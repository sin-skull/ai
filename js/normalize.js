// 単語の正規化。表記ゆれを同じ語として扱うための「キー」を作る。
// 表示用の元の表記は別に残す（ここでは触らない）。
//
// ルール:
//   1. NFKC … 全角英数→半角、半角カナ→全角カナ、濁点の結合など
//   2. カタカナ→ひらがな（ー は残す）
//   3. 英字は小文字
//   4. 連続する空白は1つにし、前後の空白は除く
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});

  function normalizeTerm(input) {
    if (typeof input !== 'string') return '';
    let t = input.normalize('NFKC');
    t = t.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
    t = t.toLowerCase().replace(/\s+/g, ' ').trim();
    return t;
  }

  AI.normalizeTerm = normalizeTerm;
})(typeof globalThis !== 'undefined' ? globalThis : window);
