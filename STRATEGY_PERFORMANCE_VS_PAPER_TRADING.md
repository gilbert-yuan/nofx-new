# 策略表现 vs 模拟交易 - 差异对比

## 概述

系统中有两个独立的交易模拟系统：
1. **策略表现（Performance View）** - 用于回测和评估策略规则
2. **模拟交易（Paper Trading）** - 用于模拟实盘账户操作

## 核心差异对比

| 维度 | 策略表现 | 模拟交易 |
|------|---------|---------|
| **目的** | 评估策略规则有效性 | 模拟真实交易账户 |
| **数据来源** | `server/paperTrading.js` | `server/simulatedAccount.js` |
| **处理方式** | 批量回测历史信号 | 实时推进订单状态 |
| **资金模型** | 每个信号独立1000 USDT | 共享账户资金池 |
| **持仓限制** | 无限制，所有信号独立 | 最多20个同时持仓 |
| **账户模拟** | 不模拟账户余额 | 完整账户余额管理 |
| **杠杆** | 不使用杠杆 | 1-5倍杠杆 |
| **复利** | 不复利 | 不复利 |
| **爆仓** | 不考虑爆仓 | 有爆仓机制 |

---

## 详细对比

### 1. 资金管理

#### 策略表现
```javascript
// 每条信号独立使用固定名义本金
const notional = 1000; // USDT，固定
const leverage = 1;    // 不使用杠杆
```

**特点**：
- ✅ 每个信号独立评估，互不影响
- ✅ 适合大规模回测（可以同时评估数百个信号）
- ❌ 不考虑资金约束
- ❌ 不反映实际账户情况

#### 模拟交易
```javascript
// 共享账户资金池
initialBalance: 10000,              // 初始资金
margin: 100,                        // 每单保证金
leverage: 1-5,                      // 杠杆倍数
notional: margin * leverage,        // 名义本金
available: balance - usedMargin     // 可用余额
```

**特点**：
- ✅ 真实账户资金约束
- ✅ 考虑保证金占用
- ✅ 模拟爆仓风险
- ❌ 持仓数量有限（最多20个）
- ❌ 需要充足资金才能下单

---

### 2. 入场逻辑

#### 策略表现（paperTrading.js:21-27）
```javascript
// 下一根K线开盘价在区间内即入场
if (!entry && row.open >= p.entryMin && row.open <= p.entryMax) {
  const slipped = Number(row.open) * (1 + direction * costs.slippageBps / 10000);
  // 滑点后的价格必须仍在止损和止盈之间
  if (long ? slipped > p.stopLoss && slipped < p.takeProfit 
           : slipped < p.stopLoss && slipped > p.takeProfit) {
    entry = slipped;
    entryTime = time;
  }
}
```

#### 模拟交易（simulatedAccount.js:76-83）
```javascript
// 相同的入场逻辑
if (order.status === 'pending' && row.open >= p.entryMin && row.open <= p.entryMax) {
  const entry = row.open * (1 + sign * order.costs.slippageBps / 10000);
  if (long ? entry > p.stopLoss && entry < p.takeProfit 
           : entry < p.stopLoss && entry > p.takeProfit) {
    Object.assign(order, { 
      status: 'open', 
      entry, 
      entryAt: new Date(time).toISOString(), 
      quantity: order.notional / entry,
      entryFee: order.notional * order.costs.feeBps / 10000 
    });
    // 计算爆仓价格
    order.liquidationPrice = entry * (1 - sign * (1 / order.leverage - 0.005));
  }
}
```

**相同点**：
- ✅ 都是下一根K线开盘价入场
- ✅ 都考虑滑点（5个基点）
- ✅ 都验证滑点后价格仍在止损止盈之间

**不同点**：
- 模拟交易增加了爆仓价格计算
- 模拟交易有入场手续费扣除

---

### 3. 出场逻辑

#### 策略表现（paperTrading.js:32-37）
```javascript
// 止损优先原则：同根K线同时触及止损和止盈，按止损出场
const stop = long ? row.low <= p.stopLoss : row.high >= p.stopLoss;
const target = long ? row.high >= p.takeProfit : row.low <= p.takeProfit;
let exit = null, reason;
if (stop) { 
  exit = long ? Math.min(row.open, p.stopLoss) : Math.max(row.open, p.stopLoss); 
  reason = 'stop_loss'; 
}
else if (target) { 
  exit = p.takeProfit; 
  reason = 'take_profit'; 
}
else if (held >= p.maxHoldBars) { 
  exit = row.close; 
  reason = 'timeout'; 
}
```

