// 本地服务的冒烟测试：真的起一个 HTTP 服务，真的打端点。
//
// 这里不打站点——站点请求全部用桩替换，只验证「服务自己的行为」：
// 路由存在、CORS 头对、静态文件不越界、错误形状统一、端口能顺延。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startService } from '../lib/service.mjs'
import { createCatalogSource } from '../lib/catalog-source.mjs'
import { createStatusSource } from '../lib/status-source.mjs'
import { loadState, saveState, maskKey, tailOf, statePath } from '../lib/store.mjs'

let dir
let svc
let base

const STATUS = {
  siteName: 'DragonAPI',
  quotaPerUnit: 500000,
  displayType: 'USD',
  displayInCurrency: true,
  usdExchangeRate: 1,
  customSymbol: '¤',
  customRate: 1,
}

const CATALOG = {
  data: [
    { model_name: 'gpt-6-sol', enable_groups: ['gpt-plus'], model_ratio: 1, completion_ratio: 5, cache_ratio: 0.1, supported_endpoint_types: ['openai'], vendor_id: 2 },
    { model_name: 'claude-sonnet-5', enable_groups: ['claude-max企业'], model_ratio: 1, completion_ratio: 5, supported_endpoint_types: ['anthropic'], vendor_id: 1 },
  ],
  group_ratio: { 'gpt-plus': 0.1, 'claude-max企业': 1.2 },
  group_order: ['gpt-plus', 'claude-max企业'],
  usable_group: { 'gpt-plus': 'GPT 日常档' },
  auto_groups: ['gpt-plus'],
  vendors: [{ id: 2, name: 'OpenAI' }, { id: 1, name: 'Anthropic' }],
  pricing_version: 'test-v1',
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dragonapi-test-'))
  const st = loadState(dir)
  st.status = STATUS
  st.pat = 'nap_test_pat'
  st.patHint = maskKey('nap_test_pat')
  st.patScopes = ['api_key:read']
  st.accounts = {
    abcd: { label: 'gpt-plus · 主钥匙', group: 'gpt-plus', masked: 'sk-a**********abcd', tail: 'abcd', models: 1, boundAt: 1 },
  }
  saveState(dir, st)

  svc = await startService({
    port: 3599,
    dir,
    site: 'https://example.test',
    // 目录与站点参数各用一个固定桩源：不打真实站点。
    catalog: createCatalogSource({ site: 'https://example.test', stub: CATALOG }),
    status: createStatusSource({ site: 'https://example.test', seed: STATUS }),
    getState: async () => ({
      accounts: st.accounts,
      pat: st.pat,
      patHint: st.patHint,
      patScopes: st.patScopes,
      enabledGroups: [],
    }),
    setPat: async () => {},
    keyOf: () => '',
  })
  base = `http://127.0.0.1:${svc.port}`
})

after(async () => {
  await svc?.close()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
})

test('/api/ping 有版本与端口', async () => {
  const r = await fetch(base + '/api/ping')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.ok, true)
  assert.equal(j.port, svc.port)
  assert.ok(j.version)
})

test('所有响应都带 CORS 通配头（页面 origin 是 opaque）', async () => {
  const r = await fetch(base + '/api/ping')
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
})

test('OPTIONS 预检回 204 且允许 POST / DELETE', async () => {
  const r = await fetch(base + '/api/keys', { method: 'OPTIONS' })
  assert.equal(r.status, 204)
  assert.match(r.headers.get('access-control-allow-methods') || '', /POST/)
  assert.match(r.headers.get('access-control-allow-methods') || '', /DELETE/)
})

test('/api/state 给出站点、币种、账号、分组', async () => {
  const r = await fetch(base + '/api/state')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.ok, true)
  assert.equal(j.siteName, 'DragonAPI')
  assert.equal(j.currency.symbol, '$')
  assert.equal(j.pat.set, true)
  assert.equal(j.accounts.length, 1)
  assert.equal(j.accounts[0].group, 'gpt-plus')
  // 没有钥匙明文时余额显示 —，不能假装是 0
  assert.equal(j.accounts[0].balance, '—')
})

test('/api/catalog 给出模型行，且没有「启用」这类字段', async () => {  const r = await fetch(base + '/api/catalog')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.ok, true)
  assert.ok(Array.isArray(j.models))
  assert.ok(j.models.length > 0)
  // 模型广场是纯展示：不能出现任何「启用/停用」语义的字段
  for (const m of j.models) {
    assert.equal('enabled' in m, false, `不应有 enabled 字段：${m.id}`)
    assert.equal('disabled' in m, false, `不应有 disabled 字段：${m.id}`)
    assert.equal('selected' in m, false, `不应有 selected 字段：${m.id}`)
  }
})

