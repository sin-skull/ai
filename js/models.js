// モデルを1つずつ載せる管理。
// - メモリに載せるモデルは、いつも1つだけ（検索モデルと回答モデルを同時に持たない）。
// - 別のモデルを使う前に、今載っているモデルを外す（外してから、少し待つ）。
// - モデルを使う処理（検索、ベクトル作成、答えの生成、有効化）は、すべて1列に並べて1つずつ実行する。
//   バックグラウンドの処理や、ボタンの連打があっても重ならない。
//
// 使い方：
//   const m = AI.models.create();
//   m.register('embed', () => provider);   // { ready, prepare(onProgress), unload() } を返す関数
//   await m.run('embed', (model) => model.embed(...), { onProgress });
//   await m.exclusive(async () => { ... 何も載っていない状態で実行 ... });
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});

  function create({ pauseMs = 60, onEvent } = {}) {
    const getters = new Map();
    let resident = null; // { kind, model }
    let chain = Promise.resolve();
    let waiting = 0;
    let running = null; // 実行中の処理の種類（表示用）
    const emit = (type, detail) => {
      try {
        if (onEvent) onEvent(type, detail);
      } catch (_) {
        /* 表示の失敗は本体に影響させない */
      }
    };
    const pause = () => new Promise((r) => setTimeout(r, pauseMs));

    async function unloadResident() {
      if (!resident) return;
      const { kind, model } = resident;
      resident = null;
      emit('unload', { kind });
      try {
        if (model && model.unload) await model.unload();
      } catch (_) {
        /* 外せなくても参照は切る */
      }
      await pause(); // 後片付けの時間
    }

    // 処理を列の最後に並べる。前の処理が失敗しても、列は止めない
    function enqueue(label, job) {
      waiting++;
      const p = chain.then(async () => {
        waiting--;
        running = label;
        try {
          return await job();
        } finally {
          running = null;
        }
      });
      chain = p.catch(() => {});
      return p;
    }

    return {
      register(kind, getter) {
        getters.set(kind, getter);
      },
      // kind のモデルを載せて（別のが載っていれば先に外して）、work(model) を実行する
      run(kind, work, { onProgress, prepare } = {}) {
        return enqueue(kind, async () => {
          const getter = getters.get(kind);
          const model = getter && getter();
          if (!model) throw new Error('モデルが用意されていません');
          if (resident && (resident.kind !== kind || resident.model !== model)) await unloadResident();
          if (!model.ready) {
            emit('load', { kind });
            if (prepare) await prepare(model, onProgress);
            else await model.prepare(onProgress);
          }
          resident = { kind, model };
          return work ? work(model) : true;
        });
      },
      // 何も載っていない状態で実行する（有効にする・消す、など）。戻り値が { adopt: { kind, model } } なら、それを載っている扱いにする
      exclusive(work) {
        return enqueue('exclusive', async () => {
          await unloadResident();
          const result = await work();
          if (result && result.adopt) resident = { kind: result.adopt.kind, model: result.adopt.model };
          return result;
        });
      },
      // 今載っているモデルを外す（列に並べて実行）
      release() {
        return enqueue('release', unloadResident);
      },
      // 載っているモデルが kind で、それが使えなくなったとき（オフにしたなど）。列を待たずに参照だけ切る
      forget(kind) {
        if (resident && resident.kind === kind) resident = null;
      },
      resident: () => (resident ? resident.kind : null),
      busy: () => running !== null || waiting > 0,
      running: () => running,
      idle: () => chain,
    };
  }

  AI.models = { create };
})(typeof globalThis !== 'undefined' ? globalThis : window);
