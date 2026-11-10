// 用量解析的回归测试。
//
// 站点日志的字段写法不统一（顶层 / other 里都可能有），这里把见过的形状
// 全部钉住，免得哪天站点换个字段名就整列变空。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { rowsOf, summarize, windowOf, fmtStamp } from '../lib/usage.mjs'

const CUR = { symbol: '$', per: 500000, rate: 1, code: 'USD', display: true }

test('rowsOf：顶层字段直接读', () => {
  const rows = rowsOf([{
    created_at: 1762700000,
    type: 2,
    model_name: 'gpt-6-sol',
    prompt_tokens: 1000,
    completion_tokens: 500,
    quota: 500000,
    use_time: 4,
    group: 'gpt-plus',
    token_name: 'Magpie-gpt-plus',
    is_stream: true,
  }], CUR)
  assert.equal(rows.length, 1)
  const r = rows[0]
  assert.equal(r.model, 'gpt-6-sol')
  assert.equal(r.input, 1000)
  assert.equal(r.output, 500)
  assert.equal(r.costRaw, 500000)
  assert.equal(r.cost, '$1.00')
  assert.equal(r.kind, '消耗')
  assert.equal(r.tokenName, 'Magpie-gpt-plus')
  assert.equal(r.isStream, true)
})

test('rowsOf：字段塞在 other 里也能读', () => {
  const rows = rowsOf([{
    created_at: 1762700000,
    type: 2,
    other: JSON.stringify({ model_name: 'claude-sonnet-5', prompt_tokens: 200, completion_tokens: 100, quota: 250000 }),
  }], CUR)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].model, 'claude-sonnet-5')
  assert.equal(rows[0].input, 200)
  assert.equal(rows[0].output, 100)
})

test('rowsOf：other 是对象而不是字符串也认', () => {
  const rows = rowsOf([{ created_at: 1, other: { model_name: 'x', quota: 500000 } }], CUR)
  assert.equal(rows[0].model, 'x')
})

test('rowsOf：既没模型也没计价说明的行被丢掉', () => {
  const rows = rowsOf([{ created_at: 1, type: 4 }, { created_at: 2, model_name: 'ok' }], CUR)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].model, 'ok')
})

test('rowsOf：按时间倒序，最新在最上面', () => {
  const rows = rowsOf([
    { created_at: 100, model_name: 'a' },
    { created_at: 300, model_name: 'c' },
    { created_at: 200, model_name: 'b' },
  ], CUR)
  assert.deepEqual(rows.map((r) => r.model), ['c', 'b', 'a'])
})

test('rowsOf：吞吐按「生成耗时」算，扣掉首字等待', () => {
  // 总时长 5 秒，首字 1 秒 → 生成 4 秒，输出 400 token → 100 t/s
  const rows = rowsOf([{ created_at: 1, model_name: 'a', completion_tokens: 400, use_time: 5, ttft: 1 }], CUR)
  assert.equal(rows[0].tps, 100)
})

test('rowsOf：没有首字数据时用总时长', () => {
  const rows = rowsOf([{ created_at: 1, model_name: 'a', completion_tokens: 400, use_time: 4 }], CUR)
  assert.equal(rows[0].tps, 100)
})

test('rowsOf：没有 quota 时费用留空，不写 0', () => {
  const rows = rowsOf([{ created_at: 1, model_name: 'a' }], CUR)
  assert.equal(rows[0].cost, '')
  assert.equal(rows[0].costRaw, undefined)
})

test('rowsOf：type 映射成中文，未知值原样说明', () => {
  assert.equal(rowsOf([{ created_at: 1, model_name: 'a', type: 1 }], CUR)[0].kind, '充值')
  assert.equal(rowsOf([{ created_at: 1, model_name: 'a', type: 2 }], CUR)[0].kind, '消耗')
  assert.equal(rowsOf([{ created_at: 1, model_name: 'a', type: 9 }], CUR)[0].kind, '类型 9')
})

test('summarize：汇总总额、token、按模型、按桶', () => {
  const start = 1762617600000 // 某天零点
  const end = start + 24 * 3600e3
  const rows = [
    { at: start + 3600e3, model: 'a', input: 100, output: 100, costRaw: 500000 },
    { at: start + 7200e3, model: 'a', input: 50, output: 50, costRaw: 250000 },
    { at: start + 7200e3, model: 'b', input: 10, output: 0, costRaw: 100000 },
    // 窗口外的必须被排除
    { at: start - 1, model: 'c', input: 9999, output: 0, costRaw: 999999 },
  ]
  const s = summarize(rows, CUR, start, end)
  assert.equal(s.spentRaw, 850000)
  assert.equal(s.spent, '$1.70')
  assert.equal(s.tokens, 310)
  assert.equal(s.byModel.length, 2)
  assert.equal(s.byModel[0].model, 'a')
  assert.equal(s.byModel[0].calls, 2)
  assert.ok(s.buckets.length >= 1)
})

test('summarize：窗口内没有任何行时给零，不抛', () => {
  const start = 1762617600000
  const s = summarize([], CUR, start, start + 24 * 3600e3)
  assert.equal(s.spentRaw, 0)
  assert.equal(s.tokens, 0)
  assert.deepEqual(s.byModel, [])
})

test('windowOf：day 是今天零点到明天零点', () => {
  const now = new Date(2026, 10, 10, 18, 30).getTime()
  const w = windowOf('day', now)
  assert.equal(new Date(w.start).getDate(), 10)
  assert.equal(new Date(w.start).getHours(), 0)
  assert.equal(new Date(w.end).getDate(), 11)
})

test('windowOf：week 是最近 7 天（含今天）', () => {
  const now = new Date(2026, 10, 10, 18, 30).getTime()
  const w = windowOf('week', now)
  assert.equal(new Date(w.start).getDate(), 4)
  assert.equal(new Date(w.end).getDate(), 11)
})

test('windowOf：month 是最近 30 天', () => {
  const now = new Date(2026, 10, 10, 18, 30).getTime()
  const w = windowOf('month', now)
  const days = Math.round((w.end - w.start) / 86400e3)
  // 11 月 10 日往前 29 天是 10 月 12 日，到 11 月 11 日零点正好 30 天
  assert.equal(days, 30)
})

test('fmtStamp 输出 MM-DD HH:mm', () => {
  const sec = Math.floor(new Date(2026, 10, 10, 18, 22).getTime() / 1000)
  assert.equal(fmtStamp(sec), '11-10 18:22')
  assert.equal(fmtStamp(0), '')
  assert.equal(fmtStamp(undefined), '')
})
