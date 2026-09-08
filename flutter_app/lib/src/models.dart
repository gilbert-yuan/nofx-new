import 'dart:math' as math;

enum TradeAction { openLong, openShort, closeLong, closeShort, wait }

extension TradeActionCopy on TradeAction {
  String get code => switch (this) {
        TradeAction.openLong => 'OPEN_LONG',
        TradeAction.openShort => 'OPEN_SHORT',
        TradeAction.closeLong => 'CLOSE_LONG',
        TradeAction.closeShort => 'CLOSE_SHORT',
        TradeAction.wait => 'WAIT',
      };

  String get label => switch (this) {
        TradeAction.openLong => '做多',
        TradeAction.openShort => '做空',
        TradeAction.closeLong => '平多',
        TradeAction.closeShort => '平空',
        TradeAction.wait => '观望',
      };
}

TradeAction tradeActionFromCode(String code) => switch (code.toUpperCase()) {
      'BUY' || 'OPEN_LONG' => TradeAction.openLong,
      'SELL' || 'OPEN_SHORT' => TradeAction.openShort,
      'CLOSE_LONG' => TradeAction.closeLong,
      'CLOSE_SHORT' => TradeAction.closeShort,
      _ => TradeAction.wait,
    };

class MarketSymbol {
  const MarketSymbol({
    required this.code,
    required this.baseCoin,
    required this.rank,
    required this.price,
    required this.change,
    required this.marketCap,
  });

  final String code;
  final String baseCoin;
  final int rank;
  final double price;
  final double change;
  final String marketCap;

  factory MarketSymbol.fromApiJson(Map<String, dynamic> json) {
    final code =
        (json['symbol'] ?? json['code'] ?? '').toString().toUpperCase();
    final base = (json['baseCoin'] ??
            (code.endsWith('USDT') ? code.substring(0, code.length - 4) : code))
        .toString();
    return MarketSymbol(
      code: code,
      baseCoin: base,
      rank: _toInt(json['rank']),
      price: _toDouble(json['price']),
      change: _toDouble(json['change'] ?? json['priceChangePercent']),
      marketCap: _formatMarketCap(json['marketCap']),
    );
  }

  factory MarketSymbol.fromJson(Map<String, dynamic> json) =>
      MarketSymbol.fromApiJson(json);

  Map<String, dynamic> toJson() => {
        'symbol': code,
        'baseCoin': baseCoin,
        'rank': rank,
        'price': price,
        'change': change,
        'marketCap': marketCap,
      };

  MarketSymbol copyWith({double? price, double? change}) => MarketSymbol(
        code: code,
        baseCoin: baseCoin,
        rank: rank,
        price: price ?? this.price,
        change: change ?? this.change,
        marketCap: marketCap,
      );
}

class Candle {
  const Candle({
    required this.open,
    required this.high,
    required this.low,
    required this.close,
    this.openTime,
    this.closeTime,
    this.volume,
    this.quoteVolume,
    this.tradeCount,
  });

  final double open;
  final double high;
  final double low;
  final double close;
  final int? openTime;
  final int? closeTime;
  final double? volume;
  final double? quoteVolume;
  final int? tradeCount;

  factory Candle.fromApiJson(Map<String, dynamic> json) => Candle(
        open: _toDouble(json['open']),
        high: _toDouble(json['high']),
        low: _toDouble(json['low']),
        close: _toDouble(json['close']),
        openTime: _toNullableInt(json['openTime'] ?? json['open_time']),
        closeTime: _toNullableInt(json['closeTime'] ?? json['close_time']),
        volume: _toNullableDouble(json['volume']),
        quoteVolume:
            _toNullableDouble(json['quoteVolume'] ?? json['quote_volume']),
        tradeCount: _toNullableInt(json['tradeCount'] ?? json['trade_count']),
      );

  factory Candle.fromJson(Map<String, dynamic> json) =>
      Candle.fromApiJson(json);

  Map<String, dynamic> toJson() => {
        'openTime': openTime,
        'open': open,
        'high': high,
        'low': low,
        'close': close,
        'volume': volume,
        'closeTime': closeTime,
        'quoteVolume': quoteVolume,
        'tradeCount': tradeCount,
      };
}

class AnalysisResult {
  const AnalysisResult({
    required this.symbol,
    required this.action,
    required this.confidence,
    required this.position,
    required this.reason,
    required this.risk,
    required this.suggestion,
    required this.createdAt,
  });

  final String symbol;
  final TradeAction action;
  final int confidence;
  final String position;
  final String reason;
  final String risk;
  final String suggestion;
  final DateTime createdAt;

