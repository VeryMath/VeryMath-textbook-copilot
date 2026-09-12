import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  getStorageInfo, updateSettings, listCourses, importCourse, getState, saveState,
  updateTextbook, savePage, resolveCourseFile, listConversations, getConversation, migrateState,
  updateMindmapNode, listReferences, importReference, updateReference, deleteReference, getReferenceFile,
  startReferenceExtraction, searchReferences,
} from './course-store.mjs';

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function method(req, ...methods) {
  if (!methods.includes(req.method)) fail(405, `此地址支持 ${methods.join('、')}。`);
}
function decode(value) {
  try { return decodeURIComponent(value); } catch { fail(400, '地址或文件名格式不正确。'); }
}

function body(req) {
  if (!req.headers['content-type']?.includes('application/json')) fail(415, '请以 JSON 格式发送请求。');
  return new Promise((accept, reject) => {
    let size = 0;
    let failed = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > 25 * 1024 * 1024) {
        failed = true;
        chunks.length = 0;
        reject(Object.assign(new Error('记录超过 25 MB，请减少单次保存的内容。'), { status: 413 }));
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('请求内容不是有效的 JSON。'), { status: 400 })); }
    });
    req.on('aborted', () => reject(Object.assign(new Error('请求已中断。'), { status: 400 })));
    req.on('error', reject);
  });
}

