# API 参考文档

> 2026-09-11: Automation now has only `klineSync` and `positionReview`. See [current task flow and API](automation-two-tasks.md). The automation examples below describe the previous implementation.

全局自动化系统的完整API接口说明。

## 基础信息

**Base URL**: `http://127.0.0.1:3100`  
**Content-Type**: `application/json`  
**认证**: 无需认证（本地服务）

---

## 系统控制

### 启动自动化

启动全局自动化系统，开始定时任务。

```http
POST /api/automation/start
```

**响应示例：**
```json
{
  "message": "全局自动化系统已启动"
}
```

**curl示例：**
```bash
curl -X POST http://127.0.0.1:3100/api/automation/start
```

---

### 停止自动化

停止全局自动化系统，取消所有定时任务。

```http
POST /api/automation/stop
```

**响应示例：**
```json
{
  "message": "全局自动化系统已停止"
}
```

**curl示例：**
```bash
curl -X POST http://127.0.0.1:3100/api/automation/stop
```

---

### 查看系统状态

获取系统完整状态，包括任务配置、统计数据和账户信息。

```http
GET /api/automation/status
```

**响应示例：**
```json
{
  "tasks": {
    "klineSync": {
      "enabled": true,
      "interval": 60000,
      "lastRun": "2026-09-08T10:30:00.000Z",
      "running": false
    },
    "analysis": {
      "enabled": true,
      "interval": 7200000,
      "lastRun": "2026-09-08T09:00:00.000Z",
      "running": false
    },
    "positionReview": {
      "enabled": true,
      "interval": 300000,
      "lastRun": "2026-09-08T10:29:00.000Z",
      "running": false
    }
  },
  "stats": {
    "totalAnalyzed": 150,
    "totalOrders": 25,
    "totalReviews": 120,
    "errors": [
      {
        "task": "klineSync",
        "error": "网络超时",
        "time": "2026-09-08T10:25:00.000Z"
      }
    ]
  },
  "account": {
    "unlimitedCapital": true,
    "investedMargin": 2500,
    "closedMargin": 500,
    "realizedReturn": 0.05,
    "balance": null,
    "usedMargin": 2500,
    "realized": 25.50,
    "unrealized": 15.20,
    "net": 40.70,
    "openCount": 25
  },
  "uptime": 3600
}
```

**字段说明：**

| 字段 | 类型 | 描述 |
|------|------|------|
| tasks | object | 三大任务的配置和状态 |
| tasks.*.enabled | boolean | 任务是否启用 |
| tasks.*.interval | number | 任务间隔（毫秒） |
| tasks.*.lastRun | string | 上次运行时间（ISO 8601） |
| tasks.*.running | boolean | 是否正在运行 |
| stats.totalAnalyzed | number | 累计分析币种数 |
| stats.totalOrders | number | 累计下单数 |
| stats.totalReviews | number | 累计复核次数 |
| stats.errors | array | 最近错误（最多50条） |
| account | object | 模拟账户状态 |
| uptime | number | 进程运行时间（秒） |

**curl示例：**
```bash
curl http://127.0.0.1:3100/api/automation/status | jq
```

---

## 任务配置

### 配置任务

修改任务的启用状态或运行间隔。

```http
PUT /api/automation/tasks/:taskName
Content-Type: application/json

{
  "enabled": true,
  "interval": 60000
}
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| taskName | string | 是 | 任务名称：`klineSync`、`analysis`、`positionReview` |

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| enabled | boolean | 否 | 是否启用任务 |
| interval | number | 否 | 任务间隔（毫秒，>0） |

**响应示例：**
```json
{
  "enabled": false,
  "interval": 60000,
  "lastRun": "2026-09-08T10:30:00.000Z",
  "running": false
}
```

**curl示例：**

```bash
# 禁用K线同步
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/klineSync \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# 修改分析间隔为1小时
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/analysis \
  -H "Content-Type: application/json" \
  -d '{"interval": 3600000}'

# 修改复核间隔为1分钟
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/positionReview \
  -H "Content-Type: application/json" \
  -d '{"interval": 60000}'
```

---

### 手动触发任务

立即执行一次任务，不等待定时器。

```http
POST /api/automation/tasks/:taskName/trigger
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| taskName | string | 是 | 任务名称：`klineSync`、`analysis`、`positionReview` |

**响应示例：**
```json
{
  "message": "任务已提交",
  "task": "analysis"
}
```

**说明：**
- 任务异步执行，立即返回
- 查看 `/api/automation/status` 获取任务状态
- 任务运行中时不会重复触发

**curl示例：**

