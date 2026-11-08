import electron from 'electron';
import { join } from 'node:path';
import { checkForUpdate } from '../../shared/release-updates.mjs';
import { downloadReleaseAsset, verifyDownloadedAsset } from './download.mjs';

const { app, dialog, shell, Menu } = electron;

export function createDesktopUpdater({ getWindow, showWindow, getServiceLaunchUrl, isClosing, queueWindowsInstaller }) {
  let checking = false;
  let downloadController;
  let dialogController;
  let timer;
  let offeredVersion;
  let downloaded;

  function refreshMenu() {
    const menu = Menu.getApplicationMenu();
    const check = menu?.getMenuItemById('check-updates');
    const cancel = menu?.getMenuItemById('cancel-update-download');
    if (check) check.enabled = !checking;
    if (cancel) cancel.enabled = !!downloadController;
  }
  async function message(options) {
    if (isClosing()) return { response: options.cancelId ?? 0 };
    showWindow();
    const parent = getWindow();
    dialogController = new AbortController();
    try {
      const value = { title: 'VeryMath 更新', noLink: true, ...options, signal: dialogController.signal };
      return parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, value) : await dialog.showMessageBox(value);
    } finally { dialogController = undefined; }
  }
  async function agentIsBusy() {
    const launchUrl = new URL(getServiceLaunchUrl());
    const access = launchUrl.searchParams.get('access');
    if (!access || !/^[A-Za-z0-9_-]{43}$/.test(access)) throw new Error('课程服务访问凭据无效，无法确认任务状态。');
    const url = new URL(`http://127.0.0.1:${launchUrl.port}/api/agent/status`);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${access}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('无法确认课程任务状态，请先完成课程保存，再从下载目录安装。');
    const state = await response.json();
    if (typeof state.busy !== 'boolean') throw new Error('课程任务状态无效，请先完成课程保存。');
    return state.busy;
  }
  async function offerInstallation(update) {
    try { await verifyDownloadedAsset(update.path, update.asset); }
    catch (error) { downloaded = undefined; throw error; }
    if (isClosing()) return;
    if (process.platform === 'darwin') {
      const answer = await message({ type: 'info', message: `VeryMath ${update.version} 已下载并通过校验。`,
        detail: '打开安装镜像后，将 VeryMath 拖入“应用程序”。更新前请完成课程保存。',
        buttons: ['打开安装镜像', '显示文件', '稍后'], defaultId: 2, cancelId: 2 });
      if (answer.response === 0 && !isClosing()) {
        const error = await shell.openPath(update.path);
        if (error) throw new Error(`安装镜像打开失败：${error}`);
      } else if (answer.response === 1 && !isClosing()) shell.showItemInFolder(update.path);
      return;
    }
    if (process.platform === 'win32') {
      if (await agentIsBusy()) {
        const answer = await message({ type: 'info', message: `VeryMath ${update.version} 安装包已准备好。`,
          detail: '课程任务仍在运行。请等待任务结束并完成保存，再关闭应用运行安装包。',
          buttons: ['显示安装包', '稍后'], defaultId: 1, cancelId: 1 });
        if (answer.response === 0 && !isClosing()) shell.showItemInFolder(update.path);
        return;
      }
      const answer = await message({ type: 'question', message: `VeryMath ${update.version} 已下载并通过校验。`,
        detail: '安装需要退出当前应用。应用会先检查课程保存状态，停止课程服务，再启动安装程序。',
        buttons: ['退出并安装', '显示安装包', '稍后'], defaultId: 2, cancelId: 2 });
      if (isClosing()) return;
      if (answer.response === 0) {
        if (await agentIsBusy()) {
          await message({ type: 'info', message: '课程任务已开始运行，请等待任务结束后安装。', buttons: ['确定'] });
          return;
        }
        queueWindowsInstaller(update);
      } else if (answer.response === 1) shell.showItemInFolder(update.path);
      return;
    }
    shell.showItemInFolder(update.path);
  }

  async function check(manual = false) {
    if (checking || isClosing()) return;
    checking = true;
    refreshMenu();
    try {
      const result = await checkForUpdate(app.getVersion(), { platform: process.platform, arch: process.arch });
      if (isClosing()) return;
      if (!result.available) {
        if (manual) await message({ type: 'info', message: `当前版本为 ${result.currentVersion}，暂无可用更新。`, buttons: ['确定'] });
        return;
      }
      if (!manual && offeredVersion === result.latestVersion) return;
      offeredVersion = result.latestVersion;
      if (!result.asset) {
        const answer = await message({ type: 'info', message: `发现 VeryMath ${result.latestVersion}。`,
          detail: '当前系统暂未提供可自动下载的安装包，可在官方发布页查看。',
          buttons: ['查看发布页', '稍后'], defaultId: 1, cancelId: 1 });
        if (answer.response === 0 && !isClosing()) await shell.openExternal(result.releaseUrl);
        return;
      }
      if (downloaded?.version === result.latestVersion) {
        await offerInstallation(downloaded);
        return;
      }
      const answer = await message({ type: 'question', message: `发现 VeryMath ${result.latestVersion}，是否下载？`,
        detail: `当前版本：${result.currentVersion}\n安装包：${result.asset.name}\n大小：${(result.asset.size / 1024 / 1024).toFixed(1)} MB\n查看说明后，可从「帮助 → 检查更新」继续。下载后会再次询问是否安装。`,
        buttons: ['下载更新', '查看更新说明', '稍后'], defaultId: 2, cancelId: 2 });
      if (isClosing()) return;
      if (answer.response === 1) {
        await shell.openExternal(result.releaseUrl);
        return;
      }
      if (answer.response !== 0) return;
      downloadController = new AbortController();
      refreshMenu();
      const path = await downloadReleaseAsset(result.asset, { directory: join(app.getPath('userData'), 'updates'), signal: downloadController.signal,
        onProgress: (received, total) => { const target = getWindow(); if (target && !target.isDestroyed()) target.setProgressBar(received / total); } });
      downloaded = { version: result.latestVersion, path, asset: result.asset };
      downloadController = undefined;
      refreshMenu();
      const target = getWindow(); if (target && !target.isDestroyed()) target.setProgressBar(-1);
      await offerInstallation(downloaded);
    } catch (error) {
      if (!isClosing() && !downloadController?.signal.aborted) {
        if (manual || downloadController || downloaded) {
          await message({ type: 'error', message: '更新操作未完成。', detail: `${error.message}\n可在帮助菜单中重新检查更新。`, buttons: ['确定'] });
        } else console.error(`更新检查失败：${error.message}`);
      }
    } finally {
      downloadController = undefined;
      checking = false;
      const target = getWindow(); if (target && !target.isDestroyed()) target.setProgressBar(-1);
      refreshMenu();
    }
  }
  return {
    check,
    cancelDownload: () => downloadController?.abort(),
    cancelForQuit: () => { downloadController?.abort(); dialogController?.abort(); },
    start: () => {
      if (!app.isPackaged || timer) return;
      void check();
      timer = setInterval(() => { void check(); }, 6 * 60 * 60 * 1000);
      timer.unref();
    },
    stop: () => { clearInterval(timer); timer = undefined; downloadController?.abort(); dialogController?.abort(); },
  };
}
