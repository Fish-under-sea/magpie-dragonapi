// host.js 的地址校验：bridge 地址是 boot.js 从宿主页面带过来的，界面只
// 认它自己目录下的 _magpie/bridge.js，别的协议/别的站一律不加载。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bridgeUrl } from '../ui/host.js'

const base = 'http://127.0.0.1:4399/_magpie/plugin/0123456789abcdef0123456789abcdef/page/index.html'
const ok = 'http://127.0.0.1:4399/_magpie/plugin/0123456789abcdef0123456789abcdef/page/_magpie/bridge.js'

test('bridgeUrl 接受宿主页面旁边的 http(s) bridge', () => {
  assert.equal(bridgeUrl(ok, base, 'http://127.0.0.1:4399'), ok)
  assert.equal(bridgeUrl(ok.replace('http:', 'https:'), base, 'https://127.0.0.1:4399'), ok.replace('http:', 'https:'))
})

test('bridgeUrl 把相对地址按页面地址解析', () => {
  assert.equal(bridgeUrl('_magpie/bridge.js', base, 'http://127.0.0.1:4399'), ok)
})

test('bridgeUrl 拒绝非 http(s)、非 bridge 路径、别的源与空值', () => {
  const same = 'http://127.0.0.1:4399'
  assert.equal(bridgeUrl('', base, same), '')
  assert.equal(bridgeUrl('wails://wails.localhost/_magpie/bridge.js', base, same), '')
  assert.equal(bridgeUrl('javascript:alert(1)', base, same), '')
  assert.equal(bridgeUrl('https://evil.test/_magpie/bridge.js', base, same), '')
  assert.equal(bridgeUrl('http://127.0.0.1:4399/other/app.js', base, same), '')
})

test('bridgeUrl 拿不到祖先源时只认回环地址', () => {
  // Node 里没有 location.ancestorOrigins；等价于旧 WebKit / 独立打开
  assert.equal(bridgeUrl(ok, base), ok)
  assert.equal(bridgeUrl('https://evil.test/_magpie/bridge.js', base), '')
  assert.equal(bridgeUrl('http://192.168.1.5:4399/_magpie/bridge.js', base), '')
})
