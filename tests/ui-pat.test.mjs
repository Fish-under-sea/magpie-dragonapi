import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8')
const fn = (name) => {
  const m = src.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))
  assert.ok(m, name)
  return m[0]
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function harness(names, extra = {}) {
  const boxes = new Map()
  const get = id => {
    if (!boxes.has(id)) boxes.set(id, { children: [], replaceChildren(...v) { this.children = v }, classList: { toggle() {} } })
    return boxes.get(id)
  }
  const c = vm.createContext({
    cache: { state: null, usage: {}, usageErrors: {}, keys: {}, aff: {}, subscriptions: {} },
    loading: {}, dataEpoch: 0, usagePending: new Map(), filters: { range: 'day' },
    lastSecret: {}, revealed: new Map([[1, 'fake']]), affTransferArmedUntil: 1, confirmDeleteId: 1,
    RANGE_LABEL: { day: '日', week: '周' },
    $: get, h: (tag, props, ...children) => ({ tag, props, children }),
    regionLoading: (box, text) => box.replaceChildren({ loading: text }),
    regionError: (box, text) => box.replaceChildren({ error: text }),
    renderUsage() {}, renderLogs() {}, renderSecret() {}, renderPat() {},
    banner() {}, clearBanner() {}, describeError: e => e.message,
    fmtInt: String, fmtAt: String, moneyRaw: String, fullDate: String,
    BILLING_LABEL: { subscription_first: '优先订阅' }, SUB_STATUS: { expired: '已到期', cancelled: '已取消' },
    ...extra,
  })
  vm.runInContext(names.map(fn).join('\n'), c)
  return { c, get, run: code => vm.runInContext(code, c) }
}

test('PAT 更换和全局刷新共用完整失效：清空账户、推荐、订阅、日志和明文', () => {
  const { c, run } = harness(['clearAccountCache', 'clearCache'])
  run('clearCache()')
  for (const name of ['state', 'aff', 'keys', 'subscriptions']) assert.equal(c.cache[name], null)
  assert.equal(Object.keys(c.cache.usage).length, 0)
  assert.equal(c.revealed.size, 0)
  assert.equal(c.lastSecret, null)
  assert.equal(c.affTransferArmedUntil, 0)
  assert.equal(c.dataEpoch, 1)
  for (const name of ['onSavePat', 'onClearPat']) assert.match(fn(name), /clearAccountCache\(\)/)
})

test('PAT 失效后较晚返回的旧账户日志不能重填缓存', async () => {
  const d = deferred()
  const { c, run } = harness(['loadUsage', 'clearAccountCache'], { api: { usage: () => d.promise } })
  const pending = run('loadUsage()')
  run('clearAccountCache()')
  d.resolve({ rows: [{ model: 'old' }] })
  assert.equal(await pending, null)
  assert.equal(c.cache.usage.day, undefined)
})

test('并发切换日周区间，各自请求不会被全局 loading 丢弃', async () => {
  const ds = { day: deferred(), week: deferred() }
  const { c, run } = harness(['loadUsage'], { api: { usage: range => ds[range].promise } })
  const day = run('loadUsage()')
  c.filters.range = 'week'
  const week = run('loadUsage()')
  ds.day.resolve({ rows: ['day'] }); ds.week.resolve({ rows: ['week'] })
  await Promise.all([day, week])
  assert.equal(c.cache.usage.day.rows[0], 'day')
  assert.equal(c.cache.usage.week.rows[0], 'week')
})

test('用量读取失败会同时更新日志和概览，不保留旧数据', async () => {
  let renders = 0
  const { c, run } = harness(['loadUsage'], {
    api: { usage: async () => { throw Error('usage:read 权限不足') } },
    renderUsage: () => renders++, renderLogs: () => renders++,
  })
  c.cache.usage.day = { rows: ['old'] }
  await run('loadUsage(true)')
  assert.equal(c.cache.usage.day, undefined)
  assert.match(c.cache.usageErrors.day, /权限不足/)
  assert.equal(renders, 2)
  assert.match(fn('renderLogs'), /cache\.usageErrors/)
})

