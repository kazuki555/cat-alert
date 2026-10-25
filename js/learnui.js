// 猫アラート：「猫の学習」欄（カメラが保存した写真に「猫」「ちがう」を教える画面）。カメラ側と見る側の両方で使う
// source：写真の出どころ（カメラ側はこのiPhoneの中、見る側はデータ通信でカメラ側に頼む）
//   page(view, offset) → Promise<{ items: [{ id, at, label, score }], total, counts: { todo, cat, not } }>
//   thumb(id) → Promise<写真のURL | null>
//   label(id, label) → Promise<{ ok, counts }>
import { fmtDateTime } from './common.js';

const VIEWS = [
  { key: 'todo', text: 'まだ' },
  { key: 'cat', text: '猫' },
  { key: 'not', text: 'ちがう' },
];

export function createLearnPanel(root, source, { pageSize = 12 } = {}) {
  root.textContent = '';
  const countsEl = el('p', 'learn-counts');
  const tabs = el('div', 'row');
  const msg = el('p', 'help');
  const grid = el('ul', 'learn-grid');
  const more = el('button', 'btn small', 'もっと見る');
  const reload = el('button', 'btn small', '新しくする');
  const foot = el('div', 'row');
  foot.append(more, reload);
  root.append(countsEl, tabs, msg, grid, foot);

  let view = 'todo';
  let offset = 0;
  let total = 0;
  let enabled = true;
  let loading = false;
  let seq = 0;          // 古い読み込みの結果を捨てるための番号
  let urls = [];        // あとで片づける写真のURL（blob: のもの）
  const tabBtns = VIEWS.map((v) => {
    const b = el('button', 'btn small', v.text);
    b.addEventListener('click', () => { if (view !== v.key) { view = v.key; refresh(); } });
    tabs.append(b);
    return [v.key, b];
  });

  function setCounts(c) {
    if (!c) return;
    countsEl.textContent = `まだ ${c.todo}枚・猫 ${c.cat}枚・ちがう ${c.not}枚`;
  }
  function renderTabs() {
    for (const [k, b] of tabBtns) b.classList.toggle('on', k === view);
  }
  function clearGrid() {
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
    grid.textContent = '';
  }
  function emptyText() {
    return view === 'todo' ? 'まだ答えていない写真はありません。カメラが「猫かも」と思うと、ここに写真がたまります'
      : view === 'cat' ? '「猫」と答えた写真はまだありません' : '「ちがう」と答えた写真はまだありません';
  }
  function updateFoot() {
    more.hidden = grid.children.length >= total;
    if (!grid.children.length && !msg.textContent) msg.textContent = emptyText();
  }
  function tile(item) {
    const li = el('li', 'learn-tile');
    const img = el('img');
    img.alt = 'カメラが保存した写真';
    const cap = el('div', 'learn-cap', `${fmtDateTime(item.at)}・猫らしさ ${Math.round((item.score || 0) * 100)}%`);
    const row = el('div', 'learn-btns');
    const yes = el('button', 'btn small', '🐱 猫');
    const no = el('button', 'btn small', '✕ ちがう');
    const mark = () => { yes.classList.toggle('on', item.label === 'cat'); no.classList.toggle('on', item.label === 'not'); };
    mark();
    const answer = async (label) => {
      if (!enabled) return;
      const next = item.label === label ? null : label;  // もう一度押すと「まだ」に戻す
      yes.disabled = true;
      no.disabled = true;
      let r = null;
      try { r = await source.label(item.id, next); } catch { r = null; }
      yes.disabled = false;
      no.disabled = false;
      if (!r?.ok) { msg.textContent = '答えを保存できませんでした。もう一度押してください'; return; }
      item.label = next;
      setCounts(r.counts);
      // いまの一覧に合わなくなった写真は、一覧から外す
      if ((view === 'todo' && next) || (view !== 'todo' && next !== view)) {
        li.remove();
        total = Math.max(0, total - 1);
        updateFoot();
      } else {
        mark();
      }
    };
    yes.addEventListener('click', () => answer('cat'));
    no.addEventListener('click', () => answer('not'));
    row.append(yes, no);
    li.append(img, cap, row);
    source.thumb(item.id).then((u) => {
      if (!u) return;
      if (u.startsWith('blob:')) urls.push(u);
      img.src = u;
    }).catch(() => {});
    return li;
  }
  async function loadPage() {
    if (!enabled || loading) return;
    loading = true;
    const my = ++seq;
    msg.textContent = '読み込んでいます…';
    try {
      const r = await source.page(view, offset);
      if (my !== seq) return;
      msg.textContent = '';
      total = r.total;
      setCounts(r.counts);
      for (const it of r.items) grid.append(tile(it));
      offset += r.items.length;
    } catch (e) {
      if (my === seq) msg.textContent = `写真を読み込めませんでした（${e?.message || e}）`;
    } finally {
      if (my === seq) { loading = false; updateFoot(); }
    }
  }
  function refresh() {
    seq++;
    loading = false;
    offset = 0;
    total = 0;
    clearGrid();
    renderTabs();
    loadPage();
  }
  more.addEventListener('click', loadPage);
  reload.addEventListener('click', refresh);
  renderTabs();

  return {
    refresh,
    setCounts,
    // 使えないとき（見る側でカメラにつながっていないなど）は、理由を出して隠す
    setEnabled(on, why = '') {
      enabled = on;
      tabs.hidden = !on;
      foot.hidden = !on;
      if (!on) { seq++; loading = false; clearGrid(); countsEl.textContent = ''; msg.textContent = why; }
    },
  };
}

function el(tag, cls = '', text = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
