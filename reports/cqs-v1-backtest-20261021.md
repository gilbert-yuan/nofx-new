# Crypto Quant Signal V1（TradingView）本地化 + 回测结论

- 日期：2026-10-21
- 标的/区间：7 个币 × 30 天（2026-09-18T13:37Z → 2026-10-18T13:37Z，1m 逐根回放）
- 引擎：共享生产回放引擎 `backtest::replay`（复用同一套成交、成本、风控、出场规则，没有另写一套回测）
- 数据：Postgres `market_klines` 1m；5m 高级别优先取库里原生 5m
- 产出：`output/cqs-backtest-20261021/`（主跑）、`output/cqs-backtest-20261021-confirm/`（确认跑）

## 一句话结论

**这个策略回测为负期望，不建议接入生产。** 而且不是"成本吃掉了薄 edge"——**扣费前的毛收益本身就是负的**。
另外它在共享执行层里几乎无法成交：原脚本按 1m ATR 定止损，风险单位比往返成本还小一个量级。

## 一、本地化实现

新增策略 `crypto-quant-signal-v1`（引擎 `cqs-v1`），注册表驱动，前端「策略管理」页自动可见，**默认不启用**。

| 文件 | 内容 |
|---|---|
| `rust/src/strategies/cqs.rs` | 策略实现（新增） |
| `rust/src/strategies/registry.json` | 注册条目 + 26 项参数 schema（新增） |
| `rust/src/strategies.rs` | `analyze` / `review` 分派（修改） |
| `rust/src/backtest.rs` | 支持可选 `replayWindow`（默认仍是 80，其它策略零影响） |
| `rust/src/bin/nofx-cqs-backtest.rs` | 回测工具（新增） |
| `Cargo.toml` | 注册 `nofx-cqs-backtest`（修改） |

### 与 Pine 脚本的对齐

- `ta.ema` / `ta.rsi`：与共享库 EMA、Wilder RSI 一致。
- `ta.atr` / `ta.dmi`：**在策略内重新实现为 Wilder RMA**，没有用共享库里 SMA 版的 `atr()` 和 EMA 版的 `adx()`（口径不同，会改变 ADX≥18 与止损距离的判定）。
- 高级别 `request.security(..., "5", close[1], lookahead_on)`：取**上一根已收盘 5m K 线**的 close 与该处的 EMA100。
- 止损/止盈按信号根 `close` 计算：`close ∓ ATR×atrMult`、`close ± 风险×rr`，与 Pine 一致。
- EMA21/55 排列 + RSI 区间 + ADX/±DI + 成交量倍数 + `crossover(close, emaFast)` 触发，多空双向。
- 出场：只有固定止损 / 固定止盈 / 90 根超时，关闭移动止损、智能退出、分批止盈。

### 两处必须说明的执行差异

1. **成交时刻**：Pine 在信号根按 `close` 立即成交；本地最快是**下一根 1m 开盘价**。因此加了 `entryBandAtr`（默认 0.25×ATR）作为可接受区间，超出则本根放弃。1m 的 1 个 ATR 只有约 0.04%，所以即使放大到 1.5×ATR 也仍等于"按收盘价附近成交"。
2. **`minStopPct`（本地新增，默认 0）**：只把止损**拉远**，从不压缩；默认 0 时与原脚本逐位一致。它存在的唯一目的是做对照实验——见下文。

## 二、为什么原版口径几乎不可能成交

| 量 | 数值 |
|---|---|
| 1m ATR14 占价格（BTC，32 天） | p50 = **0.043%**，p90 = 0.091% |
| 原版止损距离 = 1.5×ATR | **≈ 0.065%** |
| 共享成本模型往返成本（6bps 费 + 5bps 滑点 ×2 + 资金费） | **≈ 0.226%** |
| 原版目标 = 2R | ≈ 0.130% |

**风险单位（0.065%）比一次往返成本（0.226%）还小 3.5 倍。** 2R 的目标连成本都覆盖不了 —— 净盈亏比恒 < 1。

回测里表现为两道闸：

1. **共享成本闸门**（`research::normalize_plan` 要求成本后盈亏比 ≥ 1）：需要 ATR% ≥ 0.30%，而 1m ATR 只有 0.05% 的时间能达到 →
   **原版口径 898 个信号里只有 6 个被提交、2 个成交。**
2. **流动性筛选闸门**（`NOFX_SCREEN_MIN_ATR_PCT` 默认 0.002，即最近 15 根 1m 的 ATR% ≥ 0.2%）：1m 的 ATR 峰值也才 0.36%、p90 只有 0.09% →
   把止损放大到能过成本闸门后，**116/116 个信号又被流动性筛选拦下**。

⇒ 这两条都是为高周期设计的门槛，任何 1m 级别的策略在本引擎里都会撞上；不是这条策略独有的 bug，但也说明它现在**不可能在线上跑起来**。

## 三、回测结果（放开流动性闸门后，让信号真的能成交）

每标的/变体是独立的 1000 USDT 账户，**不要相加当成一个组合**。7 个币：SOL、DOGE、NEAR、BTC、ETH、BNB、XRP。

