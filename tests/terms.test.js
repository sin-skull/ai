// フェーズ1-A の回帰テスト：正規化・DB の土台・単語辞書。
(function () {
  'use strict';
  const { test, equal, ok, rejects } = window.T;

  // テストごとに別名のDBを作り、終わったら消す
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

  // ---- 正規化 ----
  test('正規化: 全角英数と大文字は半角小文字になる', () => {
    equal(AI.normalizeTerm('ＡＩ'), 'ai');
    equal(AI.normalizeTerm('Ａｉ　Ａｓｓｉｓｔａｎｔ'), 'ai assistant');
  });

  test('正規化: カタカナはひらがなになり、半角カナも同じ語になる', () => {
    equal(AI.normalizeTerm('アイ'), 'あい');
    equal(AI.normalizeTerm('ｱｲ'), 'あい');
    equal(AI.normalizeTerm('ガッコウ'), 'がっこう');
    equal(AI.normalizeTerm('ｶﾞｯｺｳ'), 'がっこう');
  });

  test('正規化: 長音符は残り、前後と連続の空白は整理される', () => {
    equal(AI.normalizeTerm('コンピューター'), 'こんぴゅーたー');
    equal(AI.normalizeTerm('  a   b  '), 'a b');
  });

  test('正規化: 漢字は変えない／文字列以外は空になる', () => {
    equal(AI.normalizeTerm('人工知能'), '人工知能');
    equal(AI.normalizeTerm(null), '');
    equal(AI.normalizeTerm(undefined), '');
    equal(AI.normalizeTerm('   '), '');
  });

  // ---- DBの土台 ----
  test('DB: 全ストアが作られ、schemaVersion が保存される', () =>
    withDb(async (db) => {
      const names = Array.from(db.objectStoreNames).sort();
      equal(names, ['feedback', 'ngram', 'passages', 'queue', 'settings', 'terms', 'vectors']);
      const row = await AI.db.tx(db, 'settings', 'readonly', (t) =>
        AI.db.rq(t.objectStore('settings').get('schemaVersion'))
      );
      equal(row.value, AI.db.SCHEMA_VERSION);
    }));

  test('DB: 例外が出たトランザクションは丸ごと取り消される', () =>
    withDb(async (db) => {
      await rejects(
        AI.db.tx(db, 'terms', 'readwrite', async (t) => {
          await AI.db.rq(t.objectStore('terms').put({ key: 'x', updatedAt: 1 }));
          throw new Error('途中で失敗');
        })
      );
      equal(await AI.terms.count(db), 0, '書き込みが残っている');
    }));

  // ---- 単語辞書 ----
  test('辞書: 新しい語は created になる', () =>
    withDb(async (db) => {
      const r = await AI.terms.add(db, 'AI', '人工知能');
      equal(r.status, 'created');
      equal(r.record.key, 'ai');
      equal(r.record.term, 'AI');
      equal(r.record.useCount, 0);
      equal(r.record.score, 0);
    }));

  test('辞書: 同じ語を2回保存しても1件のまま', () =>
    withDb(async (db) => {
      await AI.terms.add(db, 'AI', '人工知能');
      const r = await AI.terms.add(db, 'AI', '人工知能');
      equal(r.status, 'unchanged');
      equal(await AI.terms.count(db), 1);
    }));

  test('辞書: 表記ゆれ（全角・大文字・カナ）も同じ1件に統合され、表記が記録される', () =>
    withDb(async (db) => {
      await AI.terms.add(db, 'ai', '人工知能');
      await AI.terms.add(db, 'ＡＩ', '人工知能');
      await AI.terms.add(db, 'Ai', '人工知能');
      equal(await AI.terms.count(db), 1);
      const rec = await AI.terms.get(db, 'AI');
      equal(rec.term, 'ai', '表示用は最初の表記');
      equal(rec.variants, ['ai', 'ＡＩ', 'Ai']);

      await AI.terms.add(db, 'ガッコウ', '学ぶ場所');
      await AI.terms.add(db, 'がっこう', '学ぶ場所');
      await AI.terms.add(db, 'ｶﾞｯｺｳ', '学ぶ場所');
      equal(await AI.terms.count(db), 2);
    }));

  test('辞書: 定義が違うとき ask は書き込まず conflict を返す', () =>
    withDb(async (db) => {
      await AI.terms.add(db, 'AI', '人工知能');
      const r = await AI.terms.add(db, 'AI', '愛', { onConflict: 'ask' });
      equal(r.status, 'conflict');
      equal(r.existing.definition, '人工知能');
      equal(r.incoming.definition, '愛');
      equal((await AI.terms.get(db, 'AI')).definition, '人工知能', '書き込まれている');
    }));

  test('辞書: 既定の onConflict は ask', () =>
    withDb(async (db) => {
      await AI.terms.add(db, 'AI', '人工知能');
      const r = await AI.terms.add(db, 'AI', '愛');
      equal(r.status, 'conflict');
    }));

  test('辞書: overwrite は置き換え、append は足し、ignore は残す', () =>
    withDb(async (db) => {
      await AI.terms.add(db, 'a', '一');
      let r = await AI.terms.add(db, 'a', '二', { onConflict: 'overwrite' });
      equal(r.status, 'updated');
      equal(r.record.definition, '二');

      r = await AI.terms.add(db, 'a', '三', { onConflict: 'append' });
      equal(r.status, 'updated');
      equal(r.record.definition, '二\n三');

      r = await AI.terms.add(db, 'a', '三', { onConflict: 'append' });
      equal(r.status, 'unchanged', '同じ内容の追記が重複した');
      equal(r.record.definition, '二\n三');

      r = await AI.terms.add(db, 'a', '四', { onConflict: 'ignore' });
      equal(r.status, 'unchanged');
      equal((await AI.terms.get(db, 'a')).definition, '二\n三');
    }));

  test('辞書: 今の定義が空なら、衝突にせず補完する／新しい定義が空なら変えない', () =>
    withDb(async (db) => {
      await AI.terms.add(db, 'b', '');
      let r = await AI.terms.add(db, 'b', '中身');
      equal(r.status, 'updated');
      equal(r.record.definition, '中身');
      r = await AI.terms.add(db, 'b', '');
      equal(r.status, 'unchanged');
      equal((await AI.terms.get(db, 'b')).definition, '中身');
    }));

  test('辞書: 出典は URL で重複せず積まれる', () =>
    withDb(async (db) => {
      const s1 = { url: 'https://ja.wikipedia.org/wiki/AI', title: 'AI - Wikipedia' };
      await AI.terms.add(db, 'AI', '人工知能', { source: s1 });
      await AI.terms.add(db, 'AI', '人工知能', { source: s1 });
      await AI.terms.add(db, 'AI', '人工知能', { source: { url: 'https://example.com/', title: 'ex' } });
      const rec = await AI.terms.get(db, 'AI');
      equal(rec.sources.length, 2);
      equal(rec.sources[0].url, s1.url);
    }));

  test('辞書: 削除すると消え、無い語の削除は false', () =>
    withDb(async (db) => {
      await AI.terms.add(db, 'AI', '人工知能');
      equal(await AI.terms.remove(db, 'ＡＩ'), true, '表記ゆれでも消せる');
      equal(await AI.terms.get(db, 'AI'), undefined);
      equal(await AI.terms.count(db), 0);
      equal(await AI.terms.remove(db, 'AI'), false);
    }));

  test('辞書: list は更新が新しい順', () =>
    withDb(async (db) => {
      await AI.terms.add(db, 'one', '1', { now: 1000 });
      await AI.terms.add(db, 'two', '2', { now: 3000 });
      await AI.terms.add(db, 'three', '3', { now: 2000 });
      const keys = (await AI.terms.list(db)).map((r) => r.key);
      equal(keys, ['two', 'three', 'one']);
    }));

  test('辞書: 空の単語は拒否される／未知の onConflict も拒否される', () =>
    withDb(async (db) => {
      await rejects(AI.terms.add(db, '   ', 'x'));
      await rejects(AI.terms.add(db, '', 'x'));
      await rejects(AI.terms.add(db, 'a', 'x', { onConflict: 'merge' }));
      equal(await AI.terms.count(db), 0);
    }));

  test('辞書: 同時に複数回 add しても1件にまとまる', () =>
    withDb(async (db) => {
      await Promise.all([
        AI.terms.add(db, 'AI', '人工知能'),
        AI.terms.add(db, 'ａｉ', '人工知能'),
        AI.terms.add(db, 'Ai', '人工知能'),
      ]);
      equal(await AI.terms.count(db), 1);
      ok((await AI.terms.get(db, 'ai')).variants.length >= 1);
    }));
})();
