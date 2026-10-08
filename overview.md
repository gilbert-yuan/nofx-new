# Rust 后端迁移概览

2026-10-08 起，后端为原生 Rust，Vue 前端保持原有实现。启动、测试和 PM2 部署以 [Rust 后端说明](docs/RUST_BACKEND.md) 为准。

- 本机已安装 Rust 1.99.0、Cargo、rustfmt、Clippy、MSVC Build Tools 和 Windows SDK。
- API、PostgreSQL 规范化账户、市场行情、七个正式策略、流向分析、模拟成交、账户账本和自动交易执行均使用 Rust。
- 新增后端测试、回测和策略优化必须使用 Rust，并复用 `nofx_core`。
- 旧回测脚本已经删除。本次没有迁移旧回测命令；行情数据、策略配置和研究报告保留。
- 旧 Node 后端、旧 Node 测试和辅助工具已经移除，恢复归档位于 `output/rust-migration/`。
- 默认启动为 `npm run dev`；发布构建为 `npm run build:server`，PM2 执行 Rust 发布程序。
- 本次验证只使用独立测试数据库与本地模拟交易所，没有重启现有生产进程或发送真实订单。

代码结构与回归范围见 [README](README.md) 和 [Rust 后端说明](docs/RUST_BACKEND.md)。