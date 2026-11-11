// 价格解析的回归测试。
//
// 这些用例全部取自站点 /api/pricing 的真实数据（2026-11-10 快照），
// 所以它们既是单测，也是「站点换了写法就会被发现」的哨兵。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseTiers, chatCoeffs, usagePrices, priceOf, billingOf } from '../lib/pricing.mjs'

const CUR = { symbol: '$', per: 500000, rate: 1, code: 'USD', display: true }

test('parseTiers 取出所有档位，忽略嵌套括号', () => {
  const expr = 'len <= 272000 ? tier("short_context", p*2 + c*10) : tier("long_context", p*4 + c*15)'
  const tiers = parseTiers(expr)
  assert.equal(tiers.length, 2)
  assert.deepEqual(tiers.map((t) => t.name), ['short_context', 'long_context'])
  assert.equal(tiers[0].body, 'p*2 + c*10')
  assert.equal(tiers[1].body, 'p*4 + c*15')
})

test('parseTiers 能处理一元 tier（按次模型）', () => {
  const tiers = parseTiers('tier("按次", 0.65)')
  assert.deepEqual(tiers, [{ name: '按次', body: '0.65' }])
})

test('parseTiers 遇到残缺表达式返回已解析的部分，不抛', () => {
  assert.deepEqual(parseTiers('tier("x", p*2'), [])
  assert.deepEqual(parseTiers(''), [])
  assert.deepEqual(parseTiers(null), [])
})

test('chatCoeffs 不会把 cr / cc / cc1h 里的 c 当成输出系数', () => {
  const co = chatCoeffs('p*3 + c*15 + cr*0.3 + cc*3.75 + cc1h*6')
  assert.equal(co.input, 3)
  assert.equal(co.output, 15)
  assert.equal(co.cacheRead, 0.3)
  assert.equal(co.cacheWrite, 3.75)
  assert.equal(co.cacheWrite1h, 6)
})

test('chatCoeffs：c 在 cr / cc 之后时也要取对（真实站点 gpt-6-sol 的形状）', () => {
  // 站点原文：p*2 + cr*0.2 + cc*2.5 + c*10
  // 只有左侧断言时，`c` 会先命中 cr 里的 c，输出系数被读成 1，
  // 显示成「输出 $0.16/M 比输入 $0.32/M 便宜」——一眼就不对。
  const co = chatCoeffs('p*2 + cr*0.2 + cc*2.5 + c*10')
  assert.equal(co.input, 2)
  assert.equal(co.cacheRead, 0.2)
  assert.equal(co.cacheWrite, 2.5)
  assert.equal(co.output, 10, '输出系数必须是 10，不是 1')
})

test('chatCoeffs：cc1h 不能被读成 cc', () => {
  const co = chatCoeffs('p*1 + cc1h*6')
  assert.equal(co.cacheWrite, undefined, 'cc 不该从 cc1h 里被匹配出来')
  assert.equal(co.cacheWrite1h, 6)
})

test('chatCoeffs：p 不能从 param / 别的词里被匹配出来', () => {
  const co = chatCoeffs('param("service_tier") * p*3 + c*9')
  assert.equal(co.input, 3, 'p 只能匹配独立的 p')
  assert.equal(co.output, 9)
})

test('chatCoeffs 把裸变量当成系数 1', () => {
  const co = chatCoeffs('p + c*2')
  assert.equal(co.input, 1)
  assert.equal(co.output, 2)
})

test('chatCoeffs 没有系数时返回 null', () => {
  assert.equal(chatCoeffs('0.65'), null)
  assert.equal(chatCoeffs('u("seconds") * 0.45'), null)
})

test('usagePrices 取出用量变量与单价区间', () => {
  const expr = 'u("resolution") == "480p" ? tier("480p", u("seconds") * 0.14) : tier("1080p", u("seconds") * 1.0)'
  const u = usagePrices(expr)
  assert.ok(u.seconds)
  assert.equal(u.seconds.min, 0.14)
  assert.equal(u.seconds.max, 1.0)
})

test('usagePrices 处理多个用量变量', () => {
  const u = usagePrices('u("seconds") * 0.49 + u("reference_video_seconds") * 0.49')
  assert.equal(u.seconds.min, 0.49)
  assert.equal(u.reference_video_seconds.min, 0.49)
})

