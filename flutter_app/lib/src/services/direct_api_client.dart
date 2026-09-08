import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models.dart';

class DirectApiException implements Exception {
  const DirectApiException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  @override
  String toString() => message;
}

class DirectApiClient {
  DirectApiClient({http.Client? client}) : _client = client ?? http.Client();

  static const defaultMarketBaseUrl = 'https://api.bybit.com';
  static const defaultAiBaseUrl = 'https://api.openai.com/v1';
  static const defaultCoinglassBaseUrl = 'https://open-api-v4.coinglass.com';

  final http.Client _client;

  Future<List<MarketSymbol>> fetchSymbols({
    String search = '',
    int limit = 100,
    String baseUrl = defaultMarketBaseUrl,
  }) async {
    final normalizedSearch = search.trim().toUpperCase();
    final result = <MarketSymbol>[];
    String? cursor;

    do {
      final body = await _get(
        baseUrl,
        '/v5/market/instruments-info',
        query: {
          'category': 'linear',
          'status': 'Trading',
          'limit': '1000',
          if (cursor != null && cursor.isNotEmpty) 'cursor': cursor,
        },
      );
      final data = _asMap(body, '交易所合约接口返回格式无效');
      final resultData = data['result'];
      final rows = resultData is Map ? resultData['list'] : null;
      if (rows is List) {
        for (final item in rows.whereType<Map>()) {
          final row = Map<String, dynamic>.from(item);
          if (row['contractType'] != 'LinearPerpetual' ||
              row['quoteCoin'] != 'USDT') {
            continue;
          }
          final symbol = (row['symbol'] ?? '').toString().toUpperCase();
          final baseCoin = (row['baseCoin'] ?? '').toString().toUpperCase();
          if (symbol.isEmpty ||
              (normalizedSearch.isNotEmpty &&
                  !symbol.contains(normalizedSearch) &&
                  !baseCoin.contains(normalizedSearch))) {
            continue;
          }
          result.add(
            MarketSymbol(
              code: symbol,
              baseCoin:
                  baseCoin.isEmpty ? symbol.replaceAll('USDT', '') : baseCoin,
              rank: result.length + 1,
              price: 0,
              change: 0,
              marketCap: 'Bybit 合约',
            ),
          );
          if (result.length >= limit) break;
        }
      }
      cursor =
          resultData is Map ? resultData['nextPageCursor']?.toString() : null;
    } while (result.length < limit && cursor != null && cursor.isNotEmpty);

    return _dedupeSymbols(result).take(limit).toList();
  }

  Future<KlineResponse> fetchKlines({
    required String symbol,
    required String interval,
    required int limit,
    String baseUrl = defaultMarketBaseUrl,
  }) async {
    final normalizedSymbol = symbol.toUpperCase().replaceFirst('BYBIT_', '');
    final body = await _get(
      baseUrl,
      '/v5/market/kline',
      query: {
        'category': 'linear',
        'symbol': normalizedSymbol,
        'interval': _bybitInterval(interval),
        'limit': '${limit.clamp(20, 200)}',
      },
    );
    final data = _asMap(body, '交易所 K 线接口返回格式无效');
    final resultData = data['result'];
    final rawRows = resultData is Map ? resultData['list'] : null;
    if (rawRows is! List) {
      throw const DirectApiException('交易所 K 线接口缺少 list 字段');
    }

    final candles = rawRows
        .whereType<List>()
        .where((row) => row.length >= 7)
        .map(
          (row) => Candle(
            openTime: _toInt(row[0]),
            open: _toDouble(row[1]),
            high: _toDouble(row[2]),
            low: _toDouble(row[3]),
            close: _toDouble(row[4]),
            volume: _toDouble(row[5]),
            quoteVolume: _toDouble(row[6]),
            closeTime: _toInt(row[0]) + _intervalMilliseconds(interval) - 1,
            tradeCount: 0,
          ),
        )
        .toList()
      ..sort((a, b) => (a.openTime ?? 0).compareTo(b.openTime ?? 0));

    return KlineResponse(
      symbol: normalizedSymbol,
      interval: interval,
      candles: candles,
    );
  }

  Future<Map<String, CoinglassMarket>> fetchCoinglassMarkets({
    required String apiKey,
    String baseUrl = defaultCoinglassBaseUrl,
    int perPage = 50,
    int maxPages = 6,
  }) async {
    if (apiKey.trim().isEmpty) {
      throw const DirectApiException('请先配置 Coinglass API Key');
    }
    final result = <String, CoinglassMarket>{};
    for (var page = 1; page <= maxPages; page++) {
      final body = await _get(
        baseUrl,
        '/api/futures/coins-markets',
        query: {
          'per_page': '$perPage',
          'page': '$page',
        },
        headers: {'CG-API-KEY': apiKey.trim()},
      );
      final data = _asMap(body, 'Coinglass 接口返回格式无效');
      final code = data['code']?.toString();
      if (code != null && code != '0') {
        throw DirectApiException(
          data['msg']?.toString() ?? 'Coinglass 接口错误 ($code)',
          statusCode: int.tryParse(code),
        );
      }
      final rows = data['data'];
      if (rows is! List || rows.isEmpty) break;
      for (final item in rows.whereType<Map>()) {
        final market =
            CoinglassMarket.fromApiJson(Map<String, dynamic>.from(item));
        if (market.symbol.isNotEmpty) result[market.symbol] = market;
      }
      if (rows.length < perPage) break;
    }
    return result;
  }

