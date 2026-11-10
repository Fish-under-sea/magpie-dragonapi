// DragonAPI 的 magpie 宿主部分：一个 OpenCode 形状的 provider 插件。
//
// 它不碰 magpie 源码，用的都是 magpie 自己提供的扩展点：
//
//   config            声明供应商（名字、npm、base）
//   auth.methods      两种登录：贴 sk- 钥匙 / 用 PAT 自动建钥匙
//   auth.usage        余额，按 magpie 的用量卡显示
//   auth.loader       请求带着这把钥匙出去，并把 `分组/模型` 还原成站点的模型名
//   provider.models   模型目录：`分组/模型` 一行，每行属于一个分组
//
// 与 NearToken 最大的不同：DragonAPI 不读请求头里的分组，分组是**钥匙的属性**。
// 所以这里的模型 id 带分组前缀，而「走哪个分组」由 magpie 的账号选择决定——
// 每个账号（一把钥匙）的 models 清单只列它那一组的模型，宿主就不会把模型发错账号。
//
// 另外它起一个只监听 127.0.0.1 的本地服务：magpie 的插件页是 connect-src 'none'
// 的沙箱，页面自己发不出任何请求，只能把自己导航过去。界面由那个服务提供。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_SITE, currencyOf, readTokenUsage, createKey, revealKey, readKeys } from './lib/site.mjs'
import { buildCatalog } from './lib/catalog.mjs'
import { createCatalogSource } from './lib/catalog-source.mjs'
import { createStatusSource } from './lib/status-source.mjs'
import { loadState, saveState, maskKey, tailOf } from './lib/store.mjs'
import { startService } from './lib/service.mjs'

/** 供应商 id：一个就好，多账号靠 magpie 自己的账号槽。 */
const PROVIDER_ID = 'dragonapi'
/** 站点给这把钥匙起的名字前缀，便于用户在控制台认出来。 */
const KEY_NAME = 'Magpie'

/**
 * 插件状态。全部放在闭包里，一个进程一份。
 *
 * 这里刻意不存钥匙明文到磁盘：钥匙由 magpie 的 plugin-auth.json 保管，
 * 我们只在内存里留一份 `tail → 钥匙` 的映射，供本地服务查余额用。
 * 进程重启后由第一次 models() 调用重新填上。
 *
 * 目录与站点参数不在这里缓存：它们各有自己的源（catalog-source /
 * status-source），插件和本地服务共用同一份，避免两处真相。
 */
function makeContext(input, options) {
  const dir = String(input?.directory || '.')
  const site = String(options?.site || DEFAULT_SITE).replace(/\/+$/, '')
  const port = Number(options?.port) > 0 ? Number(options.port) : 3517

  const state = loadState(dir)
  /** 内存里的钥匙：tail → 明文。不落盘。 */
  const secrets = new Map()
  /**
   * 上一次「站点实时」拿到的模型表，用于列表单调不减。
   *
   * 它必须挂在 ctx 上，不能是 makeContext 里的局部变量：provider.models
   * 定义在返回的对象里，闭包看不到 makeContext 的局部变量，直接引用会
   * 抛 ReferenceError——而那个错误被 catch 吞成空表，表现就是「插件一个
   * 模型都没有」，完全查不出原因。
   */
  const memory = { lastGood: null }

  // catalogStub 只给测试用：注入一份固定目录，不打站点。
  const catalog = createCatalogSource({ site, stub: options?.catalogStub || null })
  const status = createStatusSource({
    site,
    // 冷启动先用上次落盘的值顶上，别让页面等一次网络往返。
    seed: state.status || null,
    onRead: (v) => { state.status = v; saveState(dir, state) },
  })

  function persist() {
    saveState(dir, state)
  }

  /** 从一份 auth 里把钥匙记进内存，并把账号元数据补进 state。 */
  function remember(auth) {
    if (!auth) return null
    const secret = String(auth.key || auth.access || '')
    if (!secret) return null
    const tail = tailOf(secret)
    if (tail) secrets.set(tail, secret)
    const md = auth.metadata && typeof auth.metadata === 'object' ? auth.metadata : {}
    const group = String(md.group || '')
    if (tail && group) {
      const had = state.accounts[tail] || {}
      state.accounts[tail] = {
        label: String(md.label || had.label || `${group} · ${maskKey(secret)}`),
        group,
        masked: maskKey(secret),
        tail,
        models: Number(md.models) || had.models || 0,
        boundAt: Number(had.boundAt) || Number(md.boundAt) || Date.now(),
      }
      persist()
    }
    return { secret, tail, group }
  }

  return {
    dir,
    site,
    port,
    state,
    secrets,
    memory,
    persist,
    remember,
    catalog,
    status,
    noteModelsError: (why) => { state.lastModelsError = why },
  }
}

