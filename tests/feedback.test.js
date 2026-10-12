// フェーズ1-C の回帰テスト：評価（👍/👎）。
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

  test('feedback: 👍を押すとログが残り、単語の評価値が上がる', () =>
    withDb(async (db) => {
      await AI.terms.add(db, 'AI', '人工知能');
      const r = await AI.feedback.rate(db, 'term', 'ai', 1);
      equal(r, { value: 1, score: 1 });
      equal((await AI.terms.get(db, 'AI')).score, 1);
      equal((await AI.feedback.history(db, 'term', 'ai')).length, 1);
    }));

  test('feedback: 同じ向きの再押しは取り消し、逆向きは付け替え（ログは全て残る）', () =>
    withDb(async (db) => {
      await AI.terms.add(db, 'AI', '人工知能');
      equal((await AI.feedback.rate(db, 'term', 'ai', 1)).value, 1);
      equal((await AI.feedback.rate(db, 'term', 'ai', 1)).value, 0, '取り消し');
      equal((await AI.feedback.rate(db, 'term', 'ai', -1)).value, -1);
      equal((await AI.feedback.rate(db, 'term', 'ai', 1)).value, 1, '付け替え');
      equal((await AI.terms.get(db, 'AI')).score, 1);
      equal((await AI.feedback.history(db, 'term', 'ai')).map((l) => l.value), [1, 0, -1, 1]);
      equal(await AI.feedback.current(db, 'term', 'ai'), 1);
    }));

  test('feedback: 文章にも付き、単語とは別々に数える', () =>
    withDb(async (db) => {
      await AI.terms.add(db, 'x', 'y');
      const p = await AI.passages.add(db, '本文');
      await AI.feedback.rate(db, 'passage', p.id, -1);
      await AI.feedback.rate(db, 'term', 'x', 1);
      equal((await AI.passages.get(db, p.id)).score, -1);
      equal((await AI.terms.get(db, 'x')).score, 1);
      equal(await AI.feedback.current(db, 'passage', p.id), -1);
    }));

  test('feedback: 対象が無い・値が不正なら例外で、ログも残らない', () =>
    withDb(async (db) => {
      await rejects(AI.feedback.rate(db, 'term', 'nothing', 1));
      await rejects(AI.feedback.rate(db, 'passage', 999, 1));
      await rejects(AI.feedback.rate(db, 'term', 'x', 5));
      await rejects(AI.feedback.rate(db, 'cat', 'x', 1));
      const logs = await AI.db.tx(db, 'feedback', 'readonly', (t) => AI.db.rq(t.objectStore('feedback').getAll()));
      equal(logs, []);
    }));
})();
