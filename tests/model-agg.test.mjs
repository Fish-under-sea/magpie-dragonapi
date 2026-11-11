// 聚合规则的单元测试。ui/model-agg.js 是纯计算模块，可以直接 import，
// 不需要起服务、也不需要 DOM。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { aggregateRows, byVersionDesc, focusGroupOf, orderDefault, spanOf, tierRankOf, versionRank } from '../ui/model-agg.js'

/** 造一行目录数据，字段与 lib/catalog.mjs 的输出一致。 */
function row(group, ratio, input, output, cache, extra = {}) {
  return {
    id: `${group}/gpt-6.1-sol`,
    name: 'gpt-6.1-sol',
    group,
    groupRatio: ratio,
    groupAuto: false,
    kind: 'chat',
    vendor: 'OpenAI',
    context: 128000,
    description: 'OpenAI 的对话模型。',
    tags: '',
    endpoints: ['openai'],
    pricing: {
      kind: 'tiered',
      inputNum: input,
      outputNum: output,
      cacheNum: cache,
      input: `$${input}/M`,
      output: `$${output}/M`,
      cache: `$${cache}/M`,
    },
    ...extra,
  }
}

test('同一个模型的多个分组聚合成一张卡，分组一个都不省略', () => {
  const rows = [
    row('gpt-pro', 0.16, 0.32, 1.6, 0.02),
    row('gpt-特惠', 0.06, 0.12, 0.6, 0.006),
    row('gpt-plus', 0.1, 0.2, 1.0, 0.01),
    row('gpt-promax', 0.16, 0.32, 1.6, 0.02),
  ]
  const out = aggregateRows(rows)
  assert.equal(out.length, 1, '四个分组应聚合成一个模型')
  assert.equal(out[0].groups.length, 4, '分组必须全部保留，不能省略')
  assert.equal(out[0].groupCount, 4)
})

test('分组按倍率升序，便宜的在前', () => {
  const out = aggregateRows([
    row('gpt-pro', 0.16, 0.32, 1.6, 0.02),
    row('gpt-特惠', 0.06, 0.12, 0.6, 0.006),
    row('gpt-plus', 0.1, 0.2, 1.0, 0.01),
  ])
  assert.deepEqual(out[0].groups.map((g) => g.id), ['gpt-特惠', 'gpt-plus', 'gpt-pro'])
  assert.equal(out[0].cheapest.id, 'gpt-特惠')
})

test('auto 分组没有固定倍率，排在最后', () => {
  const out = aggregateRows([
    row('auto', null, 0.3, 1.5, 0.03, { groupAuto: true }),
    row('gpt-pro', 0.16, 0.32, 1.6, 0.02),
  ])
  assert.deepEqual(out[0].groups.map((g) => g.id), ['gpt-pro', 'auto'])
})

test('价格给区间而不是取最低：价差大时 min 与 max 都要在', () => {
  const out = aggregateRows([
    row('gpt-特惠', 0.06, 0.12, 0.6, 0.006),
    row('gpt-pro', 0.16, 0.32, 1.6, 0.02),
  ])
  const { input, output, cache } = out[0].prices
  assert.equal(input.min, 0.12)
  assert.equal(input.max, 0.32)
  assert.equal(input.same, false)
  assert.equal(output.min, 0.6)
  assert.equal(output.max, 1.6)
  assert.equal(cache.same, false)
})

test('所有分组价格相同时 same=true，展示层据此只印一个数', () => {
  const out = aggregateRows([
    row('gpt-pro', 0.16, 0.32, 1.6, 0.02),
    row('gpt-promax', 0.16, 0.32, 1.6, 0.02),
  ])
  assert.equal(out[0].prices.input.same, true)
})

test('缺少数值时不硬凑区间，返回 null 让调用方退回站点字符串', () => {
  const out = aggregateRows([
    row('gpt-pro', 0.16, 0.32, 1.6, 0.02, { pricing: { kind: 'percall', input: '$0.02/次' } }),
  ])
  assert.equal(out[0].prices.input, null)
  assert.equal(out[0].priceKind, 'percall')
})

