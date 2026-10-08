# NOFX

后端使用原生 Rust（Axum / Tokio / PostgreSQL），前端保留 Vue / Vite。API、策略分析、模拟成交、订单复核、交易所同步和自动任务均在 Rust 中运行。

Windows 本机已经安装 Rust 1.99.0、Cargo、rustfmt、Clippy 和 MSVC 构建工具。新机器可运行 `npm run setup:rust`；项目工具链由 `rust-toolchain.toml` 固定。

```powershell
npm install
npm run build
cargo run --locked --bin nofx-server
```

服务默认监听 `http://127.0.0.1:3100`，同时提供 `dist/` 静态页面。读取项目根目录的 `.env` 和现有 `data/` 配置；PostgreSQL 需要先运行。新终端可直接使用 Cargo，尚未刷新 PATH 的旧终端可执行：

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
```

完整启动、测试、PM2 部署与迁移说明见 [Rust 后端说明](docs/RUST_BACKEND.md)。新增后端测试和回测使用 Rust，复用 `nofx_core`。旧回测脚本已经删除，本次没有新增离线回测命令。

自动 K 线采集覆盖 `marketSync.symbolsText` 指定的币种（`ALL` 表示全部 Binance USDT 永续合约），同步 `1m / 5m / 15m / 1h / 4h / 1d`、配置周期及启用策略所需的辅助周期。成交额和策略黑名单只影响交易分析；新币的已有历史也会保存，分析仍要求足够且连续的已收盘 K 线。

需要采集与分析展示时，可在 `data/config.json` 中设置 `marketSync.dataOnly: true`，或通过 `PUT /api/config` 保存该设置。该模式同步行情并生成只读的策略机会与妖币预测，跳过下单、持仓复核和交易账户同步，也不新增交易分析记录；切换模式后重启服务。`GET /api/history/sync/status` 返回各币种、周期的同步状态和错误明细。`GET /api/automation/status` 的 `analysisMeta` 返回分析阶段、分析次数、行情就绪数量和实际更新时间。

接口契约保存在 `src/api/contract.json`，资金流参数保存在 `rust/src/flow_defaults.json`，前端和 Rust 工具直接引用这些静态 JSON 文件，不依赖 `shared/` 目录。前端环境显示与标签格式化保存在 `src/utils/`，交易、分析与配置合并由 Rust API 执行。PM2 使用 `ecosystem.config.json`，原来的 `.cjs` 配置已替换。

运行 `npm run diagnose` 检查 Rust 服务的同步、分析和下单状态；`npm run diagnose -- --pm2` 同时读取保存的 PM2 快照。诊断工具不会发送交易指令，也不会输出 API 密钥。

首次使用 PM2 运行服务时执行 `npm run pm2:start`。更新已运行的服务时执行 `npm run pm2:restart`，该命令先构建前端，再停止 `nofx-api`、编译 Rust 并重新启动。Windows 会锁定正在运行的 `.exe` 文件，因此 Rust 编译必须在服务停止后进行；编译期间 API 暂时不可用。

币安实盘与公开合约行情默认使用官方 `https://fapi.binance.com`，Demo 使用 `https://demo-fapi.binance.com`。可用 `BINANCE_FUTURES_BASE` 覆盖实盘地址。公有 GET 请求在连接中断或响应体读取失败时最多尝试三次，重试使用新连接，成功后记录 `Public market request recovered after retry`；最终同步结果查看 `/api/history/sync/status` 的失败数和错误明细。

公开行情请求在进程内共享每分钟 1200 权重的预算，并参考 Binance 返回的 IP 已用权重。429/418 会按 `Retry-After` 或封禁截止时间暂停请求；K 线缓存完整时只补缺少的收盘数据，缺失或断档才重新拉取完整窗口。只读分析在实时接口失败时可使用本地缓存，卡片显示实际数据时间与“等待实时数据确认”；交易执行继续要求最新行情。