```bash
# 立即同步K线
curl -X POST http://127.0.0.1:3100/api/automation/tasks/klineSync/trigger

# 立即分析行情
curl -X POST http://127.0.0.1:3100/api/automation/tasks/analysis/trigger

# 立即复核持仓
curl -X POST http://127.0.0.1:3100/api/automation/tasks/positionReview/trigger
```

---

## 账户查询

### 查看模拟账户

获取模拟账户的完整状态，包括余额、持仓和订单列表。

```http
GET /api/paper/account
```

**响应示例：**
```json
{
  "unlimitedCapital": true,
  "investedMargin": 2500,
  "closedMargin": 500,
  "realizedReturn": 0.05,
  "initialBalance": 10000,
  "balance": null,
  "available": null,
  "equity": null,
  "usedMargin": 2500,
  "realized": 25.50,
  "unrealized": 15.20,
  "net": 40.70,
  "openCount": 25,
  "automation": {
    "version": 1,
    "enabled": true,
    "engine": "local",
    "interval": "1m",
    "margin": 100,
    "scan": {
      "nextAt": 1725804000000,
      "running": false
    },
    "review": {
      "nextAt": 1725800400000,
      "running": false
    }
  },
  "orders": [
    {
      "id": "uuid-1",
      "symbol": "BTCUSDT",
      "direction": "OPEN_LONG",
      "status": "open",
      "margin": 100,
      "leverage": 3,
      "notional": 300,
      "entry": 50000,
      "quantity": 0.006,
      "markPrice": 51000,
      "unrealized": 5.99,
      "plan": {
        "stopLoss": 49000,
        "takeProfit": 53000,
        "entryMin": 49800,
        "entryMax": 50200,
        "maxHoldBars": 120
      },
      "protectionRevisions": [
        {
          "stopLoss": 50000,
          "takeProfit": 54000,
          "effectiveFrom": 1725800400000,
          "at": "2026-09-08T10:30:00.000Z"
        }
      ],
      "reviewHistory": [
        {
          "at": "2026-09-08T10:30:00.000Z",
          "engine": "local",
          "action": "updated",
          "reason": "按最新 14 根真实波幅复核；只收紧止损，顺势调整止盈。",
          "previous": {
            "stopLoss": 49000,
            "takeProfit": 53000
          },
          "stopLoss": 50000,
          "takeProfit": 54000
        }
      ],
      "createdAt": "2026-09-08T08:00:00.000Z",
      "entryAt": "2026-09-08T08:05:00.000Z",
      "markAt": "2026-09-08T10:30:00.000Z",
      "heldBars": 145
    }
  ],
  "busy": false,
  "lastRunAt": "2026-09-08T10:30:00.000Z",
  "error": ""
}
```

**字段说明：**

| 字段 | 类型 | 描述 |
|------|------|------|
| unlimitedCapital | boolean | 是否启用无限资金模式 |
| investedMargin | number | 累计投入保证金 |
| closedMargin | number | 已平仓保证金 |
| realizedReturn | number | 已平仓收益率 |
| balance | number\|null | 余额（无限资金时为null） |
| usedMargin | number | 已用保证金 |
| realized | number | 已实现盈亏 |
| unrealized | number | 未实现盈亏 |
| net | number | 净盈亏 |
| openCount | number | 持仓数量 |
| orders | array | 订单列表 |

**curl示例：**

```bash
# 查看完整账户
curl http://127.0.0.1:3100/api/paper/account | jq

# 仅查看概况
curl http://127.0.0.1:3100/api/paper/account | jq '{
  openCount,
  usedMargin,
  realized,
  unrealized,
  net
}'

# 查看持仓
curl http://127.0.0.1:3100/api/paper/account | jq '.orders[] | select(.status=="open")'

# 查看已平仓
curl http://127.0.0.1:3100/api/paper/account | jq '.orders[] | select(.status=="closed")'
```

---

### 刷新模拟持仓

更新所有持仓的最新行情和盈亏状态。

```http
POST /api/paper/refresh
```

**响应示例：**
同 `/api/paper/account`

**curl示例：**
```bash
curl -X POST http://127.0.0.1:3100/api/paper/refresh | jq
```

---

### 手动平仓

手动平仓指定订单。

```http
POST /api/paper/orders/:id/close
```

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 订单ID（UUID） |

**响应示例：**
```json
{
  "id": "uuid-1",
  "status": "closed",
  "exit": 51000,
  "exitAt": "2026-09-08T10:35:00.000Z",
  "reason": "manual",
  "net": 5.88
}
```

**curl示例：**
```bash
# 获取订单ID
ORDER_ID=$(curl -s http://127.0.0.1:3100/api/paper/account | jq -r '.orders[0].id')

# 平仓
curl -X POST "http://127.0.0.1:3100/api/paper/orders/$ORDER_ID/close" | jq
```

---

## 分析查询

### 查看分析列表

获取历史分析记录。

