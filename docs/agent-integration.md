# Agent 接入

工作台提供一个 Agent 列表，默认统一通过 ACP 连接。课程、Skill、对话、图片和 PDF 课件使用同一套处理流程。

## 选择后连接

1. 在项目目录运行 `npm install`、`npm run dev`。
2. 打开工作区设置，选择自己的 Coding Agent，点击连接。
3. 复用已有登录；需要登录时，按 Agent 返回的方式完成认证。
4. 选择 Agent 提供的模型，或跟随它原来的设置，然后开始使用课程工具。

Codex 与 Claude 的 ACP 适配器作为项目依赖安装，不需要再手动配置转换程序。Codex 适配器包含兼容的 Codex 程序，Claude 适配器使用 Claude Agent SDK。已有账号仍保存在 Agent 原来的位置，安装项目不会替使用者注册或购买账号。

| Agent | 默认 ACP 入口 |
| --- | --- |
| [Codex](https://github.com/agentclientprotocol/codex-acp) | 项目依赖 `@agentclientprotocol/codex-acp` |
| [Claude Code](https://github.com/agentclientprotocol/claude-agent-acp) | 项目依赖 `@agentclientprotocol/claude-agent-acp` |
| [OpenCode](https://opencode.ai/docs/acp/) | `opencode acp` |
| [Cursor](https://prod.cursor.com/docs/cli/acp) | `agent acp` |
| [Gemini CLI](https://geminicli.com/docs/cli/cli-reference/) | `gemini --acp` |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) | `copilot --acp --stdio` |
| [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/) | `qwen --acp` |
| [Kimi Code](https://moonshotai.github.io/kimi-cli/en/reference/kimi-acp.html) | `kimi acp` |
| [Kiro CLI](https://kiro.dev/docs/cli/acp/) | `kiro-cli acp` |

除项目自带的适配器外，其他 Agent 的 CLI 需安装在部署电脑上。预设来自相应接口说明，不代表所有版本和账号都已逐一验证；旧版程序的参数可在高级设置中调整。

ACP 统一的是通信方式，各 Agent 支持的模型、登录、工具和图像 API 仍由它自己决定。只有封闭图形界面、没有开放接口的产品无法直接接入。更多程序可查阅 [ACP 官方支持名单](https://agentclientprotocol.com/get-started/agents)。

## 图片输入与扫描教材

看图需要三处同时支持：模型本身、所用 API 服务，以及 Agent 对图片输入的处理。工作台显示“已连接”只代表连接就绪，不代表已经验证图片识别。

OpenCode 的自定义模型若未正确识别图片能力，可在原有 `provider.<服务名称>.models.<模型名称>` 配置中合并：

```json
"modalities": {
  "input": ["text", "image"],
  "output": ["text"]
}
```

保留原有地址、凭据、其他模型参数和已支持的输入类型。未显式填写 modalities 不一定意味着禁用了图片，需结合 Agent 实际识别的能力判断；不要为纯文本模型强行声明图片支持。字段定义见 [OpenCode 官方配置](https://opencode.ai/config.json)。

工作台会读取 OpenCode 的个人 provider/model 配置并用于课程进程。修改后在工作台断开并重新连接 OpenCode，使配置重新加载，然后用一张真实图片确认模型能描述其中的内容。仅生成了原页 PNG、或模型声称支持图片，都不能代替实际读取验证。API 网关也需要正确转发图片。

## 高级设置

正常使用无需展开。需要自定义程序位置、修改启动参数或兼容旧环境时再调整。

- **连接方式**：默认 ACP。Codex、Claude Code、OpenCode 保留原生接口兼容选项；自定义 Agent 可选择命令行兼容方式。
- **Agent 程序**：留空使用预设或项目适配器；也可填可执行命令名或完整路径。这里填写 ACP 适配器的程序位置，不能把普通 `codex` 命令当成 `codex-acp`。
- **启动参数**：每行一个参数，无须给整行再加一层引号。
- **模型参数**：仅命令行兼容方式使用；填写模型时，追加参数名称及模型名，例如 `--model 模型名`。

更换连接方式会断开当前连接，并载入该方式自己的程序参数和模型。升级前保存的原生设置保留到原生兼容选项；旧的自定义 ACP 与命令行设置合并到“自定义 Agent”下对应的方式。账号、课程和 Skill 路径继续共用。

系统不会在 ACP 登录失败或调用失败后自动改走另一种接口；错误会显示在页面，需要时可明确选择兼容方式。

## 自定义 Agent

在列表中选择“自定义 Agent”，高级设置会展开。填写该 Agent 的 ACP 命令，连接方式保留 ACP 即可。

若程序只支持非交互 CLI，改选“命令行（兼容）”。例如 Cursor CLI 的文本模式，程序填 `agent`，参数逐行填写：

```text
--print
--output-format
text
{prompt}
```

| 参数写法 | 传递方式 |
| --- | --- |
| `{prompt}` | 把完整课程要求作为一个参数传入 |
| `{promptFile}` | 传入 UTF-8 要求文件路径，任务结束后移除本次文件 |
| 两者都不用 | 通过标准输入传入完整要求 |
| `{courseDir}`、`{outputsDir}` | 本次课程目录或输出目录 |

命令参数不经过 shell，不执行其中的管道、反引号或 `$()`。CLI 必须能输出纯文本并自行退出；带界面的交互终端或厂商 JSON 日志不适用于此模式。[Aider](https://aider.chat/docs/scripting.html) 可使用 `--message-file` 和下一行的 `{promptFile}`，再加 `--no-auto-commits`。

## 工具、权限与数据

文件与命令工具由 Agent 自身提供。当前 ACP 客户端不声明客户端文件、终端或表单扩展能力；依赖编辑器提供全部工具的包装程序，需要补齐自己的工具支持。

课程任务的单次 ACP 工具请求只选择 `allow_once`，不保存长期许可；停止任务会取消会话，必要时结束本工作台启动的进程。Codex ACP 在当前课程的 outputs 中运行，使用工作区写入模式；其他 Agent 收到同样的课程输出目录要求。文件和凭据的访问仍受对应 Agent 的实际权限机制约束。

OpenCode 的 ACP 与原生兼容方式共用独立课程环境，读取个人模型配置，不继承个人插件、MCP 和自动发现的 Skill。已有课程图片、公式和课件展示保持原来的方式。

## 开发者维护

| 模块 | 负责内容 |
| --- | --- |
| `agent-providers.mjs` | 统一 Agent 列表、ACP 预设、项目适配器入口、兼容选项和个人设置读取 |
| `acp-client.mjs` | ACP 初始化、认证、会话、模型、流式输出和取消 |
| 原生 Client、`command-client.mjs` | 高级设置中显式选择的兼容方式 |
| `agent.mjs` | 课程要求、选定 Skill、连接状态与资料回传 |
| `AgentConnection.tsx` | 统一选择界面与高级设置 |

调用方向：页面 → `/api/agent/*` → `agent.mjs` → 同一个 ACP 客户端 → 所选 Agent 或其适配器。兼容方式也返回相同的 `progress/text/done` 事件，资料统一交回 `agent.mjs` 处理。

新增 ACP Agent 只需在 `agent-providers.mjs` 中声明名称和 `connections.acp`，前端自动显示。新适配器接入后，应使用真实教材分别核对登录、模型选择、Skill、资料回传和停止任务；缺少对应账号时明确标注未验证。