test('priceOf：倍率计费按 1 倍率 = 2 美元/百万 token 折算', () => {
  const row = { quota_type: 0, model_ratio: 1, completion_ratio: 5, cache_ratio: 0.1 }
  const p = priceOf(row, 1, CUR)
  assert.equal(p.kind, 'ratio')
  assert.equal(p.input, '$2.00/M')
  assert.equal(p.output, '$10.00/M')
  assert.equal(p.cache, '$0.20/M')
})

test('priceOf：倍率计费要乘分组倍率', () => {
  const row = { quota_type: 0, model_ratio: 1, completion_ratio: 5, cache_ratio: 0.1 }
  const p = priceOf(row, 0.1, CUR)
  assert.equal(p.input, '$0.20/M')
  assert.equal(p.output, '$1.00/M')
})

test('priceOf：表达式计费取第一档的 p / c 系数', () => {
  const row = {
    quota_type: 0,
    billing_mode: 'tiered_expr',
    billing_expr: 'len <= 272000 ? tier("short_context", p*2 + c*10) : tier("long_context", p*4 + c*20)',
  }
  const p = priceOf(row, 1, CUR)
  assert.equal(p.kind, 'tiered')
  assert.equal(p.input, '$2.00/M')
  assert.equal(p.output, '$10.00/M')
  // 多档时 note 要说清「上表是哪一档」，不能让用户以为那就是全部
  assert.match(p.note, /short_context/)
  assert.match(p.note, /2 档/)
})

test('priceOf：表达式解析不出来时明确说未知，不编价格', () => {
  const row = { quota_type: 0, billing_mode: 'tiered_expr', billing_expr: 'fixed(0.01)' }
  const p = priceOf(row, 1, CUR)
  assert.equal(p.kind, 'unknown')
  assert.equal(p.input, '价格未知')
  assert.ok(p.note.length > 0)
})

test('priceOf：按秒计费的视频给区间价，不给单值', () => {
  const row = {
    quota_type: 1,
    model_price: 0.45,
    billing_mode: 'tiered_expr',
    billing_expr: 'u("resolution") == "480p" ? tier("480p", u("seconds") * 0.14) : tier("1080p", u("seconds") * 1.0)',
    billing_usage_schema: { resolution: { enum: ['480p', '720p', '1080p'] } },
  }
  const p = priceOf(row, 1, CUR)
  assert.equal(p.kind, 'percall')
  assert.match(p.input, /0\.1400/)
  assert.match(p.input, /1\.0000/)
  assert.match(p.input, /秒/)
  assert.match(p.note, /分辨率/)
})

test('priceOf：纯按次模型给「/次」', () => {
  const row = { quota_type: 1, model_price: 0.65, billing_mode: 'tiered_expr', billing_expr: 'tier("按次", 0.65)' }
  const p = priceOf(row, 1, CUR)
  assert.equal(p.kind, 'percall')
  assert.equal(p.input, '$0.65/次')
})

test('priceOf：按次但站点没给单价时不说成 0', () => {
  const row = { quota_type: 1, model_price: 0 }
  const p = priceOf(row, 1, CUR)
  assert.equal(p.kind, 'unknown')
  assert.equal(p.input, '价格未知')
})

test('priceOf：完全没有计价规则时是 unknown', () => {
  const p = priceOf({}, 1, CUR)
  assert.equal(p.kind, 'unknown')
})

test('priceOf：币种符号跟随站点', () => {
  const cny = { symbol: '¥', per: 500000, rate: 1, code: 'CNY', display: true }
  const p = priceOf({ quota_type: 0, model_ratio: 1, completion_ratio: 2 }, 1, cny)
  assert.equal(p.input, '¥2.00/M')
})

test('billingOf 给出档位、用量变量与 schema', () => {
  const row = {
    quota_type: 1,
    billing_mode: 'tiered_expr',
    billing_expr: 'u("seconds") * 0.45',
    billing_usage_schema: { seconds: { type: 'number', unit: 'second' } },
    billing_usage_examples: [{ label: '720p 8s', facts: { seconds: 8 } }],
  }
  const b = billingOf(row, 1)
  assert.equal(b.mode, 'tiered_expr')
  assert.equal(b.usages.seconds.min, 0.45)
  assert.ok(b.schema.seconds)
  assert.equal(b.examples.length, 1)
})

