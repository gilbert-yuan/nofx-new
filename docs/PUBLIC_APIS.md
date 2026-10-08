# 📊 公开/免费数据接口汇总

## 🎯 加密货币行情数据

### 1. CoinGecko API ⭐ 推荐

**优势**：
- ✅ 完全免费
- ✅ 无需API Key
- ✅ 数据最全面
- ✅ 支持中文

**可用数据**：
- 价格、市值、成交量
- 24小时涨跌幅
- 历史价格数据
- 市场情绪指标
- 社交媒体统计
- 开发活跃度

**接口示例**：
```javascript
// 1. 获取市场数据
https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1

// 2. 获取单个币种详细信息
https://api.coingecko.com/api/v3/coins/bitcoin?localization=false

// 3. 获取历史数据
https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=30

// 4. 获取全球市场数据
https://api.coingecko.com/api/v3/global

// 5. 获取恐慌贪婪指数
https://api.coingecko.com/api/v3/search/trending
```

**限制**：
- 免费版：10-50次/分钟
- 无需注册

**文档**：https://www.coingecko.com/en/api/documentation

---

### 2. CoinMarketCap API

**优势**：
- ✅ 权威数据源
- ✅ 免费额度充足
- ✅ 数据更新快

**可用数据**：
- 实时价格
- 市值排名
- 成交量
- 资金费率
- 交易对信息

**接口示例**：
```javascript
// 需要免费API Key
const API_KEY = 'your_free_api_key';

// 1. 最新行情
https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest
Headers: X-CMC_PRO_API_KEY: your_api_key

// 2. 币种信息
https://pro-api.coinmarketcap.com/v1/cryptocurrency/info?symbol=BTC

// 3. 历史数据
https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/historical
```

**限制**：
- 免费版：333次/天（~10k次/月）
- 需要注册获取Key

**注册**：https://coinmarketcap.com/api/

---

### 3. CryptoCompare API

**优势**：
- ✅ 历史数据丰富
- ✅ 技术指标计算
- ✅ 新闻API

**可用数据**：
- OHLCV数据
- 技术指标（RSI、MACD等已计算）
- 新闻和社交媒体情绪
- 链上数据

**接口示例**：
```javascript
// 无需Key可用（有限制）

// 1. 历史OHLCV
https://min-api.cryptocompare.com/data/v2/histoday?fsym=BTC&tsym=USD&limit=100

// 2. 实时价格
https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD,EUR

// 3. 新闻
https://min-api.cryptocompare.com/data/v2/news/?lang=EN

// 4. 社交媒体统计
https://min-api.cryptocompare.com/data/social/coin/latest?coinId=1182
```

**限制**：
- 免费版：250,000次/月
- 注册后可提高额度

**文档**：https://min-api.cryptocompare.com/documentation

---

### 4. Messari API

**优势**：
- ✅ 专业级数据
- ✅ 基本面数据
- ✅ 研究报告

**可用数据**：
- 市场数据
- 链上指标
- 基本面信息
- 质押数据

**接口示例**：
```javascript
// 无需Key（有限制）

// 1. 资产信息
https://data.messari.io/api/v1/assets/bitcoin/metrics

// 2. 市场数据
https://data.messari.io/api/v1/assets/bitcoin/metrics/market-data

// 3. 所有资产列表
https://data.messari.io/api/v2/assets
```

**限制**：
- 免费版：20次/分钟，1000次/月
- 部分数据需要付费

**文档**：https://messari.io/api/docs

---

## 📈 传统金融数据

### 5. Alpha Vantage ⭐ 推荐

**优势**：
- ✅ 股票、外汇、加密货币
- ✅ 技术指标API
- ✅ 基本面数据

**可用数据**：
- 实时和历史价格
- 50+技术指标（已计算）
- 基本面财务数据
- 新闻情绪

**接口示例**：
```javascript
const API_KEY = 'your_free_api_key';

// 1. 加密货币日线数据
https://www.alphavantage.co/query?function=DIGITAL_CURRENCY_DAILY&symbol=BTC&market=USD&apikey=${API_KEY}

// 2. 技术指标 - RSI
https://www.alphavantage.co/query?function=RSI&symbol=BTC&interval=daily&time_period=14&series_type=close&apikey=${API_KEY}

// 3. 技术指标 - MACD
https://www.alphavantage.co/query?function=MACD&symbol=BTC&interval=daily&series_type=close&apikey=${API_KEY}

// 4. 布林带
https://www.alphavantage.co/query?function=BBANDS&symbol=BTC&interval=daily&time_period=20&series_type=close&apikey=${API_KEY}

// 5. 新闻情绪
https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=CRYPTO:BTC&apikey=${API_KEY}
```