#### 模拟交易（simulatedAccount.js:91-99）
```javascript
// 增加了爆仓检查
const stop = long ? row.low <= p.stopLoss : row.high >= p.stopLoss;
const target = long ? row.high >= p.takeProfit : row.low <= p.takeProfit;
const liquidated = long ? row.low <= order.liquidationPrice : row.high >= order.liquidationPrice;
const opensBeyondLiquidation = long ? row.open <= order.liquidationPrice : row.open >= order.liquidationPrice;
const stopBeforeLiquidation = long ? p.stopLoss > order.liquidationPrice : p.stopLoss < order.liquidationPrice;

// 爆仓优先级最高
if (liquidated && (opensBeyondLiquidation || !stopBeforeLiquidation)) 
  settlePaperOrder(order, opensBeyondLiquidation ? row.open : order.liquidationPrice, 'liquidation', end, !!target);
// 然后是止损
else if (stop) 
  settlePaperOrder(order, long ? Math.min(row.open, p.stopLoss) : Math.max(row.open, p.stopLoss), 'stop_loss', end, !!target);
// 然后是止盈
else if (target) 
  settlePaperOrder(order, p.takeProfit, 'take_profit', end);
// 最后是超时
else if (order.heldBars >= p.maxHoldBars) 
  settlePaperOrder(order, row.close, 'timeout', end);
```

**相同点**：
- ✅ 止损优先原则（同根K线双触发按止损）
- ✅ 止损价格取开盘价和止损价的较优值
- ✅ 止盈按精确价格成交
- ✅ 超时按收盘价平仓

**不同点**：
- 模拟交易增加了**爆仓检查**（优先级最高）
- 模拟交易的爆仓逻辑会检查开盘价是否已跳空触及爆仓价

---

### 4. 成本计算

#### 策略表现（paperTrading.js:40-48）
```javascript
exit *= 1 - direction * costs.slippageBps / 10000;  // 出场滑点
const quantity = costs.notional / entry;
const gross = direction * (exit - entry) * quantity;
const fee = (entry + exit) * quantity * costs.feeBps / 10000;  // 双边手续费
const fundingReserve = costs.notional * costs.fundingBpsPer8h / 10000 * 
                       (exitTime - entryTime) / (8 * 3600000);  // 资金费
const net = gross - fee - fundingReserve;
```

**成本项目**：
1. 入场滑点：5 基点
2. 出场滑点：5 基点  
3. 手续费：6 基点（双边各6基点，共12基点）
4. 资金费：每8小时3基点

#### 模拟交易（simulatedAccount.js:50-61）
```javascript
const exit = price * (1 - direction * order.costs.slippageBps / 10000);
const gross = direction * (exit - order.entry) * order.quantity;
const exitFee = exit * order.quantity * order.costs.feeBps / 10000;
const funding = order.notional * order.costs.fundingBpsPer8h / 10000 * 
                Math.max(0, time - Date.parse(order.entryAt)) / 28800000;
const rawNet = gross - order.entryFee - exitFee - funding;
// 🔥 重要：隔离保证金亏损上限
const net = Math.max(-order.margin - order.entryFee, rawNet);
```

**相同点**：
- ✅ 成本结构完全相同（滑点、手续费、资金费）
- ✅ 默认成本参数一致

**不同点**：
- 模拟交易有**隔离保证金保护**：
  - 最大亏损 = 保证金 + 入场手续费
  - 防止单笔交易亏损超过投入资金
  - `isolatedLossAdjustment` 记录被截断的亏损

---

### 5. 数据要求

#### 策略表现
```javascript
// 需要信号生成后的完整K线历史
if (!row || !validCandle(row) || 
    (row.refreshedAt && Date.parse(row.refreshedAt) < time)) 
  return { status: 'data_gap', missingAt: new Date(time).toISOString() };
```

**特点**：
- 一次性回测所有历史信号
- 缺少任何一根K线就标记为 `data_gap`
- 适合批量评估策略历史表现

#### 模拟交易
```javascript
// 实时推进，缺失K线会暂停并报错
if (!row || !validCandle(row) || row.confirmed === false) { 
  order.error = `缺少 ${new Date(time).toISOString()} 的已收盘 K 线，等待补齐后继续。`; 
  break; 
}
```

**特点**：
- 逐根K线推进订单状态
- 遇到缺失数据会暂停，等待数据补齐
- 模拟实盘的实时推进过程

---

### 6. 持仓复核（动态保护）

#### 策略表现
```javascript
// ❌ 不支持持仓复核
// 止损止盈在信号生成时冻结，不会动态调整
```

