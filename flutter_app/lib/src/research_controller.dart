import 'dart:async';

import 'package:flutter/foundation.dart';

import 'models.dart';
import 'services/database_service.dart';
import 'services/direct_api_client.dart';
import 'services/window_service.dart';

class ResearchController extends ChangeNotifier {
  ResearchController({
    DatabaseService? databaseService,
    WindowService? windowService,
  })  : database = databaseService ?? DatabaseService(),
        window = windowService ?? WindowService(),
        directApi = DirectApiClient();

  final DatabaseService database;
  final WindowService window;
  final DirectApiClient directApi;
  final List<MarketSymbol> marketSymbols = [];
  final Map<String, List<Candle>> _candleCache = {};
  Timer? _refreshTimer;

  String selectedSymbol = 'BTCUSDT';
  AnalysisConfig config = const AnalysisConfig();
  bool isAnalysing = false;
  String status = '正在初始化本地数据库';
  int analysisTotal = 0;
  int analysisCompleted = 0;
  int analysisFailures = 0;
  String? lastError;
  bool isFetchingCandles = false;
  String candleStatus = '等待获取 K 线';
  bool isFetchingAllKlines = false;
  int allKlineTotal = 0;
  int allKlineCompleted = 0;
  int allKlineFailures = 0;
  String allKlineStatus = '等待拉取全部币种 K 线';
  bool isFetchingSymbols = false;
  int symbolFetchTotal = 0;
  int symbolFetchCompleted = 0;
  String symbolFetchStatus = '等待获取币种';
  String strategyName = 'K 线趋势分析策略';
  String modelName = 'gpt-4o-mini';
  bool aiEnabled = true;
  String marketApiBaseUrl = DirectApiClient.defaultMarketBaseUrl;
  String aiApiBaseUrl = DirectApiClient.defaultAiBaseUrl;
  String apiKey = '';
  String coinglassApiBaseUrl = DirectApiClient.defaultCoinglassBaseUrl;
  String coinglassApiKey = '';
  bool coinglassEnabled = false;
  Map<String, CoinglassMarket> coinglassMarkets = {};
  String coinglassStatus = '等待获取 Coinglass 行情';
  String settingsStatus = '配置会保存到本地 SQLite';
  bool windowAlwaysOnTop = false;
  bool windowCompact = false;
  double windowOpacity = 1;
  bool localAnalysisEnabled = true;
  double riskThreshold = 0.62;
  bool conservativeMode = true;
  bool showOnlyActionable = false;
  String systemPrompt = '分析每个合约的 OHLCV K 线；这是研究建议，不执行订单。';
  String analysisRules = '证据不足时优先观望，返回理由、风险和执行建议。';
  bool autoRefresh = false;
  int refreshSeconds = 60;
  bool isReady = false;
  bool isOnline = false;
  String? databasePathHint;
  List<AnalysisResult> results = [];
  List<AnalysisResult> history = [];

  MarketSymbol get selectedMarket {
    if (marketSymbols.isEmpty) return symbols.first;
    return marketSymbols.firstWhere(
      (symbol) => symbol.code == selectedSymbol,
      orElse: () => marketSymbols.first,
    );
  }

  List<Candle> get candles =>
      _candleCache[_cacheKey(selectedSymbol)] ?? const [];

  List<AnalysisResult> get selectedHistory =>
      history.where((item) => item.symbol == selectedSymbol).toList()
        ..sort((a, b) => b.createdAt.compareTo(a.createdAt));

  AnalysisResult? get latestAnalysis =>
      selectedHistory.isEmpty ? null : selectedHistory.first;

  double get analysisProgress =>
      analysisTotal == 0 ? 0 : analysisCompleted / analysisTotal;

  double get symbolFetchProgress =>
      symbolFetchTotal == 0 ? 0 : symbolFetchCompleted / symbolFetchTotal;

  double get allKlineProgress =>
      allKlineTotal == 0 ? 0 : allKlineCompleted / allKlineTotal;

