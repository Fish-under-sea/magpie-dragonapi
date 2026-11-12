// 目录：把站点 /api/pricing 折成 magpie 的模型表。
//
// 这里有一处与 NearToken 的根本不同，必须先说清：
//
//   NearToken 站点让插件在请求头里塞 `x-neartoken-group` 来选分组，所以它
//   可以「一个模型一行，按那一行走那一组」。DragonAPI 没有这个补丁——
//   `TokenAuth` 里 `userGroup = tokenGroup`，分组是**钥匙的属性**，请求头里
//   没有任何入口能改它（`Distribute` 只从 `/pg/chat/completions` 的请求体读
//   group，而那条路由要浏览器会话）。
//
// 所以这里的分组策略是：**一个分组一把钥匙 = magpie 的一个账号**。
// 模型 id 用 `分组/模型` 的形式，每个账号的 `models` 清单只列它那一组的模型，
// 让宿主自己把请求送到对的账号（上游 magpie 的 `AccountServes` 保证这点）。
// 这也意味着**目录里的分组是给账号用的，不是给请求头用的**。

import { priceOf } from './pricing.mjs'

/** 端点类型 → 该用哪个 SDK 方言发出去。 */
export function npmOf(row) {
  const ends = Array.isArray(row?.supported_endpoint_types) ? row.supported_endpoint_types.map(String) : []
  // 只要模型支持 openai 兼容，就走 openai-compatible：本站绝大多数模型都挂着它，
  // 而且 anthropic / gemini 原生通道在 magpie 里要额外的账号形态，第一版不做。
  if (ends.includes('openai') || ends.includes('openai-response')) return '@ai-sdk/openai-compatible'
  if (ends.includes('image-generation')) return '@ai-sdk/openai-compatible'
  if (ends.includes('anthropic')) return '@ai-sdk/anthropic'
  if (ends.includes('gemini')) return '@ai-sdk/google'
  return '@ai-sdk/openai-compatible'
}

/** 模型的类别，决定 magpie 把它放进哪个分区。 */
export function kindOf(row) {
  const ends = Array.isArray(row?.supported_endpoint_types) ? row.supported_endpoint_types.map(String) : []
  if (ends.includes('image-generation')) return 'image'
  if (ends.includes('视频任务')) return 'video'
  if (ends.some((e) => /^(audio|tts|asr|transcription|speech)$/i.test(e))) return 'audio'
  if (ends.some((e) => /^(embedding|jina-rerank|rerank)$/i.test(e))) return 'embedding'
  const groups = Array.isArray(row?.enable_groups) ? row.enable_groups.join(' ').toLowerCase() : ''
  const tags = String(row?.tags || '').toLowerCase()
  // 站点把生图模型挂在 image 分组，endpoint 仍写 openai/gemini，单看 endpoint
  // 会被误判成 chat，然后混进 LLM 列表、还带上思考强度。分组/tag 是可靠信号。
  if (/image|图像|生图|绘图|绘画/.test(groups) || /图像|生图|绘图|绘画/.test(tags)) return 'image'
  if (/embedding|向量|rerank/.test(groups)) return 'embedding'
  return 'chat'
}

/** kindOutput 是 magpie 的 capabilities.output：分区靠它认。 */
export function kindOutput(kind) {
  switch (kind) {
    case 'image': return { image: true, text: true }
    case 'video': return { video: true, text: true }
    case 'audio': return { audio: true, text: true }
    case 'embedding': return { embedding: true, text: true }
    default: return { text: true }
  }
}

/**
 * seriesRank 决定供应商列表里的排序：对话在前，功能模型在后。
 * 站点自己给的 group_order 是「推荐顺序」，直接用它更贴合站点。
 */
function rankOf(kind, group, groupOrder) {
  const base = kind === 'chat' ? 0 : 1 + ['image', 'video', 'audio', 'embedding'].indexOf(kind)
  const gi = Array.isArray(groupOrder) ? groupOrder.indexOf(group) : -1
  return [base, gi < 0 ? 999 : gi]
}

/**
 * buildCatalog 把站点目录折成
 *   { models: {id: Model}, rows: [行], groups: [组], vendors: [vendor], version }
 *
 * `rows` 是「分组 × 模型」的扁平表，给页面用；`models` 是给宿主的模型表。
 * `enabledGroups` 是用户勾选的分组（空数组表示全部分组）。
 */