/** 让本地服务能拿到某个账号的钥匙（按 tail）。 */
export function keyForTail(ctx, tail) {
  return ctx.secrets.get(String(tail || '')) || ''
}

export default async function dragonapi(input, options) {
  void input
  const ctx = makeContext(input, options)

  // 预热目录与站点参数，但**绝不等它**。
  //
  // 宿主的插件加载有 20 秒上限（实测报错：the plugin's load didn't finish in 20s）。
  // 之前这里 `await Promise.all([...])` 等站点，网络一慢就把整个插件的加载拖死，
  // 表现是插件行直接标「没有加载成功」——而服务其实已经起来了，页面还能开，
  // 只是宿主判定它加载失败。这两件事的因果很容易看错。
  //
  // 预热只是省掉第一次 models() 的等待，失败了也不影响任何功能：
  // models() 自己会取，而且它本来就允许慢。
  void Promise.allSettled([ctx.status.get({}), ctx.catalog.get({})])

  // 本地服务：页面的真正宿主。起不来也不能让供应商消失，所以失败只记一笔。
  let service = null
  const serviceReady = startService({
    port: ctx.port,
    dir: ctx.dir,
    site: ctx.site,
    // 目录与站点参数各有唯一所有者，服务只消费，不自己缓存。
    catalog: ctx.catalog,
    status: ctx.status,
    // 本地服务查余额要用某个账号的钥匙。钥匙只在内存里，按 tail 取。
    keyOf: (tail) => ctx.secrets.get(String(tail || '')) || '',
    getState: async () => ({
      accounts: ctx.state.accounts,
      pat: ctx.state.pat,
      patHint: ctx.state.patHint,
      patScopes: ctx.state.patScopes,
      enabledGroups: ctx.state.enabledGroups || [],
    }),
    setPat: async ({ pat, hint, scopes, user }) => {
      ctx.state.pat = pat
      ctx.state.patHint = hint
      ctx.state.patScopes = scopes
      if (user) ctx.state.user = { id: user.id, name: user.username }
      ctx.persist()
    },
  })
    .then((s) => {
      service = s
      console.log(`[dragonapi] 本地服务已就绪 http://127.0.0.1:${s.port}`)
      return s
    })
    .catch((e) => {
      console.error('[dragonapi] 本地服务起不来：' + (e?.message || e))
      return null
    })
  // 让本地服务能找到钥匙：它不能直接读这个闭包，所以注入一个取值函数。
  void serviceReady
  void service

  return {
    /**
     * config 声明供应商。任何一步失败都不能让 provider 消失：
     * 宿主拿不到声明就当成没这个供应商。
     */
    async config(cfg) {
      try {
        if (!cfg || typeof cfg !== 'object') return
        cfg.provider ??= {}
        cfg.provider[PROVIDER_ID] ??= {}
        const p = cfg.provider[PROVIDER_ID]
        p.name = 'DragonAPI'
        if (!p.npm) p.npm = '@ai-sdk/openai-compatible'
        if (!p.api) p.api = ctx.site + '/v1'
        // 不要声明 models：空对象会被理解成「这个供应商声明的模型是 0 个」。
        delete p.models
      } catch { /* 声明失败也不能抛 */ }
    },

    auth: {
      provider: PROVIDER_ID,
      get icon() {
        // 站点图标：包内 svg 编成 data URI。宿主只收 https 与 data:image，
        // 联网抓会在断网时变成灰书页。
        try {
          const svg = readFileSync(join(ctx.dir, 'page', 'icon.svg'))
          return 'data:image/svg+xml;base64,' + svg.toString('base64')
        } catch {
          try {
            const here = new URL('.', import.meta.url).pathname
            const svg = readFileSync(join(here, 'page', 'icon.svg'))
            return 'data:image/svg+xml;base64,' + svg.toString('base64')
          } catch { return '' }
        }
      },

      get methods() {
        const out = [
          {
            type: 'api',
            label: 'DragonAPI API Key',
            placeholder: 'sk-…',
            // 不写 authorize：宿主直接把用户粘的钥匙存下来，这是最常见也最稳的路。
          },
        ]
        // 有 PAT 才出现第二条：用访问令牌按分组建一把新钥匙，并自动绑成账号。
        // 这是「在插件里建钥匙」真正可用的形态——页面能建钥匙，但页面写不了
        // magpie 的账号表，只有走这里的 authorize 才能既建又绑。
        if (ctx.state.pat) {
          out.push({
            type: 'api',
            keyless: true,
            label: '用访问令牌按分组自动建钥匙',
            placeholder: '',
            async ask(inputs) {
              if (inputs && inputs.group) return null
              const groups = await groupChoices(ctx)
              if (!groups.length) {
                throw new Error('读不到可用的分组：请先在插件页面里设置访问令牌（需要 profile:read 权限）')
              }
              return {
                type: 'select',
                key: 'group',
                message: '这把新钥匙建在哪个分组？分组决定它能调哪些模型、按什么倍率计费',
                options: groups.map((g) => ({ label: `${g}${ratioHint(ctx, g)}`, value: g })),
              }
            },
            async authorize(inputs) {
              const group = String(inputs?.group || '').trim()
              if (!group) throw new Error('没有选分组')
              const pat = ctx.state.pat
              if (!pat) throw new Error('还没有设置访问令牌（PAT）')
              const name = `${KEY_NAME}-${group}`.slice(0, 50)
              try {
                await createKey(ctx.site, pat, { name, group, unlimited: true })
                const keys = await readKeys(ctx.site, pat)
                const made = keys.find((k) => k.name === name && k.group === group)
                if (!made) throw new Error('钥匙建好了，但没能在列表里找到它')
                const secret = await revealKey(ctx.site, pat, made.id)
                const tail = tailOf(secret)
                if (tail) ctx.secrets.set(tail, secret)
                return {
                  type: 'success',
                  key: secret,
                  metadata: {
                    group,
                    label: `${group} · ${maskKey(secret)}`,
                    masked: maskKey(secret),
                    tail,
                    boundAt: Date.now(),
                  },
                }
              } catch (e) {
                throw new Error(`自动建钥匙失败：${String(e?.message || e)}。可以改用「DragonAPI API Key」，到控制台建一把再粘进来。`)
              }
            },
          })
        }
        return out
      },

      /** 余额：站点给这把钥匙的额度。 */
      async usage(getAuth) {
        try {
          const auth = await getAuth()
          const found = ctx.remember(auth)
          const key = found?.secret
          if (!key) throw new Error('还没有连接 DragonAPI')
          const [st, u] = await Promise.all([ctx.status.get({}), readTokenUsage(ctx.site, key)])
          const cur = currencyOf(st)
          const used = Number(u.used) || 0
          return {
            user: u.name || '',
            balance: fmt(u.available, cur),
            windows: [
              { name: '已用', display: fmt(used, cur) },
              // 钥匙允许查用户额度时才有这个窗口；没有就不给，别编一个 0。
              ...(u.userQuota ? [{ name: '账户余额', display: fmt(u.userQuota.available, cur) }] : []),
            ],
          }
        } catch (e) {
          throw new Error(String(e?.message || e))
        }
      },

      /** 请求带着这把钥匙出去，并把 `分组/模型` 还原成站点认的模型名。 */
      async loader(getAuth) {
        const auth = await getAuth()
        const found = ctx.remember(auth)
        const key = found?.secret || ''
        return {
          apiKey: key,
          baseURL: ctx.site + '/v1',
          fetch: async (input_, init) => {
            const body = init?.body
            if (typeof body !== 'string') return fetch(input_, init)
            let parsed
            try { parsed = JSON.parse(body) } catch { return fetch(input_, init) }
            const raw = parsed?.model
            if (typeof raw !== 'string' || !raw.includes('/')) return fetch(input_, init)
            // `分组/模型` → `模型`。分组已经由账号选定了，请求里不需要它。
            const bare = raw.slice(raw.indexOf('/') + 1)
            if (!bare) return fetch(input_, init)
            parsed.model = bare
            return fetch(input_, { ...init, body: JSON.stringify(parsed) })
          },
        }
      },
    },

    provider: {
      id: PROVIDER_ID,
      /**
       * 模型表：`分组/模型` 一行。
       *
       * 宿主会为**每个账号**各调一次，并带上那个账号的 auth（`ctx.auth`）。
       * 所以我们只返回该账号所属分组的模型：宿主的 AccountServes 就会把
       * 请求送到对的账号，不需要任何请求头。
       *
       * 没有任何账号时返回全量目录，让用户先看到「这个供应商有什么」。
       */
      async models(_given, hookCtx) {
        let group = ''
        try {
          const auth = hookCtx?.auth
          const found = ctx.remember(auth)
          group = found?.group || ''
        } catch { /* auth 形状不对就按「无分组」处理 */ }

        try {
          const cat = await ctx.catalog.get({})
          const st = await ctx.status.get({})
          const cur = currencyOf(st)
          const built = cat.env
            ? buildCatalog(cat.env, { cur, enabledGroups: [], site: ctx.site })
            : { models: {}, rows: [], groups: [] }

          // 保护 1：列表单调不减。站点偶发少给几个模型时用上一次实时表补齐，
          // 否则宿主会把这些「消失」的模型从用户选择里移除。
          let table = group ? pickGroup(built.models, group) : built.models
          const lastGood = ctx.memory.lastGood
          if (lastGood) {
            for (const id of Object.keys(lastGood)) {
              if (!table[id] && (!group || id.startsWith(group + '/'))) table[id] = lastGood[id]
            }
          }

          // 保护 2：本次不是实时数据时打标记，宿主看到 magpie.fellBack 就跳过
          // 「谁不见了」的对比，避免把网络抖动当成模型下架。
          if (cat.source !== 'live') {
            try { table[Symbol.for('magpie.fellBack')] = true } catch { /* 标记失败不影响返回 */ }
          } else if (Object.keys(table).length) {
            ctx.memory.lastGood = { ...(lastGood || {}), ...table }
          }

          // 顺手把这个账号有多少模型记下来，页面要用。
          if (group) {
            const tail = tailOf(String(hookCtx?.auth?.key || hookCtx?.auth?.access || ''))
            if (tail && ctx.state.accounts[tail]) {
              ctx.state.accounts[tail].models = Object.keys(table).length
              ctx.persist()
            }
          }

          return table
        } catch (error) {
          // 绝不向宿主抛 rejected Promise（抛了宿主就判「没有模型」→ 掉供应商），
          // 但也绝不静默吞掉：空表等于告诉宿主「这个供应商一个模型都没有」，
          // 效果和抛错一样糟，而且完全查不出原因。所以：
          //   1. 把错误打进日志与健康记录，能查；
          //   2. 手上还有上一次的表就把它交出去，最差也要有个表。
          const why = String(error?.message || error)
          console.error('[dragonapi] provider.models 失败：' + why)
          ctx.noteModelsError(why)
          const last = ctx.memory.lastGood
          return last && (!group || Object.keys(last).some((id) => id.startsWith(group + '/')))
            ? pickGroupIf(last, group)
            : {}
        }
      },
    },

    /**
     * 只给测试用：读上一次 provider.models 的错误。
     *
     * 生产路径里这个错误已经进了 console.error 与状态文件；但单测需要一个
     * 能断言的入口，否则「出错时静默返回空表」这类 bug 又只能靠人眼发现。
     */
    get __lastModelsError() {
      return ctx.state.lastModelsError || ''
    },

    /**
     * 停掉本地服务。
     *
     * 这个服务的句柄会让进程的事件循环一直活着，所以必须能关——测试里
     * 每建一个插件实例就多一个监听端口，不关的话 `node --test` 永远不退出。
     * 宿主侧也用得上：卸载插件时应当把端口还回去。
     */
    async dispose() {
      const s = await serviceReady
      if (s) await s.close()
    },
  }
}

