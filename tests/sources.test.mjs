// 目录源与站点参数源的回归测试。
//
// 这两个源是为了修一个真实 bug 才抽出来的：之前 index.mjs 与 service.mjs
// 各缓存一份目录，「页面点刷新」刷的是另一份，按钮点了没用。所以这里最要紧
// 的用例是「force 真的能穿透到 fetch」和「服务看到的就是宿主看到的那一份」。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCatalogSource, DEFAULT_TTL } from '../lib/catalog-source.mjs'
import { createStatusSource } from '../lib/status-source.mjs'

/** 记一次调用的假拉取。 */
function spyFetch(result) {
  const calls = []
  const fn = async (site, opts) => {
    calls.push({ site, opts })
    if (typeof result === 'function') return result(opts, calls.length)
    return result
  }
  return { fn, calls }
}

const ENV = { data: [{ model_name: 'a' }], group_ratio: { g: 1 }, pricing_version: 'v1' }
const OK = { notModified: false, env: ENV, etag: '"e1"', lastModified: 'Mon, 10 Nov 2026 00:00:00 GMT' }

test('目录源：首次 get 会打站点，结果带 etag', async () => {
  const { fn, calls } = spyFetch(OK)
  const src = createCatalogSource({ site: 'https://x.test', fetchPricing: fn })
  const st = await src.get({})
  assert.equal(calls.length, 1)
  assert.equal(st.source, 'live')
  assert.equal(st.env.pricing_version, 'v1')
  assert.equal(st.etag, '"e1"')
})

test('目录源：TTL 内第二次 get 不打站点', async () => {
  const { fn, calls } = spyFetch(OK)
  const src = createCatalogSource({ site: 'https://x.test', fetchPricing: fn })
  await src.get({})
  await src.get({})
  assert.equal(calls.length, 1, 'TTL 内不该重复请求')
})

test('目录源：force 穿透 TTL，真的再打一次站点', async () => {
  const { fn, calls } = spyFetch(OK)
  const src = createCatalogSource({ site: 'https://x.test', fetchPricing: fn })
  await src.get({})
  await src.get({ force: true })
  assert.equal(calls.length, 2, 'force 必须真的发请求——这正是刷新按钮的链路')
})

test('目录源：TTL 内用条件请求；force 时不带条件头（要拿最新）', async () => {
  const { fn, calls } = spyFetch(OK)
  const src = createCatalogSource({ site: 'https://x.test', fetchPricing: fn })
  await src.get({})
  await src.get({ force: true })
  // force 时传空对象，条件头由 readPricing 决定不带
  assert.deepEqual(calls[1].opts, {})
})

test('目录源：304 只更新时间，保留原内容', async () => {
  const first = { notModified: false, env: ENV, etag: '"e1"', lastModified: 'L1' }
  let n = 0
  const src = createCatalogSource({
    site: 'https://x.test',
    fetchPricing: async () => (++n === 1 ? first : { notModified: true, etag: '"e1"', lastModified: 'L1' }),
  })
  const a = await src.get({})
  const b = await src.get({ force: true })
  assert.equal(b.env, a.env, '304 不该换掉内容')
  assert.equal(b.source, 'live')
  assert.equal(b.at >= a.at, true)
})

test('目录源：拉失败但有旧数据 → stale，且旧内容还在', async () => {
  let n = 0
  const src = createCatalogSource({
    site: 'https://x.test',
    fetchPricing: async () => {
      if (++n === 1) return OK
      throw new Error('网络断了')
    },
  })
  await src.get({})
  const st = await src.get({ force: true })
  assert.equal(st.source, 'stale')
  assert.match(st.error, /网络断了/)
  assert.equal(st.env.pricing_version, 'v1', '旧内容必须留着')
})

test('目录源：一次都没成功过 → empty，错误可读', async () => {
  const src = createCatalogSource({
    site: 'https://x.test',
    fetchPricing: async () => { throw new Error('DNS 挂了') },
  })
  const st = await src.get({})
  assert.equal(st.source, 'empty')
  assert.equal(st.env, null)
  assert.match(st.error, /DNS 挂了/)
})

test('目录源：健康记录留下每次拉取的结果', async () => {
  let n = 0
  const src = createCatalogSource({
    site: 'https://x.test',
    fetchPricing: async () => {
      if (++n === 1) return OK
      throw new Error('第二次失败')
    },
  })
  await src.get({})
  await src.get({ force: true })
  const recent = src.recent()
  assert.equal(recent.length, 2)
  // 最新在前
  assert.equal(recent[0].ok, false)
  assert.equal(recent[1].ok, true)
  assert.equal(recent[1].count, 1)
})

test('目录源：健康记录有上限，不会无限增长', async () => {
  const src = createCatalogSource({
    site: 'https://x.test',
    fetchPricing: async () => OK,
  })
  for (let i = 0; i < 20; i++) await src.get({ force: true })
  assert.ok(src.recent().length <= 12)
})

test('目录源：snapshot 不触发拉取', async () => {
  const { fn, calls } = spyFetch(OK)
  const src = createCatalogSource({ site: 'https://x.test', fetchPricing: fn })
  await src.get({})
  const before = calls.length
  src.snapshot()
  src.snapshot()
  assert.equal(calls.length, before)
})

test('目录源：桩模式完全不打站点', async () => {
  const { fn, calls } = spyFetch(OK)
  const src = createCatalogSource({ site: 'https://x.test', fetchPricing: fn, stub: ENV })
  const st = await src.get({ force: true })
  assert.equal(calls.length, 0)
  assert.equal(st.env, ENV)
  assert.equal(st.source, 'live')
})

test('目录源：默认 TTL 是五分钟', () => {
  assert.equal(DEFAULT_TTL, 5 * 60e3)
})

test('站点参数源：seed 先顶上，get 后换成实读值', async () => {
  const seed = { siteName: '旧值', quotaPerUnit: 500000 }
  const real = { siteName: '新值', quotaPerUnit: 500000 }
  const src = createStatusSource({ site: 'https://x.test', seed, fetchStatus: async () => real })
  assert.equal(src.snapshot().siteName, '旧值')
  const v = await src.get({})
  assert.equal(v.siteName, '新值')
})

test('站点参数源：读失败沿用上一次，不退回默认值', async () => {
  let n = 0
  const src = createStatusSource({
    site: 'https://x.test',
    seed: { quotaPerUnit: 500000, siteName: 'ok' },
    fetchStatus: async () => { throw new Error('断了') },
  })
  const v = await src.get({ force: true })
  // 关键：per 不能被退成 1，否则额度原值会被当金额，余额放大五十万倍
  assert.equal(v.quotaPerUnit, 500000)
  assert.equal(src.lastError(), '断了')
})

test('站点参数源：读到新值会回调（用来落盘）', async () => {
  const saved = []
  const src = createStatusSource({
    site: 'https://x.test',
    fetchStatus: async () => ({ siteName: 'x', quotaPerUnit: 1 }),
    onRead: (v) => saved.push(v),
  })
  await src.get({})
  assert.equal(saved.length, 1)
  assert.equal(saved[0].siteName, 'x')
})

test('站点参数源：TTL 内不重复请求', async () => {
  let n = 0
  const src = createStatusSource({
    site: 'https://x.test',
    fetchStatus: async () => { n++; return { quotaPerUnit: 500000 } },
  })
  await src.get({})
  await src.get({})
  assert.equal(n, 1)
  await src.get({ force: true })
  assert.equal(n, 2)
})
