// 用量：把站点的逐条日志折成页面能直接画的形状。
//
// 站点的 /api/log/token 每条字段写法不统一（有时在顶层，有时塞在 other 里），
// 所以这里逐个字段兜底。这套解析与 NearToken 的同名逻辑高度同构——那个站点
// 也是 New API 部署，日志形状一致。

import { text } from './site.mjs'

/** num 只接受真正的数字，字符串数字也认；其它一律 undefined。 */
function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

/** otherOf 把 other 字段（可能是 JSON 字符串）拆成对象。 */
function otherOf(row) {
  const o = row?.other
  if (!o) return null
  if (typeof o === 'object') return o
  if (typeof o === 'string') {
    try { return JSON.parse(o) } catch { return null }
  }
  return null
}

/** pick 取第一个非空的字符串。 */
function pick(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/** 站点日志的 type 值 → 人话。 */
const LOG_KINDS = { 1: '充值', 2: '消耗', 3: '管理', 4: '系统', 5: '错误', 6: '退款' }

function kindOf(type) {
  const n = Number(type)
  return LOG_KINDS[n] || (Number.isFinite(n) ? `类型 ${n}` : '—')
}

/** fmtStamp 把 Unix 秒折成 `MM-DD HH:mm`。 */
export function fmtStamp(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** firstToken 取首字耗时（秒）。站点有时给 ttft，有时给 first_token_time。 */
function firstToken(row) {
  const o = otherOf(row)
  return num(row?.ttft) ?? num(o?.ttft) ?? num(row?.first_token_time) ?? num(o?.first_token_time)
}

/**
 * detailOf 拼「计价说明」。
 * 站点把计价档位与单价塞在 other 里，键名随版本变，这里按常见写法逐个兜底。
 */
function detailOf(other, quota) {
  if (!other || typeof other !== 'object') return ''
  const tier = pick(other?.tier, other?.billing_tier, other?.group)
  const inPrice = num(other?.model_ratio) ?? num(other?.input_price)
  const outPrice = num(other?.completion_ratio) ?? num(other?.output_price)
  const parts = []
  if (tier) parts.push(tier)
  if (inPrice !== undefined || outPrice !== undefined) {
    parts.push(`${inPrice ?? '—'} / ${outPrice ?? '—'}`)
  }
  if (!parts.length && quota !== undefined) return ''
  return parts.join(' · ')
}

/**
 * rowsOf 把站点原始日志折成页面行。
 *
 * @param {Array} items     /api/log/token 的 data
 * @param {object} cur      currencyOf 的结果
 * @param {string} account  这个账号在 magpie 里的键（多账号时用来区分来源）
 */
export function rowsOf(items, cur, account = '') {
  const out = []
  for (const r of Array.isArray(items) ? items : []) {
    if (!r || typeof r !== 'object') continue
    const other = otherOf(r)
    const at = num(r?.created_at) ?? num(r?.createdAt) ?? 0
    const prompt = num(r?.prompt_tokens) ?? num(other?.prompt_tokens)
    const completion = num(r?.completion_tokens) ?? num(other?.completion_tokens)
    const secs = num(r?.use_time) ?? num(other?.use_time)
    const quota = num(r?.quota) ?? num(other?.quota)
    const model = pick(r?.model_name, r?.modelName, other?.model_name)
    const detail = detailOf(other, quota)
    // 模型与说明都空的行没有信息量，丢掉（与宿主的口径一致）。
    if (!model && !detail) continue
    // 吞吐 = 输出 token / 生成耗时；用总时长做分母会明显偏低。
    const ttft = firstToken(r)
    const tps = completion && secs
      ? (() => {
        const gen = ttft !== undefined && secs > ttft ? secs - ttft : secs
        return gen > 0 ? Math.round(completion / gen) : undefined
      })()
      : undefined
    out.push({
      at: at * 1000,
      atText: fmtStamp(at),
      account,
      kind: kindOf(r?.type),
      model,
      group: pick(r?.group, other?.group),
      tokenName: pick(r?.token_name, r?.tokenName),
      upModel: pick(other?.upstream_model, other?.up_model, other?.request_model),
      respModel: pick(other?.response_model, other?.downstream_model),
      effort: pick(other?.reasoning_effort, other?.effort),
      input: prompt,
      output: completion,
      cache: num(r?.cache_tokens) ?? num(other?.cache_tokens),
      bytes: num(r?.request_size) ?? num(other?.request_size),
      cost: quota === undefined ? '' : text(quota, cur),
      costRaw: quota,
      tps,
      ttft,
      dur: secs,
      detail,
      isStream: r?.is_stream === true || r?.isStream === true,
    })
  }
  // 最新在最上面：按时间显式降序，不依赖站点返回顺序。
  out.sort((a, b) => (b.at || 0) - (a.at || 0))
  return out
}

/**
 * summarize 把一堆行按窗口汇总：总额、token、按模型、按时间桶。
 *
 * @param {Array} rows    rowsOf 的结果
 * @param {object} cur
 * @param {number} start  窗口起点（毫秒）
 * @param {number} end    窗口终点（毫秒）
 */
export function summarize(rows, cur, start, end) {
  const span = Math.max(1, end - start)
  // 桶的粒度：一天按小时，一周按 6 小时，一个月按天。
  const bucketMs = span <= 26 * 3600e3 ? 3600e3 : span <= 8 * 24 * 3600e3 ? 6 * 3600e3 : 24 * 3600e3
  const byModel = new Map()
  const byBucket = new Map()
  let spent = 0
  let tokens = 0
  for (const r of rows) {
    if (!r.at || r.at < start || r.at > end) continue
    const cost = Number(r.costRaw) || 0
    const tok = (Number(r.input) || 0) + (Number(r.output) || 0)
    spent += cost
    tokens += tok
    const key = r.model || '（未知）'
    const had = byModel.get(key) || { model: key, tokens: 0, costRaw: 0, calls: 0 }
    had.tokens += tok
    had.costRaw += cost
    had.calls += 1
    byModel.set(key, had)
    const b = Math.floor((r.at - start) / bucketMs) * bucketMs + start
    const hb = byBucket.get(b) || { at: b, costRaw: 0, tokens: 0 }
    hb.costRaw += cost
    hb.tokens += tok
    byBucket.set(b, hb)
  }
  const models = [...byModel.values()]
    .sort((a, b) => b.costRaw - a.costRaw)
    .map((m) => ({ ...m, cost: text(m.costRaw, cur) }))
  const buckets = [...byBucket.values()]
    .sort((a, b) => a.at - b.at)
    .map((b) => ({ ...b, cost: text(b.costRaw, cur) }))
  return {
    start,
    end,
    spent: text(spent, cur),
    spentRaw: spent,
    tokens,
    byModel: models,
    buckets,
  }
}

/** 窗口的起止（毫秒）。range ∈ day | week | month。 */
export function windowOf(range, now = Date.now()) {
  const d = new Date(now)
  if (range === 'week') {
    // 最近 7 天（含今天），按本地零点切。
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6).getTime()
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
    return { start, end }
  }
  if (range === 'month') {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 29).getTime()
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
    return { start, end }
  }
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  return { start, end }
}