  factory AnalysisResult.fromApiJson(
    Map<String, dynamic> json, {
    String? fallbackSymbol,
    DateTime? fallbackTime,
  }) {
    final rawAction =
        (json['positionRecommendation'] ?? json['action'] ?? 'WAIT')
            .toString()
            .toUpperCase();
    return AnalysisResult(
      symbol: (json['symbol'] ?? fallbackSymbol ?? '').toString().toUpperCase(),
      action: tradeActionFromCode(rawAction),
      confidence: _toInt(json['confidence']).clamp(0, 100).toInt(),
      position: _positionLabel(rawAction, json['positionRecommendation']),
      reason: (json['reason'] ?? 'AI 未提供判断依据').toString(),
      risk: (json['risk'] ?? 'AI 未提供风险提示').toString(),
      suggestion: (json['suggestion'] ?? '请结合最新 K 线复核后再决定。').toString(),
      createdAt: _toDateTime(
          json['createdAt'] ?? json['at'], fallbackTime ?? DateTime.now()),
    );
  }

  factory AnalysisResult.fromJson(Map<String, dynamic> json) =>
      AnalysisResult.fromApiJson(json);

  Map<String, dynamic> toJson() => {
        'symbol': symbol,
        'action': action.code,
        'positionRecommendation': action.code,
        'confidence': confidence,
        'position': position,
        'reason': reason,
        'risk': risk,
        'suggestion': suggestion,
        'createdAt': createdAt.toIso8601String(),
      };
}

class KlineResponse {
  const KlineResponse(
      {required this.symbol, required this.interval, required this.candles});

  final String symbol;
  final String interval;
  final List<Candle> candles;
}

class AnalysisEnvelope {
  const AnalysisEnvelope({
    required this.id,
    required this.type,
    required this.symbol,
    required this.interval,
    required this.createdAt,
    required this.analyses,
    this.error = '',
  });

  final String id;
  final String type;
  final String symbol;
  final String interval;
  final DateTime createdAt;
  final List<AnalysisResult> analyses;
  final String error;

  AnalysisResult? get primaryResult => analyses.isEmpty ? null : analyses.first;

  factory AnalysisEnvelope.fromApiJson(Map<String, dynamic> json) {
    final at = _toDateTime(json['at'] ?? json['createdAt'], DateTime.now());
    final fallbackSymbol = (json['symbol'] ?? '').toString().toUpperCase();
    final rawAnalyses = json['analyses'];
    final analyses = rawAnalyses is List
        ? rawAnalyses
            .whereType<Map>()
            .map((item) => AnalysisResult.fromApiJson(
                  Map<String, dynamic>.from(item),
                  fallbackSymbol: fallbackSymbol,
                  fallbackTime: at,
                ))
            .toList()
        : <AnalysisResult>[];
    return AnalysisEnvelope(
      id: (json['id'] ?? 'analysis-${at.microsecondsSinceEpoch}').toString(),
      type: (json['type'] ?? 'single').toString(),
      symbol: fallbackSymbol.isEmpty
          ? (analyses.firstOrNull?.symbol ?? '')
          : fallbackSymbol,
      interval: (json['interval'] ?? '4h').toString(),
      createdAt: at,
      analyses: analyses,
      error: (json['error'] ?? '').toString(),
    );
  }

  factory AnalysisEnvelope.fromJson(Map<String, dynamic> json) =>
      AnalysisEnvelope.fromApiJson(json);

  Map<String, dynamic> toJson() => {
        'id': id,
        'type': type,
        'symbol': symbol,
        'interval': interval,
        'at': createdAt.toIso8601String(),
        'analyses': analyses.map((item) => item.toJson()).toList(),
        'error': error,
      };
}

class CoinglassMarket {
  const CoinglassMarket({
    required this.symbol,
    this.price = 0,
    this.priceChangePercent1h = 0,
    this.priceChangePercent4h = 0,
    this.priceChangePercent24h = 0,
    this.openInterestUsd = 0,
    this.openInterestChangePercent1h = 0,
    this.openInterestChangePercent4h = 0,
    this.openInterestChangePercent24h = 0,
    this.volumeChangePercent1h = 0,
    this.volumeChangePercent4h = 0,
    this.volumeChangePercent24h = 0,
    this.longShortRatio1h = 0,
    this.longShortRatio4h = 0,
    this.longShortRatio24h = 0,
    this.liquidationUsd1h = 0,
    this.liquidationUsd4h = 0,
    this.liquidationUsd24h = 0,
    this.longLiquidationUsd1h = 0,
    this.shortLiquidationUsd1h = 0,
    this.longLiquidationUsd4h = 0,
    this.shortLiquidationUsd4h = 0,
    this.longLiquidationUsd24h = 0,
    this.shortLiquidationUsd24h = 0,
  });

  final String symbol;
  final double price;
  final double priceChangePercent1h;
  final double priceChangePercent4h;
  final double priceChangePercent24h;
  final double openInterestUsd;
  final double openInterestChangePercent1h;
  final double openInterestChangePercent4h;
  final double openInterestChangePercent24h;
  final double volumeChangePercent1h;
  final double volumeChangePercent4h;
  final double volumeChangePercent24h;
  final double longShortRatio1h;
  final double longShortRatio4h;
  final double longShortRatio24h;
  final double liquidationUsd1h;
  final double liquidationUsd4h;
  final double liquidationUsd24h;
  final double longLiquidationUsd1h;
  final double shortLiquidationUsd1h;
  final double longLiquidationUsd4h;
  final double shortLiquidationUsd4h;
  final double longLiquidationUsd24h;
  final double shortLiquidationUsd24h;