test('计价方式不一致标 mixed，不假装统一', () => {
  const out = aggregateRows([
    row('gpt-pro', 0.16, 0.32, 1.6, 0.02),
    row('gpt-特惠', 0.06, 0.12, 0.6, 0.006, { pricing: { kind: 'percall', input: '$0.02/次' } }),
  ])
  assert.equal(out[0].priceKind, 'mixed')
})

test('元信息取最全的那一行，端点取并集', () => {
  const out = aggregateRows([
    row('a', 0.1, 1, 1, 1, { description: '', context: null, endpoints: ['openai'] }),
    row('b', 0.2, 1, 1, 1, { description: '有说明', context: 200000, endpoints: ['anthropic'] }),
  ])
  assert.equal(out[0].description, '有说明')
  assert.equal(out[0].context, 200000)
  assert.deepEqual(out[0].endpoints.sort(), ['anthropic', 'openai'])
})

test('不同模型不会被并到一起', () => {
  const a = row('gpt-pro', 0.16, 0.32, 1.6, 0.02)
  const b = { ...row('gpt-pro', 0.16, 1, 5, 0.1), name: 'gpt-6-astra', id: 'gpt-pro/gpt-6-astra' }
  const out = aggregateRows([a, b])
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((x) => x.name).sort(), ['gpt-6-astra', 'gpt-6.1-sol'])
})

test('空输入返回空数组，不抛', () => {
  assert.deepEqual(aggregateRows([]), [])
  assert.deepEqual(aggregateRows(null), [])
})

test('focusGroupOf：筛选了某个分组就用它，否则用最便宜的', () => {
  const out = aggregateRows([
    row('gpt-pro', 0.16, 0.32, 1.6, 0.02),
    row('gpt-特惠', 0.06, 0.12, 0.6, 0.006),
  ])
  assert.equal(focusGroupOf(out[0], 'gpt-pro').id, 'gpt-pro')
  assert.equal(focusGroupOf(out[0], '').id, 'gpt-特惠')
  assert.equal(focusGroupOf(out[0], '不存在的分组').id, 'gpt-特惠')
  assert.equal(focusGroupOf(null, 'x'), null)
})

test('spanOf 忽略非数值与 null', () => {
  const s = spanOf([{ pricing: { a: 1 } }, { pricing: { a: null } }, { pricing: {} }, { pricing: { a: 3 } }], 'a')
  assert.deepEqual(s, { min: 1, max: 3, same: false, count: 2 })
  assert.equal(spanOf([], 'a'), null)
})

// ── 默认排序：厂商 → 模型等级 → 版本号 ─────────────────────────────

test('版本号解析：- 与 . 等价', () => {
  assert.deepEqual(versionRank('claude-fable-5-2'), [5, 2])
  assert.deepEqual(versionRank('claude-opus-5.5'), [5, 5])
  assert.deepEqual(versionRank('deepseek-v4'), [4])
  assert.equal(versionRank('no-version-here'), null)
})

test('模型等级：旗舰 < 标准 < 轻量', () => {
  assert.equal(tierRankOf('deepseek-v4-pro'), 2)
  assert.equal(tierRankOf('glm-5.3-flash'), 4)
  assert.equal(tierRankOf('claude-fable-5-2'), 0, 'fable 最高档')
  assert.equal(tierRankOf('claude-opus-5-5'), 1, 'opus 次之')
  assert.equal(tierRankOf('claude-sonnet-5-5'), 2, 'sonnet 第三')
  assert.equal(tierRankOf('claude-haiku-5-5'), 4, 'haiku 最低')
  // 整词匹配：minimax 不能被当成 mini
  assert.equal(tierRankOf('minimax-m'), 3, 'minimax 不该命中 mini')
  // 同时出现多个档位词时取最高的那个
  assert.equal(tierRankOf('minimax-m-pro'), 2)
})

/** 造一个聚合对象，只带排序需要的字段。 */
function agg(name, vendor, group = 'g1') {
  return aggregateRows([{
    id: `${group}/${name}`, name, group, groupRatio: 0.1, groupAuto: false,
    kind: 'chat', vendor, context: 1000, description: '', tags: '', endpoints: ['openai'],
    pricing: { kind: 'ratio', inputNum: 1, outputNum: 2, cacheNum: 0.1, input: '$1/M' },
  }])[0]
}

