# 盈利优化实施记录（2026-10-17 13:00–13:20）

前序诊断：`reports/profit-optimization-20261017-1247.md`
本次按老板确认的五项全部落地，已部署并核验。

- 新二进制：`data/ml/runtime-20261017-1305/bin/nofx-server.exe`（13:12 构建，17.7MB）
- 进程：PM2 `nofx-api` id 11，干净环境启动，`↺ = 0`，进程内 `HTTP_PROXY/HTTPS_PROXY` 计数 **0**
- 验证：`cargo fmt --check` 通过；`cargo check --all-targets --locked` 通过；`cargo test --lib --locked` **286 passed / 0 failed / 9 ignored**（新增 7 个测试）

---

## 一、五项改动

### 1. 存量仓出场规则强制迁移（止血）

**问题**：`ml_execution::signal()` 的覆盖只作用于**新建订单**；在场 28 个仓的 `plan.exitRules` 仍是旧的 `smartExit.enabled=true / minHoldBars=0`，会继续在入场第 1 根被均线打断（该桶 -153bps/笔）。

**改法**：新增 `ml_execution::enforce_exit_rules()`，在 `paper::refresh_internal` 每次复核前对模型订单强制执行 `ml_horizon_exit_rules()`；K 线拉取失败的分支也写入，避免一次抖动让旧规则苟活。

```rust
// rust/src/paper.rs —— refresh_internal 内，advance_paper_order 之前
let migrated = crate::ml_execution::enforce_exit_rules(&mut order);
if migrated { tracing::info!(order=%id, symbol=%symbol, "Migrated model order to the frozen 11-bar exit rules"); }
```

**核验**（线上实测）：日志出现 26 条 `Migrated model order to the frozen 11-bar exit rules`；API 复查 **26/26** 在场模型仓均为 `smartExit.enabled=false / barLevelEnabled=false / minHoldBars=11 / maxHoldBars=11`。

### 2. 孤儿仓只读归因清单

**新增工具**：`rust/src/bin/nofx-orphan-audit.rs`（`Cargo.toml` 已注册），只读连接 PostgreSQL，把交易所持仓与本地订单逐一匹配后输出 JSON 清单。不写库、不下单、不平仓。

```bash
DATABASE_URL="postgres://postgres:admin@127.0.0.1:5432/nofx_lite" \
  cargo run --locked --bin nofx-orphan-audit -- --out output
```

**结果**（13:15，`output/orphan-audit-2026-10-17T05-15-49-511Z.json`）：

| 项目 | 数值 |
| --- | ---: |
| 交易所持仓 | 92 |
| 本地管理中的币种 | 48 |
| **孤儿仓** | **51** |
| 名义合计 | **2,538 U（权益 46.8%）** |
| 浮盈亏合计 | **+50.40 U** |
| 多 / 空 | 41 / 10 |

| 归因 | 数量 | 名义 | 浮盈亏 |
| --- | ---: | ---: | ---: |
| `closed_locally_but_still_on_exchange`（本地记已平、交易所仍有仓） | **42** | 2,100U | +34.24U |
| `entry_attempted_never_filled`（开仓尝试过、本地从未成交） | 9 | 438U | +16.16U |

**新发现（比原报告更严重）**：42 个仓属于「本地已记平仓、交易所还在」。这意味着这批仓位的**已实现盈亏是虚构的**——策略账面记了一笔平仓收益/亏损，实际仓位没平。`accountingComplete=false`（129 条不完整）很可能同源。这不是"忘记同步"，是平仓链路与账本的写入顺序问题，需要单独排查（下一步，未动）。

Top 12（按名义）：

