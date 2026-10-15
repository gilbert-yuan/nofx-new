# 本机 LightGBM 决策与受限模拟

已在 i5-10400（6 核 / 12 线程）上实际运行。模型训练、特征、回测、记账和风险规则由 Rust 完成；FastAPI 是仅绑定本机的 JSON 转发入口。当前部署 BTCUSDT、ETHUSDT 的 LightGBM 基线，Chronos 对照未通过保留门槛。最近一个月的模型基线均亏损，结果不支持投入实盘资金。

## 工具与职责

| 文件 / 可执行工具 | 用途 |
| --- | --- |
| `rust/src/bin/nofx-ml-data.rs` | 公共 USDT 永续行情采集，冻结闭合 K 线、连续性与来源哈希 |
| `rust/src/ml_features.rs` | 25 个基础特征、12 小时标签、固定分类门槛、6 个可选预测特征 |
| `rust/src/ml_lightgbm.rs` | CPU LightGBM C API 训练、保存、加载、三分类 |
| `rust/src/bin/nofx-ml-train.rs` | 独立第一阶段训练，不加载 Chronos 或 ONNX Runtime |
| `rust/src/bin/nofx-ml-eval.rs` | 按时间滚动样本外 A/B，对照与部署选择 |
| `rust/src/ml_replay.rs` | 复用项目 paper / simulator / research 成交和成本规则 |
| `rust/src/bin/nofx-ml-strategies.rs` | 复用项目 backtest 引擎回放现有策略 |
| `rust/src/bin/nofx-ml-server.rs` | 本机信号 API、行情轮询、独立有限资金模拟账户、恢复校验 |
| `scripts/ml-fastapi.py` | 固定 Rust 上游的 FastAPI JSON 网关 |

