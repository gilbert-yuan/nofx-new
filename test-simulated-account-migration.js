/**
 * 迁移现有 API 从旧的 simulated_account 表切换到新的表结构
 *
 * 使用方法：
 * 1. 先运行 migrate-to-optimized-schema.js 创建新表并迁移数据
 * 2. 运行本脚本测试新 API 的兼容性
 * 3. 修改 server.js 启用新版本
 */

import { SimulatedAccount } from './server/simulatedAccount.js';
import { SimulatedAccountV2 } from './server/simulatedAccountV2.js';
import pg from 'pg';
import 'dotenv/config';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/nofx'
});

async function compareAccounts(oldAccount, newAccount) {
  console.log('📊 比较旧版和新版账户实现\n');

  // 1. 读取状态
  console.log('1️⃣ 读取账户状态...');
  const oldState = await oldAccount.read();
  const newState = await newAccount.read();

  console.log(`   旧版订单数: ${oldState.orders.length}`);
  console.log(`   新版订单数: ${newState.orders.length}`);

  // 2. 获取状态摘要
  console.log('\n2️⃣ 获取账户摘要...');
  const oldStatus = await oldAccount.status();
  const newStatus = await newAccount.status();

  console.log(`   旧版余额: ${oldStatus.balance}`);
  console.log(`   新版余额: ${newStatus.balance}`);
  console.log(`   旧版已实现收益: ${oldStatus.realized.toFixed(4)}`);
  console.log(`   新版已实现收益: ${newStatus.realized.toFixed(4)}`);
  console.log(`   旧版活跃订单: ${oldStatus.openCount}`);
  console.log(`   新版活跃订单: ${newStatus.openCount}`);

  // 3. 检查订单字段一致性
  console.log('\n3️⃣ 检查订单字段一致性...');
  let fieldMismatches = 0;

  for (let i = 0; i < Math.min(oldState.orders.length, newState.orders.length); i++) {
    const oldOrder = oldState.orders[i];
    const newOrder = newState.orders[i];

    if (oldOrder.id !== newOrder.id) {
      console.log(`   ⚠️  订单 ${i}: ID 不匹配`);
      fieldMismatches++;
      continue;
    }

    // 检查关键字段
    const fields = ['symbol', 'status', 'margin', 'leverage', 'entry', 'exit', 'net', 'roi'];
    for (const field of fields) {
      if (oldOrder[field] !== newOrder[field]) {
        // 数值字段允许微小差异
        if (typeof oldOrder[field] === 'number' && typeof newOrder[field] === 'number') {
          const diff = Math.abs(oldOrder[field] - newOrder[field]);
          if (diff > 0.0001) {
            console.log(`   ⚠️  订单 ${oldOrder.symbol}: ${field} 不匹配 (${oldOrder[field]} vs ${newOrder[field]})`);
            fieldMismatches++;
          }
        } else if (oldOrder[field] != newOrder[field]) { // 使用 == 忽略 null vs undefined
          console.log(`   ⚠️  订单 ${oldOrder.symbol}: ${field} 不匹配`);
          fieldMismatches++;
        }
      }
    }
  }

  if (fieldMismatches === 0) {
    console.log('   ✅ 所有订单字段一致');
  } else {
    console.log(`   ⚠️  发现 ${fieldMismatches} 个字段不匹配`);
  }

  return {
    orderCountMatch: oldState.orders.length === newState.orders.length,
    balanceMatch: Math.abs((oldStatus.balance || 0) - (newStatus.balance || 0)) < 0.01,
    fieldMismatches
  };
}

