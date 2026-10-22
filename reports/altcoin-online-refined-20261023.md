# 山寨趋势突破线上参数替换记录

已按用户“替换线上参数”的明确要求，热更新当前线上策略`altcoin-trend-breakout-live-v1`。服务保存时间为2026-10-22 21:35:29.512 UTC，即2026-10-23 05:35:29.512 Asia/Irkutsk。采用本轮180组全期最高候选`A-7191f22c929c`，没有另选参数或重新优化。

| 参数 | 原值 | 当前生效覆盖值 |
|---|---:|---:|
| 周期 | 4h | 4h |
| EMA快／慢 | 30／90 | 25／75 |
| 通道根数 | 10 | 8 |
| 初始止损ATR | 1.5 | 1 |
| 跟踪止损ATR | 3 | 3 |
| EMA方向过滤 | 开启 | 开启 |

仅四个参数值变化：`emaFast`、`emaSlow`、`channelPeriod`、`stopAtr`。单笔计划风险0.3%、最多3仓、单币名义比例50%以及其他策略参数均未变化。沿用1倍策略杠杆、同向最多2仓、50 USDT单笔名义上限及现有全局风控。

验收时仅此策略启用，其余12项关闭；Binance Demo同步开启、实盘同步关闭，健康检查通过、执行状态`ready=true`。这不是已产生新参数成交或盈利的证明。

通过`PUT /api/strategies/altcoin-trend-breakout-live-v1`写入，附完整`expectedParams`校验旧值，接口返回`rejected=[]`，随后GET读回全部参数并核对。更新由现有Rust Store机制持久保存，无需重新编译或重启。新一轮扫描会读取新值；已开始的扫描可能持有旧参数快照，已有订单按自身冻结参数复核，未主动平仓或改写旧订单保护规则。

内置显示名称仍为“山寨趋势突破 · EMA30/90”，内置默认值及模型标签也保留原注册表元数据；当前实际参数以API覆盖值为准。备注已明确写入EMA25/75、通道8、止损1 ATR和来源候选。“恢复默认”会回到旧30/90参数。

本轮研究中的历史全期收益+25.2723%、回撤8.3782%，新13天统一33/34覆盖诊断收益-2.7002%；研究结论没有因上线而改变。此替换按用户要求执行，详细验证见[研究报告](altcoin-local-refinement-20261023.md)。

- [当前线上参数模板](../configs/altcoin-live-refined-20261023.json)
- `output/altcoin-online-refined-20261023/strategies-before.json`：替换前完整策略状态。
- `patch.json`、`put-response.json`、`strategies-after.json`：请求、响应及独立读回。
- `verification.json`、`runtime-guards-before.json`、`runtime-guards-after.json`：参数差异、启用状态、运行模式及风控核对。
- `automation-health.json`：执行准备状态。
- `rollback.json`：原参数、启用状态与备注的回滚请求体；本次未使用。

本次没有修改Rust源码或运行二进制，验收使用现有参数接口、只读状态与持久化核对；未另跑回测或Cargo构建。运行二进制SHA256仍为`5d91474bd71adcefb40629438ad5e955de610739c2e2dfcfb535365ad2bfe01f`。
