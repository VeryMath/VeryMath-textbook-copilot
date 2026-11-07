import { Type } from 'typebox';
import { defineTool, createExtensionRuntime } from '@earendil-works/pi-coding-agent';
import { readFile, writeFile, readdir, mkdir, lstat, realpath, copyFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { resolve, relative, dirname, extname, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { validateMindmap } from '../skills/mindmap/scripts/validate-mindmap.mjs';
import { validateKnowledgeGraph } from '../skills/knowledge-graph/scripts/validate-knowledge-graph.mjs';

const execute = promisify(execFile);
const readPagesScript = fileURLToPath(new URL('../skills/textbook-parse/scripts/read-pages.mjs', import.meta.url));
const maxFileBytes = 20 * 1024 * 1024;
const maxArchiveBytes = 100 * 1024 * 1024;
const outputKinds = ['notes', 'slides', 'quizzes', 'mindmaps', 'knowledge-graphs', 'files'];
const textExtensions = new Set(['.md', '.txt', '.json', '.tex', '.csv', '.svg', '.log']);
function fail(message) { throw new Error(message); }
function inside(root, path) {
  const local = relative(root, path);
  return local === '' || (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`));
}
async function checkPath(root, path, allowMissing = false) {
  if (!inside(root, path)) fail('文件超出本次任务允许的目录。');
  let current = root;
  for (const part of ['', ...relative(root, path).split(sep).filter(Boolean)]) {
    if (part) current = resolve(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return path; throw error; }
    if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) fail('任务文件不能使用链接文件。');
  }
  return path;
}

export function createCourseResourceLoader(instructions, skills) {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills, diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => instructions, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => fail('课程会话不允许加载外部资源。'), reload: async () => {},
  };
}

async function pageRange(request, textbookDir, totalPages) {
  if (['none', 'selection'].includes(request.scope)) return null;
  if (request.scope === 'range') return { ...request.pageRange };
  if (request.scope === 'page') return { start: request.page, end: request.page };
  if (request.scope === 'book') return { start: 1, end: totalPages || Number.MAX_SAFE_INTEGER };
  const path = await checkPath(textbookDir, resolve(textbookDir, 'outline.json'));
  const outline = JSON.parse(await readFile(path, 'utf8'));
  const level = request.scope === 'chapter' ? 0 : 1;
  const candidates = outline.filter(item => item.level === level && Number.isSafeInteger(item.page) && item.page <= request.page);
  const selected = candidates.find(item => item.id === request.chapter?.id) || candidates.at(-1);
  if (!selected) fail('当前目录无法确定所选章或节，请选择指定页码。');
  const next = outline.slice(outline.indexOf(selected) + 1).find(item => item.level <= level && item.page >= selected.page);
  return { start: selected.page, end: next?.page || totalPages || Number.MAX_SAFE_INTEGER };
}

async function cleanEnvironment(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return { PATH: '/usr/bin:/bin', HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
    ...(process.env.ELECTRON_RUN_AS_NODE === '1' ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
}

export async function createPiTools(context) {
  const { request, resultId, resultPath, references = [], skillPaths = [], artifactFiles = [], signal } = context;
  const courseDir = await realpath(context.courseDir);
  const outputsDir = await checkPath(courseDir, resolve(courseDir, 'outputs'));
  const textbookDir = await checkPath(courseDir, resolve(courseDir, 'textbook'));
  const textbookPath = resolve(courseDir, 'textbook.pdf');
  const taskDir = resolve(outputsDir, '.build', `task-${resultId}`);
  const writeRoots = [taskDir, ...outputKinds.map(kind => resolve(outputsDir, kind, resultId))];
  for (const root of writeRoots) {
    await checkPath(outputsDir, root, true);
    await mkdir(root, { recursive: true, mode: 0o700 });
  }
  const range = await pageRange(request, textbookDir, context.totalPages);
  const readFiles = new Map(), readRoots = [];
  for (const skill of skillPaths) {
    const path = resolve(skill.path);
    await checkPath(dirname(path), path);
    if (skill.bundled) readRoots.push(dirname(path));
    else readFiles.set(path, dirname(path));
  }
  for (const reference of references) for (const path of [reference.path, reference.textPath].filter(Boolean)) {
    await checkPath(courseDir, path); readFiles.set(path, courseDir);
  }
  for (const path of artifactFiles) {
    await checkPath(outputsDir, path); readFiles.set(path, outputsDir);
  }
  if (range) readFiles.set(resolve(textbookDir, 'outline.json'), textbookDir);
  const pending = resolve(resultPath);
  if (pending !== resolve(outputsDir, `pending-${resultId}.json`)) fail('结果文件位置无效。');
  readFiles.set(pending, outputsDir);

  async function readablePath(value) {
    if (typeof value !== 'string' || value.includes('\0')) fail('文件路径无效。');
    const path = resolve(courseDir, value);
    const root = readFiles.get(path) || [...writeRoots, ...readRoots].find(item => inside(item, path));
    if (!root) fail('只能读取本次选定资料、Skill 和本次生成文件。');
    return checkPath(root, path);
  }
  async function writablePath(value) {
    if (typeof value !== 'string' || value.includes('\0')) fail('文件路径无效。');
    const path = resolve(outputsDir, value);
    const root = path === pending ? outputsDir : writeRoots.find(item => inside(item, path));
    if (!root) fail('只能写入本次任务的输出目录。');
    return checkPath(root, path, true);
  }
  const response = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], details: {} });
  const tool = (name, description, parameters, operation) => defineTool({ name, label: name, description, parameters,
    execute: async (_id, params, toolSignal) => {
      signal?.throwIfAborted(); toolSignal?.throwIfAborted();
      return operation(params, signal && toolSignal ? AbortSignal.any([signal, toolSignal]) : signal || toolSignal);
    } });
  async function parsePdf(path, start, end, images, folder, taskSignal) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= 30) fail('每次读取 1 至 30 页，页码必须有效。');
    const out = await writablePath(resolve(taskDir, folder));
    await mkdir(out, { recursive: true, mode: 0o700 });
    await execute(process.execPath, [readPagesScript, '--pdf', path, '--start', String(start), '--end', String(end), '--images', images || 'none', '--out', out], {
      cwd: taskDir, env: await cleanEnvironment(resolve(taskDir, '.runtime')), signal: taskSignal, timeout: 120000, maxBuffer: maxFileBytes,
    });
    const source = JSON.parse(await readFile(await checkPath(taskDir, resolve(out, 'source.json')), 'utf8'));
    return response({ ...source, directory: out });
  }

  const tools = [
    tool('read_textbook_pages', '读取本次允许范围内的教材页面，每次最多 30 页。selection 与 none 范围不读取原 PDF。', Type.Object({
      start: Type.Integer({ minimum: 1 }), end: Type.Integer({ minimum: 1 }), images: Type.Optional(Type.Union(['none', 'pages', 'all'].map(value => Type.Literal(value)))),
    }), async (params, taskSignal) => {
      if (!range || params.start < range.start || params.end > range.end) fail('页码超出本次选定的教材范围。');
      return parsePdf(await checkPath(courseDir, textbookPath), params.start, params.end, params.images, `textbook-${params.start}-${params.end}`, taskSignal);
    }),
    tool('read_reference', '读取本次选定辅助资料的正文。PDF 可指定页码；图片通过 read_file 查看。', Type.Object({
      id: Type.String(), start: Type.Optional(Type.Integer({ minimum: 1 })), end: Type.Optional(Type.Integer({ minimum: 1 })),
    }), async (params, taskSignal) => {
      const reference = references.find(item => item.id === params.id);
      if (!reference) fail('这份资料没有在本次任务中选定。');
      if (reference.format === 'pdf') return parsePdf(await readablePath(reference.path), params.start || 1, params.end || params.start || 1, 'none', `reference-${reference.id}`, taskSignal);
      if (!reference.textPath) fail('资料正文尚未提取完成，请等待后重试。');
      const path = await readablePath(reference.textPath);
      if ((await lstat(path)).size > maxFileBytes) fail('资料正文超过单次读取上限。');
      return response(await readFile(path, 'utf8'));
    }),
    tool('read_file', '读取本次允许的文字文件或图片。相对路径以课程目录为基准。', Type.Object({ path: Type.String() }), async ({ path: value }) => {
      const path = await readablePath(value), info = await lstat(path);
      if (!info.isFile() || info.size > maxFileBytes) fail('文件类型或大小超出读取范围。');
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(path).toLowerCase()];
      if (mime) return { content: [{ type: 'image', data: (await readFile(path)).toString('base64'), mimeType: mime }], details: {} };
      if (!textExtensions.has(extname(path).toLowerCase())) fail('此文件请使用对应的 PDF 或 ZIP 专用工具读取。');
      return response(await readFile(path, 'utf8'));
    }),
    tool('write_file', '保存本次生成的文字、JSON、LaTeX 或 SVG。相对路径以 outputs 为基准，使用指定任务目录。', Type.Object({ path: Type.String(), content: Type.String() }), async ({ path: value, content }) => {
      const path = await writablePath(value);
      if (!textExtensions.has(extname(path).toLowerCase()) || Buffer.byteLength(content) > maxFileBytes) fail('生成文件类型或大小不受支持。');
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await checkPath(outputsDir, path, true); await writeFile(path, content, { mode: 0o600 });
      return response({ path });
    }),
    tool('copy_file', '将允许读取的文件复制到本次输出目录。', Type.Object({ source: Type.String(), destination: Type.String() }), async params => {
      const source = await readablePath(params.source), destination = await writablePath(params.destination), info = await lstat(source);
      if (!info.isFile() || info.size > maxArchiveBytes) fail('文件超出复制范围。');
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await copyFile(source, destination);
      return response({ path: destination });
    }),
    tool('list_outputs', '列出本次任务输出目录中的文件。', Type.Object({ subdir: Type.String() }), async ({ subdir }) => {
      const path = await readablePath(resolve(outputsDir, subdir));
      if (!writeRoots.some(root => inside(root, path))) fail('只能列出本次任务目录。');
      return response((await readdir(path, { withFileTypes: true })).filter(item => !item.isSymbolicLink()).map(item => ({ name: item.name, directory: item.isDirectory() })));
    }),
  ];
  tools.push(tool('read_pdf_pages', '读取本次生成或明确选定 PDF 的页面，不接受主教材路径。', Type.Object({ path: Type.String(), start: Type.Integer({ minimum: 1 }), end: Type.Integer({ minimum: 1 }) }), async (params, taskSignal) => {
    const path = await readablePath(params.path);
    if (extname(path).toLowerCase() !== '.pdf') fail('请选择允许的 PDF 文件。');
    return parsePdf(path, params.start, params.end, 'pages', 'pdf-review', taskSignal);
  }));
  async function walk(directory, files = []) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = await checkPath(taskDir, resolve(directory, entry.name));
      if (entry.isDirectory()) await walk(path, files);
      else if (entry.isFile()) files.push(path);
      else fail('源码目录含有不支持的文件。');
      if (files.length > 1000) fail('源码目录文件过多。');
    }
    return files;
  }
  tools.push(tool('package_sources', '将本次编译项目保存为源码 ZIP。', Type.Object({ directory: Type.String(), destination: Type.String() }), async params => {
    const directory = await readablePath(params.directory);
    if (!inside(taskDir, directory)) fail('只能打包本次编译项目。');
    const destination = await writablePath(params.destination);
    if (extname(destination) !== '.zip' || inside(directory, destination)) fail('ZIP 必须保存到项目目录之外。');
    const files = await walk(directory);
    let size = 0;
    for (const path of files) size += (await lstat(path)).size;
    if (size > maxArchiveBytes) fail('源码 ZIP 超过大小上限。');
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const zip = new yazl.ZipFile();
    zip.on('error', error => zip.outputStream.destroy(error));
    for (const path of files) zip.addFile(path, relative(directory, path).split(sep).join('/'));
    const saving = pipeline(zip.outputStream, createWriteStream(destination, { mode: 0o600 }));
    zip.end(); await saving;
    return response({ path: destination });
  }));
  tools.push(tool('extract_sources', '将已选课件的源码 ZIP 展开到本次项目目录。', Type.Object({ path: Type.String() }), async params => {
    const path = await readablePath(params.path);
    if (extname(path) !== '.zip') fail('请选择源码 ZIP。');
    const destination = resolve(taskDir, 'sources');
    await checkPath(taskDir, destination, true); await mkdir(destination, { recursive: true, mode: 0o700 });
    const zip = await new Promise((accept, reject) => yauzl.open(path, { lazyEntries: true, strictFileNames: true }, (error, archive) => error ? reject(error) : accept(archive)));
    let bytes = 0, count = 0;
    await new Promise((accept, reject) => {
      const stop = error => { zip.close(); reject(error); };
      zip.on('error', stop); zip.on('end', accept);
      zip.on('entry', entry => {
        void (async () => {
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (++count > 1000 || (mode && ![0o040000, 0o100000].includes(mode))) fail('源码 ZIP 文件类型或数量不受支持。');
          if (/^[a-z]:/i.test(entry.fileName) || entry.fileName.includes('\\')) fail('源码 ZIP 文件路径无效。');
          bytes += entry.uncompressedSize;
          if (bytes > maxArchiveBytes) fail('源码 ZIP 展开后超过大小上限。');
          const target = await checkPath(destination, resolve(destination, entry.fileName), true);
          if (entry.fileName.endsWith('/')) await mkdir(target, { recursive: true, mode: 0o700 });
          else {
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            const stream = await new Promise((acceptStream, rejectStream) => zip.openReadStream(entry, (error, value) => error ? rejectStream(error) : acceptStream(value)));
            await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
          }
          zip.readEntry();
        })().catch(stop);
      });
      zip.readEntry();
    });
    return response({ directory: destination });
  }));
  async function validateArtifact(artifact) {
    if (artifact.id !== resultId) fail('生成结果的 ID 与本次任务不一致。');
    if (artifact.kind === 'mindmap') validateMindmap(artifact, resultId, context.totalPages);
    if (artifact.kind === 'knowledge-graph') validateKnowledgeGraph(artifact, resultId, context.totalPages, { requireV2: true });
    const prefix = `/api/courses/${encodeURIComponent(request.book.id)}/outputs/`;
    for (const url of [artifact.url, artifact.sourceUrl, ...(artifact.chapters || []).map(item => item.url)].filter(Boolean)) {
      if (typeof url !== 'string') fail('生成文件地址无效。');
      const path = url.startsWith(prefix) ? resolve(outputsDir, decodeURIComponent(url.slice(prefix.length)))
        : resolve(outputsDir, url.replace(/^outputs\//, ''));
      if (!inside(outputsDir, path)) fail('生成文件地址超出课程输出目录。');
      await readablePath(path);
    }
  }
  tools.push(tool('validate_result', '检查本次结果文件中的图谱结构、页码与文件引用。', Type.Object({}), async () => {
    const artifact = JSON.parse(await readFile(await readablePath(pending), 'utf8'));
    await validateArtifact(artifact);
    return response('结果检查通过。');
  }));
  return { tools, taskDir, range, outputDirectories: writeRoots.slice(1), validateArtifact };
}
