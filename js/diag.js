// 段階の記録（診断）。モデルを動かす各段階の「始まり」を、動かす前に書き残す。
// Safari に強制終了されると、ページの側では例外として捕まえられない。そこで、始まりの記録が
// 終わりの記録なしに残っていたら、「その段階の途中で落ちた」と次の起動で分かるようにする。
//
// 守ること：
// - 記録するのは段階名と、数値・方式などの決まった項目だけ。質問の本文、資料の本文は記録しない。
// - 外部には送らない（この端末の localStorage と IndexedDB にだけ置く）。
// - ふつうに閉じた・再読み込みしたとき（pagehide）は、落ちた扱いにしない。
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});

  const STAGES = {
    download: 'ダウンロード（保存分の確認）',
    init: 'モデルの初期化（展開）',
    first: '最初の計算',
    read: '資料の読み込み',
    generate: '回答の生成',
    'embed-load': '検索モデルの読み込み',
    embed: '検索モデルの計算',
    reindex: '意味づけ（ベクトル）の更新',
    unload: 'モデルを外す',
  };
  // 記録してよい項目（これ以外は捨てる）
  const ALLOWED = ['engine', 'model', 'pack', 'chars', 'tokens', 'load', 'piece', 'pieces', 'done', 'total', 'boot', 'turn', 'runtime', 'sub'];
  const MAX_EVENTS = 200;

  function sanitize(info) {
    const out = {};
    if (!info || typeof info !== 'object') return out;
    for (const key of ALLOWED) {
      const v = info[key];
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
      else if (typeof v === 'boolean') out[key] = v;
      else if (typeof v === 'string') out[key] = v.slice(0, key === 'sub' ? 90 : 40);
    }
    return out;
  }

  // storage: localStorage と同じ形（getItem/setItem/removeItem）。persist: 確実に残したいとき用（IndexedDB など、await できるもの）
  function create({ name = 'ai', storage, persist } = {}) {
    const KEY_CUR = `${name}-diag-cur`;
    const KEY_LOG = `${name}-diag-log`;
    const KEY_CLEAN = `${name}-diag-clean`;
    const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const read = (k, d) => {
      try {
        const v = st && st.getItem(k);
        return v ? JSON.parse(v) : d;
      } catch (_) {
        return d;
      }
    };
    const write = (k, v) => {
      try {
        if (!st) return;
        if (v === null) st.removeItem(k);
        else st.setItem(k, JSON.stringify(v));
      } catch (_) {
        /* 書けなくても本体の動作は続ける */
      }
    };
    let current = null;

    function push(event) {
      const list = read(KEY_LOG, []);
      list.push({ t: Date.now(), ...event });
      write(KEY_LOG, list.slice(-MAX_EVENTS));
    }

    return {
      STAGES,
      // 起動時に1回呼ぶ。前回、段階の途中で終わっていたら（ふつうに閉じていなければ）、その段階を返す
      async boot() {
        let cur = read(KEY_CUR, null);
        if (persist && persist.load) {
          try {
            const saved = await persist.load();
            if (saved && (!cur || saved.at > cur.at)) cur = saved;
          } catch (_) {
            /* 読めなければ localStorage の分だけで判断 */
          }
        }
        const clean = Number(read(KEY_CLEAN, 0)) || 0;
        write(KEY_CUR, null);
        write(KEY_CLEAN, null);
        if (persist && persist.save) await persist.save(null).catch(() => {});
        if (!cur) return null;
        if (clean > cur.at) {
          push({ kind: 'closed', stage: cur.stage, info: cur.info });
          return null; // 途中でふつうに閉じただけ
        }
        push({ kind: 'crash', stage: cur.stage, info: cur.info });
        return cur;
      },
      async begin(stage, info) {
        current = { stage, info: sanitize(info), at: Date.now() };
        write(KEY_CUR, current); // すぐ書ける方を先に
        push({ kind: 'begin', stage, info: current.info });
        if (persist && persist.save) await persist.save(current).catch(() => {});
      },
      async end(extra) {
        if (!current) return;
        const ms = Date.now() - current.at;
        push({ kind: 'ok', stage: current.stage, info: { ...current.info, ...sanitize(extra) }, ms });
        current = null;
        write(KEY_CUR, null);
        if (persist && persist.save) await persist.save(null).catch(() => {});
      },
      async fail(error) {
        if (!current) return;
        push({ kind: 'error', stage: current.stage, info: current.info, message: String((error && error.message) || error || '').slice(0, 120) });
        current = null;
        write(KEY_CUR, null);
        if (persist && persist.save) await persist.save(null).catch(() => {});
      },
      // 段階を1つ、始まりと終わりを記録しながら実行する
      async step(stage, info, work) {
        await this.begin(stage, info);
        try {
          const result = await work();
          await this.end();
          return result;
        } catch (error) {
          await this.fail(error);
          throw error;
        }
      },
      // 段階の中の細かい進み具合（例：初期化の中の「実行用ファイルの準備」）。強制終了したら、最後に書いた内容が残る。
      // 実行ライブラリの記録だけを渡す（質問の本文は渡さない）
      note(text) {
        if (!current) return;
        current.info = { ...current.info, sub: String(text).replace(/\s+/g, ' ').slice(0, 90) };
        write(KEY_CUR, current);
      },
      markClean() {
        write(KEY_CLEAN, Date.now());
      },
      current: () => current,
      events: () => read(KEY_LOG, []),
      clear() {
        write(KEY_LOG, null);
      },
      label: (stage) => STAGES[stage] || stage,
      describe(event) {
        const i = event.info || {};
        const parts = [];
        if (i.engine) parts.push(i.engine);
        if (i.model) parts.push(i.model);
        if (i.chars) parts.push(`${i.chars}字`);
        if (i.tokens) parts.push(`${i.tokens}トークン`);
        if (i.pieces) parts.push(`塊${i.piece || '?'}/${i.pieces}`);
        if (i.turn) parts.push(`${i.turn}問目`);
        if (typeof i.load === 'number') parts.push(`答えの量${i.load}`);
        if (i.runtime) parts.push(i.runtime);
        if (i.sub) parts.push(`最後の処理：${i.sub}`);
        return `${STAGES[event.stage] || event.stage}${parts.length ? `（${parts.join('・')}）` : ''}`;
      },
    };
  }

  AI.diag = { create, sanitize, STAGES };
})(typeof globalThis !== 'undefined' ? globalThis : window);
