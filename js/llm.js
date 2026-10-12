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
  const GGUF_HOSTS = ['huggingface.co（モデル）'];

  // この部品の置き場所。同梱した実行用ファイル（vendor/）の場所を、ここから決める（アプリでも試験室でも同じ場所を指す）
  const SCRIPT_URL = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || (typeof location !== 'undefined' ? location.href : '');
  const vendorUrl = (path) => new URL(`../vendor/${path}`, SCRIPT_URL).href;

  // ---- wllama（llama.cpp の Web 版）で動かすモデル（GGUF）----
  // モデルのファイルは端末の保存領域（OPFS）に置き、少しずつ読む。丸ごと1度にメモリへ写さない。
  // layers は層の数（「分担」のとき、半分をGPUに置く）。容量は Hugging Face で確認したファイルの大きさ。
  const GGUF_PACKS = [
    {
      id: 'lfm2-350m-gguf',
      label: 'LFM2 350M（4bit・日本語対応）',
      kind: 'gguf',
      url: 'https://huggingface.co/LiquidAI/LFM2-350M-GGUF/resolve/main/LFM2-350M-Q4_K_M.gguf',
      approxMB: 229,
      layers: 16,
      version: 1,
      license: 'LFM Open License v1.0（年間売上が一定額未満なら商用も可。配布前に条件を確認する）',
      note: '小さく、日本語に対応。まず試す候補',
      hosts: GGUF_HOSTS,
    },
    {
      id: 'gemma3-270m-gguf',
      label: 'Gemma 3 270M（8bit）',
      kind: 'gguf',
      url: 'https://huggingface.co/ggml-org/gemma-3-270m-it-GGUF/resolve/main/gemma-3-270m-it-Q8_0.gguf',
      approxMB: 292,
      layers: 18,
      version: 1,
      license: 'Gemma Terms of Use（利用条件あり）',
      note: 'とても小さい。日本語の力は実測で確かめる',
      hosts: GGUF_HOSTS,
    },
    {
      id: 'qwen2.5-0.5b-gguf',
      label: 'Qwen2.5 0.5B（4bit）',
      kind: 'gguf',
      url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_0.gguf',
      approxMB: 429,
      layers: 24,
      version: 1,
      license: 'Apache-2.0',
      note: '構造が素直（Transformerだけ）。LFM2と比べる用',
      hosts: GGUF_HOSTS,
    },
    {
      id: 'lfm2-700m-gguf',
      label: 'LFM2 700M（4bit・日本語対応）',
      kind: 'gguf',
      url: 'https://huggingface.co/LiquidAI/LFM2-700M-GGUF/resolve/main/LFM2-700M-Q4_K_M.gguf',
      approxMB: 469,
      layers: 16,
      version: 1,
      license: 'LFM Open License v1.0（年間売上が一定額未満なら商用も可。配布前に条件を確認する）',
      note: '350Mより賢いが2倍重い。350Mが安定したら試す',
      hosts: GGUF_HOSTS,
    },
  ];
  // 配管テスト用：意味のある答えは出さない極小モデル（英小文字だけを返す）。試験室とテストで使う
  const TINY_PACK = { id: 'tiny-test', label: '配管テスト用（極小）', kind: 'gguf', url: vendorUrl('tiny-test.gguf?v=2'), approxMB: 0.5, layers: 2, version: 1, license: '自作', raw: true, hosts: [] };

  // 動かし方：CPUだけ／分担（半分の層をGPU）／GPU（全部）
  const ENGINES = {
    cpu: { label: 'CPUだけ', gpuLayers: () => 0 },
    split: { label: '分担（半分をGPU）', gpuLayers: (pack) => Math.ceil(pack.layers / 2) },
    gpu: { label: 'GPU', gpuLayers: () => 999 },
  };
  const ENGINE_ORDER = ['gpu', 'split', 'cpu']; // 落ちたときは右へ（軽い方へ）

  let wllamaModule = null;
  function loadWllama() {
    // ファイルを直接開いたとき（file://）は、モジュールを読み込めない（ブラウザの決まり）
    if (typeof location !== 'undefined' && location.protocol === 'file:') return Promise.reject(new Error('この開き方（file://）では、wllama を使えません'));
    if (!wllamaModule) wllamaModule = import(vendorUrl('wllama-3.6.1/index.js')).catch((e) => ((wllamaModule = null), Promise.reject(e)));
    return wllamaModule;
  }
  // wllama の互換版（Asyncify）が要るか：JSPI と 64bit メモリの両方が無ければ互換版（wllama と同じ判定）
  function needCompat() {
    const jspi = !!(typeof WebAssembly !== 'undefined' && WebAssembly.Suspending);
    let mem64 = false;
    try {
      new WebAssembly.Memory({ address: 'i64', initial: 1n });
      mem64 = true;
    } catch (_) {
      mem64 = false;
    }
    return !jspi || !mem64;
  }
  // 実行用ファイル（wasm）は、ページ側で取得して blob にしてから渡す。
  // 計算を受け持つ worker が自分で取りに行くと、Service Worker を通らず、オフラインで読めないことがあるため。
  let assetsPromise = null;
  function wllamaAssets() {
    if (!assetsPromise) {
      assetsPromise = (async () => {
        const blobUrl = async (url) => {
          const r = await fetch(url);
          if (!r.ok) throw new Error(`実行用ファイルを読めませんでした（${r.status}）`);
          return URL.createObjectURL(await r.blob());
        };
        if (needCompat()) {
          const code = await (await fetch(vendorUrl('wllama-compat-3.6.1/wasm/wllama.js'))).text();
          return { compat: true, paths: { default: vendorUrl('wllama-3.6.1/wasm/wllama.wasm') }, compatRes: { worker: { code }, wasm: await blobUrl(vendorUrl('wllama-compat-3.6.1/wasm/wllama.wasm')) } };
        }
        return { compat: false, paths: { default: await blobUrl(vendorUrl('wllama-3.6.1/wasm/wllama.wasm')) }, compatRes: null };
      })().catch((e) => {
        assetsPromise = null;
        throw e;
      });
    }
    return assetsPromise;
  }
  // assets を渡さないとき（保存済みモデルの確認・削除だけ）は、計算はしないので URL のままでよい
  function newWllama(mod, assets) {
    const w = new mod.Wllama(assets ? assets.paths : { default: vendorUrl('wllama-3.6.1/wasm/wllama.wasm') }, {
      logger: mod.LoggerWithoutDebug,
      allowOffline: true,
      parallelDownloads: 2,
      suppressNativeLog: true,
    });
    // 互換版も、外部のCDNではなく同梱分を使う
    w.setCompat(assets && assets.compatRes ? assets.compatRes : null);
    return w;
  }

  // 保存済みのモデル（wllama の保存領域）
  async function ggufSaved(pack) {
    const mod = await loadWllama();
    const w = newWllama(mod);
    const models = await w.modelManager.getModels();
    const m = models.find((x) => x.url === pack.url);
    return m ? { saved: true, bytes: m.size } : { saved: false, bytes: 0 };
  }
  async function ggufRemove(pack) {
    const mod = await loadWllama();
    const w = newWllama(mod);
    const models = await w.modelManager.getModels();
    for (const m of models.filter((x) => x.url === pack.url)) await m.remove();
  }

  // diag：段階の記録（AI.diag.create の戻り値）。無くても動く
  // offline()：true ならダウンロードしない（保存分が無ければエラー）
  function wllamaGenerator(pack, { engine = 'cpu', diag = null, nCtx = 3072, offline = () => false } = {}) {
    let wllama = null;
    let abort = null;
    const gpuLayers = (ENGINES[engine] || ENGINES.cpu).gpuLayers(pack);
    const info = (extra) => ({ engine, model: pack.id, ...extra });
    const step = (stage, extra, fn) => (diag ? diag.step(stage, info(extra), fn) : fn());
    return {
      id: `${pack.id}@${engine}`,
      version: pack.version,
      pack,
      engine,
      get ready() {
        return wllama !== null;
      },
      async prepare(onProgress) {
        if (wllama) return;
        const mod = await loadWllama();
        const w = newWllama(mod, await wllamaAssets());
        try {
          const model = await step('download', {}, async () => {
            const saved = (await w.modelManager.getModels()).find((x) => x.url === pack.url);
            if (saved) return saved;
            if (offline()) throw new Error('オフラインモードなので、モデルをダウンロードしません（この端末に保存されていません）');
            return w.modelManager.downloadModel({ url: pack.url }, { progressCallback: ({ loaded, total }) => onProgress && onProgress({ label: pack.id, loaded, total }) });
          });
          const blobs = await model.open();
          await step('init', {}, () => w.loadModel(blobs, { n_gpu_layers: gpuLayers, n_ctx: nCtx, n_threads: 1 }));
          await step('first', {}, () => w.createCompletion({ prompt: 'a', max_tokens: 1, temperature: 0 }));
          wllama = w;
        } catch (error) {
          try {
            await w.exit();
          } catch (_) {
            /* 片付けの失敗は無視 */
          }
          throw error;
        }
      },
      // 資料の読み込み（最初の文字が出るまで）と、回答の生成（そのあと）を分けて記録する
      async generate(messages, options = {}) {
        if (!wllama) throw new Error('回答モデルの準備ができていません');
        abort = new AbortController();
        const chars = messages.reduce((n, m) => n + String(m.content || '').length, 0);
        let text = '';
        let generating = false;
        if (diag) await diag.begin('read', info({ chars, ...(options.stageInfo || {}) }));
        try {
          const common = { max_tokens: options.maxTokens || 256, temperature: 0, stream: true, abortSignal: abort.signal };
          const stream = pack.raw
            ? await wllama.createCompletion({ prompt: messages.map((m) => m.content).join('\n'), ...common })
            : await wllama.createChatCompletion({ messages, ...common });
          for await (const chunk of stream) {
            const c = chunk.choices && chunk.choices[0];
            const piece = (c && (pack.raw ? c.text : c.delta && c.delta.content)) || '';
            if (!piece) continue;
            if (!generating) {
              generating = true;
              if (diag) {
                await diag.end();
                await diag.begin('generate', info({ chars, ...(options.stageInfo || {}) }));
              }
            }
            text += piece;
            if (options.onToken) options.onToken(text);
          }
          if (diag) await diag.end({ chars: text.length });
        } catch (error) {
          const stopped = error && (error.name === 'AbortError' || error.name === 'WllamaAbortError' || (abort && abort.signal.aborted));
          if (diag) {
            if (stopped) await diag.end();
            else await diag.fail(error);
          }
          if (!stopped) throw error;
        } finally {
          abort = null;
        }
        return text.trim();
      },
      stop() {
        if (abort) abort.abort();
      },
      async unload() {
        const w = wllama;
        wllama = null;
        if (w) {
          try {
            await w.exit();
          } catch (_) {
            /* 降ろせなくても使わなくなる */
          }
        }
      },
    };
  }

  // 旧方式：Transformers.js（ONNX）で動かすモデル
  const PACKS = [
    {
      id: 'lfm2-350m',
      label: '日本語対応（LFM2 350M）',
      model: 'onnx-community/LFM2-350M-ONNX',
      dtype: 'q8',
      approxMB: 510,
      version: 1,
      license: 'LFM Open License v1.0（年間売上が一定額未満なら商用も可。配布前に条件を確認する）',
      note: '日本語に対応した小型モデル。4bit版はこのアプリの実行環境で動かない（GatherBlockQuantized 未対応）ことが実機で分かったので、8bit版を使う（実機は未確認）',
      hosts: HOSTS,
    },
    {
      id: 'lfm2-350m-gpu',
      label: '日本語対応・GPU版（LFM2 350M）',
      model: 'onnx-community/LFM2-350M-ONNX',
      dtype: 'q4',
      device: 'webgpu',
      requiresWebGPU: true,
      approxMB: 300,
      version: 1,
      license: 'LFM Open License v1.0（年間売上が一定額未満なら商用も可。配布前に条件を確認する）',
      note: 'GPUで動かす試験的な版。メモリの使い方が違うので、CPU版が落ちる端末で動く可能性がある（実機は未確認）。GPUに対応していない端末では選べない',
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

  for (const p of PACKS) p.kind = 'onnx';
  const ALL = GGUF_PACKS.concat(PACKS);
  // 選べるモデル（GPU が無い端末では、GPU 専用の旧方式は出さない）
  const available = () => ALL.filter((p) => !p.requiresWebGPU || (typeof navigator !== 'undefined' && !!navigator.gpu));
  // 作り方を1か所にまとめる（アプリとテストはここを通す。テストでは差し替える）
  function createGenerator(pack, options = {}) {
    if (pack.kind === 'gguf') return AI.llm.wllamaGenerator(pack, options);
    return AI.llm.transformersGenerator(pack);
  }

  AI.llm = { needCompat, wllamaAssets, available, PACKS: ALL, GGUF_PACKS, ONNX_PACKS: PACKS, TINY_PACK, ENGINES, ENGINE_ORDER, transformersGenerator, wllamaGenerator, createGenerator, loadWllama, ggufSaved, ggufRemove, vendorUrl };
})(typeof globalThis !== 'undefined' ? globalThis : window);