  Future<void> initialize() async {
    if (isReady) return;
    try {
      try {
        await window.initialize();
      } catch (error) {
        lastError = '窗口初始化失败，继续使用普通窗口：$error';
      }
      await database.initialize();
      final savedState = await database.loadAppState();
      if (savedState.config != null) config = savedState.config!;
      if (savedState.selectedSymbol != null &&
          savedState.selectedSymbol!.isNotEmpty) {
        selectedSymbol = savedState.selectedSymbol!;
      }
      autoRefresh = savedState.autoRefresh ?? false;
      refreshSeconds = savedState.refreshSeconds ?? 60;
      marketApiBaseUrl =
          await database.loadSetting<String>('marketApiBaseUrl') ??
              marketApiBaseUrl;
      aiApiBaseUrl =
          await database.loadSetting<String>('aiApiBaseUrl') ?? aiApiBaseUrl;
      apiKey = await database.loadSetting<String>('apiKey') ?? apiKey;
      aiEnabled = await database.loadSetting<bool>('aiEnabled') ?? aiEnabled;
      strategyName =
          await database.loadSetting<String>('strategyName') ?? strategyName;
      modelName = await database.loadSetting<String>('modelName') ?? modelName;
      systemPrompt =
          await database.loadSetting<String>('systemPrompt') ?? systemPrompt;
      analysisRules =
          await database.loadSetting<String>('analysisRules') ?? analysisRules;
      coinglassApiKey = await database.loadSetting<String>('coinglassApiKey') ??
          coinglassApiKey;
      coinglassApiBaseUrl =
          await database.loadSetting<String>('coinglassApiBaseUrl') ??
              coinglassApiBaseUrl;
      coinglassEnabled = await database.loadSetting<bool>('coinglassEnabled') ??
          coinglassEnabled;
      windowAlwaysOnTop =
          await database.loadSetting<bool>('windowAlwaysOnTop') ?? false;
      windowCompact =
          await database.loadSetting<bool>('windowCompact') ?? false;
      windowOpacity = (await database.loadSetting<num>('windowOpacity') ?? 1)
          .clamp(.3, 1.0)
          .toDouble();
      try {
        await window.setAlwaysOnTop(windowAlwaysOnTop);
        await window.setCompactMode(windowCompact);
        await window.setOpacity(windowOpacity);
      } catch (error) {
        lastError = '窗口状态恢复失败：$error';
      }
      history = await database.loadAnalyses(limit: 200);
      results = _latestResults(history);
      final cachedSymbols = await database.loadSymbols();
      if (cachedSymbols.isNotEmpty) {
        marketSymbols.addAll(_dedupeSymbols(cachedSymbols));
      }
      if (marketSymbols.isEmpty) marketSymbols.addAll(symbols);
      final cachedCandles = await database.loadKlines(
        symbol: selectedSymbol,
        interval: config.interval,
        limit: config.klineCount,
      );
      if (cachedCandles.isNotEmpty) {
        _candleCache[_cacheKey(selectedSymbol)] = cachedCandles;
      }
      isReady = true;
      status = '已恢复本地缓存 · ${marketSymbols.length} 个币种 · ${history.length} 条分析';
      candleStatus = cachedCandles.isEmpty
          ? '暂无本地 K 线缓存'
          : '已恢复本地 K 线 · ${cachedCandles.length} 根';
      _configureRefreshTimer();
      notifyListeners();
      await fetchDirectSymbols(showProgress: false);
      if (coinglassEnabled && coinglassApiKey.isNotEmpty) {
        await fetchCoinglassMarkets();
      }
      if (candles.isEmpty) await fetchCandles();
    } catch (error) {
      isReady = true;
      if (marketSymbols.isEmpty) marketSymbols.addAll(symbols);
      lastError = '初始化失败，已使用内置目录和本地缓存：$error';
      status = '本地缓存模式 · 直连接口不可用';
      notifyListeners();
    }
  }

  void selectSymbol(String symbol) {
    selectedSymbol = symbol;
    candleStatus = '已切换到 $symbol';
    unawaited(_saveState());
    notifyListeners();
  }

