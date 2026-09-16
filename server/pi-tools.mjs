import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const readPagesScript = fileURLToPath(new URL('../skills/textbook-parse/scripts/read-pages.mjs', import.meta.url));

function runScript(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [readPagesScript, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `脚本退出代码 ${code}`));
    });
    child.on('error', reject);
  });
}

export function createPiTools(context) {
  const { textbookPath, textbookDir, outputsDir, courseDir } = context;

  const readTextbookPages = defineTool({
    name: 'read_textbook_pages',
    label: '读取教材页面',
    description: '读取主教材 PDF 指定页码范围的正文、公式和图片。参数：start（起始页）、end（结束页）、images（图片模式：none/pages/all，默认 none）。',
    parameters: Type.Object({
      start: Type.Integer({ description: '起始 PDF 页码（从 1 开始）', minimum: 1 }),
      end: Type.Integer({ description: '结束 PDF 页码（包含）', minimum: 1 }),
      images: Type.Optional(Type.Union([
        Type.Literal('none'), Type.Literal('pages'), Type.Literal('all'),
      ], { description: 'none=纯文字, pages=原页校对, all=独立图片' })),
    }),
    execute: async (_toolCallId, params) => {
      const imageMode = params.images || 'none';
      const outDir = resolve(outputsDir, '.build', 'textbook-content');
      await mkdir(outDir, { recursive: true });
      try {
        const result = await runScript([
          '--pdf', textbookPath,
          '--start', String(params.start),
          '--end', String(params.end),
          '--images', imageMode,
          '--out', outDir,
        ], { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE });
        return {
          content: [{ type: 'text', text: `已读取第 ${params.start}-${params.end} 页。内容保存在 ${outDir}。` }],
          details: { outputDir: outDir, stdout: result },
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `读取教材页面失败：${error.message}` }],
          details: { error: error.message },
          isError: true,
        };
      }
    },
  });

  const readFileTool = defineTool({
    name: 'read_file',
    label: '读取文件',
    description: '读取指定路径的文件内容。路径可以是绝对路径或相对于课程目录的路径。',
    parameters: Type.Object({
      path: Type.String({ description: '文件路径（绝对路径或相对于课程目录）' }),
    }),
    execute: async (_toolCallId, params) => {
      const filePath = resolve(params.path);
      try {
        const content = await readFile(filePath, 'utf8');
        return { content: [{ type: 'text', text: content }], details: { path: filePath } };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `读取文件失败：${error.message}` }],
          details: { error: error.message },
          isError: true,
        };
      }
    },
  });

  const writeFileTool = defineTool({
    name: 'write_file',
    label: '写入文件',
    description: '将内容写入指定路径的文件。路径应相对于 outputs 目录。',
    parameters: Type.Object({
      path: Type.String({ description: '相对于 outputs 目录的文件路径' }),
      content: Type.String({ description: '文件内容' }),
    }),
    execute: async (_toolCallId, params) => {
      const filePath = resolve(outputsDir, params.path);
      await mkdir(resolve(filePath, '..'), { recursive: true });
      await writeFile(filePath, params.content, 'utf8');
      return {
        content: [{ type: 'text', text: `已写入 ${relative(outputsDir, filePath)}` }],
        details: { path: filePath, relativePath: relative(outputsDir, filePath) },
      };
    },
  });

  const listOutputsTool = defineTool({
    name: 'list_outputs',
    label: '列出输出文件',
    description: '列出 outputs 目录下的文件和子目录。',
    parameters: Type.Object({
      subdir: Type.Optional(Type.String({ description: '子目录（如 notes/, slides/, mindmaps/）' })),
    }),
    execute: async (_toolCallId, params) => {
      const dir = params.subdir ? resolve(outputsDir, params.subdir) : outputsDir;
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const listing = entries.map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`).join('\n');
        return { content: [{ type: 'text', text: listing || '目录为空' }], details: { dir } };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `列出文件失败：${error.message}` }],
          details: { error: error.message },
          isError: true,
        };
      }
    },
  });

  return [readTextbookPages, readFileTool, writeFileTool, listOutputsTool];
}
