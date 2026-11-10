// 端到端冒烟：真的起服务、真的加载界面、真的点一遍四个标签页。
//
// 用 Node 自带的 fetch 抓页面与静态资源，确认「服务能提供界面」这条链路
// 是通的。真正的浏览器渲染靠人眼，这里只钉住不该坏的东西。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startService } from '../lib/service.mjs'
import { createCatalogSource } from '../lib/catalog-source.mjs'
import { createStatusSource } from '../lib/status-source.mjs'
import { loadState, saveState, maskKey } from '../lib/store.mjs'

const here = dirname(fileURLToPath(import.meta.url))

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
    { model_name: 'seedance-2.0', enable_groups: ['视频'], quota_type: 1, model_price: 0.45, billing_mode: 'tiered_expr', billing_expr: 'u("seconds") * 0.45', supported_endpoint_types: ['视频任务'], vendor_id: 4 },
  ],
  group_ratio: { 'gpt-plus': 0.1, '视频': 1 },
  group_order: ['gpt-plus', '视频'],
  usable_group: { 'gpt-plus': 'GPT 日常档' },
  auto_groups: [],
  vendors: [{ id: 2, name: 'OpenAI' }, { id: 4, name: 'Google' }],
  pricing_version: 'e2e',
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dragonapi-e2e-'))
  const st = loadState(dir)
  st.status = STATUS
  st.pat = 'nap_e2e'
  st.patHint = maskKey('nap_e2e')
  st.accounts = { abcd: { label: 'gpt-plus', group: 'gpt-plus', masked: 'sk-a**********abcd', tail: 'abcd', models: 1, boundAt: 1 } }
  saveState(dir, st)
  svc = await startService({
    port: 3597,
    dir,
    site: 'https://example.test',
    catalog: createCatalogSource({ site: 'https://example.test', stub: CATALOG }),
    status: createStatusSource({ site: 'https://example.test', seed: STATUS }),
    getState: async () => ({ accounts: st.accounts, pat: st.pat, patHint: st.patHint, patScopes: [], enabledGroups: [] }),
    setPat: async () => {},
    keyOf: () => '',
  })
  base = `http://127.0.0.1:${svc.port}`
})

