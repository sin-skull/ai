// 段階の記録（診断）のテスト。localStorage の代わりに、メモリ上の入れ物を使う。
(function () {
  'use strict';
  const { test, equal, ok } = window.T;

  function memStorage() {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
  }

  test('diag: 段階の途中で終わると、次の起動でその段階を返す（強制終了の検知）', async () => {
    const st = memStorage();
    const d1 = AI.diag.create({ name: 't', storage: st });
    await d1.begin('init', { engine: 'gpu', model: 'lfm2' });
    // ここで強制終了したことにする（end を呼ばない）
    const d2 = AI.diag.create({ name: 't', storage: st });
    const crash = await d2.boot();
    equal(crash.stage, 'init');
    equal(crash.info.engine, 'gpu');
    ok(d2.events().some((e) => e.kind === 'crash' && e.stage === 'init'));
    equal(await AI.diag.create({ name: 't', storage: st }).boot(), null, '2回目の起動では、もう言わない');
  });

  test('diag: 終わった段階・ふつうに閉じたときは、落ちた扱いにしない', async () => {
    const st = memStorage();
    const d1 = AI.diag.create({ name: 't', storage: st });
    await d1.step('download', {}, async () => 1);
    equal(await AI.diag.create({ name: 't', storage: st }).boot(), null);
    const d3 = AI.diag.create({ name: 't', storage: st });
    await d3.begin('generate', {});
    await new Promise((r) => setTimeout(r, 5));
    d3.markClean(); // pagehide
    equal(await AI.diag.create({ name: 't', storage: st }).boot(), null);
  });

  test('diag: 決まった項目だけを記録し、質問の本文は残さない', async () => {
    const st = memStorage();
    const d = AI.diag.create({ name: 't', storage: st });
    await d.begin('read', { chars: 120, query: '秘密の質問', content: '資料の本文', engine: 'cpu' });
    const all = JSON.stringify([...st._m.values()]);
    ok(!all.includes('秘密の質問') && !all.includes('資料の本文'), '本文が入っていない');
    ok(all.includes('120'));
  });

  test('diag: 失敗は「エラー」として残り、落ちた扱いにしない', async () => {
    const st = memStorage();
    const d = AI.diag.create({ name: 't', storage: st });
    let thrown = false;
    try {
      await d.step('first', {}, async () => {
        throw new Error('計算できない');
      });
    } catch (_) {
      thrown = true;
    }
    ok(thrown);
    ok(d.events().some((e) => e.kind === 'error' && e.message.includes('計算できない')));
    equal(await AI.diag.create({ name: 't', storage: st }).boot(), null);
  });

  test('diag: IndexedDB など（persist）にも残す。新しい方を使う', async () => {
    const st = memStorage();
    let saved = null;
    const persist = { load: async () => saved, save: async (v) => (saved = v) };
    const d = AI.diag.create({ name: 't', storage: st, persist });
    await d.begin('generate', { turn: 3 });
    st.removeItem('t-diag-cur'); // localStorage 側が消えていても
    const crash = await AI.diag.create({ name: 't', storage: st, persist }).boot();
    equal(crash.stage, 'generate');
    equal(crash.info.turn, 3);
    equal(saved, null, '起動時に消す');
  });
})();
