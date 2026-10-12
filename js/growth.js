// 知識の「育ち」。評価・重要度・新しさ・使われた回数を、検索の順位と整理に反映する。
//
// 方針:
//   ・モデルは賢くならない。育つのは、保存した知識の質だけ
//   ・順位への効きは小さく、設定で調整できる（0 にすれば無効）。関係ない文章が上に来ないよう、
//     検索で「関係あり」と判定された結果の並べ替えにだけ使う
//   ・消すのは必ず本人。ここは候補を出すだけ（ピン留めしたものは候補に出さない）
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});
  const { tx, rq } = AI.db;

  const DAY = 24 * 60 * 60 * 1000;
  const FRESH_HALF_DAYS = 180; // 新しさが半分になる日数
  const RRF_K = 60;
  const DEFAULT_WEIGHTS = { score: 0.1, importance: 0.1, fresh: 0.05 };
  const LIMITS = { score: [0, 0.5], importance: [0, 0.5], fresh: [0, 0.3] };

  // 整理候補の基準
  const UNUSED_DAYS = 30; // 保存から、使われないまま経った日数
  const OLD_DAYS = 180; // 古いとみなす日数

  const STORE = { term: 'terms', passage: 'passages' };
  const keyOf = { term: (r) => r.key, passage: (r) => r.id };
  const savedAt = { term: (r) => r.updatedAt, passage: (r) => r.fetchedAt };

  function clampWeights(w) {
    const out = {};
    for (const k of Object.keys(DEFAULT_WEIGHTS)) {
      const v = Number(w && w[k]);
      const [lo, hi] = LIMITS[k];
      out[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULT_WEIGHTS[k];
    }
    return out;
  }

  // 0〜1。新しいほど 1 に近い
  function freshness(savedMs, now) {
    const age = Math.max(0, (now - savedMs) / DAY);
    return Math.pow(0.5, age / FRESH_HALF_DAYS);
  }

  // 順位にかける倍率。評価 -1〜+1、重要度 0〜1、新しさ（0.5 を基準に ±）
  function factor(passage, weights, now) {
    const w = clampWeights(weights);
    const f =
      1 +
      w.score * (passage.score || 0) +
      w.importance * (passage.importance || 0) +
      w.fresh * (freshness(passage.fetchedAt || now, now) - 0.5);
    return Math.max(0.1, f);
  }

  // 検索結果を、評価などを加味して並べ替える。元の順位から作った点（RRF）に倍率をかける。
  // 戻り値は新しい配列（hits の各要素に boost を足したコピー）。同点は元の順のまま
  function rerank(hits, weights, now = Date.now()) {
    const scored = hits.map((h, i) => {
      const boost = factor(h.passage, weights, now);
      return { hit: { ...h, boost }, value: boost / (RRF_K + i + 1), i };
    });
    scored.sort((a, b) => b.value - a.value || a.i - b.i);
    return scored.map((s) => s.hit);
  }

  // 回答の根拠に使ったとき。使用回数 +1 と最終使用日
  async function markUsed(db, kind, ids, now = Date.now()) {
    if (!STORE[kind]) throw new Error(`未知の対象: ${kind}`);
    const list = Array.isArray(ids) ? ids : [ids];
    return tx(db, STORE[kind], 'readwrite', async (t) => {
      const store = t.objectStore(STORE[kind]);
      let n = 0;
      for (const id of list) {
        const r = await rq(store.get(id));
        if (!r) continue;
        r.useCount = (r.useCount || 0) + 1;
        r.lastUsedAt = now;
        await rq(store.put(r));
        n++;
      }
      return n;
    });
  }

  // 重要度（0〜1）。ピン留め = 1、外す = 0
  async function setImportance(db, kind, id, value) {
    if (!STORE[kind]) throw new Error(`未知の対象: ${kind}`);
    const v = Math.min(1, Math.max(0, Number(value) || 0));
    return tx(db, STORE[kind], 'readwrite', async (t) => {
      const store = t.objectStore(STORE[kind]);
      const r = await rq(store.get(id));
      if (!r) throw new Error('対象が見つかりません');
      r.importance = v;
      await rq(store.put(r));
      return v;
    });
  }

  async function loadWeights(db) {
    const row = await tx(db, 'settings', 'readonly', (t) => rq(t.objectStore('settings').get('ranking')));
    return clampWeights(row && row.value);
  }
  async function saveWeights(db, weights) {
    const value = clampWeights(weights);
    await tx(db, 'settings', 'readwrite', (t) => rq(t.objectStore('settings').put({ name: 'ranking', value })));
    return value;
  }

  // 整理の候補。ピン留め（重要度 > 0）は出さない。
  // 戻り値: [{ kind, id, title, reasons: [{code, text}], points, ageDays, refetch }]（優先度の高い順）
  function candidates(terms, passages, now = Date.now()) {
    const out = [];
    const consider = (kind, r) => {
      if ((r.importance || 0) > 0) return;
      const base = savedAt[kind](r);
      const ageDays = Math.floor((now - base) / DAY);
      const reasons = [];
      let points = 0;
      if ((r.score || 0) < 0) {
        reasons.push({ code: 'low', text: '👎が付いています' });
        points += 100;
      }
      if (!(r.useCount > 0) && ageDays >= UNUSED_DAYS) {
        reasons.push({ code: 'unused', text: `一度も使われていません（保存から${ageDays}日）` });
        points += 50;
      }
      const lastTouched = r.lastUsedAt || base;
      if (ageDays >= OLD_DAYS && (now - lastTouched) / DAY >= OLD_DAYS) {
        reasons.push({ code: 'old', text: `${ageDays}日前に保存したままです` });
        points += 20;
      }
      if (!reasons.length) return;
      const refetch = kind === 'passage' && /^https?:\/\/[a-z-]+\.wikipedia\.org\//.test(r.sourceUrl || '');
      out.push({ kind, id: keyOf[kind](r), title: kind === 'term' ? r.term : r.title, reasons, points: points + Math.min(ageDays, 19) / 100, ageDays, refetch });
    };
    terms.forEach((r) => consider('term', r));
    passages.forEach((r) => consider('passage', r));
    return out.sort((a, b) => b.points - a.points);
  }

  // 育ちの集計：週ごとの蓄積数、よく使われた知識、未回答の数
  function summary(terms, passages, queueCount, now = Date.now(), weeks = 8) {
    const created = terms.map((r) => r.createdAt || r.updatedAt).concat(passages.map((r) => r.fetchedAt));
    const points = [];
    for (let w = weeks - 1; w >= 0; w--) {
      const end = now - w * 7 * DAY;
      points.push({ end, total: created.filter((t) => t <= end).length });
    }
    const used = terms
      .map((r) => ({ kind: 'term', title: r.term, useCount: r.useCount || 0 }))
      .concat(passages.map((r) => ({ kind: 'passage', title: r.title, useCount: r.useCount || 0 })))
      .filter((x) => x.useCount > 0)
      .sort((a, b) => b.useCount - a.useCount)
      .slice(0, 5);
    const rated = (rs) => rs.filter((r) => (r.score || 0) > 0).length;
    return {
      points,
      used,
      terms: terms.length,
      passages: passages.length,
      queue: queueCount,
      liked: rated(terms) + rated(passages),
      disliked: terms.concat(passages).filter((r) => (r.score || 0) < 0).length,
      pinned: terms.concat(passages).filter((r) => (r.importance || 0) > 0).length,
    };
  }

  AI.growth = {
    DAY, DEFAULT_WEIGHTS, LIMITS, UNUSED_DAYS, OLD_DAYS, FRESH_HALF_DAYS,
    clampWeights, freshness, factor, rerank, markUsed, setImportance, loadWeights, saveWeights, candidates, summary,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
