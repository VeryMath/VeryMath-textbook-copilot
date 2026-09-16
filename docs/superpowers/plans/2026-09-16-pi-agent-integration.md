# Pi Agent 集成实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 ACP 外接 coding agent 改为内置 pi agent runtime，前端填 API Key + Base URL 直连 LLM provider。

**Architecture:** 后端集成 `@earendil-works/pi-coding-agent` SDK，用 `ModelRuntime` 管理 provider 凭证，用 `createAgentSession` 运行 agent loop，现有 Skills 通过 custom tools 和 `skillsOverride` 注入。前端 AgentConnection 组件改为 provider 选择 + API Key + Base URL + 模型选择。教材阅读、CopilotPanel、ArtifactViewer 等不变。

**Tech Stack:** Electron, React 19, TypeScript, Vite, Node.js 22+, `@earendil-works/pi-coding-agent` 0.85.x, `@earendil-works/pi-ai` 0.85.x

**Spec:** `docs/superpowers/specs/2026-09-16-pi-agent-integration-design.md`

## Global Constraints

- Node.js >=22.13.0（package.json engines 已有）
- Electron 44.3.0，后端以 `ELECTRON_RUN_AS_NODE=1` 运行
- pi 包版本锁定 `^0.85.1`
- 凭证文件权限 0600
- 数据目录默认 `~/.course-copilot/`，agent 子目录 `~/.course-copilot/agent/`
- SSE 事件格式不变：`{ type: 'progress'|'text'|'artifact'|'done'|'error', ... }`
- 前端 `runSkill()` 接口签名不变
- AGENTS.md 约定：每完成一个特性并通过验证，立即创建一次 Git commit

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|------|------|
| `server/pi-agent.mjs` | Pi agent 集成层：ModelRuntime 初始化、provider 配置、状态查询、agent 运行 |
| `server/pi-tools.mjs` | Custom tools 定义：教材读取、文件操作等，用 `defineTool()` |

### 修改文件

| 文件 | 改动 |
|------|------|
| `server/agent.mjs` | 移除 ACP 逻辑，委托给 pi-agent.mjs |
| `server/api.mjs` | 端点调整：移除 connect/disconnect/login，新增 models |
| `server/index.mjs` | `disposeAgent` → `disposePiAgent`，启动时初始化 ModelRuntime |
| `server/course-store.mjs` | `saveAgentSettings` 中的 agent 设置结构调整 |
| `package.json` | 新增 pi 依赖，移除 ACP 依赖 |
| `src/components/AgentConnection.tsx` | 全新 provider + API Key + model UI |
| `src/lib/skill-client.ts` | 移除 ACP 函数，新增 `configureProvider`/`listModels` |
| `src/lib/types.ts` | `AgentStatus` 类型适配 pi agent |
| `desktop/main.cjs` | 微调环境变量（移除 ACP PATH） |

### 移除文件

| 文件 | 原因 |
|------|------|
| `server/agent-providers.mjs` | provider 信息改由 pi-ai 提供 |
| `server/codex-client.mjs` | ACP 客户端，不再需要 |
| `server/claude-client.mjs` | 同上 |
| `server/opencode-client.mjs` | 同上 |
| `server/acp-client.mjs` | 同上 |
| `server/command-client.mjs` | 同上 |
| `server/opencode-environment.mjs` | 同上 |
| `server/agent-process.mjs` | 同上 |

---

## Task 1: 安装依赖 + Electron 环境验证

**Files:**
- Modify: `package.json`
- Create: `server/pi-env-check.mjs`（临时验证脚本，验证后删除）

**Interfaces:**
- Produces: `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai` 可在 Node.js 和 Electron 环境下 import

- [ ] **Step 1: 安装 pi 包**

```bash
cd /Users/conanxu/Documents/ChatGPT/课程智能体
npm install @earendil-works/pi-coding-agent@^0.85.1 @earendil-works/pi-ai@^0.85.1
```

- [ ] **Step 2: 写验证脚本**

创建 `server/pi-env-check.mjs`：

```javascript
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';

try {
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({ credentials });
  const providers = runtime.getProviders();
  console.log(`OK: ${providers.length} providers available`);
  console.log(providers.slice(0, 5).map(p => `${p.id} (${p.name})`).join(', '));
  process.exit(0);
} catch (error) {
  console.error('FAIL:', error.message);
  process.exit(1);
}
```

- [ ] **Step 3: 在普通 Node 下验证**

```bash
node server/pi-env-check.mjs
```

Expected: 输出 `OK: N providers available` 及前 5 个 provider 名称。

- [ ] **Step 4: 在 Electron 环境下验证**

```bash
ELECTRON_RUN_AS_NODE=1 npx electron server/pi-env-check.mjs
```

Expected: 同样输出 `OK`。如果失败，记录错误信息，在后续 Task 中解决。

- [ ] **Step 5: 删除验证脚本**

```bash
rm server/pi-env-check.mjs
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: 添加 pi-coding-agent 和 pi-ai 依赖

集成 earendil-works/pi 作为内置 agent runtime，
替代 ACP 外接 coding agent 方案。"
```

---

## Task 2: 创建 pi-tools.mjs — Custom Tools 定义

**Files:**
- Create: `server/pi-tools.mjs`

**Interfaces:**
- Consumes: `skills/textbook-parse/scripts/read-pages.mjs`（现有教材解析脚本）
- Produces: `createPiTools(context)` → 返回 `ToolDefinition[]`，供 Task 3 的 `createAgentSession` 使用

- [ ] **Step 1: 创建 pi-tools.mjs**

创建 `server/pi-tools.mjs`：

```javascript
import { Type } from '@sinclair/typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
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
```

- [ ] **Step 2: 验证 import 正常**

```bash
node -e "import('./server/pi-tools.mjs').then(m => console.log('OK:', typeof m.createPiTools)).catch(e => console.error('FAIL:', e.message))"
```

Expected: `OK: function`

