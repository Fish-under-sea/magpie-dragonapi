// 插件入口的契约测试：完全按宿主的调用方式走一遍。
//
// 这些用例守的是一类最致命的 bug：插件「能加载」但返回空表。宿主拿不到
// 模型就判定「这个供应商没有模型」，插件根本不出现——而且因为 provider.models
// 里的 catch 会兜住异常，日志里什么都没有，只能靠这种按宿主方式的调用来发现。
//
// 曾经真的发生过：lastGood 声明在 makeContext 里，provider.models 引用它时
// 抛 ReferenceError，被 catch 吞成空表，插件显示 0 个模型。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import dragonapi from '../index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
let dir
let plugin
let bad

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dragonapi-entry-'))
  // 用真目录桩，不打站点：入口测试关心的是形状与作用域，不是网络。
  const env = JSON.parse(readFileSync(join(here, '..', '证据-站点定价快照-2026-11-10.json'), 'utf8'))
  plugin = await dragonapi({ directory: dir }, { port: 3631, site: 'https://example.test', catalogStub: env })

  // 一个必然在 buildCatalog 里炸的目录源：data 的 getter 直接抛。
  bad = await dragonapi({ directory: dir }, {
    port: 3632,
    site: 'https://example.test',
    catalogStub: { get data() { throw new Error('故意炸') } },
  })
})