```http
GET /api/research/list?limit=100&date=2026-09-08
```

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| limit | number | 否 | 返回数量（默认100） |
| date | string | 否 | 日期过滤（YYYY-MM-DD） |
| symbol | string | 否 | 币种过滤 |

**响应示例：**
```json
[
  {
    "id": "auto-runid-BTCUSDT",
    "at": "2026-09-08T08:00:00.000Z",
    "type": "single",
    "analysisEngine": "local",
    "analyses": [
      {
        "symbol": "BTCUSDT",
        "action": "BUY",
        "confidence": 0.75,
        "confidenceType": "rule_strength",
        "reason": "本地规则：20 根均线高于50 根均线，收盘价与趋势同向。",
        "eligible": true,
        "plan": {
          "entryMin": 49800,
          "entryMax": 50200,
          "stopLoss": 49000,
          "takeProfit": 53000,
          "maxHoldBars": 120
        },
        "recommendedLeverage": 3
      }
    ]
  }
]
```

**curl示例：**

```bash
# 最近100条
curl http://127.0.0.1:3100/api/research/list?limit=100 | jq

# 今天的分析
curl "http://127.0.0.1:3100/api/research/list?date=$(date +%Y-%m-%d)" | jq

# 特定币种
curl "http://127.0.0.1:3100/api/research/list?symbol=BTCUSDT&limit=10" | jq
```

---

### 查看策略表现

获取策略的统计表现数据。

```http
GET /api/research/performance?date=2026-09-08
```

**查询参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| date | string | 否 | 日期过滤（YYYY-MM-DD） |
| symbol | string | 否 | 币种过滤 |

**响应示例：**
```json
{
  "asOf": "2026-09-08T10:35:00.000Z",
  "records": 150,
  "truncated": false,
  "excluded": 20,
  "summary": {
    "count": 130,
    "winCount": 78,
    "winRate": 0.6,
    "avgReturn": 0.025,
    "totalReturn": 3.25
  },
  "byStrategy": [...],
  "bySymbol": [...],
  "byDirection": [
    {
      "key": "OPEN_LONG",
      "count": 65,
      "winRate": 0.62,
      "avgReturn": 0.028
    },
    {
      "key": "OPEN_SHORT",
      "count": 65,
      "winRate": 0.58,
      "avgReturn": 0.022
    }
  ]
}
```

**curl示例：**

```bash
# 完整表现
curl http://127.0.0.1:3100/api/research/performance | jq

# 今天的表现
curl "http://127.0.0.1:3100/api/research/performance?date=$(date +%Y-%m-%d)" | jq

# 按方向统计
curl http://127.0.0.1:3100/api/research/performance | jq '.byDirection'
```

---

## 错误响应

所有接口在出错时返回统一格式：

```json
{
  "error": "错误消息"
}
```

**HTTP状态码：**

| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 202 | 已接受（异步任务） |
| 400 | 请求参数错误 |
| 404 | 资源不存在 |
| 409 | 冲突（任务已在运行） |
| 422 | 业务逻辑错误 |
| 500 | 服务器内部错误 |

---

## 完整示例

### 启动并观察系统

```bash
#!/bin/bash

# 1. 启动自动化
echo "启动自动化系统..."
curl -X POST http://127.0.0.1:3100/api/automation/start
sleep 2

# 2. 查看状态
echo -e "\n系统状态:"
curl -s http://127.0.0.1:3100/api/automation/status | jq '{
  klineSync: .tasks.klineSync,
  analysis: .tasks.analysis,
  positionReview: .tasks.positionReview,
  stats: .stats
}'

# 3. 立即执行一次分析
echo -e "\n触发行情分析..."
curl -X POST http://127.0.0.1:3100/api/automation/tasks/analysis/trigger

# 4. 等待分析完成
echo -e "\n等待分析完成（可能需要几分钟）..."
sleep 120

# 5. 查看账户
echo -e "\n账户状态:"
curl -s http://127.0.0.1:3100/api/paper/account | jq '{
  openCount: .openCount,
  usedMargin: .usedMargin,
  realized: .realized,
  unrealized: .unrealized,
  orders: .orders | length
}'

# 6. 查看最新持仓
echo -e "\n最新持仓:"
curl -s http://127.0.0.1:3100/api/paper/account | jq '.orders[] | select(.status=="open") | {
  symbol,
  direction,
  entry,
  markPrice,
  unrealized,
  stopLoss: .plan.stopLoss,
  takeProfit: .plan.takeProfit
}'
```

---

## 相关文档

- [快速启动指南](QUICKSTART.md)
- [完整功能文档](global-automation.md)
- [配置指南](automation-config.md)
- [功能清单](CHECKLIST.md)

---

**版本**: v1.0.0  
**更新日期**: 2026-09-08
