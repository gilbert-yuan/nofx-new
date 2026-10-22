# 当前策略专项清理交付报告（2026-10-23）

**范围**：删除与当前策略 `altcoin-trend-breakout-live-v1`（山寨趋势突破 · EMA25/75）无关的策略定制代码，含其他策略的回测部分；保持当前策略的经济行为不变。

**基线**：提交 `d460dcb`（上一轮删除了 137 个文件，+7446/−44714 行，含旧策略模块与回测 bin）。
**本轮**：工作区 28 个文件，+52/−2518 行（另 7 个脚本与 `__pycache__` 已随 `d460dcb` 前后的删除清除）。

## 1. 本轮修复的编译错误（上一轮删除后的悬空引用）

| 位置 | 问题 | 处理 |
| --- | --- | --- |
| `rust/src/automation.rs` | 调用已删除的 `strategies::kline_features` / `match_feature_rules`（旧 ML 特征筛选入口） | 整块删除 `entry_filter` 特征筛选分支 |
| `rust/src/automation_guards.rs` | 同上，`entry_filter` 函数本体引用 `match_feature_rules` | 删除 `entry_filter`（读取 `analysis.backtestFeatureFilters` 与 `backtest/production-profiles.json` 的旧机制；线上配置无此键，行为不变） |
| `rust/src/paper.rs` | `refresh_internal` 引用已移除的 `strategy` 变量 | 只保留通用 `sync_entries(db, store, None)` 分支，删除随之无用的 `selected_ids` |
| `rust/src/indicator_history.rs` | 默认策略 ID 回落值仍是已删除的 `enhanced-trend-v1` | 改为回落 `strategies::ACTIVE_STRATEGY_ID` |

另清理两处 `skillContext`（旧 Yao/Martin 遗留，当前注册表 `marketContext` 为 `{}`，恒为 null）与死方法 `Automation::token_matches`。

## 2. 删除的死代码（`rust/src/strategies/indicators.rs`）

当前策略只用 `mean/ema/closes/true_ranges/atr/finite_candle`。删除 12 个无调用方函数及各自测试：

- `enhanced_macd`（enhanced-trend 策略）
- `skill_summary` / `pivots` / `skill_structure`（Yao/Martin 结构分析）
- `adx` / `supertrend`（regime/structure 策略）
- `macd` / `rsi` / `rsi_simple` / `atr_series` / `ema_first` / `last`

`strategies.rs` 的 `pub use indicators::{atr, ema, rsi}` 同步改为 `{atr, ema}`。保留函数逐字未动，新增 2 个边界测试。

## 3. 回测工具的旧 B（retest）残留精简

`nofx-altcoin-backtest` 的搜索网格原本接受但忽略 `retestBars` / `retestBandAtr`（旧 B 变体 `altcoin-trend-retest-v1` 的结构参数，仅为兼容历史候选哈希）：

- 代码：从 `parse_search_grid` 白名单移除这两个字段，测试改为断言拒绝；
- 配置：从 4 个研究配置（`altcoin-{best,refined}-{full,training}-*.json`）剥离同名字段。**候选用显式 ID（A-aadb2873715e / A-7191f22c929c）覆盖哈希，ID 与线上 `source_candidate` 溯源链不变；两字段本来就被引擎忽略，回测行为不变。**

搜索/恢复/成本压力（cost1/cost2 × training/full/holdout）机器本身是当前策略在用的参数检索工具，保留。

## 4. 删除的脚本与文档

**脚本（7）**：`compare_opt_groups.py`、`merge_90d.py`、`strength_filter_audit.py`（Martin Luk 专用）、`render_forecast_sweep_report.py`、`render_rolling_benchmark_report.py`（对应 bin 已删）、`summarize_backtests.py`（硬编码 martin 输出文件名，对当前回测产物无效）、`scripts/__pycache__/`。
保留：`collect-intraday-archive.ps1`（行情/资金费采集）、`deploy-runtime.sh`（默认目标更新为 `runtime-altcoin-20261023`）。

**文档（16）**：chronos、martin-luk、local-buy-model、monthly-campaign、10 个 ml-*、crypto-portfolio-strategy（多模型设计稿，P0 已判不通过）、`docs/tradingview/yao-coin-ambush-v1.pine`。
保留：`altcoin-perpetual-trend-20261022.md`、`free-market-indicators.md`、`indicator-backtest.md`（描述仍在用的 market_filters）、`superpowers/plans/`。

## 5. 保留范围（未动）

- 共享层：撮合/成本/仓位/风控（`simulator`、`paper`、`automation_guards` 的 sizing/screen/book_check、`ledger`、`market_filters`、`market_indicators`、`flow`、`spot`、`analytics`、`research`、`exchange`、`db`）。
- 数据归档（ML 命名但属采集组件，计划明确保留）：`ml_archive.rs`、`ml_dataset.rs`、`nofx-ml-collect`、`nofx-ml-archive`、`nofx-ml-archive-repair`。
- 运维工具：`nofx-server`、`nofx-diagnostics`、`nofx-orphan-audit`。
- 迁移对照 fixture：`oracle_tests.rs` + `backend_oracles.json`（AGENTS.md 要求的固定 JSON 对照）。
- 数据与历史：`data/`、`output/`、`reports/` 全部未动；账户记录、历史报告未清理。

## 6. 验证结果

| 项 | 结果 |
| --- | --- |
| `cargo fmt --check` | 通过 |
| `cargo check --all-targets` | 通过，0 警告 |
| `cargo test --all-targets` | **212 通过 / 0 失败**（4 个 ignored 需本地 PG 与服务端） |
| `npm run build`（Vue） | 通过（61 模块，dist hash `index-8o9xzAWs.js`） |
| 当前策略回放经济等价 | **通过**： incumbent 候选 A-7191f22c929c 同窗口（2026-10-01→10-14，holdout 10-09T16:00，cost1/cost2 × training/full/holdout 共 6 场景）复跑，`nofx-altcoin-verify` 全部 `max_absolute_delta = 0.0`；汇总净值逐位一致（train −1.883166798237923%、full −2.7001852301957285%）。证据：`output/cleanup-parity-20261023/`（report.json + parity.json） |
| 旧策略边界 | 注册表仅剩当前策略；`/api/strategies/martin-luk-pullback-v1`、`/api/automation/yao-coins` 等返回 404（集成测试断言）；`altcoin-trend-retest-v1` 回放被拒 |

**修复的陈旧测试**：`altcoin_live::tests::database_shaped_closed_candles_reach_the_live_strategy` 原断言 `emaSlow == 90`（旧 30/90 参数），改为当前注册表缺省 25/75/8/1/3 —— 该失败是上一轮切换参数后遗留，非本轮引入。

## 7. 注意事项

- **线上服务当前未运行**：PM2 守护进程未启动（3100 端口仅剩环境残留代理返回 502）。本轮按计划未重启、未替换 `data/ml/runtime-altcoin-20261023/bin/nofx-server.exe`（Oct 23 04:43，未动）。需要上线时用干净环境重启（清 `HTTP_PROXY` 等沙箱变量）。
- 所有删除均为 git 跟踪文件，可用 `git checkout d460dcb -- <path>` 恢复；本轮改动未创建提交。
- 候选 ID 说明：剥离 legacy 字段后，**不带显式 ID** 的新网格会得到不同派生哈希（如 A-1f9978a5018b），但既有配置的显式 ID 与报告中的溯源不受影响。
