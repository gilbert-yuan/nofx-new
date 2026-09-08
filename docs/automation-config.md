# 全局自动化配置示例

## 默认配置

```javascript
{
  "tasks": {
    "klineSync": {
      "enabled": true,
      "interval": 60000  // 60秒
    },
    "analysis": {
      "enabled": true,
      "interval": 7200000  // 2小时
    },
    "positionReview": {
      "enabled": true,
      "interval": 300000  // 5分钟
    }
  }
}
```

## 推荐配置场景

### 1. 保守型（适合新手）

```bash
# 每2小时分析一次
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/analysis \
  -H "Content-Type: application/json" \
  -d '{"interval": 7200000}'

# 每10分钟复核一次
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/positionReview \
  -H "Content-Type: application/json" \
  -d '{"interval": 600000}'
```

**特点**：
- 下单频率低，减少手续费
- 复核间隔长，避免频繁调整
- 适合测试和观察策略

### 2. 激进型（适合波段）

```bash
# 每1小时分析一次
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/analysis \
  -H "Content-Type: application/json" \
  -d '{"interval": 3600000}'

# 每1分钟复核一次
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/positionReview \
  -H "Content-Type: application/json" \
  -d '{"interval": 60000}'
```

**特点**：
- 捕捉更多机会
- 快速响应行情变化
- 止盈止损更敏感

### 3. 超激进型（适合日内交易）

```bash
# 每30分钟分析一次
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/analysis \
  -H "Content-Type: application/json" \
  -d '{"interval": 1800000}'

# 每30秒复核一次
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/positionReview \
  -H "Content-Type: application/json" \
  -d '{"interval": 30000}'
```

**特点**：
- 极高频率
- 适合测试策略响应速度
- 需要关注系统负载

### 4. 夜间模式（节省资源）

```bash
# 仅在白天运行（需要手动控制）

# 早上8点启动
curl -X POST http://127.0.0.1:3100/api/automation/start

# 晚上10点停止
curl -X POST http://127.0.0.1:3100/api/automation/stop

# 或者使用cron job自动控制
```

### 5. 只复核不下单

```bash
# 禁用分析任务
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/analysis \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# 仅运行复核（管理现有持仓）
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/positionReview \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "interval": 300000}'
```

**用途**：
- 手动选择开仓时机
- 自动管理止盈止损
- 减少策略风险

## 性能调优

### 大量币种场景（200+）

```bash
# K线同步间隔放宽
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/klineSync \
  -H "Content-Type: application/json" \
  -d '{"interval": 120000}'  # 2分钟

# 分析间隔延长
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/analysis \
  -H "Content-Type: application/json" \
  -d '{"interval": 14400000}'  # 4小时

# 复核间隔适中
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/positionReview \
  -H "Content-Type: application/json" \
  -d '{"interval": 600000}'  # 10分钟
```

### 少量币种场景（<50）

```bash
# 所有任务高频率
curl -X PUT http://127.0.0.1:3100/api/automation/tasks/klineSync \
  -H "Content-Type: application/json" \
  -d '{"interval": 30000}'  # 30秒

curl -X PUT http://127.0.0.1:3100/api/automation/tasks/analysis \
  -H "Content-Type: application/json" \
  -d '{"interval": 3600000}'  # 1小时

curl -X PUT http://127.0.0.1:3100/api/automation/tasks/positionReview \
  -H "Content-Type: application/json" \
  -d '{"interval": 60000}'  # 1分钟
```

## 环境配置

### 开发环境

```bash
# .env
PORT=3100
DATABASE_URL=postgresql://localhost/nofx_dev

# 使用本地规则，无需模型Key
# 启动开发服务器
npm run dev

# 启动自动化
curl -X POST http://127.0.0.1:3100/api/automation/start
```

### 生产环境

```bash
# .env
PORT=3100
DATABASE_URL=postgresql://user:pass@host/nofx_prod
NODE_ENV=production

# 构建前端
npm run build

# 使用PM2运行
npm run pm2:start

# 等待服务启动
sleep 5

# 启动自动化
curl -X POST http://127.0.0.1:3100/api/automation/start

# 查看日志
npm run pm2:logs
```

## 监控脚本

### 健康检查

创建 `scripts/health-check.sh`:

