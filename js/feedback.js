// 評価（👍/👎）。押すたびにログ(feedback)へ1行足し、対象の score をログの合計に更新する。
// 対象: 'term'（id は正規化した見出し語）／'passage'（id は数値）
// 同じ向きをもう一度押すと取り消し（0 を記録）、逆向きを押すと付け替える。
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});
  const { tx, rq } = AI.db;

  const STORE = { term: 'terms', passage: 'passages' };

  // 今の評価（-1, 0, 1）：その対象の最後のログの値
  function latest(logs) {
    return logs.length ? logs[logs.length - 1].value : 0;
  }

  // value: 1 または -1。戻り値: { value（押した結果の今の評価）, score（対象の合計） } 対象が無ければ例外
  async function rate(db, targetType, targetId, value, options = {}) {
    if (!STORE[targetType]) throw new Error(`未知の対象: ${targetType}`);
    if (value !== 1 && value !== -1) throw new Error('評価は 1 か -1 です');
    const now = options.now ?? Date.now();
    return tx(db, [STORE[targetType], 'feedback'], 'readwrite', async (t) => {
      const target = t.objectStore(STORE[targetType]);
      const record = await rq(target.get(targetId));
      if (!record) throw new Error('評価する対象が見つかりません');

      const log = t.objectStore('feedback');
      const logs = await rq(log.index('target').getAll([targetType, targetId]));
      const now1 = latest(logs) === value ? 0 : value; // 同じ向きの再押しは取り消し
      await rq(log.add({ targetType, targetId, value: now1, at: now }));

      // score は「対象ごとの今の評価」なので、最新ログの値そのもの
      record.score = now1;
      await rq(target.put(record));
      return { value: now1, score: record.score };
    });
  }

  // 評価を指定の値（-1, 0, 1）にする。取り消し（元に戻す）に使う。ログには1行足す
  async function setValue(db, targetType, targetId, value, options = {}) {
    if (!STORE[targetType]) throw new Error(`未知の対象: ${targetType}`);
    if (![-1, 0, 1].includes(value)) throw new Error('評価は -1, 0, 1 のどれかです');
    const now = options.now ?? Date.now();
    return tx(db, [STORE[targetType], 'feedback'], 'readwrite', async (t) => {
      const target = t.objectStore(STORE[targetType]);
      const record = await rq(target.get(targetId));
      if (!record) throw new Error('評価する対象が見つかりません');
      await rq(t.objectStore('feedback').add({ targetType, targetId, value, at: now, via: options.via || 'button' }));
      record.score = value;
      await rq(target.put(record));
      return { value, score: record.score };
    });
  }

  async function current(db, targetType, targetId) {
    const logs = await tx(db, 'feedback', 'readonly', (t) =>
      rq(t.objectStore('feedback').index('target').getAll([targetType, targetId]))
    );
    return latest(logs);
  }

  async function history(db, targetType, targetId) {
    return tx(db, 'feedback', 'readonly', (t) =>
      rq(t.objectStore('feedback').index('target').getAll([targetType, targetId]))
    );
  }

  AI.feedback = { rate, setValue, current, history };
})(typeof globalThis !== 'undefined' ? globalThis : window);
