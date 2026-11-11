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
 * rows：目录里的行（每行一个分组×模型，字段见 lib/catalog.mjs 的 buildCatalog）。
 * 返回聚合后的模型数组，每个元素带 groups（全部分组，按倍率升序）。
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