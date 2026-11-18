// 颜色亮度与可读性兜底。
//
// 宿主的 --bg / --fg 都可以被用户自定义；主题深浅也不能只信 bridge 的 dark
// 标志（bridge 在页面自己的文档里算主题时，prefers-color-scheme 可能已经是
// 另一套）。这里用官方 --bg 的实际亮度定深浅，并在 fg/bg 对比度不足时给出
// 可读的墨色——只在「白字配白玻璃」这种真的看不见的情况下生效。

/** 把 #rgb / rgb()/rgba() 解析成 0–255；解析不了返回 null。 */
export function parseColor(value) {
  const s = String(value || '').trim()
  const hex = s.match(/^#([0-9a-f]{3,8})$/i)
  if (hex) {
    const h = hex[1]
    if (h.length === 3) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16))
    if (h.length >= 6) return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
    return null
  }
  const rgb = s.match(/^rgba?\(([^)]+)\)$/i)
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).map(Number).filter((n) => Number.isFinite(n))
    if (parts.length >= 3) return parts.slice(0, 3)
  }
  return null
}

/** WCAG 相对亮度，0（黑）–1（白）。 */
export function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** 这个颜色算深色吗；解析不了返回 null。 */
export function isDarkColor(value) {
  const rgb = parseColor(value)
  return rgb ? luminance(rgb) < 0.38 : null
}

/** fg 与 bg 的对比度低于 3 时，换成同色系可读的墨色。 */
export function ensureReadable(root) {
  if (typeof getComputedStyle !== 'function') return
  const cs = getComputedStyle(root)
  const bg = parseColor(cs.getPropertyValue('--bg')) || parseColor(cs.getPropertyValue('--card'))
  const fg = parseColor(cs.getPropertyValue('--fg'))
  if (!bg || !fg) return
  const L1 = luminance(bg)
  const L2 = luminance(fg)
  const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
  if (ratio >= 3) return
  const darkBg = L1 < 0.38
  const ink = darkBg
    ? { '--fg': '#f4f6fb', '--fg-2': '#d5d9e2', '--muted': '#b3b9c6', '--faint': '#8f96a4' }
    : { '--fg': '#15181f', '--fg-2': '#3d434e', '--muted': '#5b626e', '--faint': '#858c98' }
  for (const [k, v] of Object.entries(ink)) root.style.setProperty(k, v)
}
