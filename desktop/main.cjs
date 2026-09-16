const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron');
const { spawn } = require('node:child_process');
const { createWriteStream } = require('node:fs');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { homedir } = require('node:os');

app.setName('VeryMath');
let window;
let service;
let serviceUrl;
let dataDirectory;
let quitting = false;
let stopped = false;
let log;
let configPath;

function localUrl(value) {
  try { return new URL(value).origin === serviceUrl; } catch { return false; }
}

function openExternal(value) {
  try {
    if (['https:', 'http:', 'mailto:'].includes(new URL(value).protocol)) {
      void shell.openExternal(value).catch(error => dialog.showErrorBox('链接打开失败', error.message));
    }
  } catch { /* 无效链接保持在当前窗口。 */ }
}

function protectContents(contents) {
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('will-navigate', (event, url) => {
    if (!localUrl(url)) { event.preventDefault(); openExternal(url); }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (!localUrl(url)) { openExternal(url); return { action: 'deny' }; }
    return { action: 'allow', overrideBrowserWindowOptions: {
      width: 1000, height: 780, show: true, title: 'VeryMath · 阅读资料', backgroundColor: '#faf8f7',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    } };
  });
  contents.on('did-create-window', reader => { reader.show(); reader.focus(); });
  contents.on('will-prevent-unload', () => {
    quitting = false;
    dialog.showErrorBox('课程正在保存', '请等待页面显示“已保存到本机”后再退出。保存失败时，可在页面点击重试保存。');
  });
}

async function startService() {
  const environment = { ...process.env,
    ELECTRON_RUN_AS_NODE: '1', COURSE_COPILOT_HOME: dataDirectory, HOST: '127.0.0.1', PORT: '0',
    PATH: [...new Set([process.env.PATH, join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/Library/TeX/texbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean))].join(':'),
  };
  service = spawn(process.execPath, [join(app.getAppPath(), 'server/index.mjs')], {
    cwd: app.getAppPath(), env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  service.stdout.pipe(log, { end: false });
  service.stderr.pipe(log, { end: false });
  service.on('exit', () => {
    if (!quitting && !stopped && serviceUrl) {
      dialog.showErrorBox('课程服务已停止', '请重新打开 VeryMath。课程文件保存在个人数据目录中。可在帮助菜单查看运行日志。');
      app.quit();
    }
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('课程服务启动超时，请查看运行日志。')), 30000);
    const failed = error => finish(error);
    const exited = code => finish(new Error(`课程服务启动失败（退出代码 ${code}），请查看运行日志。`));
    const ready = message => {
      if (message?.type === 'ready' && Number.isInteger(message.port) && message.port > 0) finish(null, `http://127.0.0.1:${message.port}`);
    };
    function finish(error, url) {
      clearTimeout(timeout);
      service.off('error', failed); service.off('exit', exited); service.off('message', ready);
      if (error) reject(error); else resolve(url);
    }
    service.once('error', failed); service.once('exit', exited); service.on('message', ready);
  });
}

async function stopService() {
  if (!service || service.exitCode !== null || service.signalCode !== null) return;
  await new Promise(resolve => {
    const timeout = setTimeout(() => service.kill('SIGKILL'), 5000);
    service.once('exit', () => { clearTimeout(timeout); resolve(); });
    if (service.connected) service.send({ type: 'shutdown' }, error => { if (error) service.kill('SIGTERM'); });
    else service.kill('SIGTERM');
  });
}

async function chooseDirectory() {
  const result = await dialog.showOpenDialog(window, { title: '选择课程数据目录', defaultPath: dataDirectory, properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || result.filePaths[0] === dataDirectory) return;
  await writeFile(configPath, JSON.stringify({ dataDirectory: result.filePaths[0] }, null, 2), { mode: 0o600 });
  delete process.env.COURSE_COPILOT_HOME;
  app.relaunch(); app.quit();
}

async function createWindow() {
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 960, minHeight: 640,
    title: 'VeryMath 智慧教材', backgroundColor: '#faf8f7', show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.on('closed', () => { window = undefined; });
  await window.loadURL(serviceUrl);
}

function showWindow() {
  if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  else if (serviceUrl && !quitting) void createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('web-contents-created', (_event, contents) => protectContents(contents));
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', event => {
    if (stopped) return;
    event.preventDefault();
    stopped = true;
    void stopService().finally(() => { log?.end(); app.quit(); });
  });
  process.on('exit', () => { if (service?.exitCode === null) service.kill('SIGTERM'); });
  void app.whenReady().then(async () => {
    app.setAboutPanelOptions({ applicationName: 'VeryMath 智慧教材', applicationVersion: app.getVersion(), copyright: 'VeryMath · Apache-2.0' });
    await mkdir(app.getPath('userData'), { recursive: true });
    app.setAppLogsPath();
    await mkdir(app.getPath('logs'), { recursive: true });
    configPath = join(app.getPath('userData'), 'desktop-settings.json');
    let config = {};
    try { config = JSON.parse(await readFile(configPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    dataDirectory = process.env.COURSE_COPILOT_HOME || config.dataDirectory || join(homedir(), '.course-copilot');
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    if (!config.dataDirectory && process.env.COURSE_COPILOT_HOME) {
      await writeFile(configPath, JSON.stringify({ dataDirectory }, null, 2), { mode: 0o600 });
    }
    log = createWriteStream(join(app.getPath('logs'), 'course-service.log'), { flags: 'a', mode: 0o600 });
    log.on('error', error => console.error('日志写入失败：', error.message));
    serviceUrl = await startService();
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'VeryMath', submenu: [{ role: 'about', label: '关于 VeryMath' }, { type: 'separator' }, { role: 'services', label: '服务' }, { type: 'separator' }, { role: 'hide', label: '隐藏 VeryMath' }, { role: 'hideOthers', label: '隐藏其他' }, { role: 'unhide', label: '显示全部' }, { type: 'separator' }, { role: 'quit', label: '退出 VeryMath' }] },
      { label: '文件', submenu: [{ label: '打开课程数据目录', click: () => void shell.openPath(dataDirectory) }, { label: '选择课程数据目录…', click: () => void chooseDirectory().catch(error => dialog.showErrorBox('切换目录失败', error.message)) }, { type: 'separator' }, { role: 'close', label: '关闭窗口' }] },
      { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
      { label: '视图', submenu: [{ role: 'reload', label: '重新载入' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'togglefullscreen', label: '全屏' }] },
      { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, { label: '显示教材窗口', click: showWindow }, { role: 'front', label: '全部置于顶层' }] },
      { label: '帮助', submenu: [{ label: '查看运行日志', click: () => void shell.openPath(app.getPath('logs')) }, { label: '项目主页', click: () => openExternal('https://github.com/VeryMath/VeryMath-textbook-copilot') }] },
    ]));
    await createWindow();
  }).catch(async error => {
    dialog.showErrorBox('VeryMath 启动失败', error.message);
    quitting = true;
    await stopService();
    app.quit();
  });
}