// ── 详情页要「能读」：每档真实单价、服务档倍率、用量字段 ──────────────
//
// 之前的抽屉直接把 mode / tier(...) / 空数组倒出来，分档表的输入输出两列
// 读的是 tiers[].input（服务端从来没给过这个字段），所以永远显示「—」。
// 下面这些用例钉住「详情页拿到的是数字，不是表达式」。

test('billingOf：每档给出折好的单价，不是原始系数', () => {
  const row = {
    quota_type: 0,
    billing_mode: 'tiered_expr',
    billing_expr: 'len <= 272000 ? tier("short_context", p*2 + c*10 + cr*0.2) : tier("long_context", p*4 + c*20)',
  }
  const b = billingOf(row, 0.16, CUR)
  assert.equal(b.tiers.length, 2)
  // 0.2 × 0.16 = 0.032 → 两位小数不够看，走四位
  assert.equal(b.tiers[0].prices.input, '$0.32/M')
  assert.equal(b.tiers[0].prices.output, '$1.60/M')
  assert.equal(b.tiers[0].prices.cacheRead, '$0.03/M')
  assert.equal(b.tiers[1].prices.input, '$0.64/M')
  assert.equal(b.tiers[1].prices.cacheRead, undefined, '这档没有 cr，就不该给一个缓存价')
})

test('billingOf：把 service_tier 这类 param 倍率单独取出来', () => {
  const row = {
    quota_type: 0,
    billing_mode: 'tiered_expr',
    billing_expr: 'tier("standard", p * 0.2 + c * 1.2) * (param("service_tier") == "priority" ? 2 : 1) * (param("service_tier") == "ultrafast" ? 3 : 1)',
  }
  const b = billingOf(row, 1, CUR)
  assert.deepEqual(b.multipliers, [
    { param: 'service_tier', value: 'priority', factor: 2 },
    { param: 'service_tier', value: 'ultrafast', factor: 3 },
  ])
})

test('billingOf：用量字段带上站点给的中文名与单位', () => {
  const row = {
    quota_type: 1,
    billing_mode: 'tiered_expr',
    billing_expr: 'u("seconds") * 0.16',
    billing_usage_schema: {
      seconds: { type: 'number', unit: 'second', unitLabel: { en: 'second', zh: '秒' }, description: { en: 'Duration', zh: '时长' } },
    },
  }
  const b = billingOf(row, 1, CUR)
  assert.equal(b.usageRows.length, 1)
  assert.equal(b.usageRows[0].field, 'seconds')
  assert.equal(b.usageRows[0].label, '时长')
  assert.equal(b.usageRows[0].unit, '秒')
  assert.equal(b.usageRows[0].price, '$0.1600/秒')
})

test('billingOf：没有 cur 时也不抛，符号退回 $', () => {
  const b = billingOf({ quota_type: 0, model_ratio: 1 }, 1)
  assert.equal(b.groupRatio, 1)
  assert.equal(b.tiers.length, 0)
  assert.deepEqual(b.usageRows, [])
  assert.deepEqual(b.multipliers, [])
})

test('billingOf：站点只给英文 unit 时也翻成中文单位', () => {
  const row = {
    quota_type: 1,
    billing_mode: 'tiered_expr',
    billing_expr: 'u("seconds") * 0.16',
    billing_usage_schema: { seconds: { type: 'number', unit: 'second' } },
  }
  const b = billingOf(row, 1, CUR)
  assert.equal(b.usageRows[0].unit, '秒', 'second 应翻成「秒」，不能把英文单位直接甩给用户')
  assert.equal(b.usageRows[0].price, '$0.1600/秒')

  // 真实站点常见形态：只给 unitLabel.en，没有 zh。英文 unitLabel 不能盖过单位表。
  const row2 = {
    ...row,
    billing_usage_schema: { seconds: { type: 'number', unit: 'second', unitLabel: { en: 'second' } } },
  }
  assert.equal(billingOf(row2, 1, CUR).usageRows[0].unit, '秒', 'unitLabel.en 不该盖过中文单位表')
})
