// 聚合规则的单元测试。ui/model-agg.js 是纯计算模块，可以直接 import，
// 不需要起服务、也不需要 DOM。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { aggregateRows, brandOf, byVersionDesc, focusGroupOf, orderDefault, spanOf, tierRankOf, versionRank } from '../ui/model-agg.js'

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
  // 用不带厂商代号的模型：全部落在默认等级，只有一道
  const out = sortList([agg('acme-6-sol', 'Acme'), agg('acme-5.6', 'Acme'), agg('acme-6.1-sol', 'Acme')])
  assert.deepEqual(out.map((x) => x.name), ['acme-6.1-sol', 'acme-6-sol', 'acme-5.6'])
})

test('byVersionDesc：缺版本号的排末尾，- 与 . 等价', () => {
  const out = [agg('claude-x-preview', 'Anthropic'), agg('claude-x-5.5', 'Anthropic'), agg('claude-x-5-6', 'Anthropic')]
    .sort(byVersionDesc)
  assert.deepEqual(out.map((x) => x.name), ['claude-x-5-6', 'claude-x-5.5', 'claude-x-preview'])
})

test('Gemini 的代号等级：c > a > a-h > a-m > a-l > flash', () => {
  assert.equal(tierRankOf('gemini-4-carbon', 'Google'), 0)
  assert.equal(tierRankOf('gemini-4-argon', 'Google'), 1)
  assert.equal(tierRankOf('gemini-4-argon-high', 'Google'), 2)
  assert.equal(tierRankOf('gemini-4-argon-medium', 'Google'), 3)
  assert.equal(tierRankOf('gemini-4-argon-low', 'Google'), 4)
  assert.equal(tierRankOf('gemini-3.8-flash', 'Google'), 5)
  // 只有 Google 用这套代号；别家同名不受影响
  assert.equal(tierRankOf('some-carbon-model', 'OpenAI'), 3)
})

test('Gemini 4 全系列按 c→a→a-h→a-m→a-l 排，不跨道', () => {
  const list = [
    agg('gemini-4-argon-low', 'Google'),
    agg('gemini-4-argon', 'Google'),
    agg('gemini-4-argon-medium', 'Google'),
    agg('gemini-4-carbon', 'Google'),
    agg('gemini-4-argon-high', 'Google'),
  ]
  const names = sortList(list).map((x) => x.name)
  assert.deepEqual(names, [
    'gemini-4-carbon',
    'gemini-4-argon',
    'gemini-4-argon-high',
    'gemini-4-argon-medium',
    'gemini-4-argon-low',
  ])
})

test('GPT 的代号等级：astra(a) > sol > terra，等级优先于代数', () => {
  assert.equal(tierRankOf('gpt-6-astra', 'OpenAI'), 0)
  assert.equal(tierRankOf('gpt-6.1-sol', 'OpenAI'), 1)
  assert.equal(tierRankOf('gpt-6-sol', 'OpenAI'), 1)
  assert.equal(tierRankOf('gpt-5.6-terra', 'OpenAI'), 2)
  // 6a 必须排在 6.1sol 前面：代数只在同一等级道内比较
  const out = sortList([
    agg('gpt-6.1-sol', 'OpenAI'),
    agg('gpt-6-astra', 'OpenAI'),
    agg('gpt-6-sol', 'OpenAI'),
  ])
  assert.equal(out[0].name, 'gpt-6-astra')
  assert.ok(
    out.findIndex((x) => x.name === 'gpt-6-astra') < out.findIndex((x) => x.name === 'gpt-6.1-sol'),
    'gpt-6-astra 应在 gpt-6.1-sol 之前',
  )
})

// ── 同一模型的不同拼写（- 与 .）去重 ───────────────────────────────

/** 造一行指定名字的目录数据。 */
function rowOf(name, group, ratio) {
  return {
    id: `${group}/${name}`, name, group, groupRatio: ratio, groupAuto: false,
    kind: 'chat', vendor: 'Anthropic', context: 200000, description: '', tags: '',
    endpoints: ['anthropic', 'openai'],
    pricing: { kind: 'ratio', inputNum: 1.4, outputNum: 7, cacheNum: 0.07, input: '$1.40/M' },
  }
}

test('同一模型两种拼写：证据一致就合并，主名保留分组多的那个', () => {
  const out = aggregateRows([
    rowOf('claude-opus-5-5', 'claude-kiro', 0.1),
    rowOf('claude-opus-5-5', 'claude-cursor', 0.4),
    rowOf('claude-opus-5.5', 'claude-kiro', 0.1),
  ])
  assert.equal(out.length, 1, '两种拼写应合成一张卡')
  assert.equal(out[0].name, 'claude-opus-5-5', '主名用分组更全的那种拼写')
  assert.deepEqual(out[0].aliases, ['claude-opus-5-5', 'claude-opus-5.5'], '另一个拼写记进 aliases')
  assert.equal(out[0].groups.length, 2, '同名分组不能因为合并被算两遍')
})