  Future<AnalysisEnvelope> analyzeSingle({
    required String symbol,
    required String interval,
    required int limit,
    required String aiBaseUrl,
    required String apiKey,
    required String strategyName,
    required String model,
    required String systemPrompt,
    required String analysisRules,
    required List<Candle> candles,
    CoinglassMarket? coinglass,
  }) async {
    if (apiKey.trim().isEmpty) {
      throw const DirectApiException('请先配置 AI API Key');
    }
    if (model.trim().isEmpty) {
      throw const DirectApiException('请先配置 AI 模型名称');
    }
    if (candles.isEmpty) {
      throw const DirectApiException('没有可供 AI 分析的 K 线数据');
    }

    final baseCoin = symbol.replaceFirst('USDT', '').toUpperCase();
    final market = [
      {
        'symbol': symbol,
        'interval': interval,
        'klines': candles.take(limit).map((item) => item.toJson()).toList(),
        'volumeAnalysis': _volumeAnalysis(candles),
        if (coinglass != null) 'coinglassMarket': coinglass.toJson(),
      },
    ];
    final payload = {
      'model': model.trim(),
      'temperature': 0.2,
      'messages': [
        {
          'role': 'system',
          'content': 'Strategy: ${strategyName.trim()}\n'
              '${systemPrompt.trim()}\n'
              'Analyze the symbol independently. Use OHLCV klines, volumeAnalysis, and CoinGlass market intelligence (open interest, long/short ratio, liquidations, volume changes) to judge buy-worthiness and upside probability. '
              'Rising open interest with rising price suggests new long positions; falling OI with rising price suggests short covering. '
              'Long/short ratio > 1 means more longs; high liquidation indicates volatility. '
              'This is research only: never place orders. '
              'Return JSON only in the form '
              '{"analyses":[{"symbol":"$symbol","action":"BUY|SELL|HOLD",'
              '"positionRecommendation":"OPEN_LONG|OPEN_SHORT|CLOSE_LONG|CLOSE_SHORT|WAIT",'
              '"confidence":0,"reason":"...","risk":"...","suggestion":"..."}]}',
        },
        {
          'role': 'user',
          'content': jsonEncode({
            'strategy': strategyName.trim(),
            'objective':
                'Analyze $baseCoin USDT perpetual contract using OHLCV data and CoinGlass market intelligence.',
            'rules': analysisRules,
            'market': market,
          }),
        },
      ],
    };

    final body = await _postJson(
      aiBaseUrl,
      '/chat/completions',
      payload,
      headers: {'Authorization': 'Bearer ${apiKey.trim()}'},
    );
    final data = _asMap(body, 'AI 接口返回格式无效');
    final content = _extractModelContent(data);
    final parsed = _parseJsonContent(content);
    final now = DateTime.now();
    final response = <String, dynamic>{
      'id': 'direct-analysis-${now.microsecondsSinceEpoch}',
      'type': 'single',
      'symbol': symbol,
      'interval': interval,
      'at': now.toIso8601String(),
      'analyses': parsed['analyses'] is List ? parsed['analyses'] : [],
      'error': parsed['error'] ?? '',
    };
    return AnalysisEnvelope.fromApiJson(response);
  }

  Map<String, dynamic> _volumeAnalysis(List<Candle> candles) {
    final volumes = candles.map((c) => c.quoteVolume ?? c.volume ?? 0).toList();
    if (volumes.length < 4) {
      return {'upProbability': 50, 'signal': 'insufficient_data'};
    }
    final recent = volumes.skip(volumes.length - 3).reduce((a, b) => a + b) / 3;
    final baseline = volumes.take(volumes.length - 3).reduce((a, b) => a + b) /
        (volumes.length - 3);
    final rising = candles.last.close >= candles.first.close;
    final ratio = baseline == 0 ? 1.0 : recent / baseline;
    var probability =
        50 + (rising ? 1 : -1) * ((ratio - 1) * 35).clamp(-30, 30);
    probability = probability.clamp(5, 95);
    return {
      'upProbability': probability.round(),
      'volumeRatio': double.parse(ratio.toStringAsFixed(2)),
      'signal': rising ? 'rising_with_volume' : 'falling_with_volume'
    };
  }

  Future<dynamic> _get(
    String baseUrl,
    String path, {
    Map<String, String>? query,
    Map<String, String>? headers,
  }) async {
    try {
      final uri = _uri(baseUrl, path, query);
      final req = http.Request('GET', uri);
      if (headers != null) req.headers.addAll(headers);
      final streamed =
          await _client.send(req).timeout(const Duration(seconds: 30));
      final response = await http.Response.fromStream(streamed);
      return _decode(response, '直连接口请求失败');
    } on DirectApiException {
      rethrow;
    } catch (error) {
      throw DirectApiException('直连接口无法访问：$error');
    }
  }

