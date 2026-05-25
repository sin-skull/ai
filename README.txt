// 領収書スキャナー Prototype
// 目的：スマホブラウザで、連続撮影・一時キュー・OCR・確認保存を行う。
// 注意：カメラはHTTPS環境、または localhost で動作。file:// では基本動かない。

const els = {
  captureView: document.getElementById("captureView"),
  reviewView: document.getElementById("reviewView"),
  savedView: document.getElementById("savedView"),

  camera: document.getElementById("camera"),
  canvas: document.getElementById("captureCanvas"),
  cameraStatus: document.getElementById("cameraStatus"),

  startCameraBtn: document.getElementById("startCameraBtn"),
  captureBtn: document.getElementById("captureBtn"),
  undoBtn: document.getElementById("undoBtn"),
  clearQueueBtn: document.getElementById("clearQueueBtn"),
  reviewBtn: document.getElementById("reviewBtn"),

  manualModeBtn: document.getElementById("manualModeBtn"),
  autoModeBtn: document.getElementById("autoModeBtn"),

  queueCount: document.getElementById("queueCount"),
  queueList: document.getElementById("queueList"),

  backToCaptureBtn: document.getElementById("backToCaptureBtn"),
  reviewIndex: document.getElementById("reviewIndex"),
  reviewAlert: document.getElementById("reviewAlert"),
  reviewImage: document.getElementById("reviewImage"),
  dateInput: document.getElementById("dateInput"),
  timeInput: document.getElementById("timeInput"),
  shopInput: document.getElementById("shopInput"),
  totalInput: document.getElementById("totalInput"),
  taxInput: document.getElementById("taxInput"),
  categoryInput: document.getElementById("categoryInput"),
  itemsInput: document.getElementById("itemsInput"),
  memoInput: document.getElementById("memoInput"),
  rawTextBox: document.getElementById("rawTextBox"),

  prevReceiptBtn: document.getElementById("prevReceiptBtn"),
  nextReceiptBtn: document.getElementById("nextReceiptBtn"),
  saveReceiptBtn: document.getElementById("saveReceiptBtn"),
  discardReceiptBtn: document.getElementById("discardReceiptBtn"),

  openSavedBtn: document.getElementById("openSavedBtn"),
  backFromSavedBtn: document.getElementById("backFromSavedBtn"),
  savedList: document.getElementById("savedList"),
  savedCount: document.getElementById("savedCount"),
  exportJsonBtn: document.getElementById("exportJsonBtn"),

  toast: document.getElementById("toast"),
};

let stream = null;
let captureMode = "manual";
let queue = [];
let saved = loadSaved();
let reviewPos = 0;

let autoTimer = null;
let autoLastHash = "";
let lastFrameSample = null;
let stableSince = 0;
let autoLockedUntil = 0;

let longPressTimer = null;
let longScanActive = false;
let longScanInterval = null;
let longScanFrames = [];

const AUTO_INTERVAL_MS = 420;
const AUTO_STABLE_MS = 1000;
const DUPLICATE_THRESHOLD = 0.93;
const LONG_PRESS_MS = 520;
const LONG_SCAN_CAPTURE_MS = 650;

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    els.toast.classList.add("hidden");
  }, 1900);
}

function setView(name) {
  for (const v of [els.captureView, els.reviewView, els.savedView]) {
    v.classList.remove("active");
  }
  if (name === "capture") els.captureView.classList.add("active");
  if (name === "review") els.reviewView.classList.add("active");
  if (name === "saved") els.savedView.classList.add("active");
}

function setStatus(text) {
  els.cameraStatus.textContent = text;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("このブラウザではカメラが使えません");
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 1920 },
      },
      audio: false,
    });

    els.camera.srcObject = stream;
    await els.camera.play();
    setStatus("カメラ起動中。領収書を枠内へ");
    startAutoLoop();
  } catch (err) {
    console.error(err);
    setStatus("カメラ起動に失敗。HTTPSか権限を確認");
  }
}

function setCaptureMode(mode) {
  captureMode = mode;
  els.manualModeBtn.classList.toggle("active", mode === "manual");
  els.autoModeBtn.classList.toggle("active", mode === "auto");

  if (mode === "manual") {
    setStatus("手動モード：撮るボタンで撮影");
  } else {
    setStatus("自動モード：枠内で安定したら撮影");
  }
}

