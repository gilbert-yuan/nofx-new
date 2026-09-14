# 模拟挂单同步 Binance Demo 交付概览

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
