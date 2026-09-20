# VeryMath 智慧教材

个人部署的课程学习工作台：左侧阅读教材，右侧与 Copilot 交互。导入自己的教材 PDF，连接一个 LLM API，就能针对任意章节提问、讲解、出题，并生成思维导图、知识图谱和 LaTeX 课件。所有数据保存在你自己的电脑上，使用你自己的 API 账号。

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13.0-green.svg)](https://nodejs.org)

## 特性

- **个人部署**：本地 HTTP 服务 + 浏览器界面，教材与课程记录不离开本机。
- **桌面版开箱即用**：macOS（Apple Silicon）和 Windows 均提供安装包，自带运行环境，无需手动安装 Node.js 或命令行工具。
- **接入你已有的 LLM**：内置支持 Anthropic、OpenAI、Google、DeepSeek 等常见 Provider，也支持自定义 OpenAI 兼容接口；在「工作区设置」中填入 API Key 即可连接。
- **内置课程 Skill**：教材解析、讲解、知识点出题、思维导图、知识图谱、LaTeX Beamer 课件随项目提供；讲解视频可接入自定义 Skill。
- **成品有序存放**：生成结果按类型分目录，编译与内部文件隐藏，方便直接查阅。

## 工作原理

```text
前端 UI：教材、目录、选中文字、对话、图谱、课件、视频
                    ↕ 请求、进度、回答、结果
课程 Agent：理解要求 → 读取教材 → 调用一个或多个 Skill
                    ↕ 读取与保存文件
个人课程目录：原始教材、解析内容、阅读记录、对话、生成资料
```

教学任务统一交给所选 LLM 完成，Agent 调用项目内置的 Skill 处理具体工作。每个用户用自己的 API 账号，路径已配置不代表任务已执行成功。

## 支持的 LLM Provider

| Provider | 说明 |
| --- | --- |
| Anthropic | Claude 系列模型，填入 API Key 即可 |
| OpenAI | GPT 系列模型，填入 API Key 即可 |
| Google | Gemini 系列模型，填入 API Key 即可 |
| DeepSeek | DeepSeek 系列模型，填入 API Key 即可 |
| 自定义 | 任何 OpenAI Chat Completions 兼容接口，填入 Base URL、模型名称和 API Key |

以上之外还有 OpenRouter、xAI、Groq、Moonshot、Z.AI 等服务商，完整列表以「工作区设置」中实际显示的为准。

在「工作区设置」中选择模型服务 Provider 并填入 API Key，选择模型后即可开始提问。

## 快速开始

### 桌面版（推荐）

提供 macOS 和 Windows 安装包，自带运行环境，无需安装 Node.js 或命令行工具。

**macOS（Apple Silicon）**：打开下载的 `VeryMath-<版本>-arm64.dmg`，将 VeryMath 拖入 Applications，然后从应用程序中打开。要求 macOS 12 或更新版本。

**Windows**：运行下载的 `VeryMath-<版本>-windows-x64-setup.exe`，按安装向导选择目录后启动。适用于 64 位 Windows 10 或更新版本。安装包未签名，首次运行时 Windows 可能显示 SmartScreen 提示，点击「仍要运行」即可。

下载地址见 [Releases](https://github.com/VeryMath/VeryMath-textbook-copilot/releases)。

启动后，前往「工作区设置」选择模型服务 Provider 并填入 API Key，选择模型后即可开始提问。默认课程目录：

- macOS：`~/.course-copilot`
- Windows：`%USERPROFILE%\.course-copilot`

菜单「文件 → 选择课程数据目录…」可连接已有课程目录；「打开课程数据目录」可在文件管理器中查看教材与生成资料。

生成 LaTeX 课件需要本机 XeLaTeX；扫描文字识别需要 Tesseract、中文语言数据及 Poppler。桌面版保留工作区设置中的环境检查和连接入口。

源码打包命令：

| 平台 | 命令 | 产物 |
| --- | --- | --- |
| macOS | `npm run desktop:dist` | `release/VeryMath-0.2.2-arm64.dmg` |
| Windows | `npm run desktop:dist:win` | `release/VeryMath-0.2.2-windows-x64-setup.exe` |

Windows 构建使用 GitHub Actions `windows-latest` runner，确保 native 模块正确安装。详见 [桌面版文档](docs/desktop.md)。

### 浏览器版

首次使用建议先读 [用户手册](docs/user-guide.md)，重点是安装与启动；其余功能由所选 LLM 自主完成。

最省事的安装方式是把下面这段发给你使用的 Coding Agent，它会自动完成依赖安装、内置 Skill 配置、服务启动，并返回访问地址：

```text
拉取 https://github.com/VeryMath/VeryMath-textbook-copilot，
按仓库里的 skills/verymath-install/SKILL.md 完成 VeryMath 智慧教材的本机部署：
检查并安装必要依赖，配置内置课程 Skill，启动工作台并给我访问地址。
```

部署步骤写在 [skills/verymath-install/SKILL.md](skills/verymath-install/SKILL.md)，Agent 拉取仓库后按这份说明执行即可。

手动安装：在要部署的电脑上准备 Node.js 22.13 或更新版本，然后：

```bash
git clone https://github.com/VeryMath/VeryMath-textbook-copilot.git
cd VeryMath-textbook-copilot
npm ci
npm run build && npm start
```

启动地址以终端输出为准（默认 `http://127.0.0.1:4173`，可用 `PORT` 改端口，默认只监听本机）。开发时可用 `npm run dev`；开发、预览与正式服务都会初始化模型服务，并共用同一份接口与个人目录。首次打开页面点击「导入教材」选择 PDF，再到「工作区设置」选择模型服务 Provider 并填入 API Key。

> 前端、本机文件服务与 Agent 运行在同一台部署电脑上；单独把 `dist` 传到静态托管平台无法运行 Agent。

源码不依赖任何开发者的用户名、个人目录或账号。macOS 和 Windows 已进行实际安装与页面验证；Linux 使用相同 Node.js 启动方式。

## 个人数据目录

默认位置为 `~/.course-copilot/`，设置页显示实际完整路径：

```text
~/.course-copilot/
├── settings.json                   # 当前课程、栏目宽度、模型服务与 Skill 设置
├── agent/                          # 模型服务配置：auth.json（各服务商的 API Key，0600）等
└── courses/
    └── 面向机器学习的最优化方法/      # 目录名 = 书名；同一本书（sha256 相同）只保留一个
        ├── textbook.pdf            # 原始教材
        ├── references/             # 辅助资料，每份资料按 ID 建立子目录
        │   └── <资料ID>/           # 原文件、metadata.json 与提取正文 text.json
        ├── textbook/
        │   ├── course.json         # 教材名称、页数、sha256 文件指纹
        │   ├── outline.json        # 章节目录
        │   ├── pages/              # 已阅读页面的正文
        │   └── images/             # 教材图片
        ├── reading.json            # 页码、书签、笔记数据、当前对话
        ├── conversations/          # 每段对话分别保存
        └── outputs/                # 成品按类型分列；点开只看到文档
            ├── notes/              # 讲解、笔记、图片（.md/.svg/.png）
            ├── slides/             # 课件 PDF 与源文件 ZIP
            ├── quizzes/  mindmaps/  knowledge-graphs/  videos/  files/
            └── .build/             # 机器文件（默认隐藏）：结果 JSON、LaTeX 编译树、解析缓存
                └── artifacts/      # result-<ID>.json
```

`outputs` 顶层只放给人看的成品，按类型分子目录；编译过程文件、解析中间产物和结果 JSON 都收进 `.build/`。旧布局可用 `npm run migrate`（先整目录备份，`--dry-run` 可预览）一次性整理成新结构并合并重复书。

启动时可指定其他位置：

```bash
COURSE_COPILOT_HOME="$HOME/Documents/我的课程资料" npm start
```

切换路径后会使用新位置，不自动搬动旧目录。迁移时先停止服务，复制完整个人目录，再指定新位置启动。备份也复制完整目录；生成任务结束后再备份能避免漏掉正在写入的文件。

换电脑后，在新电脑上安装桌面版或浏览器版并连接复制的完整个人数据目录。已保存的各服务商 API Key 随 `agent/auth.json` 一并保留，重启后也可继续使用；未复制配置时，在「工作区设置」中填写 API Key。如果手动填写的 Skill 路径改变，在设置页更新即可。

应用创建的目录权限为 `0700`，文件为 `0600`。Agent 写入生成文件时也应使用私有权限；服务发布本地文件结果时会将对应文件收紧为 `0600`。不要把个人数据目录作为网页静态目录公开。

浏览器内仅保留当前界面状态。教材文件、阅读位置、书签、对话、结果和栏宽由本机服务保存，换浏览器或清除缓存后可重新读取。页面显示保存失败时可以重试，关闭前等待保存完成。当前有笔记数据字段，尚未增加笔记编辑界面。

首次使用时可以直接导入自己的 PDF；如果本地项目目录已有配套的最优化教材 PDF，空课程目录会自动导入它，源码仓库不包含该 PDF。导入 PDF 会新增独立课程，同名教材使用不同文件夹。旧版浏览器中的教材、阅读和对话会在启动时迁移；服务确认成功后才清理对应旧记录。迁移失败时原浏览器数据仍保留，刷新可重试。

阅读器使用 PDF.js 连续滚动展示原始 PDF，页码对应 PDF 页序。滚动时界面同步当前可见页；目录跳转、书签和页码输入会定位到指定页。选中文字可跨连续页面引用。正文随着阅读提取并保存到 `textbook/pages/`。整章、整书的知识结构任务由 Agent 调用相应 Skill 补读原始 PDF。

Copilot 的“操作范围”适用于所有课程工具。处理连续多页时选“指定页码”，填写起始页和结束页（例如 10–15），按 PDF 页序计数并包含首尾页；无需逐页拖选。“选中文字”用于在教材上拖选一段文字，选中后会显示引用内容。扫描教材没有文字层时使用“指定页码”，具体识别效果取决于 Agent 的图像读取能力。

## 功能

每本教材的「辅助资料」标签页可添加讲义、习题解答和参考文献，支持一次选择多个文件、编辑名称与说明、打开和删除。支持 PDF、TXT、Markdown、DOCX、PPTX、PNG、JPEG、WebP，资料随所属课程保存。勾选资料后点击「结合这些资料提问」，输入框会展示本轮选中的资料，可逐份移除。所选资料也会显示在发送后的消息中。自由问答、教材解析、讲解和出题任务按所选清单阅读，引用时标注资料名称和对应位置。思维导图、知识图谱、讲解视频和课件围绕主教材生成与修改。

资料上传后会在后台提取正文。「搜索全文」按输入的连续文字搜索当前教材的辅助资料，结果显示命中片段和位置，点击 PDF 页码可打开对应页面。已有资料会在首次搜索时提取，页面自动更新进度和结果。PDF 按文件页序标页码，PPTX 按演示顺序标幻灯片序号，TXT、Markdown 和 DOCX 标段落序号。

扫描 PDF 和图片可点击「识别扫描文字」进行光学字符识别（OCR）。部署电脑需安装 Tesseract，中文识别需安装 `chi_sim` 或 `chi_tra` 语言数据；PDF 扫描页还需 Poppler 的 `pdftoppm`。DOCX 与 PPTX 正文由应用内的 ZIP 读取库提取，无需另外安装 `unzip`。提取失败时，资料卡片显示原因并提供重试。识别结果中的公式和关键数字应结合原页核对。

配置好模型服务后，界面提供以下课程功能，按当前页、选中内容、当前章节或整本教材的范围调用：

- **教材解析**：把选定页或章节整理为可读的数字教材，提取正文、公式、图片和目录。
- **讲解内容**：依据教材对概念、定理、算法和例题做分层讲解，可主动配图。
- **知识点出题**：生成带递进提示和参考答案的练习卡片。
- **思维导图**：按章、节或选文生成层级知识树，节点可跳回教材页，支持保存个人补充。
- **知识图谱**：概念与关系的可视化网络，支持概览/详细两种深度、搜索、缩放和证据跳转。
- **生成课件**：用 LaTeX Beamer 把章节编译成 16:9 的 PDF 课件，可预览、下载 PDF 与源文件。
- **自由问答**：不带固定功能，按你的提问组织讲解、绘图和资料。

对话、文字资料和课件共用 KaTeX 公式渲染，支持行内与独立公式。生成课件需要部署电脑有可用的 XeLaTeX、Beamer、ctex、数学宏包和中文字体；「工作区设置 → 课件编译环境」可查看缺失项并重新检查。

## 文档

- [用户手册](docs/user-guide.md) — 安装、启动与日常使用。
- [架构与开发参考](docs/architecture.md) — 三层分工、模型服务配置、课程任务数据流、模块清单。
- [模型服务接入](docs/agent-integration.md) — 服务商、API Key、自定义端点与模型能力声明。
- [Skill 模块开发与接入](docs/skill-development.md) — 如何新增或修改一个课程 Skill。
- [桌面版](docs/desktop.md) — macOS 与 Windows 桌面应用的实现、构建与打包说明。
- [数学与算法实验（规划中）](docs/math-experiments.md)、[知识点学习流程（规划中）](docs/learning-flow.md) — 后续方向。

## 许可

本项目采用 [Apache License 2.0](LICENSE) 许可。
