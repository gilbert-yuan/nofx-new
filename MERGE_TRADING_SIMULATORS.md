# 策略表现与模拟交易合并方案

## 可行性分析

### 为什么可以合并

两个系统的核心逻辑**高度相似**：

1. **入场逻辑完全相同**
   - 都是下一根K线开盘价在区间内入场
   - 都考虑滑点（5基点）
   - 都验证滑点后价格在止损止盈之间

2. **出场逻辑基本相同**
   - 都遵循止损优先原则
   - 都按相同方式计算成交价格
   - 都支持超时平仓

3. **成本计算完全相同**
   - 滑点、手续费、资金费计算公式一致

4. **数据处理相似**
   - 都是逐根K线推进
   - 都检查K线有效性

### 当前的差异点

| 差异项 | 策略表现 | 模拟交易 | 是否可统一 |
|-------|---------|---------|-----------|
| 资金模型 | 每信号独立1000U | 共享账户资金池 | ✅ 可配置 |
| 杠杆 | 固定1倍 | 1-5倍可选 | ✅ 可配置 |
| 爆仓检查 | 不检查 | 完整模拟 | ✅ 可选开启 |
| 持仓限制 | 无限制 | 最多20个 | ✅ 可配置 |
| 隔离保证金 | 无 | 有亏损上限 | ✅ 可选开启 |
| 动态止损 | 不支持 | 支持复核 | ✅ 可选开启 |
| 处理模式 | 批量回测 | 实时推进 | ✅ 可选模式 |

**结论：所有差异都可以通过配置参数来统一！**

---

## 合并方案设计

### 方案A：统一引擎 + 模式选择（推荐）

创建一个统一的交易模拟引擎，通过模式参数区分用途：