  Future<bool> addSymbol(String rawCode) async {
    final code =
        rawCode.trim().toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');
    if (code.isEmpty) {
      status = '请输入币种代码';
      notifyListeners();
      return false;
    }
    final normalized = code.endsWith('USDT') ? code : '${code}USDT';
    final existingSymbols = List<MarketSymbol>.from(marketSymbols);
    final previousSelected = selectedSymbol;
    await fetchDirectSymbols(search: normalized, showProgress: false);
    final fetchedMatches =
        marketSymbols.where((item) => item.code == normalized).toList();

    marketSymbols
      ..clear()
      ..addAll(_dedupeSymbols([...existingSymbols, ...fetchedMatches]));
    selectedSymbol = previousSelected;

    if (marketSymbols.every((item) => item.code != normalized)) {
      status = '$normalized 未在交易所合约目录中找到';
      notifyListeners();
      return false;
    }
    if (existingSymbols.every((item) => item.code != normalized)) {
      await database.saveSymbols(marketSymbols);
    }
    selectSymbol(normalized);
    await fetchCandles(normalized);
    return true;
  }

  Future<void> fetchAllSymbols() => fetchDirectSymbols();

  CoinglassMarket? coinglassFor(String symbol) {
    final baseCoin = symbol.replaceFirst('USDT', '').toUpperCase();
    return coinglassMarkets[baseCoin];
  }

  Future<void> fetchCoinglassMarkets() async {
    if (!coinglassEnabled || coinglassApiKey.trim().isEmpty) {
      coinglassStatus = 'Coinglass 未启用或未配置 Key';
      notifyListeners();
      return;
    }
    coinglassStatus = '正在获取 Coinglass 合约行情';
    status = coinglassStatus;
    notifyListeners();
    try {
      final fetched = await directApi.fetchCoinglassMarkets(
        apiKey: coinglassApiKey,
        baseUrl: coinglassApiBaseUrl,
      );
      coinglassMarkets = fetched;
      coinglassStatus = 'Coinglass · ${fetched.length} 个币种行情';
      status = coinglassStatus;
      _updateMarketSymbolsFromCoinglass();
    } catch (error) {
      coinglassStatus = 'Coinglass 行情获取失败：$error';
      lastError = coinglassStatus;
      status = 'Coinglass 离线 · 使用 K 线数据分析';
    } finally {
      notifyListeners();
    }
  }

  void _updateMarketSymbolsFromCoinglass() {
    for (var i = 0; i < marketSymbols.length; i++) {
      final cg = coinglassFor(marketSymbols[i].code);
      if (cg != null) {
        marketSymbols[i] = marketSymbols[i].copyWith(
          price: cg.price > 0 ? cg.price : marketSymbols[i].price,
          change: cg.priceChangePercent24h != 0
              ? cg.priceChangePercent24h
              : marketSymbols[i].change,
        );
      }
    }
  }

  Future<void> fetchDirectSymbols({
    String search = '',
    bool showProgress = true,
  }) async {
    if (isFetchingSymbols || isFetchingAllKlines) return;
    isFetchingSymbols = true;
    if (showProgress) {
      symbolFetchStatus = '正在从交易所获取合约目录';
      status = symbolFetchStatus;
      notifyListeners();
    }
    try {
      final fetched = await directApi.fetchSymbols(
        search: search,
        limit: config.maxSymbols.clamp(1, 300).toInt(),
        baseUrl: marketApiBaseUrl,
      );
      if (fetched.isNotEmpty) {
        marketSymbols
          ..clear()
          ..addAll(_dedupeSymbols(fetched));
        if (!marketSymbols.any((item) => item.code == selectedSymbol)) {
          selectedSymbol = marketSymbols.first.code;
        }
        await database.saveSymbols(marketSymbols);
        isOnline = true;
        symbolFetchTotal = marketSymbols.length;
        symbolFetchCompleted = symbolFetchTotal;
        symbolFetchStatus = '已获取 ${marketSymbols.length} 个合约';
        status = '交易所直连 · ${marketSymbols.length} 个合约';
      }
    } catch (error) {
      isOnline = false;
      lastError = '合约目录请求失败，继续使用本地缓存：$error';
      if (marketSymbols.isEmpty) marketSymbols.addAll(symbols);
      symbolFetchStatus = '使用本地合约目录';
      status = '交易所离线 · 本地缓存可用';
    } finally {
      isFetchingSymbols = false;
      notifyListeners();
    }
  }

