// 本地状态：PAT、已绑定账号的元数据、目录快照。
//
// 存在 magpie 自己的配置目录里（宿主把 `settings.Dir()` 作为 `input.directory`
// 交给插件），文件名固定 `dragonapi-state.json`，原子写（临时文件 + rename）。
//
// **这里绝不落盘任何钥匙明文。** 钥匙本身由 magpie 的 plugin-auth.json 保管
// （那是宿主的事），这里只记「哪个账号对应哪个分组、打码后是什么样」，
// 用来在页面上把账号和钥匙对上号。PAT 是个例外——它必须明文存在本地，
// 因为每次建钥匙都要用它，而 magpie 的 auth 表存的是供应商凭据不是这个。
// PAT 只写在这个 0600 的文件里，不写日志、不回显完整值。

import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const FILE_NAME = 'dragonapi-state.json'

/** emptyState 是「什么都没配过」的样子。 */
function emptyState() {
  return {
    version: 1,
    pat: '',
    patHint: '',
    patScopes: [],
    // 已绑定的账号：key 是 magpie 的账号键（provider 或 provider#slot），
    // 记的是它对应的站点分组与打码钥匙，供页面显示。
    accounts: {},
    // 上一次成功的目录快照，冷启动时先给宿主一份非空的表。
    catalog: null,
    catalogAt: 0,
    updatedAt: 0,
  }
}

/** statePath 是状态文件的位置。 */
export function statePath(dir) {
  return join(dir || '.', FILE_NAME)
}

/** loadState 读状态；文件不存在或坏了都返回空状态，不抛。 */
export function loadState(dir) {
  const p = statePath(dir)
  if (!existsSync(p)) return emptyState()
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    if (!raw || typeof raw !== 'object') return emptyState()
    return {
      ...emptyState(),
      ...raw,
      accounts: raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {},
    }
  } catch {
    // 坏文件不能把插件带崩：当成没配过，下一次写入会覆盖它。
    return emptyState()
  }
}

/** saveState 原子写状态。写失败返回 false，不抛——状态存不下不该让插件停摆。 */
export function saveState(dir, state) {
  const p = statePath(dir)
  try {
    mkdirSync(dirname(p), { recursive: true })
    const tmp = p + '.tmp-' + process.pid
    const body = JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2)
    writeFileSync(tmp, body, { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch { /* Windows 上 chmod 基本无效，忽略 */ }
    renameSync(tmp, p)
    return true
  } catch {
    return false
  }
}

/** maskKey 把钥匙打码成 `sk-a**********9f3c`，与站点自己的写法一致。 */
export function maskKey(key) {
  const s = String(key || '')
  if (!s) return ''
  if (s.length <= 4) return '*'.repeat(s.length)
  if (s.length <= 8) return s.slice(0, 2) + '****' + s.slice(-2)
  return s.slice(0, 4) + '**********' + s.slice(-4)
}

/** tailOf 取钥匙后四位，用来在页面里把账号和站点钥匙对上号。 */
export function tailOf(key) {
  const s = String(key || '')
  return s.length >= 8 ? s.slice(-4) : ''
}
