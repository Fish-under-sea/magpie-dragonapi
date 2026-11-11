// 站点客户端：DragonAPI 的每一次出站请求都从这里走。
//
// 两条通道，凭据不同，能做的事也不同：
//
//   sk- 钥匙    中转鉴权用。能调模型、能读这把钥匙的余额与逐条用量。
//   nap_ 令牌   控制台鉴权（PAT，带 scope）。能读账户、分组、钥匙列表，
//               也能建钥匙 / 删钥匙 / 看完整钥匙。建不了 PAT：站点要求
//               浏览器会话，插件代不了。
//
// 所以这里把两者分开：调用方必须说清用的是哪一种，不允许「有哪个用哪个」
// 的隐式回退——那把 PAT 当成钥匙发出去，会得到一条让人摸不着头脑的 401。

/** 站点根地址。可以由插件 options 覆盖（自建站、测试站）。 */
export const DEFAULT_SITE = 'https://newapi.dragon3api.com'

/** 一次请求最多等多久。站点正常时都在 1 秒内，超过这个数就该报错而不是挂着。 */
const TIMEOUT_MS = 20_000

/**
 * SiteError 是「站点这一层」的错误，带三个页面判断用的字段：
 *
 *   status   HTTP 状态码（网络层失败是 0）
 *   code     站点自己给的错误码，如 AUTH_UNAUTHORIZED
 *   kind     http | network | response（不是 JSON）
 *
 * 为什么必须分得清：PAT 保存时「令牌无效」和「站点连不上」要给出完全不同的
 * 处置——前者是用户去控制台改权限，后者是令牌本身可能没问题，不该直接拒收。
 * 之前两者都只是一个 Error，结果一律被报成「这份访问令牌不可用」。
 */
export class SiteError extends Error {
  constructor(message, { status = 0, code = '', kind = 'http' } = {}) {
    super(message)
    this.name = 'SiteError'
    this.status = status
    this.code = code
    this.kind = kind
  }

  /** isAuth：站点明确说「这份凭据不行」。只有这种才该拒绝保存。 */
  get isAuth() {
    if (this.kind !== 'http') return false
    return this.status === 401 || this.status === 403 || /^AUTH_/.test(this.code)
  }
}

