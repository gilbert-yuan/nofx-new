# 本机最小模型买入审核实验

本机使用 Qwen2.5-0.5B-Instruct Q4_K_M，通过 llama.cpp 的 CPU 服务审核已有做多计划，输出 `BUY` 或 `WAIT`。模型只审核固定计划，不生成订单或修改交易配置。

## 已安装的模型

- CPU：Intel i5-10400，启动时使用 4 个线程；无独立显卡。
- 推理服务：llama.cpp b11429（0.6.0-dev），仅监听 `127.0.0.1:18080`，上下文 4096，单请求运行。
- 模型：`data/local-model/models/qwen2.5-0.5b-instruct-q4_k_m.gguf`，491,400,032 字节。
- 模型 SHA-256：`74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`。
- CPU 运行包 SHA-256：`1283323272b04cd07905816a597a0da810918102de958f4ff6f7bbaa70ed2efe`。

官方资源：[Qwen 模型](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF)、[llama.cpp CPU 运行包](https://github.com/ggml-org/llama.cpp/releases/tag/b11429)。本次模型从 [Qwen 的 ModelScope 仓库](https://modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct-GGUF) 下载，与上述 Hugging Face 官方文件的 SHA-256 一致。文件放在被 Git 忽略的 `data/`，不会提交权重。

## 运行

从项目根目录执行：

```powershell
.\scripts\start-local-model.ps1
cargo build --bin nofx-local-model-eval
.\target\debug\nofx-local-model-eval.exe --samples 24 --output output/local-model-eval-20261014.json
```

检查格式约束与简单指令是否影响判断，可运行独立诊断；它不读取历史或模拟交易：

```powershell
.\target\debug\nofx-local-model-eval.exe --sanity-only --output output/local-model-sanity-20261014.json
```

已存在的报告不会覆盖，重复实验请指定新的输出文件名。启动脚本会复用已运行的同名模型。服务地址为 `http://127.0.0.1:18080/v1`，模型 ID 为 `qwen2.5-0.5b-instruct`，日志位于 `data/local-model/logs/`。

停止本次启动的模型进程时，先核对 PID 和可执行文件：

```powershell
$modelServerId = [int](Get-Content data/local-model/server.pid)
Get-Process -Id $modelServerId | Select-Object Id,Path
# 确认 Path 是本项目 data/local-model/runtime/b11429/llama-server.exe 后执行：
Stop-Process -Id $modelServerId
```

## 实验口径

默认读取冻结的 `output/profit-improvement-20261011/data/BTCUSDT.json`，在既有训练、验证时间范围内均匀选择 24 个满足本地均线规则和规范化风控的 15 分钟做多信号。每个信号仅由此前 80 根已收盘 K 线生成。模型接收当时价格、均线、ATR、固定保护计划和扣费后的盈亏比，不接收未来 K 线或交易结果。

候选与模拟成交结果均截断在 `1790944920000`（2026-10-02 20:42，UTC+08）之前，保护该冻结研究的最终 20% 区间。自定义数据集仍使用同一时间截止值；它不是所有数据集自动计算的 20% 边界。

所有候选都使用 `research::prepare_market`、`analytics::local_analysis`、`research::normalize_plan` 和共享 `paper`/`simulator`。基线与模型审核后使用相同计划、100 USDT 保证金、1 倍杠杆；单边费用 6 bps、滑点 5 bps、资金费 3 bps/8h。模拟按时间顺序推进，入场使用后续 K 线，保留挂单过期及动态保护规则。

模型请求固定 `temperature=0`、`seed=42`、最多 160 个输出 token，并以 JSON schema 约束格式。服务错误、解析错误和独立风控失败都降级为 `WAIT`。报告分别保存原始模型判断与风控后的有效判断，避免将程序拦截算作模型能力。

另有 8 个应当拒绝的合成负例、2 个可讨论的正例，以及 3 个历史输入各两次重复。正例允许模型选择观望；负例包括无效止损/止盈、过期行情、不可交易信号、低盈亏比、缺少趋势、K 线不足和极端波动。

这次实验是规则理解与买入审核的初步验证。历史候选已通过提示词中的主要条件，全部放行说明没有增加筛选；全部拒绝也不证明预测能力。逐笔交易独立模拟，可能存在时间重叠，因此净额合计不是共享资金池组合收益。已用于研发的数据和少量样本不能证明未来盈利。

执行检查：`cargo fmt --check`、`cargo check --all-targets`、`cargo test --all-targets`。新工具的测试覆盖无效输出、独立拦截、未来价格不影响模型输入、截止时间保护、后续入场及共享成本。
