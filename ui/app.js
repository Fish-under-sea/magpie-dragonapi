/* DragonAPI in Magpie · 本地控制台前端
 *
 * 为什么不用框架：页面由插件自起的本地 HTTP 服务直接托管，没有构建步骤，
 * 四个标签页不值得引入几百 KB 的运行时。
 *
 * 为什么状态全在内存：页面文档的 origin 是 opaque（从 magpie 沙箱 iframe
 * location.replace 过来），碰 localStorage / sessionStorage / indexedDB / cookie
 * 都会抛异常；需要留下来的东西只能交给服务端 API。
 *
 * 为什么所有 fetch 都 credentials: "omit"：opaque origin 下带凭据的跨源请求
 * 会被直接拒，服务端也用 Access-Control-Allow-Origin: * 兜住，不需要 cookie。
 */

'use strict';

// ── DOM 小工具 ─────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * 轻量建元素：只做本文件需要的那几种属性，避免到处写 setAttribute。
 * 数据一律走 textContent（不接受 html 字符串），防止站点返回的文本变成标记。
 */
function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
    for (const [key, val] of Object.entries(props)) {
      if (val === null || val === undefined || val === false) continue;
      if (key === 'class') node.className = val;
      else if (key === 'text') node.textContent = String(val);
      else if (key === 'dataset') Object.assign(node.dataset, val);
      else if (key === 'value') node.value = val;
      else if (key === 'checked') node.checked = Boolean(val);
      else if (key === 'disabled') node.disabled = Boolean(val);
      else if (key.startsWith('on') && typeof val === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), val);
      } else node.setAttribute(key, val === true ? '' : String(val));
    }
  } else if (props !== null && props !== undefined && props !== false) {
    kids.unshift(props);
  }
  append(node, ...kids);
  return node;
}

function append(parent, ...kids) {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false || kid === true) continue;
    if (Array.isArray(kid)) { append(parent, ...kid); continue; }
    parent.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return parent;
}

/** 通用表格：headers 为字符串或 {label, cls}，rows 为单元格描述或现成的 <tr>。 */
function tableEl(headers, rows, { empty = '没有数据', tableClass = 'data-table' } = {}) {
  if (!rows || rows.length === 0) return h('div', { class: 'empty', text: empty });
  const thead = h('thead', null, h('tr', null, headers.map((hd) => {
    const spec = typeof hd === 'string' ? { label: hd } : hd;
    return h('th', { scope: 'col', class: spec.cls || null }, spec.label);
  })));
  const tbody = h('tbody');
  for (const row of rows) {
    if (row instanceof Node) { tbody.append(row); continue; }
    const tr = h('tr');
    for (const cell of row) {
      if (cell instanceof Node) { tr.append(cell); continue; }
      const spec = cell || {};
      // 有些单元格要跨列（价格未知 / auto 分组），直接给现成的 <td>
      if (spec.node instanceof Node) { tr.append(spec.node); continue; }
      tr.append(h('td', { class: spec.cls || null, title: spec.title || null }, spec.text ?? ''));
    }
    tbody.append(tr);
  }
  const wrap = h('div', { class: 'table-wrap' }, h('table', { class: tableClass }, thead, tbody));
  // 窄屏时表格会横向溢出，但滚动条在触屏上不可见——不加提示的话，用户
  // 会以为输入价/输出价/说明那几列不存在。
  //
  // 提示必须放在表格**上方**：放下面的话，195 行的表格得滚到底才看见，
  // 等于没提示。也不能放进滚动容器里（::after），那会跟着内容一起滚。
  const hint = h('p', { class: 'scroll-hint', 'data-overflow': '0', text: '← 左右滑动看完整列 →' });
  markOverflow(wrap, hint);
  return h('div', null, hint, wrap);
}

/**
 * markOverflow 在表格渲染后判断是否真的溢出，只有溢出才显示提示。
 *
 * 判两次：插入 DOM 后立刻判一次（多数情况下布局已经算好了），再在下一帧
 * 复核一次（字体加载完、图片撑开等会让宽度变化）。只靠 rAF 的话，无头截图
 * 或虚拟时间预算下可能还没跑到，提示就不出现。
 */
function markOverflow(wrap, hint) {
  const check = () => {
    if (!wrap.isConnected) return;
    // +2 是给亚像素留的余量，避免「差 1px」也提示
    hint.dataset.overflow = wrap.scrollWidth > wrap.clientWidth + 2 ? '1' : '0';
  };
  check();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(check);
  else setTimeout(check, 0);
  // 窗口变宽变窄都要重判，否则转屏后提示会留在屏幕上
  window.addEventListener('resize', check, { passive: true });
}

function regionLoading(node, text) {
  node.replaceChildren(h('p', { class: 'loading', text }));
}

function regionError(node, message, retry) {
  node.replaceChildren(h('div', { class: 'region-error' },
    h('p', { class: 'region-error-text', text: message }),
    retry ? h('button', { class: 'btn ghost', type: 'button', onclick: retry }, '重试') : null,
  ));
}

// ── 主题：URL 上的 ?theme / ?tokens ────────────────────────

/** 兜底色板：tokens 缺失或损坏时页面也得能看，不能白底白字。 */
const FALLBACK = {
  dark: { bg: '#14161b', fg: '#e7e9ee', muted: '#9aa1ae', accent: '#5b8def' },
  light: { bg: '#f7f8fa', fg: '#1b1f27', muted: '#5f6672', accent: '#3b5bdb' },
};

function initTheme() {
  const params = new URLSearchParams(location.search);
  const asked = params.get('theme');
  const mode = asked === 'dark' || asked === 'light'
    ? asked
    : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

  const root = document.documentElement;
  root.dataset.theme = mode;
  // 先铺兜底色，再让 magpie 注入的 token 覆盖；顺序反了会出现「只注入了 bg」的花屏。
  for (const [key, value] of Object.entries(FALLBACK[mode])) root.style.setProperty('--' + key, value);

  const raw = params.get('tokens');
  if (raw) {
    try {
      const tokens = JSON.parse(raw);
      if (tokens && typeof tokens === 'object') {
        for (const [key, value] of Object.entries(tokens)) {
          if (typeof value !== 'string' || !value.trim()) continue;
          root.style.setProperty('--' + String(key).replace(/^--/, ''), value.trim());
        }
      }
    } catch {
      // tokens 是宿主拼出来的，坏了不该连累整页；保留兜底色即可。
    }
  }

  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', mode === 'light' ? 'light dark' : 'dark light');
}

// ── 请求层 ────────────────────────────────────────────────

/**
 * API 基址：必须是绝对地址。
 *
 * 页面跑在 magpie 的 `sandbox="allow-scripts"` iframe 里，安全源是**不透明**
 * 的（`self.origin === "null"`，localStorage / cookie 都会抛 SecurityError）。
 * 在这种文档里，`fetch('/api/ping')` 这种相对路径会被 Chrome 直接判
 * `TypeError: Failed to fetch`——绝对地址却正常。实测对比：
 *
 *   相对 path   → TypeError: Failed to fetch
 *   绝对 URL    → 200
 *
 * 所以这里把「当前文档所在目录」算成基址：
 *   - 直接访问服务（http://127.0.0.1:3517/）        → http://127.0.0.1:3517/
 *   - 经 magpie web 代理（…/_magpie/service/<tok>/）→ 保留那段前缀
 * 不能直接用 location.origin：不透明文档里它可能报出真实源，也可能报 "null"，
 * 两种情况都要能工作，所以从 href 里解析并保留 pathname 的目录部分。
 */
const API_BASE = (() => {
  try {
    const u = new URL(location.href);
    const dir = u.pathname.replace(/[^/]*$/, ''); // 去掉文件名，保留目录
    return u.origin + dir;
  } catch {
    return '/';
  }
})();

/** apiUrl 把接口路径拼成绝对地址。传进来的 path 以 / 开头。 */
function apiUrl(path) {
  return API_BASE.replace(/\/+$/, '') + path;
}