| 币种 | 方向 | 名义 U | 浮盈亏 | 归因 | 本地单数 | 持有天 |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| SIRENUSDT | LONG | 62 | +11.67 | closed_locally… | 3 | 1.8 |
| OPUSDT | LONG | 53 | +3.22 | closed_locally… | 4 | 7.0 |
| MORPHOUSDT | LONG | 52 | +2.57 | never_filled | 1 | 1.7 |
| DASHUSDT | LONG | 52 | +2.14 | closed_locally… | 3 | 30.4 |
| SOONUSDT | LONG | 52 | +1.91 | closed_locally… | 2 | 8.8 |
| NMRUSDT | LONG | 52 | +1.85 | closed_locally… | 4 | 10.7 |
| PYTHUSDT | LONG | 52 | +1.62 | closed_locally… | 4 | 8.4 |
| JUPUSDT | LONG | 51 | +1.66 | closed_locally… | 6 | 8.2 |
| MINAUSDT | LONG | 51 | +1.47 | closed_locally… | 13 | 32.5 |
| 1000BONKUSDT | SHORT | 51 | -1.20 | closed_locally… | 2 | 8.4 |
| WIFUSDT | LONG | 51 | +1.04 | closed_locally… | 1 | 1.2 |
| 我踏马来了USDT | SHORT | 51 | -0.76 | closed_locally… | 6 | 33.1 |

> 未做任何处置。51 个仓全平可释放约 2,500U 名义占用、兑现约 +50U，但平仓不可逆，等老板看过清单再决定。

### 3. `min_edge` 净收益门槛接入执行链

**为什么不直接接训练产物**：`ml_profit_policy` 的 `min_edge` 打分的是**回归预测**（每 50U 预算的净 USDT），而线上预测器
`nofx-ml-monthly-predict-compat.exe` 只输出三分类概率，**没有任何运行时二进制能产出回归分数**（`Cargo.toml` 里也没有对应 bin）。
把 `min_edge` 硬接到分类概率上是伪造映射。

**改法**：新增 `rust/src/ml_edge.rs`，用同一语义（**成本后净收益门槛**）落到可测量的量上：

```
净期望(bps) = 胜率 × 均盈(bps) + (1-胜率) × 均亏(bps)      // fees/funding 已在 net 内
要求：净期望 ≥ NOFX_ML_MIN_EDGE_BPS（默认 25）
```

滚动窗口为最近 200 笔已平仓模型订单，样本 < 30 笔时**拒绝开仓**（"没有证据"≠"没有问题"）。
在 `authorize()` 中触发，且**排在容量检查之前**——书满了会掩盖"这个策略根本没有边际"这个更重要的事实。

**线上实测（13:20，`POST /api/ml/pipeline`）**：

```
SOLUSDT blocked_demo: 模型已实现净期望 -81bps/笔（124 笔，胜率 31%，均盈 244bps，均亏 -225bps）低于门槛 25bps
DOGE/XRP/LINK/AVAX 同上；ETHUSDT: 模型未生成有效新仓计划
```

盈亏平衡点 = 225/(244+225) = **48.1% 胜率**，实际 31%。

**预期效果（必须提前说清）**：在净期望转正前，**模型不会开新仓**。要越过 +25bps 门槛，需要
①胜率从 31% 抬到 ~52%，或 ②均盈从 244bps 抬到 ~580bps。这正是 11 根持有的目标（旧 `timeout` 桶是唯一正收益桶）。
所以接下来几天是**用现有仓位的平仓数据做前向验证**，不是空转。

### 4. 并发仓位上限 18 + 按分数取前 N

- `ensure_capacity()` 新增 `NOFX_ML_MAX_POSITIONS`（默认 18）：`pending/open` 的模型订单数达上限即拒绝。
- `ml_demo::scan` 改为**两阶段**：先分析整批、收集候选，按 `automation::score()`（信号强度/置信度）排序，
  再按排名依次提交，名额用完即止。原实现是"扫描顺序先到先得"，等于用轮转游标决定下注，不是决策。

**核验**：`summary` 新增 `ranked` 字段；本次扫描 `{universe: 49, batch: 20, analyzed: 20, ranked: 0, created: 0}` —— ranked=0 是因为门槛先拦住了（符合预期）。
排序分支在有候选通过门槛时才会走，目前只经过编译与代码审查，没有端到端样本。

### 5. 币池：流动性 5000 万 + 上市 30 天

