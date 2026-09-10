# 自适应策略优化 - 部署和使用指南

## ✅ 已完成的实施

### 1. 核心模块

#### `server/adaptiveFilters.js`
自适应过滤器模块，包含：
- ✅ `filterSymbolsByPerformance()` - 基于胜率过滤币种
- ✅ `identifyHighProbabilityHours()` - 识别高胜率时段
- ✅ `shouldTradeAtCurrentHour()` - 检查当前时段是否适合交易
- ✅ `getAdaptiveParametersForSymbol()` - 获取币种级别的自适应参数
- ✅ `adjustForVolatility()` - 波动率自适应调整
- ✅ `shouldOpenPosition()` - 综合评估是否开仓

#### `server/adaptiveStrategy.js` (已存在，已完善)
持仓时长优化模块，包含：
- ✅ `analyzeHoldingPeriodPerformance()` - 分析持仓时长表现
- ✅ `generateOptimizedParameters()` - 生成优化参数
- ✅ `optimizeStrategyFromOrders()` - 完整优化流程

#### `server/adaptiveConfig.js`
配置管理模块，包含：
- ✅ `DEFAULT_ADAPTIVE_CONFIG` - 默认配置
- ✅ `getAdaptiveConfig()` - 获取配置
- ✅ `validateAdaptiveConfig()` - 验证配置

#### `server/adaptiveRoutes.js`
API 路由模块，提供：
- ✅ `GET /api/adaptive/config` - 获取配置
- ✅ `PUT /api/adaptive/config` - 更新配置
- ✅ `GET /api/adaptive/symbol-filter` - 币种过滤分析
- ✅ `GET /api/adaptive/hour-analysis` - 时段分析
- ✅ `GET /api/adaptive/current-hour-check` - 当前时段检查
- ✅ `GET /api/adaptive/symbol-params/:symbol` - 币种参数
- ✅ `GET /api/adaptive/holding-optimization` - 持仓优化建议
- ✅ `GET /api/adaptive/report` - 完整分析报告
- ✅ `POST /api/adaptive/apply-optimization` - 应用优化
- ✅ `POST /api/adaptive/reset-overrides` - 重置覆盖

### 2. 核心逻辑集成

#### `server/localAnalysis.js` (已修改)
- ✅ 支持动态 `adaptiveParams` 参数
- ✅ 应用自适应止损止盈倍数
- ✅ 应用自适应最大持仓时长
- ✅ 在分析结果中记录使用的自适应参数

#### `server/paperAutomation.js` (已修改)
- ✅ 集成币种过滤 (`filterSymbolsByPerformance`)
- ✅ 集成时段过滤 (`shouldTradeAtCurrentHour`)
- ✅ 集成持仓优化 (`analyzeHoldingPeriodPerformance`, `generateOptimizedParameters`)
- ✅ 集成币种级别参数 (`getAdaptiveParametersForSymbol`)
- ✅ 自动应用优化建议到策略规则
- ✅ 详细日志输出优化过程

#### `server/researchRoutes.js` (已修改)
- ✅ 注册自适应策略路由 (`registerAdaptiveStrategyRoutes`)

### 3. 测试文件

#### `tests/adaptiveFilters.test.js`
- ✅ 完整的单元测试覆盖
- ✅ 测试所有过滤和优化函数
- ✅ 边界条件测试

## 🚀 部署步骤

### 1. 验证文件完整性

确保以下文件已创建/修改：

```bash
# 新建文件
ls -l server/adaptiveFilters.js
ls -l server/adaptiveConfig.js
ls -l server/adaptiveRoutes.js
ls -l tests/adaptiveFilters.test.js

# 修改文件
git status | grep -E "(localAnalysis|paperAutomation|researchRoutes)"
```

### 2. 运行测试

```bash
# 运行自适应过滤器测试
npm test tests/adaptiveFilters.test.js

# 运行完整测试套件
npm test
```

### 3. 重启服务器

```bash
# 停止现有服务
# Ctrl+C 或 kill <pid>

# 启动服务器
npm run dev
# 或
npm start
```

### 4. 验证 API 端点

```bash
# 检查健康状态
curl http://localhost:3100/api/health

# 获取自适应配置
curl http://localhost:3100/api/adaptive/config

# 获取完整分析报告（需要至少20笔历史订单）
curl http://localhost:3100/api/adaptive/report
```

## 📊 使用指南

### 1. 自动模式（推荐）

自适应优化默认**自动启用**，当满足以下条件时会自动生效：

#### 币种过滤
- 至少 20 笔历史已平仓订单
- 自动过滤胜率 < 35% 的币种（需至少 5 笔订单）

#### 时段过滤
- 至少 50 笔历史已平仓订单
- 识别胜率 ≥ 55% 的时段（需至少 5 笔订单）
- 在低胜率时段跳过扫描

