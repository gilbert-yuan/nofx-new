# 策略分析与优化方案

## 📊 当前策略架构分析

### 1. 现有策略关系图

```
订单生命周期:
  分析生成 → 挂单等待 → 入场执行 → 持仓管理 → 平仓结算 → 复盘分析
     ↓           ↓           ↓           ↓           ↓           ↓
  本地策略    validForBars  entryMin/   stopLoss/   maxHoldBars  orderReplay
  (v2)       (3根K线)      Max范围     takeProfit   (30根)      (自动)
```

### 2. 当前策略特征

#### 本地策略 v2 (`localAnalysis.js`)

**单周期版本:**
- **趋势判断**: 20MA > 50MA (做多), 20MA < 50MA (做空)
- **价格确认**: 收盘价与趋势同向
- **偏离过滤**: 价格偏离20MA不超过1.5 ATR
- **做空禁用**: 历史做空0%胜率,已禁用
- **止损**: 2.5 ATR (从1.5放宽)
- **止盈**: 4 ATR (从3扩大)
- **入场窗口**: 3根K线
- **最大持仓**: 30根K线 (从12延长)

**多周期版本 (默认):**
- 主周期: 1m (同上过滤)
- 辅助周期要求:
  - 15m: 同向 + 价格一致 + 强度>0.3 ATR
  - 1h/4h: 均同向 + 价格一致 + 强度>0.5 ATR
- **重要**: 辅助数据不足时保持WAIT,不降级开仓
- 置信度提升: 基础0.65 + 趋势强度 + 共振奖励

### 3. 订单特征记录

每个订单完整保存:
```javascript
{
  analysisContext: {
    signal,           // 完整分析信号
    strategyVersion,  // 策略版本哈希
    analysisEngine,   // 'local' | 'ai'
    scope,           // 分析参数
    confidence,      // 置信分数
    confidenceType,  // 'rule_strength' (非胜率)
    reason,          // 开仓理由
    risk,            // 风险提示
    automationRunId  // 自动化批次ID
  },
  replayAnalysis: {  // 平仓后自动生成
    score,           // 综合评分 0-100
    primaryIssue,    // 主要问题类型
    analysis: {
      direction,     // 方向准确性
      stopLoss,      // 止损合理性
      takeProfit,    // 止盈合理性
      entry          // 入场时机
    }
  }
}
```

## 🎯 识别的核心问题

### 问题1: 策略与订单特征割裂

**现状:**
- 策略规则固定 (2.5/4 ATR, 30根K线)
- 订单复盘分析完整,但**未反馈到策略**
- 持仓时长胜率统计存在,但**人工参考**

**影响:**
- 策略无法从历史订单学习
- 固定参数在不同市场环境表现差异大
- 优化建议停留在展示层面

### 问题2: 多周期过滤可能过严

**现状:**
- 要求15m/1h/4h三个辅助周期**全部**满足条件
- 数据缺失时直接WAIT,不降级
- 共振条件严格 (强度阈值0.3/0.5 ATR)

**风险:**
- 错过部分有效入场机会
- 样本量不足导致统计意义下降
- 过度拟合多周期可能降低策略鲁棒性

### 问题3: 固定止损止盈比例

**现状:**
- 止损固定2.5 ATR, 止盈固定4 ATR
- 盈亏比1:1.6固定
- 未考虑币种波动率差异

**问题:**
- 高波动币种: 止损可能过紧
- 低波动币种: 止盈可能过远
- 未根据实际胜率动态调整

### 问题4: 缺少自适应机制

**已有但未应用:**
- `adaptiveStrategy.js` 完整实现
- `orderReplay.js` 深度分析
- 持仓时长胜率统计

**缺失:**
- 自动应用优化参数
- 策略版本对比验证
- A/B测试框架

## 💡 优化方案

### 方案A: 自适应参数调整 (推荐优先实施)

#### 1. 动态止损止盈

```javascript
// 基于币种历史表现调整
function adaptiveProtection(symbol, baseATR, historicalOrders) {
  const symbolOrders = historicalOrders.filter(o => o.symbol === symbol);
  
  if (symbolOrders.length < 10) {
    // 样本不足,使用默认值
    return { stopLoss: 2.5, takeProfit: 4 };
  }
  
  // 分析该币种的最优止损止盈
  const analysis = analyzeOptimalProtection(symbolOrders);
  
  return {
    stopLoss: analysis.optimalStopLossATR || 2.5,
    takeProfit: analysis.optimalTakeProfitATR || 4,
    confidence: analysis.confidence
  };
}
```

