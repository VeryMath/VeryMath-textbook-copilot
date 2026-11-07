import { Download, ExternalLink, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { VersionUpdates } from '../lib/useVersionUpdates';
import './version-updates.css';

export function VersionUpdateNotice({ updates }: { updates: VersionUpdates }) {
  if (!updates.notice) return null;
  return <div className="version-update-notice" role="status">
    <Download size={16}/>
    <span>发现新版本 {updates.notice.latestVersion}，当前版本为 {updates.notice.currentVersion}。</span>
    <a href={updates.notice.releaseUrl} target="_blank" rel="noopener noreferrer">查看官方发布页<ExternalLink size={14}/></a>
    <button className="icon-button" type="button" aria-label="关闭本版本更新提示" onClick={updates.dismiss}><X size={15}/></button>
  </div>;
}

export function VersionUpdateSettings({ updates }: { updates: VersionUpdates }) {
  const { status, checking, error } = updates;
  if (status?.managedByDesktop) return null;
  return <section className="version-update-settings" aria-label="版本更新">
    <h3><Download size={17}/>版本更新</h3>
    <p>{status ? `当前版本：${status.currentVersion}` : checking ? '正在读取版本信息。' : '尚未完成版本检查。'}</p>
    {status && <p>{status.available ? `发现新版本 ${status.latestVersion}。` : '当前没有可用的新版本。'}</p>}
    <div className="version-update-actions">
      <button type="button" className="secondary-button" disabled={checking} onClick={() => void updates.check(true)}>
        {checking ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>}
        {checking ? '正在检查…' : error ? '重试检查' : '检查更新'}
      </button>
      {status && <a className="text-button" href={status.releaseUrl} target="_blank" rel="noopener noreferrer">官方发布页<ExternalLink size={14}/></a>}
    </div>
    {error && <p className="version-update-error" role="alert">{error}</p>}
    {status && <p className="version-update-checked">上次检查：{new Date(status.checkedAt).toLocaleString('zh-CN')}</p>}
    <p>浏览器版请在官方发布页查看更新说明，自行更新源码后重新启动服务。</p>
  </section>;
}
