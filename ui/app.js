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

const filters = { group: '', vendor: '', kind: '', q: '', range: 'day', account: '' };

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

// ── 厂商图标 ──────────────────────────────────────────────
//
// 图标来自同一作者的 magpie-neartoken 仓库（ui/vendor-icons/，MIT），
// 按厂商名做**包含式**匹配：站点的厂商名是中文与英文混着的（「阿里云」
// 「字节跳动」「Black Forest Labs」），精确匹配只能命中一小半。
//
// 匹配不到就退回首字母方块——宁可少一张图，也不要一个破图占位。
const VENDOR_ICONS = [
  [/openai/i, 'OpenAI.svg'],
  [/anthropic|claude|kiro/i, 'Claude.Color.svg'],
  [/google|gemini|巴德/i, 'Gemini.Color.svg'],
  [/deepseek|深度求索/i, 'DeepSeek.Color.svg'],
  [/阿里|qwen|通义|千问/i, 'Qwen.Color.svg'],
  [/moonshot|kimi|月之暗面/i, 'Moonshot.svg'],
  [/xai|grok/i, 'XAI.svg'],
  [/智谱|zhipu|glm/i, 'Zhipu.Color.svg'],
  [/minimax|海螺/i, 'Minimax.Color.svg'],
  [/字节|bytedance|豆包|doubao/i, 'ByteDance.svg'],
  [/即梦|jimeng/i, 'Jimeng.Color.svg'],
  [/ideogram/i, 'Ideogram.svg'],
  [/midjourney/i, 'Midjourney.svg'],
  [/black forest|flux/i, 'Flux.svg'],
  [/腾讯|hunyuan|混元/i, 'Hunyuan.Color.svg'],
  [/小米|mimo/i, 'XiaomiMiMo.svg'],
];

function vendorIconFile(name) {
  const s = String(name || '');
  if (!s) return '';
  for (const [re, file] of VENDOR_ICONS) if (re.test(s)) return file;
  return '';
}

/**
 * vendorBadge 造一个 16px 的厂商标记：有图标用 <img>，没有就用首字母。
 *
 * 图标加载失败时把 img 换成字母块——静态托管里少一个 svg 时，页面上
 * 不该出现一个碎图图标。
 */
function vendorBadge(name, { size = 16, cls = '' } = {}) {
  const file = vendorIconFile(name);
  const label = String(name || '').trim();
  if (!file) {
    return h('span', { class: `vendor-letter ${cls}`.trim(), 'aria-hidden': 'true', text: label.slice(0, 1).toUpperCase() || '?' });
  }
  const img = h('img', {
    class: `vendor-icon ${cls}`.trim(),
    src: 'vendor-icons/' + file,
    alt: '',
    width: size,
    height: size,
    loading: 'lazy',
  });
  img.addEventListener('error', () => {
    img.replaceWith(h('span', { class: `vendor-letter ${cls}`.trim(), 'aria-hidden': 'true', text: label.slice(0, 1).toUpperCase() || '?' }));
  }, { once: true });
  return img;
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
  renderVendorChips(models);
  renderKindSeg(models);
  renderGroupBanner(groups, models);

  const counts = catalogCounts(data);
  const query = filters.q.trim().toLowerCase();
  const rows = models.filter((m) => {
    if (filters.group && m.group !== filters.group) return false;
    if (filters.vendor && (m.vendor || '') !== filters.vendor) return false;
    if (filters.kind && m.kind !== filters.kind) return false;
    if (!query) return true;
    const hay = [m.name, m.id, m.group, m.vendor, m.description, m.tags, ...(m.endpoints || [])]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(query);
  });

  if (meta) {
    // replaceChildren 吃 null 会把它印成字符串「null」——先过滤掉空项再加。
    meta.replaceChildren(...[
      h('b', { text: fmtInt(rows.length) }),
      h('span', { text: ` 个模型 · 全站 ${fmtInt(counts.models)} 个 / ${fmtInt(counts.rows)} 行 / ${fmtInt(counts.groups)} 个分组` }),
      filters.vendor ? h('span', { text: ` · 厂商 ${filters.vendor}` }) : null,
      h('span', { class: 'spacer' }),
      h('span', {
        class: 'muted',
        text: `来源 ${SOURCE_LABEL[data.source] || data.source || '未知'} · 更新于 ${fmtAt(data.at)}`,
      }),
    ].filter(Boolean));
  }

  if (!rows.length) {
    body.replaceChildren(h('div', { class: 'empty', text: '没有符合条件的模型。放宽分组、厂商或搜索词再试。' }));
    return;
  }

  body.replaceChildren(...rows.map((m) => modelCard(m, groupMap)));
}