/** 粘贴 PAT 时常带请求头前缀、引号与不可见字符；保存与发请求必须同一口径。 */
export function normalizePat(value) {
  return String(value ?? '')
    .replace(/[\s​-‍⁠﻿'"`“”‘’]/gu, '')
    .replace(/^(?:(?:authorization:?)|bearer)+/i, '')
}

function requireSuccess(env, path) {
  if (env?.success === false) {
    throw new SiteError(`${path}：${env.message || env.error?.message || '站点拒绝读取'}`, {
      status: 200, code: String(env.code || env.error?.code || ''),
    })
  }
  return env
}

function objectData(env, path) {
  requireSuccess(env, path)
  if (!env?.data || typeof env.data !== 'object' || Array.isArray(env.data)) {
    throw new SiteError(`${path} 返回了未知数据结构`, { kind: 'response' })
  }
  return env.data
}

/** 仅接受已知日志形状；读失败/版本变化不能冒充空日志。 */
function logItems(env, path) {
  requireSuccess(env, path)
  if (Array.isArray(env)) return env
  const d = env?.data
  if (Array.isArray(d)) return d
  if (Array.isArray(d?.items)) return d.items
  if (Array.isArray(d?.data)) return d.data
  throw new SiteError(`${path} 返回了未知日志结构`, { kind: 'response' })
}

function logQuery({ pageSize = 100, start, end } = {}) {
  const q = new URLSearchParams({ p: '0', page_size: String(Math.max(1, Math.min(100, Number(pageSize) || 100))) })
  // 调用方的时间窗是毫秒，站点的筛选参数是 Unix 秒。
  if (Number.isFinite(start)) q.set('start_timestamp', String(Math.floor(start / 1000)))
  if (Number.isFinite(end)) q.set('end_timestamp', String(Math.floor(end / 1000)))
  return q
}

/** headersFor 把「凭据 + 种类」说清。调用方给错就直接抛，不留隐式回退。 */
function headersFor(auth) {
  const h = { accept: 'application/json', 'user-agent': 'magpie-dragonapi' }
  if (!auth) return h
  const raw = String(auth.token || '').trim()
  if (!raw) return h
  if (auth.kind === 'key') {
    // 中转鉴权只认 sk-；站点自己也会 TrimPrefix("sk-")，但我们保留前缀，
    // 因为 /api/usage/token/ 的实现里同样会 TrimPrefix，两种写法都认。
    h.authorization = 'Bearer ' + raw
    return h
  }
  if (auth.kind === 'pat') {
    const pat = normalizePat(raw)
    h.authorization = 'Bearer ' + pat
    h['new-api-access-token'] = pat
    return h
  }
  throw new Error(`未知的凭据种类：${String(auth.kind)}`)
}

/** siteCall 发一次请求并把 JSON 解析出来；非 2xx 抛出带站点原话的错误。 */
export async function siteCall(site, path, { method = 'GET', body, auth, timeoutMs = TIMEOUT_MS, headers } = {}) {
  const base = String(site || DEFAULT_SITE).replace(/\/+$/, '')
  const url = base + path
  const init = {
    method,
    headers: { ...headersFor(auth), ...(headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let res
  try {
    res = await fetch(url, init)
  } catch (e) {
    // 连不上（DNS / TLS / 超时 / 被墙）与「站点说不行」是两件事，必须分开报。
    const why = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `等满 ${timeoutMs} ms 没有响应` : String(e?.message || e)
    throw new SiteError(`连不上站点（${path}）：${why}`, { kind: 'network' })
  }
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    // 站点偶尔会回一页 HTML（Cloudflare 挑战、502 页）。原样带一点正文出来，
    // 否则排查时只剩「不是 JSON」这一句，看不出发生了什么。
    throw new SiteError(`${path} 返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 160).replace(/\s+/g, ' ')}`, {
      status: res.status,
      kind: 'response',
    })
  }
  if (!res.ok) {
    const why = parsed?.message || parsed?.error?.message || parsed?.error || ''
    const code = String(parsed?.code || parsed?.error?.code || '')
    throw new SiteError(`${path} HTTP ${res.status}${code ? ' ' + code : ''}${why ? '：' + why : ''}`, { status: res.status, code })
  }
  return parsed
}

/** 站点参数。钱怎么显示、额度怎么折算全在这里。 */
export async function readStatus(site) {
  const env = await siteCall(site, '/api/status')
  const d = env?.data
  if (!d || typeof d !== 'object') throw new Error('/api/status 没有 data')
  return {
    siteName: String(d.system_name || 'DragonAPI'),
    version: String(d.version || ''),
    quotaPerUnit: Number(d.quota_per_unit) > 0 ? Number(d.quota_per_unit) : 500000,
    // 站点自己的显示规则：quota_display_type 是 USD / CNY / TOKENS / CUSTOM，
    // display_in_currency 决定是否按货币展示。这两个都要读，只读一个会算错。
    displayType: String(d.quota_display_type || 'USD').toUpperCase(),
    displayInCurrency: d.display_in_currency === true,
    usdExchangeRate: Number(d.usd_exchange_rate ?? d.custom_currency_exchange_rate) > 0
      ? Number(d.usd_exchange_rate ?? d.custom_currency_exchange_rate)
      : 1,
    customSymbol: typeof d.custom_currency_symbol === 'string' ? d.custom_currency_symbol.trim() : '',
    customRate: Number(d.custom_currency_exchange_rate) > 0 ? Number(d.custom_currency_exchange_rate) : 1,
    turnstile: d.turnstile_check === true,
    logo: String(d.logo || ''),
    raw: d,
  }
}

/**
 * currencyOf 把站点参数折成「怎么印钱」。
 *
 * 符号优先级：quota_display_type 认识的码 → 非占位符的自定义符号 → 默认。
 * 站点给的 custom_currency_symbol 常常是通用占位符 ¤，直接显示很难看。
 * 读不到就返回一组保守默认值，但绝不把 per 折成 1——那会把额度原值当金额，
 * 余额直接放大五十万倍。
 */
export function currencyOf(status) {
  const byCode = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥' }
  const code = String(status?.displayType || 'USD').toUpperCase()
  const custom = String(status?.customSymbol || '')
  const symbol = byCode[code]
    || (custom && custom !== '¤' ? custom : (code === 'CNY' ? '¥' : '$'))
  const per = Number(status?.quotaPerUnit) > 0 ? Number(status.quotaPerUnit) : 500000
  // 币种汇率：USD 恒为 1；CNY 用站点汇率；CUSTOM 用自定义汇率。
  const rate = code === 'USD' ? 1
    : code === 'CNY' ? (Number(status?.usdExchangeRate) > 0 ? Number(status.usdExchangeRate) : 1)
      : code === 'CUSTOM' ? (Number(status?.customRate) > 0 ? Number(status.customRate) : 1)
        : 1
  return { symbol, per, rate, code, display: status?.displayInCurrency !== false }
}

/** money 把 quota 折成站点显示的那笔钱（保留两位，用于余额与流水）。 */
export function money(quota, cur) {
  const n = Number(quota)
  if (!Number.isFinite(n)) return '—'
  const base = n / (cur.per > 0 ? cur.per : 1)
  const value = cur.display && cur.rate > 0 ? base * cur.rate : base
  return value.toFixed(2)
}

/** text 是带符号的一笔钱。 */
export function text(quota, cur) {
  return cur.symbol + money(quota, cur)
}

/** 公开目录。不需要任何凭据，站点本来就把它给所有人看。 */
export async function readPricing(site, { etag, lastModified } = {}) {
  const headers = {}
  // 条件请求：实测站点认 If-None-Match 与 If-Modified-Since，命中回 304。
  // 目录动得不勤，这一条能把轮询成本压到几乎为零。
  if (etag) headers['if-none-match'] = etag
  if (lastModified) headers['if-modified-since'] = lastModified
  const base = String(site || DEFAULT_SITE).replace(/\/+$/, '')
  const res = await fetch(base + '/api/pricing', {
    headers: { accept: 'application/json', 'user-agent': 'magpie-dragonapi', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (res.status === 304) return { notModified: true, etag, lastModified }
  const nextEtag = res.headers.get('etag') || ''
  const nextLast = res.headers.get('last-modified') || ''
  const text_ = await res.text()
  let env
  try {
    env = JSON.parse(text_)
  } catch {
    throw new Error(`/api/pricing 返回的不是 JSON（HTTP ${res.status}）`)
  }
  if (!res.ok || env?.success === false) {
    throw new Error(`/api/pricing HTTP ${res.status}：${env?.message || '站点拒绝'}`)
  }
  return { notModified: false, env, etag: nextEtag, lastModified: nextLast }
}

/** 一把钥匙的额度与用量。这是 sk- 通道里最要紧的一个端点。 */
export async function readTokenUsage(site, key) {
  const env = await siteCall(site, '/api/usage/token/', { auth: { kind: 'key', token: key } })
  const d = objectData(env, '/api/usage/token/')
  return {
    name: String(d.name || ''),
    granted: Number(d.total_granted) || 0,
    used: Number(d.total_used) || 0,
    available: Number(d.total_available) || 0,
    unlimited: d.unlimited_quota === true,
    expiresAt: Number(d.expires_at) || 0,
    modelLimits: d.model_limits && typeof d.model_limits === 'object' ? d.model_limits : null,
    modelLimitsEnabled: d.model_limits_enabled === true,
    // 钥匙允许查用户额度时才有；不允许就没有这个字段，别当成 0。
    userQuota: d.user_quota && typeof d.user_quota === 'object'
      ? { available: Number(d.user_quota.total_available) || 0, used: Number(d.user_quota.total_used) || 0 }
      : null,
  }
}

/** 逐条用量。保守只取最近最多 100 条，service 明确标注 partial。 */
export async function readTokenLogs(site, key, options = {}) {
  const env = await siteCall(site, `/api/log/token?${logQuery(options)}`, {
    auth: { kind: 'key', token: key },
  })
  return logItems(env, '/api/log/token')
}

/** PAT 能读到的账户资料。 */
export async function readSelf(site, pat, { timeoutMs } = {}) {
  const env = await siteCall(site, '/api/user/self', { auth: { kind: 'pat', token: pat }, timeoutMs })
  const d = objectData(env, '/api/user/self')
  if (!('id' in d) && !('username' in d)) throw new SiteError('/api/user/self 返回了未知账户结构', { kind: 'response' })
  return {
    id: Number(d.id) || 0,
    username: String(d.username || ''),
    displayName: String(d.display_name || ''),
    group: String(d.group || ''),
    quota: numberOf(d.quota) ?? null,
    usedQuota: numberOf(d.used_quota) ?? null,
    affCode: String(d.aff_code || ''),
    raw: d,
  }
}

/**
 * 推荐计划的数据：邀请码、已邀请人数、累计奖励额度。
 *
 * `/api/user/aff` 是 New API 的可选端点，不是每个站点都开；形状也可能变，
 * 所以这里全部按可选处理——拿不到就返回 null，让界面如实显示「站点没有提供」，
 * 而不是把 undefined 印出来。
 */
export async function readAff(site, pat) {
  const results = await Promise.allSettled([
    siteCall(site, '/api/user/aff', { auth: { kind: 'pat', token: pat } }).then((env) => {
      requireSuccess(env, '/api/user/aff')
      if (typeof env?.data === 'string') return { aff_code: env.data }
      return objectData(env, '/api/user/aff')
    }),
    readSelf(site, pat).then((self) => self.raw),
  ])
  const failed = results.filter((r) => r.status === 'rejected')
  // 一端成功时保留可读字段；另一端的鉴权错误必须原样放 note，不能说成未开放。
  if (failed.length === results.length) throw failed.find((r) => r.reason?.isAuth)?.reason || failed[0].reason
  const aff = results[0].status === 'fulfilled' ? results[0].value : {}
  const self = results[1].status === 'fulfilled' ? results[1].value : {}
  const out = { code: String(aff.aff_code ?? aff.affCode ?? self.aff_code ?? '') }
  const fields = {
    count: ['aff_count', 'affCount'], quota: ['aff_quota', 'affQuota'],
    historyQuota: ['aff_history_quota'], pending: ['aff_pending_quota', 'pending_quota'],
  }
  for (const [name, aliases] of Object.entries(fields)) {
    const value = aliases.map((key) => self[key] ?? aff[key]).find((v) => numberOf(v) !== undefined)
    if (value !== undefined) out[name] = numberOf(value)
  }
  out.note = failed.map((r) => String(r.reason?.message || r.reason)).join('；')
  return out
}

function numberOf(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

const BILLING_PREFERENCES = new Set(['subscription_first', 'wallet_first', 'subscription_only', 'wallet_only'])

/** wallet:read 的只读探针也用相同结构校验，不能把 HTML/未知 JSON 当成功。 */
export async function readSubscriptionSelf(site, pat, { timeoutMs } = {}) {
  const env = await siteCall(site, '/api/subscription/self', { auth: { kind: 'pat', token: pat }, timeoutMs })
  const d = objectData(env, '/api/subscription/self')
  if (!Array.isArray(d.subscriptions) && !Array.isArray(d.all_subscriptions)) {
    throw new SiteError('/api/subscription/self 返回了未知订阅结构', { kind: 'response' })
  }
  for (const key of ['subscriptions', 'all_subscriptions']) {
    if (d[key] !== undefined && !Array.isArray(d[key])) throw new SiteError(`/api/subscription/self 的 ${key} 不是数组`, { kind: 'response' })
    for (const item of d[key] || []) {
      const s = item?.subscription ?? item
      if (!s || typeof s !== 'object' || Array.isArray(s) || numberOf(s.id) === undefined || numberOf(s.plan_id) === undefined) {
        throw new SiteError('/api/subscription/self 返回了未知订阅条目', { kind: 'response' })
      }
    }
  }
  return d
}

async function readSubscriptionPlans(site, pat) {
  const path = '/api/subscription/plans'
  const env = requireSuccess(await siteCall(site, path, { auth: { kind: 'pat', token: pat } }), path)
  const data = env?.data
  const items = Array.isArray(data) ? data : data?.plans
  if (!Array.isArray(items)) throw new SiteError(`${path} 返回了未知套餐结构`, { kind: 'response' })
  return items.map((item) => {
    const plan = item?.plan ?? item
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || numberOf(plan.id) === undefined) {
      throw new SiteError(`${path} 返回了未知套餐条目`, { kind: 'response' })
    }
    return plan
  })
}

/** 订阅额度是 quota，套餐售价则保留原币，不走 quota 汇率。 */
export async function readSubscriptions(site, pat, cur, now = Date.now()) {
  const [selfResult, plansResult] = await Promise.allSettled([
    readSubscriptionSelf(site, pat), readSubscriptionPlans(site, pat),
  ])
  if (selfResult.status === 'rejected') throw selfResult.reason
  const self = selfResult.value
  const rawPlans = plansResult.status === 'fulfilled' ? plansResult.value : []
  const byId = new Map(rawPlans.map((p) => [String(p.id), p]))
  const ms = (v) => { const n = numberOf(v); return n === undefined ? null : n * 1000 }
  const plans = rawPlans.map((p) => {
    const amount = numberOf(p.price_amount ?? p.price)
    const currency = typeof p.currency === 'string' ? p.currency : ''
    const quota = numberOf(p.total_amount ?? p.amount_total)
    const durationValue = numberOf(p.duration_value)
    return {
      id: numberOf(p.id), title: String(p.title || `套餐 #${p.id}`),
      subtitle: String(p.subtitle || ''),
      durationUnit: String(p.duration_unit || ''), durationValue: durationValue ?? null,
      totalRaw: quota ?? null, total: quota === undefined ? '' : quota === 0 ? '不限量' : text(quota, cur),
      unlimited: quota === 0, quotaResetPeriod: String(p.quota_reset_period || ''),
      upgradeGroup: String(p.upgrade_group || ''),
      priceAmount: amount ?? null, priceCurrency: currency,
      price: amount === undefined ? '' : `${currency ? currency + ' ' : ''}${amount.toFixed(2)}`,
    }
  })
  const seen = new Set()
  const subscriptions = [...(self.subscriptions || []), ...(self.all_subscriptions || [])].flatMap((item) => {
    const s = item?.subscription ?? item
    if (!s || typeof s !== 'object' || Array.isArray(s) || numberOf(s.id) === undefined || numberOf(s.plan_id) === undefined) {
      throw new SiteError('/api/subscription/self 返回了未知订阅条目', { kind: 'response' })
    }
    if (seen.has(String(s.id))) return []
    seen.add(String(s.id))
    const plan = item?.plan ?? byId.get(String(s.plan_id))
    const total = numberOf(s.amount_total ?? s.total_amount)
    const used = numberOf(s.amount_used ?? s.used_amount)
    const remaining = total !== undefined && used !== undefined ? total - used : undefined
    const endAt = ms(s.end_time)
    const startAt = ms(s.start_time)
    const unlimited = total === 0
    return [{
      id: numberOf(s.id), planId: numberOf(s.plan_id), title: String(plan?.title || `套餐 #${s.plan_id}`),
      status: s.status ?? null,
      active: s.status === 'active' && endAt !== null && endAt > now && (startAt === null || startAt <= now),
      startAt, endAt, nextResetAt: ms(s.next_reset_time),
      totalRaw: total ?? null, usedRaw: used ?? null, remainingRaw: unlimited ? null : remaining ?? null,
      total: total === undefined ? '' : unlimited ? '不限量' : text(total, cur),
      used: used === undefined ? '' : text(used, cur),
      remaining: unlimited || remaining === undefined ? '' : text(remaining, cur),
      unlimited, progress: total > 0 && used !== undefined ? used / total * 100 : null,
    }]
  })
  return {
    subscriptions, plans,
    billingPreference: BILLING_PREFERENCES.has(self.billing_preference) ? self.billing_preference : null,
    plansError: plansResult.status === 'rejected' ? String(plansResult.reason?.message || plansResult.reason) : '',
    at: now,
  }
}

/**
 * 把推荐计划的累计奖励转入余额。
 *
 * 端点 `/api/user/aff_transfer` 是 New API 的标准接口（无请求体，整笔转入）。
 * 我们没有它的返回结构可依，所以原样把站点的 message 带回去——
 * 成功失败都以站点为准，不在这里替它编一句「已转入」。
 */
export async function transferAff(site, pat) {
  const env = await siteCall(site, '/api/user/aff_transfer', {
    method: 'POST',
    auth: { kind: 'pat', token: pat },
  })
  return { ok: env?.success !== false, message: String(env?.message || ''), data: env?.data ?? null }
}
/** 当前账号可用的分组。建钥匙时要从这里挑，不能凭目录里的分组名瞎猜。 */
export async function readUsableGroups(site, pat) {
  const env = await siteCall(site, '/api/user/self/groups', { auth: { kind: 'pat', token: pat } })
  const d = env?.data
  // 这个端点历史上给过两种形状：字符串数组，或 {组名: 说明} 对象。
  if (Array.isArray(d)) return d.map((x) => String(x)).filter(Boolean)
  if (d && typeof d === 'object') return Object.keys(d)
  return []
}

/** 钥匙列表。站点只给打码后的 key。 */
export async function readKeys(site, pat, { pageSize = 100, timeoutMs } = {}) {
  const env = requireSuccess(await siteCall(site, `/api/token/?p=0&size=${Math.max(1, Math.min(100, pageSize))}`, {
    auth: { kind: 'pat', token: pat }, timeoutMs,
  }), '/api/token/')
  const d = env?.data
  const items = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : null
  if (!items) throw new SiteError('/api/token/ 返回了未知钥匙列表结构', { kind: 'response' })
  return items.map((t) => ({
    id: Number(t?.id) || 0,
    name: String(t?.name || ''),
    key: String(t?.key || ''),
    group: String(t?.group || ''),
    status: Number(t?.status) || 0,
    used: Number(t?.used_quota) || 0,
    remain: Number(t?.remain_quota) || 0,
    unlimited: t?.unlimited_quota === true,
    createdAt: Number(t?.created_time) || 0,
    lastUsedAt: Number(t?.accessed_time) || 0,
    expiredAt: Number(t?.expired_time) || 0,
  }))
}

/**
 * 建一把钥匙。
 *
 * 关键点：这个端点不需要浏览器会话，也不需要二次验证（上游 AddToken 里
 * 没有 RequireSecurityProof），所以带着 api_key:write 的 PAT 就能建。
 * 但**响应里不含钥匙明文**——只有 {success, message}，明文得再调一次 reveal。
 * 也就是说「建钥匙」与「拿明文」是两次请求，中间失败会留下一把没人知道
 * 明文的钥匙，所以调用方必须把这两步当成一件事处理（见 service.mjs）。
 */
export async function createKey(site, pat, { name, group, unlimited = true, remainQuota = 0, expiredAt = -1 }) {
  const body = {
    name: String(name || '').slice(0, 50),
    group: String(group || ''),
    unlimited_quota: unlimited === true,
    remain_quota: unlimited ? 0 : Math.max(0, Math.floor(Number(remainQuota) || 0)),
    expired_time: Number.isFinite(expiredAt) ? Math.floor(expiredAt) : -1,
    model_limits_enabled: false,
    model_limits: '',
    allow_ips: '',
    allow_user_quota_query: true,
  }
  const env = await siteCall(site, '/api/token/', { method: 'POST', body, auth: { kind: 'pat', token: pat } })
  if (env?.success === false) throw new Error(env?.message || '站点拒绝建钥匙')
  return { ok: true }
}

/** 更新一把钥匙（改名/分组/额度/过期/状态）。 */
export async function updateKey(site, pat, id, { name, group, unlimited = true, remainQuota = 0, expiredAt = -1, status } = {}) {
  const body = {
    id: Math.floor(Number(id)),
    name: String(name || '').slice(0, 50),
    group: String(group || ''),
    unlimited_quota: unlimited === true,
    remain_quota: unlimited ? 0 : Math.max(0, Math.floor(Number(remainQuota) || 0)),
    expired_time: Number.isFinite(expiredAt) ? Math.floor(expiredAt) : -1,
    model_limits_enabled: false,
    model_limits: '',
    allow_ips: '',
    allow_user_quota_query: true,
  }
  if (Number.isFinite(Number(status))) body.status = Number(status)
  const env = await siteCall(site, '/api/token/', { method: 'PUT', body, auth: { kind: 'pat', token: pat } })
  if (env?.success === false) throw new Error(env?.message || '站点拒绝更新钥匙')
  return { ok: true }
}

/** 读一把钥匙的明文。需要 api_key:reveal 权限。 */
export async function revealKey(site, pat, id) {
  const env = await siteCall(site, `/api/token/${Math.floor(Number(id))}/key`, {
    method: 'POST',
    auth: { kind: 'pat', token: pat },
  })
  if (env?.success === false) throw new Error(env?.message || '站点拒绝给出钥匙')
  const secret = String(env?.data?.key || '')
  if (!secret) throw new Error('站点没有返回钥匙明文')
  return secret
}

/** 删一把钥匙。 */
export async function deleteKey(site, pat, id) {
  const env = await siteCall(site, `/api/token/${Math.floor(Number(id))}`, {
    method: 'DELETE',
    auth: { kind: 'pat', token: pat },
  })
  if (env?.success === false) throw new Error(env?.message || '站点拒绝删除钥匙')
  return { ok: true }
}

/**
 * 校验一份凭据是不是真的能用，并尽量取回它代表的名字。
 *
 * 这里刻意分成两条：sk- 走 /api/usage/token/，PAT 走 /api/user/self。
 * 用错通道会得到 401，而 401 的正文长得差不多，很容易被误读成「钥匙失效」。
 */
export async function verifyKey(site, key) {
  const usage = await readTokenUsage(site, key)
  return { ok: true, kind: 'key', name: usage.name, usage }
}

export async function verifyPat(site, pat) {
  const self = await readSelf(site, pat)
  return { ok: true, kind: 'pat', user: self }
}

/**
 * PAT 通道的用量流水（`/api/log/self`）。
 *
 * 注意别拿 `readTokenLogs` 冒充：那条走的是 sk- 钥匙的 `/api/log/token`，
 * 用 PAT 打过去、或者干脆传空串，都只会拿到 401。之前探测 `usage:read`
 * 用的正是 `readTokenLogs(site, '')`，所以这个 scope 永远探不出来。
 */
export async function readUsageSelf(site, pat, options = {}) {
  const env = await siteCall(site, `/api/log/self?${logQuery(options)}`, {
    auth: { kind: 'pat', token: pat }, timeoutMs: options.timeoutMs,
  })
  return logItems(env, '/api/log/self')
}

/**
 * 分页读账户日志：返回 `{ items, total }`。
 * `/api/log/self` 的 `data.total` 是整个时间窗的条数，分页时用它算总页数。
 */
export async function readUsageSelfPage(site, pat, options = {}) {
  const q = new URLSearchParams({
    p: String(Math.max(1, Number(options.page || 1))),
    page_size: String(Math.max(1, Math.min(100, Number(options.pageSize) || 100))),
  })
  if (Number.isFinite(options.start)) q.set('start_timestamp', String(Math.floor(options.start / 1000)))
  if (Number.isFinite(options.end)) q.set('end_timestamp', String(Math.floor(options.end / 1000)))
  const env = await siteCall(site, `/api/log/self?${q}`, {
    auth: { kind: 'pat', token: pat }, timeoutMs: options.timeoutMs,
  })
  requireSuccess(env, '/api/log/self')
  const d = env?.data
  const items = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : Array.isArray(d?.data) ? d.data : null
  if (!items) throw new SiteError('/api/log/self 返回了未知日志结构', { kind: 'response' })
  const total = Number(d?.total ?? d?.total_count ?? d?.count ?? items.length) || items.length
  return { items, total }
}

/**
 * PAT 通道的数据看板（`/api/data/self`）：按时间桶 × 模型的行。
 * 参数是毫秒时间窗与粒度（hour / day / week），站点只接受秒级时间戳。
 */
export async function readDataSelf(site, pat, options = {}) {
  const q = new URLSearchParams();
  if (options.start) q.set('start_timestamp', String(Math.floor(options.start / 1000)));
  if (options.end) q.set('end_timestamp', String(Math.floor(options.end / 1000)));
  q.set('time_granularity', options.granularity || 'hour');
  const env = await siteCall(site, `/api/data/self?${q}`, {
    auth: { kind: 'pat', token: pat }, timeoutMs: options.timeoutMs,
  });
  const d = env && env.data;
  return (Array.isArray(d) ? d : Object.values(d || {})).filter(Boolean);
}

/**
 * PAT 通道的日志汇总（`/api/log/self/stat`）：quota / rpm / tpm。
 *
 * 这是站点日志页顶部三个数字的真实来源：quota 按所选时间窗统计（就是页面上的
 * 「用量」），rpm / tpm 是站点侧的分钟速率（没有请求时就是 0，不是缺失）。
 */
export async function readUsageStatsSelf(site, pat, options = {}) {
  const env = await siteCall(site, `/api/log/self/stat?${logQuery(options)}`, {
    auth: { kind: 'pat', token: pat }, timeoutMs: options.timeoutMs,
  })
  const d = objectData(env, '/api/log/self/stat')
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
  return { quota: n(d?.quota), rpm: n(d?.rpm), tpm: n(d?.tpm) }
}

/**
 * probePat 并行探四个只读端点，判断这份 PAT 到底能干什么。
 *
 * 为什么要「宽松」：站点把一份令牌的 scope 卡得很细，`/api/user/self` 要
 * `profile:read`。只用它做准入门槛时，一份只能读钥匙列表的 PAT 会被整份
 * 拒收——用户看到的是「保存失败」，实际只是权限少了一格。
 *
 * 所以判定分三种，调用方据此决定「拒收 / 收下但警告 / 收下」：
 *
 *   authRejected  ／ 四个端点全部 401/403 —— 令牌本身不行，拒收
 *   verified      ／ 至少一个端点通了 —— 令牌有效，记录能用的 scope
 *   networkOnly   ／ 一个都没通，但错误都不是鉴权错误 —— 站点连不上，令牌先存下
 */
export async function probePat(site, pat) {
  const timeoutMs = 12_000
  const checks = [
    { scope: 'profile:read', run: () => readSelf(site, pat, { timeoutMs }) },
    { scope: 'api_key:read', run: () => readKeys(site, pat, { pageSize: 1, timeoutMs }) },
    { scope: 'usage:read', run: () => readUsageSelf(site, pat, { pageSize: 1, timeoutMs }) },
    { scope: 'wallet:read', run: () => readSubscriptionSelf(site, pat, { timeoutMs }) },
  ]

  const results = await Promise.all(checks.map(async (check) => {
    try {
      return { scope: check.scope, ok: true, value: await check.run() }
    } catch (error) {
      return { scope: check.scope, ok: false, error }
    }
  }))

  const ok = results.filter((r) => r.ok)
  const failed = results.filter((r) => !r.ok)
  const authFails = failed.filter((r) => r.error?.isAuth === true)
  const otherFails = failed.filter((r) => r.error?.isAuth !== true)
  const user = results[0].ok ? results[0].value : null

  return {
    user,
    scopes: ok.map((r) => r.scope),
    missing: failed.map((r) => r.scope),
    verified: ok.length > 0,
    authRejected: ok.length === 0 && authFails.length === failed.length && failed.length === checks.length,
    networkOnly: ok.length === 0 && otherFails.length === failed.length,
    // 只报第一个失败原因：三个都是同一件事时，列三遍没有帮助。
    error: failed.length ? failed[0].error : null,
    failures: failed.map((r) => ({ scope: r.scope, kind: r.error?.kind || 'http', message: String(r.error?.message || r.error) })),
  }
}
