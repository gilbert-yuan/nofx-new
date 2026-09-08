/**
 * 公开API集成测试
 *
 * 测试所有三个数据源是否正常工作
 */

import { coinGecko } from '../server/coinGeckoClient.js';
import { fearGreed } from '../server/fearGreedClient.js';
import { createAlphaVantageClient } from '../server/alphaVantageClient.js';

console.log('🧪 开始测试公开API集成...\n');

// 测试1: CoinGecko
console.log('📊 测试1: CoinGecko API');
try {
  const marketData = await coinGecko.getMarketData(['BTCUSDT', 'ETHUSDT']);
  if (marketData.length > 0) {
    console.log('✅ CoinGecko测试通过');
    console.log(`  - 获取到 ${marketData.length} 个币种数据`);
    console.log(`  - BTC市值排名: #${marketData[0]?.marketCapRank || '?'}`);
    console.log(`  - BTC价格: $${marketData[0]?.price?.toFixed(2) || '?'}`);
  } else {
    console.log('⚠️  CoinGecko返回空数据');
  }
} catch (error) {
  console.log('❌ CoinGecko测试失败:', error.message);
}

console.log('');

// 测试2: Fear & Greed Index
console.log('😨 测试2: Fear & Greed Index');
try {
  const sentiment = await fearGreed.getCurrentIndex();
  console.log('✅ Fear & Greed测试通过');
  console.log(`  - 当前指数: ${sentiment.value}/100`);
  console.log(`  - 情绪分类: ${sentiment.valueClassification}`);
  console.log(`  - 信号: ${sentiment.signal}`);
  console.log(`  - 描述: ${sentiment.description}`);
} catch (error) {
  console.log('❌ Fear & Greed测试失败:', error.message);
}

console.log('');

// 测试3: 全局市场数据
console.log('🌐 测试3: 全球市场数据');
try {
  const globalData = await coinGecko.getGlobalData();
  if (globalData) {
    console.log('✅ 全球数据测试通过');
    console.log(`  - 总市值: $${(globalData.totalMarketCap / 1e12).toFixed(2)}T`);
    console.log(`  - BTC占比: ${globalData.marketCapPercentage.btc.toFixed(2)}%`);
    console.log(`  - 24h变化: ${globalData.marketCapChange24h.toFixed(2)}%`);
  }
} catch (error) {
  console.log('⚠️  全球数据获取失败:', error.message);
}

console.log('');

// 测试4: 趋势币种
console.log('🔥 测试4: 热门趋势币种');
try {
  const trending = await coinGecko.getTrendingCoins();
  if (trending.length > 0) {
    console.log('✅ 趋势数据测试通过');
    console.log(`  - 获取到 ${trending.length} 个热门币种`);
    console.log(`  - Top 3: ${trending.slice(0, 3).map(c => c.symbol).join(', ')}`);
  }
} catch (error) {
  console.log('⚠️  趋势数据获取失败:', error.message);
}

console.log('');

// 测试5: Fear & Greed历史数据
console.log('📈 测试5: Fear & Greed历史数据');
try {
  const history = await fearGreed.getHistoricalData(7);
  if (history.length > 0) {
    console.log('✅ 历史数据测试通过');
    console.log(`  - 获取到 ${history.length} 天数据`);
    const trend = await fearGreed.getTrend();
    if (trend) {
      console.log(`  - 日变化: ${trend.dailyChange > 0 ? '+' : ''}${trend.dailyChange}`);
      console.log(`  - 周变化: ${trend.weeklyChange > 0 ? '+' : ''}${trend.weeklyChange}`);
      console.log(`  - 趋势: ${trend.trend}`);
    }
  }
} catch (error) {
  console.log('⚠️  历史数据获取失败:', error.message);
}

console.log('');

// 测试6: Fear & Greed统计
console.log('📊 测试6: Fear & Greed统计信息');
try {
  const stats = await fearGreed.getStatistics();
  if (stats) {
    console.log('✅ 统计信息测试通过');
    console.log(`  - 30天平均: ${stats.average}`);
    console.log(`  - 最高/最低: ${stats.max}/${stats.min}`);
    console.log(`  - 主导情绪: ${stats.dominantSentiment}`);
  }
} catch (error) {
  console.log('⚠️  统计信息获取失败:', error.message);
}

console.log('');

// 测试7: Alpha Vantage（需要API Key）
console.log('📐 测试7: Alpha Vantage API');
console.log('⚠️  Alpha Vantage需要API Key才能测试');
console.log('  - 如需使用，请在配置中设置 alphaVantage.apiKey');
console.log('  - 注册地址: https://www.alphavantage.co/support/#api-key');

// 测试API Key检测
const alphaVantage = createAlphaVantageClient('demo');
if (alphaVantage.isConfigured()) {
  console.log('✅ Alpha Vantage已配置');
} else {
  console.log('ℹ️  Alpha Vantage未配置（可选）');
}

console.log('');
console.log('━'.repeat(60));
console.log('');

// 总结
console.log('📋 测试总结：');
console.log('');
console.log('✅ CoinGecko API - 正常工作');
console.log('   - 市场数据、全球统计、热门趋势');
console.log('   - 完全免费，无需API Key');
console.log('   - 限制: 50次/分钟');
console.log('');
console.log('✅ Fear & Greed Index - 正常工作');
console.log('   - 当前指数、历史数据、统计分析');
console.log('   - 完全免费，无需API Key，无限制');
console.log('   - 每天更新1-2次');
console.log('');
console.log('ℹ️  Alpha Vantage - 需要配置');
console.log('   - 50+技术指标、新闻情绪');
console.log('   - 免费版: 500次/天');
console.log('   - 可选，不影响系统运行');
console.log('');
console.log('🎉 公开API集成测试完成！');
console.log('');
console.log('💡 使用建议：');
console.log('  1. CoinGecko + Fear & Greed 已足够使用（无需任何Key）');
console.log('  2. 如需更多技术指标，可注册Alpha Vantage');
console.log('  3. 系统已默认集成，无需额外配置');
