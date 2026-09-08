# 模拟账户关系表迁移

应用现在通过 `server/simulatedAccountRepository.js` 读写关系表。原来的
`simulated_account.state` 不再作为运行时账本。HTTP 返回的对象形状保持兼容，
前端仍可读取账户、订单、计划和复核历史，但它们不再作为一个 JSON 写入数据库。

## 表结构

所有业务表使用 `account_id` 关联账户；订单子表通过 `(account_id, order_id)`
外键关联订单，并支持级联删除。金额和价格使用 DOUBLE PRECISION，保持原系统
JavaScript Number / JSON 数值的精度；本次迁移不做小数位截断。时间字段使用
TIMESTAMPTZ，K 线游标和任务时间保留原毫秒数。

| 表 | 内容 |
| --- | --- |
| simulated_accounts | 初始余额、无限资金开关 |
| simulated_orders | 一行一个订单：方向、状态、保证金、杠杆、成交、盈亏、行情游标等独立列 |
| simulated_order_plans | 当前计划、初始计划和原分析计划；入场范围、止盈止损和期限独立列 |
| simulated_order_costs | 手续费、滑点、资金费假设 |
| simulated_order_analysis | 策略版本、分析引擎、置信度、原因、风险、自动分析批次 |
| simulated_order_signals | 原始分析信号的方向、有效性、时间和文本字段 |
| simulated_order_scopes | 分析周期、数量、引擎和批次大小 |
| simulated_order_scope_symbols | 分析范围中的币种，一行一个 |
| simulated_order_validation_issues | 上下文/信号的校验问题，一行一条 |
| simulated_order_protection_revisions | 每次保护价格修改及其生效时间 |
| simulated_order_reviews | 每次复核、动作、原因及修改前后的价格 |
| simulated_automation_settings | 自动化启用状态、引擎、保证金、周期 |
| simulated_automation_jobs | scan/review 各自的进度、计数、下次执行时间和任务租约 |
| simulated_automation_symbols | 任务的有序币种或订单 ID 列表 |
| simulated_automation_errors | 任务错误，一行一条 |
| simulated_account_extensions / simulated_order_extensions | null、空对象/数组的结构标记，以及少量未列入业务列的扩展标量；每行一个属性路径/值，不保存整段 JSON |
| simulated_account_migrations | 迁移版本、时间、原订单数及完整数据 SHA-256 |

新表不含 JSON/JSONB 列。扩展表只用于无损兼容可选属性，主要交易字段全部在
具名业务列中。新增稳定业务字段应添加到 repository 的字段映射，而非长期依赖扩展属性。

## 迁移命令

连接配置与 API 共用 MarketDb 的环境变量，支持 DATABASE_URL 或 PG* 配置。
不会使用旧脚本中硬编码的数据库地址。

```powershell
# 预演：在事务中建表、复制、逐字段验证，最后全部回滚
npm run migrate:simulated-account -- --dry-run

# 正式切换前停止 API/所有旧账本写入程序
npm run pm2:stop
npm run migrate:simulated-account -- --apply
npm run pm2:start
```

迁移在同一事务中锁定原表，复制所有数据，重新组装完整账户并执行深度相等校验。
任何复制或校验失败会回滚全部改动。成功后原表改名为
`simulated_account_legacy_v1`，作为切换时的原始备份保留；旧程序继续访问旧表名
会明确报错，避免出现两份账本分别更新。再次执行迁移只报告已完成，不重新导入备份。

旧的 `paper_orders`、`paper_account_config` 及相关试验脚本不是这次迁移的目标，
这些旧表不删除、不覆盖，运行中的 SimulatedAccount 不再依赖它们。
请使用上述新命令，不使用 `migrate-to-optimized-schema.js` 进行本次迁移。

## 写入与一致性

- 事务先锁定账户行，再读取、执行变更、比对新旧关系行，只插入/更新/删除变化的行。
- 余额预留、订单去重、自动化租约、复核状态仍处于同一事务，不会因拆表失去原子性。
- 查询使用 REPEATABLE READ 的只读事务，避免跨表拼出不同提交时刻的数据。
- 为兼容既有自动化回调，`mutate` 仍在内存中组装账户；本次消除了整块 JSON 写放大，
  尚未将所有业务操作改成独立的 SQL 命令或服务端分页，不能视为无限订单规模优化。

## 验证

```powershell
$env:SIMULATED_DB_TEST='1'
$env:RESEARCH_DB_TEST='1'
node --test tests/simulatedAccountRepository.test.js tests/simulatedAccount.test.js
```

数据库测试在随机命名的独立 schema 中运行，结束后只删除该测试 schema。
覆盖无损迁移、dry-run 回滚、重复迁移、非法源数据回滚、并发更新、SQL 失败回滚、
未变更订单不写入、复核子记录、订单级联删除和 HTTP 下单/取消/刷新。

## 回退原则

保留 `simulated_account_legacy_v1`，不要在系统已产生新交易后直接改名覆盖回去，
否则会丢失切换后的交易。需要回退时先停止所有写入，用 repository.read() 导出
当前完整状态并核对，再将该最新状态写入旧结构、部署匹配旧结构的程序。
备份仅代表迁移时刻，不能代替迁移后的最新账本。