```javascript
/**
 * 统一的交易模拟引擎
 */
class TradingSimulator {
  constructor(options = {}) {
    this.mode = options.mode || 'backtest';  // 'backtest' | 'account'
    this.config = {
      // 资金管理
      accountMode: options.mode === 'account',
      initialBalance: options.initialBalance || 10000,
      unlimitedCapital: options.mode === 'backtest',
      
      // 持仓限制
      maxPositions: options.maxPositions || (options.mode === 'account' ? 20 : Infinity),
      allowDuplicateSymbol: options.mode === 'backtest',
      
      // 风险控制
      enableLiquidation: options.enableLiquidation ?? (options.mode === 'account'),
      enableIsolatedMargin: options.enableIsolatedMargin ?? (options.mode === 'account'),
      
      // 动态保护
      enableDynamicProtection: options.enableDynamicProtection ?? (options.mode === 'account'),
      
      // 处理模式
      batchMode: options.batchMode ?? (options.mode === 'backtest'),
      
      // 成本参数
      costs: options.costs || PAPER_COSTS
    };
  }

  /**
   * 评估单个订单/信号
   */
  evaluate(order, rows, now = Date.now()) {
    // 统一的核心逻辑
    return this._processOrder(order, rows, now);
  }

  /**
   * 批量回测（策略表现模式）
   */
  async batchBacktest(signals, getKlines) {
    const results = [];
    for (const signal of signals) {
      const order = this._signalToOrder(signal);
      const rows = await getKlines(signal);
      const result = this.evaluate(order, rows);
      results.push(result);
    }
    return this._summarize(results);
  }

  /**
   * 账户模式推进（模拟交易模式）
   */
  async advanceAccount(account, getKlines, now = Date.now()) {
    for (const order of account.orders.filter(o => this._isActive(o))) {
      const rows = await getKlines(order);
      this._advanceOrder(order, rows, now);
    }
    return this._accountSummary(account);
  }

  /**
   * 核心处理逻辑（统一）
   */
  _processOrder(order, rows, now) {
    const byTime = new Map(rows.map(r => [Number(r.openTime), r]));
    const long = order.direction === 'OPEN_LONG';
    const direction = long ? 1 : -1;
    
    let time = order.nextTime;
    let entry = order.entry || null;
    let entryTime = order.entryAt ? Date.parse(order.entryAt) : null;
    let held = order.heldBars || 0;
    
    while (nextOpenTime(time, order.interval) <= now) {
      // 检查过期
      if (!entry && time >= Date.parse(order.expiresAt)) {
        return this._markExpired(order);
      }
      
      // 获取K线
      const row = byTime.get(time);
      if (!this._validateKline(row, time, order.interval)) {
        return this._markDataGap(order, time);
      }
      
      // 获取当前保护价格（支持动态调整）
      const protection = this._getProtection(order, time);
      
      // 尝试入场
      if (!entry) {
        entry = this._tryEntry(order, row, protection, direction);
        if (entry) {
          entryTime = time;
          if (this.config.enableLiquidation) {
            order.liquidationPrice = this._calcLiquidation(entry, order.leverage, direction);
          }
        }
      }
      
      // 持仓管理
      if (entry) {
        held++;
        
        // 更新未实现盈亏
        order.markPrice = row.close;
        order.unrealized = this._calcUnrealized(entry, row.close, order.quantity, direction, entryTime, time, order.costs);
        
        // 检查出场条件
        const exitResult = this._checkExit(order, row, protection, entry, held, direction);
        if (exitResult) {
          return this._settle(order, exitResult, time);
        }
      }
      
      time = nextOpenTime(time, order.interval);
    }
    
    // 未完成
    return this._markPending(order, entry, entryTime, held);
  }

  /**
   * 入场逻辑（统一）
   */
  _tryEntry(order, row, protection, direction) {
    const { entryMin, entryMax } = protection;
    if (row.open < entryMin || row.open > entryMax) return null;
    
    const slipped = row.open * (1 + direction * order.costs.slippageBps / 10000);
    const long = direction === 1;
    
    // 验证滑点后价格仍在止损止盈之间
    if (long ? slipped <= protection.stopLoss || slipped >= protection.takeProfit
             : slipped >= protection.stopLoss || slipped <= protection.takeProfit) {
      return null;
    }
    
    return slipped;
  }

  /**
   * 出场检查（统一，支持爆仓）
   */
  _checkExit(order, row, protection, entry, held, direction) {
    const long = direction === 1;
    const { stopLoss, takeProfit, maxHoldBars } = protection;
    
    // 1. 爆仓检查（账户模式）
    if (this.config.enableLiquidation && order.liquidationPrice) {
      const liquidated = long ? row.low <= order.liquidationPrice : row.high >= order.liquidationPrice;
      const opensBeyond = long ? row.open <= order.liquidationPrice : row.open >= order.liquidationPrice;
      const stopBeforeLiq = long ? stopLoss > order.liquidationPrice : stopLoss < order.liquidationPrice;
      
      if (liquidated && (opensBeyond || !stopBeforeLiq)) {
        return {
          reason: 'liquidation',
          price: opensBeyond ? row.open : order.liquidationPrice,
          ambiguous: long ? row.high >= takeProfit : row.low <= takeProfit
        };
      }
    }
    
    // 2. 止损检查
    const hitStop = long ? row.low <= stopLoss : row.high >= stopLoss;
    if (hitStop) {
      return {
        reason: 'stop_loss',
        price: long ? Math.min(row.open, stopLoss) : Math.max(row.open, stopLoss),
        ambiguous: long ? row.high >= takeProfit : row.low <= takeProfit
      };
    }
    
    // 3. 止盈检查
    const hitTarget = long ? row.high >= takeProfit : row.low <= takeProfit;
    if (hitTarget) {
      return {
        reason: 'take_profit',
        price: takeProfit,
        ambiguous: false
      };
    }
    
    // 4. 超时检查
    if (held >= maxHoldBars) {
      return {
        reason: 'timeout',
        price: row.close,
        ambiguous: false
      };
    }
    
    return null;
  }

  /**
   * 结算（统一，支持隔离保证金）
   */
  _settle(order, exitResult, time) {
    const direction = order.direction === 'OPEN_LONG' ? 1 : -1;
    const exit = exitResult.price * (1 - direction * order.costs.slippageBps / 10000);
    const quantity = order.quantity || order.notional / order.entry;
    
    // 计算盈亏
    const gross = direction * (exit - order.entry) * quantity;
    const entryFee = order.entryFee || order.notional * order.costs.feeBps / 10000;
    const exitFee = exit * quantity * order.costs.feeBps / 10000;
    const funding = this._calcFunding(order, time);
    const rawNet = gross - entryFee - exitFee - funding;
    
    // 隔离保证金保护（账户模式）
    let net = rawNet;
    let isolatedAdjustment = 0;
    if (this.config.enableIsolatedMargin && rawNet < 0) {
      const maxLoss = -order.margin - entryFee;
      if (rawNet < maxLoss) {
        isolatedAdjustment = maxLoss - rawNet;
        net = maxLoss;
      }
    }
    
    return {
      status: 'closed',
      reason: exitResult.reason,
      entry: order.entry,
      exit,
      entryAt: order.entryAt,
      exitAt: new Date(nextOpenTime(time, order.interval)).toISOString(),
      gross,
      fees: entryFee + exitFee,
      funding,
      net,
      roi: net / order.margin,
      isolatedLossAdjustment: isolatedAdjustment,
      ambiguousBar: exitResult.ambiguous,
      heldBars: order.heldBars
    };
  }

  /**
   * 获取保护价格（支持动态调整）
   */
  _getProtection(order, time) {
    if (!this.config.enableDynamicProtection || !order.protectionRevisions?.length) {
      return order.plan;
    }
    
    const revision = [...order.protectionRevisions]
      .reverse()
      .find(r => r.effectiveFrom <= time);
    
    return revision ? {
      ...order.plan,
      stopLoss: revision.stopLoss,
      takeProfit: revision.takeProfit
    } : order.plan;
  }
}
```

---

## 实施步骤

### 第一阶段：创建统一引擎

1. 新建文件 `server/tradingSimulator.js`
2. 实现核心模拟逻辑（合并两个文件的逻辑）
3. 支持两种模式的配置参数

