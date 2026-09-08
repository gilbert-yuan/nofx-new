from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class Database:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(str(self.path), check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._initialize()

    def _initialize(self) -> None:
        with self._lock, self._connection:
            self._connection.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS candles (
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
                );
                CREATE INDEX IF NOT EXISTS idx_candles_lookup
                    ON candles(symbol, interval, open_time DESC);
                CREATE TABLE IF NOT EXISTS analyses (
                    analysis_id TEXT PRIMARY KEY,
                    symbol TEXT NOT NULL,
                    interval TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_analyses_lookup
                    ON analyses(symbol, created_at DESC);
                CREATE TABLE IF NOT EXISTS symbols (
                    symbol TEXT PRIMARY KEY,
                    base_coin TEXT NOT NULL DEFAULT '',
                    quote_coin TEXT NOT NULL DEFAULT '',
                    rank INTEGER,
                    market_cap REAL,
                    payload TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS settings (
                    setting_key TEXT PRIMARY KEY,
                    setting_value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                """
            )

    @staticmethod
    def _now_ms() -> int:
        return int(datetime.now(tz=timezone.utc).timestamp() * 1000)

    def save_setting(self, key: str, value: Any) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO settings(setting_key, setting_value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(setting_key) DO UPDATE SET
                    setting_value=excluded.setting_value,
                    updated_at=excluded.updated_at
                """,
                (key, json.dumps(value, ensure_ascii=False), self._now_ms()),
            )

    def load_setting(self, key: str, default: Any = None) -> Any:
        with self._lock:
            row = self._connection.execute(
                "SELECT setting_value FROM settings WHERE setting_key = ?", (key,)
            ).fetchone()
        if not row:
            return default
        try:
            return json.loads(row["setting_value"])
        except json.JSONDecodeError:
            return default

    def save_symbols(self, rows: list[dict[str, Any]]) -> None:
        with self._lock, self._connection:
            for item in rows:
                symbol = str(item.get("symbol", "")).upper()
                if not symbol:
                    continue
                self._connection.execute(
                    """
                    INSERT INTO symbols(symbol, base_coin, quote_coin, rank, market_cap, payload, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(symbol) DO UPDATE SET
                        base_coin=excluded.base_coin,
                        quote_coin=excluded.quote_coin,
                        rank=excluded.rank,
                        market_cap=excluded.market_cap,
                        payload=excluded.payload,
                        updated_at=excluded.updated_at
                    """,
                    (
                        symbol,
                        str(item.get("baseCoin", "")),
                        str(item.get("quoteCoin", "")),
                        item.get("rank"),
                        item.get("marketCap"),
                        json.dumps(item, ensure_ascii=False),
                        self._now_ms(),
                    ),
                )

    def load_symbols(self, search: str = "", limit: int = 300) -> list[dict[str, Any]]:
        pattern = f"%{search.upper()}%"
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT payload FROM symbols
                WHERE symbol LIKE ? OR base_coin LIKE ?
                ORDER BY COALESCE(rank, 999999), symbol
                LIMIT ?
                """,
                (pattern, pattern, limit),
            ).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def save_candles(self, symbol: str, interval: str, rows: list[dict[str, Any]]) -> None:
        with self._lock, self._connection:
            for row in rows:
                self._connection.execute(
                    """
                    INSERT INTO candles(
                        symbol, interval, open_time, open, high, low, close,
                        volume, close_time, quote_volume, trade_count, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(symbol, interval, open_time) DO UPDATE SET
                        open=excluded.open, high=excluded.high, low=excluded.low,
                        close=excluded.close, volume=excluded.volume,
                        close_time=excluded.close_time, quote_volume=excluded.quote_volume,
                        trade_count=excluded.trade_count, updated_at=excluded.updated_at
                    """,
                    (
                        symbol,
                        interval,
                        int(row.get("openTime", row.get("open_time", 0))),
                        float(row.get("open", 0)),
                        float(row.get("high", 0)),
                        float(row.get("low", 0)),
                        float(row.get("close", 0)),
                        float(row.get("volume", 0)),
                        int(row.get("closeTime", row.get("close_time", 0))),
                        float(row.get("quoteVolume", row.get("quote_volume", 0))),
                        int(row.get("tradeCount", row.get("trade_count", 0))),
                        self._now_ms(),
                    ),
                )

    def load_candles(self, symbol: str, interval: str, limit: int = 80) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT open_time AS openTime, open, high, low, close, volume,
                       close_time AS closeTime, quote_volume AS quoteVolume,
                       trade_count AS tradeCount
                FROM candles
                WHERE symbol = ? AND interval = ?
                ORDER BY open_time DESC
                LIMIT ?
                """,
                (symbol, interval, limit),
            ).fetchall()
        return [dict(row) for row in reversed(rows)]

    def save_analysis(self, envelope: dict[str, Any]) -> None:
        analysis_id = str(envelope.get("id") or f"local-{self._now_ms()}")
        symbol = str(envelope.get("symbol") or "")
        interval = str(envelope.get("interval") or "")
        created_at = str(envelope.get("at") or datetime.now(tz=timezone.utc).isoformat())
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO analyses(analysis_id, symbol, interval, created_at, payload)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(analysis_id) DO UPDATE SET
                    symbol=excluded.symbol, interval=excluded.interval,
                    created_at=excluded.created_at, payload=excluded.payload
                """,
                (analysis_id, symbol, interval, created_at, json.dumps(envelope, ensure_ascii=False)),
            )

    def load_analyses(self, symbol: str = "", limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            if symbol:
                rows = self._connection.execute(
                    "SELECT payload FROM analyses WHERE symbol = ? ORDER BY created_at DESC LIMIT ?",
                    (symbol, limit),
                ).fetchall()
            else:
                rows = self._connection.execute(
                    "SELECT payload FROM analyses ORDER BY created_at DESC LIMIT ?", (limit,)
                ).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def close(self) -> None:
        with self._lock:
            self._connection.close()
