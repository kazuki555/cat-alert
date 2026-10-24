// 猫アラート：カメラ側（見張り機能）。役割が「カメラ」のときだけ index.html から読み込まれる
import {
  $, $$, load, save, storageOk, isValidTopic, randomTopic,
  pad, clamp, fmtTime, ymd, stamp, errText, fmtDuration, fmtSize, fmtDateTime, toJpeg,
  addLog, renderLog, reportError, createWakeLock,
} from './common.js';


// ---------- 定数 ----------
const MP_VERSION = '1.0.1';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URLS = {
  lite0: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
  lite2: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/1/efficientdet_lite2.tflite',
};
// 見つける対象のグループ：表示名・AI(COCO)のラベル・ntfy のタグ（タグは通知タイトルの絵文字になる）
const GROUPS = {
  animal: { label: '動物', labels: ['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'], tag: 'paw_prints' },
  person: { label: '人', labels: ['person'], tag: 'bust_in_silhouette' },
};
// AIのラベル名 → 日本語名（枠の文字や通知の（）の中に使う）
const LABEL_JA = {
  bird: '鳥', cat: '猫', dog: '犬', horse: '馬', sheep: '羊', cow: '牛',
  elephant: '象', bear: 'クマ', zebra: 'シマウマ', giraffe: 'キリン', person: '人',
};
const labelJa = (l) => LABEL_JA[l] ?? l;
// 選んだグループに入っているAIのラベルを全部合わせたもの
const targetLabels = () => settings.targets.flatMap((g) => GROUPS[g].labels);
// いちばん確かな検知の「名前・確からしさ」（例：猫・92%）
const bestText = (hits) => {
  const b = hits.reduce((a, h) => (h.score > a.score ? h : a));
  return `${labelJa(b.label)}・${Math.round(b.score * 100)}%`;
};
const CONFIRM_N = 5;          // 直近5回の判定のうち
const CONFIRM_K = 3;          // 3回以上見つかったら「来た」
const DETECT_FLOOR = 0.25;    // これ未満の候補はAIから受け取らない（点線枠の表示用）
const WORK_MAX = 640;         // 判定用に縮小するときの最大辺
const SNAPSHOT_WIDTH = 640;
const DAILY_CAP = 200;        // ntfy.sh 無料枠（1日250通）より少なく
const REMIND_RESERVE = 30;    // 1日の残りがこれ未満になったら、「映り続けている」通知は止める（新しく来たときの通知に残しておく）
const REMIND_PHOTO_WIDTH = 480;  // 「映り続けている」通知の写真は小さくする（無料枠の添付の合計20MBを使い切らないため）
const RETRY_MS = 10_000;
const RATE_LIMIT_RETRY_MS = 60_000;
const SYSTEM_GAP_MS = 5 * 60_000;  // 開始・再開の通知は5分に1回まで
const QUEUE_MAX = 5;
const REC_MAX_MS = 5 * 60_000;           // 録画1本の最長
const REC_STORE_LIMIT = 300 * 1_000_000; // 録画の合計の上限（約300MB）
const REC_MAX_COUNT = 50;
const REC_BITRATE = 1_000_000;           // 約1Mbps（1分で約7.5MB）


// ---------- 設定 ----------
const DEFAULTS = {
  server: 'https://ntfy.sh',
  topic: '',
  targets: ['animal'],
  threshold: 0.5,
  model: 'lite0',
  fps: 3,
  absentSec: 60,
  minIntervalSec: 60,
  repeatSec: 60,
  roi: { x: 0, y: 0, w: 1, h: 1 },
  facing: 'environment',
  gpu: false,
  sendInTest: false,
  record: true,
  recGraceSec: 5,
  boost: 'auto',
  torch: false,
  view: 'normal',
};
const settings = { ...DEFAULTS, ...load('settings', {}) };
// v5：対象を「猫・犬・人」から「動物・人」に置きかえる（1回だけ。cat／dog があれば animal にする）
if (settings.ver !== 5) {
  const old = Array.isArray(settings.targets) ? settings.targets : [];
  const next = [];
  if (old.some((t) => t === 'cat' || t === 'dog' || t === 'animal')) next.push('animal');
  if (old.includes('person')) next.push('person');
  settings.targets = next;
  settings.ver = 5;
}
settings.targets = (Array.isArray(settings.targets) ? settings.targets : []).filter((t) => t in GROUPS);
if (!settings.targets.length) settings.targets = ['animal'];
if (!(settings.model in MODEL_URLS)) settings.model = 'lite0';
const pick = (v, allowed, def) => (allowed.includes(v) ? v : def);
settings.fps = pick(settings.fps, [1, 2, 3, 5], DEFAULTS.fps);
settings.absentSec = pick(settings.absentSec, [30, 60, 120, 300], DEFAULTS.absentSec);
settings.minIntervalSec = pick(settings.minIntervalSec, [30, 60, 180, 600], DEFAULTS.minIntervalSec);
settings.repeatSec = pick(settings.repeatSec, [0, 60, 180, 600], DEFAULTS.repeatSec);
settings.recGraceSec = pick(settings.recGraceSec, [3, 5, 10, 30], DEFAULTS.recGraceSec);
settings.boost = pick(settings.boost, ['auto', 'high', 'off'], DEFAULTS.boost);
settings.torch = settings.torch === true;
settings.view = pick(settings.view, ['normal', 'ultra', 'hd'], DEFAULTS.view);
if (!(settings.threshold >= 0.3 && settings.threshold <= 0.9)) settings.threshold = DEFAULTS.threshold;
if (!isValidRoi(settings.roi)) settings.roi = { ...DEFAULTS.roi };
if (!isValidTopic(settings.topic)) settings.topic = randomTopic();
saveSettings();

function saveSettings() { save('settings', settings); }
function isValidRoi(r) {
  return !!r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.x >= 0 && r.y >= 0 &&
    r.w >= 0.05 && r.h >= 0.05 && r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001;
}
function isFullRoi(r) { return r.x <= 0.001 && r.y <= 0.001 && r.w >= 0.999 && r.h >= 0.999; }

// ---------- 小物 ----------
function targetNames(list) { return list.filter((t) => t in GROUPS).map((t) => GROUPS[t].label).join('・'); }

// ---------- 画面の部品 ----------
const els = {
  badge: $('#badge'), stage: $('#stage'), cam: $('#cam'), testImg: $('#testImg'), testVid: $('#testVid'),
  overlay: $('#overlay'), stageMsg: $('#stageMsg'),
  startBtn: $('#startBtn'), stopBtn: $('#stopBtn'), testNotifyBtn: $('#testNotifyBtn'), dimBtn: $('#dimBtn'), flipBtn: $('#flipBtn'), view: $('#view'), torchBtn: $('#torchBtn'), stTorch: $('#stTorch'),
  stState: $('#stState'), stJudge: $('#stJudge'), stRate: $('#stRate'), stLast: $('#stLast'),
  stCount: $('#stCount'), stViewers: $('#stViewers'), stNet: $('#stNet'), stWake: $('#stWake'), stRec: $('#stRec'),
  boost: $('#boost'), record: $('#record'), recGraceSec: $('#recGraceSec'), clips: $('#clips'), clipsInfo: $('#clipsInfo'), clipsClear: $('#clipsClear'),
  settingsBox: $('#settingsBox'), topic: $('#topic'), topicCopy: $('#topicCopy'), topicShare: $('#topicShare'), topicNew: $('#topicNew'),
  targetBoxes: $$('input[name=target]'), threshold: $('#threshold'), thresholdVal: $('#thresholdVal'),
  model: $('#model'), fps: $('#fps'), absentSec: $('#absentSec'), minIntervalSec: $('#minIntervalSec'), repeatSec: $('#repeatSec'),
  roiEdit: $('#roiEdit'), roiReset: $('#roiReset'), roiText: $('#roiText'), gpu: $('#gpu'), server: $('#server'),
  fileInput: $('#fileInput'), sendInTest: $('#sendInTest'), testEnd: $('#testEnd'),
  log: $('#log'), dim: $('#dim'), dimInfo: $('#dimInfo'), dimState: $('#dimState'), dimSub: $('#dimSub'),
  storageWarn: $('#storageWarn'), secureWarn: $('#secureWarn'),
};

function setBadge(text, kind = '') {
  els.badge.textContent = text;
  els.badge.className = 'badge' + (kind ? ' ' + kind : '');
}
function showStageMsg(text) { els.stageMsg.textContent = text; els.stageMsg.hidden = false; }
function hideStageMsg() { els.stageMsg.hidden = true; }
const IDLE_MSG = '「見張りを始める」を押すとカメラが起動します';


// ---------- 1日の通知数 ----------
function dailyState() {
  const d = load('daily', null);
  const today = ymd();
  return d && d.date === today ? d : { date: today, count: 0 };
}
function dailyCount() { return dailyState().count; }
function dailyInc() { const d = dailyState(); d.count += 1; save('daily', d); }

// ---------- 状態 ----------
let mode = 'idle';        // 'idle' | 'camera' | 'test'
let running = false;      // カメラで見張り中
let starting = false;
let lastDets = [];
const trackers = {};      // 対象ごとの「来た／いない」の判定状態
const stats = { viewers: 0, linkDown: false, inferMs: null, rate: null, lastDetectAt: null, net: 'idle', failing: false, wake: '—' };

function resetTrackers() { for (const k of Object.keys(trackers)) delete trackers[k]; }

// 「判定」欄の文。次の通知がいつ届くかが分かるように、残り時間も出す
function judgeText(label, now) {
  const t = trackers[label];
  const name = GROUPS[label].label;
  if (!t) return `${name}：いない`;
  if (t.present) {
    const gone = now - t.lastSeen;
    if (gone < 2000) {
      const next = settings.repeatSec && t.nextRemindAt ? Math.max(0, Math.ceil((t.nextRemindAt - now) / 1000)) : 0;
      return next > 0 ? `${name}：来ている（次の通知まで あと${next}秒）` : `${name}：来ている`;
    }
    const left = Math.max(0, Math.ceil((settings.absentSec * 1000 - gone) / 1000));
    return `${name}：見えなくなって${Math.floor(gone / 1000)}秒（あと${left}秒で「いない」に戻ります）`;
  }
  const wait = t.lastNotified ? Math.ceil((settings.minIntervalSec * 1000 - (now - t.lastNotified)) / 1000) : 0;
  return wait > 0 ? `${name}：いない（次に通知できるまで あと${wait}秒）` : `${name}：いない`;
}