class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      credentials: 'omit',       // opaque origin：带凭据必被拒
      cache: 'no-store',         // 服务端已经自己缓存目录，浏览器别再叠一层
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // 网络层失败（服务没起来 / 端口变了）统一成一句人话
    throw new ApiError('连不上本地服务，插件可能已经退出，或端口被改了。', 0, null);
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }

  if (!res.ok || (data && typeof data === 'object' && data.ok === false)) {
    const reason = (data && (data.error || data.message)) || `请求失败（HTTP ${res.status}）`;
    throw new ApiError(reason, res.status, data);
  }
  if (data === null) {
    throw new ApiError('服务返回的不是 JSON，这个端口上可能跑着别的服务。', res.status, null);
  }
  return data;
}

/** 把异常翻译成能直接给用户看的中文，别把 stack 抖到界面上。 */
function describeError(err) {
  if (err instanceof ApiError) {
    if (err.status === 401) return `PAT 无效或已过期：${err.message}`;
    if (err.status === 403) return `权限不足：${err.message}`;
    if (err.status === 404) return `接口不存在，页面与插件版本可能不一致：${err.message}`;
    if (err.status === 429) return `请求太频繁，稍等一下再试：${err.message}`;
    return err.message;
  }
  return (err && err.message) || '未知错误';
}

