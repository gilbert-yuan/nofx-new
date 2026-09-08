# 全局自动化交易系统

全局自动化系统整合了K线同步、行情分析、模拟下单和持仓复核功能，实现完全自动化的交易流程。

## 核心特性

### ✅ 使用公开接口，无需API Key

- **K线获取**: 使用 OKX 公开行情接口，无需任何认证
- **无限资金**: 模拟账户支持无限资金模式
- **本地规则**: 支持纯本地规则分析，无需AI模型

### 🔄 三大自动化任务

#### 1. K线同步 (klineSync)
- **频率**: 每 60 秒
- **功能**: 自动获取所有USDT永续合约的1分钟K线
- **来源**: OKX 公开接口
- **存储**: 自动保存到PostgreSQL数据库

#### 2. 行情分析 (analysis)  
- **频率**: 每 2 小时
- **功能**: 扫描所有币种，生成开仓建议并自动下单
- **模式**: 
  - `local` - 纯本地规则（20/50均线 + ATR）
  - `ai` - AI分析（需要模型Key）
  - `auto` - 自动选择（有Key用AI，无Key用本地）
- **下单**: 自动提交模拟订单，保证金100 USDT，杠杆1-5倍

#### 3. 持仓复核 (positionReview)
- **频率**: 每 5 分钟
- **功能**: 复核所有持仓，动态调整止盈止损
- **策略**: 只收紧止损，不扩大风险

## API 接口

### 启动/停止自动化

```bash
# 启动全局自动化系统
curl -X POST http://127.0.0.1:3100/api/automation/start

# 停止全局自动化系统
curl -X POST http://127.0.0.1:3100/api/automation/stop
```

### 查看系统状态

```bash
# 获取完整状态
curl http://127.0.0.1:3100/api/automation/status
```

响应示例：
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
    "errors": []
  },
  "account": {
    "balance": null,
    "usedMargin": 2500,
    "openCount": 25,
    "realized": 150.50,
    "unrealized": 45.20
  }
}
```

### 配置任务

```bash
# 禁用K线同步
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/klineSync \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# 修改分析任务间隔（毫秒）
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/analysis \
  -H "Content-Type: application/json" \
  -d '{"interval": 3600000}'

# 修改复核频率为每10分钟
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/positionReview \
  -H "Content-Type: application/json" \
  -d '{"interval": 600000}'
```

### 手动触发任务

```bash
# 立即执行K线同步
curl -X POST http://127.0.0.1:3100/api/automation/tasks/klineSync/trigger

# 立即执行行情分析
curl -X POST http://127.0.0.1:3100/api/automation/tasks/analysis/trigger

# 立即执行持仓复核
curl -X POST http://127.0.0.1:3100/api/automation/tasks/positionReview/trigger
```

## 本地规则说明

### 开仓逻辑

```javascript
// 计算20根和50根移动平均线
fast = mean(last 20 closes)
slow = mean(last 50 closes)

// 计算14根平均真实波幅
atr = average(last 14 true ranges)

// 判断趋势
if (fast > slow && close > fast) {
  // 多头趋势
  action = 'BUY'
  entry = [close - 0.35*atr, close + 0.35*atr]
  stopLoss = entryMin - 1.5*atr
  takeProfit = entryMax + 3*atr
}

if (fast < slow && close < fast) {
  // 空头趋势
  action = 'SELL'
  entry = [close - 0.35*atr, close + 0.35*atr]
  stopLoss = entryMax + 1.5*atr
  takeProfit = entryMin - 3*atr
}
```

### 止盈止损调整

```javascript
// 每5分钟复核持仓
atr = average(last 14 true ranges)
price = current_close

if (long_position) {
  // 只收紧止损（向上移动）
  new_stopLoss = max(old_stopLoss, price - 1.5*atr)
  // 顺势调整止盈
  new_takeProfit = max(old_takeProfit, price + 3*atr)
}

if (short_position) {
  // 只收紧止损（向下移动）
  new_stopLoss = min(old_stopLoss, price + 1.5*atr)
  // 顺势调整止盈
  new_takeProfit = min(old_takeProfit, price - 3*atr)
}
```

### 杠杆计算

```javascript
// 目标：止损时亏损不超过保证金的10%
entry = (direction === 'LONG') ? plan.entryMax : plan.entryMin
distance = abs(entry - stopLoss) / entry
leverage = min(5, max(1, floor(0.1 / distance)))

// 示例：
// 止损距离 2% -> 杠杆 5x
// 止损距离 5% -> 杠杆 2x
// 止损距离 10% -> 杠杆 1x
```

## 使用场景

### 场景1: 完全无Key自动化

```bash
# 1. 启动系统（使用本地规则）
curl -X POST http://127.0.0.1:3100/api/automation/start

# 2. 观察运行状态
curl http://127.0.0.1:3100/api/automation/status

# 系统将自动：
# - 每60秒获取K线
# - 每2小时扫描所有币种并自动下单
# - 每5分钟复核持仓并调整止盈止损
```

### 场景2: 使用AI分析

```bash
# 1. 在Web界面配置模型Key
# 2. 启动系统（自动使用AI）
curl -X POST http://127.0.0.1:3100/api/automation/start

# 3. 系统将使用AI分析代替本地规则
```

### 场景3: 自定义频率

```bash
# 每小时分析一次
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/analysis \
  -H "Content-Type: application/json" \
  -d '{"interval": 3600000}'

# 每分钟复核持仓
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/positionReview \
  -H "Content-Type: application/json" \
  -d '{"interval": 60000}'
