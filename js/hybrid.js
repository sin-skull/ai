// キーワード検索と意味検索を合わせる（ハイブリッド）。
// 順位だけを使って合算する（RRF: 1 / (K + 順位)）。点数の尺度が違う2つを、そのまま足さないため。
// 固有名詞や型番はキーワードが強く、言い換えは意味検索が強いので、どちらかに引っかかれば上に来る。
// 意味検索が使えない（モデル未準備・失敗）ときは、キーワードだけで答える。
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});

  const RRF_K = 60;

  // 戻り値: [{ passage, via: ['keyword'|'semantic'], score, semScore（意味検索の近さ。無ければ undefined）, snippet }]
  async function search(db, query, options = {}) {
    // minSemantic: これ未満の近さは「関係ない」として捨てる（意味検索は何にでも少しは近くなるため）
    const { provider, limit = 5, mode = 'hybrid', minSemantic = -1 } = options;
    const useKeyword = mode !== 'semantic';
    const useSemantic = mode !== 'keyword' && provider && provider.ready;

    const fused = new Map(); // passageId -> { score, via, passage, snippet }
    const bump = (passage, rank, via, snippet) => {
      const cur = fused.get(passage.id) || { passage, score: 0, via: [], snippet: '' };
      cur.score += 1 / (RRF_K + rank);
      if (!cur.via.includes(via)) cur.via.push(via);
      if (!cur.snippet || via === 'keyword') cur.snippet = snippet || cur.snippet;
      fused.set(passage.id, cur);
    };

    if (useKeyword) {
      const kw = await AI.passages.search(db, query, { limit: 50 });
      kw.forEach((hit, i) => bump(hit.passage, i + 1, 'keyword', hit.snippet));
    }

    let semanticError = null;
    if (useSemantic) {
      try {
        const [qv] = await provider.embed([String(query)], 'query');
        const sem = await AI.vectors.search(db, qv, provider, { limit: 50 });
        const near = sem.filter((x) => x.score >= minSemantic);
        for (let i = 0; i < near.length; i++) {
          const passage = await AI.passages.get(db, near[i].passageId);
          if (!passage) continue;
          const c = near[i].chunk;
          bump(passage, i + 1, 'semantic', passage.body.slice(c.start, c.end).trim().slice(0, 90));
          fused.get(passage.id).semScore = near[i].score;
        }
      } catch (error) {
        semanticError = error; // 意味検索が失敗しても、キーワードの結果は返す
      }
    }

    const out = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    out.semanticError = semanticError;
    return out;
  }

  AI.hybrid = { RRF_K, search };
})(typeof globalThis !== 'undefined' ? globalThis : window);
