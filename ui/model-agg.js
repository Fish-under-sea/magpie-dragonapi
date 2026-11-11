// 把「分组 × 模型」的行聚合成「一个模型一张卡」。
//
// 站点把同一个模型在 14 个分组里各卖一份，目录因此是「分组 × 模型」的行表
// （189 行 / 125 个模型）。用户要找的是「有没有这个模型、大概什么价」，
// 所以展示层要反过来：一个模型一张卡，把它的全部分组都列出来。
//
// 这里只做纯计算，不碰 DOM —— 这样能直接单测，也避免渲染逻辑里藏聚合规则。
//
// 约束：
//   - 不省略任何分组。分组少就一行排开，多就换行，绝不出现「+3」。
//   - 价格给区间而不是「取最低」：不同分组价差很大（0.06× 到 1.2×），
//     只显示一个数会让人以为那就是这个模型的价。
//   - 计价方式不一致（例如有的分组按倍率、有的按次）时标成 mixed，不假装统一。

/** 分组排序：有倍率的按倍率升序，auto / 无倍率的排后面，同倍率按分组名。 */
function byRatioThenName(a, b) {
  const ra = typeof a.ratio === 'number' && a.ratio > 0 ? a.ratio : Infinity
  const rb = typeof b.ratio === 'number' && b.ratio > 0 ? b.ratio : Infinity
  if (ra !== rb) return ra - rb
  return String(a.id || '').localeCompare(String(b.id || ''), 'zh')
}

/**
 * 一列数值（每百万 token 的单价）在多个分组之间的区间。
 * 没有任何有限数值时返回 null —— 调用方据此退回站点给的字符串。
 */
export function spanOf(groups, key) {
  const nums = []
  for (const g of groups) {
    const n = g && g.pricing ? g.pricing[key] : null
    if (typeof n === 'number' && Number.isFinite(n)) nums.push(n)
  }
  if (!nums.length) return null
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  return { min, max, same: min === max, count: nums.length }
}

/** 计价方式：全部分组一致就用那个；不一致标 mixed；全都没有就 unknown。 */
function kindOfGroups(groups) {
  const kinds = new Set()
  for (const g of groups) {
    if (g.auto) { kinds.add('auto'); continue }
    kinds.add((g.pricing && g.pricing.kind) || 'unknown')
  }
  if (!kinds.size) return 'unknown'
  if (kinds.size === 1) return [...kinds][0]
  return kinds.has('unknown') && kinds.size === 1 ? 'unknown' : 'mixed'
}

/**
 * 模型名里的版本号：`gpt-6.1-sol` → [6,1]，`deepseek-v4` → [4]。
 * 取第一段数字串，`-` 与 `.` 都当分隔（站点两种写法混用）。
 */
export function versionRank(name) {
  const m = String(name || '').match(/\d+(?:[.-]\d+)*/)
  return m ? m[0].split(/[.-]/).map(Number) : null
}

/**
 * 模型等级词：数值越小等级越高。想调整顺序只改这张表。
 *
 * Anthropic 的等级就是代号，顺序是 **fable > opus > sonnet > haiku**（f-o-s-h）。
 * 这类代号不带版本号，必须单独列出，否则它们会全落进默认档、按名字排——
 * 那样 haiku 会排在 opus 前面，fable 也上不去。
 *
 * 其它厂商用档位词表达同一件事：max/ultra（旗舰）> pro/plus（进阶）>
 * 默认（标准）> fast/flash/lite/mini（轻量）> draft（草稿）。
 * 等级只在**同一厂商内**比较，所以两套词放一张表不会互相干扰。
 */
const TIER_WORDS = {
  fable: 0,
  opus: 1, max: 1, ultra: 1, quality: 1, best: 1,
  sonnet: 2, pro: 2, plus: 2, prime: 2, advanced: 2,
  // 3 = 标准档（没有档位词时的默认，见 TIER_DEFAULT）
  fast: 4, flash: 4, flashx: 4, lite: 4, light: 4, mini: 4, turbo: 4, highspeed: 4,
  haiku: 4,
  draft: 5,
}
const TIER_DEFAULT = 3

/**
 * 厂商自有的代号等级：**按顺序匹配，先命中先用**，所以越具体的写越前。
 *
 * 一些厂商不用档位词，而是用一串代号表示等级。这种顺序只能由人定，
 * 写在这里比塞进通用词表清楚——通用词表跨厂商共用，加进去会误伤别家。
 *
 * Google：`gemini-4-carbon`(c) > `gemini-4-argon`(a) > `argon-high`(a-h)
 * > `argon-medium`(a-m) > `argon-low`(a-l) > `flash`。
 */
