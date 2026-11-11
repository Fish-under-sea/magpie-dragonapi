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

// ── 模型广场卡片网格 ────────────────────────────────────────────────
// 用户报过两次「卡片不等高」，两次的要求其实是同一个：整屏看过去要齐。
// 中间有一版改成 align-items:start（按内容定高），理由是 stretch 会让矮卡
// 中间空一段；但那样每一排高度都不同，整屏参差——比中间空一段更难看。
//
// 现在的方案是两头都要：网格 stretch 取齐，同时把卡内各块高度归一
// （头 / 说明 / 价格 / 分组 各预留固定高度），余量只剩页脚上方一点点，
// 由 .mc-foot 的 margin-top:auto 收走。这样每排等高、卡内也不空。
test('卡片等高：网格 stretch + 卡内各块预留高度 + 页脚吸底', async () => {
  const css = (await (await fetch(base + '/ui/style.css')).text()).replace(/\/\*[\s\S]*?\*\//g, '')

  const grid2 = css.match(/\.grid-2\s*\{[^}]*\}/)
  assert.ok(grid2, '找不到 .grid-2')
  assert.match(grid2[0], /align-items:\s*stretch/, '.grid-2 必须 stretch')

  const modelGrid = css.match(/(?:^|\n)\.model-grid\s*\{[^}]*\}/m)
  assert.ok(modelGrid, '找不到 .model-grid')
  assert.match(modelGrid[0], /align-items:\s*stretch/, '.model-grid 必须 stretch（同排等高）')

  const foot = css.match(/(?:^|\n)\.mc-foot\s*\{[^}]*\}/m)
  assert.ok(foot, '找不到 .mc-foot')
  assert.match(foot[0], /justify-content:\s*flex-end/, '详情应右对齐')
  assert.match(foot[0], /margin-top:\s*auto/, '页脚必须 margin-top:auto，把余量收在卡底')

  const mc = css.match(/(?:^|\n)\.mc\s*\{[^}]*\}/m)
  assert.ok(mc, '找不到 .mc')
  assert.match(mc[0], /display:\s*flex/, '.mc 必须是 flex 容器')
  assert.match(mc[0], /flex-direction:\s*column/, '.mc 必须纵向排布')

  // 卡内四个高度会变的地方都必须预留高度，否则 stretch 仍会在卡内留空段
  for (const [sel, why] of [
    ['\\.mc-head', '有/无厂商行差一整行'],
    ['\\.mc-desc', '描述一行与两行'],
    ['\\.mc-prices', '区间写法与单值字号不同'],
    ['\\.mc-line-groups', '分组 1 个与 4 个差一行'],
  ]) {
    const rule = css.match(new RegExp(`(?:^|\\n)${sel}\\s*\\{[^}]*\\}`, 'm'))
    assert.ok(rule, `找不到 ${sel} 规则`)
    assert.match(rule[0], /min-height:\s*(?:\d|calc\()/, `${sel} 必须预留高度（${why}）`)
  }

  // 组名本身仍不折行（折在「国模_原厂」中间读不出来），换行发生在 .mc-groups 层
  const group = css.match(/\.mc-group\s*\{[^}]*\}/)
  assert.ok(group, '找不到 .mc-group')
  assert.match(group[0], /white-space:\s*nowrap/, '组名要单行省略')
})