### 第二阶段：重构现有代码

1. **策略表现**：
   ```javascript
   // server/researchRoutes.js
   import { TradingSimulator } from './tradingSimulator.js';
   
   async function evaluatePerformance(signals) {
     const simulator = new TradingSimulator({ mode: 'backtest' });
     return await simulator.batchBacktest(signals, getKlinesForSignal);
   }
   ```

2. **模拟交易**：
   ```javascript
   // server/simulatedAccount.js
   import { TradingSimulator } from './tradingSimulator.js';
   
   async function advanceAccount(account) {
     const simulator = new TradingSimulator({ 
       mode: 'account',
       initialBalance: account.initialBalance,
       unlimitedCapital: account.unlimitedCapital
     });
     return await simulator.advanceAccount(account, getKlinesForOrder);
   }
   ```

### 第三阶段：迁移测试

1. 保留原有文件作为备份
2. 逐步切换到新引擎
3. 对比新旧引擎的结果一致性
4. 确认所有测试通过后删除旧代码

### 第四阶段：增强功能

1. 统一的持仓复核接口
2. 更灵活的成本配置
3. 支持更多出场策略
4. 统一的统计分析

---

## 配置示例

### 策略表现模式
```javascript
const backtestSimulator = new TradingSimulator({
  mode: 'backtest',
  unlimitedCapital: true,
  enableLiquidation: false,
  enableIsolatedMargin: false,
  enableDynamicProtection: false,
  maxPositions: Infinity,
  batchMode: true
});
```

### 模拟交易模式
```javascript
const accountSimulator = new TradingSimulator({
  mode: 'account',
  initialBalance: 10000,
  unlimitedCapital: false,
  enableLiquidation: true,
  enableIsolatedMargin: true,
  enableDynamicProtection: true,
  maxPositions: 20,
  batchMode: false
});
```

### 混合模式（新功能）
```javascript
// 带资金约束的回测
const constrainedBacktest = new TradingSimulator({
  mode: 'backtest',
  unlimitedCapital: false,
  initialBalance: 10000,
  enableLiquidation: true,
  maxPositions: 20
});

// 无限资金的模拟交易（测试用）
const unlimitedAccount = new TradingSimulator({
  mode: 'account',
  unlimitedCapital: true,
  enableDynamicProtection: true
});
```

---

## 优势

### 1. 代码复用
- ✅ 消除重复代码（两个文件约70%逻辑相同）
- ✅ 统一维护一套核心逻辑
- ✅ bug修复只需改一处

### 2. 功能增强
- ✅ 策略表现可以开启爆仓检查
- ✅ 策略表现可以模拟资金约束
- ✅ 模拟交易可以切换为批量模式
- ✅ 灵活组合各种功能

### 3. 测试简化
- ✅ 只需测试一个引擎
- ✅ 确保两种模式逻辑一致
- ✅ 更容易发现和修复问题

### 4. 扩展性
- ✅ 易于添加新功能（如部分平仓）
- ✅ 易于支持新的出场策略
- ✅ 易于自定义成本模型

---

## 风险和注意事项

### 潜在风险
1. **破坏现有功能**
   - 缓解：保留旧代码作为备份
   - 缓解：充分测试对比结果

2. **增加复杂度**
   - 缓解：清晰的配置文档
   - 缓解：提供预设模式

3. **性能影响**
   - 缓解：保持批量模式的高性能
   - 缓解：懒加载不需要的功能

### 兼容性
1. **数据库结构**
   - 无需修改现有表结构
   - 订单格式保持兼容

2. **API接口**
   - 保持现有API不变
   - 内部切换到新引擎

3. **前端代码**
   - 无需修改前端
   - 后端透明升级

---

## 时间估算

| 阶段 | 任务 | 时间 |
|------|------|------|
| 1 | 创建统一引擎 | 4-6小时 |
| 2 | 重构策略表现 | 2-3小时 |
| 3 | 重构模拟交易 | 2-3小时 |
| 4 | 测试验证 | 3-4小时 |
| 5 | 文档更新 | 1-2小时 |
| **总计** | | **12-18小时** |

---

## 建议

### 短期方案（立即实施）
✅ **先合并核心逻辑**
- 创建 `tradingSimulator.js`
- 提取共同的入场、出场、结算逻辑
- 两个现有文件调用统一引擎

### 中期方案（1-2周）
✅ **完全迁移**
- 废弃 `paperTrading.js`
- 重构 `simulatedAccount.js` 使用新引擎
- 充分测试

### 长期方案（1-2月）
✅ **功能增强**
- 添加更多出场策略
- 支持部分平仓
- 优化性能

---

## 结论

**强烈建议合并！**

理由：
1. ✅ 技术上完全可行（逻辑高度相似）
2. ✅ 收益明显（代码复用、功能增强）
3. ✅ 风险可控（渐进式迁移、保留备份）
4. ✅ 未来可扩展性好

下一步：是否开始实施合并？
