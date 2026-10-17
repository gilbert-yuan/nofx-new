# 前向证据归因修正：+176bps 里有多少是策略赚的

日期：2026-10-17 17:20（UTC+8）
数据源：运行中 `nofx-server` 的 `/api/paper/account` 快照（781→839 笔已平仓）、PM2 日志、`output/_close_run.log`。
本次只读核对 + 一处代码修正（门槛归因），未改策略参数、未平仓、未放大规模。

---

## 一、结论

1. 14:50 报告里的「前向窗口 52 笔、胜率 53.3%、净期望 +176bps」**不成立**。
   其中 **48 笔不是策略自己的出场**：41 笔是孤儿仓清理产生的外部平仓记录，6 笔 `smart_exit_ma` + 1 笔 `timeout`
   是仓位在交易所被清掉后、账本用旧 `reason` 补记的（没有平仓单）。
2. 剔除后真实前向样本 **4 笔，全部是 11 根 `timeout`**，净 +3.81 USDT / **+190bps**，胜率 4/4。
   样本远低于 30 笔，门槛应判定为 **probe**，而不是 `open`。
3. 这不是记账美观问题：门槛在 `ready_to_scale`（前向 ≥200 笔且 ≥+25bps）后会把单笔上限从 50U 放开到无限。
   按 52 笔假样本推进，约两天就会“证明”策略有边际并放大仓位。**先修归因，再谈放大。**

---

## 二、证据：52 笔前向记录的构成

窗口起点 `2026-10-17T05:12Z`（11 根出场规则上线时刻）。按 `reason` 与交易所平仓单拆分：

| 类别 | 笔数 | 净收益 USDT | 名义 USDT | 判定 |
| --- | ---: | ---: | ---: | --- |
| `manual`（`source=binance-demo`，外部同步记录） | 41 | **+42.10** | 2,050 | 非策略，排除 |
| `smart_exit_ma`，无任何平仓单 | 6 | -1.47 | 300 | 仓位被外部清掉，排除 |
| `timeout`，无平仓单（ATOMUSDT） | 1 | +0.67 | 50 | 同上，排除 |
| `timeout`，有 `nofx_exit_*` 平仓单 | **4** | **+3.81** | 200 | **真实策略出场** |
| 合计 | 52 | +45.10 | 2,600 | 真实 +3.81，其余 +41.30 为外部 |

真实 4 笔：

| 币种 | 出场 | 持仓根数 | 净收益 |
| --- | --- | ---: | ---: |
| LABUSDT | timeout | 11 | +2.66 |
| SENTUSDT | timeout | 11 | +0.13 |
| ZENUSDT | timeout | 11 | +0.18 |
| ETHFIUSDT | timeout | 11 | +0.84 |

对照 `output/_close_run.log`：`ZILUSDT / POLUSDT / FARTCOINUSDT / USUSDT / TRUMPUSDT / NEARUSDT / ATOMUSDT`
正是 14:08–14:32 那批 reduceOnly 清理的标的。清理成交后，本地仓位在下一轮复核时被置为 `closed`，
但 `reason` 保留了上一次模拟器写入的值（`smart_exit_ma` 或 `timeout`），`net` 用交易所 metric 回填。
所以 **`reason` 不能单独作为出场归因**。

---

## 三、根因与修正

### 根因

`paper::fused_orders` 在交易所仓位消失（`remainingQty=0`）时，把本地订单直接置 `closed`，
沿用订单上已有的 `reason` 与 `heldBars`。外部平仓（手工、清孤儿、强平）与系统出场在账本上长得一样。

### 修正（`rust/src/ml_edge.rs`）

新增 `strategy_exit()`：只有能证明是系统执行的出场才计入边际。

- `reason = manual` → 排除（外部同步）。
- `reason = stop_loss` → 保留（交易所保护单是策略自己的风控，允许没有 closeOrder）。
- 其余 `timeout / trailing_stop / smart_exit_ma / partial_take_profit` → **必须有 filled close order**；
  没有就排除（外部平掉或记录不可核验，宁可少算）。
- 无 `exchange` 块的纯 paper 记录 → 保留（不可能来自外部同步）。

`forward()` 新增两个可审计字段：`excluded_external`（被排除笔数）、`excluded_net_usdt`（被排除的净盈亏）。
门槛 `gate()` 与 `margin_cap()` 自动继承同一口径。

### 测试

