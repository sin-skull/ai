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
})();