#### 持仓时长优化
- 至少 20 笔历史已平仓订单
- 自动调整 `maxHoldBars` 参数
- 置信度 ≥ 0.3 时自动应用

#### 币种级别参数
- 每个币种至少 10 笔历史订单
- 自动调整该币种的止损止盈倍数

### 2. 监控优化效果

#### 查看日志

服务器控制台会输出详细的优化日志：

```
[自适应过滤] 过滤了2个低胜率币种: DOGEUSDT(28.6%), SHIBUSDT(31.2%)
[自适应过滤] 当前时段8:00 UTC为高胜率时段（胜率62.5%）
[自适应优化] 基于68笔历史订单，调整maxHoldBars: 30 → 25
[自适应优化] 整体胜率: 52.9%, 平均持仓: 18.3根
[自适应参数] BTCUSDT: 止损放宽至3.0x ATR（触发率45.5%过高）
```

#### API 监控端点

```bash
# 获取完整分析报告
curl http://localhost:3100/api/adaptive/report | jq

# 示例响应
{
  "summary": {
    "totalOrders": 68,
    "totalWins": 36,
    "overallWinRate": 0.529,
    "totalNet": 123.45,
    "avgNet": 1.815
  },
  "holdingOptimization": {
    "optimized": true,
    "suggestedMaxHoldBars": 25,
    "confidence": 0.45,
    "recommendations": [...]
  },
  "hourAnalysis": {
    "highProbHours": [8, 9, 14, 15, 16],
    "topHours": [...]
  },
  "symbolPerformance": {
    "topSymbols": [...],
    "worstSymbols": [...]
  }
}
```

### 3. 手动控制

#### 禁用特定过滤器

```bash
curl -X PUT http://localhost:3100/api/adaptive/config \
  -H "Content-Type: application/json" \
  -d '{
    "symbolFilter": { "enabled": false },
    "hourFilter": { "enabled": true }
  }'
```

#### 调整阈值

```bash
curl -X PUT http://localhost:3100/api/adaptive/config \
  -H "Content-Type: application/json" \
  -d '{
    "symbolFilter": {
      "enabled": true,
      "minWinRate": 0.40,
      "minSampleSize": 10
    },
    "hourFilter": {
      "enabled": true,
      "minWinRate": 0.60,
      "minSampleSize": 10
    }
  }'
```

#### 手动应用优化参数

```bash
curl -X POST http://localhost:3100/api/adaptive/apply-optimization \
  -H "Content-Type: application/json" \
  -d '{
    "maxHoldBars": 25,
    "stopLossATR": 3.0,
    "takeProfitATR": 4.5
  }'
```

#### 重置为默认参数

```bash
curl -X POST http://localhost:3100/api/adaptive/reset-overrides
```

## 📈 效果评估

### 关键指标对比

在实施自适应优化前后，对比以下指标：

| 指标 | 优化前基线 | 优化后目标 | 实际结果 |
|------|-----------|-----------|---------|
| 整体胜率 | __%  | +5-10% | __% |
| 盈利因子 | __ | >1.5 | __ |
| 平均盈亏比 | __ | >1.2 | __ |
| 最大回撤 | __%  | <15% | __% |
| 平均持仓时长 | __根 | 优化后 | __根 |

### 分段评估

**重要**: 只比较 v2 标记的订单

```sql
-- 在数据库中筛选 v2 订单
SELECT 
  COUNT(*) as total,
  SUM(CASE WHEN net > 0 THEN 1 ELSE 0 END) as wins,
  AVG(net) as avg_net,
  AVG(heldBars) as avg_hold
FROM orders
WHERE status = 'closed'
  AND analysisContext->>'$.analysisEngine' = 'local'
  AND createdAt >= '2024-XX-XX'  -- 部署日期
```

### 按维度分析

```bash
# 查看统计数据
curl http://localhost:3100/api/paper/statistics | jq

# 按币种
curl http://localhost:3100/api/adaptive/symbol-filter?symbols=BTCUSDT,ETHUSDT,SOLUSDT | jq

# 按时段
curl http://localhost:3100/api/adaptive/hour-analysis | jq
```

## ⚠️ 注意事项

### 1. 样本量要求

- **币种过滤**: 至少 5 笔订单/币种，启用需全局 ≥20 笔
- **时段过滤**: 至少 5 笔订单/时段，启用需全局 ≥50 笔
- **持仓优化**: 至少 20 笔订单
- **币种参数**: 至少 10 笔订单/币种

样本不足时，自适应功能自动禁用，使用默认参数。

### 2. 过度优化风险

自适应优化可能导致**过度拟合历史数据**。建议：

- 定期检查优化后的表现（每 50-100 笔订单）
- 如果新订单表现下降，考虑重置参数
- 保留 30% 订单作为验证集（暂未实现，待后续版本）

### 3. 市场环境变化

