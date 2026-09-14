# 环境、配置接口与启动

## 环境和依赖

在项目根目录检查 git --version、node --version、npm --version，并读取 package.json。当前项目要求 Node.js >=22.13.0。macOS、Linux 可按本机环境安装；原生 Windows 优先使用已有 WSL2，在 WSL 内完成安装、构建和服务运行，不混用 Windows 的 node_modules。没有 WSL2 时说明需要的系统操作，不能声称已验证原生 Windows。

优先使用用户已有的兼容 Node；不足时用已有版本管理器提供项目所需版本。没有可用管理工具时按平台查阅官方安装方法，不使用不明的一键安装脚本。不将开发者机器上的缓存路径写入配置或说明。

仓库存在受版本控制的 package-lock.json 时使用 npm ci；否则使用 npm install --package-lock=false。不要加 --omit=dev、--omit=optional 或 --ignore-scripts。然后运行 npm run build。

PDF 图像支持由 PDF.js 的可选依赖提供。可检查实际安装中的 pdfjs-dist 和 @napi-rs/canvas 是否可加载；有真实 PDF 时使用教材解析 Skill 的 read-pages.mjs 读取指定页，--images pages 同时验证原页图像。没有 PDF 时不把依赖加载成功说成教材解析已验证。

课件环境从 GET /api/agent/status 的 latex 读取，包括 ready、engine、missing、message。缺少 XeLaTeX 或宏包字体时，基础工作台仍能运行。用户需要课件时再按该列表补齐 TeX 环境；基础部署不默认下载体积很大的完整 TeX 发行版。Python、视频工具也按实际 Skill 需要安装。

补齐 TeX 或视频工具后，必须重新读取 GET /api/agent/status 的 latex 字段，确认 ready 为 true 且 missing 为空，才能把课件环境说成就绪；中文字体（如 Fandol）缺失时尤其要核对是否在补装清单内。补齐失败或未重查时，只报告仍缺哪些及下一步，不声称已就绪。

## 正式启动

默认在项目目录执行：

```bash
npm run build
npm start
```

已完成本轮构建则直接启动，不重复构建。服务同时提供页面和本机 API，正式启动不需要再启动 Vite。环境变量 HOST、PORT、COURSE_COPILOT_HOME 需要传给同一个服务进程。

POSIX 后台运行可直接使用下列形式，将路径和端口替换为实际值，先创建日志目录。所有带空格的路径完整引用。

```bash
HOST=127.0.0.1 PORT=4173 COURSE_COPILOT_HOME="$HOME/.course-copilot" nohup node server/index.mjs > "$HOME/.course-copilot/server.log" 2>&1 < /dev/null &
```

记录实际 PID、日志路径、工作目录和启动命令，退出启动终端后再次检查地址可访问。不要把开发会话里的进程编号当成操作系统 PID。停止时只结束本次确认属于该工作台的进程；重新使用保存的 PID 前核对进程，以免 PID 已复用。重启沿用同一项目、Node、端口和数据目录。

部分 Agent 的命令工具会在调用结束时回收后台进程，nohup 不能保证绕过这种回收。启动后若连接被拒绝，检查日志和进程，再改用工具支持的持续运行终端；没有这类能力时给出用户终端启动命令，并明确当前服务未能保持运行。

若端口占用，结合进程命令、工作目录和 API 判断是否为本工作台；HTTP 200 本身不能证明这一点。同一数据目录已有工作台服务时复用它，不另开第二个服务同时操作课程文件。需要更新正在运行的旧版本时，先确认没有学习任务，再按原启动方式重启。

## 本机配置 API

以下接口均在实际启动地址下调用；本机请求绕过代理。写请求使用 Content-Type: application/json，检查 HTTP 状态和响应内容。仅输出必要状态，不转储账号配置或凭据。

| 接口 | 用途 |
| --- | --- |
| GET /api/storage | 读取实际个人目录 directory 和已有 settings |
| GET /api/agent/status | 读取 config、providers、connected、phase、busy、models、skills、latex |
| PATCH /api/agent/config | 合并修改 provider、mode、executable、args、model、skillPaths |
| POST /api/agent/connect，正文 {} | 使用当前配置连接 |
| POST /api/agent/login | 发起登录；默认正文 {}，需要选择方式时传入 status.authMethods 中的真实 authMethod |
| GET /api/skills | 查看课程功能是否可用；available 同时要求已连接与 Skill 已配置 |

先检查 busy，正在执行任务时不更换配置或断开。选择 Agent 的请求例如 {"provider":"opencode","mode":"acp"}；provider 必须是 status.providers 中实际存在的 ID，不假定调用安装的 Agent 就一定受支持。

新安装的课程 Skill 默认路径由注册表计算，无需写个人绝对路径。确需修复时，读取 server/skills/tutoring.mjs、structure.mjs、materials.mjs 导出的条目，从本地注册表取得实际 path，只 PATCH 需要修复的项，例如：

```json
{"skillPaths":{"quiz":"/实际项目目录/skills/quiz/SKILL.md"}}
```

不要将整个状态响应作为 PATCH 正文。保留有效自定义路径和主动停用的项；若用户明确要求恢复全部内置 Skill，再按注册表恢复相应路径。video 的默认 path 为 null，不包含在内置配置完成的数量里。很旧的目录位置已失效时，可以更新为这次安装的对应文件。

Codex、Claude 使用仓库自带 ACP 组件时 executable 留空，不填普通 CLI 路径代替适配器。其他预设 Agent 的默认参数由 agent-providers.mjs 提供。模型只能在连接后选取 status.models 中的真实 ID，支持手填的接口除外；没有指定模型时保持原设置。

## 图片输入能力

检查所选模型、API 服务和 Agent 是否支持图片输入，不能将连接成功视为多模态已就绪。OpenCode 自定义模型如需声明图片能力，在已有 provider 的对应 models 条目中合并 `modalities: { input: ["text", "image"], output: ["text"] }`，保留原有字段及其他支持的输入类型。只有确认模型与接口支持图片时才修改；没有显式声明不一定意味着图片已禁用。

工作台会继承 OpenCode 的 provider/model 配置，修改后断开并重新连接。使用真实教材截图确认模型能识别其中内容；无法验证时说明图片能力待确认，不直接认定模型不支持，也不盲目开启。具体说明见项目 docs/agent-integration.md 的“图片输入与扫描教材”。

## 就绪判断

- 首页实际返回应用 HTML，引用的 JS/CSS 能加载；不是“页面尚未构建”的返回内容。
- /api/storage 的目录是此次选择的目录，原有课程和设置保留。
- status.skills 中六个内置条目的 configured 为 true，或明确列出用户主动停用项；这只表示文件可读。
- status.connected 为 true 才能说明 Agent 已连接，CLI 兼容入口是否能推理仍以真实执行为准。未登录或连接失败时保留可用页面，给出实际处理方法。
- 课件依赖和真实教材读取分别报告实际检查结果，不将“安装完成”扩大成每个 Skill 都已完成生成验证。
