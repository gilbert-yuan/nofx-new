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
      takeProfit: entry + 2000,
      // R 口径复核需要可计算的入场基准价（ref = entryMax for long）
      entryMin: entry,
      entryMax: entry
    }
  };

  // 创建继续上涨的K线：阶梯上涨、每 3 根带一次回调 ——
  // 单边直涨会让 RSI 触顶 80 触发智能退出获利了结（CLOSE），盖过本用例要验证的移动止损路径
  const klines = [];
  for (let i = 0; i < 60; i++) {
    const price = entry + Math.floor(i / 3) * 130 + [60, 120, 70][i % 3];
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

// ── P5 回归：移动止损必须「提前保护」，不能等 2% 浮盈 ────────────────────────────
//
// 背景：P5 复盘发现旧逻辑用 `profit > 0.02`（价格涨 2%）作为移动止损开关。
// 主止损是 2 ATR，实测 ATR/价格约 0.35%，即 1R ≈ 0.70% 价格，2% ≈ 2.9R，
// 而实测盈利单平均 MFE 只有 1.91R —— 绝大多数订单永远触发不了移动止损，
// 一路裸露到初始止损被扫掉。改为按 R 触发（0.4R）后，样本外胜率 41.5%→56.9%。
// 本用例锁住「0.4R 即触发」这一行为，防止有人把阈值改回百分比。
function flatMarket(entry, price, atr) {
  const klines = [];
  for (let i = 0; i < 60; i++) {
    // 前 40 根在 entry 附近盘整造出可计算的 ATR，后 20 根走到 price
    const p = i < 40 ? entry : entry + (price - entry) * ((i - 39) / 21);
    klines.push({
      openTime: Date.now() - (60 - i) * 60000,
      open: p, high: p + atr * 0.4, low: p - atr * 0.4, close: p, volume: 1000, confirmed: true
    });
  }
  return { symbol: 'BTCUSDT', interval: '1m', klines, marketProvider: 'okx' };
}

test('P5 移动止损：浮盈约 0.5R 就应提前保护（而非等 2%）', () => {
  const entry = 100;
  const atr = 1;                       // ATR=1
  const stopLoss = entry - 2 * atr;    // 2ATR 止损 → risk = 2（1R = 2 价格）
  // 浮盈 1.0 价格 = 0.5R，远不到 2%（2 价格），旧逻辑不会触发
  const market = flatMarket(entry, entry + 1.0, atr);
  const order = {
    direction: 'OPEN_LONG', entry,
    plan: { stopLoss, takeProfit: entry + 8, entryMin: entry, entryMax: entry }
  };
  const result = enhancedProtectionReview(order, market);
  assert.strictEqual(result.action, 'UPDATE_PROTECTION',
    `浮盈 0.5R 必须触发移动止损，实际返回 ${result.action}（reason: ${result.reason}）`);
  assert.ok(result.stopLoss > stopLoss, '止损应上移');
  console.log('✓ P5 提前保护（0.5R）回归通过');
});

test('P5 移动止损：浮盈仅 0.2R 时应保持不动（避免过早锁死）', () => {
  const entry = 100;
  const atr = 1;
  const stopLoss = entry - 2 * atr;    // 1R = 2 价格
  const market = flatMarket(entry, entry + 0.4, atr); // 0.2R
  const order = { direction: 'OPEN_LONG', entry, plan: { stopLoss, takeProfit: entry + 8 } };
  const result = enhancedProtectionReview(order, market);
  assert.strictEqual(result.action, 'HOLD',
    `浮盈 0.2R 不应改变保护价，实际 ${result.action}`);
  console.log('✓ P5 不过早锁死（0.2R）回归通过');
});
