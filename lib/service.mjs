// 本地服务：页面真正住的地方。
//
// 为什么要有一个服务，而不是纯静态页面：
//
//   magpie 的插件页跑在 `sandbox="allow-scripts"` 的 iframe 里，CSP 是
//   `connect-src 'none'`——一条 fetch / XHR / WebSocket 都发不出去，连
//   localStorage 都没有。页面唯一能做的联网动作是「把自己导航到别处」。
//
//   所以这里起一个只监听 127.0.0.1 的 HTTP 服务：`page/index.html` 是带路页，
//   它把框架导航到本服务，界面由本服务提供。这也正是社区插件
//   `@magpie-community/page-chat` 的做法。
//
// 两个必须记住的约束：
//
//   1. 导航后文档的 origin 是 opaque（Origin: null），所以所有响应都要带
//      `Access-Control-Allow-Origin: *`，且前端不能用 cookie / storage。
//   2. 服务只听 127.0.0.1。magpie web 部署在别的机器上时，`magpie.service`
//      会给出反代地址，带路页优先用它（见 page/boot.js）。

import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { currencyOf, text, readTokenUsage, readTokenLogs, readSelf, readUsageSelf, readUsageSelfPage, readUsageStatsSelf, readDataSelf, readSubscriptions, normalizePat, readUsableGroups, readKeys, createKey, updateKey, revealKey, deleteKey, probePat, readAff, transferAff } from './site.mjs'
import { buildCatalog, modelsOfGroup } from './catalog.mjs'
import { billingOf } from './pricing.mjs'
import { rowsOf, summarize, windowOf } from './usage.mjs'
import { summarizeDashboard } from './dashboard.mjs'
import { maskKey, tailOf, statePath } from './store.mjs'

