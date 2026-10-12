// 文章を生成する部品（ジェネレータ）。回答モデルをブラウザの中で動かす。
//
// ジェネレータの形（これを満たせば差し替えられる。テストでは疑似ジェネレータを使う）:
//   id        モデルの識別子
//   ready     準備できているか
//   prepare(onProgress)                 モデルを読み込む（初回だけダウンロード。保存済みなら通信しない）
//   generate(messages, { maxTokens, onToken })   messages: [{role, content}]。戻り値: 生成した文字列。onToken(これまでの全文)
//   stop()                              生成を途中で止める
//   unload()                            メモリから降ろす（端末のファイルは残す）
(function (root) {
  'use strict';
  const AI = (root.AI = root.AI || {});

  // 容量は onnx ファイルの実サイズ（Hugging Face で確認した値）に設定ファイル等を足した目安。
  // 0.5B は Apache-2.0。重いモデルは iPhone のメモリで動かないので、ここでは小さいものだけを置く。
  const HOSTS = ['huggingface.co（モデル）', 'cdn.jsdelivr.net（実行用ファイル）'];
  const PACKS = [
    {
      id: 'lfm2-350m',
      label: '軽量（LFM2 350M）',
      model: 'onnx-community/LFM2-350M-ONNX',
      dtype: 'q4',
      approxMB: 300,
      version: 1,
      license: 'LFM Open License v1.0（年間売上が一定額未満なら商用も可。配布前に条件を確認する）',
      note: '日本語に対応した小型モデル。容量が小さく、iPhoneでも落ちにくい見込み（実機は未確認）',
      hosts: HOSTS,
    },
    {
      id: 'qwen2.5-0.5b',
      label: '標準（Qwen2.5 0.5B）',
      model: 'onnx-community/Qwen2.5-0.5B-Instruct',
      dtype: 'q8',
      approxMB: 520,
      version: 1,
      license: 'Apache-2.0',
      note: '日本語の力は軽量版より期待できるが、メモリを多く使う。端末によっては読み込み中に落ちる',
      hosts: HOSTS,
    },
  ];

  function transformersGenerator(pack) {
    let generator = null;
    let stopper = null;
    return {
      id: `${pack.model}@${pack.dtype}`,
      version: pack.version,
      pack,
      get ready() {
        return generator !== null;
      },
      async prepare(onProgress) {
        if (generator) return;
        generator = await AI.embed.createPipeline('text-generation', pack, onProgress, '回答モデル');
      },
      async generate(messages, options = {}) {
        if (!generator) throw new Error('回答モデルの準備ができていません');
        const lib = await AI.embed.loadLibrary();
        let streamed = '';
        const streamer = new lib.TextStreamer(generator.tokenizer, {
          skip_prompt: true,
          skip_special_tokens: true,
          callback_function: (piece) => {
            streamed += piece;
            if (options.onToken) options.onToken(streamed);
          },
        });
        stopper = lib.InterruptableStoppingCriteria ? new lib.InterruptableStoppingCriteria() : null;
        const params = {
          max_new_tokens: options.maxTokens || 256,
          do_sample: false, // 毎回同じ答えになるように（作り話を減らす）
          repetition_penalty: 1.1,
          streamer,
        };
        if (stopper) params.stopping_criteria = stopper;
        try {
          const out = await generator(messages, params);
          const last = out && out[0] && out[0].generated_text;
          const text = Array.isArray(last) ? (last[last.length - 1] || {}).content : last;
          return String(text || streamed).trim();
        } finally {
          stopper = null;
        }
      },
      stop() {
        if (stopper) stopper.interrupt();
      },
      async unload() {
        const g = generator;
        generator = null;
        try {
          if (g && g.dispose) await g.dispose();
        } catch (_) {
          /* 降ろせなくても使わなくなる */
        }
      },
    };
  }

  AI.llm = { PACKS, transformersGenerator };
})(typeof globalThis !== 'undefined' ? globalThis : window);
