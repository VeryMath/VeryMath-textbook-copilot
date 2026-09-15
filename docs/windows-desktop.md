# Windows 桌面版

Windows 与 macOS 共用 `desktop/main.cjs` 和课程后端。Windows 使用 NSIS 安装向导，提供安装目录选择、桌面快捷方式与开始菜单入口。课程文件保存在 `%USERPROFILE%\.course-copilot`；桌面设置和运行日志位于 Electron 的用户数据与日志目录，可通过应用菜单访问。

Windows 版本使用分号组合程序搜索路径，保留用户环境中的路径，并加入用户安装的常用命令目录。内置 Codex 适配器使用随应用打包的 Windows 程序。外部 Agent 可填写 `.exe` 的完整路径；复制的手动登录命令适用于 PowerShell。

关闭教材主窗口时退出应用，退出前继续检查课程保存状态，并关闭后端及 Agent 进程。Windows 的 Agent 清理使用系统 `taskkill.exe /T` 结束相关子进程。

## 构建

在 Windows x64 环境运行：

```powershell
npm ci
npm run desktop:dist:win
```

安装包位于 `release/VeryMath-0.1.1-windows-x64-setup.exe`。原生运行依赖由 Windows 上的 `npm ci` 安装。安装向导配置见 `package.json` 中的 `win` 与 `nsis` 字段；选项说明见 [electron-builder NSIS 文档](https://www.electron.build/v26/docs/nsis/)。

`.github/workflows/windows-desktop.yml` 负责 Windows 构建，执行前端类型检查和构建，再生成安装包，检查包内 Node.js 与 Codex 能否启动，并上传安装文件。工作流产物保存 14 天。

当前安装包使用未签名配置。正式分发时可在构建环境配置 Windows 代码签名证书。实际 Windows 桌面上的安装、阅读和 Agent 交互仍需验证。
