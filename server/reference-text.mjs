import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openPromise } from 'yauzl';
import { SaxesParser } from 'saxes';

const OFFICE_ENTRY_BYTES = 32 * 1024 * 1024;
const OFFICE_TOTAL_BYTES = 128 * 1024 * 1024;
const OFFICE_TIMEOUT_MS = 120000;
const OFFICE_ENTRY_COUNT = 10000;
const OFFICE_XML_DEPTH = 256;
const OFFICE_TEXT_BLOCKS = 100000;
const officeNamespaces = {
  word: new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']),
  drawing: new Set(['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main']),
  presentation: new Set(['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main']),
  relationship: new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships']),
};

const execute = promisify(execFile);
async function command(name, args, signal) {
  try { return (await execute(name, args, { signal, timeout: 120000, maxBuffer: 32 * 1024 * 1024 })).stdout; }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`缺少 ${name} 程序，请安装后重新提取。`);
    if (signal.aborted) throw signal.reason;
    throw new Error(`${name} 处理失败：${String(error.stderr || error.message).slice(0, 400)}`);
  }
}
async function withOfficeXml(path, format, signal, consume) {
  signal.throwIfAborted();
  const timeout = new AbortController();
  const combined = AbortSignal.any([signal, timeout.signal]);
  const deadline = performance.now() + OFFICE_TIMEOUT_MS;
  const timeoutError = new Error('资料提取超过 120 秒，请减少文档内容后重新导入。');
  const timer = setTimeout(() => timeout.abort(timeoutError), OFFICE_TIMEOUT_MS);
  let archive;
  let stream;
  let totalBytes = 0;
  let rejectInterrupted;
  const interrupted = new Promise((_resolve, reject) => { rejectInterrupted = reject; });
  const wait = operation => Promise.race([operation, interrupted]);
  const abort = () => {
    stream?.destroy();
    archive?.close();
    rejectInterrupted(combined.reason);
  };
  combined.addEventListener('abort', abort, { once: true });
  const check = () => {
    if (performance.now() >= deadline) timeout.abort(timeoutError);
    combined.throwIfAborted();
  };
  try {
    archive = await wait(openPromise(path, { autoClose: false }).then(value => {
      if (combined.aborted) value.close();
      return value;
    }));
    check();
    archive.on('error', error => timeout.abort(error));
    if (archive.entryCount > OFFICE_ENTRY_COUNT) throw new Error('资料内部文件超过 10000 个，请减少文档内容后重新导入。');
    const files = new Map();
    const entries = archive.eachEntry();
    for (let count = 0; ; count++) {
      check();
      const next = await wait(entries.next());
      if (next.done) break;
      if (count >= OFFICE_ENTRY_COUNT) throw new Error('资料内部文件超过 10000 个，请减少文档内容后重新导入。');
      const entry = next.value;
      const needed = format === 'docx' ? entry.fileName === 'word/document.xml'
        : ['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels'].includes(entry.fileName)
          || /^ppt\/slides\/[^/]+\.xml$/.test(entry.fileName);
      if (!needed) continue;
      if (files.has(entry.fileName)) throw new Error(`资料包含重复的 ${entry.fileName}，请重新导出文件。`);
      files.set(entry.fileName, entry);
    }
    const readXml = async (filename, handlers) => {
      check();
      const entry = files.get(filename);
      if (!entry) throw new Error(`资料缺少 ${filename}，请重新导出文件后导入。`);
      if (entry.uncompressedSize > OFFICE_ENTRY_BYTES) throw new Error('资料单个正文文件超过 32 MiB，请减少文档内容后重新导入。');
      if (totalBytes + entry.uncompressedSize > OFFICE_TOTAL_BYTES) throw new Error('资料正文累计超过 128 MiB，请减少文档内容后重新导入。');
      stream = await wait(archive.openReadStreamPromise(entry).then(value => {
        if (combined.aborted) value.destroy();
        return value;
      }));
      try {
        check();
        const parser = new SaxesParser({ xmlns: true, fileName: filename });
        for (const [event, handler] of Object.entries(handlers)) parser.on(event, handler);
        let depth = 0;
        parser.on('opentag', node => {
          if (++depth > OFFICE_XML_DEPTH) throw new Error('资料 XML 层级超过 256 层，请重新导出文件。');
          handlers.opentag?.(node);
        });
        parser.on('closetag', node => { handlers.closetag?.(node); depth--; });
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const chunks = stream[Symbol.asyncIterator]();
        let size = 0;
        while (true) {
          check();
          const next = await wait(chunks.next());
          if (next.done) break;
          const chunk = next.value;
          size += chunk.length;
          totalBytes += chunk.length;
          if (size > OFFICE_ENTRY_BYTES) throw new Error('资料单个正文文件超过 32 MiB，请减少文档内容后重新导入。');
          if (totalBytes > OFFICE_TOTAL_BYTES) throw new Error('资料正文累计超过 128 MiB，请减少文档内容后重新导入。');
          parser.write(decoder.decode(chunk, { stream: true }));
        }
        parser.write(decoder.decode()).close();
        check();
      } finally {
        stream.destroy();
        stream = undefined;
      }
    };
    await consume(readXml, check);
    check();
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', abort);
    stream?.destroy();
    archive?.close();
  }
}
async function readOfficeParagraphs(readXml, filename, namespace) {
  const paragraphs = [];
  const active = [];
  let textDepth = 0;
  await readXml(filename, {
    opentag(node) {
      if (node.local === 'p' && namespace.has(node.uri)) active.push([]);
      if (node.local === 't' && (officeNamespaces.word.has(node.uri) || officeNamespaces.drawing.has(node.uri))) textDepth++;
    },
    text(value) { if (textDepth && active.length) active.at(-1).push(value); },
    cdata(value) { if (textDepth && active.length) active.at(-1).push(value); },
    closetag(node) {
      if (node.local === 't' && (officeNamespaces.word.has(node.uri) || officeNamespaces.drawing.has(node.uri))) textDepth--;
      if (node.local === 'p' && namespace.has(node.uri)) {
        if (paragraphs.length >= OFFICE_TEXT_BLOCKS) throw new Error('资料单个正文文件的文本单元超过 100000 个，请减少文档内容后重新导入。');
        paragraphs.push(active.pop().join(''));
      }
    },
  });
  return paragraphs;
}
async function ocrLanguage(signal) {
  const output = await command('tesseract', ['--list-langs'], signal);
  const languages = output.split(/\r?\n/).map(line => line.trim());
  const chosen = ['chi_sim', 'chi_tra', 'eng'].filter(language => languages.includes(language));
  if (!chosen.length) throw new Error('Tesseract 尚未安装中文或英文语言数据。');
  return { value: chosen.join('+'), message: chosen.some(language => language.startsWith('chi_')) ? '' : '当前文字识别语言为英语；中文扫描资料需要安装 Tesseract 中文语言数据。' };
}

