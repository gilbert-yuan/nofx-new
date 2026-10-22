# Altcoin Parameter Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本轮使用当前会话已有的原生多代理工具直接执行用户已授权的参数搜索，不依赖额外插件，不增加计划审批、不提交工作区已有修改。

**Goal:** 在事先声明的最多 186 组参数中，找出固定风险下全期净收益最高的一组，同时独立报告仅以前段选参的复验表现。

**Architecture:** 策略模块提供参数校验和因果批量指标缓存，单边界分析与批量分析共用规则。回测入口继续使用共享 paper/simulator 风险、成交和成本模型；候选只改变结构参数，不另写快速盈亏模拟。

**Tech Stack:** Rust 1.99.0、serde_json、现有 Cargo 工程；不新增 Python/Node 回测工具。

**Spec:** [既有策略定义](../../altcoin-perpetual-trend-20261022.md)及本文件的搜索范围。

## Global Constraints

- 资金 10,000 USDT，风险 0.3%，杠杆 1，最多 3 仓、同向最多 2 仓；上市和成交额规则及成本不变。
- 数据及正式全期固定为 2026-06-25 00:00 至 2026-10-01 00:00 UTC；前段终点/后段起点为 2026-08-29 08:00 UTC。
- ATR14 固定。基础空间为 A/B × EMA (10,40)/(20,60)/(30,90) × channel 10/20/40 × stop 1.5/2/2.5 ATR × trail 2/3/4 ATR，共 162 组。
- B 基础回踩为 3 根、0.25 ATR；只按前段净收益选出 B 前 3 组，再扩展 retest 1/3/5 × band 0.1/0.25/0.5，去重最多增加 24 组。
- 净收益排名；并列按较低回撤，再按稳定参数键排序。不暗中删除少交易或亏损候选。
- 全期冠军为事后描述性冠军；前段冠军仅由前段决定。后段已经查看，不能宣称未知验证。
- researchOnly 保留，原报告及原档案不覆盖，所有候选、失败和阶段筛选均落盘。

## Review Focus

1. 预计算是否读到未来：逐前缀/截断与追加未来数据的信号及复核必须一致。
2. 历史缺口是否改变已发生信号：每段按旧 market_at 的连续段起点重播种。
3. 参数是否在旧仓退出时漂移：入场计划冻结完整结构参数，review 读冻结值。
4. 训练快照是否等价独立截断：同数据与币池下，用共享结清逻辑对照独立训练回放。
5. 性能修改是否偷换执行：旧 A/B 八场景的订单、资金费、净额和权益须在 1e-6 内复现。

---

### Task 1: 参数化共享策略和因果缓存

**Files:** Modify `rust/src/strategies/altcoin_breakout.rs`、`rust/src/strategies.rs`；测试放在模块内。

**Interfaces:** `PreparedSeries::new(retest: bool, candles: &[Value], params: &Value) -> Result<Self, String>`；`analyze_at(&self, symbol: &str, closed_len: usize) -> Value`；`review_at(&self, order: &Value, closed_len: usize) -> Value`。

- [x] 添加参数越界、默认规则兼容、冻结参数、逐前缀等价和未来数据不影响过去的回归测试。
- [x] 实现 emaFast/emaSlow/channelPeriod/stopAtr/trailAtr/retestBars/retestBandAtr 的校验和计划冻结；默认值保持原规则。
- [x] 实现一次预计算与按闭合长度取值，共用单次分析规则，不增加另一套策略实现。
- [x] 由根线程运行模块测试并检查旧基线等价。

### Task 2: 有限搜索和共享回放

**Files:** Modify `rust/src/bin/nofx-altcoin-backtest.rs`、`rust/src/paper.rs`；测试在对应 Rust 模块内。

**Interfaces:** `--optimize` 启动预设空间；`--search-grid` 接收固定候选清单；`--search-limit` 仅供冒烟，输出明确记录已执行范围。继续调用 `run_portfolio`、`paper::submit_paper_order`、`paper::advance_paper_order` 和 `simulator::close_order`。

- [x] 去除账户汇总的订单深复制，保留全部汇总算式；批量策略输入避免完整历史重复复制。
- [x] 增加训练终点快照，使用与期末相同的共享结清逻辑；以独立截断回放作等价测试。
- [x] 保存事前基础候选、第二阶段前段 Top3、所有尝试/失败和训练/全期摘要。
- [x] 分别选择全期冠军与前段冠军；对两者及原基线补跑双倍成本和后段独立账户，并保留完整账本。

### Task 3: 实跑、验证和结果归档

**Files:** Create `reports/altcoin-parameter-search-20261022.md`、最终参数 JSON；运行产物使用新的 output 目录。

- [x] 执行 `cargo fmt --check`、`cargo check --all-targets`、`cargo test --all-targets`，记录日志和源文件摘要。
- [x] 冒烟验证批量默认参数与上轮基线逐笔/权益一致，确认每候选成本后再运行完整有限搜索。
- [x] 运行最多 186 组并保留全部结果；按预定规则生成两份排名，不根据收益修改空间。
- [x] 独立核对冠军账本、仓位风险、集中度、成本压力和后段表现；写明最高仅限本轮已搜索空间。
- [x] 保存可复现参数、命令和报告；保持研究模式，不自动启用交易。
