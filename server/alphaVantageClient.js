/**
 * Alpha Vantage API 客户端
 *
 * 功能：
 * - 获取50+技术指标（已计算）
 * - 加密货币和股票数据
 * - 新闻情绪分析
 * - 需要免费API Key，500次/天
 *
 * 注册地址：https://www.alphavantage.co/support/#api-key
 */

import { request } from 'undici';

export class AlphaVantageClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://www.alphavantage.co/query';
    this.lastRequest = 0;
    this.minInterval = 12000; // 5次/分钟 = 12秒间隔（保守）
  }

  // 限流控制
  async rateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.minInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minInterval - elapsed));
    }
    this.lastRequest = Date.now();
  }

  /**
   * 检查API Key是否配置
   */
  isConfigured() {
    return Boolean(this.apiKey && this.apiKey !== 'demo' && this.apiKey.length > 10);
  }

  /**
   * 获取加密货币日线数据
   * @param {string} symbol - 币种符号，如 'BTC'
   * @param {string} market - 市场，默认 'USD'
   * @returns {Promise<Object>} 日线数据
   */
  async getCryptoDaily(symbol, market = 'USD') {
    if (!this.isConfigured()) {
      throw new Error('Alpha Vantage API Key 未配置');
    }

    await this.rateLimit();

    try {
      const url = `${this.baseUrl}?function=DIGITAL_CURRENCY_DAILY&symbol=${symbol}&market=${market}&apikey=${this.apiKey}`;

      const { statusCode, body } = await request(url, { method: 'GET' });

      if (statusCode !== 200) {
        throw new Error(`Alpha Vantage API error: ${statusCode}`);
      }

      const data = JSON.parse(await body.text());

      if (data['Error Message']) {
        throw new Error(data['Error Message']);
      }

      if (data['Note']) {
        throw new Error('API调用频率超限，请稍后重试');
      }

      return data;
    } catch (error) {
      console.error(`[AlphaVantage] 获取${symbol}日线数据失败:`, error.message);
      throw error;
    }
  }

  /**
   * 获取RSI指标
   * @param {string} symbol - 币种符号，如 'BTC'
   * @param {string} interval - 时间间隔：daily, weekly, monthly
   * @param {number} timePeriod - 周期，默认14
   * @returns {Promise<Object>} RSI数据
   */
  async getRSI(symbol, interval = 'daily', timePeriod = 14) {
    if (!this.isConfigured()) {
      return null; // 如果没配置Key，返回null而不是报错
    }

    await this.rateLimit();

    try {
      const url = `${this.baseUrl}?function=RSI&symbol=${symbol}&interval=${interval}&time_period=${timePeriod}&series_type=close&apikey=${this.apiKey}`;

      const { statusCode, body } = await request(url, { method: 'GET' });

      if (statusCode !== 200) {
        throw new Error(`Alpha Vantage API error: ${statusCode}`);
      }

      const data = JSON.parse(await body.text());

      if (data['Error Message'] || data['Note']) {
        return null;
      }

      const technicalAnalysis = data['Technical Analysis: RSI'];
      if (!technicalAnalysis) return null;

      const latest = Object.entries(technicalAnalysis)[0];
      if (!latest) return null;

      return {
        date: latest[0],
        rsi: parseFloat(latest[1]['RSI']),
        period: timePeriod
      };
    } catch (error) {
      console.error(`[AlphaVantage] 获取${symbol} RSI失败:`, error.message);
      return null;
    }
  }

  /**
   * 获取MACD指标
   * @param {string} symbol - 币种符号
   * @param {string} interval - 时间间隔
   * @returns {Promise<Object>} MACD数据
   */
  async getMACD(symbol, interval = 'daily') {
    if (!this.isConfigured()) {
      return null;
    }

    await this.rateLimit();

    try {
      const url = `${this.baseUrl}?function=MACD&symbol=${symbol}&interval=${interval}&series_type=close&apikey=${this.apiKey}`;

      const { statusCode, body } = await request(url, { method: 'GET' });

      if (statusCode !== 200) {
        throw new Error(`Alpha Vantage API error: ${statusCode}`);
      }

      const data = JSON.parse(await body.text());

      if (data['Error Message'] || data['Note']) {
        return null;
      }

      const technicalAnalysis = data['Technical Analysis: MACD'];
      if (!technicalAnalysis) return null;

      const latest = Object.entries(technicalAnalysis)[0];
      if (!latest) return null;

      return {
        date: latest[0],
        macd: parseFloat(latest[1]['MACD']),
        signal: parseFloat(latest[1]['MACD_Signal']),
        hist: parseFloat(latest[1]['MACD_Hist'])
      };
    } catch (error) {
      console.error(`[AlphaVantage] 获取${symbol} MACD失败:`, error.message);
      return null;
    }
  }

  /**
   * 获取布林带指标
   * @param {string} symbol - 币种符号
   * @param {string} interval - 时间间隔
   * @param {number} timePeriod - 周期，默认20
   * @returns {Promise<Object>} 布林带数据
   */
  async getBBANDS(symbol, interval = 'daily', timePeriod = 20) {
    if (!this.isConfigured()) {
      return null;
    }

    await this.rateLimit();

    try {
      const url = `${this.baseUrl}?function=BBANDS&symbol=${symbol}&interval=${interval}&time_period=${timePeriod}&series_type=close&apikey=${this.apiKey}`;

      const { statusCode, body } = await request(url, { method: 'GET' });

      if (statusCode !== 200) {
        throw new Error(`Alpha Vantage API error: ${statusCode}`);
      }

      const data = JSON.parse(await body.text());

      if (data['Error Message'] || data['Note']) {
        return null;
      }

      const technicalAnalysis = data['Technical Analysis: BBANDS'];
      if (!technicalAnalysis) return null;

      const latest = Object.entries(technicalAnalysis)[0];
      if (!latest) return null;

      return {
        date: latest[0],
        upper: parseFloat(latest[1]['Real Upper Band']),
        middle: parseFloat(latest[1]['Real Middle Band']),
        lower: parseFloat(latest[1]['Real Lower Band']),
        period: timePeriod
      };
    } catch (error) {
      console.error(`[AlphaVantage] 获取${symbol} BBANDS失败:`, error.message);
      return null;
    }
  }

  /**
   * 获取随机指标（STOCH）
   * @param {string} symbol - 币种符号
   * @param {string} interval - 时间间隔
   * @returns {Promise<Object>} STOCH数据
   */
  async getSTOCH(symbol, interval = 'daily') {
    if (!this.isConfigured()) {
      return null;
    }

    await this.rateLimit();

    try {
      const url = `${this.baseUrl}?function=STOCH&symbol=${symbol}&interval=${interval}&apikey=${this.apiKey}`;

      const { statusCode, body } = await request(url, { method: 'GET' });

      if (statusCode !== 200) {
        throw new Error(`Alpha Vantage API error: ${statusCode}`);
      }

      const data = JSON.parse(await body.text());

      if (data['Error Message'] || data['Note']) {
        return null;
      }

      const technicalAnalysis = data['Technical Analysis: STOCH'];
      if (!technicalAnalysis) return null;

      const latest = Object.entries(technicalAnalysis)[0];
      if (!latest) return null;

      return {
        date: latest[0],
        slowK: parseFloat(latest[1]['SlowK']),
        slowD: parseFloat(latest[1]['SlowD'])
      };
    } catch (error) {
      console.error(`[AlphaVantage] 获取${symbol} STOCH失败:`, error.message);
      return null;
    }
  }

  /**
   * 获取ADX指标（趋势强度）
   * @param {string} symbol - 币种符号
   * @param {string} interval - 时间间隔
   * @param {number} timePeriod - 周期，默认14
   * @returns {Promise<Object>} ADX数据
   */
  async getADX(symbol, interval = 'daily', timePeriod = 14) {
    if (!this.isConfigured()) {
      return null;
    }

    await this.rateLimit();

    try {
      const url = `${this.baseUrl}?function=ADX&symbol=${symbol}&interval=${interval}&time_period=${timePeriod}&apikey=${this.apiKey}`;

      const { statusCode, body } = await request(url, { method: 'GET' });

      if (statusCode !== 200) {
        throw new Error(`Alpha Vantage API error: ${statusCode}`);
      }

      const data = JSON.parse(await body.text());

      if (data['Error Message'] || data['Note']) {
        return null;
      }

      const technicalAnalysis = data['Technical Analysis: ADX'];
      if (!technicalAnalysis) return null;

      const latest = Object.entries(technicalAnalysis)[0];
      if (!latest) return null;

      return {
        date: latest[0],
        adx: parseFloat(latest[1]['ADX']),
        period: timePeriod
      };
    } catch (error) {
      console.error(`[AlphaVantage] 获取${symbol} ADX失败:`, error.message);
      return null;
    }
  }

  /**
   * 获取新闻情绪
   * @param {string} ticker - 代码，如 'CRYPTO:BTC'
   * @param {number} limit - 返回数量
   * @returns {Promise<Object>} 新闻情绪数据
   */
  async getNewsSentiment(ticker = 'CRYPTO:BTC', limit = 50) {
    if (!this.isConfigured()) {
      return null;
    }

    await this.rateLimit();

    try {
      const url = `${this.baseUrl}?function=NEWS_SENTIMENT&tickers=${ticker}&limit=${limit}&apikey=${this.apiKey}`;

      const { statusCode, body } = await request(url, { method: 'GET' });

      if (statusCode !== 200) {
        throw new Error(`Alpha Vantage API error: ${statusCode}`);
      }

      const data = JSON.parse(await body.text());

      if (data['Error Message'] || data['Note']) {
        return null;
      }

      const feed = data.feed || [];

      // 计算平均情绪分数
      const sentimentScores = feed
        .map(item => item.overall_sentiment_score)
        .filter(score => score !== undefined);

      const averageSentiment = sentimentScores.length > 0
        ? sentimentScores.reduce((sum, score) => sum + score, 0) / sentimentScores.length
        : 0;

      return {
        itemsReturned: data.items || 0,
        averageSentiment: averageSentiment.toFixed(3),
        sentimentLabel: this.getSentimentLabel(averageSentiment),
        recentNews: feed.slice(0, 5).map(item => ({
          title: item.title,
          url: item.url,
          sentiment: item.overall_sentiment_label,
          sentimentScore: item.overall_sentiment_score,
          source: item.source,
          publishedAt: item.time_published
        }))
      };
    } catch (error) {
      console.error(`[AlphaVantage] 获取${ticker}新闻情绪失败:`, error.message);
      return null;
    }
  }

  /**
   * 情绪标签
   * @private
   */
  getSentimentLabel(score) {
    if (score <= -0.35) return 'Bearish';
    if (score <= -0.15) return 'Somewhat-Bearish';
    if (score < 0.15) return 'Neutral';
    if (score < 0.35) return 'Somewhat-Bullish';
    return 'Bullish';
  }

  /**
   * 批量获取指标（节省API调用次数）
   * @param {string} symbol - 币种符号
   * @param {string} interval - 时间间隔
   * @returns {Promise<Object>} 所有可用指标
   */
  async getAllIndicators(symbol, interval = 'daily') {
    if (!this.isConfigured()) {
      console.log('[AlphaVantage] API Key未配置，跳过技术指标获取');
      return null;
    }

    console.log(`[AlphaVantage] 正在获取${symbol}的技术指标...`);

    // 串行调用，避免超限
    const indicators = {};

    try {
      indicators.rsi = await this.getRSI(symbol, interval);
      indicators.macd = await this.getMACD(symbol, interval);
      indicators.bbands = await this.getBBANDS(symbol, interval);
      indicators.stoch = await this.getSTOCH(symbol, interval);
      indicators.adx = await this.getADX(symbol, interval);

      console.log(`[AlphaVantage] ${symbol}技术指标获取完成`);

      return indicators;
    } catch (error) {
      console.error(`[AlphaVantage] 批量获取${symbol}指标失败:`, error.message);
      return null;
    }
  }
}

// 导出工厂函数（需要从配置中获取API Key）
export function createAlphaVantageClient(apiKey) {
  return new AlphaVantageClient(apiKey);
}