/** 只留某个分组的模型。 */
function pickGroup(models, group) {
  const out = {}
  const prefix = group + '/'
  for (const [id, m] of Object.entries(models)) if (id.startsWith(prefix)) out[id] = m
  return out
}

/** pickGroupIf：group 为空时返回整表，否则只留那一组。 */
function pickGroupIf(models, group) {
  return group ? pickGroup(models, group) : { ...models }
}

/** 金额：读不到站点参数时也不把额度原值当钱。 */
function fmt(quota, cur) {
  const n = Number(quota)
  if (!Number.isFinite(n)) return '—'
  const base = n / (cur.per > 0 ? cur.per : 1)
  const value = cur.display && cur.rate > 0 ? base * cur.rate : base
  return cur.symbol + value.toFixed(2)
}

/** 可建钥匙的分组。优先问站点（用户实际可用的），失败就退回目录里的分组。 */
async function groupChoices(ctx) {
  if (ctx.state.pat) {
    try {
      const { readUsableGroups } = await import('./lib/site.mjs')
      const list = await readUsableGroups(ctx.site, ctx.state.pat)
      if (list.length) return list
    } catch { /* 退回目录 */ }
  }
  const cat = ctx.catalog.snapshot()
  const ratios = cat.env?.group_ratio && typeof cat.env.group_ratio === 'object' ? cat.env.group_ratio : {}
  return Object.keys(ratios).filter((g) => g !== 'auto')
}

/** 分组后面跟一个倍率提示，帮用户选。 */
function ratioHint(ctx, group) {
  const cat = ctx.catalog.snapshot()
  const ratios = cat.env?.group_ratio && typeof cat.env.group_ratio === 'object' ? cat.env.group_ratio : {}
  const r = Number(ratios[group])
  return Number.isFinite(r) && r > 0 ? ` ×${Math.round(r * 10000) / 10000}` : ''
}