const api = {
  ping: () => request('/api/ping'),
  state: () => request('/api/state'),
  savePat: (pat) => request('/api/pat', { method: 'POST', body: { pat } }),
  clearPat: () => request('/api/pat', { method: 'DELETE' }),
  catalog: (force) => request('/api/catalog' + (force ? '?refresh=1' : '')),
  model: (group, name) => request(`/api/model?group=${encodeURIComponent(group)}&model=${encodeURIComponent(name)}`),
  usage: (range) => request(`/api/usage?range=${encodeURIComponent(range)}`),
  logs: (account) => request(`/api/logs?limit=200&account=${encodeURIComponent(account)}`),
  keys: () => request('/api/keys'),
  createKey: (body) => request('/api/keys', { method: 'POST', body }),
  deleteKey: (id) => request(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  revealKey: (id) => request(`/api/keys/${encodeURIComponent(id)}/reveal`, { method: 'POST' }),
  bindInfo: () => request('/api/bind-info'),
  health: () => request('/api/health'),
};

// ── 提示条：所有失败都必须在界面上说话 ────────────────────

const banners = new Map();

function banner(tone, text, { key = 'b-' + Math.random().toString(36).slice(2), timeout = 0 } = {}) {
  const host = $('#banners');
  if (!host) return key;

  let entry = banners.get(key);
  if (!entry) {
    const icon = h('span', { class: 'banner-icon', 'aria-hidden': 'true' });
    const textEl = h('div', { class: 'banner-text' });
    const el = h('div', { class: 'banner' }, icon, textEl,
      h('button', {
        class: 'banner-close', type: 'button', 'aria-label': '关闭这条提示',
        onclick: () => clearBanner(key),
      }, '×'));
    entry = { el, icon, textEl, timer: 0 };
    banners.set(key, entry);
    host.append(el);
    // 提示条不该越堆越长，最多留 6 条
    while (host.children.length > 6) {
      const first = host.firstElementChild;
      const deadKey = [...banners.entries()].find(([, v]) => v.el === first);
      if (deadKey) { if (deadKey[1].timer) clearTimeout(deadKey[1].timer); banners.delete(deadKey[0]); }
      first.remove();
    }
  }

  entry.el.dataset.tone = tone;
  entry.el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  entry.icon.textContent = tone === 'error' ? '!' : tone === 'warn' ? '!' : tone === 'ok' ? '✓' : 'i';
  entry.textEl.textContent = text;

  if (entry.timer) clearTimeout(entry.timer);
  if (timeout > 0) entry.timer = setTimeout(() => clearBanner(key), timeout);
  return key;
}

function clearBanner(key) {
  const entry = banners.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.el.remove();
  banners.delete(key);
}

// ── 格式化 ────────────────────────────────────────────────

const RANGE_LABEL = { day: '日', week: '周', month: '月' };
const KIND_LABEL = { chat: '对话', image: '生图', video: '视频', audio: '音频', embedding: '向量' };
const SOURCE_LABEL = { live: '实时', cache: '缓存', snapshot: '快照' };

const dtf = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

function fmtAt(ms) {
  return Number.isFinite(ms) && ms > 0 ? dtf.format(new Date(ms)) : '—';
}

function fmtInt(n) {
  return Number.isFinite(n) ? n.toLocaleString('zh-CN') : '—';
}

function fmtRatio(r) {
  return Number.isFinite(r) ? `${r}×` : '—';
}

/** 把服务端给的原始 quota 折成站点币种；金额本身仍优先用服务端格式化好的字符串。 */
function moneyRaw(raw) {
  if (!Number.isFinite(raw)) return '—';
  const cur = cache.state && cache.state.currency;
  if (!cur || cur.display === false) return fmtInt(raw);
  const per = Number(cur.per) > 0 ? Number(cur.per) : 500000;
  const rate = Number(cur.rate) > 0 ? Number(cur.rate) : 1;
  const value = (raw / per) * rate;
  const digits = Math.abs(value) >= 1 ? 2 : 4;
  const shown = value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  return `${cur.symbol || '$'}${shown || '0'}`;
}

/** 币种金额 → 原始 quota，建钥匙填额度时用；与服务端 moneyRaw 的折算方向相反。 */
function rawFromMoney(amount) {
  const cur = cache.state && cache.state.currency;
  const per = cur && Number(cur.per) > 0 ? Number(cur.per) : 500000;
  const rate = cur && Number(cur.rate) > 0 ? Number(cur.rate) : 1;
  return Math.round((amount * per) / rate);
}

// ── 全局状态（只放内存） ──────────────────────────────────

const cache = {
  ping: null,
  state: null,
  stateError: '',
  catalog: null,
  keys: null,
  bind: null,
  health: null,
  usage: {},   // range -> response
  logs: {},    // account key -> rows[]
};

const loading = { state: false, catalog: false, keys: false, bind: false, health: false, usage: false, logs: false };

const filters = { group: '', kind: '', q: '', range: 'day', account: '' };

let activeTab = 'catalog';

// 页面内存里的临时物：完整钥匙只在这里出现一次
let lastSecret = null;          // { key, bind }
const revealed = new Map();     // key id -> secret
let confirmDeleteId = null;     // 正在二次确认删除的钥匙 id

// ── 顶部栏 ────────────────────────────────────────────────

function renderHeader() {
  const dot = $('#conn-dot');
  const text = $('#conn-text');
  const pill = $('#conn-pill');
  const st = cache.state;

  if (!dot || !text || !pill) return;

  let tone = 'busy';
  let label = '连接中…';
  let title = '';

  if (cache.stateError) {
    tone = 'bad';
    label = '本地服务无响应';
    title = cache.stateError;
  } else if (st) {
    const health = st.health || {};
    if (health.ok) {
      tone = 'ok';
      label = health.source === 'live' ? '已连接' : `已连接 · ${SOURCE_LABEL[health.source] || health.source || '缓存'}`;
      title = `${health.ms != null ? health.ms + ' ms' : '耗时未知'} · ${fmtAt(health.at)}`;
    } else {
      tone = 'warn';
      label = '站点不可达';
      title = '本地服务正常，但上游 DragonAPI 没有响应；目录可能来自缓存。';
    }
  }

  dot.dataset.state = tone;
  text.textContent = label;
  pill.title = title || '本地服务与站点连接状态';

  const currency = st && st.currency;
  const curPill = $('#currency-pill');
  if (curPill) {
    curPill.textContent = currency
      ? `${currency.symbol || ''} ${currency.code || ''}`.trim() || '—'
      : '—';
    curPill.title = currency
      ? `站点币种 ${currency.code || ''}${currency.per ? ` · 1 单位 = ${currency.per} quota` : ''}`
      : '站点币种';
  }

  const site = st && st.site;
  const link = $('#site-link');
  if (link && site) {
    link.href = site;
    link.textContent = site.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  if (st && cache.ping && cache.ping.version) {
    pill.title = `${pill.title} · 插件 v${cache.ping.version}`;
  }
}

function populateAccountSelect() {
  const sel = $('#flow-account');
  if (!sel) return;
  const accounts = (cache.state && cache.state.accounts) || [];
  const current = filters.account;

  // 注意：replaceChildren 只吃 Node / string，数组必须展开，否则直接抛 TypeError
  sel.replaceChildren(
    h('option', { value: '', text: '全部账号' }),
    ...accounts.map((a) => h('option', { value: a.key, text: a.label || a.masked || a.key })),
  );

  if (current && accounts.some((a) => a.key === current)) sel.value = current;
  else { sel.value = ''; filters.account = ''; }
  sel.disabled = accounts.length === 0;
}

// ── 标签页切换 ────────────────────────────────────────────

function activateTab(name, { focus = false, force = false } = {}) {
  const tab = $(`.tab[data-tab="${name}"]`);
  if (!tab) return;
  activeTab = name;

  for (const btn of $$('.tab')) {
    const on = btn === tab;
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
  }
  for (const panel of $$('.panel')) {
    panel.hidden = panel.dataset.panel !== name;
  }
  if (focus) tab.focus();

  // 离开密钥页就丢掉「只显示一次」的完整钥匙，避免它一直留在屏幕上
  if (name !== 'keys' && lastSecret) {
    lastSecret = null;
    renderSecret();
  }

  ensureTab(name, force);
}

function ensureTab(name, force = false) {
  if (name === 'catalog') return loadCatalog(force);
  if (name === 'wallet') return loadWallet(force);
  // 密钥页有两块独立内容：钥匙列表（要 PAT）与绑定说明（不需要）。
  // 绑定说明必须一起拉，否则「怎么绑进 magpie」会永远停在加载中——
  // 它只有 loadBind 里才会被填，而 loadBind 之前只在刷新按钮里被调到。
  if (name === 'keys') return Promise.all([loadKeys(force), loadBind(force)]);
  if (name === 'pat') return loadPat(force);
  return Promise.resolve();
}

function bindTabs() {
  const tabs = $$('.tab');
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
    tab.addEventListener('keydown', (ev) => {
      let next = -1;
      if (ev.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (ev.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = tabs.length - 1;
      else return;
      ev.preventDefault();
      activateTab(tabs[next].dataset.tab, { focus: true });
    });
  });
}

// ── 1. 模型广场（纯展示） ─────────────────────────────────

async function loadCatalog(force = false) {
  if (cache.catalog && !force) { renderCatalog(); return cache.catalog; }
  if (loading.catalog) return cache.catalog;

  loading.catalog = true;
  regionLoading($('#catalog-body'), '正在读取模型目录');

  try {
    const data = await api.catalog(force);
    cache.catalog = data;
    clearBanner('catalog');
    renderCatalog();
    return data;
  } catch (err) {
    const msg = describeError(err);
    banner('error', `读取模型目录失败：${msg}`, { key: 'catalog' });
    regionError($('#catalog-body'), `模型目录没读到：${msg}`, () => loadCatalog(true));
    $('#catalog-meta').replaceChildren();
    return null;
  } finally {
    loading.catalog = false;
  }
}

function catalogCounts(data) {
  if (data && data.counts) return data.counts;
  if (cache.state && cache.state.counts) return cache.state.counts;
  const models = (data && data.models) || [];
  return {
    models: new Set(models.map((m) => m.name)).size,
    rows: models.length,
    groups: ((data && data.groups) || []).length,
  };
}

function renderCatalog() {
  const data = cache.catalog;
  const body = $('#catalog-body');
  const meta = $('#catalog-meta');
  if (!data || !body) return;

  const models = data.models || [];
  const groups = data.groups || [];
  const groupMap = new Map(groups.map((g) => [g.id, g]));

  renderGroupChips(groups, models);

  const counts = catalogCounts(data);
  const query = filters.q.trim().toLowerCase();
  const rows = models.filter((m) => {
    if (filters.group && m.group !== filters.group) return false;
    if (filters.kind && m.kind !== filters.kind) return false;
    if (!query) return true;
    const hay = [m.name, m.id, m.group, m.vendor, m.description, m.tags].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(query);
  });

  meta.replaceChildren(
    h('span', { class: 'stat' }, h('b', { text: fmtInt(counts.models) }), '个模型'),
    h('span', { class: 'stat' }, h('b', { text: fmtInt(counts.rows) }), '行'),
    h('span', { class: 'stat' }, h('b', { text: fmtInt(counts.groups) }), '个分组'),
    h('span', { class: 'spacer' }),
    h('span', {
      class: 'muted',
      text: `当前显示 ${fmtInt(rows.length)} 行 · 来源 ${SOURCE_LABEL[data.source] || data.source || '未知'} · 更新于 ${fmtAt(data.at)}`,
    }),
  );

  if (!rows.length) {
    body.replaceChildren(h('div', { class: 'empty', text: '没有符合条件的模型。放宽分组或搜索词再试。' }));
    return;
  }

  const tableRows = rows.map((m) => catalogRow(m, groupMap));
  body.replaceChildren(tableEl(
    ['模型名', '分组', '倍率', '输入价', '输出价', '缓存价', '端点', '说明'],
    tableRows,
  ));
}

function renderGroupChips(groups, models) {
  const host = $('#group-chips');
  if (!host) return;

  const counts = new Map();
  for (const m of models) counts.set(m.group, (counts.get(m.group) || 0) + 1);

  const chips = [
    h('button', {
      class: 'chip', type: 'button',
      'aria-pressed': String(filters.group === ''),
      onclick: () => { filters.group = ''; renderCatalog(); },
    }, '全部', h('span', { class: 'chip-count', text: String(models.length) })),
  ];

  for (const g of groups) {
    chips.push(h('button', {
      class: 'chip', type: 'button',
      'aria-pressed': String(filters.group === g.id),
      title: [
        g.auto ? 'auto 分组：费率取决于实际命中的通道' : (g.ratio != null ? `分组倍率 ${g.ratio}×` : ''),
        g.note || '',
      ].filter(Boolean).join(' · '),
      onclick: () => {
        filters.group = filters.group === g.id ? '' : g.id;
        renderCatalog();
      },
    }, g.id, h('span', { class: 'chip-count', text: String(counts.get(g.id) || g.models || 0) })));
  }

  host.replaceChildren(...chips);
}

function catalogRow(m, groupMap) {
  const info = groupMap.get(m.group);
  const isAuto = m.group === 'auto' || (info && info.auto === true);
  const pricing = m.pricing || {};
  const priceKind = pricing.kind || 'unknown';
  const ratio = m.groupRatio != null ? m.groupRatio : (info ? info.ratio : null);

  const nameCell = h('td', { class: 'col-name' },
    h('button', {
      class: 'name-btn', type: 'button',
      title: '查看这个模型的计费表达式与分档',
      onclick: () => openModelDrawer(m),
    }, m.name || m.id || '未命名'),
    m.vendor ? h('span', { class: 'vendor', text: m.vendor }) : null,
  );

  const cells = [
    nameCell,
    { text: m.group || '—', cls: 'mono' },
    {
      text: ratio == null ? '—' : fmtRatio(ratio),
      cls: 'num',
      title: isAuto ? 'auto 分组没有固定倍率，按实际命中通道计费' : (ratio != null ? `分组倍率 ${ratio}×` : '站点没有给出倍率'),
    },
  ];

  // 价格三列：auto 与 unknown 都用一格跨三列，避免三格重复同一句提示。
  if (isAuto) {
    cells.push({ node: h('td', {
      colspan: 3, class: 'muted price-merged',
      title: 'auto 分组没有固定倍率，实际费率取决于命中的通道',
    }, '以实际命中通道为准') });
  } else if (priceKind === 'unknown') {
    cells.push({ node: h('td', {
      colspan: 3, class: 'unknown price-merged',
      title: pricing.note || '站点没有给出可解析的价格',
    }, '价格未知') });
  } else {
    cells.push(
      { text: pricing.input || '—', cls: 'num', title: pricing.note || null },
      { text: pricing.output || '—', cls: 'num', title: pricing.note || null },
      { text: pricing.cache || '—', cls: 'num', title: pricing.note || null },
    );
  }

  const endpoints = Array.isArray(m.endpoints) ? m.endpoints : [];
  cells.push({
    node: h('td', null, endpoints.length
      ? h('span', { class: 'ep-list' }, endpoints.map((e) => h('span', { class: 'ep', text: e })))
      : h('span', { class: 'muted', text: '—' })),
  });

  const desc = m.description || m.tags || '';
  cells.push({
    text: desc || '—',
    cls: 'col-desc',
    title: [desc, m.tags ? `tags: ${m.tags}` : '', pricing.note || '', m.context ? `上下文 ${fmtInt(m.context)}` : '']
      .filter(Boolean).join('\n'),
  });

  return cells;
}

function bindCatalogControls() {
  const search = $('#catalog-search');
  const kind = $('#catalog-kind');
  const reset = $('#catalog-reset');

  search.addEventListener('input', () => {
    filters.q = search.value;
    if (cache.catalog) renderCatalog();
  });
  kind.addEventListener('change', () => {
    filters.kind = kind.value;
    if (cache.catalog) renderCatalog();
  });
  reset.addEventListener('click', () => {
    filters.group = '';
    filters.kind = '';
    filters.q = '';
    search.value = '';
    kind.value = '';
    if (cache.catalog) renderCatalog();
    search.focus();
  });
}

// ── 2. 余额与用量 ─────────────────────────────────────────

async function loadWallet(force = false) {
  await loadState(force);
  renderAccounts();
  await Promise.all([loadUsage(force), loadFlow(force)]);
}

function renderAccounts() {
  const box = $('#account-body');
  const sub = $('#account-sub');
  if (!box) return;

  if (cache.stateError) {
    regionError(box, `账户信息没读到：${cache.stateError}`, () => loadState(true).then(renderAccounts));
    if (sub) sub.textContent = '';
    return;
  }
  const st = cache.state;
  if (!st) { regionLoading(box, '正在读取账户'); if (sub) sub.textContent = ''; return; }

  const accounts = st.accounts || [];
  if (sub) sub.textContent = accounts.length ? `${accounts.length} 个账号` : '';
  if (!accounts.length) {
    box.replaceChildren(h('div', { class: 'empty', text: '还没有绑定任何账号。在 magpie 里添加 DragonAPI 账号后，钥匙与余额会出现在这里。' }));
    return;
  }

  box.replaceChildren(...accounts.map((a) => h('div', { class: 'acct' },
    h('div', { class: 'acct-top' },
      h('span', { class: 'acct-label', text: a.label || a.tokenName || '未命名账号' }),
      a.group ? h('span', { class: 'tag', text: a.group }) : null,
      h('span', { class: 'acct-mask', text: a.masked || '' }),
    ),
    h('div', { class: 'acct-figs' },
      fig('余额', a.balance ?? '—', 'big pos', Number.isFinite(a.balanceRaw) ? `${fmtInt(a.balanceRaw)} quota` : ''),
      fig('已用', a.used ?? '—', '', Number.isFinite(a.usedRaw) ? `${fmtInt(a.usedRaw)} quota` : ''),
      fig('模型数', Number.isFinite(a.models) ? fmtInt(a.models) : '—'),
      fig('绑定于', fmtAt(a.boundAt)),
    ),
  )));
}

function fig(k, v, cls = '', title = '') {
  return h('div', { class: 'fig' },
    h('span', { class: 'fig-k', text: k }),
    h('span', { class: `fig-v ${cls}`.trim(), title: title || null, text: v }),
  );
}

async function loadUsage(force = false) {
  const range = filters.range;
  if (cache.usage[range] && !force) { renderUsage(); return cache.usage[range]; }
  if (loading.usage) return cache.usage[range] || null;

  loading.usage = true;
  regionLoading($('#usage-body'), `正在读取${RANGE_LABEL[range]}用量`);

  try {
    const data = await api.usage(range);
    cache.usage[range] = data;
    clearBanner('usage');
    renderUsage();
    renderFlow();
    return data;
  } catch (err) {
    const msg = describeError(err);
    banner('error', `读取${RANGE_LABEL[range]}用量失败：${msg}`, { key: 'usage' });
    regionError($('#usage-body'), `用量没读到：${msg}`, () => loadUsage(true));
    return null;
  } finally {
    loading.usage = false;
  }
}

function renderUsage() {
  const box = $('#usage-body');
  if (!box) return;
  const data = cache.usage[filters.range];

  if (!data) {
    regionLoading(box, '正在读取用量');
    return;
  }

  const byModel = data.byModel || [];
  const rows = byModel.map((m) => [
    { text: m.model || '—', cls: 'mono' },
    { text: fmtInt(m.calls), cls: 'num' },
    { text: fmtInt(m.tokens), cls: 'num' },
    { text: m.cost || '—', cls: 'num', title: Number.isFinite(m.costRaw) ? `${fmtInt(m.costRaw)} quota` : null },
  ]);

  box.replaceChildren(
    h('div', { class: 'summary-row' },
      h('div', { class: 'summary-box' },
        h('span', { class: 'fig-k', text: '花费 spent' }),
        h('div', { class: 'fig-v', text: data.spent || '—' })),
      h('div', { class: 'summary-box' },
        h('span', { class: 'fig-k', text: 'tokens' }),
        h('div', { class: 'fig-v', text: fmtInt(data.tokens) })),
    ),
    h('p', { class: 'range-note', text: `区间 ${fmtAt(data.start)} → ${fmtAt(data.end)}` }),
    tableEl([{ label: '模型' }, { label: '调用', cls: 'num' }, { label: 'tokens', cls: 'num' }, { label: '费用', cls: 'num' }],
      rows, { empty: '这个区间还没有按模型的用量。' }),
  );
}

async function loadFlow(force = false) {
  const account = filters.account;
  if (!account) { renderFlow(); return null; }        // 全部账号直接用 usage.rows
  if (cache.logs[account] && !force) { renderFlow(); return cache.logs[account]; }
  if (loading.logs) return cache.logs[account] || null;

  loading.logs = true;
  renderFlow();
  try {
    const data = await api.logs(account);
    // 契约写的是「同 rows 的扁平列表」，可能直接是数组，也可能包在 rows 里
    const rows = Array.isArray(data) ? data : (data.rows || data.logs || []);
    cache.logs[account] = rows;
    clearBanner('logs');
    renderFlow();
    return rows;
  } catch (err) {
    const msg = describeError(err);
    banner('error', `读取账号流水失败：${msg}`, { key: 'logs' });
    regionError($('#flow-body'), `流水没读到：${msg}`, () => loadFlow(true));
    return null;
  } finally {
    loading.logs = false;
  }
}

function renderFlow() {
  const box = $('#flow-body');
  const count = $('#flow-count');
  if (!box) return;

  const account = filters.account;
  const source = account ? cache.logs[account] : (cache.usage[filters.range] && cache.usage[filters.range].rows);

  if (source === undefined) {
    regionLoading(box, account ? '正在读取该账号的流水' : '正在读取用量流水');
    if (count) count.textContent = '';
    return;
  }

  const rows = (source || []).slice(0, 200);
  if (count) {
    count.textContent = account
      ? `${fmtInt(rows.length)} 行 · 仅该账号`
      : `${fmtInt(rows.length)} 行 · 多账号合并`;
  }

  const tableRows = rows.map((r) => [
    { text: r.atText || fmtAt(r.at), cls: 'mono' },
    { text: r.model || '—', cls: 'mono' },
    { text: r.group || '—', cls: 'mono' },
    { text: r.tokenName || '—', cls: 'mono' },
    { text: fmtInt(r.input), cls: 'num' },
    { text: fmtInt(r.output), cls: 'num' },
    { text: fmtInt(r.cache), cls: 'num' },
    { text: r.cost || '—', cls: 'num', title: Number.isFinite(r.costRaw) ? `${fmtInt(r.costRaw)} quota` : null },
    {
      text: r.detail || (r.kind ? r.kind : '—'),
      cls: 'col-desc',
      title: [
        r.detail || '',
        r.kind ? `类型 ${r.kind}` : '',
        Number.isFinite(r.tps) ? `TPS ${r.tps}` : '',
        Number.isFinite(r.ttft) ? `TTFT ${r.ttft}s` : '',
        Number.isFinite(r.dur) ? `耗时 ${r.dur}s` : '',
        r.isStream ? '流式' : '',
      ].filter(Boolean).join('\n'),
    },
  ]);

  box.replaceChildren(tableEl(
    ['时间', '模型', '分组', '令牌名', { label: '输入', cls: 'num' }, { label: '输出', cls: 'num' },
      { label: '缓存', cls: 'num' }, { label: '费用', cls: 'num' }, '详情'],
    tableRows,
    { empty: account ? '这个账号还没有用量记录。' : '这个区间还没有用量记录。' },
  ));
}

function bindWalletControls() {
  for (const btn of $$('.segmented [data-range]')) {
    btn.addEventListener('click', () => {
      const range = btn.dataset.range;
      if (filters.range === range) return;
      filters.range = range;
      for (const other of $$('.segmented [data-range]')) {
        other.setAttribute('aria-pressed', String(other === btn));
      }
      loadUsage(false).then(renderFlow);
    });
  }

  const account = $('#flow-account');
  account.addEventListener('change', () => {
    filters.account = account.value;
    if (!filters.account) { renderFlow(); return; }
    loadFlow(false);
  });
}

// ── 3. 密钥 ───────────────────────────────────────────────

async function loadKeys(force = false) {
  if (cache.keys && !force) { renderKeys(); return cache.keys; }
  if (loading.keys) return cache.keys;

  loading.keys = true;
  regionLoading($('#keys-body'), '正在读取钥匙列表');

  try {
    const data = await api.keys();
    cache.keys = data;
    clearBanner('keys');
    renderKeys();
    return data;
  } catch (err) {
    const msg = describeError(err);
    banner('error', `读取钥匙列表失败：${msg}`, { key: 'keys' });
    regionError($('#keys-body'), `钥匙列表没读到：${msg}`, () => loadKeys(true));
    renderKeyGroupOptions();
    return null;
  } finally {
    loading.keys = false;
  }
}

function keyGroups() {
  const data = cache.keys;
  if (data && Array.isArray(data.groups) && data.groups.length) {
    return data.groups.map((g) => (typeof g === 'string' ? { id: g } : g));
  }
  const st = cache.state;
  if (st && Array.isArray(st.groups) && st.groups.length) {
    return st.groups.map((g) => ({ id: g.id, ratio: g.ratio, auto: g.auto, note: g.note }));
  }
  return [];
}

function renderKeyGroupOptions() {
  const sel = $('#key-group');
  const submit = $('#key-submit');
  if (!sel) return;

  const groups = keyGroups();
  const previous = sel.value;
  sel.replaceChildren(...groups.map((g) => h('option', {
    value: g.id,
    text: g.auto
      ? `${g.id}（auto · 按命中通道计费）`
      : (g.ratio != null ? `${g.id} · ${g.ratio}×` : g.id),
  })));
  if (previous && groups.some((g) => g.id === previous)) sel.value = previous;

  sel.disabled = groups.length === 0;
  if (submit) submit.disabled = groups.length === 0;

  if (!groups.length) {
    const hasPat = Boolean(cache.state && cache.state.pat && cache.state.pat.set);
    banner('warn', hasPat
      ? '服务端没有返回可建钥匙的分组，可能是 PAT 缺少 api_key:read 权限。'
      : '还没有 PAT，读不到可建钥匙的分组。先到「访问令牌」页设置 PAT。', { key: 'key-groups' });
  } else {
    clearBanner('key-groups');
  }
}

function renderKeys() {
  const box = $('#keys-body');
  const count = $('#keys-count');
  if (!box) return;

  renderKeyGroupOptions();
  if (count) {
    const n = cache.keys && Array.isArray(cache.keys.keys) ? cache.keys.keys.length : 0;
    count.textContent = n ? `${n} 把` : '';
  }

  if (!cache.keys) {
    if (!loading.keys) regionLoading(box, '正在读取钥匙列表');
    return;
  }

  const keys = cache.keys.keys || [];
  if (!keys.length) {
    box.replaceChildren(h('div', { class: 'empty', text: '还没有钥匙。用左边的表单按分组建一把，建完记得立刻复制 sk-。' }));
    return;
  }

  const thead = h('thead', null, h('tr', null,
    ['名称', '分组', '打码', '创建时间', { label: '已用', cls: 'num' }, '状态', '绑定', '操作']
      .map((hd) => {
        const spec = typeof hd === 'string' ? { label: hd } : hd;
        return h('th', { scope: 'col', class: spec.cls || null }, spec.label);
      })));

  const tbody = h('tbody');
  for (const k of keys) {
    const status = keyStatus(k);
    tbody.append(h('tr', null,
      h('td', { class: 'col-name' }, k.name || '未命名'),
      h('td', null, k.group ? h('span', { class: 'tag', text: k.group }) : '—'),
      h('td', { class: 'mono' }, k.masked || '—'),
      h('td', { class: 'mono' }, fmtAt(k.createdAt)),
      h('td', {
        class: 'num',
        title: Number.isFinite(k.used) ? `${fmtInt(k.used)} quota` : null,
      }, moneyRaw(k.used)),
      h('td', null, h('span', { class: status.cls, text: status.label })),
      h('td', null, k.bound
        ? h('span', { class: 'tag ok', text: '已绑定' })
        : h('span', { class: 'tag', text: '未绑定' })),
      h('td', null, keyActions(k)),
    ));

    if (revealed.has(k.id)) {
      tbody.append(h('tr', null, h('td', { colspan: 8 }, h('div', { class: 'reveal-box' },
        h('span', { class: 'reveal-label', text: '完整钥匙' }),
        h('code', { class: 'reveal-value', text: revealed.get(k.id) }),
        copyButton(revealed.get(k.id), '复制'),
        h('button', {
          class: 'btn tiny ghost', type: 'button',
          onclick: () => { revealed.delete(k.id); renderKeys(); },
        }, '收起'),
      ))));
    }
  }

  // 密钥表也走同一套滚动容器 + 提示，别让它在窄屏上悄悄裁掉「状态」「操作」列。
  const wrap = h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' }, thead, tbody));
  const hint = h('p', { class: 'scroll-hint', 'data-overflow': '0', text: '← 左右滑动看完整列 →' });
  markOverflow(wrap, hint);
  box.replaceChildren(hint, wrap);
}

function keyStatus(k) {
  if (Number.isFinite(k.expiredAt) && k.expiredAt > 0 && k.expiredAt < Date.now()) {
    return { label: '已过期', cls: 'tag bad' };
  }
  if (k.status === 1) return { label: '启用', cls: 'tag ok' };
  if (k.status === 2) return { label: '已禁用', cls: 'tag warn' };
  if (k.status === 3) return { label: '已过期', cls: 'tag bad' };
  if (k.status === 4) return { label: '已耗尽', cls: 'tag bad' };
  return { label: k.status == null ? '未知' : `状态 ${k.status}`, cls: 'tag' };
}

function keyActions(k) {
  if (confirmDeleteId === k.id) {
    return h('span', { class: 'row-actions' },
      h('button', {
        class: 'btn tiny danger', type: 'button',
        onclick: () => deleteKey(k),
      }, '确认删除'),
      h('button', {
        class: 'btn tiny ghost', type: 'button',
        onclick: () => { confirmDeleteId = null; renderKeys(); },
      }, '取消'),
    );
  }
  return h('span', { class: 'row-actions' },
    h('button', {
      class: 'btn tiny ghost', type: 'button',
      title: '需要 PAT 的 api_key:reveal 权限',
      onclick: (ev) => revealKey(k, ev.currentTarget),
    }, '查看完整钥匙'),
    h('button', {
      class: 'btn tiny danger', type: 'button',
      onclick: () => { confirmDeleteId = k.id; renderKeys(); },
    }, '删除'),
  );
}

async function revealKey(k, btn) {
  btn.disabled = true;
  btn.textContent = '读取中…';
  try {
    const data = await api.revealKey(k.id);
    if (!data.secret) throw new ApiError('服务端没有返回 secret。', 200, data);
    revealed.set(k.id, data.secret);
    clearBanner('reveal-' + k.id);
    renderKeys();
  } catch (err) {
    const msg = describeError(err);
    banner('error', `查看完整钥匙失败：${msg}`, { key: 'reveal-' + k.id });
    btn.disabled = false;
    btn.textContent = '查看完整钥匙';
  }
}

async function deleteKey(k) {
  confirmDeleteId = null;
  try {
    await api.deleteKey(k.id);
    revealed.delete(k.id);
    cache.keys = null;
    clearBanner('keys');
    banner('ok', `已删除钥匙「${k.name || k.masked || k.id}」。`, { key: 'keys-ok', timeout: 6000 });
    await loadKeys(true);
  } catch (err) {
    banner('error', `删除钥匙失败：${describeError(err)}`, { key: 'keys' });
    renderKeys();
  }
}

function renderSecret() {
  const slot = $('#secret-slot');
  if (!slot) return;

  if (!lastSecret) { slot.replaceChildren(); return; }

  const { key = {}, bind } = lastSecret;
  const secret = key.secret || '';
  const how = Array.isArray(bind && bind.how)
    ? bind.how
    : (bind && bind.how ? [bind.how] : ((cache.bind && cache.bind.how) || []));

  const valueNode = h('div', { class: 'secret-value', id: 'secret-value', text: secret || '（服务端没有返回 secret）' });

  slot.replaceChildren(h('div', { class: 'secret-card' },
    h('h2', { text: '新钥匙已创建' }),
    h('p', { class: 'secret-warn', text: '这把钥匙只显示这一次，关掉或离开本页就再也看不到，请立刻复制。' }),
    h('div', { class: 'secret-line' },
      valueNode,
      copyButton(secret, '复制'),
      h('button', {
        class: 'btn ghost', type: 'button',
        onclick: () => { lastSecret = null; renderSecret(); },
      }, '我已保存，关闭'),
    ),
    h('p', { class: 'hint', text: `名称 ${key.name || '—'} · 分组 ${key.group || '—'} · id ${key.id ?? '—'}` }),
    how.length ? h('div', null,
      h('p', { class: 'hint', text: '怎么绑进 magpie：' }),
      h('ol', { class: 'bind-steps' }, how.map((step) => h('li', { text: String(step) }))),
    ) : null,
  ));
}

function bindKeyForm() {
  const form = $('#key-form');
  const unlimited = $('#key-unlimited');
  const quota = $('#key-quota');
  const group = $('#key-group');
  const name = $('#key-name');

  unlimited.addEventListener('change', () => {
    quota.disabled = unlimited.checked;
    if (unlimited.checked) quota.value = '';
  });

  // 换分组时给个默认名，省一次手打；用户改过就不覆盖
  group.addEventListener('change', () => {
    if (!name.value.trim() || name.dataset.auto === '1') {
      name.value = group.value ? `Magpie-${group.value}` : '';
      name.dataset.auto = '1';
    }
  });
  name.addEventListener('input', () => { name.dataset.auto = '0'; });

  form.addEventListener('submit', onCreateKey);
}

async function onCreateKey(ev) {
  ev.preventDefault();
  const submit = $('#key-submit');
  const group = $('#key-group').value;
  const name = $('#key-name').value.trim();
  const unlimited = $('#key-unlimited').checked;
  const amount = Number($('#key-quota').value);

  if (!group) {
    banner('warn', '先选一个分组；分组决定这把钥匙能用到哪些模型。', { key: 'key-form' });
    return;
  }
  if (!name) {
    banner('warn', '给钥匙起个名字，之后在控制台里才认得出来。', { key: 'key-form' });
    $('#key-name').focus();
    return;
  }
  if (!unlimited && (!Number.isFinite(amount) || amount <= 0)) {
    banner('warn', '额度要填一个大于 0 的数，或者勾上「无限额度」。', { key: 'key-form' });
    $('#key-quota').focus();
    return;
  }

  // 契约的请求体只写了 name / group / unlimited / expiredAt；
  // 有限额度按契约里 keys[].remain 的语义补 remain（原始 quota），
  // 换算沿用 state.currency 的 per / rate，与金额显示同源。
  const body = { name, group, unlimited, expiredAt: 0 };
  if (!unlimited) body.remain = rawFromMoney(amount);

  submit.disabled = true;
  submit.textContent = '创建中…';
  try {
    const data = await api.createKey(body);
    lastSecret = { key: data.key || {}, bind: data.bind || null };
    renderSecret();
    clearBanner('key-form');
    banner('ok', '钥匙已创建。完整钥匙只显示一次，请立刻复制。', { key: 'key-create', timeout: 9000 });
    $('#key-name').value = '';
    $('#key-name').dataset.auto = '0';
    $('#key-quota').value = '';
    cache.keys = null;
    await loadKeys(true);
    const slot = $('#secret-slot');
    if (slot && slot.firstElementChild) slot.firstElementChild.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (err) {
    const msg = describeError(err);
    banner('error', `创建钥匙失败：${msg}`, { key: 'key-form' });
  } finally {
    submit.disabled = false;
    submit.textContent = '创建钥匙';
  }
}

async function loadBind(force = false) {
  if (cache.bind && !force) { renderBind(); return cache.bind; }
  if (loading.bind) return cache.bind;
  loading.bind = true;
  try {
    cache.bind = await api.bindInfo();
    clearBanner('bind');
    renderBind();
    return cache.bind;
  } catch (err) {
    const msg = describeError(err);
    banner('error', `读取绑定说明失败：${msg}`, { key: 'bind' });
    regionError($('#bind-info-body'), `绑定说明没读到：${msg}`, () => loadBind(true));
    return null;
  } finally {
    loading.bind = false;
  }
}

function renderBind() {
  const box = $('#bind-info-body');
  if (!box) return;
  const data = cache.bind;
  if (!data) { regionLoading(box, '正在读取绑定说明'); return; }

  const how = Array.isArray(data.how) ? data.how : (data.how ? [data.how] : []);
  box.replaceChildren(
    how.length
      ? h('ol', { class: 'bind-steps' }, how.map((step) => h('li', { text: String(step) })))
      : h('p', { class: 'muted', text: '服务端没有给出绑定步骤。' }),
    data.auto && data.auto.label
      ? h('p', { class: 'hint', text: `自动方式：${data.auto.label}（method: ${data.auto.method || '—'}）` })
      : null,
  );
}

// ── 4. 访问令牌（PAT） ────────────────────────────────────

async function loadPat(force = false) {
  await loadState(force);
  renderPat();
  await Promise.all([loadHealth(force), loadPing(force)]);
}

function renderPat() {
  const box = $('#pat-state');
  const badge = $('#pat-badge');
  if (!box) return;

  if (cache.stateError) {
    regionError(box, `PAT 状态没读到：${cache.stateError}`, () => loadState(true).then(renderPat));
    if (badge) badge.textContent = '';
    return;
  }
  const st = cache.state;
  if (!st) { regionLoading(box, '正在读取 PAT 状态'); if (badge) badge.textContent = ''; return; }

  const pat = st.pat || {};
  if (badge) badge.textContent = pat.set ? '已设置' : '未设置';

  if (!pat.set) {
    box.replaceChildren(
      h('p', { class: 'muted', text: '还没有设置 PAT。设置后才能读账户、建钥匙、看钱包。' }),
      h('p', { class: 'hint', text: 'PAT 以 nap_ 开头，在控制台「安全 → 访问令牌」创建。' }),
    );
    return;
  }

  const scopes = Array.isArray(pat.scopes) ? pat.scopes : [];
  box.replaceChildren(
    h('div', { class: 'kv' }, h('span', { class: 'k', text: 'hint' }), h('span', { class: 'v', text: pat.hint || '—' })),
    h('div', { class: 'kv' },
      h('span', { class: 'k', text: 'scopes' }),
      scopes.length
        ? h('span', { class: 'scope-list' }, scopes.map((s) => h('span', { class: 'tag', text: s })))
        : h('span', { class: 'v muted', text: '服务端没有返回 scopes' }),
    ),
  );
}

async function loadPing(force = false) {
  if (cache.ping && !force) return cache.ping;
  try {
    cache.ping = await api.ping();
    renderHeader();
    renderHealth();
    return cache.ping;
  } catch (err) {
    // ping 失败通常意味着服务没起来；state 那条会给出更完整的提示，这里只记一次
    banner('error', `本地服务探测失败：${describeError(err)}`, { key: 'ping' });
    renderHeader();
    return null;
  }
}

async function loadHealth(force = false) {
  if (cache.health && !force) { renderHealth(); return cache.health; }
  if (loading.health) return cache.health;
  loading.health = true;
  try {
    cache.health = await api.health();
    clearBanner('health');
    renderHealth();
    return cache.health;
  } catch (err) {
    banner('error', `读取健康记录失败：${describeError(err)}`, { key: 'health' });
    regionError($('#diag-body'), `健康记录没读到：${describeError(err)}`, () => loadHealth(true));
    return null;
  } finally {
    loading.health = false;
  }
}

function renderHealth() {
  const box = $('#diag-body');
  if (!box) return;

  const health = cache.health;
  const ping = cache.ping;

  if (!health && !ping) { regionLoading(box, '正在读取诊断信息'); return; }

  const head = h('dl', { class: 'kv-grid' },
    h('dt', { text: '插件版本' }), h('dd', { text: ping && ping.version ? `v${ping.version}` : '—' }),
    h('dt', { text: '本地端口' }), h('dd', { text: ping && ping.port != null ? String(ping.port) : '—' }),
    h('dt', { text: '站点' }), h('dd', { text: (cache.state && cache.state.site) || '—' }),
    h('dt', { text: '目录版本' }), h('dd', { text: (cache.state && cache.state.catalogAt) ? fmtAt(cache.state.catalogAt) : '—' }),
  );

  const recent = (health && health.recent) || [];
  const rows = recent.map((r) => [
    { text: fmtAt(r.at), cls: 'mono' },
    { text: r.ok ? '正常' : '失败', cls: r.ok ? 'tag ok' : 'tag bad' },
    { text: SOURCE_LABEL[r.source] || r.source || '—', cls: 'mono' },
    { text: Number.isFinite(r.count) ? fmtInt(r.count) : '—', cls: 'num' },
    { text: Number.isFinite(r.ms) ? `${r.ms} ms` : '—', cls: 'num' },
  ]);

  box.replaceChildren(
    head,
    h('p', { class: 'hint', text: '最近的目录拉取记录：' }),
    tableEl(['时间', '结果', '来源', '条目数', { label: '耗时', cls: 'num' }], rows, { empty: '还没有健康记录。' }),
  );
}

async function onSavePat(ev) {
  ev.preventDefault();
  const input = $('#pat-input');
  const btn = $('#pat-save');
  const pat = input.value.trim();

  if (!pat) { banner('warn', '先粘贴一个 PAT 再保存。', { key: 'pat-form' }); input.focus(); return; }
  if (!pat.startsWith('nap_')) {
    banner('warn', 'PAT 一般以 nap_ 开头，确认一下有没有粘错（sk- 是钥匙，不是 PAT）。', { key: 'pat-form' });
    return;
  }

  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const data = await api.savePat(pat);
    if (cache.state) cache.state.pat = data.pat || { set: true };
    input.value = '';
    clearBanner('pat-form');
    banner('ok', data.user && data.user.name
      ? `PAT 已保存，已连接到账户 ${data.user.name}。`
      : 'PAT 已保存。', { key: 'pat-ok', timeout: 7000 });
    renderPat();
    // PAT 换了，钥匙/余额/用量都可能变，别拿旧缓存骗人
    cache.keys = null;
    cache.health = null;
    cache.stateError = '';
    if (activeTab === 'keys') loadKeys(true);
    return data;
  } catch (err) {
    banner('error', `保存 PAT 失败：${describeError(err)}`, { key: 'pat-form' });
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

async function onClearPat(btn) {
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = '确认清除？';
    setTimeout(() => {
      if (btn.dataset.armed === '1') { btn.dataset.armed = '0'; btn.textContent = '清除 PAT'; }
    }, 4000);
    return;
  }
  btn.dataset.armed = '0';
  btn.textContent = '清除中…';
  btn.disabled = true;
  try {
    const data = await api.clearPat();
    if (cache.state) cache.state.pat = data.pat || { set: false };
    cache.keys = null;
    cache.health = null;
    clearBanner('pat-form');
    banner('ok', 'PAT 已清除，页面不再持有任何凭据。', { key: 'pat-ok', timeout: 6000 });
    renderPat();
    if (activeTab === 'keys') loadKeys(true);
  } catch (err) {
    banner('error', `清除 PAT 失败：${describeError(err)}`, { key: 'pat-form' });
  } finally {
    btn.disabled = false;
    btn.textContent = '清除 PAT';
  }
}

function bindPatControls() {
  $('#pat-form').addEventListener('submit', onSavePat);
  $('#pat-clear').addEventListener('click', (ev) => onClearPat(ev.currentTarget));
  $('#pat-shortcut').addEventListener('click', () => {
    activateTab('pat', { focus: true });
    setTimeout(() => $('#pat-input').focus(), 0);
  });
}

// ── 复制：clipboard 失败就退回「选中文本」 ────────────────

function copyButton(text, label) {
  const btn = h('button', {
    class: 'btn', type: 'button',
    onclick: () => copyText(text, btn, label),
  }, label);
  return btn;
}

async function copyText(text, btn, label = '复制') {
  if (!text) { banner('warn', '没有可复制的内容。', { key: 'copy' }); return; }

  // 首选异步剪贴板；opaque origin / 权限拒绝时它会抛，必须能退回
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      flashButton(btn, label, '已复制');
      return;
    }
  } catch {
    // 继续走下面的兜底
  }

  // 兜底一：临时 textarea + execCommand（老浏览器 / 无权限时还能用）
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    ta.remove();
    if (ok) { flashButton(btn, label, '已复制'); return; }
  } catch {
    // 再退一步
  }

  // 兜底二：选中文本，让用户自己按 Ctrl+C；至少不会静默失败
  const target = btn.closest('.secret-line, .reveal-box, .secret-card');
  const node = target && (target.querySelector('.secret-value, .reveal-value') || target);
  if (node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    flashButton(btn, label, '已选中，按 Ctrl+C');
    banner('warn', '浏览器不允许直接写剪贴板，文本已选中，按 Ctrl+C 复制。', { key: 'copy', timeout: 6000 });
  } else {
    flashButton(btn, label, '复制失败');
    banner('warn', '复制失败，请手动选中钥匙文本。', { key: 'copy', timeout: 6000 });
  }
}

