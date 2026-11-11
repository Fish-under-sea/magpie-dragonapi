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
  "pat": {
    "set": true,
    "hint": "nap_…a1b2",
    "scopes": ["profile:read", "api_key:read"],
    "verified": true,
    "stateFile": "C:\\…\\magpie\\data\\dragonapi-state.json"
  },
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

### `/api/state` 的 PAT 钱包增量字段

无 PAT 时 `user: null, userError: ""`。有 PAT 时实时读 `/api/user/self`，仅返回以下白名单（不包含 raw、email、access_token、aff_code 或其它上游字段）：

```json
{
  "user": {
    "id": 7, "username": "fish", "displayName": "Fish", "group": "gpt-plus",
    "balance": "$1.00", "balanceRaw": 500000,
    "used": "$0.50", "usedRaw": 250000
  },
  "userError": ""
}
```

钱包 quota 缺失/非法时相应 Raw 为 `null`，格式化金额为 `"—"`，不是零。
self 失败时仍回 state 的 `ok:true`，但 `user:null`、`userError` 带真实错误；UI 必须显示错误。
`accounts` **仍只表示绑定 sk 账户**，PAT-only 时为空。钱包额度与 sk 额度不是独立资金，**不可相加**。

### `POST /api/pat`
```json
// 请求
{ "pat": "nap_xxx" }
// 成功响应（令牌至少有一个端点验通）
{
  "ok": true,
  "pat": {
    "set": true,
    "hint": "nap_…a1b2",
    "scopes": ["profile:read", "api_key:read", "usage:read"],
    "verified": true,
    "missing": [],
    "persisted": true
  },
  "user": { "name": "fish", "id": 12 },
  "warning": ""
}
```

校验方式：**并行四个只读端点**，每次请求超时 **12 秒**：
`/api/user/self` → `profile:read`、`/api/token/` → `api_key:read`、
`/api/log/self` → `usage:read`、`/api/subscription/self` → `wallet:read`；**不写任何东西**。
保存前先 normalize PAT：去空白、引号、Authorization/Bearer 前缀与零宽字符；
PAT 出站同时发送 `Authorization: Bearer <PAT>` 与 `new-api-access-token: <PAT>`，sk 不带后者。
仅 wallet:read 可用也接受，scope 只记录结构校验通过的端点。

判定规则（这是「访问令牌保存失败」那次事故的根因，改之前先读）：

| 情况 | 行为 |
| --- | --- |
| 四个端点全 401/403（或返回 AUTH_* 错误码） | **拒收**，HTTP 400，`error` 带站点原话，`hint` 说清怎么改权限 |
| 至少一个通了，但缺别的 scope | **收下**，`warning` 指名缺哪一格，`scopes` 只列能用的 |
| 一个都没通，但都不是鉴权错误（超时 / 非 JSON 验证页） | **收下**，`verified: false`，`warning` 说「没能连上站点验证」 |
| 令牌能用但状态文件写不进去 | HTTP 500，`error` 带**状态文件路径与原因**，`pat.persisted: false` |

不允许出现「返回 ok 但没落盘」——那会变成用户重启后令牌凭空消失。

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
单模型详情。`billing` 里的字段**已经折成可以直接显示的量**，页面不该再自己解析表达式：

```json
{
  "ok": true,
  "billing": {
    "mode": "tiered_expr",
    "modeLabel": "表达式分档计费",
    "expr": "tier(\"short_context\", p*2 + c*10) * (param(\"service_tier\") == \"priority\" ? 2 : 1)",
    "groupRatio": 1,
    "currency": { "symbol": "$", "code": "USD" },
    "tiers": [
      {
        "name": "short_context",
        "body": "p*2 + c*10",
        "coeffs": { "input": 2, "output": 10 },
        "prices": { "input": "$2.00/M", "output": "$10.00/M" }
      }
    ],
    "multipliers": [{ "param": "service_tier", "value": "priority", "factor": 2 }],
    "usages": { "seconds": { "min": 0.16, "max": 0.16 } },
    "usageRows": [{ "field": "seconds", "label": "时长", "unit": "秒", "price": "$0.1600/秒", "min": 0.16, "max": 0.16 }],
    "schema": { },
    "examples": []
  }
}
```

| 字段 | 用途 |
| --- | --- |
| `tiers[].prices` | 每档实际单价（系数 × 分组倍率）。**不要读 `tiers[].input`——那个字段不存在** |
| `multipliers` | 整单倍率规则，如 `service_tier=priority` 时 ×2 |
| `usageRows` | 视频/按秒模型的字段 / 单位 / 单价，单位已尽量翻成中文 |
| `schema` / `examples` | 站点原文，只作为证据收在折叠块里 |

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
`rows` 最多 200 条，按时间倒序。`/api/usage` 也接受可选 `account=<key>`。

- **有 PAT 且未指定 account**：只走 `/api/log/self`，`source: "pat"`，不叠加 sk 日志。
- **显式 account**：只走该绑定 sk 的 `/api/log/token`，`source: "key"`；找不到账号、钥匙尚未载入或读取失败明确报错，绝不退回 PAT。
- 无 PAT 且未指定 account：读取各绑定 sk，`source: "key"`；任一失败明确报错，不跳过后伪装完整统计。
- 上游接受裸数组、`data` 数组、`data.items`、`data.data`；未知结构与 `success:false` 都是错误，不会回空成功。
- 只请求最近最多 100 条（sk 为每把最多 100 条），**不分页**。成功响应总带 `partial: true` 与 `note`，说明非完整用量；UI 不能把它当完整窗口统计。
- 所选 day/week/month 毫秒窗口通过 `start_timestamp` / `end_timestamp` 转成 **Unix 秒**发送到上游，再在本地过滤。

