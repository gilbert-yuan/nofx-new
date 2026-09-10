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
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // 把第三方依赖从业务代码中拆出，提升缓存命中与首屏加载
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('vue') || id.includes('pinia') || id.includes('@vue')) return 'vue-vendor';
            return 'vendor';
          }
        }
      }
    }
  }
});
