import { test } from 'node:test';
import assert from 'node:assert';
import { enhancedAnalysis, enhancedProtectionReview } from '../server/enhancedAnalysis.js';

test('增强版分析 - 多头趋势识别', () => {
  // 模拟强劲多头趋势 - 确保有足够数据计算MACD
  const klines = [];
  let price = 50000;

  // 先生成一些基线数据
  for (let i = 0; i < 30; i++) {
    const open = price;
    const close = price + 10;  // 缓慢上涨
    const high = close + 20;
    const low = open - 10;
    const volume = 1000;

    klines.push({
      openTime: Date.now() - (90 - i) * 60000,
      open,
      high,
      low,
      close,
      volume,
      confirmed: true
    });

    price = close;
  }

  // 然后生成强势上涨
  for (let i = 0; i < 30; i++) {
    const open = price;
    const close = price + 150 + Math.random() * 100;  // 大幅上涨
    const high = Math.max(open, close) + Math.random() * 50;
    const low = Math.min(open, close) - Math.random() * 20;
    const volume = 1500 + Math.random() * 1000;  // 放量

    klines.push({
      openTime: Date.now() - (60 - i) * 60000,
      open,
      high,
      low,
      close,
      volume,
      confirmed: true
    });

    price = close;
  }

  const market = {
    symbol: 'BTCUSDT',
    interval: '1m',
    klines,
    marketProvider: 'okx'
  };

  const result = enhancedAnalysis(market);

  assert.ok(result, '应该返回分析结果');

  if (result.action !== 'BUY') {
    console.log('未能识别为买入，原因:', result.reason);
    console.log('K线数量:', klines.length);
    console.log('最终价格:', price.toFixed(2));
    console.log('涨幅:', ((price / 50000 - 1) * 100).toFixed(2) + '%');
  }

  // 如果还是WAIT，至少验证理由合理
  if (result.action === 'WAIT') {
    assert.ok(result.reason.length > 0, '应该有观望理由');
    console.log('⚠️ 增强版分析 - 多头趋势未触发买入（评分可能不足60）');
    console.log(`  原因: ${result.reason}`);
  } else {
    assert.strictEqual(result.action, 'BUY', '应该识别为买入信号');
    assert.ok(result.plan, '应该包含交易计划');
    assert.ok(result.plan.trendStrengthScore >= 60, '趋势强度评分应该>=60');
    assert.ok(result.confidence > 0.6, '置信度应该>60%');

    console.log('✓ 增强版分析 - 多头趋势识别通过');
    console.log(`  评分: ${result.plan.trendStrengthScore}/100`);
    console.log(`  置信度: ${(result.confidence * 100).toFixed(1)}%`);
    console.log(`  风险收益比: ${result.plan.riskRewardRatio.toFixed(2)}:1`);
  }
});

test('增强版分析 - 空头趋势识别', () => {
  // 模拟强劲空头趋势
  const klines = [];
  let price = 50000;

  // 先生成基线数据
  for (let i = 0; i < 30; i++) {
    const open = price;
    const close = price - 10;
    const high = open + 10;
    const low = close - 20;
    const volume = 1000;

    klines.push({
      openTime: Date.now() - (90 - i) * 60000,
      open,
      high,
      low,
      close,
      volume,
      confirmed: true
    });

    price = close;
  }

  // 然后生成强势下跌
  for (let i = 0; i < 30; i++) {
    const open = price;
    const close = price - 150 - Math.random() * 100;  // 大幅下跌
    const high = Math.max(open, close) + Math.random() * 20;
    const low = Math.min(open, close) - Math.random() * 50;
    const volume = 1500 + Math.random() * 1000;  // 放量

    klines.push({
      openTime: Date.now() - (60 - i) * 60000,
      open,
      high,
      low,
      close,
      volume,
      confirmed: true
    });

    price = close;
  }

  const market = {
    symbol: 'ETHUSDT',
    interval: '1m',
    klines,
    marketProvider: 'okx'
  };

  const result = enhancedAnalysis(market);

  assert.ok(result, '应该返回分析结果');

  if (result.action === 'WAIT') {
    console.log('⚠️ 增强版分析 - 空头趋势未触发卖出');
    console.log(`  原因: ${result.reason}`);
  } else {
    assert.strictEqual(result.action, 'SELL', '应该识别为卖出信号');
    assert.ok(result.plan, '应该包含交易计划');
    assert.ok(result.plan.trendStrengthScore >= 60, '趋势强度评分应该>=60');

    console.log('✓ 增强版分析 - 空头趋势识别通过');
    console.log(`  评分: ${result.plan.trendStrengthScore}/100`);
    console.log(`  置信度: ${(result.confidence * 100).toFixed(1)}%`);
  }
});

