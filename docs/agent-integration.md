# 模型服务接入

工作台把课程任务交给内置的 pi agent runtime（[`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi)），直接调用 LLM API，不需要安装 Codex、Claude Code 等外部命令行程序。课程、Skill、对话、图片和 PDF 课件使用同一套处理流程。

## 配置步骤

1. 在项目目录运行 `npm ci`，再用 `npm run build && npm start` 启动（`npm run dev` 只提供前端页面与课程文件接口，模型服务接口不会初始化）。
2. 打开「工作区设置」，在「模型服务 Provider」中选择服务商，或在最后选择「自定义 API（OpenAI 兼容）」。
3. 填写 API Key；「自定义 API」还需填 Base URL 与模型名称，内置服务商要走代理时见后文 `models.json`。
4. 点击「保存并连接」。状态变为「已配置」后，在「使用模型」中选择模型（自定义 API 直接填模型名称），即可开始提问。

自建或中转的 OpenAI 兼容端点选「自定义 API（OpenAI 兼容）」，填写 API Key、Base URL 与模型名称。Anthropic、OpenAI、Google、DeepSeek 等内置服务商只需填写 API Key。

## 支持的模型服务

「模型服务 Provider」列表由内置 Agent 运行时的 `ModelRuntime.getProviders()`（`@earendil-works/pi-coding-agent`）提供：未配置自定义服务商时为 40 项，配置后会多出一个由 `models.json` 定义的 `custom` 条目（设置页不重复显示）。除 Anthropic、OpenAI、Google、DeepSeek 等常见服务商，列表还包含 OpenRouter、xAI、Groq、Moonshot、Z.AI、GitHub Copilot 等；「自定义 API（OpenAI 兼容）」是设置页自带的入口。列表随依赖版本变化，部署时以设置页实际显示为准，本文不逐个列举。

各服务商支持的模型、额度、计费与所在地可用性由服务商决定。工作台只负责把请求发到所选服务，不代管账号，也不代表某个模型一定可用。

## 凭据与配置文件

| 文件 | 内容 | 写入者 |
| --- | --- | --- |
| `<数据目录>/agent/auth.json` | 「自定义 API」的 API Key（0600 权限） | 保存「自定义 API」配置时由本应用写入 |
| `<数据目录>/agent/models.json` | 自定义 API 与模型定义 | 选择「自定义 API」并填写 Base URL、模型名称时写入，也可手工编辑 |
| `<数据目录>/agent/models-store.json` | 服务商模型目录的本地缓存 | 运行时维护，支持离线读取 |
| `<数据目录>/settings.json` 的 `agent` 字段 | 当前 `provider`、`model`、`baseUrl` 与 `skillPaths` | 本应用 |

默认数据目录是 `~/.course-copilot`，设置页底部显示实际路径。API Key 不写入 `settings.json`，也不进入课程目录：内置服务商的 Key 由运行时进程持有，不落盘，服务重启后需要重新填写；只有「自定义 API」的 Key 写入 `auth.json`，会随数据目录备份或复制。个人设置中保存的是「用哪个服务商的哪个模型」，切换服务商后原来保存的配置仍保留，可以在设置里改回。工作台不设中转：内置服务商默认直连官方端点（按后文示例在 `models.json` 中改写 `baseUrl` 可指向自建代理），自定义 API 的请求发往你填写的地址。

## 自定义服务商与模型

选择「自定义 API（OpenAI 兼容）」并保存后，`models.json` 形如：

```json
{
  "providers": {
    "custom": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "models": [{ "id": "gpt-4o", "name": "gpt-4o" }]
    }
  }
}
```

`models.json` 的读取端支持 `//` 行注释与尾逗号；但在设置页保存「自定义 API」时，应用会用标准 JSON 重写整个文件，手工编辑的内容可能被丢弃，改动后请避免在该页再次保存。模型条目除 `id`、`name` 外还可用以下字段描述能力，未写的字段按默认值处理（`input` 默认 `["text"]`、`contextWindow` 默认 128000、`maxTokens` 默认 16384）：

| 字段 | 含义 |
| --- | --- |
| `api` | 覆盖该模型的接口类型，例如 `openai-completions`、`anthropic-messages`、`google-generative-ai` |
| `reasoning` | 是否支持思考；配合 `thinkingLevelMap` 可以只开放实际支持的档位 |
| `input` | 输入类型：`["text"]` 或 `["text", "image"]` |
| `contextWindow`、`maxTokens` | 上下文与单次输出上限，影响上下文管理与请求参数 |
| `cost` | 每百万 token 单价，用于成本统计 |
| `compat` | 兼容开关，见下节 |

