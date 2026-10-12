// 画面の動き。会話（覚える・聞く・調べる）と、左の記憶パネル。
// 文字は必ず textContent で入れる（保存した内容をHTMLとして解釈しない）。
(function () {
  'use strict';
  const $ = (selector) => document.querySelector(selector);

  // 古いファイルが混ざっていないか（キャッシュのずれ）。足りない部品があれば理由を出して止める
  const REQUIRED = ['#app', '#thread', '#messages', '#composer', '#input', '#send', '#drawer',
    '#scrim', '#menu', '#close', '#reset', '#search', '#count', '#terms', '#empty', '#tab-terms', '#tab-passages',
    '#tab-queue', '#semantic', '#semantic-btn', '#semantic-sync', '#mode', '#storage', '#backup-info', '#export', '#import', '#import-file'];
  const missing = REQUIRED.filter((s) => !$(s));
  if (missing.length) {
    window.__showFatal &&
      window.__showFatal('ページの一部が古いままのようです。再読み込みしてください。', `見つからない部品: ${missing.join(' ')}`);
    return;
  }

  const WIKI_LICENSE = 'CC BY-SA 4.0'; // Wikipedia の本文のライセンス。保存するときに出典と一緒に残す

  const el = {
    thread: $('#thread'),
    messages: $('#messages'),
    hello: $('#hello'),
    form: $('#composer'),
    input: $('#input'),
    send: $('#send'),
    drawer: $('#drawer'),
    scrim: $('#scrim'),
    menu: $('#menu'),
    close: $('#close'),
    reset: $('#reset'),
    search: $('#search'),
    count: $('#count'),
    list: $('#terms'),
    empty: $('#empty'),
    tabTerms: $('#tab-terms'),
    tabPassages: $('#tab-passages'),
    tabQueue: $('#tab-queue'),
    mode: $('#mode'),
    semantic: $('#semantic'),
    semBtn: $('#semantic-btn'),
    semSync: $('#semantic-sync'),
    storage: $('#storage'),
    backupInfo: $('#backup-info'),
    exportBtn: $('#export'),
    importBtn: $('#import'),
    importFile: $('#import-file'),
  };

  // 古いブラウザ（matchMedia の addEventListener が無い）でも落ちないようにする
  function onChange(query, handler) {
    if (query.addEventListener) query.addEventListener('change', handler);
    else if (query.addListener) query.addListener(handler);
  }

  function scrollDown() {
    el.thread.scrollTop = el.thread.scrollHeight;
  }

  // ---- 画面の高さ（iPhoneのキーボードで入力欄が隠れないように）----
  const vv = window.visualViewport;
  function fitHeight() {
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
    if (vv) window.scrollTo(0, 0);
    scrollDown();
  }
  if (vv) vv.addEventListener('resize', fitHeight);
  window.addEventListener('resize', fitHeight);
  fitHeight();

  // ---- 記憶パネル ----
  const wide = window.matchMedia('(min-width: 900px)');
  function setDrawer(open) {
    const overlay = open && !wide.matches;
    el.drawer.classList.toggle('open', overlay);
    el.scrim.classList.toggle('show', overlay);
    el.menu.setAttribute('aria-expanded', String(overlay));
    el.drawer.inert = !(wide.matches || open);
    if (overlay) el.close.focus();
  }
  onChange(wide, () => setDrawer(false));
  el.menu.addEventListener('click', () => setDrawer(true));
  el.close.addEventListener('click', () => {
    setDrawer(false);
    el.menu.focus();
  });
  el.scrim.addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && el.drawer.classList.contains('open')) {
      setDrawer(false);
      el.menu.focus();
    }
  });
  setDrawer(false);

  // ---- 会話 ----
  // role: 'user' | 'ai'。opts: { title, sub, actions: [{ label, main, run }] }
  function addMessage(role, text, opts = {}) {
    if (el.hello && !opts.keepHello) {
      el.hello.remove();
      el.hello = null;
    }
    const msg = document.createElement('div');
    msg.className = `msg ${role}`;
    const body = document.createElement('div');
    body.className = 'body';

    if (opts.title) {
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = opts.title;
      body.appendChild(title);
    }
    if (text) body.appendChild(document.createTextNode(text));
    if (opts.sub) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = opts.sub;
      body.appendChild(sub);
    }
    msg.appendChild(body);

    if (opts.actions && opts.actions.length) {
      const row = document.createElement('div');
      row.className = 'actions';
      const buttons = [];
      for (const action of opts.actions) {
        const b = document.createElement('button');
        b.type = 'button';
        if (action.main) b.className = 'main';
        b.textContent = action.label;
        b.addEventListener('click', async () => {
          // 1回選んだら、この問いのボタンは全部使えなくする
          buttons.forEach((x) => (x.disabled = true));
          try {
            await action.run();
          } catch (error) {
            addMessage('ai', `うまくいきませんでした。\n${error.message}`);
          }
        });
        buttons.push(b);
        row.appendChild(b);
      }
      body.appendChild(row);
    }

    if (opts.rate) body.appendChild(rateRow(opts.rate));

    el.messages.appendChild(msg);
    scrollDown();
    return msg;
  }

  // 👍/👎。rate: { type: 'term' | 'passage', id }
  function rateRow(rate) {
    const row = document.createElement('div');
    row.className = 'rate';
    const buttons = [
      { value: 1, text: '👍', label: '役に立った' },
      { value: -1, text: '👎', label: '違う・いらない' },
    ].map((def) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = def.text;
      b.setAttribute('aria-label', def.label);
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', async () => {
        try {
          const r = await AI.feedback.rate(db, rate.type, rate.id, def.value);
          buttons.forEach((x, i) => x.setAttribute('aria-pressed', String(r.value === [1, -1][i])));
          await render();
        } catch (error) {
          addMessage('ai', `評価を記録できませんでした。\n${error.message}`);
        }
      });
      return b;
    });
    row.append(...buttons);
    return row;
  }

  // ---- 記憶（DB）。開けなくても、入力欄とボタンは反応するようにしておく ----
  let db = null;
  const dbReady = AI.db
    .open()
    .then(async (opened) => {
      db = opened;
      await AI.net.load(db); // 前回のモードを引き継ぐ
      await loadSemantic(); // 意味検索の設定を引き継ぐ
      await render();
      await renderFoot(true);
    })
    .catch((error) => {
      addMessage('ai', `記憶を開けませんでした。\n${error.message}\nプライベートブラウズでは使えないことがあります。`);
    });

  function formatDate(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  }

  // learn: { term, definition, source? }
  async function save(learn, policy) {
    let result;
    try {
      result = await AI.terms.add(db, learn.term, learn.definition, {
        onConflict: policy,
        source: learn.source,
      });
    } catch (error) {
      addMessage('ai', error.message);
      return;
    }

    if (result.status === 'conflict') {
      addMessage('ai', '', {
        title: `「${result.existing.term}」はもう覚えています`,
        sub: `いま：${result.existing.definition}\n新しい：${result.incoming.definition}`,
        actions: [
          { label: '上書きする', main: true, run: () => save(learn, 'overwrite') },
          { label: '追記する', run: () => save(learn, 'append') },
          { label: '今のまま', run: () => save(learn, 'ignore') },
        ],
      });
      return;
    }

    const term = result.record.term;
    if (policy !== 'ignore') await AI.queue.resolve(db, learn.term); // 覚えたので、未回答からは外す
    if (policy === 'ignore') addMessage('ai', `「${term}」は今のまま残しました。`);
    else if (result.status === 'created') addMessage('ai', `「${term}」を覚えました。`);
    else if (result.status === 'updated') addMessage('ai', `「${term}」を更新しました。`);
    else addMessage('ai', `「${term}」はすでに同じ内容で覚えています。`);
    await render();
  }

  // 文章として保存する（確認のあとに呼ぶ）
  async function savePassage(text, extra = {}) {
    const p = await AI.passages.add(db, text, extra);
    for (const term of extra.terms || []) await AI.queue.resolve(db, term);
    addMessage('ai', `文章として保存しました。\n「${p.title}」`, {
      sub: '「文章」タブで見たり消したりできます。聞くと、この中からも探します。',
    });
    await render();
    indexInBackground(p); // 意味検索がオンなら、ベクトルも作る（待たない）
  }

  // ---- Wikipedia（ここだけが外部に通信する。ボタンを押したときだけ）----
  // ctx: まとめて調べるときだけ { item, done }。決めたら done() で次の語へ進む
  function showCandidate(query, list, index, ctx) {
    const c = list[index];
    const learn = {
      term: query,
      definition: c.extract,
      source: { url: c.url, title: `Wikipedia「${c.title}」`, license: WIKI_LICENSE },
    };
    const finish = () => ctx && ctx.done();
    const actions = [
      {
        label: '単語と文章で覚える',
        main: true,
        run: async () => {
          await save(learn, 'ask');
          await savePassage(c.extract, { title: c.title, sourceUrl: c.url, license: WIKI_LICENSE, terms: [query] });
          finish();
        },
      },
      {
        label: '単語だけ覚える',
        run: async () => {
          await save(learn, 'ask');
          finish();
        },
      },
    ];
    if (index + 1 < list.length) {
      actions.push({ label: '次の候補', run: async () => showCandidate(query, list, index + 1, ctx) });
    }
    if (ctx) {
      actions.push({
        label: 'あとで',
        run: async () => {
          addMessage('ai', `「${query}」は調べ待ちのままにします。`);
          finish();
        },
      });
      actions.push({
        label: 'いらない',
        run: async () => {
          await AI.queue.setStatus(db, ctx.item.id, 'dismissed');
          addMessage('ai', `「${query}」は未回答から外しました。`);
          await render();
          finish();
        },
      });
    } else {
      actions.push({ label: 'やめる', run: async () => addMessage('ai', '覚えませんでした。') });
    }
    addMessage('ai', c.extract, {
      title: c.title,
      sub: `Wikipedia（候補 ${index + 1}/${list.length}）\n${c.url}\n${WIKI_LICENSE}・保存すると出典と一緒に残します`,
      actions,
    });
  }

  async function searchWikipedia(query) {
    if (AI.net.isOffline()) {
      addMessage('ai', 'いまはオフラインモードです。右上の「オフライン」を押してオンラインに戻すと、Wikipediaで調べられます。');
      return;
    }
    if (navigator.onLine === false) {
      addMessage('ai', 'いまオフラインなので、調べられません。');
      return;
    }
    addMessage('ai', `Wikipediaで「${query}」を調べています…`);
    let list;
    try {
      list = await AI.wiki.search(query);
    } catch (error) {
      addMessage('ai', `Wikipediaに繋がりませんでした。\n${error.message}`);
      return;
    }
    if (!list.length) {
      addMessage('ai', `Wikipediaにも「${query}」は見つかりませんでした。\n「${query} = 意味」の形で教えてください。`);
      return;
    }
    showCandidate(query, list, 0);
  }

  // ---- 未回答をまとめて調べる ----
  async function researchQueue() {
    if (AI.net.isOffline() || navigator.onLine === false) {
      addMessage('ai', 'いまはオフラインなので調べられません。オンラインに戻してから、もう一度どうぞ。');
      return;
    }
    const items = await AI.queue.list(db);
    if (!items.length) {
      addMessage('ai', '未回答の質問はありません。');
      return;
    }
    addMessage('ai', `次の ${items.length} 件の語をWikipediaに送って調べます。\n${items.map((i) => `・${i.query}`).join('\n')}`, {
      sub: '調べた結果は自動では保存しません。候補を見て、残すものを選べます。',
      actions: [
        { label: '送って調べる', main: true, run: () => runResearch(items) },
        { label: 'やめる', run: async () => addMessage('ai', '調べませんでした。') },
      ],
    });
  }

  async function runResearch(items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      addMessage('ai', `(${i + 1}/${items.length}) 「${item.query}」を調べています…`);
      let list;
      try {
        list = await AI.wiki.search(item.query);
      } catch (error) {
        addMessage('ai', `Wikipediaに繋がりませんでした。\n${error.message}\n残りは調べ待ちのままです。`);
        return;
      }
      if (!list.length) {
        addMessage('ai', `「${item.query}」は見つかりませんでした。調べ待ちのままにします。`);
        continue;
      }
      await new Promise((resolve) => showCandidate(item.query, list, 0, { item, done: resolve }));
    }
    addMessage('ai', 'まとめて調べ終わりました。');
    await render();
  }

  // オンラインのとき、溜まっている未回答を知らせる
  async function notifyPending() {
    if (!db || AI.net.isOffline() || navigator.onLine === false) return;
    const n = await AI.queue.count(db);
    if (!n) return;
    addMessage('ai', `答えられなかった質問が ${n} 件あります。`, {
      keepHello: true, // 最初の画面の案内は消さない
      actions: [
        { label: 'まとめて調べる', main: true, run: researchQueue },
        { label: 'あとで', run: async () => {} },
      ],
    });
  }
  AI.net.onChange((off) => {
    if (!off) notifyPending().catch(() => {});
  });
  window.addEventListener('online', () => notifyPending().catch(() => {}));

  // ---- 意味検索（言い換えでも見つける。モデルはブラウザの中で動かす）----
  const SEMANTIC_KEY = 'semantic';
  // これ未満の近さは「関係ない」として捨てる。e5-small の評価セット（docs/EVAL.md）で、正解が1位のときの最小 0.843、
  // 関係ない質問の最大 0.831 だった間に置いた。差は小さい（0.012）ので、文章が増えたら測り直す。
  const SEMANTIC_MIN = 0.84;
  let semantic = { enabled: false, pack: AI.embed.PACKS[0].id };
  let provider = null;
  let preparing = null; // 読み込み中のPromise（二重に読み込まない）
  let semanticWarned = false;

  const packOf = (id) => AI.embed.PACKS.find((p) => p.id === id) || AI.embed.PACKS[0];
  const getSetting = (name) => AI.db.tx(db, 'settings', 'readonly', (t) => AI.db.rq(t.objectStore('settings').get(name)));
  const putSetting = (name, value) =>
    AI.db.tx(db, 'settings', 'readwrite', (t) => AI.db.rq(t.objectStore('settings').put({ name, value })));

  async function loadSemantic() {
    const row = await getSetting(SEMANTIC_KEY);
    if (row && row.value && row.value.enabled) {
      semantic = row.value;
      provider = AI.embed.transformersProvider(packOf(semantic.pack));
    }
  }

  // 書き換えられる進捗メッセージ
  function progressMessage(text) {
    const msg = addMessage('ai', text);
    const body = msg.querySelector('.body');
    return {
      set(t) {
        body.childNodes[0].nodeValue = t;
      },
      remove() {
        msg.remove();
      },
    };
  }

  const megabytes = (n) => `${(n / 1024 / 1024).toFixed(0)}MB`;
  function downloadProgress(pm) {
    const files = new Map();
    return (info) => {
      files.set(info.label, info);
      let loaded = 0;
      let total = 0;
      files.forEach((f) => {
        loaded += f.loaded;
        total += f.total;
      });
      if (total) pm.set(`モデルをダウンロードしています… ${Math.min(100, Math.round((loaded / total) * 100))}%（${megabytes(loaded)} / ${megabytes(total)}）`);
    };
  }

  async function ensureReady(onProgress) {
    if (!provider) return false;
    if (provider.ready) return true;
    if (!preparing) preparing = provider.prepare(onProgress).finally(() => (preparing = null));
    await preparing;
    return provider.ready;
  }

  // 保存した文章を探す。意味検索がオンならキーワードと合わせる。使えないときはキーワードだけ
  async function searchPassages(query, limit = 5) {
    if (!(semantic.enabled && provider)) return AI.passages.search(db, query, { limit });
    let note = null;
    try {
      if (!provider.ready) note = progressMessage('意味検索の準備をしています…');
      await ensureReady();
    } catch (error) {
      if (!semanticWarned) {
        semanticWarned = true;
        addMessage('ai', `${error.message}\nキーワード検索だけで探します。`);
      }
    }
    if (note) note.remove();
    const found = await AI.hybrid.search(db, query, { provider: provider.ready ? provider : null, limit, minSemantic: SEMANTIC_MIN });
    return found;
  }

  // 文章を1件保存したあと、その分のベクトルを作る（失敗しても保存は有効。あとで「未作成を作る」で補える）
  async function indexInBackground(passage) {
    if (!(semantic.enabled && provider)) return;
    try {
      await ensureReady();
      await AI.vectors.indexPassage(db, passage, provider);
      await renderSemantic();
    } catch (_) {
      await renderSemantic().catch(() => {});
    }
  }

  async function renderSemantic() {
    if (!db) return;
    if (!semantic.enabled) {
      const pack = packOf(semantic.pack);
      el.semantic.textContent = `意味検索：オフ\n言い換えでも探せるようになります（約${pack.approxMB}MB・Wi-Fi推奨）`;
      el.semBtn.textContent = '有効にする';
      el.semSync.hidden = true;
      return;
    }
    const st = await AI.vectors.status(db, provider);
    el.semantic.textContent = `意味検索：オン（${packOf(semantic.pack).label}）\n作成済み ${st.indexed}/${st.total} 件${st.stale ? `（未作成 ${st.stale} 件）` : ''}`;
    el.semBtn.textContent = 'オフにする';
    el.semSync.hidden = st.stale === 0;
  }

  async function enableSemantic() {
    setDrawer(false);
    if (AI.net.isOffline() || navigator.onLine === false) {
      addMessage('ai', 'モデルのダウンロードにはネットが要ります。オンラインにしてから、もう一度どうぞ。');
      return;
    }
    const pack = packOf(semantic.pack);
    let free = '';
    try {
      const e = await navigator.storage.estimate();
      if (e.quota) free = `\n端末の保存領域の目安：あと ${megabytes(Math.max(0, e.quota - (e.usage || 0)))}`;
    } catch (_) {
      /* 取れなくても進める */
    }
    addMessage('ai', `意味検索を有効にします。\nモデル「${pack.label}」を、約${pack.approxMB}MBダウンロードします。${free}`, {
      sub: `通信先：${pack.hosts.join('、')}\n送るのはモデルの取得だけで、記憶や質問は送りません。取得後は端末に保存され、オフラインでも使えます。`,
      actions: [
        { label: 'ダウンロードして有効にする', main: true, run: () => runEnable(pack) },
        { label: 'やめる', run: async () => addMessage('ai', '有効にしませんでした。') },
      ],
    });
  }

  async function runEnable(pack) {
    const pm = progressMessage('準備しています…');
    const candidate = AI.embed.transformersProvider(pack);
    try {
      await candidate.prepare(downloadProgress(pm));
      pm.set('動作を確かめています…');
      await candidate.embed(['動作確認'], 'query'); // 実際に1回動かして、使えることを確かめる
    } catch (error) {
      pm.remove();
      addMessage('ai', `意味検索を有効にできませんでした。\n${error.message}`);
      return;
    }
    provider = candidate;
    semantic = { enabled: true, pack: pack.id };
    semanticWarned = false;
    await putSetting(SEMANTIC_KEY, semantic);
    const n = await AI.vectors.reindex(db, provider, {
      onProgress: ({ done, total }) => pm.set(`文章のベクトルを作っています… ${done}/${total}`),
    });
    pm.remove();
    addMessage('ai', `意味検索が使えるようになりました。保存済みの文章 ${n} 件を処理しました。`, {
      sub: '言い換えた質問でも、近い内容の文章を探します。',
    });
    await renderFoot(false);
  }

  function disableSemantic() {
    setDrawer(false);
    const off = async (wipe) => {
      semantic = { ...semantic, enabled: false };
      await putSetting(SEMANTIC_KEY, semantic);
      if (wipe) {
        await AI.vectors.removeAll(db);
        try {
          if (window.caches) {
            await caches.delete('transformers-cache'); // 取得したモデル
            await caches.delete(AI.embed.LIB_CACHE); // 実行用の本体
          }
        } catch (_) {
          /* 消せなくても無効にはなっている */
        }
      }
      provider = null;
      addMessage('ai', wipe ? '意味検索をオフにして、ベクトルとモデルを端末から消しました。' : '意味検索をオフにしました。ベクトルとモデルは残してあります。');
      await renderFoot(false);
    };
    addMessage('ai', '意味検索をオフにしますか？', {
      sub: '消しても、保存した単語や文章は残ります。',
      actions: [
        { label: 'オフにする（残す）', main: true, run: () => off(false) },
        { label: 'オフにして全て消す', run: () => off(true) },
        { label: 'やめる', run: async () => {} },
      ],
    });
  }

  async function runSync() {
    setDrawer(false);
    if (!(semantic.enabled && provider)) return;
    const pm = progressMessage('ベクトルを作っています…');
    try {
      await ensureReady(downloadProgress(pm));
      const n = await AI.vectors.reindex(db, provider, {
        onProgress: ({ done, total }) => pm.set(`ベクトルを作っています… ${done}/${total}`),
      });
      pm.remove();
      addMessage('ai', `${n} 件のベクトルを作りました。`);
    } catch (error) {
      pm.remove();
      addMessage('ai', `ベクトルを作れませんでした。\n${error.message}`);
    }
    await renderSemantic();
  }

  el.semBtn.addEventListener('click', () => (semantic.enabled ? disableSemantic() : enableSemantic()));
  el.semSync.addEventListener('click', runSync);

  // ---- 聞く ----
  function showPassage(p) {
    addMessage('ai', p.body, { rate: { type: 'passage', id: p.id }, title: p.title, sub: `保存 ${formatDate(p.fetchedAt)}${p.sourceUrl ? `\n${p.sourceUrl}` : ''}${p.license ? `（${p.license}）` : ''}` });
  }

  async function ask(query) {
    const record = await AI.terms.get(db, query);
    const hits = await searchPassages(query);
    if (record) {
      addMessage('ai', record.definition || '（定義はまだありません）', {
        title: record.term,
        rate: { type: 'term', id: record.key },
        sub: `更新 ${formatDate(record.updatedAt)}${hits.length ? `\n保存した文章にも ${hits.length} 件あります。` : ''}`,
        actions: hits.map((h) => ({ label: h.passage.title, run: async () => showPassage(h.passage) })),
      });
      return;
    }
    if (hits.length) {
      addMessage('ai', hits.map((h, i) => `${i + 1}. ${h.passage.title}${h.via && !h.via.includes('keyword') ? '〔意味が近い〕' : ''}\n   ${h.snippet}`).join('\n'), {
        title: `保存した文章に ${hits.length} 件あります`,
        sub: '押すと全文を表示します。',
        actions: hits.map((h) => ({ label: h.passage.title, run: async () => showPassage(h.passage) })),
      });
      return;
    }

    const key = AI.normalizeTerm(query);
    const near = key
      ? (await AI.terms.list(db)).filter((r) => r.key.includes(key) || key.includes(r.key)).slice(0, 5)
      : [];
    const actions = near.map((r) => ({
      label: r.term,
      run: async () => {
        addMessage('user', r.term);
        await ask(r.term);
      },
    }));
    // 答えられなかった質問は、未回答に残す（あとでオンラインのときにまとめて調べられる）
    await AI.queue.add(db, query);
    await render();

    if (AI.net.isOffline()) {
      addMessage('ai', `「${query}」はまだ知りません。${near.length ? '近い言葉があります。' : ''}\n「${query} = 意味」と教えてください。`, {
        sub: 'オフラインモード中なので、外部には調べに行きません。未回答に残したので、オンラインに戻ったらまとめて調べられます。',
        actions,
      });
      return;
    }
    actions.push({ label: 'Wikipediaで調べる', main: true, run: () => searchWikipedia(query) });

    addMessage('ai', `「${query}」はまだ知りません。${near.length ? '近い言葉があります。' : ''}\n「${query} = 意味」と教えるか、Wikipediaで調べられます。`, {
      sub: `Wikipediaで調べると、「${query}」がWikipediaに送られます。調べずに閉じても、未回答に残ります。`,
      actions,
    });
  }

  async function handle(text) {
    addMessage('user', text);
    await dbReady;
    if (!db) return; // 開けなかった理由は、すでに画面に出している
    const parsed = AI.chat.parse(text);
    if (parsed.type === 'teach') {
      if (!parsed.confirm) return save(parsed, 'ask');
      addMessage('ai', `「${parsed.term}」＝「${parsed.definition}」として覚えますか？`, {
        actions: [
          { label: '覚える', main: true, run: () => save(parsed, 'ask') },
          { label: 'やめる', run: async () => addMessage('ai', '覚えませんでした。') },
        ],
      });
      return;
    }
    if (parsed.type === 'note') {
      addMessage('ai', '長い文章なので、文章として保存しますか？', {
        sub: `${parsed.text.length}文字。保存すると、あとからキーワードで探せます。`,
        actions: [
          { label: '文章として保存', main: true, run: () => savePassage(parsed.text) },
          { label: '保存しない', run: async () => addMessage('ai', '保存しませんでした。') },
        ],
      });
      return;
    }
    if (parsed.type === 'ask') return ask(parsed.query);
  }

  // ---- 入力欄 ----
  function fitInput() {
    el.input.style.height = 'auto';
    el.input.style.height = `${el.input.scrollHeight}px`;
    el.send.disabled = el.input.value.trim() === '';
  }
  el.input.addEventListener('input', fitInput);

  const touch = window.matchMedia('(pointer: coarse)');
  el.input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // 日本語の変換確定のEnterでは送らない。スマホのEnterは改行にする（送るのは右のボタン）
    if (event.isComposing || event.keyCode === 229 || touch.matches) return;
    event.preventDefault();
    submit();
  });

  async function submit() {
    const text = el.input.value.trim();
    if (!text) return;
    el.input.value = '';
    fitInput();
    try {
      await handle(text);
    } catch (error) {
      addMessage('ai', `うまくいきませんでした。\n${error.message}`);
    }
    if (!touch.matches) el.input.focus();
  }

  // requestSubmit が無い古いブラウザでも動くように、submit イベントから直接呼ぶ
  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  document.querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      el.input.value = chip.dataset.fill;
      fitInput();
      el.input.focus();
    })
  );

  el.reset.addEventListener('click', () => {
    el.messages.textContent = '';
    el.hello = null;
    addMessage('ai', '新しい会話にしました。覚えた内容は消えていません。');
    el.input.focus();
  });

  // ---- 記憶の一覧 ----
  async function renderTerms() {
    if (!db) return;
    const all = await AI.terms.list(db);
    const q = AI.normalizeTerm(el.search.value);
    const shown = q
      ? all.filter((r) => r.key.includes(q) || AI.normalizeTerm(r.definition).includes(q))
      : all;

    el.list.textContent = '';
    for (const r of shown) {
      const li = document.createElement('li');

      const term = document.createElement('span');
      term.className = 'term';
      term.textContent = r.term;

      const def = document.createElement('p');
      def.className = 'def';
      def.textContent = r.definition || '（定義なし）';

      const meta = document.createElement('span');
      meta.className = 'meta';
      const others = r.variants.filter((v) => v !== r.term);
      const from = r.sources.length ? ` ・ 出典 ${r.sources[0].title || r.sources[0].url}` : '';
      meta.textContent = `更新 ${formatDate(r.updatedAt)}${others.length ? ` ・ ${others.join('、')}` : ''}${from}`;

      // 消すときは2回押す（スマホの押し間違い対策）
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '消す';
      del.setAttribute('aria-label', `${r.term} を消す`);
      let timer = null;
      del.addEventListener('click', async () => {
        if (!del.classList.contains('armed')) {
          del.classList.add('armed');
          del.textContent = 'もう一度';
          timer = setTimeout(() => {
            del.classList.remove('armed');
            del.textContent = '消す';
          }, 3000);
          return;
        }
        clearTimeout(timer);
        await AI.terms.remove(db, r.key);
        await render();
      });

      li.append(term, del, def, meta);
      el.list.appendChild(li);
    }

    el.empty.hidden = shown.length > 0;
    el.empty.textContent = all.length === 0 ? 'まだ何も覚えていません。' : '見つかりませんでした。';
    el.count.textContent = q ? `${shown.length} / ${all.length} 件` : `${all.length} 件`;
  }

  // ---- 文章の一覧（「文章」タブ）----
  async function renderPassages() {
    const total = await AI.passages.count(db);
    const q = el.search.value.trim();
    const shown = q
      ? (await AI.passages.search(db, q, { limit: 200 })).map((h) => h.passage)
      : await AI.passages.list(db);

    el.list.textContent = '';
    for (const p of shown) {
      const li = document.createElement('li');

      const title = document.createElement('span');
      title.className = 'term';
      title.textContent = p.title;

      const body = document.createElement('p');
      body.className = 'def clamp';
      body.textContent = p.body;
      body.title = 'タップで全文を開く／閉じる';
      body.addEventListener('click', () => body.classList.toggle('clamp'));

      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `保存 ${formatDate(p.fetchedAt)} ・ ${p.body.length}文字${p.sourceUrl ? ` ・ ${p.sourceUrl}` : ''}${p.license ? ` ・ ${p.license}` : ''}`;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '消す';
      del.setAttribute('aria-label', `${p.title} を消す`);
      let timer = null;
      del.addEventListener('click', async () => {
        if (!del.classList.contains('armed')) {
          del.classList.add('armed');
          del.textContent = 'もう一度';
          timer = setTimeout(() => {
            del.classList.remove('armed');
            del.textContent = '消す';
          }, 3000);
          return;
        }
        clearTimeout(timer);
        await AI.passages.remove(db, p.id); // 単語は残る
        await render();
      });

      li.append(title, del, body, meta);
      el.list.appendChild(li);
    }

    el.empty.hidden = shown.length > 0;
    el.empty.textContent = total === 0 ? 'まだ文章は保存していません。長い文章を貼って送ると、保存できます。' : '見つかりませんでした。';
    el.count.textContent = q ? `${shown.length} / ${total} 件` : `${total} 件`;
  }

  // ---- モード（オンライン／オフライン）----
  function showMode(off) {
    el.mode.dataset.mode = off ? 'offline' : 'online';
    el.mode.textContent = off ? 'オフライン' : 'オンライン';
    el.mode.setAttribute('aria-pressed', String(off));
    el.input.placeholder = off ? '覚えさせる・聞く' : '覚えさせる・聞く・文章を貼る';
  }
  AI.net.onChange(showMode);
  el.mode.addEventListener('click', async () => {
    const next = !AI.net.isOffline();
    try {
      await AI.net.setOffline(db, next);
    } catch (error) {
      addMessage('ai', `モードを切り替えられませんでした。\n${error.message}`);
      return;
    }
    addMessage(
      'ai',
      next
        ? 'オフラインモードにしました。これからは外部に通信せず、覚えた内容だけで答えます。'
        : 'オンラインに戻しました。知らない語はWikipediaで調べられます。'
    );
  });

  // ---- 保存領域と書き出し ----
  const DAY = 24 * 60 * 60 * 1000;
  function bytes(n) {
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  const installed = () =>
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

  async function renderFoot(askPersist) {
    // 保存領域：使用量と、消されにくくする要求の結果
    const parts = [];
    try {
      if (navigator.storage && navigator.storage.persist && askPersist) await navigator.storage.persist();
      const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        parts.push(`使用量 ${bytes(e.usage || 0)}`);
      }
      parts.push(persisted ? '消えにくい保存：有効' : '消えにくい保存：未確認');
    } catch (_) {
      parts.push('保存領域の状態は取得できませんでした');
    }
    await renderSemantic();
    const note = installed() ? '' : '\nホーム画面に追加すると、消えにくくなります。';
    el.storage.textContent = parts.join(' ／ ') + note;

    // 最後に書き出してからの日数
    const last = await AI.backup.lastExportAt(db);
    const total = (await AI.terms.count(db)) + (await AI.passages.count(db));
    el.backupInfo.className = '';
    if (last == null) {
      el.backupInfo.textContent = total ? '⚠ まだ書き出していません。端末の都合で記憶が消えることがあるので、バックアップを取ってください。' : 'まだ書き出していません。';
      if (total) el.backupInfo.className = 'warn';
    } else {
      const days = Math.floor((Date.now() - last) / DAY);
      el.backupInfo.textContent = days === 0 ? '最後の書き出し：今日' : `最後の書き出し：${days}日前`;
      if (days >= 7 && total) {
        el.backupInfo.textContent += '。そろそろバックアップを取りませんか。';
        el.backupInfo.className = 'warn';
      }
    }
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }

  el.exportBtn.addEventListener('click', async () => {
    if (!db) return;
    try {
      const data = await AI.backup.exportAll(db);
      const name = `ai-backup-${stamp()}.json`;
      const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
      const touchDevice = window.matchMedia('(pointer: coarse)').matches;
      if (touchDevice && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: name });
        } catch (error) {
          if (error && error.name === 'AbortError') return; // 共有をやめた
          throw error;
        }
      } else {
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
      await AI.backup.markExported(db);
      setDrawer(false);
      addMessage('ai', `書き出しました（${name}）。\n単語 ${data.terms.length} 件、文章 ${data.passages.length} 件。`, {
        sub: '「ファイル」アプリなど、端末の外にも置いておくと安心です。',
      });
      await renderFoot(false);
    } catch (error) {
      addMessage('ai', `書き出せませんでした。\n${error.message}`);
    }
  });

  el.importBtn.addEventListener('click', () => el.importFile.click());
  el.importFile.addEventListener('change', async () => {
    const file = el.importFile.files && el.importFile.files[0];
    el.importFile.value = ''; // 同じファイルをもう一度選べるように
    if (!file || !db) return;
    setDrawer(false);
    let data;
    let counts;
    try {
      data = JSON.parse(await file.text());
      counts = AI.backup.validate(data);
    } catch (error) {
      addMessage('ai', `読み込めませんでした。\n${error instanceof SyntaxError ? 'JSONとして読めないファイルです。' : error.message}`);
      return;
    }
    const run = (mode) => async () => {
      const r = await AI.backup.importAll(db, data, { mode });
      addMessage('ai', mode === 'overwrite'
        ? `置き換えました。単語 ${r.terms.added} 件、文章 ${r.passages.added} 件。`
        : `統合しました。単語は新規 ${r.terms.added} 件・既存と統合 ${r.terms.merged} 件、文章は新規 ${r.passages.added} 件（同じ内容 ${r.passages.skipped} 件は重ねていません）。`);
      await render();
      await renderFoot(false);
      if (semantic.enabled) runSync(); // 読み込んだ文章のベクトルを作る
    };
    addMessage('ai', `「${file.name}」を読み込みます。\n単語 ${counts.terms} 件、文章 ${counts.passages} 件。`, {
      sub: '統合：今の記憶を残して足します。置き換え：今の記憶は全て消えます。',
      actions: [
        { label: '統合して読み込む', main: true, run: run('merge') },
        { label: '置き換える', run: run('overwrite') },
        { label: 'やめる', run: async () => addMessage('ai', '読み込みませんでした。') },
      ],
    });
  });

  // ---- オフラインで開けるように（Service Worker）----
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  // ---- 未回答の一覧（「未回答」タブ）----
  async function renderQueue() {
    const items = await AI.queue.list(db);
    el.list.textContent = '';
    if (items.length && !AI.net.isOffline()) {
      const li = document.createElement('li');
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'bulk';
      go.textContent = `まとめて調べる（${items.length}件）`;
      go.addEventListener('click', () => {
        setDrawer(false);
        researchQueue();
      });
      li.appendChild(go);
      el.list.appendChild(li);
    }
    for (const r of items) {
      const li = document.createElement('li');
      const term = document.createElement('span');
      term.className = 'term';
      term.textContent = r.query;
      const def = document.createElement('p');
      def.className = 'def';
      def.textContent = r.askedCount > 1 ? `${r.askedCount}回聞かれました` : '答えられませんでした';
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `最初に聞いた日 ${formatDate(r.createdAt)}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '外す';
      del.setAttribute('aria-label', `${r.query} を未回答から外す`);
      let timer = null;
      del.addEventListener('click', async () => {
        if (!del.classList.contains('armed')) {
          del.classList.add('armed');
          del.textContent = 'もう一度';
          timer = setTimeout(() => {
            del.classList.remove('armed');
            del.textContent = '外す';
          }, 3000);
          return;
        }
        clearTimeout(timer);
        await AI.queue.setStatus(db, r.id, 'dismissed');
        await render();
      });
      li.append(term, del, def, meta);
      el.list.appendChild(li);
    }
    el.empty.hidden = items.length > 0;
    el.empty.textContent = '答えられなかった質問はありません。';
    el.count.textContent = `${items.length} 件`;
  }

  // ---- タブ ----
  let tab = 'terms';
  const TABS = { terms: el.tabTerms, passages: el.tabPassages, queue: el.tabQueue };
  const PLACEHOLDER = { terms: '記憶を探す', passages: '文章を探す', queue: '' };
  function setTab(next) {
    tab = next;
    for (const [name, button] of Object.entries(TABS)) button.setAttribute('aria-selected', String(tab === name));
    el.search.placeholder = PLACEHOLDER[tab];
    el.search.hidden = tab === 'queue'; // 未回答は件数が少ないので、検索欄は出さない
    el.search.value = '';
    return render();
  }
  // 「未回答」タブに件数を出す（気づけるように）
  async function updateBadge() {
    const n = await AI.queue.count(db);
    el.tabQueue.textContent = n ? `未回答 ${n}` : '未回答';
  }
  async function render() {
    if (!db) return;
    if (tab === 'terms') await renderTerms();
    else if (tab === 'passages') await renderPassages();
    else await renderQueue();
    await updateBadge();
  }
  el.tabTerms.addEventListener('click', () => setTab('terms'));
  el.tabPassages.addEventListener('click', () => setTab('passages'));
  el.tabQueue.addEventListener('click', () => setTab('queue'));
  el.search.addEventListener('input', render);

  fitInput();
})();
