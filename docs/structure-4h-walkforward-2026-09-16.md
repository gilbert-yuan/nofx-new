# structure-long-v1 / structure-short-v1：4h 结构策略优化记录

更新时间：2026-09-16  
结论：本轮没有找到同时满足“保留段净收益为正、回撤可控、训练段与保留段方向一致、跨时间块稳定”的可部署参数组合。搜索结果和失败候选均已保留，当前没有修改策略启用状态或把任何候选写入实盘配置。

## 数据与执行口径

- 数据：`data/backtest/bf365-*`，Binance USDT-M perpetual，1m 数据范围为 `2025-09-13T12:46:00Z` 至 `2026-09-13T12:46:00Z`，以 `data/backtest/bf365-1m/meta.json` 为准。
- 决策链：4h 方向 → 1h 位置 → 15m 计划 → 1m 执行。
- 默认成本：手续费 6 bps、滑点 5 bps、资金费率 3 bps / 8h；启用 liquidation、isolated margin、dynamic protection。
- 资金：初始资金 100U，默认自动保证金 5% 权益，最多 20 个活动订单；默认待成交 TTL 1440 分钟、止损冷却 60 分钟、普通冷却 30 分钟。
- 研究约束：`strictSkillData=false`；4h 结构策略不使用旧的衍生品/BTC 环境信号；随机种子为 `20260916`。
- 走步定义：每个 30 天块前 20 天只作训练诊断，最后 10 天是唯一计入 walk-forward 选择分数的保留段；6 个块覆盖约 180 天、100 个币种。

## 做过的参数覆盖

快速坐标筛选使用 20 个币种、30 天、训练 20 天，分组覆盖以下参数；对应的 trial JSON 保存在 `data/backtest/_campaign-*-20x30/`。

| 分组 | 覆盖内容 |
| --- | --- |
| runtime | `window4h/window1h/window15m/executionWindow`、最大持仓、自动保证金、保证金上限、挂单/冷却、手续费、滑点、资金费、liquidation/isolated/dynamic protection |
| filter | 多空方向分数、`entryQualityMin`、`extendedAtr`、`nearLevelAtr`、量能比、RSI 极值、高波动分位数 |
| entry/risk | `entryBufAtr`、`minRealRR`、止损缓冲/最小止损、最大持仓根数、单笔风险、日损失、极端波动阈值、杠杆和风险预算 |
| trailing | 移动触发、扩盈、最小空间、保本、L0/L1/L2 阶梯的 trail/lock/atR |
| exit | 智能退出、均线退出、最小持仓、分批 TP 开关、TP1/TP2 R 倍数、分批比例、TP1 后保本 |

联合候选在两个独立目录中运行，避免多空并行写同一个汇总文件：

- 多头：`data/backtest/_campaign-joint-wf100-long/optimization.json`
- 空头：`data/backtest/_campaign-joint-wf100-short/optimization.json`

## 结果

### 200 币种 × 90 天默认基线

| 策略 | 平仓数 | 净收益 | MDD | PF | 训练段 | 保留段 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| long | 23 | +1.8148U | 3.5800U | 1.186 | +1.9992U / 17 笔 | -0.1844U / 6 笔 |
| short | 17 | -2.4018U | 7.1126U | 0.742 | -4.5912U / 13 笔 | +2.1894U / 4 笔 |

默认基线的全样本净收益不能掩盖训练/保留段反转，因此不构成部署依据。文件位于 `data/backtest/_campaign-final-200x90/`。

### 联合筛选冠军与 100×30×6 块走步

| 策略 | 筛选冠军 | 筛选训练/保留 | 走步保留块净收益 | 总保留 | 最差块 | MDD | 正块 |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| long | `window4h=55`、`smartExitEnabled=true`、`riskPerTrade=0.005`、`entryBufAtr=0.1` | +0.1471U / +0.4117U | `+0.48/-1.62/-1.23/-0.01/-3.26/-3.54` | -9.1798U | -3.5390U | 3.6137U | 1/6 |
| short | `bearishScoreMin=60`、`riskPerTrade=0.005`、`useStrategyRisk=false` | +0.2351U / +0.3162U | `+0.36/-1.25/-0.73/-1.24/-0.68/+0.20` | -3.3275U | -1.2495U | 1.9649U | 2/6 |