内置服务商也可以覆盖，例如让 Anthropic 或 OpenAI 走自建代理：

```json
{
  "providers": {
    "anthropic": { "baseUrl": "https://proxy.example.com", "apiKey": "$ANTHROPIC_API_KEY" },
    "openrouter": { "modelOverrides": { "anthropic/claude-sonnet-4": { "contextWindow": 200000 } } }
  }
}
```

`apiKey` 可以写成 `$环境变量名` 从环境读取。自建或中转服务不识别 `developer` 角色、不支持 `reasoning_effort`、或要求 `max_tokens` 字段名时，用 `compat` 在服务商级或模型级声明，例如 `{"compat":{"supportsDeveloperRole":false,"supportsReasoningEffort":false,"maxTokensField":"max_tokens"}}`。

模型名称或端点填错时，请求会在执行任务时报错，不会在保存配置时发现。修改 `models.json` 后需要重启服务才会被运行时读取。

## 图片输入与扫描教材

看图需要三处同时支持：模型本身、所用 API 服务，以及请求中确实带上图片。工作台显示「已配置」只代表凭据可读，不代表已经验证图片识别。

内置服务商的模型目录自带能力声明；自建或中转的模型必须自己在 `models.json` 中把 `input` 写成 `["text", "image"]`。没有声明图片能力时，pi-ai 会把图片替换成 `(image omitted: model does not support images)` 这类占位文本，模型只看到文字。工作台不按模型名称推断能力，也不会替用户开启。

不确定能力时，用一张真实教材截图或扫描页提问，确认模型能描述其中内容；只看是否生成了原页 PNG，或模型自称支持图片，都不能代替实际读取验证。API 网关也需要正确转发图片。生成图片是另一件事：由所选模型自身是否具备生图能力决定，工作台不单独配置图片服务。

## 运行机制

- 每次课程任务创建一个独立的内存会话，任务结束后不保留会话状态；课程对话由本应用保存在个人课程目录。
- Agent 使用内置的文件与命令工具读写课程目录，因此能直接读取 PDF、运行脚本、编译 LaTeX，产物写入当前课程的 `outputs`。
- 停止任务会中断当前会话；同一时刻只允许一个任务，正在执行时不能修改配置。
- 模型凭据由运行时管理：内置服务商的 Key 不落盘，重新保存「自定义 API」配置（会重建运行时）或重启服务后，都要在设置页重新填写；只有「自定义 API」的 Key 写入 `auth.json`。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 按钮不可用或提示「待配置」 | 在设置中选择服务商并填写 API Key，保存后确认状态为「已配置」 |
| API Key 无效、额度不足 | 错误来自服务商，检查 Key、余额与所选模型是否对该账号开放 |
| 模型列表为空 | 点击「刷新状态」；自定义 API 需要先保存 Base URL 与模型名称 |
| 自定义端点报 400 或角色错误 | 按服务商要求补上 `compat` 开关，或改用其文档指定的 `api` 类型 |
| 图片没被识别 | 确认模型声明了 `input: ["text","image"]`，并用真实截图验证 |
| 换电脑后要重新配置吗 | 内置服务商的 API Key 需要重新填写（Key 不落盘）；复制整个数据目录可带走服务商、模型、Skill 路径与「自定义 API」的 Key。不要把 Key 提交到仓库 |

## 开发者维护

| 模块 | 负责内容 |
| --- | --- |
| `server/pi-agent.mjs` | ModelRuntime 初始化、服务商配置、模型列表、会话创建与事件转换 |
| `server/pi-tools.mjs` | 教材读取、文件读写等自定义工具 |
| `server/agent.mjs` | 稳定导出层，供 `server/api.mjs` 调用 |
| `src/components/AgentConnection.tsx` | 服务商、API Key、Base URL、模型与 Skill 路径表单 |
| `src/lib/skill-client.ts` | `/api/agent/*` 客户端 |

调用方向：页面 → `/api/agent/configure`、`/api/agent/models`、`/api/agent/run` → `pi-agent.mjs` → pi agent runtime → 服务商 API。新增服务商不需要改前端：列表来自 pi-ai，只有「自定义 API」需要额外填写 Base URL 与模型名称。调整这条链路后，用真实教材分别核对配置保存、模型列表、Skill 调用、资料回传和停止任务。