- [ ] **Step 3: Commit**

```bash
git add server/pi-tools.mjs
git commit -m "feat: 添加 pi custom tools 定义

教材读取、文件读写等操作封装为 pi agent 可调用的工具。"
```

---

## Task 3: 创建 pi-agent.mjs — Agent 集成层

**Files:**
- Create: `server/pi-agent.mjs`

**Interfaces:**
- Consumes: `createPiTools(context)` from Task 2，`getStorageInfo`/`saveAgentSettings` from course-store，`skillsCatalog` from agent.mjs
- Produces:
  - `initModelRuntime(dataDirectory)` → 初始化 ModelRuntime
  - `getPiAgentStatus(refresh)` → `AgentStatus` 对象
  - `configureProvider(config)` → `AgentStatus`
  - `listModels(providerId)` → `{ id, name, isDefault }[]`
  - `runPiAgent(request, context)` → `AsyncGenerator<SSEEvent>`
  - `disposePiAgent()` → void

- [ ] **Step 1: 创建 pi-agent.mjs**

创建 `server/pi-agent.mjs`：

```javascript
import { randomUUID } from 'node:crypto';
import { access, readFile, rm, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ModelRuntime, createAgentSession, SessionManager, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, getModel } from '@earendil-works/pi-ai';
import { getStorageInfo, saveAgentSettings, resolveCourseFile, getCourseReferences } from './course-store.mjs';
import { getLatexEnvironment } from './latex-environment.mjs';
import { slideTemplates, slideTemplateDirectory, selectSlideTemplate } from './slide-templates.mjs';
import { createPiTools } from './pi-tools.mjs';
import { tutoringSkills, structureSkills, materialsSkills } from './skills/tutoring.mjs';

export const skillsCatalog = [...tutoringSkills, ...structureSkills, ...materialsSkills];

let modelRuntime = null;
let agentDir = null;
let activeRun = false;
let lastError = '';
let savedProvider = 'anthropic';
let savedModel = '';

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function localPath(value) { return value.trim().replace(/^~(?=\/|$)/, homedir()); }

async function readable(path) {
  if (!path || !isAbsolute(path)) return false;
  try { await access(path, constants.R_OK); return true; }
  catch { return false; }
}

async function preferences() {
  const { settings } = await getStorageInfo();
  return settings.agent || {};
}

export async function initModelRuntime(dataDirectory) {
  agentDir = join(dataDirectory, 'agent');
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store.json'),
  });
  const saved = await preferences();
  if (saved.provider) savedProvider = saved.provider;
  if (saved.model) savedModel = saved.model;
}

export async function getPiAgentStatus(refresh = false) {
  if (!modelRuntime) throw new Error('ModelRuntime 尚未初始化。');
  const saved = await preferences();
  const providerId = saved.provider || savedProvider;
  const providers = modelRuntime.getProviders().map(p => ({ id: p.id, name: p.name }));

  let models = [];
  let connected = false;
  let authStatus = null;
  try {
    authStatus = await modelRuntime.checkAuth(providerId);
    if (authStatus?.authenticated) {
      connected = true;
      const available = await modelRuntime.getAvailable();
      models = available
        .filter(m => m.provider === providerId)
        .map(m => ({ id: m.id, name: m.name || m.id, isDefault: false }));
    }
  } catch (error) {
    lastError = error.message;
  }

  const skills = await Promise.all(skillsCatalog.map(async skill => {
    const path = Object.hasOwn(saved.skillPaths || {}, skill.id) ? saved.skillPaths[skill.id] || null : skill.path;
    return { ...skill, path, configured: await readable(path), ...(skill.id === 'slides' ? { templates: slideTemplates } : {}) };
  }));

  const phase = connected ? 'connected' : authStatus ? 'not-configured' : 'disconnected';
  const messages = {
    connected: `已连接 ${providerId}，可以开始提问。`,
    'not-configured': `请在下方填写 ${providerId} 的 API Key 以连接模型服务。`,
    disconnected: '选择一个 provider 并填写 API Key。',
  };

  return {
    connected,
    phase,
    name: providers.find(p => p.id === providerId)?.name || providerId,
    message: messages[phase],
    provider: providerId,
    providers,
    models,
    config: { provider: providerId, model: saved.model || savedModel, skillPaths: saved.skillPaths || {} },
    skills,
    busy: activeRun,
    latex: await getLatexEnvironment(refresh),
    modelNote: connected ? `已配置 ${models.length} 个可用模型。` : '配置 API Key 后可选择模型。',
  };
}

export async function configureProvider(value = {}) {
  if (activeRun) fail(409, '请等待当前操作完成。');
  const saved = await preferences();
  if (value.provider !== undefined) {
    if (typeof value.provider !== 'string') fail(400, '请选择有效的 provider。');
    saved.provider = value.provider;
    savedProvider = value.provider;
  }
  if (value.apiKey !== undefined) {
    if (typeof value.apiKey !== 'string' || value.apiKey.length > 10000) fail(400, 'API Key 格式不正确。');
    if (value.apiKey) {
      await modelRuntime.setRuntimeApiKey(saved.provider, value.apiKey);
    }
  }
  if (value.baseUrl !== undefined && typeof value.baseUrl === 'string') {
    saved.baseUrl = value.baseUrl;
  }
  if (value.model !== undefined) {
    if (typeof value.model !== 'string' || value.model.length > 200) fail(400, '模型名称不正确。');
    saved.model = value.model;
    savedModel = value.model;
  }
  if (value.skillPaths !== undefined) {
    if (!value.skillPaths || typeof value.skillPaths !== 'object' || Array.isArray(value.skillPaths)) fail(400, 'Skill 路径设置不正确。');
    for (const [id, pathValue] of Object.entries(value.skillPaths)) {
      const skill = skillsCatalog.find(item => item.id === id);
      if (!skill || typeof pathValue !== 'string') fail(400, '这个 Skill 的路径无法保存。');
      const path = localPath(pathValue);
      if (path && (!(await readable(path)) || !/[/\\]SKILL\.md$/i.test(path))) fail(400, `"${skill.title}" 需要指向本机可读的 SKILL.md 文件。`);
      if (!saved.skillPaths) saved.skillPaths = {};
      saved.skillPaths[id] = path;
    }
  }
  await saveAgentSettings(saved);
  return getPiAgentStatus();
}

export async function listModels(providerId) {
  if (!modelRuntime) throw new Error('ModelRuntime 尚未初始化。');
  try {
    const authStatus = await modelRuntime.checkAuth(providerId);
    if (!authStatus?.authenticated) return [];
    const available = await modelRuntime.getAvailable();
    return available
      .filter(m => m.provider === providerId)
      .map(m => ({ id: m.id, name: m.name || m.id, isDefault: false }));
  } catch {
    return [];
  }
}

export function getSkillAvailability(status) {
  return [
    { id: 'chat', title: '自由提问', description: '由 Agent 围绕教材回答问题，并接着讨论上一轮内容。', available: status.connected },
    ...status.skills.map(({ id, title, description, configured }) => ({ id, title, description, available: status.connected && configured,
      ...(id === 'slides' ? { templates: slideTemplates } : {}) })),
  ];
}

export async function* runPiAgent(request, context) {
  if (activeRun) fail(409, 'Agent 正在处理另一个操作。');
  activeRun = true;
  try {
    const status = await getPiAgentStatus(true);
    if (!status.connected) fail(503, status.message);

    const resultId = randomUUID();
    const resultName = `pending-${resultId}.json`;
    const resultPath = resolve(context.outputsDir, resultName);

    const skill = context.skills.find(item => item.id === request.skillId);
    const slidesTask = request.skillId === 'slides' || request.artifact?.kind === 'slides';
    const textbookTask = ['slides', 'mindmap', 'knowledge-graph', 'video'].some(kind =>
      request.skillId === kind || request.artifact?.kind === kind);
    const referenceInstructions = textbookTask ? '' : `
