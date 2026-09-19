# 架构与开发参考

本文面向接手或扩展项目的开发者，记录前端与服务端如何协作、模型服务配置、课程任务的数据流、Skill 分工，以及可继续开发的方向。面向最终用户的内容见 [README](../README.md) 和 [用户手册](user-guide.md)；如何新增一个课程 Skill 见 [Skill 模块开发与接入](skill-development.md)。

## 三层分工

```text
前端 UI：教材、目录、选中文字、对话、图谱、课件、视频
                    ↕ 请求、进度、回答、结果
课程 Agent：理解要求 → 读取教材 → 调用一个或多个 Skill
                    ↕ 读取与保存文件
个人课程目录：原始教材、解析内容、阅读记录、对话、生成资料
```

本机 HTTP 服务负责传递请求、返回进度、读写文件和提供 PDF／生成文件。教学任务统一交给内嵌的 pi agent runtime（实现位于 `server/pi-agent.mjs`，对外经 `server/agent.mjs` 导出）。七个专项 Skill 与自由问答按钮表达操作意图，Agent 可以组合多个 Skill。

## 配置模型服务

1. 打开页面右上角「工作区设置」，在「模型服务 Provider」中选择服务商，或选择「自定义 API（OpenAI 兼容）」。列表来自内置 Agent 运行时的 `ModelRuntime.getProviders()`（未配置自定义服务商时 40 项）；具体方法见 [模型服务接入说明](agent-integration.md)。
2. 填写 API Key；「自定义 API」再填 Base URL 与模型名称。API Key 不进入课程目录，「自定义 API」的 Key 由本应用写入 `<数据目录>/agent/auth.json`。
3. 点击「保存并连接」，在「使用模型」中选择模型；自定义 API 直接填写模型名称。关闭设置页即可自由提问。
4. 在「接入 Skill」配置所需技能的路径，即可启用对应功能按钮。

工作台不安装外部命令行程序，也不需要外部 Agent 的登录。服务商提供哪些模型、是否有额度由服务商决定；工作台只按该服务商的模型目录发起请求。

配图由 Agent 根据自身实际可调用的 API 和工具自主完成：有文生图能力时优先使用，否则程序绘图。生成的图片保存到当前课程 `outputs`，通过 Markdown 展示。工作台不单独配置图片服务，也不会依据模型名称假定存在生图能力。已有图片和 LaTeX 公式继续正常展示。

切换服务商或模型后，下一次任务立即生效；服务商、模型与 Skill 路径分别保存在个人设置中。正在执行任务时不能更改配置，需先停止任务或等待完成。

「刷新状态」重新读取个人设置、模型可用性与课件编译环境；`models.json` 的改动需要重启服务才会生效。保存成功代表凭据可读、模型目录可拉取；服务商是否有额度、凭据是否过期，仍以实际问答结果为准。

`server/pi-agent.mjs` 负责一次课程任务的全部环节：

- `initModelRuntime()` 在服务启动时创建 pi-coding-agent 的 `ModelRuntime`，指向 `<数据目录>/agent/` 下的 `auth.json`、`models.json` 与 `models-store.json`。
- `getPiAgentStatus()`、`configureProvider()`、`listModels()` 供设置页读写服务商、API Key、Base URL、模型与 Skill 路径。
- `runPiAgent()` 用 `getModel(provider, model)` 解析模型，再用 `createAgentSession()` 创建会话：`cwd` 为当前课程目录，同时注入模型运行时、内置工具与自定义工具；`SessionManager.inMemory()` 让 pi 会话不落盘，`SettingsManager.inMemory({ compaction: { enabled: false } })` 关闭自动压缩。
- 课程要求与 Skill 通过 `DefaultResourceLoader` 注入：`systemPromptOverride` 提供 `server/prompts/course-tutor.md` 与本次任务说明，`skillsOverride` 追加「接入 Skill」中可读的 `SKILL.md`。
- 会话事件转换成本应用的流式事件：`message_update` 的 `text_delta` 转为 `text`，`tool_execution_start`／`tool_execution_end` 转为 `progress`；任务结束时检查本次待检查 JSON 是否产出资料。
- 同一时刻只允许一个任务；点击停止或请求中断时调用 `session.abort()`。