筛选阶段的正收益没有跨时间块保留。多头走步共 154 笔保留段交易，空头 39 笔；这不是交易数不足导致的单一空结论，而是多个块连续出现负净收益。联合报告中的 `validation` 字段保存每块的训练、保留、回撤、胜率和原始 JSON 路径。

## 可复现命令

优化器脚本是现有的 Node.js 脚本 `scripts/_bt_4h_optimize.mjs`，支持 `BT_OPT_STRATEGIES` 只运行一个方向。下面是多头联合验证命令；空头命令只需替换策略、输出目录、基础参数和方向字段。

```powershell
$env:NODE_OPTIONS='--max-old-space-size=3072'
$env:BT_OPT_OUT='data/backtest/_campaign-joint-wf100-long'
$env:BT_OPT_STRATEGIES='structure-long-v1'
$env:BT_SEED='20260916'
$env:BT_OPT_SYMBOL_COUNT='20'
$env:BT_OPT_DAYS='30'
$env:BT_OPT_TRAIN_DAYS='20'
$env:BT_OPT_BASE_OVERRIDES='{"smartExitEnabled":true,"riskPerTrade":0.005}'
$env:BT_OPT_BASE_RUNTIME='{"window4h":55}'
$env:BT_OPT_FIELDS='window4h,window1h,window15m,executionWindow,bullishScoreMin,smartExitEnabled,smartExitBarLevel,partialTpEnabled,riskPerTrade,entryBufAtr,minRealRR'
$env:BT_OPT_MAX_TRIALS='32'
$env:BT_OPT_VALIDATE_TOP_K='4'
$env:BT_OPT_VALIDATE_DAYS='180'
$env:BT_OPT_VALIDATE_BLOCK_DAYS='30'
$env:BT_OPT_VALIDATE_HOLDOUT_DAYS='10'
$env:BT_OPT_VALIDATE_BLOCKS='6'
$env:BT_OPT_VALIDATE_SYMBOL_COUNT='100'
$env:BT_OPT_VALIDATE_MIN_TRADES='12'
$env:BT_OPT_VALIDATE_MIN_POSITIVE_BLOCKS='3'
$env:BT_OPT_MIN_TRADES='3'
$env:BT_OPT_MIN_SEGMENT_TRADES='1'
node scripts/_bt_4h_optimize.mjs
```

空头联合验证的关键覆盖为：

```powershell
$env:BT_OPT_OUT='data/backtest/_campaign-joint-wf100-short'
$env:BT_OPT_STRATEGIES='structure-short-v1'
$env:BT_OPT_BASE_OVERRIDES='{"bearishScoreMin":60,"riskPerTrade":0.005}'
$env:BT_OPT_BASE_RUNTIME='{}'
$env:BT_OPT_FIELDS='window4h,window1h,window15m,executionWindow,bearishScoreMin,smartExitEnabled,smartExitBarLevel,partialTpEnabled,useStrategyRisk,riskPerTrade,entryBufAtr,minRealRR'
node scripts/_bt_4h_optimize.mjs
```

默认 200×90 对照使用 `scripts/_bt_4h_portfolio.mjs`，设置 `BT_STRATEGY`、`BT_SEED=20260916`、`BT_SYMBOL_COUNT=200`、`BT_DAYS=90`、`BT_TRAIN_DAYS=60`、`BT_USE_STRATEGY_RISK=1`，窗口为 `20/30/30/80`，并分别输出到 `data/backtest/_campaign-final-200x90/`。

200×90 的单块候选重放会达到数 GB 的 1m 对象峰值；因此候选稳健性以已经成功完成的 100×30×6 走步为准。失败的 200×90 候选进程只作为资源限制记录，不计入收益结论。

## 修复与验证

- 正式结构信号现在返回数值 `score` 和 `entryQuality`，组合回测的候选排序和审计不再把所有信号当成 0 分。
- `extendedAtr` 现在同时控制 `doNotChaseAbove/Below`，不再被硬编码的 2 ATR 覆盖。
- 限价单成交当根采用保护优先：不从成交前未知路径制造分批止盈；任何同根保护价触发也不会先记 TP1/TP2 再止损。
- 走步评分只使用保留段；训练段仍写入报告用于诊断。优化器支持按策略隔离运行，并修正走步块文件名的补零。
- `npm test`：202 tests，191 pass，11 skip，0 fail。
- `node scripts/_test_partial_tp.mjs`：全部通过。
- `node --check scripts/_bt_4h_optimize.mjs`、`node --check server/tradingSimulator.js`、`git diff --check`：通过。
