# OKX 行情连接故障

`Unable to reach OKX /api/v5/market/candles: fetch failed` 表示请求未取得 HTTP 响应，不能据此判断是币种不存在或交易所限流。

客户端现在保留底层错误码和连接方式，例如 `fetch failed (proxy; ECONNRESET)`。`ECONNREFUSED` 表示连接被拒绝，`EHOSTUNREACH` 表示目标不可达，`UND_ERR_CONNECT_TIMEOUT` / `TimeoutError` 表示超时。代理模式下，故障也可能发生在代理到 OKX 的链路。

公共 GET 请求遇到指定的临时网络错误时，最多请求 3 次，两次等待分别为 500ms、1000ms，每次请求超时仍为 30 秒。持续故障时仍会向调用方报错，不会使用旧行情冒充最新行情。签名请求（包括下单、平仓和修改保护单）不会自动重试；HTTP/API 业务错误及证书错误也不会重试。

代理配置在创建客户端时读取，优先级为：

1. `OKX_PROXY_URL`：可指定 OKX 专用代理，空字符串表示直连。
2. `HTTPS_PROXY`，其次 `HTTP_PROXY`。
3. 默认 `http://127.0.0.1:7890`，保持原有行为。

当前 `ecosystem.config.cjs` 显式设置了 7890 代理。若服务运行在另一台服务器，127.0.0.1 指的是那台服务器自身。修改代理配置前，应在实际运行服务的主机验证网络。修改代码或环境变量后，需要重启实际运行的 PM2 进程才能生效；使用项目对应的 PM2_HOME，避免操作另一套 PM2 实例。

可在服务主机执行仅查询公共行情的检查：

```powershell
curl.exe --max-time 10 --proxy http://127.0.0.1:7890 "https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=15m&limit=1"
```

返回 `code: "0"` 说明这一次请求成功，不代表之前的断连已被永久排除。若后续仍报错，使用新增错误码区分代理拒绝连接、连接中断或超时。
