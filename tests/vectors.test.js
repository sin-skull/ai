// フェーズ4 の回帰テスト：チャンク分割・ベクトルの保存と検索・ハイブリッド。
// 実モデルは使わず、文字2-gramをハッシュした疑似プロバイダで、仕組みだけを確かめる。
(function () {
  'use strict';
  const { test, equal, ok, rejects } = window.T;

  async function withDb(fn) {
    const name = `ai-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const db = await AI.db.open(name);
    try {
      await fn(db);
    } finally {
      db.close();
      await AI.db.deleteDatabase(name);
    }
  }

  // 同じ文字の並びを多く含むほど近くなる、決定的なベクトル
  function fakeProvider(opts = {}) {
    const dim = opts.dim || 64;
    const p = {
      id: opts.id || 'fake',
      version: opts.version || 1,
      dim,
      ready: opts.ready !== false,
      calls: [],
      async prepare() {
        p.ready = true;
      },
      async embed(texts, kind) {
        p.calls.push({ texts: texts.slice(), kind });
        if (opts.onEmbed) await opts.onEmbed(texts, kind);
        if (opts.fail) throw new Error('embed failed');
        return texts.map((t) => {
          const v = new Float32Array(dim);
          const s = AI.normalizeTerm(t);
          const chars = Array.from(s);
          for (let i = 0; i + 1 < chars.length; i++) {
            let h = 0;
            for (const c of chars[i] + chars[i + 1]) h = (h * 31 + c.codePointAt(0)) >>> 0;
            v[h % dim] += 1;
          }
          return AI.embed.normalize(v);
        });
      },
    };
    return p;
  }

  // ---- チャンク ----
  test('vectors: 短い文章は1チャンク、空は0チャンク', () => {
    const c = AI.vectors.chunk('短い文です。');
    equal(c.length, 1);
    equal(c[0], { start: 0, end: 6, text: '短い文です。' });
    equal(AI.vectors.chunk(''), []);
    equal(AI.vectors.chunk('  \n  '), []);
  });

  test('vectors: 長い文章は文の切れ目で分かれ、どれも上限以内で、抜けと重なりが無い', () => {
    const sentence = 'これは一つの文です。';
    const body = sentence.repeat(60); // 600字
    const chunks = AI.vectors.chunk(body, 100);
    ok(chunks.length >= 6, `${chunks.length}`);
    ok(chunks.every((c) => c.text.length <= 100), '上限を超えたチャンクがある');
    equal(chunks.map((c) => c.text).join(''), body, '連結すると元の本文に戻る');
    ok(chunks.slice(0, -1).every((c) => c.text.endsWith('。')), '文の途中で切れていない');
    for (let i = 1; i < chunks.length; i++) equal(chunks[i].start, chunks[i - 1].end);
  });

  test('vectors: 句点の無い長すぎる文も、上限で割る', () => {
    const chunks = AI.vectors.chunk('あ'.repeat(250), 100);
    equal(chunks.map((c) => c.text.length), [100, 100, 50]);
  });

  // ---- 保存と検索 ----
  test('vectors: 保存したベクトルで、近い文章が先に出る。一番近いチャンクの位置も返る', () =>
    withDb(async (db) => {
      const prov = fakeProvider();
      const a = await AI.passages.add(db, '猫は小さな動物で、ねずみを捕る。\n\n犬は人に懐く動物で、番犬にもなる。', { title: '動物' });
      const b = await AI.passages.add(db, '東京は日本の首都で、人口が多い。', { title: '都市' });
      for (const p of [a, b]) await AI.vectors.indexPassage(db, p, prov);
      const [qv] = await prov.embed(['番犬にもなる'], 'query');
      const r = await AI.vectors.search(db, qv, prov);
      equal(r.map((x) => x.passageId), [a.id, b.id]);
      ok(r[0].score > r[1].score);
      ok(a.body.slice(r[0].chunk.start, r[0].chunk.end).includes('番犬'), '近いチャンクが特定される');
    }));

  test('vectors: 1つ目のチャンクにはタイトルを付けて作る', () =>
    withDb(async (db) => {
      const prov = fakeProvider();
      const p = await AI.passages.add(db, '本文です。', { title: '見出し' });
      await AI.vectors.indexPassage(db, p, prov);
      equal(prov.calls[0].kind, 'passage');
      equal(prov.calls[0].texts[0], '見出し\n本文です。');
    }));

  test('vectors: 文章を削除すると、ベクトルも同時に消える', () =>
    withDb(async (db) => {
      const prov = fakeProvider();
      const p = await AI.passages.add(db, '消える文章です。');
      await AI.vectors.indexPassage(db, p, prov);
      equal((await AI.vectors.status(db, prov)).indexed, 1);
      await AI.passages.remove(db, p.id);
      const rows = await AI.db.tx(db, 'vectors', 'readonly', (t) => AI.db.rq(t.objectStore('vectors').getAll()));
      equal(rows, []);
    }));

  test('vectors: 計算中に文章が消された／書き換えられたら、保存しない', () =>
    withDb(async (db) => {
      const p = await AI.passages.add(db, '計算中に消える文章です。');
      const prov = fakeProvider({ onEmbed: async () => { await AI.passages.remove(db, p.id); } });
      equal(await AI.vectors.indexPassage(db, p, prov), false);
      const rows = await AI.db.tx(db, 'vectors', 'readonly', (t) => AI.db.rq(t.objectStore('vectors').getAll()));
      equal(rows, [], '消えた文章のベクトルが残っている');
    }));

  // ---- 作成状況と作り直し ----
  test('vectors: 未作成の文章を数え、作り直しで埋まる（進捗つき）', () =>
    withDb(async (db) => {
      const prov = fakeProvider();
      for (const s of ['一つ目の文章', '二つ目の文章', '三つ目の文章']) await AI.passages.add(db, s);
      equal(await AI.vectors.status(db, prov), { total: 3, indexed: 0, stale: 3 });
      const seen = [];
      equal(await AI.vectors.reindex(db, prov, { onProgress: (p) => seen.push(p.done) }), 3);
      equal(seen, [1, 2, 3]);
      equal(await AI.vectors.status(db, prov), { total: 3, indexed: 3, stale: 0 });
      equal(await AI.vectors.reindex(db, prov), 0, '済みは作り直さない');
    }));

  test('vectors: 途中で止められ、続きから再開できる', () =>
    withDb(async (db) => {
      const prov = fakeProvider();
      for (const s of ['あいう文章', 'かきく文章', 'さしす文章']) await AI.passages.add(db, s);
      let n = 0;
      equal(await AI.vectors.reindex(db, prov, { shouldStop: () => n++ >= 2 }), 2);
      equal((await AI.vectors.status(db, prov)).stale, 1);
      equal(await AI.vectors.reindex(db, prov), 1);
      equal((await AI.vectors.status(db, prov)).stale, 0);
    }));

  test('vectors: モデルや版が変わったら古いベクトルは使わず、作り直す', () =>
    withDb(async (db) => {
      const v1 = fakeProvider({ id: 'm', version: 1 });
      const v2 = fakeProvider({ id: 'm', version: 2 });
      const other = fakeProvider({ id: 'other', dim: 32 });
      const p = await AI.passages.add(db, 'モデルを変える文章です。');
      await AI.vectors.indexPassage(db, p, v1);
      equal((await AI.vectors.status(db, v2)).stale, 1, '版が違えば未作成扱い');
      const [qv] = await v2.embed(['モデル'], 'query');
      equal(await AI.vectors.search(db, qv, v2), [], '版が違うベクトルは検索に使わない');
      equal(await AI.vectors.reindex(db, v2), 1);
      equal(await AI.vectors.removeOthers(db, other), 1, '別モデルに切り替えたら掃除できる');
      equal((await AI.vectors.status(db, v2)).indexed, 0);
    }));

  test('vectors: 書き出しにベクトルは含めない。読み込み後は作り直しが必要になる', () =>
    withDb(async (db) => {
      const prov = fakeProvider();
      const p = await AI.passages.add(db, '持ち出す文章です。');
      await AI.vectors.indexPassage(db, p, prov);
      const data = await AI.backup.exportAll(db);
      ok(!('vectors' in data));
      await AI.backup.importAll(db, JSON.parse(JSON.stringify(data)), { mode: 'overwrite' });
      equal(await AI.vectors.status(db, prov), { total: 1, indexed: 0, stale: 1 });
    }));

  // ---- ハイブリッド ----
  test('hybrid: キーワードで見つかるものと意味で見つかるものを合わせる', () =>
    withDb(async (db) => {
      const prov = fakeProvider();
      const kw = await AI.passages.add(db, 'ゼロ知識証明は、秘密を明かさずに正しさを示す方法。', { title: '暗号' });
      const sem = await AI.passages.add(db, '秘密を明かさずに、正しいことを相手に示す方法がある。', { title: '別の言い方' });
      const none = await AI.passages.add(db, '今日の天気は晴れで、気温が高い。', { title: '天気' });
      await AI.vectors.reindex(db, prov);
      const r = await AI.hybrid.search(db, 'ゼロ知識証明', { provider: prov, limit: 3 });
      equal(r[0].passage.id, kw.id);
      ok(r[0].via.includes('keyword'));
      ok(r.some((x) => x.passage.id === sem.id && x.via.includes('semantic') && !x.via.includes('keyword')), '意味だけで見つかったものがある');
      equal(r[0].semanticError, undefined);
    }));

  test('hybrid: 両方に引っかかった文章が、片方だけのものより上に来る', () =>
    withDb(async (db) => {
      const prov = fakeProvider();
      const both = await AI.passages.add(db, '光合成は植物が光で養分を作る仕組み。', { title: 'A' });
      const kwOnly = await AI.passages.add(db, '光合成。', { title: 'B' });
      await AI.vectors.indexPassage(db, both, prov);
      const r = await AI.hybrid.search(db, '光合成', { provider: prov });
      equal(r.map((x) => x.passage.id)[0], both.id);
      equal(r.find((x) => x.passage.id === both.id).via.sort(), ['keyword', 'semantic']);
      equal(r.find((x) => x.passage.id === kwOnly.id).via, ['keyword']);
    }));

  test('hybrid: モデル未準備・失敗・オフでも、キーワード検索だけで答える', () =>
    withDb(async (db) => {
      const p = await AI.passages.add(db, '東京タワーは電波塔。');
      const notReady = fakeProvider({ ready: false });
      equal((await AI.hybrid.search(db, '東京タワー', { provider: notReady })).map((x) => x.passage.id), [p.id]);
      equal(notReady.calls.length, 0, '準備前にモデルを呼ばない');
      equal((await AI.hybrid.search(db, '東京タワー')).length, 1, 'プロバイダ無しでも動く');

      const broken = fakeProvider({ fail: true });
      const r = await AI.hybrid.search(db, '東京タワー', { provider: broken });
      equal(r.map((x) => x.passage.id), [p.id]);
      ok(r.semanticError && r.semanticError.message === 'embed failed', '失敗は記録され、検索は続く');
    }));

  test('hybrid: mode でキーワードのみ・意味のみを選べる（評価用）', () =>
    withDb(async (db) => {
      const prov = fakeProvider();
      const a = await AI.passages.add(db, 'りんごは赤い果物です。');
      await AI.vectors.indexPassage(db, a, prov);
      const k = await AI.hybrid.search(db, 'りんご', { provider: prov, mode: 'keyword' });
      equal(k[0].via, ['keyword']);
      const s = await AI.hybrid.search(db, 'りんご', { provider: prov, mode: 'semantic' });
      equal(s[0].via, ['semantic']);
    }));

  test('hybrid: 近さが minSemantic に届かない意味検索の結果は捨てる', () =>
    withDb(async (db) => {
      const prov = fakeProvider();
      const a = await AI.passages.add(db, '全く関係のない別の話題の文章です。');
      await AI.vectors.indexPassage(db, a, prov);
      const loose = await AI.hybrid.search(db, 'ちがう質問', { provider: prov, mode: 'semantic' });
      equal(loose.length, 1, '閾値なしなら、何かしら返る');
      ok(typeof loose[0].semScore === 'number');
      const strict = await AI.hybrid.search(db, 'ちがう質問', { provider: prov, mode: 'semantic', minSemantic: 0.999 });
      equal(strict, [], '閾値以上だけが残る');
    }));
})();