function updateStatus() {
  els.stState.textContent = mode === 'camera' && running ? '見張り中' : mode === 'test' ? 'テスト中' : '待機中';
  const now = Date.now();
  els.stJudge.textContent = settings.targets.map((t) => judgeText(t, now)).join(' / ');
  els.stRate.textContent = stats.rate == null ? '—' : `${stats.rate.toFixed(1)}回/秒・1回 ${Math.round(stats.inferMs)}ms`;
  els.stLast.textContent = stats.lastDetectAt ? fmtTime(stats.lastDetectAt) : '—';
  els.stCount.textContent = `${dailyCount()}件（上限 ${DAILY_CAP}件）`;
  els.stNet.textContent = !navigator.onLine ? 'オフライン（つながるのを待っています）'
    : stats.failing ? `送信失敗・送り直し待ち ${queue.length}件`
    : stats.net === 'ok' ? '正常' : '—';
  els.stWake.textContent = stats.wake;
  els.stRec.textContent = rec ? `● 録画中 ${fmtDuration(Date.now() - rec.startedAt)}`
    : !settings.record ? 'オフ' : !recSupported ? '非対応' : '待機中';
  els.stRec.className = rec ? 'rec-on' : '';
  const ti = torchInfo();
  els.stTorch.textContent = ti.ok ? (settings.torch ? 'オン' : 'オフ') : `使えない（${ti.why}）`;
  els.torchBtn.disabled = !ti.ok;
  els.torchBtn.textContent = ti.ok && settings.torch ? '🔦 ライト：オン' : '🔦 ライト';
  els.torchBtn.title = ti.why;
  els.stViewers.textContent = !cameraLink ? '—' : stats.linkDown ? '映像のサーバーにつながりません'
    : stats.viewers ? `${stats.viewers}人` : 'いません（待機中）';
  updateDim();
}
function updateButtons() {
  els.startBtn.hidden = running;
  els.stopBtn.hidden = !running;
  els.startBtn.disabled = starting;
}

// ---------- 映像の入力元 ----------
let testKind = null;      // 'image' | 'video'
let testUrl = null;
function activeSource() { return mode === 'test' ? (testKind === 'video' ? els.testVid : els.testImg) : els.cam; }
function sourceSize(el) { return el.tagName === 'VIDEO' ? [el.videoWidth, el.videoHeight] : [el.naturalWidth, el.naturalHeight]; }
function sourceReady(el) {
  return el.tagName === 'VIDEO' ? el.readyState >= 2 && el.videoWidth > 0 : el.complete && el.naturalWidth > 0;
}
function showSource() {
  els.cam.hidden = mode === 'test';
  els.testImg.hidden = !(mode === 'test' && testKind === 'image');
  els.testVid.hidden = !(mode === 'test' && testKind === 'video');
  layoutOverlay();
}

// ---------- AI（MediaPipe Object Detector） ----------
let mp = null;
let fileset = null;
let detector = null;
let detectorConf = '';
let detectorTargets = '';
let detectorTask = null;
function wantedConf() { return `${settings.model}|${settings.gpu ? 'GPU' : 'CPU'}`; }
function detectorOutdated() {
  return !detector || detectorConf !== wantedConf() || detectorTargets !== settings.targets.join(',');
}
async function ensureDetector() {
  while (detectorTask) await detectorTask.catch(() => {});
  if (!detectorOutdated()) return detector;
  const conf = wantedConf();
  const targets = settings.targets.join(',');
  detectorTask = (async () => {
    if (detector && detectorConf === conf) {
      await detector.setOptions({ categoryAllowlist: targetLabels() });
      detectorTargets = targets;
      return;
    }
    const prevMsg = els.stageMsg.hidden ? null : els.stageMsg.textContent;
    showStageMsg('AIを読み込んでいます…\n（初回は1分ほどかかることがあります）');
    try {
      mp ??= await import(`${MP_BASE}/vision_bundle.mjs`);
      fileset ??= await mp.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      const old = detector;
      detector = null;
      try { old?.close(); } catch { /* 閉じられなくても続ける */ }
      detector = await mp.ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URLS[settings.model], delegate: settings.gpu ? 'GPU' : 'CPU' },
        runningMode: 'IMAGE',
        scoreThreshold: DETECT_FLOOR,
        maxResults: 5,
        categoryAllowlist: targetLabels(),
      });
      detectorConf = conf;
      detectorTargets = targets;
    } finally {
      if (prevMsg) showStageMsg(prevMsg); else hideStageMsg();
    }
  })();
  try { await detectorTask; } finally { detectorTask = null; }
  return detector;
}

// ---------- 判定ループ ----------
let looping = false;
let loopTimer = null;
let frameCount = 0;
let rateStart = 0;
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });

// ---------- 低光量モード（旧：明るさ補正。保存値の auto／high／off はそのまま）（Safariのカメラは、標準カメラアプリのような自動の明るさ調整が効かないため） ----------
// 画面全体の平均の明るさ（0〜255）が target になるように持ち上げる（明るい場所では何もしない）。max は持ち上げる倍率の上限
const BOOST_LEVELS = { auto: { target: 110, max: 6 }, high: { target: 150, max: 10 } };
let boostGain = 1;
let lutKey = '';
let lutData = null;
function lutFor(gain) {
  const key = gain.toFixed(2);
  if (key !== lutKey) {
    lutData = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lutData[i] = 255 * Math.pow(Math.min(1, (i * gain) / 255), 0.8);  // 暗い部分を特に持ち上げる
    lutKey = key;
  }
  return lutData;
}
function applyLut(ctx, w, h, gain) {
  if (gain < 1.05) return;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const lut = lutFor(gain);
  for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  ctx.putImageData(img, 0, 0);
}
// 判定用の画像の明るさを測って補正量を決め、補正する
function boostWork(w, h) {
  if (settings.boost === 'off') { boostGain = 1; return; }
  const lv = BOOST_LEVELS[settings.boost];
  const d = wctx.getImageData(0, 0, w, h).data;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 16) { sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; n++; }
  const want = clamp(lv.target / Math.max(sum / n, 4), 1, lv.max);
  boostGain = boostGain * 0.7 + want * 0.3;   // 急に変わらないようにならす
  applyLut(wctx, w, h, boostGain);
}
function setPreviewFilter() {
  const f = boostGain >= 1.05 ? `brightness(${boostGain.toFixed(2)})` : '';
  for (const el of [els.cam, els.testImg, els.testVid]) if (el.style.filter !== f) el.style.filter = f;
}

function startLoop() {
  if (looping) return;
  looping = true;
  frameCount = 0;
  rateStart = performance.now();
  stats.rate = null;
  loopTimer = setTimeout(tick, 0);
}
function stopLoop() {
  looping = false;
  clearTimeout(loopTimer);
  loopTimer = null;
}
async function tick() {
  if (!looping) return;
  const t0 = performance.now();
  try {
    await processFrame();
  } catch (e) {
    console.error(e);
    reportError('判定中にエラーが起きました', e);
  }
  if (!looping) return;
  loopTimer = setTimeout(tick, Math.max(10, 1000 / settings.fps - (performance.now() - t0)));
}

let detectorRetryAt = 0;
let lastPushedGain = 1;
let lastGainPushAt = 0;
async function processFrame() {
  if (mode === 'camera') checkCameraAlive();
  if (detectorOutdated()) {
    if (Date.now() < detectorRetryAt) return;  // 読み込みに失敗した直後は、しばらく待ってから試し直す
    try {
      await ensureDetector();
    } catch (e) {
      detectorRetryAt = Date.now() + 15_000;
      throw e;
    }
  }
  const src = activeSource();
  if (!detector || !sourceReady(src)) return;

  // 見張る範囲だけを切り出して縮小し、AIに渡す
  const [sw, sh] = sourceSize(src);
  const r = settings.roi;
  const cx = Math.floor(r.x * sw);
  const cy = Math.floor(r.y * sh);
  const cw = Math.max(1, Math.min(sw - cx, Math.round(r.w * sw)));
  const ch = Math.max(1, Math.min(sh - cy, Math.round(r.h * sh)));
  const k = Math.min(1, WORK_MAX / Math.max(cw, ch));
  const ww = Math.max(1, Math.round(cw * k));
  const wh = Math.max(1, Math.round(ch * k));
  if (work.width !== ww || work.height !== wh) { work.width = ww; work.height = wh; }
  wctx.drawImage(src, cx, cy, cw, ch, 0, 0, ww, wh);
  boostWork(ww, wh);
  setPreviewFilter();
  // 見る側は、この倍率で映像を明るく見せる。大きく変わったときだけ、1秒に1回まで知らせる
  if (cameraLink && Math.abs(boostGain - lastPushedGain) > 0.15 && Date.now() - lastGainPushAt > 1000) {
    lastPushedGain = boostGain;
    lastGainPushAt = Date.now();
    cameraLink.pushState();
  }

  const t0 = performance.now();
  const result = detector.detect(work);
  const ms = performance.now() - t0;
  stats.inferMs = stats.inferMs == null ? ms : stats.inferMs * 0.8 + ms * 0.2;
  frameCount++;
  const now = performance.now();
  if (now - rateStart >= 2000) {
    stats.rate = (frameCount * 1000) / (now - rateStart);
    frameCount = 0;
    rateStart = now;
  }

  // 元の映像の座標に戻す
  lastDets = result.detections
    .filter((d) => d.boundingBox && d.categories && d.categories.length)
    .map((d) => {
      const c = d.categories[0];
      const b = d.boundingBox;
      return { label: c.categoryName, score: c.score, x: cx + b.originX / k, y: cy + b.originY / k, w: b.width / k, h: b.height / k };
    });
  drawOverlay();
  sendDets(sw, sh);
  if (rec && rec.viaCanvas) drawRecCanvas();
  await updateTrackers(lastDets, src);
  updateStatus();
}

