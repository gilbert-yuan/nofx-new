/**
 * 测试统一的交易模拟引擎
 */

import { createBacktestSimulator, createAccountSimulator } from './server/tradingSimulator.js';
import { marketData } from './server/marketData.js';
import { prepareMarket } from './server/research.js';

async function testUnifiedEngine() {
  console.log('='.repeat(60));
  console.log('测试统一交易模拟引擎');
  console.log('='.repeat(60));

  try {
    // 获取测试数据
    console.log('\n1. 获取 ETH/USDT 市场数据...');
    const rows = await marketData.klines({ symbol: 'ETHUSDT', interval: '1m', limit: 100 });
    const market = prepareMarket({
      symbol: 'ETHUSDT',
      interval: '1m',
      rows,
      limit: 80,
      marketProvider: 'okx'
    });

    console.log(`   获取到 ${market.klines.length} 根K线`);
    console.log(`   最新价格: ${market.klines.at(-1).close}`);

    // 创建测试信号
    const testSignal = {
      symbol: 'ETHUSDT',
      interval: '1m',
      eligible: true,
      positionRecommendation: 'OPEN_LONG',
      firstEntryAt: new Date(market.klines[0].openTime).toISOString(),
      expiresAt: new Date(market.klines[5].openTime).toISOString(),
      plan: {
        entryMin: market.klines[1].close * 0.999,
        entryMax: market.klines[1].close * 1.001,
        stopLoss: market.klines[1].close * 0.98,
        takeProfit: market.klines[1].close * 1.02,
        maxHoldBars: 20
      }
    };

    console.log('\n2. 测试回测模式（策略表现）...');
    const backtestSim = createBacktestSimulator();
    const backtestResult = backtestSim.evaluate(testSignal, market.klines);

    console.log('   回测结果:');
    console.log(`   - 状态: ${backtestResult.status}`);
    if (backtestResult.entry) {
      console.log(`   - 入场价: ${backtestResult.entry}`);
      console.log(`   - 入场时间: ${backtestResult.entryAt}`);
    }
    if (backtestResult.status === 'closed') {
      console.log(`   - 出场价: ${backtestResult.exit}`);
      console.log(`   - 出场原因: ${backtestResult.reason}`);
      console.log(`   - 净收益: ${backtestResult.net.toFixed(2)} USDT`);
      console.log(`   - 收益率: ${(backtestResult.netReturn * 100).toFixed(2)}%`);
    }

    console.log('\n3. 测试账户模式（模拟交易）...');
    const accountSim = createAccountSimulator({
      initialBalance: 10000,
      enableLiquidation: true,
      enableIsolatedMargin: true
    });

    // 创建测试订单
    const testOrder = {
      symbol: 'ETHUSDT',
      interval: '1m',
      direction: 'OPEN_LONG',
      nextTime: market.klines[0].openTime,
      expiresAt: new Date(market.klines[5].openTime).toISOString(),
      notional: 1000,
      leverage: 3,
      margin: 333.33,
      costs: {
        feeBps: 6,
        slippageBps: 5,
        fundingBpsPer8h: 3
      },
      plan: {
        entryMin: market.klines[1].close * 0.999,
        entryMax: market.klines[1].close * 1.001,
        stopLoss: market.klines[1].close * 0.98,
        takeProfit: market.klines[1].close * 1.02,
        maxHoldBars: 20
      },
      protectionRevisions: []
    };

    const accountResult = accountSim.evaluate(testOrder, market.klines);

    console.log('   账户模式结果:');
    console.log(`   - 状态: ${accountResult.status}`);
    if (accountResult.entry) {
      console.log(`   - 入场价: ${accountResult.entry}`);
      console.log(`   - 入场时间: ${accountResult.entryAt}`);
    }
    if (accountResult.status === 'closed') {
      console.log(`   - 出场价: ${accountResult.exit}`);
      console.log(`   - 出场原因: ${accountResult.reason}`);
      console.log(`   - 净收益: ${accountResult.net.toFixed(2)} USDT`);
      console.log(`   - ROI: ${(accountResult.roi * 100).toFixed(2)}%`);
      if (accountResult.isolatedLossAdjustment) {
        console.log(`   - 隔离保证金调整: ${accountResult.isolatedLossAdjustment.toFixed(2)} USDT`);
      }
    }

    console.log('\n4. 测试批量回测...');
    const signals = [testSignal];
    const batchResult = await backtestSim.batchBacktest(signals, async (signal) => {
      return market.klines;
    });

    console.log('   批量回测汇总:');
    console.log(`   - 总信号数: ${batchResult.total}`);
    console.log(`   - 已平仓: ${batchResult.closed}`);
    console.log(`   - 盈利: ${batchResult.wins}`);
    console.log(`   - 亏损: ${batchResult.losses}`);
    if (batchResult.winRate !== null) {
      console.log(`   - 胜率: ${(batchResult.winRate * 100).toFixed(1)}%`);
    }
    if (batchResult.averageNet !== null) {
      console.log(`   - 平均净收益: ${batchResult.averageNet.toFixed(2)} USDT`);
    }

    console.log('\n5. 对比两种模式...');
    console.log('   回测模式特点:');
    console.log('   - 每个信号独立1000 USDT');
    console.log('   - 不考虑爆仓');
    console.log('   - 适合快速评估策略');

    console.log('\n   账户模式特点:');
    console.log('   - 支持杠杆（1-5倍）');
    console.log('   - 完整爆仓模拟');
    console.log('   - 隔离保证金保护');
    console.log('   - 适合模拟真实交易');

    console.log('\n='.repeat(60));
    console.log('✅ 统一引擎测试完成！');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    console.error(error.stack);
  }
}

testUnifiedEngine();