#### 2. 动态持仓时长

```javascript
// 基于胜率分布自动调整
function adaptiveMaxHoldBars(historicalOrders, currentMaxHold = 30) {
  const analysis = analyzeHoldingPeriodPerformance(historicalOrders);
  
  if (!analysis.sufficient) return currentMaxHold;
  
  // 找出高胜率区间上限
  const highWinRateRegions = analysis.highWinRateRegions;
  if (highWinRateRegions.length > 0) {
    const maxHighWinBars = Math.max(...highWinRateRegions.map(r => r.bars + 4));
    return Math.ceil(maxHighWinBars * 1.2); // 留20%余量
  }
  
  return currentMaxHold;
}
```

#### 3. 币种白名单/黑名单

```javascript
// 基于币种胜率过滤
function filterSymbolsByPerformance(symbols, historicalOrders) {
  const symbolStats = {};
  
  for (const order of historicalOrders) {
    if (!symbolStats[order.symbol]) {
      symbolStats[order.symbol] = { count: 0, wins: 0 };
    }
    symbolStats[order.symbol].count++;
    if (order.net > 0) symbolStats[order.symbol].wins++;
  }
  
  return symbols.filter(symbol => {
    const stats = symbolStats[symbol];
    if (!stats || stats.count < 5) return true; // 样本不足,保留
    
    const winRate = stats.wins / stats.count;
    return winRate >= 0.35; // 过滤胜率<35%的币种
  });
}
```

### 方案B: 多周期灵活性优化

#### 1. 分级共振策略

```javascript
// 不同共振等级使用不同参数
const MULTI_TIMEFRAME_LEVELS = {
  FULL_RESONANCE: {
    // 15m + 1h + 4h 全部满足
    stopLossATR: 2.0,   // 更紧止损
    takeProfitATR: 5.0,  // 更远止盈
    maxHoldBars: 40,     // 更长持仓
    confidence: 0.85
  },
  PARTIAL_RESONANCE: {
    // 仅1h + 4h 满足
    stopLossATR: 2.5,
    takeProfitATR: 4.0,
    maxHoldBars: 30,
    confidence: 0.75
  },
  SINGLE_TIMEFRAME: {
    // 仅主周期满足(降级模式)
    stopLossATR: 3.0,   // 更宽止损
    takeProfitATR: 3.5,  // 更近止盈
    maxHoldBars: 20,     // 更短持仓
    confidence: 0.65
  }
};
```

#### 2. 允许有条件降级

```javascript
// 辅助数据不足时,根据主周期强度决定是否降级
function shouldDegradeToSingleTimeframe(mainTrend, auxAnalysis) {
  // 统计可用的辅助周期
  const available = ['15m', '1h', '4h'].filter(
    int => auxAnalysis[int] && auxAnalysis[int].trend !== 'unknown'
  );
  
  if (available.length >= 2) {
    return false; // 至少2个辅助周期可用,不降级
  }
  
  // 主周期趋势非常强,且历史单周期表现良好
  const mainStrength = Math.abs(mainTrend.fast - mainTrend.slow) / mainTrend.atr;
  const historicalSingleWinRate = getHistoricalSingleTimeframeWinRate();
  
  return mainStrength > 1.0 && historicalSingleWinRate > 0.55;
}
```

### 方案C: 复盘驱动的策略迭代

#### 1. 自动触发参数调整

```javascript
// 每N笔订单自动触发优化
class AdaptiveStrategyManager {
  constructor(simulation) {
    this.simulation = simulation;
    this.lastOptimizationAt = 0;
    this.optimizationInterval = 50; // 每50笔订单
  }
  
  async checkAndOptimize() {
    const state = await this.simulation.read();
    const closedCount = state.orders.filter(o => o.status === 'closed').length;
    
    if (closedCount - this.lastOptimizationAt >= this.optimizationInterval) {
      const optimization = optimizeStrategyFromOrders(state.orders);
      
      if (optimization.optimizedParams.shouldApply) {
        // 自动应用优化
        await this.applyOptimization(optimization);
        this.lastOptimizationAt = closedCount;
        
        console.log(`[自适应策略] 已更新参数: maxHoldBars ${optimization.optimizedParams.suggestedMaxHoldBars}`);
      }
    }
  }
}
```

#### 2. 策略版本对比

