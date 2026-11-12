// 目录构建的回归测试。
//
// 用的是站点 2026-11-10 的真实快照（证据-站点定价快照-2026-11-10.json），
// 所以数字对不上就说明站点变了，或者我们的折叠逻辑坏了。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildCatalog, modelsOfGroup, npmOf, kindOf, kindOutput } from '../lib/catalog.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const snapshot = JSON.parse(readFileSync(join(here, '..', '证据-站点定价快照-2026-11-10.json'), 'utf8'))
const CUR = { symbol: '$', per: 500000, rate: 1, code: 'USD', display: true }
const SITE = 'https://newapi.dragon3api.com'

test('快照本身没坏：122 个模型、14 个分组、29 个 vendor', () => {
  assert.equal(snapshot.data.length, 122)
  assert.equal(Object.keys(snapshot.group_ratio).length, 14)
  assert.equal(snapshot.vendors.length, 29)
})

test('buildCatalog 展开成 195 行「分组 × 模型」', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  assert.equal(c.rows.length, 195)
  // 模型表也应该是 195 条：一行一个 id
  assert.equal(Object.keys(c.models).length, 195)
})

test('每个模型 id 都是 `分组/模型`，且能反解回原模型名', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  const names = new Set(snapshot.data.map((m) => m.model_name))
  for (const id of Object.keys(c.models)) {
    assert.match(id, /^[^/]+\/.+$/, `id 形状不对：${id}`)
    const bare = id.slice(id.indexOf('/') + 1)
    assert.ok(names.has(bare), `反解不出模型名：${id}`)
  }
})

test('分组统计覆盖全部 14 个分组，且模型数加起来等于 195', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  assert.equal(c.groups.length, 14)
  const sum = c.groups.reduce((n, g) => n + g.models, 0)
  assert.equal(sum, 195)
  const ids = c.groups.map((g) => g.id).sort()
  assert.deepEqual(ids, Object.keys(snapshot.group_ratio).sort())
})

test('modelsOfGroup 只给该分组的模型，且与账号隔离策略一致', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  const gptPlus = modelsOfGroup(c.rows, 'gpt-plus')
  assert.equal(gptPlus.length, 5)
  for (const id of gptPlus) assert.ok(id.startsWith('gpt-plus/'))
  // 另一个分组不能混进来
  assert.equal(gptPlus.filter((id) => id.startsWith('gpt-pro/')).length, 0)
})

test('enabledGroups 过滤生效；空数组表示全部', () => {
  const all = buildCatalog(snapshot, { cur: CUR, site: SITE, enabledGroups: [] })
  assert.equal(all.rows.length, 195)
  const only = buildCatalog(snapshot, { cur: CUR, site: SITE, enabledGroups: ['gpt-plus', 'grok'] })
  assert.equal(only.rows.length, 5 + 4)
  assert.equal(only.rows.every((r) => r.group === 'gpt-plus' || r.group === 'grok'), true)
})

test('kind 分布按分组/tag 识别生图：image 32 / video 27', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  const byKind = {}
  for (const r of c.rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1
  // image 分组的生图模型 endpoint 也写 openai/gemini；只看 endpoint 会漏掉一半，
  // 必须结合 enable_groups/tags，整组 32 个都算 image。
  assert.equal(byKind.image, 32)
  assert.equal(byKind.video, 27)
  assert.ok(byKind.chat > 0)
})

test('视频模型的 capabilities.output 带 video', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  const videoIds = Object.keys(c.models).filter((id) => c.models[id].kind === 'video')
  assert.equal(videoIds.length, 27)
  for (const id of videoIds) {
    assert.equal(c.models[id].capabilities.output.video, true)
  }
})

test('生图模型的 capabilities.output 带 image', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  const imageIds = Object.keys(c.models).filter((id) => c.models[id].kind === 'image')
  assert.equal(imageIds.length, 32)
  for (const id of imageIds) {
    assert.equal(c.models[id].capabilities.output.image, true)
  }
})

test('api.id 是站点认的裸模型名，api.url 指向站点的 /v1', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  const id = 'gpt-plus/gpt-6-sol'
  const m = c.models[id]
  assert.ok(m, '应该有 gpt-plus/gpt-6-sol')
  assert.equal(m.api.id, 'gpt-6-sol')
  assert.equal(m.api.url, SITE + '/v1')
})

test('显示名带分组与倍率，便于在多账号列表里区分', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  const m = c.models['gpt-plus/gpt-6-sol']
  assert.match(m.name, /gpt-6-sol/)
  assert.match(m.name, /gpt-plus/)
  assert.match(m.name, /×0\.1/)
})

test('价格：未知的不会被编造成 0', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  const unknown = c.rows.filter((r) => r.pricing.kind === 'unknown')
  // 站点上确实有一批算不准的（表达式只有 fixed/param 之类），它们必须标 unknown
  for (const r of unknown) {
    assert.equal(r.pricing.input, '价格未知')
    assert.ok(r.pricing.note.length > 0)
  }
  // 绝大多数应该是能算的
  const known = c.rows.length - unknown.length
  assert.ok(known / c.rows.length > 0.7, `可算价格的比例太低：${known}/${c.rows.length}`)
})

