# 策略优化功能

## 功能概述

系统现在支持基于历史成交记录自动分析和优化本地策略参数。每个持仓订单都关联了完整的分析上下文，包括策略版本、分析参数、信号详情等。

## 核心功能

### 1. 订单关联分析结果

每个订单现在包含 `analysisContext` 字段，存储：

- **signal**: 完整的分析信号（开仓计划、止盈止损、入场规则等）
- **strategyVersion**: 策略版本哈希（用于追踪策略演进）
- **analysisEngine**: 分析引擎类型（local/ai）
- **scope**: 分析参数（K线数量、周期等）
- **confidence**: 置信度分数
- **confidenceType**: 置信度类型
- **reason**: 开仓理由（策略规则匹配说明）
- **risk**: 风险提示
- **validationIssues**: 验证问题列表
- **automationRunId**: 自动化运行ID
- **dataAsOf**: 行情数据时间戳

### 2. 策略优化分析

通过 `/api/paper/optimize` 接口获取基于历史成交的优化建议。

#### 统计维度

- **整体表现**: 胜率、平均ROI、平均持仓时长、累计收益
- **按策略版本**: 不同策略版本的表现对比
- **按币种**: 各币种的胜率和收益
- **按方向**: 做多/做空的表现差异
- **按平仓原因**: 止损/止盈/超时的分布

#### 优化建议类型

1. **止损优化** (`stop_loss`)
   - 检测止损过紧导致频繁被打
   - 建议: 调整 ATR 倍数

2. **止盈优化** (`take_profit`)
   - 分析止盈命中率和效果
   - 建议: 调整止盈距离

3. **持仓时长优化** (`hold_duration`)
   - 检测实际持仓时长与最大持仓时长的比例
   - 建议: 缩短 maxHoldBars 提高资金利用率

4. **方向偏好分析** (`direction_bias`)
   - 检测多空表现差异
   - 建议: 可能需要单向策略

5. **币种筛选** (`symbol_filter`)
   - 识别表现不佳的币种
   - 建议: 加入黑名单

6. **整体表现评估** (`overall_performance`)
   - 整体胜率过低或过高的提示
   - 建议: 调整入场门槛

### 3. 可执行的参数调整

系统自动生成具体的参数调整建议：

```json
{
  "field": "maxHoldBars",
  "current": "120",
  "suggested": 72,
  "reason": "平均持仓 17.3 根K线，仅占最大持仓时长的 14%，可以缩短 maxHoldBars"
}
```

## API 接口

### GET /api/paper/optimize

获取策略优化分析报告。

**响应示例：**

```json
{
  "stats": {
    "total": 11,
    "profitable": 3,
    "losing": 8,
    "winRate": 0.273,
    "averageRoi": -0.0168,
    "averageHoldBars": 17.3,
    "totalNet": -18.53,
    "byStrategy": [...],
    "bySymbol": [...],
    "byDirection": [...],
    "byReason": [...]
  },
  "suggestions": [
    {
      "type": "stop_loss",
      "severity": "high",
      "message": "止损命中率 81.8%，胜率仅 11.1%，建议放宽止损距离",
      "data": {...}
    }
  ],
  "adjustments": [
    {
      "field": "maxHoldBars",
      "current": "120",
      "suggested": 72,
      "reason": "..."
    }
  ],
  "sampleSize": 11,
  "timestamp": "2026-09-08T14:30:00.000Z"
}
```

### GET /api/paper/orders/:id

获取订单完整详情（包含分析上下文）。

**响应示例：**

```json
{
  "id": "d7a2174a-...",
  "symbol": "IOSTUSDT",
  "direction": "OPEN_LONG",
  "status": "closed",
  "roi": -0.0338,
  "reason": "stop_loss",
  "analysisContext": {
    "signal": {
      "plan": {...},
      "confidence": 0.728,
      "reason": "本地规则：20 根均线高于50 根均线..."
    },
    "strategyVersion": "cb3d4c0ce4bfdbc5",
    "analysisEngine": "local",
    "scope": {
      "limit": 80,
      "engine": "local",
      "interval": "1m"
    }
  }
}
```

## 数据迁移

已有订单可以通过迁移脚本补充分析上下文：

```bash
node migrate-orders-with-context.js
```

该脚本会：
1. 从 `research_records` 表读取原始分析记录
2. 为每个订单补充完整的 `analysisContext`
3. 更新模拟账户状态

## 使用场景

### 场景 1: 定期优化策略

每周运行优化分析，根据建议调整策略参数：

1. 调用 `/api/paper/optimize`
2. 查看胜率、ROI、平仓原因分布
3. 根据 `adjustments` 更新本地策略规则
4. 观察后续表现变化

### 场景 2: 币种筛选

识别表现不佳的币种并排除：

```json
{
  "type": "symbol_filter",
  "severity": "high",
  "message": "以下币种胜率较低，建议排除：SOPHUSDT, DOODUSDT",
  "data": {
    "symbols": [
      {"symbol": "SOPHUSDT", "winRate": 0.0, "count": 3},
      {"symbol": "DOODUSDT", "winRate": 0.0, "count": 2}
    ]
  }
}
```

### 场景 3: 方向调整

发现多空表现差异时调整策略：

```json
{
  "type": "direction_bias",
  "severity": "medium",
  "message": "多空表现差异显著：做多胜率 42.9%，做空胜率 0.0%",
  "data": {
    "longWinRate": 0.429,
    "shortWinRate": 0.0,
    "longCount": 7,
    "shortCount": 4
  }
}
```

建议: 暂时只做多，或重新审视做空规则。

## 后续扩展

1. **A/B 测试**: 同时运行多个策略版本，对比表现
2. **参数自动调优**: 基于遗传算法或贝叶斯优化自动寻找最优参数
3. **风险归因分析**: 分析亏损订单的共同特征
4. **实时监控**: 当胜率低于阈值时自动暂停策略
5. **策略回测**: 使用优化后的参数在历史数据上验证

## 注意事项

1. **样本量**: 建议至少有 20+ 已平仓订单才进行优化分析
2. **过拟合**: 避免过度优化导致策略过拟合历史数据
3. **市场变化**: 优化建议基于历史表现，市场环境变化可能导致失效
4. **综合判断**: 结合多个维度的建议，不要单纯追求某一指标
