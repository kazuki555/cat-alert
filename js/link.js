// 猫アラート：カメラ側（B）と見る側（A）をつなぐ（WebRTC ＋ PeerJS）
// 合言葉（トピック名）を知っている同士だけがつながる。合言葉そのものは、どこにも送らない。
import { addLog, errText } from './common.js';

const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js';
const MAX_VIEWERS = 2;                  // 同時に見られる人数（Bの発熱を抑えるため）
const AUTH_TIMEOUT_MS = 5_000;          // 本人確認にかけてよい時間
const PING_MS = 10_000;
const DEAD_MS = 30_000;                 // これだけ返事がなければ切れたとみなす
const BITRATE_DIRECT = 1_000_000;       // 直接つながったときの上限（約1Mbps）
const BITRATE_RELAY = 300_000;          // 中継のときの上限（約300kbps）
const SERVER_RETRY_MS = 5_000;
const ID_RETRY_MAX_MS = 120_000;        // 前のIDが残っているとき、試し続ける最長
const VIEWER_RETRY_MS = [5_000, 10_000, 30_000];  // 以後は30秒ごと
const BUSY_RETRY_MS = 10_000;
const DENY_RETRY_MS = 30_000;

// ---------- PeerJS の読み込み（必要になったときだけ） ----------
let peerjsTask = null;
export function loadPeerJs() {
  if (window.peerjs?.Peer) return Promise.resolve(window.peerjs.Peer);
  peerjsTask ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PEERJS_URL;
    s.onload = () => (window.peerjs?.Peer ? resolve(window.peerjs.Peer) : reject(new Error('PeerJS を読み込めませんでした')));
    s.onerror = () => { peerjsTask = null; s.remove(); reject(new Error('PeerJS を読み込めませんでした')); };
    document.head.append(s);
  });
  return peerjsTask;
}

// ---------- 合言葉からIDと確認用の印を作る ----------
const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const newNonce = () => hex(crypto.getRandomValues(new Uint8Array(16)));
export async function cameraPeerId(topic) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode('cat-alert/camera/' + topic));
  return 'catcam5-' + hex(d).slice(0, 20);
}
// tag を付けて、行きと帰りの印が同じにならないようにする（なりすましの使い回しを防ぐ）
async function mac(key, tag, nonce) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(`${tag}:${nonce}`)));
}
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- 接続の種類（直接／中継） ----------
export async function connectionKind(pc) {
  if (!pc) return null;
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
  if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) pair ??= r; });
  if (!pair) return null;
  const l = stats.get(pair.localCandidateId);
  const r = stats.get(pair.remoteCandidateId);
  return l?.candidateType === 'relay' || r?.candidateType === 'relay' ? 'relay' : 'direct';
}

