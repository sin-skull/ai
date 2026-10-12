// モデルを1つずつ載せる管理のテスト。疑似モデルで、同時に2つ載らないこと・処理が重ならないことを確かめる。
(function () {
  'use strict';
  const { test, equal, ok } = window.T;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function fakeModel(name, log, state) {
    let ready = false;
    return {
      get ready() {
        return ready;
      },
      async prepare() {
        log.push(`load:${name}`);
        await wait(5);
        ready = true;
        state.loaded.add(name);
        state.max = Math.max(state.max, state.loaded.size);
      },
      async unload() {
        log.push(`unload:${name}`);
        await wait(3);
        ready = false;
        state.loaded.delete(name);
      },
    };
  }

  test('models: 別のモデルを使う前に、前のモデルを外す（同時に2つ載らない）', async () => {
    const log = [];
    const state = { loaded: new Set(), max: 0 };
    const m = AI.models.create({ pauseMs: 1 });
    const embed = fakeModel('embed', log, state);
    const llm = fakeModel('llm', log, state);
    m.register('embed', () => embed);
    m.register('llm', () => llm);
    await m.run('embed', () => log.push('use:embed'));
    await m.run('llm', () => log.push('use:llm'));
    await m.run('embed', () => log.push('use:embed'));
    equal(state.max, 1, '同時に載ったのは1つまで');
    equal(log.join(','), 'load:embed,use:embed,unload:embed,load:llm,use:llm,unload:llm,load:embed,use:embed');
    equal(m.resident(), 'embed');
  });

  test('models: 同時に頼まれても、1つずつ順に実行する（重ならない）', async () => {
    const log = [];
    const state = { loaded: new Set(), max: 0 };
    const m = AI.models.create({ pauseMs: 1 });
    const embedOnce = fakeModel('embed', log, state);
    const llm = fakeModel('llm', log, state);
    m.register('embed', () => embedOnce);
    m.register('llm', () => llm);
    let active = 0;
    let maxActive = 0;
    const job = (kind) =>
      m.run(kind, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await wait(4);
        active--;
      });
    await Promise.all([job('llm'), job('embed'), job('llm'), job('embed'), job('llm')]);
    equal(maxActive, 1, '処理は重ならない');
    equal(state.max, 1, 'モデルも同時に1つ');
  });

  test('models: 前の処理が失敗しても、列は止まらない', async () => {
    const log = [];
    const state = { loaded: new Set(), max: 0 };
    const m = AI.models.create({ pauseMs: 1 });
    const llm = fakeModel('llm', log, state);
    m.register('llm', () => llm);
    let failed = false;
    try {
      await m.run('llm', async () => {
        throw new Error('x');
      });
    } catch (_) {
      failed = true;
    }
    ok(failed);
    equal(await m.run('llm', async () => 'ok'), 'ok');
  });

  test('models: exclusive は何も載っていない状態で実行し、adopt で載せたことにできる', async () => {
    const log = [];
    const state = { loaded: new Set(), max: 0 };
    const m = AI.models.create({ pauseMs: 1 });
    const embed = fakeModel('embed', log, state);
    const llm = fakeModel('llm', log, state);
    m.register('embed', () => embed);
    m.register('llm', () => llm);
    await m.run('embed', null);
    await m.exclusive(async () => {
      equal(state.loaded.size, 0, '先に外れている');
      await llm.prepare();
      return { adopt: { kind: 'llm', model: llm } };
    });
    equal(m.resident(), 'llm');
    await m.run('llm', () => log.push('use'));
    equal(log.filter((x) => x === 'load:llm').length, 1, '載っているので読み直さない');
  });

  test('models: 読み込みに失敗したら、載っていない扱い', async () => {
    const m = AI.models.create({ pauseMs: 1 });
    const bad = { ready: false, async prepare() { throw new Error('読めない'); }, async unload() {} };
    m.register('llm', () => bad);
    let failed = false;
    try {
      await m.run('llm', () => 1);
    } catch (e) {
      failed = e.message === '読めない';
    }
    ok(failed);
    equal(m.resident(), null);
  });
})();
