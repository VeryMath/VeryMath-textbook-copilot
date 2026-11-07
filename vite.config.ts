import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error The API is a plain Node module shared with the production server.
import { createApiMiddleware, disposeAgent } from './server/api.mjs';
// @ts-expect-error The model runtime is shared with the production server.
import { initModelRuntime } from './server/agent.mjs';
// @ts-expect-error Storage uses the same personal directory in both modes.
import { getStorageInfo } from './server/course-store.mjs';
// @ts-expect-error 访问检查与 Node 服务共用。
import { createLocalAccess } from './server/http-security.mjs';

export default defineConfig({
  plugins: [react(), {
    name: 'course-api',
    configResolved(config) {
      for (const options of [config.server, config.preview]) {
        if (!['127.0.0.1', 'localhost', '::1'].includes(String(options.host))) {
          throw new Error('课程服务只能监听 127.0.0.1、localhost 或 ::1。');
        }
      }
    },
    async configureServer(server) {
      const httpServer = server.httpServer;
      if (!httpServer) throw new Error('课程开发服务需要独立的 HTTP 服务。');
      const access = createLocalAccess();
      server.middlewares.use(createApiMiddleware(access));
      server.printUrls = () => { console.log(`课程工作台：${access.launchUrl(httpServer.address())}`); };
      const { directory } = await getStorageInfo();
      await initModelRuntime(directory);
      server.httpServer?.once('close', disposeAgent);
    },
    async configurePreviewServer(server) {
      const access = createLocalAccess();
      server.middlewares.use(createApiMiddleware(access));
      server.printUrls = () => { console.log(`课程工作台：${access.launchUrl(server.httpServer.address())}`); };
      const { directory } = await getStorageInfo();
      await initModelRuntime(directory);
      server.httpServer.once('close', disposeAgent);
    },
    closeBundle() { disposeAgent(); },
  }],
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1' },
  build: {
    rollupOptions: { output: { entryFileNames: 'assets/app.js', chunkFileNames: 'assets/[name].js', assetFileNames: 'assets/[name][extname]' } },
  },
});
