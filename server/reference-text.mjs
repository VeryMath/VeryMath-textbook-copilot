import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openPromise } from 'yauzl';

const execute = promisify(execFile);
async function command(name, args, signal) {
  try { return (await execute(name, args, { signal, timeout: 120000, maxBuffer: 32 * 1024 * 1024 })).stdout; }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`缺少 ${name} 程序，请安装后重新提取。`);
    if (signal.aborted) throw signal.reason;
    throw new Error(`${name} 处理失败：${String(error.stderr || error.message).slice(0, 400)}`);
  }
}
function xmlText(xml) {
  return [...xml.matchAll(/<(?:w|a):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:w|a):t>/g)].map(match => match[1]
    .replace(/&#x([\da-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')).join('');
}
async function readOfficeXml(path, format, signal) {
  const archive = await openPromise(path);
  const files = new Map();
  try {
    for await (const entry of archive.eachEntry()) {
      signal.throwIfAborted();
      const needed = format === 'docx' ? entry.fileName === 'word/document.xml'
        : ['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels'].includes(entry.fileName)
          || /^ppt\/slides\/[^/]+\.xml$/.test(entry.fileName);
      if (!needed) continue;
      if (entry.uncompressedSize > 32 * 1024 * 1024) throw new Error('资料正文过大，请拆分文件后重新导入。');
      const stream = await archive.openReadStreamPromise(entry);
      const abort = () => stream.destroy(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) throw new Error('资料正文过大，请拆分文件后重新导入。');
          chunks.push(chunk);
        }
        files.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
      } finally {
        signal.removeEventListener('abort', abort);
        stream.destroy();
      }
    }
  } finally { archive.close(); }
  signal.throwIfAborted();
  return filename => {
    if (!files.has(filename)) throw new Error(`资料缺少 ${filename}，请重新导出文件后导入。`);
    return files.get(filename);
  };
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
    const readXml = await readOfficeXml(path, format, signal);
    const xml = readXml('word/document.xml');
    const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(match => xmlText(match[0])).filter(text => text.trim());
    paragraphs.forEach((text, index) => add({ paragraph: index + 1, text, source: 'text' }, paragraphs.length));
    if (!pages.length) warnings.push('文档中未提取到正文。');
  } else if (format === 'pptx') {
    const readXml = await readOfficeXml(path, format, signal);
    const presentation = readXml('ppt/presentation.xml');
    const relationships = readXml('ppt/_rels/presentation.xml.rels');
    const targets = new Map([...relationships.matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => {
      const id = /\bId="([^"]+)"/.exec(tag)?.[1];
      const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
      return [id, target];
    }));
    const files = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"[^>]*>/g)].map(([, id]) => {
      const target = targets.get(id);
      if (!target) throw new Error('幻灯片目录缺少对应的页面文件。');
      const file = posix.normalize(target.startsWith('/') ? target.slice(1) : 'ppt/' + target);
      if (!/^ppt\/slides\/[^/]+\.xml$/.test(file)) throw new Error('幻灯片页面路径无效。');
      return file;
    });
    for (const [index, file] of files.entries()) {
      signal.throwIfAborted();
      const xml = readXml(file);
      const text = [...xml.matchAll(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g)].map(match => xmlText(match[0])).join('\n');
      add({ slide: index + 1, text, source: 'text' }, files.length);
    }
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
