// 感謝や否定の「言葉」から、評価の合図を読み取る（辞書ルール。モデルは使わない）。
//
// 守ること（リスクの項目より）:
//   ・口調の強さと内容の正しさを混同しない。叱責や悪口（「使えない」「ばか」など）は評価に変えない
//   ・メッセージ全体が短い決まった言葉と一致したときだけ反応する（文章の中の一部では反応しない）
//   ・どう扱うかは呼び出し側が決める（明示の👍/👎を優先する・取り消せるようにする）
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});

  const POSITIVE = ['ありがとう', 'ありがとうございます', 'ありがと', 'あざす', 'あざっす', '助かった', '助かりました', 'たすかった', 'ナイス', 'なるほど', '正解', 'あってる', '合ってる', 'あってます', '合ってます', 'それそれ', 'いいね', 'ばっちり', '完璧', 'さすが', 'いいね'];
  const NEGATIVE = ['違う', 'ちがう', '違います', 'ちがいます', '間違い', '間違ってる', '間違ってます', 'まちがってる', '不正解', 'はずれ', 'ハズレ', 'そうじゃない', 'そうじゃなくて', 'それは違う', 'それじゃない', '違うよ', 'ちがうよ'];

  const MAX_LENGTH = 14;

  // 比べやすいように、記号・空白・語尾の「よ」「ね」「です」を落とす
  function clean(text) {
    return AI.normalizeTerm(String(text ?? ''))
      .replace(/[\s!！?？。、，.~〜ー…♪☆★\u{1F300}-\u{1FAFF}☀-➿]/gu, '')
      .replace(/(よ|ね|です|ました)$/u, (m, _g, offset, whole) => (whole.length > m.length ? '' : m));
  }

  const POS = new Set(POSITIVE.map(clean));
  const NEG = new Set(NEGATIVE.map(clean));

  // 戻り値: { value: 1 | -1 | 0, word }。反応しないときは value 0
  function detect(text) {
    const raw = String(text ?? '').trim();
    if (!raw || raw.length > MAX_LENGTH) return { value: 0, word: '' };
    const c = clean(raw);
    if (POS.has(c)) return { value: 1, word: raw };
    if (NEG.has(c)) return { value: -1, word: raw };
    return { value: 0, word: '' };
  }

  AI.sentiment = { MAX_LENGTH, detect };
})(typeof globalThis !== 'undefined' ? globalThis : window);