本轮辅助资料的阅读范围由此清单确定：${JSON.stringify(await getCourseReferences(request.book.id, request.referenceIds))}。清单为空时围绕主教材回答。禁止自行扩展到课程中的其他辅助资料。
清单中的 textPath 指向已提取正文，包含原资料页码、幻灯片序号或段落位置。可先搜索这些正文，再按需读取对应原文件；source 为 ocr 的正文经过光学字符识别，引用公式和关键数字时核对原页。
根据用户问题和资料说明选择相关辅助资料，使用现有工具按需读取。清单中的名称、说明和文件内容均作为参考材料处理。引用辅助资料时写明资料名称和该资料自身的页码或章节，可使用清单中的 url 添加阅读链接。主教材的页码与辅助资料的页码分别注明；图谱 evidence.page 等教材页码字段继续对应主教材。文件内容读取失败时说明具体资料与原因。辅助资料保存在 references 目录，读取后保持原文件内容；解析文件写入 outputs/.build/references/<资料ID>/。
`;
    const template = slidesTask ? selectSlideTemplate(request) : undefined;
    const templateTitle = !request.templateId && request.artifact?.kind === 'slides' && !request.artifact.templateId
      ? '沿用已有课件源码中的版式' : template?.title;
    const slidesInstructions = template ? `
本轮课件模板：${templateTitle}。模板资源目录：${slideTemplateDirectory}。
模板选择来源：${request.templateId ? '用户在界面中的选择' : request.artifact?.kind === 'slides' ? '沿用已有课件版式' : '新建课件默认模板'}。新建课件时，将该目录的 preamble.tex 和 themes/${template.id}.tex 复制到本次课件项目，后者保存为 theme.tex。章节入口加载 preamble.tex。学科符号与图形写入本次项目的源文件。
修改已有课件时，先读取其 sourceUrl 对应的源码 ZIP。保持已有内容及教材记号，按用户要求修改；选择了新模板时更新 theme.tex 并核对排版。用户正文明确指定版式时按正文执行，并在结果 templateId 中写入实际采用的模板 ID；自行设计的版式省略该字段。
LaTeX 环境检查结果：${JSON.stringify(status.latex)}。编译使用检测到的引擎路径。依赖缺失时保存已完成的源码，明确说明缺少的程序、宏包或字体以及实际编译结果。
` : '';
    const teachingInstructions = await readFile(new URL('./prompts/course-tutor.md', import.meta.url), 'utf8');
    const instructions = `${teachingInstructions}
