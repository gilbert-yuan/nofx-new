from __future__ import annotations

from typing import Any

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QWidget


class CandleChart(QWidget):
    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.rows: list[dict[str, Any]] = []
        self.setMinimumHeight(260)
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent, False)

    def set_rows(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.fillRect(self.rect(), QColor("#111820"))
        margin_left, margin_top, margin_right, margin_bottom = 48, 18, 14, 34
        chart = self.rect().adjusted(margin_left, margin_top, -margin_right, -margin_bottom)
        if not self.rows:
            painter.setPen(QColor("#8b98a7"))
            painter.drawText(chart, Qt.AlignmentFlag.AlignCenter, "暂无 K 线数据")
            return

        lows = [float(row.get("low", 0)) for row in self.rows]
        highs = [float(row.get("high", 0)) for row in self.rows]
        floor, ceiling = min(lows), max(highs)
        span = max(ceiling - floor, 1e-9)

        painter.setPen(QPen(QColor("#293541"), 1))
        for fraction in (0, 0.25, 0.5, 0.75, 1):
            y = chart.top() + int(chart.height() * fraction)
            painter.drawLine(chart.left(), y, chart.right(), y)
            value = ceiling - span * fraction
            painter.setPen(QColor("#768493"))
            painter.drawText(4, y + 4, f"{value:.4g}")
            painter.setPen(QPen(QColor("#293541"), 1))

        step = chart.width() / max(len(self.rows), 1)
        body_width = max(2, int(step * 0.58))
        for index, row in enumerate(self.rows):
            x = chart.left() + step * (index + 0.5)
            high = float(row.get("high", 0))
            low = float(row.get("low", 0))
            open_price = float(row.get("open", 0))
            close = float(row.get("close", 0))
            y_high = chart.bottom() - (high - floor) / span * chart.height()
            y_low = chart.bottom() - (low - floor) / span * chart.height()
            y_open = chart.bottom() - (open_price - floor) / span * chart.height()
            y_close = chart.bottom() - (close - floor) / span * chart.height()
            rising = close >= open_price
            color = QColor("#35c98b" if rising else "#ed6a6a")
            painter.setPen(QPen(color, 1))
            painter.drawLine(int(x), int(y_high), int(x), int(y_low))
            top, bottom = min(y_open, y_close), max(y_open, y_close)
            painter.fillRect(
                int(x - body_width / 2),
                int(top),
                body_width,
                max(1, int(bottom - top)),
                color,
            )

        last = float(self.rows[-1].get("close", 0))
        last_y = chart.bottom() - (last - floor) / span * chart.height()
        painter.setPen(QPen(QColor("#f4c95d"), 1, Qt.PenStyle.DashLine))
        painter.drawLine(chart.left(), int(last_y), chart.right(), int(last_y))
        painter.setPen(QColor("#f4c95d"))
        painter.drawText(chart.right() - 84, int(last_y) - 4, f"{last:.6g}")