/** 类型筛选：做成 neartoken 那种分段控件，数量直接跟在标签后面。 */
function renderKindSeg(models) {
  const host = $('#kind-chips');
  if (!host) return;

  const counts = new Map();
  for (const m of models) {
    const k = m.kind || 'chat';
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  const order = ['chat', 'image', 'video', 'audio', 'embedding'];
  const kinds = [...counts.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const seg = [h('button', {
    type: 'button',
    'aria-pressed': String(filters.kind === ''),
    onclick: () => { filters.kind = ''; renderCatalog(); },
  }, '全部', h('span', { class: 'seg-count', text: String(models.length) }))];

  for (const k of kinds) {
    seg.push(h('button', {
      type: 'button',
      'aria-pressed': String(filters.kind === k),
      onclick: () => {
        filters.kind = filters.kind === k ? '' : k;
        renderCatalog();
      },
    }, KIND_LABEL[k] || k, h('span', { class: 'seg-count', text: String(counts.get(k) || 0) })));
  }

  host.replaceChildren(...seg);
}

/** 厂商筛选：侧栏第二组，带 16px 品牌图标。按模型数从多到少排，常用的在上面。 */
function renderVendorChips(models) {
  const host = $('#vendor-chips');
  const total = $('#vendor-total');
  if (!host) return;

  const counts = new Map();
  for (const m of models) {
    const v = String(m.vendor || '').trim();
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }

  const vendors = [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b, 'zh'));
  if (total) total.textContent = String(vendors.length);

  if (!vendors.length) {
    host.replaceChildren(h('p', { class: 'ma-note', text: '站点没有给厂商信息。' }));
    return;
  }

  const chips = [h('button', {
    class: 'market-chip', type: 'button',
    'aria-pressed': String(filters.vendor === ''),
    onclick: () => { filters.vendor = ''; renderCatalog(); },
  }, h('span', { class: 'chip-name', text: '全部厂商' }), h('span', { class: 'chip-count', text: String(models.length) }))];

  for (const v of vendors) {
    chips.push(h('button', {
      class: 'market-chip', type: 'button',
      'aria-pressed': String(filters.vendor === v),
      onclick: () => {
        filters.vendor = filters.vendor === v ? '' : v;
        renderCatalog();
      },
    },
    vendorBadge(v),
    h('span', { class: 'chip-name', text: v }),
    h('span', { class: 'chip-count', text: String(counts.get(v)) })));
  }

  host.replaceChildren(...chips);
}

/** 选中分组时的横幅：分组名、倍率、该组模型数，以及站点对这个分组的说明。 */
function renderGroupBanner(groups, models) {
  const host = $('#group-banner');
  if (!host) return;

  const info = filters.group ? groups.find((g) => g.id === filters.group) : null;
  if (!info) { host.hidden = true; host.replaceChildren(); return; }

  const n = models.filter((m) => m.group === info.id).length;
  const ratio = Number(info.ratio) > 0 ? `×${fmtRatio(info.ratio)}` : (info.auto ? '按命中通道计费' : '');

  host.hidden = false;
  host.replaceChildren(...[
    h('div', { class: 'gb-head' },
      h('span', { class: 'gb-name', text: info.id }),
      ratio ? h('span', { class: 'gb-ratio', text: ratio }) : null,
      h('span', { class: 'gb-count', text: `${n} 个模型` }),
      h('button', {
        class: 'link gb-actions', type: 'button',
        onclick: () => { filters.group = ''; renderCatalog(); },
      }, '取消筛选')),
    info.note ? h('p', { class: 'gb-note', text: info.note }) : null,
  ].filter(Boolean));
}

function renderGroupChips(groups, models) {
  const host = $('#group-chips');
  const total = $('#group-total');
  if (!host) return;

  const counts = new Map();
  for (const m of models) counts.set(m.group, (counts.get(m.group) || 0) + 1);
  if (total) total.textContent = String(groups.length);

  const chips = [
    h('button', {
      class: 'market-chip', type: 'button',
      'aria-pressed': String(filters.group === ''),
      onclick: () => { filters.group = ''; renderCatalog(); },
    }, '全部', h('span', { class: 'chip-count', text: String(models.length) })),
  ];

  for (const g of groups) {
    const ratio = g.ratio != null && Number(g.ratio) > 0 ? `×${fmtRatio(g.ratio)}` : '';
    chips.push(h('button', {
      class: 'market-chip', type: 'button',
      'aria-pressed': String(filters.group === g.id),
      title: [
        g.auto ? '该分组费率取决于实际命中的通道，站点没有给固定倍率' : (ratio ? `分组倍率 ${ratio}` : ''),
        g.note || '',
      ].filter(Boolean).join(' · '),
      onclick: () => {
        filters.group = filters.group === g.id ? '' : g.id;
        renderCatalog();
      },
    },
    h('span', { class: 'chip-name', text: g.id }),
    ratio ? h('span', { class: 'ratio', text: ratio }) : null,
    h('span', { class: 'chip-count', text: String(counts.get(g.id) || g.models || 0) })));
  }

  host.replaceChildren(...chips);
}

/**
 * 一张模型卡。
 *
 * 结构照 NearToken 的模型广场：厂商图标 + 名称/厂商 → 描述 → 计费方式
 * → 价格 → 分组 → 端点 → 详情。等高靠三件事：外层 `.model-grid` 的
 * `align-items: stretch`、卡片自身 `display:flex; flex-direction:column`、
 * 以及尾部 `margin-top:auto` 把页脚按到底。任何一项缺失，同一行卡片就会参差。
 *
 * 刻意没照搬的两处：
 *   1. NearToken 的卡片有「已启用/未启用」开关。我们按既定要求做成纯展示，
 *      不给假开关——本站做不到按模型启停。
 *   2. 它有实时健康度（延迟、吞吐、成功率条）。我们没有这些数据，
 *      编一个出来比留白更糟，所以那个位置换成上下文长度与计费档位。
 */
function modelCard(m, groupMap) {
  const info = groupMap.get(m.group);
  const isAuto = m.group === 'auto' || (info && info.auto === true);
  const pricing = m.pricing || {};
  const priceKind = pricing.kind || 'unknown';
  const ratio = m.groupRatio != null ? m.groupRatio : (info ? info.ratio : null);
  const kind = m.kind || 'chat';
  const endpoints = Array.isArray(m.endpoints) ? m.endpoints : [];

  // 计费方式的说法要跟价格表一致：按次/按秒只给一列，别硬凑出「输出价 —」。
  let billing = { cls: 'flat', label: '按量计费' };
  if (isAuto) billing = { cls: 'auto', label: '以实际命中通道为准' };
  else if (priceKind === 'unknown') billing = { cls: 'unknown', label: '价格未知' };
  else if (priceKind === 'percall') {
    billing = { cls: 'call', label: /\/秒/.test(pricing.input || '') ? '按秒计费' : '按次计费' };
  } else if (priceKind === 'tiered') billing = { cls: 'dyn', label: '分档计费' };

  let priceCells;
  if (isAuto) {
    priceCells = [h('div', { class: 'wide' }, h('span', { text: '单价' }), h('b', { class: 'muted', text: '—' }))];
  } else if (priceKind === 'unknown') {
    priceCells = [h('div', { class: 'wide' }, h('span', { text: '单价' }), h('b', { class: 'unknown', text: '价格未知' }))];
  } else if (priceKind === 'percall') {
    priceCells = [h('div', { class: 'wide' }, h('span', { text: '单价' }), h('b', { text: pricing.input || '—' }))];
  } else {
    priceCells = [
      h('div', null, h('span', { text: '输入' }), h('b', { text: pricing.input || '—' })),
      h('div', null, h('span', { text: '输出' }), h('b', { text: pricing.output || '—' })),
      h('div', null, h('span', { text: '缓存读取' }), h('b', { text: pricing.cache || '—' })),
    ];
  }

  const desc = m.description || '';
  const titleBits = [
    desc,
    m.tags ? `标签：${m.tags}` : '',
    pricing.note || '',
    m.context ? `上下文 ${fmtInt(m.context)}` : '',
    `模型 id：${m.id || ''}`,
  ].filter(Boolean).join('\n');

  const open = () => openModelDrawer(m);

  return h('article', { class: `mc mc-${kind}`, title: titleBits },
    h('div', { class: 'mc-head' },
      h('span', { class: 'mc-vicon' }, vendorBadge(m.vendor, { size: 18 })),
      h('div', { class: 'grow' },
        h('button', {
          class: 'mc-name', type: 'button',
          title: '查看这个模型的计费表达式与分档',
          onclick: open,
        }, m.name || m.id || '未命名'),
        m.vendor ? h('div', { class: 'mc-vendor', text: m.vendor }) : null),
      // 绝大多数是对话模型，每张卡都挂一个「对话」只会变成噪音；只在生图/视频这类上标。
      kind !== 'chat' ? h('span', { class: 'mc-kind', text: KIND_LABEL[kind] || kind }) : null),

    h('p', { class: desc ? 'mc-desc' : 'mc-desc is-empty', text: desc || '站点没有提供说明' }),

    h('div', { class: `mc-billing ${billing.cls}`, text: billing.label }),

    h('div', { class: priceKind === 'percall' || priceKind === 'unknown' || isAuto ? 'mc-prices one' : 'mc-prices' }, priceCells),

    h('div', { class: 'mc-line' },
      h('span', { class: 'k', text: '分组' }),
      h('span', { class: 'mc-group', text: m.group || '—' }),
      ratio != null && Number(ratio) > 0 ? h('span', { class: 'mc-ratio', text: `×${fmtRatio(ratio)}` }) : null),

    h('div', { class: 'mc-line' },
      h('span', { class: 'k', text: '端点' }),
      endpoints.length
        ? h('span', { class: 'mc-ends' }, endpoints.map((e) => h('span', { class: 'mc-end', text: e })))
        : h('span', { class: 'muted', text: '—' })),

    h('div', { class: 'mc-foot' },
      h('span', { class: 'mc-ctx', text: m.context ? `上下文 ${fmtInt(m.context)}` : '' }),
      h('button', { class: 'link', type: 'button', onclick: open }, '详情')));
}

function bindCatalogControls() {
  const search = $('#catalog-search');
  const reset = $('#catalog-reset');

  search.addEventListener('input', () => {
    filters.q = search.value;
    if (cache.catalog) renderCatalog();
  });

  // 类型筛选现在是主区的分段控件（renderKindSeg），不再是一个 select。
  reset.addEventListener('click', () => {
    filters.group = '';
    filters.vendor = '';
    filters.kind = '';
    filters.q = '';
    search.value = '';
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

  box.replaceChildren(...accounts.map((a) => {
    const mask = a.masked || '';
    // 服务端的 label 本身就是「分组 · 打码钥匙」，再单列一次打码就是重复。
    // 只在 label 里没有它时才单独显示。
    const showMask = mask && !String(a.label || '').includes(mask);
    // 余额是「—」不是因为没有余额，而是插件进程还没拿到这把钥匙的明文
    // （冷启动后要等宿主调一次 models/usage 才会填）。说清楚，别让人以为没钱了。
    const noKeyHint = a.balance === '—'
      ? '插件还没拿到这把钥匙的明文：在 magpie 里发一次请求、或点右上角「刷新」即可'
      : '';
    return h('div', { class: 'acct' },
      h('div', { class: 'acct-top' },
        h('span', { class: 'acct-label', text: a.label || a.tokenName || '未命名账号' }),
        a.group ? h('span', { class: 'tag', text: a.group }) : null,
        showMask ? h('span', { class: 'acct-mask', text: mask }) : null,
      ),
      h('div', { class: 'acct-figs' },
        fig('余额', a.balance ?? '—', 'big pos', noKeyHint || (Number.isFinite(a.balanceRaw) ? `${fmtInt(a.balanceRaw)} quota` : '')),
        fig('已用', a.used ?? '—', '', Number.isFinite(a.usedRaw) ? `${fmtInt(a.usedRaw)} quota` : ''),
        fig('模型数', Number.isFinite(a.models) ? fmtInt(a.models) : '—'),
        fig('绑定于', fmtAt(a.boundAt)),
      ),
    );
  }));
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
    cache.keysNeedPat = false;
    clearBanner('keys');
    renderKeys();
    return data;
  } catch (err) {
    const msg = describeError(err);
    // 「还没设 PAT」是刚装好时的正常状态，不是错误。这里不该甩红条，
    // 该直接告诉他下一步做什么——否则第一次打开就像插件坏了。
    const needPat = err instanceof ApiError && err.status === 400 && /访问令牌/.test(msg);
    if (needPat) {
      cache.keysNeedPat = true;
      cache.keysError = '';
      clearBanner('keys');
      renderKeys();
      renderKeyGroupOptions();
      return null;
    }
    cache.keysNeedPat = false;
    cache.keysError = msg;
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
    if (cache.keysNeedPat) {
      // 首次打开、还没设 PAT：给一条通往「访问令牌」页的路，而不是报错。
      box.replaceChildren(h('div', { class: 'empty guide' },
        h('p', { text: '还没设置访问令牌（PAT），所以读不到钥匙列表，也不能建钥匙。' }),
        h('p', { class: 'muted', text: 'PAT 只能在浏览器里登录控制台后创建：头像 → 安全 → 访问令牌，勾上 profile:read、api_key:read、api_key:write。' }),
        h('button', {
          class: 'btn primary', type: 'button',
          onclick: () => activateTab('pat', { focus: true }),
        }, '去设置访问令牌')));
      return;
    }
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
  if (badge) badge.textContent = pat.set ? (pat.verified ? '已设置 · 已验证' : '已设置 · 未验证') : '未设置';

  if (!pat.set) {
    box.replaceChildren(
      h('p', { class: 'muted', text: '还没有设置 PAT。设置后才能读账户、建钥匙、看钱包。' }),
      h('p', { class: 'hint', text: 'PAT 以 nap_ 开头，在控制台「安全 → 访问令牌」创建。' }),
    );
    return;
  }

  const scopes = Array.isArray(pat.scopes) ? pat.scopes : [];
  box.replaceChildren(...[
    pat.verified === false
      ? h('p', { class: 'hint', text: '这份令牌保存时没能连上站点验证，可能是站点一时不可达；点右上角「刷新」或在密钥页试一次就能确认它是否可用。' })
      : null,
    h('div', { class: 'kv' }, h('span', { class: 'k', text: 'hint' }), h('span', { class: 'v', text: pat.hint || '—' })),
    h('div', { class: 'kv' },
      h('span', { class: 'k', text: 'scopes' }),
      scopes.length
        ? h('span', { class: 'scope-list' }, scopes.map((s) => h('span', { class: 'tag', text: s })))
        : h('span', { class: 'v muted', text: '还没有验到可用的 scope' }),
    ),
  ].filter(Boolean));
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
    // warning 是「存下了，但你该知道」：缺 scope 或没能验证。不能当成成功一笔带过，
    // 也不该当失败——令牌本身已经收下了。
    if (data.warning) {
      banner('warn', data.warning, { key: 'pat-ok' });
    } else {
      banner('ok', data.user && data.user.name
        ? `PAT 已保存，已连接到账户 ${data.user.name}。`
        : 'PAT 已保存。', { key: 'pat-ok', timeout: 7000 });
    }
    renderPat();
    // PAT 换了，钥匙/余额/用量都可能变，别拿旧缓存骗人
    cache.keys = null;
    cache.health = null;
    cache.stateError = '';
    if (activeTab === 'keys') loadKeys(true);
    return data;
  } catch (err) {
    // 服务端在 400 里带的 hint 是可操作的下一步（去勾哪个 scope），必须带出来。
    const extra = err && err.payload && err.payload.hint ? ` ${err.payload.hint}` : '';
    banner('error', `保存 PAT 失败：${describeError(err)}${extra}`, { key: 'pat-form' });
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

  const kind = model.kind || 'chat';
  $('#drawer-title').textContent = model.name || model.id || '模型详情';
  $('#drawer-sub').replaceChildren(...[
    h('span', { class: 'tag-chip', text: model.group || '未分组' }),
    model.groupRatio != null && Number(model.groupRatio) > 0
      ? h('span', { class: 'tag-chip' }, '倍率 ', h('span', { class: 'ratio', text: fmtRatio(model.groupRatio) }))
      : null,
    model.vendor ? h('span', { class: 'tag-chip' }, vendorBadge(model.vendor, { size: 12 }), ' ', model.vendor) : null,
    h('span', { class: 'tag-chip', text: KIND_LABEL[kind] || kind }),
  ].filter(Boolean));

  const icon = $('#drawer-icon');
  if (icon) icon.replaceChildren(vendorBadge(model.vendor, { size: 30 }));

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

/** 计费因子 → 人话。站点 DSL 里的变量名不该原样丢给用户。 */
const COEFF_LABEL = {
  input: '输入',
  output: '输出',
  cacheRead: '缓存读取',
  cacheWrite: '缓存写入',
  cacheWrite1h: '缓存写入（1 小时）',
};
const PARAM_LABEL = { service_tier: '服务档' };

/**
 * modelDetailNodes 把详情抽屉的内容造出来。
 *
 * 这条路径以前的形态是「把站点原文倒出来」：`mode: tiered_expr`、一整行
 * `tier("standard", p * 0.2 + …)`、分档表两列全是「—」、示例是 `[]`。
 * 用户看到的是一屏机器串，读不出任何结论。
 *
 * 现在的顺序按「先结论、后证据」：
 *   价签 → 概览 → 计费怎么算（中文）→ 每档实际单价 → 按用量单价 → 原始表达式（折叠）
 */
function modelDetailNodes(model, data) {
  const nodes = [];
  const pricing = model.pricing || {};
  const billing = data.billing || null;
  const priceKind = pricing.kind || 'unknown';
  const isAuto = model.group === 'auto' || model.groupAuto === true;

  // ── 1. 价签：详情页最该先被看到的东西 ──────────────────
  nodes.push(priceTiles(pricing, billing, { isAuto, priceKind }));

  // ── 2. 概览 ────────────────────────────────────────────
  nodes.push(h('dl', { class: 'kv-grid' },
    h('dt', { text: '厂商' }), h('dd', { text: model.vendor || '—' }),
    h('dt', { text: '类型' }), h('dd', { text: KIND_LABEL[model.kind] || model.kind || '—' }),
    h('dt', { text: '上下文' }), h('dd', { class: 'mono', text: model.context ? fmtInt(model.context) : '—' }),
    h('dt', { text: '端点' }), h('dd', { class: 'mono', text: (model.endpoints || []).join(' · ') || '—' }),
    h('dt', { text: '分组' }), h('dd', { text: model.group || '—' }),
    h('dt', { text: '分组倍率' }), h('dd', { class: 'mono', text: model.groupRatio != null && Number(model.groupRatio) > 0 ? fmtRatio(model.groupRatio) : '—' }),
    h('dt', { text: '模型 id' }), h('dd', { class: 'mono' }, model.id || '—'),
  ));

  if (model.description) nodes.push(h('p', { class: 'hint', text: model.description }));

  // ── 3. 计费怎么算 ──────────────────────────────────────
  const facts = billingFacts(billing, { isAuto, priceKind, note: pricing.note });
  nodes.push(h('section', { class: 'dtl-section' },
    h('h3', { class: 'dtl-h3', text: '计费方式' }),
    facts.length
      ? h('ul', { class: 'dtl-facts' }, facts.map((f) => h('li', null, f)))
      : h('p', { class: 'hint', text: '站点没有给出这个模型的计费规则。' }),
  ));

  if (!billing) {
    nodes.push(h('p', { class: 'hint', text: '这一条没有更细的计费信息（站点目录里没有它的 billing 配置）。' }));
    return nodes;
  }

  // ── 4. 每档实际单价 ────────────────────────────────────
  const tiers = Array.isArray(billing.tiers) ? billing.tiers : [];
  const priced = tiers.filter((t) => t.prices && Object.keys(t.prices).length);
  if (priced.length) {
    const hasWrite = priced.some((t) => t.prices.cacheWrite || t.prices.cacheWrite1h);
    const headers = ['档位', { label: '输入', cls: 'num' }, { label: '输出', cls: 'num' }, { label: '缓存读取', cls: 'num' }];
    if (hasWrite) headers.push({ label: '缓存写入', cls: 'num' });
    const rows = priced.map((t) => {
      const cells = [
        { text: t.name || '—', cls: 'mono' },
        { text: t.prices.input || '—', cls: 'num' },
        { text: t.prices.output || '—', cls: 'num' },
        { text: t.prices.cacheRead || '—', cls: 'num' },
      ];
      if (hasWrite) cells.push({ text: t.prices.cacheWrite || t.prices.cacheWrite1h || '—', cls: 'num' });
      return cells;
    });
    nodes.push(h('section', { class: 'dtl-section' },
      h('h3', { class: 'dtl-h3', text: '每一档的实际单价（已乘分组倍率）' }),
      tableEl(headers, rows, { empty: '站点没有给出分档价格。' }),
    ));
  }

  // ── 5. 按用量计费（视频 / 按秒） ───────────────────────
  const usageRows = Array.isArray(billing.usageRows) ? billing.usageRows : [];
  if (usageRows.length) {
    nodes.push(h('section', { class: 'dtl-section' },
      h('h3', { class: 'dtl-h3', text: '按用量计费' }),
      tableEl(['字段', '单位', { label: '单价', cls: 'num' }],
        usageRows.map((u) => [
          { text: u.label || u.field || '—', cls: '' },
          { text: u.unit || '—', cls: 'mono' },
          { text: u.price || '—', cls: 'num' },
        ]),
        { empty: '站点没有给出用量单价。' }),
    ));
  }

  // ── 6. 原始表达式（证据，默认折叠） ────────────────────
  if (billing.expr) {
    nodes.push(h('details', { class: 'raw' },
      h('summary', { text: '原始计费表达式（站点原文，一般不用看）' }),
      h('pre', { class: 'expr', text: String(billing.expr) }),
      billing.schema ? h('pre', { class: 'expr', text: `用量 schema\n${safeJson(billing.schema)}` }) : null,
    ));
  }

  // 示例：站点给了才有，空数组不再渲染成一个「[]」吓人。
  const examples = Array.isArray(billing.examples) ? billing.examples : [];
  if (examples.length) {
    nodes.push(h('details', { class: 'raw' },
      h('summary', { text: `站点给的计费示例（${examples.length} 条）` }),
      h('pre', { class: 'expr', text: safeJson(examples) }),
    ));
  }

  return nodes;
}

/** priceTiles 造详情页顶部的价签：能算准就给三格，算不准就直说。 */
function priceTiles(pricing, billing, { isAuto, priceKind }) {
  const one = (label, value, { unknown = false } = {}) => h('div', { class: `dtl-price${unknown ? ' is-unknown' : ''}` },
    h('span', { text: label }),
    h('b', { text: value || '—' }));

  if (isAuto) {
    return h('div', { class: 'dtl-prices one' }, one('单价', pricing.input || '以实际命中通道为准', { unknown: true }));
  }
  if (priceKind === 'unknown') {
    return h('div', { class: 'dtl-prices one' }, one('单价', '价格未知', { unknown: true }));
  }
  if (priceKind === 'percall' || priceKind === 'call') {
    return h('div', { class: 'dtl-prices one' }, one('单价', pricing.input || '—'));
  }

  // 分档模型：首屏给第一档，具体每一档在下面表格里。
  const first = billing && Array.isArray(billing.tiers) ? billing.tiers.find((t) => t.prices && t.prices.input) : null;
  const input = (first && first.prices.input) || pricing.input;
  const output = (first && first.prices.output) || pricing.output;
  const cache = (first && first.prices.cacheRead) || pricing.cache;
  return h('div', { class: 'dtl-prices' },
    one('输入', input),
    one('输出', output),
    one('缓存读取', cache));
}

/**
 * billingFacts 生成「计费怎么算」的中文句子。
 *
 * 只描述站点真的给出来的东西：倍率、档位、服务档加成、用量变量。
 * 算不出来就说算不出来，不替站点编规则。
 */
function billingFacts(billing, { isAuto, priceKind, note } = {}) {
  const facts = [];

  if (isAuto) {
    facts.push('这个分组没有固定倍率：实际单价取决于这次请求命中的通道，站点也算不出一个确定值。');
  }

  if (priceKind === 'ratio') {
    facts.push('按倍率计费：模型倍率 × 分组倍率 × 2 美元 / 百万 token。');
  }

  if (billing && Array.isArray(billing.tiers) && billing.tiers.length) {
    const names = billing.tiers.map((t) => t.name).filter(Boolean);
    const hasTokenPrices = billing.tiers.some((t) => t.prices && Object.keys(t.prices).length);
    facts.push(hasTokenPrices
      ? `共 ${billing.tiers.length} 档：${names.join(' / ')}。下表每一档的单价已经乘上分组倍率 ${fmtRatio(billing.groupRatio)}。`
      : `共 ${billing.tiers.length} 档：${names.join(' / ')}。这些档按用量计费，单价见下表。`);
  }

  const multipliers = billing && Array.isArray(billing.multipliers) ? billing.multipliers : [];
  for (const m of multipliers) {
    const who = PARAM_LABEL[m.param] || m.param;
    facts.push(`当请求的「${who}」是 ${m.value} 时，整单乘 ${m.factor}。`);
  }

  const usageRows = billing && Array.isArray(billing.usageRows) ? billing.usageRows : [];
  if (usageRows.length) {
    const parts = usageRows.slice(0, 3).map((u) => `${u.label || u.field} ${u.price}`);
    facts.push(`按用量计费：${parts.join('、')}${usageRows.length > 3 ? ' 等' : ''}。实际扣费以控制台为准。`);
  }

  if (priceKind === 'percall' && !usageRows.length) {
    facts.push('按次计费：与 token 数无关，每调用一次扣一次。');
  }

  if (priceKind === 'unknown' && !isAuto) {
    facts.push('站点没有给出能解析成单价的规则，所以这里不给数字——编一个出来比留白更糟。');
  }

  if (note) facts.push(`站点说明：${note}`);

  return facts;
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
