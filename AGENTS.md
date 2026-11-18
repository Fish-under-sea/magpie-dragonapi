# DragonAPI in Magpie —— 项目约定与经验

## 命名：包名 / 供应商标识 / 插件头部 三者分清，不要混用
- **npm 包名 + 插件管理器卡片**：`package.json.name` = `@fish-under-sea/magpie-dragonapi`；`magpie.name` 也用包名，插件列表里要能认出这是哪个包。
- **供应商列表显示名**：`index.mjs` 的 `config` 里 `p.name = 'DragonAPI'`。图二「来自插件」的供应商卡显示产品名，不是包名。
- **插件内部头部与侧边栏页面名**：`magpie.page.title` / `magpie.page.titles.*` 和 `ui/index.html` 的 `<h1>` = `DragonAPI`。
- 改其中一处时先确认改的是哪一层，不要「顺手」把另一层一起改掉。

## 图标：供应商图标与侧边栏图标必须区分
- 供应商/插件卡图标：`magpie.icon` = `page/icon.png`（品牌头像）。
- 侧边栏页面图标：`magpie.page.icon` = `page/star.png`（空心五角星）。
- 星标要求：**纯白、粗描边**。用 Pillow 超采样（1024 → 256），`stroke≈128/1024`（约 32px@256）、圆角接头；细描边缩小后会发灰，不要用。
- 不要把 `page/star.png` 同时用作供应商图标，否则两处无法区分。
- `index.mjs` 的 `auth.icon` 读包内 PNG 时必须用 `dirname(fileURLToPath(import.meta.url))`；**不要**用 `new URL('.', import.meta.url).pathname`（Windows 得到 `/C:/...`，join 后读不到文件），也不要把 `ctx.dir`（宿主配置目录）当包根。读不到会退成灰方块，供应商列表里非常显眼。

## 手动 sk- 钥匙：先验证，再只导入它自己的模型
- `auth.methods` 里 `type: 'api'` 的手动钥匙必须带 `prompts`（自己问 key）和 `authorize`；没有 authorize 时宿主会把任意字符串直接存成账号，并给它挂整张模型目录。
- `authorize` 先用 `/api/usage/token/` 验钥匙（无效/禁用/过期直接抛错），再用 `/v1/models` 取这把钥匙真正可用的模型；`/v1/models` 缺失时用 `usage.model_limits` 兜底，两者都没有就拒绝。
- 把裸模型名写进 metadata 的 `allowed`；`provider.models` 用 `pickAllowed` 过滤，并且**不能再让 `lastGood` 把整组模型补回来**，否则「只导入钥匙包含的模型」会被上一次的缓存破坏。
- 分组可由 PAT 的 `/api/token/` 列表按 key 尾号匹配，匹配不到再用可用模型与目录做交集打分；分组只用于展示/排序，最终请求仍由钥匙自己的分组决定。

## 液态玻璃（Magpie 2.4.0+）
- 插件页是跳到本地服务的，一跳转宿主 bridge 就没了：`page/boot.js` 必须把 `_magpie/bridge.js` 的 http(s) 地址随 URL 带给 `ui/host.js` 重新加载，否则 `magpie.glass` / `--magpie-glass-*` / `data-magpie-glass` 永远不出现。
- 根元素绝不能声明深色 `color-scheme`：Chromium 会给文档画一层不透明的 `#121212` 画布，iframe 里的宿主壁纸被挡住，玻璃只剩深色实底。根固定 `color-scheme: normal !important`，深色交给 `body` 的 `color-scheme`（实测；meta color-scheme 也要保持 light）。
- 玻璃规则一律带 `fill 100% / blur 0px` 回退，并挂在 `html[data-magpie-glass]` 下；不写死 blur，玻璃关着时页面必须与改动前逐像素一致。
- 画布照抄 content 的 fill（0 就是真透）：**绝不能给整页加一层底**，否则宿主壁纸被压成一大块灰色遮罩（2026-11-18 实机反馈）。文字面下限 content/sidebar/overlay/control = 62/62/70/55%；玻璃颜色用 `--magpie-bg` / `--magpie-card`，字体色用 `--magpie-fg` 系列，`green/red/amber` 映射 `ok/warn/bad`，页面不自己挑颜色。
- 无底色的长条（`.keys-titlebar`、`.keys-filterbar`）不能再带 `backdrop-filter`：玻璃卡片里 Chromium 会把「透明底 + 模糊」渲染成一条黑带（2026-11-18 实机截图）。玻璃开着时对它们 `backdrop-filter: none; background: transparent`。
- 所有成块的「面」（卡片、次级卡片、页头、控件）都要套 1px 高光边 + 下侧暗边 + 柔和外阴影（宿主 `fish-glass.css`／Purge 的同一套材质），否则玻璃只是一块灰板，不像玻璃。
- 本地服务必须在默认导出返回前 listen：`index.mjs` 里 `await Promise.race([serviceReady, 3s 超时])`。宿主判定「插件加载完成」是在默认导出返回时，而 magpie web 的反代第一跳不会等我们；服务没 listen 时页面会显示宿主的英文重试页（The plugin's service isn't answering yet），几秒后才好。
- 所有表头（`.keys-table thead th`、`.data-table thead th`、`.lg-head`、`.model-grid.as-list .ml-head`）玻璃开时都改成**不吸顶、透明**，只留一条细分隔线——宿主页面里表头实色长条是最常见的「未透明色块」（2026-11-18 实机反馈）。表头原来若带 `backdrop-filter` 也要清掉。

