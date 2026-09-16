import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function readCommand(executable, args, cwd) {
  return execute(executable, args, { cwd, timeout: 20000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
}

let cached;
let checkedAt = 0;
let pending;

async function executable(name, directories) {
  for (const directory of directories) {
    const path = join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    try { await access(path, constants.X_OK); return path; } catch { /* 检查下一个安装位置。 */ }
  }
  return '';
}

async function inspect() {
  const directories = [...new Set([...(process.env.PATH || '').split(delimiter).filter(Boolean), '/Library/TeX/texbin'])];
  const engine = await executable('xelatex', directories);
  const missing = [];
  let version = '';
  if (engine) {
    try { version = (await readCommand(engine, ['--version'])).stdout.split('\n')[0].trim(); }
    catch { missing.push('XeLaTeX 无法运行'); }
  } else missing.push('XeLaTeX');

  // 从同一套 TeX 安装查询宏包和字体。
  const lookup = engine ? await executable('kpsewhich', [dirname(engine)]) : '';
  const files = ['beamer.cls', 'ctex.sty', 'amsmath.sty', 'amsfonts.sty', 'amssymb.sty', 'bm.sty', 'booktabs.sty', 'tikz.sty',
    'FandolSong-Regular.otf', 'FandolSong-Bold.otf', 'FandolHei-Regular.otf', 'FandolHei-Bold.otf', 'FandolKai-Regular.otf', 'FandolFang-Regular.otf'];
  const mathFiles = ['cmr10.tfm', 'cmmi10.tfm', 'cmsy10.tfm', 'cmex10.tfm', 'msam10.tfm', 'msbm10.tfm',
    'cmr10.pfb', 'cmmi10.pfb', 'cmsy10.pfb', 'cmex10.pfb', 'msam10.pfb', 'msbm10.pfb'];
  let preferredMathFonts = false;
  if (lookup) {
    const paths = await Promise.all([...files, ...mathFiles].map(async file => {
      try { return !!(await readCommand(lookup, [file])).stdout.trim(); } catch { return false; }
    }));
    files.forEach((file, index) => { if (!paths[index]) missing.push(file); });
    preferredMathFonts = paths.slice(files.length).every(Boolean);
  } else if (engine) missing.push('kpsewhich（宏包与字体查询程序）');

  return { engine, version, missing, preferredMathFonts, ready: missing.length === 0,
    message: missing.length ? `课件编译环境需要处理：${missing.join('、')}。`
      : '已找到 XeLaTeX、模板宏包和中文字体。' };
}

export async function getLatexEnvironment(refresh = false) {
  if (pending) return pending;
  if (!refresh && cached && Date.now() - checkedAt < 30000) return cached;
  pending = inspect();
  try { cached = await pending; checkedAt = Date.now(); return cached; }
  finally { pending = undefined; }
}