  Future<void> fetchCandles([String? symbol]) async {
    final target = symbol ?? selectedSymbol;
    // 批量分析期间也允许为下一个币种补拉 K 线；调用方按顺序执行，避免重复请求。
    if (isFetchingCandles || isFetchingAllKlines) return;
    isFetchingCandles = true;
    candleStatus = '正在从交易所获取 $target K 线';
    lastError = null;
    notifyListeners();
    try {
      final response = await directApi.fetchKlines(
        symbol: target,
        interval: config.interval,
        limit: config.klineCount,
        baseUrl: marketApiBaseUrl,
      );
      _candleCache[_cacheKey(target)] = response.candles;
      await database.saveKlines(
        symbol: target,
        interval: config.interval,
        candles: response.candles,
      );
      _updateMarketFromCandles(target, response.candles);
      isOnline = true;
      candleStatus = '$target K 线已更新 · ${response.candles.length} 根 · 交易所直连';
      status = '已同步 $target ${config.interval} K 线';
    } catch (error) {
      final local = await database.loadKlines(
        symbol: target,
        interval: config.interval,
        limit: config.klineCount,
      );
      if (local.isNotEmpty) {
        _candleCache[_cacheKey(target)] = local;
        candleStatus = '$target 使用本地 K 线缓存 · ${local.length} 根';
        status = '交易所离线 · 已恢复 $target 本地 K 线';
      } else {
        _candleCache.remove(_cacheKey(target));
        candleStatus = '$target 交易所和本地缓存均不可用';
        status = '没有真实 K 线数据，无法分析';
      }
      lastError = 'K 线请求失败：$error';
      isOnline = false;
    } finally {
      isFetchingCandles = false;
      notifyListeners();
    }
  }

  Future<void> fetchCurrentKline([String? symbol]) => fetchCandles(symbol);

  Future<void> fetchLatestKlines() async {
    if (isFetchingAllKlines ||
        isFetchingCandles ||
        isFetchingSymbols ||
        isAnalysing) {
      return;
    }
    isFetchingAllKlines = true;
    allKlineTotal = 0;
    allKlineCompleted = 0;
    allKlineFailures = 0;
    allKlineStatus = '正在获取全部交易所合约目录';
    status = allKlineStatus;
    lastError = null;
    notifyListeners();

    try {
      final fetchedSymbols = await directApi.fetchSymbols(
        limit: 1000,
        baseUrl: marketApiBaseUrl,
      );
      if (fetchedSymbols.isEmpty) {
        throw const DirectApiException('交易所没有返回可用合约');
      }
      marketSymbols
        ..clear()
        ..addAll(_dedupeSymbols(fetchedSymbols));
      await database.saveSymbols(marketSymbols);
      if (!marketSymbols.any((item) => item.code == selectedSymbol)) {
        selectedSymbol = marketSymbols.first.code;
      }

      final targets = _scopeSymbols(all: true);
      allKlineTotal = targets.length;
      allKlineStatus = '正在拉取全部 ${targets.length} 个币种的 ${config.interval} K 线';
      status = allKlineStatus;
      notifyListeners();

      const batchSize = 8;
      for (var offset = 0; offset < targets.length; offset += batchSize) {
        final batch = targets.skip(offset).take(batchSize).toList();
        final outcomes = await Future.wait(batch.map((symbol) async {
          try {
            final response = await directApi.fetchKlines(
              symbol: symbol,
              interval: config.interval,
              limit: config.klineCount,
              baseUrl: marketApiBaseUrl,
            );
            await database.saveKlines(
              symbol: symbol,
              interval: config.interval,
              candles: response.candles,
            );
            if (symbol == selectedSymbol) {
              _candleCache[_cacheKey(symbol)] = response.candles;
            }
            _updateMarketFromCandles(symbol, response.candles);
            return null;
          } catch (error) {
            return error;
          }
        }));
        allKlineFailures += outcomes.whereType<Object>().length;
        allKlineCompleted += batch.length;
        allKlineStatus =
            '已拉取 $allKlineCompleted/$allKlineTotal 个币种 · 失败 $allKlineFailures';
        status = allKlineStatus;
        notifyListeners();
      }

      isOnline = allKlineFailures < allKlineTotal;
      candleStatus = allKlineFailures == 0
          ? '全部 $allKlineTotal 个币种 K 线已更新 · 交易所直连'
          : '全部 K 线完成，$allKlineFailures 个币种请求失败';
      status = candleStatus;
      if (allKlineFailures > 0) {
        lastError = '$allKlineFailures 个币种 K 线请求失败，可再次拉取重试';
      }
    } catch (error) {
      lastError = '全部 K 线请求失败：$error';
      allKlineStatus = '全部币种 K 线拉取失败';
      status = allKlineStatus;
      isOnline = false;
    } finally {
      isFetchingAllKlines = false;
      notifyListeners();
    }
  }

