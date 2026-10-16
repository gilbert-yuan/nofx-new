# 全合约月度 Chronos + LightGBM 流水线

本流程优先由 Chronos-Bolt-Tiny 预测未来 12 小时价格分位数，再由全币种共用的 LightGBM 判断 SELL / HOLD / BUY。数据采集、特征、校准、训练、推理和交易回放均由 Rust 完成。模型只作为研究候选集成，不读取账户密钥、不创建订单。

完整「预测 → 信号 → 止盈止损」已接入行情工作台与 `POST /api/ml/pipeline`；复用月度回放的共享风控，详见 [模型交易链路](ml-trading-pipeline.md)。

2026-10-15 已完成冻结月度数据的 869 合约训练及 1,738 份共享引擎回放。三分类测试准确率 56.59%（基线 56.10%），但成本后净收益加总为 −258.81 USDT（基线 −148.11），保留研究模式。Chronos 本轮做预测校准，权重未更新；完整覆盖、预测误差和比较条件见 [最终评估](../reports/ml-global-monthly-evaluation-20261015.md)。

默认数据来源是 Binance 官方公开归档，采集最近 30 个完整 UTC 日和额外 256 小时上下文。枚举归档中的 USDT 合约目录，逐币记录最新日是否可用、实际覆盖和缺失；归档缺失不能直接判定停牌或退市。这不等同于当前可交易合约清单，也不代表全球所有币种。K 线、成交额、成交次数、主动成交和可以回溯的历史辅助来源按真实可用程度采集，归档 ZIP 核对官方 SHA-256。REST 方式另行枚举当前可交易合约，支持资金费率、持仓量、多空比、基差、标记价、指数价和溢价。来源与限制见 [数据采集说明](ml-monthly-data.md)。当前快照不回填历史训练，缺失来源带有明确掩码。

## 执行

从项目根目录运行；首次完整运行可能需要较长时间。脚本先完成数据采集，再训练和验证。

```powershell
# 采集公开归档、训练、保存候选模型和报告
.\scripts\train-monthly-model.ps1

# 完成后以本机研究服务提供模型查询和预测
.\scripts\train-monthly-model.ps1 -Serve
```

默认数据目录为 `data/ml/monthly-archive-20261014`，结果目录为 `output/ml-monthly-20261014`，缓存为该数据目录下的 `feature-cache-v3`，可用 `-CacheDir` 指定。缓存校验价格来源、模型、特征实现和精确浮点解析约定的指纹；代码变化后选择新的缓存目录，旧缓存保留。采集中断后使用相同目录重跑，会恢复固定截止时间、币种目录全集和已成功的文件。成功数据、模型和结果拒绝覆盖；新一轮研究使用新的目录。已完成的候选可直接复用 `-Serve`，不重新训练。编译脚本限制单个 Cargo 构建任务，适合本机内存容量。需要 REST 采集时使用 `-Source rest -DataDir data/ml/monthly-rest-next -OutputDir output/ml-monthly-rest-next`；`-Proxy` 默认沿用项目 PM2 配置的 `http://127.0.0.1:7890`，归档采集使用直接连接。

可分阶段运行 Rust 工具：

```powershell
# 第一阶段优先取得所有合约的小时 K 线
.\target\debug\nofx-ml-archive.exe --output-dir data/ml/monthly-archive-20261014 --phase candles

# 第二阶段取得历史辅助来源
.\target\debug\nofx-ml-archive.exe --output-dir data/ml/monthly-archive-20261014 --phase history

# 可在历史采集进行期间提前生成闭合价格前缀的 Chronos 特征缓存
.\target\debug\nofx-ml-monthly-train.exe --data-dir data/ml/monthly-archive-20261014 --output-dir output/ml-monthly-20261014 --cache-dir data/ml/monthly-archive-20261014/feature-cache-v3 --prepare-only

# 数据完成后训练，复用特征缓存
.\target\debug\nofx-ml-monthly-train.exe --data-dir data/ml/monthly-archive-20261014 --output-dir output/ml-monthly-20261014 --cache-dir data/ml/monthly-archive-20261014/feature-cache-v3
```

