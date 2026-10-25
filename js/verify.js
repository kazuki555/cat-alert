// 猫アラート：猫かどうかを確かめる（2段目のAI）と、このカメラの写真で覚える（学習）。カメラ側だけで使う
// 1段目（物体検出）は、猫を「鳥」などと見まちがえたり、確からしさが低く出たりする。そこで候補の部分を切り出し、
// 細かく分類するAI（1000種類を見分ける）でもう一度確かめる。さらに、ユーザーが「猫」「ちがう」と教えた写真に
// 似ているかどうかでも判断する（似た写真が多いほど、教えてもらった答えを信じる）。
import { toJpeg } from './common.js';

const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models';
const CLASSIFIER_URL = `${MODEL_BASE}/image_classifier/efficientnet_lite2/int8/1/efficientnet_lite2.tflite`;   // 約7MB
const EMBEDDER_URL = `${MODEL_BASE}/image_embedder/mobilenet_v3_small/float32/1/mobilenet_v3_small.tflite`;   // 約4MB
export const CROP_SIZE = 256;       // 確かめるときに切り出す大きさ（正方形）

// 分類AI（ImageNet）の番号：281〜285 が家の猫（トラ猫・キジ猫・ペルシャ・シャム・エジプシャン）、
// 286・287 はクーガー・オオヤマネコ（暗いと猫がこう判定されやすい）、0〜397 が動物
const isHouseCat = (i) => i >= 281 && i <= 285;
const isCatLike = (i) => i === 286 || i === 287;
const isAnimal = (i) => i >= 0 && i <= 397;
const ANIMAL_SURE = 0.4;            // 動物の点の合計がこれ以上なら「動物が写っている」と信じる
const DET_WEIGHT = 0.85;            // 1段目の「猫」の確からしさを、どれだけ足すか

// 学習（教えてもらった写真との似ぐあい）
const SIM_MIN = 0.45;               // これより似ていない写真は使わない（同じ猫どうしは0.7〜0.95、別のものは0.2以下）
const NEIGHBORS = 9;                // 似ている順に、この枚数まで見る
const LEARN_WEIGHT = 0.85;          // よく似た写真がたくさんあるとき、教えてもらった答えをどれだけ信じるか
const LEARN_FULL = 1.2;             // 似ぐあいの重みの合計がこれだけあれば「よく似た写真がたくさんある」とみなす（とても似た写真2枚ほど）
const DUP_SIM = 0.95;               // これ以上似ている写真は、同じ場面として保存しない
const DUP_RECENT = 40;              // 同じ場面かどうかを比べる、最近の写真の枚数
const TODO_MAX = 300;               // まだ答えをもらっていない写真の上限（古いものから消す）
const LABELED_MAX = 1000;           // 答えをもらった写真の上限
const THUMB_SIZE = 128;             // 保存する写真の大きさ（見る側へも送るので小さく）

// ---------- AI の読み込み ----------
let classifier = null;
let embedder = null;
let loadedConf = '';
export function verifierReady() { return !!classifier && !!embedder; }
export function verifierConf() { return loadedConf; }
export async function loadVerifier(mp, fileset, gpu) {
  const delegate = gpu ? 'GPU' : 'CPU';
  if (verifierReady() && loadedConf === delegate) return;
  closeVerifier();
  const opts = (url) => ({ baseOptions: { modelAssetPath: url, delegate }, runningMode: 'IMAGE' });
  const c = await mp.ImageClassifier.createFromOptions(fileset, { ...opts(CLASSIFIER_URL), maxResults: -1 });
  let e;
  try {
    e = await mp.ImageEmbedder.createFromOptions(fileset, { ...opts(EMBEDDER_URL), l2Normalize: true });
  } catch (err) {
    try { c.close(); } catch { /* 閉じられなくても続ける */ }
    throw err;
  }
  classifier = c;
  embedder = e;
  loadedConf = delegate;
}
export function closeVerifier() {
  try { classifier?.close(); } catch { /* 閉じられなくても続ける */ }
  try { embedder?.close(); } catch { /* 閉じられなくても続ける */ }
  classifier = null;
  embedder = null;
  loadedConf = '';
}

