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
