/**
 * 检查K线数据的refreshedAt状态
 */

import pg from 'pg';

const client = new pg.Client({
  host: 'localhost',
  port: 5432,
  database: 'nofx',
  user: 'postgres',
  password: 'postgres'
});

async function checkKlines() {
  try {
    await client.connect();
    console.log('已连接到数据库\n');

    // 检查最近的K线数据
    const result = await client.query(`
      SELECT
        symbol,
        interval,
        COUNT(*) as count,
        MAX("openTime") as latest_open,
        MAX("refreshedAt") as latest_refresh,
        NOW() - MAX("refreshedAt") as age
      FROM klines
      WHERE symbol LIKE 'OKX_PUBLIC_%'
      GROUP BY symbol, interval
      ORDER BY MAX("refreshedAt") DESC
      LIMIT 10
    `);

    console.log('最近更新的K线数据:');
    console.log('=====================================');
    result.rows.forEach(row => {
      console.log(`币种: ${row.symbol}`);
      console.log(`周期: ${row.interval}`);
      console.log(`数量: ${row.count}`);
      console.log(`最新K线时间: ${new Date(Number(row.latest_open)).toISOString()}`);
      console.log(`最后刷新时间: ${row.latest_refresh}`);
      console.log(`数据年龄: ${row.age}`);
      console.log('-------------------------------------');
    });

    // 检查是否有过期数据
    const staleResult = await client.query(`
      SELECT
        symbol,
        interval,
        COUNT(*) as stale_count
      FROM klines
      WHERE symbol LIKE 'OKX_PUBLIC_%'
        AND "refreshedAt" < NOW() - INTERVAL '10 minutes'
      GROUP BY symbol, interval
      ORDER BY stale_count DESC
      LIMIT 10
    `);

    console.log('\n过期数据 (超过10分钟未刷新):');
    console.log('=====================================');
    if (staleResult.rows.length === 0) {
      console.log('没有过期数据');
    } else {
      staleResult.rows.forEach(row => {
        console.log(`${row.symbol} / ${row.interval}: ${row.stale_count} 条`);
      });
    }

    // 检查data_gap相关的信号
    const signalResult = await client.query(`
      SELECT
        symbol,
        interval,
        "createdAt",
        "firstEntryAt",
        "expiresAt"
      FROM research
      WHERE eligible = true
        AND plan IS NOT NULL
      ORDER BY "createdAt" DESC
      LIMIT 5
    `);

    console.log('\n最近的交易信号:');
    console.log('=====================================');
    signalResult.rows.forEach(row => {
      console.log(`币种: ${row.symbol}`);
      console.log(`周期: ${row.interval}`);
      console.log(`生成时间: ${row.createdAt}`);
      console.log(`首次入场时间: ${row.firstEntryAt}`);
      console.log(`到期时间: ${row.expiresAt}`);
      console.log('-------------------------------------');
    });

  } catch (error) {
    console.error('错误:', error.message);
    console.error(error.stack);
  } finally {
    await client.end();
  }
}

checkKlines();