**技术指标列表**：
- SMA, EMA, WMA, DEMA, TEMA
- MACD, MACDEXT
- RSI, STOCH, STOCHRSI
- WILLR, ADX, ADXR
- CCI, AROON, BBANDS
- ATR, OBV, AD
- 等50+指标

**限制**：
- 免费版：5次/分钟，500次/天
- 需要注册

**文档**：https://www.alphavantage.co/documentation/

---

### 6. Yahoo Finance API（非官方）

**优势**：
- ✅ 完全免费
- ✅ 无需Key
- ✅ 数据稳定

**可用数据**：
- 股票、指数、期货
- 历史价格
- 基本面数据

**使用方式**：
```javascript
// 使用 yfinance Python库
// 或者直接HTTP请求

// 1. 历史数据
https://query1.finance.yahoo.com/v7/finance/download/BTC-USD?period1=0&period2=9999999999&interval=1d

// 2. 实时数据
https://query1.finance.yahoo.com/v7/finance/quote?symbols=BTC-USD
```

**注意**：
- 非官方API，可能随时变化
- 建议配合第三方库使用

---

## 🌐 链上数据

### 7. Blockchain.com API

**优势**：
- ✅ 比特币链上数据
- ✅ 完全免费
- ✅ 无需Key

**可用数据**：
- 区块信息
- 交易数据
- 地址余额
- 网络统计

**接口示例**：
```javascript
// 1. 单个区块
https://blockchain.info/rawblock/block_hash

// 2. 地址信息
https://blockchain.info/rawaddr/bitcoin_address

// 3. 未确认交易
https://blockchain.info/unconfirmed-transactions?format=json

// 4. 市场数据
https://blockchain.info/ticker

// 5. 图表数据
https://api.blockchain.info/charts/market-price?timespan=1year&format=json
```

**文档**：https://www.blockchain.com/api

---

### 8. Etherscan API

**优势**：
- ✅ 以太坊链上数据
- ✅ Gas价格
- ✅ Token信息

**可用数据**：
- 地址余额
- 交易历史
- Gas价格
- Token余额和转账

**接口示例**：
```javascript
const API_KEY = 'your_free_api_key';

// 1. ETH余额
https://api.etherscan.io/api?module=account&action=balance&address=0x...&tag=latest&apikey=${API_KEY}

// 2. Gas价格
https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey=${API_KEY}

// 3. ERC20 Token余额
https://api.etherscan.io/api?module=account&action=tokenbalance&contractaddress=0x...&address=0x...&tag=latest&apikey=${API_KEY}
```

**限制**：
- 免费版：5次/秒
- 需要注册

**文档**：https://docs.etherscan.io/

---

## 💹 恐慌贪婪指数

### 9. Alternative.me Fear & Greed Index

**优势**：
- ✅ 完全免费
- ✅ 无需Key
- ✅ 市场情绪指标

**可用数据**：
- 恐慌贪婪指数（0-100）
- 历史情绪数据
- 情绪分类

**接口示例**：
```javascript
// 1. 当前指数
https://api.alternative.me/fng/

// 2. 历史数据（最近30天）
https://api.alternative.me/fng/?limit=30

// 3. 指定日期范围
https://api.alternative.me/fng/?limit=0&date_format=world
```

**返回示例**：
```json
{
  "data": [{
    "value": "45",
    "value_classification": "Fear",
    "timestamp": "1638316800",
    "time_until_update": "43200"
  }]
}
```

**文档**：https://alternative.me/crypto/fear-and-greed-index/

---

## 📰 新闻和情绪数据

### 10. NewsAPI

**优势**：
- ✅ 全球新闻聚合
- ✅ 免费版额度充足
- ✅ 多语言支持

**可用数据**：
- 加密货币新闻
- 财经新闻
- 情绪分析（基础）

**接口示例**：
```javascript
const API_KEY = 'your_free_api_key';

// 1. 搜索加密货币新闻
https://newsapi.org/v2/everything?q=bitcoin&sortBy=publishedAt&apiKey=${API_KEY}

// 2. 头条新闻
https://newsapi.org/v2/top-headlines?category=business&apiKey=${API_KEY}

// 3. 特定来源
https://newsapi.org/v2/top-headlines?sources=coindesk&apiKey=${API_KEY}
```

