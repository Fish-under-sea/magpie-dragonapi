// 站点参数源：/api/status 的缓存与降级。
//
// 与目录源分开，因为它们的失效策略不同：目录变了要重列模型，站点参数
// （币种、汇率、额度折算）变了只影响「钱怎么印」，不需要惊动宿主。
//
// 降级原则只有一条：读不到就沿用上一次成功的值，一次都没成功过才用默认值。
// 绝不把 quota_per_unit 退成 1——那会把额度原值当金额，余额直接放大五十万倍。

import { readStatus } from './site.mjs'

/** 站点参数多久算过期。这些几乎不变，十分钟足够。 */
export const DEFAULT_TTL = 10 * 60e3

/**
 * createStatusSource 造一个站点参数源。
 *
 * @param {object} o
 * @param {string} o.site
 * @param {object} [o.seed]  上次落盘的参数（冷启动先顶上，别让页面等）
 * @param {function} [o.fetchStatus]
 * @param {function} [o.onRead]  读到新值时回调（用来落盘）
 */
export function createStatusSource({ site, seed = null, fetchStatus = readStatus, onRead } = {}) {
  let state = { at: 0, value: seed || null, error: '' }

  async function get({ force = false } = {}) {
    const now = Date.now()
    if (!force && state.value && now - state.at < DEFAULT_TTL) return state.value
    try {
      const v = await fetchStatus(site)
      state = { at: now, value: v, error: '' }
      try { onRead?.(v) } catch { /* 落盘失败不影响这次读取 */ }
      return v
    } catch (error) {
      state = { ...state, at: now, error: String(error?.message || error) }
      return state.value
    }
  }

  const snapshot = () => state.value
  const lastError = () => state.error

  return { get, snapshot, lastError }
}
