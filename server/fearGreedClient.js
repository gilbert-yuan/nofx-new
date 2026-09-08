/**
 * Fear & Greed Index API 客户端
 *
 * 功能：
 * - 获取当前恐慌贪婪指数（0-100）
 * - 获取历史情绪数据
 * - 情绪信号分类
 * - 完全免费，无需API Key，无限制
 */

import { request } from 'undici';

export class FearGreedClient {
  constructor() {
    this.baseUrl = 'https://api.alternative.me/fng';
    this.cache = null;
    this.cacheTime = 0;
    this.cacheDuration = 10 * 60 * 1000; // 缓存10分钟（指数每天更新1-2次）
  }

  /**
   * 获取当前恐慌贪婪指数
   * @returns {Promise<Object>} 当前指数数据
   */
  async getCurrentIndex() {
    // 检查缓存
    if (this.cache && Date.now() - this.cacheTime < this.cacheDuration) {
      return this.cache;
    }

    try {
      const { statusCode, body } = await request(this.baseUrl, { method: 'GET' });

      if (statusCode !== 200) {
        throw new Error(`Fear & Greed API error: ${statusCode}`);
      }

      const { data } = JSON.parse(await body.text());
      const current = data[0];

      const result = {
        value: parseInt(current.value),
        valueClassification: current.value_classification,
        timestamp: new Date(parseInt(current.timestamp) * 1000),
        timeUntilUpdate: parseInt(current.time_until_update || 0),
        signal: this.getSignal(parseInt(current.value)),
        description: this.getDescription(parseInt(current.value))
      };

      // 更新缓存
      this.cache = result;
      this.cacheTime = Date.now();

      return result;
    } catch (error) {
      console.error('[FearGreed] 获取指数失败:', error.message);

      // 如果有缓存，返回缓存
      if (this.cache) {
        return this.cache;
      }

      // 否则返回中性值
      return {
        value: 50,
        valueClassification: 'Neutral',
        timestamp: new Date(),
        signal: 'NEUTRAL',
        description: '数据获取失败，使用默认中性值'
      };
    }
  }

  /**
   * 获取历史数据
   * @param {number} limit - 获取天数（默认30天）
   * @returns {Promise<Array>} 历史数据数组
   */
  async getHistoricalData(limit = 30) {
    try {
      const url = `${this.baseUrl}?limit=${limit}`;
      const { statusCode, body } = await request(url, { method: 'GET' });

      if (statusCode !== 200) {
        throw new Error(`Fear & Greed API error: ${statusCode}`);
      }

      const { data } = JSON.parse(await body.text());

      return data.map(item => ({
        value: parseInt(item.value),
        valueClassification: item.value_classification,
        timestamp: new Date(parseInt(item.timestamp) * 1000),
        signal: this.getSignal(parseInt(item.value))
      }));
    } catch (error) {
      console.error('[FearGreed] 获取历史数据失败:', error.message);
      return [];
    }
  }

  /**
   * 获取信号分类
   * @param {number} value - 指数值（0-100）
   * @returns {string} 信号分类
   */
  getSignal(value) {
    if (value <= 20) return 'EXTREME_FEAR';
    if (value <= 40) return 'FEAR';
    if (value <= 60) return 'NEUTRAL';
    if (value <= 80) return 'GREED';
    return 'EXTREME_GREED';
  }

  /**
   * 获取中文描述
   * @param {number} value - 指数值
   * @returns {string} 中文描述
   */
  getDescription(value) {
    if (value <= 20) return '极度恐慌 - 可能是买入机会';
    if (value <= 40) return '恐慌 - 市场情绪偏空';
    if (value <= 60) return '中性 - 市场平衡';
    if (value <= 80) return '贪婪 - 市场情绪偏多';
    return '极度贪婪 - 可能是卖出机会';
  }