**限制**：
- 免费版：1000次/月
- 需要注册

**文档**：https://newsapi.org/docs

---

### 11. Reddit API（免费）

**优势**：
- ✅ 社区情绪
- ✅ 完全免费
- ✅ 实时讨论

**可用数据**：
- r/cryptocurrency 帖子
- r/bitcoin, r/ethereum 等
- 评论数据
- 热度统计

**接口示例**：
```javascript
// 无需Key（公开端点）

// 1. 热门帖子
https://www.reddit.com/r/cryptocurrency/hot.json

// 2. 最新帖子
https://www.reddit.com/r/cryptocurrency/new.json

// 3. 搜索
https://www.reddit.com/r/cryptocurrency/search.json?q=bitcoin&restrict_sr=1
```

**文档**：https://www.reddit.com/dev/api/

---

## 🔥 推荐集成方案

### 方案1：基础版（完全免费，无需Key）

```javascript
数据源组合：
├─ K线数据: OKX公开接口（已有）✅
├─ 市场数据: CoinGecko API
├─ 情绪指标: Fear & Greed Index
├─ 新闻: Reddit API
└─ 链上数据: Blockchain.com API

预期增强：
- 市场情绪过滤
- 新闻事件识别
- 链上异动监控
```

### 方案2：增强版（需注册，仍免费）

```javascript
数据源组合：
├─ K线数据: OKX公开接口（已有）✅
├─ 技术指标: Alpha Vantage API（已计算）
├─ 市场数据: CoinMarketCap API
├─ 链上数据: Etherscan API
├─ 情绪指标: Fear & Greed Index
├─ 新闻分析: NewsAPI
└─ 基本面: Messari API

预期增强：
- 50+技术指标（无需计算）
- 多维度情绪分析
- 基本面筛选
- 新闻情绪评分
```

### 方案3：专业版（最全面）

```javascript
数据源组合：
├─ 所有方案2的数据源
├─ 深度数据: CryptoCompare API
├─ 社交媒体: Twitter API（需申请）
└─ 自定义爬虫

预期增强：
- 全方位市场分析
- 社交媒体情绪
- 多时间框架验证
```

---

## 💻 集成代码示例

### 示例1：CoinGecko市场数据

```javascript
// server/coinGeckoClient.js

export class CoinGeckoClient {
  constructor() {
    this.baseUrl = 'https://api.coingecko.com/api/v3';
  }

  // 获取市场数据
  async getMarketData(symbols = ['bitcoin', 'ethereum']) {
    const ids = symbols.join(',');
    const url = `${this.baseUrl}/coins/markets?vs_currency=usd&ids=${ids}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    return data.map(coin => ({
      symbol: coin.symbol.toUpperCase(),
      price: coin.current_price,
      change24h: coin.price_change_percentage_24h,
      volume24h: coin.total_volume,
      marketCap: coin.market_cap,
      marketCapRank: coin.market_cap_rank
    }));
  }

  // 获取全球市场数据
  async getGlobalData() {
    const url = `${this.baseUrl}/global`;
    const response = await fetch(url);
    const { data } = await response.json();
    
    return {
      totalMarketCap: data.total_market_cap.usd,
      btcDominance: data.market_cap_percentage.btc,
      ethDominance: data.market_cap_percentage.eth,
      marketCapChange24h: data.market_cap_change_percentage_24h_usd
    };
  }
}
```

### 示例2：恐慌贪婪指数

```javascript
// server/fearGreedIndex.js

export async function getFearGreedIndex() {
  const url = 'https://api.alternative.me/fng/';
  const response = await fetch(url);
  const { data } = await response.json();
  
  const current = data[0];
  
  return {
    value: parseInt(current.value),
    classification: current.value_classification,
    timestamp: new Date(parseInt(current.timestamp) * 1000),
    signal: getSignal(parseInt(current.value))
  };
}

function getSignal(value) {
  if (value <= 25) return 'EXTREME_FEAR';
  if (value <= 45) return 'FEAR';
  if (value <= 55) return 'NEUTRAL';
  if (value <= 75) return 'GREED';
  return 'EXTREME_GREED';
}

