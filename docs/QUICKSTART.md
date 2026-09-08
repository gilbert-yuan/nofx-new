# 全局自动化快速启动指南

## 5分钟快速开始

### 第1步：启动服务

```bash
# 开发模式（推荐）
npm run dev

# 或使用PM2后台运行
npm run pm2:start
npm run pm2:logs
```

等待服务启动完成，看到：
```
[GlobalAutomation] 系统就绪，使用 POST /api/automation/start 启动
NOFX Lite API listening on http://127.0.0.1:3100
```

### 第2步：启动全局自动化

打开新终端：

```bash
curl -X POST http://127.0.0.1:3100/api/automation/start
```

看到响应：
```json
{
  "message": "全局自动化系统已启动"
}
```

### 第3步：验证运行状态

```bash
# 查看系统状态
curl http://127.0.0.1:3100/api/automation/status | jq
```

期望输出：
```json
{
  "tasks": {
    "klineSync": {
      "enabled": true,
      "interval": 60000,
      "lastRun": "2026-09-08T...",
      "running": false
    },
    "analysis": {
      "enabled": true,
      "interval": 7200000,
      "lastRun": null,
      "running": false
    },
    "positionReview": {
      "enabled": true,
      "interval": 300000,
      "lastRun": null,
      "running": false
    }
  },
  "stats": {
    "totalAnalyzed": 0,
    "totalOrders": 0,
    "totalReviews": 0,
    "errors": []
  }
}
```

### 第4步：查看自动化运行

```bash
# 方式1：PM2日志
npm run pm2:logs

# 方式2：开发模式控制台
# 直接查看 npm run dev 的输出

# 期望看到：
# [GlobalAutomation] 开始同步 XXX 个币种的K线...
# [GlobalAutomation] K线同步完成: 成功 XXX, 失败 XXX
```

### 第5步：等待第一次分析（2小时后）

或者立即手动触发：

```bash
# 立即执行一次分析
curl -X POST http://127.0.0.1:3100/api/automation/tasks/analysis/trigger
```

等待几分钟后查看结果：

```bash
# 查看账户状态
curl http://127.0.0.1:3100/api/paper/account | jq

# 查看持仓
curl http://127.0.0.1:3100/api/paper/account | jq '.orders[] | select(.status != "closed")'
```

## 完成！🎉

系统现在会自动：

- ✅ 每60秒获取最新K线
- ✅ 每2小时扫描所有币种并自动下单
- ✅ 每5分钟复核持仓并调整止盈止损

---

## 常用命令

### 查看持仓概况

```bash
curl http://127.0.0.1:3100/api/paper/account | jq '{
  openCount: .openCount,
  usedMargin: .usedMargin,
  realized: .realized,
  unrealized: .unrealized
}'
```

### 查看最新分析

```bash
curl http://127.0.0.1:3100/api/research/list?limit=10 | jq
```

### 停止自动化

```bash
curl -X POST http://127.0.0.1:3100/api/automation/stop
```

### 修改任务频率

```bash
# 改为每小时分析一次
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/analysis \
  -H "Content-Type: application/json" \
  -d '{"interval": 3600000}'

# 改为每分钟复核持仓
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/positionReview \
  -H "Content-Type: application/json" \
  -d '{"interval": 60000}'
```

---

## 故障排查

### 看不到日志？

```bash
# PM2模式
npm run pm2:logs

# 开发模式
# 查看 npm run dev 的控制台输出
```

### 没有自动下单？

```bash
# 1. 检查分析任务是否运行
curl http://127.0.0.1:3100/api/automation/status | jq '.tasks.analysis'

# 2. 查看错误日志
curl http://127.0.0.1:3100/api/automation/status | jq '.stats.errors'

# 3. 手动触发一次分析
curl -X POST http://127.0.0.1:3100/api/automation/tasks/analysis/trigger

# 4. 等待几分钟后查看账户
curl http://127.0.0.1:3100/api/paper/account | jq
```

### 持仓没有自动调整止盈止损？

```bash
# 1. 检查是否有持仓
curl http://127.0.0.1:3100/api/paper/account | jq '.orders[] | select(.status=="open")'

# 2. 查看复核历史
curl http://127.0.0.1:3100/api/paper/account | jq '.orders[0].reviewHistory[-5:]'

# 3. 手动触发复核
curl -X POST http://127.0.0.1:3100/api/automation/tasks/positionReview/trigger
```

---

## Web界面

打开浏览器访问：http://127.0.0.1:5173

- 行情工作台：查看K线和手动分析
- 模拟交易：查看自动下单的持仓
- 模型设置：配置AI模型（可选）

---

## 下一步

1. 观察系统运行24小时，查看策略表现
2. 根据实际情况调整任务频率
3. 考虑是否启用AI分析（需要配置模型Key）
4. 查看详细文档：`docs/global-automation.md`

---

**重要提示**：
- 这是模拟交易，不会使用真实资金
- 本地规则仅供参考，请充分测试后再考虑实盘
- 建议先运行一周，评估策略效果
