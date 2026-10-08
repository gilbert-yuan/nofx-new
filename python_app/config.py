from __future__ import annotations

import os
from pathlib import Path


APP_NAME = "NOFX Python Qt Watcher"
DEFAULT_API_BASE = os.getenv("NOFX_API_BASE", "http://127.0.0.1:3000/api").rstrip("/")
DEFAULT_SYMBOL = "BTCUSDT"
DEFAULT_INTERVAL = "4h"
DEFAULT_LIMIT = 80
DEFAULT_REFRESH_SECONDS = 60


def app_data_dir() -> Path:
    configured = os.getenv("NOFX_DATA_DIR")
    if configured:
        path = Path(configured).expanduser()
    else:
        appdata = os.getenv("APPDATA")
        path = Path(appdata) / "nofx-python-qt" if appdata else Path.home() / ".nofx-python-qt"
    path.mkdir(parents=True, exist_ok=True)
    return path


DB_PATH = app_data_dir() / "nofx_research.sqlite"
