/**
 * 超级增强版分析引擎
 *
 * 集成了3大免费数据源：
 * 1. CoinGecko - 市场数据（市值、成交量、排名）
 * 2. Fear & Greed Index - 市场情绪
 * 3. Alpha Vantage - 技术指标（可选，需API Key）
 *
 * 在原有8个指标基础上，新增：
 * - 市值排名过滤
 * - 成交量/市值比过滤
 * - 恐慌贪婪指数调整
 * - 新闻情绪分析（可选）
 */

import { enhancedAnalysis, enhancedProtectionReview } from './enhancedAnalysis.js';
import { coinGecko } from './coinGeckoClient.js';
import { fearGreed } from './fearGreedClient.js';
import { createAlphaVantageClient } from './alphaVantageClient.js';

export class SuperEnhancedAnalysis {
  constructor({ store }) {
    this.store = store;
    this.alphaVantage = null;
    this.sentimentCache = new Map();
    this.marketDataCache = new Map();
  }

  /**
   * 初始化Alpha Vantage客户端
   */
  async initAlphaVantage() {
    if (this.alphaVantage) return;

    try {
      const config = await this.store.getConfig();
      const apiKey = config.alphaVantage?.apiKey;

      if (apiKey && apiKey.length > 10) {
        this.alphaVantage = createAlphaVantageClient(apiKey);
        console.log('[SuperEnhanced] Alpha Vantage已启用');
      } else {
        console.log('[SuperEnhanced] Alpha Vantage未配置，将使用本地计算');
      }
    } catch (error) {
      console.error('[SuperEnhanced] 初始化Alpha Vantage失败:', error.message);
    }
  }

  /**
   * 获取市场数据（带缓存）
   */
  async getMarketData(symbol) {
    const cacheKey = symbol;
    const cached = this.marketDataCache.get(cacheKey);

    if (cached && Date.now() - cached.time < 5 * 60 * 1000) {
      return cached.data;
    }

    try {
      const marketData = await coinGecko.getMarketData([symbol]);
      if (marketData.length > 0) {
        const data = marketData[0];
        this.marketDataCache.set(cacheKey, { data, time: Date.now() });
        return data;
      }
    } catch (error) {
      console.error(`[SuperEnhanced] 获取${symbol}市场数据失败:`, error.message);
    }

    return null;
  }

  /**
   * 获取市场情绪（带缓存）
   */
  async getSentiment() {
    const cacheKey = 'fear_greed';
    const cached = this.sentimentCache.get(cacheKey);

    if (cached && Date.now() - cached.time < 10 * 60 * 1000) {
      return cached.data;
    }

    try {
      const sentiment = await fearGreed.getCurrentIndex();
      this.sentimentCache.set(cacheKey, { data: sentiment, time: Date.now() });
      return sentiment;
    } catch (error) {
      console.error('[SuperEnhanced] 获取市场情绪失败:', error.message);
      return null;
    }
  }

