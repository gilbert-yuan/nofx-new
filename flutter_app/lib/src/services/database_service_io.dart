import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as path;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart' as mobile_sqlite;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../models.dart';

class DatabaseService {
  DatabaseService({DatabaseFactory? factory}) : _factory = factory;

  static const databaseName = 'nofx_research.sqlite';
  final DatabaseFactory? _factory;
  Database? _database;

  Future<Database> get database async {
    if (_database != null) return _database!;
    final factory = _factory ??
        (defaultTargetPlatform == TargetPlatform.android ||
                defaultTargetPlatform == TargetPlatform.iOS
            ? mobile_sqlite.databaseFactory
            : _desktopDatabaseFactory());
    final directory = await getApplicationSupportDirectory();
    final dbPath = path.join(directory.path, databaseName);
    _database = await factory.openDatabase(
      dbPath,
      options: OpenDatabaseOptions(
        version: 1,
        onCreate: (db, version) async => _createSchema(db),
        onUpgrade: (db, oldVersion, newVersion) async {
          if (oldVersion < 1) await _createSchema(db);
        },
      ),
    );
    return _database!;
  }

  Future<void> initialize() async {
    await database;
  }

  Future<void> saveSymbols(List<MarketSymbol> symbols) async {
    final db = await database;
    final batch = db.batch();
    for (final symbol in symbols) {
      batch.insert(
        'cache',
        {
          'cache_key': 'symbol:${symbol.code}',
          'cache_type': 'symbol',
          'payload': jsonEncode(symbol.toJson()),
          'updated_at': DateTime.now().millisecondsSinceEpoch,
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }
    await batch.commit(noResult: true);
  }

  Future<List<MarketSymbol>> loadSymbols() async {
    final db = await database;
    final rows = await db.query(
      'cache',
      where: 'cache_type = ?',
      whereArgs: ['symbol'],
      orderBy: 'updated_at DESC',
    );
    return rows
        .map((row) => MarketSymbol.fromJson(_decodePayload(row['payload'])))
        .toList();
  }

  Future<void> saveKlines({
    required String symbol,
    required String interval,
    required List<Candle> candles,
  }) async {
    final db = await database;
    final batch = db.batch();
    for (var index = 0; index < candles.length; index++) {
      final candle = candles[index];
      batch.insert(
        'klines',
        {
          'symbol': symbol,
          'interval': interval,
          'open_time': candle.openTime ?? index,
          'open': candle.open,
          'high': candle.high,
          'low': candle.low,
          'close': candle.close,
          'volume': candle.volume ?? 0,
          'close_time': candle.closeTime ?? 0,
          'quote_volume': candle.quoteVolume ?? 0,
          'trade_count': candle.tradeCount ?? 0,
          'updated_at': DateTime.now().millisecondsSinceEpoch,
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }
    await batch.commit(noResult: true);
  }

  Future<List<Candle>> loadKlines({
    required String symbol,
    required String interval,
    required int limit,
  }) async {
    final db = await database;
    final rows = await db.query(
      'klines',
      where: 'symbol = ? AND interval = ?',
      whereArgs: [symbol, interval],
      orderBy: 'open_time DESC',
      limit: limit,
    );
    return rows.reversed.map(Candle.fromJson).toList();
  }

  Future<void> saveAnalysis(AnalysisEnvelope envelope) async {
    final db = await database;
    await db.insert(
      'analyses',
      {
        'analysis_id': envelope.id,
        'symbol': envelope.symbol,
        'interval': envelope.interval,
        'type': envelope.type,
        'created_at': envelope.createdAt.millisecondsSinceEpoch,
        'payload': jsonEncode(envelope.toJson()),
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
    final result = envelope.primaryResult;
    if (result == null) return;
    await db.insert(
      'cache',
      {
        'cache_key': 'latest-analysis:${result.symbol}',
        'cache_type': 'latest-analysis',
        'payload': jsonEncode(result.toJson()),
        'updated_at': result.createdAt.millisecondsSinceEpoch,
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<List<AnalysisResult>> loadAnalyses(
      {String? symbol, int limit = 100}) async {
    final db = await database;
    final rows = await db.query(
      'analyses',
      where: symbol == null || symbol.isEmpty ? null : 'symbol = ?',
      whereArgs: symbol == null || symbol.isEmpty ? null : [symbol],
      orderBy: 'created_at DESC',
      limit: limit,
    );
    final results = <AnalysisResult>[];
    for (final row in rows) {
      results.addAll(
          AnalysisEnvelope.fromJson(_decodePayload(row['payload'])).analyses);
    }
    return results;
  }

  Future<void> saveSetting(String key, dynamic value) async {
    final db = await database;
    await db.insert(
      'settings',
      {
        'setting_key': key,
        'setting_value': jsonEncode(value),
        'updated_at': DateTime.now().millisecondsSinceEpoch,
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<T?> loadSetting<T>(String key) async {
    final db = await database;
    final rows = await db.query('settings',
        where: 'setting_key = ?', whereArgs: [key], limit: 1);
    if (rows.isEmpty) return null;
    final value = jsonDecode(rows.first['setting_value']! as String);
    return value is T ? value : null;
  }

  Future<void> saveAppState({
    required String selectedSymbol,
    required AnalysisConfig config,
    required bool autoRefresh,
    required int refreshSeconds,
  }) async {
    await Future.wait([
      saveSetting('selectedSymbol', selectedSymbol),
      saveSetting('analysisConfig', config.toJson()),
      saveSetting('autoRefresh', autoRefresh),
      saveSetting('refreshSeconds', refreshSeconds),
    ]);
  }

  Future<AppStateSnapshot> loadAppState() async {
    final configJson = await loadSetting<Map>('analysisConfig');
    final refreshSeconds = await loadSetting<num>('refreshSeconds');
    return AppStateSnapshot(
      selectedSymbol: await loadSetting<String>('selectedSymbol'),
      config: configJson == null
          ? null
          : AnalysisConfig.fromJson(Map<String, dynamic>.from(configJson)),
      autoRefresh: await loadSetting<bool>('autoRefresh'),
      refreshSeconds: refreshSeconds?.toInt(),
    );
  }

  Future<void> clearAnalyses() async {
    final db = await database;
    await db.delete('analyses');
    await db.delete('cache',
        where: 'cache_type = ?', whereArgs: ['latest-analysis']);
  }

  Future<void> close() async {
    final db = _database;
    _database = null;
    await db?.close();
  }

  Future<void> _createSchema(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS klines (
        symbol TEXT NOT NULL,
        interval TEXT NOT NULL,
        open_time INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL DEFAULT 0,
        close_time INTEGER NOT NULL DEFAULT 0,
        quote_volume REAL NOT NULL DEFAULT 0,
        trade_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (symbol, interval, open_time)
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS analyses (
        analysis_id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        interval TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS cache (
        cache_key TEXT PRIMARY KEY,
        cache_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    ''');
    await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_klines_lookup ON klines(symbol, interval, open_time)');
    await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_analyses_lookup ON analyses(symbol, created_at)');
  }

  static DatabaseFactory _desktopDatabaseFactory() {
    sqfliteFfiInit();
    return databaseFactoryFfi;
  }

  static Map<String, dynamic> _decodePayload(Object? value) =>
      Map<String, dynamic>.from(jsonDecode(value! as String) as Map);
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
