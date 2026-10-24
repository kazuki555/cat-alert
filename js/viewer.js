// 猫アラート：見る側（A）の画面。役割が「見る側」のときだけ index.html から読み込まれる
import { $, load, save, isValidTopic, addLog, renderLog, setLogElement, errText, createWakeLock } from './common.js';
import { createViewerLink } from './link.js';

setLogElement($('#vLog'));

const els = {
  video: $('#vVideo'), msg: $('#vMsg'), stage: $('#vStage'),
  watch: $('#vWatch'), stop: $('#vStop'), full: $('#vFull'),
  link: $('#vLink'), kind: $('#vKind'), cam: $('#vCam'), wake: $('#vWake'),
  topic: $('#vTopic'), settings: $('#vSettings'),
  banner: $('#vBanner'), overlay: $('#vOverlay'),
  flip: $('#vFlip'), torch: $('#vTorch'), low: $('#vLow'), why: $('#vWhy'),
  clips: $('#vClips'), clipsInfo: $('#vClipsInfo'),
};

// 合言葉：招待リンクで届いたもの → 自分で入れたもの → 同じブラウザのカメラ側の設定（パソコンで2つのタブを試すとき）
function savedTopic() {
  const t = load('pairTopic', null) ?? load('settings', {})?.topic;
  return isValidTopic(t) ? t : '';
}
let topic = savedTopic();
let link = null;
let viewing = false;
let lastCode = '';
let camState = null;   // カメラ側から届いた最新の state
let live = false;
const pendingCmds = new Map();  // id → { name, timer }
let cmdSeq = 0;

const STATUS_TEXT = {
  connecting: 'つないでいます…',
  connected: 'つながりました（映像を待っています）',
  live: '映っています',
  notfound: 'カメラが見つかりません（カメラ側で見張りが始まっているか、合言葉が同じか確認してください）',
  badkey: '合言葉が違います',
  busy: 'いま見ている人が多いので見られません（あとでもう一度つなぎます）',
  lost: '切れました。つなぎ直しています…',
  server: '映像をつなぐサーバーにつながりません。つなぎ直しています…',
};
const STAGE_TEXT = {
  connecting: 'つないでいます…',
  connected: '映像を待っています…',
  notfound: 'カメラが見つかりません\nカメラ側で「見張りを始める」を押してください',
  badkey: '合言葉が違います',
  busy: 'いま見ている人が多いので見られません',
  lost: '切れました。つなぎ直しています…',
  server: '映像をつなぐサーバーにつながりません',
};

// ---------- 画面スリープ防止 ----------
const wake = createWakeLock({ isWanted: () => viewing, onChange: (t) => { els.wake.textContent = t; } });