// ---------- 「来た／いない」の判定 ----------
async function updateTrackers(dets, src) {
  const now = Date.now();
  for (const label of settings.targets) {
    const t = trackers[label] ??= { hist: [], present: false, lastSeen: 0, lastNotified: 0 };
    const hits = dets.filter((d) => GROUPS[label].labels.includes(d.label) && d.score >= settings.threshold);
    t.hist.push(hits.length > 0);
    if (t.hist.length > CONFIRM_N) t.hist.shift();
    if (hits.length) t.lastSeen = now;
    const confirmed = hits.length > 0 && t.hist.filter(Boolean).length >= CONFIRM_K;
    if (confirmed) startOrExtendRecording(label);
    if (!t.present && confirmed) {
      t.present = true;
      t.presentSince = now;
      t.nextRemindAt = settings.repeatSec ? now + settings.repeatSec * 1000 : 0;
      await onArrival(label, hits, src, t, now);
    } else if (t.present && now - t.lastSeen >= settings.absentSec * 1000) {
      t.present = false;
      t.hist = [];
      addLog(`${GROUPS[label].label}がいなくなりました`, 'info');
      sendEvent('gone', label, null, null);
    } else if (t.present && confirmed && settings.repeatSec && now >= (t.nextRemindAt || 0)) {
      // 映り続けているあいだ、決めた間隔でもう一度知らせる
      t.nextRemindAt = now + settings.repeatSec * 1000;
      await onStillThere(label, hits, src, t, now);
    }
  }
  checkRecordingEnd(now);
  if (mode === 'idle') return;
  const present = settings.targets.filter((l) => trackers[l]?.present);
  if (present.length) setBadge(`${targetNames(present)}を検知中`, 'alert');
  else setBadge(mode === 'test' ? 'テスト中' : '見張り中', 'run');
}

async function onArrival(label, hits, src, t, now) {
  const name = GROUPS[label].label;
  const best = bestText(hits);  // 例：猫・92%
  sendEvent('arrive', label, hits, src);
  stats.lastDetectAt = now;
  let blob = null;
  let thumb = null;
  try {
    blob = await makeSnapshot(src, hits);
    thumb = URL.createObjectURL(blob);
  } catch (e) {
    console.warn(e);
  }
  if (mode === 'test' && !settings.sendInTest) {
    addLog(`${name}が来ました（${best}）。テスト中なので通知は送りません`, 'detect', thumb);
    return;
  }
  if (t.lastNotified && now - t.lastNotified < settings.minIntervalSec * 1000) {
    addLog(`${name}が来ました（${best}）。前の通知から間もないので送りません`, 'detect', thumb);
    return;
  }
  if (dailyCount() >= DAILY_CAP) {
    addLog(`${name}が来ました（${best}）。今日の通知が上限に達したので送りません`, 'warn', thumb);
    return;
  }
  t.lastNotified = now;
  addLog(`${name}が来ました（${best}）。通知を送ります`, 'detect', thumb);
  enqueue({
    title: `${name}が来ました（${best}）`,
    message: `${fmtTime(now)} に${name}を検知しました（${best}）${rec ? '。カメラ側で録画しています' : ''}`,
    tags: GROUPS[label].tag,
    priority: 4,
    blob,
    filename: `${label}-${stamp(now)}.jpg`,
  });
}

// 映り続けているときの通知（写真は小さめ）
async function onStillThere(label, hits, src, t, now) {
  const name = GROUPS[label].label;
  const best = bestText(hits);
  const bestName = best.split('・')[0];
  const lasted = fmtDuration(now - t.presentSince);
  sendEvent('still', label, hits, src, { sec: Math.round((now - t.presentSince) / 1000) });
  stats.lastDetectAt = now;
  if (mode === 'test' && !settings.sendInTest) {
    addLog(`${name}がまだいます（${bestName}・${lasted}）。テスト中なので通知は送りません`, 'detect');
    return;
  }
  if (dailyCount() >= DAILY_CAP - REMIND_RESERVE) {
    if (!t.capLogged) {
      t.capLogged = true;
      addLog('今日の通知が多いので、映り続けているあいだの通知はここで止めます（新しく来たときだけ通知します）', 'warn');
    }
    return;
  }
  let blob = null;
  let thumb = null;
  try {
    blob = await makeSnapshot(src, hits, REMIND_PHOTO_WIDTH);
    thumb = URL.createObjectURL(blob);
  } catch (e) {
    console.warn(e);
  }
  t.lastNotified = now;
  addLog(`${name}がまだいます（${bestName}・${lasted}）。通知を送ります`, 'detect', thumb);
  enqueue({
    title: `${name}がまだいます（${bestName}・${lasted}）`,
    message: `${fmtTime(now)}：${name}が映り続けています（${bestName}・${lasted}・確からしさ ${best.split('・')[1]}）${rec ? '。カメラ側で録画しています' : ''}`,
    tags: GROUPS[label].tag,
    priority: 4,
    blob,
    filename: `${label}-${stamp(now)}.jpg`,
  });
}

// ---------- 見る側（A）への知らせ ----------
// 判定のたびに、枠の位置を送る（位置は映像全体を1とした割合）
let lastDetsSentEmpty = true;
function sendDets(sw, sh) {
  if (!cameraLink?.viewers()) return;
  const round = (v) => Math.round(v * 10000) / 10000;
  const list = lastDets.map((d) => ({
    label: d.label, name: labelJa(d.label), score: Math.round(d.score * 100) / 100,
    x: round(d.x / sw), y: round(d.y / sh), w: round(d.w / sw), h: round(d.h / sh),
    ok: d.score >= settings.threshold,  // 実線の枠にするか（通知の基準を超えたか）
  }));
  if (!list.length && lastDetsSentEmpty) return;
  lastDetsSentEmpty = !list.length;
  cameraLink.send({ t: 'dets', list });
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
// 来た（arrive）／まだいる（still）／いなくなった（gone）を送る。ntfy への通知とは別に、見ている人には必ず届ける
function sendEvent(kind, group, hits, src, extra = {}) {
  if (!cameraLink?.viewers()) return;
  const msg = { t: 'event', kind, group, at: Date.now(), ...extra };
  if (hits?.length) {
    const b = hits.reduce((a, h) => (h.score > a.score ? h : a));
    msg.name = labelJa(b.label);
    msg.pct = Math.round(b.score * 100);
  }
  const link = cameraLink;
  let photo = null;
  const done = () => {
    if (cameraLink !== link) return;
    // データ通信（JSON）は1回16KBまで。写真は10KBずつに分けて、知らせの直後に送る
    if (photo) {
      const n = Math.ceil(photo.length / PHOTO_PART);
      msg.photoId = ++photoSeq;
      msg.photoParts = n;
      link.send(msg);
      for (let i = 0; i < n; i++) link.send({ t: 'photo', id: msg.photoId, i, data: photo.slice(i * PHOTO_PART, (i + 1) * PHOTO_PART) });
    } else {
      link.send(msg);
    }
  };
  if (kind === 'gone' || !src) { done(); return; }
  // 小さな写真（幅320px・約20〜30KB）をつける
  makeSnapshot(src, hits, 320).then(blobToDataUrl).then((url) => { photo = url; }).catch(() => {}).then(done);
}
const PHOTO_PART = 10_000;
let photoSeq = 0;

// ---------- 通知用の写真 ----------
async function makeSnapshot(src, hits, width = SNAPSHOT_WIDTH) {
  const [sw, sh] = sourceSize(src);
  const k = Math.min(1, width / sw);
  const w = Math.round(sw * k);
  const h = Math.round(sh * k);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0, w, h);
  applyLut(g, w, h, boostGain);
  const lw = Math.max(2, Math.round(w / 220));
  const r = settings.roi;
  if (!isFullRoi(r)) {
    g.setLineDash([lw * 4, lw * 3]);
    g.lineWidth = lw;
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.strokeRect(r.x * w, r.y * h, r.w * w, r.h * h);
    g.setLineDash([]);
  }
  const th = Math.max(16, Math.round(w / 22));
  g.textBaseline = 'middle';
  g.font = `bold ${Math.round(th * 0.7)}px system-ui, sans-serif`;
  for (const d of hits) {
    const x = d.x * k;
    const y = d.y * k;
    g.lineWidth = lw + 1;
    g.strokeStyle = '#ff7a1a';
    g.strokeRect(x, y, d.w * k, d.h * k);
    const text = `${labelJa(d.label)} ${Math.round(d.score * 100)}%`;
    const tw = g.measureText(text).width + th * 0.6;
    const ty = y - th >= 0 ? y - th : y;
    g.fillStyle = '#ff7a1a';
    g.fillRect(x, ty, tw, th);
    g.fillStyle = '#1a0d05';
    g.fillText(text, x + th * 0.3, ty + th / 2);
  }
  const ts = new Date().toLocaleString('ja-JP');
  g.font = `${Math.round(th * 0.6)}px system-ui, sans-serif`;
  const tsw = g.measureText(ts).width + th * 0.6;
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, h - th, tsw, th);
  g.fillStyle = '#ffffff';
  g.fillText(ts, th * 0.3, h - th / 2);
  return toJpeg(c);
}
async function makeTestCard() {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 360;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 640, 360);
  grad.addColorStop(0, '#ff9a3c');
  grad.addColorStop(1, '#d9480f');
  g.fillStyle = grad;
  g.fillRect(0, 0, 640, 360);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 44px system-ui, sans-serif';
  g.fillText('テスト通知', 320, 150);
  g.font = '24px system-ui, sans-serif';
  g.fillText(new Date().toLocaleString('ja-JP'), 320, 215);
  return toJpeg(c);
}

// ---------- 通知の送信（ntfy） ----------
const queue = [];
let sending = false;
let retryTimer = null;

