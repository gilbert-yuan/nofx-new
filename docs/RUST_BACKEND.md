# 原生 Rust 后端

当前后端入口为 `rust/src/main.rs`，Cargo 包位于项目根目录，库名为 `nofx_core`。后端运行时不调用 Node.js、Python、JavaScript 引擎或旧 Express 服务。

## 环境与启动

Windows 使用 `x86_64-pc-windows-msvc` 工具链，版本固定为 Rust 1.99.0。本机已经安装 Rust、Cargo、rustfmt、Clippy、Visual Studio C++ Build Tools 和 Windows SDK。

```powershell
# 在新机器安装，已安装时复用现有工具链
npm run setup:rust

# 前端静态资源与原生发布程序
npm run build
npm run build:server

# 一条命令构建并启动
npm start

# Rust 开发服务；自动构建前端
npm run dev

# Rust 与 Vue 热更新开发
npm run dev:hot
```

发布程序为 `target/release/nofx-server.exe`。可以不经 npm 启动：

```powershell
.\target\release\nofx-server.exe --root D:\UGit\nofx-new --host 127.0.0.1 --port 3100
```

服务使用现有 `.env`、`data/config.json`、`data/strategy.json`、`data/strategies.json` 和 PostgreSQL。优先使用 `DATABASE_URL`，也支持 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSWORD`、`PGSSL`。`HOST` 默认 `127.0.0.1`、`PORT` 默认 `3100`、`DATA_DIR` 默认 `data`。

保持既有自动交易配置。默认启动后五秒启动全局自动任务；需要手动启动时设置 `NOFX_AUTOSTART=0`。市场扫描与持仓复核是两个可配置任务，账户观察在后台定期同步。

PM2 的 `nofx-api` 现在执行 Rust 发布程序，`interpreter: 'none'`；`npm run pm2:start` 和 `npm run pm2:restart` 会先构建前端和 Rust。修改完成后尚未重启现有生产进程，因此需要正常发布重启后才切换正在运行的服务。

## 实现范围

| 模块 | Rust 源码 |
| --- | --- |
| API、静态资源、配置与研究记录 | `api.rs`、`store.rs`、`research.rs` |
| PostgreSQL 规范化账户与行情 | `db.rs` |
| 七个注册策略、复核与预测 | `strategies.rs`、`strategies/` |
| 模拟成交、成本、部分止盈、移动保护与清算 | `simulator.rs` |
| 统一资金池、挂单、平仓、交易所保护单 | `paper.rs` |
| Binance USD-M 签名接口与账户成交账本 | `exchange.rs`、`ledger.rs` |
| Binance Spot Demo 历史成交及 FIFO 盈亏 | `spot.rs` |
| 自动任务、流动性、特征筛选与评分仓位 | `automation.rs`、`automation_guards.rs` |
| 流向分析、统计、适应性筛选、订单重放 | `flow.rs`、`analytics.rs`、`analytics/` |

已有数据库的未识别嵌套扩展字段仍完整保留。活跃订单刷新与单笔交易链接更新避免每次搬运全部历史分析与复核明细。策略平仓按对应入场成交数量分配，不会因一个策略退出就清空其他策略的共享持仓。交易写入只发送一次；超时或响应不明时持久化请求 ID，并通过查询确认，防止重复发送。

## 验证

```powershell
cargo fmt --all -- --check
cargo check --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all-targets

# 需要本机 PostgreSQL。自动新建并删除专用测试库，测试服务使用空配置；
# 交易生命周期测试仅请求本地模拟交易所。
cargo test --locked --all-targets -- --ignored --nocapture

npm run build
```

普通测试覆盖策略对照、成交成本、清算边界、连续行情、资金费分配、共享持仓退出、签名与请求不重发。171 个固定旧实现对照样例存于 Rust JSON fixtures，由 Rust 测试加载；测试和服务均不再需要旧 JavaScript 后端。隔离集成测试验证 HTTP 响应、PostgreSQL 往返、未知扩展字段、统计、SPA 路由、部分平仓及保护单替换。

未使用实际交易所账户发送订单，也未使用生产数据库进行交易烟雾验证。外部交易所、代理和 AI 服务的实际可用性取决于本机配置与网络。

## 旧代码与后续开发

旧回测脚本及相关工具已移除，原始恢复归档为 `output/rust-migration/removed-backtest-scripts.zip`。旧 Node 后端 93 个文件、41 个测试及旧辅助工具已移除，恢复归档为 `output/rust-migration/legacy-node-backend.zip`；同目录文本清单列出全部条目。没有删除现有行情数据、策略配置或研究报告。

前端源码继续使用 JavaScript；`shared/` 保留前端所需的 API 路径、环境判定、平仓理由及流向分析默认值。Node 依赖仅承担前端和开发/进程工具，Express、cors、pg、dotenv、undici 已从项目直接依赖移除。

新增测试放在 Rust 模块或 `rust/tests/`。后续需要回测时，在 `rust/src/bin/` 注册 Rust 工具并复用 `nofx_core::simulator`、策略和成本规则；本次按用户要求只删除旧回测脚本，没有迁移这些命令。

其他文档中的旧 Node 后端路径、回测命令和历史检查结果属于迁移前记录。当前启动和验证以本文件与根目录 README 为准。
