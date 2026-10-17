# 平仓失败归因与修复（RabbitMQ 决策记录）

日期：2026-10-17
结论：**不引入 RabbitMQ**；平仓失败全部来自交易所侧幂等/配额语义，与消息投递无关。改为在订单状态机上做幂等收敛 + 退避重试 + 配额降级。

---

## 1. 取证方法与数据基座

- 数据源：`GET /api/automation/status`，768 笔已平仓 + 107 笔活跃订单（`output/_mq1.json`）。
- 平仓是否真在交易所发生，用 `exchange.closeOrders[].status=="filled" && executedQty>0` 判定，不依赖订单自身 `status`。
- 所有错误字符串来自真实落库行，直接作为单元测试的固定夹具。

---

## 2. 失败分类（按环节归位）

### 2.1 平仓撤销环节

| 项 | 值 |
|---|---|
| `exchange.status="cancel_error"` | 45 笔（另 4 笔 cancel_error 但已有成交） |
| 其中 `lastError` | **45/45 = `Binance 400: Unknown order sent.`** |
| 时间分布 | 全部落在 2026-09-14 ~ 09-16，**近一个月零新增** |

`Unknown order sent.`（-2011）是纯文本，**不带数字错误码**。而代码里的幂等判断 `missing_order()` 只匹配 `-2013` 与 `Order does not exist` —— 所以这条判断一次都没生效过。调用点 `paper.rs`（平仓前撤销挂单）是裸 `.await?`，一旦撞上就**整笔平仓中止**。

### 2.2 保护单环节

| 错误 | 累计 | 近 2 天 | 语义 |
|---|---|---|---|
| `ClientOrderId is duplicated (-4116)` | 102 | 12 | 确定性 clientAlgoId 被交易所占用 |
| `Reach max stop order limit (-4045)` | 17 | 17 | 账户条件单配额耗尽 |
| `open stop/take profit order with GTE...` | 29 | — | 同价位重复保护单 |

这三类**不影响平仓本身**（仓位照样平掉），影响的是平掉之后保护单补不上。

### 2.3 非平仓类（开仓侧，不计入）

`Invalid symbol (-1121)` 23 笔、`Precision (-1111)` 4 笔、`Leverage 12 is not valid` 3 笔、`Limit price can't be higher than 0` 9 笔、环境不支持合约约 17 笔。

### 2.4 已修项

`账户更新排队超时` 10 笔 —— 上一轮批量写入重构后归零。

---

## 3. 为什么 RabbitMQ 解决不了

1. **没有一例消息丢失。** `emergencyClose.status` 在 768 笔中为 `not_requested` 522、`None` 246，应急平仓路径一次未触发。不存在「请求发出但无人处理」的记录。
2. **平仓已有比 MQ 更强的持久化驱动。** `automation.rs:147-155` 常驻任务每 **15 秒** 执行 `exchange_refresh`，按 Postgres 里订单的**当前状态**重新收敛（入场 → 策略出场 → 保护单）。平仓意图落在 `manualExecutions[status=submitting, clientOrderId]`，进程重启后靠 clientOrderId 回查交易所。这是数据库 outbox + 幂等 worker，重放一次与重放百次结果相同。
3. **MQ 会引入第二个真相源。** 「DB 已提交 / 消息已投递」之间的双写窗口是当前架构不存在的新故障模式。
4. **失败原因全在语义层。** -4116 / -4045 / -2011 是交易所的确定性响应，投递一百次仍是同一结果。
5. **`retryCount` / `retryAt` 是死字段**（此前只在 `paper.rs` 的默认结构里写死 0/null，从未读写）——真正的缺口是缺退避，不是缺队列。

---

## 4. 已实施修复（`rust/src/paper.rs`）

### 4.1 让「已不存在」等于成功（-2011 / -2013）

`missing_order()` 扩展为同时匹配 `-2011`、`-2013`、`Order does not exist`、`Unknown order sent`。
三处撤销调用改为可容忍：

