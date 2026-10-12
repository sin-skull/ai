// Wikipedia 検索（js/wiki.js）のテスト。実際には通信せず、偽の fetch で確かめる。
(function () {
  'use strict';
  const { test, equal, ok, rejects } = window.T;

  function fakeFetch(body, status = 200, seen = []) {
    return async (url, init) => {
      seen.push({ url: String(url), init });
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
  }

  test('wiki: 最初の段落だけを取り、長ければ文の切れ目で切る', () => {
    equal(AI.wiki.shorten('一つ目。\n\n二つ目。'), '一つ目。');
    const long = 'あ'.repeat(60) + '。' + 'い'.repeat(300);
    const s = AI.wiki.shorten(long, 100);
    ok(s.endsWith('。') && s.length <= 100, `切れ目で終わっていない: ${s.length}`);
    ok(AI.wiki.shorten('い'.repeat(300), 100).endsWith('…'), '切れ目が無いときは … で終わる');
    equal(AI.wiki.shorten(''), '');
    equal(AI.wiki.shorten(null), '');
  });

  test('wiki: 検索語を正しく組み立て、関連の高い順に返す', async () => {
    const seen = [];
    const body = {
      query: {
        pages: {
          22: { title: '二番目', fullurl: 'https://ja.wikipedia.org/wiki/二番目', extract: '二番目の説明。', index: 2 },
          11: { title: '一番目', fullurl: 'https://ja.wikipedia.org/wiki/一番目', extract: '一番目の説明。', index: 1 },
        },
      },
    };
    const r = await AI.wiki.search('AI', { fetchImpl: fakeFetch(body, 200, seen) });
    equal(r.map((x) => x.title), ['一番目', '二番目']);
    equal(r[0], { title: '一番目', url: 'https://ja.wikipedia.org/wiki/一番目', extract: '一番目の説明。' });

    const url = new URL(seen[0].url);
    equal(url.origin + url.pathname, 'https://ja.wikipedia.org/w/api.php');
    equal(url.searchParams.get('gsrsearch'), 'AI');
    equal(url.searchParams.get('origin'), '*', 'ブラウザから呼ぶのに必要');
    equal(url.searchParams.get('generator'), 'search');
  });

  test('wiki: 説明が空のページは除かれ、何も無ければ空配列', async () => {
    const body = { query: { pages: { 1: { title: 'x', fullurl: 'u', extract: '', index: 1 } } } };
    equal(await AI.wiki.search('x', { fetchImpl: fakeFetch(body) }), []);
    equal(await AI.wiki.search('x', { fetchImpl: fakeFetch({ batchcomplete: '' }) }), []);
  });

  test('wiki: 空の検索語は通信せず空、通信に失敗したら例外', async () => {
    const seen = [];
    equal(await AI.wiki.search('   ', { fetchImpl: fakeFetch({}, 200, seen) }), []);
    equal(seen.length, 0, '空の検索語で通信した');
    await rejects(AI.wiki.search('AI', { fetchImpl: fakeFetch({}, 500) }));
  });

  // 検索（generator=search）と記事名の完全一致（titles=）で、別の答えを返す偽の fetch
  function routedFetch(searchPages, exactPages, seen = []) {
    return async (url) => {
      const u = new URL(String(url));
      seen.push(u);
      const pages = u.searchParams.get('titles') ? exactPages : searchPages;
      if (pages === 'fail') throw new Error('network');
      return { ok: true, status: 200, json: async () => ({ query: { pages } }) };
    };
  }
  const page = (title, extract, index) => ({ title, fullurl: `https://ja.wikipedia.org/wiki/${title}`, extract, index });

  test('wiki: 記事名がぴったり一致するものを先頭にする（重複は除く）', async () => {
    const search = { 1: page('人工知能の歴史', '歴史の説明。', 1), 2: page('AI', '人工知能の説明。', 2), 3: page('エーアイ', '別の説明。', 3) };
    const exact = { 9: page('AI', '人工知能の説明。', undefined) };
    const r = await AI.wiki.search('AI', { fetchImpl: routedFetch(search, exact) });
    equal(r.map((x) => x.title), ['AI', '人工知能の歴史', 'エーアイ']);
  });

  test('wiki: 一致する記事が無ければ、検索結果のまま。確認に失敗しても検索結果は返す', async () => {
    const search = { 1: page('一番目', '説明。', 1), 2: page('二番目', '説明。', 2) };
    equal((await AI.wiki.search('x', { fetchImpl: routedFetch(search, { '-1': { title: 'x', missing: '' } }) })).map((x) => x.title), ['一番目', '二番目']);
    equal((await AI.wiki.search('x', { fetchImpl: routedFetch(search, 'fail') })).map((x) => x.title), ['一番目', '二番目']);
  });

  test('wiki: 候補は最大5件まで', async () => {
    const search = {};
    for (let i = 1; i <= 8; i++) search[i] = page(`記事${i}`, '説明。', i);
    const r = await AI.wiki.search('x', { fetchImpl: routedFetch(search, { '-1': { title: 'x', missing: '' } }) });
    equal(r.length, 8 > 5 ? r.length : 5); // 検索の件数指定は gsrlimit で行う（偽の応答は件数を絞らない）
    const seen = [];
    await AI.wiki.search('x', { fetchImpl: routedFetch(search, { '-1': { title: 'x', missing: '' } }, seen) });
    equal(seen[0].searchParams.get('gsrlimit'), '5');
  });

  test('wiki: 文の質問は、内容語だけを取り出して検索する（単語はそのまま）', () => {
    equal(AI.wiki.searchTerm('植物はどうやって太陽の光から栄養を作るの'), '植物 太陽 栄養');
    equal(AI.wiki.searchTerm('寝ている間に脳は何をしている'), '寝 脳');
    equal(AI.wiki.searchTerm('光合成はどこで行われるの'), '光合成');
    equal(AI.wiki.searchTerm('AI'), 'AI');
    equal(AI.wiki.searchTerm('光合成'), '光合成');
    equal(AI.wiki.searchTerm('  '), '');
  });

  test('wiki: 文の質問では、取り出した言葉で検索する', async () => {
    const seen = [];
    await AI.wiki.search('植物はどうやって太陽の光から栄養を作るの', { fetchImpl: routedFetch({ 1: page('光合成', '説明。', 1) }, 'fail', seen) });
    equal(seen[0].searchParams.get('gsrsearch'), '植物 太陽 栄養');
    equal(seen.length, 1, '文のときは記事名の一致確認はしない');
  });
})();