function captureFrameBlob(scale = 0.92) {
  const video = els.camera;
  const canvas = els.canvas;
  if (!video.videoWidth || !video.videoHeight) return null;

  const w = Math.floor(video.videoWidth * scale);
  const h = Math.floor(video.videoHeight * scale);
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);

  return new Promise(resolve => {
    canvas.toBlob(blob => resolve(blob), "image/jpeg", 0.86);
  });
}

async function captureReceipt({ source = "manual", ignoreDuplicate = false, frames = null } = {}) {
  if (!stream) {
    showToast("先にカメラを起動してください");
    return;
  }

  const blob = await captureFrameBlob();
  if (!blob) return;

  const hash = await makeImageHash(blob);
  const isDup = !ignoreDuplicate && isDuplicateHash(hash, autoLastHash);

  if (isDup && source === "auto") {
    setStatus("同じ領収書の可能性。自動撮影を停止中");
    URL.revokeObjectURL(URL.createObjectURL(blob));
    autoLockedUntil = Date.now() + 1800;
    return;
  }

  autoLastHash = hash;

  const item = {
    id: crypto.randomUUID(),
    mode: frames ? "longScan" : "single",
    source,
    blob,
    previewUrl: URL.createObjectURL(blob),
    frames: frames || [],
    status: "processing",
    rawText: "",
    parsed: emptyParsed(),
    alerts: [],
    createdAt: new Date().toISOString(),
  };

  queue.unshift(item);
  renderQueue();
  showToast(source === "auto" ? "自動撮影しました" : "撮影しました");

  processOCR(item);
}

async function processLongScanFrames(frames) {
  if (!frames.length) {
    showToast("長尺スキャン画像がありません");
    return;
  }

  const cover = frames[0].blob;
  const item = {
    id: crypto.randomUUID(),
    mode: "longScan",
    source: "longPress",
    blob: cover,
    previewUrl: URL.createObjectURL(cover),
    frames,
    status: "processing",
    rawText: "",
    parsed: emptyParsed(),
    alerts: [],
    createdAt: new Date().toISOString(),
  };

  queue.unshift(item);
  renderQueue();
  showToast(`${frames.length}枚を1件として解析します`);

  processOCR(item);
}

async function processOCR(item) {
  renderQueue();

  try {
    if (!window.Tesseract) {
      throw new Error("Tesseract.js が読み込まれていません");
    }

    let texts = [];

    if (item.mode === "longScan" && item.frames?.length) {
      for (const frame of item.frames) {
        const result = await Tesseract.recognize(frame.blob, "jpn+eng");
        texts.push(result.data.text || "");
      }
    } else {
      const result = await Tesseract.recognize(item.blob, "jpn+eng");
      texts.push(result.data.text || "");
    }

    item.rawText = mergeOCRTexts(texts);
    item.parsed = parseReceiptText(item.rawText);
    item.alerts = buildAlerts(item.parsed);
    item.status = item.alerts.length ? "needsReview" : "ok";
  } catch (err) {
    console.error(err);
    item.status = "failed";
    item.alerts = ["読み取りできませんでした"];
    item.parsed = emptyParsed();
    item.rawText = "";
  }

  renderQueue();
}

function emptyParsed() {
  return {
    shop: "",
    date: "",
    time: "",
    items: [],
    tax: "",
    total: "",
    category: "",
    categoryCandidates: [],
  };
}

function buildAlerts(parsed) {
  const alerts = [];
  if (!parsed.shop) alerts.push("店名不明");
  if (!parsed.date) alerts.push("日付不明");
  if (!parsed.total) alerts.push("合計金額不明");
  if (!parsed.category) alerts.push("区分未判定");
  return alerts;
}

function mergeOCRTexts(texts) {
  const lines = [];
  const seen = new Set();

  texts.join("\n")
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .forEach(line => {
      const key = line.replace(/\s+/g, "");
      if (!seen.has(key)) {
        seen.add(key);
        lines.push(line);
      }
    });

  return lines.join("\n");
}

function parseReceiptText(text) {
  const lines = text
    .split(/\n+/)
    .map(v => v.trim())
    .filter(Boolean);

  const joined = lines.join("\n");
  const parsed = emptyParsed();

  parsed.shop = detectShop(lines);
  const dt = detectDateTime(joined);
  parsed.date = dt.date;
  parsed.time = dt.time;
  parsed.total = detectTotal(lines);
  parsed.tax = detectTax(lines);
  parsed.items = detectItems(lines);
  const category = detectCategory(joined, parsed.shop);
  parsed.category = category.category;
  parsed.categoryCandidates = category.candidates;

  return parsed;
}

