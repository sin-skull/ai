// 入力の解釈。いまはルールだけで読み取る（モデルはフェーズ5以降）。
//
// 戻り値:
//   { type: 'empty' }
//   { type: 'teach', term, definition, confirm }  … 覚えさせる。confirm=true なら保存前に確認する
//   { type: 'note', text }                        … 長い文章。文章として保存するか確認する
//   { type: 'ask', query }                        … 調べる（質問・単語だけの入力もここ）
//
// 読み取りの優先順位:
//   1. 「単語 = 意味」「単語：意味」「単語: 意味」 … 迷いが無いので、そのまま保存してよい
//   2. 質問（「AIとは？」「AIって何」など）
//   3. 長い文章（NOTE_MIN 文字以上／2文以上／改行を含み一定以上）は文章として扱う
//   4. 「AIは人工知能」「AIとは人工知能のこと」 … ふつうの文との区別がつかないので、確認してから保存
//   5. それ以外は調べる
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});

  const MAX_TERM = 40; // これより長い「単語」は、文として扱う
  const NOTE_MIN = 80; // これ以上の長さは、文章として保存する候補にする
  const NOTE_MIN_MULTILINE = 40; // 改行を含むなら、これ以上で候補にする

  const QUESTION_TAIL =
    /(とは何ですか|とは何|とはなに|とは|って何ですか|って何|ってなに|を教えてください|を教えて|について教えてください|について教えて|について|は何ですか|は何|はなに|ですか)\s*$/;

  function cleanDefinition(text) {
    return text
      .replace(/(のことです|のこと|です|である|だよ|だ)\s*[。.]?\s*$/u, '')
      .replace(/[。.]\s*$/u, '')
      .trim();
  }

  function parse(input) {
    const text = String(input ?? '').trim();
    if (!text) return { type: 'empty' };

    // 1. 区切り記号ではっきり教えている
    const explicit =
      text.match(/^([^=＝\n]+?)\s*[=＝]\s*([\s\S]+)$/) ||
      text.match(/^([^：\n]+?)\s*：\s*([\s\S]+)$/) ||
      text.match(/^([^:\n]+?):\s+([\s\S]+)$/);
    if (explicit) {
      const term = explicit[1].trim();
      const definition = explicit[2].trim();
      if (term && definition && term.length <= MAX_TERM) {
        return { type: 'teach', term, definition, confirm: false };
      }
    }

    // 2. 質問
    const isQuestion = /[?？]\s*$/.test(text) || QUESTION_TAIL.test(text);
    if (isQuestion) {
      const query = text
        .replace(/[?？]+\s*$/, '')
        .replace(QUESTION_TAIL, '')
        .trim();
      return { type: 'ask', query: query || text.replace(/[?？]+\s*$/, '').trim() };
    }

    // 3. 長い文章
    const sentences = (text.match(/[。.！!]/g) || []).length;
    if (text.length >= NOTE_MIN || sentences >= 2 || (/\n/.test(text) && text.length >= NOTE_MIN_MULTILINE)) {
      return { type: 'note', text };
    }

    // 4. 「AIは人工知能」型。ふつうの文かもしれないので確認つき
    const copula = text.match(/^(.+?)(?:とは|って|は)\s*([\s\S]+)$/);
    if (copula) {
      const term = copula[1].trim();
      const definition = cleanDefinition(copula[2]);
      if (term && definition && term.length <= MAX_TERM) {
        return { type: 'teach', term, definition, confirm: true };
      }
    }

    // 5. 単語だけ、などは調べる
    return { type: 'ask', query: text };
  }

  // 質問の形をしているか（？で終わる、または「〜とは」「〜を教えて」など）。1回で複数聞くときの区切りに使う
  function isQuestion(input) {
    const text = String(input ?? '').trim();
    return !!text && !/[=＝：]/.test(text) && (/[?？]\s*$/.test(text) || QUESTION_TAIL.test(text));
  }

  // 1回の送信に複数の質問が入っていたら分ける（改行、または「？」の後ろで区切る）。
  // 全部が質問のときだけ分ける。1つでも質問でないものが混じるときは、分けない（文章として扱う）
  const MAX_QUESTIONS = 5;
  function splitQuestions(input) {
    const text = String(input ?? '').trim();
    if (!text) return [text];
    const parts = text
      .split(/\n+/)
      .flatMap((line) => line.match(/[^?？]+[?？]*/g) || [])
      .map((x) => x.trim())
      .filter(Boolean);
    if (parts.length < 2 || parts.length > MAX_QUESTIONS) return [text];
    return parts.every(isQuestion) ? parts : [text];
  }

  AI.chat = { parse, isQuestion, splitQuestions };
})(typeof globalThis !== 'undefined' ? globalThis : window);
