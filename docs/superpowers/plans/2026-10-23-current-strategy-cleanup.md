# Current Strategy Cleanup Implementation Plan

> **For agentic workers:** Execute the checked tasks in this session using the available collaboration tools; review the integrated result before completion.

**Goal:** 精简为当前山寨直接突破策略，删除其他策略的定制实现、离线工具和界面入口，保持当前策略的经济行为。

**Architecture:** 仅注册`altcoin-trend-breakout-live-v1`，默认参数EMA25/75、通道8、初始1 ATR、跟踪3 ATR；同算法旧研究ID只作为历史回放输入兼容。保留共享撮合、成本、仓位、风控、历史行情与资金费采集，回测复用现有Rust引擎。历史结果和账户数据不清理，运行中的Demo二进制不在代码精简过程中替换。

**Tech Stack:** Rust/Cargo、Vue/Vite、现有PostgreSQL与本地JSON Store。

**Spec:** 用户本轮“删除与当前策略无关的策略定制代码…包括回测部分”及项目AGENTS.md。

## Global Constraints

- 所有后端、回测及测试使用Rust，保留共享成交、成本、风控与出场规则。
- 不覆盖原有未提交改动；针对本轮删除对象保留可恢复快照及清单。
- 不删除数据、账户记录或历史报告，不更改当前Demo参数/启用状态，不启动竞争服务。
- 不将ML命名的数据归档组件误删：当前回测需要的真实资金费、标记价与K线采集继续保留。

## Review Focus

- 注册表只出现当前策略，缺省与恢复默认均为25/75、8、1、3。
- 当前策略的信号、冻结参数、成交、资金费、仓位与权益曲线不变。
- 旧研究A输入仍可重放；B回踩及其他策略输入不再作为可执行策略。
- 删除ML/其他策略模块后所有接口、前端导入、Cargo目标和fixture引用可编译。
- 通用订单管理及历史订单显示继续工作，未知历史策略不会阻断共享止损或手动平仓。

## Tasks

- [x] 保存变更前源码清单、当前参数与当前策略回放参考。（`git show d460dcb` 为删除前快照；参考回放 = output/altcoin-new-window-full-winner-20261023）
- [x] 精简策略注册、分派、配置缺省、专用实现与专用fixture；加入单策略注册及旧输入边界测试。
- [x] 删除旧ML/Yao/Martin/H4/CQS/结构/Regime策略工具和模块，保留当前回放、验证、数据归档与通用诊断工具；精简当前回测的旧B与专用搜索分支。
- [x] 清理自动化、API、执行层和前端中的旧策略专用分支、入口与脚本，保留共享账户/撮合/成本/风控。
- [x] 执行`cargo fmt --check`、`cargo check --all-targets`、`cargo test --all-targets`、Vue构建、当前策略回放及Rust经济等价验证。
- [x] 审核删除清单、统计代码减少、记录保留范围和验证结果，核对线上仍为既有Demo参数。（见 reports/current-strategy-cleanup-20261023.md）

不创建提交，不在本轮重启或替换当前在线二进制。验证通过后交付本地代码与精简说明。
