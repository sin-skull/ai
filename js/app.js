// 画面の動き。会話（覚える・聞く・調べる）と、左の記憶パネル。
// 文字は必ず textContent で入れる（保存した内容をHTMLとして解釈しない）。
(function () {
  'use strict';
  const $ = (selector) => document.querySelector(selector);

  // 古いファイルが混ざっていないか（キャッシュのずれ）。足りない部品があれば理由を出して止める
  const REQUIRED = ['#app', '#thread', '#messages', '#composer', '#input', '#send', '#drawer',
    '#scrim', '#menu', '#close', '#reset', '#search', '#count', '#terms', '#empty', '#tab-terms', '#tab-passages',
    '#mode', '#storage', '#backup-info', '#export', '#import', '#import-file'];
  const missing = REQUIRED.filter((s) => !$(s));
  if (missing.length) {
    window.__showFatal &&
      window.__showFatal('ページの一部が古いままのようです。再読み込みしてください。', `見つからない部品: ${missing.join(' ')}`);
    return;
  }

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
    mode: $('#mode'),
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
    if (el.hello) {
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
    if (policy === 'ignore') addMessage('ai', `「${term}」は今のまま残しました。`);
    else if (result.status === 'created') addMessage('ai', `「${term}」を覚えました。`);
    else if (result.status === 'updated') addMessage('ai', `「${term}」を更新しました。`);
    else addMessage('ai', `「${term}」はすでに同じ内容で覚えています。`);
    await render();
  }

  // 文章として保存する（確認のあとに呼ぶ）
  async function savePassage(text, extra = {}) {
    const p = await AI.passages.add(db, text, extra);
    addMessage('ai', `文章として保存しました。\n「${p.title}」`, {
      sub: '「文章」タブで見たり消したりできます。聞くと、この中からも探します。',
    });
    await render();
  }

  // ---- Wikipedia（ここだけが外部に通信する。ボタンを押したときだけ）----
  function showCandidate(query, list, index) {
    const c = list[index];
    const learn = { term: query, definition: c.extract, source: { url: c.url, title: `Wikipedia「${c.title}」` } };
    const actions = [
      {
        label: '単語と文章で覚える',
        main: true,
        run: async () => {
          await save(learn, 'ask');
          await savePassage(c.extract, { title: c.title, sourceUrl: c.url, terms: [query] });
        },
      },
      { label: '単語だけ覚える', run: () => save(learn, 'ask') },
    ];
    if (index + 1 < list.length) {
      actions.push({ label: '次の候補', run: async () => showCandidate(query, list, index + 1) });
    }
    actions.push({ label: 'やめる', run: async () => addMessage('ai', '覚えませんでした。') });
    addMessage('ai', c.extract, {
      title: c.title,
      sub: `Wikipedia（候補 ${index + 1}/${list.length}）\n${c.url}`,
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

  // ---- 聞く ----
  function showPassage(p) {
    addMessage('ai', p.body, { rate: { type: 'passage', id: p.id }, title: p.title, sub: `保存 ${formatDate(p.fetchedAt)}${p.sourceUrl ? `\n${p.sourceUrl}` : ''}` });
  }

  async function ask(query) {
    const record = await AI.terms.get(db, query);
    const hits = await AI.passages.search(db, query, { limit: 5 });
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
      addMessage('ai', hits.map((h, i) => `${i + 1}. ${h.passage.title}\n   ${h.snippet}`).join('\n'), {
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
    if (AI.net.isOffline()) {
      addMessage('ai', `「${query}」はまだ知りません。${near.length ? '近い言葉があります。' : ''}\n「${query} = 意味」と教えてください。`, {
        sub: 'オフラインモード中なので、外部には調べに行きません。',
        actions,
      });
      return;
    }
    actions.push({ label: 'Wikipediaで調べる', main: true, run: () => searchWikipedia(query) });

    addMessage('ai', `「${query}」はまだ知りません。${near.length ? '近い言葉があります。' : ''}\n「${query} = 意味」と教えるか、Wikipediaで調べられます。`, {
      sub: `Wikipediaで調べると、「${query}」がWikipediaに送られます。`,
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
      meta.textContent = `保存 ${formatDate(p.fetchedAt)} ・ ${p.body.length}文字${p.sourceUrl ? ` ・ ${p.sourceUrl}` : ''}`;

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

  // ---- タブ ----
  let tab = 'terms';
  function setTab(next) {
    tab = next;
    el.tabTerms.setAttribute('aria-selected', String(tab === 'terms'));
    el.tabPassages.setAttribute('aria-selected', String(tab === 'passages'));
    el.search.placeholder = tab === 'terms' ? '記憶を探す' : '文章を探す';
    el.search.value = '';
    return render();
  }
  function render() {
    return tab === 'terms' ? renderTerms() : renderPassages();
  }
  el.tabTerms.addEventListener('click', () => setTab('terms'));
  el.tabPassages.addEventListener('click', () => setTab('passages'));
  el.search.addEventListener('input', render);

  fitInput();
})();
