// 評価セットを走らせて、キーワード／意味／ハイブリッドの順位を比べる。
// 使い方: tests/eval.html を開いて「実行」。?fake=1 で、実モデルの代わりに疑似モデル（仕組みの確認用）。
(function () {
  'use strict';
  const { passages, queries, unrelated } = window.EVAL;

  function fakeProvider(pack) {
    return {
      id: 'fake', version: 1, dim: 64, ready: true,
      async prepare() {},
      async embed(texts) {
        return texts.map((t) => {
          const v = new Float32Array(64);
          const c = Array.from(AI.normalizeTerm(t));
          for (let i = 0; i + 1 < c.length; i++) {
            let h = 0;
            for (const ch of c[i] + c[i + 1]) h = (h * 31 + ch.codePointAt(0)) >>> 0;
            v[h % 64] += 1;
          }
          return AI.embed.normalize(v);
        });
      },
    };
  }

  function rankOf(results, passageId) {
    const i = results.findIndex((r) => r.passage.id === passageId);
    return i < 0 ? Infinity : i + 1;
  }

  function summarize(ranks) {
    const n = ranks.length;
    const hit = (k) => ranks.filter((r) => r <= k).length / n;
    const mrr = ranks.reduce((s, r) => s + (r === Infinity ? 0 : 1 / r), 0) / n;
    return { n, hit1: hit(1), hit3: hit(3), hit5: hit(5), mrr };
  }

  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const num = (x) => x.toFixed(3);

  async function run(log, options = {}) {
    const name = `ai-eval-${Date.now()}`;
    const db = await AI.db.open(name);
    const out = { models: null, modes: {}, scores: {} };
    try {
      let provider;
      if (options.fake) {
        provider = fakeProvider();
      } else {
        provider = AI.embed.transformersProvider(AI.embed.PACKS[0]);
        const t0 = performance.now();
        log('モデルを読み込んでいます…（初回は約120MBをダウンロードします）');
        let lastShown = 0;
        await provider.prepare((info) => {
          const now = performance.now();
          if (now - lastShown > 1500) {
            lastShown = now;
            log(`  ${info.label}: ${Math.round((info.loaded / info.total) * 100)}%`);
          }
        });
        out.loadMs = Math.round(performance.now() - t0);
        log(`モデルの準備ができました（${(out.loadMs / 1000).toFixed(1)}秒）`);
      }
      out.model = provider.id;

      const ids = [];
      for (const p of passages) ids.push((await AI.passages.add(db, p.body, { title: p.title })).id);
      const t1 = performance.now();
      await AI.vectors.reindex(db, provider);
      out.indexMs = Math.round(performance.now() - t1);
      log(`文章${passages.length}件のベクトルを作成：${(out.indexMs / 1000).toFixed(1)}秒（1件 ${Math.round(out.indexMs / passages.length)}ms）`);

      const ranks = { keyword: [], semantic: [], hybrid: [] };
      const byKind = { paraphrase: { keyword: [], semantic: [], hybrid: [] }, keyword: { keyword: [], semantic: [], hybrid: [] } };
      const topScores = []; // 正解が1位のときの意味検索の近さ
      const t2 = performance.now();
      for (const q of queries) {
        const want = ids[q.a];
        for (const mode of ['keyword', 'semantic', 'hybrid']) {
          const r = await AI.hybrid.search(db, q.q, { provider, mode, limit: 30, minSemantic: -1 });
          const rank = rankOf(r, want);
          ranks[mode].push(rank);
          byKind[q.kind][mode].push(rank);
          if (mode === 'semantic' && r[0] && r[0].passage.id === want) topScores.push(r[0].semScore);
        }
      }
      out.queryMs = Math.round((performance.now() - t2) / (queries.length * 3));

      for (const mode of ['keyword', 'semantic', 'hybrid']) out.modes[mode] = summarize(ranks[mode]);
      out.byKind = {};
      for (const kind of Object.keys(byKind)) {
        out.byKind[kind] = {};
        for (const mode of Object.keys(byKind[kind])) out.byKind[kind][mode] = summarize(byKind[kind][mode]);
      }

      // 関係ない質問の、意味検索での一番高い近さ
      const unrelatedTop = [];
      for (const q of unrelated) {
        const r = await AI.hybrid.search(db, q, { provider, mode: 'semantic', limit: 1, minSemantic: -1 });
        unrelatedTop.push(r[0] ? r[0].semScore : 0);
      }
      const sorted = topScores.slice().sort((a, b) => a - b);
      out.scores = {
        relatedMin: sorted[0],
        relatedP10: sorted[Math.floor(sorted.length * 0.1)],
        relatedAvg: sorted.reduce((s, x) => s + x, 0) / sorted.length,
        unrelatedMax: Math.max(...unrelatedTop),
        unrelatedAvg: unrelatedTop.reduce((s, x) => s + x, 0) / unrelatedTop.length,
      };
      out.scores.suggested = (out.scores.unrelatedMax + out.scores.relatedP10) / 2;

      // 表示
      log('');
      log('■ 順位の比較（正解の文章が何位に出たか）');
      for (const mode of ['keyword', 'semantic', 'hybrid']) {
        const s = out.modes[mode];
        log(`${mode.padEnd(9)} 1位 ${pct(s.hit1)} ／ 3位以内 ${pct(s.hit3)} ／ 5位以内 ${pct(s.hit5)} ／ 平均逆順位(MRR) ${num(s.mrr)}`);
      }
      for (const kind of Object.keys(out.byKind)) {
        log(`  └ ${kind === 'paraphrase' ? '言い換え' : '言葉がそのまま入る'}の質問（${out.byKind[kind].keyword.n}件）`);
        for (const mode of ['keyword', 'semantic', 'hybrid']) {
          const s = out.byKind[kind][mode];
          log(`      ${mode.padEnd(9)} 1位 ${pct(s.hit1)} ／ 3位以内 ${pct(s.hit3)} ／ MRR ${num(s.mrr)}`);
        }
      }
      log('');
      log('■ 意味検索の近さ（「関係ない」と捨てる線の目安）');
      log(`正解が1位のとき：最小 ${num(out.scores.relatedMin)} ／ 下位10% ${num(out.scores.relatedP10)} ／ 平均 ${num(out.scores.relatedAvg)}`);
      log(`関係ない質問の最高：最大 ${num(out.scores.unrelatedMax)} ／ 平均 ${num(out.scores.unrelatedAvg)}`);
      log(`→ 目安の閾値：${num(out.scores.suggested)}${out.scores.unrelatedMax >= out.scores.relatedP10 ? '（注意：重なっていて、きれいには分けられない）' : ''}`);
      log('');
      log(`■ 速さ：1回の検索 約${out.queryMs}ms`);
    } finally {
      db.close();
      await AI.db.deleteDatabase(name);
    }
    return out;
  }

  window.runEval = run;
})();