function enqueue(msg) {
  dailyInc();
  queue.push(msg);
  while (queue.length > QUEUE_MAX) queue.shift();
  updateStatus();
  flushQueue();
}
async function sendNtfy(m) {
  const url = new URL(`${settings.server}/${encodeURIComponent(settings.topic)}`);
  // 日本語はヘッダーに入れられないので、URLのパラメータで渡す
  url.searchParams.set('title', m.title);
  if (m.tags) url.searchParams.set('tags', m.tags);
  if (m.priority) url.searchParams.set('priority', String(m.priority));
  let body = m.message;
  if (m.blob) {
    url.searchParams.set('message', m.message);
    url.searchParams.set('filename', m.filename);
    body = m.blob;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url.toString(), { method: m.blob ? 'PUT' : 'POST', body, signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch { /* 本文なし */ }
      const err = new Error(`HTTP ${res.status}${detail ? '：' + detail : ''}`);
      err.status = res.status;
      throw err;
    }
    return await res.json().catch(() => ({}));
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('時間切れ');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
async function flushQueue() {
  if (sending || !queue.length) return;
  sending = true;
  clearTimeout(retryTimer);
  retryTimer = null;
  let delay = 0;
  try {
    while (queue.length) {
      const m = queue[0];
      try {
        await sendNtfy(m);
      } catch (e) {
        if (e.status >= 400 && e.status < 500 && e.status !== 429) {
          if (m.blob) {
            // 写真が大きすぎるなどで断られたときは、写真なしの文字だけで送り直す
            m.blob = null;
            addLog(`写真つきで送れなかったので（${errText(e)}）、文字だけで送り直します`, 'warn');
            continue;
          }
          queue.shift();
          addLog(`通知を送れませんでした（${errText(e)}）。この通知は取り消しました`, 'error');
          continue;
        }
        delay = e.status === 429 ? RATE_LIMIT_RETRY_MS : RETRY_MS;
        if (!stats.failing) addLog(`通知を送れませんでした（${errText(e)}）。${delay / 1000}秒ごとに送り直します`, 'error');
        stats.failing = true;
        break;
      }
      queue.shift();
      if (stats.failing) addLog('通信が戻りました', 'ok');
      stats.failing = false;
      stats.net = 'ok';
      addLog(`通知を送りました：${m.title}`, 'ok');
    }
  } finally {
    sending = false;
    if (delay) retryTimer = setTimeout(flushQueue, delay);
    updateStatus();
  }
}
// 開始・再開・再開失敗のお知らせ。種類ごとに一定時間に1回まで
function notifySystem({ title, message, key = 'lastSystemAt', gap = SYSTEM_GAP_MS, tags = 'eyes', priority = 3 }) {
  const last = load(key, 0);
  if (Date.now() - last < gap || dailyCount() >= DAILY_CAP) return;
  save(key, Date.now());
  enqueue({ title, message, tags, priority });
}
function notifyResumeFailed(reason) {
  notifySystem({
    title: '見張りを再開できませんでした',
    message: `${reason}（${fmtTime(Date.now())}）。カメラ側のiPhoneを確認してください`,
    key: 'lastFailAt', gap: 10 * 60_000, tags: 'warning', priority: 4,
  });
}
window.addEventListener('online', () => { updateStatus(); flushQueue(); });
window.addEventListener('offline', updateStatus);

// ---------- 録画（見つけている間だけ。B本体の IndexedDB に保存） ----------
const recMime = (() => {
  if (!('MediaRecorder' in window)) return null;
  for (const m of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* 次の形式を試す */ }
  }
  return '';
})();
const recSupported = recMime !== null;
let rec = null;          // 録画中の情報
let recCanvas = null;    // テストのとき、画像・動画を録画するためのキャンバス
let recCtx = null;
let recWarned = false;

function startOrExtendRecording(label) {
  if (!settings.record || mode === 'idle') return;
  if (rec) { rec.labels.add(label); return; }
  startRecording([label]);
}
function recordingStream() {
  const canCanvas = !!HTMLCanvasElement.prototype.captureStream;
  // 明るさ補正がオンのカメラ映像は、補正したあとの映像をキャンバス経由で録画する（少し画質は下がる）
  if (mode === 'camera' && !(settings.boost !== 'off' && canCanvas)) return stream;
  if (!canCanvas || (mode !== 'test' && mode !== 'camera')) return null;
  const src = activeSource();
  if (!sourceReady(src)) return null;
  const [sw, sh] = sourceSize(src);
  const k = Math.min(1, (mode === 'camera' ? 960 : 1280) / sw);
  recCanvas = document.createElement('canvas');
  recCanvas.width = Math.round(sw * k);
  recCanvas.height = Math.round(sh * k);
  recCtx = recCanvas.getContext('2d', { willReadFrequently: true });
  drawRecCanvas();
  return recCanvas.captureStream(mode === 'camera' ? 15 : 10);
}
function drawRecCanvas() {
  const src = activeSource();
  if (!recCtx || !sourceReady(src)) return;
  recCtx.drawImage(src, 0, 0, recCanvas.width, recCanvas.height);
  applyLut(recCtx, recCanvas.width, recCanvas.height, boostGain);
}
function startRecording(labels) {
  if (rec) return;
  if (!recSupported) {
    if (!recWarned) addLog('このブラウザは録画に対応していません（通知はこれまでどおり届きます）', 'warn');
    recWarned = true;
    return;
  }
  const s = recordingStream();
  if (!s) return;
  let recorder;
  try {
    recorder = new MediaRecorder(s, { ...(recMime ? { mimeType: recMime } : {}), videoBitsPerSecond: REC_BITRATE });
  } catch (e) {
    reportError('録画を始められませんでした', e);
    return;
  }
  const r = { recorder, chunks: [], startedAt: Date.now(), endedAt: 0, labels: new Set(labels), viaCanvas: mode === 'test', finished: false };
  recorder.addEventListener('dataavailable', (ev) => { if (ev.data && ev.data.size) r.chunks.push(ev.data); });
  recorder.addEventListener('stop', () => finishRecording(r));
  recorder.addEventListener('error', (ev) => reportError('録画中にエラーが起きました', ev.error || ev));
  try {
    recorder.start();
  } catch (e) {
    reportError('録画を始められませんでした', e);
    return;
  }
  rec = r;
  // カメラ映像をキャンバス経由で録画するときは、録画用の絵を1秒に約15回描き直す
  if (mode === 'camera' && s !== stream) r.drawTimer = setInterval(drawRecCanvas, 1000 / 15);
  addLog(`録画を始めました（${targetNames(labels)}）`, 'info');
  updateStatus();
}
function stopRecording() {
  const r = rec;
  if (!r) return;
  rec = null;
  r.endedAt = Date.now();
  clearInterval(r.drawTimer);
  try {
    if (r.recorder.state !== 'inactive') r.recorder.stop();
    else finishRecording(r);
  } catch {
    finishRecording(r);
  }
  updateStatus();
}
function checkRecordingEnd(now) {
  if (!rec) return;
  // 通知と同じ基準（判定の厳しさ）で見つからなくなってから、決めた秒数がたったら止める
  const lastSeen = Math.max(0, ...settings.targets.map((l) => trackers[l]?.lastSeen || 0));
  if (now - lastSeen >= settings.recGraceSec * 1000) {
    stopRecording();
  } else if (now - rec.startedAt >= REC_MAX_MS) {
    // 長くなったら区切って、続きを新しいファイルに録る
    const labels = [...rec.labels];
    stopRecording();
    startRecording(labels);
  }
}
async function finishRecording(r) {
  if (r.finished) return;
  r.finished = true;
  clearInterval(r.drawTimer);
  if (rec === r) rec = null;
  if (!r.endedAt) r.endedAt = Date.now();
  const type = r.recorder.mimeType || recMime || 'video/mp4';
  const blob = new Blob(r.chunks, { type });
  r.chunks = [];
  updateStatus();
  if (!blob.size) {
    addLog('録画が空だったので保存しませんでした', 'warn');
    return;
  }
  const clip = { id: String(r.startedAt), startedAt: r.startedAt, endedAt: r.endedAt, labels: [...r.labels], type, size: blob.size, blob };
  try {
    await saveClip(clip);
    addLog(`録画を保存しました（${fmtDuration(clip.endedAt - clip.startedAt)}・${fmtSize(blob.size)}）`, 'ok');
  } catch (e) {
    reportError('録画を保存できませんでした', e);
  }
  renderClips();
}

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('catAlert', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('clips', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}
async function clipsAll() {
  const db = await openDb();
  const list = await new Promise((resolve, reject) => {
    const req = db.transaction('clips', 'readonly').objectStore('clips').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  return list.sort((a, b) => b.startedAt - a.startedAt);
}
async function clipsWrite(fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('clips', 'readwrite');
    fn(tx.objectStore('clips'));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('保存が中断されました'));
  });
}
async function saveClip(clip) {
  try {
    await clipsWrite((s) => s.put(clip));
  } catch (e) {
    if (e?.name !== 'QuotaExceededError') throw e;
    const old = (await clipsAll()).reverse().slice(0, 3);
    if (!old.length) throw e;
    await clipsWrite((s) => old.forEach((c) => s.delete(c.id)));
    addLog(`保存容量が足りないので、古い録画を${old.length}本削除しました`, 'warn');
    await clipsWrite((s) => s.put(clip));
  }
  // 上限（本数・合計サイズ）を超えた古い録画を消す
  const list = await clipsAll();
  let total = 0;
  const remove = list.filter((c, i) => { total += c.size; return i >= REC_MAX_COUNT || total > REC_STORE_LIMIT; });
  if (remove.length) {
    await clipsWrite((s) => remove.forEach((c) => s.delete(c.id)));
    addLog(`上限を超えたので、古い録画を${remove.length}本削除しました`, 'info');
  }
}

let clipUrls = [];
async function renderClips() {
  let list;
  try {
    list = await clipsAll();
  } catch {
    els.clipsInfo.textContent = '録画の保存場所を使えません';
    return;
  }
  pushClips();  // 見ている人にも、録画が増えた・減ったことを知らせる
  clipUrls.forEach((u) => URL.revokeObjectURL(u));
  clipUrls = [];
  els.clips.textContent = '';
  const total = list.reduce((sum, c) => sum + c.size, 0);
  els.clipsInfo.textContent = list.length ? `${list.length}本・${fmtSize(total)}` : '';
  els.clipsClear.hidden = !list.length;
  for (const c of list) {
    const li = document.createElement('li');
    const title = document.createElement('div');
    title.className = 'clip-title';
    title.textContent = `${fmtDateTime(c.startedAt)}　${targetNames(c.labels) || '—'}・${fmtDuration(c.endedAt - c.startedAt)}・${fmtSize(c.size)}`;
    const row = document.createElement('div');
    row.className = 'row';
    const play = document.createElement('button');
    play.className = 'btn small';
    play.textContent = '再生';
    const share = document.createElement('button');
    share.className = 'btn small';
    share.textContent = '保存・共有';
    const del = document.createElement('button');
    del.className = 'btn small';
    del.textContent = '削除';
    row.append(play, share, del);
    li.append(title, row);
    play.addEventListener('click', () => {
      const shown = li.querySelector('video');
      if (shown) {
        shown.pause();
        shown.remove();
        play.textContent = '再生';
        return;
      }
      const url = URL.createObjectURL(c.blob);
      clipUrls.push(url);
      const v = document.createElement('video');
      v.src = url;
      v.controls = true;
      v.playsInline = true;
      v.muted = true;
      v.autoplay = true;
      li.append(v);
      play.textContent = '閉じる';
    });
    share.addEventListener('click', () => shareClip(c));
    del.addEventListener('click', async () => {
      if (!confirm('この録画を削除しますか？')) return;
      try { await clipsWrite((s) => s.delete(c.id)); } catch (e) { reportError('削除できませんでした', e); }
      renderClips();
    });
    els.clips.append(li);
  }
}
async function shareClip(c) {
  const ext = c.type.includes('mp4') ? 'mp4' : 'webm';
  const file = new File([c.blob], `${c.labels[0] || 'clip'}-${stamp(c.startedAt)}.${ext}`, { type: c.type.split(';')[0] });
  // iPhoneでは共有シートから「ビデオを保存」（写真アプリ）やAirDropを選べる
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch (e) { if (e.name !== 'AbortError') reportError('共有できませんでした', e); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
els.clipsClear.addEventListener('click', async () => {
  if (!confirm('録画をすべて削除しますか？')) return;
  try { await clipsWrite((s) => s.clear()); } catch (e) { reportError('削除できませんでした', e); }
  renderClips();
});

// ---------- 3つの操作（見る側からも、このiPhoneのボタンからもできる） ----------
// カメラ切替
let switching = false;
async function switchCamera() {
  if (switching) return { ok: false, msg: 'カメラを切り替え中です。少し待ってください' };
  const prev = settings.facing;
  const next = prev === 'environment' ? 'user' : 'environment';
  const which = next === 'user' ? '前面' : '背面';
  settings.facing = next;
  saveSettings();
  if (!running) {
    addLog(`次からは${which}カメラを使います`, 'info');
    cameraLink?.pushState();
    updateStatus();
    return { ok: true, msg: mode === 'test' ? `テスト中なので、次からは${which}カメラを使います` : `見張りを始めたら${which}カメラを使います` };
  }
  switching = true;
  try {
    await startCamera();  // 古いほうを止めてから開く。成功すると、配信中の映像も差しかえる
    addLog(`${which}カメラに切り替えました`, 'info');
    return { ok: true, msg: '' };
  } catch (e) {
    settings.facing = prev;
    saveSettings();
    const msg = cameraErrorText(e);
    addLog(`カメラを切り替えられませんでした（${msg}）`, 'error');
    scheduleCameraRestart('元のカメラに戻します');
    return { ok: false, msg: `カメラを切り替えられませんでした（${msg}）` };
  } finally {
    switching = false;
    cameraLink?.pushState();
    updateStatus();
  }
}

// フラッシュライト（外カメで、端末が対応しているときだけ）
function cameraTrack() { return mode === 'camera' ? stream?.getVideoTracks()[0] ?? null : null; }
function torchInfo() {
  if (!running && mode !== 'test') return { ok: false, why: '見張りを始めると使えます' };
  const track = cameraTrack();
  // iOS では getSupportedConstraints が当てにならないので、トラックの能力で調べる
  if (!track || !track.getCapabilities || track.getCapabilities().torch !== true) return { ok: false, why: 'この端末ではライトを操作できません' };
  if (settings.facing === 'user') return { ok: false, why: 'ライトは外カメのときだけ使えます' };
  return { ok: true, why: '' };
}
// iOS では getSettings().torch が正しくないことがあるので、ライトの状態は settings.torch に自分で覚えておく
async function applyTorch(on) {
  await cameraTrack().applyConstraints({ advanced: [{ torch: on }] });
}
async function setTorch(on) {
  const info = torchInfo();
  if (!info.ok) return { ok: false, msg: info.why };
  try {
    await applyTorch(on);
  } catch (e) {
    addLog(`ライトを操作できませんでした（${errText(e)}）`, 'error');
    return { ok: false, msg: 'ライトを操作できませんでした' };
  }
  settings.torch = on;
  saveSettings();
  addLog(`ライトを${on ? 'つけました' : '消しました'}`, 'info');
  cameraLink?.pushState();
  updateStatus();
  return { ok: true, msg: '' };
}
async function restoreTorch() {
  if (!settings.torch || !torchInfo().ok) return;
  try { await applyTorch(true); } catch { /* つけ直せなくても続ける */ }
}

// 低光量モード（自動／オン／オフ）。オンのときはコマ数を下げて、シャッターを長く開けさせる
const lowLightFps = () => (settings.boost === 'high' ? 10 : 15);
const LOWLIGHT_TEXT = { auto: '自動', high: 'オン', off: 'オフ' };
async function setLowLight(v) {
  if (!(v in LOWLIGHT_TEXT)) return { ok: false, msg: '低光量モードの値が正しくありません' };
  settings.boost = v;
  saveSettings();
  els.boost.value = v;
  if (v === 'off') { boostGain = 1; setPreviewFilter(); }
  addLog(`低光量モード：${LOWLIGHT_TEXT[v]}`, 'info');
  const track = cameraTrack();
  if (track) track.applyConstraints({ frameRate: lowLightFps() }).catch(() => { /* 端末によっては効かない */ });
  cameraLink?.pushState();
  updateStatus();
  return { ok: true, msg: '' };
}

// ---------- 録画を見る側（A）に見せる ----------
// 一覧（新しい順に30本まで）。データ通信は1回16KBまでなので、一覧は小さく保つ
const CLIP_LIST_MAX = 30;
const CLIP_PART_BYTES = 7_500;      // 1かけら＝7,500バイト（文字にすると約10,000文字）
const CLIP_BUFFER_MAX = 512_000;    // これ以上たまっていたら、送り終わるのを待つ
let clipSendId = null;              // いま送っている録画（新しい依頼が来たら、前のは中止する）
async function clipListMsg() {
  const list = (await clipsAll()).slice(0, CLIP_LIST_MAX).map((c) => ({
    id: c.id, startedAt: c.startedAt, endedAt: c.endedAt, labels: c.labels, size: c.size, type: c.type,
  }));
  return { t: 'cliplist', list };
}
async function pushClips() {
  if (!cameraLink?.viewers()) return;
  try { cameraLink.send(await clipListMsg()); } catch { /* 一覧を送れなくても、見張りは続ける */ }
}
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(s);
}
async function sendClip(id, reply) {
  const token = String(id);
  clipSendId = token;
  const stillWanted = () => clipSendId === token && reply.alive();
  let clip = null;
  try { clip = (await clipsAll()).find((c) => c.id === token); } catch { /* 見つからない扱い */ }
  if (!clip) { reply({ t: 'clipmeta', id: token, ok: false, msg: 'この録画は、もうありません' }); return; }
  const n = Math.ceil(clip.size / CLIP_PART_BYTES);
  reply({ t: 'clipmeta', id: token, ok: true, n, size: clip.size, type: clip.type });
  addLog(`見る側に録画を送ります（${fmtSize(clip.size)}）`, 'info');
  try {
    for (let i = 0; i < n; i++) {
      if (!stillWanted()) { addLog('録画の送信をやめました', 'info'); return; }
      while (reply.buffered() > CLIP_BUFFER_MAX) {
        await new Promise((r) => setTimeout(r, 40));
        if (!stillWanted()) { addLog('録画の送信をやめました', 'info'); return; }
      }
      const buf = await clip.blob.slice(i * CLIP_PART_BYTES, (i + 1) * CLIP_PART_BYTES).arrayBuffer();
      reply({ t: 'clipdata', id: token, i, data: toBase64(new Uint8Array(buf)) });
    }
    addLog('見る側に録画を送り終えました', 'ok');
  } catch (e) {
    reportError('録画を送れませんでした', e);
  } finally {
    if (clipSendId === token) clipSendId = null;
  }
}
async function handleClipMsg(m, reply) {
  if (m.t === 'clips') reply(await clipListMsg());
  else if (m.t === 'clipget') sendClip(m.id, reply);
  else if (m.t === 'clipstop') { if (clipSendId === String(m.id)) clipSendId = null; }
}

// 見る側（A）からの命令を受ける
async function handleCmd(m, reply) {
  if (m.t === 'clips' || m.t === 'clipget' || m.t === 'clipstop') {
    try { await handleClipMsg(m, reply); } catch (e) { reportError('録画の一覧を送れませんでした', e); }
    return;
  }
  const done = (r) => { reply({ t: 'result', id: m.id, ok: r.ok, msg: r.msg || '' }); cameraLink?.pushState(); };
  const label = m.name === 'flip' ? 'カメラ切替' : m.name === 'torch' ? 'ライト' : m.name === 'lowlight' ? '低光量モード' : '不明な命令';
  addLog(`見る側から命令が届きました：${label}`, 'info');
  try {
    if (m.name === 'flip') done(await switchCamera());
    else if (m.name === 'torch') done(await setTorch(m.value === true));
    else if (m.name === 'lowlight') done(await setLowLight(m.value));
    else done({ ok: false, msg: 'この命令には対応していません' });
  } catch (e) {
    done({ ok: false, msg: errText(e) });
  }
}

// ---------- カメラ ----------
let stream = null;
let lastFrameAt = 0;
let restartTimer = null;
let cameraFailing = false;
const hasFrameCallback = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

function watchFrames(s) {
  if (!hasFrameCallback) return;
  const cb = () => {
    lastFrameAt = performance.now();
    if (stream === s) els.cam.requestVideoFrameCallback(cb);
  };
  els.cam.requestVideoFrameCallback(cb);
}
// 画角：iPhone のカメラは 4:3 が全体。16:9 にすると上下が切れて狭くなるので、初期設定は 4:3 にする
const VIEW_SIZE = { normal: { w: 1280, h: 960 }, ultra: { w: 1280, h: 960 }, hd: { w: 1280, h: 720 } };
function videoConstraints(extra = {}) {
  const z = VIEW_SIZE[settings.view];
  // コマ数を15に抑えると、暗いときにシャッターを長く開けられて、少し明るく映る
  return { audio: false, video: { width: { ideal: z.w }, height: { ideal: z.h }, frameRate: { ideal: lowLightFps() }, ...extra } };
}
const gum = (c) => navigator.mediaDevices.getUserMedia(c);
async function openStream() {
  const normal = () => gum(videoConstraints({ facingMode: { ideal: settings.facing } }));
  let s = await normal();
  if (settings.view !== 'ultra' || settings.facing !== 'environment') return s;
  // 超広角：ラベルに「Ultra Wide」「超広角」が付いたカメラを探す（許可を得たあとに、名前が分かる）
  let id = null;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    id = devs.find((d) => d.kind === 'videoinput' && /ultra|超広角/i.test(d.label))?.deviceId ?? null;
  } catch { /* 探せなければ標準のカメラ */ }
  if (!id) { if (!openStream.warned) { openStream.warned = true; addLog('超広角カメラが見つかりません。標準のカメラを使います', 'warn'); } return s; }
  if (s.getVideoTracks()[0]?.getSettings().deviceId === id) return s;
  s.getTracks().forEach((t) => t.stop());  // iPhone は2つのカメラを同時に使えない
  try {
    return await gum(videoConstraints({ deviceId: { exact: id } }));
  } catch (e) {
    addLog(`超広角カメラを開けませんでした（${errText(e)}）。標準のカメラを使います`, 'warn');
    return normal();
  }
}
async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    const e = new Error('insecure');
    e.name = 'InsecureContext';
    throw e;
  }
  stopCamera();
  const s = await openStream();
  stream = s;
  tuneExposure(s);
  els.cam.srcObject = s;
  try { await els.cam.play(); } catch { /* autoplay 属性で再生される */ }
  lastFrameAt = performance.now();
  watchFrames(s);
  s.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (running && stream === s) scheduleCameraRestart('カメラが止まりました。再起動します');
  });
  if (mode === 'camera') syncLink();  // 開き直したら、配信中の映像も差しかえる
  restoreTorch();                     // カメラを開き直すとライトが消えるので、つけ直す
  cameraLink?.pushState();
}
// カメラ本体の露出を明るめにする（端末やブラウザが対応している場合だけ。対応していなければ何もしない）
async function tuneExposure(s) {
  try {
    const track = s.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    const adv = {};
    if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) adv.exposureMode = 'continuous';
    const ec = caps.exposureCompensation;
    if (ec && Number.isFinite(ec.max) && ec.max > 0) adv.exposureCompensation = ec.max * 0.5;
    if (!Object.keys(adv).length) return;
    await track.applyConstraints({ advanced: [adv] });
    if (!tuneExposure.logged) { tuneExposure.logged = true; addLog('カメラの露出を明るめにしました', 'info'); }
  } catch { /* 対応していない */ }
}
function stopCamera() {
  if (rec && !rec.viaCanvas) stopRecording();  // カメラを止める前に、録画中の分を保存する
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  els.cam.srcObject = null;
}
function checkCameraAlive() {
  if (!running || !hasFrameCallback || document.visibilityState !== 'visible') return;
  if (performance.now() - lastFrameAt > 10_000) {
    lastFrameAt = performance.now();
    scheduleCameraRestart('映像が止まっているので、カメラを再起動します');
  }
}
function scheduleCameraRestart(reason) {
  if (restartTimer || !running) return;
  if (!cameraFailing) addLog(reason, 'warn');
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    if (!running) return;
    try {
      await startCamera();
      cameraFailing = false;
      addLog('カメラを再起動しました', 'ok');
    } catch (e) {
      if (!cameraFailing) addLog(`カメラを再起動できませんでした（${cameraErrorText(e)}）。5秒ごとに試します`, 'error');
      cameraFailing = true;
      scheduleCameraRestart('');
    }
  }, cameraFailing ? 5000 : 2000);
}
function cameraErrorText(e) {
  switch (e?.name) {
    case 'InsecureContext': return 'このページは https:// で開く必要があります';
    case 'NotAllowedError':
    case 'SecurityError': return 'カメラの使用が許可されていません。Safariの設定で、このサイトのカメラを「許可」にしてください';
    case 'NotFoundError':
    case 'OverconstrainedError': return 'カメラが見つかりません';
    case 'NotReadableError':
    case 'AbortError': return 'カメラを使えません（ほかのアプリが使っている可能性があります）';
    default: return errText(e);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !running) return;
  if (!wake.held()) requestWakeLock();
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState !== 'live') scheduleCameraRestart('画面に戻ったので、カメラを再起動します');
  else lastFrameAt = performance.now();
  flushQueue();
});

