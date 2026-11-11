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

/** keyOf 把「凭据 + 种类」说清。调用方给错就直接抛，不留隐式回退。 */
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
    // 控制台鉴权：PAT 形如 nap_xxx，直接放 Bearer。
    h.authorization = 'Bearer ' + raw
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
  const d = env?.data
  if (!d || typeof d !== 'object') throw new Error('/api/usage/token/ 没有 data')
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

/** 逐条用量。站点按钥匙给最近 1000 条。 */
export async function readTokenLogs(site, key, { pageSize = 100 } = {}) {
  const env = await siteCall(site, `/api/log/token?p=0&page_size=${Math.max(1, Math.min(1000, pageSize))}`, {
    auth: { kind: 'key', token: key },
  })
  if (env?.success === false) throw new Error(env?.message || '站点拒绝读用量')
  const d = env?.data
  const items = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : Array.isArray(d?.data) ? d.data : []
  return items
}

/** PAT 能读到的账户资料。 */
export async function readSelf(site, pat) {
  const env = await siteCall(site, '/api/user/self', { auth: { kind: 'pat', token: pat } })
  const d = env?.data
  if (!d || typeof d !== 'object') throw new Error('/api/user/self 没有 data')
  return {
    id: Number(d.id) || 0,
    username: String(d.username || ''),
    displayName: String(d.display_name || ''),
    group: String(d.group || ''),
    quota: Number(d.quota) || 0,
    usedQuota: Number(d.used_quota) || 0,
    affCode: String(d.aff_code || ''),
    raw: d,
  }
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
export async function readKeys(site, pat, { pageSize = 100 } = {}) {
  const env = await siteCall(site, `/api/token/?p=0&size=${Math.max(1, Math.min(100, pageSize))}`, {
    auth: { kind: 'pat', token: pat },
  })
  const d = env?.data
  const items = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : []
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
export async function readUsageSelf(site, pat, { pageSize = 1 } = {}) {
  const env = await siteCall(site, `/api/log/self?p=0&page_size=${Math.max(1, Math.min(100, pageSize))}`, {
    auth: { kind: 'pat', token: pat },
  })
  if (env?.success === false) throw new Error(env?.message || '站点拒绝读用量')
  return env?.data
}

/**
 * probePat 一次性探三个只读端点，判断这份 PAT 到底能干什么。
 *
 * 为什么要「宽松」：站点把一份令牌的 scope 卡得很细，`/api/user/self` 要
 * `profile:read`。只用它做准入门槛时，一份只能读钥匙列表的 PAT 会被整份
 * 拒收——用户看到的是「保存失败」，实际只是权限少了一格。
 *
 * 所以判定分三种，调用方据此决定「拒收 / 收下但警告 / 收下」：
 *
 *   authRejected  ／ 三个端点全部 401/403 —— 令牌本身不行，拒收
 *   verified      ／ 至少一个端点通了 —— 令牌有效，记录能用的 scope
 *   networkOnly   ／ 一个都没通，但错误都不是鉴权错误 —— 站点连不上，令牌先存下
 */
export async function probePat(site, pat) {
  const checks = [
    { scope: 'profile:read', run: () => readSelf(site, pat) },
    { scope: 'api_key:read', run: () => readKeys(site, pat, { pageSize: 1 }) },
    { scope: 'usage:read', run: () => readUsageSelf(site, pat) },
  ]

  const results = []
  for (const check of checks) {
    try {
      results.push({ scope: check.scope, ok: true, value: await check.run() })
    } catch (error) {
      results.push({ scope: check.scope, ok: false, error })
    }
  }

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
