import { pageRangeError } from '../shared/page-range.mjs';
import { chmod, copyFile, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMindmapNode } from '../shared/mindmap-text.mjs';
import { validateKnowledgeGraph } from '../skills/knowledge-graph/scripts/validate-knowledge-graph.mjs';
import { slideTemplates } from './slide-templates.mjs';
import { extractReferenceText, searchReferenceText } from './reference-text.mjs';

const configuredHome = process.env.COURSE_COPILOT_HOME || resolve(homedir(), '.course-copilot');
let directory = resolve(configuredHome.replace(/^~(?=\/|$)/, homedir()));
let initialization;
const writes = new Map();
const generationSnapshots = new Map();
const referenceExtractions = new Map();
let referenceExtractionQueue = Promise.resolve();
const pdfLimit = 100 * 1024 * 1024;

export function disposeReferenceExtractions() {
  for (const job of referenceExtractions.values()) job.controller.abort();
}

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function recordName(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 180) fail(400, '记录名称无效。');
  const name = encodeURIComponent(id);
  if (name.length > 220) fail(400, '记录名称过长。');
  return name;
}

function serial(key, work) {
  const previous = writes.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  writes.set(key, current);
  void current.finally(() => { if (writes.get(key) === current) writes.delete(key); }).catch(() => {});
  return current;
}

function updateGenerationSnapshots(id, artifact) {
  for (const snapshot of generationSnapshots.get(id) || []) {
    snapshot.set(artifact.id, structuredClone(artifact));
  }
}

// 所有课程文件都从个人目录逐层访问，不穿过符号链接。
async function safePath(...parts) {
  const target = resolve(directory, ...parts);
  const local = relative(directory, target);
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) fail(400, '文件路径超出了个人课程目录。');
  let current = directory;
  for (const part of local.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) fail(400, '课程文件不能使用符号链接。');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