### `GET /api/logs?range=day|week|month&limit=200&account=<key>`
同 `rows` 的扁平列表，供「用量」页翻看。`range` 默认 day，窗口口径与 `/api/usage` 相同；
响应为 `{ok,range,start,end,source,partial,note,rows}`，`limit` 范围 1–500，但不会增加上游取样条数。

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

## 7. 订阅与钱包（需要 PAT wallet:read，只读）

### `GET /api/subscriptions`

并行读取站点 `/api/subscription/self` 与 `/api/subscription/plans`。
self 失败（含鉴权、`success:false`、未知数据结构）明确回 `{ok:false,error}`；
plans 失败仍返回 self，`plans:[]`、`plansError` 为真实错误，UI 必须显示而非假装没有套餐。
上游 self 必须含 `subscriptions` 或 `all_subscriptions` 数组；两数组合并、按订阅 id 去重，
兼容每项的 `.subscription` wrapper。plans 兼容数组或 `data.plans`，每项兼容 `.plan` wrapper。

```json
{
  "ok": true,
  "subscriptions": [{
    "id": 1, "planId": 7, "title": "Pro", "status": "active", "active": true,
    "startAt": 1800000000000, "endAt": 1802592000000, "nextResetAt": 1800086400000,
    "totalRaw": 500000, "usedRaw": 750000, "remainingRaw": -250000,
    "total": "$1.00", "used": "$1.50", "remaining": "$-0.50",
    "unlimited": false, "progress": 150
  }],
  "plans": [{
    "id": 7, "title": "Pro", "subtitle": "月度套餐",
    "durationUnit": "month", "durationValue": 1,
    "totalRaw": 500000, "total": "$1.00", "unlimited": false,
    "quotaResetPeriod": "daily", "upgradeGroup": "pro",
    "priceAmount": 9.99, "priceCurrency": "USD", "price": "USD 9.99"
  }],
  "billingPreference": "subscription_first",
  "plansError": "",
  "at": 1800000000000
}
```

- 所有响应均白名单，不透传原始 user/subscription/plan。
- 标题优先嵌入 `.plan.title`，其次用 `plan_id` join plans，最后 `套餐 #<id>`。
- start/end/next reset 从上游 Unix 秒转为毫秒；缺失为 null。
- `active` 仅在 `status === "active"`、endAt 大于当前时间、且开始时间未在未来时为 true。
  缺失或零到期时间不擅自视为有效；取消/过期状态不是 active。
- 订阅 quota 取 amount_total/amount_used（兼容 total_amount/used_amount），
  套餐 quota 取 total_amount（兼容 amount_total）；统一用站点 currencyOf/text 折算。
  数值未知时 Raw 为 null、金额为空字符串，不伪装零。
- **真实 total=0 才是 unlimited**，total 显示 `不限量`、remainingRaw/progress 为 null、remaining 为空。
- 有限额度 `remainingRaw=total-used`；`progress=used/total*100` 是真实百分比，可大于100，
  UI 仅对进度条宽度 clamp，不改数字。不要根据 active 或进度反推资金余额。
- 套餐 `priceAmount/priceCurrency/price` 是**售价原币**，不使用 quota 汇率转换。
  缺少价格为 null/空字符串，缺周期 durationValue 为 null；其余缺描述字段为空字符串。
- `billingPreference` 只读，四值：subscription_first / wallet_first / subscription_only / wallet_only；
  未知或缺失为 null。没有修改偏好/购买订阅接口，不发资金写请求。

## 8. 推荐奖励

### `GET /api/aff`

并行读 `/api/user/aff` 与 `/api/user/self`。aff 的 data 既可对象也可邀请码字符串；
从 self 优先提取真实 `aff_count` / `aff_quota` / `aff_history_quota`，兼容 aff 对象提供这些字段。

```json
{
  "ok": true,
  "aff": { "count": 3, "quota": 500000, "historyQuota": 900000 },
  "code": "invite-code", "link": "https://site/sign-up?aff=invite-code",
  "note": "", "at": 1800000000000
}
```

count/quota/historyQuota/pending **缺字段就省略**（非0）；无任何指标时 aff 为 null。
一端失败仍保留另一端能读的数据，并在 note 保留真实错误，**包括401/403**，
不得将鉴权失败改写成“站点未开放”；缺 profile 权限但能读 aff 时仍可只显示邀请码。
两端都失败明确回 `{ok:false,error}`。quota/historyQuota/pending 是原始 quota，不是已格式化金额。

`POST /api/aff/transfer` 保持原有资金逻辑，本次未修改。

## 9. UI 必须做到的事

1. **模型广场是只读的**：显示分组、倍率、模型、价格、端点类型；没有启用/停用开关，没有「已选」状态。
2. 分组筛选、**厂商筛选**、搜索、按 kind 过滤；价格未知的模型明确标「价格未知」，不猜。
3. **详情抽屉给结论，不倒原文**：价格 / 概览 / 计费方式（中文）/ 每档实际单价 / 按用量单价；原始表达式与 schema 折叠在「原始计费表达式」里，空数组不渲染。中文值不用等宽字体。
4. 余额卡 + 用量卡（按天/周/月）+ 用量流水表。
5. 密钥页：列出现有钥匙（打码）、按分组建新钥匙、建完显示一次完整钥匙并提供复制、删除钥匙、查看完整钥匙（需 reveal 权限）。
6. PAT 页：填入/清除访问令牌，说明需要哪些 scope；保存后显示验到的 scope。缺 scope 时给「哪些功能会失败」的提示，不要一句「不可用」打死。
7. 所有网络失败都要有可读提示，不能白屏；不能使用 localStorage。
