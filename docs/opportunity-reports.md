# 策略机会与超级确认

自动化选币现在分为两层：

1. 现有策略负责选币、判断方向，并生成入场区间、止损和止盈计划。
2. 独立的机会确认方法读取策略计划和最新衍生品市场上下文，补充 24h 涨跌幅、OI 变化、资金费率与当前价格，给出是否可以继续以及是否需要等待更好价格的结论。

## 机会报告

报告只针对通过策略计划校验的 `BUY` 或 `SELL` 信号生成；`WAIT` 或没有完整计划的信号不会被当成机会。报告不直接下单，也不会替换策略自身的风险控制。

主要结论代码：

- `BUY_NOW`：可以考虑按策略计划继续做多。
- `WAIT_PULLBACK`：方向偏多，但当前不宜直接追多，等待回踩理想入场区。
- `SELL_NOW`：可以考虑按策略计划继续做空。
- `WAIT_REBOUND`：方向偏空，但当前不宜直接追空，等待反弹到理想入场区。

`canProceed` 表示独立确认层的结论，`recommendation` 在等待时为 `HOLD`。等待并不等于策略失效：现有的限价计划仍可作为回踩/反弹触发条件，实际是否提交仍由原有自动化和风控配置决定。

## API

读取最近机会：

```text
GET /api/automation/opportunities?limit=20
```

自动化状态接口 `/api/automation/status` 也会返回 `opportunities` 字段，前端自动化页面使用该字段展示最近报告。

单条报告的重点字段：

```json
{
  "symbol": "BRUSDT",
  "action": "BUY",
  "recommendation": "HOLD",
  "canProceed": false,
  "decision": {
    "code": "WAIT_PULLBACK",
    "label": "偏多，但不追涨，等待回踩后做多"
  },
  "current": {
    "price": 0.318,
    "change24hPct": 30,
    "oiChangePct": 46,
    "fundingRate": 0.0008
  },
  "levels": {
    "entryRange": { "min": 0.3, "max": 0.306 },
    "optimalEntry": 0.303,
    "stopLoss": 0.285,
    "takeProfits": [0.325, 0.345, 0.365]
  }
}
```

市场上下文来自 Binance U 本位合约公开行情接口；任一衍生品指标获取失败时，报告仍会生成，但对应字段为空，并保留在 `contextErrors` 中。
