/**
 * 生产部署（PM2 单进程）
 * 后端 express 已直接托管前端 dist 静态资源与 SPA fallback，
 * 不再需要独立的 vite/web 进程；构建后只需启动 nofx-api。
 *
 * 启动：npm run build && npm run pm2:start
 */
module.exports = {
  apps: [
    {
      name: 'nofx-api',
      cwd: __dirname,
      script: 'server/index.js',
      interpreter: 'node',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3100,
        HTTP_PROXY: 'http://127.0.0.1:7890',
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        // P3 盈利改造：入场综合评分门槛 66 → 70（代码默认值仍是 66，回滚只需删掉本行）。
        // 用于降频：合成样本下出单量 76 → 39（约 -49%），落在 40%~60% 目标区间。
        NOFX_MIN_TREND_SCORE: '70'
      }
    }
  ]
};
