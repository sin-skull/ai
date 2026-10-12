// Wikipedia（日本語版）で調べる。外部に通信するのはこのファイルだけ。
// 検索語はそのまま Wikipedia に送られる。呼ぶ側は、送る前に本人が押したときだけ呼ぶこと。
//
// 本文は CC BY-SA。保存するときは出典（記事のURLとタイトル）を必ず一緒に残す。
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});

  const ENDPOINT = 'https://ja.wikipedia.org/w/api.php';

  // 最初の段落を、文の切れ目（。）で max 文字以内に収める
  function shorten(text, max = 280) {
    const first =
      String(text ?? '')
        .split(/\n+/)
        .map((s) => s.trim())
        .find((s) => s) || '';
    if (first.length <= max) return first;
    const head = first.slice(0, max);
    const stop = head.lastIndexOf('。');
    return stop >= 40 ? head.slice(0, stop + 1) : `${head}…`;
  }

  // 戻り値: [{ title, url, extract }]（関連が高い順。見つからなければ空）
  async function search(query, options = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const { limit = 3, signal, fetchImpl } = options;

    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      origin: '*',
      generator: 'search',
      gsrsearch: q,
      gsrlimit: String(limit),
      prop: 'extracts|info',
      exintro: '1',
      explaintext: '1',
      exlimit: 'max',
      inprop: 'url',
      redirects: '1',
    });

    // 通信は AI.net 経由（オフラインモード中はここで止まる）
    const response = await AI.net.fetch(`${ENDPOINT}?${params}`, { signal }, fetchImpl);
    if (!response.ok) throw new Error(`Wikipediaに繋がりませんでした（${response.status}）`);
    const data = await response.json();
    const pages = data && data.query && data.query.pages ? Object.values(data.query.pages) : [];
    return pages
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map((p) => ({ title: p.title, url: p.fullurl, extract: shorten(p.extract) }))
      .filter((p) => p.extract);
  }

  // 記事名を指定して、最新の冒頭を取る（保存した文章の再取得用）。無ければ null
  async function byTitle(title, options = {}) {
    const t = String(title ?? '').trim();
    if (!t) return null;
    const params = new URLSearchParams({
      action: 'query', format: 'json', origin: '*', titles: t,
      prop: 'extracts|info', exintro: '1', explaintext: '1', inprop: 'url', redirects: '1',
    });
    const response = await AI.net.fetch(`${ENDPOINT}?${params}`, { signal: options.signal }, options.fetchImpl);
    if (!response.ok) throw new Error(`Wikipediaに繋がりませんでした（${response.status}）`);
    const data = await response.json();
    const pages = data && data.query && data.query.pages ? Object.values(data.query.pages) : [];
    const page = pages.find((p) => !p.missing && p.extract);
    return page ? { title: page.title, url: page.fullurl, extract: shorten(page.extract) } : null;
  }

  AI.wiki = { ENDPOINT, shorten, search, byTitle };
})(typeof globalThis !== 'undefined' ? globalThis : window);
