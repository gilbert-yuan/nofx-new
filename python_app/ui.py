from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Callable

from PySide6.QtCore import QPoint, Qt, QThread, QTimer, Signal
from PySide6.QtGui import QColor, QFont
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QFormLayout,
    QFrame,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSlider,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from api import ApiClient, ApiError
from chart import CandleChart
from config import (
    APP_NAME,
    DB_PATH,
    DEFAULT_API_BASE,
    DEFAULT_INTERVAL,
    DEFAULT_LIMIT,
    DEFAULT_REFRESH_SECONDS,
    DEFAULT_SYMBOL,
)
from db import Database
from workers import ApiWorker


class DragBar(QFrame):
    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self._drag_offset: QPoint | None = None

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            self._drag_offset = event.globalPosition().toPoint() - self.window().frameGeometry().topLeft()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if self._drag_offset is not None and event.buttons() & Qt.MouseButton.LeftButton:
            self.window().move(event.globalPosition().toPoint() - self._drag_offset)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        self._drag_offset = None
        super().mouseReleaseEvent(event)


class MainWindow(QMainWindow):
    notify = Signal(str, str)

    def __init__(self) -> None:
        super().__init__()
        self.api_base = DEFAULT_API_BASE
        self.api = ApiClient(self.api_base)
        self.db = Database(DB_PATH)
        self._jobs: dict[str, tuple[QThread, ApiWorker]] = {}
        self._drag_position: QPoint | None = None
        self._base_opacity = 1.0
        self._fade_enabled = True
        self._pointer_inside = True
        self._compact = False
        self._symbols: list[dict[str, Any]] = []
        self._history: list[dict[str, Any]] = []
        self._shutting_down = False
        self._build_ui()
        self._restore_settings()
        self._connect_signals()
        self._load_cached_data()
        self._restore_window_state()
        self._configure_timer()
        QTimer.singleShot(100, self.load_symbols)
        QTimer.singleShot(250, self.refresh_market)

    def _build_ui(self) -> None:
        self.setWindowTitle(APP_NAME)
        self.setMinimumSize(900, 620)
        self.resize(1220, 780)
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.Window
            | Qt.WindowType.WindowSystemMenuHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose)
        self.setMouseTracking(True)

        root = QWidget()
        root.setObjectName("root")
        self.setCentralWidget(root)
        layout = QVBoxLayout(root)
        layout.setContentsMargins(14, 12, 14, 14)
        layout.setSpacing(10)

        header = DragBar()
        header.setObjectName("header")
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(14, 8, 8, 8)
        self.title_label = QLabel("NOFX 盯盘研究工作台")
        self.title_label.setObjectName("title")
        self.api_status = QLabel("API 检查中…")
        self.api_status.setObjectName("muted")
        header_layout.addWidget(self.title_label)
        header_layout.addWidget(self.api_status)
        header_layout.addStretch(1)
        self.pin_button = QPushButton("置顶")
        self.compact_button = QPushButton("紧凑")
        self.minimize_button = QPushButton("—")
        self.close_button = QPushButton("×")
        for button in (self.pin_button, self.compact_button, self.minimize_button, self.close_button):
            button.setObjectName("windowButton")
            button.setFixedHeight(30)
        self.close_button.setObjectName("closeButton")
        header_layout.addWidget(self.pin_button)
        header_layout.addWidget(self.compact_button)
        header_layout.addWidget(self.minimize_button)
        header_layout.addWidget(self.close_button)
        layout.addWidget(header)

        controls = QFrame()
        controls.setObjectName("controls")
        controls_layout = QGridLayout(controls)
        controls_layout.setContentsMargins(12, 10, 12, 10)
        controls_layout.setHorizontalSpacing(10)
        controls_layout.setVerticalSpacing(8)
        self.symbol_combo = QComboBox()
        self.symbol_combo.setEditable(True)
        self.symbol_combo.setMinimumWidth(155)
        self.interval_combo = QComboBox()
        self.interval_combo.addItems(["1m", "5m", "15m", "1h", "4h", "1d"])
        self.limit_spin = QSpinBox()
        self.limit_spin.setRange(20, 200)
        self.limit_spin.setSingleStep(10)
        self.refresh_seconds_spin = QSpinBox()
        self.refresh_seconds_spin.setRange(15, 3600)
        self.refresh_seconds_spin.setSuffix(" 秒")
        self.refresh_button = QPushButton("刷新 K线")
        self.analyze_button = QPushButton("AI 分析")
        self.auto_refresh_check = QCheckBox("自动刷新")
        self.fade_check = QCheckBox("鼠标移出降低透明度")
        self.opacity_slider = QSlider(Qt.Orientation.Horizontal)
        self.opacity_slider.setRange(30, 100)
        self.opacity_slider.setValue(100)
        self.opacity_label = QLabel("100%")
        self.opacity_label.setMinimumWidth(42)
        controls_layout.addWidget(QLabel("币种"), 0, 0)
        controls_layout.addWidget(self.symbol_combo, 0, 1)
        controls_layout.addWidget(QLabel("周期"), 0, 2)
        controls_layout.addWidget(self.interval_combo, 0, 3)
        controls_layout.addWidget(QLabel("K线数量"), 0, 4)
        controls_layout.addWidget(self.limit_spin, 0, 5)
        controls_layout.addWidget(self.refresh_button, 0, 6)
        controls_layout.addWidget(self.analyze_button, 0, 7)
        controls_layout.addWidget(self.auto_refresh_check, 1, 0, 1, 2)
        controls_layout.addWidget(QLabel("刷新间隔"), 1, 2)
        controls_layout.addWidget(self.refresh_seconds_spin, 1, 3)
        controls_layout.addWidget(self.fade_check, 1, 4, 1, 2)
        controls_layout.addWidget(QLabel("透明度"), 1, 6)
        controls_layout.addWidget(self.opacity_slider, 1, 7)
        controls_layout.addWidget(self.opacity_label, 1, 8)
        layout.addWidget(controls)

        metrics = QFrame()
        metrics_layout = QGridLayout(metrics)
        metrics_layout.setContentsMargins(0, 0, 0, 0)
        self.price_label = self._metric_card(metrics_layout, 0, "最新价格", "--")
        self.high_label = self._metric_card(metrics_layout, 1, "区间最高", "--")
        self.low_label = self._metric_card(metrics_layout, 2, "区间最低", "--")
        self.candle_count_label = self._metric_card(metrics_layout, 3, "本地K线", "0 根")
        layout.addWidget(metrics)

        body = QGridLayout()
        body.setColumnStretch(0, 3)
        body.setColumnStretch(1, 2)
        body.setRowStretch(0, 1)
        chart_group = QGroupBox("K线走势")
        chart_layout = QVBoxLayout(chart_group)
        self.chart = CandleChart()
        chart_layout.addWidget(self.chart)
        body.addWidget(chart_group, 0, 0)

        analysis_group = QGroupBox("AI 分析")
        analysis_layout = QVBoxLayout(analysis_group)
        self.action_label = QLabel("观望")
        self.action_label.setObjectName("action")
        self.confidence_label = QLabel("信心度：--")
        self.analysis_time_label = QLabel("尚未分析")
        self.reason_edit = self._readonly_text()
        self.risk_edit = self._readonly_text()
        self.suggestion_edit = self._readonly_text()
        analysis_layout.addWidget(self.action_label)
        analysis_layout.addWidget(self.confidence_label)
        analysis_layout.addWidget(self.analysis_time_label)
        analysis_layout.addWidget(QLabel("判断依据"))
        analysis_layout.addWidget(self.reason_edit)
        analysis_layout.addWidget(QLabel("风险提示"))
        analysis_layout.addWidget(self.risk_edit)
        analysis_layout.addWidget(QLabel("执行建议"))
        analysis_layout.addWidget(self.suggestion_edit)
        body.addWidget(analysis_group, 0, 1)
        layout.addLayout(body, 1)

        history_group = QGroupBox("历史分析")
        history_layout = QVBoxLayout(history_group)
        self.history_table = QTableWidget(0, 5)
        self.history_table.setHorizontalHeaderLabels(["时间", "币种", "周期", "操作", "信心度"])
        self.history_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.history_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.history_table.horizontalHeader().setStretchLastSection(True)
        history_layout.addWidget(self.history_table)
        layout.addWidget(history_group, 0)

        self.status_label = QLabel(f"数据库：{DB_PATH}")
        self.status_label.setObjectName("muted")
        layout.addWidget(self.status_label)

        self.setStyleSheet(
            """
            QWidget#root { background: #0c1117; color: #e6edf3; }
            QFrame#header, QFrame#controls, QGroupBox {
                background: #151d26; border: 1px solid #263241; border-radius: 8px;
            }
            QGroupBox { margin-top: 8px; padding-top: 12px; }
            QGroupBox::title { subcontrol-origin: margin; left: 12px; padding: 0 5px; color: #9eacba; }
            QLabel#title { font-size: 17px; font-weight: 700; color: #f2f5f7; }
            QLabel#muted { color: #8b98a7; }
            QLabel#action { font-size: 28px; font-weight: 700; color: #f4c95d; }
            QLabel.metricTitle { color: #82909e; font-size: 11px; }
            QLabel.metricValue { color: #eff5f8; font-size: 18px; font-weight: 700; }
            QPushButton { background: #263342; color: #e6edf3; border: 1px solid #3a4a5b; border-radius: 5px; padding: 7px 12px; }
            QPushButton:hover { background: #314355; }
            QPushButton:pressed { background: #1e2935; }
            QPushButton#windowButton { padding: 4px 10px; }
            QPushButton#closeButton { background: #6d3038; border-color: #8d4049; }
            QComboBox, QSpinBox, QPlainTextEdit { background: #0f161e; border: 1px solid #344252; border-radius: 5px; padding: 5px; color: #e6edf3; }
            QComboBox QAbstractItemView { background: #151d26; color: #e6edf3; }
            QSlider::groove:horizontal { height: 4px; background: #344252; }
            QSlider::handle:horizontal { width: 14px; margin: -5px 0; border-radius: 7px; background: #35c98b; }
            QTableWidget { background: #0f161e; border: 1px solid #263241; gridline-color: #263241; }
            QHeaderView::section { background: #1c2732; color: #aebbc7; padding: 6px; border: 0; }
            QTableWidget::item { padding: 4px; }
            QCheckBox { color: #b7c3cc; }
            """
        )

    @staticmethod
    def _readonly_text() -> QPlainTextEdit:
        widget = QPlainTextEdit()
        widget.setReadOnly(True)
        widget.setMaximumHeight(72)
        return widget

    @staticmethod
    def _metric_card(layout: QGridLayout, column: int, title: str, value: str) -> QLabel:
        box = QFrame()
        box.setStyleSheet("QFrame { background: #151d26; border: 1px solid #263241; border-radius: 8px; }")
        box_layout = QVBoxLayout(box)
        box_layout.setContentsMargins(12, 8, 12, 8)
        title_label = QLabel(title)
        title_label.setProperty("class", "metricTitle")
        value_label = QLabel(value)
        value_label.setProperty("class", "metricValue")
        box_layout.addWidget(title_label)
        box_layout.addWidget(value_label)
        layout.addWidget(box, 0, column)
        return value_label

    def _connect_signals(self) -> None:
        self.refresh_button.clicked.connect(self.refresh_market)
        self.analyze_button.clicked.connect(self.analyze_market)
        self.symbol_combo.currentTextChanged.connect(self._on_symbol_changed)
        self.interval_combo.currentTextChanged.connect(self._on_interval_changed)
        self.limit_spin.valueChanged.connect(self._save_settings)
        self.refresh_seconds_spin.valueChanged.connect(self._configure_timer)
        self.auto_refresh_check.toggled.connect(self._configure_timer)
        self.fade_check.toggled.connect(self._on_fade_changed)
        self.opacity_slider.valueChanged.connect(self._on_opacity_changed)
        self.pin_button.clicked.connect(self.toggle_always_on_top)
        self.compact_button.clicked.connect(self.toggle_compact)
        self.minimize_button.clicked.connect(self.showMinimized)
        self.close_button.clicked.connect(self.close)
        self.notify.connect(self._show_notification)
        self.refresh_timer = QTimer(self)
        self.refresh_timer.timeout.connect(self.refresh_market)

    def _restore_settings(self) -> None:
        self.symbol_combo.setCurrentText(self.db.load_setting("symbol", DEFAULT_SYMBOL))
        self.interval_combo.setCurrentText(self.db.load_setting("interval", DEFAULT_INTERVAL))
        self.limit_spin.setValue(int(self.db.load_setting("limit", DEFAULT_LIMIT)))
        self.refresh_seconds_spin.setValue(int(self.db.load_setting("refresh_seconds", DEFAULT_REFRESH_SECONDS)))
        self.auto_refresh_check.setChecked(bool(self.db.load_setting("auto_refresh", False)))
        self._fade_enabled = bool(self.db.load_setting("fade_enabled", True))
        self.fade_check.setChecked(self._fade_enabled)
        opacity = int(float(self.db.load_setting("opacity", 1.0)) * 100)
        self.opacity_slider.setValue(max(30, min(100, opacity)))
        self._base_opacity = self.opacity_slider.value() / 100
        self.opacity_label.setText(f"{self.opacity_slider.value()}%")

    def _restore_window_state(self) -> None:
        if bool(self.db.load_setting("always_on_top", False)):
            self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)
            self.pin_button.setText("取消置顶")
        self._compact = bool(self.db.load_setting("compact", False))
        if self._compact:
            self.setMinimumSize(420, 420)
            self.resize(480, 700)
            self.compact_button.setText("恢复窗口")

    def _load_cached_data(self) -> None:
        self._symbols = self.db.load_symbols(limit=300)
        self._populate_symbols(self._symbols)
        symbol = self.current_symbol
        interval = self.current_interval
        candles = self.db.load_candles(symbol, interval, self.limit_spin.value())
        if candles:
            self._apply_candles(candles, source="SQLite 缓存")
        self._history = self.db.load_analyses(symbol, 100)
        self._render_history()
        if self._history:
            self._apply_analysis(self._history[0])

    @property
    def current_symbol(self) -> str:
        return self.symbol_combo.currentText().strip().upper().replace("BYBIT_", "") or DEFAULT_SYMBOL

    @property
    def current_interval(self) -> str:
        return self.interval_combo.currentText().strip() or DEFAULT_INTERVAL

    def _populate_symbols(self, rows: list[dict[str, Any]]) -> None:
        current = self.current_symbol
        self.symbol_combo.blockSignals(True)
        self.symbol_combo.clear()
        for item in rows:
            symbol = str(item.get("symbol", "")).upper()
            if symbol:
                self.symbol_combo.addItem(symbol, item)
        self.symbol_combo.setCurrentText(current)
        self.symbol_combo.blockSignals(False)

    def _on_symbol_changed(self) -> None:
        self._save_settings()
        candles = self.db.load_candles(self.current_symbol, self.current_interval, self.limit_spin.value())
        if candles:
            self._apply_candles(candles, source="SQLite 缓存")
        self._history = self.db.load_analyses(self.current_symbol, 100)
        self._render_history()
        if self._history:
            self._apply_analysis(self._history[0])

    def _on_interval_changed(self) -> None:
        self._save_settings()
        candles = self.db.load_candles(self.current_symbol, self.current_interval, self.limit_spin.value())
        if candles:
            self._apply_candles(candles, source="SQLite 缓存")

    def _save_settings(self) -> None:
        self.db.save_setting("symbol", self.current_symbol)
        self.db.save_setting("interval", self.current_interval)
        self.db.save_setting("limit", self.limit_spin.value())
        self.db.save_setting("refresh_seconds", self.refresh_seconds_spin.value())
        self.db.save_setting("auto_refresh", self.auto_refresh_check.isChecked())
        self.db.save_setting("fade_enabled", self.fade_check.isChecked())
        self.db.save_setting("opacity", self._base_opacity)

    def _configure_timer(self) -> None:
        self._save_settings()
        self.refresh_timer.stop()
        if self.auto_refresh_check.isChecked():
            self.refresh_timer.start(self.refresh_seconds_spin.value() * 1000)
            self.status_label.setText(f"自动刷新已开启：每 {self.refresh_seconds_spin.value()} 秒")

    def _on_fade_changed(self, enabled: bool) -> None:
        self._fade_enabled = enabled
        self._apply_window_opacity()
        self._save_settings()

    def _on_opacity_changed(self, value: int) -> None:
        self._base_opacity = value / 100
        self.opacity_label.setText(f"{value}%")
        self._apply_window_opacity()
        self._save_settings()

    def _apply_window_opacity(self) -> None:
        effective = self._base_opacity
        if self._fade_enabled and not self._pointer_inside:
            effective = max(0.3, effective * 0.68)
        self.setWindowOpacity(effective)

    def enterEvent(self, event) -> None:  # noqa: N802
        self._pointer_inside = True
        self._apply_window_opacity()
        super().enterEvent(event)

    def leaveEvent(self, event) -> None:  # noqa: N802
        self._pointer_inside = False
        self._apply_window_opacity()
        super().leaveEvent(event)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton and event.position().y() <= 54:
            self._drag_position = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if self._drag_position is not None and event.buttons() & Qt.MouseButton.LeftButton:
            self.move(event.globalPosition().toPoint() - self._drag_position)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        self._drag_position = None
        super().mouseReleaseEvent(event)

    def toggle_always_on_top(self) -> None:
        enabled = not bool(self.windowFlags() & Qt.WindowType.WindowStaysOnTopHint)
        self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, enabled)
        self.show()
        self.pin_button.setText("取消置顶" if enabled else "置顶")
        self.db.save_setting("always_on_top", enabled)

    def toggle_compact(self) -> None:
        self._compact = not self._compact
        self.setMinimumSize(420 if self._compact else 900, 420 if self._compact else 620)
        self.resize(480, 700) if self._compact else self.resize(1220, 780)
        self.compact_button.setText("恢复窗口" if self._compact else "紧凑")
        self.db.save_setting("compact", self._compact)

    def load_symbols(self) -> None:
        cached = self.db.load_symbols(limit=300)
        if cached:
            self._symbols = cached
            self._populate_symbols(cached)
        self.api_status.setText("正在同步币种…")
        self._start_job("symbols", lambda: self.api.symbols(limit=300), self._symbols_loaded)

    def _symbols_loaded(self, rows: list[dict[str, Any]]) -> None:
        self._symbols = rows
        self.db.save_symbols(rows)
        self._populate_symbols(rows)
        self.api_status.setText(f"API 在线 · {len(rows)} 个合约")

    def refresh_market(self) -> None:
        symbol, interval, limit = self.current_symbol, self.current_interval, self.limit_spin.value()
        self.refresh_button.setEnabled(False)
        self.status_label.setText(f"正在获取 {symbol} {interval} K线…")
        self._start_job(
            "klines",
            lambda: self.api.klines(symbol, interval, limit),
            lambda data: self._klines_loaded(data, symbol, interval),
            lambda error: self._klines_failed(error, symbol, interval),
        )

    def _klines_loaded(self, data: dict[str, Any], symbol: str, interval: str) -> None:
        rows = data.get("rows", [])
        self.db.save_candles(symbol, interval, rows)
        if symbol == self.current_symbol and interval == self.current_interval:
            self._apply_candles(rows, source="Node API")
        self.refresh_button.setEnabled(True)
        self.status_label.setText(f"{symbol} K线已更新并保存到 SQLite：{len(rows)} 根")

    def _klines_failed(self, error: str, symbol: str, interval: str) -> None:
        rows = self.db.load_candles(symbol, interval, self.limit_spin.value())
        self.refresh_button.setEnabled(True)
        if rows:
            self._apply_candles(rows, source="SQLite 缓存")
            self.status_label.setText(f"API 暂不可用，已使用本地缓存：{error}")
        else:
            self.status_label.setText(error)

    def _apply_candles(self, rows: list[dict[str, Any]], source: str) -> None:
        self.chart.set_rows(rows)
        if not rows:
            return
        closes = [float(row.get("close", 0)) for row in rows]
        self.price_label.setText(f"{closes[-1]:.8g}")
        self.high_label.setText(f"{max(float(row.get('high', 0)) for row in rows):.8g}")
        self.low_label.setText(f"{min(float(row.get('low', 0)) for row in rows):.8g}")
        self.candle_count_label.setText(f"{len(rows)} 根")
        self.status_label.setText(f"数据来源：{source} · 更新时间：{datetime.now().strftime('%H:%M:%S')}")

    def analyze_market(self) -> None:
        symbol, interval, limit = self.current_symbol, self.current_interval, self.limit_spin.value()
        self.analyze_button.setEnabled(False)
        self.status_label.setText(f"正在请求 {symbol} AI 分析…")
        self._start_job(
            "analysis",
            lambda: self.api.analyze(symbol, interval, limit),
            self._analysis_loaded,
            self._analysis_failed,
        )

    def _analysis_loaded(self, envelope: dict[str, Any]) -> None:
        self.db.save_analysis(envelope)
        self._history = self.db.load_analyses(self.current_symbol, 100)
        self._apply_analysis(envelope)
        self._render_history()
        self.analyze_button.setEnabled(True)
        error = envelope.get("error") or ""
        self.status_label.setText(f"AI 分析已保存到 SQLite{f'：{error}' if error else ''}")

    def _analysis_failed(self, error: str) -> None:
        self.analyze_button.setEnabled(True)
        self.status_label.setText(error)

    def _apply_analysis(self, envelope: dict[str, Any]) -> None:
        analyses = envelope.get("analyses") or []
        if not analyses:
            self.action_label.setText("观望")
            self.confidence_label.setText("信心度：--")
            self.reason_edit.setPlainText(envelope.get("error") or "暂无有效 AI 分析结果")
            self.risk_edit.clear()
            self.suggestion_edit.clear()
            return
        item = analyses[0]
        action = str(item.get("positionRecommendation") or item.get("action") or "WAIT").upper()
        labels = {
            "BUY": "做多",
            "OPEN_LONG": "做多",
            "SELL": "做空",
            "OPEN_SHORT": "做空",
            "CLOSE_LONG": "平多",
            "CLOSE_SHORT": "平空",
            "HOLD": "观望",
            "WAIT": "观望",
        }
        self.action_label.setText(labels.get(action, "观望"))
        confidence = item.get("confidence", "--")
        self.confidence_label.setText(f"信心度：{confidence}%" if str(confidence) != "--" else "信心度：--")
        self.analysis_time_label.setText(f"生成时间：{envelope.get('at', '--')}")
        self.reason_edit.setPlainText(str(item.get("reason") or "暂无"))
        self.risk_edit.setPlainText(str(item.get("risk") or "暂无"))
        self.suggestion_edit.setPlainText(str(item.get("suggestion") or "暂无"))

    def _render_history(self) -> None:
        self.history_table.setRowCount(0)
        for envelope in self._history[:30]:
            analyses = envelope.get("analyses") or []
            item = analyses[0] if analyses else {}
            action = str(item.get("positionRecommendation") or item.get("action") or "WAIT").upper()
            labels = {"BUY": "做多", "OPEN_LONG": "做多", "SELL": "做空", "OPEN_SHORT": "做空", "CLOSE_LONG": "平多", "CLOSE_SHORT": "平空", "HOLD": "观望", "WAIT": "观望"}
            row = self.history_table.rowCount()
            self.history_table.insertRow(row)
            values = [
                str(envelope.get("at", ""))[:19].replace("T", " "),
                str(envelope.get("symbol", self.current_symbol)),
                str(envelope.get("interval", "")),
                labels.get(action, "观望"),
                str(item.get("confidence", "--")),
            ]
            for column, value in enumerate(values):
                self.history_table.setItem(row, column, QTableWidgetItem(value))

    def _start_job(
        self,
        name: str,
        task: Callable[[], Any],
        on_success: Callable[[Any], None],
        on_error: Callable[[str], None] | None = None,
    ) -> None:
        existing = self._jobs.get(name)
        if existing:
            return
        # Keep worker threads independent from the window so close can wait for them safely.
        thread = QThread()
        worker = ApiWorker(task)
        worker.moveToThread(thread)
        thread.started.connect(worker.run)

        def success(result: Any) -> None:
            try:
                if not self._shutting_down:
                    on_success(result)
            finally:
                thread.quit()

        def failed(error: str) -> None:
            try:
                if not self._shutting_down:
                    (on_error or self._job_failed)(error)
            finally:
                thread.quit()

        worker.finished.connect(success)
        worker.failed.connect(failed)
        worker.finished.connect(worker.deleteLater)
        worker.failed.connect(worker.deleteLater)
        thread.finished.connect(thread.deleteLater)
        thread.finished.connect(lambda: self._job_finished(name))
        self._jobs[name] = (thread, worker)
        thread.start()

    def _job_finished(self, name: str) -> None:
        self._jobs.pop(name, None)
        if self._shutting_down and not self._jobs:
            QTimer.singleShot(0, self.close)

    def _job_failed(self, error: str) -> None:
        if not self._shutting_down:
            self.status_label.setText(error)

    def _show_notification(self, title: str, message: str) -> None:
        QMessageBox.information(self, title, message)

    def closeEvent(self, event) -> None:  # noqa: N802
        if not self._shutting_down:
            self._shutting_down = True
            self.refresh_timer.stop()
            self.refresh_button.setEnabled(False)
            self.analyze_button.setEnabled(False)
            for thread, _worker in list(self._jobs.values()):
                thread.quit()

        if self._jobs:
            event.ignore()
            return

        self._save_settings()
        self.db.close()
        super().closeEvent(event)


def launch() -> None:
    app = QApplication.instance() or QApplication([])
    app.setApplicationName(APP_NAME)
    window = MainWindow()
    window.show()
    app.exec()