  factory CoinglassMarket.fromApiJson(Map<String, dynamic> json) {
    return CoinglassMarket(
      symbol: (json['symbol'] ?? '').toString().toUpperCase(),
      price: _toDouble(json['current_price']),
      priceChangePercent1h: _toDouble(json['price_change_percent_1h']),
      priceChangePercent4h: _toDouble(json['price_change_percent_4h']),
      priceChangePercent24h: _toDouble(json['price_change_percent_24h']),
      openInterestUsd: _toDouble(json['open_interest_usd']),
      openInterestChangePercent1h:
          _toDouble(json['open_interest_change_percent_1h']),
      openInterestChangePercent4h:
          _toDouble(json['open_interest_change_percent_4h']),
      openInterestChangePercent24h:
          _toDouble(json['open_interest_change_percent_24h']),
      volumeChangePercent1h: _toDouble(json['volume_change_percent_1h']),
      volumeChangePercent4h: _toDouble(json['volume_change_percent_4h']),
      volumeChangePercent24h: _toDouble(json['volume_change_percent_24h']),
      longShortRatio1h: _toDouble(json['long_short_ratio_1h']),
      longShortRatio4h: _toDouble(json['long_short_ratio_4h']),
      longShortRatio24h: _toDouble(json['long_short_ratio_24h']),
      liquidationUsd1h: _toDouble(json['liquidation_usd_1h']),
      liquidationUsd4h: _toDouble(json['liquidation_usd_4h']),
      liquidationUsd24h: _toDouble(json['liquidation_usd_24h']),
      longLiquidationUsd1h: _toDouble(json['long_liquidation_usd_1h']),
      shortLiquidationUsd1h: _toDouble(json['short_liquidation_usd_1h']),
      longLiquidationUsd4h: _toDouble(json['long_liquidation_usd_4h']),
      shortLiquidationUsd4h: _toDouble(json['short_liquidation_usd_4h']),
      longLiquidationUsd24h: _toDouble(json['long_liquidation_usd_24h']),
      shortLiquidationUsd24h: _toDouble(json['short_liquidation_usd_24h']),
    );
  }

  Map<String, dynamic> toJson() => {
        'symbol': symbol,
        'price': price,
        'priceChangePercent': {
          '1h': priceChangePercent1h,
          '4h': priceChangePercent4h,
          '24h': priceChangePercent24h,
        },
        'openInterest': {
          'usd': openInterestUsd,
          'changePercent': {
            '1h': openInterestChangePercent1h,
            '4h': openInterestChangePercent4h,
            '24h': openInterestChangePercent24h,
          },
        },
        'volumeChangePercent': {
          '1h': volumeChangePercent1h,
          '4h': volumeChangePercent4h,
          '24h': volumeChangePercent24h,
        },
        'longShortRatio': {
          '1h': longShortRatio1h,
          '4h': longShortRatio4h,
          '24h': longShortRatio24h,
        },
        'liquidation': {
          'usd': {
            '1h': liquidationUsd1h,
            '4h': liquidationUsd4h,
            '24h': liquidationUsd24h,
          },
          'long': {
            '1h': longLiquidationUsd1h,
            '4h': longLiquidationUsd4h,
            '24h': longLiquidationUsd24h,
          },
          'short': {
            '1h': shortLiquidationUsd1h,
            '4h': shortLiquidationUsd4h,
            '24h': shortLiquidationUsd24h,
          },
        },
      };

  String get formattedOi => openInterestUsd >= 1000000000
      ? '${(openInterestUsd / 1000000000).toStringAsFixed(2)}B'
      : openInterestUsd >= 1000000
          ? '${(openInterestUsd / 1000000).toStringAsFixed(1)}M'
          : openInterestUsd.toStringAsFixed(0);

  String get formattedLiquidation1h => liquidationUsd1h >= 1000000
      ? '${(liquidationUsd1h / 1000000).toStringAsFixed(1)}M'
      : liquidationUsd1h.toStringAsFixed(0);
}

class AnalysisConfig {
  const AnalysisConfig({
    this.interval = '4h',
    this.klineCount = 80,
    this.maxSymbols = 30,
    this.batchSize = 8,
    this.customSymbols = '',
  });

  final String interval;
  final int klineCount;
  final int maxSymbols;
  final int batchSize;
  final String customSymbols;

  Map<String, dynamic> toJson() => {
        'interval': interval,
        'klineCount': klineCount,
        'maxSymbols': maxSymbols,
        'batchSize': batchSize,
        'customSymbols': customSymbols,
      };

  factory AnalysisConfig.fromJson(Map<String, dynamic> json) => AnalysisConfig(
        interval: (json['interval'] ?? '4h').toString(),
        klineCount: _toInt(json['klineCount'] ?? json['klineLimit'])
            .clamp(20, 200)
            .toInt(),
        maxSymbols: _toInt(json['maxSymbols']).clamp(1, 300).toInt(),
        batchSize: _toInt(json['batchSize']).clamp(1, 20).toInt(),
        customSymbols: (json['customSymbols'] ?? '').toString(),
      );

