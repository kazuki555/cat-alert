// 猫アラート：カメラ側と見る側で共通の部品（保存・時刻の書き方・記録・画面スリープ防止）
export const $ = (s) => document.querySelector(s);
export const $$ = (s) => Array.from(document.querySelectorAll(s));

const LOG_MAX = 30;
export const STORE = 'catAlert.';

// ---------- 保存 ----------
export function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
export function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); return true; } catch { return false; }
}
export const storageOk = (() => {
  try {
    localStorage.setItem(STORE + 'probe', '1');
    const ok = localStorage.getItem(STORE + 'probe') === '1';
    localStorage.removeItem(STORE + 'probe');
    return ok;
  } catch { return false; }
})();

// ---------- 合言葉（トピック名） ----------
export function isValidTopic(t) { return typeof t === 'string' && /^[-_A-Za-z0-9]{1,64}$/.test(t); }
export function randomTopic() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32文字（見間違えやすい l・o・0・1 を除外）
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return 'neko-' + Array.from(bytes, (b) => chars[b % 32]).join('');
}

// ---------- 小物 ----------
export const pad = (n) => String(n).padStart(2, '0');
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export function fmtTime(ms) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
export function ymd(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function stamp(ms) { const d = new Date(ms); return `${ymd(d).replaceAll('-', '')}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }
export function errText(e) { return (e && (e.message || e.name)) || String(e); }
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${pad(s % 60)}秒`;
}
export function fmtSize(bytes) { return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1e3))}KB`; }
export function fmtDateTime(ms) { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(ms)}`; }
export function toJpeg(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('写真を作れませんでした'))), 'image/jpeg', 0.75));
}

// ---------- 記録 ----------
const logs = [];
let logTarget = null;
const logEl = () => logTarget ?? $('#log');
// 記録を出す場所を変える（見る側は自分の記録欄を使う）
export function setLogElement(el) { logTarget = el; }
export function addLog(text, type = 'info', thumbUrl = null) {
  logs.unshift({ t: Date.now(), text, type, thumbUrl });
  while (logs.length > LOG_MAX) {
    const old = logs.pop();
    if (old.thumbUrl) URL.revokeObjectURL(old.thumbUrl);
  }
  renderLog();
}
export function renderLog() {
  logEl().textContent = '';
  for (const e of logs) {
    const li = document.createElement('li');
    li.className = 'log-' + e.type;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = fmtTime(e.t);
    const text = document.createElement('span');
    text.className = 'log-text';
    text.textContent = e.text;
    li.append(time, text);
    if (e.thumbUrl) {
      // 別タブで開くと見張りのカメラが止まるので、その場で拡大する
      const img = document.createElement('img');
      img.src = e.thumbUrl;
      img.alt = '検知したときの写真（タップで拡大）';
      img.className = e.big ? 'big' : '';
      img.addEventListener('click', () => { e.big = !e.big; img.className = e.big ? 'big' : ''; });
      li.append(img);
    }
    logEl().append(li);
  }
}
const errSeen = new Map();
export function reportError(prefix, e) {
  const key = prefix + errText(e);
  const now = Date.now();
  if (now - (errSeen.get(key) || 0) < 60_000) return;
  errSeen.set(key, now);
  addLog(`${prefix}（${errText(e)}）`, 'error');
}
window.addEventListener('error', (e) => reportError('予期しないエラーが起きました', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportError('予期しないエラーが起きました', e.reason));

// ---------- 画面スリープ防止 ----------
// isWanted：いま画面を点けておきたいか（見張り中・見ている間）
// onChange：状態の文が変わったとき（画面の表示に使う）
export function createWakeLock({ isWanted, onChange }) {
  let wakeLock = null;
  async function request() {
    if (!('wakeLock' in navigator)) {
      onChange('非対応（自動ロックを「なし」に）');
      return;
    }
    if (wakeLock) return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      // 取得までの間に起動が失敗した場合や、二重に取れた場合はすぐ手放す
      if (!isWanted() || wakeLock) {
        lock.release().catch(() => {});
        return;
      }
      wakeLock = lock;
      onChange('有効');
      lock.addEventListener('release', () => {
        if (wakeLock === lock) wakeLock = null;
        onChange(isWanted() ? '解除（画面に戻ると再設定）' : '—');
      });
    } catch {
      onChange('設定できません（自動ロックを「なし」に）');
    }
  }
  async function release() {
    const lock = wakeLock;
    wakeLock = null;
    try { await lock?.release(); } catch { /* すでに解除済み */ }
    onChange('—');
  }
  return { request, release, held: () => !!wakeLock };
}
