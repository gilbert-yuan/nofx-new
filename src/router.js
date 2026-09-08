/**
 * 简单的路由管理器
 * 使用 URL hash 记录和恢复页面状态
 */

export class Router {
  constructor() {
    this.listeners = new Set();
    this.state = this.parseHash();

    // 监听浏览器前进/后退
    window.addEventListener('hashchange', () => {
      this.state = this.parseHash();
      this.notifyListeners();
    });
  }

  /**
   * 解析 URL hash 为状态对象
   * 格式: #/view?param1=value1&param2=value2
   */
  parseHash() {
    const hash = window.location.hash.slice(1) || '/workbench';
    const [path, queryString] = hash.split('?');
    const view = path.slice(1) || 'workbench';

    const params = {};
    if (queryString) {
      queryString.split('&').forEach(pair => {
        const [key, value] = pair.split('=');
        if (key && value !== undefined) {
          params[key] = decodeURIComponent(value);
        }
      });
    }

    return { view, params };
  }

  /**
   * 构建 URL hash
   */
  buildHash(view, params = {}) {
    const queryParts = [];
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== '') {
        queryParts.push(`${key}=${encodeURIComponent(value)}`);
      }
    }

    const queryString = queryParts.length > 0 ? '?' + queryParts.join('&') : '';
    return `#/${view}${queryString}`;
  }

  /**
   * 导航到新页面
   */
  push(view, params = {}) {
    const hash = this.buildHash(view, params);
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
  }

  /**
   * 替换当前页面（不产生历史记录）
   */
  replace(view, params = {}) {
    const hash = this.buildHash(view, params);
    window.location.replace(hash);
  }

  /**
   * 更新当前页面参数（保持视图不变）
   */
  updateParams(params = {}) {
    this.push(this.state.view, { ...this.state.params, ...params });
  }

  /**
   * 获取当前状态
   */
  getState() {
    return { ...this.state };
  }

  /**
   * 订阅路由变化
   */
  onChange(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * 通知所有监听器
   */
  notifyListeners() {
    this.listeners.forEach(callback => callback(this.state));
  }

  /**
   * 返回上一页
   */
  back() {
    window.history.back();
  }

  /**
   * 前进到下一页
   */
  forward() {
    window.history.forward();
  }
}

// 创建全局路由实例
export const router = new Router();
