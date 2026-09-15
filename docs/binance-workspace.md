# 币安工作台

启动：`npm run pm2:start`。前端 http://127.0.0.1:5173，API http://127.0.0.1:3000。

## 数据来源与独立操作

- `GET /api/market/symbols`：币安正式网 exchangeInfo 中可交易的 USDT 永续合约，缓存一小时；不依赖账户密钥或市值排名。
- `POST /api/market/symbols/refresh`：强制刷新合约列表，不拉取 K 线。
- `GET /api/market/symbols/status`：列表数量、更新时间和错误。
- `GET /api/market/klines?symbol=BTCUSDT&interval=15m&limit=80`：单独获取 K 线，不请求币种列表。
- `POST /api/history/fetch`：批量拉取与落库，共享定时同步锁，不触发交易；忙时返回 409。
- `GET /api/history/sync/status`：当前进度、错误、下次运行时间；只显示币安同步状态。

正式网行情以 BINANCE_ 前缀保存。测试网持仓分析使用测试网行情，并以 BINANCE_TESTNET_ 保存。原 OKX / Bybit 数据保留，币安策略表现排除旧交易所的信号，不混用价格。

## 交易设置

币安页面现在为两个环境分别保存凭证：`demoApiKey/demoSecretKey` 对应 Binance Demo Trading，`liveApiKey/liveSecretKey` 对应 USDⓈ-M 实盘。顶部的“手动操作环境”只决定账户快照、持仓、挂单、手动下单和测试连接按钮使用哪一套凭证；旧配置里的 `apiKey/secretKey` 仍会按当前环境兼容迁移，`testnet` 也会继续作为 `demo` 的兼容别名。

按照当前 USDⓈ-M Futures 文档，Demo REST 基址是 `https://demo-fapi.binance.com`，正式环境官方基址是 `https://fapi.binance.com`；本项目在受限网络下默认使用同一合约 API 的官网边缘路由，仍可用 `BINANCE_FUTURES_BASE` 覆盖。保存后才生效，测试连接和立即复核均使用已保存配置。创建 API Key 时建议只开启必要的读取/交易权限并限制 IP，实盘 Key 不要开启提现权限，绝不把 Secret Key 放到前端或提交到仓库。

交易配置页的“账户与订单操作”提供以下按钮：

- “刷新账户快照”：调用签名账户接口，显示钱包余额、持仓数量和单向/双向模式。
- “刷新持仓”：调用 USDⓈ-M `positionRisk`，显示当前非零仓位；单向模式下可发起只减仓市价平仓。
- “刷新挂单”：调用 `openOrders`，逐笔撤销未成交订单。
- “提交限价/市价订单”：调用 `POST /fapi/v1/order`；市价单、实盘单和只减仓单都会先弹出浏览器确认。
- “运行冒烟测试”：仅允许 Demo 环境，执行远价限价单 → 查询挂单 → 撤单 → 再查询，避免把冒烟请求发到实盘。

所有账户、订单和持仓按钮都由服务端签名后访问币安，前端只发送业务参数，不接触 Secret Key。手动下单不会因为“仅生成模拟指令”开关而变成纸面订单，仍以页面顶部的 Demo/实盘环境为准。

### 模拟单异步同步

设置页的“同步模拟单”开关分别控制 Demo 和实盘，互不依赖。每个环境都必须同时配置自己的 API Key、Secret Key 并保存；没有勾选的环境不会访问 Binance，也不会产生远端订单。两个开关同时开启时，同一笔模拟订单会在两个账户各生成一笔独立的远端订单，请只在明确需要双账户镜像时启用实盘开关。

模拟下单接口只负责写入本地模拟订单并立即返回，不等待交易所网络。后台队列随后异步执行：

- 模拟开仓提交为 Binance USDⓈ-M GTC 限价单，并按对应环境的 `exchangeInfo` 对齐价格、数量和最小名义价值。
- 入口单提交后用 `/fapi/v1/order` 查单，把 `NEW`、`PARTIALLY_FILLED`、`FILLED`、撤单和错误状态写回模拟订单的 `exchangeSync.demo` / `exchangeSync.live`。
- 模拟分批止盈、最终止盈、止损、超时和手动平仓会创建对应的只减仓市价单；平仓数量按远端入口成交数量与模拟成交比例换算。
- 每个环境使用不同的 `clientOrderId` 前缀（`nofxpaper...` / `nofxlive...`），503 或网络超时不会盲目重复下单，而是先按 client order id 查单，确认未知执行状态后再决定是否重试。
- 队列错误只记录在同步元数据中，不改变模拟撮合、K 线推进、账户结算或接口响应。服务重启后会从数据库恢复尚未确认的同步状态。

远端状态会随模拟订单一并返回：`exchange` 是 Demo 兼容别名，完整状态在 `exchangeSync.demo` 和 `exchangeSync.live`；其中的 `closeOrders` 记录每次分批/最终平仓的远端订单号、成交数量、状态、重试时间和最后错误。

切换交易所的首次启动会关闭自动执行并恢复模拟指令，保留原密钥和风控数值。启用后，仅在 15 分钟同步结束时复核；每币种每根 K 线的执行标记会持久化，以避免重启后的重复提交。

当前实现支持 USDT 永续、单向持仓；发现双向模式时停止复核，不自动更改账户模式。开仓量使用基础币数量并按 MARKET_LOT_SIZE 取整，价格按 PRICE_FILTER 处理。开仓评估单仓/总仓名义价值、已有持仓和挂单。止盈止损使用 Binance Algo Order API 的 STOP_MARKET / TAKE_PROFIT_MARKET、MARK_PRICE 和 closePosition。

保护单更新先创建新单、后取消旧单，无法确认时保留错误供用户检查。系统不会覆盖手动条件单。新开仓成交后如保护单失败，会立即发送只减仓平仓指令并记录错误。订单或平仓返回未全部成交时标记需核对，不自动重发原指令。

`npm run check`、`npm test`、`npm run build` 可执行本地验证；`RESEARCH_DB_TEST=1` 可启用 PostgreSQL 隔离事务测试。单元测试使用伪客户端，不会向交易所发单。实盘成交和保护单触发尚需账户环境下验证。

参考：

- [USDⓈ-M Futures Introduction](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/Introduction)
- [USDⓈ-M Futures Quick Start](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/quick-start)
- [USDⓈ-M Futures General Info](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info)
- [币安 USD-M 交易 API](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade)
- [USDⓈ-M Futures User Data Streams](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/user-data-streams)