const VENDOR_GRADES = {
  Google: [
    [/carbon/i, 0],
    [/argon-h(?:igh)?\b/i, 2],
    [/argon-m(?:edium)?\b/i, 3],
    [/argon-l(?:ow)?\b/i, 4],
    [/\bargon\b/i, 1],
    [/flash/i, 5],
  ],
  OpenAI: [
    // GPT 的代号等级：astra(a) > sol > terra。等级优先于代数，所以
    // gpt-6-astra 排在 gpt-6.1-sol 前面——代数只在同一道内比较。
    [/\bastra\b/i, 0],
    [/\bsol\b/i, 1],
    [/\bterra\b/i, 2],
    // codex 是另一条产品线（代码审查），不该和对话型号插花排，
    // 单独排在这些等级之后。
    [/\bcodex\b/i, 4],
  ],
}

/** 取名字里**从最高档开始**的档位词；整词匹配，避免 `minimax` 命中 `mini`。 */
export function tierRankOf(name, vendor = '') {
  const vendorRules = VENDOR_GRADES[vendor]
  if (Array.isArray(vendorRules)) {
    for (const [re, rank] of vendorRules) if (re.test(String(name || ''))) return rank
  }

  const tokens = String(name || '').toLowerCase().split(/[-_.\s]+/).filter(Boolean)
  let best = null
  for (const t of tokens) {
    const r = TIER_WORDS[t]
    if (r !== undefined && (best === null || r < best)) best = r
  }
  return best === null ? TIER_DEFAULT : best
}

/** 版本从新到旧；没有版本号的排到本组末尾；同版本按名称。 */
export function byVersionDesc(a, b) {
  const x = versionRank(a.name)
  const y = versionRank(b.name)
  if (x && y) {
    const n = Math.max(x.length, y.length)
    for (let i = 0; i < n; i++) {
      const d = (y[i] || 0) - (x[i] || 0)
      if (d) return d
    }
  } else if (x) return -1
  else if (y) return 1
  return String(a.name || '').localeCompare(String(b.name || ''), 'zh')
}

/**
 * 默认排序：**厂商 → 等级分道 → 轮转取版本**。
 *
 * 不能只按「等级 → 版本」排成一片：那样 Claude 区会连着出现 fable-5-2、
 * fable-5-1、fable-5 三张同等级卡，再轮到 opus 一大片。用户要的是
 * 「每个等级轮流往下取一个版本」：
 *
 *   f5.2 → o5.5 → s5.5 → h5.5 → f5.1 → o5.5 → s5 → …
 *
 * 所以不是比较器，而是「分道 + 轮转」：
 *   1. 按类别（侧栏顺序）与厂商分桶，桶之间按类别顺序拼接；
 *   2. 桶内按等级分道（fable / opus / sonnet / haiku …，即 TIER_WORDS 的档位）；
 *   3. 每道内部按版本从新到旧；
 *   4. 各道按等级从高到低轮流取一个，取完为止。
 *
 * 只有一道时（例如 GPT 区几乎全在默认档），结果就是普通的版本降序。
 */
export function orderDefault(aggs, { catOf, catOrder = [] } = {}) {
  const list = Array.isArray(aggs) ? aggs : []
  const catRank = (a) => {
    const c = catOf ? catOf(a) : 'other'
    const i = catOrder.indexOf(c)
    return i < 0 ? catOrder.length : i
  }

  // 1. 分桶：类别 + 厂商。空厂商排在本类别末尾。
  const buckets = new Map()
  for (const a of list) {
    const rank = catRank(a)
    const vendor = a.vendor || '\uffff'
    const key = `${rank}\u0000${vendor}`
    let b = buckets.get(key)
    if (!b) {
      b = { rank, vendor, items: [] }
      buckets.set(key, b)
    }
    b.items.push(a)
  }

  const out = []
  const orderedBuckets = [...buckets.values()]
    .sort((x, y) => x.rank - y.rank || String(x.vendor).localeCompare(String(y.vendor), 'zh'))

  for (const bucket of orderedBuckets) {
    // 2. 分道：等级 → 该等级的模型（道内按版本降序）
    const lanes = new Map()
    for (const a of bucket.items) {
      const t = tierRankOf(a.name, a.vendor)
      const lane = lanes.get(t) || []
      lane.push(a)
      lanes.set(t, lane)
    }
    const laneOrder = [...lanes.keys()].sort((x, y) => x - y)
    for (const t of laneOrder) lanes.get(t).sort(byVersionDesc)

    // 3. 轮转：每轮各道取一个，直到取完
    const cursor = new Map(laneOrder.map((t) => [t, 0]))
    let remaining = bucket.items.length
    while (remaining > 0) {
      for (const t of laneOrder) {
        const lane = lanes.get(t)
        const i = cursor.get(t)
        if (i >= lane.length) continue
        out.push(lane[i])
        cursor.set(t, i + 1)
        remaining -= 1
      }
    }
  }

  return out
}
/**
 * rows：目录里的行（每行一个分组×模型，字段见 lib/catalog.mjs 的 buildCatalog）。
 * 返回聚合后的模型数组，每个元素带 groups（全部分组，按倍率升序）。
 *
 * 分组一律逐个列出，即使两个分组的倍率与价格完全一样也不合并：
 * 分组名是用户要认的渠道，拼成 `gpt-pro/promax` 会让人以为那是一个名字。
 * 分组多时自然换到第二行，这个双行排布是刻意的，卡片高度仍由预留高度取齐。
 */