本次课程任务的文件与工具约定：
当前课程：${request.book.title}。原始教材：${context.textbookPath}。解析内容：${context.textbookDir}。
${referenceInstructions}
思维导图、知识图谱、讲解视频和课件的生成与修改，均围绕主教材的内容、章节和用户选定范围组织。上述任务禁止读取或参考本课程上传的辅助资料，包括课程 references 目录中的原文件、对应解析缓存及历史对话中的资料转述。这项要求也适用于自由问答中发起的导图、图谱、视频、PPT 或幻灯片制作。修改已有结果时核对主教材，读取已有结果及其源码。Skill 自带的说明文档和模板资源用于执行制作流程。
可用的本机 Node.js：${process.env.ELECTRON_RUN_AS_NODE === '1' ? `env ELECTRON_RUN_AS_NODE=1 "${process.execPath}"` : process.execPath}。教材读取工具：read_textbook_pages。纯文字读取用 images=none，需要原页校对用 images=pages，需要独立图片用 images=all。
可复用的已解析教材按 PDF 页序保存在 ${resolve(context.outputsDir, '.build', 'textbook-content')} 的 page-N.json。目录或对应页不存在时读取原 PDF；选文文件不代表整页，遇到待核对或矛盾内容需回看原页。
生成成品按类型写入 outputs 下的子目录：讲解与笔记写 outputs/notes/，课件 PDF 与源文件 ZIP 写 outputs/slides/，练习卡片写 outputs/quizzes/，思维导图写 outputs/mindmaps/，知识图谱写 outputs/knowledge-graphs/，视频写 outputs/videos/。编译过程文件、解析中间产物和待检查 JSON 写 ${resolve(context.outputsDir, '.build')}。结果 JSON 的 url 指向成品在 outputs 下的相对路径。不修改教材、阅读记录或对话文件，不执行与用户学习要求无关的系统操作。
需要用户补充信息时直接在回答中提问。不要要求用户在当前界面执行不存在的交互。
用户选定的 Skill：${skill ? `${skill.title}，${skill.path}。请先读取并使用它。` : '自由提问，可根据需要读取已配置的 Skill。'}
${slidesInstructions}
可用 Skills：${JSON.stringify(context.skills.map(({ title, path }) => ({ title, path })))}
当用户需要图谱、课件、视频、文档等学习资料时，将真实结果写入 ${context.outputsDir} 下对应的类型子目录，同时将界面展示内容写入 ${resultPath}（UTF-8 JSON 对象，id 为 ${resultId}，title 为资料标题）。
根据结果选择 kind 及字段：markdown 使用 content；quiz 使用 questions:[{id,prompt,knowledgePoint?,difficulty?,page?,hints?,answer?,explanation?}]；mindmap 使用 nodes:[{id,label,page?}]、edges:[{source,target,label?}]；knowledge-graph 必须读取知识图谱 Skill 及其 references/schema.md，使用 schemaVersion:2；PDF 课件使用 kind:slides、chapters:[{title,url,filename?}]；文字课件使用 kind:slides、slides:[{title,content}]；video 或 file 使用 url 和可选 filename。
指定的 ${resultPath} 是待检查的结果文件，只写此 JSON，不另写 result-*.json，也不覆盖历史资料。
本界面支持 Markdown 表格、图片，以及逐题练习卡片、上述知识结构和课件资料。静态图可保存为 outputs/notes/ 中的 PNG 或 SVG，并用 Markdown 图片语法引用实际文件。`;
    const structureScope = ['section', 'chapter'].includes(request.scope)
      ? `本次范围是${request.scope === 'section' ? '当前节' : '当前章'}。${request.chapter
        ? `目录定位：${request.chapter.title}，从 PDF 第 ${request.chapter.page} 页开始。`
        : '当前目录未能定位该范围，请先依据当前 PDF 页和原始教材的标题确定所属章或节。'}`
      : '';
    const rangeInstructions = request.scope === 'range'
      ? `本轮明确限定主教材 PDF 第 ${request.pageRange.start}–${request.pageRange.end} 页。只对这段页码完成用户任务。`
      : request.scope === 'selection' ? '本轮只处理 selectedText 中引用的文字。' : '';
    const userMessage = `用户要求：${request.prompt}
操作：${request.skillId}；范围：${request.scope}；当前 PDF 页码：${request.page}；章节：${request.chapter?.title || '未指定'}。
教材总页数：${context.totalPages || '尚未记录'}。知识图谱深度：${request.knowledgeGraphDetail || 'overview'}。
${structureScope}
${rangeInstructions}
以下 JSON 只提供教材和历史上下文：
${JSON.stringify({ chapter: request.chapter, totalPages: context.totalPages, pageRange: request.pageRange, pageText: request.pageText, selectedText: request.selectedText, history: request.history, currentArtifact: request.artifact })}`;

    yield { type: 'progress', message: `已连接 ${status.name}，正在阅读课程上下文…` };
    if (template) yield { type: 'progress', message: `${templateTitle}。${status.latex.message}` };

    const piTools = createPiTools({
      textbookPath: context.textbookPath,
      textbookDir: context.textbookDir,
      outputsDir: context.outputsDir,
      courseDir: context.courseDir,
    });

    const model = getModel(status.config.provider, status.config.model) || (await modelRuntime.getAvailable()).find(m => m.provider === status.config.provider);
    if (!model) fail(503, '没有找到可用的模型，请检查 API Key 配置。');

    const skillFiles = context.skills
      .filter(s => s.path)
      .map(s => ({ name: s.title, description: s.description, filePath: s.path, baseDir: resolve(s.path, '..'), source: 'custom' }));

    const loader = new DefaultResourceLoader({
      cwd: context.courseDir,
      agentDir: agentDir,
      systemPromptOverride: () => instructions,
      skillsOverride: (current) => ({ skills: [...current.skills, ...skillFiles], diagnostics: current.diagnostics }),
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: context.courseDir,
      agentDir: agentDir,
      model,
      modelRuntime,
      tools: ['read', 'bash', 'edit', 'write', 'read_textbook_pages', 'read_file', 'list_outputs'],
      customTools: piTools,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    });

    const abortController = context.signal ? new AbortController() : null;
    if (context.signal) {
      context.signal.addEventListener('abort', () => {
        void session.abort().catch(() => {});
      });
    }

    let agentDone = false;
    let agentError = null;

    const eventPromise = new Promise((resolve) => {
      session.subscribe((event) => {
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          // pi text_delta 事件通过 yield 流式输出
        }
        if (event.type === 'agent_end') {
          agentDone = true;
          resolve();
        }
      });
    });

    // 启动 prompt
    const promptPromise = session.prompt(userMessage);

    // 流式输出 text_delta
    const textDeltas = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        textDeltas.push(event.assistantMessageEvent.delta);
      }
    });

    // 等待 agent 完成
    try {
      await promptPromise;
    } catch (error) {
      agentError = error;
    }
    unsubscribe();

    // 输出累积的文本
    const fullText = textDeltas.join('');
    if (fullText) {
      yield { type: 'text', content: fullText };
    }

    if (agentError) {
      yield { type: 'error', message: agentError.message };
      return;
    }

    // 检查是否有 artifact 生成
    let artifactPath;
    try {
      artifactPath = await resolveCourseFile(request.book.id, `outputs/${resultName}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (artifactPath) {
      const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
      if (artifact.id !== resultId) throw new Error('生成资料的 id 不正确，请让 Agent 重新生成。');
      yield { type: 'artifact', artifact };
      await rm(artifactPath, { force: true }).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }

    yield { type: 'done' };
  } finally {
    activeRun = false;
  }
}

