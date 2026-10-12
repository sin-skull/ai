// 入力の解釈（js/chat.js）の回帰テスト。
(function () {
  'use strict';
  const { test, equal } = window.T;
  const p = (s) => AI.chat.parse(s);

  test('入力: 空は empty', () => {
    equal(p('').type, 'empty');
    equal(p('   \n ').type, 'empty');
  });

  test('入力: 「単語 = 意味」は確認なしで覚える', () => {
    equal(p('AI = 人工知能'), { type: 'teach', term: 'AI', definition: '人工知能', confirm: false });
    equal(p('AI＝人工知能'), { type: 'teach', term: 'AI', definition: '人工知能', confirm: false });
    equal(p('AI：人工知能'), { type: 'teach', term: 'AI', definition: '人工知能', confirm: false });
    equal(p('AI: 人工知能'), { type: 'teach', term: 'AI', definition: '人工知能', confirm: false });
  });

  test('入力: 区切りは最初の1つで切り、定義の中の記号は残る', () => {
    const r = p('式 = a = b + 1');
    equal(r.term, '式');
    equal(r.definition, 'a = b + 1');
  });

  test('入力: 定義は複数行でもよい', () => {
    equal(p('AI = 人工知能\nartificial intelligence').definition, '人工知能\nartificial intelligence');
  });

  test('入力: URLのコロンは区切りにしない', () => {
    equal(p('https://example.com/a').type, 'ask');
  });

  test('入力: 質問は ask になり、語尾が取り除かれる', () => {
    equal(p('AIとは？'), { type: 'ask', query: 'AI' });
    equal(p('AIって何？'), { type: 'ask', query: 'AI' });
    equal(p('AIって何'), { type: 'ask', query: 'AI' });
    equal(p('AIについて教えて'), { type: 'ask', query: 'AI' });
    equal(p('AIとは何ですか'), { type: 'ask', query: 'AI' });
    equal(p('人工知能?'), { type: 'ask', query: '人工知能' });
  });

  test('入力: 単語だけは調べる', () => {
    equal(p('AI'), { type: 'ask', query: 'AI' });
    equal(p('  人工知能  '), { type: 'ask', query: '人工知能' });
  });

  test('入力: 「AIは人工知能」型は確認つきで覚える', () => {
    equal(p('AIは人工知能'), { type: 'teach', term: 'AI', definition: '人工知能', confirm: true });
    equal(p('AIとは人工知能のこと'), { type: 'teach', term: 'AI', definition: '人工知能', confirm: true });
    equal(p('AIは人工知能です。'), { type: 'teach', term: 'AI', definition: '人工知能', confirm: true });
  });

  test('入力: 長すぎる「単語」は覚えさせず、調べる扱いになる', () => {
    const long = 'あ'.repeat(41) + ' = 意味';
    equal(p(long).type, 'ask');
  });

  test('入力: 質問は「は」を含んでいても質問が優先される', () => {
    equal(p('今日は何ですか').type, 'ask');
    equal(p('AIは何？').type, 'ask');
  });

  test('chat: 長い文章は文章として保存する候補になる（質問・明示の教えは優先）', () => {
    const long = '機械学習は人工知能の一分野で、データから規則を学習する。'.repeat(4);
    equal(AI.chat.parse(long), { type: 'note', text: long });
    const multi = '見出し\n' + 'これは複数行のメモです。'.repeat(4);
    equal(AI.chat.parse(multi).type, 'note');
    equal(AI.chat.parse('猫は動物です。犬も動物です。').type, 'note', '2文以上');
    equal(AI.chat.parse('猫は動物です。').type, 'teach', '1文は従来どおり');
    equal(AI.chat.parse('短い\nメモ').type, 'ask', '短い複数行は文章扱いにしない');
    equal(AI.chat.parse(`AI = ${long}`).type, 'teach', '明示の「=」が優先');
    equal(AI.chat.parse(`${long}とは？`).type, 'ask', '質問が優先');
  });

  test('chat.splitQuestions: 質問が複数あれば分ける（改行／？の後ろ）', () => {
    const eq = (a, b) => equal(JSON.stringify(a), JSON.stringify(b));
    eq(AI.chat.splitQuestions('光合成とは？ 葉緑体って何？'), ['光合成とは？', '葉緑体って何？']);
    eq(AI.chat.splitQuestions('太陽はなぜ光るの？\n月は何でできてる？'), ['太陽はなぜ光るの？', '月は何でできてる？']);
  });

  test('chat.splitQuestions: 質問でないものが混じる／1つだけなら分けない', () => {
    const eq = (a, b) => equal(JSON.stringify(a), JSON.stringify(b));
    eq(AI.chat.splitQuestions('光合成とは？'), ['光合成とは？']);
    eq(AI.chat.splitQuestions('AI = 人工知能\n光合成とは？'), ['AI = 人工知能\n光合成とは？']);
    eq(AI.chat.splitQuestions('今日は晴れ。光合成とは？'), ['今日は晴れ。光合成とは？']);
  });

  test('chat.splitQuestions: 多すぎる（6個以上）ときは分けない', () => {
    const t = Array.from({ length: 6 }, (_, i) => `質問${i}？`).join('');
    equal(AI.chat.splitQuestions(t).length, 1);
  });
})();