test('拼写相同但价格不同：不合并，各自保留', () => {
  const a = rowOf('claude-opus-5-5', 'claude-kiro', 0.1)
  const b = { ...rowOf('claude-opus-5.5', 'claude-kiro', 0.1), pricing: { ...rowOf('x', 'g', 1).pricing, inputNum: 9.9 } }
  const out = aggregateRows([a, b])
  assert.equal(out.length, 2, '价格对不上就不能当作同一个模型')
})

test('只有一处拼写的模型，aliases 为空且不影响展示', () => {
  const out = aggregateRows([rowOf('claude-sonnet-5-5', 'claude-kiro', 0.1)])
  assert.equal(out.length, 1)
  assert.equal(out[0].aliases, undefined)
})

// ── 国模的品牌顺序：kimi → ds → qwen → glm → hy → minimax → mimo ──────

test('brandOf：从名字或 vendor 认出品牌', () => {
  assert.equal(brandOf('kimi-k3', 'Moonshot'), 'kimi')
  assert.equal(brandOf('deepseek-v4-pro', 'DeepSeek'), 'ds')
  assert.equal(brandOf('qwen3.8-max', '阿里云'), 'qwen')
  assert.equal(brandOf('glm-5.3', '智谱'), 'glm')
  assert.equal(brandOf('hy3', ''), 'hy', '混元的名字就是 hy3，vendor 是空的')
  assert.equal(brandOf('minimax-m3', 'MiniMax'), 'minimax')
  assert.equal(brandOf('mimo-v2.5', ''), 'mimo')
})

test('国模区按品牌顺序排，不按名字或版本', () => {
  const list = [
    agg('mimo-v2.5', ''), agg('minimax-m3', 'MiniMax'), agg('hy3', ''),
    agg('glm-5.3', '智谱'), agg('qwen3.8-max', '阿里云'), agg('deepseek-v4-pro', 'DeepSeek'),
    agg('kimi-k3', 'Moonshot'),
  ]
  const names = sortList(list).map((x) => x.name)
  assert.deepEqual(names, [
    'kimi-k3', 'deepseek-v4-pro', 'qwen3.8-max', 'glm-5.3', 'hy3', 'minimax-m3', 'mimo-v2.5',
  ])
})

test('国模这类「档位只是变体」的类别：代数优先于档位', () => {
  // mimo-v2.6-flash 必须排在 mimo-v2.5-pro 前面：2.6 > 2.5，flash 只是同代变体
  const out = sortList([
    agg('mimo-v2.5-pro', ''),
    agg('mimo-v2.5', ''),
    agg('mimo-v2.6-flash', ''),
  ])
  assert.deepEqual(out.map((x) => x.name), ['mimo-v2.6-flash', 'mimo-v2.5-pro', 'mimo-v2.5'])
})

test('同代内才比档位：v4-pro 在 v4-flash 之前', () => {
  const out = sortList([
    agg('deepseek-v4-flash', 'DeepSeek'),
    agg('deepseek-v4-pro', 'DeepSeek'),
  ])
  assert.deepEqual(out.map((x) => x.name), ['deepseek-v4-pro', 'deepseek-v4-flash'])
})

test('版本相同时档位先于名称，不被名字排序挡掉', () => {
  // glm-5-3-flash-260828 与 glm-5.3 版本都是 5.3；按名字会 flash 在前，
  // 但档位（默认档 3 < flash 档 4）应当先发挥作用
  const out = sortList([
    agg('glm-5-3-flash-260828', '智谱'),
    agg('glm-5.3', '智谱'),
  ])
  assert.deepEqual(out.map((x) => x.name), ['glm-5.3', 'glm-5-3-flash-260828'])
})

// ── 视频的品牌顺序：seed(ance) → h3 → wan → veo → omni → grok → muse ──

test('brandOf：名字优先于 vendor（wan 不能被阿里云判成 qwen）', () => {
  assert.equal(brandOf('wan3.0-video', '阿里云'), 'wan')
  assert.equal(brandOf('seedance-2.5', '字节跳动'), 'seed')
  assert.equal(brandOf('veo-3.1', 'Google'), 'veo')
  assert.equal(brandOf('omni-flash-video', 'Google'), 'omni')
  assert.equal(brandOf('grok-imagine-video-1.5', 'xAI'), 'grok')
  assert.equal(brandOf('muse-video', ''), 'muse')
  // 名字看不出来时才退回 vendor
  assert.equal(brandOf('some-unnamed', 'DeepSeek'), 'ds')
})

test('视频区按品牌顺序排', () => {
  const list = [
    agg('muse-video', ''), agg('grok-imagine-video-1.5', 'xAI'), agg('omni-flash-video', 'Google'),
    agg('veo-3.1', 'Google'), agg('wan3.0-video', '阿里云'), agg('seedance-2.5', '字节跳动'),
  ].map((a) => ({ ...a, cat: 'video' }))
  const catOf = () => 'video'
  const names = orderDefault(list, { catOf, catOrder: ['video'] }).map((x) => x.name)
  assert.deepEqual(names, [
    'seedance-2.5', 'wan3.0-video', 'veo-3.1', 'omni-flash-video',
    'grok-imagine-video-1.5', 'muse-video',
  ])
})