// ---------- 画面スリープ防止 ----------
const wake = createWakeLock({
  isWanted: () => running || starting,
  onChange: (text) => { stats.wake = text; updateStatus(); },
});
const requestWakeLock = wake.request;
const releaseWakeLock = wake.release;

// ---------- 見張りの開始・停止 ----------
async function startMonitoring({ resumed = false } = {}) {
  if (running || starting) return;
  starting = true;
  updateButtons();
  try {
    if (mode === 'test') endTest();
    if (!isValidTopic(settings.topic)) {
      addLog('トピック名が正しくありません。設定を確認してください', 'error');
      els.settingsBox.open = true;
      return;
    }
    setBadge('起動中…');
    try {
      await startCamera();
    } catch (e) {
      const msg = cameraErrorText(e);
      addLog(`カメラを起動できませんでした（${msg}）`, 'error');
      setBadge('カメラを使えません', 'error');
      showStageMsg(msg + (resumed ? '\n「見張りを始める」を押すと再開します' : ''));
      releaseWakeLock();
      if (resumed) notifyResumeFailed(`カメラを起動できません：${msg}`);
      return;
    }
    mode = 'camera';
    showSource();
    hideStageMsg();
    syncLink();
    try {
      await ensureDetector();
    } catch (e) {
      console.error(e);
      addLog(`AIを読み込めませんでした（${errText(e)}）。通信状態を確認してください`, 'error');
      setBadge('AIを読み込めません', 'error');
      stopCamera();
      releaseWakeLock();
      mode = 'idle';
      syncLink();
      showSource();
      showStageMsg(IDLE_MSG);
      if (resumed) notifyResumeFailed('AIを読み込めません');
      return;
    }
    running = true;
    cameraFailing = false;
    save('running', true);
    resetTrackers();
    lastDets = [];
    if (!wake.held()) await requestWakeLock();
    startLoop();
    setBadge('見張り中', 'run');
    addLog(resumed ? '見張りを再開しました' : '見張りを始めました', 'ok');
    notifySystem({
      title: resumed ? '見張りを再開しました' : '見張りを始めました',
      message: `対象：${targetNames(settings.targets)}（${fmtTime(Date.now())}）`,
    });
  } finally {
    starting = false;
    updateButtons();
    updateStatus();
  }
}
function stopMonitoring() {
  stopRecording();
  running = false;
  save('running', false);
  stopLoop();
  clearTimeout(restartTimer);
  restartTimer = null;
  stopCamera();
  releaseWakeLock();
  mode = 'idle';
  syncLink();
  lastDets = [];
  resetTrackers();
  boostGain = 1;
  setPreviewFilter();
  showSource();
  setBadge('待機中');
  showStageMsg(IDLE_MSG);
  addLog('見張りを止めました', 'info');
  updateButtons();
  updateStatus();
}

