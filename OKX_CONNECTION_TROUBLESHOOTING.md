# OKX API 连接问题诊断和解决方案

## 🔍 问题诊断

### 错误信息
```
Unable to reach OKX /api/v5/market/candles: fetch failed
```

### 诊断结果
1. ✅ 代理端口 7890 正在监听
2. ❌ 通过代理无法连接 OKX API
3. ❌ 直接连接 OKX API 失败

## 🛠️ 解决方案

### 方案 1：检查代理软件状态（推荐）

**可能原因**：
- 代理软件（Clash/V2Ray/SSR）未启动或未正常工作
- 代理规则未正确配置 OKX 域名

**解决步骤**：

1. **检查代理软件是否运行**
   - 打开 Clash/V2Ray 等代理软件
   - 确认代理模式为"全局"或"规则"
   - 确认 HTTP 端口为 7890

2. **测试代理连接**
   ```bash
   # 在命令行测试
   curl -x http://127.0.0.1:7890 https://www.google.com
   
   # 如果失败，尝试重启代理软件
   ```

3. **添加 OKX 域名到代理规则**
   - 在代理软件配置中添加：
   - `*.okx.com` → Proxy
   - `www.okx.com` → Proxy

### 方案 2：使用备用数据源（临时方案）

如果 OKX 持续无法连接，可以临时切换到币安数据源：

**修改 `server/marketData.js`**：

```javascript
// 找到 marketData 定义
// 当前：
export const marketData = new OkxMarket();

// 改为：
export const marketData = new BinanceMarket();
```

**优点**：
- 币安 API 通常更稳定
- 无需代理即可访问

**缺点**：
- 已有的 OKX 历史数据无法使用
- 需要重新获取 K 线数据

### 方案 3：禁用代理（如果不需要代理）

如果你在国外或使用 VPN，可以禁用代理：

**修改 `server/okxClient.js`**：

```javascript
// 找到第 6 行
// 当前：
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';

// 改为：
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
```

### 方案 4：配置环境变量代理

如果代理端口不是 7890，设置正确的端口：

**Windows (PowerShell)**：
```powershell
$env:HTTP_PROXY="http://127.0.0.1:YOUR_PORT"
$env:HTTPS_PROXY="http://127.0.0.1:YOUR_PORT"
```

**然后重启服务器**：
```bash
npm run dev
```

### 方案 5：检查防火墙设置

**可能原因**：防火墙阻止了 Node.js 访问代理

**解决步骤**：
1. 打开 Windows 防火墙
2. 添加 node.exe 到允许列表
3. 允许入站和出站连接

## 🔧 快速修复（推荐执行）

### 立即尝试：重启代理软件

1. 关闭 Clash/V2Ray 等代理软件
2. 等待 5 秒
3. 重新启动代理软件
4. 确认系统代理已启用
5. 重启服务器：
   ```bash
   cd D:/UGit/nofx-new
   npm run dev
   ```

### 验证修复

```bash
# 测试代理连接
curl -x http://127.0.0.1:7890 https://www.okx.com/api/v5/public/time

# 应该返回类似：
# {"code":"0","msg":"","data":[{"ts":"1725875123456"}]}
```

## 📊 当前影响

### 受影响的功能

1. ❌ **自动扫描**：无法获取最新行情数据
2. ❌ **手动分析**：无法分析新币种
3. ❌ **K线同步**：无法更新历史数据
4. ✅ **复盘分析**：使用本地数据库，不受影响
5. ✅ **自适应优化**：使用历史订单，不受影响

### 不影响的功能

- 查看历史订单
- 查看统计数据
- 查看自适应报告
- 已有订单的管理

## 🎯 推荐操作步骤

### 步骤 1：检查代理（5分钟）

```bash
# 1. 打开代理软件（Clash/V2Ray）
# 2. 确认代理模式为"全局"或"规则"
# 3. 测试连接
curl -x http://127.0.0.1:7890 https://www.google.com
```

### 步骤 2：如果代理正常，重启服务器

```bash
# 停止当前服务器（Ctrl+C）
cd D:/UGit/nofx-new
npm run dev
```

### 步骤 3：如果仍然失败，切换到币安

```javascript
// 编辑 server/marketData.js
// 第 95 行附近
export const marketData = new BinanceMarket();
```

### 步骤 4：验证连接

```bash
# 服务器启动后，查看日志
# 应该看到类似：
# NOFX Lite API listening on http://127.0.0.1:3100

# 测试 API
curl http://localhost:3100/api/health
```

## ⚠️ 常见错误

### 错误 1：代理端口冲突

**症状**：端口 7890 被占用
**解决**：
```bash
# 查找占用进程
netstat -ano | findstr 7890

# 结束进程或更改代理端口
```

### 错误 2：代理认证失败

**症状**：`407 Proxy Authentication Required`
**解决**：检查代理软件是否需要认证，添加用户名密码

### 错误 3：DNS 解析失败

**症状**：`getaddrinfo ENOTFOUND`
**解决**：
1. 检查 DNS 设置
2. 尝试使用 8.8.8.8 或 1.1.1.1
3. 刷新 DNS 缓存：`ipconfig /flushdns`

## 📝 临时替代方案

在 OKX 连接问题解决前，可以：

1. **使用现有数据**：
   - 查看历史订单复盘
   - 查看自适应优化建议
   - 不进行新的交易扫描

2. **切换到币安**：
   - 短期内使用币安数据源
   - 等待 OKX 连接恢复后切换回来

3. **手动暂停自动交易**：
   ```bash
   curl -X PUT http://localhost:3100/api/paper/automation \
     -H "Content-Type: application/json" \
     -d '{"enabled": false}'
   ```

## 🔄 后续监控

连接恢复后，验证以下功能：

- [ ] K线数据获取正常
- [ ] 自动扫描恢复
- [ ] 手动分析可用
- [ ] 实时价格更新

---

**总结**：OKX API 连接失败通常是代理配置问题。建议首先检查代理软件状态，然后重启服务器。如果问题持续，可临时切换到币安数据源。
