/**
 * dashboard 数据看板聚合。
 *
 * 站点 `/api/data/self` 返回按「时间桶 × 模型」拆好的行：
 * `{ created_at, model_name, count, quota, token_used, cache_read_tokens, cache_creation_tokens }`。
 * 这里只做确定性的汇总，金额换算交给页面（页面才知道币种与倍率）。
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * summarizeDashboard 汇总站点数据看板的行。
 *
 * @param {Array<object>} rows 站点 `/api/data/self` 的行
 * @param {{ start: number, end: number }} span 时间窗（毫秒）
 */
export function summarizeDashboard(rows, span = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const totals = { count: 0, quota: 0, tokens: 0, cacheRead: 0, cacheWrite: 0 };
  const models = new Map();
  const buckets = new Map();

  for (const row of list) {
    const at = Math.floor(num(row.created_at) * 1000) || 0;
    const model = String(row.model_name || '');
    const count = num(row.count);
    const quota = num(row.quota);
    const tokens = num(row.token_used);
    const cacheRead = num(row.cache_read_tokens);
    const cacheWrite = num(row.cache_creation_tokens);

    totals.count += count;
    totals.quota += quota;
    totals.tokens += tokens;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;

    const m = models.get(model) || { model, count: 0, quota: 0, tokens: 0, cacheRead: 0, cacheWrite: 0 };
    m.count += count;
    m.quota += quota;
    m.tokens += tokens;
    m.cacheRead += cacheRead;
    m.cacheWrite += cacheWrite;
    models.set(model, m);

    const b = buckets.get(at) || { at, count: 0, quota: 0, tokens: 0, values: {} };
    b.count += count;
    b.quota += quota;
    b.tokens += tokens;
    b.values[model] = (b.values[model] || 0) + quota;
    buckets.set(at, b);
  }

  const minutes = Math.max(1, (num(span.end) - num(span.start)) / 60000);
  const sortedModels = [...models.values()].sort((a, b) => b.quota - a.quota || b.count - a.count);
  return {
    totals: {
      ...totals,
      avgRpm: totals.count / minutes,
      avgTpm: totals.tokens / minutes,
    },
    models: sortedModels,
    buckets: [...buckets.values()].sort((a, b) => a.at - b.at),
    minutes,
  };
}