function detectShop(lines) {
  const ignore = /領収|レシート|合計|小計|税込|税額|TEL|電話|登録番号|No\.|お預|釣|現金|クレジット/i;
  for (const line of lines.slice(0, 8)) {
    if (line.length >= 3 && !ignore.test(line) && !looksLikeOnlyNumber(line)) {
      return cleanText(line);
    }
  }
  return "";
}

function detectDateTime(text) {
  let date = "";
  let time = "";

  const dateMatch =
    text.match(/(20\d{2})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/) ||
    text.match(/(\d{2})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/);

  if (dateMatch) {
    let y = dateMatch[1];
    if (y.length === 2) y = "20" + y;
    const m = dateMatch[2].padStart(2, "0");
    const d = dateMatch[3].padStart(2, "0");
    date = `${y}-${m}-${d}`;
  }

  const timeMatch = text.match(/(\d{1,2})[:：](\d{2})/);
  if (timeMatch) {
    time = `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`;
  }

  return { date, time };
}

function detectTotal(lines) {
  const priority = /(合計|総合計|計|お買上|税込合計|クレジット計|現計)/;
  const avoid = /(小計|税|税込|消費税|お預|預り|釣|おつり|ポイント)/;

  for (const line of [...lines].reverse()) {
    if (priority.test(line) && !avoid.test(line.replace(/税込合計/, ""))) {
      const n = lastMoneyNumber(line);
      if (n) return n;
    }
  }

  // 最終手段：下部の大きそうな数字
  const candidates = [];
  for (const line of lines.slice(-10)) {
    const n = lastMoneyNumber(line);
    if (n) candidates.push(n);
  }
  return candidates.sort((a, b) => b - a)[0] || "";
}

function detectTax(lines) {
  const taxWords = /(消費税|税額|税込|内税)/;
  for (const line of lines) {
    if (taxWords.test(line)) {
      const n = lastMoneyNumber(line);
      if (n) return n;
    }
  }
  return "";
}

function detectItems(lines) {
  const items = [];
  const skip = /(合計|小計|税込|消費税|税額|お預|釣|TEL|電話|登録番号|領収|レシート|No\.|クレジット|現金|ポイント)/i;

  for (const line of lines) {
    if (skip.test(line)) continue;
    const n = lastMoneyNumber(line);
    if (!n) continue;

    const name = cleanText(line.replace(/[¥￥]?\s*[\d,]+円?$/, "").trim());
    if (name && name.length <= 28 && !looksLikeOnlyNumber(name)) {
      items.push({ name, price: n });
    }
    if (items.length >= 8) break;
  }

  return items;
}

function detectCategory(text, shop) {
  const target = `${shop}\n${text}`.toLowerCase();

  const rules = [
    { words: ["jr", "東急", "小田急", "東京メトロ", "タクシー", "suica", "pasmo", "駅"], category: "交通費", candidates: ["交通費"] },
    { words: ["スターバックス", "ドトール", "タリーズ", "カフェ", "喫茶"], category: "会議費", candidates: ["会議費", "接待費", "食費"] },
    { words: ["焼肉", "居酒屋", "寿司", "レストラン", "酒場", "食堂"], category: "接待費", candidates: ["接待費", "会議費", "食費", "私的支出"] },
    { words: ["セブン", "ファミリーマート", "ローソン", "ミニストップ"], category: "消耗品費", candidates: ["消耗品費", "食費", "雑費"] },
    { words: ["ヨドバシ", "ビックカメラ", "ヤマダ", "ノジマ", "ケーズ"], category: "備品", candidates: ["備品", "消耗品費"] },
    { words: ["郵便", "ヤマト", "佐川"], category: "通信費", candidates: ["通信費", "荷造運賃"] },
  ];

  for (const rule of rules) {
    if (rule.words.some(w => target.includes(w.toLowerCase()))) {
      return { category: rule.category, candidates: rule.candidates };
    }
  }

  return { category: "", candidates: [] };
}

