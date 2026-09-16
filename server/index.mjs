import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';
import { createApiMiddleware, disposeAgent } from './api.mjs';
import { initModelRuntime } from './agent.mjs';
import { getStorageInfo, disposeReferenceExtractions } from './course-store.mjs';

const distPath = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const api = createApiMiddleware();
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mjs': 'text/javascript; charset=utf-8', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.wasm': 'application/wasm',
};

function plain(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

async function serveApp(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, '仅支持 GET 或 HEAD。');
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
  } catch {
    return plain(res, 400, '地址格式不正确。');
  }
  let path = resolve(distPath, `.${pathname}`);
  if (path !== distPath && !path.startsWith(`${distPath}${sep}`)) return plain(res, 404, '没有找到文件。');
  if (pathname.includes('\0')) return plain(res, 400, '地址格式不正确。');
  try {
    const info = await stat(path);
    if (!info.isFile()) path = resolve(distPath, 'index.html');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (extname(pathname)) return plain(res, 404, '没有找到文件。');
    path = resolve(distPath, 'index.html');
  }
  let info;
  try {
    const actualDist = await realpath(distPath);
    path = await realpath(path);
    if (!path.startsWith(`${actualDist}${sep}`)) return plain(res, 404, '没有找到文件。');
    info = await stat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return plain(res, 404, '页面尚未构建，请先运行 npm run build。');
    throw error;
  }
  res.writeHead(200, {
    'Content-Type': mimeTypes[extname(path)] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return void res.end();
  const stream = createReadStream(path);
  res.on('close', () => stream.destroy());
  stream.on('error', (error) => res.destroy(error));
  stream.pipe(res);
}

const server = createServer((req, res) => {
  api(req, res, () => {
    void serveApp(req, res).catch((error) => {
      console.error(error);
      if (res.headersSent) res.destroy();
      else plain(res, 500, '页面暂时无法打开。');
    });
  });
});
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
server.once('close', disposeAgent);
process.once('exit', disposeAgent);
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  disposeAgent();
  disposeReferenceExtractions();
  server.close(() => { if (process.connected) process.disconnect(); });
  const timeout = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 4000);
  timeout.unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutdown);
if (process.send) {
  process.on('message', message => { if (message?.type === 'shutdown') shutdown(); });
  process.once('disconnect', shutdown);
}
async function boot() {
  const { directory } = await getStorageInfo();
  await initModelRuntime(directory);
  server.listen(port, host, () => {
    const actualPort = server.address().port;
    console.log(`课程工作台：http://${host}:${actualPort}`);
    process.send?.({ type: 'ready', port: actualPort });
  });
}
void boot().catch(error => {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
});
server.on('error', (error) => {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
});
