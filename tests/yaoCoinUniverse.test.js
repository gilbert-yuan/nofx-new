import test from 'node:test';
import assert from 'node:assert/strict';
import {
  YAO_MARKET_PROFILE_DEFAULTS,
  filterYaoCoinUniverse,
  scoreYaoMarketProfile
} from '../server/yaoCoinUniverse.js';
import { prefilterYaoCoinSymbols } from '../server/yaoCoinAmbushAnalysis.js';

function marketRow(overrides = {}) {
  return {
    symbol: 'TESTUSDT',
    marketCap: 500_000_000,
    marketCapRank: 120,
    volume24h: 50_000_000,
    volumeMarketCapRatio: 0.1,
    circulatingSupply: 5_000_000,
    totalSupply: 10_000_000,
    priceChangePercentage24h: 10,
    ...overrides
  };
}

test('动态市场画像识别合格的市值、流通率和流动性组合', () => {
  const profile = scoreYaoMarketProfile(marketRow());
  assert.equal(profile.symbol, 'TESTUSDT');
  assert.equal(profile.known, true);
  assert.equal(profile.eligible, true);
  assert.equal(profile.circulatingRatio, 0.5);
  assert.ok(profile.score >= YAO_MARKET_PROFILE_DEFAULTS.minScore);
  assert.equal(profile.coverage, 1);
});

test('动态市场画像拒绝过小市值和过低流动性，不形成永久白名单', () => {
  const result = filterYaoCoinUniverse(
    ['TESTUSDT', 'GOODUSDT'],
    [
      marketRow({ symbol: 'TESTUSDT', marketCap: 1_000_000, volume24h: 20_000, volumeMarketCapRatio: 0.0001 }),
      marketRow({ symbol: 'GOODUSDT' })
    ],
    { allowUnknown: false }
  );
  assert.deepEqual(result.filtered, ['GOODUSDT']);
  assert.equal(result.filteredOut.length, 1);
  assert.equal(result.unavailable, false);
});

test('市场画像字段缺失时按配置决定是否保留，全部不可用时 fail-open', () => {
  const keepUnknown = filterYaoCoinUniverse(['UNKNOWNUSDT'], [], { allowUnknown: true });
  assert.deepEqual(keepUnknown.filtered, ['UNKNOWNUSDT']);
  assert.equal(keepUnknown.unavailable, true);

  const rejectUnknown = filterYaoCoinUniverse(['UNKNOWNUSDT'], [], { allowUnknown: false });
  assert.deepEqual(rejectUnknown.filtered, ['UNKNOWNUSDT']);
  assert.equal(rejectUnknown.unavailable, true);
});

test('妖币预筛选复用当前轮市场画像，不依赖固定币种列表', async () => {
  const result = await prefilterYaoCoinSymbols(['TESTUSDT', 'BADUSDT'], {
    params: { marketUniverseEnabled: true, marketUniverseMinScore: 55, marketUniverseAllowUnknown: false },
    deps: {
      superAnalysis: {
        async getMarketDataBatch() {
          return [marketRow({ symbol: 'TESTUSDT' }), marketRow({
            symbol: 'BADUSDT', marketCap: 1_000_000, volume24h: 20_000, volumeMarketCapRatio: 0.0001
          })];
        }
      }
    }
  });
  assert.deepEqual(result.filtered, ['TESTUSDT']);
  assert.equal(result.filteredOut[0].symbol, 'BADUSDT');
  assert.equal(result.unavailable, false);
});

test('数量乘数合约复用基础币种的市场画像，但保留原合约符号', () => {
  const result = filterYaoCoinUniverse(['1000TESTUSDT'], [marketRow({ symbol: 'TESTUSDT' })], { allowUnknown: false });
  assert.deepEqual(result.filtered, ['1000TESTUSDT']);
  assert.equal(result.profiles[0].symbol, '1000TESTUSDT');
});
