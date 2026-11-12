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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_SITE, currencyOf, readTokenUsage, readTokenModels, createKey, revealKey, readKeys } from './lib/site.mjs'
import { buildCatalog } from './lib/catalog.mjs'
import { createCatalogSource } from './lib/catalog-source.mjs'
import { createStatusSource } from './lib/status-source.mjs'
import { loadState, saveState, maskKey, tailOf } from './lib/store.mjs'
import { startService } from './lib/service.mjs'

/** 供应商 id：一个就好，多账号靠 magpie 自己的账号槽。 */
const PROVIDER_ID = 'dragonapi'
/** 站点给这把钥匙起的名字前缀，便于用户在控制台认出来。 */
const KEY_NAME = 'Magpie'
/** 「优先走 Responses API」开关的 key（magpie 的 auth.options）。 */
const OPT_RESPONSES = 'responsesFirst'

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
    const r = saveState(dir, state)
    // 存不下不抛（插件不能因此停摆），但必须留痕：页面按返回值报错，日志留一份。
    if (!r.saved) console.error(`[dragonapi] 状态没能写进 ${r.path}：${r.error}`)
    return r
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
    const allowed = Array.isArray(md.allowed)
      ? md.allowed.map((v) => String(v)).filter(Boolean)
      : (Array.isArray(state.accounts[tail]?.allowed) ? state.accounts[tail].allowed : null)
    if (tail && (group || (allowed && allowed.length))) {
      const had = state.accounts[tail] || {}
      state.accounts[tail] = {
        label: String(md.label || had.label || (group ? `${group} · ${maskKey(secret)}` : maskKey(secret))),
        group,
        masked: maskKey(secret),
        tail,
        // models 是数量，allowed 是这把钥匙实际可用的模型名（不含分组前缀）。
        models: Number(md.modelCount) || Number(md.models) || had.models || (allowed ? allowed.length : 0),
        allowed: allowed || had.allowed,
        boundAt: Number(had.boundAt) || Number(md.boundAt) || Date.now(),
      }
      persist()
    }
    return { secret, tail, group, allowed: allowed || null }
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
    /**
     * preferResponses 读「走 Responses API」开关。
     *
     * 默认**开**：站点是 New API 部署，对话模型统一走 `/v1/responses`，
     * 这样 magpie 的模型设置里才会出现 Responses 协议选项（协议选项是按
     * 模型表里实际用到的协议归纳的）。关掉则退回 chat completions。
     * 旧宿主不提供 option 时按默认（开）处理。
     */
    preferResponses() {
      try {
        const v = input?.magpie?.option?.(PROVIDER_ID, OPT_RESPONSES)
        return v === undefined || v === null ? true : v === true
      } catch { return true }
    },
    noteModelsError: (why) => { state.lastModelsError = why },
  }
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
      patVerified: ctx.state.patVerified === true,
      enabledGroups: ctx.state.enabledGroups || [],
    }),
    setPat: async ({ pat, hint, scopes, user, verified }) => {
      ctx.state.pat = pat
      ctx.state.patHint = hint
      ctx.state.patScopes = scopes
      ctx.state.patVerified = verified === true
      if (user) ctx.state.user = { id: user.id, name: user.username }
      // 把落盘结果交回去：写失败时页面必须知道，不能弹「已保存」。
      return ctx.persist()
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
      /**
       * options 是 magpie 自己的开关声明（OpenCode 不读）。用户在插件编辑器里
       * 打开后，声明了 openai-response 的模型改用 Responses API。
       */
      options: [
        {
          key: OPT_RESPONSES,
          label: '走 Responses API',
          description: '默认走 Responses API（模型设置里可看到 Responses 协议）；关掉退回 chat completions。',
          default: true,
        },
      ],
      get icon() {
        // 站点图标（Ciallo 立绘）：包内 png 编成 data URI。宿主只收 https 与
        // data:image，联网抓会在断网时变成灰书页。
        //
        // 不能拼 `new URL('.', import.meta.url).pathname`：Windows 上 pathname
        // 是 `/C:/...`，join 出来是 `\C:\...`，读不到文件，供应商图标就退成
        // 灰方块。ctx.dir 在宿主里是配置目录，不是包目录，也不能当包根用。
        const roots = []
        try { roots.push(dirname(fileURLToPath(import.meta.url))) } catch { /* 不是 file URL */ }
        if (ctx.dir) roots.push(String(ctx.dir))
        for (const root of roots) {
          try {
            const png = readFileSync(join(root, 'page', 'icon.png'))
            return 'data:image/png;base64,' + png.toString('base64')
          } catch { /* 换下一个根目录 */ }
        }
        return ''
      },

      get methods() {
        const out = [
          {
            type: 'api',
            label: 'DragonAPI API Key',
            // 自己问 key（KeyAsked）：这样 authorize 能拿到输入、先向站点验证，
            // 而不是宿主把任意字符串当成钥匙存下来、再给它挂上整张目录。
            prompts: [
              { type: 'password', key: 'key', message: 'DragonAPI API Key', placeholder: 'sk-…' },
            ],
            async authorize(inputs) {
              const key = String(inputs?.key || inputs?.apiKey || inputs?.token || '').trim()
              if (!key) throw new Error('请填写 DragonAPI 的 sk- 钥匙')
              return authorizeKey(ctx, key)
            },
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
          // 不写 baseURL：每个模型在自己 api.url 上按自己的协议（openai/
          // anthropic/gemini）发请求。全局 base 会把所有模型压回同一个协议。
          fetch: async (input_, init) => {
            // 每个模型按自己的协议发出：OpenAI 兼容把模型放在 body 里，
            // Gemini 放在 URL 的 /models/<模型>:generateContent 里，
            // Anthropic 又在 body 里。所以两处都要还原裸模型名。
            const href = (() => {
              try { return String(typeof input_ === 'string' ? input_ : input_?.url || '') } catch { return '' }
            })()

            /** bareModel 去掉 `分组/` 前缀，只留站点认的模型名。 */
            const bareModel = (v) => {
              if (typeof v !== 'string' || !v.includes('/')) return ''
              const cut = v.indexOf('/')
              return v.slice(cut + 1)
            }

            // Gemini：/v1beta/models/<id>:generateContent，id 可能被 URL 编码成 %2F
            let nextHref = href
            if (href.includes('/models/')) {
              const q = href.indexOf('?')
              const head = q < 0 ? href : href.slice(0, q)
              const tail = q < 0 ? '' : href.slice(q)
              const marker = '/models/'
              const at = head.indexOf(marker)
              if (at >= 0) {
                const after = head.slice(at + marker.length)
                const decoded = decodeURIComponent(after)
                // `模型:generateContent` —— 冒号后面是动作，只能编码模型名那一段。
                const colon = decoded.lastIndexOf(':')
                const namePart = colon < 0 ? decoded : decoded.slice(0, colon)
                const action = colon < 0 ? '' : decoded.slice(colon)
                const bare = bareModel(namePart)
                if (bare && bare !== namePart) {
                  nextHref = head.slice(0, at + marker.length) + encodeURIComponent(bare) + action + tail
                }
              }
            }

            const body = init?.body
            if (typeof body !== 'string') {
              return nextHref !== href ? fetch(nextHref, init) : fetch(input_, init)
            }
            let parsed
            try { parsed = JSON.parse(body) } catch {
              return nextHref !== href ? fetch(nextHref, init) : fetch(input_, init)
            }
            const bare = bareModel(parsed?.model)
            if (!bare) return nextHref !== href ? fetch(nextHref, init) : fetch(input_, init)
            // `分组/模型` → `模型`。分组已经由账号选定了，请求里不需要它。
            parsed.model = bare
            const url = nextHref !== href ? nextHref : input_
            return fetch(url, { ...init, body: JSON.stringify(parsed) })
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
        let allowed = null
        try {
          const auth = hookCtx?.auth
          const found = ctx.remember(auth)
          group = found?.group || ''
          allowed = Array.isArray(found?.allowed) ? found.allowed : null
        } catch { /* auth 形状不对就按「无分组」处理 */ }

        try {
          const cat = await ctx.catalog.get({})
          const st = await ctx.status.get({})
          const cur = currencyOf(st)
          const built = cat.env
            ? buildCatalog(cat.env, { cur, enabledGroups: [], site: ctx.site, preferResponses: ctx.preferResponses() })
            : { models: {}, rows: [], groups: [] }

          // 保护 1：列表单调不减。站点偶发少给几个模型时用上一次实时表补齐，
          // 否则宿主会把这些「消失」的模型从用户选择里移除。
          let table = group ? pickGroup(built.models, group) : built.models
          // 用户手动添加的钥匙：只留 /v1/models 说它能用的那些，而不是整组目录。
          if (allowed && allowed.length) table = pickAllowed(table, allowed, group)
          const lastGood = ctx.memory.lastGood
          // allowed 是站点对这把钥匙的精确授权：不能再把上一次的全组表补回来，
          // 否则「只导入钥匙包含的模型」又被 lastGood 破坏了。
          if (lastGood && !(allowed && allowed.length)) {
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

/** pickAllowed 只留钥匙在站点上真正可用的模型，按裸模型名去重。 */
function pickAllowed(models, allowed, group) {
  const want = new Set(allowed.map((v) => String(v)))
  const seen = new Set()
  const out = {}
  for (const [id, m] of Object.entries(models)) {
    const cut = id.indexOf('/')
    const bare = cut >= 0 ? id.slice(cut + 1) : id
    if (!want.has(bare)) continue
    if (group && (cut < 0 || id.slice(0, cut) !== group)) continue
    if (seen.has(bare)) continue
    seen.add(bare)
    out[id] = m
  }
  return out
}

/**
 * authorizeKey 验证一把 sk- 钥匙，并算出它实际能用的模型。
 *
 * 站点 `/api/usage/token/` 是钥匙可访问的，用它做鉴权；模型列表用
 * `/v1/models` 拿（会按分组、model_limits、启用状态过滤）。只把交集写进
 * auth metadata，provider.models 之后就不会再给整张目录。
 */
async function authorizeKey(ctx, key) {
  let usage
  try {
    usage = await readTokenUsage(ctx.site, key)
  } catch (e) {
    throw new Error(`钥匙验证失败：${String(e?.message || e)}。请确认这是 DragonAPI 的 sk- 钥匙，且没有被禁用/过期。`)
  }
  let allowed = []
  let modelsError = ''
  try {
    allowed = await readTokenModels(ctx.site, key)
  } catch (e) {
    modelsError = String(e?.message || e)
  }
  // 站点没开 /v1/models 时，model_limits 是同一把钥匙的授权清单，可以兜底；
  // 两者都没有才拒绝，不能因为接口缺失就把有效钥匙挡在门外。
  if (!allowed.length && usage.modelLimitsEnabled && usage.modelLimits) {
    allowed = Object.keys(usage.modelLimits)
  }
  if (usage.modelLimitsEnabled && usage.modelLimits) {
    const limits = Object.keys(usage.modelLimits)
    if (limits.length && allowed.length) {
      const set = new Set(limits)
      allowed = allowed.filter((m) => set.has(m))
    }
  }
  if (!allowed.length) {
    throw new Error(modelsError
      ? `钥匙有效，但读不到它的模型：${modelsError}`
      : '这把钥匙在站点上没有可用模型：先在控制台给它开放模型/分组，再重新添加。')
  }

  const cat = await ctx.catalog.get({})
  const st = await ctx.status.get({})
  const built = cat.env
    ? buildCatalog(cat.env, { cur: currencyOf(st), enabledGroups: [], site: ctx.site, preferResponses: ctx.preferResponses() })
    : { models: {} }
  const known = new Set(Object.keys(built.models).map((id) => {
    const cut = id.indexOf('/')
    return cut >= 0 ? id.slice(cut + 1) : id
  }))
  allowed = [...new Set(allowed.filter((m) => known.has(m)))]
  if (!allowed.length) {
    throw new Error('站点返回的模型和当前模型目录对不上，稍后重试；如果一直这样，把插件页面里的模型目录刷新一次。')
  }

  const tail = tailOf(key)
  let group = ''
  if (ctx.state.pat) {
    try {
      const keys = await readKeys(ctx.site, ctx.state.pat)
      const hit = keys.find((k) => k.key && tail && k.key.endsWith(tail))
      if (hit?.group) group = hit.group
    } catch { /* 没有 PAT 或不给读列表，就走下面的模型匹配 */ }
  }
  if (!group) {
    const want = new Set(allowed)
    const score = new Map()
    for (const id of Object.keys(built.models)) {
      const cut = id.indexOf('/')
      if (cut < 0) continue
      const g = id.slice(0, cut)
      const bare = id.slice(cut + 1)
      if (!want.has(bare)) continue
      score.set(g, (score.get(g) || 0) + 1)
    }
    group = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || ''
  }

  return {
    type: 'success',
    key,
    metadata: {
      group,
      label: group ? `${group} · ${maskKey(key)}` : maskKey(key),
      masked: maskKey(key),
      tail,
      boundAt: Date.now(),
      modelCount: allowed.length,
      allowed,
    },
  }
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
