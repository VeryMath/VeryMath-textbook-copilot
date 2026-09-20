import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error The API is a plain Node module shared with the production server.
import { createApiMiddleware, disposeAgent } from './server/api.mjs';
// @ts-expect-error The model runtime is shared with the production server.
import { initModelRuntime } from './server/agent.mjs';
// @ts-expect-error Storage uses the same personal directory in both modes.
import { getStorageInfo } from './server/course-store.mjs';

export default defineConfig({
  plugins: [react(), {
    name: 'course-api',
    async configureServer(server) {
      const { directory } = await getStorageInfo();
      await initModelRuntime(directory);
      server.middlewares.use(createApiMiddleware());
      server.httpServer?.once('close', disposeAgent);
    },
    async configurePreviewServer(server) {
      const { directory } = await getStorageInfo();
      await initModelRuntime(directory);
      server.middlewares.use(createApiMiddleware());
      server.httpServer.once('close', disposeAgent);
    },
    closeBundle() { disposeAgent(); },
  }],
  server: { host: '127.0.0.1', port: 5173 },
  build: {
    rollupOptions: { output: { entryFileNames: 'assets/app.js', chunkFileNames: 'assets/[name].js', assetFileNames: 'assets/[name][extname]' } },
  },
});