async function testNewFeatures(newAccount) {
  console.log('\n\n🧪 测试新版特性\n');

  // 1. 测试单独获取订单
  console.log('1️⃣ 测试获取单个订单...');
  const orders = await newAccount.getOrders();
  if (orders.length > 0) {
    const order = await newAccount.getOrder(orders[0].id);
    console.log(`   ✅ 成功获取订单: ${order.symbol} (${order.status})`);
  }

  // 2. 测试按币种查询
  console.log('\n2️⃣ 测试按币种查询...');
  const symbols = new Set(orders.map(o => o.symbol));
  for (const symbol of Array.from(symbols).slice(0, 3)) {
    const symbolOrders = await newAccount.getOrdersBySymbol(symbol);
    console.log(`   ✅ ${symbol}: ${symbolOrders.length} 个订单`);
  }

  // 3. 测试获取活跃订单
  console.log('\n3️⃣ 测试获取活跃订单...');
  const activeOrders = await newAccount.getActiveOrders();
  console.log(`   ✅ 活跃订单: ${activeOrders.length} 个`);

  // 4. 测试获取已平仓订单
  console.log('\n4️⃣ 测试获取已平仓订单...');
  const closedOrders = await newAccount.getClosedOrders(10);
  console.log(`   ✅ 最近平仓: ${closedOrders.length} 个`);
  if (closedOrders.length > 0) {
    console.log(`   最新平仓: ${closedOrders[0].symbol} (ROI: ${(closedOrders[0].roi * 100).toFixed(2)}%)`);
  }
}

async function testPerformance() {
  console.log('\n\n⚡ 性能测试\n');

  const oldAccount = new SimulatedAccount({ pool });
  const newAccount = new SimulatedAccountV2({ pool });

  // 测试读取性能
  console.log('读取性能对比:');

  const oldStart = Date.now();
  await oldAccount.read();
  const oldTime = Date.now() - oldStart;
  console.log(`   旧版: ${oldTime}ms`);

  const newStart = Date.now();
  await newAccount.read();
  const newTime = Date.now() - newStart;
  console.log(`   新版: ${newTime}ms`);

  if (newTime < oldTime) {
    console.log(`   🚀 新版快 ${oldTime - newTime}ms (${((1 - newTime/oldTime) * 100).toFixed(1)}%)`);
  } else {
    console.log(`   ⚠️  新版慢 ${newTime - oldTime}ms`);
  }

  // 测试状态获取性能
  console.log('\n状态获取性能对比:');

  const oldStatusStart = Date.now();
  await oldAccount.status();
  const oldStatusTime = Date.now() - oldStatusStart;
  console.log(`   旧版: ${oldStatusTime}ms`);

  const newStatusStart = Date.now();
  await newAccount.status();
  const newStatusTime = Date.now() - newStatusStart;
  console.log(`   新版: ${newStatusTime}ms`);

  if (newStatusTime < oldStatusTime) {
    console.log(`   🚀 新版快 ${oldStatusTime - newStatusTime}ms`);
  } else {
    console.log(`   ⚠️  新版慢 ${newStatusTime - oldStatusTime}ms`);
  }
}

async function main() {
  console.log('🔄 SimulatedAccount 迁移验证\n');
  console.log('=' .repeat(70) + '\n');

  try {
    // 创建账户实例
    const oldAccount = new SimulatedAccount({ pool });
    const newAccount = new SimulatedAccountV2({ pool });

    // 初始化
    await oldAccount.init();
    await newAccount.init();

    // 比较两个实现
    const comparison = await compareAccounts(oldAccount, newAccount);

    // 测试新功能
    await testNewFeatures(newAccount);

    // 性能测试
    await testPerformance();

    // 总结
    console.log('\n\n' + '=' .repeat(70));
    console.log('📋 迁移验证总结\n');

    if (comparison.orderCountMatch && comparison.balanceMatch && comparison.fieldMismatches === 0) {
      console.log('✅ 数据一致性: 完全一致');
      console.log('✅ 新版实现: 功能正常');
      console.log('✅ 可以安全切换到新版本');
      console.log('\n下一步:');
      console.log('1. 修改 server.js，将 SimulatedAccount 替换为 SimulatedAccountV2');
      console.log('2. 重启服务');
      console.log('3. 监控日志，确认无错误');
      console.log('4. 验收测试通过后，可删除旧的 simulated_account 表');
    } else {
      console.log('⚠️  发现不一致:');
      if (!comparison.orderCountMatch) console.log('   - 订单数量不匹配');
      if (!comparison.balanceMatch) console.log('   - 账户余额不匹配');
      if (comparison.fieldMismatches > 0) console.log(`   - ${comparison.fieldMismatches} 个字段不匹配`);
      console.log('\n需要检查迁移脚本，确保数据完整性');
    }

  } catch (error) {
    console.error('\n❌ 验证失败:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