  /**
   * 超级增强版分析（集成所有数据源）
   */
  async analyze(market) {
    await this.initAlphaVantage();

    // 1. 基础增强版分析
    const baseAnalysis = enhancedAnalysis(market);

    // 如果基础分析就是WAIT，直接返回
    if (baseAnalysis.action === 'WAIT') {
      return baseAnalysis;
    }

    const symbol = market.symbol;
    const enhancements = [];
    let confidenceMultiplier = 1.0;
    let scoreAdjustment = 0;

    // 2. 获取市场数据（CoinGecko）
    const marketData = await this.getMarketData(symbol);
    if (marketData) {
      // 市值排名过滤
      if (marketData.marketCapRank > 100) {
        return {
          ...baseAnalysis,
          action: 'WAIT',
          reason: `市值排名${marketData.marketCapRank}，建议只交易前100币种`,
          confidence: 0
        };
      }

      // 成交量/市值比过滤（流动性）
      if (marketData.volumeMarketCapRatio < 0.01) {
        enhancements.push(`流动性偏低(${(marketData.volumeMarketCapRatio * 100).toFixed(2)}%)`);
        confidenceMultiplier *= 0.9;
        scoreAdjustment -= 5;
      }

      // 24小时涨跌幅参考
      if (Math.abs(marketData.priceChangePercentage24h) > 15) {
        enhancements.push(`24h波动${marketData.priceChangePercentage24h.toFixed(1)}%，风险较高`);
        confidenceMultiplier *= 0.85;
      }

      enhancements.push(`市值排名#${marketData.marketCapRank}`);
    }

    // 3. 获取市场情绪（Fear & Greed）
    const sentiment = await this.getSentiment();
    if (sentiment) {
      const evaluation = fearGreed.evaluateEntry(baseAnalysis.action, sentiment.value);

      if (!evaluation.suitable) {
        return {
          ...baseAnalysis,
          action: 'WAIT',
          reason: `${baseAnalysis.reason}；但${evaluation.reason}`,
          confidence: 0
        };
      }

      confidenceMultiplier *= evaluation.confidence;
      enhancements.push(`恐慌贪婪指数${sentiment.value}(${sentiment.valueClassification})`);

      // 根据情绪调整评分
      if (sentiment.signal === 'EXTREME_FEAR' && baseAnalysis.action === 'BUY') {
        scoreAdjustment += 5; // 极度恐慌时买入，加分
      } else if (sentiment.signal === 'EXTREME_GREED' && baseAnalysis.action === 'SELL') {
        scoreAdjustment += 5; // 极度贪婪时卖出，加分
      } else if (sentiment.signal === 'GREED' && baseAnalysis.action === 'BUY') {
        scoreAdjustment -= 5; // 贪婪时买入，减分
      } else if (sentiment.signal === 'FEAR' && baseAnalysis.action === 'SELL') {
        scoreAdjustment -= 5; // 恐慌时卖出，减分
      }
    }

    // 4. Alpha Vantage技术指标（可选）
    if (this.alphaVantage && this.alphaVantage.isConfigured()) {
      try {
        // 注意：Alpha Vantage对加密货币的支持有限
        // 这里仅作示例，实际可能需要调整
        const cleanSymbol = symbol.replace('USDT', '').replace('BUSD', '');

        // 由于API限制，这里只获取关键指标
        const rsi = await this.alphaVantage.getRSI(cleanSymbol, 'daily');
        if (rsi) {
          enhancements.push(`AV-RSI:${rsi.rsi.toFixed(1)}`);

          // 与本地计算的RSI对比验证
          if (baseAnalysis.plan?.indicators?.rsi) {
            const localRSI = baseAnalysis.plan.indicators.rsi;
            const diff = Math.abs(rsi.rsi - localRSI);
            if (diff > 10) {
              enhancements.push(`RSI差异${diff.toFixed(1)}，数据可能有偏差`);
              confidenceMultiplier *= 0.95;
            }
          }
        }
      } catch (error) {
        console.error('[SuperEnhanced] Alpha Vantage指标获取失败:', error.message);
      }
    }

    // 5. 综合调整
    const finalScore = (baseAnalysis.plan?.trendStrengthScore || 0) + scoreAdjustment;
    const finalConfidence = baseAnalysis.confidence * confidenceMultiplier;

    // 如果调整后评分低于55，转为观望
    if (finalScore < 55) {
      return {
        ...baseAnalysis,
        action: 'WAIT',
        reason: `初始评分${baseAnalysis.plan?.trendStrengthScore}，调整后${finalScore}分，低于门槛`,
        confidence: 0
      };
    }

    // 6. 返回增强结果
    return {
      ...baseAnalysis,
      confidence: Math.max(0.5, Math.min(0.95, finalConfidence)),
      reason: `${baseAnalysis.reason}；${enhancements.join('；')}`,
      plan: {
        ...baseAnalysis.plan,
        trendStrengthScore: finalScore,
        originalScore: baseAnalysis.plan?.trendStrengthScore,
        scoreAdjustment,
        confidenceMultiplier: confidenceMultiplier.toFixed(3),
        dataSource: {
          coinGecko: Boolean(marketData),
          fearGreed: Boolean(sentiment),
          alphaVantage: this.alphaVantage?.isConfigured() || false
        }
      }
    };
  }

