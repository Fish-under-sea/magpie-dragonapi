// 刷新链路的回归测试：`GET /api/catalog?refresh=1` 必须真的穿透到拉取。
//
// 这是修过的一个真实 bug 的护栏：之前 service.mjs 自己缓存一份目录，
// 刷新回调刷的是 index.mjs 那份，「页面点刷新」按钮点了没有任何效果。
// 现在目录只有一份（catalog-source），服务直接让它 force，所以这个用例
// 断言的是「服务收到的目录就是源里那一份，且 force 真的发起了请求」。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startService } from '../lib/service.mjs'
import { createCatalogSource } from '../lib/catalog-source.mjs'
import { createStatusSource } from '../lib/status-source.mjs'

let dir
let svc
let base
let calls

const STATUS = {
  siteName: 'DragonAPI',
  quotaPerUnit: 500000,
  displayType: 'USD',
  displayInCurrency: true,
  usdExchangeRate: 1,
  customSymbol: '¤',
  customRate: 1,
}

/** 每次被调用都换一个 pricing_version，用来分辨「拿到的是不是新的那份」。 */
function pricingFor(n) {
  return {
    notModified: false,
    env: {
      data: [{ model_name: 'm' + n, enable_groups: ['g'], model_ratio: 1, completion_ratio: 2, supported_endpoint_types: ['openai'] }],
      group_ratio: { g: 1 },
      group_order: ['g'],
      vendors: [],
      pricing_version: 'v' + n,
    },
    etag: '"e' + n + '"',
    lastModified: 'L' + n,
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dragonapi-refresh-'))
  calls = 0
  const catalog = createCatalogSource({
    site: 'https://example.test',
    fetchPricing: async () => {
      calls += 1
      return pricingFor(calls)
    },
  })
  const status = createStatusSource({ site: 'https://example.test', seed: STATUS })
  svc = await startService({
    port: 3596,
    dir,
    site: 'https://example.test',
    catalog,
    status,
    getState: async () => ({ accounts: {}, pat: '', patHint: '', patScopes: [], enabledGroups: [] }),
    setPat: async () => {},
    keyOf: () => '',
  })
  base = `http://127.0.0.1:${svc.port}`
})

after(async () => {
  await svc?.close()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

test('首次取目录会拉一次站点', async () => {
  const j = await (await fetch(base + '/api/catalog')).json()
  assert.equal(j.ok, true)
  assert.equal(calls, 1)
  assert.equal(j.version, 'v1')
})

test('不带 refresh 的第二次请求走缓存，不重复拉', async () => {
  const before = calls
  const j = await (await fetch(base + '/api/catalog')).json()
  assert.equal(calls, before, 'TTL 内不该再打站点')
  assert.equal(j.version, 'v1')
})

test('refresh=1 真的穿透到拉取，并拿到新版本 —— 这就是刷新按钮的链路', async () => {
  const before = calls
  const j = await (await fetch(base + '/api/catalog?refresh=1')).json()
  assert.equal(calls, before + 1, 'refresh=1 必须真的发起请求')
  assert.equal(j.version, 'v2', '必须拿到新拉的那一份，而不是旧缓存')
  assert.equal(j.models[0].name, 'm2')
})

test('再点一次刷新，版本继续前进', async () => {
  const j = await (await fetch(base + '/api/catalog?refresh=1')).json()
  assert.equal(j.version, 'v3')
})

test('/api/state 与 /api/catalog 看的是同一份目录', async () => {
  const [st, cat] = await Promise.all([
    fetch(base + '/api/state').then((r) => r.json()),
    fetch(base + '/api/catalog').then((r) => r.json()),
  ])
  assert.equal(st.counts.models, cat.counts.models)
  assert.equal(st.counts.rows, cat.counts.rows)
  assert.equal(st.catalogAt, cat.at)
})

test('/api/health 报的是目录源的真实记录', async () => {
  const j = await (await fetch(base + '/api/health')).json()
  assert.equal(j.ok, true)
  assert.ok(Array.isArray(j.recent))
  assert.ok(j.recent.length >= 3, '应该有多次拉取记录')
  assert.equal(j.recent[0].ok, true)
})
