import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ensureReadable, isDarkColor, luminance, parseColor } from '../ui/color.js'

test('parseColor 认 #rgb / #rrggbb / rgb() / rgba()', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255])
  assert.deepEqual(parseColor('#1a1a1e'), [26, 26, 30])
  assert.deepEqual(parseColor('rgb(18, 52, 86)'), [18, 52, 86])
  assert.deepEqual(parseColor('rgba(18, 52, 86, .5)'), [18, 52, 86])
  assert.equal(parseColor('var(--bg)'), null)
  assert.equal(parseColor(''), null)
})

test('亮度与深浅判断跟着官方 --bg 走', () => {
  assert.ok(luminance([0, 0, 0]) < 0.01)
  assert.ok(luminance([255, 255, 255]) > 0.99)
  assert.equal(isDarkColor('#1a1a1e'), true)
  assert.equal(isDarkColor('#f4f4f6'), false)
  assert.equal(isDarkColor('nonsense'), null)
})

test('白字配白底时，对比度兜底会换成深墨色', () => {
  const props = new Map([['--bg', '#f4f4f6'], ['--fg', '#fbf9f9'], ['--card', '#ffffff']])
  const root = { style: { setProperty: (k, v) => props.set(k, v) } }
  const real = globalThis.getComputedStyle
  globalThis.getComputedStyle = () => ({ getPropertyValue: (k) => props.get(k) || '' })
  try {
    ensureReadable(root)
    assert.equal(props.get('--fg'), '#15181f')
    assert.equal(props.get('--muted'), '#5b626e')
  } finally {
    globalThis.getComputedStyle = real
  }
})

test('白字配深底时保持官方白字，不被兜底改掉', () => {
  const props = new Map([['--bg', '#1a1a1e'], ['--fg', '#fbf9f9'], ['--card', '#232327']])
  const root = { style: { setProperty: (k, v) => props.set(k, v) } }
  const real = globalThis.getComputedStyle
  globalThis.getComputedStyle = () => ({ getPropertyValue: (k) => props.get(k) || '' })
  try {
    ensureReadable(root)
    assert.equal(props.get('--fg'), '#fbf9f9')
  } finally {
    globalThis.getComputedStyle = real
  }
})
