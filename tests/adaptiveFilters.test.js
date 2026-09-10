import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterSymbolsByPerformance,
  identifyHighProbabilityHours,
  shouldTradeAtCurrentHour,
  getAdaptiveParametersForSymbol,
  adjustForVolatility,
  shouldOpenPosition
} from '../server/adaptiveFilters.js';

const expect = actual => ({
  toContain: expected => assert.ok(actual.includes(expected)),
  toHaveLength: expected => assert.equal(actual.length, expected),
  toBeCloseTo: (expected, digits = 2) => assert.ok(Math.abs(actual - expected) < 0.5 * 10 ** -digits),
  toEqual: expected => assert.deepEqual(actual, expected),
  toBe: expected => assert.equal(actual, expected),
  toBeGreaterThan: expected => assert.ok(actual > expected),
  toBeLessThan: expected => assert.ok(actual < expected),
  get not() {
    return { toContain: expected => assert.ok(!actual.includes(expected)) };
  }
});

describe('adaptiveFilters', () => {
  describe('filterSymbolsByPerformance', () => {
    it('应该保留样本不足的币种', () => {
      const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
      const orders = [
        { symbol: 'BTCUSDT', status: 'closed', net: 10 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 }
      ];

      const result = filterSymbolsByPerformance(symbols, orders, {
        minSampleSize: 5,
        minWinRate: 0.35
      });

      expect(result.filtered).toContain('BTCUSDT');
      expect(result.filtered).toContain('ETHUSDT'); // 无历史数据，保留
      expect(result.filtered).toContain('SOLUSDT');
    });

    it('应该过滤低胜率币种', () => {
      const symbols = ['BTCUSDT', 'ETHUSDT'];
      // 排除门槛为 MIN_SAMPLE_SIZE_TO_EXCLUDE(10)，样本数须 ≥10 才会被拉黑，
      // 因此这里用 12 单（2 胜 10 负 = 16.7% 胜率）以命中排除逻辑。
      const orders = [
        { symbol: 'BTCUSDT', status: 'closed', net: 10 },
        { symbol: 'BTCUSDT', status: 'closed', net: 10 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 } // 2/12 = 16.7% 胜率
      ];

      const result = filterSymbolsByPerformance(symbols, orders, {
        minSampleSize: 5,
        minWinRate: 0.35
      });

      expect(result.filtered).not.toContain('BTCUSDT');
      expect(result.filteredOut).toHaveLength(1);
      expect(result.filteredOut[0].symbol).toBe('BTCUSDT');
      expect(result.filteredOut[0].winRate).toBeCloseTo(0.167, 2);
    });

    it('应该保留高胜率币种', () => {
      const symbols = ['BTCUSDT'];
      const orders = [
        { symbol: 'BTCUSDT', status: 'closed', net: 10 },
        { symbol: 'BTCUSDT', status: 'closed', net: 10 },
        { symbol: 'BTCUSDT', status: 'closed', net: 10 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 } // 3/5 = 60% 胜率
      ];

      const result = filterSymbolsByPerformance(symbols, orders, {
        minSampleSize: 5,
        minWinRate: 0.35
      });

      expect(result.filtered).toContain('BTCUSDT');
      expect(result.filteredOut).toHaveLength(0);
    });

    it('禁用时应该返回所有币种', () => {
      const symbols = ['BTCUSDT', 'ETHUSDT'];
      const orders = [
        { symbol: 'BTCUSDT', status: 'closed', net: -5 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 },
        { symbol: 'BTCUSDT', status: 'closed', net: -5 }
      ];

      const result = filterSymbolsByPerformance(symbols, orders, {
        minSampleSize: 5,
        minWinRate: 0.35,
        enabled: false
      });

      expect(result.filtered).toEqual(symbols);
      expect(result.filteredOut).toHaveLength(0);
    });
  });

  describe('identifyHighProbabilityHours', () => {
    it('应该识别高胜率时段', () => {
      const orders = [];
      // 在8:00 UTC创建5笔盈利订单
      for (let i = 0; i < 5; i++) {
        orders.push({
          status: 'closed',
          createdAt: new Date(Date.UTC(2024, 0, 1, 8, i)).toISOString(),
          net: 10
        });
      }
      // 在12:00 UTC创建5笔亏损订单
      for (let i = 0; i < 5; i++) {
        orders.push({
          status: 'closed',
          createdAt: new Date(Date.UTC(2024, 0, 1, 12, i)).toISOString(),
          net: -5
        });
      }

      const result = identifyHighProbabilityHours(orders, {
        minSampleSize: 5,
        minWinRate: 0.55
      });

      expect(result.highProbHours).toContain(8); // 100% 胜率
      expect(result.highProbHours).not.toContain(12); // 0% 胜率
    });

    it('样本不足时应该返回空数组', () => {
      const orders = [
        {
          status: 'closed',
          createdAt: new Date(Date.UTC(2024, 0, 1, 8, 0)).toISOString(),
          net: 10
        }
      ];

      const result = identifyHighProbabilityHours(orders, {
        minSampleSize: 5,
        minWinRate: 0.55
      });

      expect(result.highProbHours).toHaveLength(0);
    });
  });

  describe('shouldTradeAtCurrentHour', () => {
    it('应该允许在高胜率时段交易', () => {
      const orders = [];
      for (let i = 0; i < 6; i++) {
        orders.push({
          status: 'closed',
          createdAt: new Date(Date.UTC(2024, 0, 1, 8, i)).toISOString(),
          net: 10
        });
      }

      const result = shouldTradeAtCurrentHour(8, orders, {
        minSampleSize: 5,
        minWinRate: 0.55
      });

      expect(result.shouldTrade).toBe(true);
    });

    it('应该拒绝在低胜率时段交易', () => {
      const orders = [];
      for (let i = 0; i < 5; i++) {
        orders.push({
          status: 'closed',
          createdAt: new Date(Date.UTC(2024, 0, 1, 12, i)).toISOString(),
          net: -5
        });
      }

      const result = shouldTradeAtCurrentHour(12, orders, {
        minSampleSize: 5,
        minWinRate: 0.55
      });

      expect(result.shouldTrade).toBe(false);
    });

    it('样本不足时应该允许交易', () => {
      const orders = [
        {
          status: 'closed',
          createdAt: new Date(Date.UTC(2024, 0, 1, 8, 0)).toISOString(),
          net: 10
        }
      ];

      const result = shouldTradeAtCurrentHour(8, orders, {
        minSampleSize: 5,
        minWinRate: 0.55
      });

      expect(result.shouldTrade).toBe(true);
      expect(result.reason).toContain('数据不足');
    });
  });

  describe('getAdaptiveParametersForSymbol', () => {
    it('样本不足时应该返回默认参数', () => {
      const orders = [
        { symbol: 'BTCUSDT', status: 'closed', net: 10, heldBars: 10 }
      ];

      const result = getAdaptiveParametersForSymbol('BTCUSDT', orders, {
        defaultStopLossATR: 2.5,
        defaultTakeProfitATR: 4.0,
        minSampleSize: 10
      });

      expect(result.stopLossATR).toBe(2.5);
      expect(result.takeProfitATR).toBe(4.0);
      expect(result.confidence).toBe(0);
    });

    it('止损触发率高时应该放宽止损', () => {
      const orders = [];
      for (let i = 0; i < 10; i++) {
        orders.push({
          symbol: 'BTCUSDT',
          status: 'closed',
          net: -5,
          heldBars: 10,
          reason: i < 5 ? '止损' : '时间到期'
        });
      }

      const result = getAdaptiveParametersForSymbol('BTCUSDT', orders, {
        defaultStopLossATR: 2.5,
        defaultTakeProfitATR: 4.0,
        minSampleSize: 10
      });

      expect(result.stopLossATR).toBeGreaterThan(2.5);
      expect(result.reason).toContain('放宽');
    });

    it('止盈难以触及时应该收紧止盈', () => {
      const orders = [];
      for (let i = 0; i < 10; i++) {
        orders.push({
          symbol: 'BTCUSDT',
          status: 'closed',
          net: 5,
          heldBars: 20,
          reason: '时间到期' // 从未触及止盈
        });
      }

      const result = getAdaptiveParametersForSymbol('BTCUSDT', orders, {
        defaultStopLossATR: 2.5,
        defaultTakeProfitATR: 4.0,
        minSampleSize: 10
      });

      expect(result.takeProfitATR).toBeLessThan(4.0);
      expect(result.reason).toContain('收紧');
    });

    it('识别模拟引擎标准的止损和止盈原因', () => {
      const orders = Array.from({ length: 10 }, (_, i) => ({
        symbol: 'BTCUSDT', status: 'closed', net: i < 5 ? -5 : 5, heldBars: 10,
        reason: i < 5 ? 'stop_loss' : 'take_profit'
      }));
      const result = getAdaptiveParametersForSymbol('BTCUSDT', orders, { minSampleSize: 10 });
      expect(result.stats.stopLossTouchRate).toBeCloseTo(0.5);
      expect(result.stats.takeProfitTouchRate).toBeCloseTo(0.5);
    });
  });

  describe('adjustForVolatility', () => {
    it('高波动时应该放宽止损、缩短持仓', () => {
      const result = adjustForVolatility(150, 100);

      expect(result.stopLossMultiplier).toBeGreaterThan(1);
      expect(result.maxHoldBarsMultiplier).toBeLessThan(1);
      expect(result.reason).toContain('高于均值');
    });

    it('低波动时应该收紧止损、延长持仓', () => {
      const result = adjustForVolatility(60, 100);

      expect(result.stopLossMultiplier).toBeLessThan(1);
      expect(result.maxHoldBarsMultiplier).toBeGreaterThan(1);
      expect(result.reason).toContain('低于均值');
    });

    it('正常波动时不调整', () => {
      const result = adjustForVolatility(100, 100);

      expect(result.stopLossMultiplier).toBe(1);
      expect(result.takeProfitMultiplier).toBe(1);
      expect(result.maxHoldBarsMultiplier).toBe(1);
    });
  });

  describe('shouldOpenPosition', () => {
    it('所有过滤通过时应该允许开仓', () => {
      const orders = [];
      for (let i = 0; i < 6; i++) {
        orders.push({
          symbol: 'BTCUSDT',
          status: 'closed',
          net: 10,
          createdAt: new Date(Date.UTC(2024, 0, 1, 8, i)).toISOString()
        });
      }

      const result = shouldOpenPosition({
        symbol: 'BTCUSDT',
        currentHour: 8,
        historicalOrders: orders,
        options: {
          symbolFilter: { enabled: true, minSampleSize: 5, minWinRate: 0.55 },
          hourFilter: { enabled: true, minSampleSize: 5, minWinRate: 0.55 }
        }
      });

      expect(result.shouldOpen).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it('币种被过滤时应该拒绝开仓', () => {
      const orders = [];
      // 同上：排除门槛为 10 单，这里用 12 单全亏以命中排除逻辑。
      for (let i = 0; i < 12; i++) {
        orders.push({
          symbol: 'BTCUSDT',
          status: 'closed',
          net: -10 // 全部亏损
        });
      }

      const result = shouldOpenPosition({
        symbol: 'BTCUSDT',
        currentHour: 8,
        historicalOrders: orders,
        options: {
          symbolFilter: { enabled: true, minSampleSize: 5, minWinRate: 0.35 }
        }
      });

      expect(result.shouldOpen).toBe(false);
      expect(result.reasons.length).toBeGreaterThan(0);
    });
  });
});