function lastMoneyNumber(line) {
  const matches = [...line.matchAll(/(?:[¥￥]\s*)?(\d{1,3}(?:,\d{3})+|\d{2,7})\s*円?/g)];
  if (!matches.length) return "";
  const raw = matches[matches.length - 1][1].replace(/,/g, "");
  const num = Number(raw);
  if (!Number.isFinite(num)) return "";
  return num;
}

function looksLikeOnlyNumber(text) {
  return /^[\d\s,¥￥円:：\/\-.]+$/.test(text);
}

function cleanText(text) {
  return text.replace(/\s+/g, " ").replace(/[|｜]/g, "").trim();
}

function renderQueue() {
  els.queueCount.textContent = `${queue.length}件`;

  if (!queue.length) {
    els.queueList.className = "queue-list empty";
    els.queueList.textContent = "まだ撮影されていません";
    return;
  }

  els.queueList.className = "queue-list";
  els.queueList.innerHTML = "";

  queue.forEach((item, index) => {
    const div = document.createElement("div");
    div.className = "queue-item";

    const img = document.createElement("img");
    img.className = "thumb";
    img.src = item.previewUrl;

    const body = document.createElement("div");

    const status = document.createElement("div");
    status.className = "status-line";
    status.textContent = statusLabel(item);

    const pre = document.createElement("div");
    pre.className = "preview-text";
    pre.textContent = buildThinPreview(item);

    body.append(status, pre);
    div.append(img, body);
    div.addEventListener("click", () => {
      reviewPos = index;
      openReview();
    });

    els.queueList.appendChild(div);
  });
}

function statusLabel(item) {
  if (item.status === "processing") return "読み取り中...";
  if (item.status === "failed") return "⚠ 読み取りできませんでした";
  if (item.status === "needsReview") return "⚠ 確認が必要";
  if (item.status === "ok") return "読み取り結果プレビュー";
  return "撮影済み";
}

function buildThinPreview(item) {
  const p = item.parsed || emptyParsed();

  if (item.status === "processing") {
    return "----\n解析中\n\n----\n計 ----";
  }

  if (item.status === "failed") {
    return "⚠ 読み取り確認が必要\n\n店名：不明\n日時：----\n品目：----\n税込：----\n計：----";
  }

  const shop = p.shop || "⚠ 店名不明";
  const datetime = [
    p.date ? p.date.replaceAll("-", "/") : "----",
    p.time || ""
  ].filter(Boolean).join(" ");

  const itemLines = p.items.length
    ? p.items.slice(0, 3).map(it => `${it.name || "----"}　${it.price || "----"}`)
    : ["品目：----"];

  if (p.items.length > 3) {
    itemLines.push(`ほか ${p.items.length - 3}件`);
  }

  return [
    shop,
    datetime || "日時：----",
    "",
    ...itemLines,
    "",
    `税込　${p.tax || "----"}`,
    `計　　${p.total || "----"}`
  ].join("\n");
}

function undoLastReceipt() {
  const last = queue.shift();
  if (!last) {
    showToast("取消する領収書がありません");
    return;
  }

  revokeReceipt(last);
  renderQueue();
  showToast("直前の領収書を取り消しました");
}

function clearQueue() {
  queue.forEach(revokeReceipt);
  queue = [];
  renderQueue();
  showToast("一時キューを破棄しました");
}

function revokeReceipt(item) {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  if (item.frames) {
    item.frames.forEach(frame => {
      if (frame.previewUrl) URL.revokeObjectURL(frame.previewUrl);
    });
  }
}

function openReview() {
  if (!queue.length) {
    showToast("確認する領収書がありません");
    return;
  }
  if (reviewPos >= queue.length) reviewPos = 0;
  setView("review");
  renderReview();
}

function renderReview() {
  const item = queue[reviewPos];
  if (!item) {
    setView("capture");
    renderQueue();
    return;
  }

  const p = item.parsed || emptyParsed();
  els.reviewIndex.textContent = `${reviewPos + 1} / ${queue.length}`;
  els.reviewImage.src = item.previewUrl;

  els.dateInput.value = p.date || "";
  els.timeInput.value = p.time || "";
  els.shopInput.value = p.shop || "";
  els.totalInput.value = p.total || "";
  els.taxInput.value = p.tax || "";
  els.categoryInput.value = p.category || "";
  els.itemsInput.value = p.items.map(it => `${it.name || "----"} ${it.price || "----"}`).join("\n");
  els.memoInput.value = "";
  els.rawTextBox.textContent = item.rawText || "----";

  if (item.alerts?.length) {
    els.reviewAlert.classList.remove("hidden");
    els.reviewAlert.textContent = [
      "この領収書は確認が必要です",
      "",
      ...item.alerts.map(a => `・${a}`)
    ].join("\n");
  } else {
    els.reviewAlert.classList.add("hidden");
    els.reviewAlert.textContent = "";
  }
}

