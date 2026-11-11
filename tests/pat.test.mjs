import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePat, siteCall, probePat, readAff, readUsageSelf, readTokenLogs } from '../lib/site.mjs'

const SITE = 'https://pat.test'
const PAT = 'nap_test_only'
const response = (data, status = 200) => new Response(JSON.stringify(data), { status })
async function stub(handler, run) {
  const real = globalThis.fetch
  globalThis.fetch = (url, init) => Promise.resolve(handler(new URL(url), init))
  try { return await run() } finally { globalThis.fetch = real }
}

test('normalizePat removes copied headers, quotes, whitespace and zero-width characters', () => {
  for (const value of [PAT, ` "${PAT}" `, `Authorization: Bearer '${PAT}'`, `Bearer\nnap_​test_﻿only`, '`nap_test_only`']) {
    assert.equal(normalizePat(value), PAT)
    assert.equal(normalizePat(normalizePat(value)), PAT)
  }
  assert.equal(normalizePat(null), '')
})

test('PAT sends both normalized auth headers; sk never sends PAT header', async () => {
  const seen = []
  await stub((url, init) => { seen.push(init); return response({ success: true }) }, async () => {
    await siteCall(SITE, '/read', { auth: { kind: 'pat', token: `Authorization: Bearer "${PAT}"` } })
    await siteCall(SITE, '/read', { auth: { kind: 'key', token: 'sk-test-only' } })
  })
  assert.equal(seen[0].headers.authorization, `Bearer ${PAT}`)
  assert.equal(seen[0].headers['new-api-access-token'], PAT)
  assert.equal(seen[1].headers.authorization, 'Bearer sk-test-only')
  assert.equal('new-api-access-token' in seen[1].headers, false)
})

test('probePat launches four read-only probes in parallel, all with a 12-second budget, accepting wallet-only', async () => {
  const realTimeout = AbortSignal.timeout
  const budgets = []
  AbortSignal.timeout = (ms) => { budgets.push(ms); return realTimeout(ms) }
  let calls = 0
  let release
  const gate = new Promise((r) => { release = r })
  try {
    await stub(async (url, init) => {
      assert.equal(init.method, 'GET')
      assert.equal(init.body, undefined)
      calls++
      if (calls === 4) release()
      await gate
      return url.pathname === '/api/subscription/self'
        ? response({ success: true, data: { subscriptions: [] } })
        : response({ success: false, code: 'AUTH_FORBIDDEN', message: 'scope missing' }, 403)
    }, async () => {
      const probe = await probePat(SITE, PAT)
      assert.equal(calls, 4)
      assert.deepEqual(budgets, [12000, 12000, 12000, 12000])
      assert.equal(probe.verified, true)
      assert.equal(probe.authRejected, false)
      assert.deepEqual(probe.scopes, ['wallet:read'])
      assert.equal(probe.user, null)
    })
  } finally { AbortSignal.timeout = realTimeout }
})

test('probePat rejects four auth failures including HTTP-200 AUTH codes and never accepts unknown JSON', async () => {
  await stub(() => response({ success: false, code: 'AUTH_UNAUTHORIZED', message: 'invalid' }), async () => {
    const result = await probePat(SITE, PAT)
    assert.equal(result.authRejected, true)
    assert.equal(result.failures.length, 4)
  })
  await stub(() => response({ success: true, data: {} }), async () => {
    const result = await probePat(SITE, PAT)
    assert.equal(result.verified, false)
    assert.deepEqual(result.scopes, [])
    assert.equal(result.failures.length, 4)
  })
  await stub(() => response({ success: true, data: { subscriptions: [{ unrelated: true }] } }), async () => {
    assert.equal((await probePat(SITE, PAT)).scopes.includes('wallet:read'), false)
  })
})

test('both log readers accept known arrays, reject unknown/success:false, and send second-based windows', async () => {
  const items = [{ id: 1, model_name: 'test' }]
  for (const read of [readUsageSelf, readTokenLogs]) {
    for (const shape of [items, { data: items }, { data: { items } }, { data: { data: items } }]) {
      await stub((url) => {
        assert.equal(url.searchParams.get('start_timestamp'), '1762700000')
        assert.equal(url.searchParams.get('end_timestamp'), '1762703600')
        assert.equal(url.searchParams.get('page_size'), '100')
        assert.equal(url.searchParams.get('p'), '0')
        assert.equal(url.searchParams.size, 4)
        return response(shape)
      }, async () => assert.deepEqual(await read(SITE, PAT, { pageSize: 500, start: 1762700000123, end: 1762703600456 }), items))
    }
    for (const shape of [{}, { data: {} }, { data: null }, { success: false, message: 'denied', data: [] }]) {
      await stub(() => response(shape), async () => assert.rejects(read(SITE, PAT), /未知日志结构|denied/))
    }
  }
})

test('readAff accepts string code and gets real counts and quotas from self', async () => {
  await stub((url) => response(url.pathname.endsWith('/aff')
    ? { success: true, data: 'invite-code' }
    : { success: true, data: { id: 1, aff_count: 3, aff_quota: 500000, aff_history_quota: 900000 } }), async () => {
    assert.deepEqual(await readAff(SITE, PAT), { code: 'invite-code', count: 3, quota: 500000, historyQuota: 900000, note: '' })
  })
})

test('readAff omits missing numbers and reports partial failure including auth verbatim', async () => {
  await stub((url) => url.pathname.endsWith('/aff')
    ? response({ success: true, data: 'code' })
    : response({ message: 'offline' }, 503), async () => {
    const aff = await readAff(SITE, PAT)
    assert.equal(aff.code, 'code')
    assert.match(aff.note, /503/)
    for (const field of ['count', 'quota', 'historyQuota', 'pending']) assert.equal(field in aff, false)
  })
  await stub((url) => url.pathname.endsWith('/aff')
    ? response({ message: 'not installed' }, 404)
    : response({ data: { id: 1, aff_code: 'self-code', aff_count: 0 } }), async () => {
    const aff = await readAff(SITE, PAT)
    assert.equal(aff.code, 'self-code')
    assert.equal(aff.count, 0)
    assert.match(aff.note, /404/)
  })
  for (const authPath of ['/api/user/aff', '/api/user/self']) {
    await stub((url) => url.pathname === authPath
      ? response({ code: 'AUTH_FORBIDDEN', message: 'missing scope' }, 403)
      : response({ data: url.pathname.endsWith('/aff') ? 'code' : { id: 1 } }), async () => {
      const aff = await readAff(SITE, PAT)
      assert.equal(aff.code, authPath.endsWith('/self') ? 'code' : '')
      assert.match(aff.note, /403.*missing scope/)
      assert.equal('quota' in aff, false)
    })
  }
  await stub(() => response({ success: false, message: 'upstream failure' }), async () => {
    await assert.rejects(readAff(SITE, PAT), /upstream failure/)
  })
})
