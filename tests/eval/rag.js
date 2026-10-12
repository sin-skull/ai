// 回答の評価。保存文章30件に対して、検索→回答まで通して、次を数える。
//   ・答えを出せた割合（質問36件）／正解の文章を根拠に使えた割合
//   ・答えが資料の言葉でできている割合（根拠度。低いと作り話の疑い）
//   ・関係ない質問6件で、ちゃんと「知らない」にできた割合（作り話をしないか）
// 使い方: tests/eval.html で「回答も評価」。?fake 相当のボタンは疑似モデルで仕組みだけ確認。
(function () {
  'use strict';
  const { passages, queries, unrelated } = window.EVAL;
  const MIN = 0.84; // app.js の SEMANTIC_MIN と同じ

  function fakeGenerator() {
    return {
      id: 'fake', ready: true,
      async prepare() {},
      // 資料の先頭の文をそのまま返す。資料に無い質問のふりはできないので、関係ない質問は検索が空になる想定
      async generate(messages) {
        const doc = messages[1].content.split('\n')[2] || '';
        return doc.split('。')[0] + '。';
      },
      stop() {}, async unload() {},
    };
  }
  function fakeProvider() {
    return {
      id: 'fake', version: 1, dim: 64, ready: true,
      async prepare() {},
      async embed(texts) {
        return texts.map((t) => {
          const v = new Float32Array(64);
          const c = Array.from(AI.normalizeTerm(t));
          for (let i = 0; i + 1 < c.length; i++) {
            let h = 0;
            for (const ch of c[i] + c[i + 1]) h = (h * 31 + ch.codePointAt(0)) >>> 0;
            v[h % 64] += 1;
          }
          return AI.embed.normalize(v);
        });
      },
    };
  }

  const pct = (x) => `${(x * 100).toFixed(0)}%`;

  async function run(log, options = {}) {
    const db = await AI.db.open(`ai-eval-rag-${Date.now()}`);
    const name = db.name;
    const out = {};
    try {
      let provider = fakeProvider();
      let generator = fakeGenerator();
      const progress = (label) => {
        let last = 0;
        return (info) => {
          const now = performance.now();
          if (now - last > 1500) {
            last = now;
            log(`  ${label} ${info.label}: ${Math.round((info.loaded / info.total) * 100)}%`);
          }
        };
      };
      if (!options.fake) {
        provider = AI.embed.transformersProvider(AI.embed.PACKS[0]);
        generator = AI.llm.transformersGenerator(AI.llm.PACKS[0]);
        log('意味検索のモデルを読み込んでいます…');
        await provider.prepare(progress('意味検索'));
        log('回答モデルを読み込んでいます…（初回は約520MBをダウンロードします）');
        const t0 = performance.now();
        await generator.prepare(progress('回答'));
        out.loadMs = Math.round(performance.now() - t0);
        log(`回答モデルの準備ができました（${(out.loadMs / 1000).toFixed(1)}秒）`);
      }
      const ids = [];
      for (const p of passages) ids.push((await AI.passages.add(db, p.body, { title: p.title })).id);
      await AI.vectors.reindex(db, provider);

      let answered = 0, right = 0, groundSum = 0, groundN = 0, tokensMs = 0;
      const samples = [];
      for (const { q, a } of queries) {
        const hits = await AI.hybrid.search(db, q, { provider, limit: 5, minSemantic: MIN });
        if (!hits.length) continue;
        const t = performance.now();
        const r = await AI.rag.answer({ query: q, hits, generator, persona: { preset: 'polite' } });
        tokensMs += performance.now() - t;
        if (r.unknown) continue;
        answered++;
        if (r.evidence[0] && r.evidence[0].passage.id === ids[a]) right++;
        groundSum += r.grounding;
        groundN++;
        if (samples.length < 6) samples.push({ q, a: r.text, ground: r.grounding, ok: r.evidence[0].passage.id === ids[a] });
      }
      let refused = 0;
      const wrong = [];
      for (const q of unrelated) {
        const hits = await AI.hybrid.search(db, q, { provider, limit: 5, minSemantic: MIN });
        if (!hits.length) { refused++; continue; }
        const r = await AI.rag.answer({ query: q, hits, generator, persona: { preset: 'polite' } });
        if (r.unknown) refused++;
        else wrong.push({ q, a: r.text });
      }
      out.summary = {
        n: queries.length,
        answeredRate: answered / queries.length,
        rightEvidenceRate: right / queries.length,
        groundingAvg: groundN ? groundSum / groundN : 0,
        refusedRate: refused / unrelated.length,
        msPerAnswer: answered ? Math.round(tokensMs / answered) : 0,
        wrong,
      };
      const s = out.summary;
      log('');
      log('■ 回答の評価');
      log(`答えを出せた：${pct(s.answeredRate)}（質問${s.n}件）／ 正解の文章を根拠にできた：${pct(s.rightEvidenceRate)}`);
      log(`答えが資料の言葉でできている度合い（根拠度の平均）：${s.groundingAvg.toFixed(2)}（1に近いほど資料どおり）`);
      log(`関係ない質問で「知らない」にできた：${pct(s.refusedRate)}（${unrelated.length}件）`);
      if (s.wrong.length) s.wrong.forEach((w) => log(`  ✗ 作り話の疑い: 「${w.q}」→ ${w.a}`));
      log(`1回の回答にかかった時間：約${(s.msPerAnswer / 1000).toFixed(1)}秒`);
      log('');
      log('■ 答えの例（目で確かめてください）');
      samples.forEach((x) => log(`Q: ${x.q}\nA: ${x.a}\n   根拠度 ${x.ground.toFixed(2)} ／ 根拠の文章 ${x.ok ? '正解' : '違う'}`));
    } finally {
      db.close();
      await AI.db.deleteDatabase(name);
    }
    return out;
  }
  window.runRagEval = run;
})();