// ---------- 確かめる ----------
// 分類AIの答えから「猫らしさ」を出す。背景（箱・マットなど）にも点が流れるので、動物の点のうち猫の割合で見る
function classScore(canvas) {
  const cats = classifier.classify(canvas).classifications[0]?.categories ?? [];
  let cat = 0;
  let animal = 0;
  for (const k of cats) {
    if (!isAnimal(k.index)) continue;
    animal += k.score;
    if (isHouseCat(k.index)) cat += k.score;
    else if (isCatLike(k.index)) cat += 0.6 * k.score;
  }
  const sure = Math.min(1, animal / ANIMAL_SURE);
  const share = animal > 0 ? cat / animal : 0;
  return { cls: share * sure, other: sure * (1 - share) };  // other：はっきり別の動物（犬・鳥など）だと言っている度合い
}
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
// 教えてもらった写真のうち、よく似たものの答えで多数決する（似ているほど重く数える）
function vote(emb) {
  const top = [];  // [似ぐあい, 猫なら1・ちがうなら0]（似ている順）
  for (const s of labeled) {
    const sim = dot(emb, s.emb);
    if (sim < SIM_MIN) continue;
    if (top.length === NEIGHBORS && sim <= top[top.length - 1][0]) continue;
    let i = top.length;
    while (i > 0 && top[i - 1][0] < sim) i--;
    top.splice(i, 0, [sim, s.label === 'cat' ? 1 : 0]);
    if (top.length > NEIGHBORS) top.pop();
  }
  let sw = 0;
  let sy = 0;
  for (const [sim, y] of top) {
    const w = ((sim - SIM_MIN) / (1 - SIM_MIN)) ** 2;
    sw += w;
    sy += w * y;
  }
  if (sw <= 0) return null;
  return { p: sy / sw, conf: Math.min(1, sw / LEARN_FULL) };
}
// 切り出した写真（CROP_SIZE の正方形のキャンバス）が猫かどうか。detCat：1段目が「猫」と言った確からしさ（言っていなければ0）
// wantEmb：写真を保存するかもしれないので、似ぐあいを測るための数値（埋め込み）も作ってほしいとき
export function judge(canvas, detCat, wantEmb) {
  const { cls, other } = classScore(canvas);
  // 1段目が「猫」と言っていても、分類AIがはっきり別の動物だと言うなら、1段目の答えは軽く見る
  let score = 1 - (1 - cls) * (1 - DET_WEIGHT * (1 - other) * detCat);
  let emb = null;
  let learn = null;
  if (wantEmb || labeled.length) {
    const f = embedder.embed(canvas).embeddings[0]?.floatEmbedding;
    if (f && f.length) emb = Float32Array.from(f);
  }
  if (emb && labeled.length) {
    const v = vote(emb);
    if (v) {
      const k = LEARN_WEIGHT * v.conf;
      score = score * (1 - k) + v.p * k;
      learn = v.p;
    }
  }
  return { score: Math.min(1, Math.max(0, score)), cls, learn, emb };
}

// ---------- 覚えた写真（IndexedDB。写真そのものはこのiPhoneの中だけ） ----------
let all = [];        // 写真の一覧（新しい順。写真の中身は入れない）：{ id, at, label, score, emb }
let labeled = [];    // all のうち、答えをもらったもの
let dbPromise = null;
let loadTask = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('catAlertLearn', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('samples', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}
async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('samples', mode);
    const r = fn(t.objectStore('samples'));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('保存が中断されました'));
  });
}
const refreshLabeled = () => { labeled = all.filter((s) => s.label); };
// 起動のときに1回だけ、保存してある一覧を読む（写真の中身は、見るときに読む）
export function initSamples() {
  loadTask ??= (async () => {
    const list = (await tx('readonly', (s) => s.getAll())) || [];
    all = list.map((s) => ({ id: s.id, at: s.at, label: s.label ?? null, score: s.score ?? 0, emb: s.emb }))
      .filter((s) => s.emb && s.emb.length)
      .sort((a, b) => b.at - a.at);
    refreshLabeled();
  })();
  loadTask.catch(() => { loadTask = null; });
  return loadTask;
}
// 「猫かも」と思った写真を保存する。同じ場面の写真が続くときは保存しない。保存したら true
export async function addSample(canvas, emb, score) {
  if (!emb) return false;
  for (const s of all.slice(0, DUP_RECENT)) if (dot(emb, s.emb) >= DUP_SIM) return false;
  // 先に小さくしておく（このあとキャンバスは次の判定に使われる）
  const c = document.createElement('canvas');
  c.width = THUMB_SIZE;
  c.height = THUMB_SIZE;
  c.getContext('2d').drawImage(canvas, 0, 0, THUMB_SIZE, THUMB_SIZE);
  const thumb = await toJpeg(c);
  const s = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), label: null, score: Math.round(score * 100) / 100, emb };
  await tx('readwrite', (st) => st.put({ ...s, thumb }));
  all.unshift(s);
  await prune();
  return true;
}
async function prune() {
  const todo = all.filter((s) => !s.label);
  const done = all.filter((s) => s.label);
  const remove = [...todo.slice(TODO_MAX), ...done.slice(LABELED_MAX)];
  if (!remove.length) return;
  const ids = new Set(remove.map((s) => s.id));
  await tx('readwrite', (st) => { ids.forEach((id) => st.delete(id)); });
  all = all.filter((s) => !ids.has(s.id));
  refreshLabeled();
}
export function sampleCounts() {
  let todo = 0;
  let cat = 0;
  let not = 0;
  for (const s of all) { if (s.label === 'cat') cat++; else if (s.label === 'not') not++; else todo++; }
  return { todo, cat, not };
}
// view：'todo'（まだ）／'cat'（猫）／'not'（ちがう）
export function listSamples(view, offset, limit) {
  const want = view === 'cat' ? 'cat' : view === 'not' ? 'not' : null;
  const list = all.filter((s) => s.label === want);
  return {
    total: list.length,
    items: list.slice(offset, offset + limit).map((s) => ({ id: s.id, at: s.at, label: s.label, score: s.score })),
  };
}
export async function sampleThumb(id) {
  const s = await tx('readonly', (st) => st.get(id));
  return s?.thumb ?? null;
}
// 答えを付ける（label：'cat'／'not'／null＝まだに戻す）。できたら true
export async function labelSample(id, label) {
  const s = all.find((x) => x.id === id);
  if (!s || !['cat', 'not', null].includes(label)) return false;
  const saved = await tx('readonly', (st) => st.get(id));
  if (!saved) return false;
  await tx('readwrite', (st) => st.put({ ...saved, label }));
  s.label = label;
  refreshLabeled();
  return true;
}
export async function resetSamples() {
  await tx('readwrite', (st) => st.clear());
  all = [];
  labeled = [];
}