  AnalysisConfig copyWith({
    String? interval,
    int? klineCount,
    int? maxSymbols,
    int? batchSize,
    String? customSymbols,
  }) {
    return AnalysisConfig(
      interval: interval ?? this.interval,
      klineCount: klineCount ?? this.klineCount,
      maxSymbols: maxSymbols ?? this.maxSymbols,
      batchSize: batchSize ?? this.batchSize,
      customSymbols: customSymbols ?? this.customSymbols,
    );
  }
}

List<Candle> buildCandles(String symbol, int count, {double? seedPrice}) {
  final random = math.Random(
    symbol.codeUnits.fold<int>(0, (total, unit) => total + unit),
  );
  final known = symbols.where((item) => item.code == symbol).toList();
  final seed = seedPrice ??
      (known.isEmpty ? _priceFromSymbol(symbol) : known.first.price);
  var cursor = seed * (0.92 + random.nextDouble() * 0.12);

  return List.generate(count, (index) {
    final wave = math.sin(index / 5.5) * 0.012;
    final impulse = (random.nextDouble() - 0.48) * 0.026;
    final open = cursor;
    final close = open * (1 + wave + impulse);
    final high = math.max(open, close) * (1 + random.nextDouble() * 0.018);
    final low = math.min(open, close) * (1 - random.nextDouble() * 0.018);
    cursor = close;
    return Candle(open: open, high: high, low: low, close: close);
  });
}

double _priceFromSymbol(String symbol) {
  final hash =
      symbol.codeUnits.fold<int>(0, (total, unit) => total * 31 + unit);
  return 0.5 + (hash.abs() % 100000) / 100;
}

double _toDouble(dynamic value) =>
    double.tryParse(value?.toString() ?? '') ?? 0;

double? _toNullableDouble(dynamic value) =>
    value == null ? null : _toDouble(value);

int _toInt(dynamic value) => int.tryParse(value?.toString() ?? '') ?? 0;

int? _toNullableInt(dynamic value) => value == null ? null : _toInt(value);

DateTime _toDateTime(dynamic value, DateTime fallback) =>
    DateTime.tryParse(value?.toString() ?? '') ?? fallback;

String _formatMarketCap(dynamic value) {
  if (value == null) return '未知';
  if (value is String && value.isNotEmpty) return value;
  final number = _toDouble(value);
  if (number >= 1000000000000) {
    return '${(number / 1000000000000).toStringAsFixed(2)}T';
  }
  if (number >= 1000000000) {
    return '${(number / 1000000000).toStringAsFixed(2)}B';
  }
  if (number >= 1000000) {
    return '${(number / 1000000).toStringAsFixed(2)}M';
  }
  return number == 0 ? '未知' : number.toStringAsFixed(0);
}

String _positionLabel(String action, dynamic recommendation) {
  switch ((recommendation ?? action).toString().toUpperCase()) {
    case 'OPEN_LONG':
    case 'OPEN_SHORT':
      return '按 AI 建议执行，仓位需自行评估';
    case 'CLOSE_LONG':
    case 'CLOSE_SHORT':
      return '优先考虑已有仓位管理';
    default:
      return '无新增仓位';
  }
}