function collectReviewValues() {
  return {
    date: els.dateInput.value,
    time: els.timeInput.value,
    shop: els.shopInput.value.trim(),
    total: Number(els.totalInput.value) || "",
    tax: Number(els.taxInput.value) || "",
    category: els.categoryInput.value,
    itemsText: els.itemsInput.value.trim(),
    memo: els.memoInput.value.trim(),
  };
}

function saveCurrentReceipt() {
  const item = queue[reviewPos];
  if (!item) return;

  const v = collectReviewValues();
  const record = {
    id: crypto.randomUUID(),
    date: v.date,
    time: v.time,
    shop: v.shop || "不明",
    total: v.total,
    tax: v.tax,
    category: v.category || "未分類",
    itemsText: v.itemsText,
    memo: v.memo,
    rawText: item.rawText || "",
    createdAt: new Date().toISOString(),
  };

  saved.unshift(record);
  saveSaved(saved);

  revokeReceipt(item);
  queue.splice(reviewPos, 1);

  if (reviewPos >= queue.length) reviewPos = Math.max(0, queue.length - 1);

  renderQueue();
  showToast("保存しました");

  if (queue.length) {
    renderReview();
  } else {
    setView("capture");
  }
}

function discardCurrentReceipt() {
  const item = queue[reviewPos];
  if (!item) return;

  revokeReceipt(item);
  queue.splice(reviewPos, 1);
  if (reviewPos >= queue.length) reviewPos = Math.max(0, queue.length - 1);

  renderQueue();
  showToast("破棄しました");

  if (queue.length) {
    renderReview();
  } else {
    setView("capture");
  }
}

function moveReview(delta) {
  if (!queue.length) return;
  reviewPos = (reviewPos + delta + queue.length) % queue.length;
  renderReview();
}

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem("receiptScannerRecords") || "[]");
  } catch {
    return [];
  }
}

function saveSaved(records) {
  localStorage.setItem("receiptScannerRecords", JSON.stringify(records));
}

function renderSaved() {
  els.savedCount.textContent = `${saved.length}件`;
  els.savedList.innerHTML = "";

  if (!saved.length) {
    els.savedList.innerHTML = `<div class="queue-list empty">保存済みはありません</div>`;
    return;
  }

  saved.forEach(record => {
    const div = document.createElement("div");
    div.className = "saved-item";
    div.innerHTML = `
      <strong>${escapeHtml(record.shop)} / ${record.total || "----"}円</strong>
      <div class="saved-meta">
        ${escapeHtml(record.date || "日付不明")} ${escapeHtml(record.time || "")}<br>
        ${escapeHtml(record.category || "未分類")}<br>
        ${escapeHtml(record.memo || "")}
      </div>
    `;
    els.savedList.appendChild(div);
  });
}

function exportJson() {
  const blob = new Blob([JSON.stringify(saved, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "receipts.json";
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[m]));
}

// 自動撮影：本格的な物体検出ではなく、簡易的な安定・白領域・重複チェック。
// Ver.1では「それっぽく動く」ための安全寄り実装。
function startAutoLoop() {
  clearInterval(autoTimer);
  autoTimer = setInterval(autoCheckFrame, AUTO_INTERVAL_MS);
}

function autoCheckFrame() {
  if (captureMode !== "auto") return;
  if (!stream || Date.now() < autoLockedUntil) return;
  if (!els.camera.videoWidth) return;

  const sample = sampleGuideArea();
  if (!sample) return;

  const whiteOk = sample.whiteRatio > 0.18;
  const stable = lastFrameSample ? frameDiff(sample.data, lastFrameSample.data) < 12 : false;

  if (whiteOk && stable) {
    if (!stableSince) stableSince = Date.now();

    const elapsed = Date.now() - stableSince;
    setStatus(`全体候補を検出。そのまま... ${Math.ceil((AUTO_STABLE_MS - elapsed) / 1000)}`);

    if (elapsed >= AUTO_STABLE_MS) {
      stableSince = 0;
      captureReceipt({ source: "auto", ignoreDuplicate: false });
      autoLockedUntil = Date.now() + 1400;
    }
  } else {
    stableSince = 0;
    setStatus(captureMode === "auto" ? "自動モード：領収書を枠内へ" : "手動モード");
  }

  lastFrameSample = sample;
}

function sampleGuideArea() {
  const video = els.camera;
  const c = document.createElement("canvas");
  const w = 80;
  const h = 120;
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });

  const sx = video.videoWidth * 0.18;
  const sy = video.videoHeight * 0.10;
  const sw = video.videoWidth * 0.64;
  const sh = video.videoHeight * 0.76;

  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  let white = 0;

  for (let i = 0; i < data.length; i += 4) {
    const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
    if (avg > 178) white++;
  }

  return {
    data,
    whiteRatio: white / (data.length / 4),
  };
}

