// フェーズ3-B の回帰テスト：未回答キュー。
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

  test('queue: 答えられなかった質問が溜まり、古い順に取り出せる', () =>
    withDb(async (db) => {
      await AI.queue.add(db, '量子コンピュータ', { now: 1000 });
      await AI.queue.add(db, 'ブロックチェーン', { now: 2000 });
      equal((await AI.queue.list(db)).map((r) => r.query), ['量子コンピュータ', 'ブロックチェーン']);
      equal(await AI.queue.count(db), 2);
      await rejects(AI.queue.add(db, '  '));
    }));

  test('queue: 同じ質問（表記ゆれ含む）は重ねず、回数だけ増える', () =>
    withDb(async (db) => {
      await AI.queue.add(db, 'ＡＩ');
      const r = await AI.queue.add(db, 'ai');
      equal(await AI.queue.count(db), 1);
      equal(r.askedCount, 2);
    }));

  test('queue: 覚えたら済みになり、同じ語を再び聞かれたら新しく溜まる', () =>
    withDb(async (db) => {
      await AI.queue.add(db, 'AI');
      await AI.queue.add(db, '別の語');
      equal(await AI.queue.resolve(db, 'ＡＩ'), 1);
      equal((await AI.queue.list(db)).map((r) => r.query), ['別の語']);
      equal(await AI.queue.count(db, 'done'), 1);
      await AI.queue.add(db, 'AI');
      equal(await AI.queue.count(db), 2, '済みの語は重ねず、新しい調べ待ちになる');
    }));

  test('queue: いらないにすると調べ待ちから外れる。1件消せる', () =>
    withDb(async (db) => {
      const a = await AI.queue.add(db, 'A');
      const b = await AI.queue.add(db, 'B');
      equal(await AI.queue.setStatus(db, a.id, 'dismissed'), true);
      equal((await AI.queue.list(db)).map((r) => r.id), [b.id]);
      equal(await AI.queue.setStatus(db, 9999, 'done'), false);
      await rejects(AI.queue.setStatus(db, b.id, 'nope'));
      equal(await AI.queue.remove(db, b.id), true);
      equal(await AI.queue.remove(db, b.id), false);
    }));

  test('queue: 書き出しに含まれ、置き換えで復元、統合では調べ待ちだけ重ねず足す', () =>
    withDb(async (db) => {
      await AI.queue.add(db, 'AI');
      const done = await AI.queue.add(db, '済みの語');
      await AI.queue.setStatus(db, done.id, 'done');
      const data = JSON.parse(JSON.stringify(await AI.backup.exportAll(db)));
      equal(data.queue.length, 2);

      await AI.queue.remove(db, (await AI.queue.list(db))[0].id);
      equal(await AI.queue.count(db), 0);
      await AI.backup.importAll(db, data, { mode: 'overwrite' });
      equal((await AI.queue.list(db)).map((r) => r.query), ['AI']);
      equal(await AI.queue.count(db, 'done'), 1);

      const r = await AI.backup.importAll(db, data, { mode: 'merge' });
      equal(r.queue, 0, '同じ調べ待ちは重ねない');
      await AI.queue.add(db, '手元の語');
      const other = { ...data, queue: [{ ...data.queue[0], id: 77, key: 'べつ', query: '別の語' }] };
      equal((await AI.backup.importAll(db, other, { mode: 'merge' })).queue, 1);
      equal(await AI.queue.count(db), 3);
    }));
})();
