// 本地 HTML 实时预览：改界面时用这个，不要动 magpie。
//
//   node dev.mjs                    # 127.0.0.1:3671，改 ui/ 自动刷新
//   node dev.mjs --sandbox          # 套一层 magpie 同款沙箱 iframe 再看（见下）
//   node dev.mjs --port 4000        # 换端口
//
// 它起两个东西：
//   1. 内部服务（默认 3672）：真正的 lib/service.mjs，带真实站点目录与 /api/*。
//   2. 开发服务（默认 3671）：对外。静态文件直接从 ui/ 读盘（每次请求都读，
//      所以改完立刻生效），把 /api/* 反代给内部服务，并在 index.html 里注入
//      一段「收到 /__live 事件就刷新」的脚本。
//
// 为什么要两个端口：内部服务是插件在 magpie 里跑的那一份，不能为开发改它。
// 开发服务只负责「发文件 + 注入 + 热刷新 + 代理」，这样 prod 代码保持干净。
//
// --sandbox 为什么重要：magpie 的插件页跑在 sandbox="allow-scripts" 的 iframe
// 里，安全源是不透明的（localStorage 会抛 SecurityError）。这个差异曾经造成
// 一个真实事故：顶层打开一切正常，装进 magpie 后所有接口都「连不上」。
// 所以改界面时要两种模式都看一遍，尤其是改请求、存储、导航的时候。

import { createServer } from 'node:http'
import { watch } from 'node:fs'
import { readFileSync, existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startService, serveFile } from './lib/service.mjs'
import { createCatalogSource } from './lib/catalog-source.mjs'
import { createStatusSource } from './lib/status-source.mjs'
import { loadState, saveState } from './lib/store.mjs'

const here = resolve(fileURLToPath(new URL('.', import.meta.url)))
const uiDir = join(here, 'ui')

/** 命令行参数：只认这几个，够用就行，不做通用解析。 */
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const valueOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback
}

const PORT = valueOf('--port', 3671)
const SERVICE_PORT = valueOf('--service-port', PORT + 1)
const SANDBOX = flag('--sandbox')
const SITE = process.env.DRAGONAPI_SITE || 'https://newapi.dragon3api.com'
const DIR = process.env.DRAGONAPI_DIR || join(here, '.dev-state')

/** 热刷新脚本：只在开发服务注入，生产 html 一个字节都不改。 */
const LIVE_SCRIPT = `
<script>
/* 开发预览：ui/ 里任何文件改动都会让这个页面整页重载。
   只在 node dev.mjs 下注入，打包产物里没有这段。 */
(() => {
  try {
    const es = new EventSource('/__live');
    es.addEventListener('reload', () => location.reload());
    es.addEventListener('error', () => { /* 断线由 EventSource 自己重连 */ });
  } catch (e) { /* 沙箱里 EventSource 被禁也不该影响页面 */ }
})();
</script>
`

