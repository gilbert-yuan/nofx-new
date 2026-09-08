/**
 * CoinGecko API 客户端
 *
 * 功能：
 * - 获取市场数据（价格、市值、成交量）
 * - 获取全球市场统计
 * - 获取历史价格数据
 * - 完全免费，无需API Key
 *
 * 限制：50次/分钟
 */

import { request } from 'undici';

export class CoinGeckoClient {
  constructor() {
    this.baseUrl = 'https://api.coingecko.com/api/v3';
    this.lastRequest = 0;
    this.minInterval = 1200; // 50次/分钟 = 1.2秒间隔
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
   * 获取多个币种的市场数据
   * @param {string[]} symbols - 币种符号列表，如 ['BTC', 'ETH']
   * @returns {Promise<Array>} 市场数据数组
   */
  async getMarketData(symbols) {
    await this.rateLimit();

    // CoinGecko使用币种ID，需要映射
    const idMap = {
      'BTC': 'bitcoin',
      'ETH': 'ethereum',
      'BNB': 'binancecoin',
      'SOL': 'solana',
      'XRP': 'ripple',
      'ADA': 'cardano',
      'AVAX': 'avalanche-2',
      'DOGE': 'dogecoin',
      'DOT': 'polkadot',
      'MATIC': 'matic-network'
    };

    // 批量查询（最多250个）
    const ids = symbols.slice(0, 250).map(s => {
      const symbol = s.replace('USDT', '').toUpperCase();
      return idMap[symbol] || symbol.toLowerCase();
    }).join(',');

    try {
      const url = `${this.baseUrl}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=false&price_change_percentage=24h`;

      const { statusCode, body } = await request(url, { method: 'GET' });

      if (statusCode !== 200) {
        throw new Error(`CoinGecko API error: ${statusCode}`);
      }

      const data = JSON.parse(await body.text());

      return data.map(coin => ({
        symbol: coin.symbol.toUpperCase() + 'USDT',
        coinId: coin.id,
        price: coin.current_price,
        marketCap: coin.market_cap,
        marketCapRank: coin.market_cap_rank,
        volume24h: coin.total_volume,
        volumeMarketCapRatio: coin.total_volume / coin.market_cap,
        priceChange24h: coin.price_change_24h,
        priceChangePercentage24h: coin.price_change_percentage_24h,
        priceChangePercentage7d: coin.price_change_percentage_7d_in_currency,
        circulatingSupply: coin.circulating_supply,
        totalSupply: coin.total_supply,
        ath: coin.ath,
        athChangePercentage: coin.ath_change_percentage,
        athDate: coin.ath_date,
        lastUpdated: coin.last_updated
      }));
    } catch (error) {
      console.error('[CoinGecko] 获取市场数据失败:', error.message);
      return [];
    }
  }

  /**
   * 获取单个币种详细信息
   * @param {string} symbol - 币种符号，如 'BTC'
   * @returns {Promise<Object>} 币种详细信息
   */
  async getCoinDetails(symbol) {
    await this.rateLimit();

    const coinId = this.symbolToCoinId(symbol);

    try {
      const url = `${this.baseUrl}/coins/${coinId}?localization=false&tickers=false&market_data=true&community_data=true&developer_data=false&sparkline=false`;

      const { statusCode, body } = await request(url, { method: 'GET' });

      if (statusCode !== 200) {
        throw new Error(`CoinGecko API error: ${statusCode}`);
      }

      const data = JSON.parse(await body.text());

      return {
        symbol: data.symbol.toUpperCase(),
        name: data.name,
        marketCapRank: data.market_cap_rank,
        sentiment: {
          votesUpPercentage: data.sentiment_votes_up_percentage,
          votesDownPercentage: data.sentiment_votes_down_percentage
        },
        communityData: {
          twitterFollowers: data.community_data?.twitter_followers,
          redditSubscribers: data.community_data?.reddit_subscribers,
          redditActiveUsers: data.community_data?.reddit_average_posts_48h
        },
        marketData: {
          currentPrice: data.market_data.current_price.usd,
          marketCap: data.market_data.market_cap.usd,
          totalVolume: data.market_data.total_volume.usd,
          high24h: data.market_data.high_24h.usd,
          low24h: data.market_data.low_24h.usd,
          priceChange24h: data.market_data.price_change_percentage_24h,
          priceChange7d: data.market_data.price_change_percentage_7d,
          priceChange30d: data.market_data.price_change_percentage_30d
        }
      };
    } catch (error) {
      console.error(`[CoinGecko] 获取${symbol}详细信息失败:`, error.message);
      return null;
    }
  }

  /**
   * 获取全球市场数据
   * @returns {Promise<Object>} 全球市场统计
   */
  async getGlobalData() {
    await this.rateLimit();

    try {
      const url = `${this.baseUrl}/global`;

      const { statusCode, body } = await request(url, { method: 'GET' });

      if (statusCode !== 200) {
        throw new Error(`CoinGecko API error: ${statusCode}`);
      }

      const { data } = JSON.parse(await body.text());

      return {
        activeCryptocurrencies: data.active_cryptocurrencies,
        markets: data.markets,
        totalMarketCap: data.total_market_cap.usd,
        totalVolume24h: data.total_volume.usd,
        marketCapPercentage: {
          btc: data.market_cap_percentage.btc,
          eth: data.market_cap_percentage.eth
        },
        marketCapChange24h: data.market_cap_change_percentage_24h_usd,
        updatedAt: data.updated_at
      };
    } catch (error) {
      console.error('[CoinGecko] 获取全球数据失败:', error.message);
      return null;
    }
  }

  /**
   * 获取趋势币种（热门）
   * @returns {Promise<Array>} 趋势币种列表
   */
  async getTrendingCoins() {
    await this.rateLimit();

    try {
      const url = `${this.baseUrl}/search/trending`;

      const { statusCode, body } = await request(url, { method: 'GET' });

      if (statusCode !== 200) {
        throw new Error(`CoinGecko API error: ${statusCode}`);
      }

      const data = JSON.parse(await body.text());

      return data.coins.map(item => ({
        symbol: item.item.symbol.toUpperCase(),
        name: item.item.name,
        marketCapRank: item.item.market_cap_rank,
        priceUsd: item.item.data?.price,
        priceChange24h: item.item.data?.price_change_percentage_24h?.usd
      }));
    } catch (error) {
      console.error('[CoinGecko] 获取趋势币种失败:', error.message);
      return [];
    }
  }

  /**
   * 符号转币种ID
   * @private
   */
  symbolToCoinId(symbol) {
    const cleanSymbol = symbol.replace('USDT', '').replace('BUSD', '').toUpperCase();

    const idMap = {
      'BTC': 'bitcoin',
      'ETH': 'ethereum',
      'BNB': 'binancecoin',
      'SOL': 'solana',
      'XRP': 'ripple',
      'ADA': 'cardano',
      'AVAX': 'avalanche-2',
      'DOGE': 'dogecoin',
      'DOT': 'polkadot',
      'MATIC': 'matic-network',
      'LTC': 'litecoin',
      'SHIB': 'shiba-inu',
      'TRX': 'tron',
      'LINK': 'chainlink',
      'ATOM': 'cosmos',
      'UNI': 'uniswap',
      'ETC': 'ethereum-classic',
      'XLM': 'stellar',
      'XMR': 'monero',
      'BCH': 'bitcoin-cash'
    };

    return idMap[cleanSymbol] || cleanSymbol.toLowerCase();
  }

  /**
   * 批量获取币种的市值排名
   * @param {string[]} symbols - 币种符号列表
   * @returns {Promise<Map>} 符号 -> 排名的映射
   */
  async getMarketCapRanks(symbols) {
    const marketData = await this.getMarketData(symbols);
    const rankMap = new Map();

    marketData.forEach(coin => {
      rankMap.set(coin.symbol, coin.marketCapRank);
    });

    return rankMap;
  }
}

// 单例导出
export const coinGecko = new CoinGeckoClient();
