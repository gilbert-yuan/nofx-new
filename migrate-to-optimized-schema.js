/**
 * 数据库结构优化迁移脚本
 *
 * 将 JSONB 嵌套数据迁移到扁平化表结构
 */

import pg from 'pg';
import 'dotenv/config';
import fs from 'fs';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/nofx'
});

async function main() {
  console.log('🚀 开始数据库结构优化迁移\n');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ========================================================================
    // 步骤 1: 创建新表结构
    // ========================================================================
    console.log('📋 步骤 1: 创建新表结构...');
    const schema = fs.readFileSync('schema-optimization.sql', 'utf-8');
    await client.query(schema);
    console.log('   ✅ 新表结构创建完成\n');

    // ========================================================================
    // 步骤 2: 迁移模拟订单数据
    // ========================================================================
    console.log('📦 步骤 2: 迁移模拟订单数据...');

    const accountResult = await client.query('SELECT state FROM simulated_account WHERE id=1');
    if (accountResult.rows.length > 0) {
      const state = accountResult.rows[0].state;
      const orders = state.orders || [];

      console.log(`   发现 ${orders.length} 个订单`);

      let migrated = 0;
      for (const order of orders) {
        try {
          await client.query(`
            INSERT INTO paper_orders (
              id, record_id, symbol, interval, direction, status,
              margin, leverage, notional,
              entry, entry_at, entry_fee, quantity,
              exit, exit_at, reason,
              gross, fees, funding, net, roi,
              mark_price, mark_at, unrealized, liquidation_price, held_bars,
              created_at, next_time, expires_at,
              automatic, market_provider, error, ambiguous_bar, isolated_loss_adjustment,
              plan, initial_plan, costs, protection_revisions, review_history, analysis_context
            ) VALUES (
              $1, $2, $3, $4, $5, $6,
              $7, $8, $9,
              $10, $11, $12, $13,
              $14, $15, $16,
              $17, $18, $19, $20, $21,
              $22, $23, $24, $25, $26,
              $27, $28, $29,
              $30, $31, $32, $33, $34,
              $35, $36, $37, $38, $39, $40
            )
            ON CONFLICT (id) DO UPDATE SET
              status = EXCLUDED.status,
              mark_price = EXCLUDED.mark_price,
              mark_at = EXCLUDED.mark_at,
              unrealized = EXCLUDED.unrealized,
              exit = EXCLUDED.exit,
              exit_at = EXCLUDED.exit_at,
              reason = EXCLUDED.reason,
              net = EXCLUDED.net,
              roi = EXCLUDED.roi,
              held_bars = EXCLUDED.held_bars,
              error = EXCLUDED.error
          `, [
            order.id, order.recordId, order.symbol, order.interval, order.direction, order.status,
            order.margin, order.leverage, order.notional,
            order.entry || null, order.entryAt || null, order.entryFee || null, order.quantity || null,
            order.exit || null, order.exitAt || null, order.reason || null,
            order.gross || null, order.fees || null, order.funding || null, order.net || null, order.roi || null,
            order.markPrice || null, order.markAt || null, order.unrealized || 0, order.liquidationPrice || null, order.heldBars || 0,
            order.createdAt, order.nextTime, order.expiresAt,
            order.automatic || false, order.marketProvider || 'okx', order.error || '', order.ambiguousBar || false, order.isolatedLossAdjustment || 0,
            JSON.stringify(order.plan), JSON.stringify(order.initialPlan), JSON.stringify(order.costs),
            JSON.stringify(order.protectionRevisions || []), JSON.stringify(order.reviewHistory || []),
            order.analysisContext ? JSON.stringify(order.analysisContext) : null
          ]);
          migrated++;
        } catch (error) {
          console.log(`   ❌ 订单 ${order.id} 迁移失败: ${error.message}`);
        }
      }

      console.log(`   ✅ 已迁移 ${migrated}/${orders.length} 个订单\n`);

      // 迁移账户配置
      await client.query(`
        INSERT INTO paper_account_config (id, initial_balance, unlimited_capital, automation)
        VALUES (1, $1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET
          initial_balance = EXCLUDED.initial_balance,
          unlimited_capital = EXCLUDED.unlimited_capital,
          automation = EXCLUDED.automation,
          updated_at = NOW()
      `, [
        state.initialBalance || 10000,
        state.unlimitedCapital || false,
        JSON.stringify(state.automation || {})
      ]);

      console.log('   ✅ 账户配置已迁移\n');
    }

    // ========================================================================
    // 步骤 3: 迁移分析信号数据
    // ========================================================================
    console.log('📊 步骤 3: 迁移分析信号数据...');

    const recordsResult = await client.query(`
      SELECT record FROM research_records
      ORDER BY created_at DESC
      LIMIT 5000
    `);

    console.log(`   发现 ${recordsResult.rows.length} 条研究记录`);

    let signalCount = 0;
    let metaCount = 0;

    for (const row of recordsResult.rows) {
      const record = row.record;

      try {
        // 迁移元数据
        await client.query(`
          INSERT INTO research_records_meta (
            id, type, symbols, interval, kline_count, market_count,
            strategy_version, analysis_engine,
            signal_count, eligible_count,
            automation_run_id, error, research_only, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (id) DO NOTHING
        `, [
          record.id,
          record.type || 'single',
          record.symbols || [record.symbol],
          record.interval || '15m',
          record.klineCount || 0,
          record.marketCount || 0,
          record.strategyVersion || null,
          record.analysisEngine || 'local',
          (record.analyses || []).length,
          (record.analyses || []).filter(a => a.eligible).length,
          record.automationRunId || null,
          record.error || '',
          record.researchOnly !== false,
          record.at
        ]);
        metaCount++;

        // 迁移每个分析信号
        for (const signal of record.analyses || []) {
          try {
            const signalId = `${record.id}:${signal.symbol}`;
            await client.query(`
              INSERT INTO analysis_signals (
                id, record_id, symbol,
                action, position_recommendation, eligible, confidence, confidence_type,
                reason, risk, suggestion,
                plan, recommended_leverage,
                generated_at, data_as_of, first_entry_at, expires_at,
                exchange, interval, market_provider,
                strategy_version, analysis_engine,
                validation_issues, automation_run_id
              ) VALUES (
                $1, $2, $3,
                $4, $5, $6, $7, $8,
                $9, $10, $11,
                $12, $13,
                $14, $15, $16, $17,
                $18, $19, $20,
                $21, $22,
                $23, $24
              )
              ON CONFLICT (id) DO NOTHING
            `, [
              signalId, record.id, signal.symbol,
              signal.action || 'WAIT', signal.positionRecommendation || 'WAIT',
              signal.eligible || false, signal.confidence || null, signal.confidenceType || null,
              signal.reason || '', signal.risk || '', signal.suggestion || '',
              signal.plan ? JSON.stringify(signal.plan) : null, signal.recommendedLeverage || null,
              signal.generatedAt || record.at, signal.dataAsOf || record.at,
              signal.firstEntryAt || record.at, signal.expiresAt || record.at,
              signal.exchange || 'binance', signal.interval || record.interval || '15m',
              signal.marketProvider || 'okx',
              record.strategyVersion || null, signal.analysisEngine || record.analysisEngine || 'local',
              JSON.stringify(signal.validationIssues || []), record.automationRunId || null
            ]);
            signalCount++;
          } catch (error) {
            console.log(`   ⚠️  信号 ${signal.symbol} 迁移失败: ${error.message}`);
          }
        }
      } catch (error) {
        console.log(`   ⚠️  记录 ${record.id} 迁移失败: ${error.message}`);
      }
    }

    console.log(`   ✅ 已迁移 ${metaCount} 条元数据记录`);
    console.log(`   ✅ 已迁移 ${signalCount} 个分析信号\n`);

    // ========================================================================
    // 步骤 4: 验证迁移结果
    // ========================================================================
    console.log('🔍 步骤 4: 验证迁移结果...');

    const orderCount = await client.query('SELECT COUNT(*) FROM paper_orders');
    const closedCount = await client.query("SELECT COUNT(*) FROM paper_orders WHERE status = 'closed'");
    const signalsCount = await client.query('SELECT COUNT(*) FROM analysis_signals');
    const eligibleCount = await client.query('SELECT COUNT(*) FROM analysis_signals WHERE eligible = true');

    console.log(`   - 订单总数: ${orderCount.rows[0].count}`);
    console.log(`   - 已平仓订单: ${closedCount.rows[0].count}`);
    console.log(`   - 分析信号总数: ${signalsCount.rows[0].count}`);
    console.log(`   - 有效信号数: ${eligibleCount.rows[0].count}\n`);

    // ========================================================================
    // 步骤 5: 测试查询性能
    // ========================================================================
    console.log('⚡ 步骤 5: 测试查询性能...');

    const tests = [
      {
        name: '按币种统计已平仓订单',
        query: 'SELECT * FROM v_closed_orders_stats LIMIT 5'
      },
      {
        name: '按策略版本统计',
        query: 'SELECT * FROM v_orders_by_strategy'
      },
      {
        name: '查询活跃订单',
        query: 'SELECT * FROM v_active_orders'
      },
      {
        name: '查询有效信号',
        query: 'SELECT * FROM v_eligible_signals LIMIT 10'
      }
    ];

    for (const test of tests) {
      const start = Date.now();
      const result = await client.query(test.query);
      const elapsed = Date.now() - start;
      console.log(`   ✓ ${test.name}: ${result.rows.length} 行，${elapsed}ms`);
    }

    await client.query('COMMIT');
    console.log('\n✅ 迁移完成！\n');

    // 显示示例查询
    console.log('📚 常用查询示例:\n');
    console.log('-- 查看按币种统计');
    console.log('SELECT * FROM v_closed_orders_stats;\n');
    console.log('-- 查看按策略版本统计');
    console.log('SELECT * FROM v_orders_by_strategy;\n');
    console.log('-- 查询特定币种的所有订单');
    console.log("SELECT * FROM paper_orders WHERE symbol = 'BTCUSDT' ORDER BY created_at DESC;\n");
    console.log('-- 查询高置信度信号');
    console.log('SELECT * FROM analysis_signals WHERE confidence > 0.7 ORDER BY confidence DESC LIMIT 10;\n');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\n❌ 迁移失败:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
