/**
 * 测试优化后的数据库查询性能
 */

import pg from 'pg';
import 'dotenv/config';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/nofx'
});

async function benchmark(name, query) {
  const start = Date.now();
  const result = await pool.query(query);
  const elapsed = Date.now() - start;
  return { name, rows: result.rows.length, elapsed, sample: result.rows[0] };
}

async function main() {
  console.log('⚡ 数据库查询性能测试\n');
  console.log('=' .repeat(70) + '\n');

  const tests = [
    {
      category: '📊 订单统计查询',
      queries: [
        {
          name: '按币种统计（视图）',
          query: 'SELECT * FROM v_closed_orders_stats'
        },
        {
          name: '按策略版本统计（视图）',
          query: 'SELECT * FROM v_orders_by_strategy'
        },
        {
          name: '查询亏损最多的5个币种',
          query: `SELECT symbol, total, win_rate, total_net, avg_roi
                  FROM v_closed_orders_stats
                  WHERE total >= 2
                  ORDER BY total_net ASC LIMIT 5`
        },
        {
          name: '查询表现最好的币种',
          query: `SELECT symbol, total, win_rate, total_net, avg_roi
                  FROM v_closed_orders_stats
                  WHERE total >= 2
                  ORDER BY win_rate DESC, total_net DESC LIMIT 5`
        },
        {
          name: '统计各平仓原因',
          query: `SELECT reason, COUNT(*) as count,
                  ROUND(AVG(CASE WHEN net > 0 THEN 1.0 ELSE 0.0 END), 4) as win_rate,
                  ROUND(AVG(net), 4) as avg_net
                  FROM paper_orders
                  WHERE status = 'closed'
                  GROUP BY reason
                  ORDER BY count DESC`
        }
      ]
    },
    {
      category: '🔍 订单检索查询',
      queries: [
        {
          name: '查询活跃订单',
          query: 'SELECT * FROM v_active_orders'
        },
        {
          name: '查询最近10个已平仓订单',
          query: `SELECT id, symbol, direction, entry, exit, net, roi, reason, exit_at
                  FROM paper_orders
                  WHERE status = 'closed'
                  ORDER BY exit_at DESC LIMIT 10`
        },
        {
          name: '查询特定币种的所有订单',
          query: `SELECT id, status, direction, entry, exit, net, roi, created_at
                  FROM paper_orders
                  WHERE symbol = 'IOSTUSDT'
                  ORDER BY created_at DESC`
        },
        {
          name: '查询盈利订单（按ROI排序）',
          query: `SELECT id, symbol, direction, net, roi, exit_at
                  FROM paper_orders
                  WHERE status = 'closed' AND net > 0
                  ORDER BY roi DESC LIMIT 10`
        }
      ]
    },
    {
      category: '📈 分析信号查询',
      queries: [
        {
          name: '查询有效信号统计',
          query: 'SELECT * FROM v_eligible_signals'
        },
        {
          name: '查询高置信度信号（>0.7）',
          query: `SELECT id, symbol, confidence, position_recommendation,
                  analysis_engine, generated_at
                  FROM analysis_signals
                  WHERE confidence > 0.7
                  ORDER BY confidence DESC LIMIT 10`
        },
        {
          name: '按引擎类型统计信号',
          query: `SELECT analysis_engine,
                  COUNT(*) as total,
                  SUM(CASE WHEN eligible THEN 1 ELSE 0 END) as eligible_count,
                  ROUND(AVG(confidence), 4) as avg_confidence
                  FROM analysis_signals
                  GROUP BY analysis_engine`
        },
        {
          name: '查询特定币种的历史信号',
          query: `SELECT id, confidence, position_recommendation,
                  reason, generated_at
                  FROM analysis_signals
                  WHERE symbol = 'BTCUSDT'
                  ORDER BY generated_at DESC LIMIT 10`
        }
      ]
    },
    {
      category: '🔬 复杂关联查询',
      queries: [
        {
          name: '订单关联分析上下文',
          query: `SELECT
                    o.id, o.symbol, o.status, o.net, o.roi,
                    o.analysis_context->>'strategyVersion' as strategy,
                    o.analysis_context->>'analysisEngine' as engine,
                    o.analysis_context->'signal'->>'confidence' as signal_confidence
                  FROM paper_orders o
                  WHERE o.status = 'closed' AND o.analysis_context IS NOT NULL
                  ORDER BY o.exit_at DESC LIMIT 10`
        },
        {
          name: '订单与信号关联查询',
          query: `SELECT
                    o.symbol, o.net, o.roi, o.reason,
                    s.confidence, s.position_recommendation
                  FROM paper_orders o
                  LEFT JOIN analysis_signals s ON s.record_id = o.record_id AND s.symbol = o.symbol
                  WHERE o.status = 'closed'
                  ORDER BY o.exit_at DESC LIMIT 10`
        }
      ]
    }
  ];

  const results = [];

  for (const category of tests) {
    console.log(category.category);
    console.log('-'.repeat(70));

    for (const test of category.queries) {
      const result = await benchmark(test.name, test.query);
      results.push(result);

      const statusIcon = result.elapsed < 5 ? '🟢' : result.elapsed < 20 ? '🟡' : '🔴';
      console.log(`${statusIcon} ${result.name}`);
      console.log(`   查询时间: ${result.elapsed}ms | 结果行数: ${result.rows}`);

      if (result.sample) {
        const sampleStr = JSON.stringify(result.sample).substring(0, 80);
        console.log(`   示例: ${sampleStr}...`);
      }
      console.log();
    }
  }

  // 性能总结
  console.log('=' .repeat(70));
  console.log('📊 性能总结\n');

  const avgTime = results.reduce((sum, r) => sum + r.elapsed, 0) / results.length;
  const maxTime = Math.max(...results.map(r => r.elapsed));
  const fastQueries = results.filter(r => r.elapsed < 5).length;

  console.log(`   总查询数: ${results.length}`);
  console.log(`   平均响应时间: ${avgTime.toFixed(2)}ms`);
  console.log(`   最慢查询: ${maxTime}ms`);
  console.log(`   快速查询 (<5ms): ${fastQueries}/${results.length} (${(fastQueries/results.length*100).toFixed(1)}%)`);

  console.log('\n✅ 测试完成');

  await pool.end();
}

main().catch(err => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
