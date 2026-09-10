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
      // 日志带时间戳：便于区分历史错误与当前错误（此前无时间戳，排障只能盲猜）。
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // 防崩溃循环：连续崩溃达到上限后停止自启，避免无限 restart 占用端口/CPU。
      max_restarts: 10,
      min_uptime: '10s',
      // 指数退避，崩溃后不要瞬间重试。
      exp_backoff_restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
        PORT: 3100,
        HTTP_PROXY: 'http://127.0.0.1:7890',
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        // P3 盈利改造：入场综合评分门槛 66 → 70（代码默认值仍是 66，回滚只需删掉本行）。
        // 用于降频：合成样本下出单量 76 → 39（约 -49%），落在 40%~60% 目标区间。
        NOFX_MIN_TREND_SCORE: '70',
        // P6 胜率优化（2026-09-11）：禁空。09-10 当日空单 166 笔胜率仅 30.1%、净 -282.7 USDT
        // （限价挂单部署后每小时均净亏），而多单 53 笔 45.3%、净 +5.8 USDT（限价挂单后 56.3%）。
        // 空头出血占当前全部亏损的主导，先禁空止血；行情风格切换后可删掉本行恢复双向。
        NOFX_LONG_ONLY: 'true',
        // P8 胜率优化（2026-09-11，50 币×30 天 1m 回测 489 笔依据）：
        // 均线失守阈值 1→2 ATR —— 回调挂单入场（成交=价格已回落）与均线失守退出几何重叠，
        // 是「入场即出场」的结构性冲突根源；放宽后净亏 -900.8 → -786.4U。
        NOFX_SMART_MA_ATR: '2.0',
        // 最小持仓保护：入场 15 根内禁止智能退出 CLOSE（回测 52% 订单 1 根内被平；
        // SMART_MA_ATR=2.0 + 15 根组合最优：胜率 15.5%→31.4%、净 -900.8 → -759.0U）。
        // 移动止损/止损止盈/超时不受影响。回滚：删掉两行重启即可。
        NOFX_SMART_MIN_HOLD: '15',
      }
    }
  ]
};
