// フェーズ2 の回帰テスト：オフラインモード（通信の遮断）と書き出し／読み込み。
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
  const all = (db, store) => AI.db.tx(db, store, 'readonly', (t) => AI.db.rq(t.objectStore(store).getAll()));

  async function seed(db) {
    await AI.terms.add(db, 'AI', '人工知能', { source: { url: 'https://example.com/ai', title: 'ex' } });
    await AI.terms.add(db, 'ＡＩ', '', {});
    const p = await AI.passages.add(db, '機械学習は人工知能の一分野。', { terms: ['AI'], sourceUrl: 'https://example.com/ml' });
    await AI.feedback.rate(db, 'term', 'ai', 1);
    await AI.feedback.rate(db, 'passage', p.id, -1);
    return p;
  }

  // ---- オフラインモード ----
  test('net: オフラインモードでは通信する前に止まり、戻すと通信できる', async () => {
    let calls = 0;
    const fake = async () => { calls++; return { ok: true }; };
    await AI.net.setOffline(null, true);
    await rejects(AI.net.fetch('https://example.com', {}, fake));
    equal(calls, 0, 'オフライン中に通信した');
    await AI.net.setOffline(null, false);
    await AI.net.fetch('https://example.com', {}, fake);
    equal(calls, 1);
  });

  test('net: モードは保存され、次に開いたときに戻る', () =>
    withDb(async (db) => {
      await AI.net.setOffline(db, true);
      await AI.net.setOffline(null, false); // 画面側の状態だけ戻す
      equal(await AI.net.load(db), true, '保存したモードが復元される');
      await AI.net.setOffline(db, false);
      equal(await AI.net.load(db), false);
    }));

  test('net: オフラインモードでは Wikipedia 検索も通信しない', async () => {
    let calls = 0;
    await AI.net.setOffline(null, true);
    try {
      await rejects(AI.wiki.search('AI', { fetchImpl: async () => { calls++; return {}; } }));
      equal(calls, 0);
    } finally {
      await AI.net.setOffline(null, false);
    }
  });

  // ---- 書き出し／読み込み ----
  test('backup: 書き出し→全削除→上書き読み込みで完全に復元できる（検索も）', () =>
    withDb(async (db) => {
      const p = await seed(db);
      const data = JSON.parse(JSON.stringify(await AI.backup.exportAll(db))); // ファイルを経由したつもり
      equal(data.format, 'ai-backup');

      // 全部消す
      await AI.passages.remove(db, p.id);
      await AI.terms.remove(db, 'AI');
      equal(await AI.passages.count(db), 0);

      const r = await AI.backup.importAll(db, data, { mode: 'overwrite' });
      equal(r.terms.added, 1);
      equal(r.passages.added, 1);
      equal((await AI.terms.get(db, 'AI')).definition, '人工知能');
      equal((await AI.terms.get(db, 'AI')).score, 1);
      equal((await AI.passages.search(db, '機械学習')).map((x) => x.passage.id), [p.id], '検索インデックスが作り直されている');
      equal(await AI.feedback.current(db, 'passage', p.id), -1);
    }));

  test('backup: 上書きは今のデータを全て消してから入れる', () =>
    withDb(async (db) => {
      await seed(db);
      const data = await AI.backup.exportAll(db);
      await AI.terms.add(db, '余計な語', '消えるはず');
      await AI.passages.add(db, '余計な文章');
      await AI.backup.importAll(db, data, { mode: 'overwrite' });
      equal(await AI.terms.get(db, '余計な語'), undefined);
      equal(await AI.passages.count(db), 1);
      equal((await AI.passages.search(db, '余計')).length, 0, '余計な文章の索引も残らない');
    }));

  test('backup: 統合は今のデータを残し、同じ内容は重ねない', () =>
    withDb(async (db) => {
      await seed(db);
      const data = await AI.backup.exportAll(db);
      // 別の端末のつもり：今のDBにだけ別のデータがある
      await AI.terms.add(db, '手元だけ', 'ここにだけある');
      await AI.passages.add(db, '手元だけの文章');
      const r = await AI.backup.importAll(db, data, { mode: 'merge' });
      equal(r.passages, { added: 0, skipped: 1 }, '同じ本文は重ねない');
      equal(await AI.passages.count(db), 2);
      ok(await AI.terms.get(db, '手元だけ'));
      const again = await AI.backup.importAll(db, data, { mode: 'merge' });
      equal(again.feedback, 0, '同じ評価ログは重ねない');
      equal((await all(db, 'feedback')).length, 2);
    }));

  test('backup: 統合では新しい方の定義を採用し、表記ゆれと出典は足す', () =>
    withDb(async (db) => {
      await AI.terms.add(db, 'AI', '古い定義', { now: 1000 });
      const data = await AI.backup.exportAll(db);
      data.terms[0].definition = '新しい定義';
      data.terms[0].updatedAt = 5000;
      data.terms[0].variants = ['AI', 'えーあい'];
      data.terms[0].sources = [{ url: 'https://example.com/n', title: 'n', at: 5000 }];
      await AI.backup.importAll(db, data, { mode: 'merge' });
      const t = await AI.terms.get(db, 'AI');
      equal(t.definition, '新しい定義');
      ok(t.variants.includes('えーあい'));
      equal(t.sources.length, 1);

      // 手元の方が新しいときは、手元を残す
      data.terms[0].definition = 'さらに古い';
      data.terms[0].updatedAt = 10;
      await AI.backup.importAll(db, data, { mode: 'merge' });
      equal((await AI.terms.get(db, 'AI')).definition, '新しい定義');
    }));

  test('backup: 統合した文章は新しいIDで検索でき、評価ログのIDも付け替わる', () =>
    withDb(async (db) => {
      const p = await seed(db);
      const data = await AI.backup.exportAll(db);
      // 別の端末：同じIDに別の文章がある
      const other = await AI.db.open(`ai-test-other-${Date.now()}`);
      try {
        await AI.passages.add(other, '別端末の文章');
        const r = await AI.backup.importAll(other, data, { mode: 'merge' });
        equal(r.passages.added, 1);
        const hit = (await AI.passages.search(other, '機械学習'))[0].passage;
        ok(hit.id !== 1, '新しいIDが振られる');
        equal(await AI.feedback.current(other, 'passage', hit.id), -1, '評価が正しい文章に付く');
        equal(await AI.feedback.current(other, 'passage', 1), 0, '別の文章には付かない');
      } finally {
        const n = other.name; other.close(); await AI.db.deleteDatabase(n);
      }
    }));

  test('backup: 壊れたファイル・別のファイルは、何も書き込まずに断る', () =>
    withDb(async (db) => {
      await seed(db);
      const good = await AI.backup.exportAll(db);
      for (const bad of [null, {}, { format: 'other' }, { ...good, terms: 'x' }, { ...good, formatVersion: 99 },
        { ...good, passages: [{ id: 'x', body: 1 }] }, { ...good, terms: [{ key: '' }] }]) {
        await rejects(AI.backup.importAll(db, bad, { mode: 'overwrite' }));
      }
      equal(await AI.passages.count(db), 1, '断ったあともデータは無事');
      await rejects(AI.backup.importAll(db, good, { mode: 'nope' }));
    }));

  test('backup: 最後に書き出した日時を覚える', () =>
    withDb(async (db) => {
      equal(await AI.backup.lastExportAt(db), null);
      await AI.backup.markExported(db, 12345);
      equal(await AI.backup.lastExportAt(db), 12345);
    }));
})();
