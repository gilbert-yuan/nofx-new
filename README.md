# NOFX

后端使用原生 Rust（Axum / Tokio / PostgreSQL），前端保留 Vue / Vite。API、策略分析、模拟成交、订单复核、交易所同步和自动任务均在 Rust 中运行。

行情工作台已接入「AI 信号与风控」：Chronos-Bolt-Tiny 预测价格 → LightGBM 判断信号 → 共享 Rust 风控与止盈止损。支持只读研究和 Binance Demo 自动执行，Demo 订单复用现有交易、账户对账和持仓复核引擎。运行模式、开关与限制见 [模型交易链路](docs/ml-trading-pipeline.md)。

本机 Demo 实例使用 `http://127.0.0.1:3101`，启用记录与当前限制见 [Demo 运行验收](reports/ml-demo-activation-20261015.md)。

当前模型的交易参数可使用 Rust `nofx-ml-optimize` 搜索，以扣成本净收益比较48组门槛、ATR保护和持有时间，并在锁定参数后做历史分段复核；运行及限制见 [模型参数优化](docs/ml-parameter-optimization.md)，实际结果见 [2026-10-16 参数优化报告](reports/ml-parameter-optimization-20261016.md)。

模型训练层的后续优化使用180天归档、共享成交引擎标签、三窗口 LightGBM 搜索与验证早停、独立概率校准，以及 Chronos 区间校准和消融。执行入口为 `powershell -File scripts/improve-ml-model.ps1`；阶段计划、验收门槛与状态文件见 [模型优化计划](docs/ml-model-improvement-plan-20261016.md)。候选验证不修改 Demo 配置。

全币种月度 ML 流程使用 Rust 采集 Binance USDT 合约的官方公开归档或公共 REST 历史行情与辅助指标，以 Chronos-Bolt-Tiny 预测、LightGBM 分类决策，并按共同时间边界清除标签泄漏。运行 `powershell -File scripts/train-monthly-model.ps1` 顺序完成采集、预测校准与训练；参数及模型接口见 [月度模型流水线](docs/ml-monthly-pipeline.md)。本轮已完成 869 个合约训练和回放，分类准确率小幅提高但成本后亏损；模型评估仍保留 `research_only`，Demo 执行由独立运行开关控制。实际指标见 [最终评估](reports/ml-global-monthly-evaluation-20261015.md)。

Windows 本机已经安装 Rust 1.99.0、Cargo、rustfmt、Clippy 和 MSVC 构建工具。新机器需先安装 Rust 和 MSVC 构建工具；项目工具链由 `rust-toolchain.toml` 固定。

```powershell
npm install
npm run build
cargo run --locked --bin nofx-server
```

