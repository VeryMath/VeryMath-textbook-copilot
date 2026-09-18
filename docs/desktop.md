# 桌面版

VeryMath 使用 Electron 提供原生窗口、菜单、文件选择和下载，支持 macOS 和 Windows。`desktop/main.cjs` 启动打包内的课程服务，服务在 `127.0.0.1` 的系统分配端口上监听，通过进程消息通知窗口加载地址。退出应用时先关闭课程服务及相关进程；关闭教材窗口会隐藏窗口，阅读状态继续保留在窗口中。

渲染窗口启用上下文隔离和沙盒，使用 HTTP 接口访问课程内容。教材和辅助资料的本地链接在独立阅读窗口打开，外部网页链接交给默认浏览器。课程界面的保存保护继续生效：存在待保存数据时，退出会提示等待保存或重试。

菜单按平台适配：macOS 保留原生应用菜单（VeryMath、服务、隐藏等），Windows 使用简化菜单并将「关于」「退出」放入文件和帮助菜单。

## 数据与运行环境

### macOS

- 默认课程目录：`~/.course-copilot`，与浏览器版格式一致。
- 桌面设置：`~/Library/Application Support/VeryMath/desktop-settings.json`，记录通过菜单选择的课程目录。
- 运行日志：`~/Library/Logs/VeryMath/course-service.log`，可通过帮助菜单打开。
- 首次启动时设置 `COURSE_COPILOT_HOME` 可指定并记住已有课程目录。后续通过文件菜单切换目录。
- 同一课程目录应由一个正在运行的 VeryMath 服务使用。

### Windows

- 默认课程目录：`%USERPROFILE%\.course-copilot`，与浏览器版格式一致。
- 桌面设置：`%APPDATA%\VeryMath\desktop-settings.json`，记录通过菜单选择的课程目录。
- 运行日志：`%APPDATA%\VeryMath\logs\course-service.log`，可通过帮助菜单打开。
- 安装包未签名，首次运行时 Windows 可能显示 SmartScreen 提示，点击「仍要运行」即可。
- 安装向导提供桌面和开始菜单快捷方式，可选择安装目录。

### 运行环境

应用通过 Electron 的 [ELECTRON_RUN_AS_NODE](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node) 模式运行后端和课程读取工具。启动环境按平台区分 PATH 分隔符和路径列表：macOS 包含 Homebrew、`~/.local/bin` 和 MacTeX 路径；Windows 使用系统 PATH。

应用包含前端成品、后端、课程 Skill、模板和运行依赖。课程文件与用户设置保存在个人数据目录。打包采用普通资源目录（`asar: false`），方便 Agent 直接读取 Skill、模板及工具文件。

## 构建

### macOS

在 Apple 芯片 Mac 上执行 `npm ci`，然后运行：

| 命令 | 用途 |
| --- | --- |
| `npm run desktop` | 构建前端并启动开发应用 |
| `npm run desktop:pack` | 生成 `release/mac-arm64/VeryMath.app` |
| `npm run desktop:dist` | 生成应用和 DMG 安装包 |

打包配置位于 `package.json` 的 `build` 字段。默认产物使用 Apple 芯片架构、macOS 12 最低版本和临时签名。

正式分发时，由项目维护者配置 Apple Developer ID 和公证凭据，将 `mac.identity`、`mac.hardenedRuntime`、`mac.notarize` 调整为发布配置，并按 [electron-builder 的 macOS 签名说明](https://www.electron.build/v26/docs/mac/) 打包。凭据通过构建环境提供。

### Windows

Windows 安装包通过 GitHub Actions 在 `windows-latest` runner 上构建，确保 native 模块（如 `@napi-rs/canvas`、`esbuild`）正确安装为 win32-x64 二进制。**不建议从 macOS 交叉编译**，因为 native 模块会缺失对应平台二进制。

构建流程见 `.github/workflows/windows-desktop.yml`，推送 `codex/windows-desktop` 分支或手动触发即可。构建步骤：

1. `npm ci`
2. `npm run desktop:dist:win`（生成 NSIS 安装包）
3. 验证内嵌 Node.js 启动
4. 上传 `release/*-windows-x64-setup.exe` 为 artifact

本地构建（需 Windows 环境）：

| 命令 | 用途 |
| --- | --- |
| `npm run desktop:pack:win` | 生成 `release/win-unpacked/` 目录 |
| `npm run desktop:dist:win` | 生成 NSIS 安装包 |

NSIS 配置：非一键安装、允许选择安装目录、创建桌面和开始菜单快捷方式、关闭差分包。图标使用 `desktop/icon.png`。