  Future<void> updateConfig(AnalysisConfig next) async {
    config = next;
    _candleCache.clear();
    candleStatus = '分析范围已更新，等待获取 API K 线';
    await _saveState();
    notifyListeners();
  }

  Future<void> analyseCurrent() => _analyseCurrentFromApi();

  Future<void> analyseRange() async {
    await _analyseSymbols(_scopeSymbols());
  }

  Future<void> analyseAll() async {
    await _analyseSymbols(_scopeSymbols(all: true));
  }

  Future<void> analyseMarket() => analyseCurrent();

  List<String> _scopeSymbols({bool all = false}) {
    final custom = config.customSymbols
        .split(RegExp(r'[,\\s]+'))
        .map((s) => s.trim().toUpperCase())
        .where((s) => s.isNotEmpty)
        .map((s) => s.endsWith('USDT') ? s : '${s}USDT')
        .toList();
    if (!all && custom.isNotEmpty) return custom.toSet().toList();
    final list = marketSymbols.map((s) => s.code).toList();
    return (all ? list : list.take(config.maxSymbols)).toList();
  }

  Future<void> _analyseSymbols(List<String> targets) async {
    if (isAnalysing || targets.isEmpty) return;
    isAnalysing = true;
    analysisTotal = targets.length;
    analysisCompleted = 0;
    analysisFailures = 0;
    notifyListeners();
    for (final symbol in targets) {
      try {
        if ((_candleCache[_cacheKey(symbol)] ?? []).isEmpty) {
          await fetchCandles(symbol);
        }
        final envelope = await directApi.analyzeSingle(
            symbol: symbol,
            interval: config.interval,
            limit: config.klineCount,
            aiBaseUrl: aiApiBaseUrl,
            apiKey: apiKey,
            strategyName: strategyName,
            model: modelName,
            systemPrompt: systemPrompt,
            analysisRules: analysisRules,
            candles: _candleCache[_cacheKey(symbol)] ?? const [],
            coinglass: coinglassFor(symbol));
        await database.saveAnalysis(envelope);
        history = [...envelope.analyses, ...history];
      } catch (_) {
        analysisFailures++;
      }
      analysisCompleted++;
      status = '已分析 $analysisCompleted/${targets.length}';
      notifyListeners();
    }
    results = _latestResults(history);
    isAnalysing = false;
    notifyListeners();
  }

