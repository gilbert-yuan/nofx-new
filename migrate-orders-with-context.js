/**
 * 为现有订单补充分析上下文
 */

import pg from 'pg';
import 'dotenv/config';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/nofx'
});

async function main() {
  console.log('🔄 开始迁移订单数据...\n');

  // 1. 读取当前账户状态
  const { rows } = await pool.query('SELECT state FROM simulated_account WHERE id=1');
  if (rows.length === 0) {
    console.log('❌ 未找到模拟账户');
    return;
  }

  const state = rows[0].state;
  console.log(`📊 当前订单数: ${state.orders.length}`);

  let migrated = 0;
  let failed = 0;

  // 2. 为每个订单补充分析上下文
  for (const order of state.orders) {
    if (order.analysisContext) {
      console.log(`✓ ${order.symbol} - 已有分析上下文，跳过`);
      continue;
    }

    // 尝试从研究记录中获取分析数据
    try {
      const recordResult = await pool.query(
        'SELECT record FROM research_records WHERE id = $1',
        [order.recordId]
      );

      if (recordResult.rows.length === 0) {
        console.log(`⚠ ${order.symbol} - 未找到分析记录 ${order.recordId}`);
        failed++;
        continue;
      }

      const record = recordResult.rows[0].record;
      const signal = record.analyses?.find(s => s.symbol === order.symbol);

      if (!signal) {
        console.log(`⚠ ${order.symbol} - 分析记录中未找到该币种信号`);
        failed++;
        continue;
      }

      // 构建分析上下文
      order.analysisContext = {
        signal: { ...signal },
        strategyVersion: record.strategyVersion,
        analysisEngine: record.analysisEngine || signal.analysisEngine,
        scope: record.scope,
        confidence: signal.confidence,
        confidenceType: signal.confidenceType,
        reason: signal.reason,
        risk: signal.risk,
        validationIssues: signal.validationIssues || [],
        automationRunId: record.automationRunId,
        dataAsOf: signal.dataAsOf
      };

      console.log(`✅ ${order.symbol} - 已补充分析上下文`);
      migrated++;
    } catch (error) {
      console.log(`❌ ${order.symbol} - 迁移失败: ${error.message}`);
      failed++;
    }
  }

  // 3. 保存更新后的状态
  if (migrated > 0) {
    await pool.query('UPDATE simulated_account SET state = $1 WHERE id = 1', [
      JSON.stringify(state)
    ]);
    console.log(`\n✅ 迁移完成: ${migrated} 个订单已更新, ${failed} 个失败`);
  } else {
    console.log(`\n⚠️  没有需要迁移的订单`);
  }

  await pool.end();
}

main().catch(err => {
  console.error('❌ 迁移失败:', err);
  process.exit(1);
});