- 平仓前撤销挂单（原裸 `?`）——撞车不再中止平仓。挂单在 listing 与 cancel 之间成交，正是「要平的那个仓」本身。
- 单笔撤单入口：`GET` 查不到时按 `CANCELED` 收敛，`DELETE` 撞车同样收敛。
- `cancel_native_protection` 清理残留保护单。

### 4.2 `-4116` 撞车后轮换 clientAlgoId

`sync_protection` 的提交改为两段：

1. 用确定性 ID 提交；若返回 duplicate，先按 clientAlgoId 查 `openAlgoOrders`，**在挂单则直接接管**；
2. 不在挂单说明 ID 已被交易所烧掉（订单已触发/离场但 ID 仍被保留）。此时**轮换 ID 重试一次**，否则同一个确定性 ID 每轮扫描都会撞车，这条腿会永远补不上保护。

同时修掉一个潜在缺陷：删除旧保护单时排除刚接管的 `algoId`，避免「先删后建」把刚拿到的保护单删掉、留下空窗。

### 4.3 `-4045` 配额耗尽降级为本地止损

新增 `record_protection_fallback()`，写入 `protection.<leg>.status="local"`、`mode="local"`、`fallbackAt`，并清空 `protectionError`（降级是确定状态，不该每 15 秒当错误刷）。

降级并非「裸奔」：平仓压力由两条既有机制承接 ——
- `sync_protection` 入口的 markPrice 越界判定，每 15 秒按 `plan.stopLoss` 强平；
- `simulator` 的逐根 K 线 `stop_loss`（`simulator.rs:589` `protected` 分支）。

差别只在于触发粒度：本地 15 秒 / 逐根，交易所条件单是实时。因此仅在配额耗尽时降级，并保留可审计状态。

### 4.4 真正接上指数退避

`retry_patch()` / `retry_due()`：首次失败仍在下一个 15 秒扫描重试（**不慢于原行为**），之后 30s → 60s → 120s → 240s → 封顶 300s。成功即清零。
门控放在 `sync_entries` 每单入口，`manualCloseRequested` / `manualEntryCancelled` **绕过退避**，人工平仓永不被延迟。

---

## 5. 验证

| 项目 | 结果 |
|---|---|
| `cargo test --lib` | **277 passed, 0 failed**（新增 4 个单元测试） |
| 端到端（真实 Postgres + mock 交易所） | `durable_partial_exit_and_protection` **pass** |
| 端到端覆盖点 | ① -4116 后恰好重试 1 次且 ID 不同，最终落 `submitted`；② -4045 双腿落 `local` 且 `protectionError` 清空；③ 降级过程不动仓位 |
| `cargo check --all-targets` | pass |
| 部署 | `data/ml/runtime-20261017-1036/bin/nofx-server.exe`，11:29 重启，日志无 ERROR |
| 退避生效 | 活跃订单已出现 `retryCount=1, retryAt!=null` |
| 保护单错误 | 活跃订单 `protectionError` **全空**；122 条历史错误全部属于已平仓行 |

**验证局限**：`-4116`/`-4045` 的真实分支尚未被生产流量触发（当前没有待补保护单的活跃仓位），正确性由 mock 端到端测试保证，非线上观测。

---

## 6. 未处理 / 待决策

1. **102 笔孤儿持仓**：Binance Demo 有仓、本地无对应订单，占权益约 87%，合计未实现 +25.74。它们同时消耗条件单配额，是 `-4045` 的直接来源。在 80% 占用缓冲下，策略当前被挡在开仓之外。等你选择处置方式（建议先只读归因清单）。
2. **前端不渲染 `protection` 状态**：整套 `protection` / `protectionError` 在 `src/` 里零引用，`local` 与 `unknown` 目前只能在 API/DB 层看到。需要 UI 支持才谈得上「可审计」。
3. P1：`ml_profit_policy::min_edge` 仍未接入线上闸门（线上只判 `probability_threshold=0.45`）；流动性/上市时长过滤仍偏松（`NOFX_MIN_QUOTE_VOL_24H` 默认 5,000,000）。
4. P3：`maxPositionsToReview`、`maxTotalNotionalPct` 仍是死配置；`accountingComplete=false` / `incompleteHistory=129` 未收敛。
5. 开仓侧 `Invalid symbol` / `Precision` 共 27 笔：下单前应过滤不可交易合约与步长，属独立改进项，本轮未动。