async function makeDirectory(...parts) {
  const path = await safePath(...parts);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function readJson(path, fallback) {
  await safePath(path);
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function writeFile(path, content) {
  await safePath(path);
  const temporary = resolve(dirname(path), `.writing-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.close();
    await safePath(path);
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
}
function writeJson(path, value) { return writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }

async function courseRecords() {
  const coursesPath = await safePath('courses');
  const entries = await readdir(coursesPath, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const courseDir = await safePath(coursesPath, entry.name);
    const meta = await readJson(resolve(courseDir, 'textbook/course.json'));
    if (meta?.id) records.push({ ...meta, courseDir });
  }
  return records.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}

async function courseRecord(id) {
  recordName(id);
  await initializeStore();
  const record = (await courseRecords()).find((item) => item.id === id);
  if (!record) fail(404, '没有找到这门课程。');
  return record;
}

async function bookFrom(record) {
  const chapters = await readJson(resolve(record.courseDir, 'textbook/outline.json'), []);
  const { id, title, filename, totalPages, initialPage, source, courseDir } = record;
  return { id, title, filename, totalPages, initialPage, source, chapters,
    directory: courseDir, url: `/api/courses/${encodeURIComponent(id)}/textbook` };
}

function courseTitle(filename) {
  let title = filename.replace(/\.pdf$/i, '').replace(/[\x00-\x1f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 80);
  while (Buffer.byteLength(title) > 220) title = [...title].slice(0, -1).join('');
  return title || '未命名教材';
}

async function reserveCourse(title) {
  for (let suffix = 1; ; suffix++) {
    const folder = suffix === 1 ? title : `${title} (${suffix})`;
      const path = await safePath('courses', folder);
      try {
        await mkdir(path, { mode: 0o700 });
        for (const child of ['textbook', 'textbook/pages', 'textbook/images', 'conversations', 'outputs',
          'outputs/notes', 'outputs/slides', 'outputs/quizzes', 'outputs/mindmaps', 'outputs/knowledge-graphs',
          'outputs/videos', 'outputs/files', `outputs/${BUILD_DIR}`, `outputs/${BUILD_ARTIFACTS}`]) {
          await makeDirectory(path, child);
        }
        return path;
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

async function writeNewCourse(courseDir, data, chapters) {
  const metadata = { ...data, createdAt: new Date().toISOString() };
  await writeJson(resolve(courseDir, 'textbook/outline.json'), chapters);
  await writeJson(resolve(courseDir, 'reading.json'), {
    page: data.initialPage || 1, bookmarks: [], notes: [], conversationId: randomUUID(),
  });
  await writeJson(resolve(courseDir, 'textbook/course.json'), metadata);
  return bookFrom({ ...metadata, courseDir });
}

export function initializeStore() {
  if (!initialization) initialization = (async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    directory = await realpath(directory);
    await chmod(directory, 0o700);
    await makeDirectory('courses');
    const settingsPath = await safePath('settings.json');
    if (await readJson(settingsPath) === undefined) await writeJson(settingsPath, {});
    else await chmod(settingsPath, 0o600);
    if ((await courseRecords()).length) return;
    let bundled;
    try { bundled = JSON.parse(await readFile(new URL('../src/data/textbook.json', import.meta.url), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const original = fileURLToPath(new URL(`../${bundled.filename}`, import.meta.url));
    try { await stat(original); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const courseDir = await reserveCourse(courseTitle(bundled.title));
    try {
      await copyFile(original, resolve(courseDir, 'textbook.pdf'));
      await chmod(resolve(courseDir, 'textbook.pdf'), 0o600);
      await writeNewCourse(courseDir, {
        id: 'optimization', title: bundled.title, filename: bundled.filename,
        totalPages: bundled.totalPages, initialPage: bundled.initialPage || 1, source: 'included',
      }, bundled.chapters || []);
    } catch (error) { await rm(courseDir, { recursive: true, force: true }); throw error; }
  })().catch((error) => { initialization = undefined; throw error; });
  return initialization;
}

export async function getStorageInfo() {
  await initializeStore();
  return { directory, settings: await readJson(resolve(directory, 'settings.json'), {}) };
}

// Agent 设置只包含程序位置、模型和 Skill 路径；账号凭据由 Agent 自己保存。
export async function saveAgentSettings(value) {
  await initializeStore();
  return serial('settings', async () => {
    const path = resolve(directory, 'settings.json');
    const settings = await readJson(path, {});
    settings.agent = value;
    await writeJson(path, settings);
    return settings.agent;
  });
}

export async function updateSettings(value) {
  await initializeStore();
  if (!object(value)) fail(400, '个人设置格式不正确。');
  return serial('settings', async () => {
    const path = resolve(directory, 'settings.json');
    const settings = await readJson(path, {});
    if (value.activeCourseId !== undefined) {
      await courseRecord(value.activeCourseId);
      settings.activeCourseId = value.activeCourseId;
    }
    if (value.columnWidths !== undefined) {
      if (!object(value.columnWidths)) fail(400, '栏宽设置格式不正确。');
      settings.columnWidths = {};
      for (const key of ['sidebar', 'copilot']) {
        if (value.columnWidths[key] === undefined) continue;
        const width = value.columnWidths[key];
        if (!Number.isFinite(width) || width < 0 || width > 5000) fail(400, '栏宽设置超出了可用范围。');
        settings.columnWidths[key] = width;
      }
    }
    await writeJson(path, settings);
    return settings;
  });
}

export async function listCourses() {
  await initializeStore();
  return Promise.all((await courseRecords()).map(bookFrom));
}

export async function importCourse(stream, filename, legacyId) {
  await initializeStore();
  if (legacyId !== undefined) recordName(legacyId);
  return serial('create-course', async () => {
    if (legacyId) {
      const existing = (await courseRecords()).find((item) => item.legacyId === legacyId);
      if (existing) { stream.resume(); return bookFrom(existing); }
    }
    const name = basename(filename.replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '').slice(0, 180) || '教材.pdf';
    const title = courseTitle(name);
    const courseDir = await reserveCourse(title);
    let handle;
    try {
      handle = await open(resolve(courseDir, 'textbook.pdf'), 'wx', 0o600);
      const hash = createHash('sha256');
      let size = 0;
      let prefix = Buffer.alloc(0);
      for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        hash.update(chunk);
        if (size > pdfLimit) fail(413, '教材超过了 100 MB，请压缩 PDF 后重试。');
        if (prefix.length < 5) {
          prefix = Buffer.concat([prefix, chunk.subarray(0, 5 - prefix.length)]);
          if (prefix.length === 5 && prefix.toString('ascii') !== '%PDF-') fail(400, '请上传有效的 PDF 教材。');
        }
        await handle.writeFile(chunk);
      }
      if (prefix.length < 5) fail(400, 'PDF 文件为空或不完整。');
      const sha256 = hash.digest('hex');
      await handle.close();
      handle = undefined;
      // 同一本教材（按文件指纹）再次上传时复用已有课程，不新建带 (2) 的文件夹。
      const duplicate = (await courseRecords()).find((item) => item.sha256 && item.sha256 === sha256);
      if (duplicate) {
        await rm(courseDir, { recursive: true, force: true });
        return bookFrom(duplicate);
      }
      return await writeNewCourse(courseDir, {
        id: randomUUID(), title, filename: name, initialPage: 1, source: 'imported', sha256,
        ...(legacyId ? { legacyId } : {}),
      }, []);
    } catch (error) {
      stream.resume();
      await handle?.close().catch(() => {});
      await rm(courseDir, { recursive: true, force: true });
      throw error;
    }
  });
}

export async function getCoursePaths(id) {
  const { courseDir, totalPages } = await courseRecord(id);
  return {
    courseDir, totalPages, textbookPath: await safePath(courseDir, 'textbook.pdf'),
    textbookDir: await safePath(courseDir, 'textbook'), outputsDir: await safePath(courseDir, 'outputs'),
  };
}

const referenceExtensions = new Set(['.pdf', '.txt', '.md', '.docx', '.pptx', '.png', '.jpg', '.jpeg', '.webp']);
const referenceLimit = 100 * 1024 * 1024;
function referenceDirectoryName(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) fail(400, '辅助资料编号无效。');
  return id;
}
function referenceInfo(courseId, metadata) {
  const job = referenceExtractions.get(`${courseId}/${metadata.id}`);
  const textIndex = job ? { status: job.status, processedPages: job.processedPages, totalPages: job.totalPages }
    : metadata.textIndex || { status: 'pending' };
  return { ...metadata, textIndex, url: `/api/courses/${encodeURIComponent(courseId)}/references/${metadata.id}/file` };
}
async function referenceRecord(record, referenceId) {
  const path = await safePath(record.courseDir, 'references', referenceDirectoryName(referenceId));
  const metadata = await readJson(resolve(path, 'metadata.json'));
  if (!metadata) fail(404, '没有找到这份辅助资料。');
  if (metadata.id !== referenceId || typeof metadata.filename !== 'string'
      || basename(metadata.filename) !== metadata.filename || metadata.filename.includes('\\')
      || !referenceExtensions.has(extname(metadata.filename).toLowerCase())) fail(400, '辅助资料记录格式不正确。');
  return { path, metadata };
}

export async function listReferences(id) {
  const record = await courseRecord(id);
  const directory = await safePath(record.courseDir, 'references');
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const references = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    try {
      const { metadata } = await referenceRecord(record, entry.name);
      references.push(referenceInfo(id, metadata));
    } catch (error) { if (error.status !== 404 && error.code !== 'ENOENT') throw error; }
  }
  return references.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function importReference(id, stream, filename) {
  const record = await courseRecord(id);
  const name = basename(filename.replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '').trim();
  if (!name || Buffer.byteLength(name) > 220 || !referenceExtensions.has(extname(name).toLowerCase())) {
    fail(400, '请选择 PDF、TXT、Markdown、DOCX、PPTX 或 PNG、JPEG、WebP 图片，文件名最多 220 字节。');
  }
  return serial(id, async () => {
    const referenceId = randomUUID();
    const path = await makeDirectory(record.courseDir, 'references', referenceId);
    let handle;
    try {
      handle = await open(resolve(path, name), 'wx', 0o600);
      let size = 0;
      let prefix = Buffer.alloc(0);
      for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > referenceLimit) fail(413, '单份辅助资料最大 100 MiB（104857600 字节）。');
        if (prefix.length < 5) prefix = Buffer.concat([prefix, chunk.subarray(0, 5 - prefix.length)]);
        await handle.writeFile(chunk);
      }
      if (!size) fail(400, '辅助资料文件为空。');
      if (extname(name).toLowerCase() === '.pdf' && prefix.toString('ascii') !== '%PDF-') fail(400, '请上传有效的 PDF 文件。');
      await handle.close(); handle = undefined;
      const metadata = { id: referenceId, title: name, filename: name, description: '', size,
        format: extname(name).slice(1).toLowerCase(), createdAt: new Date().toISOString() };
      await writeJson(resolve(path, 'metadata.json'), metadata);
      return referenceInfo(id, metadata);
    } catch (error) {
      stream.resume();
      await handle?.close().catch(() => {});
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  });
}

export async function updateReference(id, referenceId, value) {
  if (!object(value) || Object.keys(value).some(key => !['title', 'description'].includes(key))
      || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200
      || typeof value.description !== 'string' || value.description.length > 2000) fail(400, '请填写资料名称（最多 200 字符）和说明（最多 2000 字符）。');
  const record = await courseRecord(id);
  return serial(id, async () => {
    const { path, metadata } = await referenceRecord(record, referenceId);
    const updated = { ...metadata, title: value.title.trim(), description: value.description.trim() };
    await writeJson(resolve(path, 'metadata.json'), updated);
    return referenceInfo(id, updated);
  });
}

export async function deleteReference(id, referenceId) {
  const record = await courseRecord(id);
  return serial(id, async () => {
    if (generationSnapshots.get(id)?.size) fail(409, 'Agent 正在使用这门课程的资料，请在任务结束后删除。');
    const { path } = await referenceRecord(record, referenceId);
    referenceExtractions.get(`${id}/${referenceId}`)?.controller.abort();
    await rm(path, { recursive: true });
    return { deleted: true };
  });
}

export async function getReferenceFile(id, referenceId) {
  const record = await courseRecord(id);
  const { path, metadata } = await referenceRecord(record, referenceId);
  const file = await safePath(path, metadata.filename);
  if (!(await stat(file)).isFile()) fail(404, '辅助资料文件不存在。');
  return { path: file, filename: metadata.filename };
}

export async function getCourseReferences(id, referenceIds) {
  const available = await listReferences(id);
  const references = referenceIds === undefined ? available : [...new Set(referenceIds)].map(referenceId => {
    const item = available.find(reference => reference.id === referenceId);
    if (!item) fail(404, '所选辅助资料已删除或属于其他课程，请重新选择。');
    return item;
  });
  return Promise.all(references.map(async item => {
    const file = await getReferenceFile(id, item.id);
    const textPath = await safePath(dirname(file.path), 'text.json');
    return { ...item, path: file.path, ...((await stat(textPath).catch(() => null))?.isFile() ? { textPath } : {}) };
  }));
}

export async function startReferenceExtraction(id, referenceId, ocr = false) {
  const record = await courseRecord(id);
  return serial(id, async () => {
    const { path, metadata } = await referenceRecord(record, referenceId);
    const key = `${id}/${referenceId}`;
    if (referenceExtractions.has(key)) return referenceInfo(id, metadata);
    const job = { status: 'queued', processedPages: 0, totalPages: 0, controller: new AbortController() };
    referenceExtractions.set(key, job);
    const run = async () => {
      const signal = job.controller.signal;
      try {
        signal.throwIfAborted();
        job.status = 'processing';
        const file = await safePath(path, metadata.filename);
        const index = await extractReferenceText({ path: file, format: metadata.format, ocr, signal,
          onProgress: (processed, total) => { job.processedPages = processed; job.totalPages = total; } });
        await serial(id, async () => {
          signal.throwIfAborted();
          const current = await referenceRecord(record, referenceId);
          await writeJson(resolve(current.path, 'text.json'), index);
          await writeJson(resolve(current.path, 'metadata.json'), { ...current.metadata,
            textIndex: { status: 'ready', totalPages: index.pages.length, needsOcr: index.needsOcr,
              message: index.warnings.slice(0, 5).join(' '), extractedAt: index.extractedAt } });
        });
      } catch (error) {
        if (!signal.aborted) await serial(id, async () => {
          if (signal.aborted) return;
          const current = await referenceRecord(record, referenceId);
          await writeJson(resolve(current.path, 'metadata.json'), { ...current.metadata,
            textIndex: { ...current.metadata.textIndex, status: 'error', message: error.message } });
        }).catch(error => console.error('辅助资料提取结果保存失败：', error.message));
      } finally { if (referenceExtractions.get(key) === job) referenceExtractions.delete(key); }
    };
    referenceExtractionQueue = referenceExtractionQueue.catch(() => {}).then(run);
    return referenceInfo(id, metadata);
  });
}

export async function searchReferences(id, query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 160) fail(400, '请输入 1 至 160 个字符的搜索文字。');
  const record = await courseRecord(id);
  const references = await listReferences(id);
  const hits = [];
  let total = 0, indexing = false, indexedDocuments = 0;
  for (const reference of references) {
    if (reference.textIndex.status === 'pending') {
      await startReferenceExtraction(id, reference.id); indexing = true;
    } else if (['queued', 'processing'].includes(reference.textIndex.status)) indexing = true;
    const { path } = await referenceRecord(record, reference.id);
    const index = await readJson(resolve(path, 'text.json'));
    if (!index) continue;
    indexedDocuments++;
    for (const hit of searchReferenceText(index, query)) {
      total++;
      if (hits.length < 100) hits.push({ ...hit, referenceId: reference.id, title: reference.title,
        location: hit.slide ? `第 ${hit.slide} 张幻灯片` : hit.paragraph ? `第 ${hit.paragraph} 段` : reference.format === 'pdf' ? `PDF 第 ${hit.page} 页` : '图片',
        url: reference.url + (reference.format === 'pdf' && hit.page ? `#page=${hit.page}` : '') });
    }
  }
  return { query: query.trim(), hits, total, indexing, indexedDocuments, totalDocuments: references.length };
}

function outputRelative(filename) {
  if (typeof filename !== 'string' || !filename || filename.includes('\\') || filename.includes('\0')
      || filename.split('/').some((part) => !part || part === '.' || part === '..') || isAbsolute(filename)) {
    fail(400, '生成文件路径不正确。');
  }
  return filename;
}

// 成品与机器文件分开放：人看的文档进 outputs/<类型>/，编译树、解析缓存和结果 JSON 进 outputs/.build/。
const BUILD_DIR = '.build';
const BUILD_ARTIFACTS = `${BUILD_DIR}/artifacts`;

export function outputUrl(courseId, relativeFilename) {
  return `/api/courses/${encodeURIComponent(courseId)}/outputs/${outputRelative(relativeFilename).split('/').map(encodeURIComponent).join('/')}`;
}

// 成品相对 outputs 的路径按扩展名归入类型子目录；结果 JSON 与编译/解析产物归入 .build。
function classifyOutputPath(relativePath) {
  const ext = extname(relativePath.split('/').pop() || '').toLowerCase();
  if (ext === '.pdf' || ext === '.zip') return `slides/${relativePath}`;
  if (ext === '.mp4' || ext === '.webm' || ext === '.mp3' || ext === '.wav') return `videos/${relativePath}`;
  if (ext === '.md' || ext === '.svg' || ext === '.png' || ext === '.jpg' || ext === '.jpeg'
      || ext === '.webp' || ext === '.tex' || ext === '.json' || ext === '.txt' || ext === '') return `notes/${relativePath}`;
  return `files/${relativePath}`;
}

const TYPE_SUBDIRS = new Set(['notes', 'slides', 'quizzes', 'mindmaps', 'knowledge-graphs', 'videos', 'files', BUILD_DIR]);

// Agent 仍写入 outputs 根目录；服务把成品归入类型子目录、结果 JSON 与编译/解析产物归入 .build。
// 已带类型或 .build 前缀的路径保持不变（幂等），避免二次分类叠成 notes/notes。
function normalizeOutputRelative(record, relativePath) {
  const parts = relativePath.split('/').filter(Boolean);
  const top = parts[0] || '';
  if (TYPE_SUBDIRS.has(top)) return relativePath;
  if (/^(slides-|quiz-|mindmap-|knowledge-|video-|reading-|selection-|demo-)/.test(top) || /-(parse|source)-\d{8}$/.test(top)) return `${BUILD_DIR}/${relativePath}`;
  const base = parts[parts.length - 1];
  if (/^pending-.*\.json$/.test(base) || /^result-.*\.json$/.test(base)) return `${BUILD_ARTIFACTS}/${relativePath}`;
  return classifyOutputPath(relativePath);
}

export async function resolveCourseFile(id, filename) {
  if (filename !== 'textbook.pdf' && !filename.startsWith('outputs/')) fail(404, '没有找到这个课程文件。');
  outputRelative(filename);
  const { courseDir } = await courseRecord(id);
  const path = await safePath(courseDir, filename);
  const info = await stat(path);
  if (!info.isFile()) fail(404, '没有找到这个课程文件。');
  await chmod(path, 0o600);
  return path;
}

function normalizeArtifactSource(source) {
  if (!object(source) || !['page', 'section', 'chapter', 'selection', 'range', 'book'].includes(source.scope)
      || !positive(source.page)
      || !['chapterId', 'sectionId'].every(key => source[key] === undefined
        || (typeof source[key] === 'string' && source[key].trim()))) return undefined;
  if (source.scope === 'range' && (pageRangeError(source.pageRange) || source.page !== source.pageRange.start)) return undefined;
  return {
    scope: source.scope, page: source.page,
    ...(source.scope === 'range' ? { pageRange: { start: source.pageRange.start, end: source.pageRange.end } } : {}),
    ...(source.chapterId === undefined ? {} : { chapterId: source.chapterId }),
    ...(source.sectionId === undefined ? {} : { sectionId: source.sectionId }),
  };
}

function normalizeArtifact(record, artifact, options = {}) {
  if (!object(artifact) || typeof artifact.title !== 'string'
      || !['markdown', 'quiz', 'mindmap', 'knowledge-graph', 'slides', 'video', 'file'].includes(artifact.kind)) {
    fail(400, '生成结果格式不正确。');
  }
  recordName(artifact.id);
  if (artifact.kind === 'markdown' && typeof artifact.content !== 'string') fail(400, '文字资料缺少正文。');
  if (artifact.kind === 'quiz') {
    if (!Array.isArray(artifact.questions) || !artifact.questions.length || !artifact.questions.every(question => object(question)
        && typeof question.id === 'string' && question.id.trim()
        && typeof question.prompt === 'string' && question.prompt.trim()
        && ['knowledgePoint', 'difficulty', 'answer', 'explanation'].every(key => question[key] === undefined || typeof question[key] === 'string')
        && (question.page === undefined || positive(question.page) && (!record.totalPages || question.page <= record.totalPages))
        && (question.hints === undefined || Array.isArray(question.hints) && question.hints.every(hint => typeof hint === 'string' && hint.trim())))) {
      fail(400, '练习卡片需要有效的题目、提示和参考答案字段。');
    }
    if (new Set(artifact.questions.map(question => question.id)).size !== artifact.questions.length) fail(400, '练习题的 id 不能重复。');
  }
  if (artifact.kind === 'slides') {
    if (artifact.templateId !== undefined && !slideTemplates.some(template => template.id === artifact.templateId)) fail(400, '课件模板名称不正确。');
    if (artifact.slides !== undefined && (!Array.isArray(artifact.slides) || !artifact.slides.every((slide) => object(slide)
        && typeof slide.title === 'string' && typeof slide.content === 'string'))) fail(400, '课件页面需要包含标题和正文。');
    if (artifact.chapters !== undefined && (!Array.isArray(artifact.chapters) || !artifact.chapters.length
        || !artifact.chapters.every((chapter) => object(chapter) && typeof chapter.title === 'string' && chapter.title.trim()
          && typeof chapter.url === 'string' && /\.pdf$/i.test(chapter.url)
          && (chapter.filename === undefined || typeof chapter.filename === 'string')))) fail(400, '章节课件需要包含标题和 PDF 文件地址。');
    if (!Array.isArray(artifact.slides) && !artifact.chapters?.length) fail(400, '课件需要包含页面内容或章节 PDF。');
    if (artifact.sourceUrl !== undefined && (typeof artifact.sourceUrl !== 'string' || !/\.zip$/i.test(artifact.sourceUrl))) {
      fail(400, '课件源文件需要使用 ZIP 文件地址。');
    }
  }
  if (['mindmap', 'knowledge-graph'].includes(artifact.kind)) {
    if (!Array.isArray(artifact.nodes) || !artifact.nodes.every((node) => object(node) && typeof node.id === 'string'
        && node.id.trim() && typeof node.label === 'string' && (node.page === undefined || positive(node.page))
        && (node.originalLabel === undefined || typeof node.originalLabel === 'string')
        && (node.userText === undefined || typeof node.userText === 'string'))
        || !Array.isArray(artifact.edges) || !artifact.edges.every((edge) => object(edge)
        && typeof edge.source === 'string' && typeof edge.target === 'string'
        && (edge.label === undefined || typeof edge.label === 'string'))) fail(400, '知识结构需要有效的知识点和连线列表。');
    if (new Set(artifact.nodes.map((node) => node.id)).size !== artifact.nodes.length) fail(400, '知识点名称重复，请为每个知识点使用不同的 id。');
  }
  if (artifact.kind === 'knowledge-graph' && artifact.schemaVersion !== undefined) {
    try {
      validateKnowledgeGraph(artifact, artifact.id, record.totalPages, {
        historicalRead: options.historicalRead,
      });
    }
    catch (error) { fail(400, `知识图谱格式不正确：${error.message}`); }
  }
  if (artifact.filename !== undefined && typeof artifact.filename !== 'string') fail(400, '生成文件名格式不正确。');
  if ((['video', 'file'].includes(artifact.kind) || artifact.url !== undefined)
      && (typeof artifact.url !== 'string' || !artifact.url.trim())) fail(400, '生成文件缺少本地文件地址。');
  const result = { ...artifact };
  if (result.kind === 'mindmap') result.nodes = result.nodes.map(normalizeMindmapNode);
  // 范围只是可选排序信息，旧结果里不合规范的范围不能使整份资料消失。
  const source = normalizeArtifactSource(result.source);
  if (source) result.source = source;
  else delete result.source;
  if (result.url !== undefined) result.url = normalizeOutputUrl(record, result.url);
  if (result.kind === 'slides') {
    if (result.sourceUrl !== undefined) result.sourceUrl = normalizeOutputUrl(record, result.sourceUrl);
    if (result.chapters) result.chapters = result.chapters.map(chapter => ({ ...chapter, url: normalizeOutputUrl(record, chapter.url) }));
  }
  return result;
}

function normalizeOutputUrl(record, url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) {
    fail(400, '生成文件应保存在当前课程的 outputs 文件夹，并使用本地文件地址。');
  }
  const prefix = `/api/courses/${encodeURIComponent(record.id)}/outputs/`;
  let local;
  if (url.startsWith(prefix)) {
    try { local = decodeURIComponent(url.slice(prefix.length)); }
    catch { fail(400, '生成文件地址的编码不正确。'); }
  } else {
    const outputs = resolve(record.courseDir, 'outputs');
    local = (isAbsolute(url) ? relative(outputs, url) : url.replace(/^outputs\//, '')).split(sep).join('/');
  }
  return outputUrl(record.id, normalizeOutputRelative(record, local));
}

async function writeArtifact(record, artifact, options = {}) {
  if (!object(artifact) || typeof artifact.id !== 'string') fail(400, '生成结果格式不正确。');
  recordName(artifact.id);
  const path = await safePath(record.courseDir, 'outputs', BUILD_ARTIFACTS, `result-${recordName(artifact.id)}.json`);
  const snapshot = [...(generationSnapshots.get(record.id) || [])].find(items => items.has(artifact.id));
  if (options.preserveExisting) {
    const rawExisting = snapshot?.get(artifact.id) ?? await readJson(path);
    if (rawExisting !== undefined) return normalizeArtifact(record, rawExisting, { historicalRead: true });
  }
  const result = normalizeArtifact(record, artifact, options);
  const urls = [result.url, ...(result.kind === 'slides' ? [result.sourceUrl, ...(result.chapters || []).map(chapter => chapter.url)] : [])].filter(Boolean);
  for (const url of new Set(urls)) {
    const prefix = `/api/courses/${encodeURIComponent(record.id)}/outputs/`;
    let local;
    try { local = decodeURIComponent(url.slice(prefix.length)); }
    catch { fail(400, '生成文件地址的编码不正确。'); }
    const targetRel = outputRelative(local);
    const target = await safePath(record.courseDir, 'outputs', targetRel);
    let present = true;
    try { if (!(await stat(target)).isFile()) present = false; } catch { present = false; }
    if (!present) {
      // Agent 把成品写在 outputs 根目录；服务按类型归入子目录。
      const rootFile = await safePath(record.courseDir, 'outputs', targetRel.split('/').pop());
      try {
        if ((await stat(rootFile)).isFile()) {
          await makeDirectory(record.courseDir, 'outputs', dirname(targetRel));
          await rename(rootFile, target);
          present = true;
        }
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    if (!present) {
      const buildTarget = await safePath(record.courseDir, 'outputs', BUILD_DIR, targetRel);
      try {
        if ((await stat(buildTarget)).isFile()) { await rename(buildTarget, target); present = true; }
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    if (!present) fail(400, '生成文件不存在，请先让 Coding Agent 将文件写入当前课程的 outputs 文件夹。');
    await chmod(target, 0o600);
  }
  await writeJson(path, result);
  updateGenerationSnapshots(record.id, result);
  return result;
}

export async function saveArtifact(id, artifact) {
  const record = await courseRecord(id);
  return serial(id, () => writeArtifact(record, artifact));
}

function sourceForRequest(request, outline) {
  const source = normalizeArtifactSource({ scope: request.scope, page: request.page, pageRange: request.pageRange });
  if (!source || source.scope === 'book') return source;
  const chapters = (Array.isArray(outline) ? outline : []).filter(item => object(item)
    && typeof item.id === 'string' && item.id.trim() && positive(item.page)
    && Number.isInteger(item.level) && item.level >= 0);
  let chapterIndex = -1;
  chapters.forEach((item, index) => {
    if (item.level === 0 && item.page <= source.page
        && (chapterIndex < 0 || item.page >= chapters[chapterIndex].page)) chapterIndex = index;
  });
  const requestedIndex = chapters.findIndex(item => item.id === request.chapter?.id && item.page <= source.page);
  // 请求里的目录 ID 表示用户选定的范围；级别和父子关系仍取自本课程的真实目录。
  if (source.scope === 'chapter' && chapters[requestedIndex]?.level === 0) chapterIndex = requestedIndex;
  if (source.scope === 'section' && chapters[requestedIndex]?.level === 1) {
    chapterIndex = -1;
    for (let index = requestedIndex - 1; index >= 0; index--) {
      if (chapters[index].level === 0) { chapterIndex = index; break; }
    }
  }
  let sectionIndex = -1;
  if (chapterIndex >= 0) {
    source.chapterId = chapters[chapterIndex].id;
    for (let index = chapterIndex + 1; index < chapters.length; index++) {
      const item = chapters[index];
      if (item.level === 0) break;
      if (item.level === 1 && item.page >= chapters[chapterIndex].page && item.page <= source.page
          && (sectionIndex < 0 || item.page >= chapters[sectionIndex].page)) sectionIndex = index;
    }
  }
  if (source.scope === 'section' && chapters[requestedIndex]?.level === 1) sectionIndex = requestedIndex;
  if (source.scope !== 'chapter' && sectionIndex >= 0) source.sectionId = chapters[sectionIndex].id;
  return source;
}

// 在启动 Agent 前调用：Agent 会直接写 outputs，不能把本次模型写入的 source 当成历史范围。
export async function createGeneratedArtifactSaver(id, request) {
  const record = await courseRecord(id);
  const { existing, source, inherited, graphInherited, conceptCatalogPath } = await serial(id, async () => {
    const saved = await artifactsFor(record);
    const existing = new Map(saved.map(artifact => [artifact.id, artifact]));
    const outline = await readJson(resolve(record.courseDir, 'textbook/outline.json'), []);
    const context = request.skillId === 'chat' && request.artifact?.kind === 'mindmap' ? request.artifact : undefined;
    const original = context && existing.get(context.id);
    const inherited = context && (!original || original.kind === 'mindmap')
      ? normalizeArtifactSource(original ? original.source : context.source) : undefined;
    const graphContext = request.skillId === 'chat' && request.artifact?.kind === 'knowledge-graph'
      ? existing.get(request.artifact.id) : undefined;
    const graphInherited = graphContext?.kind === 'knowledge-graph'
      ? normalizeArtifactSource(graphContext.source) : undefined;
    const source = context ? undefined : sourceForRequest(request, outline);
    let conceptCatalogPath;
    if (request.skillId === 'knowledge-graph' || request.skillId === 'chat') {
      // Naming hints only. A repeated label does not establish equal meaning or textbook evidence.
      const concepts = new Map();
      for (const artifact of saved) {
        if (artifact.kind !== 'knowledge-graph') continue;
        for (const node of artifact.nodes) {
          if (typeof node.conceptKey !== 'string' || !node.conceptKey.trim()
              || typeof node.type !== 'string' || !node.type.trim()) continue;
          const key = JSON.stringify([node.conceptKey, node.type, node.label]);
          const known = concepts.get(key);
          const aliases = new Set([...(known?.aliases || []), ...(Array.isArray(node.aliases) ? node.aliases.filter(alias => typeof alias === 'string' && alias.trim()) : [])]);
          concepts.set(key, { conceptKey: node.conceptKey, type: node.type, label: node.label,
            aliases: [...aliases], ...(node.description ? { description: node.description } : {}) });
        }
      }
      if (concepts.size) {
        conceptCatalogPath = await safePath(record.courseDir, 'outputs', BUILD_DIR, 'knowledge-concepts.json');
        await writeJson(conceptCatalogPath, { concepts: [...concepts.values()] });
      }
    }
    const snapshots = generationSnapshots.get(id) || new Set();
    snapshots.add(existing);
    generationSnapshots.set(id, snapshots);
    return { existing, source, inherited, graphInherited, conceptCatalogPath };
  });
  const save = artifact => serial(id, async () => {
    const previous = existing.get(artifact?.id);
    try {
      // PDF loading may finish after generation started. Never validate against a stale
      // client-supplied count or a pre-load record captured before metadata was saved.
      if (artifact?.kind === 'knowledge-graph') record.totalPages = (await courseRecord(id)).totalPages;
      // 新生成的文字属于原文；用户补充只能来自已保存节点或专用 PATCH 接口。
      const incoming = artifact?.kind === 'mindmap' && Array.isArray(artifact.nodes)
        ? { ...artifact, nodes: artifact.nodes.map(node => {
          if (!object(node)) return node;
          const { userText, originalLabel, ...generated } = node;
          return generated;
        }) } : artifact;
      const result = normalizeArtifact(record, incoming);
      delete result.source;
      if (source?.scope === 'range' && !['mindmap', 'knowledge-graph'].includes(result.kind)) result.source = { ...source };
      if (result.kind === 'knowledge-graph') {
        // Only new generations require v2; legacy files stay readable as they are.
        try { validateKnowledgeGraph(result, result.id, record.totalPages, { requireV2: true }); }
        catch (error) { fail(400, `知识图谱未通过保存检查：${error.message}`); }
        const latestOutline = await readJson(resolve(record.courseDir, 'textbook/outline.json'), []);
        const scopedSource = source && { ...sourceForRequest(request, latestOutline), ...source };
        const trustedSource = previous?.kind === 'knowledge-graph' ? previous.source
          : request.skillId === 'chat' && request.artifact?.kind === 'knowledge-graph' ? graphInherited : scopedSource;
        if (trustedSource) result.source = { ...trustedSource };
      }
      if (previous?.kind === 'mindmap') {
        const retainedIds = new Set(result.kind === 'mindmap' ? result.nodes.map(node => node.id) : []);
        if (previous.nodes.some(node => node.userText && !retainedIds.has(node.id))) {
          fail(409, '这份导图仍有用户补充，已保留原资料。请生成新导图后再调整节点结构。');
        }
      }
      if (result.kind === 'mindmap') {
        const trustedSource = previous?.kind === 'mindmap' ? previous.source : inherited || source;
        if (trustedSource) result.source = { ...trustedSource };
        if (previous?.kind === 'mindmap') {
          const originalNodes = new Map(previous.nodes.map(node => [node.id, node]));
          result.nodes = result.nodes.map(node => {
            const original = originalNodes.get(node.id);
            return original ? {
              ...node, label: original.label, userText: original.userText,
              ...(original.originalLabel === undefined ? {} : { originalLabel: original.originalLabel }),
            } : node;
          });
        }
      }
      const saved = await writeArtifact(record, result);
      existing.set(saved.id, structuredClone(saved));
      updateGenerationSnapshots(id, saved);
      return saved;
    } catch (error) {
      // Agent 可能已覆盖同名文件；失败时恢复完整旧图，不能只拒绝流式事件。
      if (previous && (previous.kind === 'mindmap' || previous.kind === 'knowledge-graph' || artifact?.kind === 'knowledge-graph')) {
        await writeArtifact(record, previous, { historicalRead: true });
        updateGenerationSnapshots(id, previous);
      }
      throw error;
    }
  });
  save.knowledgeGraphContext = { conceptCatalogPath };
  save.dispose = () => {
    const snapshots = generationSnapshots.get(id);
    snapshots?.delete(existing);
    if (!snapshots?.size) generationSnapshots.delete(id);
  };
  return save;
}

export async function updateMindmapNode(id, artifactId, nodeId, value) {
  if (!object(value) || typeof value.userText !== 'string'
      || Object.keys(value).some(key => key !== 'userText')) fail(400, '只能编辑用户补充文字，不能修改生成原文。');
  const userText = value.userText;
  if (userText.length > 2000) fail(400, '补充文字不能超过 2000 个字符。');
  if (typeof nodeId !== 'string' || !nodeId.trim()) fail(400, '节点名称无效。');
  const filename = `result-${recordName(artifactId)}.json`;
  const record = await courseRecord(id);
  return serial(id, async () => {
    const path = await safePath(record.courseDir, 'outputs', BUILD_ARTIFACTS, filename);
    // 同 ID 生成进行中时，以生成前快照（含期间保存的补充）为准，避免读到 Agent 的临时覆盖。
    const snapshot = [...(generationSnapshots.get(id) || [])].find(items => items.has(artifactId));
    const saved = snapshot?.get(artifactId) ?? await readJson(path);
    if (saved === undefined) fail(404, '没有找到这份生成资料。');
    const artifact = normalizeArtifact(record, saved);
    if (artifact.id !== artifactId) fail(400, '生成资料的 ID 与文件名不一致。');
    if (artifact.kind !== 'mindmap') fail(400, '当前只支持编辑思维导图节点。');
    const node = artifact.nodes.find(item => item.id === nodeId);
    if (!node) fail(404, '没有找到这个思维导图节点。');
    if (node.userText === userText) return artifact;
    const updated = {
      ...artifact,
      nodes: artifact.nodes.map(item => item.id === nodeId
        ? { ...item, userText }
        : item),
    };
    const result = await writeArtifact(record, updated);
    updateGenerationSnapshots(id, result);
    return result;
  });
}

async function artifactsFor(record) {
  // Do not display an Agent's drafts or temporary overwrites during generation.
  const active = [...(generationSnapshots.get(record.id) || [])][0];
  if (active) return [...active.values()].map(artifact => structuredClone(artifact));
  const outputs = await safePath(record.courseDir, 'outputs', BUILD_ARTIFACTS);
  const files = await readdir(outputs, { withFileTypes: true }).catch(() => []);
  const artifacts = [];
  for (const file of files) {
    if (!file.isFile() || !/^result-.+\.json$/.test(file.name)) continue;
    try {
      const artifact = await readJson(resolve(outputs, file.name));
      if (artifact?.id) artifacts.push(normalizeArtifact(record, artifact, { historicalRead: true }));
    } catch (error) {
      // Agent 可能还在写这个文件；一个尚不能展示的结果不应挡住整门课程。
      if (!(error instanceof SyntaxError) && error.status !== 400) throw error;
    }
  }
  return artifacts;
}

function readingValues(value, initialPage) {
  if (!object(value)) fail(400, '阅读记录格式不正确。');
  const page = value.page ?? initialPage ?? 1;
  if (!positive(page)) fail(400, '阅读页码不正确。');
  const bookmarks = value.bookmarks ?? [];
  const notes = value.notes ?? [];
  if (!Array.isArray(bookmarks) || !bookmarks.every(positive)
      || !Array.isArray(notes) || !notes.every((note) => object(note) && typeof note.id === 'string' && positive(note.page) && typeof note.content === 'string')) {
    fail(400, '书签或笔记格式不正确。');
  }
  const conversationId = value.conversationId || randomUUID();
  recordName(conversationId);
  return { page, bookmarks: [...new Set(bookmarks)], notes, conversationId };
}

function validMessages(messages) {
  if (!Array.isArray(messages) || !messages.every((message) => object(message)
      && typeof message.id === 'string' && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string'
      && (message.artifacts === undefined || Array.isArray(message.artifacts)))) {
    fail(400, '对话记录格式不正确。');
  }
  return messages;
}

function latestMessageArtifacts(record, messages, artifacts) {
  const latest = new Map(artifacts.map(artifact => [artifact.id, artifact]));
  return validMessages(messages).map(message => {
    if (message.artifacts === undefined) return message;
    const resolved = [];
    for (const artifact of message.artifacts) {
      if (object(artifact) && typeof artifact.id === 'string' && latest.has(artifact.id)) {
        resolved.push(latest.get(artifact.id));
        continue;
      }
      try {
        resolved.push(normalizeArtifact(record, artifact, { historicalRead: true }));
      } catch (error) {
        if (error.status !== 400) throw error;
      }
    }
    return { ...message, artifacts: resolved };
  });
}

async function conversationFor(record, conversationId) {
  return readJson(resolve(record.courseDir, 'conversations', `${recordName(conversationId)}.json`));
}

async function stateFor(record) {
  const saved = await readJson(resolve(record.courseDir, 'reading.json'), {});
  const reading = readingValues(saved, record.initialPage);
  const conversation = await conversationFor(record, reading.conversationId);
  const artifacts = await artifactsFor(record);
  return { ...reading, messages: latestMessageArtifacts(record, conversation?.messages || [], artifacts), artifacts };
}

export async function getState(id) { return stateFor(await courseRecord(id)); }

async function saveMessages(record, conversationId, messages, extra = {}) {
  const normalized = [];
  for (const message of validMessages(messages)) {
    const artifacts = [];
    for (const artifact of message.artifacts || []) artifacts.push(await writeArtifact(record, artifact, { preserveExisting: true }));
    normalized.push({ ...message, ...(message.artifacts ? { artifacts } : {}) });
  }
  await writeJson(resolve(record.courseDir, 'conversations', `${recordName(conversationId)}.json`), {
    id: conversationId, messages: normalized, updatedAt: new Date().toISOString(), ...extra,
  });
}

export async function saveState(id, value) {
  const record = await courseRecord(id);
  return serial(id, async () => {
    const reading = readingValues(value, record.initialPage);
    validMessages(value.messages || []);
    if (!Array.isArray(value.artifacts || [])) fail(400, '生成结果列表格式不正确。');
    for (const artifact of value.artifacts || []) await writeArtifact(record, artifact, { preserveExisting: true });
    await saveMessages(record, reading.conversationId, value.messages || []);
    await writeJson(resolve(record.courseDir, 'reading.json'), { ...reading, updatedAt: new Date().toISOString() });
    return stateFor(record);
  });
}

export async function listConversations(id) {
  const record = await courseRecord(id);
  const path = await safePath(record.courseDir, 'conversations');
  const results = [];
  for (const file of await readdir(path, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue;
    const saved = await readJson(resolve(path, file.name));
    if (!saved?.id) continue;
    results.push({ id: saved.id, title: saved.messages?.find((message) => message.role === 'user')?.content.slice(0, 60) || '新对话',
      updatedAt: saved.updatedAt || '', messageCount: saved.messages?.length || 0 });
  }
  return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getConversation(id, conversationId) {
  const record = await courseRecord(id);
  const saved = await conversationFor(record, conversationId);
  if (!saved) fail(404, '没有找到这段对话。');
  return { messages: latestMessageArtifacts(record, saved.messages || [], await artifactsFor(record)) };
}

export async function updateTextbook(id, value) {
  const record = await courseRecord(id);
  if (!object(value)) fail(400, '教材信息格式不正确。');
  if (value.totalPages !== undefined && !positive(value.totalPages)) fail(400, '教材页数不正确。');
  if (value.chapters !== undefined && (!Array.isArray(value.chapters) || !value.chapters.every((chapter) => object(chapter)
      && typeof chapter.id === 'string' && typeof chapter.title === 'string' && positive(chapter.page)
      && Number.isInteger(chapter.level) && chapter.level >= 0))) fail(400, '教材目录格式不正确。');
  return serial(id, async () => {
    const latest = await readJson(resolve(record.courseDir, 'textbook/course.json'));
    if (value.totalPages !== undefined) latest.totalPages = value.totalPages;
    if (value.chapters !== undefined) await writeJson(resolve(record.courseDir, 'textbook/outline.json'), value.chapters);
    await writeJson(resolve(record.courseDir, 'textbook/course.json'), latest);
    return bookFrom({ ...latest, courseDir: record.courseDir });
  });
}

export async function savePage(id, page, text) {
  if (!positive(page) || typeof text !== 'string') fail(400, '教材页码或正文格式不正确。');
  const record = await courseRecord(id);
  return serial(id, async () => {
    await writeFile(resolve(record.courseDir, 'textbook/pages', `${page}.txt`), text);
    return { saved: true };
  });
}

export async function migrateState(id, value) {
  if (!object(value) || typeof value.legacyId !== 'string' || !object(value.state)) fail(400, '旧记录格式不正确。');
  recordName(value.legacyId);
  const record = await courseRecord(id);
  return serial(id, async () => {
    const conversationId = `legacy-${value.legacyId}`;
    if (await conversationFor(record, conversationId)) return stateFor(record);
    const incoming = readingValues({ ...value.state, conversationId }, record.initialPage);
    const messages = validMessages(value.state.messages || []).map((message) => message.status === 'running'
      ? { ...message, status: 'stopped', progress: '从旧浏览器恢复的对话，原任务已停止。' } : message);
    const current = await stateFor(record);
    const savedReading = await readJson(resolve(record.courseDir, 'reading.json'), {});
    for (const artifact of value.state.artifacts || []) await writeArtifact(record, artifact, { preserveExisting: true });
    const reading = {
      page: savedReading.updatedAt || current.messages.length || current.bookmarks.length || current.notes.length ? current.page : incoming.page,
      bookmarks: [...new Set([...current.bookmarks, ...incoming.bookmarks])],
      notes: [...current.notes, ...incoming.notes.filter((note) => !current.notes.some((item) => item.id === note.id))],
      conversationId: savedReading.updatedAt || current.messages.length ? current.conversationId : conversationId,
    };
    await writeJson(resolve(record.courseDir, 'reading.json'), reading);
    await saveMessages(record, conversationId, messages, { legacyId: value.legacyId });
    return stateFor(record);
  });
}