function flashButton(btn, original, temporary) {
  if (!btn) return;
  btn.textContent = temporary;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1600);
}

// ── 单模型详情（抽屉） ────────────────────────────────────

let drawerLastFocus = null;

function openModelDrawer(model) {
  const drawer = $('#drawer');
  if (!drawer) return;
  drawerLastFocus = document.activeElement;

  $('#drawer-title').textContent = model.name || model.id || '模型详情';
  $('#drawer-sub').textContent = [model.group, model.kind].filter(Boolean).join(' · ');
  const body = $('#drawer-body');
  regionLoading(body, '正在读取计费详情');
  drawer.hidden = false;
  $('#drawer-close').focus();

  loadModelDetail(model, body);
}

async function loadModelDetail(model, body) {
  try {
    const data = await api.model(model.group || '', model.name || model.id || '');
    body.replaceChildren(...modelDetailNodes(model, data));
    clearBanner('model');
  } catch (err) {
    const msg = describeError(err);
    banner('error', `读取模型详情失败：${msg}`, { key: 'model' });
    body.replaceChildren(h('div', { class: 'region-error' },
      h('p', { class: 'region-error-text', text: `模型详情没读到：${msg}` }),
      h('p', { class: 'hint', text: '模型广场本身仍然可用，这里只是单模型的分档与表达式。' }),
    ));
  }
}

