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

  // 文のままの質問（「植物はどうやって太陽の光から栄養を作るの」）をそのまま検索すると、
  // 全文検索が「葉」のような一語に引っ張られる。漢字・カタカナ・英数字のかたまり（助詞や活用語尾を除いた内容語）を空白でつなぐ。
  // 短い言葉（単語）はそのまま使う
  const SENTENCE_MIN = 9;
  const STOP_SINGLE = ['何', '間', '時', '中', '事', '物', '方', '様', '他', '今', '前', '後', '内', '外', '上', '下', '所', '為'];
  function searchTerm(query) {
    const q = String(query ?? '').trim();
    if (Array.from(q).length < SENTENCE_MIN && !/\s/.test(q)) return q;
    const words = q.match(/[\u4e00-\u9fff\u30a1-\u30fa\u30fc\u3005a-zA-Z0-9]+/g) || [];
    const long = words.filter((w) => Array.from(w).length >= 2);
    // 2文字以上の語があればそれだけ。無ければ1文字の語から、意味の薄いもの（何・間など）を除く
    const singles = words.filter((w) => !STOP_SINGLE.includes(w));
    const picked = long.length ? long : singles.length ? singles : words.length ? words : [q];
    return [...new Set(picked)].join(' ');
  }

  // 戻り値: [{ title, url, extract }]（関連が高い順。見つからなければ空）
  async function search(query, options = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const { limit = 5, signal, fetchImpl } = options;

    const term = searchTerm(q);
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      origin: '*',
      generator: 'search',
      gsrsearch: term,
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
    const found = pages
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map((p) => ({ title: p.title, url: p.fullurl, extract: shorten(p.extract) }))
      .filter((p) => p.extract);
    if (options.exact === false) return found;

    // 検索の順位は、短い言葉だと意図と違う記事が先に来ることがある。記事名がぴったり一致するものがあれば先頭にする
    if (term !== q) return found; // 文の質問は、記事名との一致を見ない
    try {
      const exact = await byTitle(q, { signal, fetchImpl });
      if (exact) return [exact].concat(found.filter((p) => p.title !== exact.title)).slice(0, limit);
    } catch (_) {
      /* 一致の確認ができなくても、検索結果は返す */
    }
    return found;
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

  AI.wiki = { ENDPOINT, shorten, searchTerm, search, byTitle };
})(typeof globalThis !== 'undefined' ? globalThis : window);
