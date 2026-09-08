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

币安页面只需要 API Key 和 Secret Key，支持合约测试网或正式网。保存后才生效，测试连接和立即复核均使用已保存配置。切换交易所的首次启动会关闭自动执行并恢复模拟指令，保留原密钥和风控数值。启用后，仅在 15 分钟同步结束时复核；每币种每根 K 线的执行标记会持久化，以避免重启后的重复提交。

当前实现支持 USDT 永续、单向持仓；发现双向模式时停止复核，不自动更改账户模式。开仓量使用基础币数量并按 MARKET_LOT_SIZE 取整，价格按 PRICE_FILTER 处理。开仓评估单仓/总仓名义价值、已有持仓和挂单。止盈止损使用 Binance Algo Order API 的 STOP_MARKET / TAKE_PROFIT_MARKET、MARK_PRICE 和 closePosition。

保护单更新先创建新单、后取消旧单，无法确认时保留错误供用户检查。系统不会覆盖手动条件单。新开仓成交后如保护单失败，会立即发送只减仓平仓指令并记录错误。订单或平仓返回未全部成交时标记需核对，不自动重发原指令。

`npm run check`、`npm test`、`npm run build` 可执行本地验证；`RESEARCH_DB_TEST=1` 可启用 PostgreSQL 隔离事务测试。单元测试使用伪客户端，不会向交易所发单。实盘成交和保护单触发尚需账户环境下验证。

参考：[币安 USD-M 交易 API](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade)。