- `positions_flattened_outside_the_strategy_do_not_count_as_edge`：
  30 笔“timeout 但无平仓单”必须被排除，门槛保持 `probe`；`manual` 即使有成交也排除；无平仓单的 `stop_loss` 保留。
- `exits_this_system_executed_still_build_the_forward_sample`：
  30 笔带 `nofx_exit` 成交的 timeout 正常计入并判 `open`。
- 原有 6 个 `ml_edge` 测试不变。

验证：`cargo fmt --check`、`cargo check --all-targets --locked`、`cargo test --lib --locked`
（**297 passed / 0 failed / 9 ignored**）。

---

## 四、修正后的诚实读数（部署后由 API 复核）

| 指标 | 修正前口径 | 修正后口径 |
| --- | ---: | ---: |
| 前向笔数 | 52 | **4** |
| 胜率 | 53.3% | 100%（4/4） |
| 净期望 | +176bps | **+190bps** |
| 被排除 | 0 | **48 笔 / +41.30U** |
| 门槛判定 | `open` | **`probe`** |

全历史（同口径，含旧规则）真实样本 43 笔：**-18.73U / -88bps / 胜率 30%**。
这说明前向 4 笔的正收益还不能归因于“策略变好了”，只能算方向性提示。

当前账户（17:00 左右）：权益 **5,413.59**、可用 **3,975.79**、占用 **1,437.80**（26.6%）、`canOpen=true`；
已实现 **-558.63**、未实现 **-27.78**；模型在场 23 个 open + 3 个 pending，`accountingComplete=false`（129 条不完整）。

其中 19 个仓位已持有 8–10 根，**1–3 小时内会集中触发 11 根 timeout**。
这是第一批量足够大的真实出场样本：到 30 笔时门槛会给出 `open` 或 `blocked` 的明确判定。

---

## 五、同日离线研究的旁证（非本次产出，research_only）

`output/forecast-sweep-20261017/report.json`（15:00 生成，16 币种、9 个周期×预测期组合）：

- 9 个组合**扣除成本后全部为负**（-3.3% ~ -32.0%）；平均 IC 最高 0.013（15m/15m），方向准确率 50–53%。
- 成本拖累 4.3%–36.3%，远大于毛收益。

`output/rolling-benchmark-20261017/report.json`（14:33 生成，180 天、16 币种、10 折 walk-forward）：

| 策略 | 净收益 | Sharpe | IC / 方向准确率 |
| --- | ---: | ---: | --- |
| LightGBM 模型 | **-17.4%** | -1.44 | IC -0.011 / 50.1% |
| 趋势基线 | +1.15% | 0.27 | — |
| 买入持有 | +29.3% | 1.57 | — |

两项独立研究与实盘账本指向同一件事：**当前模型在扣成本后没有可测量的方向性边际**。
调 `probability_threshold`、加杠杆或换周期都救不了“概率里没有信息”这件事。

---

## 六、下一步（按“先止漏、再验证、最后放大”）

1. **等 30 笔真实前向样本**（今晚 ~19:00–21:00 大概率到）。只看 `gate` 的 `expectancy_bps`：
   ≥25bps → `open`，继续 50U 探针；<25bps → `blocked`，自动停新仓。
2. **在此之前不做任何放大**：`NOFX_ML_PROBE_MARGIN=50` 与 `NOFX_ML_MAX_POSITIONS=18` 保持。
3. **不要用清洗后的全历史调参**：43 笔真实样本里混着旧出场规则，只用于方向性诊断。
4. 若 30 笔后仍 <25bps：停用 `chronos-lightgbm-v1` 自动执行，把预算转给“趋势基线 + 成本”的纸面验证；
   同时修 `accountingComplete=false`（129 条 `missingExitQty`），否则熔断与归因仍建立在残缺账本上。
5. 归因根因（可选，下一轮）：外部平仓时写入 `closeProvenance=external` / `reason=external_flat`，
   而不是沿用旧 `reason`。本轮过滤器已能兜底，但这会让账本本身可审计。

## 七、局限

- 4 笔真实前向样本，不足以下任何结论；+190bps 只说明“旧规则止血后没有立刻继续亏”。
- `closeOrders` 缺失也可能是历史记录不全（老订单在同步前平仓），过滤器对旧样本偏保守；
  它只影响全历史展示，不影响以 05:12Z 为起点的前向门槛。
- 被排除的 +41.30U 是真实平仓盈亏（Demo 权益的一部分），不是虚构；只是不能算作策略 alpha。
- 账户 `realized=-558.63` 仍包含外部平仓与旧策略，不能直接当“模型亏了 558”。
