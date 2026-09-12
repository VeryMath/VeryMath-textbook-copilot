import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { extname, resolve, sep } from 'node:path';
import { codingAgent, getAgentStatus, getSkillAvailability, connectAgent, disconnectAgent, configureAgent, startAgentLogin, cancelAgentLogin } from './agent.mjs';
export { disposeAgent } from './agent.mjs';
import { handleCourseApi } from './course-api.mjs';
import { createGeneratedArtifactSaver, getCoursePaths, outputUrl } from './course-store.mjs';
import { slideTemplates } from './slide-templates.mjs';

const pdfAssetsRoot = fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const limit = 2 * 1024 * 1024;
    let size = 0;
    const chunks = [];
    let failed = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (failed) return;
      if (size > limit) {
        failed = true;
        chunks.length = 0;
        reject(new HttpError(413, '请求内容太长，请减少输入文字或对话历史。'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, '请求内容不是有效的 JSON。'));
      }
    });
    req.on('aborted', () => reject(new HttpError(400, '请求已中断。')));
    req.on('error', reject);
  });
}

function checkRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || typeof request.skillId !== 'string' || !request.book
    || !['id', 'title', 'filename'].every((key) => typeof request.book[key] === 'string')
    || !Number.isInteger(request.page) || request.page < 1
    || !['page', 'section', 'chapter', 'selection', 'book'].includes(request.scope)
    || (request.knowledgeGraphDetail !== undefined && !['overview', 'detailed'].includes(request.knowledgeGraphDetail))
    || !['selectedText', 'pageText', 'prompt'].every((key) => typeof request[key] === 'string')
    || !Array.isArray(request.history)
    || !request.history.every((item) => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')) {
    throw new HttpError(400, '缺少教材、页码、操作范围或问题内容，请刷新页面后重试。');
  }
  if (request.templateId !== undefined && !slideTemplates.some(template => template.id === request.templateId)) {
    throw new HttpError(400, '请选择白底深蓝、米白宋体或蓝色标题栏模板。');
  }
  if (request.referenceIds !== undefined && (!Array.isArray(request.referenceIds) || request.referenceIds.length > 50
      || request.referenceIds.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)))) {
    throw new HttpError(400, '请选择当前课程的辅助资料，每次最多 50 份。');
  }
}

async function writeEvent(res, event, signal) {
  signal.throwIfAborted();
  if (!res.write(`${JSON.stringify(event)}\n`)) {
    await once(res, 'drain', { signal });
  }
}

async function runAgent(req, res, request, skills) {
  const paths = await getCoursePaths(request.book.id);
  const saveGeneratedArtifact = await createGeneratedArtifactSaver(request.book.id, request);
  const controller = new AbortController();
  const stop = () => {
    if (!res.writableFinished) controller.abort();
  };
  let endType;
  try {
    if (req.aborted || res.destroyed) return;
    req.on('aborted', stop);
    res.on('close', stop);
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    for await (const rawEvent of codingAgent(request, {
      signal: controller.signal, ...paths, skills,
      ...saveGeneratedArtifact.knowledgeGraphContext,
      outputUrl: (filename) => outputUrl(request.book.id, filename),
    })) {
      let event = rawEvent;
      if (!event || !['progress', 'text', 'artifact', 'done', 'error'].includes(event.type)) {
        throw new Error('Coding Agent 返回了无法识别的内容。');
      }
      if (event.type === 'done') {
        endType = 'done';
        break;
      }
      controller.signal.throwIfAborted();
      if (event.type === 'artifact') event = { ...event, artifact: await saveGeneratedArtifact(event.artifact) };
      await writeEvent(res, event, controller.signal);
      if (event.type === 'error') {
        endType = 'error';
        break;
      }
    }
    if (endType === 'done' && !controller.signal.aborted) {
      await writeEvent(res, { type: 'done' }, controller.signal);
    } else if (!endType && !controller.signal.aborted) {
      await writeEvent(res, { type: 'error', message: 'Coding Agent 已结束，但没有返回完成信息，请检查接入函数。' }, controller.signal);
    }
  } catch (error) {
    if (!controller.signal.aborted && !res.destroyed) {
      const reason = error instanceof Error ? error.message : '请稍后重试。';
      res.write(`${JSON.stringify({ type: 'error', message: `Coding Agent 执行失败：${reason}` })}\n`);
    }
  } finally {
    saveGeneratedArtifact.dispose();
    req.off('aborted', stop);
    res.off('close', stop);
    if (!res.destroyed) res.end();
  }
}