test('模型广场是筛选栏 + 卡片网格，不再是表格', async () => {
  const html = await (await fetch(base + '/')).text()
  assert.match(html, /class="market-body"/, '缺少 market-body 布局')
  assert.match(html, /class="market-aside"/, '缺少左侧筛选栏')
  assert.match(html, /class="model-grid"/, '缺少卡片网格容器')
  assert.match(html, /id="group-chips"/, '缺少分组筛选')

  const js = await (await fetch(base + '/ui/app.js')).text()
  assert.match(js, /function modelCard\(/, '缺少 modelCard 渲染函数')
  // 模型广场不该再走表格渲染
  assert.equal(/tableEl\(\s*\[\s*'模型名'/.test(js), false, '模型广场不该再用表格渲染')
})

test('卡片含 NearToken 那套信息位：名称/厂商/描述/计费/价格/分组/端点/详情', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  const fn = js.match(/function modelCard\([\s\S]*?\n\}/)
  assert.ok(fn, '找不到 modelCard')
  for (const cls of ['mc-name', 'mc-vendor', 'mc-desc', 'mc-billing', 'mc-prices', 'mc-ends', 'mc-foot']) {
    assert.match(fn[0], new RegExp(cls), `卡片缺少 ${cls}`)
  }
  // 分组：一个模型跨多个分组，抽成 groupChipsEl
  const groupChips = js.match(/function groupChipsEl\([\s\S]*?\n\}/)
  assert.ok(groupChips, '找不到 groupChipsEl')
  assert.match(groupChips[0], /mc-group/, '分组 chip 缺少 mc-group')
  assert.match(groupChips[0], /ratioTag\(/, '分组 chip 应带倍率标签')
  assert.match(fn[0], /groupChipsEl\(agg\)/, '卡片应调用分组 chip 渲染')
  // 价格三列：输入 / 输出 / 缓存读取（价格格单独一个函数，卡片调用它）
  assert.match(fn[0], /priceCellsOfAgg\(/, '卡片应调用聚合价格格渲染')
  const prices = js.match(/function priceCellsOfAgg\([\s\S]*?\n\}/)
  assert.ok(prices, '找不到 priceCellsOfAgg')
  for (const label of ['输入', '输出', '缓存读取']) {
    assert.ok(prices[0].includes(label), `价格格缺少「${label}」`)
  }
})

test('分组一个都不省略：不截断、不「+N」、CSS 不省略号', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  const groupChips = js.match(/function groupChipsEl\([\s\S]*?\n\}/)
  assert.ok(groupChips, '找不到 groupChipsEl')
  assert.equal(/\.slice\(/.test(groupChips[0]), false, '分组列表不该 slice 截断')
  assert.equal(/\+\$\{/.test(groupChips[0]), false, '不该出现「+N」折叠')
  assert.equal(/mc-more/.test(groupChips[0]), false, '不该再渲染「还有几个」')

  // CSS 也不能靠省略号收场：这个值以前是 ellipsis，理由是维持等高，
  // 现在等高由网格 stretch 保证，分组必须完整可读。
  const css = (await (await fetch(base + '/ui/style.css')).text()).replace(/\/\*[\s\S]*?\*\//g, '')
  const groupRule = css.match(/\.mc-group\s*\{[^}]*\}/)
  assert.ok(groupRule, '找不到 .mc-group 规则')
  assert.match(groupRule[0], /overflow:\s*visible/, '.mc-group 不该隐藏溢出')
  assert.equal(/text-overflow:\s*ellipsis/.test(groupRule[0]), false, '.mc-group 不该用省略号')
  const groupsRule = css.match(/\.mc-groups\s*\{[^}]*\}/)
  assert.ok(groupsRule, '找不到 .mc-groups 规则')
  assert.match(groupsRule[0], /flex-wrap:\s*wrap/, '分组应允许换行排下全部分组')
})

test('跨分组价格给区间，不假装只有一个价', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  assert.match(js, /function fmtRange\(/, '缺少区间格式化')
  assert.match(js, /with-range/, '卡片应标记区间样式')
  // 只写一次符号与单位：$0.12–0.32/M，而不是 $0.12/M–$0.32/M
  const fn = js.match(/function fmtRange\([\s\S]*?\n\}/)
  assert.ok(fn, '找不到 fmtRange')
  assert.match(fn[0], /toFixed\(digits\)/, '两端应用同一精度')
})

test('目录聚合走 aggregateRows（一张卡 = 一个模型）', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  assert.match(js, /import \{ aggregateRows, focusGroupOf \} from '\.\/model-agg\.js'/, '应导入聚合模块')
  assert.match(js, /const rows = aggregateRows\(matched\)/, 'renderCatalog 应聚合后再渲染')
})

test('聚合模块必须能被服务取到（否则页面 import 404，整页挂掉）', async () => {
  // ui/app.js 是 module，import './model-agg.js' 会请求根路径 /model-agg.js。
  // 静态路由若没放行 .js，页面会白屏——这条比任何样式断言都关键。
  const r = await fetch(base + '/model-agg.js')
  assert.equal(r.status, 200, `/model-agg.js 应可访问，实际 ${r.status}`)
  const text = await r.text()
  assert.match(text, /export function aggregateRows/, '取到的应是聚合模块本体')
})

test('卡片不伪造健康度：没有延迟/吞吐/成功率这类我们拿不到的数据', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  const fn = js.match(/function modelCard\([\s\S]*?\n\}/)
  assert.ok(fn, '找不到 modelCard')
  // NearToken 的卡片有实时健康度，我们没有这些数据，编出来比留白更糟
  for (const word of ['延迟', '吞吐', '成功率', 'latency', 'tps']) {
    assert.equal(fn[0].includes(word), false, `卡片不该出现「${word}」：我们没有这项数据`)
  }
})

test('没设 PAT 时给引导式空态，不甩红色错误横幅', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  // 钥匙页：400 + 含「访问令牌」的失败应识别成「还没配置」而不是「出错了」
  assert.match(js, /keysNeedPat/, '缺少 keysNeedPat 状态')
  assert.match(js, /err\.status === 400/, '应按状态码区分「未配置」与「真失败」')
  assert.match(js, /去设置访问令牌/, '应给一条通往 PAT 页的路')
})

test('广场工具条：价格单位 /1M-/1K、排序、双列-列表都是真功能', async () => {
  const html = await (await fetch(base + '/')).text()
  for (const id of ['unit-seg', 'sort-trigger', 'sort-pop', 'view-seg', 'catalog-search']) {
    assert.ok(html.includes('id="' + id + '"'), `工具条缺少 #${id}`)
  }
  const js = await (await fetch(base + '/ui/app.js')).text()
  assert.match(js, /function fmtTok\(/, '缺少按单位换算的格式化函数')
  assert.match(js, /filters\.unit/, '单位应参与渲染')
  assert.match(js, /as-list/, '缺少列表视图')
  assert.match(js, /filters\.sort/, '排序应参与渲染')

  // 排序：默认「最新版本」，四项齐全，且是自绘弹层（原生 select 弹白底）
  assert.match(html, /id="sort-label">最新版本</, '默认排序应是最新版本')
  for (const want of ['最新版本', '名称', '价格：从低到高', '价格：从高到低']) {
    assert.ok(html.includes(want), `排序菜单缺少「${want}」`)
  }
  assert.match(js, /function byLatestVersion\(/, '缺少「最新版本」排序实现')
  assert.equal(html.includes('id="sort-select"'), false, '排序不该再用原生 select，弹层跟不了深色主题')
  assert.equal(js.includes('kind-chips'), false, '类型分段控件应已移除（分类在侧栏）')
})

test('PAT 保存：不做前缀硬校验，且有即时反馈与超时', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  // 站点令牌前缀由站点决定（文档写过 nap-、代码写过 nap_），前端按猜测拦下来
  // 就会变成「点保存没反应」——这是用户真实遇到的问题。
  assert.equal(/startsWith\('nap_'\)/.test(js), false, '不该按 nap_ 前缀硬拦')
  assert.match(js, /\^sk\[-_\]/, '只应挡明显拿错的 sk- 钥匙')
  assert.match(js, /正在向站点验证/, '点保存后要立刻有反馈')
  assert.match(js, /AbortSignal\.timeout\(/, '请求必须有超时，不能无限转圈')
})

test('列表视图是七列表格：模型/类型/价格/缓存/供应商/端点/分组', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  assert.match(js, /function listHead\(/, '缺少列表表头')
  assert.match(js, /function modelRow\(/, '缺少列表行渲染')
  const head = js.match(/function listHead\([\s\S]*?\n\}/)
  for (const col of ['模型', '类型', '价格', '缓存', '供应商', '端点', '分组']) {
    assert.ok(head[0].includes(col), `表头缺少「${col}」`)
  }
  const css = (await (await fetch(base + '/ui/style.css')).text()).replace(/\/\*[\s\S]*?\*\//g, '')
  assert.match(css, /\.model-grid\.as-list \.ml-row\s*\{/, '缺少列表行样式')
  assert.match(css, /\.model-grid\.as-list \.ml-head,/, '缺少表头样式')
})

test('标签栏是胶囊，余额页是账户概览 + 数据概览', async () => {
  const css = (await (await fetch(base + '/ui/style.css')).text()).replace(/\/\*[\s\S]*?\*\//g, '')
  const tabs = css.match(/(?:^|\n)\.tabs\s*\{[^}]*\}/m)
  assert.ok(tabs, '找不到 .tabs')
  assert.match(tabs[0], /border-radius:\s*999px/, '标签栏外框应是胶囊')
  const tab = css.match(/(?:^|\n)\.tab\s*\{[^}]*\}/m)
  assert.ok(tab, '找不到 .tab')
  assert.match(tab[0], /border-radius:\s*999px/, '标签按钮应是胶囊')

  const html = await (await fetch(base + '/')).text()
  assert.match(html, /账户概览/, '余额卡片标题应为「账户概览」')
  assert.match(html, /数据概览/, '用量卡片标题应为「数据概览」')

  const js = await (await fetch(base + '/ui/app.js')).text()
  assert.match(js, /function usageChart\(/, '缺少消耗柱状图')
  assert.match(js, /class: 'chart-bars'/, '缺少柱状图容器')
  assert.match(js, /class: 'money'/, '账户概览应有大金额')
})

test('PAT 保存后区分「已验证 / 未验证 / 缺 scope」，不当成功一笔带过', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  assert.match(js, /已设置 · 已验证/, 'PAT 页应显示验证状态')
  assert.match(js, /已设置 · 未验证/, 'PAT 页应能显示未验证')
  assert.match(js, /data\.warning/, '保存后要展示服务端的 warning（缺 scope / 未验证）')
  assert.match(js, /payload\.hint/, '保存失败时应把服务端的可操作提示带出来')
})

test('页面标题：广场直接进工具条，其余三页保留 h2 页头，卡片标题用 h3', async () => {
  const html = await (await fetch(base + '/')).text()

  // 模型广场去掉了页头：整页第一块就是横跨全宽的工具条（侧栏在它下面）
  const catalogPanel = html.match(/data-panel="catalog"[\s\S]*?<\/section>/)
  assert.ok(catalogPanel, '找不到模型广场面板')
  assert.equal(/class="page-head"/.test(catalogPanel[0]), false, '模型广场不设页头')
  assert.match(catalogPanel[0], /class="market-top"/, '缺少工具条')
  assert.ok(
    catalogPanel[0].indexOf('class="market-top"') < catalogPanel[0].indexOf('class="market-body"'),
    '工具条要在布局最前面，侧栏在它下面',
  )

  // 其余三个面板仍是 page-head + h2 + page-sub
  const heads = [...html.matchAll(/class="page-head"[\s\S]{0,220}?<h2>([^<]+)<\/h2>[\s\S]{0,120}?class="page-sub"/g)]
  assert.equal(heads.length, 3, `应有 3 个页面级标题，实际 ${heads.length}`)
  const titles = heads.map((m) => m[1])
  for (const want of ['余额与用量', '密钥', '访问令牌']) {
    assert.ok(titles.includes(want), `缺少页面标题「${want}」：${titles.join(', ')}`)
  }
  // 面板本身仍有可访问名称：由 tab 的 aria-labelledby 提供
  assert.match(html, /aria-labelledby="tab-catalog"/, '广场面板要靠 tab 标出可访问名称')

  // 卡片标题必须降到 h3：card-head 里不该再出现 h2，否则层级和页头打平
  assert.equal(/class="card-head"[\s\S]{0,80}?<h2>/.test(html), false, 'card-head 里不该有 h2')
  const cardH3 = (html.match(/<header class="card-head">[\s\S]{0,60}?<h3>/g) || []).length
  assert.ok(cardH3 >= 4, `卡片标题应统一为 h3，实际匹配 ${cardH3}`)
})

test('账户卡不重复显示打码钥匙', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  // 服务端 label 本身就是「分组 · 打码钥匙」，再单列一次就是重复
  assert.match(js, /showMask/, '缺少去重判断')
  assert.match(js, /!String\(a\.label \|\| ''\)\.includes\(mask\)/, '应按 label 是否已含打码来判断')
})

// ── 重绘后的广场：按厂商分类的分组筛选 + 分组横幅 + 供应商图标 ──────
test('模型广场：侧栏按厂商分类分组，分组 chip 前面是倍率', async () => {
  const html = await (await fetch(base + '/')).text()
  assert.match(html, /id="group-chips"/, '缺少分组/分类筛选栏')
  assert.match(html, /id="group-banner"/, '缺少选中分组/分类的横幅')

  const js = await (await fetch(base + '/ui/app.js')).text()
  assert.match(js, /const CATEGORY_ORDER = \[[^\]]*'claude'[^\]]*'gpt'[^\]]*'gemini'[^\]]*'grok'[^\]]*'guomo'[^\]]*'image'[^\]]*'video'/, '分类顺序应为 claude-gpt-gemini-grok-国模-image-video')
  assert.match(js, /function renderGroupedChips\(/, '缺少按分类渲染分组的函数')
  assert.match(js, /function renderGroupBanner\(/, '缺少顶部横幅渲染')
  assert.match(js, /function categoryOf\(/, '缺少分组归类函数')
  assert.match(js, /function ratioTag\(/, '分组 chip 应显示倍率胶囊')
  assert.match(js, /gb-tag/, '倍率/标签应统一成 gb-tag 胶囊样式')
  assert.match(js, /function vendorBadge\(/, '缺少厂商标记渲染')

  // 图标是运行时按厂商名引用的，列不进 HTML 的 src，所以要单独核对文件真的在。
  const files = [...new Set([...js.matchAll(/'([A-Za-z0-9._-]+\.svg)'/g)].map((m) => m[1]))]
  assert.ok(files.length >= 10, `厂商图标映射太少，实际 ${files.length}`)
  for (const f of files) {
    const r = await fetch(base + '/vendor-icons/' + f)
    assert.equal(r.status, 200, `供应商图标 ${f} 取不到（页面会显示碎图）`)
  }
})

// ── 详情抽屉：给结论，不给机器串 ────────────────────────────────────
test('详情抽屉不再倒站点原文，而是中文结论', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  const fn = js.match(/function modelDetailNodes\([\s\S]*?\n\}/)
  assert.ok(fn, '找不到 modelDetailNodes')
  assert.equal(/mode: \$?\{?billing\.mode/.test(fn[0]), false, '不该再把 mode: … 显示给用户')
  for (const want of ['计费方式', '每一档的实际单价', '按用量计费']) {
    assert.ok(fn[0].includes(want), `详情缺少「${want}」这一段`)
  }
  // 每档单价必须来自服务端折好的 prices，而不是根本不存在的 tiers[].input
  assert.match(fn[0], /t\.prices\.input/, '分档表应读 tiers[].prices')
  assert.equal(/t\.input\s*!=/.test(fn[0]), false, '不该再读 tiers[].input（服务端从来没给过）')
  // 原始表达式必须收进 <details>，默认折叠
  assert.match(fn[0], /h\('details', \{ class: 'raw' \}/, '原始表达式应放在折叠块里')
})

test('详情页的中文值不再被套等宽字体', async () => {
  const css = (await (await fetch(base + '/ui/style.css')).text()).replace(/\/\*[\s\S]*?\*\//g, '')
  const dd = css.match(/\.kv-grid dd\s*\{[^}]*\}/)
  assert.ok(dd, '找不到 .kv-grid dd')
  assert.equal(/font-family/.test(dd[0]), false, '.kv-grid dd 不该统一等宽：中文会掉进等宽字体的 CJK 回退字形')
  assert.match(css, /\.kv-grid dd\.mono\s*\{[^}]*font-family:\s*var\(--code\)/, '需要等宽的值应显式加 .mono')
})
