// フェーズ6 の回帰テスト：順位への反映・使用記録・ピン・整理候補・言葉からの評価。
(function () {
  'use strict';
  const { test, equal, ok } = window.T;
  const deepEqual = (a, b, m) => equal(JSON.stringify(a), JSON.stringify(b), m);
  const DAY = AI.growth.DAY;
  const NOW = Date.UTC(2026, 9, 12);

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
  const P = (id, o = {}) => ({ passage: { id, title: `p${id}`, fetchedAt: NOW, score: 0, importance: 0, ...o }, snippet: '' });

  test('growth: 評価が付いていなければ、順位は変わらない', () => {
    const out = AI.growth.rerank([P(1), P(2), P(3)], AI.growth.DEFAULT_WEIGHTS, NOW);
    deepEqual(out.map((h) => h.passage.id), [1, 2, 3]);
  });

  test('growth: 👍は上がり、👎は下がる（次回の検索に反映）', () => {
    const hits = [P(1), P(2), P(3, { score: 1 }), P(4, { score: -1 })];
    const out = AI.growth.rerank(hits, AI.growth.DEFAULT_WEIGHTS, NOW);
    ok(out.findIndex((h) => h.passage.id === 3) < 2, '👍が上位に');
    equal(out[out.length - 1].passage.id, 4);
  });

  test('growth: 重みを0にすると無効（元の順のまま）', () => {
    const hits = [P(1), P(2, { score: 1 }), P(3, { score: -1, importance: 1 })];
    const out = AI.growth.rerank(hits, { score: 0, importance: 0, fresh: 0 }, NOW);
    deepEqual(out.map((h) => h.passage.id), [1, 2, 3]);
  });

  test('growth: ピン留めは上がる。新しいほど少し有利', () => {
    const out = AI.growth.rerank([P(1), P(2, { importance: 1 })], { score: 0, importance: 0.2, fresh: 0 }, NOW);
    equal(out[0].passage.id, 2);
    const old = AI.growth.rerank([P(1, { fetchedAt: NOW - 720 * DAY }), P(2)], { score: 0, importance: 0, fresh: 0.3 }, NOW);
    equal(old[0].passage.id, 2);
  });

  test('growth: 重みは範囲に収まる（極端な値で順位が壊れない）', () => {
    const w = AI.growth.clampWeights({ score: 99, importance: -3, fresh: 'x' });
    equal(w.score, 0.5);
    equal(w.importance, 0);
    equal(w.fresh, AI.growth.DEFAULT_WEIGHTS.fresh);
  });

  test('growth: 使われると回数と最終使用日が更新される', async () => {
    await withDb(async (db) => {
      const a = await AI.passages.add(db, '本文あ', { title: 'a' });
      const b = await AI.passages.add(db, '本文い', { title: 'b' });
      equal(await AI.growth.markUsed(db, 'passage', [a.id, b.id, 999], 5000), 2);
      await AI.growth.markUsed(db, 'passage', a.id, 7000);
      const ra = await AI.passages.get(db, a.id);
      equal(ra.useCount, 2);
      equal(ra.lastUsedAt, 7000);
      equal((await AI.passages.get(db, b.id)).useCount, 1);
      await AI.terms.add(db, 'AI', '人工知能');
      await AI.growth.markUsed(db, 'term', 'ai');
      equal((await AI.terms.get(db, 'AI')).useCount, 1);
    });
  });

  test('growth: ピン留めは重要度に記録され、外せる', async () => {
    await withDb(async (db) => {
      const a = await AI.passages.add(db, '本文', { title: 'a' });
      await AI.growth.setImportance(db, 'passage', a.id, 1);
      equal((await AI.passages.get(db, a.id)).importance, 1);
      await AI.growth.setImportance(db, 'passage', a.id, 0);
      equal((await AI.passages.get(db, a.id)).importance, 0);
    });
  });

  test('growth: 重みの設定は保存され、再読み込みで戻る', async () => {
    await withDb(async (db) => {
      equal((await AI.growth.loadWeights(db)).score, AI.growth.DEFAULT_WEIGHTS.score);
      await AI.growth.saveWeights(db, { score: 0.3, importance: 0, fresh: 0.1 });
      const w = await AI.growth.loadWeights(db);
      equal(w.score, 0.3);
      equal(w.importance, 0);
    });
  });

  test('growth: 整理候補は 低評価 > 未使用 > 古い の順。ピン留めと使われたものは出ない', () => {
    const t = (o) => ({ key: o.term, term: o.term, updatedAt: NOW - (o.age || 0) * DAY, createdAt: NOW - (o.age || 0) * DAY, score: 0, useCount: 0, ...o });
    const p = (o) => ({ id: o.id, title: o.title, body: 'x', fetchedAt: NOW - (o.age || 0) * DAY, score: 0, useCount: 0, sourceUrl: '', ...o });
    const terms = [t({ term: '新しい', age: 3 }), t({ term: '低評価', age: 3, score: -1 }), t({ term: '使われた', age: 100, useCount: 4, lastUsedAt: NOW - 2 * DAY }), t({ term: 'ピン', age: 400, importance: 1 })];
    const passages = [
      p({ id: 1, title: '未使用', age: 40 }),
      p({ id: 2, title: '古いWiki', age: 400, sourceUrl: 'https://ja.wikipedia.org/wiki/X', useCount: 1, lastUsedAt: NOW - 390 * DAY }),
    ];
    const c = AI.growth.candidates(terms, passages, NOW);
    deepEqual(c.map((x) => x.title), ['低評価', '未使用', '古いWiki']);
    equal(c[2].refetch, true);
    equal(c[1].refetch, false);
    ok(c[0].reasons[0].code === 'low');
  });

  test('growth: 集計（週ごとの蓄積・よく使われた順・評価の数）', () => {
    const terms = [{ term: 'a', createdAt: NOW - 20 * DAY, updatedAt: NOW, useCount: 5, score: 1 }];
    const passages = [
      { title: 'b', fetchedAt: NOW - 3 * DAY, useCount: 9, score: -1, importance: 1 },
      { title: 'c', fetchedAt: NOW - 1 * DAY, useCount: 0 },
    ];
    const s = AI.growth.summary(terms, passages, 4, NOW, 4);
    equal(s.points.length, 4);
    equal(s.points[s.points.length - 1].total, 3);
    equal(s.points[0].total, 0);
    equal(s.points[1].total, 1);
    deepEqual(s.used.map((u) => u.title), ['b', 'a']);
    equal(s.liked, 1);
    equal(s.disliked, 1);
    equal(s.pinned, 1);
    equal(s.queue, 4);
  });

  test('growth: 再取得で本文を入れ替えても、評価・使用回数・ピンは残り、検索は新しい本文で当たる', async () => {
    await withDb(async (db) => {
      const a = await AI.passages.add(db, '古い内容のキツネ', { title: '動物' });
      await AI.feedback.rate(db, 'passage', a.id, 1);
      await AI.growth.markUsed(db, 'passage', a.id);
      await AI.growth.setImportance(db, 'passage', a.id, 1);
      await AI.passages.replaceBody(db, a.id, '新しい内容のタヌキ', { now: 123 });
      const r = await AI.passages.get(db, a.id);
      equal(r.score, 1);
      equal(r.useCount, 1);
      equal(r.importance, 1);
      equal(r.fetchedAt, 123);
      equal((await AI.passages.search(db, 'タヌキ', { fuzzy: false })).length, 1);
      equal((await AI.passages.search(db, 'キツネ', { fuzzy: false })).length, 0);
    });
  });

  test('feedback: setValue で元の評価に戻せる（取り消し）', async () => {
    await withDb(async (db) => {
      const a = await AI.passages.add(db, '本文', { title: 'a' });
      await AI.feedback.setValue(db, 'passage', a.id, -1, { via: 'words' });
      equal(await AI.feedback.current(db, 'passage', a.id), -1);
      await AI.feedback.setValue(db, 'passage', a.id, 0, { via: 'undo' });
      equal(await AI.feedback.current(db, 'passage', a.id), 0);
      equal((await AI.feedback.history(db, 'passage', a.id)).length, 2);
    });
  });

  test('sentiment: 感謝は👍、否定は👎。短い決まった言葉のときだけ', () => {
    for (const t of ['ありがとう', 'ありがとう！', 'ありがとうございます', '助かった', 'なるほど', 'あってるね']) equal(AI.sentiment.detect(t).value, 1, t);
    for (const t of ['違う', '違うよ', 'それは違う', '間違ってる', 'そうじゃない']) equal(AI.sentiment.detect(t).value, -1, t);
  });

  test('sentiment: 叱責・悪口や、長い文・質問には反応しない（口調と正しさを混同しない）', () => {
    for (const t of ['使えない', 'ばか', 'ひどい', 'ふざけるな', 'ありがとう、でも違う', '光合成とは？', '違う言語の意味を教えて', '']) equal(AI.sentiment.detect(t).value, 0, t);
  });
})();
