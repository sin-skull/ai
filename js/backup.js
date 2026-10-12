// 書き出し／読み込み（JSON）。単語・文章・評価ログを1つのファイルにまとめる。
// n-gram インデックスと意味ベクトルは持ち出さない（読み込み時に作り直す）。
//
// 読み込みの方式:
//   'merge'     … 今のデータを残して足す。同じ単語は更新が新しい方の定義を採用（表記ゆれ・出典は和集合）。
//                 同じ本文の文章は1件のまま。文章のIDは付け直す。
//   'overwrite' … 今のデータを全て消して、ファイルの内容に置き換える（IDも保つ）。
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});
  const { tx, rq } = AI.db;

  const FORMAT = 'ai-backup';
  const FORMAT_VERSION = 1;
  const EXPORTED_KEY = 'lastExportAt';

  async function exportAll(db, options = {}) {
    const now = options.now ?? Date.now();
    const data = await tx(db, ['terms', 'passages', 'feedback', 'queue'], 'readonly', async (t) => ({
      terms: await rq(t.objectStore('terms').getAll()),
      passages: await rq(t.objectStore('passages').getAll()),
      feedback: await rq(t.objectStore('feedback').getAll()),
      queue: await rq(t.objectStore('queue').getAll()),
    }));
    return { format: FORMAT, formatVersion: FORMAT_VERSION, schemaVersion: AI.db.SCHEMA_VERSION, exportedAt: now, ...data };
  }

  async function markExported(db, now = Date.now()) {
    await tx(db, 'settings', 'readwrite', (t) => rq(t.objectStore('settings').put({ name: EXPORTED_KEY, value: now })));
  }

  async function lastExportAt(db) {
    const row = await tx(db, 'settings', 'readonly', (t) => rq(t.objectStore('settings').get(EXPORTED_KEY)));
    return row ? row.value : null;
  }

  // 読み込む前に中身を確かめる。問題があれば例外（何も書き込まない）。
  function validate(data) {
    if (!data || typeof data !== 'object' || data.format !== FORMAT) throw new Error('このアプリの書き出しファイルではありません。');
    if (data.formatVersion > FORMAT_VERSION) throw new Error('新しい版のファイルです。アプリを更新してから読み込んでください。');
    for (const k of ['terms', 'passages', 'feedback']) {
      if (!Array.isArray(data[k])) throw new Error(`ファイルが壊れています（${k}）。`);
    }
    if (data.queue !== undefined && !Array.isArray(data.queue)) throw new Error('ファイルが壊れています（queue）。');
    for (const t of data.terms) if (!t || typeof t.key !== 'string' || !t.key) throw new Error('ファイルが壊れています（単語）。');
    for (const p of data.passages) {
      if (!p || typeof p.body !== 'string' || !Number.isInteger(p.id)) throw new Error('ファイルが壊れています（文章）。');
    }
    return { terms: data.terms.length, passages: data.passages.length, feedback: data.feedback.length, queue: (data.queue || []).length };
  }

  const indexText = (p) => `${p.title}\n${p.body}`;

  async function indexAddAll(t, id, text) {
    const store = t.objectStore('ngram');
    for (const gram of AI.passages.grams(text)) {
      const entry = (await rq(store.get(gram))) || { gram, ids: [] };
      if (!entry.ids.includes(id)) {
        entry.ids.push(id);
        await rq(store.put(entry));
      }
    }
  }

  function mergeTerm(current, incoming) {
    const out = { ...current };
    for (const v of incoming.variants || []) if (!out.variants.includes(v)) out.variants.push(v);
    for (const s of incoming.sources || []) {
      if (!out.sources.some((x) => (s.url && x.url === s.url) || (!s.url && x.title === s.title))) out.sources.push(s);
    }
    if (incoming.definition && (incoming.updatedAt || 0) > (current.updatedAt || 0) && incoming.definition !== current.definition) {
      out.definition = incoming.definition;
      out.updatedAt = incoming.updatedAt;
      out.term = incoming.term || out.term;
    } else if (!current.definition && incoming.definition) {
      out.definition = incoming.definition;
      out.updatedAt = Math.max(current.updatedAt || 0, incoming.updatedAt || 0);
    }
    out.createdAt = Math.min(current.createdAt || Infinity, incoming.createdAt || Infinity);
    return out;
  }

  // 戻り値: { terms: { added, merged }, passages: { added, skipped }, feedback }
  async function importAll(db, data, options = {}) {
    validate(data);
    const mode = options.mode || 'merge';
    if (mode !== 'merge' && mode !== 'overwrite') throw new Error(`未知の読み込み方式: ${mode}`);

    const queueRows = data.queue || [];
    return tx(db, ['terms', 'passages', 'ngram', 'vectors', 'feedback', 'queue'], 'readwrite', async (t) => {
      const terms = t.objectStore('terms');
      const passages = t.objectStore('passages');
      const result = { terms: { added: 0, merged: 0 }, passages: { added: 0, skipped: 0 }, feedback: 0, queue: 0 };

      if (mode === 'overwrite') {
        for (const name of ['terms', 'passages', 'ngram', 'vectors', 'feedback', 'queue']) await rq(t.objectStore(name).clear());
        for (const term of data.terms) {
          await rq(terms.put(term));
          result.terms.added++;
        }
        for (const p of data.passages) {
          await rq(passages.put(p)); // IDを保ったまま入れる
          await indexAddAll(t, p.id, indexText(p));
          result.passages.added++;
        }
        for (const f of data.feedback) {
          const { id, ...row } = f;
          await rq(t.objectStore('feedback').add(row));
          result.feedback++;
        }
        for (const q of queueRows) {
          await rq(t.objectStore('queue').put(q));
          result.queue++;
        }
        return result;
      }

      // merge
      for (const incoming of data.terms) {
        const current = await rq(terms.get(incoming.key));
        if (!current) {
          await rq(terms.put(incoming));
          result.terms.added++;
        } else {
          await rq(terms.put(mergeTerm(current, incoming)));
          result.terms.merged++;
        }
      }

      const existing = await rq(passages.getAll());
      const seen = new Set(existing.map((p) => p.body));
      const idMap = new Map(); // ファイル内のID → 今のID
      for (const p of data.passages) {
        const same = existing.find((e) => e.body === p.body);
        if (same || seen.has(p.body)) {
          idMap.set(p.id, same ? same.id : null);
          result.passages.skipped++;
          continue;
        }
        const { id, ...row } = p;
        const newId = await rq(passages.add(row));
        await indexAddAll(t, newId, indexText(row));
        seen.add(p.body);
        idMap.set(id, newId);
        result.passages.added++;
      }

      // 評価ログ：本文が重複して読み込まなかった文章のログは取り込まない。単語のログは同じ内容を重ねない
      const log = t.objectStore('feedback');
      const have = new Set((await rq(log.getAll())).map((f) => `${f.targetType}|${f.targetId}|${f.at}|${f.value}`));
      for (const f of data.feedback) {
        let targetId = f.targetId;
        if (f.targetType === 'passage') {
          targetId = idMap.get(f.targetId);
          if (targetId == null) continue;
        }
        const sig = `${f.targetType}|${targetId}|${f.at}|${f.value}`;
        if (have.has(sig)) continue;
        have.add(sig);
        await rq(log.add({ targetType: f.targetType, targetId, value: f.value, at: f.at }));
        result.feedback++;
      }

      // 未回答キュー：調べ待ちで、今の調べ待ちに無い語だけ足す
      const queue = t.objectStore('queue');
      const pending = await rq(queue.index('status').getAll('pending'));
      const keys = new Set(pending.map((q) => q.key));
      for (const q of queueRows) {
        if (q.status !== 'pending' || keys.has(q.key)) continue;
        keys.add(q.key);
        const { id, ...row } = q;
        await rq(queue.add(row));
        result.queue++;
      }
      return result;
    });
  }

  // 覚えたものを全部消す（単語・文章・索引・ベクトル・評価・未回答）。設定（意味検索・回答モデル・重み・モード）は残す。
  // options.settings: true なら設定も消す（初期状態に戻す）。戻り値: 消した件数 { terms, passages }
  async function wipe(db, options = {}) {
    const names = ['terms', 'passages', 'ngram', 'vectors', 'feedback', 'queue'].concat(options.settings ? ['settings'] : []);
    return tx(db, names, 'readwrite', async (t) => {
      const result = { terms: await rq(t.objectStore('terms').count()), passages: await rq(t.objectStore('passages').count()) };
      for (const name of names) await rq(t.objectStore(name).clear());
      return result;
    });
  }

  AI.backup = { wipe, FORMAT, validate, exportAll, importAll, markExported, lastExportAt };
})(typeof globalThis !== 'undefined' ? globalThis : window);
