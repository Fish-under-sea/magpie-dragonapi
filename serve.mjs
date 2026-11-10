// 独立启动本地服务，不依赖 magpie 的插件宿主。
//
// 用法：node serve.mjs
//
// 存在的意义：插件宿主被别的插件拖慢、或者根本没起来时，界面就打不开。
// 这时可以用这个脚本单独把服务拉起来。它和插件起的是同一个服务，读同一份
// 状态文件，所以不会打架——但两个一起跑会抢端口，所以先探测一下。
//
// 注意：单独起的服务**没有 magpie 的账号钥匙**，余额与用量会显示为「—」，
// 模型广场、密钥管理、PAT 这些照常可用。钥匙只有插件进程才知道。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

import { startService } from './lib/service.mjs'
import { createCatalogSource } from './lib/catalog-source.mjs'
import { createStatusSource } from './lib/status-source.mjs'
import { loadState, saveState } from './lib/store.mjs'

const CANDIDATES = [3517, 3518, 3519, 3520]
const SITE = process.env.DRAGONAPI_SITE || 'https://newapi.dragon3api.com'

/** 探测是否已经有一个服务在跑。 */
async function alreadyRunning() {
  for (const p of CANDIDATES) {
    try {
      const res = await fetch('http://127.0.0.1:' + p + '/api/ping', { signal: AbortSignal.timeout(800) })
      if (res.ok) {
        const j = await res.json().catch(() => null)
        if (j && j.ok) return { port: p, version: j.version }
      }
    } catch { /* 这个端口没有 */ }
  }
  return null
}

/** 猜 magpie 的配置目录：插件宿主会把它作为 input.directory 交进来。 */
function guessDir() {
  const candidates = []
  if (process.env.DRAGONAPI_DIR) candidates.push(process.env.DRAGONAPI_DIR)
  const xdg = String(process.env.XDG_CONFIG_HOME || '').trim()
  if (xdg) candidates.push(join(xdg, 'magpie'))
  candidates.push(join(homedir(), '.config', 'magpie'))
  if (process.platform === 'win32') {
    const appdata = String(process.env.APPDATA || '').trim()
    if (appdata) candidates.push(join(appdata, 'magpie'))
  }
  for (const d of candidates) {
    if (existsSync(join(d, 'plugins.json'))) return d
  }
  return candidates[candidates.length - 1]
}

const alive = await alreadyRunning()
if (alive) {
  console.log('')
  console.log('  界面服务已经在运行了')
  console.log('  地址: http://127.0.0.1:' + alive.port + '  (版本 ' + (alive.version || '?') + ')')
  console.log('  不需要再起一个，直接去 magpie 里打开「DragonAPI」即可。')
  console.log('')
  process.exit(0)
}

const dir = guessDir()
const state = loadState(dir)

// 与插件同一套源，只是没有钥匙：余额会显示「—」。
const catalog = createCatalogSource({ site: SITE })
const status = createStatusSource({
  site: SITE,
  seed: state.status || null,
  onRead: (v) => { state.status = v; saveState(dir, state) },
})

const info = await startService({
  port: 3517,
  dir,
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
    saveState(dir, state)
  },
  // 单独跑时没有 magpie 的钥匙，余额会显示为 —。
  keyOf: () => '',
}).catch((e) => {
  console.error('启动失败:', e?.message || e)
  process.exit(1)
})

console.log('')
console.log('  DragonAPI 界面服务已就绪')
console.log('  地址: http://127.0.0.1:' + info.port)
console.log('  配置目录: ' + dir)
console.log('  这个窗口最小化即可，关掉服务就停了')
console.log('')

process.on('SIGINT', async () => { await info.close(); process.exit(0) })
