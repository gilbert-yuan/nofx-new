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

---

# 追加：`exchange-refresh` 全局锁是什么、为什么可以去掉

日期：2026-10-17 12:00

## 这把锁保护的不是订单

`exchange_refresh` 的临界区里**没有任何订单级操作**。它做的是：

1. 读全量 state（`db.account`）；
2. 每个 env：逐条解析 `capitalReservations`（每条一次 `GET /fapi/v1/order`），
   然后 `positionRisk` + `openOrders` 并发拉取；
3. `ledger::synchronize(...)` 把交易所成交/资金费并入本地账本；
4. 一次 `mutate_account_light` 把 `exchangeAccounts[env]` 整份快照写回，并 `reconcile_orders`。

锁 key 是 `system:exchange-refresh:ALL` —— 一个全局 key，**不分账户、不分币种**。
所以它看起来"锁住了所有订单"，实际它锁的是"账户快照的读-改-写"这一件事。

订单级的互斥早就单独存在：`nofx-execution:{env}:{symbol}:{positionSide}`，
入场、平仓、保护单各自按币种串行。刷新根本不参与。

## 为什么它其实是冗余的

三项证据：

1. **账本写入天然幂等。** `ledger.rs` 只写三张表，全部带冲突处理：
   - `simulation_exchange_fills` → `ON CONFLICT(environment,account_key,symbol,trade_id) DO NOTHING`
   - `simulation_exchange_funding` → `ON CONFLICT(environment,account_key,flow_id) DO NOTHING`
   - `simulation_exchange_cursors` → `ON CONFLICT ... DO UPDATE`
   重复并发执行不会重复入账。
2. **账户写入自带事务锁。** `mutate_account_light` → `mutate_account_mode` 内部有
   `write_gate` + `pg_advisory_xact_lock(790217)`，并在事务内重读 state。两个刷新并发写入，
   后写者覆盖前写者，但两者都是同一时刻的交易所真相，不会产生结构损坏或重复入账。
3. **其余步骤都是只读。** `positionRisk` / `openOrders` / `prices` 不写任何东西。

它唯一还买到的，只是"别把同一份刷新跑两遍"（省 HTTP 调用）。而代价是：
**一条 advisory 事务锁被持有 31 秒，同时钉住池子里的一条连接**（`max_connections=12`），
并且把所有账户、所有调用方串行化。

## 改动

1. 删掉 `lock_execution(db,"system","exchange-refresh","ALL")`，换成进程内**按账户**互斥：
   `refresh_guard(env)` = 每个 env 一个 `tokio::sync::Mutex`。只防重复工作，不占数据库连接。
2. 拆两条路径：
   - `exchange_refresh`（后台）→ `lock().await`，排队执行；
   - `exchange_refresh_soft`（用户操作）→ `try_lock()`，拿不到就跳过，用上一个快照。
3. 新增**刷新新鲜度闸门** `refresh_if_stale()`：`LAST_REFRESH_AT` 距今 < 90 秒就完全不刷新。
   没有这道闸门会从"409"变成"每个请求自己跑 30 秒刷新"，问题只是换了个形态。
4. 删掉 `close_internal` **结尾**那次刷新：仓位已平、本地已记录，`status` 就是准的，
   再花 30 秒（甚至因报错掩盖成功）纯属负收益。

## 实测

| 指标 | 改造前 | 改造后 |
|---|---|---|
| 平仓请求耗时（3 次探测） | 2s / 2s / **31s**（取决于是否抢到锁） | **2.3s / 1.8s / 2.0s** |
| 平仓被 409 拒绝 | 命中锁即失败 | 0 |
| `Exchange account synchronization deferred 409` | 反复出现 | 部署后 **0** |
| 连接池 `inUse` | 4–6（一条被 31s 事务长期占用） | 3–4，无长期占用 |
| 后台刷新是否正常 | 是 | 是（`syncedAt` 持续推进，positions=97） |

`cargo test --lib` 278 passed（新增 `refresh_freshness_window_expires`），
`durable_partial_exit_and_protection` 端到端 pass。

## 为什么没动 `paper-refresh`

`refresh_internal` 用的是同一把全局锁（`system:paper-refresh:ALL`），但它**不能照搬**：
它在循环里基于**顶部读到的过期快照**逐单算结果，最后用一个 patch 应用回去。
并发两遍会丢更新（例如中间有人手工平仓，另一遍会用旧状态把它覆盖回去）。
`exchange-refresh` 是"整份快照替换 + 幂等 upsert"，性质不同，才敢去掉。
`paper-refresh` 要动，得先把它的写入改成带版本号的乐观并发，属独立改造。

## 前提与限制

