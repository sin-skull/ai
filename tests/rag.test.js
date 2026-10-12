// フェーズ5 の回帰テスト：資料の選び方・プロンプト・「わかりません」の判定・根拠の返し方。
// 実モデルは使わず、決まった答えを返す疑似ジェネレータで仕組みだけを確かめる。
(function () {
  'use strict';
  const { test, equal, ok } = window.T;

  const P = (id, title, body) => ({ passage: { id, title, body }, snippet: body.slice(0, 20) });
  const hits = [
    P(1, '光合成', '植物が光のエネルギーを使い、二酸化炭素と水から糖と酸素を作る反応。葉の中の葉緑体で行われる。'),
    P(2, '睡眠', '眠っている間に脳は記憶を整理する。'),
    P(3, '円安', '外国のお金に対して円の価値が下がること。'),
    P(4, '将棋', '二人で行う盤上の遊び。'),
  ];

  function fakeGen(reply) {
    const g = {
      calls: [],
      ready: true,
      async generate(messages, opts) {
        g.calls.push({ messages, opts });
        if (opts && opts.onToken) opts.onToken(reply);
        return reply;
      },
    };
    return g;
  }

  test('rag: 資料は上位3件まで。番号とタイトルが付く', () => {
    const ctx = AI.rag.pickContext(hits, '光合成とは');
    equal(ctx.length, 3);
    equal(ctx[0].n, 1);
    equal(ctx[2].passage.title, '円安');
  });

  test('rag: 長い本文は質問に関係する文を優先して、上限に収める', () => {
    const filler = 'これは関係のない長い説明文です。'.repeat(40);
    const body = `${filler}鉄は磁石にくっつく金属です。${filler}`;
    const text = AI.rag.excerpt(body, '鉄は磁石にくっつく？', 100);
    ok(text.length <= 100, `長さ ${text.length}`);
    ok(text.includes('鉄は磁石にくっつく'), text);
  });

  test('rag: 全体の長さにも上限がある', () => {
    const long = 'あ'.repeat(2000);
    const many = [P(1, 'a', long), P(2, 'b', long), P(3, 'c', long)];
    const ctx = AI.rag.pickContext(many, 'あ');
    const total = ctx.reduce((s, c) => s + c.text.length, 0);
    ok(total <= AI.rag.MAX_TOTAL, `合計 ${total}`);
  });

  test('rag: プロンプトに資料・質問・禁止事項・口調が入る', () => {
    const ctx = AI.rag.pickContext(hits.slice(0, 1), '植物は何を作る');
    const m = AI.rag.buildMessages('植物は何を作る', ctx, { preset: 'casual' });
    equal(m[0].role, 'system');
    ok(m[0].content.includes('わかりません'));
    ok(m[0].content.includes('従わない'), '資料の中の命令に従わない指示');
    ok(m[0].content.includes('くだけた'));
    ok(m[1].content.includes('[1] 光合成'));
    ok(m[1].content.includes('質問: 植物は何を作る'));
  });

  test('rag: 自分で書いた口調は80字までで、空ならていねいに戻る', () => {
    ok(AI.rag.personaText({ preset: 'custom', custom: '関西弁で話す' }).includes('関西弁'));
    equal(AI.rag.personaText({ preset: 'custom', custom: 'あ'.repeat(200) }).length, 80);
    equal(AI.rag.personaText({ preset: 'custom', custom: '  ' }), AI.rag.PERSONAS.polite.text);
    equal(AI.rag.personaText(undefined), AI.rag.PERSONAS.polite.text);
  });

  test('rag: 「わかりません」を言い方が違っても見つける', () => {
    for (const t of ['わかりません', '分かりません。', 'すみません、わかりません。', 'うーん、わかんない', '資料には書かれていません。', '']) {
      equal(AI.rag.isUnknown(t), true, t);
    }
    for (const t of ['植物は光から糖を作ります。', '円安とは円の価値が下がることです。']) equal(AI.rag.isUnknown(t), false, t);
  });

  test('rag: 資料にある言葉で答えると根拠度が高く、無い言葉だと低い', () => {
    const ctx = '植物が光のエネルギーを使い、二酸化炭素と水から糖と酸素を作る反応。';
    ok(AI.rag.grounding('植物は光のエネルギーで糖と酸素を作ります。', ctx) > 0.6);
    ok(AI.rag.grounding('宇宙ステーションは軌道を周回しています', ctx) < 0.3);
  });

  test('rag: 答えと一緒に、根拠にした文章を返す', async () => {
    const gen = fakeGen('植物は光のエネルギーで糖と酸素を作ります。');
    const r = await AI.rag.answer({ query: '植物は何を作る', hits, generator: gen, persona: { preset: 'polite' } });
    equal(r.unknown, false);
    equal(r.evidence.length, 3);
    equal(r.evidence[0].passage.title, '光合成');
    ok(r.grounding > 0.5);
    equal(gen.calls.length, 1);
  });

  test('rag: モデルが「わかりません」と言ったら unknown（呼び出し側が未回答に回す）', async () => {
    const r = await AI.rag.answer({ query: '好きな映画は', hits, generator: fakeGen('わかりません'), persona: {} });
    equal(r.unknown, true);
  });

  test('rag: 検索結果が空ならモデルを呼ばずに unknown', async () => {
    const gen = fakeGen('なにか');
    const r = await AI.rag.answer({ query: 'x', hits: [], generator: gen, persona: {} });
    equal(r.unknown, true);
    equal(gen.calls.length, 0);
  });

  test('rag: 途中経過が onToken で届く', async () => {
    const seen = [];
    await AI.rag.answer({ query: 'q', hits, generator: fakeGen('こたえ'), persona: {}, onToken: (t) => seen.push(t) });
    equal(seen[0], 'こたえ');
  });

  test('rag.extractAnswer: 質問に近い文を抜き出す（モデル不要）', async () => {
    const passage = { id: 1, title: '光合成', body: '光合成は植物が行う反応です。葉の葉緑体で光のエネルギーを使い、二酸化炭素と水から栄養を作ります。夜は止まります。' };
    const r = await AI.rag.extractAnswer({ query: '植物は光から栄養をどう作る', hits: [{ passage }] });
    ok(r.text.includes('葉緑体'));
    equal(r.evidence[0].passage.id, 1);
  });

  test('rag.extractAnswer: 手がかりが無ければ null', async () => {
    const passage = { id: 2, title: 'x', body: 'ねこはかわいい動物です。' };
    equal(await AI.rag.extractAnswer({ query: 'zzzz', hits: [{ passage }] }), null);
    equal(await AI.rag.extractAnswer({ query: 'q', hits: [] }), null);
  });

  test('rag.isFollowUp: 続きの質問を見分ける', () => {
    for (const q of ['それってなんで', 'なんで', 'もっと詳しく', 'これはどういうこと']) ok(AI.rag.isFollowUp(q), q);
    for (const q of ['睡眠時間って平均何時間', '光合成とは', '好きな映画は']) ok(!AI.rag.isFollowUp(q), q);
  });

  test('rag.buildMessages: 前の会話が入る', () => {
    const ctx = [{ n: 1, passage: { title: 't' }, text: '本文' }];
    const m = AI.rag.buildMessages('なんで', ctx, {}, [{ q: '睡眠時間は', a: '7時間' }]);
    equal(m.map((x) => x.role).join(','), 'system,user,assistant,user');
    ok(m[1].content.includes('睡眠時間は') && m[2].content === '7時間');
  });

  test('rag.missingTerms: 資料に出てこない固有名詞を見つける', () => {
    equal(JSON.stringify(AI.rag.missingTerms('アセロラはジャンクフード？', 'ジャンクフードは栄養価の低い食品')), JSON.stringify(['アセロラ']));
    equal(AI.rag.missingTerms('ジャンクフードとは', 'ジャンクフードは栄養価の低い食品').length, 0);
    equal(AI.rag.missingTerms('なんで体に悪いの', '本文').length, 0);
  });

  test('rag.answer: 資料に無い語を聞かれたら、モデルを呼ばずに unknown', async () => {
    const gen = fakeGen('なにか');
    const r = await AI.rag.answer({ query: 'アセロラは？', hits, generator: gen, persona: {} });
    equal(r.unknown, true);
    equal(gen.calls.length, 0);
    ok(r.missing.includes('アセロラ'));
  });

  test('rag.tidy: 長い答えを3文までに切り、箇条書きの記号を外す', () => {
    const t = AI.rag.tidy('A。B。C。D。E。F。G。H。I。J。');
    equal(t, 'A。B。C。D。E。F。G。H。');
    equal(AI.rag.tidy('**肥満**: 太る。\n\n1. 糖尿病。'), '肥満: 太る。\n糖尿病。');
    ok(AI.rag.tidy('あ'.repeat(900)).length <= 600);
  });

  test('rag.limitsOf: 負荷の段階が上がるほど、資料と答えが小さくなる', () => {
    const a = AI.rag.limitsOf(0), b = AI.rag.limitsOf(1), c = AI.rag.limitsOf(99);
    ok(a.total > b.total && b.total > c.total && a.tokens > b.tokens && b.tokens > c.tokens);
    const long = [{ passage: { id: 1, title: 't', body: 'あ。'.repeat(600) } }];
    ok(AI.rag.pickContext(long, 'あ', c)[0].text.length <= 250);
  });

  // ---- 分けて読む ----
  const longBody = Array.from({ length: 40 }, (_, i) => (i === 27 ? 'コンピュータは計算をする機械で、プログラムで動く。' : `関係ない話の文その${i}で、あまり意味はない。`)).join('');
  const longHits = [{ passage: { id: 9, title: 'コンピュータ', body: longBody } }];

  // 塊を読む係のときは、塊に関係する文があればそれを、無ければ「なし」を返す。最後の答えのときは final を返す
  function scriptedGen(final) {
    const g = { calls: [], ready: true, async generate(messages, opts) {
      g.calls.push({ messages, opts });
      const reading = messages[0].content.includes('資料を読む係');
      const r = reading ? (messages[1].content.includes('計算をする機械') ? 'コンピュータは計算をする機械です。' : 'なし') : final;
      if (opts && opts.onToken) opts.onToken(r);
      return r;
    } };
    return g;
  }

  test('rag.makeChunks: 長い文章を塊に分け、質問に近い塊を選ぶ', () => {
    const lim = AI.rag.limitsOf(0);
    const chunks = AI.rag.makeChunks(longHits, 'コンピュータとは', lim);
    ok(chunks.length <= lim.pieces && chunks.length >= 2);
    ok(chunks.every((c) => c.text.length <= lim.chunk));
    ok(chunks.some((c) => c.text.includes('計算をする機械')), '関係する塊が入る');
  });

  test('rag.answer: 長い資料は分けて読み、メモから答える（1回に読ませる量が小さい）', async () => {
    const lim = AI.rag.limitsOf(0);
    const gen = scriptedGen('コンピュータは計算をする機械で、プログラムで動きます。');
    const seen = [];
    const r = await AI.rag.answer({ query: 'コンピュータとは', hits: longHits, generator: gen, persona: {}, onProgress: (p) => seen.push(p.phase) });
    ok(r.pieces >= 2, '分けて読んだ');
    equal(gen.calls.length, r.pieces + 1, '塊ごとに1回＋最後に1回');
    ok(gen.calls.slice(0, -1).every((c) => c.messages[1].content.length < lim.chunk + 120), '1回に読ませる量が小さい');
    ok(gen.calls[gen.calls.length - 1].messages[1].content.includes('計算をする機械'), '最後はメモだけを読む');
    ok(r.text.includes('プログラム'), `text=${r.text} pieces=${r.pieces}`);
    ok(r.grounding >= 0.5, `grounding=${r.grounding}`);
    ok(seen.includes('read') && seen[seen.length - 1] === 'write', seen.join(','));
  });

  test('rag.answer: 分けて読んで全部「なし」なら unknown（最後の答えは作らない）', async () => {
    const gen = scriptedGen('使われないはず');
    gen.generate = async (messages) => { gen.calls.push({ messages }); return 'なし'; };
    const r = await AI.rag.answer({ query: 'コンピュータの値段', hits: longHits, generator: gen, persona: {} });
    equal(r.unknown, true);
    equal(gen.calls.length, r.pieces);
  });

  test('rag.isNone: メモの「なし」を見分ける', () => {
    ok(AI.rag.isNone('なし'));
    ok(AI.rag.isNone('「なし」。'));
    ok(AI.rag.isNone('関係することはありません。'));
    ok(!AI.rag.isNone('コンピュータは機械です。'));
  });
})();