// ---------- ライブ映像の配信（見る側へ） ----------
// 見張り中（またはテスト中）だけ PeerJS につなぎ、見る人が来たら映像を送る。判定・通知・録画は配信と関係なく動く
let cameraLink = null;
let linkTopic = '';
let linkStarting = false;
let liveCanvas = null;   // テスト中の配信用：テスト映像を描くキャンバス
let liveTrack = null;
let liveTimer = null;
function testLiveTrack() {
  if (liveTrack) return liveTrack;
  if (!HTMLCanvasElement.prototype.captureStream) return null;
  liveCanvas = document.createElement('canvas');
  liveCanvas.width = 640;
  liveCanvas.height = 360;
  liveTrack = liveCanvas.captureStream(15).getVideoTracks()[0];
  liveTimer = setInterval(drawLive, 1000 / 15);
  return liveTrack;
}
function drawLive() {
  const src = activeSource();
  if (mode !== 'test' || !liveCanvas || !sourceReady(src)) return;
  const [sw, sh] = sourceSize(src);
  const k = Math.min(1, 1280 / sw);
  const w = Math.round(sw * k);
  const h = Math.round(sh * k);
  if (liveCanvas.width !== w || liveCanvas.height !== h) { liveCanvas.width = w; liveCanvas.height = h; }
  liveCanvas.getContext('2d').drawImage(src, 0, 0, w, h);
}
function stopLiveCanvas() {
  clearInterval(liveTimer);
  liveTimer = null;
  liveTrack?.stop();
  liveTrack = null;
  liveCanvas = null;
}
function currentLiveTrack() {
  if (mode === 'camera') return stream?.getVideoTracks()[0] ?? null;
  if (mode === 'test') return testLiveTrack();
  return null;
}
function linkState() {
  const t = torchInfo();
  return {
    facing: settings.facing, running, testing: mode === 'test', rec: !!rec, groups: settings.targets,
    torch: settings.torch && t.ok, torchOk: t.ok, torchWhy: t.why,
    lowLight: settings.boost, gain: Number(boostGain.toFixed(2)),
  };
}
function closeLink() {
  cameraLink?.close();
  cameraLink = null;
  stats.viewers = 0;
  stats.linkDown = false;
  updateStatus();
}
async function syncLink() {
  if (mode !== 'test') stopLiveCanvas();
  const want = (mode === 'camera' || mode === 'test') && isValidTopic(settings.topic);
  if (!want) { closeLink(); return; }
  if (cameraLink && linkTopic !== settings.topic) closeLink();
  if (!cameraLink) {
    if (linkStarting) return;  // 作っている途中。できあがったら、そのときの映像を渡す
    linkStarting = true;
    try {
      const { createCameraLink } = await import('./link.js');
      if (cameraLink || !(mode === 'camera' || mode === 'test')) return;  // 待っている間に状況が変わった
      linkTopic = settings.topic;
      cameraLink = createCameraLink({
        topic: settings.topic,
        getState: linkState,
        onMessage: handleCmd,
        onViewers: (n) => { stats.viewers = n; updateStatus(); },
        onStatus: (code) => { stats.linkDown = code === 'server-down'; updateStatus(); },
      });
    } catch (e) {
      reportError('映像をつなぐ準備ができませんでした', e);
      return;
    } finally {
      linkStarting = false;
    }
  }
  cameraLink.setTrack(currentLiveTrack());
  updateStatus();
}

