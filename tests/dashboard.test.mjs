import test from 'node:test'
import assert from 'node:assert/strict'

import { summarizeDashboard } from '../lib/dashboard.mjs'

const rows = [
  { created_at: 1000, model_name: 'a', count: 2, quota: 100, token_used: 1000, cache_read_tokens: 10, cache_creation_tokens: 5 },
  { created_at: 1000, model_name: 'b', count: 1, quota: 50, token_used: 500, cache_read_tokens: 2, cache_creation_tokens: 0 },
  { created_at: 4600, model_name: 'a', count: 3, quota: 200, token_used: 2000 },
]
const span = { start: 0, end: 60 * 60 * 1000 }

test('summarizeDashboard：汇总总数 / 额度 / Token / 缓存', () => {
  const d = summarizeDashboard(rows, span)
  assert.equal(d.totals.count, 6)
  assert.equal(d.totals.quota, 350)
  assert.equal(d.totals.tokens, 3500)
  assert.equal(d.totals.cacheRead, 12)
  assert.equal(d.totals.cacheWrite, 5)
})

test('summarizeDashboard：平均 RPM/TPM 按分钟算', () => {
  const d = summarizeDashboard(rows, span)
  assert.equal(d.minutes, 60)
  assert.equal(d.totals.avgRpm, 6 / 60)
  assert.equal(d.totals.avgTpm, 3500 / 60)
})

test('summarizeDashboard：按时间桶排序，桶内按模型拆额度', () => {
  const d = summarizeDashboard(rows, span)
  assert.deepEqual(d.buckets.map((b) => b.at), [1_000_000, 4_600_000])
  assert.deepEqual(d.buckets[0].values, { a: 100, b: 50 })
  assert.equal(d.buckets[1].count, 3)
})

test('summarizeDashboard：模型按额度倒序汇总', () => {
  const d = summarizeDashboard(rows, span)
  assert.deepEqual(d.models.map((m) => m.model), ['a', 'b'])
  assert.equal(d.models[0].count, 5)
  assert.equal(d.models[0].quota, 300)
})

test('summarizeDashboard：空数据不抛，分钟数至少为 1', () => {
  const d = summarizeDashboard([], { start: 0, end: 0 })
  assert.equal(d.totals.count, 0)
  assert.equal(d.minutes, 1)
  assert.deepEqual(d.buckets, [])
  assert.deepEqual(d.models, [])
})
