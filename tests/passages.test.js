// フェーズ1-B の回帰テスト：文章ストアと n-gram 検索。
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

  test('passages: 2-gram は空白をまたがず、重複しない', () => {
    equal(AI.passages.grams('人工知能').sort(), ['人工', '工知', '知能'].sort());
    equal(AI.passages.grams('ＡＩ 研究').sort(), ['ai', '研究'].sort());
    equal(AI.passages.grams('あ'), ['あ']);
    equal(AI.passages.grams('ああああ'), ['ああ']);
  });

  test('passages: 保存すると id と見出しが付き、一覧と全文で取り出せる', () =>
    withDb(async (db) => {
      const p = await AI.passages.add(db, '一行目のタイトル\n二行目の本文です。', { sourceUrl: 'https://example.com' });
      ok(Number.isInteger(p.id));
      equal(p.title, '一行目のタイトル');
      equal((await AI.passages.get(db, p.id)).body, '一行目のタイトル\n二行目の本文です。');
      equal((await AI.passages.list(db)).length, 1);
      equal(await AI.passages.count(db), 1);
      await rejects(AI.passages.add(db, '   '));
    }));

  test('passages: 保存した文章がキーワードで見つかる（表記ゆれ・複数語・順不同）', () =>
    withDb(async (db) => {
      await AI.passages.add(db, '機械学習は人工知能の一分野である。', { title: 'ML' });
      await AI.passages.add(db, 'コンピューターの歴史について。', { title: '歴史' });
      equal((await AI.passages.search(db, '人工知能')).map((r) => r.passage.title), ['ML']);
      equal((await AI.passages.search(db, 'こんぴゅーたー')).map((r) => r.passage.title), ['歴史']);
      equal((await AI.passages.search(db, '知能 機械')).map((r) => r.passage.title), ['ML']);
      equal((await AI.passages.search(db, '一分')).length, 1, '2文字');
      equal((await AI.passages.search(db, '野')).length, 1, '1文字');
      equal(await AI.passages.search(db, '存在しない'), []);
      equal(await AI.passages.search(db, '  '), []);
    }));

  test('passages: 2-gram が揃っていても連続していなければ見つからない', () =>
    withDb(async (db) => {
      await AI.passages.add(db, '人工の知能');
      equal(await AI.passages.search(db, '人工知能'), [], '人工・知能 は別々に出てくるだけ');
    }));

  test('passages: 一致が多い文章が先に出て、抜粋に一致箇所が含まれる', () =>
    withDb(async (db) => {
      await AI.passages.add(db, '猫が好き。', { title: 'A' });
      await AI.passages.add(db, '猫と猫と猫の話。', { title: 'B' });
      const r = await AI.passages.search(db, '猫');
      equal(r.map((x) => x.passage.title), ['B', 'A']);
      ok(r[0].snippet.includes('猫'));
    }));

  test('passages: 削除すると検索結果から消え、インデックスも空になる', () =>
    withDb(async (db) => {
      const a = await AI.passages.add(db, '共通の言葉とAだけの話');
      const b = await AI.passages.add(db, '共通の言葉とBだけの話');
      equal((await AI.passages.search(db, '共通')).length, 2);
      equal(await AI.passages.remove(db, a.id), 1);
      equal((await AI.passages.search(db, '共通')).map((r) => r.passage.id), [b.id]);
      equal(await AI.passages.search(db, 'Aだけ'), []);
      equal(await AI.passages.remove(db, a.id), 0, '二重削除は0件');
      await AI.passages.remove(db, [b.id]);
      equal(await all(db, 'ngram'), [], '全て消えたらインデックスも残らない');
      equal(await AI.passages.count(db), 0);
    }));

  test('passages: 複数まとめて削除できる', () =>
    withDb(async (db) => {
      const ids = [];
      for (const s of ['いち', 'にい', 'さん']) ids.push((await AI.passages.add(db, s)).id);
      equal(await AI.passages.remove(db, [ids[0], ids[2], 9999]), 2);
      equal((await AI.passages.list(db)).map((p) => p.body), ['にい']);
    }));

  test('passages: 削除しても単語は残る。選んだときだけ単語も消える', () =>
    withDb(async (db) => {
      await AI.terms.add(db, 'AI', '人工知能');
      await AI.terms.add(db, '別の語', '別の意味');
      const p1 = await AI.passages.add(db, '本文1', { terms: ['AI'] });
      const p2 = await AI.passages.add(db, '本文2', { terms: ['別の語'] });
      await AI.passages.remove(db, p1.id);
      ok(await AI.terms.get(db, 'AI'), '既定では単語は残る');
      await AI.passages.remove(db, p2.id, { deleteTerms: true });
      equal(await AI.terms.get(db, '別の語'), undefined);
      ok(await AI.terms.get(db, 'AI'), '関係ない単語は残る');
    }));

  test('passages: 保存したデータはDBを開き直しても残る', async () => {
    const name = `ai-test-${Date.now()}-reopen`;
    let db = await AI.db.open(name);
    try {
      await AI.passages.add(db, '再起動しても残る文章');
      db.close();
      db = await AI.db.open(name);
      equal((await AI.passages.search(db, '再起動')).length, 1);
    } finally {
      db.close();
      await AI.db.deleteDatabase(name);
    }
  });
})();
