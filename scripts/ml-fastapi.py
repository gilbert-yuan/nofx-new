"""Loopback-only FastAPI transport for the Rust ML and paper-research service.

No market features, model inference, training, accounting, or order execution live here.
Run: data/ml/runtime/Scripts/python.exe scripts/ml-fastapi.py --port 18083
The fixed Rust upstream must already be listening on 127.0.0.1:18082.
"""

import argparse
import json
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request as HttpRequest, build_opener

from fastapi import FastAPI, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool


UPSTREAM = "http://127.0.0.1:18082"
MAX_BODY_BYTES = 1_048_576
MAX_RESPONSE_BYTES = 16_777_216
app = FastAPI(
    title="NOFX local ML JSON gateway",
    description="A local transport for Rust signals, model metadata, and paper-only stepping.",
    version="1.0.0",
)


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def proxy(method: str, path: str, body: bytes | None = None) -> Response:
    # Ignore proxy environment variables and do not follow a redirect off loopback.
    opener = build_opener(ProxyHandler({}), NoRedirects())
    request = HttpRequest(
        UPSTREAM + path,
        data=body,
        method=method,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
    )
    try:
        upstream = opener.open(request, timeout=30)
    except HTTPError as error:
        upstream = error
    except (URLError, TimeoutError, OSError) as error:
        raise HTTPException(status_code=503, detail="Local Rust ML service is unavailable") from error
    with upstream:
        status = upstream.code
        raw = upstream.read(MAX_RESPONSE_BYTES + 1)
    if 300 <= status < 400:
        raise HTTPException(status_code=502, detail="Upstream redirects are disabled")
    if len(raw) > MAX_RESPONSE_BYTES:
        raise HTTPException(status_code=502, detail="Upstream JSON response is too large")
    try:
        json.loads(raw, parse_constant=reject_constant)
    except (ValueError, UnicodeError) as error:
        if status >= 400:
            raw = json.dumps(
                {"error": raw.decode("utf-8", errors="replace"), "upstream_status": status},
                ensure_ascii=False,
                allow_nan=False,
            ).encode("utf-8")
        else:
            raise HTTPException(status_code=502, detail="Upstream did not return valid JSON") from error
    return Response(
        content=raw,
        status_code=status,
        media_type="application/json",
        headers={"X-NOFX-Gateway": "fastapi-loopback", "Cache-Control": "no-store"},
    )


def reject_constant(value: str):
    raise ValueError("JSON numeric values must be finite")


async def object_body(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            size = int(declared)
        except ValueError as error:
            raise HTTPException(status_code=400, detail="Invalid Content-Length") from error
        if size < 0 or size > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail="JSON request is too large")
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail="JSON request is too large")
    try:
        value = json.loads(raw or b"{}", parse_constant=reject_constant)
    except (ValueError, UnicodeError) as error:
        raise HTTPException(status_code=400, detail="Request must contain valid JSON") from error
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="Request JSON must be an object")
    return json.dumps(value, allow_nan=False, separators=(",", ":")).encode("utf-8")


@app.get("/health")
def health():
    return proxy("GET", "/health")


@app.get("/models")
def models():
    return proxy("GET", "/models")


@app.get("/paper")
def paper_status():
    return proxy("GET", "/paper")


@app.post("/signal")
async def signal(request: Request):
    body = await object_body(request)
    return await run_in_threadpool(proxy, "POST", "/signal", body)


@app.post("/paper/step")
async def paper_step(request: Request):
    body = await object_body(request)
    return await run_in_threadpool(proxy, "POST", "/paper/step", body)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Serve the local Rust ML gateway without execution permissions")
    parser.add_argument("--port", type=int, default=18083)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=True)