```javascript
// 跟踪不同策略版本的表现
function compareStrategyVersions(orders) {
  const versions = {};
  
  for (const order of orders.filter(o => o.status === 'closed')) {
    const ver = order.analysisContext?.strategyVersion || 'unknown';
    if (!versions[ver]) {
      versions[ver] = {
        version: ver,
        count: 0,
        wins: 0,
        totalNet: 0,
        avgRoi: 0,
        orders: []
      };
    }
    
    const v = versions[ver];
    v.count++;
    if (order.net > 0) v.wins++;
    v.totalNet += order.net;
    v.avgRoi += order.roi || 0;
    v.orders.push(order);
  }
  
  return Object.values(versions).map(v => ({
    ...v,
    winRate: v.wins / v.count,
    avgNet: v.totalNet / v.count,
    avgRoi: v.avgRoi / v.count,
    profitFactor: calculateProfitFactor(v.orders)
  })).sort((a, b) => b.winRate - a.winRate);
}
```

### 方案D: 时段与市场环境自适应

#### 1. 时段胜率过滤

```javascript
// 识别高胜率时段
function identifyHighProbabilityHours(historicalOrders) {
  const hourStats = Array(24).fill(0).map((_, i) => ({
    hour: i,
    count: 0,
    wins: 0,
    totalNet: 0
  }));
  
  for (const order of historicalOrders) {
    const hour = new Date(order.createdAt).getUTCHours();
    hourStats[hour].count++;
    if (order.net > 0) hourStats[hour].wins++;
    hourStats[hour].totalNet += order.net;
  }
  
  // 只在高胜率时段开仓
  return hourStats
    .filter(h => h.count >= 5) // 至少5笔订单
    .filter(h => h.wins / h.count >= 0.55) // 胜率>=55%
    .map(h => h.hour);
}
```

#### 2. 波动率自适应

```javascript
// 根据市场波动调整参数
function adjustForVolatility(currentVolatility, historicalAvg) {
  const volatilityRatio = currentVolatility / historicalAvg;
  
  if (volatilityRatio > 1.5) {
    // 高波动: 放宽止损,缩短持仓
    return {
      stopLossMultiplier: 1.3,
      takeProfitMultiplier: 1.2,
      maxHoldBarsMultiplier: 0.7
    };
  } else if (volatilityRatio < 0.7) {
    // 低波动: 收紧止损,延长持仓
    return {
      stopLossMultiplier: 0.8,
      takeProfitMultiplier: 0.9,
      maxHoldBarsMultiplier: 1.3
    };
  }
  
  return { stopLossMultiplier: 1, takeProfitMultiplier: 1, maxHoldBarsMultiplier: 1 };
}
```

## 📋 实施计划

### 阶段1: 基础自适应 (1-2周)

**优先级: 高**

1. ✅ **持仓时长自动调整**
   - 已有 `adaptiveStrategy.js` 完整实现
   - 需要: 集成到 `paperAutomation.js` 自动应用
   - 测试: 每50笔订单触发一次优化

2. ✅ **币种过滤**
   - 基于胜率<35%的币种暂停开仓
   - 样本要求: 至少5笔历史订单

3. ⚠️ **时段过滤**
   - 识别高胜率时段 (胜率>=55%, 样本>=5)
   - 低胜率时段降低开仓频率或跳过

### 阶段2: 动态参数 (2-3周)

**优先级: 中**

4. **币种级别止损止盈**
   - 为每个币种计算最优ATR倍数
   - 样本要求: 至少10笔历史订单
   - 默认值: 2.5/4.0 ATR

5. **多周期降级策略**
   - 实现分级共振模式
   - 允许强趋势下的单周期降级
   - 记录不同模式的胜率

6. **波动率自适应**
   - 实时监控市场波动率
   - 动态调整止损止盈倍数
   - 调整持仓时长上限

### 阶段3: 策略进化 (持续)

**优先级: 低**

7. **策略版本追踪**
   - 完整记录每个版本的表现
   - 自动回滚低性能版本
   - A/B测试不同参数组合

8. **机器学习增强**
   - 使用XGBoost预测订单成功率
   - 特征: 趋势强度、波动率、时段、币种历史等
   - 阈值: 预测成功率>60%才开仓

## 🔧 具体修改建议

### 修改1: `paperAutomation.js` - 集成自适应优化

