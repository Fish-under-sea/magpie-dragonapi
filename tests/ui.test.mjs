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
const root = join(here, '..')

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

test('四个标签页：账户在前，使用日志紧跟模型广场，密钥已并入账户页', async () => {
  const html = await (await fetch(base + '/')).text()
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(tabs, ['wallet', 'catalog', 'logs', 'pat'], `标签顺序不符，实际 ${tabs.join(', ')}`)
  assert.match(html, /id="panel-logs"/, '应有使用日志面板')
  assert.equal(/id="flow-body"/.test(html), false, '账户页不再有用量流水卡')
  assert.equal(/id="panel-keys"/.test(html), false, '密钥面板应已并入账户页')
  // 密钥的能力还在：建钥匙表单挂在账户页里
  assert.match(html, /id="key-form"/, '建钥匙表单应在（弹窗内）')
  assert.match(html, /id="key-modal"/, '建钥匙应改为弹窗（仿原站）')
  // .modal-backdrop 是 display:flex，特异性会压过 hidden 的 UA display:none；
  // 没有这条规则，点 × 之后 JS 设了 hidden、视觉上却永远显示（真实修过的 bug）
  const css = await (await fetch(base + '/style.css')).text()
  assert.match(css, /\.modal-backdrop\[hidden\]\s*\{\s*display:\s*none/, '弹窗 hidden 时必须 display:none，否则关不掉')
  assert.match(html, /id="key-create-open"/, '密钥页应有「创建 API 密钥」入口按钮')
  assert.match(html, /id="keys-body"/, '应保留已有钥匙列表')

  // 旧书签 ?tab=keys 仍要能用，映射到账户页
  const js = await (await fetch(base + '/ui/app.js')).text()
  assert.match(js, /wanted === 'keys' \? 'wallet'/, '旧 tab=keys 应映射到 wallet')
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
  // 直接检查：账户页必须同时拉 keys 与 bind（密钥已并入账户页）
  assert.match(body, /name === 'wallet'[\s\S]{0,260}loadKeys/, '账户页要调 loadKeys')
  assert.match(body, /name === 'wallet'[\s\S]{0,260}loadBind/, '账户页要调 loadBind，否则绑定说明永远加载中')
})

test('「怎么绑进 magpie」卡片已删除，但步骤仍为新建钥匙面板保留', async () => {
  const html = await (await fetch(base + '/')).text()
  const js = await (await fetch(base + '/ui/app.js')).text()

  // 卡片与其容器都不该再出现
  assert.equal(/bind-info-body/.test(html), false, '绑定说明卡片应已删除')
  assert.equal(/怎么绑进 magpie/.test(html), false, '绑定说明标题应已删除')
  // 渲染函数一并删掉，避免「有函数没容器」的死代码
  assert.equal(/function renderBind\(/.test(js), false, 'renderBind 应已删除')

  // 但数据仍要取：新建钥匙成功后，面板里会列出绑定步骤
  assert.match(js, /async function loadBind\(/, 'loadBind 应保留（取数据）')
  assert.match(js, /cache\.bind\s*=\s*await api\.bindInfo\(\)/, 'loadBind 仍要缓存步骤')
  assert.match(js, /cache\.bind && cache\.bind\.how/, '新建钥匙面板仍要用这份步骤')
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

  const foot = css.match(/(?:^|\n)\.mc-line-ends\s*\{[^}]*\}/m)
  assert.ok(foot, '找不到 .mc-line-ends')
  assert.match(foot[0], /margin-top:\s*auto/, '端点行必须 margin-top:auto，把余量收在卡底')
  // 详情已经并到端点那一行，卡片不该再单占一行页脚
  assert.equal(/\.mc-foot\s*\{/.test(css), false, '不该再有独立的 .mc-foot 行')

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

test('端点用完整说法，不再只写 Chat/Response', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  const map = js.match(/const ENDPOINT_LABEL = \{[\s\S]*?\n\};/)
  assert.ok(map, '找不到 ENDPOINT_LABEL')
  // 一个模型常同时挂几种兼容层，只写「Chat」会让人以为只支持一种协议
  assert.match(map[0], /'OpenAI 兼容'/, 'openai 应显示为「OpenAI 兼容」')
  assert.match(map[0], /'OpenAI Responses'/, 'openai-response 应显示为「OpenAI Responses」')
  assert.match(map[0], /'Anthropic 兼容'/, 'anthropic 应显示为「Anthropic 兼容」')
  assert.match(map[0], /'Gemini 兼容'/, 'gemini 应显示为「Gemini 兼容」')
  assert.equal(/(?:openai:\s*'Chat')/.test(map[0]), false, '不该再退回「Chat」这种半截说法')

  // 自动描述里也要用同一套说法，别一边「OpenAI 兼容」一边「openai 端点」
  const auto = js.match(/function autoDescription\([\s\S]*?\n\}/)
  assert.ok(auto, '找不到 autoDescription')
  assert.match(auto[0], /\.map\(endLabel\)/, '自动描述应走 endLabel 转可读名')
})

test('详情与端点同一行，省掉一整行页脚', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  const fn = js.match(/function modelCard\([\s\S]*?\n\}/)
  assert.ok(fn, '找不到 modelCard')
  const endsLine = fn[0].match(/mc-line-ends[\s\S]*?\)\);/)
  assert.ok(endsLine, '找不到端点行')
  assert.match(endsLine[0], /mc-detail/, '详情按钮应在这行里')
  assert.equal(/mc-foot/.test(fn[0]), false, '卡片里不该再渲染独立页脚')
})

test('分组逐个列出，不并成 gpt-pro/promax 这种拼串', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  const chips = js.match(/function groupChipsEl\([\s\S]*?\n\}/)
  assert.ok(chips, '找不到 groupChipsEl')
  // 分组名是用户要认的渠道；拼串会让人以为那是一个名字。
  // 分组多的模型自然排到第二行，这个双行排布是刻意的。
  assert.equal(/agg\.chips/.test(chips[0]), false, '不该再走归并后的 chips')
  assert.match(chips[0], /agg\.groups/, '应逐个渲染 agg.groups')
  assert.equal(/join\('\/'\)/.test(chips[0]), false, '不该把多个分组名拼成一个')
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
  for (const cls of ['mc-name', 'mc-vendor', 'mc-desc', 'mc-billing', 'mc-prices', 'mc-ends', 'mc-detail']) {
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
  assert.match(js, /import \{ aggregateRows, focusGroupOf, orderDefault \} from '\.\/model-agg\.js'/, '应导入聚合模块')
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

  // 排序：默认那档叫「默认排序」——站点没有发布时间字段，叫「最新版本」是骗人。
  // 四项齐全，且是自绘弹层（原生 select 弹白底）。
  assert.match(html, /id="sort-label">默认排序</, '默认档应叫「默认排序」')
  for (const want of ['默认排序', '名称', '价格：从低到高', '价格：从高到低']) {
    assert.ok(html.includes(want), `排序菜单缺少「${want}」`)
  }
  assert.equal(html.includes('最新版本'), false, '不该再出现「最新版本」这个说法')
  // 默认排序的规则在 model-agg.js：厂商 → 等级分道 → 轮转取版本
  assert.match(js, /orderDefault/, '默认排序应走 orderDefault')
  assert.equal(/function byLatestVersion\(/.test(js), false, '旧的按版本号排序应已移除')
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
  assert.match(html, /账户概览/, '标签应显示「账户概览」')
  assert.match(html, /数据概览/, '用量卡片标题应为「数据概览」')

  const js = await (await fetch(base + '/ui/app.js')).text()
  assert.match(js, /function usageChart\(/, '缺少消耗柱状图')
  assert.match(js, /class: 'chart-bars'/, '缺少柱状图容器')
  assert.match(js, /class: 'acct-num'/, '账户卡应有大金额')
  assert.match(js, /acct-hero/, '账户卡应照站点版式：大字余额 + 刷新')
})

test('PAT 保存后区分「已验证 / 未验证 / 缺 scope」，不当成功一笔带过', async () => {
  const js = await (await fetch(base + '/ui/app.js')).text()
  assert.match(js, /已设置 · 已验证/, 'PAT 页应显示验证状态')
  assert.match(js, /已设置 · 未验证/, 'PAT 页应能显示未验证')
  assert.match(js, /data\.warning/, '保存后要展示服务端的 warning（缺 scope / 未验证）')
  assert.match(js, /payload\.hint/, '保存失败时应把服务端的可操作提示带出来')
})

test('页面不再自贴标题：标签页已说明位置，面板直接进内容，卡片用 h3', async () => {
  const html = await (await fetch(base + '/')).text()

  // 四页都不再有页头/副标题：标签栏已经标出当前在哪一页，再印一遍是重复。
  assert.equal(/class="page-head"/.test(html), false, '不该再有页面级页头')
  assert.equal(/class="page-sub"/.test(html), false, '不该再有页面副标题')
  assert.equal(/<h2>/.test(html.replace(/<h2 id="drawer-title">[\s\S]*?<\/h2>/g, '')), false,
    '面板里不该再有 h2（抽屉标题除外）')

  // 模型广场整页第一块就是横跨全宽的工具条（侧栏在它下面）
  const catalogPanel = html.match(/data-panel="catalog"[\s\S]*?<\/section>/)
  assert.ok(catalogPanel, '找不到模型广场面板')
  assert.match(catalogPanel[0], /class="market-top"/, '缺少工具条')
  assert.ok(
    catalogPanel[0].indexOf('class="market-top"') < catalogPanel[0].indexOf('class="market-body"'),
    '工具条要在布局最前面，侧栏在它下面',
  )
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

test('使用日志页：筛选条 + 统计条 + 明细表都在，且列与 NearToken 对齐', async () => {
  const html = await (await fetch(base + '/')).text()
  const js = await (await fetch(base + '/ui/app.js')).text()

  assert.match(html, /id="logs-range"/, '缺少时间范围切换')
  assert.match(html, /id="logs-model"/, '缺少模型名筛选')
  assert.match(html, /id="logs-group"/, '缺少分组筛选')
  assert.match(html, /id="logs-kind"/, '缺少类型筛选')
  assert.match(html, /id="logs-more"/, '缺少展开（更多筛选）')
  assert.match(html, /id="logs-token"/, '缺少令牌名筛选（展开区）')
  assert.match(html, /id="logs-pager"/, '缺少分页条')
  assert.match(html, /id="logs-chips"/, '缺少统计条')
  assert.match(html, /id="logs-body"/, '缺少明细表容器')

  // 表头列名随 NearToken：请求体大小 / Token（入/出）等
  assert.match(js, /'时间', '分组', '模型', '费用', '请求体大小', '流', 'Token', '耗时', '详情'/, '九列表头不符')
  assert.match(js, /function fillLogFilters\(/, '缺少下拉填充')
  assert.match(js, /fillLogFilters\(\(cache\.usage/, '渲染前要按实际行填充下拉')
})

test('推荐计划：恢复成跨整行长条，并带「转入余额」', async () => {
  const html = await (await fetch(base + '/')).text()
  const js = await (await fetch(base + '/ui/app.js')).text()

  assert.match(html, /class="card aff-card"/, '推荐计划应有独立长条卡')
  assert.match(html, /class="rf" id="aff-body"/, '推荐计划用 NearToken 的 .rf 版式')
  assert.equal(/aff-inline/.test(html), false, '不应再有内嵌版')

  for (const cls of ['rf-ico', 'rf-text', 'rf-stat', 'rf-link', 'rf-copy', 'rf-transfer', 'rf-sync']) {
    assert.match(js, new RegExp(cls), `推荐计划缺少 ${cls}`)
  }
  assert.match(js, /用户通过你的推荐链接注册后/, '缺少站点原话说明')
  assert.match(js, /affTransferArmedUntil/, '转入需二次确认（沙箱里 confirm 会被拦成 false）')
  assert.match(js, /api\.transferAff\(\)/, '应调用 /api/aff/transfer')
  assert.match(js, /'确认转入'/, '第一下应提示确认')
})

test('转入余额：服务端转发站点的 /api/user/aff_transfer，不编结论', async () => {
  // fixture 设了 PAT 但站点是 example.test（不可达）：应如实报失败。
  const svc = await (await fetch(base + '/api/aff/transfer', { method: 'POST' })).json()
  assert.equal(svc.ok, false, '站点不可达时不能报成功：' + JSON.stringify(svc))
  assert.match(svc.error || '', /转入失败/, '失败要说清是转入失败')
  // lib/ 不是静态目录，源码直接从磁盘读
  const site = readFileSync(join(root, 'lib', 'site.mjs'), 'utf8')
  assert.match(site, /api\/user\/aff_transfer/, '站点端点是 /api/user/aff_transfer')
  assert.match(site, /env\?\.message/, '成功与否以站点 message 为准')
})