默认每 6 小时生成一个样本；每个样本只使用当时已闭合的 256 根小时 K 线。新的合约按真实可用范围生成样本，内部缺口、末端缺口或样本不足的合约明确排除。只有采集器记录为训练合格的合约进入模型；全集采集成功数不能直接等同于训练币种数。

## 特征与训练

69 个特征依次为 25 个价格/波动/成交量/UTC 周期特征、8 个成交额/成交次数/主动成交特征、20 个历史辅助值和可用性掩码、10 个 BTC/ETH 市场背景值和掩码、6 个 Chronos 分位数特征。市场背景包含 24/72 小时收益、72 小时相关系数和相对 24 小时收益；所有参考币行情同样按样本时点截断。

历史辅助数据使用 `available_at_ms <= origin_ms` 的连接。资金费率使用结算时刻；统计使用原时间戳加一小时；标记、指数和溢价 K 线使用闭合时刻。过期数据变为缺失：一般历史值 24 小时，标记/指数/溢价 6 小时。持仓量变化还要求可用的 24 小时前观察值。这些规则在线推理和离线训练共用。

30 天按时间划分为前 60% 训练、中间 20% 验证、最后 20% 测试。标签是未来 12 个完整小时收盘收益；分区边界前未成熟的标签清除，所有币种共用相同时间边界。阈值复用系统共享成本模型和额外收益缓冲。

Chronos 的 ONNX 权重保持原样。本轮适配是在训练区间拟合每个预测小时的收益残差中位数，并用验证区间选择收缩比例；保留原始预测和校准预测以便审查。这属于预测校准，`weights_updated:false` 明确记录，不能称为权重微调。报告对比原始/校准分位数损失。

LightGBM 在训练区间拟合全合约三分类模型，验证区间选择预设参数候选及类别概率门槛。类别固定为 `[SELL, HOLD, BUY]`；SELL 是开空候选，BUY 是开多候选。HOLD 不具有强制平仓语义。概率未进行胜率校准，不应解释成交易获利概率。

最终测试区间不参与参数和门槛选择。报告包含普通准确率、均衡准确率、混淆矩阵、类别占比、log loss、Chronos 消融对照及共享 Rust 引擎回放。回放复用生产成交、成本、风控和出场逻辑。每币是独立有限资金账户，跨币种净收益加总不代表一个共享资金组合；每 6 小时样本的 12 小时标签有重叠。

## 模型产物与推理

训练完成后输出 `manifest.json`、`training-report.json`、两个全局 LightGBM 模型、预测缓存、测试信号和逐币共享引擎回放。manifest 记录训练/验证/测试边界、特征代码哈希、币种全集、模型哈希、Chronos 哈希、校准和决策策略，以及 `research_only` 状态。

```powershell
# 获取最新闭合小时的公共数据并预测
.\target\debug\nofx-ml-monthly-predict.exe --model-dir output/ml-monthly-20261014 --symbol BTCUSDT

# 审查模型训练时核验过的完整冻结归档，明确返回历史时点
.\target\debug\nofx-ml-monthly-predict.exe --model-dir output/ml-monthly-20261014 `
  --data-dir data/ml/monthly-archive-20261014 --symbol BTCUSDT `
  --output output/ml-monthly-20261014/BTCUSDT-frozen-inference.json

# 审查单独提供的闭合行情；此方式依旧要求训练用辅助来源可用
.\target\debug\nofx-ml-monthly-predict.exe --model-dir output/ml-monthly-20261014 --symbol BTCUSDT `
  --input data/ml/monthly-archive-20261014/symbols/BTCUSDT.json `
  --history data/ml/monthly-archive-20261014/history/BTCUSDT.rebuilt.json `
  --market-data-dir data/ml/monthly-archive-20261014/symbols `
  --output output/ml-monthly-20261014/BTCUSDT-inference.json

# 独立本机候选服务：显式冻结归档审查模式
.\target\debug\nofx-ml-monthly-predict.exe --model-dir output/ml-monthly-20261014 `
  --data-dir data/ml/monthly-archive-20261014 --serve --port 18084

