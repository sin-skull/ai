// 画面の動き。会話（覚える・聞く）と、左の記憶パネル。
// 文字は必ず textContent で入れる（保存した内容をHTMLとして解釈しない）。
(async function () {
  'use strict';
  const $ = (selector) => document.querySelector(selector);

  const el = {
    app: $('#app'),
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
  };

  // ---- 画面の高さ（iPhoneのキーボードで入力欄が隠れないように）----
  const vv = window.visualViewport;
  function fitHeight() {
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
    if (vv) window.scrollTo(0, 0);
    scrollDown();
  }
  if (vv) {
    vv.addEventListener('resize', fitHeight);
  }
  window.addEventListener('resize', fitHeight);
  fitHeight();

  function scrollDown() {
    el.thread.scrollTop = el.thread.scrollHeight;
  }

  // ---- 記憶パネル ----
  const wide = window.matchMedia('(min-width: 900px)');
  function setDrawer(open) {
    const show = wide.matches || open;
    el.drawer.classList.toggle('open', open && !wide.matches);
    el.scrim.classList.toggle('show', open && !wide.matches);
    el.menu.setAttribute('aria-expanded', String(open && !wide.matches));
    el.drawer.inert = !show;
    if (open && !wide.matches) el.close.focus();
  }
  wide.addEventListener('change', () => setDrawer(false));
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
          await action.run();
        });
        buttons.push(b);
        row.appendChild(b);
      }
      body.appendChild(row);
    }

    el.messages.appendChild(msg);
    scrollDown();
    return msg;
  }

  let db;
  try {
    db = await AI.db.open();
  } catch (error) {
    addMessage('ai', `記憶を開けませんでした。\n${error.message}`);
    el.input.disabled = true;
    return;
  }

  function formatDate(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  }

  async function save(learn, policy) {
    let result;
    try {
      result = await AI.terms.add(db, learn.term, learn.definition, { onConflict: policy });
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
    await renderTerms();
  }

  async function ask(query) {
    const record = await AI.terms.get(db, query);
    if (record) {
      addMessage('ai', record.definition || '（定義はまだありません）', {
        title: record.term,
        sub: `更新 ${formatDate(record.updatedAt)}`,
      });
      return;
    }

    const key = AI.normalizeTerm(query);
    const near = key
      ? (await AI.terms.list(db))
          .filter((r) => r.key.includes(key) || key.includes(r.key))
          .slice(0, 5)
      : [];
    if (near.length) {
      addMessage('ai', `「${query}」はまだ知りません。近いものがあります。`, {
        actions: near.map((r) => ({
          label: r.term,
          run: async () => {
            addMessage('user', r.term);
            await ask(r.term);
          },
        })),
      });
      return;
    }
    addMessage('ai', `「${query}」はまだ知りません。\n「${query} = 意味」の形で教えてください。`);
  }

  async function handle(text) {
    addMessage('user', text);
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
    el.form.requestSubmit();
  });

  el.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = el.input.value.trim();
    if (!text) return;
    el.input.value = '';
    fitInput();
    await handle(text);
    if (!touch.matches) el.input.focus();
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
      meta.textContent = `更新 ${formatDate(r.updatedAt)}` + (others.length ? ` ・ ${others.join('、')}` : '');

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
        await renderTerms();
      });

      li.append(term, del, def, meta);
      el.list.appendChild(li);
    }

    el.empty.hidden = shown.length > 0;
    el.empty.textContent = all.length === 0 ? 'まだ何も覚えていません。' : '見つかりませんでした。';
    el.count.textContent = q ? `${shown.length} / ${all.length} 件` : `${all.length} 件`;
  }
  el.search.addEventListener('input', renderTerms);

  await renderTerms();
  fitInput();
})();