const List<MarketSymbol> symbols = [
  // Top 10
  MarketSymbol(
      code: 'BTCUSDT',
      baseCoin: 'BTC',
      rank: 1,
      price: 104820.5,
      change: 2.84,
      marketCap: '2.08T'),
  MarketSymbol(
      code: 'ETHUSDT',
      baseCoin: 'ETH',
      rank: 2,
      price: 2524.84,
      change: 1.72,
      marketCap: '304.3B'),
  MarketSymbol(
      code: 'SOLUSDT',
      baseCoin: 'SOL',
      rank: 3,
      price: 148.62,
      change: -0.96,
      marketCap: '79.1B'),
  MarketSymbol(
      code: 'XRPUSDT',
      baseCoin: 'XRP',
      rank: 4,
      price: 2.173,
      change: 3.23,
      marketCap: '127.4B'),
  MarketSymbol(
      code: 'BNBUSDT',
      baseCoin: 'BNB',
      rank: 5,
      price: 648.85,
      change: 0.42,
      marketCap: '94.7B'),
  MarketSymbol(
      code: 'DOGEUSDT',
      baseCoin: 'DOGE',
      rank: 6,
      price: 0.1745,
      change: -1.64,
      marketCap: '26.1B'),
  MarketSymbol(
      code: 'ADAUSDT',
      baseCoin: 'ADA',
      rank: 7,
      price: 0.6152,
      change: 1.18,
      marketCap: '21.8B'),
  MarketSymbol(
      code: 'AVAXUSDT',
      baseCoin: 'AVAX',
      rank: 8,
      price: 22.94,
      change: -2.31,
      marketCap: '9.7B'),
  MarketSymbol(
      code: 'LINKUSDT',
      baseCoin: 'LINK',
      rank: 9,
      price: 15.07,
      change: 0.85,
      marketCap: '10.2B'),
  MarketSymbol(
      code: 'TONUSDT',
      baseCoin: 'TON',
      rank: 10,
      price: 3.126,
      change: -0.48,
      marketCap: '7.9B'),

  // Top 11-30
  MarketSymbol(
      code: 'SUIUSDT',
      baseCoin: 'SUI',
      rank: 11,
      price: 3.012,
      change: 4.09,
      marketCap: '9.1B'),
  MarketSymbol(
      code: 'APTUSDT',
      baseCoin: 'APT',
      rank: 12,
      price: 5.398,
      change: -0.73,
      marketCap: '3.4B'),
  MarketSymbol(
      code: 'ARBUSDT',
      baseCoin: 'ARB',
      rank: 13,
      price: 0.388,
      change: 1.34,
      marketCap: '2.8B'),
  MarketSymbol(
      code: 'OPUSDT',
      baseCoin: 'OP',
      rank: 14,
      price: 0.781,
      change: -0.86,
      marketCap: '2.1B'),
  MarketSymbol(
      code: 'INJUSDT',
      baseCoin: 'INJ',
      rank: 15,
      price: 13.24,
      change: 2.06,
      marketCap: '1.9B'),
  MarketSymbol(
      code: 'NEARUSDT',
      baseCoin: 'NEAR',
      rank: 16,
      price: 2.41,
      change: -1.12,
      marketCap: '3.2B'),
  MarketSymbol(
      code: 'TRXUSDT',
      baseCoin: 'TRX',
      rank: 17,
      price: 0.284,
      change: 0.63,
      marketCap: '24.8B'),
  MarketSymbol(
      code: 'LTCUSDT',
      baseCoin: 'LTC',
      rank: 18,
      price: 86.4,
      change: -0.42,
      marketCap: '6.8B'),
  MarketSymbol(
      code: 'DOTUSDT',
      baseCoin: 'DOT',
      rank: 19,
      price: 3.21,
      change: 0.94,
      marketCap: '5.1B'),
  MarketSymbol(
      code: 'ATOMUSDT',
      baseCoin: 'ATOM',
      rank: 20,
      price: 4.02,
      change: 1.27,
      marketCap: '1.6B'),
  MarketSymbol(
      code: 'FILUSDT',
      baseCoin: 'FIL',
      rank: 21,
      price: 2.14,
      change: -1.76,
      marketCap: '1.2B'),
  MarketSymbol(
      code: 'ICPUSDT',
      baseCoin: 'ICP',
      rank: 22,
      price: 4.76,
      change: 0.58,
      marketCap: '2.3B'),
  MarketSymbol(
      code: 'AAVEUSDT',
      baseCoin: 'AAVE',
      rank: 23,
      price: 173.2,
      change: 2.41,
      marketCap: '2.6B'),
  MarketSymbol(
      code: 'UNIUSDT',
      baseCoin: 'UNI',
      rank: 24,
      price: 6.08,
      change: -0.31,
      marketCap: '3.7B'),
  MarketSymbol(
      code: 'MATICUSDT',
      baseCoin: 'MATIC',
      rank: 25,
      price: 0.198,
      change: -2.14,
      marketCap: '1.9B'),
  MarketSymbol(
      code: 'ETCUSDT',
      baseCoin: 'ETC',
      rank: 26,
      price: 17.32,
      change: 1.56,
      marketCap: '2.5B'),
  MarketSymbol(
      code: 'SHIBUSDT',
      baseCoin: 'SHIB',
      rank: 27,
      price: 0.00001234,
      change: 3.87,
      marketCap: '7.3B'),
  MarketSymbol(
      code: 'PEPEUSDT',
      baseCoin: 'PEPE',
      rank: 28,
      price: 0.00000876,
      change: -4.21,
      marketCap: '3.7B'),
  MarketSymbol(
      code: 'WIFUSDT',
      baseCoin: 'WIF',
      rank: 29,
      price: 1.142,
      change: 2.93,
      marketCap: '1.1B'),
  MarketSymbol(
      code: 'BONKUSDT',
      baseCoin: 'BONK',
      rank: 30,
      price: 0.00001456,
      change: -1.28,
      marketCap: '950M'),

  // Top 31-50
  MarketSymbol(
      code: 'FTMUSDT',
      baseCoin: 'FTM',
      rank: 31,
      price: 0.342,
      change: 0.87,
      marketCap: '960M'),
  MarketSymbol(
      code: 'ALGOUSDT',
      baseCoin: 'ALGO',
      rank: 32,
      price: 0.165,
      change: -0.45,
      marketCap: '1.3B'),
  MarketSymbol(
      code: 'VETUSDT',
      baseCoin: 'VET',
      rank: 33,
      price: 0.0234,
      change: 1.67,
      marketCap: '1.7B'),
  MarketSymbol(
      code: 'XLMUSDT',
      baseCoin: 'XLM',
      rank: 34,
      price: 0.087,
      change: 2.34,
      marketCap: '2.5B'),
  MarketSymbol(
      code: 'SANDUSDT',
      baseCoin: 'SAND',
      rank: 35,
      price: 0.298,
      change: -3.12,
      marketCap: '680M'),
  MarketSymbol(
      code: 'MANAUSDT',
      baseCoin: 'MANA',
      rank: 36,
      price: 0.342,
      change: 1.89,
      marketCap: '640M'),
  MarketSymbol(
      code: 'AXSUSDT',
      baseCoin: 'AXS',
      rank: 37,
      price: 3.87,
      change: -2.45,
      marketCap: '570M'),
  MarketSymbol(
      code: 'THETAUSDT',
      baseCoin: 'THETA',
      rank: 38,
      price: 1.23,
      change: 0.76,
      marketCap: '1.2B'),
  MarketSymbol(
      code: 'XTZUSDT',
      baseCoin: 'XTZ',
      rank: 39,
      price: 0.654,
      change: 1.12,
      marketCap: '620M'),
  MarketSymbol(
      code: 'EOSUSDT',
      baseCoin: 'EOS',
      rank: 40,
      price: 0.478,
      change: -0.89,
      marketCap: '540M'),
  MarketSymbol(
      code: 'HBARUSDT',
      baseCoin: 'HBAR',
      rank: 41,
      price: 0.0432,
      change: 2.67,
      marketCap: '1.6B'),
  MarketSymbol(
      code: 'RNDRUSDT',
      baseCoin: 'RNDR',
      rank: 42,
      price: 3.65,
      change: -1.34,
      marketCap: '1.8B'),
  MarketSymbol(
      code: 'GRTUSDT',
      baseCoin: 'GRT',
      rank: 43,
      price: 0.098,
      change: 0.54,
      marketCap: '920M'),
  MarketSymbol(
      code: 'FTMUSDT',
      baseCoin: 'FTM',
      rank: 44,
      price: 0.342,
      change: 1.76,
      marketCap: '960M'),
  MarketSymbol(
      code: 'IMXUSDT',
      baseCoin: 'IMX',
      rank: 45,
      price: 0.876,
      change: -2.23,
      marketCap: '1.3B'),
  MarketSymbol(
      code: 'LDOUSDT',
      baseCoin: 'LDO',
      rank: 46,
      price: 1.23,
      change: 3.45,
      marketCap: '1.1B'),
  MarketSymbol(
      code: 'STXUSDT',
      baseCoin: 'STX',
      rank: 47,
      price: 0.765,
      change: -0.67,
      marketCap: '1.1B'),
  MarketSymbol(
      code: 'RUNEUSDT',
      baseCoin: 'RUNE',
      rank: 48,
      price: 2.34,
      change: 1.98,
      marketCap: '780M'),
  MarketSymbol(
      code: 'ZILUSDT',
      baseCoin: 'ZIL',
      rank: 49,
      price: 0.0123,
      change: -1.45,
      marketCap: '260M'),
  MarketSymbol(
      code: 'ENJUSDT',
      baseCoin: 'ENJ',
      rank: 50,
      price: 0.145,
      change: 0.89,
      marketCap: '240M'),

  // Top 51-70
  MarketSymbol(
      code: 'CHZUSDT',
      baseCoin: 'CHZ',
      rank: 51,
      price: 0.0543,
      change: 2.12,
      marketCap: '480M'),
  MarketSymbol(
      code: '1INCHUSDT',
      baseCoin: '1INCH',
      rank: 52,
      price: 0.234,
      change: -1.67,
      marketCap: '340M'),
  MarketSymbol(
      code: 'COMPUSDT',
      baseCoin: 'COMP',
      rank: 53,
      price: 42.3,
      change: 1.34,
      marketCap: '360M'),
  MarketSymbol(
      code: 'SNXUSDT',
      baseCoin: 'SNX',
      rank: 54,
      price: 1.87,
      change: -0.98,
      marketCap: '580M'),
  MarketSymbol(
      code: 'MKRUSDT',
      baseCoin: 'MKR',
      rank: 55,
      price: 1234.5,
      change: 2.45,
      marketCap: '1.2B'),
  MarketSymbol(
      code: 'CRVUSDT',
      baseCoin: 'CRV',
      rank: 56,
      price: 0.345,
      change: -2.34,
      marketCap: '420M'),
  MarketSymbol(
      code: 'OCEANUSDT',
      baseCoin: 'OCEAN',
      rank: 57,
      price: 0.234,
      change: 1.56,
      marketCap: '320M'),
  MarketSymbol(
      code: 'OCEANUSDT',
      baseCoin: 'OCEAN',
      rank: 58,
      price: 0.234,
      change: 0.78,
      marketCap: '320M'),
  MarketSymbol(
      code: 'SUSHIUSDT',
      baseCoin: 'SUSHI',
      rank: 59,
      price: 0.678,
      change: -1.23,
      marketCap: '180M'),
  MarketSymbol(
      code: 'YFIUSDT',
      baseCoin: 'YFI',
      rank: 60,
      price: 4567.8,
      change: 3.21,
      marketCap: '280M'),
  MarketSymbol(
      code: 'BALUSDT',
      baseCoin: 'BAL',
      rank: 61,
      price: 1.89,
      change: -0.45,
      marketCap: '120M'),
  MarketSymbol(
      code: 'ZRXUSDT',
      baseCoin: 'ZRX',
      rank: 62,
      price: 0.234,
      change: 1.67,
      marketCap: '200M'),
  MarketSymbol(
      code: 'BATUSDT',
      baseCoin: 'BAT',
      rank: 63,
      price: 0.156,
      change: -2.12,
      marketCap: '230M'),
  MarketSymbol(
      code: 'KNCUSDT',
      baseCoin: 'KNC',
      rank: 64,
      price: 0.456,
      change: 0.89,
      marketCap: '140M'),
  MarketSymbol(
      code: 'BANDUSDT',
      baseCoin: 'BAND',
      rank: 65,
      price: 0.876,
      change: 2.34,
      marketCap: '110M'),
  MarketSymbol(
      code: 'STORJUSDT',
      baseCoin: 'STORJ',
      rank: 66,
      price: 0.234,
      change: -1.56,
      marketCap: '90M'),
  MarketSymbol(
      code: 'QNTUSDT',
      baseCoin: 'QNT',
      rank: 67,
      price: 78.9,
      change: 3.45,
      marketCap: '950M'),
  MarketSymbol(
      code: 'IOTAUSDT',
      baseCoin: 'IOTA',
      rank: 68,
      price: 0.123,
      change: -0.67,
      marketCap: '340M'),
  MarketSymbol(
      code: 'FLOWUSDT',
      baseCoin: 'FLOW',
      rank: 69,
      price: 0.543,
      change: 1.23,
      marketCap: '540M'),
  MarketSymbol(
      code: 'MINAUSDT',
      baseCoin: 'MINA',
      rank: 70,
      price: 0.432,
      change: -2.45,
      marketCap: '450M'),

  // Top 71-90
  MarketSymbol(
      code: 'CAKEUSDT',
      baseCoin: 'CAKE',
      rank: 71,
      price: 1.87,
      change: 1.89,
      marketCap: '280M'),
  MarketSymbol(
      code: 'GMXUSDT',
      baseCoin: 'GMX',
      rank: 72,
      price: 23.4,
      change: -1.23,
      marketCap: '190M'),
  MarketSymbol(
      code: 'PENDLEUSDT',
      baseCoin: 'PENDLE',
      rank: 73,
      price: 2.34,
      change: 4.56,
      marketCap: '340M'),
  MarketSymbol(
      code: 'BLURUSDT',
      baseCoin: 'BLUR',
      rank: 74,
      price: 0.234,
      change: -3.21,
      marketCap: '180M'),
  MarketSymbol(
      code: 'ARUSDT',
      baseCoin: 'AR',
      rank: 75,
      price: 5.67,
      change: 2.12,
      marketCap: '370M'),
  MarketSymbol(
      code: 'WAVESUSDT',
      baseCoin: 'WAVES',
      rank: 76,
      price: 1.23,
      change: -1.89,
      marketCap: '120M'),
  MarketSymbol(
      code: 'KAVAUSDT',
      baseCoin: 'KAVA',
      rank: 77,
      price: 0.456,
      change: 0.78,
      marketCap: '210M'),
  MarketSymbol(
      code: 'KSMUSDT',
      baseCoin: 'KSM',
      rank: 78,
      price: 17.8,
      change: 1.45,
      marketCap: '320M'),
  MarketSymbol(
      code: 'ONEUSDT',
      baseCoin: 'ONE',
      rank: 79,
      price: 0.0123,
      change: -2.34,
      marketCap: '160M'),
  MarketSymbol(
      code: 'ZILUSDT',
      baseCoin: 'ZIL',
      rank: 80,
      price: 0.0156,
      change: 3.12,
      marketCap: '260M'),
  MarketSymbol(
      code: 'DASHUSDT',
      baseCoin: 'DASH',
      rank: 81,
      price: 23.4,
      change: -0.89,
      marketCap: '280M'),
  MarketSymbol(
      code: 'NEOUSDT',
      baseCoin: 'NEO',
      rank: 82,
      price: 8.76,
      change: 1.67,
      marketCap: '620M'),
  MarketSymbol(
      code: 'QTUMUSDT',
      baseCoin: 'QTUM',
      rank: 83,
      price: 2.34,
      change: -1.23,
      marketCap: '240M'),
  MarketSymbol(
      code: 'ZECUSDT',
      baseCoin: 'ZEC',
      rank: 84,
      price: 34.5,
      change: 2.45,
      marketCap: '530M'),
  MarketSymbol(
      code: 'OMGUSDT',
      baseCoin: 'OMG',
      rank: 85,
      price: 0.345,
      change: -3.12,
      marketCap: '48M'),
  MarketSymbol(
      code: 'RVNUSDT',
      baseCoin: 'RVN',
      rank: 86,
      price: 0.0167,
      change: 1.89,
      marketCap: '230M'),
  MarketSymbol(
      code: 'DGBUSDT',
      baseCoin: 'DGB',
      rank: 87,
      price: 0.0067,
      change: -0.45,
      marketCap: '110M'),
  MarketSymbol(
      code: 'SCUSDT',
      baseCoin: 'SC',
      rank: 88,
      price: 0.0034,
      change: 2.67,
      marketCap: '190M'),
  MarketSymbol(
      code: 'LSKUSDT',
      baseCoin: 'LSK',
      rank: 89,
      price: 0.876,
      change: -1.78,
      marketCap: '120M'),
  MarketSymbol(
      code: 'XEMUSDT',
      baseCoin: 'XEM',
      rank: 90,
      price: 0.0234,
      change: 1.34,
      marketCap: '210M'),

  // Top 91-100
  MarketSymbol(
      code: 'ICXUSDT',
      baseCoin: 'ICX',
      rank: 91,
      price: 0.123,
      change: -2.12,
      marketCap: '98M'),
  MarketSymbol(
      code: 'ONTUSDT',
      baseCoin: 'ONT',
      rank: 92,
      price: 0.156,
      change: 0.89,
      marketCap: '140M'),
  MarketSymbol(
      code: 'ZILUSDT',
      baseCoin: 'ZIL',
      rank: 93,
      price: 0.0145,
      change: 3.45,
      marketCap: '260M'),
  MarketSymbol(
      code: 'CELOUSDT',
      baseCoin: 'CELO',
      rank: 94,
      price: 0.432,
      change: -1.67,
      marketCap: '210M'),
  MarketSymbol(
      code: 'COTIUSDT',
      baseCoin: 'COTI',
      rank: 95,
      price: 0.0456,
      change: 2.34,
      marketCap: '75M'),
  MarketSymbol(
      code: 'CHRUSDT',
      baseCoin: 'CHR',
      rank: 96,
      price: 0.123,
      change: -0.78,
      marketCap: '82M'),
  MarketSymbol(
      code: 'HOTUSDT',
      baseCoin: 'HOT',
      rank: 97,
      price: 0.00123,
      change: 1.56,
      marketCap: '130M'),
  MarketSymbol(
      code: 'DUSKUSDT',
      baseCoin: 'DUSK',
      rank: 98,
      price: 0.0987,
      change: -2.89,
      marketCap: '68M'),
  MarketSymbol(
      code: 'ANKRUSDT',
      baseCoin: 'ANKR',
      rank: 99,
      price: 0.0178,
      change: 0.67,
      marketCap: '180M'),
  MarketSymbol(
      code: 'WINUSDT',
      baseCoin: 'WIN',
      rank: 100,
      price: 0.000056,
      change: 4.12,
      marketCap: '95M'),
];