LightGBM 4.6.0 的 Windows DLL 安装于 `data/ml/runtime/Lib/site-packages/lightgbm/bin/lib_lightgbm.dll`；Rust 直接调用其[官方 C API](https://lightgbm.readthedocs.io/en/v4.6.0/C-API.html)。Python 环境还包含 FastAPI 0.143.0、Uvicorn 0.54.0。网关使用 [FastAPI](https://fastapi.tiangolo.com/) 实现传输，未在 Python 中建立另一套交易回测。Windows OpenMP DLL 保留到进程结束，避免线程清理阶段卸载崩溃。

## 第一阶段：独立基线

仅使用当时已收盘的连续 256 根小时 K 线。基础特征包含多尺度收益率，SMA / EMA 比值，RSI、ATR、波动率、区间位置、成交量与 UTC 时间周期项。没有读取特征时点之后的行情。

未来 12 小时收盘收益率超过 +0.515% 标为 BUY，低于 -0.515% 标为 SELL，其余 HOLD。阈值包含单边手续费 6 bps、单边滑点 5 bps、固定资金成本 3 bps / 8 小时及额外 25 bps。标签用于训练分类器，不等同于交易一定在第 12 小时平仓。

类别固定为 `[SELL, HOLD, BUY]`。模型最高类别概率至少 0.55，且比第二高概率至少高 0.10，才接受该类别，否则 HOLD。这些概率未做校准，不应解释为交易胜率。本轮是永续研究：BUY 表示开多，SELL 表示开空，并非卖出现有现货；HOLD 不关闭保护规则。

固定 CPU 4 线程、100 轮、15 叶、深度 5、最少叶样本 30、L2=5、学习率 0.05、种子 42。未按测试月优化阈值、参数或早停。

独立训练输出为 `output/ml-lightgbm-only-20261014/models/deployment/`。BTC、ETH 各 2149 个成熟训练标签；整个程序实际耗时约 12.8 秒，单个模型训练约 0.12 / 0.63 秒。两个基础模型文件的 SHA-256 与 A/B 实验最终基础模型完全一致，见 `output/ml-baseline-20261014/independent-baseline-verification.json`。独立训练本身不替代样本外测试。

## 第二阶段：Chronos 特征对照

Chronos-Bolt-Tiny 使用已核对的 CPU ONNX 模型，输入同一闭合价格前缀。新增特征为第 12 小时 q10 / q50 / q90 收益率、q10–q90 宽度、q50 第 1 至第 12 小时斜率、12 点平均 q50 收益率。基础特征、标签、分类门槛、资金及执行规则保持一致。

每周重新训练前 90 天数据，只有目标收盘时间不晚于该周起点的标签能进入训练，执行 12 小时清除边界；5 段分别为 7 / 7 / 7 / 7 / 2 天。一个账户连续运行整月，周界不重置资金或仓位。最后 36 小时仍记录模型分类，但禁止新增订单，使待成交与持仓能够按共享引擎规则结算。

预设保留规则：两种变体均完成结算、各至少 10 笔闭仓，且多数周段改善；同时满足以下一项：净收益改善至少初始资金的 0.1%，回撤恶化不超过 0.1 个百分点；或回撤降低至少 0.1 个百分点，净收益恶化不超过初始资金的 0.1%。本次每账户 1000 USDT，收益门槛为 1 USDT。这只是工程门槛，不代表统计显著性或实盘批准。

BTC 改善 0.8154 USDT、回撤降低 0.0382 个百分点，幅度未达门槛；ETH 净收益与回撤均恶化。因此部署清单的 `chronos_retained=false`，在线服务不加载 Chronos 模型或 ONNX Runtime。完整数字见 [月度报告](D:/UGit/nofx-new/reports/ml-monthly-evaluation-20261014.md)。

## 第三阶段：模拟与风控

BTC、ETH 各自独立 1000 USDT，不能将结果解释为同一个组合。每币最多一个活动订单，杠杆 1x，单笔名义金额最多 50 USDT；ATR 风险预算最多权益 1%，名义金额还受权益 20% 上限限制。初始止损 2 ATR、止盈 5 ATR，部分止盈、动态保护、待成交超时及实际出场均由共享 Rust 引擎执行。

UTC 当日权益损失达到 3% 暂停当日新增订单；本轮峰值回撤达到 10% 后停止本轮新增订单，已有订单继续接受保护。阈值是停开仓规则，价格跳空可能超过估算损失。模型回测与本模拟按小时闭合行情推进，回撤统计不能保证覆盖小时内部所有波动。

每个账户首个时点固定 30 天截止日期，最后 36 小时停止新增订单。截止后冻结账户，不自动补充资金或开始新一轮。当前账户从 2026-10-14 15:00 UTC+08 开始，截止 2026-11-13 15:00；结算尾部从 2026-11-12 03:00 开始。这是刚启动的前向检验，未完成 30 天。

每 60 秒采集一次，仅在新小时出现时追加信号。状态保留完整行情前缀、模型概率、全部 HOLD / 接受 / 拒绝信号、订单、权益、手续费、成交价内滑点、资金成本、回撤、胜率、profit factor 和平均盈利 / 平均亏损比。重复请求不重复下注。进程目录锁防止两个服务同时写同一账户。

恢复校验固定模型、特征顺序与特征代码、账户预算、起止时间和执行规则；执行代码或相关环境参数变化需停止恢复，不能重新解释已记录交易。请保留原状态目录，不通过更换目录、重置权益或更换模型来撤销本轮停止规则。模型不读取账户 API 密钥，没有真实下单路由，外部不能指定交易方向、实盘模式、资金或风险上限。

## 使用方法

以下命令从 `D:\UGit\nofx-new` 执行。冻结数据及已完成研究拒绝覆盖；做新一轮实验时改用新目录，保留原报告。

```powershell
# 重新采集到新的冻结目录（本轮数据已经存在）
cargo run --bin nofx-ml-data -- --output-dir data/ml-market-next

# 第一阶段独立训练，不需要 Chronos
cargo run --bin nofx-ml-train -- --data-dir data/ml-market-next --output-dir output/ml-only-next/models/deployment

# 第二阶段滚动 A/B：需要已导出的 Chronos CPU ONNX 文件
cargo run --bin nofx-ml-eval -- --data-dir data/ml-market-next --output-dir output/ml-study-next

# 本轮已有两策略参考结果；下列命令用于新结果目录
cargo run --release --bin nofx-ml-strategies -- --data-dir data/ml-market-20261014 --output-dir output/ml-reference-next --start-ms 1789365600000 --end-ms 1791957600000 --strategies enhanced-trend-v1,h4-trend-breakout-v1

# 服务重启仍用原 paper-dir，以恢复固定预算和截止日期
cargo run --bin nofx-ml-server -- --model-dir output/ml-baseline-20261014/models/deployment --paper-dir output/ml-paper-20261014 --port 18082 --poll-seconds 60

# 另一个终端启动 FastAPI；本机当前已运行，勿重复启动同一端口
data/ml/runtime/Scripts/python.exe scripts/ml-fastapi.py --port 18083
```

运行服务时可以将已编译 EXE 复制到 `data/ml/bin/`，避免 Windows 锁定 Cargo 需要更新的目标文件。当前就是以此方式运行。变更代码后先停止所属服务、验证原账户的兼容性，再启动；不要绕过执行指纹校验。

接口固定绑定 `127.0.0.1`，FastAPI 地址为 `http://127.0.0.1:18083`，Rust 上游为 `http://127.0.0.1:18082`。FastAPI 禁用代理环境和重定向，仅转发下面五个路由：

| 请求 | 功能 |
| --- | --- |
| `GET /health` | CPU 服务、指纹、Chronos 状态、真实交易关闭状态 |
| `GET /models` | 训练清单、特征、选择门槛 |
| `POST /signal`，`{"symbol":"BTCUSDT"}` | 采集最新闭合小时行情并返回分类与风险预览 |
| `GET /paper` | 持续模拟状态、权益和统计 |
| `POST /paper/step`，`{"symbol":"ETHUSDT"}` | 从公共行情推进模拟，不能提交外部 BUY / SELL |

```powershell
Invoke-RestMethod http://127.0.0.1:18083/health
Invoke-RestMethod http://127.0.0.1:18083/signal -Method Post -ContentType application/json -Body '{"symbol":"BTCUSDT"}'
Invoke-RestMethod http://127.0.0.1:18083/paper
```

`/signal` 允许审查用的闭合连续 `candles`，起点必须不早于模型训练截止；`/paper/step` 只接受币种，并在内部采集行情。该接口不会接受任意模型动作或账户覆盖。`/trade` 不存在。服务需要电脑保持运行与公共行情网络连通；停止服务期间不会有真实成交，重启后按保存的账户继续检验。

本轮冻结行情在 `data/ml-market-20261014/{BTCUSDT,ETHUSDT}.json`，来源与每周期哈希在各文件的 `metadata` 内。模型 A/B、信号日志、订单及权益在 `output/ml-baseline-20261014/`，现有策略结果在其 `existing-strategies-verified/` 子目录；持续状态在 `output/ml-paper-20261014/`。
