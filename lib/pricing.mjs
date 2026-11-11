// 价格：把 DragonAPI 的两种计费规则折成「看得懂的钱」。
//
// 站点有两种完全不同的计价方式，混在一起处理一定出错：
//
//   1. 倍率计费（quota_type=0 且没有 billing_mode）：模型倍率 × 分组倍率，
//      1 倍率 = 2 美元 / 百万 token（站点前端的 $P:{M:1} 除数表与 ×2 约定）。
//   2. 表达式计费（billing_mode=tiered_expr）：站点给一段 DSL，里面既有
//      chat 侧的 token 系数（p / c / cr / cc / cc1h），也有视频侧的用量变量
//      （u("seconds") / u("resolution") / u("spec") / u("reference_video_seconds")）。
//
// 这个文件只做「能算准的就算，算不准就说不准」，绝不给一个看起来像真的
// 假价格。站点前端自己也是这么做的：它把表达式解析成「变量 × 单价」表，
// 解析失败就不显示价格。

/** 视频类模型的分辨率档位顺序，用来给「按分辨率」的表达式挑一个代表值。 */
const RES_ORDER = ['480p', '720p', '768p', '1080p', '2k', '4k']

/**
 * parseTiers 把表达式里的 `tier("名字", 金额表达式)` 全部取出来。
 *
 * 只做括号配对，不做完整求值——完整求值需要一个 DSL 解释器，而站点随时
 * 会往里加函数（param / weekday / hour / fixed 已经出现了）。取不到就返回空。
 */
export function parseTiers(expr) {
  if (typeof expr !== 'string' || !expr) return []
  const out = []
  const re = /tier\(\s*"([^"]*)"\s*,/g
  let m
  while ((m = re.exec(expr))) {
    const name = m[1]
    // 从逗号后开始配对括号，直到这一层 tier( 闭合
    const start = re.lastIndex
    let depth = 0
    let end = -1
    for (let i = start; i < expr.length; i++) {
      const c = expr[i]
      if (c === '(') depth++
      else if (c === ')') {
        if (depth === 0) { end = i; break }
        depth--
      }
    }
    if (end < 0) continue
    out.push({ name, body: expr.slice(start, end).trim() })
  }
  return out
}

/**
 * chatCoeffs 从一段 tier 金额里取 chat 侧的 token 系数。
 *
 * 表达式形如 `p*2 + cr*0.2 + cc*2.5 + c*10`，单位是「美元 / 百万 token」
 * （站点前端把它按 M 换算后再乘分组倍率）。
 *
 * 变量名两侧都必须有边界。只加左侧断言是不够的：在 `p*2 + cr*0.2 + c*10`
 * 里，`c` 会先匹配到 `cr` 的那个 c（左侧是空格，左侧断言通过），而后面不是
 * `*`，于是输出系数被读成 1——真实站点上 gpt-6-sol 就这么显示成「输出比
 * 输入便宜」，一眼就能看出不对。所以右侧也要断言。
 */
export function chatCoeffs(body) {
  const pick = (name) => {
    const re = new RegExp(`(?<![a-zA-Z0-9_])${name}(?![a-zA-Z0-9_])\\s*(?:\\*\\s*([0-9.]+))?`)
    const m = body.match(re)
    if (!m) return undefined
    return m[1] === undefined ? 1 : Number(m[1])
  }
  const out = {
    input: pick('p'),
    output: pick('c'),
    cacheRead: pick('cr'),
    cacheWrite: pick('cc'),
    cacheWrite1h: pick('cc1h'),
  }
  const any = Object.values(out).some((v) => v !== undefined)
  return any ? out : null
}

/**
 * usagePrices 从表达式里取「用量变量 × 单价」表，视频模型主要靠它。
 *
 * 形如 `u("seconds") * 0.45 + u("reference_video_seconds") * 0.45`。
 * 这是站点前端 `XY` 那套做法的简化版：它把每个 u(...) 项拆成
 * 「变量 → 每单位单价」，我们照着拆，单位靠 billing_usage_schema 补。
 */
export function usagePrices(expr) {
  if (typeof expr !== 'string' || !expr) return {}
  const out = {}
  const re = /u\(\s*"([^"]+)"\s*\)\s*\*\s*([0-9.]+)/g
  let m
  while ((m = re.exec(expr))) {
    const field = m[1]
    const price = Number(m[2])
    if (!Number.isFinite(price)) continue
    // 同一个变量可能出现多次（不同分辨率分支），取最小值作为「起步价」，
    // 最大值作为「最高价」。只报一个数会误导。
    const had = out[field]
    if (!had) out[field] = { min: price, max: price }
    else out[field] = { min: Math.min(had.min, price), max: Math.max(had.max, price) }
  }
  return out
}

