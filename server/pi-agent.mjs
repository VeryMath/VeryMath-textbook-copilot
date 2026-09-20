import { randomUUID } from 'node:crypto';
import { access, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import JSON5 from 'json5';
import { ModelRuntime, createAgentSession, SessionManager, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { getStorageInfo, saveAgentSettings, resolveCourseFile, getCourseReferences } from './course-store.mjs';
import { getLatexEnvironment } from './latex-environment.mjs';
import { slideTemplates, slideTemplateDirectory, selectSlideTemplate } from './slide-templates.mjs';
import { createPiTools } from './pi-tools.mjs';
import { tutoringSkills } from './skills/tutoring.mjs';
import { structureSkills } from './skills/structure.mjs';
import { materialsSkills } from './skills/materials.mjs';

export const skillsCatalog = [...tutoringSkills, ...structureSkills, ...materialsSkills];

let modelRuntime = null;
let agentDir = null;
let dataDir = null;
let activeRun = false;
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

async function readModelConfig() {
  try { return JSON5.parse(await readFile(join(agentDir, 'models.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
}

export async function initModelRuntime(dataDirectory) {
  dataDir = dataDirectory;
  agentDir = join(dataDirectory, 'agent');
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store.json'),
  });
  const saved = await preferences();
  savedProvider = saved.provider || 'anthropic';
  savedModel = saved.model || '';
}

async function reloadModelRuntime() {
  if (!dataDir) return;
  modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store.json'),
  });
}

export async function getPiAgentStatus(refresh = false) {
  if (!modelRuntime) throw new Error('ModelRuntime 尚未初始化。');
  const saved = await preferences();
  const providerId = saved.provider || savedProvider;
  const providers = modelRuntime.getProviders().map(p => ({ id: p.id, name: p.name }));
  const modelConfig = await readModelConfig();
  const providerConfigs = Object.fromEntries(Object.entries(modelConfig.providers || {}).map(([id, config]) => [id, {
    baseUrl: config.baseUrl || '', model: id === 'custom' ? config.models?.[0]?.id || '' : '',
  }]));

  let models = [];
  let connected = false;
  let authStatus = null;
  try {
    if (providerId === 'custom') {
      const auth = await modelRuntime.checkAuth('custom');
      if (auth?.type) {
        connected = true;
        const available = await modelRuntime.getAvailable();
        models = available.filter(m => m.provider === 'custom').map(m => ({ id: m.id, name: m.name || m.id, isDefault: false }));
      }
    } else {
      authStatus = await modelRuntime.checkAuth(providerId);
      if (authStatus?.type) {
        connected = true;
        const available = await modelRuntime.getAvailable();
        models = available
          .filter(m => m.provider === providerId)
          .map(m => ({ id: m.id, name: m.name || m.id, isDefault: false }));
      }
    }
  } catch {
    // auth check failed; surface as disconnected phase below
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
    config: { provider: providerId, model: saved.model ?? savedModel,
      baseUrl: providerConfigs[providerId]?.baseUrl || '', providerConfigs, skillPaths: saved.skillPaths || {} },
    skills,
    busy: activeRun,
    latex: await getLatexEnvironment(refresh),
    modelNote: connected ? `已配置 ${models.length} 个可用模型。` : '配置 API Key 后可选择模型。',
  };
}

async function writeProviderConfig(config, provider, baseUrl, modelId) {
  const modelsPath = join(agentDir, 'models.json');
  if (!config.providers) config.providers = {};
  const current = { ...config.providers[provider] };
  if (baseUrl) current.baseUrl = baseUrl;
  else delete current.baseUrl;
  if (provider === 'custom') {
    current.api ||= 'openai-completions';
    current.models = [...(current.models || [])];
    if (!current.models.some(model => model.id === modelId)) current.models.push({ id: modelId, name: modelId });
  }
  if (Object.keys(current).length) config.providers[provider] = current;
  else delete config.providers[provider];
  await writeFile(modelsPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  await reloadModelRuntime();
}

async function writeApiKey(provider, apiKey) {
  const authPath = join(agentDir, 'auth.json');
  let auth = {};
  try { auth = JSON.parse(await readFile(authPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  auth[provider] = { type: 'api_key', key: apiKey };
  await writeFile(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
  await reloadModelRuntime();
}

export async function configureProvider(value = {}) {
  if (activeRun) fail(409, '请等待当前操作完成。');
  const saved = await preferences();
  const previousProvider = saved.provider || savedProvider;
  const provider = value.provider ?? previousProvider;
  if (typeof provider !== 'string' || (provider !== 'custom' && !modelRuntime.getProviders().some(item => item.id === provider))) {
    fail(400, '请选择有效的 provider。');
  }
  const modelConfig = await readModelConfig();
  const current = modelConfig.providers?.[provider];
  let baseUrl = current?.baseUrl || '';
  let model = provider === previousProvider ? saved.model ?? savedModel : provider === 'custom' ? current?.models?.[0]?.id || '' : '';
  if (value.apiKey !== undefined) {
    if (typeof value.apiKey !== 'string' || value.apiKey.length > 10000) fail(400, 'API Key 格式不正确。');
  }
  if (value.baseUrl !== undefined) {
    if (typeof value.baseUrl !== 'string' || value.baseUrl.length > 2000) fail(400, 'Base URL 格式不正确。');
    baseUrl = value.baseUrl.trim();
  }
  if (baseUrl) {
    let url;
    try { url = new URL(baseUrl); } catch { fail(400, 'Base URL 需要填写有效的 HTTP 或 HTTPS 地址。'); }
    if (!['http:', 'https:'].includes(url.protocol)) fail(400, 'Base URL 需要填写有效的 HTTP 或 HTTPS 地址。');
  }
  if (value.model !== undefined) {
    if (typeof value.model !== 'string' || value.model.length > 200) fail(400, '模型名称不正确。');
    model = value.model.trim();
  }
  if (provider === 'custom' && (!baseUrl || !model)) {
    fail(400, '自定义 API 需要填写 Base URL 和模型名称。');
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
  const baseUrlChanged = value.baseUrl !== undefined && baseUrl !== (current?.baseUrl || '');
  const modelAdded = provider === 'custom' && value.model !== undefined && !current?.models?.some(item => item.id === model);
  if (baseUrlChanged || modelAdded) await writeProviderConfig(modelConfig, provider, baseUrl, model);
  if (value.apiKey) await writeApiKey(provider, value.apiKey);
  saved.provider = provider;
  saved.model = model;
  delete saved.baseUrl;
  await saveAgentSettings(saved);
  savedProvider = provider;
  savedModel = model;
  return getPiAgentStatus();
}

export async function listModels(providerId) {
  if (!modelRuntime) throw new Error('ModelRuntime 尚未初始化。');
  try {
    const authStatus = await modelRuntime.checkAuth(providerId);
    if (!authStatus?.type) return [];
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
    const isWindows = process.platform === 'win32';
    const shellTool = isWindows ? 'powershell' : 'bash';
    const nodeCommand = isWindows
      ? `${process.env.ELECTRON_RUN_AS_NODE === '1' ? "$env:ELECTRON_RUN_AS_NODE='1'; " : ''}& '${process.execPath.replaceAll("'", "''")}'`
      : `${process.env.ELECTRON_RUN_AS_NODE === '1' ? 'env ELECTRON_RUN_AS_NODE=1 ' : ''}"${process.execPath}"`;

    const slidesTask = request.skillId === 'slides' || request.artifact?.kind === 'slides';
    const textbookTask = ['slides', 'mindmap', 'knowledge-graph', 'video'].some(kind =>
      request.skillId === kind || request.artifact?.kind === kind);
    const referenceInstructions = textbookTask ? '' : `
本轮辅助资料的阅读范围由此清单确定：${JSON.stringify(await getCourseReferences(request.book.id, request.referenceIds))}。清单为空且已选择教材范围时围绕主教材回答。禁止自行扩展到课程中的其他辅助资料。
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
${request.scope === 'none' ? '本轮没有选择主教材范围，不附加当前页或章节，也不要自动读取主教材。保留用户明确选定的辅助资料、已有成品和 Skill；若制作任务缺少必要范围，先询问用户。没有这些上下文时直接回答问题。' : ''}
${referenceInstructions}
思维导图、知识图谱、讲解视频和课件的生成与修改，均围绕主教材的内容、章节和用户选定范围组织。上述任务禁止读取或参考本课程上传的辅助资料，包括课程 references 目录中的原文件、对应解析缓存及历史对话中的资料转述。这项要求也适用于自由问答中发起的导图、图谱、视频、PPT 或幻灯片制作。修改已有结果时核对主教材，读取已有结果及其源码。Skill 自带的说明文档和模板资源用于执行制作流程。
命令执行工具：${shellTool}，使用该工具对应的命令语法。可用的本机 Node.js：${nodeCommand}。教材读取工具：read_textbook_pages。纯文字读取用 images=none，需要原页校对用 images=pages，需要独立图片用 images=all。
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
操作：${request.skillId}；范围：${request.scope}；当前 PDF 页码：${request.scope === 'none' ? '未指定' : request.page}；章节：${request.chapter?.title || '未指定'}。
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

    const model = modelRuntime.getModel(status.config.provider, status.config.model) || (await modelRuntime.getAvailable()).find(m => m.provider === status.config.provider);
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
      tools: ['read', shellTool, 'edit', 'write', 'read_textbook_pages', 'read_file', 'list_outputs'],
      customTools: piTools,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    });

    // 事件队列：subscriber 推送事件，generator 消费并 yield，实现真正的流式输出
    const eventQueue = [];
    let resolveEvent = null;
    let promptDone = false;
    let promptError = null;
    let hasText = false;

    const unsubscribe = session.subscribe((event) => {
      console.error(`[pi-agent] event: ${event.type}` + (event.assistantMessageEvent ? `.${event.assistantMessageEvent.type}` : ''));
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        hasText = true;
        eventQueue.push({ type: 'text', content: event.assistantMessageEvent.delta });
      } else if (event.type === 'message_end' && !hasText && event.message?.role === 'assistant') {
        const text = event.message.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
        if (text) { hasText = true; eventQueue.push({ type: 'text', content: text }); }
      } else if (event.type === 'tool_execution_start') {
        eventQueue.push({ type: 'progress', message: `正在执行: ${event.toolName}` });
      } else if (event.type === 'tool_execution_end') {
        eventQueue.push({ type: 'progress', message: '工具执行完成' });
      } else if (event.type === 'auto_retry_start') {
        eventQueue.push({ type: 'progress', message: `模型连接暂时失败，正在重试（${event.attempt}/${event.maxAttempts}）…` });
      }
      if (resolveEvent) { resolveEvent(); resolveEvent = null; }
    });

    if (context.signal) {
      context.signal.addEventListener('abort', () => {
        void session.abort().catch(() => {});
        promptDone = true;
        if (resolveEvent) { resolveEvent(); resolveEvent = null; }
      });
    }

    const promptPromise = session.prompt(userMessage)
      .catch(e => { console.error(`[pi-agent] prompt error: ${e.message}`); promptError = e; })
      .finally(() => { console.error(`[pi-agent] prompt done, hasText=${hasText}`); promptDone = true; if (resolveEvent) { resolveEvent(); resolveEvent = null; } });

    // 流式 yield：队列有事件就输出，否则等待唤醒；prompt 完成且队列清空后退出
    while (!promptDone || eventQueue.length > 0) {
      if (eventQueue.length === 0) {
        await new Promise(r => { resolveEvent = r; });
        continue;
      }
      const evt = eventQueue.shift();
      if (evt) yield evt;
    }

    unsubscribe();
    await promptPromise;
    context.signal?.throwIfAborted();

    const lastAssistant = session.messages.findLast(message => message.role === 'assistant');
    if (!promptError && ['error', 'aborted'].includes(lastAssistant?.stopReason)) {
      promptError = new Error(lastAssistant.errorMessage || '模型请求未完成，请检查 API Key、服务地址和网络后重试。');
    }

    if (promptError) {
      yield { type: 'error', message: promptError.message };
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
