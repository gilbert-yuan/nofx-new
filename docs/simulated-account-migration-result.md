# 本次迁移结果

迁移目标：当前 API 使用的 PostgreSQL 数据库，public schema。

- 已正式执行 `npm run migrate:simulated-account -- --apply`。
- 切换快照：144 笔订单、401 条复核记录、82 条保护价格修订。
- 自动化 scan/review 状态完整迁移，任务列表共 483 项。
- 原始数据备份：`public.simulated_account_legacy_v1`。
- 新存储：17 张业务/兼容表及 1 张迁移记录表；均无 JSON/JSONB 列。
- 逐字段重建校验：完整账户对象相等；账户资金和盈亏汇总相等。
- 快照 SHA-256：`dd187f3e4e07af70b33abe8aed27816ec0d6ac7ffc930a4ba780c278d5121dc9`。

迁移前停止 API，事务完成并比对后重新启动 API，恢复此前开启的全局调度。
恢复后检查时，新表已累计到 154 笔订单、416 条复核、85 条保护修订，
原备份仍为 144 笔订单，证明运行时写入已切换到新表。

账户、统计、可执行计划、自动化状态、分析记录和健康检查接口均返回 HTTP 200。

验证：全套测试 80 通过、0 失败、4 跳过（其中本次关系表数据库测试已启用）；
另外启用数据库环境运行账户/迁移专项测试，15 项全部通过，无跳过。
所有服务端 JavaScript 语法检查通过。

回退和表关系说明见 `simulated-account-migration.md`；完整建表定义见
`simulated-account-schema.sql`。备份不会跟随新交易更新，不能直接替换当前账本。
