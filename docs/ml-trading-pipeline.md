# Chronos → LightGBM → 风险管理

行情工作台的「AI 信号与风控」展示完整模型链路。选择币种，点击「分析当前币种」，读取最新闭合的 256 根 **当前模型周期** K 线（现役 Demo 仍是 1h；15m 研究候选为 15m）、辅助指标及 BTC/ETH 背景，返回未来 12 步预测、SELL/HOLD/BUY 分类和保护计划。1h 模型 12 步为 12 小时；15m 模型 12 步为 3 小时。该按钮只读取分析结果；自动执行由 Rust 自动任务独立运行。图表日期为历史窗口时禁用实时分析。现役 Demo 在 15m 历史验收和前向验证完成前保持 1h 模型。

```mermaid
flowchart LR
  A[闭合小时行情及辅助指标] --> B[Chronos-Bolt-Tiny 价格分位数]
  B --> C[LightGBM 分类概率和门槛]
  C --> D[共享 Rust 账户风控]
  D --> E[Binance Demo 入场与保护单]
  E --> F[共享持仓复核与出场引擎]
```

## 运行模式

新配置默认 `ml.mode:"research"`，只读预测返回 HOLD 执行动作。设置 `ml.mode:"demo"`、启用 `chronos-lightgbm-v1` 策略并启动全局自动任务后，运行 Binance Demo 模型交易。模型策略不路由到实盘。

Demo 还要求现有 Binance Demo 环境、`trader.enabled:true`、`trader.dryRun:false`、`trader.allowEntryOrders:true`、`trader.syncPaperOrdersToDemo:true`、`trader.syncPaperOrdersToLive:false` 和 `marketSync.dataOnly:false`。缺少条件时阻止启动或开仓。账户同步过期、当前持仓对账未完成、资金不足、暂停开仓或已有同币种挂单/仓位均阻止新增订单。

扫描覆盖训练币种、当前可交易合约与配置币种的交集，沿用 24h 成交额门槛，按流动性排序后轮转。`ml.scanBatchSize` 默认每轮 20 个，范围 1–50；每轮新增订单沿用 `trader.maxNewEntriesPerCycle`。同一币种每小时的信号只创建一次，消费记录与订单在同一账户事务中保存。HOLD 不创建新仓，也不强制平掉已有仓位。

自动下单、成交、费用、保护单与复核复用现有 Rust 引擎。Demo 模式的持仓复核仅处理模型策略订单，既有其他策略订单保留。账户同步读取整个账户，使资金占用和同币种冲突检查覆盖其他策略及外部持仓。已平仓历史缺少部分成交明细时展示会计提示；能否开仓始终采用共享资金池的当前 `syncReady`、`canOpen` 与占用检查，当前持仓对账错误仍会拦截。

独立预测器保持只读，返回 `advisory_only:true`、`orders_enabled:false`。主 API 校验该响应后，增加 Demo 账户风控与运行状态，不修改训练 manifest 或评估报告。本轮样本外回放亏损，历史评估仍是 `research_only`，详见[最终评估](../reports/ml-global-monthly-evaluation-20261015.md)。Chronos 使用预测校准，原始权重未更新。多周期不能并入 Chronos 的 256 点输入；从已收盘 1h 聚合 4h 作为 LightGBM 对照，见[多周期特征](ml-multiframe.md)。

## 风险计划

计划复用 `ml_replay::normalize_signal`、`research::normalize_plan`、`ml_replay::position_size` 及共享 `RiskLedger`：

- 闭合行情的 14 周期 ATR；参考收盘价 ±0.5 ATR 入场区间，止损 2 ATR，止盈 5 ATR；无效关系或成本后盈亏比不足时拒绝计划。
- 下一根已收盘 K 线入场与最长 11 根持有期限，覆盖 12 步预测内的生产入场延迟（1h 模型约 11 小时，15m 模型约 2.75 小时）。分批止盈与移动止损沿用共享规则；短持仓不再套用增强趋势的 0 根均线智能退出。增强趋势策略本身未改。
- Demo 仓位使用共享资金池的当前权益：单笔止损预算最多 1%，名义仓位最多 50 USDT 且不超过权益的 20%，杠杆固定 1 倍；包含共享费用、滑点和资金成本。
- 共享模型账本在日内亏损 3% 时暂停当日新增订单，最大回撤 10% 时持续拦截；状态持久化，重启不清除。同账户外部盈亏也影响权益检查。
- 创建订单和首次发送入场单前分别复核账户与风险。交易所最小成交额、步长、盘口、配置保证金及系统其他开仓限制继续生效，不为成交放大预算。

