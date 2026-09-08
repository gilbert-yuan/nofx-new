import '../models.dart';

class DatabaseService {
  final Map<String, dynamic> _settings = {};
  final Map<String, List<Candle>> _klines = {};
  final List<MarketSymbol> _symbols = [];
  final List<AnalysisResult> _analyses = [];

  Future<void> initialize() async {}

  Future<void> saveSymbols(List<MarketSymbol> symbols) async {
    _symbols
      ..clear()
      ..addAll(symbols);
  }

  Future<List<MarketSymbol>> loadSymbols() async => [..._symbols];

  Future<void> saveKlines(
      {required String symbol,
      required String interval,
      required List<Candle> candles}) async {
    _klines['$symbol:$interval'] = [...candles];
  }

  Future<List<Candle>> loadKlines(
          {required String symbol,
          required String interval,
          required int limit}) async =>
      (_klines['$symbol:$interval'] ?? const <Candle>[]).takeLast(limit);

  Future<void> saveAnalysis(AnalysisEnvelope envelope) async =>
      _analyses.insertAll(0, envelope.analyses);

  Future<List<AnalysisResult>> loadAnalyses(
          {String? symbol, int limit = 100}) async =>
      _analyses
          .where((item) => symbol == null || item.symbol == symbol)
          .take(limit)
          .toList();

  Future<void> saveSetting(String key, dynamic value) async =>
      _settings[key] = value;

  Future<T?> loadSetting<T>(String key) async {
    final value = _settings[key];
    return value is T ? value : null;
  }

  Future<void> saveAppState({
    required String selectedSymbol,
    required AnalysisConfig config,
    required bool autoRefresh,
    required int refreshSeconds,
  }) async {
    _settings['selectedSymbol'] = selectedSymbol;
    _settings['analysisConfig'] = config.toJson();
    _settings['autoRefresh'] = autoRefresh;
    _settings['refreshSeconds'] = refreshSeconds;
  }

  Future<AppStateSnapshot> loadAppState() async {
    final configJson = _settings['analysisConfig'];
    return AppStateSnapshot(
      selectedSymbol: _settings['selectedSymbol'] as String?,
      config: configJson is Map
          ? AnalysisConfig.fromJson(Map<String, dynamic>.from(configJson))
          : null,
      autoRefresh: _settings['autoRefresh'] as bool?,
      refreshSeconds: (_settings['refreshSeconds'] as num?)?.toInt(),
    );
  }

  Future<void> clearAnalyses() async => _analyses.clear();

  Future<void> close() async {}
}

class AppStateSnapshot {
  const AppStateSnapshot(
      {this.selectedSymbol,
      this.config,
      this.autoRefresh,
      this.refreshSeconds});

  final String? selectedSymbol;
  final AnalysisConfig? config;
  final bool? autoRefresh;
  final int? refreshSeconds;
}

extension<T> on List<T> {
  List<T> takeLast(int count) =>
      length <= count ? [...this] : sublist(length - count);
}
