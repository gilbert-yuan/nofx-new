import net from 'node:net';

/**
 * 本地代理（Clash 等）存活探针。
 *
 * 整站行情依赖 127.0.0.1:7890 转发 OKX，代理一旦挂掉，okxClient 会遍地抛
 * fetch failed。此模块周期性 TCP 探测，暴露 isAlive()，并在状态翻转时告警，
 * 配合 okxClient 的「代理宕机快速失败」与 globalAutomation 的「代理宕机跳过本轮」，
 * 彻底消除静默刷错误日志的问题。
 *
 * 设计为无副作用的单例：configure() 解析代理地址，start() 启动周期探测，
 * 其余模块只读取 isAlive() / 订阅 onChange()。
 */
class ProxyHealth {
  constructor() {
    this.url = null;
    this.host = null;
    this.port = null;
    // 默认乐观：启动初期未探测前不误判为宕机，避免自动化被无故跳过。
    this.alive = true;
    this.lastCheckedAt = 0;
    this.listeners = new Set();
    this.timer = null;
    this.intervalMs = 30000;
    this.checkTimeoutMs = 4000;
  }

  configure(proxyUrl) {
    if (!proxyUrl) {
      this.url = null;
      this.alive = true;
      return;
    }
    try {
      const u = new URL(proxyUrl);
      this.host = u.hostname;
      this.port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      this.url = proxyUrl;
    } catch {
      // 非标准代理地址，兜底按 host:port 解析
      const m = /:(\d+)/.exec(proxyUrl);
      this.host = '127.0.0.1';
      this.port = m ? Number(m[1]) : 7890;
      this.url = proxyUrl;
    }
  }

  start() {
    if (!this.url || this.timer) return;
    this._probe(); // 启动即探一次，尽快得到真实状态
    this.timer = setInterval(() => this._probe(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isAlive() {
    return this.alive;
  }

  /** 订阅状态翻转（true=恢复 / false=宕机），返回取消订阅函数 */
  onChange(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async _probe() {
    if (!this.host) {
      this._setAlive(true);
      return;
    }
    const ok = await this._tcpOpen(this.host, this.port, this.checkTimeoutMs);
    this.lastCheckedAt = Date.now();
    this._setAlive(ok);
  }

  _setAlive(next) {
    const prev = this.alive;
    this.alive = next;
    if (prev === next) return;
    const msg = next
      ? '[ProxyHealth] 代理恢复可用：127.0.0.1:7890 连通，OKX 行情已恢复。'
      : '[ProxyHealth] ⚠️ 代理不可达：127.0.0.1:7890 连接失败，OKX 行情将中断；请检查本地 Clash 代理是否运行。';
    console[next ? 'log' : 'error'](msg);
    for (const cb of this.listeners) {
      try {
        cb(next);
      } catch {
        // 忽略订阅者异常，避免影响探测循环
      }
    }
  }

  _tcpOpen(host, port, timeoutMs) {
    return new Promise((resolve) => {
      const socket = net.connect(port, host);
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      const t = setTimeout(() => done(false), timeoutMs);
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => {
        clearTimeout(t);
        done(true);
      });
      socket.once('error', () => {
        clearTimeout(t);
        done(false);
      });
      socket.once('timeout', () => {
        clearTimeout(t);
        done(false);
      });
    });
  }
}

export const proxyHealth = new ProxyHealth();
export default proxyHealth;