/**
 * priceOf 算一个模型的价格描述。
 *
 * 返回 { kind, input, output, cache, note }，其中 input/output/cache 已经是
 * 格式化好的字符串（如 `$2.00/M`），kind 说明这份价格是怎么来的：
 *
 *   ratio    倍率计费，算得准
 *   tiered   表达式计费且取到了系数，算得准（取第一档，其余在 note 里）
 *   flat     单档表达式计费：单价是平的，只有 fast 这类整单倍率
 *   percall  按次 / 按秒，价格是区间
 *   unknown  算不准，只有 note 说明原因
 *
 * @param {object} row     /api/pricing 里的一条模型
 * @param {number} ratio   该分组的分组倍率
 * @param {object} cur     currencyOf 的结果
 */
export function priceOf(row, ratio, cur) {
  const groupRatio = Number(ratio) > 0 ? Number(ratio) : 1
  const symbol = cur?.symbol || '$'
  // 数值单独给一份（货币单位 / 百万 token），页面要在 /1M 与 /272K 之间切换、
  // 也要按价格排序——字符串没法算，所以两个都留着。
  const perMNum = (v) => {
    const n = Number(v)
    // 保留 6 位小数：0.2 × 0.1 在浮点里是 0.020000000000000004，不收敛会让
    // 「按价格排序」和显示都出现毛刺。
    return Number.isFinite(n) ? Math.round(n * groupRatio * 1e6) / 1e6 : null
  }
  const perM = (v) => {
    // 站点前端：单价 = 系数 × 分组倍率 ÷ 1e6，再乘「充值价系数」。
    // 我们不做充值价折算（拿不到 priceRate 时不能猜），只给系数 × 分组倍率。
    const n = Number(v)
    if (!Number.isFinite(n)) return null
    const value = n * groupRatio
    return symbol + (value >= 0.01 ? value.toFixed(2) : value.toFixed(4)) + '/M'
  }

  const mode = String(row?.billing_mode || '')
  const expr = String(row?.billing_expr || '')
  const quotaType = Number(row?.quota_type) || 0

  // ---- 按次 / 按秒（quota_type=1）----
  if (quotaType === 1) {
    const per = Number(row?.model_price) || 0
    if (mode === 'tiered_expr' && expr) {
      const usage = usagePrices(expr)
      const fields = Object.keys(usage)
      // 视频：按秒计价，价格随分辨率变。给区间而不是单值。
      const seconds = usage.seconds
      if (seconds) {
        const lo = (seconds.min * groupRatio).toFixed(4)
        const hi = (seconds.max * groupRatio).toFixed(4)
        const res = resolutionRange(row)
        return {
          kind: 'percall',
          input: lo === hi ? `${symbol}${lo}/秒` : `${symbol}${lo}–${hi}/秒`,
          output: '',
          cache: '',
          note: res ? `按秒计价，随分辨率变化（${res}）` : '按秒计价',
        }
      }
      if (fields.length) {
        return {
          kind: 'percall',
          input: fields.map((f) => `${f} ${symbol}${usage[f].min}–${usage[f].max}`).join(' · '),
          output: '',
          cache: '',
          note: '按用量变量计价，实际以控制台为准',
        }
      }
    }
    // 纯按次：tier("按次", 0.65) 或直接给 model_price
    if (per > 0) {
      return {
        kind: 'percall',
        input: `${symbol}${(per * groupRatio).toFixed(2)}/次`,
        output: '',
        cache: '',
        note: '按次计价',
      }
    }
    return { kind: 'unknown', input: '价格未知', output: '', cache: '', note: '按次模型，但站点没有给单价' }
  }

  // ---- 表达式计费（chat 侧）----
  if (mode === 'tiered_expr' && expr) {
    const tiers = parseTiers(expr)
    if (tiers.length) {
      const first = tiers[0]
      const co = chatCoeffs(first.body)
      if (co) {
        const input = co.input === undefined ? null : perM(co.input)
        const output = co.output === undefined ? null : perM(co.output)
        const cache = co.cacheRead === undefined ? null : perM(co.cacheRead)
        if (input || output) {
          const mult = multiplierText(expr)
          return {
            // 单档表达式（tier("standard", …)）价格是平的，标成「分档计费」会
            // 让人以为还有别的档可切——真实站点上这类模型只有 fast 这类整单倍率。
            kind: tiers.length > 1 ? 'tiered' : 'flat',
            input: input || '—',
            output: output || '—',
            cache: cache || '—',
            inputNum: co.input === undefined ? null : perMNum(co.input),
            outputNum: co.output === undefined ? null : perMNum(co.output),
            cacheNum: co.cacheRead === undefined ? null : perMNum(co.cacheRead),
            tierCount: tiers.length,
            note: (tiers.length > 1
              ? `${tiers.length} 档（${tiers.map((t) => t.name).join(' / ')}），上表是「${first.name}」档`
              : `表达式计费（${first.name}）`) + (mult ? `；整单倍率 ${mult}` : ''),
          }
        }
      }
    }
    return { kind: 'unknown', input: '价格未知', output: '', cache: '', note: '表达式无法解析成单价' }
  }

  // ---- 倍率计费 ----
  const modelRatio = Number(row?.model_ratio) || 0
  if (modelRatio > 0) {
    const completion = Number(row?.completion_ratio) || 0
    const cacheRatio = Number(row?.cache_ratio) || 0
    // 站点约定：1 倍率 = 2 美元 / 百万 token（前端把系数按 M 换算）。
    const input = modelRatio * 2
    const output = completion > 0 ? input * completion : input
    return {
      kind: 'ratio',
      input: perM(input),
      output: perM(output),
      cache: cacheRatio > 0 ? perM(input * cacheRatio) : '—',
      inputNum: perMNum(input),
      outputNum: perMNum(output),
      cacheNum: cacheRatio > 0 ? perMNum(input * cacheRatio) : null,
      note: `倍率 ${round(modelRatio)}${completion > 0 ? ` · 补全 ${round(completion)}` : ''}`,
    }
  }

  return { kind: 'unknown', input: '价格未知', output: '', cache: '', note: '站点没有给这个模型的计价规则' }
}

