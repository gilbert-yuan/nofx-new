/**
 * 分析当前数据库表结构
 */

import pg from 'pg';
import 'dotenv/config';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/nofx'
});

async function main() {
  console.log('📊 当前数据库表结构分析\n');

  // 1. 列出所有表
  const tables = await pool.query(`
    SELECT tablename, schemaname
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);

  console.log('📋 表列表:');
  tables.rows.forEach(t => console.log(`   - ${t.tablename}`));
  console.log();

  // 2. 分析每个表的结构
  for (const table of tables.rows) {
    const tableName = table.tablename;
    console.log(`\n📁 表: ${tableName}`);
    console.log('─'.repeat(60));

    // 获取列信息
    const columns = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [tableName]);

    console.log('列结构:');
    columns.rows.forEach(col => {
      console.log(`   ${col.column_name.padEnd(20)} ${col.data_type.padEnd(15)} ${col.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'}`);
    });

    // 获取索引信息
    const indexes = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = $1
    `, [tableName]);

    if (indexes.rows.length > 0) {
      console.log('\n索引:');
      indexes.rows.forEach(idx => {
        console.log(`   - ${idx.indexname}`);
      });
    }

    // 统计行数
    const count = await pool.query(`SELECT COUNT(*) FROM ${tableName}`);
    console.log(`\n行数: ${count.rows[0].count}`);

    // 如果包含 JSONB 字段，分析 JSON 结构
    const jsonbCols = columns.rows.filter(c => c.data_type === 'jsonb');
    if (jsonbCols.length > 0) {
      console.log('\nJSONB 字段分析:');
      for (const col of jsonbCols) {
        const sample = await pool.query(`
          SELECT ${col.column_name}
          FROM ${tableName}
          LIMIT 1
        `);

        if (sample.rows.length > 0) {
          const json = sample.rows[0][col.column_name];
          const keys = Object.keys(json || {});
          console.log(`   ${col.column_name}: ${keys.length} 个顶层字段`);

          if (keys.length > 0 && keys.length <= 20) {
            console.log(`      字段: ${keys.join(', ')}`);
          }

          // 如果是数组，分析数组元素
          if (Array.isArray(json)) {
            console.log(`      数组长度: ${json.length}`);
            if (json.length > 0) {
              const elementKeys = Object.keys(json[0] || {});
              console.log(`      元素字段: ${elementKeys.join(', ')}`);
            }
          }

          // 特殊分析：orders 数组
          if (col.column_name === 'state' && json.orders) {
            console.log(`      orders 数组: ${json.orders.length} 个订单`);
            if (json.orders.length > 0) {
              const orderKeys = Object.keys(json.orders[0]);
              console.log(`      订单字段数: ${orderKeys.length}`);
            }
          }
        }
      }
    }
  }

  console.log('\n\n💡 问题分析:\n');

  // simulated_account 表分析
  const account = await pool.query('SELECT state FROM simulated_account WHERE id=1');
  if (account.rows.length > 0) {
    const state = account.rows[0].state;
    console.log('❌ simulated_account 表问题:');
    console.log(`   - 所有订单存储在单个 JSON 字段中 (${state.orders.length} 个订单)`);
    console.log('   - 无法使用 SQL 查询筛选订单');
    console.log('   - 无法建立索引优化查询');
    console.log('   - 无法做聚合统计（如按币种、按日期）');
    console.log('   - 更新单个订单需要锁定整个表\n');
  }

  // research_records 表分析
  const research = await pool.query('SELECT COUNT(*) as total FROM research_records');
  console.log('❌ research_records 表问题:');
  console.log(`   - 总记录数: ${research.rows[0].total}`);
  console.log('   - 每条记录包含完整的市场快照（K线数据）');
  console.log('   - 多个分析信号存储在 analyses 数组中');
  console.log('   - 无法高效查询特定币种的历史信号');
  console.log('   - 无法按信号属性（置信度、策略版本）建立索引\n');

  await pool.end();
}

main().catch(err => {
  console.error('❌ 分析失败:', err);
  process.exit(1);
});