每次课程请求创建独立的内存会话，任务结束后不保留 pi 侧会话状态；课程对话始终由本应用写入个人课程目录的 `conversations/`。未配置 Skill 时仍可正常自由问答、绘图和生成资料。

模型凭据由 pi 的 ModelRuntime 管理：内置服务商的 API Key 不落盘，重新保存「自定义 API」配置（会重建运行时）或重启服务后需要重新填写；只有「自定义 API」的 Key 保存在 `<数据目录>/agent/auth.json`（0600）。个人设置中的 `agent` 字段只记录服务商、模型、Base URL 与 Skill 路径，不含 API Key，也不含登录令牌；复制本项目或整个课程目录不会替其他用户配置账号。

所有模型服务收到相同的课程上下文，并被要求只在该课程的 `outputs` 中保存结果。Agent 持有内置的文件与命令工具，工作目录是当前课程目录，因此可以读取教材、运行脚本和编译 LaTeX；这是使用约定，不是操作系统级文件沙箱。

## 课程任务的数据流

`request` 完整类型在 `src/lib/types.ts`：

| 字段 | 含义 |
| --- | --- |
| `skillId` | 用户选择的操作意图 |
| `book`、`chapter`、`page` | 当前教材、章节与页码 |
| `scope` | 当前页、当前节、当前章、选中内容或整本教材 |
| `knowledgeGraphDetail` | 知识图谱深度：`overview` 或 `detailed` |
| `selectedText`、`pageText` | 选中文字、当前页正文 |
| `prompt` | 用户要求 |
| `artifact` | 正在查看的结果，可要求继续修改 |
| `history` | 当前对话中的问答 |

`scope` 表示范围，不代表整章或整书全文已经放进请求。Agent 可以读取本地教材。

`context` 由本机服务提供：

| 字段 | 含义 |
| --- | --- |
| `courseDir` | 当前课程目录 |
| `textbookPath` | 原始 PDF 完整路径 |
| `textbookDir` | 解析内容目录 |
| `outputsDir` | 生成结果保存目录 |
| `skills` | 已配置且可读的 Skill 信息与路径 |
| `outputUrl(filename)` | outputs 内相对文件名对应的浏览器地址 |
| `signal` | 点击停止或连接关闭时触发取消 |

课程路径由服务端根据课程 ID 查找；前端不指定任意磁盘路径。应把 `signal` 传给实际 Agent 并停止它启动的工作。

## 返回进度与结果

`POST /api/agent/run` 接收请求，逐行返回 JSON 事件：

| `type` | 内容 | 界面用途 |
| --- | --- | --- |
| `progress` | `message` | 当前正在执行的真实步骤 |
| `text` | `content` | 追加回答，支持 Markdown 与公式 |
| `artifact` | `artifact` | 保存结果并在左侧打开 |
| `done` | 无 | 任务完成 |
| `error` | `message` | 显示失败原因 |

每次需要生成资料时，接入层会把一个待检查 JSON 的完整路径告诉所选 Agent。Agent 将展示用 JSON 写入该文件，并把图片、PDF 等成品写入 `outputs` 下对应类型子目录（讲解笔记进 `notes/`、课件进 `slides/` 等），编译与解析过程文件写入 `outputs/.build/`。服务校验通过后把结果保存为 `outputs/.build/artifacts/result-<结果ID>.json` 并发送 `artifact` 事件；校验失败时保留已有资料。普通问答不要求生成文件。继续修改时会生成新的资料，原资料保留。

| `artifact.kind` | 内容 |
| --- | --- |
| `markdown` | `content` 正文 |
| `mindmap` / `knowledge-graph` | `nodes` 与 `edges`，节点可带教材页码；思维导图节点可含 `userText` 学生补充；知识图谱 v2 含 `detailLevel`、`coverage`、连线 `evidence` 与 `basis` |
| `slides` | PDF 课件使用 `chapters: [{title, url, filename?}]`，可附源文件 ZIP 的 `sourceUrl`；文字课件使用 `slides: [{title, content}]`，可附 `url` |
| `video` / `file` | 文件 `url`，可选 `filename` |

