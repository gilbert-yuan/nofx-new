/**
 * 测试策略优化功能
 */

const API_BASE = 'http://127.0.0.1:3100';

async function fetchJson(path) {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function postJson(path, body = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function main() {
  console.log('📊 测试策略优化功能\n');

  // 1. 获取账户状态
  console.log('1️⃣ 获取账户状态...');
  const account = await fetchJson('/api/paper/account');
  console.log(`   - 已平仓订单: ${account.orders.filter(o => o.status === 'closed').length}`);
  console.log(`   - 持仓中: ${account.orders.filter(o => o.status === 'open').length}`);
  console.log(`   - 待入场: ${account.orders.filter(o => o.status === 'pending').length}`);
  console.log(`   - 总订单数: ${account.orders.length}\n`);

  // 2. 检查订单是否包含分析上下文
  const closedOrders = account.orders.filter(o => o.status === 'closed');
  if (closedOrders.length > 0) {
    console.log('2️⃣ 检查订单分析上下文...');
    const sampleOrder = closedOrders[0];
    console.log(`   - 订单ID: ${sampleOrder.id}`);
    console.log(`   - 币种: ${sampleOrder.symbol}`);
    console.log(`   - 方向: ${sampleOrder.direction}`);
    console.log(`   - ROI: ${(sampleOrder.roi * 100).toFixed(2)}%`);
    console.log(`   - 平仓原因: ${sampleOrder.reason}`);

    if (sampleOrder.analysisContext) {
      console.log(`   ✅ 包含分析上下文:`);
      console.log(`      - 策略版本: ${sampleOrder.analysisContext.strategyVersion}`);
      console.log(`      - 分析引擎: ${sampleOrder.analysisContext.analysisEngine}`);
      console.log(`      - 置信度: ${(sampleOrder.analysisContext.confidence * 100).toFixed(1)}%`);
      console.log(`      - 开仓理由: ${sampleOrder.analysisContext.reason?.substring(0, 50)}...`);
    } else {
      console.log(`   ⚠️  缺少分析上下文（旧订单）`);
    }
    console.log();

    // 3. 获取完整订单详情
    console.log('3️⃣ 获取订单完整详情...');
    const orderDetail = await fetchJson(`/api/paper/orders/${sampleOrder.id}`);
    console.log(`   - 订单详情字段数: ${Object.keys(orderDetail).length}`);
    if (orderDetail.analysisContext) {
      console.log(`   - 分析信号完整性: ${Object.keys(orderDetail.analysisContext.signal || {}).length} 个字段`);
      console.log(`   - 分析范围参数: ${JSON.stringify(orderDetail.analysisContext.scope)}`);
    }
    console.log();
  }

  // 4. 运行策略优化分析
  console.log('4️⃣ 运行策略优化分析...');
  const optimization = await fetchJson('/api/paper/optimize');

  if (optimization.error) {
    console.log(`   ⚠️  ${optimization.error}`);
  } else {
    console.log(`   ✅ 分析完成，样本量: ${optimization.sampleSize} 个已平仓订单`);
    console.log(`\n   📈 整体统计:`);
    console.log(`      - 胜率: ${(optimization.stats.winRate * 100).toFixed(1)}%`);
    console.log(`      - 平均ROI: ${(optimization.stats.averageRoi * 100).toFixed(2)}%`);
    console.log(`      - 平均持仓时长: ${optimization.stats.averageHoldBars.toFixed(1)} 根K线`);
    console.log(`      - 累计收益: ${optimization.stats.totalNet.toFixed(2)} USDT`);

    if (optimization.stats.byReason?.length > 0) {
      console.log(`\n   📊 平仓原因分布:`);
      optimization.stats.byReason.forEach(r => {
        console.log(`      - ${r.reason}: ${r.count} 次 (胜率 ${(r.winRate * 100).toFixed(1)}%)`);
      });
    }

    if (optimization.suggestions?.length > 0) {
      console.log(`\n   💡 优化建议 (${optimization.suggestions.length} 条):`);
      optimization.suggestions.forEach((s, i) => {
        const icon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢', info: 'ℹ️', positive: '✅' }[s.severity] || '•';
        console.log(`      ${icon} [${s.type}] ${s.message}`);
      });
    } else {
      console.log(`\n   ✅ 暂无优化建议`);
    }

    if (optimization.adjustments?.length > 0) {
      console.log(`\n   🔧 可执行的参数调整 (${optimization.adjustments.length} 项):`);
      optimization.adjustments.forEach(adj => {
        console.log(`      - ${adj.field}:`);
        console.log(`        当前: ${adj.current}`);
        console.log(`        建议: ${adj.suggested}`);
        console.log(`        原因: ${adj.reason}`);
      });
    }
  }

  console.log('\n✅ 测试完成');
}

main().catch(err => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});