export async function extractReferenceText({ path, format, ocr, signal, onProgress }) {
  const pages = [];
  const warnings = [];
  let needsOcr = false;
  const add = (entry, total) => { pages.push(entry); onProgress(pages.length, total); };
  signal.throwIfAborted();
  if (['txt', 'md'].includes(format)) {
    const text = await readFile(path, 'utf8');
    const paragraphs = text.split(/\n\s*\n/).filter(value => value.trim());
    paragraphs.forEach((text, index) => add({ paragraph: index + 1, text: text.trim(), source: 'text' }, paragraphs.length));
  } else if (format === 'docx') {
    await withOfficeXml(path, format, signal, async (readXml, check) => {
      const paragraphs = (await readOfficeParagraphs(readXml, 'word/document.xml', officeNamespaces.word)).filter(text => text.trim());
      paragraphs.forEach((text, index) => {
        check();
        add({ paragraph: index + 1, text, source: 'text' }, paragraphs.length);
      });
    });
    if (!pages.length) warnings.push('文档中未提取到正文。');
  } else if (format === 'pptx') {
    await withOfficeXml(path, format, signal, async (readXml, check) => {
      const slides = [];
      const targets = new Map();
      await readXml('ppt/presentation.xml', { opentag(node) {
        if (node.local !== 'sldId' || !officeNamespaces.presentation.has(node.uri)) return;
        const id = Object.values(node.attributes).find(attribute => attribute.local === 'id' && officeNamespaces.relationship.has(attribute.uri))?.value;
        if (!id) throw new Error('幻灯片目录缺少页面编号。');
        if (slides.length >= OFFICE_ENTRY_COUNT) throw new Error('幻灯片超过 10000 页，请减少页面后重新导入。');
        slides.push(id);
      } });
      await readXml('ppt/_rels/presentation.xml.rels', { opentag(node) {
        if (node.local !== 'Relationship' || node.uri !== 'http://schemas.openxmlformats.org/package/2006/relationships') return;
        const { Id, Target, TargetMode } = node.attributes;
        if (!Id?.value || !Target?.value) throw new Error('幻灯片关联信息不完整。');
        if (targets.has(Id.value)) throw new Error('幻灯片包含重复的关联编号。');
        if (targets.size >= OFFICE_ENTRY_COUNT) throw new Error('幻灯片关联项目超过 10000 个，请减少页面后重新导入。');
        targets.set(Id.value, { target: Target.value, external: TargetMode?.value === 'External' });
      } });
      for (const [index, id] of slides.entries()) {
        check();
        const relation = targets.get(id);
        if (!relation || relation.external) throw new Error('幻灯片目录缺少本地页面文件。');
        const file = posix.normalize(relation.target.startsWith('/') ? relation.target.slice(1) : 'ppt/' + relation.target);
        if (!/^ppt\/slides\/[^/]+\.xml$/.test(file)) throw new Error('幻灯片页面路径无效。');
        const text = (await readOfficeParagraphs(readXml, file, officeNamespaces.drawing)).join('\n');
        add({ slide: index + 1, text, source: 'text' }, slides.length);
      }
    });
    if (pages.some(page => !page.text.trim())) warnings.push('部分幻灯片没有文字层，可导出为 PDF 后识别。');
  } else if (format === 'pdf') {
    const root = fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url));
    const loading = getDocument({ data: new Uint8Array(await readFile(path)), cMapUrl: join(root, 'cmaps/'), cMapPacked: true,
      standardFontDataUrl: join(root, 'standard_fonts/'), wasmUrl: join(root, 'wasm/'), isEvalSupported: false, useSystemFonts: true });
    const abort = () => { void loading.destroy().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    let temporary;
    let language;
    try {
      const pdf = await loading.promise;
      for (let number = 1; number <= pdf.numPages; number++) {
        signal.throwIfAborted();
        const page = await pdf.getPage(number);
        let text = '';
        try {
          const content = await page.getTextContent();
          text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
        } catch (error) { warnings.push(`第 ${number} 页文字提取失败：${error.message}`); }
        let source = 'text';
        if (text.replace(/\s/g, '').length < 30) {
          if (ocr) {
            temporary ||= await mkdtemp(join(tmpdir(), 'course-reference-'));
            language ||= await ocrLanguage(signal);
            const image = join(temporary, 'page');
            await command('pdftoppm', ['-f', String(number), '-l', String(number), '-singlefile', '-scale-to', '2200', '-png', path, image], signal);
            const recognized = (await command('tesseract', [image + '.png', 'stdout', '-l', language.value], signal)).trim();
            if (recognized) { text = recognized; source = 'ocr'; }
            else warnings.push(`第 ${number} 页未识别到文字。`);
          } else needsOcr = true;
        }
        add({ page: number, text, source }, pdf.numPages);
        page.cleanup();
      }
      if (language?.message) warnings.push(language.message);
    } finally {
      signal.removeEventListener('abort', abort);
      await loading.destroy();
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  } else if (['png', 'jpg', 'jpeg', 'webp'].includes(format)) {
    if (ocr) {
      const language = await ocrLanguage(signal);
      const text = (await command('tesseract', [path, 'stdout', '-l', language.value], signal)).trim();
      add({ page: 1, text, source: 'ocr' }, 1);
      if (language.message) warnings.push(language.message);
      if (!text) warnings.push('图片中未识别到文字。');
    } else { needsOcr = true; add({ page: 1, text: '', source: 'text' }, 1); }
  }
  signal.throwIfAborted();
  return { pages, needsOcr, warnings, extractedAt: new Date().toISOString() };
}

export function searchReferenceText(index, query) {
  const normalize = value => value.normalize('NFKC').replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1').replace(/\s+/g, ' ').trim();
  const needle = normalize(query).toLocaleLowerCase();
  if (!needle) return [];
  const hits = [];
  for (const entry of index.pages) {
    const text = normalize(entry.text);
    const lower = text.toLocaleLowerCase();
    let start = 0;
    while (start < text.length) {
      const match = lower.indexOf(needle, start);
      if (match < 0) break;
      const from = Math.max(0, match - 110), to = Math.min(text.length, match + needle.length + 170);
      hits.push({ page: entry.page, slide: entry.slide, paragraph: entry.paragraph, source: entry.source,
        snippet: text.slice(from, to), matchStart: match - from, matchLength: needle.length });
      start = to;
    }
  }
  return hits;
}
