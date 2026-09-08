/**
 * 测试增强分析引擎和高级指标
 */

import { enhancedAnalysis } from './server/enhancedAnalysis.js';
import { marketData } from './server/marketData.js';
import { prepareMarket } from './server/research.js';

async function testEnhanced() {
  try {
    console.log('正在获取 ETHUSDT 市场数据...');
    const rows = await marketData.klines({ symbol: 'ETHUSDT', interval: '1m', limit: 100 });
    const market = prepareMarket({
      symbol: 'ETHUSDT',
      interval: '1m',
      rows,
      limit: 80,
      marketProvider: 'okx'
    });

    if (!market || !market.klines || market.klines.length === 0) {
      console.error('获取市场数据失败或数据为空');
      return;
    }

    console.log(`获取到 ${market.klines.length} 根K线数据`);
    console.log(`最新价格: ${market.klines.at(-1).close}`);
    console.log('');

    console.log('开始执行增强分析...');
    const result = await enhancedAnalysis(market);

    console.log('\n======== 分析结果 ========');
    console.log(`币种: ${result.symbol}`);
    console.log(`操作: ${result.action}`);
    console.log(`置信度: ${(result.confidence * 100).toFixed(2)}%`);
    console.log(`原因: ${result.reason}`);

    // 强制显示 trendScore，即使是 undefined
    console.log('');
    console.log(`trendScore 存在: ${!!result.trendScore}`);
    if (result.trendScore) {
      console.log(`trendScore 类型: ${typeof result.trendScore}`);
      console.log(`trendScore 内容: ${JSON.stringify(result.trendScore, null, 2)}`);
    }
    console.log('');

    if (result.trendScore) {
      console.log('======== 趋势评分 ========');
      console.log(`总分: ${result.trendScore.score}/${result.trendScore.maxScore}`);
      console.log(`百分比: ${((result.trendScore.score / result.trendScore.maxScore) * 100).toFixed(1)}%`);
      console.log('');
      console.log('评分详情:');
      result.trendScore.reasons.forEach((r, i) => {
        console.log(`  ${i + 1}. ${r}`);
      });
    }

    if (result.plan) {
      console.log('');
      console.log('======== 交易计划 ========');
      console.log(`入场区间: ${result.plan.entryMin.toFixed(4)} - ${result.plan.entryMax.toFixed(4)}`);
      console.log(`止损价格: ${result.plan.stopLoss.toFixed(4)}`);
      console.log(`止盈价格: ${result.plan.takeProfit.toFixed(4)}`);
      console.log(`净盈亏比: ${result.plan.netRewardRisk.toFixed(2)}`);
    }

  } catch (error) {
    console.error('测试失败:', error.message);
    console.error(error.stack);
  }
}

testEnhanced();
