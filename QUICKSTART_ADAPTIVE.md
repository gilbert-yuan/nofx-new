# 自适应策略优化 - 快速启动

## ✅ 实施完成清单

- [x] 创建 `server/adaptiveFilters.js` - 过滤器模块
- [x] 创建 `server/adaptiveConfig.js` - 配置管理
- [x] 创建 `server/adaptiveRoutes.js` - API 路由
- [x] 创建 `tests/adaptiveFilters.test.js` - 单元测试
- [x] 修改 `server/localAnalysis.js` - 支持动态参数
- [x] 修改 `server/paperAutomation.js` - 集成过滤和优化
- [x] 修改 `server/researchRoutes.js` - 注册路由
- [x] 创建部署文档和分析文档

## 🚀 立即开始

### 1. 运行测试（可选）

```bash
npm test tests/adaptiveFilters.test.js
```

### 2. 重启服务器

```bash
# 停止现有服务（Ctrl+C）
# 启动服务器
npm run dev
```

### 3. 验证功能

```bash
# 检查 API 端点
curl http://localhost:3100/api/adaptive/config

# 查看完整报告（需至少20笔历史订单）
curl http://localhost:3100/api/adaptive/report
```

## 📊 自动生效条件

优化功能会在满足以下条件时**自动启用**：

1. **币种过滤** - 20+ 笔历史订单
2. **时段过滤** - 50+ 笔历史订单
3. **持仓优化** - 20+ 笔历史订单
4. **币种参数** - 10+ 笔/币种

## 📝 监控日志

启动自动扫描后，控制台会显示：

```
[自适应过滤] 过滤了2个低胜率币种: XXX(28%), YYY(31%)
[自适应过滤] 当前时段8:00 UTC为高胜率时段（胜率62.5%）
[自适应优化] 基于68笔历史订单，调整maxHoldBars: 30 → 25
[自适应参数] BTCUSDT: 止损放宽至3.0x ATR（触发率45%过高）
```

## ⚙️ 调整配置

### 禁用特定功能

```bash
curl -X PUT http://localhost:3100/api/adaptive/config \
  -H "Content-Type: application/json" \
  -d '{"symbolFilter": {"enabled": false}}'
```

### 调整阈值

```bash
curl -X PUT http://localhost:3100/api/adaptive/config \
  -H "Content-Type: application/json" \
  -d '{
    "symbolFilter": {"minWinRate": 0.40},
    "hourFilter": {"minWinRate": 0.60}
  }'
```

## 📈 预期效果

- **胜率提升**: +5-10%
- **盈利因子**: >1.5
- **减少亏损**: 过滤低胜率币种和时段

## 📚 详细文档

- [部署和使用指南](./ADAPTIVE_STRATEGY_DEPLOYMENT.md)
- [完整分析报告](./STRATEGY_ANALYSIS_AND_OPTIMIZATION.md)

---

**准备就绪！** 重启服务器后，自适应优化将自动运行。