const List<MarketSymbol> localCatalog = [
  MarketSymbol(
    code: 'ARBUSDT',
    baseCoin: 'ARB',
    rank: 13,
    price: 0.388,
    change: 1.34,
    marketCap: '本地目录',
  ),
  MarketSymbol(
    code: 'OPUSDT',
    baseCoin: 'OP',
    rank: 14,
    price: 0.781,
    change: -0.86,
    marketCap: '本地目录',
  ),
  MarketSymbol(
    code: 'INJUSDT',
    baseCoin: 'INJ',
    rank: 15,
    price: 13.24,
    change: 2.06,
    marketCap: '本地目录',
  ),
  MarketSymbol(
    code: 'NEARUSDT',
    baseCoin: 'NEAR',
    rank: 16,
    price: 2.41,
    change: -1.12,
    marketCap: '本地目录',
  ),
  MarketSymbol(
    code: 'TRXUSDT',
    baseCoin: 'TRX',
    rank: 17,
    price: 0.284,
    change: 0.63,
    marketCap: '本地目录',
  ),
  MarketSymbol(
    code: 'LTCUSDT',
    baseCoin: 'LTC',
    rank: 18,
    price: 86.4,
    change: -0.42,
    marketCap: '本地目录',
  ),
  MarketSymbol(
    code: 'DOTUSDT',
    baseCoin: 'DOT',
    rank: 19,
    price: 3.21,
    change: 0.94,
    marketCap: '本地目录',
  ),
  MarketSymbol(
    code: 'ATOMUSDT',
    baseCoin: 'ATOM',
    rank: 20,
    price: 4.02,
    change: 1.27,
    marketCap: '本地目录',
  ),
  MarketSymbol(
    code: 'FILUSDT',
    baseCoin: 'FIL',
    rank: 21,
    price: 2.14,
    change: -1.76,
    marketCap: '本地目录',
  ),
  MarketSymbol(
    code: 'ICPUSDT',
    baseCoin: 'ICP',
    rank: 22,
    price: 4.76,
    change: 0.58,
    marketCap: '本地目录',
  ),
  MarketSymbol(
    code: 'AAVEUSDT',
    baseCoin: 'AAVE',
    rank: 23,
    price: 173.2,
    change: 2.41,
    marketCap: '本地目录',
  ),
  MarketSymbol(
    code: 'UNIUSDT',
    baseCoin: 'UNI',
    rank: 24,
    price: 6.08,
    change: -0.31,
    marketCap: '本地目录',
  ),
];
