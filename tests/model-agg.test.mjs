// 聚合规则的单元测试。ui/model-agg.js 是纯计算模块，可以直接 import，
// 不需要起服务、也不需要 DOM。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { aggregateRows, focusGroupOf, spanOf } from '../ui/model-agg.js'

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