接口区分 `model_action`、`risk_adjusted_action` 与 `execution_action`。模型方向为 BUY/SELL 时，执行条件未满足仍返回 HOLD。`entry_permitted:true` 表示此刻通过模型账户检查；实际执行还需通过共享系统的盘口、交易所规则及最终事务检查。

## 接口与运行

主 API `POST /api/ml/pipeline` 只接受币种，不接受资金、方向、风险参数或外部行情覆盖。`/api/ml/signal` 返回相同链路字段。独立预测器对应 `POST /pipeline`，保持只读。

| 字段 | 内容 |
| --- | --- |
| `operating_mode` / `research_mode` | 主 API 运行模式，`demo_auto` 或 `research` |
| `execution_context` | Demo 环境、任务状态、账户检查和阻止原因 |
| `model_evaluation_status` | 原模型历史评估状态 |
| `forecast` / `raw_forecast` | 校准与原始 12 小时价格分位数 |
| `probabilities` / `action` | LightGBM 分类概率和门槛信号 |
| `risk_management.plan` | 入场范围、止盈止损、持有期限和共享出场规则 |
| `risk_management.position_size` | 当前模式的仓位和成本后预算；账户未就绪时为空 |
| `risk_management.accounting_notice` | 历史成交完整性提示 |
| `risk_management.blocked_reasons` | 开仓限制与未完成的检查 |
| `pipeline.execution_action` | 当前允许执行的方向，未通过检查时为 HOLD |

响应保留行情时点、目标时间、过期状态和模型指纹。公共行情失败返回实际错误，不回退冻结数据冒充实时结果。工作台清除切币、切日期或请求失败前的旧结果，定时刷新模式并标记跨小时过期。

使用已有模型，两个终端分别运行：

```powershell
cargo build --locked --bin nofx-server --bin nofx-ml-monthly-predict
npm run build

# 终端 1：默认实时公共行情；--data-dir 只用于冻结归档审查
.\target\debug\nofx-ml-monthly-predict.exe --model-dir output/ml-monthly-20261014 --serve --port 18084

# 终端 2：先停止任务，核对配置与账户后通过 API 启动
$env:NOFX_AUTOSTART='false'
$env:NOFX_MONTHLY_ML_PORT='18084'
.\target\debug\nofx-server.exe --root D:\UGit\nofx-new --host 127.0.0.1 --port 3100
```

在已授权的 Demo 环境保存配置和策略开关后：

```powershell
Invoke-RestMethod http://127.0.0.1:3100/api/paper/exchange-refresh -Method Post -ContentType application/json -Body '{}'
Invoke-RestMethod http://127.0.0.1:3100/api/automation/start -Method Post -ContentType application/json -Body '{}'
Invoke-RestMethod http://127.0.0.1:3100/api/automation/status
Invoke-RestMethod http://127.0.0.1:3100/api/ml/health
Invoke-RestMethod http://127.0.0.1:3100/api/ml/pipeline -Method Post -ContentType application/json -Body '{"symbol":"ETHUSDT"}'

# 停止自动任务；已有交易所订单和保护单仍按账户实际状态处理
Invoke-RestMethod http://127.0.0.1:3100/api/automation/stop -Method Post -ContentType application/json -Body '{}'
```

启动前核对路径与 PID，避免重复占用端口。Windows 更新运行中的二进制使用独立运行副本。`created` 统计本地记录，`submitted` 只统计已确认发送到 Demo 的订单，不能混同成交。

## 验证

Rust 测试覆盖多空保护计划的共享引擎执行、仓位上限、HOLD、过期预测、非法参数、Demo 限定、账户同步、同币种占用、跨日亏损/回撤持久化，以及订单去重与保护规则覆盖拦截。网关继续严格校验只读预测器的执行标志。