function modelDetailNodes(model, data) {
  const nodes = [];
  const pricing = model.pricing || {};
  const billing = data.billing || null;

  nodes.push(h('dl', { class: 'kv-grid' },
    h('dt', { text: '模型名' }), h('dd', { text: model.name || '—' }),
    h('dt', { text: '分组' }), h('dd', { text: model.group || '—' }),
    h('dt', { text: '厂商' }), h('dd', { text: model.vendor || '—' }),
    h('dt', { text: '类型' }), h('dd', { text: KIND_LABEL[model.kind] || model.kind || '—' }),
    h('dt', { text: '上下文' }), h('dd', { text: Number.isFinite(model.context) ? fmtInt(model.context) : '—' }),
    h('dt', { text: '端点' }), h('dd', { text: (model.endpoints || []).join(' · ') || '—' }),
    h('dt', { text: '分组倍率' }), h('dd', { text: model.groupRatio != null ? fmtRatio(model.groupRatio) : '—' }),
    h('dt', { text: '价格' }), h('dd', {
      text: pricing.kind === 'unknown'
        ? '价格未知'
        : [pricing.input, pricing.output, pricing.cache].filter(Boolean).join(' · ') || '—',
    }),
  ));

  if (pricing.note) nodes.push(h('p', { class: 'hint', text: `站点说明：${pricing.note}` }));
  if (model.description) nodes.push(h('p', { class: 'hint', text: model.description }));

  if (!billing) {
    nodes.push(h('p', { class: 'muted', text: '服务端没有给出更细的计费信息。' }));
    return nodes;
  }

  nodes.push(h('h3', { class: 'drawer-h3', text: '计费模式' }));
  nodes.push(h('p', { class: 'hint', text: `mode: ${billing.mode || '—'}` }));

  if (billing.expr) {
    nodes.push(h('pre', { class: 'expr', text: String(billing.expr) }));
  }

  const tiers = Array.isArray(billing.tiers) ? billing.tiers : [];
  if (tiers.length) {
    nodes.push(h('h3', { class: 'drawer-h3', text: '分档' }));
    nodes.push(tableEl(['档位', { label: '输入', cls: 'num' }, { label: '输出', cls: 'num' }],
      tiers.map((t) => [
        { text: t.name || '—', cls: 'mono' },
        { text: t.input != null ? String(t.input) : '—', cls: 'num' },
        { text: t.output != null ? String(t.output) : '—', cls: 'num' },
      ])));
  }

  const usages = Array.isArray(billing.usages) ? billing.usages : [];
  if (usages.length) {
    nodes.push(h('h3', { class: 'drawer-h3', text: '按用量计费' }));
    nodes.push(tableEl(['字段', '单位', { label: '单价', cls: 'num' }],
      usages.map((u) => [
        { text: u.field || '—', cls: 'mono' },
        { text: u.unit || '—', cls: 'mono' },
        { text: u.price != null ? String(u.price) : '—', cls: 'num' },
      ])));
  }

  if (billing.schema) {
    nodes.push(h('h3', { class: 'drawer-h3', text: '用量 schema' }));
    nodes.push(h('pre', { class: 'expr', text: safeJson(billing.schema) }));
  }
  if (billing.examples) {
    nodes.push(h('h3', { class: 'drawer-h3', text: '示例' }));
    nodes.push(h('pre', { class: 'expr', text: safeJson(billing.examples) }));
  }

  return nodes;
}

