# 设计文档：将 ACP 外接 Agent 改为内置 Pi Agent

**日期**：2026-09-16
**状态**：已实现（提交 0c7af88…2814424 落地；本文保留为改造当时的设计与验收记录）

## 1. 背景与目标

### 现状

当前应用（VeryMath 智慧教材）是一个 Electron 桌面应用，后端通过 ACP（Agent Client Protocol）连接本机已安装的 coding agent（Codex、Claude Code、OpenCode 等）。用户需要先在本机安装对应 agent，再通过 AgentConnection 设置面板配置可执行文件路径、连接模式，完成登录后才能使用。

### 目标

将 agent 连接方式从"通过 ACP 接外部 coding agent"改为"内置 pi agent runtime"。用户只需在前端填写 API Key + Base URL 即可直连 LLM provider（Anthropic、OpenAI、Google 等），无需安装任何外部 agent CLI。

### 选型

使用 [earendil-works/pi](https://github.com/earendil-works/pi) 生态的 npm 包：

- **`@earendil-works/pi-ai`** — 统一多 provider LLM API（40+ provider，含 OpenAI 兼容接口）
- **`@earendil-works/pi-agent-core`** — agent 运行时（工具调用、状态管理）
- **`@earendil-works/pi-coding-agent`** — 完整 SDK（`createAgentSession`、`ModelRuntime`、`SessionManager`、`defineTool`、`DefaultResourceLoader`）

## 2. 架构

### 改造前数据流

```
前端 AgentConnection → ACP 连接配置 → 后端 spawn 外部 agent 进程
  → ACP 协议通信 → agent 处理 → 事件流回前端
```

### 改造后数据流

```
前端 Provider 选择 + API Key + Base URL
  → POST /api/agent/configure → ModelRuntime 写入 auth.json
  → 前端拉取可用模型列表

用户发送 Skill 请求
  → POST /api/agent/run (SSE)
  → pi-agent.mjs 创建 AgentSession（in-memory）
    → 注入教材 custom tools + skills
    → session.prompt(构建的指令)
    → pi 事件流 → SSE → 前端实时渲染
    → done → 前端展示 artifact
```

### 组件关系

```
Electron Main (desktop/main.cjs)  — 不变
  └─ Node.js HTTP Server (server/index.mjs)  — 不变
       ├─ API Middleware (server/api.mjs)  — 端点调整
       ├─ Pi Agent (server/pi-agent.mjs)  — 新增
       │    ├─ ModelRuntime (pi-ai)  — provider/凭证管理
       │    ├─ AgentSession (pi-coding-agent)  — agent 运行时
       │    └─ Custom Tools  — 教材读取、文件操作等
       ├─ Course Store (server/course-store.mjs)  — 不变
       ├─ Skills (server/skills/)  — 不变
       └─ Static Files (dist/)  — 不变
```

## 3. 后端改动

### 3.1 新增文件

#### `server/pi-agent.mjs`

Pi agent 集成层，替代现有 ACP 连接逻辑。

**职责**：
- 初始化 `ModelRuntime`（authPath/modelsPath 指向应用数据目录 `~/.course-copilot/agent/`）
- 管理 provider 配置：`setRuntimeApiKey()`、`checkAuth()`、`getAvailable()`
- 创建 `AgentSession`：使用 `SessionManager.inMemory()`，不持久化 pi session（对话持久化仍由现有 course-store 管理）
- 注入 custom tools：教材读取、PDF 解析、文件写入 outputs 目录等
- 注入 skills：将现有 `server/skills/` 下的 SKILL.md 通过 `DefaultResourceLoader` 的 `skillsOverride` 传入
- 事件转换：pi 事件（`message_update`/`tool_execution_start`/`tool_execution_end`/`agent_end`）→ 现有 SSE 事件格式（`text`/`progress`/`artifact`/`done`/`error`）

**导出函数**：
- `initModelRuntime(dataDirectory)` — 初始化 ModelRuntime
- `getPiAgentStatus(refresh)` — 返回 agent 状态（替代 `getAgentStatus`）
- `configureProvider(config)` — 保存 API Key + Base URL，返回更新后状态
- `listModels(providerId)` — 列出指定 provider 的可用模型
- `runPiAgent(request, context)` — 异步生成器，执行 agent 任务（替代 `codingAgent`）
- `disposePiAgent()` — 清理资源

#### `server/pi-tools.mjs`

Pi custom tools 定义，将现有教材操作封装为 pi agent 可调用的工具。

**工具列表**：
- `read_textbook_pages` — 读取教材 PDF 指定页（封装 `skills/textbook-parse/scripts/read-pages.mjs`）
- `read_file` — 读取 outputs 目录下文件
- `write_file` — 写入 outputs 目录下文件
- `list_outputs` — 列出 outputs 目录内容

每个工具使用 `defineTool()` 定义，参数用 TypeBox schema。

### 3.2 修改文件

#### `server/agent.mjs`

- `getAgentStatus()` → 调用 `getPiAgentStatus()`
- `configureAgent()` → 调用 `configureProvider()`
- `connectAgent()` → 移除（内置 agent 无需连接，配置后即用）
- `disconnectAgent()` → 移除
- `startAgentLogin()` / `cancelAgentLogin()` → 移除
- `codingAgent()` → 调用 `runPiAgent()`
- `getSkillAvailability()` → 逻辑不变，但 `status.connected` 改为检查 pi agent 是否已配置 provider + model

#### `server/agent-providers.mjs`

移除整个文件。Provider 信息改由 pi-ai 的 `ModelRuntime.getProviders()` 提供。

#### `server/api.mjs`

API 端点调整：
- `POST /api/agent/configure` — 接收 `{ provider, apiKey, baseUrl, model }`，调用 `configureProvider()`
- `GET /api/agent/status` — 调用 `getPiAgentStatus()`
- `GET /api/agent/models` — 新增，返回指定 provider 的模型列表
- `POST /api/agent/run` — 不变（SSE 流）
- 移除：`/api/agent/connect`、`/api/agent/disconnect`、`/api/agent/login`、`/api/agent/login/cancel`

#### `server/index.mjs`

- `disposeAgent` → `disposePiAgent`
- 启动时调用 `initModelRuntime(dataDirectory)`

#### `desktop/main.cjs`

几乎不变。`startService` 的环境变量中不再需要为 ACP adapter 设置特殊 PATH。

### 3.3 移除文件

- `server/codex-client.mjs`
- `server/claude-client.mjs`
- `server/opencode-client.mjs`
- `server/acp-client.mjs`
- `server/command-client.mjs`
- `server/opencode-environment.mjs`

### 3.4 事件映射

Pi SDK 事件 → 现有前端 SSE 事件：

| Pi 事件 | SSE 事件 | 说明 |
|---------|---------|------|
| `message_update` (text_delta) | `{ type: 'text', content: delta }` | 流式文本 |
| `tool_execution_start` | `{ type: 'progress', message: '正在执行: {toolName}' }` | 工具开始 |
| `tool_execution_update` | `{ type: 'progress', message: update }` | 工具进度 |
| `tool_execution_end` | `{ type: 'progress', message: '工具完成' }` | 工具结束 |
| `agent_end` | 检查 outputs 目录生成 artifact | agent 完成 |
| agent_end（无 artifact） | `{ type: 'done' }` | 纯文本回答 |
| error | `{ type: 'error', message }` | 错误 |

### 3.5 Agent 指令构建

`runPiAgent()` 中构建的指令（system prompt + user prompt）基本沿用现有 `codingAgent()` 的逻辑：
- 读取 `server/prompts/course-tutor.md` 作为 system prompt 基础
- 附加课程上下文（教材路径、解析内容、outputs 目录、可用 tools/skills）
- 附加用户请求（skillId、scope、pageRange、selectedText 等）

区别：
- 不再需要 ACP 特定的 instructions（如"不调用子代理"等 ACP 约束）
- pi agent 的 custom tools 已通过 `defineTool` 注册，指令中引用工具名

## 4. 前端改动

### 4.1 `src/components/AgentConnection.tsx`

**移除**：
- Agent 选择器（Codex/Claude/OpenCode/Cursor/Gemini/Copilot/Qwen/Kimi/Kiro/Custom）
- 连接模式选择（ACP/native/CLI）
- 可执行文件路径输入
- 启动参数配置
- 登录流程（login/cancel）
- 连接/断开按钮

**新增**：
- Provider 下拉选择（从 `getPiAgentStatus().providers` 动态获取，显示 pi-ai 支持的 provider 列表）
- API Key 输入框（password 类型，带显示/隐藏切换）
- Base URL 输入框（可选，用于自定义端点/代理）
- 模型选择下拉（配置 API Key 后自动拉取可用模型）
- "保存配置"按钮（调用 `POST /api/agent/configure`）
- "测试连接"按钮（可选，验证 API Key 有效性）
- 连接状态指示（已配置/未配置/配置错误）

**保留**：
- Skill 路径配置（现有 skillPaths 逻辑）
- LaTeX 环境检测显示

### 4.2 `src/lib/skill-client.ts`

- `getAgentStatus()` — 返回类型适配 pi agent 状态
- 移除 `connectAgent()`、`disconnectAgent()`、`startAgentLogin()`、`cancelAgentLogin()`
- 新增 `configureProvider(config)` — POST `/api/agent/configure`
- 新增 `listModels(providerId)` — GET `/api/agent/models`
- `runSkill()` — 不变（SSE 流接口不变）

### 4.3 `src/lib/types.ts`

- `AgentStatus` 类型调整：移除 ACP 相关字段（`phase`、`connectionModes`、`defaultCommand`、`bundledAdapter`、`login` 等），新增 `provider`、`apiKey`、`baseUrl`、`models`

### 4.4 `src/App.tsx`

- `updateAgentStatus` 逻辑不变
- 设置面板中的 `AgentConnection` 调用方式不变（props 不变或微调）

## 5. 数据存储

### Agent 凭证

- 位置：`{dataDirectory}/agent/auth.json`（如 `~/.course-copilot/agent/auth.json`）
- 格式：pi-ai 标准格式 `{ "anthropic": { "type": "api_key", "key": "sk-..." } }`
- 权限：0600

### 模型缓存

- 位置：`{dataDirectory}/agent/models-store.json`
- 用途：pi-ai 缓存远程 provider catalog，支持离线使用

### 自定义模型配置

- 位置：`{dataDirectory}/agent/models.json`
- 用途：用户自定义 provider/baseUrl（如 OpenAI 兼容端点）

### 现有数据不变

- 教材文件、阅读记录、对话、artifacts — 存储位置和格式不变
- 现有 `saveAgentSettings()` 中的 agent 设置结构调整（移除 connections/profiles，改为 provider/apiKey/baseUrl/model）

## 6. 依赖变更

### package.json

```json
{
  "dependencies": {
    // 新增
    "@earendil-works/pi-coding-agent": "^0.85.1",
    "@earendil-works/pi-ai": "^0.85.1",
    "@earendil-works/pi-agent-core": "^0.85.1",
    // 移除
    // "@agentclientprotocol/claude-agent-acp": ...
    // "@agentclientprotocol/codex-acp": ...
    // "@agentclientprotocol/sdk": ...
  }
}
```

### 新增间接依赖

- `typebox`（pi 使用 TypeBox 做 tool schema）
- pi-ai 的各 provider SDK（由 pi-ai 统一管理）

## 7. 不变的部分

- Electron 桌面壳（`desktop/main.cjs`）— 仅环境变量微调
- 教材阅读器（`TextbookReader.tsx`）— 完全不变
- CopilotPanel 对话面板 — 完全不变
- ArtifactViewer、KnowledgeGraphView、QuizView — 完全不变
- Skills 系统（`server/skills/`）— 完全不变
- course-store、storage 数据层 — 完全不变
- PDF 解析脚本（`skills/textbook-parse/`）— 完全不变
- slide-templates、latex-environment — 完全不变

## 8. 风险与对策

### 8.1 pi-coding-agent 包体积

`@earendil-works/pi-coding-agent` 含完整 coding agent CLI，可能较大。但我们只需要 SDK 部分（`createAgentSession` 等），Tree-shaking 后可接受。如果体积过大，可考虑只依赖 `pi-ai` + `pi-agent-core`，自行组装 agent loop。

**对策**：先集成完整 SDK，打包后检查体积。如果 >50MB，再考虑精简。

### 8.2 Electron 环境兼容性

pi-coding-agent 可能有 Node.js 原生依赖。现有 Electron 使用 `ELECTRON_RUN_AS_NODE=1` 运行后端服务，需确认 pi 包在此模式下正常工作。

**对策**：早期验证。在实现第一步安装依赖后，立即测试 `ModelRuntime.create()` 和 `createAgentSession()` 是否在 Electron 环境下正常工作。

### 8.3 事件格式差异

pi 事件结构与现有前端期望的 SSE 事件格式有差异，需要转换层。

**对策**：`pi-agent.mjs` 中的事件转换函数做完整映射，保持前端接口不变。

### 8.4 现有 Skills 的 system prompt 适配

现有 `codingAgent()` 构建的指令含大量 ACP 特定约束。改为 pi agent 后，部分约束（如"不调用子代理"）不再需要，但教材范围限定、outputs 目录约定等仍需保留。

**对策**：`runPiAgent()` 中重新构建指令，移除 ACP 特定约束，保留教材逻辑约束。

## 9. 实现顺序

1. **安装依赖 + 环境验证** — 安装 pi 包，验证 Electron 下可运行
2. **`server/pi-agent.mjs`** — ModelRuntime 初始化 + provider 配置 + 状态查询
3. **`server/pi-tools.mjs`** — custom tools 定义
4. **`server/agent.mjs` 改造** — 接入 pi-agent，移除 ACP 逻辑
5. **`server/api.mjs` 改造** — API 端点调整
6. **移除旧 client 文件** — 清理 ACP 客户端
7. **`AgentConnection.tsx` 改造** — 新 UI
8. **`skill-client.ts` + `types.ts` 改造** — 前端 API 适配
9. **端到端测试** — 配置 provider → 发送请求 → 验证结果
10. **package.json 清理** — 移除 ACP 依赖