  Future<void> _analyseCurrentFromApi() async {
    if (isAnalysing || !localAnalysisEnabled) return;
    if (candles.isEmpty) await fetchCandles();
    isAnalysing = true;
    analysisTotal = 1;
    analysisCompleted = 0;
    analysisFailures = 0;
    lastError = null;
    status = '正在直连 AI 分析 $selectedSymbol';
    notifyListeners();
    try {
      final envelope = await directApi.analyzeSingle(
        symbol: selectedSymbol,
        interval: config.interval,
        limit: config.klineCount,
        aiBaseUrl: aiApiBaseUrl,
        apiKey: apiKey,
        strategyName: strategyName,
        model: modelName,
        systemPrompt: systemPrompt,
        analysisRules: analysisRules,
        candles: candles,
        coinglass: coinglassFor(selectedSymbol),
      );
      await database.saveAnalysis(envelope);
      if (envelope.analyses.isNotEmpty) {
        final generated = envelope.analyses;
        history = [...generated, ...history]
          ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
        results = _latestResults([...generated, ...results]);
        status = '已完成 $selectedSymbol AI 分析';
      } else {
        status = envelope.error.isEmpty ? 'AI 未返回分析结果' : envelope.error;
        lastError =
            envelope.error.isEmpty ? 'AI 分析没有返回 analyses' : envelope.error;
      }
      isOnline = true;
    } catch (error) {
      analysisFailures = 1;
      lastError = 'AI 分析请求失败：$error';
      status = 'AI 分析失败，保留历史缓存';
      isOnline = false;
    } finally {
      analysisCompleted = 1;
      isAnalysing = false;
      notifyListeners();
    }
  }

  void setStrategyName(String value) {
    strategyName = value;
    notifyListeners();
  }

  void setModelName(String value) {
    modelName = value;
    notifyListeners();
  }

  void setAiEnabled(bool value) {
    aiEnabled = value;
    notifyListeners();
  }

  void setMarketApiBaseUrl(String value) {
    marketApiBaseUrl = value.trim().isEmpty
        ? DirectApiClient.defaultMarketBaseUrl
        : value.trim();
    unawaited(database.saveSetting('marketApiBaseUrl', marketApiBaseUrl));
    notifyListeners();
  }

  void setAiApiBaseUrl(String value) {
    aiApiBaseUrl =
        value.trim().isEmpty ? DirectApiClient.defaultAiBaseUrl : value.trim();
    unawaited(database.saveSetting('aiApiBaseUrl', aiApiBaseUrl));
    notifyListeners();
  }

  void setApiKey(String value) {
    apiKey = value;
    notifyListeners();
  }

  void setCoinglassApiKey(String value) {
    coinglassApiKey = value;
    notifyListeners();
  }

  void setCoinglassApiBaseUrl(String value) {
    coinglassApiBaseUrl = value.trim().isEmpty
        ? DirectApiClient.defaultCoinglassBaseUrl
        : value.trim();
    unawaited(database.saveSetting('coinglassApiBaseUrl', coinglassApiBaseUrl));
    notifyListeners();
  }

  void setCoinglassEnabled(bool value) {
    coinglassEnabled = value;
    unawaited(database.saveSetting('coinglassEnabled', value));
    if (value && coinglassApiKey.isNotEmpty) {
      unawaited(fetchCoinglassMarkets());
    }
    notifyListeners();
  }

  void setLocalAnalysisEnabled(bool value) {
    localAnalysisEnabled = value;
    notifyListeners();
  }

  void setSystemPrompt(String value) {
    systemPrompt = value;
    notifyListeners();
  }

  void setAnalysisRules(String value) {
    analysisRules = value;
    notifyListeners();
  }

  Future<void> saveAiSettings() async {
    settingsStatus = '直连配置已保存到本地 SQLite';
    status = settingsStatus;
    await Future.wait([
      database.saveSetting('marketApiBaseUrl', marketApiBaseUrl),
      database.saveSetting('aiApiBaseUrl', aiApiBaseUrl),
      database.saveSetting('apiKey', apiKey),
      database.saveSetting('aiEnabled', aiEnabled),
      database.saveSetting('strategyName', strategyName),
      database.saveSetting('modelName', modelName),
      database.saveSetting('systemPrompt', systemPrompt),
      database.saveSetting('analysisRules', analysisRules),
      database.saveSetting('coinglassApiKey', coinglassApiKey),
      database.saveSetting('coinglassApiBaseUrl', coinglassApiBaseUrl),
      database.saveSetting('coinglassEnabled', coinglassEnabled),
      _saveState(),
    ]);
    if (coinglassEnabled && coinglassApiKey.isNotEmpty) {
      unawaited(fetchCoinglassMarkets());
    }
    notifyListeners();
  }