  /**
   * 获取趋势（相比昨天）
   * @returns {Promise<Object>} 趋势分析
   */
  async getTrend() {
    const history = await this.getHistoricalData(7);
    if (history.length < 2) return null;

    const today = history[0].value;
    const yesterday = history[1].value;
    const lastWeek = history[6]?.value || today;

    return {
      current: today,
      dailyChange: today - yesterday,
      weeklyChange: today - lastWeek,
      trend: today > yesterday ? 'INCREASING' : today < yesterday ? 'DECREASING' : 'STABLE',
      weeklyTrend: today > lastWeek ? 'INCREASING' : today < lastWeek ? 'DECREASING' : 'STABLE'
    };
  }

  /**
   * 判断是否适合开仓
   * @param {string} action - 'BUY' 或 'SELL'
   * @param {number} currentValue - 当前指数值
   * @returns {Object} 建议和理由
   */
  evaluateEntry(action, currentValue) {
    const signal = this.getSignal(currentValue);

    // 极度贪婪时不建议买入
    if (action === 'BUY' && signal === 'EXTREME_GREED') {
      return {
        suitable: false,
        confidence: 0.5,
        reason: `市场极度贪婪（${currentValue}），可能面临回调风险`,
        adjustment: 'REDUCE_CONFIDENCE'
      };
    }

    // 极度恐慌时不建议卖出
    if (action === 'SELL' && signal === 'EXTREME_FEAR') {
      return {
        suitable: false,
        confidence: 0.5,
        reason: `市场极度恐慌（${currentValue}），可能超跌反弹`,
        adjustment: 'REDUCE_CONFIDENCE'
      };
    }

    // 贪婪时买入，降低置信度
    if (action === 'BUY' && signal === 'GREED') {
      return {
        suitable: true,
        confidence: 0.8,
        reason: `市场贪婪（${currentValue}），适度降低置信度`,
        adjustment: 'REDUCE_CONFIDENCE'
      };
    }

    // 恐慌时卖出，降低置信度
    if (action === 'SELL' && signal === 'FEAR') {
      return {
        suitable: true,
        confidence: 0.8,
        reason: `市场恐慌（${currentValue}），适度降低置信度`,
        adjustment: 'REDUCE_CONFIDENCE'
      };
    }

    // 其他情况正常
    return {
      suitable: true,
      confidence: 1.0,
      reason: `市场情绪${this.getDescription(currentValue)}，适合操作`,
      adjustment: 'NONE'
    };
  }

  /**
   * 获取统计信息（最近30天）
   * @returns {Promise<Object>} 统计数据
   */
  async getStatistics() {
    const history = await this.getHistoricalData(30);
    if (history.length === 0) return null;

    const values = history.map(h => h.value);
    const average = values.reduce((sum, v) => sum + v, 0) / values.length;
    const max = Math.max(...values);
    const min = Math.min(...values);

    // 计算各区间占比
    const extremeFear = values.filter(v => v <= 20).length;
    const fear = values.filter(v => v > 20 && v <= 40).length;
    const neutral = values.filter(v => v > 40 && v <= 60).length;
    const greed = values.filter(v => v > 60 && v <= 80).length;
    const extremeGreed = values.filter(v => v > 80).length;

    return {
      period: '30天',
      average: average.toFixed(1),
      max,
      min,
      current: values[0],
      distribution: {
        extremeFear: ((extremeFear / values.length) * 100).toFixed(1) + '%',
        fear: ((fear / values.length) * 100).toFixed(1) + '%',
        neutral: ((neutral / values.length) * 100).toFixed(1) + '%',
        greed: ((greed / values.length) * 100).toFixed(1) + '%',
        extremeGreed: ((extremeGreed / values.length) * 100).toFixed(1) + '%'
      },
      dominantSentiment: this.getDominantSentiment(values)
    };
  }

  /**
   * 获取主导情绪
   * @private
   */
  getDominantSentiment(values) {
    const average = values.reduce((sum, v) => sum + v, 0) / values.length;
    return this.getSignal(Math.round(average));
  }
}

// 单例导出
export const fearGreed = new FearGreedClient();
