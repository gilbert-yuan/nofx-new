# 模拟挂单同步 Binance Demo 交付概览

## 工程约定：回测脚本统一使用 Node.js

- 本项目的回测工具链统一使用 Node.js，脚本存放于 `scripts/`，扩展名使用 `.js`、`.mjs` 或 `.cjs`。
- 回测应复用 `server/tradingSimulator.js`、现有策略分析模块与共享成本模型，保证研究、回测与运行时口径一致。
- 不得因不同模型、代理或执行环境而使用 Python、Shell 或其他语言重写回测逻辑；发现问题时直接修复对应的 Node.js 回测脚本并完成 Node.js 校验。
- `python_app/` 是独立桌面应用，不承担回测职责。

## 策略配置与回测架构

- data/strategies.json 使用 v2 结构：每个策略记录自己的 enabled、完整 params 和 notes；旧版顶层 enabled/overrides/notes 会在新服务首次读取时自动迁移。
- server/strategies/registry.js 负责注册表和参数校验，server/strategies/builtins.js 负责把正式分析、计划装饰和持仓复核绑定成策略定义；新增策略只需注册定义并提供参数 schema。
- 下单时会把策略 id 与完整参数写入订单 analysisContext，后续即使策略停用或配置改变，存量订单仍按自己的配置快照复核。
- scripts/_bt_run.mjs 与 scripts/_bt_structure_run.mjs 通过 server/strategies/loader.js 直接加载正式注册策略的 analyze/decoratePlan/review，回测结果同时记录策略 id 和完整参数。

示例：

~~~bash
BT_STRATEGY=enhanced-trend-v1 node scripts/_bt_run.mjs 0GUSDT.ndjson
BT_STRATEGY=structure-short-v1 BT_SYMBOLS=0GUSDT node scripts/_bt_structure_run.mjs
~~~

## 已完成
- 新建模拟限价挂单后，自动向 Binance Demo Trading 提交同价 GTC LIMIT 单。
- 同步范围仅限新创建、具备有效 `entryLimit` 的 pending 订单，不会批量重放历史模拟订单。
- 本地订单先落库，再异步提交远端订单；远端失败会记录 `submit_error` 和错误信息，不产生无审计的本地状态。
- 模拟订单取消、过期或账户关闭时，会尝试取消对应的 Binance Demo 远端订单。
- 增加交易所过滤器对齐，提交前按 Demo 的 `PRICE_FILTER`、`LOT_SIZE`、`MIN_NOTIONAL` 校正价格和数量，并先设置杠杆。
- 前端增加“模拟挂单同步到 Demo”配置项，只有 Demo 环境可用。

## 当前配置
- Binance：Demo Trading，`demo=true`、`testnet=false`
- 自动交易：`trader.enabled=true`、`dryRun=false`
- 模拟挂单同步：`syncPaperOrdersToDemo=true`
- PM2：`nofx-api` online
- 健康检查：`http://127.0.0.1:3100/api/health` 返回 `{"ok":true,"name":"nofx-lite"}`

## 验证
- `server/simulatedAccount.js` 语法检查通过
- Binance 与模拟账户定向测试：26 个用例，23 个通过，0 个失败，3 个跳过
- 此前完整回归：184 个用例，173 个通过，0 个失败，11 个跳过
- Vite 构建通过
- PM2 重启后服务恢复在线

## 注意
- 订单只会发送到 Binance Demo，不会发送到实盘。
- 代码改动当前尚未提交或推送。