  Future<dynamic> _postJson(
    String baseUrl,
    String path,
    Map<String, dynamic> payload, {
    Map<String, String>? headers,
  }) async {
    try {
      final response = await _client
          .post(
            _uri(baseUrl, path),
            headers: {
              'Content-Type': 'application/json',
              ...?headers,
            },
            body: jsonEncode(payload),
          )
          .timeout(const Duration(seconds: 60));
      return _decode(response, 'AI 接口请求失败');
    } on DirectApiException {
      rethrow;
    } catch (error) {
      throw DirectApiException('AI 接口无法访问：$error');
    }
  }

  dynamic _decode(http.Response response, String fallbackMessage) {
    dynamic body;
    try {
      body = response.body.isEmpty
          ? <String, dynamic>{}
          : jsonDecode(response.body);
    } catch (_) {
      throw DirectApiException(
        '$fallbackMessage（返回了无效 JSON）',
        statusCode: response.statusCode,
      );
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final message = body is Map && body['error'] != null
          ? body['error'] is Map
              ? (body['error']['message'] ?? body['error']).toString()
              : body['error'].toString()
          : '$fallbackMessage（${response.statusCode}）';
      throw DirectApiException(message, statusCode: response.statusCode);
    }
    if (body is Map && body['retCode'] != null && body['retCode'] != 0) {
      throw DirectApiException(
        body['retMsg']?.toString() ?? fallbackMessage,
        statusCode: response.statusCode,
      );
    }
    return body;
  }

  static Uri _uri(String baseUrl, String path, [Map<String, String>? query]) {
    final normalized = baseUrl.trim().replaceFirst(RegExp(r'/+$'), '');
    return Uri.parse('$normalized$path').replace(queryParameters: query);
  }

  static Map<String, dynamic> _asMap(dynamic value, String message) {
    if (value is! Map) throw DirectApiException(message);
    return Map<String, dynamic>.from(value);
  }

  static String _extractModelContent(Map<String, dynamic> body) {
    final choices = body['choices'];
    if (choices is! List || choices.isEmpty || choices.first is! Map) {
      throw const DirectApiException('AI 接口没有返回 choices');
    }
    final message = (choices.first as Map)['message'];
    final content = message is Map ? message['content'] : null;
    if (content is String && content.trim().isNotEmpty) return content;
    if (content is List) {
      return content
          .whereType<Map>()
          .map((part) => part['text']?.toString() ?? '')
          .where((part) => part.isNotEmpty)
          .join();
    }
    throw const DirectApiException('AI 接口没有返回可解析的分析内容');
  }

  static Map<String, dynamic> _parseJsonContent(String content) {
    var text = content.trim();
    if (text.startsWith('```')) {
      text = text.replaceFirst(RegExp(r'^```(?:json)?\s*'), '');
      text = text.replaceFirst(RegExp(r'\s*```$'), '');
    }
    try {
      final decoded = jsonDecode(text);
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
    } catch (_) {
      final start = text.indexOf('{');
      final end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        final decoded = jsonDecode(text.substring(start, end + 1));
        if (decoded is Map) return Map<String, dynamic>.from(decoded);
      }
    }
    throw const DirectApiException('AI 返回内容不是有效 JSON');
  }

  static List<MarketSymbol> _dedupeSymbols(List<MarketSymbol> values) => [
        ...{for (final item in values) item.code: item}.values,
      ];

  static String _bybitInterval(String interval) => switch (interval) {
        '1m' => '1',
        '3m' => '3',
        '5m' => '5',
        '15m' => '15',
        '30m' => '30',
        '1h' => '60',
        '2h' => '120',
        '4h' => '240',
        '6h' => '360',
        '12h' => '720',
        '1d' => 'D',
        '1w' => 'W',
        '1M' => 'M',
        _ => '240',
      };

  static int _intervalMilliseconds(String interval) => switch (interval) {
        '1m' => 60 * 1000,
        '3m' => 3 * 60 * 1000,
        '5m' => 5 * 60 * 1000,
        '15m' => 15 * 60 * 1000,
        '30m' => 30 * 60 * 1000,
        '1h' => 60 * 60 * 1000,
        '2h' => 2 * 60 * 60 * 1000,
        '4h' => 4 * 60 * 60 * 1000,
        '6h' => 6 * 60 * 60 * 1000,
        '12h' => 12 * 60 * 60 * 1000,
        '1d' => 24 * 60 * 60 * 1000,
        '1w' => 7 * 24 * 60 * 60 * 1000,
        _ => 4 * 60 * 60 * 1000,
      };

  static double _toDouble(dynamic value) =>
      double.tryParse(value?.toString() ?? '') ?? 0;

  static int _toInt(dynamic value) =>
      int.tryParse(value?.toString() ?? '') ?? 0;

  void dispose() => _client.close();
}
