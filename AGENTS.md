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

## 发布流程
- 改版本 → `node --test --test-isolation=none "tests/*.test.mjs"`（当前 255 条）→ 原子提交 → `git tag vX.Y.Z`。
- `npm publish --access public`。账号启用 staged publishing，registry 生效有延迟；用 `npx npm@11.19.1 view @fish-under-sea/magpie-dragonapi dist-tags` 复核 `latest`。
- 发布时把 npm cache 指到仓库内 `.npm-cache` 以避开沙箱限制，发布完删除该目录，不要提交。