/** 沙箱外壳：和 magpie 的插件页用同一个 sandbox 属性。 */
function harnessHtml(target) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>sandbox harness</title>
<style>html,body{margin:0;height:100%;background:#0b0d10}
iframe{border:0;width:100%;height:100vh;display:block}</style></head>
<body><iframe sandbox="allow-scripts" src="${target}"></iframe></body></html>`
}

const enc = (s) => Buffer.isBuffer(s) ? s : Buffer.from(String(s))

async function main() {
  // ── 1. 内部服务：真实目录 + 真实 /api/* ─────────────────
  const state = loadState(DIR)
  const catalog = createCatalogSource({ site: SITE })
  const status = createStatusSource({
    site: SITE,
    seed: state.status || null,
    onRead: (v) => { state.status = v; saveState(DIR, state) },
  })
  const inner = await startService({
    port: SERVICE_PORT,
    dir: DIR,
    site: SITE,
    catalog,
    status,
    getState: async () => ({
      accounts: state.accounts || {},
      pat: state.pat || '',
      patHint: state.patHint || '',
      patScopes: state.patScopes || [],
      enabledGroups: state.enabledGroups || [],
    }),
    setPat: async ({ pat, hint, scopes, user }) => {
      state.pat = pat
      state.patHint = hint
      state.patScopes = scopes
      if (user) state.user = { id: user.id, name: user.username }
      saveState(DIR, state)
    },
    // 开发预览没有 magpie 的钥匙：余额会显示 —，这是预期
    keyOf: () => '',
  })

  // ── 2. 热刷新：监听 ui/，改动就广播 ─────────────────────
  const clients = new Set()
  let timer = null
  function broadcast(reason) {
    for (const res of clients) {
      try { res.write(`event: reload\ndata: ${JSON.stringify(reason)}\n\n`) } catch { clients.delete(res) }
    }
  }
  try {
    watch(uiDir, { recursive: true }, (_event, file) => {
      // 编辑器保存常触发多次事件，压一下再广播
      clearTimeout(timer)
      timer = setTimeout(() => broadcast(String(file || 'changed')), 120)
    })
  } catch (e) {
    console.warn('[dev] 监听 ui/ 失败，热刷新不可用：' + (e?.message || e))
  }

  // ── 3. 开发服务：发文件 + 注入 + 代理 API ───────────────
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname

    // 事件流：保持连接，25 秒心跳，避免被系统掐断
    if (path === '/__live') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      })
      res.write('retry: 1000\n\n')
      clients.add(res)
      const beat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* 断开就算了 */ } }, 25000)
      req.on('close', () => { clearInterval(beat); clients.delete(res) })
      return
    }

    // API 一律反代给内部服务：界面代码走的就是 prod 那条路
    if (path.startsWith('/api/')) {
      const target = `http://127.0.0.1:${inner.port}${path}${url.search}`
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = chunks.length ? Buffer.concat(chunks) : undefined
      try {
        const upstream = await fetch(target, {
          method: req.method,
          headers: { 'content-type': req.headers['content-type'] || 'application/json' },
          body,
        })
        const text = await upstream.text()
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
          // 必须带上 CORS：--sandbox 模式下页面是不透明源（Origin: null），
          // 少这个头所有接口都会「连不上」。开发服务漏了它，沙箱模式就白做了。
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        })
        res.end(text)
      } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: `开发服务代理失败：${String(e?.message || e)}` }))
      }
      return
    }

    // 沙箱外壳
    if (path === '/__sandbox') {
      const q = url.search ? url.search : ''
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(harnessHtml(`/${q}`))
      return
    }

    // 首页：读盘后注入热刷新脚本
    if (path === '/' || path === '/index.html') {
      const file = join(uiDir, 'index.html')
      if (!existsSync(file)) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('ui/index.html 不见了')
        return
      }
      const html = readFileSync(file, 'utf8')
      const injected = html.includes('</body>')
        ? html.replace('</body>', `${LIVE_SCRIPT}</body>`)
        : html + LIVE_SCRIPT
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(enc(injected))
      return
    }

    // 其余静态：/ui/xxx 与根下 /app.js、/style.css 都从 ui/ 取
    const rel = path.startsWith('/ui/') ? path.slice(4) : path.replace(/^\/+/, '')
    if (serveFile(res, uiDir, rel)) return

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: '没有这个文件' }))
  })

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  const base = `http://127.0.0.1:${PORT}/`
  console.log('')
  console.log('  DragonAPI 本地实时预览')
  if (SANDBOX) {
    console.log('  ' + base + '__sandbox?theme=dark    —— 当前模式：沙箱 iframe（和 magpie 里一致）')
    console.log('  ' + base + '?theme=dark              —— 顶层直开（调试更快，但没有沙箱限制）')
  } else {
    console.log('  ' + base + '?theme=dark              —— 顶层直开（推荐日常改样式）')
    console.log('  ' + base + '__sandbox?theme=dark    —— 沙箱 iframe（改请求/存储/导航时看这个）')
  }
  console.log('')
  console.log('  改 ui/ 里任何文件都会自动刷新。内部服务（/api/*）在 127.0.0.1:' + inner.port)
  console.log('  状态目录：' + DIR)
  console.log('  Ctrl+C 结束')
  console.log('')

  const shutdown = async () => {
    for (const c of clients) { try { c.end() } catch { /* 已断 */ } }
    await new Promise((r) => server.close(r))
    await inner.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error('启动失败：' + (e?.message || e))
  process.exit(1)
})