```

## 风险控制

### 模拟账户特性

- **无限资金**: 默认启用，不受初始资金限制
- **最多持仓**: 20个同时持仓
- **单笔保证金**: 100 USDT
- **杠杆范围**: 1-5倍（自动计算）
- **费用**: 
  - 手续费: 0.06% 每边
  - 滑点: 0.05%
  - 资金费: 0.03% 每8小时

### 保护机制

1. **等待入场**: 最多6根K线（6分钟）
2. **最长持仓**: 120根K线（120分钟）
3. **只收紧止损**: 复核时不会扩大风险
4. **强平保护**: 维持保证金率0.5%
5. **价格验证**: 止盈止损必须有效且未被穿越

## 查看结果

### 模拟账户

```bash
# 查看账户总览
curl http://127.0.0.1:3100/api/paper/account
```

### 持仓列表

```bash
# 通过账户接口查看 orders 字段
curl http://127.0.0.1:3100/api/paper/account | jq '.orders'
```

### 分析记录

```bash
# 查看历史分析
curl http://127.0.0.1:3100/api/research/list?limit=100
```

### 策略表现

```bash
# 查看策略回测表现
curl http://127.0.0.1:3100/api/research/performance
```

## 监控与日志

### PM2 日志

```bash
# 查看实时日志
npm run pm2:logs

# 日志中会显示：
# [GlobalAutomation] 开始同步 XXX 个币种的K线...
# [GlobalAutomation] K线同步完成: 成功 XXX, 失败 XXX
# [GlobalAutomation] 开始行情分析，使用 local 模式...
# [GlobalAutomation] BTCUSDT 已提交 BUY 订单，杠杆 3x
# [GlobalAutomation] 开始复核 25 个持仓...
# [GlobalAutomation] ETHUSDT 止盈止损已更新
```

### 系统状态

```bash
# 查看完整状态（包括错误日志）
curl http://127.0.0.1:3100/api/automation/status | jq
```

## 故障排查

### K线同步失败

```bash
# 检查网络连接
curl https://www.okx.com/api/v5/public/instruments?instType=SWAP

# 检查数据库连接
curl http://127.0.0.1:3100/api/history/summary
```

### 分析任务失败

```bash
# 查看错误日志
curl http://127.0.0.1:3100/api/automation/status | jq '.stats.errors'

# 检查模型配置
curl http://127.0.0.1:3100/api/config | jq '.model'
```

### 持仓复核失败

```bash
# 手动刷新持仓
curl -X POST http://127.0.0.1:3100/api/paper/refresh

# 检查持仓状态
curl http://127.0.0.1:3100/api/paper/account | jq '.orders[] | select(.status=="open")'
```

## 性能优化

### 建议配置

```bash
# 大量币种场景（200+）
K线同步: 120秒
分析间隔: 4小时
复核间隔: 10分钟

# 中等币种场景（50-200）
K线同步: 60秒
分析间隔: 2小时
复核间隔: 5分钟

# 少量币种场景（<50）
K线同步: 30秒
分析间隔: 1小时
复核间隔: 1分钟
```

### 数据库维护

```bash
# 定期清理旧K线（保留最近30天）
# SQL:
DELETE FROM klines 
WHERE open_time < (EXTRACT(EPOCH FROM NOW() - INTERVAL '30 days') * 1000);

VACUUM ANALYZE klines;
```

## 注意事项

1. ⚠️ 这是**模拟交易系统**，不会使用真实资金
2. ⚠️ 本地规则仅供参考，不保证盈利
3. ⚠️ K线数据来自OKX，可能与币安实际价格有差异
4. ⚠️ 建议先观察运行一段时间，评估策略效果
5. ⚠️ 生产环境需要充分测试和风险评估

## 扩展开发

### 添加新的分析引擎

编辑 `server/localAnalysis.js`:

```javascript
export function customAnalysis(market) {
  // 自定义分析逻辑
  const klines = market.klines;
  // ... 您的逻辑
  
  return {
    symbol: market.symbol,
    action: 'BUY' | 'SELL' | 'WAIT',
    confidence: 0.75,
    reason: '分析理由',
    plan: {
      entryMin: price - delta,
      entryMax: price + delta,
      stopLoss: stopLossPrice,
      takeProfit: takeProfitPrice,
      validForBars: 6,
      maxHoldBars: 120
    }
  };
}
```

### 集成实盘交易

全局自动化系统已经包含完整的分析和信号生成逻辑，如需实盘交易：

1. 复制 `server/globalAutomation.js`
2. 将 `simulation.submit` 替换为实际的交易所下单接口
3. 添加额外的风险控制和资金管理
4. 充分回测和小资金测试

## 技术架构

```
globalAutomation.js
├── 任务调度
│   ├── klineSync (60s)
│   ├── analysis (2h)
│   └── positionReview (5m)
├── K线管理
│   ├── OKX公开接口
│   └── PostgreSQL存储
├── 分析引擎
│   ├── 本地规则
│   └── AI分析
└── 订单管理
    ├── 模拟下单
    └── 止盈止损
```

## 相关文件

- `server/globalAutomation.js` - 全局自动化核心
- `server/localAnalysis.js` - 本地规则引擎
- `server/simulatedAccount.js` - 模拟账户
- `server/paperAutomation.js` - 原模拟自动化（已集成）
- `server/marketData.js` - 行情数据接口
- `tests/globalAutomation.test.js` - 单元测试

## 更新日志

### v1.0.0 (2026-09-08)
- ✅ 初始发布
- ✅ 三大自动化任务
- ✅ 无Key运行模式
- ✅ 本地规则引擎
- ✅ RESTful API