function frameDiff(a, b) {
  let total = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 16) {
    total += Math.abs(a[i] - b[i]);
    count++;
  }
  return total / count;
}

async function makeImageHash(blob) {
  const bitmap = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  const size = 16;
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;

  let values = [];
  for (let i = 0; i < data.length; i += 4) {
    values.push((data[i] + data[i + 1] + data[i + 2]) / 3);
  }
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return values.map(v => v > avg ? "1" : "0").join("");
}

function isDuplicateHash(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let same = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) same++;
  }
  return same / a.length >= DUPLICATE_THRESHOLD;
}

// 長押しスキャン
function setupLongPress() {
  const start = () => {
    longPressTimer = setTimeout(() => {
      beginLongScan();
    }, LONG_PRESS_MS);
  };

  const end = () => {
    clearTimeout(longPressTimer);
    if (longScanActive) {
      finishLongScan();
    }
  };

  els.captureBtn.addEventListener("touchstart", start, { passive: true });
  els.captureBtn.addEventListener("touchend", end);
  els.captureBtn.addEventListener("mousedown", start);
  window.addEventListener("mouseup", end);
}

async function beginLongScan() {
  if (!stream) {
    showToast("先にカメラを起動してください");
    return;
  }

  longScanActive = true;
  longScanFrames = [];
  setStatus("長尺スキャン中：上から下へなぞってください");

  longScanInterval = setInterval(async () => {
    const blob = await captureFrameBlob(0.72);
    if (!blob) return;

    longScanFrames.push({
      blob,
      previewUrl: URL.createObjectURL(blob),
      capturedAt: Date.now(),
    });

    setStatus(`長尺スキャン中：${longScanFrames.length}枚取得`);
  }, LONG_SCAN_CAPTURE_MS);
}

function finishLongScan() {
  longScanActive = false;
  clearInterval(longScanInterval);
  setStatus("長尺スキャン終了。解析します");

  const frames = longScanFrames.slice();
  longScanFrames = [];

  if (frames.length < 2) {
    frames.forEach(f => URL.revokeObjectURL(f.previewUrl));
    showToast("長押しが短すぎました");
    return;
  }

  processLongScanFrames(frames);
}

// Events
els.startCameraBtn.addEventListener("click", startCamera);
els.captureBtn.addEventListener("click", () => {
  if (!longScanActive) captureReceipt({ source: "manual", ignoreDuplicate: true });
});
els.undoBtn.addEventListener("click", undoLastReceipt);
els.clearQueueBtn.addEventListener("click", clearQueue);
els.reviewBtn.addEventListener("click", openReview);

els.manualModeBtn.addEventListener("click", () => setCaptureMode("manual"));
els.autoModeBtn.addEventListener("click", () => setCaptureMode("auto"));

els.backToCaptureBtn.addEventListener("click", () => setView("capture"));
els.prevReceiptBtn.addEventListener("click", () => moveReview(1));
els.nextReceiptBtn.addEventListener("click", () => moveReview(-1));
els.saveReceiptBtn.addEventListener("click", saveCurrentReceipt);
els.discardReceiptBtn.addEventListener("click", discardCurrentReceipt);

els.openSavedBtn.addEventListener("click", () => {
  renderSaved();
  setView("saved");
});
els.backFromSavedBtn.addEventListener("click", () => setView("capture"));
els.exportJsonBtn.addEventListener("click", exportJson);

setupLongPress();
renderQueue();
renderSaved();
setCaptureMode("manual");