```bash
#!/bin/bash

# 检查API健康
health=$(curl -s http://127.0.0.1:3100/api/health | jq -r '.ok')
if [ "$health" != "true" ]; then
    echo "API健康检查失败"
    exit 1
fi

# 检查自动化状态
status=$(curl -s http://127.0.0.1:3100/api/automation/status)
errors=$(echo "$status" | jq -r '.stats.errors | length')

if [ "$errors" -gt 10 ]; then
    echo "错误数过多: $errors"
    echo "$status" | jq '.stats.errors[-5:]'
    exit 1
fi

echo "健康检查通过"
```

### 定时报告

创建 `scripts/daily-report.sh`:

```bash
#!/bin/bash

echo "=== 全局自动化日报 $(date) ==="

# 系统状态
echo -e "\n系统状态:"
curl -s http://127.0.0.1:3100/api/automation/status | jq '{
  analyzed: .stats.totalAnalyzed,
  orders: .stats.totalOrders,
  reviews: .stats.totalReviews,
  errors: .stats.errors | length
}'

# 账户概况
echo -e "\n账户概况:"
curl -s http://127.0.0.1:3100/api/paper/account | jq '{
  openCount: .openCount,
  usedMargin: .usedMargin,
  realized: .realized,
  unrealized: .unrealized,
  realizedReturn: .realizedReturn
}'

# 最近错误
echo -e "\n最近错误:"
curl -s http://127.0.0.1:3100/api/automation/status | jq -r '.stats.errors[-5:][]'

echo -e "\n=== 报告结束 ==="
```

运行：

```bash
# 添加执行权限
chmod +x scripts/*.sh

# 手动运行
bash scripts/health-check.sh
bash scripts/daily-report.sh

# 使用cron定时运行
# 编辑 crontab -e
# 每小时健康检查
0 * * * * cd /path/to/nofx-new && bash scripts/health-check.sh

# 每天早上8点生成报告
0 8 * * * cd /path/to/nofx-new && bash scripts/daily-report.sh
```

## 告警配置

### 错误告警

创建 `scripts/alert.sh`:

```bash
#!/bin/bash

WEBHOOK_URL="your-webhook-url"  # Slack/Discord/企业微信

status=$(curl -s http://127.0.0.1:3100/api/automation/status)
errors=$(echo "$status" | jq -r '.stats.errors | length')

if [ "$errors" -gt 5 ]; then
    message="⚠️ 全局自动化错误数: $errors\n最近错误:\n"
    message+=$(echo "$status" | jq -r '.stats.errors[-3:][]')
    
    # 发送告警（示例）
    curl -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "{\"text\":\"$message\"}"
fi
```

### 性能告警

```bash
#!/bin/bash

# 检查任务延迟
status=$(curl -s http://127.0.0.1:3100/api/automation/status)

# 检查K线同步是否超时
kline_last=$(echo "$status" | jq -r '.tasks.klineSync.lastRun')
kline_age=$(( $(date +%s) - $(date -d "$kline_last" +%s) ))

if [ "$kline_age" -gt 300 ]; then
    echo "⚠️ K线同步延迟: ${kline_age}秒"
    # 发送告警
fi
```

## Windows计划任务

使用Windows任务计划程序：

1. 打开"任务计划程序"
2. 创建基本任务
3. 触发器：每天特定时间
4. 操作：启动程序

启动脚本 `start-automation.bat`:

```bat
@echo off
cd /d D:\UGit\nofx-new
curl -X POST http://127.0.0.1:3100/api/automation/start
```

停止脚本 `stop-automation.bat`:

```bat
@echo off
cd /d D:\UGit\nofx-new
curl -X POST http://127.0.0.1:3100/api/automation/stop
```

## 配置文件持久化

系统配置保存在数据库中，重启后自动恢复。

查看当前配置：

```bash
curl http://127.0.0.1:3100/api/automation/status | jq '.tasks'
```

备份配置：

```bash
# 导出配置
curl http://127.0.0.1:3100/api/automation/status > config-backup.json

# 恢复配置（需要逐个设置）
cat config-backup.json | jq -r '.tasks | keys[]' | while read task; do
    config=$(cat config-backup.json | jq ".tasks.$task")
    curl -X PUT "http://127.0.0.1:3100/api/automation/tasks/$task" \
        -H "Content-Type: application/json" \
        -d "$config"
done
```

## 更多配置

详见完整文档：`docs/global-automation.md`