function safeJson(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function closeDrawer() {
  const drawer = $('#drawer');
  if (!drawer || drawer.hidden) return;
  drawer.hidden = true;
  if (drawerLastFocus && typeof drawerLastFocus.focus === 'function') drawerLastFocus.focus();
  drawerLastFocus = null;
}

function bindDrawer() {
  const drawer = $('#drawer');
  if (!drawer) return;

  drawer.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-drawer-close]')) closeDrawer();
  });

  document.addEventListener('keydown', (ev) => {
    if (drawer.hidden) return;
    if (ev.key === 'Escape') { ev.preventDefault(); closeDrawer(); return; }
    if (ev.key !== 'Tab') return;
    // 焦点别跑出抽屉：简单的手工 trap，够用且不引依赖
    const focusables = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', drawer)
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });
}

// ── 数据加载编排 ──────────────────────────────────────────

async function loadState(force = false) {
  if (cache.state && !force) { renderHeader(); return cache.state; }
  if (loading.state) return cache.state;

  loading.state = true;
  try {
    const data = await api.state();
    cache.state = data;
    cache.stateError = '';
    clearBanner('state');
    renderHeader();
    populateAccountSelect();
    renderKeyGroupOptions();
    if (activeTab === 'wallet') renderAccounts();
    if (activeTab === 'pat') renderPat();
    return data;
  } catch (err) {
    const msg = describeError(err);
    cache.stateError = msg;
    banner('error', `读取站点状态失败：${msg}`, { key: 'state' });
    renderHeader();
    if (activeTab === 'wallet') renderAccounts();
    if (activeTab === 'pat') renderPat();
    return null;
  } finally {
    loading.state = false;
  }
}

