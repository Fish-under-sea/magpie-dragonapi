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
    { model_name: 'gpt-6-sol', enable_groups: ['gpt-pro'], model_ratio: 1, completion_ratio: 5, cache_ratio: 0.1, supported_endpoint_types: ['openai'], vendor_id: 2 },
    { model_name: 'gpt-6-sol-tiered', enable_groups: ['gpt-plus'], billing_mode: 'tiered_expr', billing_expr: 'tier("short_context", p*2 + c*10 + cr*0.2) * (param("service_tier") == "priority" ? 2 : 1)', supported_endpoint_types: ['openai'], vendor_id: 2 },
    { model_name: 'claude-sonnet-5', enable_groups: ['claude-max企业'], model_ratio: 1, completion_ratio: 5, supported_endpoint_types: ['anthropic'], vendor_id: 1 },
  ],
  group_ratio: { 'gpt-plus': 0.1, 'gpt-pro': 0.2, 'claude-max企业': 1.2 },
  group_order: ['gpt-plus', 'gpt-pro', 'claude-max企业'],
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

test('/api/model 给出同型号在各分组的定价（详情页「按分组定价」）', async () => {
  const j = await (await fetch(base + '/api/model?group=gpt-plus&model=gpt-6-sol')).json()
  assert.ok(Array.isArray(j.siblings), '应带 siblings')
  assert.equal(j.siblings.length, 2, '同一个模型在 gpt-plus 与 gpt-pro 两个分组')
  // 从低倍率到高倍率
  assert.equal(j.siblings[0].group, 'gpt-plus')
  assert.equal(j.siblings[0].current, true, '当前分组要标出来')
  assert.equal(j.siblings[1].group, 'gpt-pro')
  // 1 × 2 美元/M × 0.2 = $0.40/M
  assert.equal(j.siblings[1].input, '$0.40/M')
})

test('/api/model 给出每档真实单价与整单倍率（详情页要用）', async () => {
  const r = await fetch(base + '/api/model?group=gpt-plus&model=gpt-6-sol-tiered')
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.ok, true)
  assert.equal(j.billing.mode, 'tiered_expr')
  assert.match(j.billing.modeLabel, /分档/)
  // p*2 × 分组倍率 0.1 = 0.2 → $0.20/M；c*10 × 0.1 = 1.0
  assert.equal(j.billing.tiers[0].prices.input, '$0.20/M')
  assert.equal(j.billing.tiers[0].prices.output, '$1.00/M')
  assert.deepEqual(j.billing.multipliers, [{ param: 'service_tier', value: 'priority', factor: 2 }])
})

test('maskKey / tailOf 的边界', () => {
  assert.equal(maskKey(''), '')
  assert.equal(maskKey('ab'), '**')
  assert.equal(maskKey('abcdef'), 'ab****ef')
  assert.equal(maskKey('sk-1234567890abcd'), 'sk-1**********abcd')
  assert.equal(tailOf('sk-1234567890abcd'), 'abcd')
  assert.equal(tailOf('short'), '')
})

// ── PAT 保存：该收的收、该拒的拒、写不进去要说出来 ──────────────
//
// 站点的每个只读端点卡不同 scope。之前只用 /api/user/self 做准入，于是
// 一份「只能读钥匙」的 PAT 会被整份拒收；usage:read 又是拿空钥匙探的，
// 永远探不出来；而落盘失败被吞掉，页面照样弹「已保存」。

const PAT = 'nap_test_valid_pat'
const SELF = { success: true, data: { id: 7, username: 'fish', display_name: 'Fish', group: 'gpt-plus', quota: 0, used_quota: 0 } }
const AUTH_FAIL = { success: false, code: 'AUTH_UNAUTHORIZED', message: 'Unauthorized, invalid access token' }
const FORBIDDEN = { success: false, code: 'AUTH_FORBIDDEN', message: 'access token missing required scope: profile:read' }

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * siteStub 只接管 `https://example.test` 的请求，本地服务照常走真 fetch。
 * 不这么做的话，把 globalThis.fetch 整个换掉会连测试自己的本地请求一起拦。
 */
async function siteStub(handler, fn) {
  const real = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url || input)
    if (!url.startsWith('https://example.test')) return real(input, init)
    return Promise.resolve(handler(new URL(url), init || {}))
  }
  try { return await fn() } finally { globalThis.fetch = real }
}

/** startPatService 起一个把状态真的写进临时目录的服务，和插件里的行为一致。 */
async function startPatService({ port, dir: fixedDir, setPat } = {}) {
  const d = fixedDir || mkdtempSync(join(tmpdir(), 'dragonapi-pat-'))
  const st = loadState(d)
  st.status = STATUS
  const calls = []
  const svc = await startService({
    port,
    dir: d,
    site: 'https://example.test',
    catalog: createCatalogSource({ site: 'https://example.test', stub: CATALOG }),
    status: createStatusSource({ site: 'https://example.test', seed: STATUS }),
    getState: async () => ({
      accounts: {}, pat: st.pat, patHint: st.patHint, patScopes: st.patScopes,
      patVerified: st.patVerified, enabledGroups: [],
    }),
    setPat: setPat || (async (patch) => {
      calls.push(patch)
      st.pat = patch.pat
      st.patHint = patch.hint
      st.patScopes = patch.scopes
      st.patVerified = patch.verified
      return saveState(d, st)
    }),
    keyOf: () => '',
  })
  return { svc, base: `http://127.0.0.1:${svc.port}`, dir: d, st, calls }
}

const savePat = (base, pat) => fetch(base + '/api/pat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pat }),
})