---

# 追加：手动平仓报 409「该币种正在执行其他交易操作」

日期：2026-10-17 11:45

## 根因（实测，非推断）

`lock_execution` 用的是 `pg_try_advisory_xact_lock`，**零等待**，抢不到立即返回 409。
而 `close_internal` 的第一件事是 `exchange_refresh(db, store)`，它要抢的是**全局**锁
`system:exchange-refresh:ALL`——不是该币种的锁。

全量刷新要遍历全部活跃仓位（103 个），每个都要多次 HTTP 调用。实测一次刷新耗时 **31.2 秒**，
而后台定时器是 15 秒一轮（`automation.rs:147-155`，sleep 在完成后才开始）。
结果这条全局锁的占用率接近 100%，手动平仓在**第一步**就必然撞 409，根本走不到平仓逻辑。

顺带发现两处更隐蔽的伤害：

- `close_internal` **结尾**还有一次 `exchange_refresh`。仓位此时已经平掉了，若这次刷新撞锁，
  整个请求返回 409 —— 用户以为平仓失败去重试，造成重复平仓动作。这是比开头更严重的问题。
- `close_above_margin` / `close_all` / `place_exchange_order` 同样在入口被这次刷新卡死。

## 修复

1. `lock_execution` 拆成三个：
   - `try_lock_execution` → `Option<Transaction>`，不报错；
   - `lock_execution` → 保持零等待，供后台扫描用（抢不到就跳过本轮，不排队）；
   - `lock_execution_wait` → 250ms 轮询直到超时，供人工操作用。
2. 新增 `refresh_unless_busy()`：刷新遇 409 记 INFO 并继续，其他错误照常抛出。
   用于 `close_internal` 入口/出口、`close_above_margin`（两处）、`close_all`（两处）、`place_exchange_order`。
3. `execute_remote_close`、`place_exchange_order`、`cancel_exchange_order` 改用
   `lock_execution_wait(..., MANUAL_LOCK_WAIT = 12s)`，人工操作等锁而不是弹错。
4. 等待超时的文案带上已等候秒数，便于下次一眼区分「刷新被占」与「该币种被占」。

关键取舍：**后台扫描永远零等待**（跳过本轮即可，避免堆叠），**人工操作才等**。

## 验证

- 单元/端到端：`lock_execution_wait` 在锁被持有时超时报错、释放后成功交接；
  `try_lock_execution` 返回 `None` 而非 error。`durable_partial_exit_and_protection` pass，`cargo test --lib` 277 passed。
- 线上探测（部署后，`POST /api/paper/orders/{不存在ID}/close`）：

| 时间点 | 修复前 | 修复后 |
|---|---|---|
| 命中「刷新被占」 | `409 该币种正在执行其他交易操作` | **`422 订单已结束或列表已更新`，1.9–2.2s** |
| 命中「刷新可获取」 | 正常但耗时 30s+ | 正常，31.2s（刷新本身仍慢） |

  说明：修复前这两条路径都会在入口 409；修复后都能进入真正的业务逻辑。
- 日志出现新埋点 `Close proceeding without a fresh account refresh`，无新增 409（`close` 路径）。
- 部署后无 ERROR（现存 ERROR 全部为 10:49–10:58 的历史约束违反记录）。

## 仍未解决（需要单独处理）

`exchange_refresh` 单次耗时 31 秒 > 15 秒周期，导致后台扫描长期占满全局刷新锁。
现在手动平仓已不受其影响，但这条定时器事实上永远跑不完一轮，
意味着**账户快照与持仓对账的实时性只有约 31–46 秒**，而不是设计的 15 秒。
要根治得拆小 `ledger::synchronize` 的粒度或改成增量同步，属独立改造项，本轮未动。
