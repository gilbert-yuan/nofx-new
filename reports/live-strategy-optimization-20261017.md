# 本地启用策略的盈利优化：诊断与修复记录

首次诊断：2026-10-17 10:10（UTC+8）
修复实施：2026-10-17 10:18 – 11:02
数据来源：运行中 `nofx-server` 的实时账户快照 + PM2 运行日志，全部为可复核的实测值。

---

## 一、结论

当前唯一开启的 `chronos-lightgbm-v1` **没有正边际证据**，但本轮定位到的亏损放大器主要不在模型，而在**执行与账本**。已修复 4 项并上线验证，账户可用资金从 -12.59 USDT 恢复到 +569.82 USDT。

**仍有一个需要业务决策的阻塞**：交易所侧 102 个持仓在本地无对应订单，占用 87% 权益，导致策略长期无法开新仓（见第五节）。

---

## 二、事实更正（对上一版诊断的修订）

上一版报告有两处推断经复核后不成立，在此更正：

| 原结论 | 复核结果 | 证据 |
| --- | --- | --- |
| `manual` 14 笔是系统强制平仓、开平同根 | **错**。`manual` 全部来自 `source=binance-demo` 的外部同步记录，`reason` 在 `paper.rs:324` 被硬编码为 `"manual"`；`heldBars=0` 只是外部记录没有该字段 | 172 笔 manual 的 source 全部是 binance-demo，paper 来源从未出现 manual |
| `maxPositionsToReview=10` 导致每轮只复核 10 个仓位 | **错**。该配置项在代码中**从未被读取**，是死配置 | 全仓 grep 仅命中 `store.rs` 默认值 |

真正的对账问题比原判断更严重，见第五节。

---

## 三、已修复并上线（4 项）

### 1. ML 订单被通用均线智能退出接管（最高价值）

**现象**：91 笔 ML 已平仓单里 51 笔（56%）由 `smart_exit_ma` 出场，中位持仓 1 根 1h，净 -24.62 USDT。

**根因**：`ml_horizon_exit_rules()` 的修复代码写于 10-17 02:15，而运行中的二进制编译于 02:00/02:01，**修复从未部署**；同时预测器跑的是 `nofx-ml-monthly-predict-compat.exe`（10-15 编译），无法用当前源码重建，它返回的 plan 仍带 `smartExit.enabled=true`。

**修复**：在 `ml_execution::signal()` 的执行边界强制覆盖 `exitRules = ml_horizon_exit_rules()`，不依赖上游返回什么。

```rust
if let Some(plan) = signal["plan"].as_object_mut() {
    plan.insert("exitRules".into(), crate::strategies::ml_horizon_exit_rules());
}
```

**验收**：新增测试 `stale_predictor_exit_rules_are_replaced_at_the_execution_boundary` —— 构造带 `smartExit=true` 的上游计划，断言输出为 `enabled=false`、`barLevelEnabled=false`，且分批止盈仍保留。

### 2. 账户写锁风暴（稳定性）

**现象**：日志每 1–2 分钟出现 `账户更新排队超时`，导致 `positionReview`、账户同步被反复推迟，订单卡在待对账。

**根因**：`paper::refresh_internal` 对每个订单单独调用一次 `mutate_account_light`，而该函数每次都要**读全账户 + diff 全表**（`simulated_order_extensions` 单次返回 78,436 行，耗时 1–2 秒）。112 个持仓 = 112 次串行全量写，10 秒写门必然打满。

**修复**：循环内只做网络与 K 线计算，结果收集后**一次性写入**。

**验收**：上线后连续运行 5 分钟，`排队超时` 出现 **0 次**（修复前每 1–2 分钟一次）；同时 `markPrice`/`unrealized` 持续更新，证明批量写没有破坏订单推进。

### 3. 资金容量缓冲

**现象**：112 个仓位把保证金占满，`available` 变成负数，系统进入"永远无法开仓"状态。

**根因**：`maxTotalNotionalPct=1.25` 也是**死配置**，代码未使用；ML 路径唯一的约束是 `canOpen = equity > committed`，等于"开到满为止"。

**修复**：`ensure_capacity()` —— 持仓占用超过权益 `NOFX_ML_MAX_COMMITTED_PCT`（默认 80%）时拒绝新开仓，保留费用、资金费与不利波动的余量。

**验收**：测试 `capacity_buffer_blocks_entries_before_margin_is_exhausted`（700/1000 通过、800/1000 通过、801/1000 拒绝、equity=0 拒绝）。

### 4. 幽灵订单占用保证金

**现象**：本地 18 个"持仓"订单，`exchange.status` 全部是 `not_submitted`/`rejected`/`canceled`，**交易所侧从未成交**，却一直占用保证金。

**根因**：提交失败后订单被"保留等待对账"，但没有超时放弃机制，永久占用。

**修复**：`abandon_stale_entry()` —— 交易所未成交（`executedQty=0`）且超过 `NOFX_ENTRY_SUBMIT_TTL_MIN`（默认 120 分钟）的订单标记为 `expired`，释放占用。

**验收**：本地 active 订单 18 → 6；`committed` 5413.30 → 4832.86；`available` **-12.59 → +569.82**；`canOpen` false → true。