// ---------- ファイルでテスト ----------
els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  if (file) startTestFile(file);
});
async function startTestFile(file) {
  if (running) stopMonitoring();
  stopLoop();
  const entering = mode !== 'test';
  if (testUrl) URL.revokeObjectURL(testUrl);
  testUrl = URL.createObjectURL(file);
  testKind = file.type.startsWith('video/') ? 'video' : 'image';
  mode = 'test';
  syncLink();
  // 読み込みの完了は待たない（判定ループが表示できるようになった時点から処理する）
  if (testKind === 'video') {
    els.testImg.removeAttribute('src');
    els.testVid.src = testUrl;
    els.testVid.play().catch(() => { /* 自動再生できなくても、読み込めれば判定は進む */ });
  } else {
    els.testVid.pause();
    els.testVid.removeAttribute('src');
    els.testImg.src = testUrl;
  }
  showSource();
  hideStageMsg();
  els.testEnd.hidden = false;
  if (entering) {
    resetTrackers();
    addLog(`テストを始めました：${file.name}`, 'info');
  } else {
    addLog(`テスト用のファイルを切り替えました：${file.name}`, 'info');
  }
  setBadge('テスト中', 'run');
  try {
    await ensureDetector();
  } catch (e) {
    console.error(e);
    addLog(`AIを読み込めませんでした（${errText(e)}）`, 'error');
    setBadge('AIを読み込めません', 'error');
    return;
  }
  if (mode === 'test') startLoop();
  updateStatus();
}
// パソコンでのテスト用：?test=ファイル名 で test/ の写真・動画を読み込む（localhost のときだけ）
(async function loadTestFromUrl() {
  const name = new URLSearchParams(location.search).get('test');
  if (!name) return;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;
  if (!/^[-_.A-Za-z0-9]{1,80}$/.test(name)) { addLog('?test= のファイル名が正しくありません', 'error'); return; }
  try {
    const res = await fetch(`test/${name}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], name, { type: blob.type || (/\.(mp4|webm|mov)$/i.test(name) ? 'video/mp4' : 'image/jpeg') });
    await startTestFile(file);
  } catch (e) {
    reportError(`テスト用ファイル ${name} を読み込めませんでした`, e);
  }
})();
function endTest() {
  stopRecording();
  stopLoop();
  els.testVid.pause();
  els.testVid.removeAttribute('src');
  els.testImg.removeAttribute('src');
  if (testUrl) { URL.revokeObjectURL(testUrl); testUrl = null; }
  testKind = null;
  mode = 'idle';
  syncLink();
  lastDets = [];
  resetTrackers();
  boostGain = 1;
  setPreviewFilter();
  els.fileInput.value = '';
  els.testEnd.hidden = true;
  showSource();
  setBadge('待機中');
  showStageMsg(IDLE_MSG);
  updateStatus();
}
els.testEnd.addEventListener('click', () => { endTest(); addLog('テストを終えました', 'info'); });
function onTestFileError() {
  if (mode === 'test') addLog('このファイルは表示できませんでした。JPEG・PNG・MP4などで試してください', 'error');
}
els.testImg.addEventListener('error', onTestFileError);
els.testVid.addEventListener('error', onTestFileError);

// ---------- 映像の上の表示（枠・範囲） ----------
const octx = els.overlay.getContext('2d');
let roiEditing = false;
let dragStart = null;
let dragRect = null;

function layoutOverlay() {
  const r = els.stage.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (els.overlay.width !== w || els.overlay.height !== h) {
    els.overlay.width = w;
    els.overlay.height = h;
  }
  drawOverlay();
}
function contentRect() {
  const src = activeSource();
  if (!sourceReady(src)) return null;
  const [sw, sh] = sourceSize(src);
  const W = els.overlay.width;
  const H = els.overlay.height;
  const s = Math.min(W / sw, H / sh);
  return { x: (W - sw * s) / 2, y: (H - sh * s) / 2, s, sw, sh };
}
function drawOverlay() {
  const W = els.overlay.width;
  const H = els.overlay.height;
  octx.clearRect(0, 0, W, H);
  const cr = contentRect();
  if (!cr) return;
  const u = W / (els.stage.clientWidth || W);   // CSSピクセル → キャンバスの倍率
  const cw = cr.sw * cr.s;
  const chh = cr.sh * cr.s;
  const roi = dragRect || settings.roi;
  if (!isFullRoi(roi) || roiEditing) {
    const rx = cr.x + roi.x * cw;
    const ry = cr.y + roi.y * chh;
    const rw = roi.w * cw;
    const rh = roi.h * chh;
    octx.fillStyle = 'rgba(0,0,0,0.45)';
    octx.fillRect(cr.x, cr.y, cw, ry - cr.y);
    octx.fillRect(cr.x, ry + rh, cw, cr.y + chh - (ry + rh));
    octx.fillRect(cr.x, ry, rx - cr.x, rh);
    octx.fillRect(rx + rw, ry, cr.x + cw - (rx + rw), rh);
    octx.setLineDash([8 * u, 6 * u]);
    octx.lineWidth = 2 * u;
    octx.strokeStyle = '#ffffff';
    octx.strokeRect(rx, ry, rw, rh);
    octx.setLineDash([]);
  }
  octx.font = `bold ${Math.round(14 * u)}px system-ui, sans-serif`;
  octx.textBaseline = 'middle';
  for (const d of lastDets) {
    const x = cr.x + d.x * cr.s;
    const y = cr.y + d.y * cr.s;
    const strong = d.score >= settings.threshold;
    octx.lineWidth = (strong ? 3 : 2) * u;
    octx.strokeStyle = strong ? '#ff7a1a' : 'rgba(255,255,255,0.75)';
    octx.setLineDash(strong ? [] : [6 * u, 5 * u]);
    octx.strokeRect(x, y, d.w * cr.s, d.h * cr.s);
    octx.setLineDash([]);
    const text = `${labelJa(d.label)} ${Math.round(d.score * 100)}%`;
    const tw = octx.measureText(text).width + 10 * u;
    const th = 20 * u;
    const ty = y - th >= 0 ? y - th : y;
    octx.fillStyle = strong ? '#ff7a1a' : 'rgba(0,0,0,0.6)';
    octx.fillRect(x, ty, tw, th);
    octx.fillStyle = strong ? '#1a0d05' : '#ffffff';
    octx.fillText(text, x + 5 * u, ty + th / 2);
  }
  if (roiEditing && !dragRect) {
    const hint = '指でなぞって、見張る範囲を描いてください';
    octx.font = `bold ${Math.round(14 * u)}px system-ui, sans-serif`;
    const tw = octx.measureText(hint).width + 16 * u;
    const th = 28 * u;
    const hy = 8 * u;
    octx.fillStyle = 'rgba(0,0,0,0.75)';
    octx.fillRect((W - tw) / 2, hy, tw, th);
    octx.fillStyle = '#ffffff';
    octx.textAlign = 'center';
    octx.textBaseline = 'middle';
    octx.fillText(hint, W / 2, hy + th / 2);
    octx.textAlign = 'start';
  }
}
window.addEventListener('resize', layoutOverlay);
if ('ResizeObserver' in window) new ResizeObserver(layoutOverlay).observe(els.stage);
els.cam.addEventListener('loadedmetadata', layoutOverlay);
els.testVid.addEventListener('loadedmetadata', layoutOverlay);
els.testImg.addEventListener('load', layoutOverlay);

function setRoiEditing(on) {
  roiEditing = on;
  els.overlay.classList.toggle('editing', on);
  els.roiEdit.textContent = on ? '指定をやめる' : '範囲を指定する';
  dragStart = null;
  dragRect = null;
  drawOverlay();
}
function pointToNorm(e) {
  const cr = contentRect();
  if (!cr) return null;
  const rect = els.overlay.getBoundingClientRect();
  const k = els.overlay.width / rect.width;
  const px = (e.clientX - rect.left) * k;
  const py = (e.clientY - rect.top) * k;
  return { x: clamp((px - cr.x) / (cr.sw * cr.s), 0, 1), y: clamp((py - cr.y) / (cr.sh * cr.s), 0, 1) };
}
function rectFrom(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
els.overlay.addEventListener('pointerdown', (e) => {
  if (!roiEditing) return;
  const p = pointToNorm(e);
  if (!p) return;
  dragStart = p;
  dragRect = null;
  els.overlay.setPointerCapture(e.pointerId);
  e.preventDefault();
});
els.overlay.addEventListener('pointermove', (e) => {
  if (!roiEditing || !dragStart) return;
  const p = pointToNorm(e);
  if (!p) return;
  dragRect = rectFrom(dragStart, p);
  drawOverlay();
  e.preventDefault();
});
els.overlay.addEventListener('pointerup', (e) => {
  if (!roiEditing || !dragStart) return;
  const r = rectFrom(dragStart, pointToNorm(e) || dragStart);
  dragStart = null;
  dragRect = null;
  if (r.w >= 0.05 && r.h >= 0.05) {
    settings.roi = r;
    saveSettings();
    renderRoiText();
    setRoiEditing(false);
    addLog('見張る範囲を設定しました', 'info');
  } else {
    drawOverlay();
    addLog('範囲が小さすぎます。もう少し大きく描いてください', 'warn');
  }
});
els.overlay.addEventListener('pointercancel', () => { dragStart = null; dragRect = null; drawOverlay(); });

// ---------- 省電力表示 ----------
let lastTap = 0;
function updateDim() {
  if (els.dim.hidden) return;
  const present = settings.targets.filter((l) => trackers[l]?.present);
  els.dimState.textContent = mode === 'camera' && running
    ? (present.length ? `${targetNames(present)}を検知中` : '見張り中')
    : mode === 'test' ? 'テスト中' : '止まっています';
  els.dimSub.textContent = `最後の検知 ${stats.lastDetectAt ? fmtTime(stats.lastDetectAt) : '—'}・今日の通知 ${dailyCount()}件` +
    (rec ? '・● 録画中' : '') + (stats.failing ? '・送信失敗あり' : '');
  // 画面の焼き付きを防ぐため、1分ごとに文字の位置を少しずらす
  const m = new Date().getMinutes();
  els.dimInfo.style.transform = `translate(${(m % 5) * 8 - 16}px, ${(Math.floor(m / 5) % 5) * 10 - 20}px)`;
}
els.dimBtn.addEventListener('click', () => { els.dim.hidden = false; updateDim(); });
els.dim.addEventListener('click', () => {
  const now = Date.now();
  if (now - lastTap < 450) els.dim.hidden = true;
  lastTap = now;
});
setInterval(updateDim, 5000);

// ---------- 設定画面 ----------
function renderRoiText() {
  els.roiText.textContent = isFullRoi(settings.roi) ? '現在：画面全体'
    : `現在：画面の約${Math.round(settings.roi.w * settings.roi.h * 100)}%`;
}
function renderThreshold() { els.thresholdVal.textContent = `${Math.round(settings.threshold * 100)}%以上`; }
function renderSettings() {
  els.topic.value = settings.topic;
  els.targetBoxes.forEach((b) => { b.checked = settings.targets.includes(b.value); });
  els.threshold.value = String(settings.threshold);
  renderThreshold();
  els.model.value = settings.model;
  els.fps.value = String(settings.fps);
  els.absentSec.value = String(settings.absentSec);
  els.minIntervalSec.value = String(settings.minIntervalSec);
  els.repeatSec.value = String(settings.repeatSec);
  els.gpu.checked = settings.gpu;
  els.server.value = settings.server;
  els.sendInTest.checked = settings.sendInTest;
  els.record.checked = settings.record;
  els.recGraceSec.value = String(settings.recGraceSec);
  els.boost.value = settings.boost;
  els.view.value = settings.view;
  renderRoiText();
}
els.topic.addEventListener('change', () => {
  const v = els.topic.value.trim();
  if (!isValidTopic(v)) {
    addLog('トピック名は、半角の英数字・ハイフン・アンダーバーで64文字以内にしてください', 'error');
    els.topic.value = settings.topic;
    return;
  }
  if (v.length < 12) addLog('トピック名が短いと他人に推測されやすくなります。12文字以上をおすすめします', 'warn');
  settings.topic = v;
  saveSettings();
  syncLink();
  addLog('トピック名を変更しました。Aのntfyアプリでも同じ名前を購読してください', 'info');
});
els.topicCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(settings.topic);
    addLog('トピック名をコピーしました', 'ok');
  } catch {
    els.topic.select();
    addLog('コピーできませんでした。入力欄を長押ししてコピーしてください', 'warn');
  }
});
// 見る側（A）の招待リンク：開くと、役割が「見る側」になり、合言葉が入る
function inviteUrl() { return `${location.origin}${location.pathname}#pair=${settings.topic}`; }
els.topicShare.addEventListener('click', async () => {
  const url = inviteUrl();
  if (navigator.share) {
    try { await navigator.share({ title: '猫アラート（見る側）', text: '猫アラートの見る側の招待リンクです', url }); } catch { /* 共有をやめた */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    addLog('見る側の招待リンクをコピーしました', 'ok');
  } catch {
    addLog(`コピーできませんでした。次のリンクを送ってください：${url}`, 'warn');
  }
});
els.topicNew.addEventListener('click', () => {
  if (!confirm('新しいトピック名を作りますか？ Aのntfyアプリで購読し直す必要があります。')) return;
  settings.topic = randomTopic();
  saveSettings();
  syncLink();
  renderSettings();
  addLog('新しいトピック名を作りました。Aのntfyアプリで購読し直してください', 'info');
});
els.targetBoxes.forEach((b) => b.addEventListener('change', () => {
  const sel = els.targetBoxes.filter((x) => x.checked).map((x) => x.value);
  if (!sel.length) {
    b.checked = true;
    addLog('見つける対象は1つ以上選んでください', 'warn');
    return;
  }
  settings.targets = sel;
  saveSettings();
  for (const k of Object.keys(trackers)) if (!sel.includes(k)) delete trackers[k];
  addLog(`見つける対象：${targetNames(sel)}`, 'info');
  updateStatus();
}));
els.threshold.addEventListener('input', () => {
  settings.threshold = Number(els.threshold.value);
  renderThreshold();
  saveSettings();
  drawOverlay();
});
els.model.addEventListener('change', () => {
  settings.model = els.model.value;
  saveSettings();
  addLog(`AIモデルを「${els.model.selectedOptions[0].textContent}」にしました`, 'info');
});
for (const key of ['fps', 'absentSec', 'minIntervalSec', 'recGraceSec', 'repeatSec']) {
  els[key].addEventListener('change', () => { settings[key] = Number(els[key].value); saveSettings(); });
}
els.view.addEventListener('change', () => {
  settings.view = els.view.value;
  saveSettings();
  addLog(`画角：${els.view.selectedOptions[0].textContent}`, 'info');
  if (running) startCamera().catch((e) => reportError('カメラを開き直せませんでした', cameraErrorText(e)));  // 映像は差しかえで続く
});
els.boost.addEventListener('change', () => { setLowLight(els.boost.value); });
els.record.addEventListener('change', () => {
  settings.record = els.record.checked;
  saveSettings();
  if (!settings.record) stopRecording();
  updateStatus();
});
els.gpu.addEventListener('change', () => { settings.gpu = els.gpu.checked; saveSettings(); });
els.server.addEventListener('change', () => {
  try {
    const u = new URL(els.server.value.trim());
    if (u.protocol !== 'https:') throw new Error('https only');
    settings.server = u.origin + u.pathname.replace(/\/+$/, '');
    saveSettings();
    els.server.value = settings.server;
  } catch {
    addLog('通知サーバーは https:// で始まるアドレスにしてください', 'error');
    els.server.value = settings.server;
  }
});
els.sendInTest.addEventListener('change', () => { settings.sendInTest = els.sendInTest.checked; saveSettings(); });
els.roiEdit.addEventListener('click', () => {
  if (!roiEditing && !contentRect()) {
    addLog('映像が表示されてから範囲を指定してください', 'warn');
    return;
  }
  setRoiEditing(!roiEditing);
  if (roiEditing) els.stage.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
els.roiReset.addEventListener('click', () => {
  settings.roi = { x: 0, y: 0, w: 1, h: 1 };
  saveSettings();
  renderRoiText();
  drawOverlay();
  addLog('見張る範囲を画面全体に戻しました', 'info');
});

// ---------- ボタン ----------
els.startBtn.addEventListener('click', () => {
  requestWakeLock();  // タップした直後に要求する（ブラウザによってはタップ直後でないと許可されない）
  startMonitoring();
});
// 画面スリープ防止が外れていたら、画面に触れたときにかけ直す
document.addEventListener('click', () => { if (running && !wake.held()) requestWakeLock(); });
els.stopBtn.addEventListener('click', () => stopMonitoring());
els.flipBtn.addEventListener('click', () => { switchCamera(); });
els.torchBtn.addEventListener('click', async () => {
  const r = await setTorch(!settings.torch);
  if (!r.ok) addLog(r.msg, 'warn');
});
els.testNotifyBtn.addEventListener('click', async () => {
  if (!isValidTopic(settings.topic)) {
    addLog('トピック名が正しくありません。設定を確認してください', 'error');
    return;
  }
  if (dailyCount() >= DAILY_CAP) {
    addLog('今日の通知が上限に達しているので送れません', 'warn');
    return;
  }
  let blob = null;
  try {
    const src = activeSource();
    blob = sourceReady(src)
      ? await makeSnapshot(src, lastDets.filter((d) => d.score >= settings.threshold))
      : await makeTestCard();
  } catch (e) {
    console.warn(e);
  }
  addLog('テスト通知を送ります', 'info');
  const now = Date.now();
  enqueue({
    title: 'テスト通知',
    message: `猫アラートからのテスト通知です（${fmtTime(now)}）。写真が見えれば準備完了です`,
    tags: 'white_check_mark',
    priority: 3,
    blob,
    filename: `test-${stamp(now)}.jpg`,
  });
});

// ---------- 起動 ----------
renderSettings();
renderLog();
renderClips();
updateButtons();
updateStatus();
layoutOverlay();
// 録画が勝手に消されにくくする（対応しているブラウザのみ）
if (settings.record && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if (!storageOk) els.storageWarn.hidden = false;
if (!window.isSecureContext) els.secureWarn.hidden = false;
if (load('running', false)) {
  addLog('前回は見張り中だったので、自動で再開します', 'info');
  startMonitoring({ resumed: true });
} else if (!load('welcomed', false)) {
  els.settingsBox.open = true;
  save('welcomed', true);
}