Invoke-RestMethod http://127.0.0.1:18084/models
Invoke-RestMethod http://127.0.0.1:18084/signal -Method Post -ContentType application/json -Body '{"symbol":"BTCUSDT"}'
```

在线推理取得目标币和 BTC/ETH 的最新闭合行情，并取得相同历史辅助来源。部分来源失败保留错误和缺失掩码；如果训练曾使用辅助来源、当前所有辅助值均缺失或过期，拒绝输出预测。训练使用过市场背景时，BTC/ETH 参考行情也必须完整。

不指定 `--data-dir` 时仍使用真实公共 REST 行情。当前环境可能收到 HTTP 451，服务会返回真实失败，不自动改用更早数据。显式指定 `--data-dir` 才启用历史审查模式：完整采集 manifest 必须与模型记录的训练来源 SHA-256 完全相同，每次读取目标币、辅助来源及 BTC/ETH 文件时核验原始文件哈希，路径限制在该数据目录内，且不能通过请求覆盖行情或时点。

冻结模式返回 `data_mode:frozen_snapshot`、`origin_ms`、`observed_at_ms`、`stale`、`forecast_target_end_ms`、`forecast_target_still_future` 和 `live_eligible:false`。截至时点早于当前闭合小时即标记过期；12 小时预测终点已经过去时明确标记目标不再位于未来。health/models 同时公开模式、数据截止时间和整体来源可用性。已核验的冻结来源可以保留训练时相同的全缺失辅助掩码，并公开可用特征数和错误，结果仅用于复核历史模型行为。

加载前校验 typed manifest、特征顺序和代码哈希、Chronos 架构、校准参数、决策策略、模型文件哈希及原生特征数。模型路径必须留在候选目录。输入验证显式闭合标志、小时连续性、OHLC、成交量和主动成交范围；拒绝未知币种、未来/未闭合行情、以及早于验证截止的部署模型推理。请求不能指定交易动作、资金或风险参数。

## 系统入口

主后端新增只读入口，转发到固定本机候选服务：

| 请求 | 功能 |
| --- | --- |
| `GET /api/ml/health` | 查询候选服务状态 |
| `GET /api/ml/models` | 查询候选 manifest 和指纹 |
| `POST /api/ml/signal`，`{"symbol":"BTCUSDT"}` | 采集公共数据并返回候选分类 |

主后端需以新构建重启后才能提供这些入口；候选服务默认端口 `18084`，后端可通过 `NOFX_MONTHLY_ML_PORT` 指定本机端口。后端只接受币种请求，拒绝外部行情、模型动作或执行参数。候选服务输出 `advisory_only:true`、`orders_enabled:false`、`real_trading_enabled:false`，没有真实下单入口。

2026-10-15 本机已用新构建运行主 API（3100）和默认实时模式的预测服务（18084），主 API 的 BTC/ETH 实时预测实测成功；该次使用 06:00 UTC 的闭合时点。`NOFX_AUTOSTART=false`，自动任务未运行。实时验收也遇到行情 TLS 连接失败，服务保留真实错误，不回退冻结数据；具体通过项和失败记录见 [最终评估](../reports/ml-global-monthly-evaluation-20261015.md)。上述记录是该时刻的验收结果，不代表持续网络可用。

上述记录保留了当时的研究验收状态。主 API 现支持独立配置 `ml.mode:"demo"`，在 Binance Demo 账户完成风控检查后，由 `chronos-lightgbm-v1` 自动任务执行。预测器及训练 manifest 仍保留只读/研究评估标志；账户执行模式不改变历史评估结论。配置、仓位上限和接口语义见[模型交易链路](ml-trading-pipeline.md)。

此前 `18082` 的 BTC/ETH 基线服务、`18083` 的网关及 `output/ml-paper-20261014` 账户使用自己的模型和指纹。全合约候选使用独立服务与数据，保留旧模型与账户文件。一月数据的验证与单次留出测试仍是有限证据；是否提高准确率和交易表现，以最终报告中的实际样本外对照为准。