#### 模拟交易
```javascript
// ✅ 支持持仓复核
const revision = [...(order.protectionRevisions || [])]
  .reverse()
  .find(r => r.effectiveFrom <= time);
const protection = revision || order.initialPlan || order.plan;
const p = { 
  ...order.plan, 
  stopLoss: protection.stopLoss, 
  takeProfit: protection.takeProfit 
};
```

**特点**：
- 模拟交易支持动态调整止损止盈
- `protectionRevisions` 记录所有复核历史
- 每次复核可以收紧止损（trailing stop）

---

## 使用场景建议

### 使用策略表现的场景
✅ **回测策略规则**
- 评估不同指标组合的效果
- 对比不同参数设置
- 大规模历史数据回测

✅ **策略开发阶段**
- 快速验证想法
- 不考虑资金约束
- 批量评估多个币种

✅ **统计分析**
- 计算胜率、盈亏比
- 分析不同市场环境的表现
- 找出最佳入场时机

### 使用模拟交易的场景
✅ **模拟实盘操作**
- 测试资金管理策略
- 验证仓位控制
- 模拟真实账户体验

✅ **风险测试**
- 测试爆仓风险
- 评估最大回撤
- 验证保证金使用率

✅ **实盘前验证**
- 熟悉交易流程
- 测试订单管理
- 验证自动化策略

---

## 核心代码位置

### 策略表现
- **主文件**: `server/paperTrading.js`
- **关键函数**: 
  - `evaluateSignal()` - 评估单个信号
  - `summarizeResults()` - 汇总统计
- **前端**: `src/components/PerformanceView.vue`
- **路由**: `/research/performance`

### 模拟交易
- **主文件**: `server/simulatedAccount.js`
- **关键函数**:
  - `submitPaperOrder()` - 提交模拟订单
  - `advancePaperOrder()` - 推进订单状态
  - `settlePaperOrder()` - 平仓结算
  - `accountSummary()` - 账户汇总
- **自动化**: `server/paperAutomation.js`
- **前端**: `src/components/PaperAccount.vue`
- **路由**: `/simulation/*`

---

## 关键差异总结

| 特性 | 策略表现 | 模拟交易 |
|------|---------|---------|
| **资金管理** | ❌ 无限资金 | ✅ 真实约束 |
| **持仓限制** | ❌ 无限制 | ✅ 最多20个 |
| **杠杆** | ❌ 不使用 | ✅ 1-5倍 |
| **爆仓** | ❌ 不考虑 | ✅ 完整模拟 |
| **动态止损** | ❌ 不支持 | ✅ 支持复核 |
| **账户余额** | ❌ 不模拟 | ✅ 完整模拟 |
| **批量回测** | ✅ 支持 | ❌ 逐个推进 |
| **历史评估** | ✅ 快速 | ❌ 较慢 |
| **实时推进** | ❌ 批量处理 | ✅ 实时更新 |
| **数据缺失** | 标记跳过 | 暂停等待 |

---

## 推荐工作流

1. **策略开发阶段**
   - 使用策略表现快速回测
   - 评估不同参数组合
   - 统计历史胜率和盈亏比

2. **策略优化阶段**
   - 继续使用策略表现
   - 对比不同版本效果
   - 筛选出最佳配置

3. **实盘前验证**
   - 切换到模拟交易
   - 测试资金管理
   - 验证风险控制

4. **实盘运行**
   - 参考模拟交易经验
   - 继续用策略表现监控规则有效性
   - 两者结合持续优化

---

## 注意事项

⚠️ **策略表现的局限性**
- 不反映资金约束下的实际表现
- 忽略了爆仓风险
- 可能高估实际收益（无资金压力）

⚠️ **模拟交易的局限性**
- 不能批量回测历史
- 需要实时推进，速度较慢
- 持仓数量有限

⚠️ **共同局限性**
- 都基于OHLC数据，无法准确模拟盘口
- 同根K线双触发按止损（保守假设）
- 滑点和手续费是估算值，实盘可能不同
- 不考虑市场深度和流动性影响

---

## 改进建议

### 短期改进
1. ✅ **已修复**: `data_gap` 判断逻辑过严（refreshedAt 检查）
2. 策略表现增加杠杆选项（可选）
3. 模拟交易支持部分平仓

### 长期改进
1. 策略表现支持组合回测（模拟资金池）
2. 增加滑点模型（根据波动率动态调整）
3. 支持分钟级更细粒度的盘中数据
4. 增加市场影响成本模型

---

## 结论

两个系统各有侧重：
- **策略表现** = 快速评估规则有效性
- **模拟交易** = 真实模拟账户操作

建议在策略开发时使用策略表现，在实盘前使用模拟交易验证。两者结合可以更全面地评估交易策略。