// ---------- 表示 ----------
function showMsg(text) { els.msg.textContent = text; els.msg.hidden = !text; }
function onStatus(code) {
  els.link.textContent = STATUS_TEXT[code] ?? code;
  live = code === 'live' || code === 'connected';
  if (!live) camState = null;
  renderOps();
  if (code === 'live') showMsg('');
  else showMsg(STAGE_TEXT[code] ?? '');
  if (code !== 'live') els.kind.textContent = '—';
  if (code === 'connected' && lastCode !== 'live') link?.send({ t: 'clips' });  // つながったら、録画の一覧をもらう
  if (!live) { stopDownload(false); clipList = []; }
  renderClips();
  if (code === 'notfound' || code === 'badkey' || code === 'busy' || code === 'server') els.cam.textContent = '—';
  if (code !== lastCode) {
    lastCode = code;
    if (code === 'live') addLog('カメラの映像が映りました', 'ok');
    else if (code === 'connected') addLog('カメラにつながりました', 'info');
    else if (code === 'notfound') addLog('カメラが見つかりません。見つかるまで、間をあけて試し続けます', 'warn');
    else if (code === 'badkey') addLog('合言葉が違います', 'error');
    else if (code === 'busy') addLog('いま見ている人が多いので見られません', 'warn');
    else if (code === 'lost') addLog('カメラとの接続が切れました。つなぎ直します', 'warn');
    else if (code === 'server') addLog('映像をつなぐサーバーにつながりません', 'warn');
  }
}
function onStream(s) {
  if (!s) { dets = []; drawDets(); }
  if (els.video.srcObject !== s) els.video.srcObject = s;
  if (s) els.video.play().catch(() => { /* autoplay 属性で再生される */ });
}
function onKind(kind) {
  els.kind.textContent = kind === 'direct' ? '直接つながっています（通信量はかかりません）'
    : kind === 'relay' ? '中継サーバー経由です（このiPhoneのデータ通信量を使います）' : '—';
}
function camText(s) {
  const parts = [];
  parts.push(s.testing ? 'テスト中' : s.running ? '見張り中' : '待機中');
  if (s.rec) parts.push('録画中');
  if (s.facing) parts.push(s.facing === 'user' ? 'インカメ' : '外カメ');
  if (typeof s.viewers === 'number') parts.push(`見ている人 ${s.viewers}人`);
  return parts.join('・');
}
// ---------- 動物が来たときの知らせ（帯・音・写真つき記録・枠） ----------
const GROUP_JA = { animal: '動物', person: '人' };
const GROUP_ICON = { animal: '🐾', person: '🧍' };
let audioCtx = null;
let bannerTimer = null;
// iPhone は、画面を一度タップしないと音を鳴らせない。「見る」を押したときに鳴らせる状態にしておく
function unlockAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* 音が出せなくても、帯と記録は出る */ }
}
function beep() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t0 = audioCtx.currentTime;
  [0, 0.22].forEach((d) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t0 + d);
    gain.gain.exponentialRampToValueAtTime(0.4, t0 + d + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.16);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + d);
    osc.stop(t0 + d + 0.18);
  });
}
function showBanner(text) {
  els.banner.textContent = text;
  els.banner.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { els.banner.hidden = true; }, 8_000);
}
const shortText = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const pendingPhotos = new Map();  // photoId → { text, parts, n, timer }
function finishPhoto(id, withPhoto) {
  const p = pendingPhotos.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pendingPhotos.delete(id);
  const url = withPhoto ? p.parts.join('') : null;
  const ok = url && url.startsWith('data:image/jpeg;base64,') && url.length < 300_000;
  addLog(p.text, 'detect', ok ? url : null);
}
function onPhotoPart(m) {
  const p = pendingPhotos.get(m.id);
  if (!p || !Number.isInteger(m.i) || m.i < 0 || m.i >= p.n || typeof m.data !== 'string') return;
  p.parts[m.i] = m.data;
  if (p.parts.filter((x) => x !== undefined).length === p.n) finishPhoto(m.id, true);
}
function onEvent(m) {
  const group = GROUP_JA[m.group] ? m.group : 'animal';
  const g = GROUP_JA[group];
  const name = shortText(m.name, 12);
  const pct = Number.isFinite(m.pct) ? Math.round(m.pct) : null;
  if (m.kind === 'gone') {
    addLog(`${g}がいなくなりました`, 'info');
    return;
  }
  const still = m.kind === 'still';
  const detail = [name, still && Number.isFinite(m.sec) ? fmtSec(m.sec) : pct != null ? `${pct}%` : ''].filter(Boolean).join('・');
  const text = `${g}が${still ? 'まだいます' : '来ました'}${detail ? `（${detail}）` : ''}`;
  showBanner(`${GROUP_ICON[group]} ${text}`);
  beep();
  const n = Number.isInteger(m.photoParts) ? m.photoParts : 0;
  if (n > 0 && n <= 20 && Number.isInteger(m.photoId)) {
    // 写真が届いてから、記録に残す（5秒待っても届かなければ、写真なしで残す）
    pendingPhotos.set(m.photoId, { text, parts: new Array(n), n, timer: setTimeout(() => finishPhoto(m.photoId, false), 5_000) });
  } else {
    addLog(text, 'detect');
  }
}
function fmtSec(s) { return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`; }

// 枠：映像の上に、カメラ側が見つけた位置を描く
let dets = [];
let detsAt = 0;
function drawDets() {
  const cv = els.overlay;
  const rect = els.stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(rect.width * dpr);
  const H = Math.round(rect.height * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw || !vh || !dets.length || Date.now() - detsAt > 2_000) return;
  const k = Math.min(W / vw, H / vh);  // object-fit: contain と同じ並べ方
  const cw = vw * k;
  const ch = vh * k;
  const ox = (W - cw) / 2;
  const oy = (H - ch) / 2;
  const lw = Math.max(2, Math.round(W / 220));
  const th = Math.max(16, Math.round(W / 22));
  g.textBaseline = 'middle';
  g.font = `bold ${Math.round(th * 0.7)}px system-ui, sans-serif`;
  for (const d of dets) {
    const x = ox + d.x * cw;
    const y = oy + d.y * ch;
    g.lineWidth = lw + 1;
    g.strokeStyle = d.ok ? '#ff7a1a' : 'rgba(255,255,255,.7)';
    g.setLineDash(d.ok ? [] : [lw * 4, lw * 3]);
    g.strokeRect(x, y, d.w * cw, d.h * ch);
    g.setLineDash([]);
    const text = `${d.name} ${Math.round(d.score * 100)}%`;
    const tw = g.measureText(text).width + th * 0.6;
    const ty = y - th >= 0 ? y - th : y;
    g.fillStyle = d.ok ? '#ff7a1a' : 'rgba(0,0,0,.6)';
    g.fillRect(x, ty, tw, th);
    g.fillStyle = d.ok ? '#1a0d05' : '#ffffff';
    g.fillText(text, x + th * 0.3, ty + th / 2);
  }
}
function onDets(m) {
  const num = (v) => (Number.isFinite(v) ? v : 0);
  dets = (Array.isArray(m.list) ? m.list.slice(0, 10) : []).map((d) => ({
    name: shortText(d.name, 12), score: num(d.score), ok: d.ok === true,
    x: num(d.x), y: num(d.y), w: num(d.w), h: num(d.h),
  }));
  detsAt = Date.now();
  drawDets();
}
setInterval(() => { if (dets.length && Date.now() - detsAt > 2_000) { dets = []; drawDets(); } }, 1_000);
window.addEventListener('resize', drawDets);
els.video.addEventListener('loadedmetadata', drawDets);

// ---------- カメラ側の録画（一覧 → 受け取り → 再生） ----------
const GROUP_NAME = { animal: '動物', person: '人' };
const CLIP_CACHE_MAX = 3;           // 受け取った録画を覚えておく本数（多いとメモリを使うため）
const CLIP_STALL_MS = 20_000;       // これだけ何も届かなければ、受け取りをあきらめる
let clipList = [];                  // カメラ側の録画の一覧（新しい順）
const clipBlobs = new Map();        // id → { blob, url }（受け取り済み）
let dl = null;                      // いま受け取り中：{ id, n, got, size, type, parts, timer }
const openClips = new Set();        // 再生のために開いている録画の id

const fmtMB = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1e3))}KB`);
function fmtClipTitle(c) {
  const d = new Date(c.startedAt);
  const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const dur = Math.max(1, Math.round((c.endedAt - c.startedAt) / 1000));
  const what = (c.labels || []).map((g) => GROUP_NAME[g]).filter(Boolean).join('・');
  return `${when}　${what ? what + '・' : ''}${fmtSec(dur)}・${fmtMB(c.size)}`;
}
function rememberClip(id, blob) {
  const old = clipBlobs.get(id);
  if (old) URL.revokeObjectURL(old.url);
  clipBlobs.delete(id);
  clipBlobs.set(id, { blob, url: URL.createObjectURL(blob) });
  while (clipBlobs.size > CLIP_CACHE_MAX) {
    // いちばん古いものから忘れる（開いているものは、なるべく残す）
    const k = [...clipBlobs.keys()].find((id) => !openClips.has(id)) ?? clipBlobs.keys().next().value;
    URL.revokeObjectURL(clipBlobs.get(k)?.url);
    clipBlobs.delete(k);
    openClips.delete(k);
  }
}
function stopDownload(send = true) {
  if (!dl) return;
  clearTimeout(dl.timer);
  if (send) link?.send({ t: 'clipstop', id: dl.id });
  dl = null;
}
function armStall() {
  clearTimeout(dl.timer);
  dl.timer = setTimeout(() => {
    addLog('録画が途中で届かなくなりました', 'warn');
    stopDownload();
    renderClips();
  }, CLIP_STALL_MS);
}
function renderClips() {
  els.clips.textContent = '';
  els.clipsInfo.textContent = clipList.length ? `${clipList.length}本` : '';
  if (!link || !live) {
    const li = document.createElement('li');
    li.className = 'help';
    li.textContent = '「見る」でカメラにつながると、録画の一覧が出ます';
    els.clips.append(li);
    return;
  }
  for (const c of clipList) {
    const li = document.createElement('li');
    const title = document.createElement('div');
    title.className = 'clip-title';
    title.textContent = fmtClipTitle(c);
    const row = document.createElement('div');
    row.className = 'row';
    const btn = document.createElement('button');
    btn.className = 'btn small';
    const have = clipBlobs.get(c.id);
    const loading = dl && dl.id === c.id;
    btn.textContent = loading ? `受け取り中 ${Math.round((dl.got / dl.n) * 100)}%` : openClips.has(c.id) ? '閉じる' : have ? '再生' : `見る（${fmtMB(c.size)}）`;
    btn.disabled = !!dl && !loading;
    row.append(btn);
    if (loading) {
      const cancel = document.createElement('button');
      cancel.className = 'btn small';
      cancel.textContent = 'やめる';
      cancel.addEventListener('click', () => { stopDownload(); renderClips(); });
      row.append(cancel);
    }
    li.append(title, row);
    if (openClips.has(c.id) && have) {
      const v = document.createElement('video');
      v.src = have.url;
      v.controls = true;
      v.playsInline = true;
      v.muted = true;
      v.autoplay = true;
      li.append(v);
    }
    btn.addEventListener('click', () => {
      if (loading) return;
      if (openClips.has(c.id)) { openClips.delete(c.id); renderClips(); return; }
      if (have) { openClips.add(c.id); renderClips(); return; }
      if (!link?.send({ t: 'clipget', id: c.id })) { addLog('録画を受け取れません（カメラにつながっていません）', 'warn'); return; }
      dl = { id: c.id, n: 0, got: 0, size: c.size, type: c.type, parts: [], timer: null };
      armStall();
      renderClips();
    });
    els.clips.append(li);
  }
}
function onClipList(m) {
  clipList = (Array.isArray(m.list) ? m.list : []).slice(0, 30).filter((c) => c && typeof c.id === 'string').map((c) => ({
    id: c.id, startedAt: Number(c.startedAt) || 0, endedAt: Number(c.endedAt) || 0,
    labels: Array.isArray(c.labels) ? c.labels.slice(0, 5) : [], size: Number(c.size) || 0, type: shortText(c.type, 60),
  }));
  // カメラ側で消された録画は、こちらでも忘れる
  for (const id of [...clipBlobs.keys()]) if (!clipList.some((c) => c.id === id)) { URL.revokeObjectURL(clipBlobs.get(id)?.url); clipBlobs.delete(id); openClips.delete(id); }
  renderClips();
}
function onClipMeta(m) {
  if (!dl || dl.id !== m.id) return;
  if (!m.ok || !Number.isInteger(m.n) || m.n < 1) {
    addLog(`録画：${shortText(m.msg, 60) || '受け取れませんでした'}`, 'warn');
    stopDownload(false);
    renderClips();
    return;
  }
  dl.n = m.n;
  dl.size = Number(m.size) || dl.size;
  dl.type = shortText(m.type, 60) || dl.type;
  armStall();
  renderClips();
}
let lastClipPaint = 0;
function onClipData(m) {
  if (!dl || dl.id !== m.id || !dl.n || !Number.isInteger(m.i) || m.i < 0 || m.i >= dl.n || typeof m.data !== 'string' || dl.parts[m.i]) return;
  try {
    const bin = atob(m.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dl.parts[m.i] = bytes;
  } catch {
    addLog('録画のデータが壊れていました', 'error');
    stopDownload();
    renderClips();
    return;
  }
  dl.got += 1;
  armStall();
  if (dl.got < dl.n) {
    if (Date.now() - lastClipPaint > 300) { lastClipPaint = Date.now(); renderClips(); }  // 進みぐあいは、ときどきだけ描き直す
    return;
  }
  const id = dl.id;
  const blob = new Blob(dl.parts, { type: dl.type.split(';')[0] || 'video/mp4' });
  stopDownload(false);
  rememberClip(id, blob);
  openClips.add(id);
  addLog(`録画を受け取りました（${fmtMB(blob.size)}）`, 'ok');
  renderClips();
}

function onMessage(m) {
  if (m.t === 'cliplist') { onClipList(m); return; }
  if (m.t === 'clipmeta') { onClipMeta(m); return; }
  if (m.t === 'clipdata') { onClipData(m); return; }
  if (m.t === 'event') { onEvent(m); return; }
  if (m.t === 'photo') { onPhotoPart(m); return; }
  if (m.t === 'dets') { onDets(m); return; }
  if (m.t === 'state') {
    camState = m;
    els.cam.textContent = camText(m);
    renderOps();
  } else if (m.t === 'result') {
    const p = pendingCmds.get(m.id);
    if (!p) return;
    clearTimeout(p.timer);
    pendingCmds.delete(m.id);
    if (m.ok) addLog(`${p.label}：できました`, 'ok');
    else addLog(`${p.label}：${m.msg || 'できませんでした'}`, 'warn');
    renderOps();
  }
}

// ---------- 3つの操作（カメラ側に命令を送る） ----------
const LOW_NEXT = { auto: 'high', high: 'off', off: 'auto' };
const LOW_TEXT = { auto: '自動', high: 'オン', off: 'オフ' };
function renderOps() {
  const st = camState;
  const busy = pendingCmds.size > 0;
  els.flip.disabled = !st || busy;
  // ライト：使えないときは、薄くして理由を出す
  const torchOk = !!st && st.torchOk === true;
  els.torch.disabled = !torchOk || busy;
  els.torch.textContent = torchOk && st.torch ? '🔦 ライト：オン' : '🔦 ライト';
  els.low.disabled = !st || busy;
  els.low.textContent = `🌙 低光量：${LOW_TEXT[st?.lowLight] ?? '—'}`;
  const why = !st ? '' : !torchOk ? (st.torchWhy || 'ライトは使えません') : '';
  els.why.hidden = !why;
  els.why.textContent = why;
  // 暗い映像を、カメラ側から届いた倍率で明るく見せる（カメラ側は映像を作り直さないので熱くならない）
  const gain = st && st.lowLight !== 'off' && Number(st.gain) >= 1.05 ? Number(st.gain) : 1;
  els.video.style.filter = gain > 1 ? `brightness(${Math.min(gain, 10)})` : '';
}
function sendCmd(name, value, label) {
  if (!link) return;
  const id = ++cmdSeq;
  if (!link.send({ t: 'cmd', id, name, value })) { addLog(`${label}：カメラにつながっていません`, 'warn'); return; }
  const timer = setTimeout(() => {
    pendingCmds.delete(id);
    addLog(`${label}：カメラから返事がありません`, 'warn');
    renderOps();
  }, 8_000);
  pendingCmds.set(id, { label, timer });
  renderOps();
}
els.flip.addEventListener('click', () => sendCmd('flip', null, 'カメラ切替'));
els.torch.addEventListener('click', () => sendCmd('torch', !camState?.torch, 'ライト'));
els.low.addEventListener('click', () => sendCmd('lowlight', LOW_NEXT[camState?.lowLight] ?? 'auto', '低光量モード'));

// ---------- 見る・やめる ----------
function startWatching() {
  if (link) return;
  if (!isValidTopic(topic)) {
    showMsg('合言葉を入れてください（下の「設定」）');
    els.settings.open = true;
    els.topic.focus();
    return;
  }
  viewing = true;
  save('viewing', true);
  unlockAudio();
  wake.request();
  els.watch.hidden = true;
  els.stop.hidden = false;
  lastCode = '';
  addLog('カメラを探します', 'info');
  try {
    // テスト用：localhost で ?badkey を付けると、わざと違う鍵で本人確認する
    const macKey = location.hostname === 'localhost' && new URLSearchParams(location.search).has('badkey') ? 'wrong-key' : undefined;
    link = createViewerLink({ topic, macKey, onStatus, onStream, onKind, onMessage });
  } catch (e) {
    addLog(`つなげませんでした（${errText(e)}）`, 'error');
    stopWatching();
  }
}
function stopWatching() {
  viewing = false;
  save('viewing', false);
  link?.close();
  link = null;
  onStream(null);
  wake.release();
  els.watch.hidden = false;
  els.stop.hidden = true;
  els.link.textContent = '—';
  els.kind.textContent = '—';
  els.cam.textContent = '—';
  live = false;
  camState = null;
  for (const p of pendingCmds.values()) clearTimeout(p.timer);
  pendingCmds.clear();
  stopDownload(false);
  clipList = [];
  renderClips();
  renderOps();
  showMsg('「見る」を押すと、カメラ側の映像を探します');
}
els.watch.addEventListener('click', startWatching);
els.stop.addEventListener('click', () => { stopWatching(); addLog('見るのをやめました', 'info'); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && viewing && !wake.held()) wake.request();
});

// ---------- 全画面 ----------
els.full.addEventListener('click', () => {
  const v = els.video;
  try {
    if (els.stage.requestFullscreen) els.stage.requestFullscreen();
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();  // iPhone の Safari
  } catch (e) {
    addLog(`全画面にできませんでした（${errText(e)}）`, 'warn');
  }
});

// ---------- 合言葉 ----------
els.topic.value = topic;
els.topic.addEventListener('change', () => {
  const v = els.topic.value.trim();
  if (!isValidTopic(v)) {
    addLog('合言葉は、半角の英数字・ハイフン・アンダーバーで64文字以内にしてください', 'error');
    els.topic.value = topic;
    return;
  }
  topic = v;
  save('pairTopic', v);
  addLog('合言葉を変更しました', 'info');
  if (link) { stopWatching(); startWatching(); }
});

// ---------- 起動 ----------
renderLog();
renderClips();
if (!topic) {
  els.settings.open = true;
  showMsg('合言葉を入れてください（下の「設定」）');
} else if (load('viewing', false)) {
  startWatching();  // 前回、見ている途中だったら、そのまま続ける
}