历史优化参数可能不适应新的市场环境：

- 波动率突变时，旧参数可能失效
- 建议使用滚动窗口（仅最近 N 笔订单）
- 当前版本使用全部历史订单，后续可配置窗口大小

### 4. 策略版本控制

- 每次优化都会记录在订单的 `analysisContext` 中
- 通过 `strategyVersion` 哈希区分不同版本
- 可通过 `/api/paper/statistics` 按版本对比表现

## 🔧 故障排查

### 问题1: 优化未生效

**症状**: 日志中没有自适应优化信息

**检查**:
```bash
# 检查历史订单数量
curl http://localhost:3100/api/paper/account | jq '.orders | length'

# 检查配置
curl http://localhost:3100/api/adaptive/config | jq
```

**解决**:
- 确保至少有 20 笔已平仓订单
- 检查配置中 `enabled` 是否为 `true`

### 问题2: 币种被过度过滤

**症状**: 几乎所有币种都被过滤

**检查**:
```bash
curl http://localhost:3100/api/adaptive/symbol-filter?symbols=ALL | jq '.filteredOut'
```

**解决**:
```bash
# 降低胜率阈值
curl -X PUT http://localhost:3100/api/adaptive/config \
  -H "Content-Type: application/json" \
  -d '{"symbolFilter": {"minWinRate": 0.30}}'
```

### 问题3: 时段过滤太严格

**症状**: 很少有时段允许交易

**检查**:
```bash
curl http://localhost:3100/api/adaptive/hour-analysis | jq '.highProbHours'
```

**解决**:
```bash
# 降低时段胜率阈值
curl -X PUT http://localhost:3100/api/adaptive/config \
  -H "Content-Type: application/json" \
  -d '{"hourFilter": {"minWinRate": 0.50}}'
```

### 问题4: API 返回 404

**症状**: `/api/adaptive/*` 端点不存在

**检查**:
```bash
# 检查路由是否注册
grep -n "registerAdaptiveStrategyRoutes" server/researchRoutes.js
```

**解决**:
- 确保 `server/researchRoutes.js` 已正确修改
- 重启服务器

## 📝 配置参考

### 默认配置

```javascript
{
  symbolFilter: {
    enabled: true,
    minSampleSize: 5,
    minWinRate: 0.35,
    minOrdersToActivate: 20
  },
  hourFilter: {
    enabled: true,
    minSampleSize: 5,
    minWinRate: 0.55,
    minOrdersToActivate: 50
  },
  holdingPeriodOptimization: {
    enabled: true,
    minSampleSize: 20,
    autoApplyThreshold: 0.3,
    triggerInterval: 50
  },
  symbolLevelParams: {
    enabled: true,
    minSampleSize: 10
  },
  volatilityAdaptive: {
    enabled: false,  // 暂未启用
    lookbackPeriod: 100
  }
}
```

### 推荐配置（保守）

更严格的过滤条件，适合初期使用：

```javascript
{
  symbolFilter: {
    minWinRate: 0.40,      // 提高至 40%
    minSampleSize: 10      // 提高至 10 笔
  },
  hourFilter: {
    minWinRate: 0.60,      // 提高至 60%
    minSampleSize: 10
  }
}
```

### 推荐配置（激进）

更宽松的过滤条件，获取更多交易机会：

```javascript
{
  symbolFilter: {
    minWinRate: 0.30,      // 降低至 30%
    minSampleSize: 3       // 降低至 3 笔
  },
  hourFilter: {
    minWinRate: 0.50,      // 降低至 50%
    minSampleSize: 3
  }
}
```

## 🎯 下一步计划

### 阶段2: 进一步优化（待实施）

1. **多周期灵活降级**
   - 实现分级共振策略
   - 允许强趋势下的单周期降级

2. **波动率自适应**
   - 启用 `volatilityAdaptive` 功能
   - 根据市场波动动态调整参数

3. **滚动窗口**
   - 仅使用最近 N 笔订单优化
   - 避免过度依赖早期数据

### 阶段3: 高级功能（探索）

4. **A/B 测试框架**
   - 同时运行多个策略版本
   - 自动对比表现

5. **机器学习模型**
   - 使用 XGBoost 预测订单成功率
   - 特征工程：趋势强度、波动率、时段、币种历史等

6. **自动回滚机制**
   - 检测策略退化
   - 自动回滚到表现更好的版本

## 📚 相关文档

- [策略分析与优化方案](./STRATEGY_ANALYSIS_AND_OPTIMIZATION.md) - 完整的问题分析和解决方案
- [本地策略 v2](./docs/local-strategy-v2.md) - 当前策略版本说明
- [策略优化建议](./STRATEGY_OPTIMIZATION.md) - 优化建议功能说明

---

**部署完成**！开始使用自适应策略优化，预期胜率提升 5-10%。