  void setRiskThreshold(double value) {
    riskThreshold = value;
    notifyListeners();
  }

  void setConservativeMode(bool value) {
    conservativeMode = value;
    notifyListeners();
  }

  void setShowOnlyActionable(bool value) {
    showOnlyActionable = value;
    notifyListeners();
  }

  Future<void> setAutoRefresh(bool value) async {
    autoRefresh = value;
    _configureRefreshTimer();
    await _saveState();
    notifyListeners();
  }

  Future<void> setRefreshSeconds(int value) async {
    refreshSeconds = value.clamp(15, 3600).toInt();
    _configureRefreshTimer();
    await _saveState();
    notifyListeners();
  }

  Future<void> setWindowAlwaysOnTop(bool value) async {
    windowAlwaysOnTop = value;
    await window.setAlwaysOnTop(value);
    await database.saveSetting('windowAlwaysOnTop', value);
    notifyListeners();
  }

  Future<void> setWindowCompact(bool value) async {
    windowCompact = value;
    await window.setCompactMode(value);
    await database.saveSetting('windowCompact', value);
    notifyListeners();
  }

  Future<void> setWindowOpacity(double value) async {
    windowOpacity = value.clamp(.3, 1.0).toDouble();
    await window.setOpacity(windowOpacity);
    await database.saveSetting('windowOpacity', windowOpacity);
    notifyListeners();
  }

  Future<void> clearHistory() async {
    history = [];
    results = [];
    await database.clearAnalyses();
    notifyListeners();
  }

  Future<void> _saveState() => database.saveAppState(
        selectedSymbol: selectedSymbol,
        config: config,
        autoRefresh: autoRefresh,
        refreshSeconds: refreshSeconds,
      );

  void _configureRefreshTimer() {
    _refreshTimer?.cancel();
    if (!autoRefresh) return;
    _refreshTimer = Timer.periodic(Duration(seconds: refreshSeconds), (_) {
      if (!isFetchingCandles && !isFetchingAllKlines && !isAnalysing) {
        fetchCandles();
        if (coinglassEnabled && coinglassApiKey.isNotEmpty) {
          unawaited(fetchCoinglassMarkets());
        }
      }
    });
  }

  void _updateMarketFromCandles(String target, List<Candle> rows) {
    if (rows.isEmpty) return;
    final market = _marketFor(target);
    final first = rows.first.close;
    final last = rows.last.close;
    final change = first == 0 ? market.change : (last - first) / first * 100;
    final updated = market.copyWith(price: last, change: change);
    final index = marketSymbols.indexWhere((item) => item.code == target);
    if (index >= 0) marketSymbols[index] = updated;
  }

  MarketSymbol _marketFor(String target) {
    return marketSymbols.firstWhere(
      (item) => item.code == target,
      orElse: () => MarketSymbol(
        code: target,
        baseCoin: target.endsWith('USDT')
            ? target.substring(0, target.length - 4)
            : target,
        rank: marketSymbols.length + 1,
        price: _seedForSymbol(target),
        change: 0,
        marketCap: '未知',
      ),
    );
  }

  String _cacheKey(String symbol) =>
      '$symbol:${config.interval}:${config.klineCount}';

  List<MarketSymbol> _dedupeSymbols(List<MarketSymbol> values) {
    return [
      ...{for (final item in values) item.code: item}.values
    ];
  }

  List<AnalysisResult> _latestResults(List<AnalysisResult> values) {
    final latest = <String, AnalysisResult>{};
    for (final item in values) {
      final previous = latest[item.symbol];
      if (previous == null || item.createdAt.isAfter(previous.createdAt)) {
        latest[item.symbol] = item;
      }
    }
    return latest.values.toList()
      ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
  }

  int _hash(String value) =>
      value.codeUnits.fold<int>(0, (total, unit) => total * 31 + unit).abs();

  double _seedForSymbol(String symbol) => 0.25 + (_hash(symbol) % 120000) / 100;

  @override
  void dispose() {
    _refreshTimer?.cancel();
    window.dispose();
    directApi.dispose();
    unawaited(database.close());
    super.dispose();
  }
}
