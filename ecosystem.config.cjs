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
        HTTPS_PROXY: 'http://127.0.0.1:7890'
      }
    },
    {
      name: 'nofx-web',
      cwd: __dirname,
      script: 'node_modules/vite/bin/vite.js',
      interpreter: 'node',
      args: '--host 127.0.0.1 --port 5173',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'development',
        NOFX_API_TARGET: 'http://127.0.0.1:3100'
      }
    }
  ]
};
