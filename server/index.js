/**
 * 组合根（Composition Root）
 * 职责：装配依赖、挂载路由、提供静态资源与 SPA fallback、统一错误处理。
 * 业务逻辑已下沉到 server/routes/* 与既有 research/globalAutomation 模块。
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { Container } from './core/container.js';
import { proxyHealth } from './core/proxyHealth.js';
import { API } from '../shared/api-contract.js';
import { createConfigRouter } from './routes/config.js';
import { createBinanceRouter } from './routes/binance.js';
import { createStrategyRouter } from './routes/strategy.js';
import { createMarketRouter } from './routes/market.js';
import { createHistoryRouter } from './routes/history.js';

const container = new Container();
await container.init();

// 启动代理存活探针：行情依赖本地 Clash(127.0.0.1:7890) 转发 OKX，
// 代理宕机时 okxClient 会快速失败、globalAutomation 跳过本轮，并在恢复后自动重试。
const proxyUrl = process.env.OKX_PROXY_URL ?? (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890');
proxyHealth.configure(proxyUrl);
await proxyHealth.check();
console.log(`[ProxyHealth] 初始探测完成，后续由自动任务检查: ${proxyHealth.url}`);

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://127.0.0.1:5173' }));
app.use(express.json({ limit: '1mb' }));

// 健康检查
app.get(API.health, (req, res) => res.json({ ok: true, name: 'nofx-lite' }));

// 业务路由（分层模块）
app.use(createConfigRouter(container));
app.use(createBinanceRouter(container));
app.use(createStrategyRouter(container));
app.use(createMarketRouter(container));
app.use(createHistoryRouter(container));

// 研究 / 全局自动化（既有模块化路由）
await container.registerResearch(app);
container.registerGlobalAutomation(app);

// 未命中 API 时回退
app.use('/api', (req, res) => res.status(404).json({ error: 'API 接口不存在。' }));

// 前端静态资源 + SPA fallback（dist 不存在时给友好提示，避免白屏）
const distDir = path.join(container.rootDir, 'dist');
const indexHtml = path.join(distDir, 'index.html');
if (fs.existsSync(indexHtml)) {
  // 带 hash 的 assets 可以长缓存；但 index.html 必须每次回源校验 —— 否则前端重建后，
  // 浏览器仍按 max-age 使用旧 index.html，去请求已被删除的旧 chunk 就会白屏。
  app.use(express.static(distDir, {
    maxAge: '1h',
    etag: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  }));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
} else {
  const buildHint = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>NOFX · 需要构建</title>
    <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0e1414;color:#d8e3df;padding:48px;max-width:640px;margin:auto;line-height:1.6}
    h1{color:#ff6b6b;margin:0 0 12px}code{background:#1d2828;padding:2px 8px;border-radius:4px;color:#5eb8ff}a{color:#5eb8ff}</style></head>
    <body><h1>前端尚未构建</h1>
    <p>Express 服务已启动，<b>API 可正常使用</b>：<a href="/api/health">/api/health</a>。</p>
    <p>前端构建产物（<code>dist/index.html</code>）未找到。请在终端执行：</p>
    <pre><code>npm run build      # 一次性构建
npm run dev        # 构建 + 启动（单进程，自动 prestart 钩子）
npm run dev:hot    # 构建 + 启动 vite HMR + 后端 nodemon（开发热更用）</code></pre>
    </body></html>`;
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.status(200).type('html').send(buildHint);
  });
}

// 统一错误处理
app.use((error, req, res, next) => {
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  res.status(status).json({ error: error.message || 'Internal server error' });
});

app.listen(container.port, () => {
  console.log(`NOFX Lite API listening on http://127.0.0.1:${container.port}`);
});

// 应用就绪后启动两项自动任务。
container.startLifecycle();