| 变体 | 成交 | 胜率 | 净额 | **毛额（扣费前）** | 剔最大1笔 | 剔最大3笔 | 亏损标的数 |
|---|---|---|---|---|---|---|---|
| `original`（原脚本逐位一致） | 2 | 50% | +0.17 | +0.29 | −0.51 | −0.00 | — |
| `cost-aware`（止损下限 0.6%） | 71 | 28.2% | **−8.01** | **−3.61** | −8.69 | −9.68 | 7/7 |
| `cost-aware-rr3`（盈亏比 3） | 75 | 26.7% | −7.51 | **−2.86** | −8.58 | −10.18 | 7/7 |
| `no-htf`（去掉 5m 过滤） | 71 | 32.4% | −7.65 | **−3.25** | −8.33 | −9.33 | 7/7 |
| `no-volume`（去掉成交量过滤） | 75 | 25.3% | −10.24 | **−5.59** | −10.92 | −11.91 | 7/7 |

**确认跑**（3 个币，5m 改为由完整 1m 聚合，行情缺口 0）：

| 变体 | 成交 | 胜率 | 净额 | 毛额 | 剔最大1笔 | 剔最大3笔 |
|---|---|---|---|---|---|---|
| `cost-aware` | 31 | 32.3% | −2.99 | **−1.08** | −3.67 | −4.65 |
| `wide-band`（入场容差 1.5×ATR） | 20 | 10.0% | −3.25 | **−2.00** | −3.42 | −3.52 |

### 怎么读这些数字

- **毛额（扣费前）在所有配置里都是负的** → 按项目既定判据，这叫"根本没有 edge"，不是"成本吃掉了薄 edge"。
- **胜率 25%–32%，而 2R 的盈亏比需要 ≥33% 才能打平** → 方向与幅度互相印证，不是某个样本偶然。
- **剔除最大 1 笔 / 3 笔后更差**（−8.01 → −8.69 → −9.68）→ 不是靠一两笔极端行情撑起来的假象。
- **7/7 个标的全负**，不存在"某个币赚、其它亏"的分布问题。
- 分项的消融实验：成交量过滤**略有正面作用**（−8.01 vs −10.24）；5m 高级别过滤**略微为负**（−8.01 vs −7.65），即 HTF 过滤在本样本上没有加分。

## 四、样本与数据的诚实披露

- 库里 1m 缺口严重：只有 **SOL / DOGE / NEAR 三个币在 30 天窗口里 1m 完全连续**；BTC/ETH/BNB/XRP 缺约 7957 分钟（17.6%），ADA/LINK/AVAX/SUI/TRX 缺约 77%（已排除）。
- 主跑用库里原生 5m（有 1515 个缺口桶），导致约 **8770–1034 分钟被跳过**（占 2%–20%）。确认跑改用 1m 聚合的 5m，缺口 = 0，结论不变。
- 首次跑曾有 1 个标的因 1m 断档让 `replay` 直接 `bail!` 中断全轮；已改为**单个回放失败只记录原因、不炸掉整轮**。
- 单笔仓位很小（名义 ≈ 权益的 10%），30 天的权益波动只有 0.1%–0.4% 量级；**净额的绝对数值小，判断依据是胜率 / 盈亏比 / 毛额方向这类结构性指标，不是净收益大小**。
- 原始 Pine 脚本没有回测（`indicator`，不是 `strategy`），本结论对应的是"把它的规则接进本地共享执行层之后"的表现，不是 TradingView 回测器里的数字。

## 五、建议

1. **不接入生产、不默认启用**（已按此落地：注册表里 `builtin: true`，但不在默认 `enabled` 集合里）。
2. 保留为可参数化的对照实验：参数已在注册表里暴露，`minStopPct` / `atrMult` / `rewardRisk` / `entryBandAtr` 都能调，后续若有人想再验证可直接跑
   `nofx-cqs-backtest --symbols ... --variants ...`。
3. 如果真要救这条思路，第一步不是调参，而是**换时间周期**：1m 的 ATR 天然小于任何真实成本结构，必须把主周期提到 15m/1h 量级，让风险单位 ≥ 3 倍往返成本，再谈信号有没有 edge。

## 复跑命令

```bash
cargo build --release --bin nofx-cqs-backtest
# 查看库里 1m/5m 覆盖与缺口
DATABASE_URL=postgres://postgres:admin@127.0.0.1:5432/nofx_lite \
  ./target/release/nofx-cqs-backtest.exe --list-coverage
DATABASE_URL=postgres://postgres:admin@127.0.0.1:5432/nofx_lite \
  ./target/release/nofx-cqs-backtest.exe --inspect --symbols SOLUSDT,DOGEUSDT \
  --start-ms 1789738620000 --end-ms 1792330620000
# 回测（放开 1m 策略必然撞上的流动性闸门，让信号能真成交）
DATABASE_URL=postgres://postgres:admin@127.0.0.1:5432/nofx_lite \
  NOFX_SCREEN_MIN_ATR_PCT=0 NOFX_MIN_QUOTE_VOL_24H=0 \
  ./target/release/nofx-cqs-backtest.exe --symbols SOLUSDT,DOGEUSDT,NEARUSDT,BTCUSDT,ETHUSDT \
  --start-ms 1789738620000 --end-ms 1792330620000 \
  --variants original,cost-aware,cost-aware-rr3,no-volume,no-htf --parallel 10 \
  --output-dir output/cqs-backtest-20261021
```
