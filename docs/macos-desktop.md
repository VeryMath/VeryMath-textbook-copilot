# macOS 桌面版

VeryMath 使用 Electron 提供原生窗口、菜单、Dock 入口、文件选择和下载。`desktop/main.cjs` 启动打包内的课程服务，服务在 `127.0.0.1` 的系统分配端口上监听，通过进程消息通知窗口加载地址。退出应用时先关闭课程服务及已连接的 Agent；关闭教材窗口会隐藏窗口，阅读状态继续保留在窗口中。

渲染窗口启用上下文隔离和沙盒，使用 HTTP 接口访问课程内容。教材和辅助资料的本地链接在独立阅读窗口打开，外部网页链接交给默认浏览器。课程界面的保存保护继续生效：存在待保存数据时，退出会提示等待保存或重试。

## 数据与运行环境

- 默认课程目录：`~/.course-copilot`，与浏览器版格式一致。
- 桌面设置：`~/Library/Application Support/VeryMath/desktop-settings.json`，记录通过菜单选择的课程目录。
- 运行日志：`~/Library/Logs/VeryMath/course-service.log`，可通过帮助菜单打开。
- 首次启动时设置 `COURSE_COPILOT_HOME` 可指定并记住已有课程目录。后续通过文件菜单切换目录。
- 同一课程目录应由一个正在运行的 VeryMath 服务使用。

应用通过 Electron 的 [ELECTRON_RUN_AS_NODE](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node) 模式运行后端和内置 Agent 适配器。课程读取工具使用相同的内置运行环境。启动环境包含 Homebrew、`~/.local/bin` 和 MacTeX 的常用路径；自定义 Agent 支持在工作区设置中填写完整路径。

应用包含前端成品、后端、课程 Skill、模板和运行依赖。课程文件与用户设置保存在个人数据目录。打包采用普通资源目录，Agent 可直接读取 Skill、模板及工具文件。

## 构建

在 Apple 芯片 Mac 上执行 `npm ci`，然后运行：

| 命令 | 用途 |
| --- | --- |
| `npm run desktop` | 构建前端并启动开发应用 |
| `npm run desktop:pack` | 生成 `release/mac-arm64/VeryMath.app` |
| `npm run desktop:dist` | 生成应用和 DMG 安装包 |

打包配置位于 `package.json` 的 `build` 字段。默认产物使用 Apple 芯片架构、macOS 12 最低版本和临时签名。本机验证包含打包应用启动、已有教材阅读、辅助资料搜索、内置运行环境和退出时的服务清理。

正式分发时，由项目维护者配置 Apple Developer ID 和公证凭据，将 `mac.identity`、`mac.hardenedRuntime`、`mac.notarize` 调整为发布配置，并按 [electron-builder 的 macOS 签名说明](https://www.electron.build/v26/docs/mac/) 打包。凭据通过构建环境提供。