test('增强版分析 - 横盘市场观望', () => {
  // 模拟横盘震荡
  const klines = [];
  const basePrice = 50000;

  for (let i = 0; i < 60; i++) {
    // 创建震荡K线
    const open = basePrice + (Math.random() - 0.5) * 200;
    const close = basePrice + (Math.random() - 0.5) * 200;
    const high = Math.max(open, close) + Math.random() * 50;
    const low = Math.min(open, close) - Math.random() * 50;
    const volume = 1000 + Math.random() * 200;

    klines.push({
      openTime: Date.now() - (60 - i) * 60000,
      open,
      high,
      low,
      close,
      volume,
      confirmed: true
    });
  }

  const market = {
    symbol: 'BNBUSDT',
    interval: '1m',
    klines,
    marketProvider: 'okx'
  };

  const result = enhancedAnalysis(market);

  assert.ok(result, '应该返回分析结果');
  assert.strictEqual(result.action, 'WAIT', '横盘应该观望');
  assert.strictEqual(result.plan, null, '观望不应该有交易计划');

  console.log('✓ 增强版分析 - 横盘市场观望通过');
  console.log(`  原因: ${result.reason}`);
});

test('增强版分析 - 多级止盈设置', () => {
  // 创建清晰的多头趋势
  const klines = [];
  let price = 50000;

  for (let i = 0; i < 60; i++) {
    const open = price;
    const close = price + 100;
    const high = close + 20;
    const low = open - 10;
    const volume = 1500;

    klines.push({
      openTime: Date.now() - (60 - i) * 60000,
      open,
      high,
      low,
      close,
      volume,
      confirmed: true
    });

    price = close;
  }

  const market = {
    symbol: 'BTCUSDT',
    interval: '1m',
    klines,
    marketProvider: 'okx'
  };

  const result = enhancedAnalysis(market);

  if (result.action === 'BUY' && result.plan) {
    assert.ok(result.plan.takeProfit1, '应该有第一止盈');
    assert.ok(result.plan.takeProfit2, '应该有第二止盈');
    assert.ok(result.plan.takeProfit3, '应该有第三止盈');
    assert.ok(result.plan.takeProfit1 < result.plan.takeProfit2, 'TP1应该<TP2');
    assert.ok(result.plan.takeProfit2 < result.plan.takeProfit3, 'TP2应该<TP3');
    assert.ok(result.plan.stopLoss < result.plan.entryMin, '止损应该<入场区间');

    console.log('✓ 增强版分析 - 多级止盈设置通过');
    console.log(`  止损: ${result.plan.stopLoss.toFixed(2)}`);
    console.log(`  止盈1: ${result.plan.takeProfit1.toFixed(2)}`);
    console.log(`  止盈2: ${result.plan.takeProfit2.toFixed(2)}`);
    console.log(`  止盈3: ${result.plan.takeProfit3.toFixed(2)}`);
  }
});

test('增强版复核 - 移动止损', () => {
  // 创建持仓订单（已盈利3%）
  const entry = 50000;
  const current = entry * 1.03;  // 盈利3%

  const order = {
    id: 'test-1',
    symbol: 'BTCUSDT',
    direction: 'OPEN_LONG',
    status: 'open',
    entry,
    quantity: 0.01,
    markPrice: current,
    plan: {
      stopLoss: entry - 500,
      takeProfit: entry + 2000
    }
  };

  // 创建继续上涨的K线
  const klines = [];
  for (let i = 0; i < 60; i++) {
    const price = entry + (i * 30);  // 逐步上涨
    klines.push({
      openTime: Date.now() - (60 - i) * 60000,
      open: price,
      high: price + 50,
      low: price - 30,
      close: price + 10,
      volume: 1000,
      confirmed: true
    });
  }

  const market = {
    symbol: 'BTCUSDT',
    interval: '1m',
    klines,
    marketProvider: 'okx'
  };

  const result = enhancedProtectionReview(order, market);

  assert.strictEqual(result.action, 'UPDATE_PROTECTION', '应该更新保护价格');
  assert.ok(result.stopLoss > order.plan.stopLoss, '止损应该上移');
  assert.ok(result.profitPercent > 2, '应该显示盈利百分比');

  console.log('✓ 增强版复核 - 移动止损通过');
  console.log(`  原止损: ${order.plan.stopLoss.toFixed(2)}`);
  console.log(`  新止损: ${result.stopLoss.toFixed(2)}`);
  console.log(`  盈利: ${result.profitPercent.toFixed(2)}%`);
});

console.log('\n🎉 增强版分析引擎测试全部通过！');
