# DragonAPI in Magpie · 本地服务 API 契约（UI 侧唯一事实来源）

> 页面（`ui/`）跑在本插件的本地服务里：`http://127.0.0.1:<port>/`。
> 页面文档的 origin 是 **opaque**（`Origin: null`），所以：
> - 所有响应必须带 `Access-Control-Allow-Origin: *`，且**不能用 cookie / credentials**；
> - **禁止 localStorage / sessionStorage / indexedDB**（沙箱里会抛异常），状态全部走服务端；
> - 所有请求用 `fetch(url, { credentials: "omit" })`。

## 0. 约定

- 全部 JSON；错误统一 `{ ok: false, error: "人话原因" }`，HTTP 状态码同时给出。
- 成功统一 `{ ok: true, ... }`。
- 金额一律用**字符串**（已格式化，带符号），避免浮点误差；原始数字另给 `*Raw` 字段。
- 时间一律 epoch 毫秒（`at`），另有 `atText` 供直接显示。

## 1. 站点与连接状态

### `GET /api/ping`
```json
{ "ok": true, "version": "0.1.0", "port": 3517 }
```

### `GET /api/state`
```json
{
  "ok": true,
  "site": "https://newapi.dragon3api.com",
  "siteName": "DragonAPI",
  "pat": { "set": true, "hint": "nap_…a1b2", "scopes": ["profile:read", "api_key:read"] },
  "currency": { "symbol": "$", "per": 500000, "rate": 1, "display": true, "code": "USD" },
  "accounts": [
    {
      "key": "dragonapi#ab12cd",
      "label": "gpt-plus · 主钥匙",
      "group": "gpt-plus",
      "masked": "sk-a**********9f3c",
      "models": 5,
      "boundAt": 1762700000000,
      "balance": "¥12.34",
      "balanceRaw": 6170000,
      "used": "¥3.21",
      "usedRaw": 1605000,
      "tokenName": "Magpie-gpt-plus"
    }
  ],
  "groups": [
    { "id": "gpt-plus", "ratio": 0.1, "note": "GPT 日常档", "models": 5, "auto": false }
  ],
  "counts": { "models": 122, "rows": 195, "groups": 14, "vendors": 29 },
  "catalogAt": 1762700000000,
  "health": { "ok": true, "source": "live", "ms": 412, "at": 1762700000000 }
}
```

### `POST /api/pat`
```json
// 请求
{ "pat": "nap_xxx" }
// 响应
{ "ok": true, "pat": { "set": true, "hint": "nap_…a1b2", "scopes": ["profile:read"] }, "user": { "name": "fish", "id": 12 } }
```
校验方式：`GET /api/user/self` + `GET /api/token/?p=0&size=1`。失败返回 400 与原因。

### `DELETE /api/pat`
```json
{ "ok": true, "pat": { "set": false } }
```

## 2. 模型广场（**纯展示，没有启用/停用开关**）

### `GET /api/catalog?refresh=1`
```json
{
  "ok": true,
  "version": "a42d372c…",
  "at": 1762700000000,
  "source": "live",
  "groups": [ { "id": "gpt-plus", "ratio": 0.1, "note": "…", "models": 5, "auto": false } ],
  "vendors": [ { "id": 2, "name": "OpenAI" } ],
  "models": [
    {
      "id": "gpt-plus/gpt-6-sol",
      "name": "gpt-6-sol",
      "group": "gpt-plus",
      "groupRatio": 0.1,
      "vendor": "OpenAI",
      "kind": "chat",
      "endpoints": ["openai"],
      "context": 272000,
      "pricing": {
        "kind": "ratio",
        "input": "$2.00/M",
        "output": "$10.00/M",
        "cache": "$0.20/M",
        "note": ""
      },
      "description": "…",
      "tags": "…"
    }
  ]
}
```
`kind` ∈ `chat | image | video | audio | embedding`。
`pricing.kind` ∈ `ratio | tiered | percall | unknown`，解析不出来时 `kind: "unknown"` 且 `note` 说明原因（**不允许编造价格**）。

### `GET /api/model?group=gpt-plus&model=gpt-6-sol`
单模型详情，额外返回：
```json
{ "ok": true, "billing": { "mode": "tiered_expr", "expr": "…", "tiers": [ { "name": "short_context", "input": 2, "output": 10 } ], "usages": [ { "field": "seconds", "unit": "second", "price": 0.45 } ], "schema": { … }, "examples": [ … ] } }
```