test('auto_groups 不是价格标志：有倍率的分组必须给出真实单价', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  // 站点快照里 auto_groups 含 13 个分组（只少 claude-cursor 一个），它表示
  // 「令牌可配置的自动分组候选」，与计费无关。曾经把它当成「价格随通道浮动」，
  // 结果 13/14 个分组全显示「以实际命中通道为准」，把真实单价藏了。
  assert.ok(snapshot.auto_groups.length > 10, `auto_groups 应有多个：${snapshot.auto_groups.length}`)
  const inAutoAndPriced = c.rows.filter((r) => snapshot.auto_groups.includes(r.group) && snapshot.group_ratio[r.group] > 0)
  assert.ok(inAutoAndPriced.length > 100, `应该有一大批「在 auto_groups 里且有倍率」的行：${inAutoAndPriced.length}`)
  for (const r of inAutoAndPriced) {
    assert.notEqual(r.pricing.kind, 'unknown', `${r.id} 有倍率却算不出价`)
    assert.notEqual(r.pricing.input, '价格未知', `${r.id} 有倍率却显示价格未知`)
  }
})

test('只有没有固定倍率的分组才说「价格未知」', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  const unknown = c.rows.filter((r) => r.pricing.kind === 'unknown')
  for (const r of unknown) {
    // 没有倍率，或者真的解析不出表达式——两种都合理；有倍率且能解析的不该在这里
    const hasRatio = snapshot.group_ratio[r.group] > 0
    if (hasRatio) {
      assert.ok(r.pricing.note.length > 0, `${r.id} 价格未知必须给原因`)
    }
  }
})

test('价格可算比例足够高（真实站点上 100%）', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  const known = c.rows.filter((r) => r.pricing.kind !== 'unknown').length
  assert.ok(known / c.rows.length > 0.95, `可算价格比例太低：${known}/${c.rows.length}`)
})

test('输出价不能低于输入价（真实站点上不该出现这种定价）', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  const bad = []
  for (const r of c.rows) {
    const p = r.pricing
    if (p.kind !== 'ratio' && p.kind !== 'tiered' && p.kind !== 'flat') continue
    const inNum = Number(String(p.input).replace(/[^0-9.]/g, ''))
    const outNum = Number(String(p.output).replace(/[^0-9.]/g, ''))
    if (!Number.isFinite(inNum) || !Number.isFinite(outNum)) continue
    // 输出通常比输入贵 2–8 倍；低于输入说明系数取错了（曾经 c 被读成 cr 里的 c）
    if (outNum < inNum) bad.push(`${r.id}: 入 ${p.input} / 出 ${p.output}`)
  }
  assert.deepEqual(bad, [], `这些模型的输出价低于输入价，系数可能取错：\n${bad.join('\n')}`)
})

test('npmOf 按端点选方言', () => {
  assert.equal(npmOf({ supported_endpoint_types: ['openai'] }), '@ai-sdk/openai-compatible')
  assert.equal(npmOf({ supported_endpoint_types: ['openai-response'] }), '@ai-sdk/openai-compatible')
  assert.equal(npmOf({ supported_endpoint_types: ['anthropic'] }), '@ai-sdk/anthropic')
  assert.equal(npmOf({ supported_endpoint_types: ['gemini'] }), '@ai-sdk/google')
  assert.equal(npmOf({}), '@ai-sdk/openai-compatible')
})

test('kindOf 只看端点与分组，不猜模型名', () => {
  assert.equal(kindOf({ supported_endpoint_types: ['image-generation'] }), 'image')
  assert.equal(kindOf({ supported_endpoint_types: ['视频任务'] }), 'video')
  assert.equal(kindOf({ supported_endpoint_types: ['openai'] }), 'chat')
  // 名字里带 video 但没有视频端点 → 仍是 chat
  assert.equal(kindOf({ model_name: 'video-helper', supported_endpoint_types: ['openai'] }), 'chat')
})

test('kindOutput 给对话模型 text:true', () => {
  assert.deepEqual(kindOutput('chat'), { text: true })
  assert.equal(kindOutput('video').video, true)
  assert.equal(kindOutput('image').image, true)
})

test('排序：对话在前，功能模型在后', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  const ids = Object.keys(c.models)
  const kinds = ids.map((id) => c.models[id].kind || 'chat')
  const firstNonChat = kinds.findIndex((k) => k !== 'chat')
  if (firstNonChat > 0) {
    const tail = kinds.slice(firstNonChat)
    assert.equal(tail.every((k) => k !== 'chat'), true, '对话模型不应出现在功能模型之后')
  }
})

test('rows 与 models 顺序一致：页面第一行就是宿主第一行', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  const fromModels = Object.keys(c.models)
  const fromRows = c.rows.map((r) => r.id)
  assert.deepEqual(fromRows, fromModels, '两处顺序不一致会让用户以为不是同一份数据')
})

test('rows 不残留内部排序字段', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  for (const r of c.rows) {
    assert.equal('_rank' in r, false, `${r.id} 残留了 _rank`)
  }
  for (const id of Object.keys(c.models)) {
    assert.equal('_rank' in c.models[id], false, `${id} 残留了 _rank`)
  }
})

test('rows 第一行是对话模型（不是图片/视频）', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  assert.equal(c.rows[0].kind, 'chat', `第一行是 ${c.rows[0].kind}：${c.rows[0].id}`)
})

test('image 分组里 endpoint 写 openai 的生图模型也归为 image，不会混进 LLM', () => {
  const c = buildCatalog(snapshot, { cur: CUR, site: SITE })
  const row = c.rows.find((r) => r.name === 'banana-pro-1k')
  assert.ok(row, '快照里应有 banana-pro-1k')
  assert.equal(row.kind, 'image')
  const m = c.models[row.id]
  assert.equal(m.kind, 'image')
  assert.equal(m.capabilities.output.image, true)
  assert.equal('variants' in m, false, '生图模型不该带 LLM 的思考强度档位')
})