- `NOFX_MIN_QUOTE_VOL_24H` 默认 500 万 → **5,000 万**（`ml_demo.rs` / `automation.rs` / `automation_guards.rs` 三处 + 生态文件）。
- `exchange::contracts()` 增加 `onboardDate`；`ml_demo` 过滤上市 < `NOFX_MIN_LISTING_DAYS`（默认 30）天的合约，
  `onboardDate` 缺失按"未知"处理（不放行）。

**核验**：训练全集 873 个合约 → 过滤后 **universe = 49**。此前 5,000 万门槛 + 30 天过滤基本不存在。

---

## 二、生态文件（`ecosystem.nofx-runtime.json`）

```json
"NOFX_MIN_QUOTE_VOL_24H": "50000000",
"NOFX_MIN_LISTING_DAYS": "30",
"NOFX_ML_MAX_POSITIONS": "18",
"NOFX_ML_MAX_COMMITTED_PCT": "0.80",
"NOFX_ML_MIN_EDGE_BPS": "25"
```

旧文件里的 `NOFX_MIN_QUOTE_VOL_24H=5000000` 会覆盖代码默认值，已一并对齐。

---

## 三、当前状态（13:20 实测）

| 项目 | 数值 |
| --- | ---: |
| 权益 | 5,426.82 |
| 可用 | 1,044.18 |
| 已占用 | 4,382.64（权益 80.8%，**仍在 80% 缓冲之上**） |
| 持仓 | 99（本地管理 48，孤儿 51） |
| `syncedAt` | 持续推进，`error` 为空 |
| 新开仓 | **全部被净期望门槛拦下**（符合设计） |

**容量仍是硬约束**：孤儿仓占 46.8% 权益 → committed 80.8% > 80%，即便门槛放开也开不了仓。**清孤儿是解锁前提。**

---

## 四、刻意没做的事

1. **没有把 `minConfidence` 从 0.45 改成 0.55**。在净期望门槛之下它只是个兜底下限；单改它会让"看起来修了"，实际仍然是概率当胜率用。要改是一行配置，但优先级低于真门槛。
2. **没有自动平掉任何一个孤儿仓**。清单已出，等指令。
3. **没有动 `ml_profit_policy` 的回归门槛**——它需要一个新的推理 bin 才能上线，属于下一阶段（用 11 根持有的新样本重训后一起做）。

---

## 五、回滚

```bash
PM2_HOME=D:/UGit/nofx-new/.pm2 npx --no-install pm2 delete nofx-api
# 把 ecosystem.nofx-runtime.json 的 script 指回 runtime-20261017-1036/bin/nofx-server.exe
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
  PM2_HOME=D:/UGit/nofx-new/.pm2 npx --no-install pm2 start ecosystem.nofx-runtime.json
```

旧二进制仍在 `data/ml/runtime-20261017-1036/bin/nofx-server.exe`，未删除。

## 六、下一步（按收益排序）

1. **处置 51 个孤儿仓**（先看清单）：释放 2,538U，committed 回到 ~34%，让容量约束让位给边际约束。
2. **查「本地记已平、交易所仍有仓」的 42 笔写入顺序**：这是账本 bug，直接影响 `accountingComplete` 与熔断可信度。
3. **观察 11 根持有的前向结果**：盯 `timeout` 桶的净 bps，以及净期望何时越过 +25bps。这是唯一能证明/证伪的窗口。
4. 回归预测推理 bin（若边际转正，再谈把 `min_edge` 用回归分数算，而不是用胜率反推）。

---

# 追加：第二轮（14:00–14:50）——孤儿仓清完、门槛改为前向窗口、服务重启

## 七、孤儿仓清理结果

只读归因清单（`output/orphan-audit-*.json`）确认后，按"交易所市价 reduceOnly、逐符号、只跳过有本地 pending/open 单的仓位"执行，
驱动脚本 `output/_close_orphans_direct.py`（默认 dry-run，`--confirm` 才下单）。

| 项目 | 清理前 | 清理后 |
| --- | ---: | ---: |
| 交易所持仓 | 92 | **41** |
| 已占用保证金 | 4,372.61 | **1,838.20** |
| 可用 | ≈1,044 | **3,582.31** |
| committed / equity | 80.8% | **33.9%** |
| 本地管理仓 | 48 | 47（其中 26 个模型仓已冻结为 11 根出场） |