export function aggregateRows(rows) {
  const map = new Map()

  for (const r of Array.isArray(rows) ? rows : []) {
    const name = r.name || r.id || ''
    const key = name || `#${map.size}`
    let a = map.get(key)

    if (!a) {
      a = {
        key,
        name,
        id: r.id || '',
        vendor: r.vendor || '',
        kind: r.kind || 'chat',
        context: r.context ?? null,
        description: r.description || '',
        tags: r.tags || '',
        endpoints: Array.isArray(r.endpoints) ? [...r.endpoints] : [],
        groups: [],
      }
      map.set(key, a)
    }

    // 同一模型的元信息偶有缺项（不同分组的行补全程度不同），补最全的那个。
    if (!a.description && r.description) a.description = r.description
    if (a.context == null && r.context != null) a.context = r.context
    if (!a.vendor && r.vendor) a.vendor = r.vendor
    if (!a.tags && r.tags) a.tags = r.tags
    for (const e of Array.isArray(r.endpoints) ? r.endpoints : []) {
      if (!a.endpoints.includes(e)) a.endpoints.push(e)
    }

    a.groups.push({
      id: r.group || '',
      ratio: typeof r.groupRatio === 'number' ? r.groupRatio : null,
      auto: r.group === 'auto' || r.groupAuto === true,
      pricing: r.pricing || {},
      row: r,
    })
  }

  const out = [...map.values()]
  for (const a of out) {
    a.groups.sort(byRatioThenName)
    a.cheapest = a.groups[0] || null
    a.priceKind = kindOfGroups(a.groups)
    a.prices = {
      input: spanOf(a.groups, 'inputNum'),
      output: spanOf(a.groups, 'outputNum'),
      cache: spanOf(a.groups, 'cacheNum'),
    }
    a.groupCount = a.groups.length
  }

  // 输出顺序保持输入首见顺序，调用方的排序菜单仍掌握最终顺序。
  return mergeAliases(out)
}

/** 版本号里的 `-` 与 `.` 视为同一种写法：claude-opus-5-5 ≡ claude-opus-5.5。 */
function canonicalName(name) {
  return String(name || '').replace(/(\d)-(?=\d)/g, '$1.')
}

/** 两个分组项是不是同一个「槽位」：同分组、同倍率、同计价、三档数值一致。 */
function sameSlot(a, b) {
  const pa = a.pricing || {}
  const pb = b.pricing || {}
  return a.id === b.id
    && (a.ratio ?? null) === (b.ratio ?? null)
    && (pa.kind || '') === (pb.kind || '')
    && (pa.inputNum ?? null) === (pb.inputNum ?? null)
    && (pa.outputNum ?? null) === (pb.outputNum ?? null)
    && (pa.cacheNum ?? null) === (pb.cacheNum ?? null)
}

/**
 * 合并同一模型的不同拼写（`claude-opus-5-5` 与 `claude-opus-5.5`）。
 *
 * 站点把同一个模型按两种写法挂在目录里，不合并就会多出一张看起来重复的卡。
 * 但「名字长得像」不能当作等价证据，所以加一道硬门槛：**较短的变体**的每个
 * 分组，都必须在**较长的变体**里找到同分组、同倍率、同计价、三档数值完全一样
 * 的一项；全部对上才合并，否则保持两张。合并时只保留主名，另一边记进 aliases，
 * 详情页会写出来，不会悄悄消失。
 */
function mergeAliases(aggs) {
  const buckets = new Map()
  for (const a of aggs) {
    const k = canonicalName(a.name)
    const list = buckets.get(k) || []
    list.push(a)
    buckets.set(k, list)
  }

  const out = []
  for (const list of buckets.values()) {
    if (list.length === 1) { out.push(list[0]); continue }
    // 分组更全的那个当主名（用户看到的名字）
    list.sort((x, y) => y.groupCount - x.groupCount || String(x.name).localeCompare(String(y.name), 'zh'))
    const primary = list[0]
    primary.aliases = [primary.name]
    for (const v of list.slice(1)) {
      const covered = v.groups.every((gv) => primary.groups.some((gp) => sameSlot(gv, gp)))
      if (!covered) {
        // 证据不足：当作不同模型，各自保留
        out.push(v)
        continue
      }
      if (!primary.aliases.includes(v.name)) primary.aliases.push(v.name)
    }
    out.push(primary)
  }
  // 保持调用方拿到的顺序稳定：按首次出现重排
  const order = new Map(aggs.map((a, i) => [a, i]))
  out.sort((x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0))
  return out
}

/**
 * 选一个「聚焦分组」：筛选了某个分组就选它，否则选最便宜的。
 * 详情页的价签、倍率与「当前」标记都以它为准。
 */
export function focusGroupOf(agg, preferGroupId) {
  if (!agg || !Array.isArray(agg.groups) || !agg.groups.length) return null
  if (preferGroupId) {
    const hit = agg.groups.find((g) => g.id === preferGroupId)
    if (hit) return hit
  }
  return agg.cheapest || agg.groups[0]
}