// ---------- カメラ側（B） ----------
// getState：いまの状態（A に送る）／onViewers：見ている人の数が変わったとき／onStatus：サーバーとの状態
// onMessage(msg, reply)：A から届いた命令など
export function createCameraLink({ topic, getState, onViewers = () => {}, onStatus = () => {}, onMessage = () => {} }) {
  let peer = null;
  let Peer = null;
  let myId = '';
  let closed = false;
  let track = null;
  let idDeadline = 0;
  let serverDown = false;
  let restartTimer = null;
  let reconnectTimer = null;
  const viewers = new Map();  // A の ID → { conn, call, authed, nonce, lastRx, authTimer }

  const authedCount = () => [...viewers.values()].filter((v) => v.authed).length;
  const notifyViewers = () => onViewers(authedCount());

  async function start() {
    try {
      Peer = await loadPeerJs();
      if (closed) return;
      myId = await cameraPeerId(topic);
      if (closed) return;
      idDeadline = Date.now() + ID_RETRY_MAX_MS;
      open();
    } catch (e) {
      markDown(`映像をつなぐ準備ができません（${errText(e)}）`);
      restartTimer = setTimeout(start, SERVER_RETRY_MS);
    }
  }
  function markDown(text) {
    if (!serverDown) addLog(`${text}。見張りと通知は続けます`, 'warn');
    serverDown = true;
    onStatus('server-down');
  }
  function open() {
    if (closed) return;
    const p = new Peer(myId);
    peer = p;
    p.on('open', () => {
      if (peer !== p) return;
      if (serverDown || !p.__logged) addLog('映像をつなぐサーバーにつながりました。見る人を待っています', 'info');
      p.__logged = true;
      serverDown = false;
      onStatus('ready');
    });
    p.on('connection', onConnection);
    p.on('disconnected', () => { if (peer === p) scheduleReconnect(); });
    p.on('error', (e) => {
      if (peer !== p || closed) return;
      if (e.type === 'unavailable-id') {
        // 読み込み直した直後は、前のIDがサーバーに残っていることがある
        if (Date.now() < idDeadline) { restartPeer(5_000); return; }
        addLog('映像用のIDが使用中のままです。しばらくして、見張りを始め直してください', 'error');
        onStatus('id-taken');
        return;
      }
      if (e.type === 'peer-unavailable' || e.type === 'webrtc') return;  // 相手側の事情。つなぎ直しは A がする
      markDown(`映像をつなぐサーバーにつながりません（${e.type || errText(e)}）`);
      if (p.destroyed) restartPeer(SERVER_RETRY_MS); else scheduleReconnect();
    });
  }
  function restartPeer(delay) {
    clearTimeout(restartTimer);
    try { peer?.destroy(); } catch { /* すでに閉じている */ }
    peer = null;
    restartTimer = setTimeout(open, delay);
  }
  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed || !peer || peer.destroyed) return;
      if (peer.disconnected) { try { peer.reconnect(); } catch { restartPeer(SERVER_RETRY_MS); } }
    }, SERVER_RETRY_MS);
  }

  function onConnection(conn) {
    const v = { conn, call: null, authed: false, nonce: newNonce(), lastRx: Date.now(), authTimer: null, peerId: conn.peer };
    conn.on('open', () => {
      if (closed) return;
      if (viewers.size >= MAX_VIEWERS) {
        addLog('見ている人が多いので、新しい人は断りました', 'warn');
        safeSend(conn, { t: 'busy' });
        setTimeout(() => conn.close(), 300);
        return;
      }
      viewers.set(v.peerId, v);
      v.authTimer = setTimeout(() => { if (!v.authed) drop(v, '本人確認がすぐに終わらなかったので切りました'); }, AUTH_TIMEOUT_MS);
      safeSend(conn, { t: 'hello', nonce: v.nonce, v: 5 });
    });
    conn.on('data', (m) => onData(v, m));
    conn.on('close', () => drop(v));
    conn.on('error', (e) => { addLog(`見る人との通信でエラーが起きました（${errText(e)}）`, 'warn'); drop(v); });
  }
  async function onData(v, m) {
    v.lastRx = Date.now();
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'auth') {
      if (v.authed) return;
      const ok = same(m.mac, await mac(topic, 'auth', v.nonce)) && typeof m.nonce === 'string' && m.nonce.length <= 64;
      if (!ok) {
        addLog('合言葉が合わない相手を切りました', 'warn');
        safeSend(v.conn, { t: 'deny' });
        setTimeout(() => drop(v), 300);
        return;
      }
      clearTimeout(v.authTimer);
      v.authed = true;
      safeSend(v.conn, { t: 'authok', mac: await mac(topic, 'authok', m.nonce) });
      addLog(`見る人がつながりました（${authedCount()}人）`, 'ok');
      notifyViewers();
      callViewer(v);
      pushState();
    } else if (!v.authed) {
      return;  // 本人確認が済むまでは、ほかのメッセージを受けない
    } else if (m.t === 'ping') {
      safeSend(v.conn, { t: 'pong' });
    } else if (m.t !== 'pong') {
      onMessage(m, (reply) => safeSend(v.conn, reply));
    }
  }
  function callViewer(v) {
    if (!peer || peer.destroyed || !track || v.call) return;
    try {
      const call = peer.call(v.peerId, new MediaStream([track]));
      if (!call) return;
      v.call = call;
      call.on('close', () => { if (v.call === call) v.call = null; });
      call.on('error', () => { if (v.call === call) v.call = null; });
      setTimeout(() => tuneBitrate(call), 1_500);
      setTimeout(() => tuneBitrate(call), 8_000);
    } catch (e) {
      addLog(`映像を送れませんでした（${errText(e)}）`, 'error');
    }
  }
  async function tuneBitrate(call) {
    try {
      const pc = call.peerConnection;
      const sender = pc?.getSenders()[0];
      if (!sender) return;
      const kind = await connectionKind(pc);
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = kind === 'relay' ? BITRATE_RELAY : BITRATE_DIRECT;
      await sender.setParameters(p);
    } catch { /* 対応していなければそのまま */ }
  }
  function drop(v, why) {
    if (viewers.get(v.peerId) !== v) { try { v.conn.close(); } catch { /* 閉じ済み */ } return; }
    viewers.delete(v.peerId);
    clearTimeout(v.authTimer);
    try { v.call?.close(); } catch { /* 閉じ済み */ }
    try { v.conn.close(); } catch { /* 閉じ済み */ }
    if (why) addLog(why, 'warn');
    if (v.authed) {
      addLog(`見る人が減りました（${authedCount()}人）`, 'info');
      notifyViewers();
      pushState();
    }
  }
  function safeSend(conn, msg) { try { conn.send(msg); } catch (e) { addLog(`送れませんでした（${errText(e)}）`, 'warn'); } }
  function send(msg) { for (const v of viewers.values()) if (v.authed) safeSend(v.conn, msg); }
  function pushState() { send({ t: 'state', ...getState(), viewers: authedCount() }); }

  const pingTimer = setInterval(() => {
    const now = Date.now();
    for (const v of [...viewers.values()]) {
      if (now - v.lastRx > DEAD_MS) { drop(v, '見る人からの返事がないので切りました'); continue; }
      if (v.authed) safeSend(v.conn, { t: 'ping' });
    }
  }, PING_MS);
  const stateTimer = setInterval(() => { if (authedCount()) pushState(); }, 5_000);

  start();
  return {
    // 送る映像を差しかえる（つなぎ直さずに、映像だけ入れかえる）
    setTrack(t) {
      track = t;
      for (const v of viewers.values()) {
        if (!v.authed) continue;
        if (v.call) {
          const sender = v.call.peerConnection?.getSenders()[0];
          sender?.replaceTrack(t).catch((e) => addLog(`映像を差しかえられませんでした（${errText(e)}）`, 'error'));
        } else {
          callViewer(v);
        }
      }
    },
    send,
    pushState,
    viewers: authedCount,
    close() {
      closed = true;
      clearInterval(pingTimer);
      clearInterval(stateTimer);
      clearTimeout(restartTimer);
      clearTimeout(reconnectTimer);
      for (const v of [...viewers.values()]) drop(v);
      try { peer?.destroy(); } catch { /* 閉じ済み */ }
      peer = null;
    },
  };
}