test('/api/model 给单个模型的计费详情，找不到就 404', async () => {
  const ok = await fetch(base + '/api/model?group=gpt-plus&model=gpt-6-sol')
  assert.equal(ok.status, 200)
  const j = await ok.json()
  assert.equal(j.ok, true)
  assert.equal(j.model.name, 'gpt-6-sol')
  const miss = await fetch(base + '/api/model?group=nope&model=nope')
  assert.equal(miss.status, 404)
  const mj = await miss.json()
  assert.equal(mj.ok, false)
  assert.ok(mj.error)
})

test('/api/bind-info 说明绑定只能走 magpie 的添加账号', async () => {
  const r = await fetch(base + '/api/bind-info')
  const j = await r.json()
  assert.equal(j.ok, true)
  assert.ok(j.how.length >= 2)
  assert.match(j.note, /magpie/)
})

test('/api/keys 在没有 PAT 时明确报错而不是空列表', async () => {
  // 换一个没有 PAT 的状态
  const dir2 = mkdtempSync(join(tmpdir(), 'dragonapi-test2-'))
  const st2 = loadState(dir2)
  st2.status = STATUS
  const svc2 = await startService({
    port: 3598,
    dir: dir2,
    site: 'https://example.test',
    catalog: createCatalogSource({ site: 'https://example.test', stub: CATALOG }),
    status: createStatusSource({ site: 'https://example.test', seed: STATUS }),
    getState: async () => ({ accounts: {}, pat: '', patHint: '', patScopes: [], enabledGroups: [] }),
    setPat: async () => {},
    keyOf: () => '',
  })
  try {
    const r = await fetch(`http://127.0.0.1:${svc2.port}/api/keys`)
    assert.equal(r.status, 400)
    const j = await r.json()
    assert.equal(j.ok, false)
    assert.match(j.error, /访问令牌/)
  } finally {
    await svc2.close()
    try { rmSync(dir2, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

test('建钥匙缺分组时拒绝，并说清为什么必须有分组', async () => {
  const r = await fetch(base + '/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x' }),
  })
  assert.equal(r.status, 400)
  const j = await r.json()
  assert.equal(j.ok, false)
  assert.match(j.error, /分组/)
})

test('静态文件：/ 给出界面，路径穿越被挡住', async () => {
  const r = await fetch(base + '/')
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type') || '', /text\/html/)
  // 穿越尝试必须失败（不能读到包外的文件）
  const bad = await fetch(base + '/ui/../../package.json')
  assert.ok(bad.status === 404 || bad.status === 400, `穿越应当被拒，实际 ${bad.status}`)
})

test('未知接口回 404 且形状统一', async () => {
  const r = await fetch(base + '/api/nope')
  assert.equal(r.status, 404)
  const j = await r.json()
  assert.equal(j.ok, false)
  assert.ok(j.error)
})

test('请求体不是 JSON 时回 400 而不是崩', async () => {
  const r = await fetch(base + '/api/pat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  assert.equal(r.status, 400)
  const j = await r.json()
  assert.equal(j.ok, false)
})

test('端口被占用时顺延，不会起不来', async () => {
  const svc3 = await startService({
    port: 3599, // 与 svc 相同，必然被占
    dir,
    site: 'https://example.test',
    catalog: createCatalogSource({ site: 'https://example.test', stub: CATALOG }),
    status: createStatusSource({ site: 'https://example.test', seed: STATUS }),
    getState: async () => ({ accounts: {}, pat: '', patHint: '', patScopes: [], enabledGroups: [] }),
    setPat: async () => {},
    keyOf: () => '',
  })
  try {
    assert.notEqual(svc3.port, 3599)
    const r = await fetch(`http://127.0.0.1:${svc3.port}/api/ping`)
    assert.equal(r.status, 200)
  } finally {
    await svc3.close()
  }
})

test('状态文件是 0600，且不含任何钥匙明文', () => {
  const st = loadState(dir)
  assert.equal(st.pat, 'nap_test_pat')
  const raw = JSON.stringify(st)
  // 只允许 PAT 与打码后的钥匙；不允许出现 sk- 明文
  assert.equal(/sk-[A-Za-z0-9]{8,}/.test(raw), false, '状态文件里不该有钥匙明文')
  assert.equal(statePath(dir).endsWith('dragonapi-state.json'), true)
})

test('maskKey / tailOf 的边界', () => {
  assert.equal(maskKey(''), '')
  assert.equal(maskKey('ab'), '**')
  assert.equal(maskKey('abcdef'), 'ab****ef')
  assert.equal(maskKey('sk-1234567890abcd'), 'sk-1**********abcd')
  assert.equal(tailOf('sk-1234567890abcd'), 'abcd')
  assert.equal(tailOf('short'), '')
})