进程内互斥假设**单进程部署**。当前 PM2 是 fork 模式单实例，成立。
若将来起多个 `nofx-server` 实例，需要换成 `pg_try_advisory_lock`（会话级）或数据库租约，
否则多进程会各刷各的（仍幂等，只是重复劳动）。

---

# 事故复盘：继承死代理导致交易所全面断网

日期：2026-10-17 12:05 报障 → 12:20 恢复

## 现象

```
Binance public GET https://fapi.binance.com/fapi/v1/exchangeInfo failed after 3 attempt(s):
error sending request for url (https://fapi.binance.com/fapi/v1/exchangeInfo):
client error (Connect): tunnel error: failed to create underlying connection:
tcp connect error: 由于目标计算机积极拒绝，无法连接。 (os error 10061)
```

`demo-fapi` 与 `fapi` 同时失败，`klineSync` 连续报错 —— 不是单个域名问题，是整个出站链路断了。

## 根因

`pm2 env <id>` 显示交易进程环境里有：

```
HTTP_PROXY:  http://127.0.0.1:50172
HTTPS_PROXY: http://127.0.0.1:50172
```

50172 是**执行命令的 shell 被注入的沙箱代理端口**，不是 `ecosystem.config.json` 里写的 7890。
前几次用 `pm2 stop/start` 重启时，PM2 把当前 shell 的环境一起带进了子进程。
沙箱代理随会话关闭后端口不再监听，于是每个请求都变成 CONNECT 隧道失败。

实测对照：

| 方式 | 结果 |
|---|---|
| `curl -x http://127.0.0.1:50172 https://fapi.binance.com/fapi/v1/time` | `000`（连接被拒） |
| `curl https://fapi.binance.com/fapi/v1/time`（直连） | `200` |

**结论：网络本身没问题，是进程被塞了一个死代理。**

## 代码层的责任

`exchange.rs::http_client()` 原本主动读取 `HTTPS_PROXY` / `HTTP_PROXY` 并据此设置 reqwest 代理：

```rust
if let Some(proxy) = std::env::var("HTTPS_PROXY").ok()
    .or_else(|| std::env::var("HTTP_PROXY").ok())
    .filter(|s| !s.is_empty()) {
    builder = builder.proxy(reqwest::Proxy::all(proxy)?);
}
```

这等于把"谁启动了我这个进程"的环境当成了网络策略。交易服务的出站策略不该被调度器的
环境变量决定 —— 一个已经消失的代理足以让整个系统静默瘫痪。

## 修复

1. **代理改为显式 opt-in**：只认 `NOFX_HTTP_PROXY`，未设置或为空一律 `.no_proxy()` 直连。
2. **可观测**：检测到继承的 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/小写变体时，
   用 `std::sync::Once` 打一条 WARN
   `Ignoring inherited proxy; set NOFX_HTTP_PROXY to opt in`，附变量名与原值。
3. **配置清理**：移除 `ecosystem.config.json` 中 `nofx-api` 的 `HTTP_PROXY`/`HTTPS_PROXY`
   （7890 同样无人监听，是同一颗雷）。
4. **重启纪律**：见 `MEMORY.md` —— 必须
   `env -u HTTP_PROXY -u HTTPS_PROXY ... pm2 start ecosystem.nofx-runtime.json`，
   并在重启后校验 `pm2 env` 无代理、`syncedAt` 推进。

## 验证：主动注入毒代理

不是"改完看着好像好了"，而是故意把死代理塞回去：

```bash
HTTP_PROXY=http://127.0.0.1:50172 HTTPS_PROXY=http://127.0.0.1:50172 \
  pm2 start ecosystem.nofx-runtime.json --update-env
```

结果：

| 检查项 | 结果 |
|---|---|
| `pm2 env` 里是否真有毒值 | 有（50172 确实在进程环境中） |
| 启动日志 | 4 条 `Ignoring inherited proxy`（HTTP_PROXY/HTTPS_PROXY/大小写变体） |
| `exchangeAccounts.demo.syncedAt` | 持续推进 |
| `exchangeAccounts.demo.error` | 空 |
| `tunnel error` 出现次数 | **0** |

说明即使外部再污染环境变量，交易进程仍能直连。

随后干净重启，`pm2 env | grep -c proxy = 0`，`syncedAt` 持续推进，`positions=92`，
`klineSync` / `positionReview` 均 enabled，ML `lastRun` 正常。
`cargo test --lib` 279 passed（新增 `only_an_explicit_proxy_setting_can_route_exchange_traffic`）。

## 教训

1. **长驻交易进程的网络策略必须显式声明**，不能依赖继承的环境变量。
2. **重启前先看 `pm2 env`**：这是唯一能看到"进程实际拿到了什么环境"的地方。
3. 事故期间的表现具有欺骗性：进程活着、API 返回 200、只是所有交易所调用失败 ——
   监控应盯 `exchangeAccounts.*.error` 与 `syncedAt` 停滞，而不只是进程存活。