/**
 * parseMultipliers 取出表达式里「某个参数等于某个值时整单加倍」的规则。
 *
 * 站点写法：`* (param("service_tier") == "priority" ? 2 : 1)`。
 * 这类修饰不属于 token 系数，混进价格里会算错，单独列出来给页面说清楚。
 */
export function parseMultipliers(expr) {
  if (typeof expr !== 'string' || !expr) return []
  const out = []
  const re = /param\(\s*"([^"]+)"\s*\)\s*==\s*"([^"]+)"\s*\?\s*([0-9.]+)\s*:\s*1/g
  let m
  while ((m = re.exec(expr))) {
    const factor = Number(m[3])
    if (!Number.isFinite(factor) || factor === 1) continue
    out.push({ param: m[1], value: m[2], factor })
  }
  return out
}

/**
 * multiplierText 把条件倍率写成一句紧凑的话，给卡片 tooltip 用。
 *
 * 例：`service_tier=priority/fast/ultrafast ×2`、`speed=fast ×2`。
 * 同一个参数的不同取值合并到一处；不同系数分开写（gpt-6-astra 的
 * ultrafast 是 ×6，不能和 ×2 混成一句）。没有这类规则就返回空串。
 */
export function multiplierText(expr) {
  const list = parseMultipliers(expr)
  if (!list.length) return ''
  // factor → param → [值…]，保持站点表达式里的先后顺序
  const byFactor = new Map()
  for (const m of list) {
    const perParam = byFactor.get(m.factor) || new Map()
    const values = perParam.get(m.param) || []
    values.push(m.value)
    perParam.set(m.param, values)
    byFactor.set(m.factor, perParam)
  }
  const parts = []
  for (const [factor, perParam] of byFactor) {
    const conds = [...perParam].map(([param, values]) => `${param}=${values.join('/')}`).join('、')
    parts.push(`${conds} ×${factor}`)
  }
  return parts.join('；')
}

/** coeffPrice 把一个 token 系数折成「每百万 token 多少钱」。 */
function coeffPrice(coeff, ratio, symbol) {
  const n = Number(coeff)
  if (coeff === undefined || coeff === null || !Number.isFinite(n)) return undefined
  const value = n * (Number(ratio) > 0 ? Number(ratio) : 1)
  return `${symbol}${value >= 0.01 ? value.toFixed(2) : value.toFixed(4)}/M`
}

/** zhText 从站点的多语文案里取中文，取不到就退回原文。 */
function zhText(spec) {
  const d = spec?.description
  if (d && typeof d === 'object') return String(d.zh || d.en || '')
  if (typeof d === 'string') return d
  return ''
}

/** 常见单位的中文说法：站点很多模型只给英文 unit，不给 unitLabel。 */
const UNIT_ZH = {
  second: '秒', seconds: '秒', minute: '分钟', minutes: '分钟',
  image: '张', images: '张', count: '次', unit: '次',
  megapixel: '百万像素', megapixels: '百万像素',
  token: 'token', tokens: 'token',
}

/**
 * usageRowsOf 把「用量变量 × 单价」折成表格行。
 *
 * 视频类模型的价格随秒数 / 分辨率变化，页面上必须给出「字段 / 单位 / 单价」，
 * 而不是一串 `u("seconds") * 0.16`。
 */
function usageRowsOf(prices, schema, ratio, symbol) {
  const out = []
  for (const [field, range] of Object.entries(prices || {})) {
    const spec = schema && typeof schema === 'object' ? schema[field] || {} : {}
    const rawUnit = String(spec?.unit || '')
    // 优先级：站点给的中文单位名 → 我们自己的常见单位表 → 站点的英文名 → 原始 unit。
    // 英文名排在单位表之后：很多模型只给 unitLabel.en="second"，直接用它就等于没翻。
    const unit = String(spec?.unitLabel?.zh || UNIT_ZH[rawUnit] || spec?.unitLabel?.en || rawUnit)
    const r = Number(ratio) > 0 ? Number(ratio) : 1
    const lo = range.min * r
    const hi = range.max * r
    const fmt = (v) => `${symbol}${v.toFixed(4)}`
    out.push({
      field,
      label: zhText(spec) || field,
      unit,
      price: lo === hi ? `${fmt(lo)}${unit ? '/' + unit : ''}` : `${fmt(lo)}–${fmt(hi)}${unit ? '/' + unit : ''}`,
      min: lo,
      max: hi,
    })
  }
  return out
}

/** 分辨率范围，从 billing_usage_schema 里读，读不到就看表达式里出现过的分辨率。 */
function resolutionRange(row) {
  const schema = row?.billing_usage_schema
  const list = schema?.resolution?.enum
  if (Array.isArray(list) && list.length) {
    const sorted = list.slice().sort((a, b) => RES_ORDER.indexOf(String(a)) - RES_ORDER.indexOf(String(b)))
    return sorted.join(' / ')
  }
  const expr = String(row?.billing_expr || '')
  const found = RES_ORDER.filter((r) => expr.includes(`"${r}"`))
  return found.length ? found.join(' / ') : ''
}

const round = (v) => String(Math.round(Number(v) * 10000) / 10000)

/**
 * billingOf 给「模型详情」用的完整计费信息，比 priceOf 多给原始数字。
 * UI 只在用户点开单个模型时用它。
 *
 * 三个「已经折好、可以直接显示」的字段是详情页的关键：
 *
 *   tiers[].prices   每一档的实际单价（X × 分组倍率），不是原始系数
 *   multipliers      整单倍率规则（如 service_tier=priority ×2）
 *   usageRows        视频/按秒模型的字段表：字段 / 单位 / 单价
 *
 * 之前的抽屉读的是 tiers[].input / tiers[].output——服务端从来没给过这两个
 * 字段，所以分档表恒为「—」，页面只好把 mode 与原始表达式倒出来。
 */
export function billingOf(row, ratio, cur) {
  const mode = String(row?.billing_mode || '')
  const expr = String(row?.billing_expr || '')
  const symbol = cur?.symbol || '$'
  const groupRatio = Number(ratio) > 0 ? Number(ratio) : 1
  const tiers = parseTiers(expr)
  const schema = row?.billing_usage_schema && typeof row.billing_usage_schema === 'object' ? row.billing_usage_schema : null
  const usages = usagePrices(expr)
  const isPerCall = Number(row?.quota_type) === 1

  return {
    mode: mode || (isPerCall ? 'per_call' : 'ratio'),
    modeLabel: mode === 'tiered_expr'
      ? (isPerCall ? '表达式按用量计费' : '表达式分档计费')
      : (isPerCall ? '按次计费' : '倍率计费'),
    expr,
    groupRatio,
    currency: { symbol, code: String(cur?.code || '') },
    tiers: tiers.map((t) => ({
      name: t.name,
      body: t.body,
      coeffs: chatCoeffs(t.body),
      prices: pricesOf(t.body, groupRatio, symbol),
    })),
    multipliers: parseMultipliers(expr),
    usages,
    usageRows: usageRowsOf(usages, schema, groupRatio, symbol),
    schema,
    examples: Array.isArray(row?.billing_usage_examples) ? row.billing_usage_examples : [],
    variants: Array.isArray(row?.billing_plugin_variants) ? row.billing_plugin_variants : [],
  }
}

/** pricesOf 把一档的 token 系数折成单价表；没有的系数就不出现在结果里。 */
function pricesOf(body, groupRatio, symbol) {
  const co = chatCoeffs(body)
  if (!co) return {}
  const out = {}
  for (const [key, coeff] of Object.entries(co)) {
    const price = coeffPrice(coeff, groupRatio, symbol)
    if (price) out[key] = price
  }
  return out
}
