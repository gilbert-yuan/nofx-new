# 月度训练数据采集

`nofx-ml-collect` 是 Rust 公共市场数据采集器，复用系统 `Exchange` 的代理、HTTP 重试、IP 权重及资金费率/统计接口限速。无需账户密钥，不执行订单。默认收集 Binance 当前 `TRADING`、`PERPETUAL`、报价及保证金币为 USDT 的全部合约。这个范围是当前交易所合约全集，包含当前合约选择产生的幸存者偏差，不代表全球所有币种。

先采集所有合约小时 K 线，再补充历史辅助数据：

```powershell
cargo run --locked --bin nofx-ml-collect -- --output-dir data/ml/monthly-20261014 --phase candles
cargo run --locked --bin nofx-ml-collect -- --output-dir data/ml/monthly-20261014 --phase history
```

默认训练区间是交易所服务器时间之前最近 30 天的完整小时，额外拉取前置 256 小时供 Chronos 上下文使用。`--end-ms` 可固定毫秒截止时间；重跑时直接复用 manifest 内的原截止时间与原合约全集，不随运行时刻漂移。`--concurrency 4` 是默认并发，上限为 8。首次采集支持 `--symbols BTCUSDT,ETHUSDT` 限定冒烟测试范围；正式运行不传此参数。

目录结构：

| 路径 | 内容 | 可参与历史训练 |
| --- | --- | --- |
| `manifest.json` | 固定区间、合约全集、逐合约状态、文件 SHA-256、行数、缺口和可用性 | 用于校验及选择合格数据 |
| `symbols/<SYMBOL>.json` | `datasets.1h` 规范化小时 K 线 | 是 |
| `history/<SYMBOL>.json` | 历史辅助数据汇总、逐接口覆盖率和错误 | 按可用时间连接 |
| `history/<SYMBOL>/<DATASET>.json` | 单接口成功原始数据、来源、区间及校验和 | 按可用时间连接 |
| `history/<SYMBOL>/<DATASET>.error.json` | 实际失败原因、接口和采集时间 | 否 |
| `snapshots/*.json` | 合约列表、24h 行情、买卖价、标记/指数价及当前资金费率规则快照 | 否 |

小时 K 线字段：`openTime`、`closeTime`、`open`、`high`、`low`、`close`、`volume`、`quoteVolume`、`tradeCount`、`takerBuyVolume`、`takerBuyQuoteVolume`、`confirmed`。成交额、成交次数和主动买入量直接来自同一历史 K 线，主动卖出量可以由总量减去主动买入量推导。所有数值必须有限，OHLC 范围、成交量、主动成交量、小时边界、重复和缺口均校验。当前未闭合 K 线排除。

历史辅助数据 `datasets` 键：

| 键 | 接口 | 时间字段 |
| --- | --- | --- |
| `funding` | `/fapi/v1/fundingRate` | `fundingTime` |
| `open_interest` | `/futures/data/openInterestHist` | `timestamp` |
| `global_long_short` | `/futures/data/globalLongShortAccountRatio` | `timestamp` |
| `top_account_long_short` | `/futures/data/topLongShortAccountRatio` | `timestamp` |
| `top_position_long_short` | `/futures/data/topLongShortPositionRatio` | `timestamp` |
| `taker_long_short` | `/futures/data/takerlongshortRatio` | `timestamp` |
| `basis` | `/futures/data/basis` | `timestamp` |
| `mark_price_1h` | `/fapi/v1/markPriceKlines` | `openTime` |
| `index_price_1h` | `/fapi/v1/indexPriceKlines` | `openTime` |
| `premium_index_1h` | `/fapi/v1/premiumIndexKlines` | `openTime` |

资金费率、统计和基差保留接口原字段。标记价、指数价、溢价 K 线规范化为 OHLC 与开闭时间；溢价允许负数。每行额外加入 `available_at_ms`。资金费率使用结算时刻；其余使用接口时间戳加一个小时。对标记价等周期起点时间，这意味着只在闭合后使用；对时间戳表示周期终点的多空比，这是保守地额外延后一小时。交易所没有提供历史首次发布/接收时间，保守时刻不能证明实际网络延迟，应在评估中说明。在线推理使用相同规则。

统计和基差接口通常仅提供最近 30 天，采集开始时向上取整其可保留起点，缺少的最早小时明确计入覆盖率。部分大户接口可能要求密钥、拒绝访问或不支持某些合约；采集器记录真实错误及空数据，不伪造替代数据。接口实际行为和保留限制以 [Binance 官方市场数据文档](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data) 为准。

新上市合约保留实际首根 K 线及 `missing_warmup_hours`。存在内部缺口或末端缺口的合约标记 `partial` 并排除训练；已满足完整 256 小时上下文、12 小时预测/标签区间和最低样本需求的新合约可参加训练，样本只从其可用范围生成，训练采样步长为 6 小时。空数据或请求失败在 manifest 中标记 `failed`，不会从全集列表消失。

成功原始文件通过临时文件写入、落盘、原子硬链接创建，不覆盖既有文件。重跑验证文件内容及区间；中断后的临时文件不参与训练。manifest 和历史汇总采用可恢复检查点。成功历史接口复用原始文件；`--retry-failed` 仅重新尝试此前不可用的历史接口。

`train_ready` 表示小时 K 线阶段结束且存在至少一个合格合约；训练仍需读取逐合约 `training_eligible`，不要将失败合约算作成功。`history_complete` 表示历史阶段全部尝试完成；`history_all_available` 才表示全部合约的全部历史接口均成功。出现任何主数据或历史接口错误时，最终状态是 `complete_with_errors`，具体错误保持可查。最新快照明确带有 `historical_training_eligible:false`，不得回填进过去的样本。

BTCUSDT 和 ETHUSDT 包含在完整合约全集，其历史价格可按同一已闭合小时连接为市场背景。新闻、社交情绪、逐笔清算及历史订单簿不属于这些免费 REST 接口可以完整回溯的月度数据。需要其他可授权、带事件/首次可用时间的来源后单独接入，不能把当前抓取的新闻或盘口用于过去月份的预测。
