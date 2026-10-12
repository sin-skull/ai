// 文章ストア。貼り付けた文章を保存し、文字2-gramの転置インデックスで探す。
//
// 1件の形:
//   id         自動採番
//   title      見出し（空なら本文の先頭から作る）
//   body       本文
//   sourceUrl  出典URL（無ければ空）
//   license    ライセンス表記（例: 'CC BY-SA 4.0'。無ければ空）
//   terms      関連する単語（表示用の表記）
//   fetchedAt  保存した時刻（ミリ秒）
//   useCount / score  フェーズ5・6で使う（今は初期値）
//
// 本体とインデックスは必ず同じトランザクションで更新する（片方だけ残らない）。
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});
  const { tx, rq } = AI.db;

  const TITLE_MAX = 30;
  const FUZZY_MIN = 0.4; // ゆるい検索で、質問の2文字の並び（内容を表すもの）のうちこの割合以上、かつ2つ以上を含む文章だけ残す

  // 正規化した文字列から、空白を含まない2文字の並び（1文字だけなら1文字）を重複なしで取る
  function grams(text) {
    const s = AI.normalizeTerm(text);
    const out = new Set();
    for (const word of s.split(' ')) {
      const chars = Array.from(word);
      if (chars.length === 1) out.add(chars[0]);
      for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
    }
    return [...out];
  }

  function makeTitle(title, body) {
    const t = String(title ?? '').trim();
    if (t) return t;
    const first = String(body).trim().split(/\n/)[0].trim();
    return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX)}…` : first;
  }

  async function indexAdd(store, id, text) {
    for (const gram of grams(text)) {
      const entry = (await rq(store.get(gram))) || { gram, ids: [] };
      if (!entry.ids.includes(id)) {
        entry.ids.push(id);
        await rq(store.put(entry));
      }
    }
  }

  async function indexRemove(store, id, text) {
    for (const gram of grams(text)) {
      const entry = await rq(store.get(gram));
      if (!entry) continue;
      const ids = entry.ids.filter((x) => x !== id);
      if (ids.length === 0) await rq(store.delete(gram));
      else if (ids.length !== entry.ids.length) await rq(store.put({ gram, ids }));
    }
  }

  // 戻り値: 保存した文章（id つき）
  async function add(db, body, options = {}) {
    const text = String(body ?? '').trim();
    if (!text) throw new Error('文章が空です');
    const now = options.now ?? Date.now();
    const record = {
      title: makeTitle(options.title, text),
      body: text,
      sourceUrl: options.sourceUrl || '',
      license: options.license || '',
      terms: Array.isArray(options.terms) ? options.terms.map(String) : [],
      fetchedAt: now,
      useCount: 0,
      score: 0,
    };
    return tx(db, ['passages', 'ngram'], 'readwrite', async (t) => {
      const id = await rq(t.objectStore('passages').add(record));
      record.id = id;
      await indexAdd(t.objectStore('ngram'), id, `${record.title}\n${record.body}`);
      return record;
    });
  }

  async function get(db, id) {
    return tx(db, 'passages', 'readonly', (t) => rq(t.objectStore('passages').get(id)));
  }

  // 新しい順
  async function list(db) {
    const all = await tx(db, 'passages', 'readonly', (t) => rq(t.objectStore('passages').getAll()));
    return all.sort((a, b) => b.fetchedAt - a.fetchedAt || b.id - a.id);
  }

  async function count(db) {
    return tx(db, 'passages', 'readonly', (t) => rq(t.objectStore('passages').count()));
  }

  // ids の文章を消す（1件でも複数でも）。インデックスと意味ベクトルも同時に消す。
  // deleteTerms: true なら、消す文章に紐づく単語も単語辞書から消す（既定は残す）。
  // 戻り値: 実際に消した件数
  async function remove(db, ids, options = {}) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => Number.isInteger(x));
    if (!list.length) return 0;
    const stores = ['passages', 'ngram', 'vectors'].concat(options.deleteTerms ? ['terms'] : []);
    return tx(db, stores, 'readwrite', async (t) => {
      let removed = 0;
      for (const id of list) {
        const record = await rq(t.objectStore('passages').get(id));
        if (!record) continue;
        await indexRemove(t.objectStore('ngram'), id, `${record.title}\n${record.body}`);
        await rq(t.objectStore('vectors').delete(id));
        await rq(t.objectStore('passages').delete(id));
        if (options.deleteTerms) {
          for (const term of record.terms) {
            const key = AI.normalizeTerm(term);
            if (key) await rq(t.objectStore('terms').delete(key));
          }
        }
        removed++;
      }
      return removed;
    });
  }

  // 本文の中の一致位置の前後を切り出す
  function snippet(body, word, width = 40) {
    const text = String(body).replace(/\s+/g, ' ');
    const at = AI.normalizeTerm(text).indexOf(word);
    if (at < 0) return text.slice(0, width * 2);
    const from = Math.max(0, at - width / 2);
    const piece = text.slice(from, from + width * 2);
    return (from > 0 ? '…' : '') + piece + (from + width * 2 < text.length ? '…' : '');
  }

  // ゆるい検索：質問に含まれる2文字の並びのうち、一定割合以上を含む文章を、割合が高い順に。
  // 日本語の質問は空白で区切れないので、文全体が一続きで本文に入っていなくても拾えるようにする。
  async function fuzzy(db, query, limit) {
    // ひらがなだけの2文字（「った」「には」など）は助詞や活用が多く、内容を表さないので、数えない
    const all = grams(query);
    const informative = all.filter((g) => /[^\u3041-\u309f\s]/.test(g));
    const qgrams = informative.length >= 2 ? informative : all;
    if (qgrams.length < 2) return [];
    const counts = new Map();
    await tx(db, 'ngram', 'readonly', async (t) => {
      const index = t.objectStore('ngram');
      for (const gram of qgrams) {
        const entry = await rq(index.get(gram));
        if (entry) for (const id of entry.ids) counts.set(id, (counts.get(id) || 0) + 1);
      }
    });
    const ranked = [...counts.entries()]
      .map(([id, n]) => ({ id, coverage: n / qgrams.length }))
      .filter((x) => x.coverage >= FUZZY_MIN && x.coverage * qgrams.length >= 2)
      .sort((a, b) => b.coverage - a.coverage)
      .slice(0, limit);
    const out = [];
    for (const { id, coverage } of ranked) {
      const passage = await get(db, id);
      if (!passage) continue;
      const text = AI.normalizeTerm(`${passage.title}\n${passage.body}`);
      const first = qgrams.find((g) => text.includes(g)) || qgrams[0];
      out.push({ passage, hits: coverage, snippet: snippet(passage.body, first), fuzzy: true });
    }
    return out;
  }

  // 空白で区切った語を全て含む文章を探す。戻り値: [{ passage, hits, snippet }]（一致が多い順）
  // 1件も無いときは、ゆるい検索（fuzzy: true の結果）に切り替える。options.fuzzy === false で切る。
  async function search(db, query, options = {}) {
    const words = AI.normalizeTerm(query).split(' ').filter(Boolean);
    if (!words.length) return [];
    const limit = options.limit ?? 20;

    const candidates = await tx(db, ['ngram', 'passages'], 'readonly', async (t) => {
      const index = t.objectStore('ngram');
      let ids = null; // null = まだ絞り込んでいない
      for (const word of words) {
        if (Array.from(word).length < 2) continue; // 1文字は索引で絞れないので、後の本文照合で確かめる
        for (const gram of grams(word)) {
          const entry = await rq(index.get(gram));
          const found = new Set(entry ? entry.ids : []);
          ids = ids === null ? found : new Set([...ids].filter((x) => found.has(x)));
          if (ids.size === 0) return [];
        }
      }
      if (ids === null) return rq(t.objectStore('passages').getAll()); // 1文字だけの検索は全件から
      const records = [];
      for (const id of ids) records.push(await rq(t.objectStore('passages').get(id)));
      return records.filter(Boolean);
    });

    // 2-gram が全部あっても語が連続しているとは限らないので、本文で確かめる
    const results = [];
    for (const passage of candidates) {
      const haystack = AI.normalizeTerm(`${passage.title}\n${passage.body}`);
      if (!words.every((w) => haystack.includes(w))) continue;
      const hits = words.reduce((n, w) => n + haystack.split(w).length - 1, 0);
      results.push({ passage, hits, snippet: snippet(passage.body, words[0]) });
    }
    const strict = results.sort((a, b) => b.hits - a.hits || b.passage.fetchedAt - a.passage.fetchedAt).slice(0, limit);
    if (strict.length || options.fuzzy === false) return strict;
    return fuzzy(db, query, limit);
  }

  // 本文を差し替える（再取得用）。インデックスも同じトランザクションで更新し、評価・使用回数・ピンは引き継ぐ。
  // ベクトルは古くなるので消す（意味検索がオンなら、呼び出し側で作り直す）
  async function replaceBody(db, id, body, options = {}) {
    const text = String(body ?? '').trim();
    if (!text) throw new Error('文章が空です');
    return tx(db, ['passages', 'ngram', 'vectors'], 'readwrite', async (t) => {
      const store = t.objectStore('passages');
      const record = await rq(store.get(id));
      if (!record) throw new Error('文章が見つかりません');
      await indexRemove(t.objectStore('ngram'), id, `${record.title}\n${record.body}`);
      record.body = text;
      record.fetchedAt = options.now ?? Date.now();
      await rq(store.put(record));
      await indexAdd(t.objectStore('ngram'), id, `${record.title}\n${record.body}`);
      await rq(t.objectStore('vectors').delete(id));
      return record;
    });
  }

  AI.passages = { grams, add, get, list, count, remove, replaceBody, search };
})(typeof globalThis !== 'undefined' ? globalThis : window);
