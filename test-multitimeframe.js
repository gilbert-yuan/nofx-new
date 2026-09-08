import { localAnalysis, localAnalysisMultiTimeframe } from './server/localAnalysis.js';

// 模拟市场数据
function generateMockMarket(symbol, trend = 'up', volatility = 0.02) {
  const klines = [];
  let basePrice = 50000;

  for (let i = 0; i < 80; i++) {
    const trendMove = trend === 'up' ? basePrice * 0.001 : -basePrice * 0.001;
    const noise = (Math.random() - 0.5) * basePrice * volatility;

    basePrice += trendMove + noise;

    const open = basePrice;
    const close = basePrice + (Math.random() - 0.5) * basePrice * volatility * 0.5;
    const high = Math.max(open, close) * (1 + Math.random() * volatility * 0.5);
    const low = Math.min(open, close) * (1 - Math.random() * volatility * 0.5);

    klines.push({
      openTime: Date.now() - (80 - i) * 15 * 60 * 1000,
      open,
      high,
      low,
      close,
      volume: Math.random() * 1000
    });
  }

  return { symbol, interval: '15m', klines };
}

console.log('=== 测试单周期分析 ===\n');
const market15m = generateMockMarket('BTCUSDT', 'up', 0.02);
const result1 = localAnalysis(market15m);
console.log('信号:', result1.action);
console.log('置信度:', result1.confidence);
console.log('原因:', result1.reason);
console.log('计划:', result1.plan ? '有' : '无');
console.log();

console.log('=== 测试多周期分析（趋势一致）===\n');
const market1h = generateMockMarket('BTCUSDT', 'up', 0.03);
market1h.interval = '1h';
const market4h = generateMockMarket('BTCUSDT', 'up', 0.04);
market4h.interval = '4h';

const auxMarkets1 = {
  '15m': market15m,
  '1h': market1h,
  '4h': market4h
};

const result2 = localAnalysisMultiTimeframe(market15m, auxMarkets1);
console.log('信号:', result2.action);
console.log('置信度:', result2.confidence);
console.log('原因:', result2.reason);
console.log('多周期分析:');
if (result2.multiTimeframeAnalysis) {
  for (const [interval, analysis] of Object.entries(result2.multiTimeframeAnalysis)) {
    console.log(`  ${interval}: ${analysis.trend} - ${analysis.reason}`);
  }
}
console.log('计划:', result2.plan ? '有' : '无');
console.log();

console.log('=== 测试多周期分析（趋势不一致）===\n');
const market1h_down = generateMockMarket('BTCUSDT', 'down', 0.03);
market1h_down.interval = '1h';
const market4h_down = generateMockMarket('BTCUSDT', 'down', 0.04);
market4h_down.interval = '4h';

const auxMarkets2 = {
  '15m': market15m, // 上升
  '1h': market1h_down, // 下降
  '4h': market4h_down // 下降
};

const result3 = localAnalysisMultiTimeframe(market15m, auxMarkets2);
console.log('信号:', result3.action);
console.log('置信度:', result3.confidence);
console.log('原因:', result3.reason);
console.log('多周期分析:');
if (result3.multiTimeframeAnalysis) {
  for (const [interval, analysis] of Object.entries(result3.multiTimeframeAnalysis)) {
    console.log(`  ${interval}: ${analysis.trend} - ${analysis.reason}`);
  }
}
console.log('计划:', result3.plan ? '有' : '无');
console.log();

console.log('✓ 测试完成');
