# 模型交易链路接入验收（2026-10-15）

已将 Chronos-Bolt-Tiny 价格预测 → LightGBM 信号判断 → Rust 风险保护计划接入主 API 和行情工作台。页面入口是「AI 信号与风控」，选择币种后点击「分析当前币种」。

## 行为与实现

- `POST /api/ml/pipeline` 返回完整三阶段结果。原有 `/api/ml/signal` 保留并增加相同风控字段。
- 风控复用月度回放的 `ml_replay::normalize_signal`、`position_size`、生产计划校验及共享出场规则，没有新增另一套成交或回测引擎。
- 14 周期 ATR、2 ATR 止损、5 ATR 止盈；研究仓位为 1 倍杠杆并受单笔风险预算及名义仓位上限限制。出场规则包含移动止损、智能退出与分批止盈快照。
- HOLD 不生成新仓计划；失效时点、价格关系或风险约束会阻止候选。主网关拒绝方向、账户、风险或外部数据覆盖。
- 当前模型保持研究模式；实际执行动作为 HOLD，自动任务未运行，没有下单。研究参考资金 1,000 USDT，不读取账户余额；当日亏损、回撤与已有仓位检查明确标记为未执行。

说明和完整 API 字段见[模型交易链路](../docs/ml-trading-pipeline.md)。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| Rust 格式检查 | 通过 |
| `cargo check --locked --all-targets` | 通过 |
| `cargo test --locked --all-targets` | 229 通过、7 忽略 |
| 风控测试 | 多空计划、仓位预算、HOLD、过期、非法配置、方向限制；生成的计划用真实共享引擎验证多空止盈/止损，全部通过 |
| Vue/Vite 构建 | 65 个模块，通过 |
| 新主 API health/models、BTC/ETH pipeline | 4/4 HTTP 200 |
| 方向、风险、账户、外部数据覆盖和未知币种 | 5/5 按预期拒绝 |
| 冻结 CLI | 退出 0，识别过期，风险调整与执行均 HOLD |
| 浏览器操作 | BTC 实时结果、切换 ETH 清除旧结果、ETH 保护价格与仓位、展开风控详情、历史日期禁用实时分析均已核对 |

2026-10-15 08:18 UTC 的实际公共数据中，BTC 分类为 HOLD，未生成新仓计划；ETH 分类为 SELL，生成通过校验的研究保护计划。两者使用 08:00 UTC 的闭合时点，`stale:false`，`orders_enabled:false`、`entry_permitted:false`。这些是当时的模型输出和技术验收记录，不代表资金投入许可。

当前预测服务为 `127.0.0.1:18084`（PID 170632），主 API 为 `127.0.0.1:3100`（PID 162628）。两者使用独立运行副本，主 API 设置 `NOFX_AUTOSTART=false`。重启前已核实旧进程路径和自动任务未运行，旧副本及证据保留。

数据 manifest、最终模型 manifest、训练报告的 SHA-256 未改变；原有模型权重和评估结果保留。外部行情仍可能出现连接失败，前端将显示实际错误并清除旧结果。

## 证据

- [机器验收摘要](../data/ml/pipeline-service-20261015/evidence/verification.json)
- [BTC 实时完整结果](../data/ml/pipeline-service-20261015/evidence/api-pipeline-BTCUSDT.json)
- [ETH 实时完整结果](../data/ml/pipeline-service-20261015/evidence/api-pipeline-ETHUSDT.json)
- [参数拒绝记录](../data/ml/pipeline-service-20261015/evidence/rejection-cases.json)
- [运行副本指纹](../data/ml/pipeline-service-20261015/evidence/binaries.json)
- [工作台截图](../data/ml/pipeline-service-20261015/evidence/workbench-eth-pipeline.jpg)

![ETH 预测、分类和风控工作台](../data/ml/pipeline-service-20261015/evidence/workbench-eth-pipeline.jpg)