所有结果需要 `id`、`title`、`kind`；具体字段见 `src/lib/types.ts`。未配置模型服务时返回 HTTP 503，选定的 Skill 未配置时返回 HTTP 501；任务没有返回 `done` 就结束时显示未完成。

## 课程 Skill 分工

课程功能按方向分三组，各自的默认路径在对应注册表中按仓库位置计算；完整操作步骤、最小 `SKILL.md`、结果格式和新增按钮示例见 [Skill 模块开发与接入](skill-development.md)。

| 负责方向 | 配置文件 | 对应功能 |
| --- | --- | --- |
| 教材、讲解与练习 | `server/skills/tutoring.mjs` | 教材解析、讲解内容、知识点出题；自由问答由 Agent 处理 |
| 知识结构 | `server/skills/structure.mjs` | 思维导图、知识图谱 |
| 教学材料 | `server/skills/materials.mjs` | 课件、讲解视频 |

每个功能由一个 Skill 目录（`SKILL.md` 及其资源）实现。打开「工作区设置 → 接入 Skill」，填写本机 `SKILL.md` 的完整路径并保存，即时生效。支持 `~/` 开头的路径；留空表示暂不接入。注册表文件定义功能的名称和分工，页面保存的个人路径优先于其中的默认 `path`。

这些配置描述技能位置和用途，不运行模型。Agent 读取 Skill 指令，使用课程目录中的真实材料完成任务，结果存入该课程的 `outputs`。各 Skill 共用课程文件，无须修改各自的前端按钮。

接入现有功能时，只需准备自己的 Skill 目录并在设置中填写路径。新增其他功能按钮时，需要同时更新功能列表、`SkillId`、前端按钮和设置页分组；具体文件与代码在开发指南中列出。当前不会仅通过新增一个目录就自动出现按钮。

## 公共教学要求

[`server/prompts/course-tutor.md`](../server/prompts/course-tutor.md) 面向不同学科、学习阶段和部署者，定义课程智能体如何帮助学习：围绕课程目标组织内容、连接先修知识、依据教材讲解、按理解程度调整解释、提供练习反馈、衔接已有讨论，以及制作与课程目标一致的资料。交流语言跟随用户，不固定学校、教材或个人背景。

所有模型服务共用这份提示词，每次任务重新读取，修改后下一轮问答即可使用。具体课程、阅读位置和已有对话由本次请求提供，专项 Skill 补充相应方法。这些要求指导 Agent 的教学行为，不代表工作台已经具备自动测评或长期学习档案功能。

可视化也是公共教学要求的一部分：图表有助于理解时，Agent 应主动采用关系图、流程图、时间线、对比表、曲线或示意图，并配合阅读指引与解释。界面当前支持 Markdown 表格、图片和知识结构资料；交互式演示取决于实际接入的工具及展示能力，提示词本身不会增加渲染组件。

图表同时要求明确的视觉层次、克制且一致的配色、易读标签和充分留白。复杂讲解应分图呈现，在实际显示尺寸下检查效果；美化保持数据、几何比例和数学含义准确。

## 公共模块

- `src/App.tsx`、`src/components/`：界面与交互。
- `src/lib/useCourseWorkspace.ts`：课程切换、恢复与保存状态。
- `src/lib/storage.ts`：文件接口和旧浏览器数据迁移。
- `src/lib/skill-client.ts`：Agent 状态与流式通信。
- `server/pi-agent.mjs`：模型运行时、服务商配置、课程任务与会话事件。
- `server/pi-tools.mjs`：教材读取与文件操作等自定义工具。
- `server/agent.mjs`：稳定导出层，供 `server/api.mjs` 调用。
- `src/components/AgentConnection.tsx`：模型服务与 Skill 路径表单。
- `server/course-store.mjs`：课程文件读写。
- `server/course-api.mjs`：课程接口、PDF 和输出文件访问。
- `server/api.mjs`：Agent 请求与 PDF 阅读资源。
- `server/index.mjs`：正式本地页面服务。

课程接口包括 `/api/storage`、`/api/settings`、`/api/courses`，以及 `/api/courses/:id/` 下的 `state`、`textbook`、`pages/:page`、`conversations`、`outputs/*`、`migrate`。`GET /api/agent/status` 返回模型服务与 Skill 配置状态，`GET /api/skills` 返回按钮可用状态。