async function servePdfAsset(req, res, directory, encodedFilename) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '此地址仅支持 GET 或 HEAD。');
  let filename;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    throw new HttpError(400, '资源地址格式不正确。');
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename) || filename === '.' || filename === '..') {
    throw new HttpError(404, '没有找到 PDF 阅读资源。');
  }
  let filePath;
  let info;
  try {
    const directoryPath = await realpath(resolve(pdfAssetsRoot, directory));
    filePath = await realpath(resolve(directoryPath, filename));
    if (!filePath.startsWith(`${directoryPath}${sep}`)) throw new HttpError(404, '没有找到 PDF 阅读资源。');
    info = await stat(filePath);
    if (!info.isFile()) throw new HttpError(404, '没有找到 PDF 阅读资源。');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HttpError(404, '没有找到 PDF 阅读资源，请检查依赖是否已安装。');
    throw error;
  }
  const mimeTypes = {
    '.wasm': 'application/wasm', '.js': 'text/javascript; charset=utf-8',
    '.ttf': 'font/ttf', '.otf': 'font/otf',
  };
  res.writeHead(200, {
    'Content-Type': mimeTypes[extname(filename)] || 'application/octet-stream',
    'Content-Length': info.size, 'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return void res.end();
  const stream = createReadStream(filePath);
  res.on('close', () => stream.destroy());
  stream.on('error', (error) => res.destroy(error));
  stream.pipe(res);
}

async function handleApi(req, res, next) {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (!pathname.startsWith('/api/')) return next();
  if (await handleCourseApi(req, res)) return;

  if (pathname === '/api/skills') {
    if (req.method !== 'GET') throw new HttpError(405, '此地址仅支持 GET。');
    return sendJson(res, 200, getSkillAvailability(await getAgentStatus()));
  }
  if (pathname === '/api/agent/status') {
    if (req.method !== 'GET') throw new HttpError(405, '此地址仅支持 GET。');
    return sendJson(res, 200, await getAgentStatus(true));
  }
  const agentActions = {
    '/api/agent/connect': ['POST', connectAgent],
    '/api/agent/disconnect': ['POST', disconnectAgent],
    '/api/agent/config': ['PATCH', configureAgent],
    '/api/agent/login': ['POST', startAgentLogin],
    '/api/agent/login/cancel': ['POST', cancelAgentLogin],
  };
  if (agentActions[pathname]) {
    const [method, action] = agentActions[pathname];
    if (req.method !== method) throw new HttpError(405, `此地址仅支持 ${method}。`);
    if (!req.headers['content-type']?.includes('application/json')) throw new HttpError(415, '请以 JSON 格式发送请求。');
    return sendJson(res, 200, await action(await readBody(req)));
  }
  const assetMatch = /^\/api\/pdf-assets\/(cmaps|standard_fonts|wasm)\/([^/]+)$/.exec(pathname);
  if (assetMatch) return servePdfAsset(req, res, assetMatch[1], assetMatch[2]);
  if (pathname === '/api/agent/run') {
    if (req.method !== 'POST') throw new HttpError(405, '运行 Coding Agent 请使用 POST。');
    if (!req.headers['content-type']?.includes('application/json')) throw new HttpError(415, '请以 JSON 格式发送请求。');
    const request = await readBody(req);
    checkRequest(request);
    const status = await getAgentStatus();
    const skill = getSkillAvailability(status).find((item) => item.id === request.skillId);
    if (!skill) throw new HttpError(404, '没有找到这个课程操作。');
    if (!status.connected) return sendJson(res, 503, { error: status.message });
    if (!skill.available) return sendJson(res, 501, { error: `“${skill.title}”的 Skill 尚未配置，请打开工作区设置，填写真实 SKILL.md 路径。` });
    if (req.aborted || res.destroyed) return;
    return runAgent(req, res, request, status.skills.filter((item) => item.configured).map(({ configured, ...item }) => item));
  }
  throw new HttpError(404, '没有找到这个接口。');
}

// Vite 开发服务与 Node 正式服务共用这一份接口。
export function createApiMiddleware() {
  return (req, res, next = () => sendJson(res, 404, { error: '没有找到这个地址。' })) => {
    void handleApi(req, res, next).catch((error) => {
      if (res.headersSent) {
        if (!res.destroyed) res.destroy();
        return;
      }
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : error.code === 'ENOENT' ? 404 : 500;
      const message = error.status ? error.message : status === 404 ? '课程文件不存在，请检查个人课程目录。' : '服务暂时无法处理请求，请查看服务端输出。';
      if (status === 500) console.error(error);
      sendJson(res, status, { error: message });
    });
  };
}