> 实施中踩到一个坑：首版写 `status:"rejected"` 触发了 DB 约束 `simulated_orders_status_check`，导致 `positionReview` 每 10 秒失败一次。改为 `expired` 后恢复。

---

## 四、当前账户状态（修复后实测）

| 项目 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 持仓数 | 112 | 103 |
| 已占用保证金 | 5,413.30 | 4,832.86 |
| 权益 | 5,398.93 | 5,402.68 |
| 可用 | **-12.59** | **+569.82** |
| canOpen | false | true |
| 账户写锁超时 | 每 1–2 分钟 | 0（5 分钟内） |
| 自动化任务失败 | 每 10 秒 | 0（新进程） |

### 当前策略的历史表现（91 笔，仅作方向性参考）

| 指标 | 数值 |
| --- | --- |
| 净收益 | -60.05 USDT（名义 4,529） |
| 单位净收益 | -132.6 bps/笔（往返成本约 12 bps） |
| 毛收益 | -121 bps —— 零手续费也照样亏 |
| 胜率 / 中位持仓 | 27.5% / 1 根 1h |

---

## 五、新发现：102 个"无主持仓"占 87% 权益（需要决策）

交易所 Demo 账户有 **102 个真实持仓**，本地 `orders` 里**没有任何对应订单**。

| 归因 | 数量 | 说明 |
| --- | ---: | --- |
| 曾在本地平仓过、但持仓仍在交易所 | 80 | 本地记录与交易所状态不一致 |
| 从未出现在本地任何记录 | 22 | 完全无来源（如 PENDLE、POL、TAO、BCH、CAKE） |

- 占用保证金 **4,714.50 USDT = 权益的 87%**
- 持有时间最长 **6.8 天**
- 浮盈 52 个 / 浮亏 50 个，合计 **+25.74 USDT**，中位数 +0.02
- 它们没有本地计划，因此**不会按 11 根 timeout 出场，也不会走 ATR 止损**，只能靠交易所侧保护单

**后果**：加上 80% 容量缓冲后，`committed/equity = 89.4% > 80%`，策略会持续被自己的缓冲拦住，**无法开新仓**。

这是纯业务决策，我不擅自平仓。三个选项：

| 选项 | 操作 | 影响 |
| --- | --- | --- |
| A. 归因后清理 | 逐笔核对来源，确认无策略归属的平掉 | 释放 4,700 USDT，策略恢复交易；平仓不可逆 |
| B. 划入独立账本 | 把这批仓位排除出 ML 资金池，单独管理 | 策略恢复交易，但两套账本并存 |
| C. 保持现状 | 不动 | 策略长期停摆，只能等这批仓位自然了结 |

建议：先做 A 的**只读归因**（把 102 个 symbol 与历史订单逐一匹配，输出可审计清单），再决定平哪些。不建议直接全平。

---

## 六、尚未处理的优化点（按优先级）

| 优先级 | 问题 | 证据 | 动作 |
| --- | --- | --- | --- |
| P0 | 102 个无主持仓 | 占 87% 权益 | 等决策（见上） |
| P1 | 训练出的净收益门槛 `min_edge` 未进执行链 | 只被离线训练 bin 引用；实盘门槛是 `probability_threshold=0.45` | 接入 policy，接受长期 HOLD |
| P1 | 币池流动性门槛过低 | 最差 5 笔全是新上线小币，单笔亏 4–7U ≈ 名义 8–13%；`NOFX_MIN_QUOTE_VOL_24H` 默认仅 500 万 | 提高门槛 + 上市天数过滤 |
| P2 | 单笔名义 50U 与 5,400U 权益不匹配 | `ml_replay` 默认 `max_notional_usdt=50`，为 1,000U 参考资金设计 | 待边际转正后再调，**现在放大只会加速亏损** |
| P2 | 读账户单次返回 78,436 行扩展数据 | 慢查询 1–2 秒 | 批量写已缓解；后续可加索引或按需加载 |
| P3 | `maxPositionsToReview`、`maxTotalNotionalPct` 是死配置 | 代码从未读取 | 删除或接线，避免误以为已生效 |
| P3 | `accountingComplete=false`（129 条不完整） | 部分平仓 `missingExitQty>0` | 依赖第五节归因结果 |

---

## 七、验收命令

```bash
cargo fmt --check
cargo check --all-targets --locked
cargo test --lib --locked          # 273 passed, 0 failed, 9 ignored
```

已部署二进制：`data/ml/runtime-20261017-1036/bin/nofx-server.exe`（PM2 守护，`ecosystem.nofx-runtime.json`）
回滚副本：`data/ml/runtime-20261017/bin/nofx-server.exe.bak-20261017`

---

## 八、局限

- 当前策略样本仅 91 笔、1.6 天，所有归因只作方向性证据，不足以定参数。
- 出场规则改动后，**路径会变**：`smart_exit_ma` 消失不等于盈利，需用新数据前向验证。
- 容量缓冲 80% 会让策略在当前占用下停止开仓，这是刻意选择（先止血），不是故障。
- 102 个无主持仓的浮盈 +25.74 不代表真实可兑现收益，平仓时的滑点未计入。
