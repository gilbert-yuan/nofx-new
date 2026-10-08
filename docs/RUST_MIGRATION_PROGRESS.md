# Rust 后端迁移进度与续接记录

更新时间：2026-10-08。任务已完成。原生发布构建及运行参数检查均通过，续接自动化 `rust` 已停用；无需重复迁移。

## 用户授权与范围

- 全部后端替换为原生 Rust，保持 Vue 前端；后续新增测试及回测必须采用 Rust。
- 已有回测脚本删除，不迁移，不新增 Rust 离线回测命令。
- 已授权三名子代理并行；三名代理此前因额度停止，最终收尾由主代理接手。
- 不执行真实交易，不用生产配置启动自动交易验证，不覆盖现有生产数据。

## 已完成

- 本机安装 Rust 1.99.0（MSVC）、Cargo、rustfmt、Clippy、VS2022 C++ Build Tools 和 Windows SDK，持久化用户 PATH。
- 根 Cargo 工程、锁文件、工具链固定和 `scripts/setup-rust.ps1`。
- 原生 API / store / PostgreSQL / exchange / research / automation / 七策略 / simulator / paper / ledger / flow / statistics / replay / spot 全部接通。
- 分批止盈按策略对应入场数量同步，持久化请求 ID 并查询不明响应，不重复发送；保护单替换先确认新单，价格穿越时触发紧急减仓。
- 自动任务加入流动性、盘口、特征筛选、评分仓位、杠杆与保证金约束，修正辅助行情窗口复用和重复复核。
- 活跃订单/账户同步使用轻量读取，单笔已结束订单链接可定向读写；未知历史扩展字段保留。
- 删除 156 个旧回测相关文件，恢复归档 `output/rust-migration/removed-backtest-scripts.zip`。
- 移除额外 228 个旧后端/测试/辅助工具文件（93 server / 41 tests / 85 scripts / 7 shared / 2 root），恢复归档 `output/rust-migration/legacy-node-backend.zip`，清单同目录 txt。行情数据、策略配置、研究报告保留。
- 根 npm 命令默认调用 Rust；PM2 使用原生发布程序；旧 Express / cors / pg / dotenv / undici 直接依赖移除并更新锁文件，实际卸载 85 个不再使用的 Node 包。
- README、docs/RUST_BACKEND.md、overview.md、AGENTS.md 及旧快速指南迁移说明已更新。
- Rust 单元测试 38 通过，内含 171 个旧实现固定对照样例。旧 JS 仅曾用于提取不可变 JSON fixtures，运行后端与测试不依赖 JS。
- 两个需要 PostgreSQL 的隔离集成测试均通过：独立测试库与空配置 HTTP 服务；本地模拟交易所的签名、不重复发送、共享持仓部分平仓及保护单替换。
- 已用只读查询核对现有 PostgreSQL 表字段与 Rust 要求；未写生产账户/订单。
- 清理一次早期失败留下的唯一 `nofx_rust_test_<uuid>` 数据库，专用测试库剩余数量为 0。
- cargo fmt / check / strict Clippy / test 和 Vite 前端构建已通过。最新源代码 release 构建已通过，原生程序 --version / --help 可运行，版本 0.1.0。

## 交付状态

全部改造及验证完成；现有生产进程尚未重启，正常发布时执行 `npm run pm2:restart` 切换至 Rust。代码未提交或推送。持续目标已完成，续接已停用。

## 续接提示

工作目录 D:\UGit\nofx-new。旧 Codex 进程 PATH 可能需要 `$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"`。不要打印 `.env`、API 密钥或数据库口令。CodeGraph 索引可能包含已删除旧文件，核对当前文件；不擅自重建索引。