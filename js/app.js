// 画面の動き（単語辞書）。文字は必ず textContent で入れる（保存した内容をHTMLとして解釈しない）。
(async function () {
  'use strict';
  const $ = (selector) => document.querySelector(selector);

  const elTerm = $('#term');
  const elDef = $('#def');
  const elStatus = $('#status');
  const elList = $('#terms');
  const elEmpty = $('#empty');
  const elCount = $('#count');
  const elSearch = $('#search');
  const elConflict = $('#conflict');

  let db;
  try {
    db = await AI.db.open();
  } catch (error) {
    say(`データベースを開けませんでした: ${error.message}`, true);
    return;
  }

  // 同じ語があって、どう扱うかを選ばせている最中の入力
  let pending = null;

  function say(message, warn = false) {
    elStatus.textContent = message;
    elStatus.classList.toggle('warn', warn);
  }

  function formatDate(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  }

  async function render() {
    const all = await AI.terms.list(db);
    const q = AI.normalizeTerm(elSearch.value);
    const shown = q
      ? all.filter(
          (r) => r.key.includes(q) || AI.normalizeTerm(r.definition).includes(q)
        )
      : all;

    elList.textContent = '';
    for (const r of shown) {
      const li = document.createElement('li');

      const term = document.createElement('span');
      term.className = 'term';
      term.textContent = r.term;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'quiet';
      del.textContent = '消す';
      del.setAttribute('aria-label', `${r.term} を消す`);
      del.addEventListener('click', async () => {
        await AI.terms.remove(db, r.key);
        say(`「${r.term}」を消しました`);
        await render();
      });

      const def = document.createElement('p');
      def.className = 'def';
      def.textContent = r.definition || '（定義なし）';

      const meta = document.createElement('span');
      meta.className = 'meta';
      const variants = r.variants.filter((v) => v !== r.term);
      meta.textContent =
        `更新 ${formatDate(r.updatedAt)}` + (variants.length ? ` ・ 他の表記: ${variants.join('、')}` : '');

      li.append(term, del, def, meta);
      elList.appendChild(li);
    }

    elEmpty.hidden = shown.length > 0;
    elEmpty.textContent = all.length === 0 ? 'まだ何も覚えていません。' : '見つかりませんでした。';
    elCount.textContent = q ? `${shown.length} / ${all.length} 件` : `${all.length} 件`;
  }

  function hideConflict() {
    pending = null;
    elConflict.classList.remove('show');
  }

  const MESSAGES = {
    created: (t) => `「${t}」を覚えました`,
    updated: (t) => `「${t}」を更新しました`,
    unchanged: (t) => `「${t}」は変わりません（すでに同じ内容です）`,
  };

  async function save(policy) {
    const { term, definition } = pending || { term: elTerm.value, definition: elDef.value };
    let result;
    try {
      result = await AI.terms.add(db, term, definition, { onConflict: policy });
    } catch (error) {
      say(error.message, true);
      return;
    }

    if (result.status === 'conflict') {
      pending = { term, definition };
      $('#c-old').textContent = result.existing.definition;
      $('#c-new').textContent = result.incoming.definition;
      elConflict.classList.add('show');
      say('');
      return;
    }

    hideConflict();
    say(
      policy === 'ignore' && result.status === 'unchanged'
        ? `「${result.record.term}」は今のまま残しました`
        : MESSAGES[result.status](result.record.term)
    );
    elTerm.value = '';
    elDef.value = '';
    elTerm.focus();
    await render();
  }

  $('#form').addEventListener('submit', (event) => {
    event.preventDefault();
    hideConflict();
    save('ask');
  });
  $('#c-overwrite').addEventListener('click', () => save('overwrite'));
  $('#c-append').addEventListener('click', () => save('append'));
  $('#c-ignore').addEventListener('click', () => save('ignore'));
  elSearch.addEventListener('input', render);

  await render();
})();
