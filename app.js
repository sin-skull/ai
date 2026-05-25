* {
  box-sizing: border-box;
}

:root {
  --bg: #0b0e14;
  --panel: #151a24;
  --panel2: #1d2430;
  --text: #f4f7fb;
  --muted: #97a1b3;
  --line: rgba(255,255,255,.10);
  --accent: #63d6a8;
  --danger: #ff6b6b;
  --warning: #ffd166;
}

html, body {
  margin: 0;
  min-height: 100%;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif;
}

button, input, select, textarea {
  font: inherit;
}

button {
  border: 0;
  cursor: pointer;
}

.app {
  width: min(100vw, 480px);
  min-height: 100vh;
  margin: 0 auto;
  background: linear-gradient(180deg, #101522 0%, #080b11 100%);
  padding: env(safe-area-inset-top) 14px calc(env(safe-area-inset-bottom) + 16px);
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 0 12px;
}

h1 {
  margin: 0;
  font-size: 20px;
  line-height: 1.2;
}

p {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.view {
  display: none;
}

.view.active {
  display: block;
}

.mode-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 10px;
}

.mode-btn,
.main-btn,
.ghost-btn,
.danger-btn {
  min-height: 44px;
  border-radius: 14px;
  padding: 0 14px;
  color: var(--text);
}

.mode-btn {
  background: var(--panel2);
  border: 1px solid var(--line);
  color: var(--muted);
}

.mode-btn.active {
  background: rgba(99,214,168,.14);
  color: var(--accent);
  border-color: rgba(99,214,168,.45);
}

.main-btn {
  background: var(--accent);
  color: #07100c;
  font-weight: 700;
}

.ghost-btn {
  background: var(--panel2);
  border: 1px solid var(--line);
}

.danger-btn {
  background: rgba(255,107,107,.15);
  border: 1px solid rgba(255,107,107,.35);
  color: #ff9a9a;
}

.camera-panel {
  position: relative;
  overflow: hidden;
  border-radius: 24px;
  background: #05070a;
  height: 58vh;
  min-height: 380px;
  border: 1px solid var(--line);
}

#camera {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.guide-box {
  position: absolute;
  inset: 8% 10%;
  border: 2px dashed rgba(255,255,255,.65);
  border-radius: 18px;
  pointer-events: none;
  display: grid;
  place-items: center;
  color: rgba(255,255,255,.55);
  font-size: 13px;
  letter-spacing: .08em;
}

.camera-status {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  min-height: 38px;
  border-radius: 14px;
  background: rgba(0,0,0,.55);
  backdrop-filter: blur(8px);
  color: var(--text);
  display: flex;
  align-items: center;
  padding: 0 12px;
  font-size: 13px;
}

.hidden {
  display: none !important;
}

.controls {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
  margin-top: 10px;
}

.longscan-hint {
  color: var(--muted);
  font-size: 12px;
  text-align: center;
  padding: 8px 0 2px;
}

.queue-panel {
  margin-top: 14px;
  padding: 14px;
  border-radius: 22px;
  background: rgba(21,26,36,.84);
  border: 1px solid var(--line);
}

.section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.section-head h2 {
  margin: 0;
  font-size: 16px;
}

.section-head span {
  color: var(--muted);
  font-size: 12px;
}

.queue-list.empty {
  color: var(--muted);
  font-size: 13px;
  padding: 20px 0;
  text-align: center;
}

.queue-item {
  display: grid;
  grid-template-columns: 62px 1fr;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid var(--line);
}

.queue-item:first-child {
  border-top: 0;
}

.thumb {
  width: 62px;
  height: 82px;
  object-fit: cover;
  border-radius: 10px;
  background: #000;
  opacity: .78;
}

.preview-text {
  opacity: .64;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
}

.status-line {
  color: var(--warning);
  font-size: 12px;
  margin-bottom: 4px;
}

.bottom-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 12px;
}

.wide {
  width: 100%;
}

.review-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.alert-box {
  background: rgba(255,209,102,.14);
  border: 1px solid rgba(255,209,102,.35);
  color: #ffe2a1;
  border-radius: 16px;
  padding: 12px;
  font-size: 13px;
  margin-bottom: 10px;
  white-space: pre-wrap;
}

.review-card {
  padding: 14px;
  border-radius: 22px;
  background: var(--panel);
  border: 1px solid var(--line);
}

#reviewImage {
  width: 100%;
  max-height: 250px;
  object-fit: contain;
  background: #05070a;
  border-radius: 16px;
  margin-bottom: 12px;
}

label {
  display: block;
  color: var(--muted);
  font-size: 12px;
  margin: 10px 0;
}

input, select, textarea {
  width: 100%;
  margin-top: 6px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: #0c111a;
  color: var(--text);
  padding: 12px;
  outline: none;
}

textarea {
  resize: vertical;
}

details {
  margin-top: 12px;
  color: var(--muted);
}

pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: #080b11;
  padding: 12px;
  border-radius: 12px;
  color: var(--muted);
}

.review-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 12px;
}

.saved-item {
  padding: 12px 0;
  border-top: 1px solid var(--line);
}

.saved-item:first-child {
  border-top: 0;
}

.saved-item strong {
  display: block;
  margin-bottom: 4px;
}

.saved-meta {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.toast {
  position: fixed;
  left: 50%;
  bottom: calc(env(safe-area-inset-bottom) + 22px);
  transform: translateX(-50%);
  width: min(88vw, 420px);
  background: rgba(0,0,0,.82);
  color: white;
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 12px 14px;
  text-align: center;
  z-index: 20;
}
