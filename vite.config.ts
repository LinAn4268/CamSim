import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // GitHub Pages 项目站点 URL 形如 https://<用户名>.github.io/<仓库名>/，
  // base 必须设为 '/<仓库名>/'，否则打包后的 JS/CSS 路径会是 '/assets/...' 导致 404。
  // 本地开发时该配置无影响；如仓库改名，同步修改这里即可。
  base: '/CamSim/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // Windows 上编辑器原子保存会触发原生文件监视器 EBUSY，改用轮询避免开发服务器崩溃
    watch: { usePolling: true, interval: 300 },
  },
  build: {
    target: 'es2020',
    // three.js 占了绝大部分体积，单独拆出来：它几乎不变，可以长期被浏览器/CI 缓存，
    // 业务代码改动时用户只需重新下载很小的那一块。
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
