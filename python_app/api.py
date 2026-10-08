from __future__ import annotations

from typing import Any

import requests


class ApiError(RuntimeError):
    pass


class ApiClient:
    def __init__(self, base_url: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "NOFX-Python-Qt/1.0"})

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        url = f"{self.base_url}/{path.lstrip('/')}"
        try:
            response = self.session.request(method, url, timeout=self.timeout, **kwargs)
        except requests.RequestException as exc:
            raise ApiError(f"无法连接 Node API：{exc}") from exc
        content_type = response.headers.get("content-type", "")
        if response.status_code >= 400:
            try:
                detail = response.json().get("error", response.text)
            except ValueError:
                detail = response.text
            raise ApiError(f"API {response.status_code}：{detail}")
        if "json" not in content_type.lower():
            raise ApiError("Node API 返回的不是 JSON 数据，请确认 API 地址正确。")
        try:
            return response.json()
        except ValueError as exc:
            raise ApiError("Node API 返回了无效 JSON。") from exc

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/health")

    def symbols(self, search: str = "", limit: int = 300) -> list[dict[str, Any]]:
        data = self._request("GET", "/market/symbols", params={"search": search, "limit": limit})
        if not isinstance(data, list):
            raise ApiError("币种接口返回格式不正确。")
        return data

    def klines(self, symbol: str, interval: str, limit: int) -> dict[str, Any]:
        data = self._request(
            "GET",
            "/market/klines",
            params={"symbol": symbol, "interval": interval, "limit": limit},
        )
        if not isinstance(data, dict) or not isinstance(data.get("rows"), list):
            raise ApiError("K线接口返回格式不正确。")
        return data

    def analyze(self, symbol: str, interval: str, limit: int) -> dict[str, Any]:
        data = self._request(
            "POST",
            "/market/analyze",
            json={
                "symbol": symbol,
                "interval": interval,
                "limit": limit,
                "scope": {"symbols": [symbol], "interval": interval, "limit": limit},
            },
        )
        if not isinstance(data, dict):
            raise ApiError("AI 分析接口返回格式不正确。")
        return data

    def analyses(self, symbol: str = "", limit: int = 100) -> list[dict[str, Any]]:
        data = self._request(
            "GET", "/analyses", params={"symbol": symbol, "limit": limit}
        )
        if not isinstance(data, list):
            raise ApiError("历史分析接口返回格式不正确。")
        return data
