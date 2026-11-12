import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSubscriptions, readSubscriptionSelf } from '../lib/site.mjs'

const SITE = 'https://subscriptions.test'
const PAT = 'nap_test_only'
const NOW = 1800000000000
const CUR = { symbol: '¥', per: 500000, rate: 7, display: true }
const response = (data, status = 200) => new Response(JSON.stringify(data), { status })
const subscription = (patch = {}) => ({ id: 1, plan_id: 7, status: 'active', start_time: NOW / 1000 - 100, end_time: NOW / 1000 + 100, amount_total: 500000, amount_used: 750000, next_reset_time: NOW / 1000 + 50, ...patch })
async function stub(handler, run) {
  const real = globalThis.fetch
  globalThis.fetch = (url, init) => Promise.resolve(handler(new URL(url), init))
  try { return await run() } finally { globalThis.fetch = real }
}
async function data(self, plans, run) {
  return stub((url) => response({ success: true, data: url.pathname.endsWith('/self') ? self : plans }), run)
}

test('subscriptions unwrap, join plan titles, deduplicate id, preserve real progress and convert seconds', async () => {
  await data({
    billing_preference: 'subscription_first',
    subscriptions: [{ subscription: subscription() }, { subscription: subscription({ id: 2, plan_id: 99, amount_total: 0 }) }],
    all_subscriptions: [{ subscription: subscription({ amount_used: 1 }) }, subscription({ id: 3, plan_id: 88 }), { subscription: subscription({ id: 4 }), plan: { title: 'Embedded' } }],
  }, [{ plan: { id: 7, title: 'Pro', subtitle: 'Monthly plan', duration_unit: 'month', duration_value: 1, total_amount: 500000, quota_reset_period: 'daily', upgrade_group: 'pro', price_amount: 9.99, currency: 'USD' } }], async () => {
    const result = await readSubscriptions(SITE, PAT, CUR, NOW)
    assert.equal(result.subscriptions.length, 4)
    const [first, unlimited, fallback, embedded] = result.subscriptions
    assert.equal(first.title, 'Pro')
    assert.equal(first.planId, 7)
    assert.equal(first.total, '¥7.00')
    assert.equal(first.used, '¥10.50')
    assert.equal(first.remaining, '¥-3.50')
    assert.equal(first.remainingRaw, -250000)
    assert.equal(first.progress, 150)
    assert.equal(first.startAt, NOW - 100000)
    assert.equal(first.endAt, NOW + 100000)
    assert.equal(first.nextResetAt, NOW + 50000)
    assert.equal(first.active, true)
    assert.equal(unlimited.unlimited, true)
    assert.equal(unlimited.total, '不限量')
    assert.equal(unlimited.remainingRaw, null)
    assert.equal(unlimited.progress, null)
    assert.equal(fallback.title, '套餐 #88')
    assert.equal(embedded.title, 'Embedded')
    assert.equal(result.billingPreference, 'subscription_first')
    assert.equal(result.plansError, '')
    assert.equal(result.plans[0].price, 'USD 9.99')
    assert.equal(result.plans[0].priceAmount, 9.99)
    assert.equal(result.plans[0].priceCurrency, 'USD')
    assert.equal(result.plans[0].subtitle, 'Monthly plan')
    assert.equal(result.plans[0].durationUnit, 'month')
    assert.equal(result.plans[0].durationValue, 1)
    assert.equal(result.plans[0].totalRaw, 500000)
    assert.equal(result.plans[0].total, '¥7.00')
    assert.equal(result.plans[0].unlimited, false)
    assert.equal(result.plans[0].quotaResetPeriod, 'daily')
    assert.equal(result.plans[0].upgradeGroup, 'pro')
  })
})

test('subscriptions active requires actual status, unexpired end, and started period', async () => {
  const cases = [
    [{}, true],
    [{ status: 'expired' }, false],
    [{ status: 'cancelled' }, false],
    [{ status: 1 }, false],
    [{ end_time: NOW / 1000 }, false],
    [{ end_time: 0 }, false],
    [{ end_time: undefined }, false],
    [{ start_time: NOW / 1000 + 1 }, false],
    [{ status: undefined }, false],
  ]
  for (const [patch, expected] of cases) {
    await data({ subscriptions: [subscription(patch)] }, [], async () => {
      const r = await readSubscriptions(SITE, PAT, CUR, NOW)
      assert.equal(r.subscriptions[0].active, expected, JSON.stringify(patch))
    })
  }
})