export function disposePiAgent() {
  modelRuntime = null;
}
```

- [ ] **Step 2: 验证 import 正常**

```bash
node -e "import('./server/pi-agent.mjs').then(m => console.log('OK:', Object.keys(m))).catch(e => console.error('FAIL:', e.message))"
```

Expected: `OK: [ 'skillsCatalog', 'initModelRuntime', 'getPiAgentStatus', 'configureProvider', 'listModels', 'getSkillAvailability', 'runPiAgent', 'disposePiAgent' ]`

- [ ] **Step 3: Commit**

```bash
git add server/pi-agent.mjs
git commit -m "feat: 添加 pi agent 集成层

ModelRuntime 初始化、provider 配置、状态查询、
agent 运行和事件转换，替代 ACP 连接逻辑。"
```

---

## Task 4: 改造 agent.mjs — 委托给 pi-agent

**Files:**
- Modify: `server/agent.mjs`（几乎全部重写，只保留 re-export）

**Interfaces:**
- Consumes: `getPiAgentStatus`/`configureProvider`/`runPiAgent`/`disposePiAgent`/`getSkillAvailability`/`initModelRuntime`/`skillsCatalog` from Task 3
- Produces: re-export 现有 API 签名供 api.mjs 使用

- [ ] **Step 1: 重写 agent.mjs**

将 `server/agent.mjs` 全部替换为：

```javascript
export {
  skillsCatalog,
  initModelRuntime,
  getPiAgentStatus as getAgentStatus,
  configureProvider as configureAgent,
  listModels,
  getSkillAvailability,
  runPiAgent as codingAgent,
  disposePiAgent as disposeAgent,
} from './pi-agent.mjs';
```

- [ ] **Step 2: 验证 re-export 正常**

```bash
node -e "import('./server/agent.mjs').then(m => console.log('OK:', Object.keys(m))).catch(e => console.error('FAIL:', e.message))"
```

Expected: `OK: [ 'skillsCatalog', 'initModelRuntime', 'getAgentStatus', 'configureAgent', 'listModels', 'getSkillAvailability', 'codingAgent', 'disposeAgent' ]`

- [ ] **Step 3: Commit**

```bash
git add server/agent.mjs
git commit -m "refactor: agent.mjs 委托给 pi-agent

移除 ACP 连接逻辑，re-export pi-agent 函数。"
```

---

## Task 5: 改造 api.mjs — 端点调整

**Files:**
- Modify: `server/api.mjs`

**Interfaces:**
- Consumes: `getAgentStatus`/`configureAgent`/`listModels`/`codingAgent`/`getSkillAvailability` from agent.mjs（已委托给 pi-agent）
- Produces: HTTP 端点供前端调用

- [ ] **Step 1: 修改 import 行**

在 `server/api.mjs` 顶部，将第 6 行的 import 替换：

```javascript
import { codingAgent, getAgentStatus, getSkillAvailability, configureAgent, listModels } from './agent.mjs';
export { disposeAgent } from './agent.mjs';
```

- [ ] **Step 2: 修改 agent 端点部分**

在 `handleApi` 函数中，将第 208-220 行的 `agentActions` 块替换为：

```javascript
  if (pathname === '/api/agent/configure') {
    if (req.method !== 'POST') throw new HttpError(405, '此地址仅支持 POST。');
    if (!req.headers['content-type']?.includes('application/json')) throw new HttpError(415, '请以 JSON 格式发送请求。');
    return sendJson(res, 200, await configureAgent(await readBody(req)));
  }
  if (pathname === '/api/agent/models') {
    if (req.method !== 'GET') throw new HttpError(405, '此地址仅支持 GET。');
    const providerId = new URL(req.url || '/', 'http://localhost').searchParams.get('provider') || '';
    return sendJson(res, 200, await listModels(providerId));
  }
```

- [ ] **Step 3: 验证构建**

```bash
node -e "import('./server/api.mjs').then(m => console.log('OK:', typeof m.createApiMiddleware)).catch(e => console.error('FAIL:', e.message))"
```

Expected: `OK: function`

- [ ] **Step 4: Commit**

```bash
git add server/api.mjs
git commit -m "refactor: api.mjs 端点调整

移除 connect/disconnect/login 端点，
新增 configure 和 models 端点。"
```

---

## Task 6: 改造 index.mjs — 初始化 ModelRuntime

**Files:**
- Modify: `server/index.mjs`

**Interfaces:**
- Consumes: `initModelRuntime` from agent.mjs，`getStorageInfo` from course-store

- [ ] **Step 1: 修改 import 行**

在 `server/index.mjs` 第 6 行后添加 `initModelRuntime`：

将：
```javascript
import { createApiMiddleware, disposeAgent } from './api.mjs';
```
改为：
```javascript
import { createApiMiddleware, disposeAgent } from './api.mjs';
import { initModelRuntime } from './agent.mjs';
import { getStorageInfo } from './course-store.mjs';
```

- [ ] **Step 2: 在 server.listen 前初始化 ModelRuntime**

在 `server.listen(...)` 调用之前（约第 95 行），插入初始化代码：

将：
```javascript
server.listen(port, host, () => {
  const actualPort = server.address().port;
  console.log(`课程工作台：http://${host}:${actualPort}`);
  process.send?.({ type: 'ready', port: actualPort });
});
```

改为：
```javascript
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
```

- [ ] **Step 3: Commit**

```bash
git add server/index.mjs
git commit -m "feat: 启动时初始化 ModelRuntime