after(async () => {
  await svc?.close()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

test('界面首页能取到，且是完整的 HTML', async () => {
  const r = await fetch(base + '/')
  assert.equal(r.status, 200)
  const html = await r.text()
  assert.match(html, /<!doctype html>/i)
  assert.match(html, /DragonAPI/)
  assert.match(html, /app\.js/)
  assert.match(html, /style\.css/)
})

test('页面引用的每个资源都真的能取到（用页面自己的相对路径解析）', async () => {
  // 这条是补上的护栏：之前只测 /ui/app.js 能取到，但页面从 `/` 打开时
  // 浏览器请求的是 `/app.js`（相对路径），结果 CSS/JS 全 404，页面只剩
  // 一个巨大的裸 SVG。测试必须按页面的视角去取，而不是按我们的视角。
  const html = await (await fetch(base + '/')).text()
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^https?:|^\/\/|^#|^data:/.test(u))
  assert.ok(refs.length >= 2, `页面应该引用 css 与 js，实际：${refs.join(', ')}`)
  for (const ref of refs) {
    const resolved = new URL(ref, base + '/')
    const r = await fetch(resolved)
    assert.equal(r.status, 200, `页面引用的 ${ref}（解析为 ${resolved.pathname}）取不到，状态 ${r.status}`)
  }
})

test('界面的 JS 与 CSS 都能取到，类型正确', async () => {
  const js = await fetch(base + '/ui/app.js')
  assert.equal(js.status, 200)
  assert.match(js.headers.get('content-type') || '', /javascript/)
  const css = await fetch(base + '/ui/style.css')
  assert.equal(css.status, 200)
  assert.match(css.headers.get('content-type') || '', /css/)
})

test('界面里没有禁用 API（storage / cookie）', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  // 注释里提到这些词是允许的，只查真正的调用形态
  assert.equal(/localStorage\s*[.[]/.test(js), false, 'app.js 不得调用 localStorage')
  assert.equal(/sessionStorage\s*[.[]/.test(js), false, 'app.js 不得调用 sessionStorage')
  assert.equal(/indexedDB\s*[.[]/.test(js), false, 'app.js 不得调用 indexedDB')
  assert.equal(/document\.cookie\s*=/.test(js), false, 'app.js 不得写 cookie')
})

test('API 不写死主机名，换端口/换代理前缀也不坏', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  // 请求虽然必须是绝对地址（不透明源的硬要求），但绝不能把 127.0.0.1 或端口
  // 写死：换个端口、或经 magpie web 的 _magpie/service/<token>/ 代理时都要能用。
  // 绝对地址必须由 API_BASE（从 location.href 推导）拼出来。
  const hardcoded = js.match(/https?:\/\/(?:127\.0\.0\.1|localhost)[^'"`\s]*\/api\//g) || []
  assert.deepEqual(hardcoded, [], `不该写死本地地址：${hardcoded.join(', ')}`)
})

test('四个标签页的入口文案都在', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  assert.match(js, /模型广场/)
  assert.match(js, /余额/)
  assert.match(js, /密钥/)
  assert.match(js, /访问令牌/)
})

test('模型广场没有「启用/停用」开关', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  // 允许出现「启用」这个词（钥匙状态标签会用到），但不允许有「切换模型启用」的交互
  const suspicious = js.match(/toggleModel|setModelEnabled|model\.enabled\s*=|enabledModels/g) || []
  assert.deepEqual(suspicious, [], `模型广场不该有启用开关：${suspicious.join(', ')}`)
})

test('目录接口给出视频模型的区间价', async () => {
  const j = await (await fetch(base + '/api/catalog')).json()
  const video = j.models.find((m) => m.kind === 'video')
  assert.ok(video, '应该有视频模型')
  assert.equal(video.pricing.kind, 'percall')
  assert.match(video.pricing.input, /秒/)
})

test('未知静态文件回 404 JSON，不是空白', async () => {
  const r = await fetch(base + '/ui/nope.js')
  assert.equal(r.status, 404)
  const j = await r.json()
  assert.equal(j.ok, false)
})

test('每个「加载中」占位符都有对应的加载函数被 tab 调到（防「永远停在加载中」）', async () => {
  // 这是修过的真实 bug：密钥页的「怎么绑进 magpie」卡片用 renderBind 画
  // 「正在读取绑定说明」，但 ensureTab('keys') 只调 loadKeys，从没调过
  // loadBind，于是那行字永远不消失。人眼截图才看得出来，所以钉成测试。
  const js = await (await fetch(base + '/ui/app.js')).text()

  // 取出 ensureTab 的函数体，看它调了哪些 loader
  const ensure = js.match(/function ensureTab\([\s\S]*?\n\}/)
  assert.ok(ensure, '找不到 ensureTab')
  const body = ensure[0]
  const called = new Set([...body.matchAll(/(load[A-Z]\w+)\s*\(/g)].map((m) => m[1]))

  // 每个 render* 里用 regionLoading 的地方，对应的 loader 必须被 tab 调到
  // （loadModelDetail 是弹窗内的，不在 tab 上，白名单排除）
  const tabLoaders = ['loadCatalog', 'loadWallet', 'loadKeys', 'loadBind', 'loadPat']
  for (const fn of tabLoaders) {
    assert.ok(
      called.has(fn) || /loadWallet|loadKeys|loadPat/.test(fn) && /loadWallet|loadKeys|loadPat/.test([...called].join(' ')),
      `${fn} 没有被 ensureTab 调到，它负责的卡片会一直停在「加载中」`,
    )
  }
  // 直接检查：密钥页必须同时拉 keys 与 bind
  assert.match(body, /name === 'keys'[\s\S]{0,200}loadKeys/, 'keys 页要调 loadKeys')
  assert.match(body, /name === 'keys'[\s\S]{0,200}loadBind/, 'keys 页要调 loadBind，否则绑定说明永远加载中')
})

test('renderBind 的加载中分支只能在没有数据时出现', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  // renderBind 里必须有一条「有数据就画内容」的分支，不能只有加载中
  const fn = js.match(/function renderBind\([\s\S]*?\n\}/)
  assert.ok(fn, '找不到 renderBind')
  assert.match(fn[0], /replaceChildren/, 'renderBind 必须真的画内容')
  assert.match(fn[0], /how/, 'renderBind 必须渲染 how 步骤')
})

test('窄屏横向溢出要有提示，且提示在表格上方', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  const css = await (await fetch(base + '/ui/style.css')).text()

  // 提示元素存在
  assert.match(js, /scroll-hint/, '缺少横向滚动提示元素')
  // 判定用真实溢出，不是无条件显示
  assert.match(js, /scrollWidth\s*>\s*\w+\.clientWidth/, '提示应按真实溢出判定')
  // 提示要插在 wrap 之前：h('div', null, hint, wrap)
  assert.match(js, /h\('div', null, hint, wrap\)/, '提示必须在表格上方——放下面 195 行要滚到底才看见')
  // 默认隐藏，只有溢出才显示
  assert.match(css, /\.scroll-hint\s*\{[\s\S]*?display:\s*none/, '提示默认应隐藏')
  assert.match(css, /data-overflow="1"/, '提示应在溢出时显示')
})

test('窄屏不粘表头（避免矮滚动容器里遮内容）', async () => {
  const css = await (await fetch(base + '/ui/style.css')).text()
  const block = css.match(/@media \(max-width: 720px\)[\s\S]*?\n\}/)
  assert.ok(block, '找不到窄屏媒体查询')
  assert.match(block[0], /position:\s*static/, '窄屏应取消表头 sticky')
})

// ── 这一组守的是一个真实事故 ──────────────────────────────────────────
// magpie 的插件页跑在 sandbox="allow-scripts" 的 iframe 里，安全源是不透明的
// （self.origin === "null"，localStorage/cookie 都抛 SecurityError）。在这种
// 文档里 `fetch('/api/ping')` 这种相对路径会被 Chrome 判 Failed to fetch，
// 而绝对地址正常。界面曾经全用相对路径，于是装进 magpie 后每个接口都「连不上
// 本地服务」——但直接开 http://127.0.0.1:<port>/ 又完全正常，极难查。
test('界面请求必须用绝对地址（不透明源里相对路径会 Failed to fetch）', async () => {
  const raw = await (await fetch(base + '/ui/app.js')).text()
  // 去掉注释再扫：注释里会用 `fetch('/api/ping')` 举例说明这个坑，
  // 不剥掉会把说明文字当成真实调用。
  const js = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  // 1) 存在 API 基址，且从 location.href 推导（不能用 location.origin：
  //    不透明文档里它可能报真实源、也可能报 "null"）
  assert.match(raw, /const API_BASE/, '缺少 API_BASE')
  assert.match(raw, /new URL\(location\.href\)/, 'API_BASE 必须从 location.href 推导')
  assert.match(js, /function apiUrl\(/, '缺少 apiUrl')
  assert.match(js, /API_BASE\.replace/, 'apiUrl 必须用 API_BASE 拼')

  // 2) fetch 只能走 apiUrl，不能出现裸相对路径
  const fetchCalls = [...js.matchAll(/fetch\(\s*([^,)\n]+)/g)].map((m) => m[1].trim())
  assert.ok(fetchCalls.length >= 1, '应该有 fetch 调用')
  for (const arg of fetchCalls) {
    assert.match(arg, /^apiUrl\(/, `fetch 的地址必须经 apiUrl 拼成绝对地址，实际是：${arg}`)
  }
  // 3) 不许出现 fetch('/api…') 这种写法
  assert.equal(/fetch\(\s*['"]\/api/.test(js), false, '不该有 fetch 直接吃相对路径')
})

test('boot.js 保证服务地址以 / 结尾（否则 web 代理前缀会被吃掉）', async () => {
  // boot.js 与 package.json 不经过本地服务（服务只发 ui/ 与根下静态资源），
  // 直接从磁盘读。
  const boot = readFileSync(join(here, '..', 'page', 'boot.js'), 'utf8')
  assert.match(boot, /endsWith\('\/'\)/, 'boot.js 必须处理结尾斜杠')
  assert.match(boot, /service \+ '\/'/, 'boot.js 应补上结尾斜杠再拼 query')
})

test('/api/ping 的版本来自 package.json，不是硬编码', async () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  const r = await (await fetch(base + '/api/ping')).json()
  assert.ok(r.version, 'ping 应带 version')
  assert.equal(r.version, pkg.version, `ping 版本 ${r.version} 与 package.json ${pkg.version} 不一致`)
})
