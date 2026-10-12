// 単語辞書。同じ語（正規化したキーが同じ）は1件に統合する。
//
// 1件の形:
//   key        正規化した見出し語（主キー）
//   term       最初に保存したときの表記（表示用）
//   variants   これまでに見た表記ゆれの一覧
//   definition 定義
//   sources    出典の一覧 [{ url, title, license, at }]
//   createdAt / updatedAt  ミリ秒
//   useCount / score       フェーズ5・6で使う（今は初期値）
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});
  const { tx, rq } = AI.db;

  // 同じ語が既にあり、定義が違うときの扱い
  //   'ask'       書き込まず { status: 'conflict' } を返す（画面で選ばせる）
  //   'overwrite' 新しい定義で置き換える
  //   'append'    今の定義の後ろに足す
  //   'ignore'    今のまま残す
  const POLICIES = ['ask', 'overwrite', 'append', 'ignore'];

  function addSource(record, source, at) {
    if (!source || (!source.url && !source.title)) return false;
    if (source.url && record.sources.some((s) => s.url === source.url)) return false;
    record.sources.push({ url: source.url || '', title: source.title || '', license: source.license || '', at });
    return true;
  }

  function addVariant(record, display) {
    if (record.variants.includes(display)) return false;
    record.variants.push(display);
    return true;
  }

  // 戻り値: { status: 'created' | 'updated' | 'unchanged' | 'conflict', record }
  //   conflict のときは { status, existing, incoming } で、何も書き込まない。
  async function add(db, term, definition, options = {}) {
    const display = String(term ?? '').trim();
    const key = AI.normalizeTerm(display);
    if (!key) throw new Error('単語が空です');

    const policy = options.onConflict || 'ask';
    if (!POLICIES.includes(policy)) throw new Error(`未知の onConflict: ${policy}`);

    const def = String(definition ?? '').trim();
    const now = options.now ?? Date.now();

    return tx(db, 'terms', 'readwrite', async (t) => {
      const store = t.objectStore('terms');
      const current = await rq(store.get(key));

      if (!current) {
        const record = {
          key,
          term: display,
          variants: [display],
          definition: def,
          sources: [],
          createdAt: now,
          updatedAt: now,
          useCount: 0,
          score: 0,
        };
        addSource(record, options.source, now);
        await rq(store.put(record));
        return { status: 'created', record };
      }

      const record = current;
      const variantAdded = addVariant(record, display);
      const sourceAdded = addSource(record, options.source, now);
      const metaChanged = variantAdded || sourceAdded;

      // 定義に変更が無い（同じ、または新しい定義が空）
      if (def === '' || def === record.definition) {
        if (metaChanged) await rq(store.put(record));
        return { status: 'unchanged', record };
      }

      // 今の定義が空なら、衝突ではなく単なる補完
      if (record.definition === '') {
        record.definition = def;
        record.updatedAt = now;
        await rq(store.put(record));
        return { status: 'updated', record };
      }

      // ここから先は定義が食い違っている
      if (policy === 'ask') {
        return {
          status: 'conflict',
          existing: current,
          incoming: { term: display, definition: def },
        };
      }
      if (policy === 'ignore') {
        if (metaChanged) await rq(store.put(record));
        return { status: 'unchanged', record };
      }
      if (policy === 'append') {
        if (record.definition.includes(def)) {
          if (metaChanged) await rq(store.put(record));
          return { status: 'unchanged', record };
        }
        record.definition = `${record.definition}\n${def}`;
      } else {
        record.definition = def; // overwrite
      }
      record.updatedAt = now;
      await rq(store.put(record));
      return { status: 'updated', record };
    });
  }

  async function get(db, term) {
    const key = AI.normalizeTerm(String(term ?? ''));
    if (!key) return undefined;
    return tx(db, 'terms', 'readonly', (t) => rq(t.objectStore('terms').get(key)));
  }

  // 更新が新しい順
  async function list(db) {
    const all = await tx(db, 'terms', 'readonly', (t) => rq(t.objectStore('terms').getAll()));
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function count(db) {
    return tx(db, 'terms', 'readonly', (t) => rq(t.objectStore('terms').count()));
  }

  // 消したら true、そもそも無かったら false
  async function remove(db, term) {
    const key = AI.normalizeTerm(String(term ?? ''));
    if (!key) return false;
    return tx(db, 'terms', 'readwrite', async (t) => {
      const store = t.objectStore('terms');
      const exists = (await rq(store.count(key))) > 0;
      if (exists) await rq(store.delete(key));
      return exists;
    });
  }

  AI.terms = { POLICIES, add, get, list, count, remove };
})(typeof globalThis !== 'undefined' ? globalThis : window);
