// 未回答キュー。答えられなかった質問を残しておき、オンラインのときにまとめて調べる。
//
// 1件の形:
//   id         自動採番
//   query      質問に含まれた語（入力のまま）
//   key        正規化した語（同じ質問を重ねないために使う）
//   status     'pending'（調べ待ち）| 'done'（覚えた）| 'dismissed'（いらない）
//   askedCount 同じ質問を聞かれた回数
//   createdAt / updatedAt  ミリ秒
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});
  const { tx, rq } = AI.db;

  const STATUSES = ['pending', 'done', 'dismissed'];

  // 調べ待ちに同じ語があれば回数を増やすだけ。無ければ足す。戻り値: レコード
  async function add(db, query, options = {}) {
    const text = String(query ?? '').trim();
    const key = AI.normalizeTerm(text);
    if (!key) throw new Error('質問が空です');
    const now = options.now ?? Date.now();
    return tx(db, 'queue', 'readwrite', async (t) => {
      const store = t.objectStore('queue');
      const pending = await rq(store.index('status').getAll('pending'));
      const same = pending.find((r) => r.key === key);
      if (same) {
        same.askedCount += 1;
        same.updatedAt = now;
        await rq(store.put(same));
        return same;
      }
      const record = { query: text, key, status: 'pending', askedCount: 1, createdAt: now, updatedAt: now };
      record.id = await rq(store.add(record));
      return record;
    });
  }

  // 古い順（先に聞かれたものから調べる）
  async function list(db, status = 'pending') {
    const rows = await tx(db, 'queue', 'readonly', (t) => rq(t.objectStore('queue').index('status').getAll(status)));
    return rows.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  }

  async function count(db, status = 'pending') {
    return tx(db, 'queue', 'readonly', (t) => rq(t.objectStore('queue').index('status').count(status)));
  }

  async function setStatus(db, id, status, options = {}) {
    if (!STATUSES.includes(status)) throw new Error(`未知の状態: ${status}`);
    const now = options.now ?? Date.now();
    return tx(db, 'queue', 'readwrite', async (t) => {
      const store = t.objectStore('queue');
      const record = await rq(store.get(id));
      if (!record) return false;
      record.status = status;
      record.updatedAt = now;
      await rq(store.put(record));
      return true;
    });
  }

  // 同じ語の調べ待ちを、まとめて「済み」にする（覚えたとき）。戻り値: 変えた件数
  async function resolve(db, query, options = {}) {
    const key = AI.normalizeTerm(String(query ?? ''));
    if (!key) return 0;
    const now = options.now ?? Date.now();
    return tx(db, 'queue', 'readwrite', async (t) => {
      const store = t.objectStore('queue');
      const pending = await rq(store.index('status').getAll('pending'));
      let n = 0;
      for (const r of pending) {
        if (r.key !== key) continue;
        r.status = 'done';
        r.updatedAt = now;
        await rq(store.put(r));
        n++;
      }
      return n;
    });
  }

  async function remove(db, id) {
    return tx(db, 'queue', 'readwrite', async (t) => {
      const store = t.objectStore('queue');
      const exists = (await rq(store.count(id))) > 0;
      if (exists) await rq(store.delete(id));
      return exists;
    });
  }

  AI.queue = { STATUSES, add, list, count, setStatus, resolve, remove };
})(typeof globalThis !== 'undefined' ? globalThis : window);