---

# 手动平仓慢：合约信息每次都重新下载 900KB

日期：2026-10-17 12:35

## 定位过程

先量化平仓路径上的每一步，而不是凭感觉猜：

| 路径 | 实测耗时 |
|---|---|
| `GET /fapi/v1/exchangeInfo`（单次，902KB） | **6.77s** |
| `GET /fapi/v1/time` | 1.55s |
| `/api/paper/account`（含 `db.account` 全量读） | 1.99–2.22s |
| 平仓探测（不存在的订单 ID） | 1.89–2.34s |

## 主因

`paper::symbol_info()` 每次都无条件拉取全量 `/fapi/v1/exchangeInfo`
（**902KB、742 个合约、单次 6.0–6.8 秒**），只为从中取一个合约：

```rust
let info = client.public_request("/fapi/v1/exchangeInfo", &json!({})).await?;
info["symbols"].as_array()
    .and_then(|a| a.iter().find(|s| s["symbol"] == symbol))
```

调用点 4 处（`paper.rs` 1704 / 2004 / 2146 / 2476）。其中 `sync_protection`（2004）
对**每个**活跃仓位各调一次 —— 94 个仓位就是 94 次 6 秒的下载。

后果有两个：

1. **平仓慢**：`execute_remote_close` 在提交平仓单前要取合约信息，直接 +6 秒。
2. **后台刷新慢**（承接上面的遗留问题）：`sync_protection` 反复下载，
   每轮扫描耗时几十秒 —— 实测 `exchange-refresh` 接口 **46.8s**。

附带发现：后台每轮还会逐个仓位持 per-symbol 锁做多次网络往返，
手动平仓撞上时要等 `lock_execution_wait`（最长 12 秒）。

## 修复

1. **`Exchange::info()` 加进程内缓存**，按环境（base URL）分区，TTL 10 分钟：
   - 命中直接返回单合约；
   - 缓存里全量列表不含该合约时直接判"环境不支持"，**不再为已知不存在的合约重下 900KB**；
   - 未命中才拉取，并重建 symbol → 合约 的索引表。
   
   理由：合约信息只在上市/下架时变化，是典型的"写少读多"数据。
2. **`Exchange::info()` 加 miss 埋点**：只在真正拉取时打
   `Fetched exchange contract metadata base=... ms=... symbols=...`。
   因为只在 miss 时记录，日志本身就是缓存是否生效的证据。
3. **`execute_remote_close` 加耗时埋点**：`Remote close finished ms=...`，
   按 target 分别记录，下次平仓可以直接从日志读出耗时构成，不用再猜。

## 验证

部署后 60 秒内：

```
1  条  Fetched exchange contract metadata
       base=https://demo-fapi.binance.com ms=6045 symbols=742
```

**只拉取了 1 次，耗时 6045ms**，之后全部命中缓存。
改动前同样的时间窗口内会发生几十次同样的 6 秒下载。

`cargo test --lib` 279 passed。

## 未进一步改动的部分（有理由）

1. **平仓响应里的 `status(db)`（约 2s）没有删**。
   前端 `TradingView.vue:275` 有 `if (result.account) accountData.value = result.account;`，
   直接用它更新界面。删掉只是把 2 秒从后端挪到前端，净收益为零。
2. **入口 `db.account(true, None)`（约 2s）保留**。
   `fused_orders()` 需要全量状态才能算融合池，无法只读单行。
3. **没有动 `close_above_margin` / `close_all` 的批量路径**。

## 预期与实际

平仓耗时构成（估算，待真实操作复核）：

| 阶段 | 改动前 | 改动后 |
|---|---|---|
| 入口 `db.account` | 2.0s | 2.0s |
| 等待币种锁 | 0–12s | 趋近 0（远程同步变快） |
| 合约信息 | **6.0–6.8s** | **≈0（命中缓存）** |
| 其余交易所往返（持仓/挂单/下单/保护单） | ~2.5s | ~2.5s |
| 响应 `status(db)` | 2.0s | 2.0s |
| **合计** | **约 13–23s** | **约 6.5s** |

剩下 4 秒是两次全量账户读（`db.account`），属于另一条独立的优化主线
（此前已记录：单次读要 diff 78436 行扩展表），本轮未触碰。

## 遗留

1. `db.account(true, None)` 单次 2 秒，是平仓与刷新的共同底座开销。
   要做需要引入增量读或状态缓存，改动面大，需单独评估。
2. `Exchange::contracts()`（币种列表）也独立调用 `exchangeInfo`，未复用本次缓存。
3. `mode()`（`positionSide/dual`）是账户级配置却每次都问交易所，
   也可缓存，本轮未做（收益约 0.4s）。
