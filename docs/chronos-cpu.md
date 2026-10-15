# Chronos-Bolt-Tiny 本机 CPU 使用说明

当前实现使用 `amazon/chronos-bolt-tiny` 预测价格，再由 Rust 评估程序比较预测信号与简单趋势信号。LightGBM 尚未加入。项目约定要求后端和回测使用 Rust，因此 JSON 接口使用 Axum；没有新增 FastAPI 服务。

Python 隔离环境仅用于一次性转换官方权重与核对转换结果。正常预测、行情读取、信号判断、风险规则和回测均由 Rust 执行。无需购买模型 API 额度；首次准备模型和实时行情读取需要联网。

## 模型与预测含义

| 项目 | 当前设置 |
| --- | --- |
| 模型 | `amazon/chronos-bolt-tiny`，8,652,672 个 F32 参数 |
| 官方权重许可 | Apache-2.0 |
| 运行设备 | CPU，默认 4 个推理线程 |
| 输入 | 256 根连续、已收盘的 1 小时收盘价 |
| 当前 ONNX 输入形状 | `[1, 256]`，F32，无缺失值 |
| 官方模型最大上下文 | 2048 个观测值；当前导出固定为 256 |
| 原生模型输出 | `[1, 9, 64]`，64 个未来时间步，分位数 0.1 至 0.9 |
| 本次输出 | 前 12 步的 q10、q50、q90，即 12 个未来小时的预测收盘价 |

12 小时来自 **1h 数据 × 12 步**。换成 5 分钟数据后，12 步只有 1 小时；不能仅更改时间标签把它解释为 12 小时。

q10 到 q90 是模型给出的逐小时预测分位数区间。它不是保证覆盖实际价格的区间，也不是未来 12 小时的最高价、最低价区间。其实际覆盖率必须由滚动验证测量。q50 是中位数预测；价格预测误差较小也不等于交易策略能够盈利。

`origin_ms` 是第一个未来小时 K 线的开盘时间，`context_end_open_ms` 必须等于 `origin_ms - 3600000`。数组下标 0 对应该未来小时的收盘价，下标 11 对应第 12 个未来小时的收盘价。接口保留原始模型分位数；若分位数交叉，会通过 `quantile_crossings` 披露，离线评估会拒绝交叉区间。

