// 外部への通信は、全てここを通す。オフラインモード中は、通信を試みる前に止める。
// モードは settings に保存し、次に開いたときも引き継ぐ（端末の接続状態とは別のスイッチ）。
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});

  const KEY = 'mode'; // settings の名前。値は 'online' | 'offline'
  let offline = false;
  const listeners = [];

  function isOffline() {
    return offline;
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  async function load(db) {
    const row = await AI.db.tx(db, 'settings', 'readonly', (t) => AI.db.rq(t.objectStore('settings').get(KEY)));
    offline = !!row && row.value === 'offline';
    listeners.forEach((fn) => fn(offline));
    return offline;
  }

  async function setOffline(db, value) {
    const next = !!value;
    if (db) {
      await AI.db.tx(db, 'settings', 'readwrite', (t) =>
        AI.db.rq(t.objectStore('settings').put({ name: KEY, value: next ? 'offline' : 'online' }))
      );
    }
    offline = next;
    listeners.forEach((fn) => fn(offline));
    return offline;
  }

  // 外部通信はこの関数だけ。fetchImpl はテスト用。
  function guardedFetch(url, init, fetchImpl) {
    if (offline) {
      return Promise.reject(new Error('オフラインモードなので、外部には通信しません。'));
    }
    return (fetchImpl || ((...args) => root.fetch(...args)))(url, init);
  }

  AI.net = { isOffline, onChange, load, setOffline, fetch: guardedFetch };
})(typeof globalThis !== 'undefined' ? globalThis : window);
