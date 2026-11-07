import { useCallback, useEffect, useRef, useState } from 'react';

type BrowserUpdate = {
  managedByDesktop: false;
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  releaseUrl: string;
  checkedAt: string;
};
type VersionStatus = BrowserUpdate | { managedByDesktop: true; currentVersion: string };
const checkInterval = 6 * 60 * 60 * 1000;

async function requestUpdate(refresh: boolean, signal: AbortSignal): Promise<VersionStatus> {
  const response = await fetch(`/api/update${refresh ? '?refresh=1' : ''}`, { cache: 'no-store', signal });
  if (!response.ok) {
    if (response.status === 401) throw new Error('请使用本次启动链接重新打开页面，再检查更新。');
    throw new Error(`版本检查失败（HTTP ${response.status}），请稍后重试。`);
  }
  const value = await response.json() as Partial<Omit<BrowserUpdate, 'managedByDesktop'>> & { managedByDesktop?: boolean };
  if (!value || typeof value.currentVersion !== 'string' || typeof value.managedByDesktop !== 'boolean') {
    throw new Error('版本接口返回的数据无效，请重试。');
  }
  if (value.managedByDesktop) return { managedByDesktop: true, currentVersion: value.currentVersion };
  if (typeof value.latestVersion !== 'string' || typeof value.available !== 'boolean'
      || typeof value.releaseUrl !== 'string' || typeof value.checkedAt !== 'string'
      || !Number.isFinite(new Date(value.checkedAt).getTime())) throw new Error('版本接口返回的数据不完整，请重试。');
  const release = new URL(value.releaseUrl);
  if (release.origin !== 'https://github.com' || release.username || release.password || release.search || release.hash
      || !/^\/VeryMath\/VeryMath-textbook-copilot\/releases\/tag\/[^/]+$/.test(release.pathname)) {
    throw new Error('版本接口返回的发布地址无效。');
  }
  return { managedByDesktop: false, currentVersion: value.currentVersion, latestVersion: value.latestVersion,
    available: value.available, releaseUrl: release.href, checkedAt: value.checkedAt };
}

export function useVersionUpdates() {
  const [status, setStatus] = useState<VersionStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [dismissedVersion, setDismissedVersion] = useState('');
  const managed = useRef(false);
  const controller = useRef<AbortController | null>(null);

  const check = useCallback(async (refresh = false) => {
    if (managed.current || controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setChecking(true); setError('');
    try {
      const value = await requestUpdate(refresh, request.signal);
      if (controller.current !== request) return;
      managed.current = value.managedByDesktop;
      setStatus(value);
    } catch (reason) {
      if (controller.current === request && !request.signal.aborted) {
        setError(reason instanceof Error ? reason.message : '版本检查失败，请重试。');
      }
    } finally {
      if (controller.current === request) { controller.current = null; setChecking(false); }
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => { void check(); }, 0);
    return () => {
      clearTimeout(initial);
      controller.current?.abort(); controller.current = null;
    };
  }, [check]);

  useEffect(() => {
    if (status?.managedByDesktop) return;
    const timer = window.setInterval(() => { void check(); }, checkInterval);
    return () => clearInterval(timer);
  }, [check, status?.managedByDesktop]);

  const available = status && !status.managedByDesktop && status.available ? status : null;
  return { status, checking, error, check,
    notice: available && available.latestVersion !== dismissedVersion ? available : null,
    dismiss: () => { if (available) setDismissedVersion(available.latestVersion); } };
}

export type VersionUpdates = ReturnType<typeof useVersionUpdates>;
