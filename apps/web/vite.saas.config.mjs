import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root, plugins: [react(), { name: 'awwo-saas-entry', configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/' || req.url?.startsWith('/?') || req.url === '/admin') req.url = `/saas.html${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
      next();
    });
  } }],
  define: { 'import.meta.env.VITE_AWWO_SAAS': JSON.stringify('1') },
  server: { host: process.env.VITE_AWWO_WEB_HOST || '127.0.0.1', port: Number(process.env.VITE_AWWO_WEB_PORT || 5189), strictPort: true,
    proxy: { '/api/v1': { target: process.env.AWWO_API_TARGET || 'http://127.0.0.1:8087' } } },
  build: { outDir: 'dist-saas', rollupOptions: { input: fileURLToPath(new URL('./saas.html', import.meta.url)) } },
});