// ---------- 見る側（A） ----------
// onStatus(code)：connecting／connected／live／notfound／badkey／busy／lost／server
// onStream(stream | null)：映像／onKind('direct' | 'relay')／onMessage(msg)：state など
// macKey：テスト用（合言葉と別の鍵で本人確認を試すときだけ使う）
export function createViewerLink({ topic, macKey, onStatus = () => {}, onStream = () => {}, onKind = () => {}, onMessage = () => {} }) {
  const key = macKey ?? topic;
  let Peer = null;
  let peer = null;
  let bId = '';
  let conn = null;
  let call = null;
  let pending = null;
  let closed = false;
  let authed = false;
  let myNonce = '';
  let retryIdx = 0;
  let retryTimer = null;
  let authTimer = null;
  let pingTimer = null;
  let kindTimer = null;
  let lastRx = 0;
  let fixedStatus = null;  // busy／badkey のときは、切れても表示をそのままにする

  const status = (code) => onStatus(code);

  async function start() {
    try {
      Peer = await loadPeerJs();
      if (closed) return;
      bId = await cameraPeerId(topic);
      if (closed) return;
      openPeer();
    } catch (e) {
      addLog(`映像をつなぐ準備ができません（${errText(e)}）`, 'error');
      status('server');
      retryTimer = setTimeout(start, SERVER_RETRY_MS);
    }
  }
  function openPeer() {
    if (closed) return;
    status('connecting');
    const p = new Peer();
    peer = p;
    p.on('open', () => { if (peer === p) connect(); });
    p.on('call', onCall);
    p.on('disconnected', () => {
      if (peer !== p || closed) return;
      setTimeout(() => { if (!closed && peer === p && p.disconnected && !p.destroyed) { try { p.reconnect(); } catch { /* 次の機会に */ } } }, SERVER_RETRY_MS);
    });
    p.on('error', (e) => {
      if (peer !== p || closed) return;
      if (e.type === 'peer-unavailable') {
        teardown();
        status('notfound');
        scheduleRetry(VIEWER_RETRY_MS[Math.min(retryIdx++, VIEWER_RETRY_MS.length - 1)]);
        return;
      }
      if (e.type === 'webrtc') return;
      status('server');
      if (p.destroyed) { try { p.destroy(); } catch { /* 閉じ済み */ } peer = null; retryTimer = setTimeout(openPeer, SERVER_RETRY_MS); }
    });
  }
  function scheduleRetry(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (!closed && peer && !peer.destroyed && !peer.disconnected) connect(); }, ms);
  }
  function teardown() {
    clearTimeout(authTimer);
    clearInterval(pingTimer);
    clearInterval(kindTimer);
    const c = conn;
    const k = call;
    conn = null;
    call = null;
    pending = null;
    authed = false;
    try { c?.close(); } catch { /* 閉じ済み */ }
    try { k?.close(); } catch { /* 閉じ済み */ }
    onStream(null);
  }
  function connect() {
    if (closed || !peer || peer.destroyed) return;
    teardown();
    fixedStatus = null;
    status('connecting');
    const c = peer.connect(bId, { serialization: 'json', reliable: true });
    conn = c;
    myNonce = newNonce();
    lastRx = Date.now();
    authTimer = setTimeout(() => { if (conn === c && !authed) lost(); }, AUTH_TIMEOUT_MS + 3_000);
    c.on('data', (m) => onData(c, m));
    c.on('close', () => { if (conn === c) lost(); });
    c.on('error', (e) => { addLog(`カメラとの通信でエラーが起きました（${errText(e)}）`, 'warn'); if (conn === c) lost(); });
  }
  function lost() {
    teardown();
    if (closed) return;
    if (fixedStatus) return;
    status('lost');
    scheduleRetry(VIEWER_RETRY_MS[Math.min(retryIdx++, VIEWER_RETRY_MS.length - 1)]);
  }
  async function onData(c, m) {
    if (conn !== c || !m || typeof m.t !== 'string') return;
    lastRx = Date.now();
    if (m.t === 'hello') {
      c.send({ t: 'auth', mac: await mac(key, 'auth', m.nonce), nonce: myNonce });
    } else if (m.t === 'authok') {
      if (!same(m.mac, await mac(topic, 'authok', myNonce))) {
        addLog('カメラ側の本人確認が合いません。つなぎません', 'error');
        fixedStatus = 'badkey';
        status('badkey');
        teardown();
        scheduleRetry(DENY_RETRY_MS);
        return;
      }
      clearTimeout(authTimer);
      authed = true;
      retryIdx = 0;
      status('connected');
      pingTimer = setInterval(() => {
        if (Date.now() - lastRx > DEAD_MS) { lost(); return; }
        try { c.send({ t: 'ping' }); } catch { /* 切れている */ }
      }, PING_MS);
      if (pending) { const p = pending; pending = null; answer(p); }
    } else if (m.t === 'deny') {
      fixedStatus = 'badkey';
      status('badkey');
      teardown();
      scheduleRetry(DENY_RETRY_MS);
    } else if (m.t === 'busy') {
      fixedStatus = 'busy';
      status('busy');
      teardown();
      scheduleRetry(BUSY_RETRY_MS);
    } else if (m.t === 'ping') {
      try { c.send({ t: 'pong' }); } catch { /* 切れている */ }
    } else if (m.t !== 'pong' && authed) {
      onMessage(m);
    }
  }
  function onCall(c) {
    if (c.peer !== bId) { c.close(); return; }  // カメラ以外からの呼び出しは受けない
    if (authed) answer(c);
    else {
      pending = c;  // 本人確認の結果が届くまで少し待つ
      setTimeout(() => { if (pending === c) { pending = null; c.close(); } }, AUTH_TIMEOUT_MS);
    }
  }
  function answer(c) {
    c.answer();
    call = c;
    c.on('stream', (s) => {
      if (call !== c) return;
      onStream(s);
      status('live');
      clearInterval(kindTimer);
      const check = async () => { try { onKind(await connectionKind(c.peerConnection)); } catch { /* 取れなければ表示しない */ } };
      setTimeout(check, 1_500);
      kindTimer = setInterval(check, 5_000);
    });
    c.on('close', () => { if (call === c) { call = null; onStream(null); if (authed) status('connected'); } });
  }

  start();
  return {
    send(msg) { try { conn?.send(msg); return !!conn && authed; } catch { return false; } },
    close() {
      closed = true;
      clearTimeout(retryTimer);
      teardown();
      try { peer?.destroy(); } catch { /* 閉じ済み */ }
      peer = null;
    },
  };
}
