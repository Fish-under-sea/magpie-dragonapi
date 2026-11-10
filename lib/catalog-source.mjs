// 目录源：/api/pricing 的缓存与刷新策略，只此一处。
//
// 为什么单独抽出来：这份数据有三处消费者——宿主要模型表、页面要模型广场、
// 独立启动模式也要。之前每处各拉各的、各缓存各的，结果是「页面点刷新刷不到
// 宿主那份」，而且三份缓存会给出三个不同的答案。现在只有一个所有者，
// 谁要都从同一个 get() 取。
//
// 三条策略：
//   1. TTL 内直接给缓存，不打站点；
//   2. 带 ETag / Last-Modified 做条件请求，命中 304 就只更新时间（站点实测认这个）；
//   3. 拉失败沿用上一次成功的快照，一次都没成功过才把错误报出去。

import { readPricing } from './site.mjs'

/** 目录多久算过期。站点目录动得不勤，五分钟足够。 */
export const DEFAULT_TTL = 5 * 60e3

/** 健康记录留几条。页面用它显示「上一次拉目录是什么时候、成没成」。 */
const HEALTH_KEEP = 12

/**
 * createCatalogSource 造一个目录源。
 *
 * @param {object} o
 * @param {string} o.site     站点根地址
 * @param {number} [o.ttl]    缓存有效期（毫秒）
 * @param {function} [o.fetchPricing] 拉取实现，测试可替换
 * @param {object} [o.stub]   固定目录，测试用；给了就不再打站点
 */
export function createCatalogSource({ site, ttl = DEFAULT_TTL, fetchPricing = readPricing, stub = null } = {}) {
  /** env 是站点 /api/pricing 的原文；source 说明它从哪来。 */
  let state = { at: 0, env: null, etag: '', lastModified: '', source: 'empty', error: '' }
  const health = []

  function note(rec) {
    health.unshift({ at: Date.now(), ...rec })
    while (health.length > HEALTH_KEEP) health.pop()
  }

  /**
   * get 取目录。force 为真时跳过 TTL（用户点刷新），但仍走条件请求——
   * 站点没变就该省掉那 89 KB。
   */
  async function get({ force = false } = {}) {
    const now = Date.now()
    if (stub) {
      state = { at: now, env: stub, etag: '', lastModified: '', source: 'live', error: '' }
      return state
    }
    if (!force && state.env && now - state.at < ttl) return state

    const startedAt = Date.now()
    try {
      const r = await fetchPricing(site, force ? {} : { etag: state.etag, lastModified: state.lastModified })
      if (r.notModified) {
        // 304：内容没变，只把「上次核对时间」推后。
        state = { ...state, at: now, source: 'live', error: '' }
      } else {
        state = { at: now, env: r.env, etag: r.etag || '', lastModified: r.lastModified || '', source: 'live', error: '' }
      }
    } catch (error) {
      state = {
        ...state,
        at: now,
        // 有旧数据就是 stale（还能用），没有才是 empty（真的什么都没有）。
        source: state.env ? 'stale' : 'empty',
        error: String(error?.message || error),
      }
    }
    note({
      ok: state.source === 'live',
      source: state.source,
      count: Array.isArray(state.env?.data) ? state.env.data.length : 0,
      ms: Date.now() - startedAt,
      error: state.error,
    })
    return state
  }

  /** snapshot 是「现在手上有什么」，不触发拉取。 */
  const snapshot = () => state

  /** recent 是最近的拉取记录，最新的在前。 */
  const recent = () => health.slice()

  return { get, snapshot, recent }
}
