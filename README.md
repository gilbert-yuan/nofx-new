# NOFX 山寨合约趋势工作台

原生 Rust 后端负责行情采集、策略分析、组合回测、模拟成交、交易所同步和自动任务；Vue / Vite 前端提供行情、策略参数、订单与账户管理。项目仅保留 `altcoin-trend-breakout-live-v1` 山寨趋势突破策略。

## 当前策略

当前线上参数为 4 小时 EMA25/75、前 8 根高低通道、Wilder ATR14、初始止损 1 ATR、跟踪止损 3 ATR。收盘突破此前通道且符合 EMA 方向时形成新信号，下一可成交时点入场；通道不包含信号 K 线。止损以实际成交价为锚，每根完整 4 小时收盘后单向收紧，EMA 反转时安排退出，不设置固定止盈。

历史池按当时过去 30 天成交额选前 30 名，要求合约上市至少 180 天；排除 BTC、ETH、稳定币和非币类合约。单笔计划风险为权益的 0.3%，杠杆 1 倍，最多 3 笔持仓、同向最多 2 笔，单币名义仓位最多权益的 50%。线上执行还受账户资金、交易所精度、流动性、盘口和全局仓位限制约束，不能用研究名义仓位代替实际下单规模。

策略管理可启用或暂停扫描、覆盖参数、保存备注和恢复默认。每笔订单保留入场时的参数快照；修改参数从后续扫描生效，已有订单按各自快照复核保护与退出。当前运行环境为 Binance Demo，具体开关以保存的配置和 `/api/automation/status` 为准。最近切换记录见 [线上参数替换记录](reports/altcoin-online-refined-20261023.md)。

## 开发与检查

安装根目录 `rust-toolchain.toml` 指定的 Rust 工具链；Windows 需要 MSVC 构建工具，并提前启动 PostgreSQL。服务从项目根目录读取 `.env` 和 `data/` 中的配置。

```powershell
npm install
npm run build
cargo run --locked --bin nofx-server
```

服务默认监听 `http://127.0.0.1:3100`，同时提供 `dist/` 静态页面。前端开发可单独运行 `npm run dev:web`；Vite 默认把 `/api` 转发到 3100，可通过 `NOFX_API_TARGET` 调整。

```powershell
cargo fmt --check
cargo check --locked --all-targets
cargo test --locked --all-targets
npm run build
```

后端代码、回测和测试均使用 Rust。Cargo 工程位于根目录，源代码在 `rust/src/`。`src/api/contract.json` 保存前后端共用的接口路径；前端只负责展示与请求，不另行实现成交或损益计算。

## 组合回测

当前权威回测入口为 Rust `nofx-altcoin-backtest`，复用在线模拟的策略、成交、成本、风险和退出模块。回测保留历史动态交易池、组合资金竞争、实际结算资金费、资金费覆盖检查和成本翻倍场景。使用显式参数文件冻结候选，避免依赖日期专属的内置搜索网格。

```powershell
cargo build --locked --bin nofx-altcoin-backtest
target/debug/nofx-altcoin-backtest.exe --search-grid configs/altcoin-refined-full-20261023.json --start-ms 1782345600000 --holdout-ms 1787990400000 --end-ms 1790812800000 --output-dir output/altcoin-current-replay
```

示例测量区间为 2026-06-25 00:00 至 2026-10-01 00:00 UTC，结束时点不包含；后段隔离账户从 2026-08-29 08:00 UTC 开始。参数文件只控制离线研究，不修改线上开关。数据路径、历史修复和其他参数通过 `--help` 查看。需要补公开历史时显式使用 `--repair-history`，并检查输出中的排除币种、修复失败和数据覆盖，不能把缺失资金费当作零。

手续费假设为每侧 6 bps，滑点每侧 5 bps，另比较两者翻倍；资金费按真实历史方向收付。小时 OHLC 无法还原逐笔路径、挂单排队及网络延迟；缺少精确结算标记价时使用已披露的历史代理价格。当前元数据仍可能带来幸存偏差。历史收益、参数选择及后续时段复验见 [参数细化报告](reports/altcoin-local-refinement-20261023.md)。历史报告、原始数据与输出保留作为审计记录。

## 行情与自动执行

行情工作台保留多周期图表、量价研判和免费辅助指标。自动任务采集 `marketSync.symbolsText` 指定的合约（`ALL` 为全部 Binance USDT 永续合约），并根据当前策略补齐辅助周期。数据不足、断档或过期时阻止相应策略执行；`waitingForHistory` 展示所需和已有根数。

`marketSync.dataOnly: true` 为只读采集与分析。自动下单还要求 `trader.enabled: true`、`trader.dryRun: false`、`trader.allowEntryOrders: true`，以及目标环境账户同步完成。`GET /api/automation/status` 的 `executionStatus` 返回就绪状态和阻止原因。`created` 统计本地订单，`submitted` 统计已确认提交的订单；每轮新增仓位受 `trader.maxNewEntriesPerCycle` 限制。

Binance 实盘及公开合约行情默认使用 `https://fapi.binance.com`，Demo 使用 `https://demo-fapi.binance.com`。代理配置需与本机网络保持一致。当前托管进程使用 `ecosystem.nofx-runtime.json`；仓库中的运行脚本会部署二进制并重启服务，执行前应核对目标环境和运行目录。

PostgreSQL 使用共享 SQLx 连接池，默认最大 12、预热 2 个连接；可通过 `.env` 的 `NOFX_DB_POOL_*` 配置调整。`GET /api/database/pool` 与 `/api/health` 返回实际连接池状态。资金与订单写入在进程内排队，并由数据库事务锁处理跨进程冲突。连接池繁忙或锁等待超时返回 503，并发交易冲突返回 409；写操作不会自动重放。
