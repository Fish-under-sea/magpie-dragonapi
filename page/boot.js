// 带路页：把 magpie 页面那个沙箱框架导航到本插件的本地服务。
//
// 为什么必须「直接跳」，不能先探测：
//
//   页面的 CSP 是 `connect-src 'none'`，fetch / XHR / WebSocket 全被禁止，
//   连 no-cors 的请求都会被直接拒绝。所以「先看看服务在不在再决定跳不跳」
//   这条路走不通——探测永远失败，页面会永远停在等待页。唯一可行的是直接
//   `location.replace`。这一点社区插件 page-chat 的 SERVE.md 也写过。
//
// 跳到哪里，分三种情况：
//
//   1. 桌面窗口：`magpie.service` 是空字符串，页面直接跳 127.0.0.1:<port>。
//   2. magpie web（在另一台机器上打开）：127.0.0.1 是看页面那台电脑自己，
//      不是跑服务的那台。这时 bridge 会给出 `magpie.service`——magpie web
//      在自己的地址上替本服务转发的路径（package.json 的 magpie.page.service
//      声明了它）。有就跳那里。
//   3. 旧版 magpie 既没有 service、又不在本机：给出 SSH 端口转发的做法。
(async () => {
  const DEFAULT_PORT = 3517
  let port = DEFAULT_PORT
  let theme = ''
  let tokens = null
  let service = ''

  try {
    const t = await window.magpie?.ready
    if (t) {
      if (typeof t.dark === 'boolean') theme = t.dark ? 'dark' : 'light'
      if (t.tokens && typeof t.tokens === 'object') tokens = t.tokens
    }
  } catch { /* 没有 bridge 就退回默认主题 */ }

  try {
    const s = window.magpie?.service
    if (typeof s === 'string' && /^https?:\/\//.test(s)) service = s
  } catch { /* 旧版 magpie 没有 service */ }

  try {
    const o = await window.magpie?.options?.get?.()
    if (o && Number.isFinite(Number(o.port)) && Number(o.port) > 0) port = Number(o.port)
  } catch { /* 没有 options 就用默认端口 */ }

  // 主题与设计令牌一起带过去：magpie 的 bridge 已经把它们算好了，
  // 这样界面配色和字体跟窗口完全一致，连用户的自定义主题也算在内。
  const q = new URLSearchParams()
  if (theme) q.set('theme', theme)
  const slim = {}
  for (const [k, v] of Object.entries(tokens || {})) {
    const s = String(v ?? '').trim()
    if (s) slim[k] = s
  }
  if (Object.keys(slim).length) q.set('tokens', JSON.stringify(slim))

  /** 5 秒后这份文档还活着，说明跳转没走成，换成能操作的提示。 */
  function armTimeout(p) {
    setTimeout(() => {
      const said = document.getElementById('said')
      if (!said) return
      said.textContent = '本地服务没有在运行（127.0.0.1:' + p + '）'
      if (document.getElementById('boot-retry')) return
      const btn = document.createElement('button')
      btn.id = 'boot-retry'
      btn.type = 'button'
      btn.textContent = '重试'
      btn.addEventListener('click', () => location.reload())
      said.parentNode.appendChild(btn)
    }, 5000)
  }

  if (service) {
    armTimeout(port)
    location.replace(service + '?' + q.toString())
    return
  }

  const target = 'http://127.0.0.1:' + port + '/?' + q.toString()

  if (!isLoopback(location.hostname)) {
    showRemote(port, target)
    return
  }
  armTimeout(port)
  location.replace(target)
})()

function isLoopback(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  return h === '' || h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h)
}

function showRemote(port, target) {
  const said = document.getElementById('said')
  if (!said) return
  const host = location.hostname.replace(/^\[|\]$/g, '')
  said.textContent = ''
  const p = (text) => {
    const el = document.createElement('p')
    el.textContent = text
    said.appendChild(el)
    return el
  }
  p('界面服务只在运行 magpie 的那台机器上监听 127.0.0.1:' + port + '，从这台电脑的浏览器连不到它。')
  p('在这台电脑上开一个 SSH 端口转发，然后点「继续」：')
  const code = p('ssh -N -L ' + port + ':127.0.0.1:' + port + ' <用户名>@' + host)
  code.style.fontFamily = 'ui-monospace, Menlo, Consolas, monospace'
  code.style.userSelect = 'all'
  const go = document.createElement('button')
  go.type = 'button'
  go.textContent = '继续'
  go.addEventListener('click', () => location.replace(target))
  said.parentNode.appendChild(go)
}
