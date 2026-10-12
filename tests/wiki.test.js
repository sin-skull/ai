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
})();