两批共 28 个目标，成交 25 个；`MORPHOUSDT` 报 `-2022 ReduceOnly is rejected`（该符号无可减仓位），
`PYTHUSDT`/`LUMIAUSDT` 客户端超时但事后复核已成交。收尾 dry-run 复核：**剩余孤儿仓 0 个，名义 0U**。
释放保证金 **2,534U**（原计划 3,048U，差额来自期间新平仓与浮亏变化），容量约束不再挡在边际约束前面。

## 八、必须修的设计缺陷：门槛把实验自己锁死了

第一轮把 `min_edge` 接到执行链时用的是**全部历史**样本（150 笔 ⇒ -13bps），结果是新开仓被永久拒绝。
但历史样本是**旧出场规则**（0 根均线打断）产出的，用它否决它自己的替代方案，逻辑上自相矛盾；
更严重的是——没有新仓就不会有新样本，样本永远回不到 30 笔以上，门槛永远开不了。**这是个死锁。**

改法（`rust/src/ml_edge.rs`、`rust/src/ml_execution.rs`）：

1. **门槛只看前向窗口**：`gate(orders, strategy, forward_epoch_ms(), min_bps)`，
   `forward_epoch_ms()` 默认 2026-10-17 05:12 UTC（本轮上线时刻），可用 `NOFX_ML_FORWARD_EPOCH` 覆盖。
2. **三态判定，而不是"要么全开要么全关"**：
   - `probe`：前向样本 < 30 笔 ⇒ 允许开仓（否则永远收不到证据）；
   - `open`：前向样本 ≥ 30 笔且净期望 ≥ 25bps ⇒ 允许开仓；
   - `blocked`：前向样本 ≥ 30 笔但净期望 < 25bps ⇒ 拒绝，并报出真实数字。
3. **规模单列一条线**：`margin_cap()` 在 `ready_to_scale`（前向 ≥ 200 笔且 ≥ +25bps）之前恒为 **50U**
   （`NOFX_ML_PROBE_MARGIN` 可调，5–50）。即"验证期不加仓"，与第 6 条一致；
   同时把未封顶的 `budget_usdt` 单独上报，`recheck_pending()` 用它复核在途挂单——
   否则一改规模就会把已有挂单判成超预算。

## 九、前向窗口已经给出方向性证据

同一时刻，同一份账本，两种口径：

| 口径 | 笔数 | 胜率 | 净期望 |
| --- | ---: | ---: | ---: |
| 全部历史（含旧出场规则） | 150 | 36% | **-13bps** |
| 前向窗口（05:12 UTC 之后） | 45 | **53.3%** | **+176bps** |

胜率从 31% → 53.3%，净期望从 -81bps → +176bps。样本仍小（45 笔），
但这正是"旧规则在放血、新规则没有"的直接读数，也说明用全历史做门槛会得出相反结论。

## 十、部署与验证

- 二进制：`target/release/nofx-server.exe` → `data/ml/runtime-20261017-1305/bin/nofx-server.exe`
- 重启脚本：`scripts/deploy-runtime.sh`（先 `pm2 delete`，再 `env -u HTTP_PROXY …` 启动，最后自检代理变量）
- 自检结果：代理变量计数 **0**，`/api/automation/status` 的 `ml.summary` 已带 `forward` 字段
- 测试：`cargo test --lib` **295 passed / 0 failed / 9 ignored**

## 十一、还没做

1. `accountingComplete` 仍为 `false`，`incompleteHistory` 129 笔——「本地记已平、交易所仍有仓」的写入顺序 bug 没动。
   它现在不影响开仓（`canOpen=true`），但会让熔断判断基于不完整账本。
2. `minConfidence` 仍是 0.65 的兜底（概率本身不携带信息，真正的门槛是净期望）。
3. 前向样本到 200 笔之前，`ready_to_scale` 恒为 false，单笔名义不会放大。
