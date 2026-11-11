// 演示数据层：网址带 ?demo（且不是 ?demo=0）时接管页面的全部 GET 请求。
// 数据只存在当前页面内存，刷新即还原；绝不向真实服务发送写请求（POST/DELETE 一律走原实现）。
// 用途：无 PAT / 无账号时也能核对使用日志页的完整排版与交互。

const DAY = 86400000;

/** makeRows 造一批形如 /api/usage 服务端输出的日志行。 */
function makeRows(now, cur) {
  const specs = [
    // [model, group, ratio, input, output, cache, bytes, isStream, tps, ttft, dur, quota, kind]
    ['gpt-6.1-sol', 'gpt-promax', 0.16, 84920, 351, 84608, 315 * 1024, true, 50, 3.9, 11.0, 1635, '消耗'],
    ['gpt-6.1-sol', 'gpt-promax', 0.16, 84556, 161, 84352, 313 * 1024, true, 443, 6.6, 7.0, 1365, '消耗'],
    ['claude-opus-5-5', 'claude-max企业', 1.20, 42100, 580, 40000, 205 * 1024, true, 96, 2.1, 9.5, 9800, '消耗'],
    ['claude-sonnet-5-5', 'claude-kiro正价', 0.35, 51200, 240, 50112, 180 * 1024, true, 210, 1.8, 5.2, 1840, '消耗'],
    ['gemini-3-pro-preview', 'gemini', 0.30, 20480, 320, 18000, 96 * 1024, true, 158, 2.6, 6.1, 1200, '消耗'],
    ['deepseek-v3.2', '国模', 0.15, 30240, 180, 28800, 88 * 1024, true, 320, 1.2, 3.8, 180, '消耗'],
    ['kimi-k2.5', '国模', 0.15, 88320, 260, 87500, 260 * 1024, false, null, null, 4.0, 320, '消耗'],
    ['gpt-image-2.6', '绘图', 1.00, null, null, null, 12 * 1024, false, null, null, 8.2, 400, '消耗'],
    ['seedance-2.5', '视频', 1.00, null, null, null, 9 * 1024, false, null, null, 22.0, 1250, '消耗'],
    ['claude-opus-5-5', 'claude-kiro', 0.10, 15800, 120, 15000, 60 * 1024, true, 88, 2.4, 7.0, 1900, '消耗'],
  ];
  const tokenNames = ['Magpie-gpt-plus', 'Magpie-claude', '脚本备用'];
  const efforts = ['high', 'medium', ''];
  return specs.flatMap(([model, group, ratio, input, output, cache, bytes, isStream, tps, ttft, dur, quota, kind], i) => {
    // 每条规格复制成两行，时间往前推，制造出翻页与排序都可见的量
    return [0, 1].map((k) => {
      const idx = i * 2 + k;
      const at = Math.floor(now / 1000) - (idx * 17 + k * 3) * 60;
      const d = new Date(at * 1000);
      const p = (x) => String(x).padStart(2, '0');
      const detail = model.startsWith('seedance')
        ? '0.272k · ¥1.60 / 720p每秒'
        : model.startsWith('gpt-image')
          ? '0.272k · ¥0.20 / 张'
          : `0.272k · ¥2 / ¥10/M`;
      return {
        at: at * 1000,
        atText: `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
        account: 'demo',
        kind,
        model,
        group,
        tokenName: tokenNames[idx % tokenNames.length],
        upModel: k === 0 && model.startsWith('gpt') ? 'gpt-6.1-sol-high' : '',
        respModel: '',
        effort: efforts[idx % efforts.length],
        input,
        output,
        cache,
        bytes,
        cost: `$${(quota / 500000).toFixed(5)}`,
        costRaw: quota,
        tps,
        ttft,
        dur,
        detail,
        isStream,
      };
    });
  });
}

/** summarize 形状与 lib/usage.mjs 的 summarize 一致（byModel / buckets / rows）。 */
function summarizeRows(rows, cur, start, end) {
  const span = Math.max(1, end - start);
  const bucketMs = span <= 26 * 3600e3 ? 3600e3 : span <= 8 * 24 * 3600e3 ? 6 * 3600e3 : 24 * 3600e3;
  const byModel = new Map();
  const byBucket = new Map();
  let spent = 0;
  let tokens = 0;
  for (const r of rows) {
    if (!r.at || r.at < start || r.at > end) continue;
    const cost = Number(r.costRaw) || 0;
    const tok = (Number(r.input) || 0) + (Number(r.output) || 0);
    spent += cost;
    tokens += tok;
    const key = r.model || '（未知）';
    const had = byModel.get(key) || { model: key, tokens: 0, costRaw: 0, calls: 0 };
    had.tokens += tok;
    had.costRaw += cost;
    had.calls += 1;
    byModel.set(key, had);
    const b = Math.floor((r.at - start) / bucketMs) * bucketMs + start;
    const hb = byBucket.get(b) || { at: b, costRaw: 0, tokens: 0 };
    hb.costRaw += cost;
    hb.tokens += tok;
    byBucket.set(b, hb);
  }
  const fmt = (raw) => `$${(raw / 500000).toFixed(4)}`;
  return {
    available: true,
    spent: fmt(spent),
    spentRaw: spent,
    tokens,
    start,
    end,
    byModel: [...byModel.values()].sort((a, b) => b.costRaw - a.costRaw).map((m) => ({ ...m, cost: fmt(m.costRaw) })),
    buckets: [...byBucket.values()].sort((a, b) => a.at - b.at).map((b) => ({ ...b, cost: fmt(b.costRaw) })),
    rows,
  };
}

/**
 * createDemoApi 返回 (path, opts) => data。
 * 只拦 GET 的读接口；写接口（建钥匙/删钥匙/转入余额）不拦——演示模式不该有副作用。
 */
export function createDemoApi() {
  const now = Date.now();
  const rows = makeRows(now);

  const rangeOf = (range) => {
    const end = now;
    const start = range === 'week' ? now - 6 * DAY : range === 'month' ? now - 29 * DAY : now - (new Date(now).getHours() * 3600e3 + new Date(now).getMinutes() * 60e3);
    return [start, end];
  };

  return async function demoRequest(path) {
    await new Promise((r) => setTimeout(r, 120));   // 一点延迟，让「正在读取」状态可见

    if (path === '/api/ping') return { ok: true, version: 'demo', port: 0 };
    if (path === '/api/state') {
      return {
        ok: true,
        site: 'https://newapi.dragon3api.com',
        siteName: 'DragonAPI',
        pat: { set: true, hint: 'nap_d****demo', scopes: ['profile:read', 'api_key:read', 'api_key:write'], verified: true },
        currency: { symbol: '$', per: 500000, rate: 1, display: true },
        user: { id: 1, username: 'demo', displayName: '演示账户', group: 'default', balance: '$18.50', balanceRaw: 9250000, used: '$68.19', usedRaw: 34095000 },
        userError: '',
        accounts: {
          'sk-demo': {
            key: 'sk-demo', label: 'gpt-promax · sk-d****demo', group: 'gpt-promax',
            masked: 'sk-d****demo', models: 124, boundAt: now - 3 * DAY,
            balance: '$1.92', balanceRaw: 960000, used: '$68.19', usedRaw: 34095000,
          },
        },
        groups: [['gpt-promax', 0.16], ['claude-kiro', 0.10], ['国模', 0.15], ['绘图', 1], ['视频', 1]],
        counts: { models: 125, rows: 189, groups: 14 },
      };
    }
    if (path.startsWith('/api/usage')) {
      const range = new URL(path, 'http://x').searchParams.get('range') || 'day';
      const [start, end] = rangeOf(range);
      return summarizeRows(rows, null, start, end);
    }
    if (path === '/api/subscriptions') {
      return {
        ok: true, billingPreference: 'subscription_first', plansError: '', at: now,
        subscriptions: [
          { id: 461, planId: 3, title: '演示 · Plus 月度套餐', status: 'active', active: true, endAt: now + 20 * DAY, nextResetAt: now + 3 * DAY, used: '$28.18', total: '$30.00', remaining: '$1.82', progress: 93.93, unlimited: false },
          { id: 462, planId: 4, title: '演示 · 不限量套餐', status: 'cancelled', active: false, endAt: now - DAY, nextResetAt: null, used: '$42.00', total: '不限量', remaining: '不限量', progress: null, unlimited: true },
          { id: 463, planId: 3, title: '演示 · 已超额套餐', status: 'expired', active: false, endAt: now - 2 * DAY, nextResetAt: null, used: '$33.00', total: '$30.00', remaining: '-$3.00', progress: 110, unlimited: false },
        ],
        plans: [{ id: 3, title: '演示 · Plus 月度套餐', subtitle: '套餐额度与钱包余额分别展示', price: '30 USD', priceAmount: 30, priceCurrency: 'USD', durationUnit: 'month', durationValue: 1, total: '$30.00', unlimited: false, quotaResetPeriod: 'weekly' }],
      };
    }
    if (path === '/api/aff') {
      return {
        ok: true,
        aff: { count: 2, quota: 12500, historyQuota: 37500, pending: 12500 },
        code: '0mY4',
        link: 'https://newapi.dragon3api.com/sign-up?aff=0mY4',
        note: '',
        at: now,
      };
    }
    if (path === '/api/keys') {
      return {
        ok: true,
        keys: [
          { id: 101, name: 'Magpie-gpt-plus', group: 'gpt-promax', key: 'sk-demo-a**********101', status: 1, remainQuota: '∞', bound: true },
          { id: 102, name: 'Magpie-claude', group: 'claude-kiro', key: 'sk-demo-b**********102', status: 1, remainQuota: '$3.20', bound: false },
          { id: 103, name: '脚本备用', group: '国模', key: 'sk-demo-c**********103', status: 2, remainQuota: '$0.00', bound: false },
        ],
        groups: ['gpt-promax', 'gpt-plus', 'claude-kiro', 'claude-kiro正价', 'claude-max企业', 'gemini', '国模', '绘图', '视频', '视频'],
      };
    }
    if (path === '/api/bind-info') {
      return {
        ok: true,
        how: [
          '在 magpie 的供应商列表里打开 DragonAPI，点「添加账号」。',
          '选「用访问令牌自动建钥匙」：插件会按你选的分组建一把新钥匙并自动绑定。',
          '或者选「DragonAPI API Key」，把上面复制到的 sk- 钥匙粘进去。',
        ],
        auto: { label: '用访问令牌自动建钥匙', method: 'pat' },
      };
    }
    if (path.startsWith('/api/catalog')) {
      // 目录演示数据：与 /api/catalog 服务端输出同形状（models[]，每行一个分组价）。
      // 挑 8 个模型 × 各自分组，覆盖对话/生图/视频三种计费。
      const G = {
        'claude-kiro': 0.10, 'claude-kiro正价': 0.35, 'claude-cursor': 0.40, 'claude-max企业': 1.20,
        'gpt-plus': 0.10, 'gpt-pro': 0.16, 'gpt-promax': 0.16, 'gemini': 0.30, '国模': 0.15, 'image': 1, '视频': 1,
      }
      const spec = (name, vendor, kind, groups, inPrice, outPrice, cachePrice, desc, extra = {}) => ({
        name, vendor,
        kind,
        groups: groups.map((g) => ({ id: g, ratio: G[g], note: '', auto: false })),
        pricing: { kind: 'token', input: `$${inPrice}/M`, output: `$${outPrice}/M`, cache: `$${cachePrice}/M` },
        desc, ...extra,
      })
      return {
        ok: true,
        models: [
          spec('claude-fable-5-2', 'Anthropic', 'chat', ['claude-cursor', 'claude-max企业'], '3.20', '16.00', '0.08', 'Anthropic 的对话模型，支持 Anthropic 兼容 / OpenAI 兼容端点；按倍率计费。'),
          spec('claude-opus-5-5', 'Anthropic', 'chat', ['claude-kiro', 'claude-kiro正价', 'claude-cursor', 'claude-max企业'], '0.40', '2.00', '0.02', 'Anthropic 的对话模型，分档计费。'),
          spec('claude-sonnet-5-5', 'Anthropic', 'chat', ['claude-kiro', 'claude-kiro正价', 'claude-max企业'], '0.20', '1.00', '0.01', 'Anthropic 的对话模型，按倍率计费。'),
          spec('gpt-6.1-sol', 'OpenAI', 'chat', ['gpt-plus', 'gpt-pro', 'gpt-promax'], '1.75', '14.00', '0.18', '通用推理与工具调用，支持多轮工作流。'),
          spec('gemini-3-pro-preview', 'Google', 'chat', ['gemini'], '2.00', '12.00', '0.20', '多模态理解与复杂推理。'),
          spec('deepseek-v3.2', 'DeepSeek', 'chat', ['国模'], '0.28', '0.42', '0.03', '通用对话、代码与中文写作。'),
          spec('gpt-image-2.6', 'OpenAI', 'image', ['image'], '0.04', '0', '0', '根据提示生成或编辑图像。', { pricing: { kind: 'perimage', input: '$0.20/张', output: '$0.20/张' } }),
          spec('seedance-2.5', '字节跳动', 'video', ['视频'], '0.30', '0', '0', '官方key 720p 4.30折。480p ¥0.30 / 720p ¥0.65 / 1080p ¥1.60 每秒。', { pricing: { kind: 'percall', input: '$0.30-1.60/秒', output: '$0.30-1.60/秒' } }),
        ],
      }
    }
    if (path === '/api/health') {
      return {
        ok: true,
        version: 'demo',
        port: 3672,
        site: 'https://newapi.dragon3api.com',
        catalogVersion: 'demo-1',
        history: [{ at: now, ok: true, source: 'live', ms: 180 }],
      }
    }
    throw new Error(`演示模式没有准备这个接口：${path}`);
  };
}