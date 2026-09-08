const API_BASE = import.meta.env?.VITE_API_BASE || '/api';

export async function api(path, options = {}) {
  const { timeoutMs = path.includes('analyze-') || path === '/history/fetch' || path.includes('performance/refresh') ? 1800000 : path.includes('analyze') || path.includes('/binance/review') ? 180000 : 45000, signal: externalSignal, headers, body: input, ...request } = options;
  const controller = new AbortController();
  const abort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...request,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
      signal: controller.signal,
      body: input === undefined ? undefined : JSON.stringify(input)
    });
    const text = await res.text();
    if (!(res.headers.get('content-type') || '').includes('application/json')) {
      throw new Error('接口未返回 JSON，请检查后端服务是否正常运行。');
    }
    let body;
    try { body = JSON.parse(text); } catch { throw new Error('接口返回的数据不完整或格式无效，请重试。'); }
    if (!res.ok) throw Object.assign(new Error(typeof body?.error === 'string' ? body.error : body?.error?.message || `请求失败（HTTP ${res.status}）`), { status: res.status });
    return body;
  } catch (error) {
    if (externalSignal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    if (controller.signal.aborted) throw new Error('请求超时，请检查网络后重试。后台任务可能仍在运行，可查看同步状态或历史记录。');
    if (error instanceof TypeError) throw new Error('无法连接服务，请检查网络及项目运行状态。');
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abort);
  }
}