## 3. 余额与用量

### `GET /api/usage?range=day|week|month`
```json
{
  "ok": true,
  "range": "day",
  "start": 1762617600000,
  "end": 1762704000000,
  "spent": "$1.23",
  "spentRaw": 615000,
  "tokens": 123456,
  "byModel": [ { "model": "gpt-6-sol", "tokens": 1000, "cost": "$0.12", "costRaw": 60000, "calls": 3 } ],
  "buckets": [ { "at": 1762617600000, "cost": "$0.05", "costRaw": 25000 } ],
  "rows": [
    {
      "at": 1762700000000, "atText": "11-10 18:22",
      "kind": "消耗", "model": "gpt-6-sol", "group": "gpt-plus", "tokenName": "Magpie-gpt-plus",
      "input": 1200, "output": 800, "cache": 0, "cost": "$0.02", "costRaw": 10000,
      "tps": 42, "ttft": 0.8, "dur": 3.2, "detail": "short_context · $2 / $10/M", "isStream": true
    }
  ]
}
```
`rows` 最多 200 条，按时间倒序。多账号时合并。

### `GET /api/logs?limit=200&account=<key>`
同 `rows` 的扁平列表，供「用量」页翻看。

## 4. 密钥管理（需要 PAT）

### `GET /api/keys`
```json
{
  "ok": true,
  "keys": [
    { "id": 12, "name": "Magpie-gpt-plus", "group": "gpt-plus", "masked": "sk-a**********9f3c",
      "createdAt": 1762700000000, "expiredAt": 0, "remain": 0, "used": 1605000,
      "unlimited": true, "status": 1, "bound": true }
  ],
  "groups": ["gpt-plus", "gpt-pro"]
}
```
`bound` 表示这把钥匙是否已作为 magpie 账号存在（按后四位 + 前缀匹配本插件记录的账号）。
`groups` 是**当前账号可建钥匙的分组**（来自 `GET /api/user/self/groups`）。

### `POST /api/keys`
```json
// 请求
{ "name": "Magpie-gpt-plus", "group": "gpt-plus", "unlimited": true, "expiredAt": 0 }
// 响应
{ "ok": true, "key": { "id": 12, "name": "…", "group": "…", "secret": "sk-…完整钥匙…" }, "bind": { "manual": true, "how": "…" } }
```
**`secret` 只在这一个响应里出现一次**，服务端不落盘明文（只记后四位）。

### `DELETE /api/keys/:id`
```json
{ "ok": true }
```

### `POST /api/keys/:id/reveal`
```json
{ "ok": true, "secret": "sk-…" }
```
需要 PAT 的 `api_key:reveal` 权限；没有就返回 403 并说明。

## 5. 绑定说明（服务端不能直接写 magpie 的账号表）

### `GET /api/bind-info`
```json
{
  "ok": true,
  "how": [
    "在 magpie 的供应商列表里打开 DragonAPI，点『添加账号』。",
    "选『用访问令牌自动建钥匙』：插件会按你选的分组建一把新钥匙并自动绑定。",
    "或者选『DragonAPI API Key』，把上面复制到的 sk- 钥匙粘进去。"
  ],
  "auto": { "method": "pat", "label": "用访问令牌自动建钥匙" }
}
```

## 6. 健康与诊断

### `GET /api/health`
```json
{ "ok": true, "recent": [ { "at": 1762700000000, "ok": true, "source": "live", "count": 195, "ms": 412 } ] }
```

## 7. UI 必须做到的事

1. **模型广场是只读的**：显示分组、倍率、模型、价格、端点类型；没有启用/停用开关，没有「已选」状态。
2. 分组筛选、搜索、按 kind 过滤；价格未知的模型明确标「价格未知」，不猜。
3. 余额卡 + 用量卡（按天/周/月）+ 用量流水表。
4. 密钥页：列出现有钥匙（打码）、按分组建新钥匙、建完显示一次完整钥匙并提供复制、删除钥匙、查看完整钥匙（需 reveal 权限）。
5. PAT 页：填入/清除访问令牌，说明需要哪些 scope。
6. 所有网络失败都要有可读提示，不能白屏；不能使用 localStorage。