test('PAT-only 账户显示钱包，绑定钥匙单独标记且不合并余额', () => {
  const { c, get, run } = harness(['renderAccounts', 'splitMoney'])
  c.cache.state = { pat: { set: true }, user: { username: 'PAT User', balance: '$12.00', used: '$2.00' }, accounts: [] }
  run('renderAccounts()')
  let shown = JSON.stringify(get('#account-body').children)
  assert.match(shown, /账户钱包/)
  assert.match(shown, /12.00/)
  c.cache.state.accounts = [{ label: 'Key', balance: '$90.00' }]
  run('renderAccounts()')
  shown = JSON.stringify(get('#account-body').children)
  assert.match(shown, /钥匙额度/)
  assert.match(shown, /90.00/)
  // 钱包与钥匙额度各自展示，不求和（旧实现会把两者相加冒充钱包）
  assert.match(shown, /12.00/)
})

test('订阅超额百分比保留文本，进度条视觉 clamp；不限量无假百分比', () => {
  const { run } = harness(['subscriptionCard'])
  const card = run("subscriptionCard({title:'Plus',status:'expired',active:false,used:'$33',total:'$30',remaining:'-$3',progress:110})")
  const progress = card.children.find(v => v?.tag === 'progress')
  assert.equal(progress.props.value, '100')
  assert.match(JSON.stringify(card), /110.0%.*已超额/)
  const unlimited = run("subscriptionCard({title:'Unlimited',status:'cancelled',unlimited:true,used:'$33'})")
  assert.equal(unlimited.children.some(v => v?.tag === 'progress'), false)
  assert.match(JSON.stringify(unlimited), /已取消/)
  const unknown = run("subscriptionCard({title:'Unknown',status:'active',active:false,progress:null})")
  assert.equal(unknown.children.some(v => v?.tag === 'progress'), false)
  assert.match(JSON.stringify(unknown), /额度数据不足/)
  assert.match(JSON.stringify(unknown), /未确认有效/)
})

test('订阅接口失败和未配置 PAT 分开显示，不当作没有订阅', async () => {
  const { c, get, run } = harness(['loadSubscriptions', 'renderSubscriptions'], {
    api: { subscriptions: async () => { const e = Error('还没有设置访问令牌'); e.status = 400; throw e } },
  })
  c.cache.subscriptions = null
  await run('loadSubscriptions(true)')
  assert.equal(c.cache.subscriptions.needPat, true)
  // 没有 PAT 时引导只出现在钱包卡里，订阅区留空，避免同一张卡两段空态
  assert.equal(get('#subscriptions-body').children.length, 0)
  c.api.subscriptions = async () => { throw Error('wallet:read 权限不足') }
  await run('loadSubscriptions(true)')
  assert.match(JSON.stringify(get('#subscriptions-body').children), /订阅没读到.*权限不足/)
})

test('没有 PAT 时钱包卡给出设置入口', () => {
  const { c, get, run } = harness(['renderAccounts', 'splitMoney'])
  c.cache.state = { pat: { set: false }, accounts: {} }
  run('renderAccounts()')
  assert.match(JSON.stringify(get('#account-body').children), /去设置访问令牌/)
})

test('订阅只显示当前生效那一条，不再渲染套餐列表', () => {
  const { c, get, run } = harness(['renderSubscriptions', 'subscriptionCard'])
  c.cache.subscriptions = {
    ok: true,
    billingPreference: 'subscription_first',
    plans: [{ title: '套餐 A' }],
    plansError: 'HTTP 503 unavailable',
    subscriptions: [
      { title: 'Old Plan', status: 'expired', active: false },
      { title: 'My Plus', status: 'active', active: true, total: '$30', used: '$12', remaining: '$18', progress: 40 },
    ],
  }
  run('renderSubscriptions()')
  const rendered = JSON.stringify(get('#subscriptions-body').children)
  assert.match(rendered, /My Plus/)
  assert.equal(rendered.includes('Old Plan'), false, '只展示当前生效的订阅')
  assert.equal(rendered.includes('套餐列表'), false, '套餐列表不再单开一区')
  assert.match(rendered, /扣费偏好/)
})

test('粘贴 PAT 规范化与打码匹配用于保存超时后的核对', () => {
  const { run } = harness(['normalizePatInput', 'patHintOf'])
  assert.equal(run('normalizePatInput(\' "Authorization: Bearer nap_test123456" \' )'), 'nap_test123456')
  assert.equal(run("patHintOf('nap_test123456')"), 'nap_**********3456')
  assert.match(fn('onSavePat'), /state\.pat\.hint === patHintOf\(pat\)/)
})