// 集成到分析引擎
export function enhancedAnalysisWithSentiment(market, sentiment) {
  const baseAnalysis = enhancedAnalysis(market);
  
  // 恐慌指数过滤
  if (sentiment.signal === 'EXTREME_GREED' && baseAnalysis.action === 'BUY') {
    baseAnalysis.confidence *= 0.8;  // 降低置信度
    baseAnalysis.risk += '；市场极度贪婪，注意回调风险';
  }
  
  if (sentiment.signal === 'EXTREME_FEAR' && baseAnalysis.action === 'SELL') {
    baseAnalysis.confidence *= 0.8;
    baseAnalysis.risk += '；市场极度恐慌，可能超跌反弹';
  }
  
  return baseAnalysis;
}
```

### 示例3：Alpha Vantage技术指标

```javascript
// server/alphaVantageClient.js

export class AlphaVantageClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://www.alphavantage.co/query';
  }

  // 获取RSI
  async getRSI(symbol, interval = 'daily', period = 14) {
    const url = `${this.baseUrl}?function=RSI&symbol=${symbol}&interval=${interval}&time_period=${period}&series_type=close&apikey=${this.apiKey}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    const latest = Object.entries(data['Technical Analysis: RSI'])[0];
    return {
      date: latest[0],
      rsi: parseFloat(latest[1]['RSI'])
    };
  }

  // 获取MACD
  async getMACD(symbol, interval = 'daily') {
    const url = `${this.baseUrl}?function=MACD&symbol=${symbol}&interval=${interval}&series_type=close&apikey=${this.apiKey}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    const latest = Object.entries(data['Technical Analysis: MACD'])[0];
    return {
      date: latest[0],
      macd: parseFloat(latest[1]['MACD']),
      signal: parseFloat(latest[1]['MACD_Signal']),
      hist: parseFloat(latest[1]['MACD_Hist'])
    };
  }

  // 获取布林带
  async getBBANDS(symbol, interval = 'daily', period = 20) {
    const url = `${this.baseUrl}?function=BBANDS&symbol=${symbol}&interval=${interval}&time_period=${period}&series_type=close&apikey=${this.apiKey}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    const latest = Object.entries(data['Technical Analysis: BBANDS'])[0];
    return {
      date: latest[0],
      upper: parseFloat(latest[1]['Real Upper Band']),
      middle: parseFloat(latest[1]['Real Middle Band']),
      lower: parseFloat(latest[1]['Real Lower Band'])
    };
  }
}
```

---

## 📋 API对比总结

| API | 免费额度 | 需要Key | 加密货币 | 技术指标 | 情绪数据 | 推荐度 |
|-----|----------|---------|----------|----------|----------|--------|
| **CoinGecko** | 50次/分 | ❌ | ✅ | ❌ | 部分 | ⭐⭐⭐⭐⭐ |
| **Fear & Greed** | 无限 | ❌ | ✅ | ❌ | ✅ | ⭐⭐⭐⭐⭐ |
| **Alpha Vantage** | 500次/天 | ✅ | ✅ | ✅ | ✅ | ⭐⭐⭐⭐⭐ |
| **CoinMarketCap** | 333次/天 | ✅ | ✅ | ❌ | ❌ | ⭐⭐⭐⭐ |
| **CryptoCompare** | 250k次/月 | ✅ | ✅ | ✅ | ✅ | ⭐⭐⭐⭐ |
| **Blockchain.com** | 无限 | ❌ | BTC | ❌ | ❌ | ⭐⭐⭐ |
| **Etherscan** | 5次/秒 | ✅ | ETH | ❌ | ❌ | ⭐⭐⭐ |
| **NewsAPI** | 1000次/月 | ✅ | ✅ | ❌ | ✅ | ⭐⭐⭐ |
| **Reddit** | 无限 | ❌ | ✅ | ❌ | ✅ | ⭐⭐⭐ |

---

## 🚀 下一步建议

### 立即可做（完全免费）

1. **集成恐慌贪婪指数**
   - 5分钟实现
   - 无需注册
   - 立即增强信号质量

2. **添加CoinGecko市场数据**
   - 市值排名过滤
   - 成交量验证
   - 24小时涨跌参考

### 短期优化（需注册，仍免费）

3. **Alpha Vantage技术指标**
   - 50+指标可用
   - 无需自己计算
   - 节省CPU资源

4. **CoinMarketCap资金费率**
   - 判断市场多空情绪
   - 过滤过热合约

### 长期规划

5. **新闻情绪分析**
6. **社交媒体监控**
7. **链上数据预警**

---

想要我帮您集成哪个API？我可以立即编写代码！