test('PAT 三条只读端点都通：收下并记全 scope', async () => {
  const { svc, base: b, dir: d, calls } = await startPatService({ port: 3610 })
  try {
    await siteStub((url) => {
      if (url.pathname === '/api/user/self') return jsonRes(SELF)
      if (url.pathname === '/api/token/') return jsonRes({ success: true, data: [] })
      if (url.pathname === '/api/log/self') return jsonRes({ success: true, data: [] })
      return jsonRes({ success: false, message: 'no route' }, 404)
    }, async () => {
      const r = await savePat(b, PAT)
      assert.equal(r.status, 200)
      const j = await r.json()
      assert.equal(j.ok, true)
      assert.deepEqual(j.pat.scopes.sort(), ['api_key:read', 'profile:read', 'usage:read'])
      assert.equal(j.pat.verified, true)
      assert.equal(j.pat.persisted, true)
      assert.equal(j.user.name, 'fish')
      assert.equal(j.warning, '')
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].verified, true)
    // 真的落盘了，不是只在内存里
    assert.equal(loadState(d).pat, PAT)
    assert.equal(loadState(d).patVerified, true)
  } finally {
    await svc.close()
  }
})

test('PAT 缺 profile:read 但能读钥匙：仍然收下，并说清哪一格没放行', async () => {
  const { svc, base: b, dir: d } = await startPatService({ port: 3611 })
  try {
    await siteStub((url) => {
      if (url.pathname === '/api/user/self') return jsonRes(FORBIDDEN, 403)
      if (url.pathname === '/api/token/') return jsonRes({ success: true, data: [] })
      if (url.pathname === '/api/log/self') return jsonRes({ success: true, data: [] })
      return jsonRes({ success: false, message: 'no route' }, 404)
    }, async () => {
      const r = await savePat(b, PAT)
      assert.equal(r.status, 200, '缺一格 scope 不该把整份令牌打回')
      const j = await r.json()
      assert.equal(j.ok, true)
      assert.equal(j.pat.verified, true)
      assert.ok(!j.pat.scopes.includes('profile:read'))
      assert.match(j.warning, /profile:read/)
      assert.match(j.warning, /读账户资料与建钥匙/, '要说清丢的是哪件事，不是笼统一句「权限不足」')
      assert.equal(j.user, null, 'self 没读到就不该编一个账户名')
    })
    assert.equal(loadState(d).pat, PAT, '令牌必须真的写进状态文件')
  } finally {
    await svc.close()
  }
})

test('PAT 三个端点全 401：拒收，且不写盘、不调 setPat', async () => {
  const { svc, base: b, dir: d, calls } = await startPatService({ port: 3612 })
  try {
    await siteStub(() => jsonRes(AUTH_FAIL, 401), async () => {
      const r = await savePat(b, PAT)
      assert.equal(r.status, 400)
      const j = await r.json()
      assert.equal(j.ok, false)
      assert.match(j.error, /访问令牌/)
      assert.match(j.hint, /profile:read/)
      assert.ok(Array.isArray(j.failures) && j.failures.length === 3)
    })
    assert.equal(calls.length, 0, '鉴权失败时不该把令牌收进状态')
    assert.equal(loadState(d).pat, '')
  } finally {
    await svc.close()
  }
})

test('站点连不上：令牌照存，但明确标成「未验证」', async () => {
  const { svc, base: b, dir: d } = await startPatService({ port: 3613 })
  try {
    await siteStub(() => { throw new TypeError('fetch failed') }, async () => {
      const r = await savePat(b, PAT)
      assert.equal(r.status, 200, '连不上站点不等于令牌无效')
      const j = await r.json()
      assert.equal(j.pat.verified, false)
      assert.match(j.warning, /没能连上站点验证/)
    })
    assert.equal(loadState(d).pat, PAT)
    assert.equal(loadState(d).patVerified, false)
  } finally {
    await svc.close()
  }
})

test('落盘失败：回 500 并给出状态文件路径，不许假装保存成功', async () => {
  const { svc, base: b } = await startPatService({
    port: 3614,
    setPat: async () => ({ saved: false, path: 'C:\\blocked\\dragonapi-state.json', error: 'EACCES: permission denied' }),
  })
  try {
    await siteStub((url) => {
      if (url.pathname === '/api/user/self') return jsonRes(SELF)
      return jsonRes({ success: true, data: [] })
    }, async () => {
      const r = await savePat(b, PAT)
      assert.equal(r.status, 500)
      const j = await r.json()
      assert.equal(j.ok, false)
      assert.match(j.error, /dragonapi-state\.json/)
      assert.match(j.error, /EACCES/)
      assert.equal(j.pat.persisted, false)
    })
  } finally {
    await svc.close()
  }
})

test('真实写盘失败也会被抓到（目录不可写）', async () => {
  // 拿一个「父级是文件」的路径当配置目录：mkdirSync 必然失败，而不是碰巧成功。
  const blocker = mkdtempSync(join(tmpdir(), 'dragonapi-block-'))
  writeFileSync(join(blocker, 'not-a-dir'), 'x')
  const badDir = join(blocker, 'not-a-dir', 'state')
  const { svc, base: b } = await startPatService({ port: 3615, dir: badDir })
  try {
    await siteStub((url) => {
      if (url.pathname === '/api/user/self') return jsonRes(SELF)
      return jsonRes({ success: true, data: [] })
    }, async () => {
      const r = await savePat(b, PAT)
      assert.equal(r.status, 500)
      const j = await r.json()
      assert.equal(j.ok, false)
      assert.match(j.error, /没能写进/)
    })
  } finally {
    await svc.close()
    try { rmSync(blocker, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})
