# 项目约定

## CodeGraph

项目根目录存在 `.codegraph/` 时，理解或定位代码前先使用 `codegraph explore "符号或问题"` 或可用的 `codegraph_explore` MCP 工具。没有索引时跳过，不主动建立索引。迁移后索引可能包含已删除的旧代码，应核对实际文件。

## 后端、测试与回测工具链

- 后端使用 **Rust**，Cargo 工程位于项目根目录，源代码位于 `rust/src/`；使用根目录 `rust-toolchain.toml` 固定的工具链。
- 所有新增、修复或重构的后端测试、回测及策略优化必须使用 **Rust**，测试放在 Rust 模块或 `rust/tests/`，可执行工具放在 `rust/src/bin/` 并在 `Cargo.toml` 注册。
- 回测必须复用 Rust 交易模拟引擎、策略分析模块与共享成本模型；在线模拟与离线回测使用同一套成交、成本、风控和出场规则。
- 修改后执行 `cargo fmt --check`、`cargo check --all-targets`、`cargo test --all-targets` 及适用的接口/回测验证；不得用 Python、Node.js 或 Shell 重写另一套回测逻辑。
- Vue 前端及其构建仍使用 Node.js。原有 JavaScript 后端与回测代码已经移除，迁移对照使用固定 JSON fixtures；后端和测试不得依赖 Node.js 业务实现。
- Python 目录仅服务于独立桌面应用；它不是回测工具链的一部分。不要在其中新增回测实现。