服务默认监听 `http://127.0.0.1:3100`，同时提供 `dist/` 静态页面。读取项目根目录的 `.env` 和现有 `data/` 配置；PostgreSQL 需要先运行。新终端可直接使用 Cargo，尚未刷新 PATH 的旧终端可执行：

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
```

新增后端测试和回测使用 Rust，复用 `nofx_core`。策略管理已提供历史指标补齐与参数组合回测入口，使用共享策略、模拟成交及成本模型；操作与限制见 [历史指标回测说明](docs/indicator-backtest.md)。

PostgreSQL 连接由共享 SQLx 连接池管理，默认最大 12、预热 2 个连接。可在 `.env` 设置 `NOFX_DB_POOL_MAX_CONNECTIONS`（4..1024）、`NOFX_DB_POOL_MIN_CONNECTIONS`（0..最大值）、`NOFX_DB_POOL_ACQUIRE_TIMEOUT_MS`（默认 10000）、`NOFX_DB_POOL_IDLE_TIMEOUT_MS`（默认 600000）、`NOFX_DB_POOL_MAX_LIFETIME_MS`（默认 1800000）和 `NOFX_DB_POOL_TEST_BEFORE_ACQUIRE`（默认 true）；空闲和生命周期超时设为 0 可禁用回收。`NOFX_DB_LOCK_TIMEOUT_MS` 默认 10000，限制 SQL 锁等待。参数在启动时校验，修改后重启生效；每个服务/研究进程各自拥有连接池，最大连接数需计入数据库总预算。`GET /api/database/pool` 与 `/api/health` 的 `databasePool` 返回连接总数、空闲数、使用数和实际配置，查询状态无需占用数据库连接。连接池繁忙或锁等待超时返回 HTTP 503，并发交易冲突返回 409；写操作不会自动重放。

月度全部启用策略的持续研究使用 `nofx-campaign`，自动补齐 12 个代表币种的数据，逐项保存结果并支持断点续跑；后台启动、状态与扩展方式见 [月度研究说明](docs/monthly-campaign.md)。

自动 K 线采集覆盖 `marketSync.symbolsText` 指定的币种（`ALL` 表示全部 Binance USDT 永续合约），同步 `1m / 5m / 15m / 1h / 4h / 1d`、配置周期及启用策略所需的辅助周期。成交额和策略黑名单只影响交易分析；新币的已有历史也会保存，分析仍要求足够且连续的已收盘 K 线。

历史长度不足的币种在分析状态和本轮汇总的 `waitingForHistory` 中显示所需/已有根数，不计为运行失败；同一币种、周期和窗口的失败辅助行情读取在一轮分析中只执行一次。数据断档、过期或请求失败仍保留错误并阻止相应策略执行。

账户写入在进程内先排队再获取数据库连接，跨进程仍由 PostgreSQL 事务锁保护。自动任务遇到连接池繁忙、账户排队超时或数据库锁冲突时显示“等待下一轮重试”，保留上一次成功汇总；其他数据库与行情错误仍显示为失败。连接池状态中的 `accountWriteBusy` 表示账户写入正在进行，`availableCapacity` 表示还能新建的连接数量。

需要采集与分析展示时，可在 `data/config.json` 中设置 `marketSync.dataOnly: true`，或通过 `PUT /api/config` 保存该设置。该模式同步行情并生成只读的策略机会与妖币预测，跳过下单、持仓复核和交易账户同步，也不新增交易分析记录；切换模式后重启服务。`GET /api/history/sync/status` 返回各币种、周期的同步状态和错误明细。`GET /api/automation/status` 的 `analysisMeta` 返回分析阶段、分析次数、行情就绪数量和实际更新时间。

启用策略只决定参与分析的策略。自动执行还要求 `marketSync.dataOnly: false`、`trader.enabled: true`、`trader.dryRun: false` 和 `trader.allowEntryOrders: true`，并完成执行环境的账户同步。`executionStatus` 返回全局执行状态和阻止原因，机会卡片的 `execution` 返回逐币种执行结果；`created` 统计本地订单记录，`submitted` 统计已确认提交到执行目标的订单。活动订单总数量不设上限，旧的 `NOFX_MAX_POSITIONS` 环境变量不再生效；资金、单币冲突和策略显式持仓风控仍生效。每轮新增订单受 `trader.maxNewEntriesPerCycle` 限制。

仓位计算同时满足最小保证金、交易所最小成交额与数量步长、单笔名义仓位上限和可用资金（含手续费预留）。最小成交额之上预留一档数量，避免数量取整后不足；所需规模超过资金或名义仓位限额时仍跳过。建议杠杆导致保证金低于门槛时，在相同名义仓位预算内逐级降低杠杆；即使 1 倍杠杆仍不满足门槛则跳过，不提高风险限额。

接口契约保存在 `src/api/contract.json`，资金流参数保存在 `rust/src/flow_defaults.json`，前端和 Rust 工具直接引用这些静态 JSON 文件，不依赖 `shared/` 目录。前端环境显示与标签格式化保存在 `src/utils/`，交易、分析与配置合并由 Rust API 执行。PM2 使用 `ecosystem.config.json`，原来的 `.cjs` 配置已替换。

免费辅助指标通过 Rust 接入 Binance：OI 数量与金额的多周期变化、主动成交差额/VWAP/成交活跃度、资金费结算信息、全市场账户与大户持仓多空比、盘口失衡与价差。机会和妖币预测卡片显示来源、有效项数及数据时间；新增指标用于辅助证据，原有风控继续生效。只读接口为 `GET /api/market/indicators?symbol=BTCUSDT&interval=1m`。默认每轮最多补齐 30 个候选，并发 3 个币种、总等待上限 15 秒，可通过 `NOFX_INDICATOR_SYMBOLS_PER_CYCLE=0..50` 调整。实现及限制见 [免费行情指标接入说明](docs/free-market-indicators.md)。

运行 `npm run diagnose` 检查 Rust 服务的同步、分析和下单状态；`npm run diagnose -- --pm2` 同时读取保存的 PM2 快照。诊断工具不会发送交易指令，也不会输出 API 密钥。

首次使用 PM2 运行服务时执行 `npm run pm2:start`。更新已运行的服务时执行 `npm run pm2:restart`，该命令先构建前端，再停止 `nofx-api`、编译 Rust 并重新启动。Windows 会锁定正在运行的 `.exe` 文件，因此 Rust 编译必须在服务停止后进行；编译期间 API 暂时不可用。

发布配置保留常规优化，关闭 LTO 并使用 16 个代码生成单元，降低 Windows 编译的峰值内存。内存紧张时可先设置 `$env:CARGO_BUILD_JOBS='1'`；测试可另外设置 `$env:CARGO_PROFILE_TEST_DEBUG='0'` 与 `$env:CARGO_PROFILE_DEV_DEBUG='0'` 降低调试信息占用。

币安实盘与公开合约行情默认使用官方 `https://fapi.binance.com`，Demo 使用 `https://demo-fapi.binance.com`。可用 `BINANCE_FUTURES_BASE` 覆盖实盘地址。公有 GET 请求在连接中断或响应体读取失败时最多尝试三次，重试使用新连接，成功后记录 `Public market request recovered after retry`；最终同步结果查看 `/api/history/sync/status` 的失败数和错误明细。

公开行情请求在进程内共享每分钟 1200 权重的预算，并参考 Binance 返回的 IP 已用权重。429/418 会按 `Retry-After` 或封禁截止时间暂停请求；K 线缓存完整时只补缺少的收盘数据，缺失或断档才重新拉取完整窗口。只读分析在实时接口失败时可使用本地缓存，卡片显示实际数据时间与“等待实时数据确认”；交易执行继续要求最新行情。
