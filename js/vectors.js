// 意味ベクトルの保存と検索。
//
// vectors ストアの1件（keyPath: passageId）:
//   passageId  対象の文章
//   model      ベクトルを作ったモデルの id
//   version    同じモデルでの設定の版（変わったら作り直す）
//   dim        次元
//   chunks     [{ start, end }] 本文のどこを1つのベクトルにしたか（文字位置）
//   data       Float32Array（chunks.length × dim。1つずつ正規化済み）
//
// 長い文章は段落・文の切れ目で分け、チャンクごとにベクトルを作る。検索では文章ごとに一番近いチャンクを使う。
// モデルの計算はトランザクションの外で行い、保存するときに「文章がまだあるか」を確かめる。
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});
  const { tx, rq } = AI.db;

  const CHUNK_MAX = 300; // 1チャンクの最大文字数（e5 の入力上限に余裕を持たせる）

  // 本文を [{ start, end, text }] に分ける（隙間なく、順番どおり）
  function chunk(body, max = CHUNK_MAX) {
    const text = String(body ?? '');
    // まず文の切れ目（改行・句点など）で小さく区切る
    const pieces = [];
    const re = /[^。！？!?\n]*[。！？!?\n]+|[^。！？!?\n]+$/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0] === '') break;
      pieces.push({ start: m.index, end: m.index + m[0].length });
    }
    // 長すぎる文は文字数で割る
    const small = [];
    for (const p of pieces) {
      for (let s = p.start; s < p.end; s += max) small.push({ start: s, end: Math.min(p.end, s + max) });
    }
    // max に収まる範囲でまとめる
    const out = [];
    let cur = null;
    for (const p of small) {
      if (cur && p.end - cur.start <= max) cur.end = p.end;
      else {
        if (cur) out.push(cur);
        cur = { start: p.start, end: p.end };
      }
    }
    if (cur) out.push(cur);
    return out
      .map((c) => ({ ...c, text: text.slice(c.start, c.end) }))
      .filter((c) => c.text.trim() !== '');
  }

  // 1つ目のチャンクだけ、タイトルを前に付ける（見出しの語でも引けるように）
  function inputsFor(passage, chunks) {
    return chunks.map((c, i) => (i === 0 && passage.title ? `${passage.title}\n${c.text}` : c.text));
  }

  function matches(row, provider) {
    return !!row && row.model === provider.id && row.version === provider.version && row.dim === provider.dim;
  }

  // 1件のベクトルを作って保存する。保存時に文章が無ければ何もしない。戻り値: 保存したら true
  async function indexPassage(db, passage, provider) {
    const chunks = chunk(passage.body);
    if (!chunks.length) return false;
    const vecs = await provider.embed(inputsFor(passage, chunks), 'passage');
    const data = new Float32Array(vecs.length * provider.dim);
    vecs.forEach((v, i) => data.set(v, i * provider.dim));
    return tx(db, ['passages', 'vectors'], 'readwrite', async (t) => {
      const still = await rq(t.objectStore('passages').get(passage.id));
      if (!still || still.body !== passage.body) return false; // 計算中に消された／書き換えられた
      await rq(
        t.objectStore('vectors').put({
          passageId: passage.id,
          model: provider.id,
          version: provider.version,
          dim: provider.dim,
          chunks: chunks.map(({ start, end }) => ({ start, end })),
          data,
        })
      );
      return true;
    });
  }

  // 作成状況。total: 文章の数 / indexed: 今のモデルで作成済み / stale: 未作成か、別のモデル・版
  async function status(db, provider) {
    const { passages, rows } = await tx(db, ['passages', 'vectors'], 'readonly', async (t) => ({
      passages: await rq(t.objectStore('passages').getAllKeys()),
      rows: await rq(t.objectStore('vectors').getAll()),
    }));
    const ok = new Set(rows.filter((r) => matches(r, provider)).map((r) => r.passageId));
    const indexed = passages.filter((id) => ok.has(id)).length;
    return { total: passages.length, indexed, stale: passages.length - indexed };
  }

  // 未作成・古いものを作り直す。onProgress({ done, total })。shouldStop() が true を返したら止める。戻り値: 作った件数
  async function reindex(db, provider, options = {}) {
    const { onProgress, shouldStop } = options;
    const { passages, rows } = await tx(db, ['passages', 'vectors'], 'readonly', async (t) => ({
      passages: await rq(t.objectStore('passages').getAll()),
      rows: await rq(t.objectStore('vectors').getAll()),
    }));
    const ok = new Set(rows.filter((r) => matches(r, provider)).map((r) => r.passageId));
    const todo = passages.filter((p) => !ok.has(p.id));
    let done = 0;
    for (const passage of todo) {
      if (shouldStop && shouldStop()) break;
      if (await indexPassage(db, passage, provider)) done++;
      if (onProgress) onProgress({ done, total: todo.length });
    }
    return done;
  }

  // 今のモデル以外のベクトルを消す（モデルを切り替えたあとの掃除）。戻り値: 消した件数
  async function removeOthers(db, provider) {
    return tx(db, 'vectors', 'readwrite', async (t) => {
      const store = t.objectStore('vectors');
      let n = 0;
      for (const row of await rq(store.getAll())) {
        if (matches(row, provider)) continue;
        await rq(store.delete(row.passageId));
        n++;
      }
      return n;
    });
  }

  async function removeAll(db) {
    return tx(db, 'vectors', 'readwrite', (t) => rq(t.objectStore('vectors').clear()));
  }

  // クエリのベクトルに近い文章を、近い順に。戻り値: [{ passageId, score, chunk: { start, end } }]
  async function search(db, queryVec, provider, options = {}) {
    const limit = options.limit ?? 20;
    const rows = await tx(db, 'vectors', 'readonly', (t) => rq(t.objectStore('vectors').getAll()));
    const results = [];
    for (const row of rows) {
      if (!matches(row, provider)) continue;
      let best = -Infinity;
      let bestAt = 0;
      const count = row.chunks.length;
      for (let c = 0; c < count; c++) {
        let dot = 0;
        const off = c * row.dim;
        for (let i = 0; i < row.dim; i++) dot += queryVec[i] * row.data[off + i];
        if (dot > best) {
          best = dot;
          bestAt = c;
        }
      }
      results.push({ passageId: row.passageId, score: best, chunk: row.chunks[bestAt] });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  AI.vectors = { CHUNK_MAX, chunk, inputsFor, indexPassage, status, reindex, removeOthers, removeAll, search };
})(typeof globalThis !== 'undefined' ? globalThis : window);