export function buildCatalog(env, { cur, enabledGroups = [], site } = {}) {
  const data = Array.isArray(env?.data) ? env.data : []
  const ratios = env?.group_ratio && typeof env.group_ratio === 'object' ? env.group_ratio : {}
  const order = Array.isArray(env?.group_order) ? env.group_order : []
  const notes = env?.usable_group && typeof env.usable_group === 'object' ? env.usable_group : {}
  const vendors = Array.isArray(env?.vendors) ? env.vendors : []
  const vendorName = new Map(vendors.map((v) => [String(v?.id), String(v?.name || '')]))

  // auto_groups 是「令牌可配置的自动分组候选」，跟价格无关——它只是站点
  // 允许你在令牌上挂哪几个分组做自动路由。之前把它当成「价格随通道浮动」，
  // 结果 13/14 个分组都被标成「以实际命中通道为准」，把真实单价全藏了。
  // 现在只把真正的 `auto` 分组视为无固定倍率（它确实不在 group_ratio 里）。
  const autoGroups = Array.isArray(env?.auto_groups) ? env.auto_groups.map(String) : []

  // 勾选为空 = 全部分组。
  const picked = new Set((Array.isArray(enabledGroups) ? enabledGroups : []).map(String).filter(Boolean))

  const groups = new Map()
  const rows = []
  const models = {}

  for (const row of data) {
    const name = String(row?.model_name || '').trim()
    if (!name) continue
    const kind = kindOf(row)
    const ends = Array.isArray(row?.supported_endpoint_types) ? row.supported_endpoint_types.map(String) : []
    const all = Array.isArray(row?.enable_groups) && row.enable_groups.length ? row.enable_groups.map(String) : []
    if (!all.length) continue

    for (const g of all) {
      const group = String(g || '').trim()
      if (!group) continue
      const ratio = Number(ratios[group]) || 0
      // `auto` 分组不在 group_ratio 里：它的实际倍率取决于命中的通道，
      // 站点自己也算不出一个确定值，所以这类分组不给单价。
      const isAuto = group === 'auto' || !(group in ratios)
      // 分组统计按「全量」算，页面要显示每组多少模型；是否进账号另判。
      const had = groups.get(group) || { id: group, ratio, note: String(notes[group] || ''), models: 0, auto: isAuto }
      had.models += 1
      groups.set(group, had)

      if (picked.size && !picked.has(group)) continue

      // 没有固定倍率的分组（只有 `auto`）算不出确定单价，交给 priceOf 的
      // unknown 分支，让 note 说清「为什么算不出来」，而不是硬塞一个数。
      const price = isAuto && !ratio
        ? { kind: 'unknown', input: '价格未知', output: '', cache: '', note: '该分组按命中的通道计费，站点没有给固定倍率' }
        : priceOf(row, ratio, cur)
      const id = `${group}/${name}`
      // 同一个「分组/模型」只会出现一次；站点不会给重复行。
      const [r0, r1] = rankOf(kind, group, order)
      // rows 与 models 共用同一套排序键：页面看到的第一行，就是宿主列表里
      // 的第一行。两处各排各的会让「界面上排在最前的模型」和「magpie 里排
      // 在最前的模型」不是同一个，用户会以为它们不是同一份数据。
      rows.push({
        id,
        name,
        group,
        groupRatio: ratio,
        groupAuto: isAuto,
        vendor: vendorName.get(String(row?.vendor_id)) || '',
        kind,
        endpoints: ends,
        context: Number(row?.context_window) > 0 ? Number(row.context_window) : 0,
        pricing: price,
        description: String(row?.description || ''),
        tags: String(row?.tags || ''),
        _rank: [r0, r1, name, group],
      })

      models[id] = {
        id,
        name: `${name} · ${group}${ratio > 0 ? ` ×${round(ratio)}` : ''}`,
        api: { id: name, url: String(site || '').replace(/\/+$/, '') + '/v1', npm: npmOf(row) },
        limit: {
          context: Number(row?.context_window) > 0 ? Number(row.context_window) : 0,
          output: 0,
        },
        ...(kind === 'chat' ? {} : { kind }),
        capabilities: {
          toolcall: kind === 'chat',
          output: kindOutput(kind),
          attachment: false,
          input: { text: true, image: false, audio: false, video: false, pdf: false },
          ...(kind === 'chat' ? { reasoning: true } : {}),
        },
        ...(kind === 'chat' ? { variants: { minimal: {}, low: {}, medium: {}, high: {}, xhigh: {}, max: {} } } : {}),
        // 排序用的私有字段，不进宿主（宿主会忽略不认识的键）
        _rank: [r0, r1, name],
      }
    }
  }

  // 按 rank 排序后把 _rank 去掉：宿主按对象的插入顺序展示模型列表。
  const ordered = Object.keys(models).sort((a, b) => {
    const x = models[a]._rank
    const y = models[b]._rank
    return x[0] - y[0] || x[1] - y[1] || String(x[2]).localeCompare(String(y[2]))
  })
  const out = {}
  for (const id of ordered) {
    const m = models[id]
    delete m._rank
    out[id] = m
  }

  // 页面行用同一套键排序，然后去掉私有字段。
  rows.sort((a, b) => {
    const x = a._rank
    const y = b._rank
    return x[0] - y[0] || x[1] - y[1] || String(x[2]).localeCompare(String(y[2])) || String(x[3]).localeCompare(String(y[3]))
  })
  for (const r of rows) delete r._rank

  return {
    models: out,
    rows,
    groups: [...groups.values()].sort((a, b) => (order.indexOf(a.id) - order.indexOf(b.id)) || a.id.localeCompare(b.id, 'zh')),
    vendors: vendors.map((v) => ({ id: Number(v?.id) || 0, name: String(v?.name || '') })),
    version: String(env?.pricing_version || ''),
    autoGroups,
  }
}

/** 一个分组下的模型 id 清单，给账号的 models 字段用。 */
export function modelsOfGroup(rows, group) {
  const g = String(group || '')
  return rows.filter((r) => r.group === g).map((r) => r.id)
}

const round = (v) => String(Math.round(Number(v) * 10000) / 10000)