读取存储目录并初始化 pi agent 的 ModelRuntime。"
```

---

## Task 7: 移除旧 ACP 客户端文件

**Files:**
- Delete: `server/agent-providers.mjs`, `server/codex-client.mjs`, `server/claude-client.mjs`, `server/opencode-client.mjs`, `server/acp-client.mjs`, `server/command-client.mjs`, `server/opencode-environment.mjs`, `server/agent-process.mjs`

- [ ] **Step 1: 删除文件**

```bash
rm server/agent-providers.mjs server/codex-client.mjs server/claude-client.mjs server/opencode-client.mjs server/acp-client.mjs server/command-client.mjs server/opencode-environment.mjs server/agent-process.mjs
```

- [ ] **Step 2: 检查没有其他文件引用它们**

```bash
grep -rn "agent-providers\|codex-client\|claude-client\|opencode-client\|acp-client\|command-client\|opencode-environment\|agent-process" server/ src/ --include="*.mjs" --include="*.ts" --include="*.tsx"
```

Expected: 无输出（没有残留引用）。如果有，修复引用后继续。

- [ ] **Step 3: 验证构建**

```bash
node -e "import('./server/index.mjs').then(() => console.log('OK')).catch(e => console.error('FAIL:', e.message))"
```

Expected: `OK`（或正常启动后超时，因为 server.listen 会阻塞）

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: 移除 ACP 客户端文件

删除 codex-client、claude-client、opencode-client、
acp-client、command-client、opencode-environment、
agent-process、agent-providers。"
```

---

## Task 8: 改造前端类型 — types.ts 和 skill-client.ts

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/skill-client.ts`

**Interfaces:**
- Produces: 新的 `AgentStatus` 类型，`configureProvider`/`listModels` 函数

- [ ] **Step 1: 修改 skill-client.ts 中的 AgentStatus 类型**

将 `src/lib/skill-client.ts` 第 1-30 行替换为：

```typescript
import type { SkillEvent, SkillInfo, SkillRequest } from './types';

export type AgentProvider = string;