## 发布流程
- 改版本 → `node --test --test-isolation=none "tests/*.test.mjs"`（当前 275 条）→ 原子提交 → `git tag vX.Y.Z`。
- `npm publish --access public`。账号启用 staged publishing，registry 生效有延迟；用 `npx npm@11.19.1 view @fish-under-sea/magpie-dragonapi dist-tags` 复核 `latest`。
- 发布时把 npm cache 指到仓库内 `.npm-cache` 以避开沙箱限制，发布完删除该目录，不要提交。
- 页面会轮询 `/api/ping` 的 `version` 与 `ui` 时间戳自动热重载；改 `ui/*` 或升级包后无需手动刷新。`/api/ping` 必须保留 `ui` 字段。


## 日志详情与列偏好
- `detailOf` 遇到 `billing_mode=tiered_expr` 时必须解开 `other.expr_b64`，用 `chatCoeffs` 取 p/c 单价；`model_ratio`/`completion_ratio` 在表达式计费里是 0，照它们拼只会得到错误的 `0 / 0`。
- 日志「详情」列默认隐藏；密钥/日志「查看」列的勾选存到服务端 `/api/prefs`（内存），因为沙箱 iframe 没有 localStorage。刷新页面靠同一服务恢复，不要回退到浏览器存储。
- 密钥表格里那个单键复制按钮必须走 `copyKeySecret`（reveal 完整明文），不能 `copyButton(k.masked)`；否则复制到的是打码值。

## 推荐计划 / 转入余额 / 钱包
- `/api/user/aff_transfer` 必须发 JSON body（`{ quota }`），不带 body 站点直接回 `EOF`；`quota` 是内部单位，1 元 = `cur.per`（当前 500000）。最低 1 元，服务端与浮窗都要校验。
- 页面不要再用二次点击「确认转入」；用浮窗输入金额（`openAffTransfer`），默认填可转余额的向下取整两位，超过可转金额或低于 1 元就地报错。
- 钱包只渲染主账户 `st.user`；绑定钥匙的额度不再生成 `acct-card`，钥匙仍在上方计数与密钥页展示。
- 推荐链接复制按钮只有 30px 宽，成功态用 `✓`，不要用「已复制」四个字（会竖排溢出）。



## 模型分类与思考强度
- 生图模型经常把 `supported_endpoint_types` 写成 `openai`/`gemini`，只按 endpoint 判断会漏进 LLM。`kindOf` 必须同时看 `enable_groups`（image/图像/生图/绘图/绘画）与 `tags`，归为 `image`，并且不要给它们加 `variants`。
- 对话模型的思考强度档位要覆盖站点实际值：`minimal / low / medium / high / xhigh / max`，不要只给三档。
- 生图模型的 `capabilities.output` 必须是 `image:true, text:false`；`text:true` 会被 magpie 当成可对话文本模型，导致既不进 LLM 也进不了 Image models 选择器。

## 每个模型走自己的协议端点
- `npmOf` 按 `supported_endpoint_types` 给模型定协议：有 `anthropic` → `@ai-sdk/anthropic`，有 `gemini` → `@ai-sdk/google`，其余 `@ai-sdk/openai-compatible`。`apiFor` 同时给出对应 base：Anthropic 是根地址，Gemini 是 `/v1beta`，OpenAI 兼容是 `/v1`。
- `loader` **不要**写全局 `baseURL`：写死会把所有模型压回同一个协议。magpie 的取值顺序是 loader.baseURL → 模型自己的 `api.url` → provider 的 `api` → npm 默认。
- Gemini 把模型名放在 URL `/models/<id>:generateContent` 里，所以 `loader.fetch` 除了改 body 的 `model`，还要把 URL 里的 `分组/模型` 还原成裸模型名；`:` 后面的动作段不能被编码。
- Responses：对话模型统一用 `@ai-sdk/openai`（Responses API）。站点实测提供 `/v1/responses`（无鉴权 401 = 端点存在），Responses 的 prompt cache 命中高于 chat completions。生图/视频仍留在 `@ai-sdk/openai-compatible`，否则 magpie 的 Images API 画不出图。

- 编辑器协议列表来自 `Provider.APIs`；插件供应商的 APIs 只有 Chat/Anthropic/Gemini（由模型 npm 推出），**没有 Responses**。用户要 Responses 只能走「自定义添加」供应商。
- 自定义供应商的参考参数：chat `https://newapi.dragon3api.com/v1`、responses `https://newapi.dragon3api.com/v1`、anthropic `https://newapi.dragon3api.com`；账号级协议选「任意协议」。

## 协议切换（magpie 源码实证）
- `pluginProtocol(npm)`：`@ai-sdk/anthropic`→anthropic、`@ai-sdk/openai`→responses、`@ai-sdk/google`→**CodeAssist**、其余→chat。
- `pluginProtocols(m)` = 主协议 + `m.Also` 里每个 npm 的协议；插件供应商的 provider 级地址只从这三个来：`Chat`/`Responses`/`Anthropic`（见 `pluginProvider` 的 switch），`CodeAssist` 只写进 `Account.codeAssist`，**`p.Gemini` 永不赋值**——所以插件供应商在编辑器里**永远选不到 Gemini 专用协议**，这是 magpie 的限制，不是插件能修的。
- ~~模型上带 `also` 可以让编辑器列出更多协议~~ **已回退**：实测开了 also 之后，Gemini 模型被按 OpenAI 协议转发，站点回 401（gemini/gemini-4-hydrogen 通过 OpenAI 协议没有响应），跨协议转发不可靠。1.5.0 起不再输出 also。
- Gemini 模型「自动」已经是 Gemini 原生请求：CodeAssist 会去掉信封，按 `/v1beta/models/<id>:streamGenerateContent` 发出去。

- ~~跨协议转发时统一端点路径~~ 同样已随 1.5.0 回退：不要在 `loader.fetch` 里改写路径，只保留「还原 `分组/模型`」这一件事。