after(async () => {
  // 必须关掉本地服务，否则监听端口让事件循环不退出，node --test 会挂住
  await plugin?.dispose()
  await bad?.dispose()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

// magpie 的插件宿主会把 index.mjs 的**每一个命名导出**当成一个 hook 调用。
// 曾经这里导出了一个没人用的 `keyForTail(ctx, tail)`，宿主拿插件上下文去调它，
// 于是每次加载都报 `TypeError: undefined is not an object (evaluating 'ctx.secrets.get')`，
// 供应商那一行直接显示 failed。这个测试把「只导出默认工厂」钉住。
test('index.mjs 只导出默认插件工厂，不要有其它命名导出', async () => {
  const mod = await import('../index.mjs')
  assert.deepEqual(Object.keys(mod).sort(), ['default'], `多余的命名导出会被宿主当 hook 调用：${Object.keys(mod).join(', ')}`)
})

test('入口返回 config / auth / provider 三块', () => {
  for (const k of ['config', 'auth', 'provider']) {
    assert.ok(k in plugin, `缺少 ${k}`)
  }
  assert.equal(typeof plugin.config, 'function')
  assert.equal(typeof plugin.auth, 'object')
  assert.equal(typeof plugin.provider, 'object')
})

test('auth.provider 与 provider.id 一致', () => {
  assert.equal(plugin.auth.provider, 'dragonapi')
  assert.equal(plugin.provider.id, 'dragonapi')
})

test('auth.methods 至少有一条 api 登录，且 key 提示与校验都在', () => {
  const methods = plugin.auth.methods
  assert.ok(methods.length >= 1)
  const api = methods.find((m) => m.type === 'api')
  assert.ok(api, '必须有一条 type=api 的登录方式')
  const hint = api.placeholder || (api.prompts || []).find((p) => p.key === 'key')?.placeholder || ''
  assert.match(String(hint), /sk-/, '钥匙输入框要提示 sk- 前缀')
  assert.equal(typeof api.authorize, 'function', '手动钥匙必须先 authorize 校验，不能直接存')
})

test('auth.icon 能从包目录读到品牌图标，不是灰方块', () => {
  const icon = plugin.auth.icon
  assert.match(icon, /^data:image\/png;base64,/, '供应商图标必须是 png data URI')
  assert.ok(icon.length > 1000, '图标内容为空会让宿主显示灰方块')
})

test('手动钥匙 authorize 空 key 直接拒绝，不会存成账号', async () => {
  const api = plugin.auth.methods.find((m) => m.type === 'api')
  await assert.rejects(() => api.authorize({}), /请填写|钥匙/)
})

test('手动钥匙 authorize 验证站点并只记下 /v1/models 给的模型', async () => {
  const api = plugin.auth.methods.find((m) => m.type === 'api')
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/api/usage/token/')) {
      return new Response(JSON.stringify({ success: true, data: { name: 'key', total_available: 1, total_used: 0, unlimited_quota: true } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.includes('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'gpt-6-sol' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(url)
  }
  try {
    const r = await api.authorize({ key: 'sk-' + 'e'.repeat(48) })
    assert.equal(r.type, 'success')
    assert.deepEqual(r.metadata.allowed, ['gpt-6-sol'])
    assert.equal(r.metadata.modelCount, 1)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('config 声明了供应商名、npm 与 base', async () => {
  const cfg = {}
  await plugin.config(cfg)
  const p = cfg.provider.dragonapi
  assert.ok(p, 'config 必须声明 dragonapi')
  assert.equal(p.name, 'DragonAPI', '供应商列表显示产品名；包名留给插件管理器')
  assert.ok(p.npm, '必须给 npm 方言')
  assert.match(p.api, /\/v1$/, 'base 要以 /v1 结尾')
})

test('config 不声明空 models（会被理解成 0 个模型）', async () => {
  const cfg = {}
  await plugin.config(cfg)
  assert.equal('models' in cfg.provider.dragonapi, false, 'config 里不该出现 models 键')
})

test('provider.models 无账号时返回全量目录，绝不是空表', async () => {
  const models = await plugin.provider.models({}, {})
  const ids = Object.keys(models)
  assert.ok(ids.length > 100, `模型数太少：${ids.length}（空表说明插件装上会显示 0 个模型）`)
  assert.equal(ids.length, 195)
})

test('provider.models 有账号时只给该分组的模型', async () => {
  const key = 'sk-' + 'a'.repeat(48)
  const models = await plugin.provider.models({}, { auth: { key, metadata: { group: 'gpt-plus' } } })
  const ids = Object.keys(models)
  assert.ok(ids.length > 0, 'gpt-plus 账号拿不到模型')
  assert.equal(ids.every((id) => id.startsWith('gpt-plus/')), true, '不能混入别的分组')
  assert.equal(ids.length, 5)
})

test('手动钥匙有 allowed 时只给该钥匙的模型，不摊整组目录', async () => {
  const key = 'sk-' + 'd'.repeat(48)
  const models = await plugin.provider.models({}, {
    auth: { key, metadata: { group: 'gpt-plus', allowed: ['gpt-6-sol'] } },
  })
  assert.deepEqual(Object.keys(models), ['gpt-plus/gpt-6-sol'])
})

test('模型形状符合宿主预期：id / name / api.id / api.url', async () => {
  const models = await plugin.provider.models({}, {})
  const one = models['gpt-plus/gpt-6-sol']
  assert.ok(one, '缺少 gpt-plus/gpt-6-sol')
  assert.equal(one.id, 'gpt-plus/gpt-6-sol')
  assert.ok(one.name)
  // api.id 必须是站点认的裸模型名，否则请求会被站点拒
  assert.equal(one.api.id, 'gpt-6-sol')
  assert.match(one.api.url, /\/v1$/)
  assert.ok(one.api.npm)
})

test('对话模型带 reasoning 与 variants，功能模型带 kind', async () => {
  const models = await plugin.provider.models({}, {})
  const chat = models['gpt-plus/gpt-6-sol']
  assert.equal(chat.capabilities.reasoning, true)
  assert.ok(chat.variants)
  const video = Object.values(models).find((m) => m.kind === 'video')
  assert.ok(video, '应该有视频模型')
  assert.equal(video.capabilities.output.video, true)
})

test('loader 给出 baseURL 与钥匙，且把「分组/模型」还原成裸模型名', async () => {
  const key = 'sk-' + 'b'.repeat(48)
  const loader = await plugin.auth.loader(async () => ({ key, metadata: { group: 'gpt-plus' } }))
  // 不设全局 base：每个模型用自己的 api.url / 协议
  assert.equal(loader.baseURL, undefined)
  assert.equal(loader.apiKey, key)
  assert.equal(typeof loader.fetch, 'function')

  // 拦下真实 fetch，检查发出去的 body 里模型名被还原了
  let sent = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body)
    return new Response('{}', { status: 200 })
  }
  try {
    await loader.fetch('https://example.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-plus/gpt-6-sol', messages: [] }),
    })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(sent.model, 'gpt-6-sol', '发出去的必须是裸模型名，否则站点不认')
})

test('loader 不动没有分组前缀的模型名', async () => {
  const loader = await plugin.auth.loader(async () => ({ key: 'sk-x', metadata: {} }))
  let sent = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body)
    return new Response('{}', { status: 200 })
  }
  try {
    await loader.fetch('https://example.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'plain-model', messages: [] }),
    })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(sent.model, 'plain-model')
})

test('usage 在没有可用钥匙时报错，而不是返回假余额', async () => {
  await assert.rejects(
    () => plugin.auth.usage(async () => ({ key: 'sk-' + 'c'.repeat(48), metadata: {} })),
    (err) => {
      // 假钥匙打真站点会 401；这里只要求「报错」，不能静默返回 0 余额
      assert.ok(err instanceof Error)
      return true
    },
  )
})

test('provider.models 出错时不抛、但也不静默（错误要记下来）', async () => {
  const models = await bad.provider.models({}, {})
  // 不抛（抛了宿主就掉供应商）
  assert.equal(typeof models, 'object')
  // 但错误要能查到
  assert.match(String(bad.__lastModelsError || ''), /故意/)
})

test('插件加载不等网络：站点挂住也必须立刻返回', async () => {
  // 守的是实际事故：宿主的插件加载有 20 秒上限（报错原文
  // "the plugin's load didn't finish in 20s"）。入口里一旦 await 站点请求，
  // 网络慢就让插件被判定加载失败——而服务其实已经起来了，页面也能开，
  // 因果关系极容易被看错。
  //
  // 这里造一个「只接受连接、永不响应」的服务器：若入口还 await 网络，
  // 这次调用会卡到 AbortSignal 超时（20 秒），测试必然超时失败。
  const net = await import('node:net')
  const silent = net.createServer(() => { /* 收下连接，什么都不回 */ })
  await new Promise((r) => silent.listen(0, '127.0.0.1', r))
  const port = silent.address().port

  const startedAt = Date.now()
  let slowPlugin = null
  try {
    slowPlugin = await dragonapi({ directory: dir }, {
      port: 3633,
      site: `http://127.0.0.1:${port}`,
    })
  } finally {
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 3000, `插件加载等了 ${elapsed}ms，说明还在等网络`)
    assert.ok(slowPlugin, '插件必须返回，哪怕站点不可达')
    assert.equal(typeof slowPlugin.provider.models, 'function')
    await slowPlugin.dispose()
    silent.close()
  }
})

test('loader 在 Gemini 协议的 URL 里也把「分组/模型」还原成裸模型名', async () => {
  const loader = await plugin.auth.loader(async () => ({ key: 'sk-x', metadata: { group: 'image' } }))
  let seen = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => { seen = String(url); return new Response('{}', { status: 200 }) }
  try {
    await loader.fetch('https://example.test/v1beta/models/image%2Fgemini-3-pro-image-preview:generateContent', {
      method: 'POST', body: JSON.stringify({ contents: [] }),
    })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.match(seen, /models\/gemini-3-pro-image-preview:generateContent/, `URL 里的分组前缀没去掉：${seen}`)
  assert.doesNotMatch(seen, /image%2F|image\//, '不许把分组名带进 URL')
})