官方资料：[模型说明](https://huggingface.co/amazon/chronos-bolt-tiny)、[模型配置](https://huggingface.co/amazon/chronos-bolt-tiny/blob/main/config.json)。

## 一次性权重转换

以下 PowerShell 命令均在项目根目录运行。现有隔离环境为 `data/chronos/model-toolchain`，与项目独立桌面应用的 Python 目录分离。

本次转换使用 Python 3.12、PyTorch 2.6.0+cpu、Chronos Forecasting 2.3.2、Transformers 4.49.0、ONNX 1.17.0、ONNX Runtime 1.22.1。已导出的模型位于 `data/chronos/chronos-bolt-tiny.onnx`；现有模型无需在每次预测前重新转换。

需要从头准备转换环境时：

```powershell
py -3.12 -m venv data/chronos/model-toolchain
$taskChronosPython = 'data/chronos/model-toolchain/Scripts/python.exe'
& $taskChronosPython -m pip install 'torch==2.6.0+cpu' --index-url https://download.pytorch.org/whl/cpu
& $taskChronosPython -m pip install 'chronos-forecasting==2.3.2' 'transformers==4.49.0' 'onnx==1.17.0' 'onnxruntime==1.22.1' 'numpy==2.5.4'
```

将官方 `config.json` 和 `model.safetensors` 准备到 `data/chronos/model`。本次核对的官方仓库修订为 `a0e552de83495b5c28c14c71c374f3e33280b340`，可使用隔离环境的 Hugging Face CLI 下载：

```powershell
& data/chronos/model-toolchain/Scripts/hf.exe download amazon/chronos-bolt-tiny --revision a0e552de83495b5c28c14c71c374f3e33280b340 --local-dir data/chronos/model
```

执行转换：

```powershell
& data/chronos/model-toolchain/Scripts/python.exe scripts/export-chronos-onnx.py --model-dir data/chronos/model --output data/chronos/chronos-bolt-tiny.onnx --reference data/chronos/parity-reference.json
```

导出脚本使用 CPU/F32，仅将导出器不支持的归一化、分块和整数嵌入操作替换为对完整有限输入等价的操作。模型自身的归一化与预测反归一化包含在 ONNX 中；Rust 不另外缩放价格。脚本检查 ONNX 图，并将三组完整输出与修改前的官方 PyTorch 模型对照，结果和版本写入 `parity-reference.json`。脚本不读取行情，不判断买入，不执行回测。

导出器还核对固定修订的权重与配置 SHA-256，生成 `chronos-bolt-tiny.manifest.json`，记录模型、配置、导出器与 ONNX 哈希及环境版本。等价范围限于固定 Tiny 配置、完整有限 F32 的 256 点输入、16 点非重叠分块、未启用 arcsinh 且归一化中间值不溢出。

## Rust 历史预测与滚动评估

默认使用项目已有的冻结行情目录 `output/profit-improvement-20261011/data`。目录下应有 `BTCUSDT.json`、`ETHUSDT.json`；增加 PROM 前，应准备同格式的 `PROMUSDT.json`。

第一步用 Rust 从已收盘历史前缀准备模型输入：

```powershell
cargo run --bin nofx-chronos-eval -- --data-dir output/profit-improvement-20261011/data --symbols BTCUSDT,ETHUSDT --context-length 256 --prepare-inputs output/chronos-bolt-tiny-20261014/inputs.json
```

第二步用 Rust/ONNX Runtime 推理：

```powershell
cargo run --bin nofx-chronos -- --inputs output/chronos-bolt-tiny-20261014/inputs.json --output output/chronos-bolt-tiny-20261014/forecasts.json --threads 4
```

第三步用同一冻结数据评估：

```powershell
cargo run --bin nofx-chronos-eval -- --data-dir output/profit-improvement-20261011/data --symbols BTCUSDT,ETHUSDT --forecasts output/chronos-bolt-tiny-20261014/forecasts.json --output output/chronos-bolt-tiny-20261014/evaluation.json
```

`--symbols` 使用逗号分隔；若评估三个币种，上述准备与评估命令都使用 `--symbols BTCUSDT,ETHUSDT,PROMUSDT`。保持 `--context-length 256`，与当前固定输入形状一致。

输入按每 12 小时一个预测起点滚动生成，只包含当时可见的 256 根收盘价；时间戳和历史前缀 SHA-256 随结果传递。评估程序核对前缀、目标时段、分位数和保留样本边界，固定保留边界之后的目标不参与本次比较。冻结数据的历史预测不能当作当前行情预测。

预测比较包含中位数误差、方向判断、q10–q90 实际覆盖率，以及价格持平预测和简单线性趋势基准。交易比较使用以下固定规则：

- Chronos 信号：第 12 小时 q10 高于当前收盘价加共享交易成本阈值。
- 简单趋势信号：当前收盘价不低于 SMA20，且 SMA20 高于 SMA50。
- 两种信号使用相同的 ATR 风险计划、共享成本模型和生产 Rust 模拟成交/出场引擎；初始止损为 2 ATR，初始止盈为 5 ATR，实际出场沿用默认分批止盈与动态保护规则。

交易样本至少相隔 24 小时，以隔离的 100 USDT、1 倍杠杆订单比较；订单收益之和不是组合收益率。生产挂单、成交延迟和到期仍未平仓的订单会保留并披露，存在未解决订单时不能把结果解释为完整收益比较。实际性能与回测结果以本次验证报告为准。

## Rust 实时预测

读取 Binance 公共 USDT 永续小时行情，不需要交易账户密钥或数据库：

```powershell
cargo run --bin nofx-chronos -- --live-symbol BTCUSDT --live-symbol ETHUSDT --output output/chronos-live.json --threads 4
```

CLI 只接受最近 256 根连续、已收盘的小时 K 线；缺失、过期或未收盘数据会报错。可对交易所支持的其他合约使用重复的 `--live-symbol` 参数。该命令返回预测 JSON，不下单。

输出包含 `q10`、`q50`、`q90`、`current_price`、预测起点和推理延迟。批量输出还包含模型加载时间及均值、P50、P95 推理时间；默认先执行 3 次预热，预热不计入逐记录延迟。

## Rust HTTP JSON 接口

启动服务：

```powershell
cargo run --bin nofx-chronos -- --serve --port 18081 --threads 4
```

服务绑定 `127.0.0.1`。在另一终端检查模型服务：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:18081/health
```

`POST /forecast` 接收单条模型上下文，而不是币种名称自动取行情。必填 JSON 字段为 `symbol`、`origin_ms`、`context_end_open_ms`、`context`；`context` 必须包含 256 个有限正数。可选字段 `context_open_ms` 用于核对连续小时，`history_sha256` 用于保留历史输入标识。服务拒绝未来尚未收盘的预测起点。

例如，用前面准备的一条**历史**上下文验证 HTTP 输出：

```powershell
$taskChronosInputs = Get-Content -LiteralPath output/chronos-bolt-tiny-20261014/inputs.json -Raw | ConvertFrom-Json
$taskChronosRequest = $taskChronosInputs.records[0] | ConvertTo-Json -Depth 8
Invoke-RestMethod -Uri http://127.0.0.1:18081/forecast -Method Post -ContentType 'application/json' -Body $taskChronosRequest
```

HTTP 返回单条 12 小时分位数预测和延迟；BUY/WAIT 比较、止盈止损与模拟执行由离线评估程序负责。

## 脱离 Python 环境运行

`nofx-chronos` 通过 Rust `ort` 动态加载 ONNX Runtime，预测时不会启动 Python。默认 DLL 路径位于转换环境内，但可以把 CPU ONNX Runtime 1.22.1 的 DLL 及其发行依赖准备到独立目录，并显式传入 `--runtime`：

```powershell
cargo run --bin nofx-chronos -- --model data/chronos/chronos-bolt-tiny.onnx --runtime D:/Models/onnxruntime-1.22.1/onnxruntime.dll --live-symbol BTCUSDT --output output/chronos-live.json
```

这样，已构建的 Rust 可执行文件只需要 ONNX 模型和 CPU Runtime DLL，转换用的 Python 环境不再是预测依赖。Rust `ort` 固定为 `2.0.0-rc.10`，对应 ONNX Runtime 1.22；不要随意用不同主接口版本的 Runtime DLL 替换。

## 验证命令

修改模型转换或 Rust 推理后，运行项目要求的检查，并在模型和 Runtime 已准备时执行官方输出对照测试：

```powershell
cargo fmt --check
cargo check --all-targets
cargo test --all-targets
cargo test --lib chronos::tests::onnx_matches_official_pytorch_reference -- --ignored --nocapture
```

本机空闲内存较小时，可对当前终端设置 `CARGO_BUILD_JOBS=1`、`CARGO_PROFILE_DEV_DEBUG=0`、`CARGO_PROFILE_TEST_DEBUG=0`，减少编译占用。构建失败、测试跳过和推理成功需要分别记录；模型能运行并不能替代收益与区间覆盖率验证。

本次实跑、滚动预测误差、交易比较限制和完整验证结果见 [2026-10-14 验证报告](D:/UGit/nofx-new/reports/chronos-cpu-evaluation-20261014.md)。