export interface AgentStatus {
  connected: boolean;
  phase: 'connected' | 'not-configured' | 'disconnected';
  name: string;
  message: string;
  provider: AgentProvider;
  providers: { id: AgentProvider; name: string }[];
  models: { id: string; name: string; isDefault: boolean }[];
  config: { provider: AgentProvider; model: string; skillPaths: Record<string, string> };
  skills: (Omit<SkillInfo, 'available'> & { path: string | null; configured: boolean })[];
  busy: boolean;
  latex?: { engine: string; version: string; missing: string[]; preferredMathFonts: boolean; ready: boolean; message: string };
  modelNote: string;
}
```

- [ ] **Step 2: 修改 agent action 函数**

将 `src/lib/skill-client.ts` 中第 56-69 行（`agentAction` 及相关导出）替换为：

```typescript
async function agentAction(action: string, value: unknown = {}, method = 'POST'): Promise<AgentStatus> {
  const response = await fetch(`/api/agent/${action}`, {
    method,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<AgentStatus>;
}

export const configureProvider = (config: { provider?: string; apiKey?: string; baseUrl?: string; model?: string; skillPaths?: Record<string, string> }) => agentAction('configure', config);
export const saveAgentConfig = configureProvider;

export async function listModels(providerId: string): Promise<{ id: string; name: string; isDefault: boolean }[]> {
  const response = await fetch(`/api/agent/models?provider=${encodeURIComponent(providerId)}`);
  if (!response.ok) throw await responseError(response);
  return response.json();
}
```

- [ ] **Step 3: 确保 skillsFromStatus 不变**

`skillsFromStatus` 函数保持不变（第 71-76 行），因为它引用的 `status.connected` 和 `status.skills` 字段名未变。

- [ ] **Step 4: 验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

Expected: 无错误（或仅有 AgentConnection.tsx 的错误，将在 Task 9 修复）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/skill-client.ts src/lib/types.ts
git commit -m "refactor: 前端类型适配 pi agent

移除 ACP 相关字段，新增 provider/apiKey/baseUrl 配置。
新增 configureProvider 和 listModels 函数。"
```

---

## Task 9: 改造 AgentConnection.tsx — Provider + API Key UI

**Files:**
- Modify: `src/components/AgentConnection.tsx`

**Interfaces:**
- Consumes: `AgentStatus`/`configureProvider`/`listModels`/`getAgentStatus` from skill-client

- [ ] **Step 1: 重写 AgentConnection.tsx**

将 `src/components/AgentConnection.tsx` 全部替换为：

```tsx
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Eye, EyeOff, LoaderCircle, RefreshCw, Key, Plug } from 'lucide-react';
import { configureProvider, getAgentStatus, listModels, saveAgentConfig, type AgentProvider, type AgentStatus } from '../lib/skill-client';

interface Props {
  status: AgentStatus | null;
  active: boolean;
  busy: boolean;
  onChange: (status: AgentStatus) => void;
}

const groups = [
  { name: '讲解与问答', owner: '同学 A', ids: ['textbook-parse', 'explain', 'quiz'] },
  { name: '知识结构', owner: '同学 B', ids: ['mindmap', 'knowledge-graph'] },
  { name: '课件与视频', owner: '同学 C', ids: ['slides', 'video'] },
];

export default function AgentConnection({ status, active, busy, onChange }: Props) {
  const [provider, setProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [modelDraft, setModelDraft] = useState('');
  const [models, setModels] = useState<{ id: string; name: string; isDefault: boolean }[]>([]);
  const [showKey, setShowKey] = useState(false);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const initialized = useRef(false);
  const locked = !!working || busy || !!status?.busy;
  const connected = !!status?.connected;
  const configured = status?.skills.filter(skill => skill.configured).length || 0;

  useEffect(() => {
    if (!status || initialized.current) return;
    initialized.current = true;
    setProvider(status.config.provider || '');
    setModelDraft(status.config.model || '');
    setPaths(Object.fromEntries(status.skills.map(skill => [skill.id, skill.path || ''])));
  }, [status]);

  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    getAgentStatus(abort.signal).then(onChange).catch(err => {
      if (!abort.signal.aborted) setError(err.message);
    });
    return () => abort.abort();
  }, [active, onChange]);

  useEffect(() => {
    if (provider && connected) {
      listModels(provider).then(setModels).catch(() => setModels([]));
    } else {
      setModels(status?.models || []);
    }
  }, [provider, connected, status?.models]);

  async function perform(label: string, action: () => Promise<AgentStatus>, message = '') {
    if (locked) return;
    setWorking(label); setError(''); setNotice('');
    try { onChange(await action()); setNotice(message); }
    catch (err) {
      setError(err instanceof Error ? err.message : '操作未完成，请重试。');
      getAgentStatus().then(onChange).catch(() => {});
    } finally { setWorking(''); }
  }

  async function saveProvider() {
    if (!provider) return;
    await perform('保存配置', () => configureProvider({ provider, ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) }), '配置已保存。');
  }

  const step = connected ? 3 : provider ? 2 : 1;

  return <div className="agent-setup">
    <ol className="connection-steps" aria-label="Agent 配置步骤">
      {['选择模型服务', '填写 API Key', '开始使用'].map((label, index) => <li key={label} className={step >= index + 1 ? 'current' : ''}>
        <span>{step > index + 1 || connected ? <Check size={12}/> : index + 1}</span>{label}
      </li>)}
    </ol>

    <label className="agent-field agent-choice">模型服务 Provider
      <select aria-label="Provider" value={provider} disabled={locked || !status} onChange={event => setProvider(event.target.value)}>
        {!status && <option value="">正在读取…</option>}
        {status?.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <small>选择 LLM 服务商，填写 API Key 后即可使用。</small>
    </label>

    <section className={`agent-card ${connected ? 'is-connected' : ''}`} aria-label="模型配置">
      <div className="agent-card-heading">
        <span className="agent-icon"><Key size={22}/></span>
        <div><h3>{status?.name || provider || '未选择'}</h3><p>直连 LLM API · 无需安装</p></div>
        <span className={`agent-phase ${connected ? 'ready' : ''}`}><span className={`status-dot ${connected ? 'online' : ''}`}/>{connected ? '已配置' : '待配置'}</span>
      </div>
      <p className="agent-description">{status?.message || '正在读取配置…'}</p>

      {connected && <div className="agent-account"><Check size={14}/><span>API Key 已验证</span></div>}

      <label className="agent-field">API Key
        <span className="agent-model-input">
          <input type={showKey ? 'text' : 'password'} aria-label="API Key" value={apiKey} disabled={locked} onChange={event => setApiKey(event.target.value)} placeholder="sk-..." autoComplete="off" spellCheck={false}/>
          <button type="button" className="text-button" onClick={() => setShowKey(v => !v)} aria-label={showKey ? '隐藏' : '显示'}>{showKey ? <EyeOff size={15}/> : <Eye size={15}/>}</button>
        </span>
        <small>从模型服务商获取 API Key，保存在本机 agent 目录中。</small>
      </label>

      <label className="agent-field">Base URL（可选）
        <input aria-label="Base URL" value={baseUrl} disabled={locked} onChange={event => setBaseUrl(event.target.value)} placeholder="留空使用默认端点" autoComplete="off" spellCheck={false}/>
        <small>使用自定义端点或代理时填写，如 OpenAI 兼容服务。</small>
      </label>

      <label className="agent-field">使用模型
        <select aria-label="使用模型" value={modelDraft} disabled={locked || !connected} onChange={event => { setModelDraft(event.target.value); void perform('保存模型', () => saveAgentConfig({ model: event.target.value }), '模型已保存。'); }}>
          <option value="">跟随默认</option>
          {models.map(m => <option key={m.id} value={m.id}>{m.name}{m.isDefault ? ' · 默认' : ''}</option>)}
        </select>
        <small>{connected ? status?.modelNote || '选择模型后即可提问。' : '配置 API Key 后可选择模型。'}</small>
      </label>

      <div className="agent-vision-note">
        <p>读取教材截图、扫描页和图表，需要模型支持图片输入。</p>
      </div>

      <div className="agent-actions">
        <button className="primary-button" disabled={locked || !provider} onClick={() => void saveProvider()}>
          {working === '保存配置' ? <LoaderCircle size={16} className="spin"/> : <Plug size={16}/>}保存并连接
        </button>
        <button className="agent-refresh" disabled={locked} onClick={() => void perform('刷新', () => getAgentStatus(), '状态已更新。')}>
          <RefreshCw size={14} className={working === '刷新' ? 'spin' : ''}/>刷新状态
        </button>
      </div>
    </section>

    {error && <p className="agent-feedback error" role="alert">{error}</p>}
    {notice && <p className="agent-feedback" role="status">{notice}</p>}
    {busy && <p className="agent-feedback">当前任务结束后，可以更改配置。</p>}

    <details className="agent-details">
      <summary>课件编译环境<span>{status?.latex?.ready ? '依赖已找到' : '需要检查'}</span><ChevronDown size={15}/></summary>
      <p>{status?.latex?.message || '刷新状态以检查课件编译环境。'}</p>
      {status?.latex?.engine && <p>XeLaTeX：<code>{status.latex.engine}</code></p>}
      {status?.latex?.version && <p>{status.latex.version}</p>}
      {status?.latex && <p>{status.latex.preferredMathFonts ? '数学字体：Computer Modern 与 AMS Fonts。' : '数学字体将在生成时按编译环境检查并选择。'}</p>}
      <button className="agent-refresh" disabled={locked} onClick={() => void perform('检查课件环境', () => getAgentStatus(), '课件编译环境已检查。')}><RefreshCw size={14}/>重新检查</button>
    </details>

    <details className="agent-details skill-paths">
      <summary>接入 Skill<span>{configured} / {status?.skills.length ?? groups.reduce((total, group) => total + group.ids.length, 0)} 已配置</span><ChevronDown size={15}/></summary>
      {groups.map(group => <fieldset key={group.name} disabled={locked}>
        <legend>{group.name}<span>{group.owner}</span></legend>
        {group.ids.map(id => {
          const skill = status?.skills.find(item => item.id === id);
          return <label className="agent-field" key={id}><span>{skill?.title || id}<small>{skill?.configured ? '已配置' : '待配置'}</small></span>
            <input value={paths[id] || ''} onChange={event => setPaths(previous => ({ ...previous, [id]: event.target.value }))} placeholder="/你的 Skill 文件夹/SKILL.md" autoComplete="off" spellCheck={false}/>
          </label>;
        })}
      </fieldset>)}
      <button className="secondary-button" disabled={locked || !status} onClick={() => void perform('保存 Skill', () => saveAgentConfig({ skillPaths: paths }), 'Skill 路径已保存。')}>
        {working === '保存 Skill' ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>}保存 Skill 路径
      </button>
    </details>
    <p className="agent-footnote">问答、文件处理和 Skill 调用由内置 Agent 执行。API Key 保存在本机，不经过第三方中转。</p>
  </div>;
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 3: 验证 Vite 构建**

```bash
npm run build
```

Expected: 构建成功，无错误。

- [ ] **Step 4: Commit**

```bash
git add src/components/AgentConnection.tsx
git commit -m "feat: AgentConnection 改为 Provider + API Key + Base URL 配置

移除 ACP 连接、登录、可执行文件路径等 UI，
改为 provider 下拉 + API Key + Base URL + 模型选择。"
```

---

## Task 10: 改造 App.tsx — 适配新 AgentStatus

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: 新的 `AgentStatus` 类型（已无 `phase`/`connectionModes`/`login` 等字段）

- [ ] **Step 1: 检查 App.tsx 中对旧 AgentStatus 字段的引用**

搜索 App.tsx 中对 `status.phase`、`status.connectionModes`、`status.login`、`status.signedIn`、`status.installed`、`status.accountLabel`、`status.defaultCommand`、`status.bundledAdapter`、`status.executable` 等旧字段的引用。

App.tsx 中主要通过 `AgentConnection` 组件传递 status，不直接访问这些字段。`updateAgentStatus` 只是 `setAgentStatus` + `setSkills`，不依赖具体字段。因此 App.tsx 大概率不需要改动。

- [ ] **Step 2: 如果有引用旧字段的地方，修复它们**

如果搜索发现 App.tsx 引用了已删除的字段，移除或替换为新字段。

- [ ] **Step 3: 验证构建**

```bash
npm run build
```

Expected: 构建成功。

- [ ] **Step 4: Commit（如果有改动）**

```bash
git add src/App.tsx
git commit -m "fix: App.tsx 适配新 AgentStatus 类型"
```

---

## Task 11: 改造 desktop/main.cjs — 微调环境变量

**Files:**
- Modify: `desktop/main.cjs`

- [ ] **Step 1: 检查 main.cjs 中的 PATH 设置**

`desktop/main.cjs` 第 52 行设置了 PATH，包含 `/Library/TeX/texbin` 等路径。这些用于 LaTeX 编译和 ACP adapter。ACP adapter 已移除，但 LaTeX 路径仍需保留（课件生成需要）。

检查是否需要移除 ACP 相关的环境变量。现有代码中 `INITIAL_AGENT_MODE` 等变量在 `agent-providers.mjs` 中设置，已在 Task 7 移除，不影响 main.cjs。

main.cjs 的改动很小或不需要改动。

- [ ] **Step 2: 如果需要改动，修改后验证**

```bash
npm run build && npm run desktop 2>&1 | head -20
```

Expected: Electron 窗口启动，显示应用界面。

- [ ] **Step 3: Commit（如果有改动）**

```bash
git add desktop/main.cjs
git commit -m "chore: 微调 desktop 环境变量"
```

---

## Task 12: 清理 package.json — 移除 ACP 依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 移除 ACP 依赖**

在 `package.json` 的 `dependencies` 中，移除以下三行：

```json
"@agentclientprotocol/claude-agent-acp": "^0.76.0",
"@agentclientprotocol/codex-acp": "^1.11.0",
"@agentclientprotocol/sdk": "^1.4.0",
```

- [ ] **Step 2: 运行 npm install 清理 node_modules**

```bash
npm install
```

- [ ] **Step 3: 验证构建**

```bash
npm run build
```

Expected: 构建成功。

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: 移除 ACP 协议依赖

不再需要 @agentclientprotocol 包。"
```

---

## Task 13: 端到端验证

**Files:**
- 无文件改动，仅验证

- [ ] **Step 1: 启动开发服务器**

```bash
npm run dev
```

- [ ] **Step 2: 打开浏览器访问应用**

访问 `http://127.0.0.1:5173`（或 Vite 显示的端口）。

- [ ] **Step 3: 验证设置面板**

打开工作区设置，确认：
- Provider 下拉列表显示 pi-ai 支持的 provider（Anthropic、OpenAI、Google 等）
- API Key 输入框正常
- Base URL 输入框正常
- Skill 路径配置正常
- LaTeX 环境检测正常

- [ ] **Step 4: 配置一个 provider**

选择一个 provider（如 Anthropic），填入 API Key，点击"保存并连接"。确认：
- 状态变为"已配置"
- 模型列表加载

- [ ] **Step 5: 发送一个测试请求**

在 CopilotPanel 中发送一个简单的"自由提问"请求。确认：
- SSE 事件正常流式输出
- 文本逐字显示
- 完成后显示"done"

- [ ] **Step 6: 如果有问题，记录并修复**

记录任何错误或异常行为，在后续 commit 中修复。

- [ ] **Step 7: 验证 Electron 桌面模式**

```bash
npm run desktop
```

确认桌面应用正常启动，设置和对话功能正常。

- [ ] **Step 8: Final commit（如果有修复）**

```bash
git add -A
git commit -m "fix: 端到端验证修复"
```
