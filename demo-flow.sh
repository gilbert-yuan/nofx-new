#!/bin/bash

# 系统流程演示脚本
# 快速启动并验证所有功能

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀 NOFX 自动化交易系统 - 流程演示"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

BASE_URL="http://127.0.0.1:3100"

# 检查服务是否运行
echo "📡 检查服务状态..."
if curl -s "$BASE_URL/api/health" > /dev/null 2>&1; then
    echo "✅ 服务正在运行"
else
    echo "❌ 服务未运行，请先启动："
    echo "   npm run dev"
    echo "   或"
    echo "   npm run pm2:start"
    exit 1
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤1：启动自动化系统"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

curl -X POST "$BASE_URL/api/automation/start" 2>/dev/null | jq
sleep 2

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤2：查看系统状态"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

curl -s "$BASE_URL/api/automation/status" | jq '{
  "任务状态": .tasks | to_entries | map({
    name: .key,
    enabled: .value.enabled,
    interval: (.value.interval / 1000 | tostring + "秒"),
    lastRun: .value.lastRun
  }),
  "统计数据": .stats,
  "运行时间": (.uptime | tostring + "秒")
}'

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤3：手动触发K线同步"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo "正在同步K线数据（可能需要30秒）..."
curl -X POST "$BASE_URL/api/automation/tasks/klineSync/trigger" 2>/dev/null | jq
echo "⏳ 等待同步完成..."
sleep 35

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤4：查看K线同步结果"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

curl -s "$BASE_URL/api/automation/status" | jq '{
  "K线同步": .tasks.klineSync,
  "已分析币种数": .stats.totalAnalyzed
}'

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤5：查看模拟账户"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

curl -s "$BASE_URL/api/paper/account" | jq '{
  "无限资金模式": .unlimitedCapital,
  "累计投入": .investedMargin,
  "持仓数量": .openCount,
  "已用保证金": .usedMargin,
  "已实现盈亏": .realized,
  "未实现盈亏": .unrealized,
  "净盈亏": .net
}'

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤6：查看持仓列表"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

OPEN_COUNT=$(curl -s "$BASE_URL/api/paper/account" | jq '.openCount')

if [ "$OPEN_COUNT" -eq 0 ]; then
    echo "ℹ️  当前无持仓"
    echo ""
    echo "💡 提示："
    echo "   - 等待2小时后自动分析会生成信号"
    echo "   - 或手动触发分析："
    echo "     curl -X POST $BASE_URL/api/automation/tasks/analysis/trigger"
else
    echo "📊 当前持仓 ($OPEN_COUNT 个):"
    curl -s "$BASE_URL/api/paper/account" | jq '.orders[] | select(.status=="open") | {
      币种: .symbol,
      方向: .direction,
      入场: .entry,
      当前: .markPrice,
      盈亏: .unrealized,
      止损: .plan.stopLoss,
      止盈: .plan.takeProfit,
      杠杆: .leverage
    }'
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤7：查看最近分析记录"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

ANALYSIS_COUNT=$(curl -s "$BASE_URL/api/research/list?limit=5" | jq '. | length')

if [ "$ANALYSIS_COUNT" -eq 0 ]; then
    echo "ℹ️  暂无分析记录，等待首次自动分析"
else
    echo "📈 最近5条分析："
    curl -s "$BASE_URL/api/research/list?limit=5" | jq '.[] | {
      时间: .at,
      币种: .analyses[0].symbol,
      动作: .analyses[0].action,
      评分: .analyses[0].plan.trendStrengthScore,
      引擎: .analysisEngine
    }'
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤8：验证数据源连接"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo "🌐 测试外部数据源..."
echo ""

# 测试CoinGecko
echo "1️⃣  CoinGecko API:"
if timeout 5 curl -s "https://api.coingecko.com/api/v3/ping" > /dev/null 2>&1; then
    echo "   ✅ 连接正常"
else
    echo "   ⚠️  连接超时（不影响使用，已有缓存机制）"
fi

# 测试Fear & Greed
echo "2️⃣  Fear & Greed Index:"
if timeout 5 curl -s "https://api.alternative.me/fng/" > /dev/null 2>&1; then
    FEAR_VALUE=$(curl -s "https://api.alternative.me/fng/" 2>/dev/null | jq -r '.data[0].value' 2>/dev/null)
    if [ -n "$FEAR_VALUE" ] && [ "$FEAR_VALUE" != "null" ]; then
        echo "   ✅ 连接正常 (当前指数: $FEAR_VALUE)"
    else
        echo "   ⚠️  数据解析失败"
    fi
else
    echo "   ⚠️  连接超时（不影响使用，已有缓存机制）"
fi

# 测试Alpha Vantage
echo "3️⃣  Alpha Vantage:"
if [ -f "data/config.json" ] && grep -q "alphaVantage" data/config.json 2>/dev/null; then
    echo "   ✅ 已配置API Key"
else
    echo "   ℹ️  未配置（可选，不影响使用）"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ 流程演示完成"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 系统状态总结："
echo ""

curl -s "$BASE_URL/api/automation/status" | jq -r '
"  • K线同步: " + (if .tasks.klineSync.enabled then "✅ 已启用" else "❌ 已禁用" end) + " (每" + (.tasks.klineSync.interval / 1000 | tostring) + "秒)",
"  • 行情分析: " + (if .tasks.analysis.enabled then "✅ 已启用" else "❌ 已禁用" end) + " (每" + (.tasks.analysis.interval / 60000 | tostring) + "分钟)",
"  • 持仓复核: " + (if .tasks.positionReview.enabled then "✅ 已启用" else "❌ 已禁用" end) + " (每" + (.tasks.positionReview.interval / 60000 | tostring) + "分钟)",
"",
"  • 已分析: " + (.stats.totalAnalyzed | tostring) + " 个币种",
"  • 已下单: " + (.stats.totalOrders | tostring) + " 次",
"  • 已复核: " + (.stats.totalReviews | tostring) + " 次"
'

echo ""
echo "💡 接下来："
echo ""
echo "  1. 观察日志：npm run pm2:logs"
echo "  2. 查看Web界面：http://localhost:5173"
echo "  3. 等待2小时自动分析，或手动触发："
echo "     curl -X POST $BASE_URL/api/automation/tasks/analysis/trigger"
echo "  4. 查看完整文档："
echo "     - docs/SYSTEM_FLOW_PREVIEW.md"
echo "     - docs/QUICK_REFERENCE.md"
echo ""
echo "🎉 系统运行正常，祝您交易顺利！"
echo ""