test('subscriptions missing amounts remain unknown, not zero or unlimited', async () => {
  await data({ all_subscriptions: [subscription({ amount_total: undefined, amount_used: undefined, next_reset_time: undefined })] }, [], async () => {
    const [s] = (await readSubscriptions(SITE, PAT, CUR, NOW)).subscriptions
    for (const key of ['totalRaw', 'usedRaw', 'remainingRaw', 'progress', 'nextResetAt']) assert.equal(s[key], null)
    for (const key of ['total', 'used', 'remaining']) assert.equal(s[key], '')
    assert.equal(s.unlimited, false)
  })
})

test('subscription self and plans are parallel GETs with PAT; plans failure retains self and explicit error', async () => {
  let count = 0
  let release
  const gate = new Promise((r) => { release = r })
  await stub(async (url, init) => {
    assert.equal(init.method, 'GET')
    assert.equal(init.headers['new-api-access-token'], PAT)
    assert.equal(init.headers.authorization, `Bearer ${PAT}`)
    count++
    if (count === 2) release()
    await gate
    return url.pathname.endsWith('/self')
      ? response({ data: { subscriptions: [subscription()], billing_preference: 'wallet_only' } })
      : response({ message: 'plans unavailable' }, 503)
  }, async () => {
    const r = await readSubscriptions(SITE, PAT, CUR, NOW)
    assert.equal(count, 2)
    assert.equal(r.subscriptions[0].title, '套餐 #7')
    assert.equal(r.billingPreference, 'wallet_only')
    assert.deepEqual(r.plans, [])
    assert.match(r.plansError, /plans unavailable/)
  })
})

test('subscription self auth/schema/success:false failures never turn into empty subscriptions', async () => {
  for (const body of [null, { data: {} }, { data: [] }, { data: { subscriptions: 'bad' } }, { data: { subscriptions: [], all_subscriptions: {} } }, { data: { subscriptions: [{}] } }, { success: false, message: 'denied', data: { subscriptions: [] } }]) {
    await stub((url) => response(url.pathname.endsWith('/self') ? body : { data: [] }), async () => {
      await assert.rejects(readSubscriptionSelf(SITE, PAT), /未知|不是数组|denied/)
      await assert.rejects(readSubscriptions(SITE, PAT, CUR, NOW), /未知|不是数组|denied/)
    })
  }
  await stub((url) => url.pathname.endsWith('/self') ? response({ message: 'wallet:read required' }, 403) : response({ data: [] }), async () => {
    await assert.rejects(readSubscriptions(SITE, PAT, CUR, NOW), (e) => e.isAuth === true)
  })
})

test('plans unknown structures or success:false produce plansError, not silent empty success', async () => {
  for (const body of [{ data: {} }, { data: [{}] }, { success: false, message: 'plan denied', data: [] }]) {
    await stub((url) => response(url.pathname.endsWith('/self') ? { data: { subscriptions: [] } } : body), async () => {
      const r = await readSubscriptions(SITE, PAT, CUR, NOW)
      assert.ok(r.plansError)
      assert.deepEqual(r.subscriptions, [])
    })
  }
})

test('plans zero quota is unlimited while missing/invalid values remain unknown, with original currency prices', async () => {
  await data({ subscriptions: [] }, [
    { id: 1, total_amount: 0, price_amount: '12.34', currency: 'EUR' },
    { id: 2, total_amount: null, duration_value: '', price_amount: 'invalid' },
    { id: 3, total_amount: 'invalid' },
  ], async () => {
    const plans = (await readSubscriptions(SITE, PAT, CUR, NOW)).plans
    assert.equal(plans[0].total, '不限量')
    assert.equal(plans[0].unlimited, true)
    assert.equal(plans[0].price, 'EUR 12.34')
    for (const p of plans.slice(1)) {
      assert.equal(p.totalRaw, null)
      assert.equal(p.total, '')
      assert.equal(p.unlimited, false)
      assert.equal(p.durationValue, null)
      assert.equal(p.priceAmount, null)
      assert.equal(p.price, '')
    }
  })
})

test('billing preference accepts exactly four read-only values, otherwise null', async () => {
  for (const preference of ['subscription_first', 'wallet_first', 'subscription_only', 'wallet_only', 'unexpected', undefined]) {
    await data({ subscriptions: [], billing_preference: preference }, [], async () => {
      const r = await readSubscriptions(SITE, PAT, CUR, NOW)
      assert.equal(r.billingPreference, ['unexpected', undefined].includes(preference) ? null : preference)
    })
  }
})