  /**
   * 超级增强版持仓复核
   */
  async reviewPosition(order, market) {
    // 基础复核
    const baseReview = enhancedProtectionReview(order, market);

    // 获取市场情绪
    const sentiment = await this.getSentiment();
    if (!sentiment) {
      return baseReview;
    }

    // 根据情绪调整建议
    const long = order.direction === 'OPEN_LONG';
    const profit = long
      ? (market.klines.at(-1).close - order.entry) / order.entry
      : (order.entry - market.klines.at(-1).close) / order.entry;

    // 如果情绪极端且盈利，建议提前止盈
    if (profit > 0.03) {
      if (long && sentiment.signal === 'EXTREME_GREED') {
        return {
          action: 'CLOSE',
          reason: `市场极度贪婪(${sentiment.value})且已盈利${(profit * 100).toFixed(2)}%，建议止盈`,
          closePrice: market.klines.at(-1).close,
          confidence: 0.85,
          sentiment: sentiment.valueClassification
        };
      }

      if (!long && sentiment.signal === 'EXTREME_FEAR') {
        return {
          action: 'CLOSE',
          reason: `市场极度恐慌(${sentiment.value})且已盈利${(profit * 100).toFixed(2)}%，建议止盈`,
          closePrice: market.klines.at(-1).close,
          confidence: 0.85,
          sentiment: sentiment.valueClassification
        };
      }
    }

    // 在原有建议基础上添加情绪信息
    return {
      ...baseReview,
      reason: `${baseReview.reason}；市场情绪${sentiment.valueClassification}(${sentiment.value})`,
      sentiment: {
        value: sentiment.value,
        classification: sentiment.valueClassification,
        signal: sentiment.signal
      }
    };
  }

  /**
   * 批量预筛选（用于自动化扫描）
   * 在详细分析前先过滤掉不合格的币种，节省时间
   */
  async preFilter(symbols) {
    console.log(`[SuperEnhanced] 预筛选${symbols.length}个币种...`);

    try {
      // 批量获取市场数据
      const marketDataList = await coinGecko.getMarketData(symbols);
      const marketDataMap = new Map(
        marketDataList.map(d => [d.symbol, d])
      );

      // 过滤条件
      const filtered = symbols.filter(symbol => {
        const data = marketDataMap.get(symbol);
        if (!data) return true; // 没有数据的保留（可能CoinGecko不支持）

        // 市值排名过滤
        if (data.marketCapRank > 100) return false;

        // 流动性过滤
        if (data.volumeMarketCapRatio < 0.005) return false;

        // 极端波动过滤（24小时涨跌超过20%）
        if (Math.abs(data.priceChangePercentage24h) > 20) return false;

        return true;
      });

      console.log(`[SuperEnhanced] 预筛选完成: ${symbols.length} -> ${filtered.length}`);

      return {
        filtered,
        removed: symbols.length - filtered.length,
        reasons: {
          lowMarketCap: marketDataList.filter(d => d.marketCapRank > 100).length,
          lowLiquidity: marketDataList.filter(d => d.volumeMarketCapRatio < 0.005).length,
          extremeVolatility: marketDataList.filter(d => Math.abs(d.priceChangePercentage24h) > 20).length
        }
      };
    } catch (error) {
      console.error('[SuperEnhanced] 预筛选失败:', error.message);
      return { filtered: symbols, removed: 0 };
    }
  }

  /**
   * 获取市场概览
   */
  async getMarketOverview() {
    try {
      const [globalData, sentiment, trending] = await Promise.all([
        coinGecko.getGlobalData(),
        fearGreed.getCurrentIndex(),
        coinGecko.getTrendingCoins()
      ]);

      return {
        global: globalData,
        sentiment,
        trending,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('[SuperEnhanced] 获取市场概览失败:', error.message);
      return null;
    }
  }
}

// 导出工厂函数
export function createSuperEnhancedAnalysis(options) {
  return new SuperEnhancedAnalysis(options);
}
