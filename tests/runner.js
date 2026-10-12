// 依存なしの小さなテストランナー。ブラウザで tests/test.html を開くと実行される。
(function (root) {
  'use strict';
  const cases = [];

  function test(name, fn) {
    cases.push({ name, fn });
  }

  function equal(actual, expected, message) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${message || '値が違う'}\n  期待: ${e}\n  実際: ${a}`);
  }

  function ok(value, message) {
    if (!value) throw new Error(message || '真であるべき');
  }

  async function rejects(promise, message) {
    try {
      await promise;
    } catch (_) {
      return;
    }
    throw new Error(message || '例外が出るべき');
  }

  async function run() {
    const results = [];
    const list = document.getElementById('results');
    for (const c of cases) {
      let error = null;
      try {
        await c.fn();
      } catch (e) {
        error = e;
      }
      results.push({ name: c.name, passed: !error, error: error ? String(error.message) : null });
      const li = document.createElement('li');
      li.className = error ? 'ng' : 'ok';
      li.textContent = `${error ? '✕' : '○'} ${c.name}`;
      if (error) {
        const pre = document.createElement('pre');
        pre.textContent = error.message;
        li.appendChild(pre);
      }
      list.appendChild(li);
    }
    const failed = results.filter((r) => !r.passed).length;
    document.getElementById('summary').textContent =
      failed === 0 ? `全${results.length}件 成功` : `${failed}件 失敗 / 全${results.length}件`;
    root.__testResults = { total: results.length, failed, results };
  }

  root.T = { test, equal, ok, rejects, run };
})(window);