辅助资料保存在课程目录的 `references/<资料ID>/`，包含原文件、`metadata.json` 和提取后生成的 `text.json`。元数据记录 `id`、`title`、`filename`、`description`、`size`（字节）、`format`、`createdAt` 和 `textIndex`。列表接口附加文件访问 `url`；提取期间返回排队状态或当前处理进度。

| 辅助资料接口 | 用途 |
| --- | --- |
| `GET /api/courses/:id/references` | 列出当前课程的资料 |
| `POST /api/courses/:id/references` | 上传原始文件，请求头 `X-Filename` 为经过 URL 编码的文件名 |
| `PATCH /api/courses/:id/references/:referenceId` | 更新 `title` 和 `description` |
| `DELETE /api/courses/:id/references/:referenceId` | 删除资料目录；课程任务执行期间返回 409 |
| `GET/HEAD /api/courses/:id/references/:referenceId/file` | 打开或下载原文件，支持范围请求 |
| `POST /api/courses/:id/references/:referenceId/text` | 后台提取正文，`ocr: true` 启用扫描文字识别，返回 202 |
| `GET /api/courses/:id/references/search?q=...` | 搜索当前课程辅助资料正文，返回片段、位置、原文件链接及提取进度 |

`server/reference-text.mjs` 提取 PDF 文字层、Office 文档正文和文本段落。PDF 保留文件页序，PPTX 按演示文稿目录保留页面顺序，DOCX、TXT 和 Markdown 记录非空正文段落序号。`text.json` 的 `pages` 条目包含正文 `text`、位置及来源 `source`。文字识别使用 Tesseract；PDF 每页文字层少于 30 个非空白字符时，启用识别会通过 `pdftoppm` 渲染该页并识别。中文语言数据使用 `chi_sim` 或 `chi_tra`。图片通过同一文字识别工具处理。

上传后自动加入串行提取队列，已有资料首次搜索时加入队列。删除资料会中止该资料的提取。搜索对正文和查询进行 Unicode NFKC 规范化、中文相邻字符间空白合并和大小写归一化，按连续文字匹配。每条结果最多保留命中前 110 个字符和后 170 个字符；落在同一片段内的匹配合并展示。`total` 为合并后的片段数量，响应最多返回前 100 条，PDF 链接附加 `#page=N`。查询范围由课程目录确定。

辅助资料多选通过 `SkillRequest.referenceIds` 传递。服务端在当前课程清单中逐项查找这些 ID，空数组表示本轮围绕主教材回答，跨课程或已删除的 ID 返回错误。界面在输入框展示所选资料，并将资料名称和链接随用户消息保存。已提取资料通过 `textPath` 向 Agent 提供正文路径。导图、图谱、视频和课件的教材取材规则继续生效。

`server/pi-agent.mjs` 在自由问答、教材解析、讲解和出题任务中读取辅助资料清单与本地路径。Agent 根据问题按需读取文件，引用时注明资料名称和该资料的页码。图谱的教材页码字段继续对应主教材。旧课程首次添加资料时创建 `references` 目录。

`skillId` 或 `artifact.kind` 为 `slides`、`mindmap`、`knowledge-graph`、`video` 的任务跳过辅助资料清单读取。思维导图、知识图谱、讲解视频和课件围绕主教材的内容、章节和所选范围生成与修改。通用 Agent 指令禁止这些任务参考课程辅助资料，包含原文件、解析缓存和历史对话中的转述；该规则也适用于自由问答中的相关制作请求。修改时核对主教材并读取已有结果及其源码。

Agent 接口包括 `POST /api/agent/configure`（保存服务商、API Key、Base URL、模型与 Skill 路径）、`GET /api/agent/models?provider=...`（该服务商的模型列表）和 `POST /api/agent/run`（课程任务）。写请求使用 JSON 请求体；配置写入个人 `settings.json` 的 `agent` 字段，「自定义 API」的 API Key 写入 `<数据目录>/agent/auth.json`。

## 后续开发方向

- [围绕知识点的学习流程](learning-flow.md)：图谱选点 → 讲解 → 作答 → 针对性补讲 → 变式练习。
- [数学与算法实验](math-experiments.md)：调整参数、比较方法，查看真实运行结果、图形和代码。
