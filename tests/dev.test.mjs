// 本地预览工具的护栏。
//
// dev.mjs 是个脚本，不好在测试里整个跑起来（它要占端口、连站点、守文件变化）。
// 但它一旦退化，改界面的人就会以为「界面坏了」而去查 prod 代码。所以这里用
// 静态断言钉住几个关键点，再单独验证它复用生产静态文件规则。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as service from '../lib/service.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dev = readFileSync(join(here, '..', 'dev.mjs'), 'utf8')

test('serveFile 是导出的：预览要复用生产的静态文件规则，不另写一份', () => {
  assert.equal(typeof service.serveFile, 'function')
})

test('dev.mjs 复用 startService 与 serveFile，不自己重写服务', () => {
  assert.match(dev, /from '\.\/lib\/service\.mjs'/, '应从 lib/service.mjs 导入')
  assert.match(dev, /startService/, '应复用 startService')
  assert.match(dev, /serveFile/, '应复用 serveFile')
})

test('dev.mjs 提供热刷新事件流，并把脚本注入 index.html', () => {
  assert.match(dev, /'\/__live'/, '缺少 /__live 端点')
  assert.match(dev, /text\/event-stream/, '应是 SSE 流')
  assert.match(dev, /EventSource/, '页面侧应监听 SSE')
  assert.match(dev, /<\/body>/, '应把脚本注入到 </body> 前')
  // 注入只发生在开发服务里，生产 html 不能被改
  assert.match(dev, /LIVE_SCRIPT/, '缺少单独的注入片段')
})

test('dev.mjs 提供沙箱模式（和 magpie 的 plugin page 同一套 sandbox）', () => {
  assert.match(dev, /\/__sandbox/, '缺少沙箱外壳路由')
  assert.match(dev, /sandbox="allow-scripts"/, '外壳必须用和 magpie 相同的 sandbox 属性')
})

test('代理 /api/* 时必须带 CORS 头', () => {
  // 沙箱模式里页面是不透明源（Origin: null），代理漏掉 ACAO 就全部「连不上」。
  // 这个坑真的踩过一次。
  const block = dev.match(/path\.startsWith\('\/api\/'\)[\s\S]*?return\n\s*\}/)
  assert.ok(block, '找不到 API 代理分支')
  assert.match(block[0], /access-control-allow-origin/, '代理响应必须带 ACAO')
})

test('dev.mjs 不吃端口冲突：端口可指定', () => {
  assert.match(dev, /--port/, '应支持 --port')
  assert.match(dev, /--service-port/, '应支持 --service-port')
})

test('dev.mjs 支持代理插件服务且保留 PAT 验证与持久化结果', () => {
  assert.match(dev, /--upstream/)
  assert.match(dev, /UPSTREAM \? null : await startService/)
  assert.match(dev, /patVerified: state\.patVerified === true/)
  assert.match(dev, /state\.patVerified = verified === true/)
  assert.match(dev, /return saveState\(DIR, state\)/)
  assert.match(dev, /inner\?\.close\(\)/)
})

test('dev.mjs 不进 npm 包', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  const files = pkg.files || []
  assert.equal(files.includes('dev.mjs'), false, 'dev.mjs 是开发工具，不该发布到 npm')
})