# DragonAPI in Magpie —— 项目约定与经验

## 命名：包名 / 供应商标识 / 插件头部 三者分清，不要混用
- **npm 包名**：`package.json.name` = `@fish-under-sea/magpie-dragonapi`，是对外发布名，不随展示改名。
- **magpie 供应商/插件卡标识**：`magpie.name` 用**包名** `@fish-under-sea/magpie-dragonapi`，不要换成产品名。
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

## 发布流程
- 改版本 → `node --test --test-isolation=none "tests/*.test.mjs"`（当前 259 条）→ 原子提交 → `git tag vX.Y.Z`。
- `npm publish --access public`。账号启用 staged publishing，registry 生效有延迟；用 `npx npm@11.19.1 view @fish-under-sea/magpie-dragonapi dist-tags` 复核 `latest`。
- 发布时把 npm cache 指到仓库内 `.npm-cache` 以避开沙箱限制，发布完删除该目录，不要提交。

