// 把 magpie 宿主的页面 bridge 接回本地界面。
//
// 界面是从 page/boot.js 跳过来的：跳转前还在宿主的沙箱帧里，跳转后这份
// 文档由插件自己的本地服务提供，宿主的 bridge 已经不在了。boot.js 因此把
// bridge 的地址（`_magpie/bridge.js`）随 URL 带过来，这里重新加载它：
//
//   - 加载后 window.magpie 就是宿主那套钩子：ready / theme / onTheme /
//     glass / onGlass / options / call …，与页面停在沙箱帧里时完全一样；
//   - 宿主会把 --magpie-glass-<region>-fill/-blur 写到 <html> 上，并在真的
//     透的时候挂 data-magpie-glass；style.css 的液态玻璃段直接吃这组变量，
//     用户拖「设置 › 外观」时页面跟着变，不需要脚本参与；
//   - 主题令牌不是 --magpie-* 就叫得动的：本页自己的 --bg / --fg / --font
//     等是从 magpie 的 bg / fg / font 映射来的，所以 onTheme 里再映射一次。
//
// 接不回来（旧宿主、wails:// 之类取不到 http(s) 地址、bridge 被拒）不算
// 错误：app.js 仍按 URL 上的 ?theme / ?tokens 上色，与改动前一致。

const BRIDGE_PATH = '/_magpie/bridge.js'

let connecting = null

/** bridgeUrl 校验 boot.js 带来的地址：只认 http(s)、路径是 bridge，且和
 *  框住我们的窗口同源（防止有人把本地界面的 URL 拼上别处的脚本）。 */
export function bridgeUrl(raw, base, allowedOrigin) {
  const value = String(raw || '').trim()
  if (!value) return ''
  try {
    const u = new URL(value, base || location.href)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    if (!u.pathname.endsWith(BRIDGE_PATH)) return ''
    // location.ancestorOrigins 不跨源泄露具体地址，只给源；拿不到时（旧
    // WebKit、独立打开）要求 bridge 在回环地址上——不给任意远程脚本留口子。
    const expected = allowedOrigin === undefined ? ancestorOrigin() : allowedOrigin
    if (expected ? u.origin !== expected : !isLoopback(u.hostname)) return ''
    return u.href
  } catch {
    return ''
  }
}

function isLoopback(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127\./.test(h)
}

function ancestorOrigin() {
  try {
    return location.ancestorOrigins?.[0] || ''
  } catch {
    return ''
  }
}

/** applyTheme 把宿主的设计令牌落到本页自己的变量层上，并同步深浅色。 */
export function applyTheme(theme) {
  if (!theme || typeof theme !== 'object') return
  const root = document.documentElement
  if (typeof theme.dark === 'boolean') root.dataset.theme = theme.dark ? 'dark' : 'light'
  for (const [key, value] of Object.entries(theme.tokens || {})) {
    const v = String(value ?? '').trim()
    if (!v) continue
    root.style.setProperty('--' + String(key).replace(/^--/, ''), v)
  }
}

/** loadScript 加载宿主的 bridge；失败或超时都只是「没有桥」，不抛。 */
function loadScript(src, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => done(Boolean(window.magpie)), timeoutMs)
    const el = document.createElement('script')
    el.src = src
    el.async = true
    el.onload = () => done(true)
    el.onerror = () => done(false)
    document.head.appendChild(el)
  })
}

/** ready 等宿主的 hello 回来；它回不来就放弃，让页面留在静态快照上。 */
async function ready(timeoutMs) {
  if (!window.magpie?.ready) return null
  let timer
  try {
    return await Promise.race([
      window.magpie.ready,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('host bridge timeout')), timeoutMs)
      }),
    ])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * connectHost 重新接上宿主的页面 bridge。
 *
 * 重复调用只会连一次；没带 bridge 地址时立刻返回 null，不拖慢首屏。
 * 返回宿主的 theme（含 glass）；接不上也返回 null。
 */
export function connectHost() {
  if (connecting) return connecting
  const src = bridgeUrl(new URLSearchParams(location.search).get('bridge'))
  if (!src) return Promise.resolve(null)

  connecting = (async () => {
    if (!window.magpie?.ready && !(await loadScript(src, 1500))) return null
    const theme = await ready(2500)
    if (!theme) return null
    applyTheme(theme)
    // 换主题、改任一族玻璃数字都会推过来；玻璃本身由 CSS 变量接手。
    try { window.magpie?.onTheme?.(applyTheme) } catch { /* 旧宿主没有 onTheme */ }
    return theme
  })().catch(() => null)

  return connecting
}