```javascript
async scan(job, config, strategy, engine) {
  const symbols = job.symbols || (await this.market.perpetualUsdtContracts()).map(s => s.symbol);
  
  // 新增: 获取历史订单进行过滤
  const state = await this.simulation.read();
  const historicalOrders = state.orders.filter(o => o.status === 'closed');
  
  // 新增: 币种过滤
  const filteredSymbols = filterSymbolsByPerformance(symbols, historicalOrders);
  
  // 新增: 时段检查
  const currentHour = new Date().getUTCHours();
  const highProbHours = identifyHighProbabilityHours(historicalOrders);
  const shouldScanNow = highProbHours.length === 0 || highProbHours.includes(currentHour);
  
  if (!shouldScanNow) {
    console.log(`[自适应] 当前时段(${currentHour}:00 UTC)非高胜率时段,跳过本轮扫描`);
    return;
  }
  
  // 新增: 动态调整持仓参数
  const optimizedParams = generateOptimizedParameters(
    analyzeHoldingPeriodPerformance(historicalOrders),
    LOCAL_STRATEGY.maxHoldBars
  );
  
  if (optimizedParams.shouldApply) {
    console.log(`[自适应] 应用优化参数: maxHoldBars ${optimizedParams.suggestedMaxHoldBars}`);
    // 修改策略规则
    strategy.rules += `\n\n## 自适应优化\n基于${historicalOrders.length}笔历史订单,maxHoldBars调整为${optimizedParams.suggestedMaxHoldBars}根K线`;
  }
  
  await this.editJob('scan', j => { 
    j.symbols = filteredSymbols; 
    j.total = filteredSymbols.length;
    j.filteredOut = symbols.length - filteredSymbols.length;
  });
  
  // ... 原有扫描逻辑
}
```

### 修改2: `localAnalysis.js` - 动态止损止盈

```javascript
export function localAnalysisMultiTimeframe(market, auxMarkets = {}, adaptiveParams = {}) {
  // ... 原有分析逻辑
  
  // 新增: 使用自适应参数
  const stopLossATR = adaptiveParams.stopLossATR || 2.5;
  const takeProfitATR = adaptiveParams.takeProfitATR || 4.0;
  const maxHoldBars = adaptiveParams.maxHoldBars || LOCAL_STRATEGY.maxHoldBars;
  
  return {
    // ...
    plan: {
      entryMin,
      entryMax,
      stopLoss: long ? entryMin - atr * stopLossATR : entryMax + atr * stopLossATR,
      takeProfit: long ? entryMax + atr * takeProfitATR : entryMin - atr * takeProfitATR,
      validForBars: LOCAL_STRATEGY.validForBars,
      maxHoldBars
    },
    adaptiveParamsUsed: { stopLossATR, takeProfitATR, maxHoldBars }
  };
}
```

### 修改3: 新增 `server/adaptiveFilters.js`

创建独立的自适应过滤模块,包含:
- `filterSymbolsByPerformance()`
- `identifyHighProbabilityHours()`
- `adjustForVolatility()`
- `shouldDegradeToSingleTimeframe()`

## 📊 评估指标

### 优化前基线 (需记录)
- 整体胜率
- 平均盈亏比
- 盈利因子
- 最大回撤
- 平均持仓时长

### 优化后目标
- **胜率提升**: +5-10%
- **盈利因子**: >1.5
- **夏普比率**: >1.0
- **最大回撤**: <15%

### 监控维度
- 按币种胜率
- 按时段胜率
- 按策略版本胜率
- 按市场波动率分段胜率

## ⚠️ 风险控制

### 1. 过度优化风险
- **问题**: 过度拟合历史数据
- **对策**: 保留30%订单作为验证集,不参与优化

### 2. 样本量不足
- **问题**: 统计意义不足导致误判
- **对策**: 最小样本要求 (币种5笔, 时段5笔, 全局50笔)

### 3. 市场环境变化
- **问题**: 历史优化参数不适应新市场
- **对策**: 滚动窗口 (仅使用最近N笔订单), 定期重置

### 4. 策略退化
- **问题**: 自动优化导致策略性能下降
- **对策**: 版本追踪 + 自动回滚机制

## 🎯 下一步行动

### 立即可做:
1. 实施币种胜率过滤 (修改 `paperAutomation.js`)
2. 实施时段过滤 (使用现有统计接口)
3. 集成 `adaptiveStrategy.js` 自动应用

### 需要数据积累:
4. 币种级别止损止盈优化 (需每币种10+订单)
5. 多周期降级策略评估 (需A/B测试)

### 长期探索:
6. 机器学习预测模型
7. 强化学习动态调参

---

**总结**: 当前最大的问题是**策略与订单数据割裂**。优先实施方案A(自适应参数)和方案C(复盘驱动迭代),预期可提升5-10%胜率。
