import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/flutter_app/**', '**/python_app/**', '**/.pm2/**', '**/data/**', '**/output/**'] },
    proxy: { '/api': process.env.NOFX_API_TARGET || 'http://127.0.0.1:3100' }
  }
});