/** uniqRows 去重：站点分页偶尔因排序不稳定重叠，按 id（无 id 用关键字段）去重。 */
function uniqRows(rows) {
  const seen = new Set()
  const out = []
  for (const r of rows) {
    const key = Number(r.id) > 0 ? `i${r.id}` : `${r.at}|${r.model}|${r.costRaw}|${r.input}|${r.output}|${r.tokenName}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

const here = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 插件版本，从 package.json 读一次。 */
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version || '0.0.0' } catch { return '0.0.0' }
})()

/** MIME 表只覆盖本插件真正会发的类型。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

/**
 * 一次响应：JSON + CORS + 不缓存（页面是活的，缓存只会让人看到旧数据）。
 *
 * 三个 CORS 头都是必需的，少一个页面就「连不上本地服务」：
 *
 *   Access-Control-Allow-Origin: *            页面是不透明源（Origin: null）
 *   Access-Control-Allow-Private-Network: true 页面在不透明源里请求 127.0.0.1，
 *       Chrome 会按 Private Network Access 先发预检；不放行就整个请求被拦，
 *       而且报错长得像「网络不可达」，极难查。
 *   Access-Control-Allow-Headers / Methods     预检要过的头与方法
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-private-network': 'true',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
}

function json(res, code, body) {
  const data = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    ...CORS,
    'cache-control': 'no-store',
  })
  res.end(data)
}

/**
 * 请求体错误单独一个类型：它该回 400，而不是和内部异常一起回 500。
 * 不加这个区分时，客户端发一个坏 JSON 会被报成「服务器内部错误」，
 * 排查时会误以为是服务挂了。
 */
class BadRequest extends Error {
  constructor(message) { super(message); this.badRequest = true }
}

/**
 * patWarning 给出「已保存，但你该知道」的那句话。
 *
 * 两种需要提醒的情况：
 *   1. 令牌有效但少 scope —— 得指名道姓说清「丢的是哪几件事」，不是笼统一句「权限不足」；
 *   2. 一个端点都没验通，且不是鉴权问题 —— 站连不上，令牌先存着，别吓人。
 */
const SCOPE_LOSS = {
  'profile:read': '读账户资料与建钥匙',
  'api_key:read': '读钥匙列表',
  'usage:read': '读用量流水',
  'wallet:read': '读订阅与扣费偏好',
};

function patWarning(probe) {
  if (probe.verified && probe.missing.length) {
    const lost = probe.missing.map((s) => SCOPE_LOSS[s] || s).join('、');
    const why = probe.failures?.[0]?.message || '权限不足';
    return `已保存，但站点没有放行 ${probe.missing.join(' / ')}：${why}。会失败的是${lost}，其它照常。`;
  }
  if (!probe.verified) {
    const why = probe.failures?.[0]?.message || '站点没有响应';
    return `已保存，但这次没能连上站点验证（${why}）。令牌本身可能没问题，稍后点右上角「刷新」或在密钥页试一次就能确认。`;
  }
  return '';
}

/** 读请求体，限制 1 MB：这里只会收 JSON 小对象。 */
function readBody(req) {
  return new Promise((resolve_, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 1 << 20) { reject(new BadRequest('请求体太大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve_({})
      try { resolve_(JSON.parse(raw)) } catch { reject(new BadRequest('请求体不是 JSON')) }
    })
    req.on('error', reject)
  })
}

/**
 * 静态文件：只允许 ui/ 与 page/ 两个目录，且必须在目录内。
 *
 * 路径穿越在这里不是理论风险——这个服务监听 127.0.0.1，本机任何程序都能打。
 *
 * 导出是给 dev.mjs 用的：本地预览也要按同样规则发静态文件，再自己实现一遍
 * 只会多一份要同步维护的路径校验。返回值表示「有没有发出去」。
 */
export function serveFile(res, root, rel) {
  const clean = normalize(rel).replace(/^([/\\])+/, '')
  if (clean.includes('..')) return false
  const file = resolve(root, clean)
  if (!file.startsWith(resolve(root) + sep) && file !== resolve(root)) return false
  if (!existsSync(file)) return false
  const st = statSync(file)
  if (!st.isFile()) return false
  const body = readFileSync(file)
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': body.length,
    ...CORS,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
  return true
}

/**
 * startService 起本地服务。
 *
 * 这个模块只管「把状态呈现成 HTTP」：路由、CORS、静态文件、JSON 形状。
 * 目录与站点参数**不在这里缓存**——它们各有唯一所有者（catalog-source /
 * status-source），由 index.mjs 或 serve.mjs 注入进来。之前这里也缓存了一份，
 * 结果「页面点刷新」刷的是另一份缓存，按钮点了没用。
 *
 * @param {object} o
 * @param {number} o.port        首选端口；占用时往后试 10 个
 * @param {string} o.dir         magpie 的配置目录（状态文件写这里）
 * @param {string} o.site        站点根地址
 * @param {object} o.catalog     目录源（catalog-source 的实例）
 * @param {object} o.status      站点参数源（status-source 的实例）
 * @param {function} o.getState  取插件状态（账号、PAT、启用分组）
 * @param {function} o.setPat    写/清 PAT
 * @param {function} o.keyOf     按 tail 取钥匙明文（独立模式下没有，返回空）
 */
export async function startService({ port = 3517, dir = '.', site, catalog, status, getState, setPat, keyOf } = {}) {
  if (!catalog || typeof catalog.get !== 'function') throw new Error('startService 需要一个目录源（catalog）')
  if (!status || typeof status.get !== 'function') throw new Error('startService 需要一个站点参数源（status）')

  /**
   * stateOf 把三样东西凑齐：插件状态、站点参数、目录快照。
   *
   * 目录与参数都从注入的源取，这里不做任何缓存——缓存归源所有，
   * 这样「页面点刷新」刷的就是宿主看到的那一份。
   */
  async function stateOf({ refresh = false } = {}) {
    const st = getState ? await getState() : { accounts: {}, pat: '' }
    const [cat, site_] = await Promise.all([catalog.get({ force: refresh }), status.get({ force: refresh })])
    const cur = currencyOf(site_)
    const built = cat.env
      ? buildCatalog(cat.env, { cur, enabledGroups: st.enabledGroups || [], site })
      : { models: {}, rows: [], groups: [], vendors: [], version: '', autoGroups: [] }
    return { st, cat, cur, built, status: site_ }
  }

  async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname
    // 排查用：设 DRAGONAPI_DEBUG=1 时把每条请求打到 stderr。
    // 插件页「连不上」时分不清「请求没到」还是「到了但响应不对」，这一行能分开。
    if (process.env.DRAGONAPI_DEBUG) {
      console.error(`[dragonapi] ${req.method} ${path} origin=${req.headers.origin || '-'} pna=${req.headers['access-control-request-private-network'] || '-'}`)
    }

    // 预检：浏览器的 fetch 带自定义头、或不透明源访问 loopback 时会先问一次。
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...CORS,
        // 允许预检结果缓存，省掉每个请求一次往返。
        'access-control-max-age': '600',
        // PNA 的预检请求会带 Access-Control-Request-Private-Network，
        // 响应必须有 allow-private-network（CORS 里已含），否则整个请求被拦。
        'cache-control': 'no-store',
      })
      res.end()
      return
    }

    // ---- 静态：界面 ----
    //
    // index.html 用相对路径引 style.css / app.js，所以它从 `/` 打开时，
    // 浏览器请求的是 `/style.css`、`/app.js`，不是 `/ui/style.css`。
    // 两种前缀都要认，否则界面只剩 HTML，CSS/JS 全 404——页面看起来就是
    // 一个巨大的裸 SVG（图标）铺满屏幕。
    const uiDir = join(here, 'ui')
    if (path === '/' || path === '/index.html') {
      if (serveFile(res, uiDir, 'index.html')) return
      json(res, 404, { ok: false, error: '界面文件缺失（ui/index.html）' })
      return
    }
    if (path.startsWith('/ui/')) {
      if (serveFile(res, uiDir, path.slice(4))) return
      json(res, 404, { ok: false, error: '没有这个文件' })
      return
    }
    // 根下的界面资源：只放行 ui/ 里真有的文件，其它一律落到 API 或 404。
    if (req.method === 'GET' && /\.(css|js|mjs|svg|png|woff2?|json)$/i.test(path)) {
      if (serveFile(res, uiDir, path.slice(1))) return
    }

    // ---- API ----
    try {
      if (path === '/api/ping' && req.method === 'GET') {
        // 版本从 package.json 读，别硬编码：硬编码的版本号会在升级后说谎，
        // 排查时容易把「旧代码还在跑」误判成「新版没修」。
        json(res, 200, { ok: true, version: PKG_VERSION, port })
        return
      }

      if (path === '/api/state' && req.method === 'GET') {
        const { st, cat, cur, built, status: site_ } = await stateOf()
        const [accounts, userResult] = await Promise.all([
          accountViews(st, cur),
          st.pat ? readSelf(site, st.pat).then((u) => ({
            user: {
              id: u.id, username: u.username, displayName: u.displayName, group: u.group,
              balanceRaw: u.quota, usedRaw: u.usedQuota,
              balance: u.quota === null ? '—' : text(u.quota, cur),
              used: u.usedQuota === null ? '—' : text(u.usedQuota, cur),
            }, userError: '',
          }), (e) => ({ user: null, userError: String(e?.message || e) })) : { user: null, userError: '' },
        ])
        json(res, 200, {
          ok: true,
          ...userResult,
          site,
          siteName: site_?.siteName || 'DragonAPI',
          pat: {
            set: Boolean(st.pat),
            hint: st.patHint || '',
            scopes: st.patScopes || [],
            verified: st.patVerified === true,
            stateFile: statePath(dir),
          },
          currency: cur,
          accounts,
          groups: built.groups,
          counts: {
            models: Array.isArray(cat.env?.data) ? cat.env.data.length : 0,
            rows: built.rows.length,
            groups: built.groups.length,
            vendors: built.vendors.length,
          },
          catalogAt: cat.at,
          health: { ok: cat.source === 'live', source: cat.source, error: cat.error, at: cat.at },
        })
        return
      }

      if (path === '/api/catalog' && req.method === 'GET') {
        // 刷新就是 force：跳过 TTL，但仍然带 ETag 走条件请求。
        // 这里直接让目录源自己刷，不再回调别处的 refresh——那样刷的是另一份缓存。
        const force = url.searchParams.get('refresh') === '1'
        const { cat, cur, built } = await stateOf({ refresh: force })
        json(res, 200, {
          ok: true,
          version: built.version,
          at: cat.at,
          source: cat.source,
          error: cat.error,
          groups: built.groups,
          vendors: built.vendors,
          models: built.rows,
          counts: {
            models: Array.isArray(cat.env?.data) ? cat.env.data.length : 0,
            rows: built.rows.length,
            groups: built.groups.length,
          },
        })
        return
      }

      if (path === '/api/model' && req.method === 'GET') {
        const group = url.searchParams.get('group') || ''
        const model = url.searchParams.get('model') || ''
        const { cat, built, cur } = await stateOf()
        const row = built.rows.find((r) => r.group === group && r.name === model)
        if (!row) { json(res, 404, { ok: false, error: '没有这个模型' }); return }
        const raw = (Array.isArray(cat.env?.data) ? cat.env.data : []).find((m) => String(m?.model_name) === model)
        // 同一个模型往往在好几个分组里卖（按分组定价）。详情页要能横向比较，
        // 所以把同名的其他分组一起给出来，按倍率从低到高排。
        const siblings = built.rows
          .filter((r) => r.name === row.name)
          .map((r) => ({
            group: r.group,
            groupRatio: r.groupRatio,
            auto: r.groupAuto === true,
            input: r.pricing?.input || '',
            output: r.pricing?.output || '',
            cache: r.pricing?.cache || '',
            inputNum: Number.isFinite(r.pricing?.inputNum) ? r.pricing.inputNum : null,
            outputNum: Number.isFinite(r.pricing?.outputNum) ? r.pricing.outputNum : null,
            cacheNum: Number.isFinite(r.pricing?.cacheNum) ? r.pricing.cacheNum : null,
            current: r.group === row.group,
          }))
          .sort((a, b) => (Number(a.groupRatio) || 0) - (Number(b.groupRatio) || 0) || a.group.localeCompare(b.group, 'zh'))
        json(res, 200, { ok: true, model: row, billing: raw ? billingOf(raw, row.groupRatio, cur) : null, siblings })
        return
      }

      if ((path === '/api/usage' || path === '/api/logs') && req.method === 'GET') {
        const range = url.searchParams.get('range') || 'day'
        if (!['day', 'week', 'month'].includes(range)) throw new BadRequest('时间窗必须是 day / week / month')
        const only = url.searchParams.get('account') || ''
        const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 1000))
        const { st, cur } = await stateOf()
        const { start, end } = windowOf(range)
        const options = { pageSize: 100, start, end }
        const all = []
        let siteTotal = null
        const source = st.pat && !only ? 'pat' : 'key'
        if (source === 'pat') {
          // 站点按 100 条一页；按 data.total 把整个时间窗翻完（最多 10 页 / 1000 条），
          // 这样「总计」就是站点真实总条数，而不是本地这 100 行。
          const collected = []
          let page = 1
          for (;;) {
            const { items, total } = await readUsageSelfPage(site, st.pat, { page, pageSize: 100, start, end })
            siteTotal = Number.isFinite(total) ? total : siteTotal
            collected.push(...items)
            if (!items.length || items.length < 100 || (siteTotal != null && collected.length >= siteTotal) || page >= 10) break
            page += 1
          }
          all.push(...uniqRows(rowsOf(collected, cur)))
        } else {
          const entries = Object.entries(st.accounts || {}).filter(([key]) => !only || key === only)
          if (only && !entries.length) throw new BadRequest('没有这个已绑定账号')
          if (!entries.length) throw new BadRequest('需要访问令牌（PAT）或已绑定的 sk 钥匙才能读取用量')
          // 明确请求某把钥匙时绝不回退 PAT；任一失败都不能假装它的用量是零。
          const lists = await Promise.all(entries.map(async ([key, meta]) => {
            const secret = await readAccountKey(key)
            if (!secret) throw new Error(`账号 ${meta?.label || key} 的钥匙尚未载入，无法读取用量`)
            return rowsOf(await readTokenLogs(site, secret, options), cur, meta?.label || key)
          }))
          all.push(...lists.flat())
        }
        all.sort((a, b) => b.at - a.at)
        const rows = all.filter((r) => r.at >= start && r.at <= end)
        const total = siteTotal != null ? siteTotal : rows.length
        const coverage = {
          source, partial: true,
          note: source === 'pat' ? '按所选时间窗统计，最多载入 1000 条日志。' : '按所选时间窗统计每把钥匙最近最多 100 条日志，非完整用量。',
        }
        json(res, 200, path === '/api/usage'
          ? { ok: true, range, total, ...summarize(all, cur, start, end), ...coverage, rows: rows.slice(0, 1000) }
          : { ok: true, range, start, end, total, ...coverage, rows: rows.slice(0, limit) })
        return
      }

      // 数据看板：站点的 /api/data/self 行按时间桶 × 模型聚合，金额留在页面换算。
      if (path === '/api/dashboard' && req.method === 'GET') {
        const days = Math.max(1, Math.min(29, Number(url.searchParams.get('days')) || 1));
        const granularity = url.searchParams.get('granularity') || 'hour';
        if (!['hour', 'day', 'week'].includes(granularity)) throw new BadRequest('粒度必须是 hour / day / week');
        const { st } = await stateOf();
        const end = Date.now();
        const start = end - days * 86400000;
        if (!st.pat) {
          json(res, 200, { ok: true, available: false, reason: '需要访问令牌（PAT）才能读取数据看板' });
          return;
        }
        try {
          const rows = await readDataSelf(site, st.pat, { start, end, granularity });
          json(res, 200, { ok: true, available: true, days, granularity, start, end, ...summarizeDashboard(rows, { start, end }) });
        } catch (err) {
          json(res, 200, { ok: true, available: false, reason: String(err?.message || err) });
        }
        return;
      }

      // 日志页顶部三个胶囊：用量 / RPM / TPM，直接取站点的 /api/log/self/stat。
      // 没有 PAT 时如实标 available:false，页面显示 —，不拿本地 100 行日志冒充全量。
      if (path === '/api/logs/stats' && req.method === 'GET') {
        const range = url.searchParams.get('range') || 'day'
        if (!['day', 'week', 'month'].includes(range)) throw new BadRequest('时间窗必须是 day / week / month')
        const { st } = await stateOf()
        if (!st.pat) {
          json(res, 200, { ok: true, available: false, quota: 0, rpm: 0, tpm: 0, reason: '需要访问令牌（PAT）才能读取统计' })
          return
        }
        const { start, end } = windowOf(range)
        try {
          const stat = await readUsageStatsSelf(site, st.pat, { start, end })
          // 站点的 stat 只给实时速率（常常 0）；RPM/TPM 用 /api/data/self 的同窗口均值补上，
          // 和日志页顶部「平均」的口径一致。
          let rpm = stat.rpm
          let tpm = stat.tpm
          try {
            const rows = await readDataSelf(site, st.pat, { start, end, granularity: range === 'day' ? 'hour' : 'day' })
            const agg = summarizeDashboard(rows, { start, end })
            rpm = agg.totals.avgRpm
            tpm = agg.totals.avgTpm
          } catch { /* 数据看板取不到就退回站点给的实时速率 */ }
          json(res, 200, { ok: true, available: true, quota: stat.quota, rpm, tpm })
        } catch (err) {
          json(res, 200, { ok: true, available: false, quota: 0, rpm: 0, tpm: 0, reason: String(err?.message || err) })
        }
        return
      }

      if (path === '/api/subscriptions' && req.method === 'GET') {
        const { st, cur } = await stateOf()
        if (!st.pat) throw new BadRequest('还没有设置访问令牌（PAT），读取订阅需要 wallet:read 权限')
        json(res, 200, { ok: true, ...await readSubscriptions(site, st.pat, cur) })
        return
      }

      // 推荐奖励转入余额：原样转发站点的结论，不替它编「成功」。
      if (path === '/api/aff/transfer' && req.method === 'POST') {
        const { st } = await stateOf()
        if (!st.pat) { json(res, 400, { ok: false, error: '还没有设置访问令牌（PAT）' }); return }
        try {
          const r = await transferAff(site, st.pat)
          json(res, 200, { ok: r.ok, message: r.message || (r.ok ? '已转入余额' : '站点没有说明原因') })
        } catch (e) {
          json(res, 502, { ok: false, error: `转入失败：${e?.message || e}` })
        }
        return
      }
      // 推荐计划：合并邀请码与真实 self 指标，部分读取失败原话放 note。
      if (path === '/api/aff' && req.method === 'GET') {
        const { st } = await stateOf()
        if (!st.pat) { json(res, 400, { ok: false, error: '还没有设置访问令牌（PAT）' }); return }
        const result = await readAff(site, st.pat)
        const { code, note, ...aff } = result
        json(res, 200, {
          ok: true,
          aff: Object.keys(aff).length ? aff : null,
          code,
          link: code ? `${site}/sign-up?aff=${encodeURIComponent(code)}` : '',
          note,
          at: Date.now(),
        })
        return
      }
      if (path === '/api/keys' && req.method === 'GET') {
        const { st } = await stateOf()
        if (!st.pat) { json(res, 400, { ok: false, error: '还没有设置访问令牌（PAT），建钥匙需要 api_key:read / api_key:write 权限' }); return }
        const keys = await readKeys(site, st.pat)
        const groups = await readUsableGroups(site, st.pat).catch(() => [])
        const boundTails = new Set(Object.values(st.accounts || {}).map((a) => String(a?.tail || '')).filter(Boolean))
        json(res, 200, {
          ok: true,
          keys: keys.map((k) => {
      // 列表接口绝不能把明文钥匙发给页面：只给打码串，明文只在 reveal 时按需换取。
      const { key, ...rest } = k
      return { ...rest, masked: maskKey(key), bound: boundTails.has(tailOf(key)) }
    }),
          groups,
        })
        return
      }

      if (path === '/api/keys' && req.method === 'POST') {
        const { st } = await stateOf()
        if (!st.pat) { json(res, 400, { ok: false, error: '还没有设置访问令牌（PAT）' }); return }
        const body = await readBody(req)
        const name = String(body?.name || '').trim()
        const group = String(body?.group || '').trim()
        if (!name) { json(res, 400, { ok: false, error: '钥匙名不能为空' }); return }
        if (!group) { json(res, 400, { ok: false, error: '必须选一个分组：分组是这把钥匙能调哪些模型、按什么倍率计费的依据' }); return }
        await createKey(site, st.pat, {
          name,
          group,
          unlimited: body?.unlimited !== false,
          remainQuota: body?.remainQuota,
          expiredAt: body?.expiredAt,
        })
        // 建完立刻找回来：站点建钥匙的响应里不含明文，必须再查一次列表拿 id，
        // 然后 reveal。这两步要当成一件事——中间失败会留下一把没人知道明文的钥匙，
        // 所以失败时要把错误说清楚，并告诉用户去控制台手动删。
        const keys = await readKeys(site, st.pat)
        const made = keys.find((k) => k.name === name && k.group === group)
        if (!made) {
          json(res, 502, { ok: false, error: '钥匙已创建，但没能在列表里找到它（可能同名重复）。请到控制台核对并取回钥匙。' })
          return
        }
        let secret = ''
        try {
          secret = await revealKey(site, st.pat, made.id)
        } catch (e) {
          json(res, 502, {
            ok: false,
            error: `钥匙已创建（id ${made.id}），但取明文失败：${String(e?.message || e)}。请在控制台手动复制，或给访问令牌加上 api_key:reveal 权限后点「查看完整钥匙」。`,
            key: { id: made.id, name: made.name, group: made.group },
          })
          return
        }
        json(res, 200, {
          ok: true,
          key: { id: made.id, name: made.name, group: made.group, secret },
          bind: {
            how: [
              '到 magpie 的供应商列表里打开 DragonAPI，点「添加账号」。',
              '选「用访问令牌自动建钥匙」：下次选好分组，插件会再建一把并直接绑成账号。',
              '或者选「DragonAPI API Key」，把上面这把 sk- 钥匙粘进去。',
            ],
            note: '分组决定这把钥匙能调哪些模型、按什么倍率计费；一把钥匙只属于一个分组。',
          },
        })
        return
      }

      if (path.startsWith('/api/keys/') && req.method === 'PUT') {
        const { st } = await stateOf()
        if (!st.pat) { json(res, 400, { ok: false, error: '还没有设置访问令牌（PAT）' }); return }
        const id = Number(path.split('/')[3])
        if (!Number.isFinite(id) || id <= 0) { json(res, 400, { ok: false, error: '钥匙 id 不对' }); return }
        const cur = (await readKeys(site, st.pat)).find((k) => k.id === id)
        if (!cur) { json(res, 404, { ok: false, error: '没有这把钥匙' }); return }
        const b = await readBody(req)
        await updateKey(site, st.pat, id, {
          name: b?.name ?? cur.name,
          group: b?.group ?? cur.group,
          unlimited: b?.unlimited != null ? b.unlimited : cur.unlimited,
          remainQuota: b?.remain != null ? b.remain : cur.remain,
          expiredAt: b?.expiredAt != null ? b.expiredAt : cur.expiredAt,
          status: b?.status != null ? b.status : cur.status,
        })
        json(res, 200, { ok: true })
        return
      }

      if (path.startsWith('/api/keys/') && req.method === 'DELETE') {
        const { st } = await stateOf()
        if (!st.pat) { json(res, 400, { ok: false, error: '还没有设置访问令牌（PAT）' }); return }
        const id = Number(path.split('/')[3])
        if (!Number.isFinite(id) || id <= 0) { json(res, 400, { ok: false, error: '钥匙 id 不对' }); return }
        await deleteKey(site, st.pat, id)
        json(res, 200, { ok: true })
        return
      }

      if (path.startsWith('/api/keys/') && path.endsWith('/reveal') && req.method === 'POST') {
        const { st } = await stateOf()
        if (!st.pat) { json(res, 400, { ok: false, error: '还没有设置访问令牌（PAT）' }); return }
        const id = Number(path.split('/')[3])
        if (!Number.isFinite(id) || id <= 0) { json(res, 400, { ok: false, error: '钥匙 id 不对' }); return }
        try {
          const secret = await revealKey(site, st.pat, id)
          json(res, 200, { ok: true, secret })
        } catch (e) {
          json(res, 403, { ok: false, error: String(e?.message || e) })
        }
        return
      }

      if (path === '/api/pat' && req.method === 'POST') {
        const body = await readBody(req)
        const pat = normalizePat(body?.pat)
        if (!pat) { json(res, 400, { ok: false, error: '访问令牌不能为空' }); return }

        // 先探能力，再决定收不收：只有站点明确说「这份凭据不行」才拒收。
        // 站点连不上、返回验证页这类情况照收——令牌本身可能完全正常，
        // 把它当无效打回去，用户唯一的感受就是「保存失败」。
        const probe = await probePat(site, pat)

        if (probe.authRejected) {
          json(res, 400, {
            ok: false,
            error: `这份访问令牌不能用：${String(probe.error?.message || probe.error || '站点拒绝')}`,
            hint: '到控制台「安全 → 访问令牌」确认它没有过期或被停用，勾上 profile:read / api_key:read / usage:read / wallet:read 中所需权限后再试。',
            failures: probe.failures,
          })
          return
        }

        const hint = maskKey(pat)
        const saved = await setPat({ pat, hint, scopes: probe.scopes, user: probe.user, verified: probe.verified })

        // 落盘失败必须说出来。之前这里不管写没写成功都回 ok，页面弹「已保存」，
        // 重启后令牌就没了——那才是「访问令牌保存失败」最坑的一种表现。
        if (saved && saved.saved === false) {
          json(res, 500, {
            ok: false,
            error: `令牌本身能用，但没能写进 ${saved.path}：${saved.error || '未知原因'}。本次会话内它仍然有效，重启后会丢；请检查该文件或目录是否可写，再点一次保存。`,
            pat: { set: true, hint, scopes: probe.scopes, verified: probe.verified, missing: probe.missing, persisted: false },
            stateFile: saved.path,
          })
          return
        }

        json(res, 200, {
          ok: true,
          pat: { set: true, hint, scopes: probe.scopes, verified: probe.verified, missing: probe.missing, persisted: true },
          user: probe.user ? { name: probe.user.username, id: probe.user.id } : null,
          warning: patWarning(probe),
          stateFile: saved?.path || '',
        })
        return
      }

      if (path === '/api/pat' && req.method === 'DELETE') {
        await setPat({ pat: '', hint: '', scopes: [], user: null, verified: false })
        json(res, 200, { ok: true, pat: { set: false } })
        return
      }

      if (path === '/api/bind-info' && req.method === 'GET') {
        json(res, 200, {
          ok: true,
          how: [
            '在 magpie 的供应商列表里打开 DragonAPI，点「添加账号」。',
            '选「用访问令牌自动建钥匙」：插件会按你选的分组建一把新钥匙并自动绑定。',
            '或者选「DragonAPI API Key」，把上面复制到的 sk- 钥匙粘进去。',
          ],
          auto: { method: 'pat', label: '用访问令牌自动建钥匙' },
          note: '页面跑在沙箱里，写不了 magpie 的账号表，所以绑定只能走 magpie 自己的「添加账号」。',
        })
        return
      }

      if (path === '/api/health' && req.method === 'GET') {
        // 健康记录归目录源所有：它才知道每次拉取成没成、花了多久。
        json(res, 200, { ok: true, recent: typeof catalog.recent === 'function' ? catalog.recent() : [] })
        return
      }

      json(res, 404, { ok: false, error: '没有这个接口' })
    } catch (e) {
      // 请求体坏了是客户端的问题，回 400；其它才是 500。
      const code = e?.badRequest ? 400 : 500
      json(res, code, { ok: false, error: String(e?.message || e) })
    }
  }

  /**
   * readAccountKey 取这个账号（按 tail）的钥匙明文。
   *
   * 钥匙不落盘，只在插件进程内存里留一份 tail → 明文 的映射，由 index.mjs
   * 在每次 usage / loader / models 拿到 auth 时填进去。进程重启后第一次
   * models() 就会重新填上，所以页面刷新一下就能看到余额。
   */
  async function readAccountKey(key) {
    try {
      const secret = keyOf ? keyOf(key) : ''
      return String(secret || '')
    } catch { return '' }
  }

  /** accountViews 把账号折成页面要的样子：带上余额与用量。 */
  async function accountViews(st, cur) {
    const out = []
    for (const [key, meta] of Object.entries(st.accounts || {})) {
      const secret = await readAccountKey(key)
      const view = {
        key,
        label: meta?.label || key,
        group: meta?.group || '',
        masked: meta?.masked || '',
        models: Number(meta?.models) || 0,
        boundAt: Number(meta?.boundAt) || 0,
        balance: '—',
        balanceRaw: 0,
        used: '—',
        usedRaw: 0,
        tokenName: '',
      }
      if (secret) {
        try {
          const u = await readTokenUsage(site, secret)
          view.balance = text(u.available, cur)
          view.balanceRaw = u.available
          view.used = text(u.used, cur)
          view.usedRaw = u.used
          view.tokenName = u.name
        } catch { /* 读不到就显示 —，不假装是 0 */ }
      }
      out.push(view)
    }
    return out
  }

  // 端口被占用时往后试，最多 10 个。撞端口在插件里很常见（另一个插件也占了）。
  let server = null
  let bound = port
  for (let i = 0; i < 10; i++) {
    const tryPort = port + i
    const s = createServer((req, res) => { handler(req, res).catch(() => { try { json(res, 500, { ok: false, error: '内部错误' }) } catch { /* 已发送 */ } }) })
    const ok = await new Promise((resolve_) => {
      s.once('error', () => resolve_(false))
      s.listen(tryPort, '127.0.0.1', () => resolve_(true))
    })
    if (ok) { server = s; bound = tryPort; break }
  }
  if (!server) throw new Error(`127.0.0.1 上 ${port}–${port + 9} 都被占用了，请到插件选项里换一个端口`)

  return {
    port: bound,
    close: () => new Promise((resolve_) => server.close(() => resolve_(true))),
  }
}