function clearCache() {
  cache.state = null;
  cache.stateError = '';
  cache.ping = null;
  cache.catalog = null;
  cache.keys = null;
  cache.bind = null;
  cache.health = null;
  cache.usage = {};
  cache.logs = {};
  confirmDeleteId = null;
  revealed.clear();
}

async function refreshAll() {
  const btn = $('#refresh-btn');
  if (!btn) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '刷新中…';

  clearCache();
  try {
    await Promise.allSettled([loadPing(true), loadState(true), loadHealth(true), loadBind(true)]);
    await ensureTab(activeTab, true);
    banner('ok', '已重新拉取最新数据。', { key: 'refresh', timeout: 4000 });
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ── 启动 ──────────────────────────────────────────────────

function bindGlobal() {
  $('#refresh-btn').addEventListener('click', refreshAll);

  const search = $('#catalog-search');
  // 搜索框里按 Esc 清空，符合输入框的常规预期
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && search.value) {
      ev.preventDefault();
      search.value = '';
      filters.q = '';
      if (cache.catalog) renderCatalog();
    }
  });
}

async function boot() {
  initTheme();
  bindGlobal();
  bindTabs();
  bindCatalogControls();
  bindWalletControls();
  bindKeyForm();
  bindPatControls();
  bindDrawer();

  const params = new URLSearchParams(location.search);
  const wanted = params.get('tab');
  const valid = ['catalog', 'wallet', 'keys', 'pat'];
  const start = valid.includes(wanted) ? wanted : 'catalog';

  activateTab(start, { focus: false });

  // 首屏并行拉：状态与目录互不依赖，谁先回来谁先画
  await Promise.allSettled([loadPing(false), loadState(false), ensureTab(start, false)]);
}

boot().catch((err) => {
  // 兜底：boot 里任何没接住的异常都不能变成白屏
  banner('error', `页面初始化失败：${describeError(err)}。可以点右上角「刷新」重试。`, { key: 'boot' });
});