async function serveFile(req, res, path, filename) {
  const info = await stat(path);
  const types = { '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8', '.tex': 'text/plain; charset=utf-8', '.zip': 'application/zip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  const headers = { 'Content-Type': types[extname(path).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
  if (filename) {
    const disposition = /\.(pdf|txt|md|png|jpe?g|webp)$/i.test(filename) ? 'inline' : 'attachment';
    headers['Content-Disposition'] = `${disposition}; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`)}`;
    headers['Content-Security-Policy'] = "sandbox; default-src 'none'";
  }
  let start = 0;
  let end = info.size - 1;
  let status = 200;
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!range || (!range[1] && !range[2])) start = -1;
    else if (!range[1]) start = Number(range[2]) > 0 ? Math.max(0, info.size - Number(range[2])) : -1;
    else {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), end);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  res.writeHead(status, { ...headers, 'Content-Length': Math.max(0, end - start + 1) });
  if (req.method === 'HEAD' || info.size === 0) return res.end();
  const stream = createReadStream(path, { start, end });
  res.on('close', () => stream.destroy());
  stream.on('error', (error) => res.destroy(error));
  stream.pipe(res);
}

export async function handleCourseApi(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;
  if (path !== '/api/storage' && path !== '/api/settings' && path !== '/api/courses' && !path.startsWith('/api/courses/')) return false;
  try {
    if (path === '/api/storage') {
      method(req, 'GET');
      json(res, 200, await getStorageInfo());
    } else if (path === '/api/settings') {
      method(req, 'PATCH');
      json(res, 200, await updateSettings(await body(req)));
    } else if (path === '/api/courses') {
      method(req, 'GET', 'POST');
      if (req.method === 'GET') json(res, 200, await listCourses());
      else {
        if (!req.headers['content-type']?.includes('application/pdf')) fail(415, '请上传 PDF 文件。');
        if (Number(req.headers['content-length']) > 100 * 1024 * 1024) { req.resume(); fail(413, '教材超过了 100 MB，请压缩 PDF 后重试。'); }
        const filename = decode(typeof req.headers['x-filename'] === 'string' ? req.headers['x-filename'] : '教材.pdf');
        json(res, 201, await importCourse(req, filename, url.searchParams.get('legacyId') ?? undefined));
      }
    } else {
      const searchMatch = /^\/api\/courses\/([^/]+)\/references\/search$/.exec(path);
      if (searchMatch) {
        method(req, 'GET');
        json(res, 200, await searchReferences(decode(searchMatch[1]), url.searchParams.get('q')));
        return true;
      }
      const textMatch = /^\/api\/courses\/([^/]+)\/references\/([^/]+)\/text$/.exec(path);
      if (textMatch) {
        method(req, 'POST');
        const value = await body(req);
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'ocr')
            || value.ocr !== undefined && typeof value.ocr !== 'boolean') fail(400, '正文提取参数无效。');
        json(res, 202, await startReferenceExtraction(decode(textMatch[1]), decode(textMatch[2]), value.ocr === true));
        return true;
      }
      const referenceMatch = /^\/api\/courses\/([^/]+)\/references(?:\/([^/]+)(\/file)?)?$/.exec(path);
      if (referenceMatch) {
        const id = decode(referenceMatch[1]);
        const referenceId = referenceMatch[2] && decode(referenceMatch[2]);
        if (!referenceId) {
          method(req, 'GET', 'POST');
          if (req.method === 'GET') json(res, 200, await listReferences(id));
          else {
            try {
              if (Number(req.headers['content-length']) > 100 * 1024 * 1024) fail(413, '单份辅助资料最大 100 MiB（104857600 字节）。');
              const filename = decode(typeof req.headers['x-filename'] === 'string' ? req.headers['x-filename'] : '');
              const reference = await importReference(id, req, filename);
              json(res, 201, await startReferenceExtraction(id, reference.id));
            } catch (error) { req.resume(); throw error; }
          }
        } else if (referenceMatch[3]) {
          method(req, 'GET', 'HEAD');
          const file = await getReferenceFile(id, referenceId);
          await serveFile(req, res, file.path, file.filename);
        } else {
          method(req, 'PATCH', 'DELETE');
          json(res, 200, req.method === 'PATCH'
            ? await updateReference(id, referenceId, await body(req)) : await deleteReference(id, referenceId));
        }
        return true;
      }
      const nodeMatch = /^\/api\/courses\/([^/]+)\/artifacts\/([^/]+)\/nodes\/([^/]+)$/.exec(path);
      if (nodeMatch) {
        method(req, 'PATCH');
        json(res, 200, await updateMindmapNode(decode(nodeMatch[1]), decode(nodeMatch[2]), decode(nodeMatch[3]), await body(req)));
        return true;
      }
      const match = /^\/api\/courses\/([^/]+)\/(state|textbook|pages\/(\d+)|outputs\/(.+)|conversations(?:\/([^/]+))?|migrate)$/.exec(path);
      if (!match) fail(404, '没有找到这个课程接口。');
      const id = decode(match[1]);
      const action = match[2];
      if (action === 'state') {
        method(req, 'GET', 'PUT');
        json(res, 200, req.method === 'GET' ? await getState(id) : await saveState(id, await body(req)));
      } else if (action === 'textbook') {
        method(req, 'GET', 'HEAD', 'PATCH');
        if (req.method === 'PATCH') json(res, 200, await updateTextbook(id, await body(req)));
        else await serveFile(req, res, await resolveCourseFile(id, 'textbook.pdf'));
      } else if (match[3]) {
        method(req, 'PUT');
        const value = await body(req);
        json(res, 200, await savePage(id, Number(match[3]), value?.text));
      } else if (match[4]) {
        method(req, 'GET', 'HEAD');
        await serveFile(req, res, await resolveCourseFile(id, `outputs/${decode(match[4])}`));
      } else if (action.startsWith('conversations')) {
        method(req, 'GET');
        json(res, 200, match[5] ? await getConversation(id, decode(match[5])) : await listConversations(id));
      } else if (action === 'migrate') {
        method(req, 'POST');
        json(res, 200, await migrateState(id, await body(req)));
      }
    }
  } catch (error) {
    if (res.headersSent) { if (!res.destroyed) res.destroy(); return true; }
    const status = error.status || (['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500);
    if (status === 500) console.error(error);
    const message = error.status ? error.message : status === 404 ? '课程文件不存在。' : '个人课程目录暂时无法读写，请检查目录权限。';
    json(res, status, { error: message });
  }
  return true;
}