const CATS = ['claude', 'gpt', 'gemini', 'grok', 'guomo', 'image', 'video', 'other']
const catOfName = (a) => (/claude/.test(a.name) ? 'claude' : /gpt/.test(a.name) ? 'gpt' : 'other')
const sortList = (list) => orderDefault(list, { catOf: catOfName, catOrder: CATS })

test('默认排序：先按厂商分区，不跨厂商插队', () => {
  // gpt-6.1 的版本号比 fable-5-2 大，但厂商分区在前，不能压过去
  const out = sortList([agg('gpt-6.1-sol', 'OpenAI'), agg('claude-fable-5-2', 'Anthropic')])
  assert.deepEqual(out.map((x) => x.name), ['claude-fable-5-2', 'gpt-6.1-sol'])
})

test('默认排序：同厂商内先按等级，再按版本号', () => {
  const out = sortList([
    agg('claude-haiku-4-5', 'Anthropic'),
    agg('claude-opus-5-5', 'Anthropic'),
    agg('claude-sonnet-5-5-pro', 'Anthropic'),
  ])
  // opus(0) → pro(1) → 标准(2) → 轻量(3)；同档内版本大的在前
  assert.deepEqual(out.map((x) => x.name), ['claude-opus-5-5', 'claude-sonnet-5-5-pro', 'claude-haiku-4-5'])
})

test('默认排序：空厂商排在本类别末尾，不跳到最前', () => {
  const out = sortList([agg('zzz-model', ''), agg('gpt-6-sol', 'OpenAI')])
  assert.deepEqual(out.map((x) => x.vendor), ['OpenAI', ''])
})

test('默认排序：没有版本号的排在同组末尾', () => {
  const out = sortList([agg('claude-preview', 'Anthropic'), agg('claude-opus-5', 'Anthropic')])
  assert.deepEqual(out.map((x) => x.name), ['claude-opus-5', 'claude-preview'])
})

test('默认排序：等级分道轮转，不把同一等级排成一片', () => {
  const list = [
    agg('claude-fable-5', 'Anthropic'),
    agg('claude-fable-5-2', 'Anthropic'),
    agg('claude-opus-5-5', 'Anthropic'),
    agg('claude-opus-5', 'Anthropic'),
    agg('claude-sonnet-5-5', 'Anthropic'),
    agg('claude-sonnet-5', 'Anthropic'),
    agg('claude-haiku-5-5', 'Anthropic'),
    agg('claude-haiku-5', 'Anthropic'),
  ]
  const names = sortList(list).map((x) => x.name)
  // f5.2 → o5.5 → s5.5 → h5.5 → f5 → o5 → s5 → h5
  assert.deepEqual(names, [
    'claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
    'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5',
  ])
})

test('默认排序：只要还有别的等级可排，就不出现同等级相邻', () => {
  const list = []
  for (const g of ['fable', 'opus', 'sonnet', 'haiku']) {
    for (const v of ['5-3', '5-2', '5-1', '5']) list.push(agg(`claude-${g}-${v}`, 'Anthropic'))
  }
  const out = sortList(list)
  const gradeOf = (n) => n.split('-')[1]
  for (let i = 1; i < out.length - 4; i++) {
    assert.notEqual(gradeOf(out[i].name), gradeOf(out[i - 1].name),
      `第 ${i + 1} 个与上一个同等级（还有别的等级没排完）：${out[i - 1].name} → ${out[i].name}`)
  }
})

test('默认排序：单一等级时退化为版本降序', () => {
  const out = sortList([agg('gpt-6-sol', 'OpenAI'), agg('gpt-5.6', 'OpenAI'), agg('gpt-6.1-sol', 'OpenAI')])
  assert.deepEqual(out.map((x) => x.name), ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6'])
})

test('byVersionDesc：缺版本号的排末尾，- 与 . 等价', () => {
  const out = [agg('claude-x-preview', 'Anthropic'), agg('claude-x-5.5', 'Anthropic'), agg('claude-x-5-6', 'Anthropic')]
    .sort(byVersionDesc)
  assert.deepEqual(out.map((x) => x.name), ['claude-x-5-6', 'claude-x-5.5', 'claude-x-preview'])
})
