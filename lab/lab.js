// 試験室の本体。アプリと同じ部品（llm.js・rag.js・models.js・diag.js）を使って、段階を追って試す。
// アプリの記憶（IndexedDB）には触れない。試験用の資料は data.js にある。
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const el = {
    env: $('#env'), model: $('#model'), engine: $('#engine'), runtime: $('#runtime'), swap: $('#swap'), condNote: $('#cond-note'), runAll: $('#run-all'), stop: $('#stop'),
    unload: $('#unload'), status: $('#status'), out: $('#out'), results: $('#results tbody'), copy: $('#copy'), clearResults: $('#clear-results'),
    diag: $('#diag'), cache: $('#cache'), clearCache: $('#clear-cache'), log: $('#log'), crash: $('#crash'),
  };
  const DATA = window.LAB_DATA;
  const PACKS = [AI.llm.TINY_PACK].concat(AI.llm.GGUF_PACKS);
  const packOf = () => PACKS.find((p) => p.id === el.model.value);

  for (const p of PACKS) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${p.label}（約${p.approxMB}MB）`;
    el.model.appendChild(o);
  }
  for (const [id, e] of Object.entries(AI.llm.ENGINES)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = e.label;
    el.engine.appendChild(o);
  }
  const showNote = () => {
    const p = packOf();
    el.condNote.textContent = `${p.note || ''}${p.raw ? '（配管テスト用：意味のある答えは出ないので、品質は測りません）' : ''} ライセンス：${p.license}`;
  };
  el.model.addEventListener('change', () => {
    resetModel();
    showNote();
  });
  el.engine.addEventListener('change', resetModel);
  el.runtime.addEventListener('change', resetModel);
  showNote();

  function log(text) {
    el.log.textContent += `${new Date().toLocaleTimeString('ja-JP')} ${text}\n`;
    el.log.scrollTop = el.log.scrollHeight;
  }

  // ---- 段階の記録（アプリとは別の名前で記録する）----
  const diag = AI.diag.create({ name: 'lab' });
  window.addEventListener('pagehide', () => diag.markClean());
  const RESULTS_KEY = 'lab-results-v2';
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v ? JSON.parse(v) : d;
      } catch (_) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (_) {
        /* 使えなくても試験はできる */
      }
    },
  };
  function addResult(r) {
    const list = store.get(RESULTS_KEY, []);
    list.push({ at: Date.now(), ...r });
    store.set(RESULTS_KEY, list.slice(-60));
    renderResults();
  }
  function renderResults() {
    el.results.replaceChildren();
    for (const r of store.get(RESULTS_KEY, []).slice().reverse()) {
      const tr = document.createElement('tr');
      const cells = [`${r.test}\n${r.model}／${r.engine}${r.runtime ? `／${r.runtime}` : ''}${r.swap ? '＋入替' : ''}`, r.result, r.first != null ? `${r.first}秒` : '—', r.speed != null ? `${r.speed}` : '—', r.quality || '—'];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        td.textContent = c;
        td.style.whiteSpace = 'pre-wrap';
        if (i === 1) td.className = r.ok ? 'ok' : 'ng';
        tr.appendChild(td);
      });
      el.results.appendChild(tr);
    }
  }
  function renderDiag() {
    const mark = { begin: '▶', ok: '✓', error: '×', crash: '💥', closed: '・' };
    const ev = diag.events().slice(-30);
    el.diag.textContent = ev.length
      ? ev.map((e) => `${new Date(e.t).toLocaleTimeString('ja-JP')} ${mark[e.kind] || ''} ${diag.describe(e)}${e.ms != null ? ` ${(e.ms / 1000).toFixed(1)}秒` : ''}${e.message ? `：${e.message}` : ''}`).join('\n')
      : 'まだありません';
  }

  // ---- この端末 ----
  async function describeEnv() {
    const lines = [];
    const ua = navigator.userAgent;
    const app = /CriOS/.test(ua) ? 'iPhone の Chrome' : /FxiOS/.test(ua) ? 'iPhone の Firefox' : /EdgiOS/.test(ua) ? 'iPhone の Edge' : /iPhone|iPad/.test(ua) ? 'Safari（またはホーム画面のアプリ）' : 'その他';
    lines.push(`アプリ：${app}`);
    lines.push(`ブラウザ：${ua.replace(/^Mozilla\/5\.0 /, '')}`);
    lines.push(`CPUの数：${navigator.hardwareConcurrency || '不明'}`);
    lines.push(`使える機能：${AI.llm.needCompat() ? 'JSPI か 64bitメモリが無い' : 'JSPI・64bitメモリあり'}／自動で選ぶ実行用ファイル：${AI.llm.runtimeOf('auto') === 'compat' ? '互換版' : '速い版'}`);
    let gpu = '無し';
    try {
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        gpu = adapter ? `あり（バッファの上限 ${Math.round(adapter.limits.maxBufferSize / 1048576)}MB。※上限の値だけでは、動くかは分からない）` : 'あり（ただし使えるGPUが見つからない）';
      }
    } catch (e) {
      gpu = `調べられない（${e.message}）`;
    }
    lines.push(`GPU（WebGPU）：${gpu}`);
    lines.push(`複数スレッド：${self.crossOriginIsolated ? '使える' : '使えない（1スレッドで動く）'}`);
    try {
      const est = await navigator.storage.estimate();
      lines.push(`保存領域：使用 ${Math.round(est.usage / 1048576)}MB／上限の目安 ${Math.round(est.quota / 1048576)}MB`);
    } catch (_) {
      /* 不明でよい */
    }
    el.env.textContent = lines.join('\n');
  }

  // ---- モデル（1つずつ載せる）----
  const models = AI.models.create();
  let generator = null;
  let provider = null;
  let loadedKey = '';
  models.register('llm', () => generator);
  models.register('embed', () => provider);
  const currentKey = () => `${el.model.value}@${el.engine.value}@${el.runtime.value}`;
  function resetModel() {
    if (generator && loadedKey !== currentKey()) {
      const g = generator;
      generator = null;
      models.forget('llm');
      models.exclusive(() => g.unload());
    }
  }
  function ensureGenerator() {
    if (!generator || loadedKey !== currentKey()) {
      generator = AI.llm.createGenerator(packOf(), { engine: el.engine.value, runtime: el.runtime.value, diag });
      loadedKey = currentKey();
    }
    return generator;
  }
  let lastPct = -1;
  const onProgress = ({ loaded, total }) => {
    const p = total ? Math.floor((loaded / total) * 100) : 0;
    if (p !== lastPct && p % 10 === 0) {
      lastPct = p;
      setStatus(`ダウンロード ${p}%（${Math.round(loaded / 1048576)}／${Math.round(total / 1048576)}MB）`);
    }
  };
  function withLlm(work) {
    ensureGenerator();
    return models.run('llm', work, { onProgress });
  }
  // 検索モデルとの入れ替え（意味検索で質問を数値にする → 外して回答モデルへ）。かかった秒数を返す
  async function embedQuery(q) {
    if (!el.swap.checked) return null;
    if (!provider) provider = AI.embed.transformersProvider(AI.embed.PACKS[0]);
    const t0 = performance.now();
    await models.run('embed', (p) => diag.step('embed', { model: 'e5' }, () => p.embed([q], 'query')), {
      prepare: (m, prog) => diag.step('embed-load', { model: 'e5' }, () => m.prepare(prog)),
    });
    return (performance.now() - t0) / 1000;
  }

  // ---- 計測 ----
  const jaRatio = (t) => {
    const s = String(t || '').replace(/\s/g, '');
    if (!s) return 0;
    return (s.match(/[ぁ-んァ-ヶー一-龯々、。「」（）]/g) || []).length / s.length;
  };
  const keyHit = (t, keys) => (keys && keys.length ? keys.filter((k) => String(t || '').includes(k)).length / keys.length : null);
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  let stopFlag = false;
  const setStatus = (t) => (el.status.textContent = t);

  // 1回答えさせて、時間を測る
  async function timedAnswer(fn) {
    const t0 = performance.now();
    let first = 0;
    let streamed = '';
    const onToken = (t) => {
      if (!first) first = performance.now();
      streamed = t;
      el.out.textContent = t;
    };
    const res = await fn(onToken);
    const end = performance.now();
    const text = typeof res === 'string' ? res : (res && res.text) || streamed;
    const genSec = first ? (end - first) / 1000 : (end - t0) / 1000;
    const chars = (streamed || text || '').length;
    return { res, text, firstSec: first ? +((first - t0) / 1000).toFixed(1) : null, speed: genSec > 0 && chars ? +(chars / genSec).toFixed(1) : null, totalSec: +((end - t0) / 1000).toFixed(1) };
  }

  // 資料を探す（試験用の資料から、2文字の並びが多く重なる順）
  function search(q, docs, limit = 3) {
    const grams = new Set();
    const n = AI.normalizeTerm(q);
    for (let i = 0; i + 1 < n.length; i++) grams.add(n.slice(i, i + 2));
    return docs
      .map((d) => {
        const b = AI.normalizeTerm(`${d.title} ${d.body}`);
        let s = 0;
        grams.forEach((g) => {
          if (b.includes(g)) s++;
        });
        return { passage: d, score: s, snippet: d.body.slice(0, 40) };
      })
      .filter((h) => h.score > 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  const base = () => ({ model: packOf().id, engine: el.engine.value, runtime: AI.llm.runtimeOf(el.runtime.value) === 'compat' ? '互換版' : '速い版', swap: el.swap.checked });
  const persona = { preset: 'polite' };

  const TESTS = {
    async load() {
      setStatus('1 読み込み中…');
      lastPct = -1;
      const t0 = performance.now();
      await withLlm(null);
      const sec = +((performance.now() - t0) / 1000).toFixed(1);
      log(`読み込み完了 ${sec}秒`);
      addResult({ ...base(), test: '1 読み込み', ok: true, result: `OK（${sec}秒）` });
    },
    async short() {
      const raw = packOf().raw;
      for (let i = 0; i < DATA.short.length && !stopFlag; i++) {
        const item = DATA.short[i];
        setStatus(`2 短い答え（${i + 1}/${DATA.short.length}）`);
        const r = await withLlm((g) => timedAnswer((onToken) => g.generate([{ role: 'user', content: item.q }], { maxTokens: 64, onToken, stageInfo: { turn: i + 1 } })));
        const q = raw ? '—' : `語${pct(keyHit(r.text, item.keys))}／日本語${pct(jaRatio(r.text))}`;
        log(`短い答え${i + 1}：${String(r.text).slice(0, 60)}`);
        addResult({ ...base(), test: `2 短い答え${i + 1}`, ok: !!r.text, result: r.text ? 'OK' : '空', first: r.firstSec, speed: r.speed, quality: q });
      }
    },
    async rag() {
      const raw = packOf().raw;
      for (let i = 0; i < DATA.ragQuestions.length && !stopFlag; i++) {
        const item = DATA.ragQuestions[i];
        setStatus(`3 検索と連携（${i + 1}/${DATA.ragQuestions.length}）`);
        const swapSec = await embedQuery(item.q);
        const hits = search(item.q, DATA.passages);
        const r = await withLlm((g) => timedAnswer((onToken) => AI.rag.answer({ query: item.q, hits, generator: g, persona, onToken, stageInfo: { turn: i + 1 } })));
        const res = r.res || {};
        const q = raw ? '—' : `語${pct(keyHit(res.text, item.keys))}／一致${pct(res.grounding)}／日本語${pct(jaRatio(res.text))}`;
        log(`検索と連携${i + 1}：根拠 ${(res.evidence || []).map((e) => e.passage.title).join('・') || 'なし'}／${String(res.text || '（わかりません）').slice(0, 60)}`);
        addResult({ ...base(), test: `3 検索と連携${i + 1}${swapSec != null ? `（入替${swapSec.toFixed(1)}秒）` : ''}`, ok: true, result: res.unknown ? 'わからない' : 'OK', first: r.firstSec, speed: r.speed, quality: q });
      }
    },
    async long() {
      const raw = packOf().raw;
      const item = DATA.longQuestion;
      setStatus('4 長い資料…');
      const hits = [{ passage: DATA.longPassage, score: 9, snippet: '' }];
      let pieces = 0;
      const r = await withLlm((g) =>
        timedAnswer((onToken) =>
          AI.rag.answer({
            query: item.q,
            hits,
            generator: g,
            persona,
            onToken,
            stageInfo: { turn: 1 },
            onProgress: (p) => {
              if (p.phase === 'read') {
                pieces = p.n;
                setStatus(`4 長い資料：分けて読んでいます（${p.i}/${p.n}）`);
              } else setStatus('4 長い資料：仕上げ');
            },
          })
        )
      );
      const res = r.res || {};
      const q = raw ? '—' : `語${pct(keyHit(res.text, item.keys))}／一致${pct(res.grounding)}／日本語${pct(jaRatio(res.text))}`;
      log(`長い資料（${DATA.longPassage.body.length}字・塊${pieces}）：${String(res.text || '（わかりません）').slice(0, 80)}`);
      addResult({ ...base(), test: `4 長い資料（${DATA.longPassage.body.length}字・塊${pieces}）`, ok: true, result: res.unknown ? 'わからない' : `OK（${r.totalSec}秒）`, first: r.firstSec, speed: r.speed, quality: q });
    },
    async ten() {
      const raw = packOf().raw;
      let prev = null;
      let ok = 0;
      const t0 = performance.now();
      const speeds = [];
      for (let i = 0; i < DATA.tenQuestions.length && !stopFlag; i++) {
        const item = DATA.tenQuestions[i];
        setStatus(`5 連続10問（${i + 1}/10）`);
        const follow = item.follow && prev;
        const swapSec = follow ? null : await embedQuery(item.q);
        const hits = follow ? prev.hits : search(item.q, DATA.passages);
        const history = follow ? [{ q: prev.q, a: prev.text }] : undefined;
        const r = await withLlm((g) => timedAnswer((onToken) => AI.rag.answer({ query: item.q, hits, generator: g, persona, onToken, history, stageInfo: { turn: i + 1 } })));
        const res = r.res || {};
        if (r.speed) speeds.push(r.speed);
        ok++;
        prev = { q: item.q, text: res.text || '', hits };
        log(`連続${i + 1}${follow ? '（続き）' : ''}${swapSec != null ? `［入替${swapSec.toFixed(1)}秒］` : ''}：${String(res.text || '（わかりません）').slice(0, 50)}`);
        if (!raw) addResult({ ...base(), test: `5 連続${i + 1}${follow ? '（続き）' : ''}`, ok: true, result: res.unknown ? 'わからない' : 'OK', first: r.firstSec, speed: r.speed, quality: `語${pct(keyHit(res.text, item.keys))}／一致${pct(res.grounding)}` });
      }
      const sec = ((performance.now() - t0) / 1000).toFixed(0);
      const avg = speeds.length ? +(speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1) : null;
      addResult({ ...base(), test: '5 連続10問（まとめ）', ok: ok === 10, result: `${ok}/10問（${sec}秒）`, speed: avg });
    },
  };

  // ---- 実行 ----
  let running = false;
  function setRunning(on) {
    running = on;
    document.querySelectorAll('button[data-test], #run-all, #unload, #clear-cache').forEach((b) => (b.disabled = on));
    el.model.disabled = el.engine.disabled = el.runtime.disabled = el.swap.disabled = on;
    el.stop.disabled = !on;
  }
  async function runTests(names) {
    if (running) return; // 二重に始めない
    setRunning(true);
    stopFlag = false;
    el.out.textContent = '';
    for (const name of names) {
      if (stopFlag) break;
      try {
        await TESTS[name]();
      } catch (e) {
        log(`失敗（${name}）：${e.message}`);
        addResult({ ...base(), test: name, ok: false, result: `エラー：${String(e.message).slice(0, 80)}` });
        break;
      } finally {
        renderDiag();
      }
    }
    setStatus(stopFlag ? '止めました' : '終わりました');
    setRunning(false);
    renderCache();
  }
  el.runAll.addEventListener('click', () => runTests(['load', 'short', 'rag', 'long', 'ten']));
  document.querySelectorAll('button[data-test]').forEach((b) => b.addEventListener('click', () => runTests(b.dataset.test === 'load' ? ['load'] : ['load', b.dataset.test])));
  el.stop.addEventListener('click', () => {
    stopFlag = true;
    if (generator) generator.stop();
  });
  el.unload.addEventListener('click', async () => {
    await models.release();
    log('外しました（保存したモデルは残っています）');
  });

  // ---- 保存したモデル ----
  async function renderCache() {
    try {
      const lines = [];
      for (const p of PACKS) {
        const s = await AI.llm.ggufSaved(p);
        if (s.saved) lines.push(`${p.label}　${Math.round(s.bytes / 1048576)}MB`);
      }
      el.cache.textContent = lines.length ? lines.join('\n') : '保存したモデルはありません';
    } catch (e) {
      el.cache.textContent = `調べられません（${e.message}）`;
    }
  }
  el.clearCache.addEventListener('click', async () => {
    await models.release();
    for (const p of PACKS) await AI.llm.ggufRemove(p).catch(() => {});
    log('モデルを消しました');
    renderCache();
  });

  // ---- 結果のコピー ----
  el.copy.addEventListener('click', async () => {
    const rows = store.get(RESULTS_KEY, []).map((r) => `${r.test}｜${r.model}／${r.engine}${r.runtime ? `／${r.runtime}` : ''}${r.swap ? '＋入替' : ''}｜${r.result}｜最初${r.first ?? '—'}秒｜${r.speed ?? '—'}字/秒｜${r.quality || '—'}`);
    const text = [el.env.textContent, '', '[結果]', ...rows, '', '[段階の記録]', el.diag.textContent].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      log('結果をコピーしました');
    } catch (_) {
      el.log.textContent += `\n${text}\n`;
      log('コピーできなかったので、ここに表示しました');
    }
  });
  el.clearResults.addEventListener('click', () => {
    store.set(RESULTS_KEY, []);
    diag.clear();
    renderResults();
    renderDiag();
  });

  // ---- 起動 ----
  (async () => {
    const crash = await diag.boot();
    if (crash) {
      el.crash.style.display = 'block';
      el.crash.textContent = `前回、「${diag.describe(crash)}」の途中でページが強制終了しました。結果に記録しました。同じ条件はくり返さず、軽い条件（動かし方・モデル）で試してください。`;
      const i = crash.info || {};
      addResult({ model: i.model || '?', engine: i.engine || '?', runtime: i.runtime, test: '強制終了', ok: false, result: `落ちた：${diag.describe(crash)}` });
    }
    renderResults();
    renderDiag();
    describeEnv();
    renderCache();
  })();
  window.__lab = { TESTS, runTests, diag, models };
})();
