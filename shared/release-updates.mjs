import semver from 'semver';

const repository = 'VeryMath/VeryMath-textbook-copilot';
const releasesUrl = `https://github.com/${repository}/releases`;
const latestReleaseUrl = `https://api.github.com/repos/${repository}/releases/latest`;

function installerName(version, platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') return `VeryMath-${version}-arm64.dmg`;
  if (platform === 'win32' && arch === 'x64') return `VeryMath-${version}-windows-x64-setup.exe`;
  return null;
}

function findInstaller(release, version, platform, arch) {
  const name = installerName(version, platform, arch);
  if (!name) return null;
  const url = `${releasesUrl}/download/${encodeURIComponent(release.tag_name)}/${name}`;
  const asset = release.assets.find(item => item?.name === name && item.state === 'uploaded'
    && item.browser_download_url === url && Number.isSafeInteger(item.size) && item.size > 0
    && typeof item.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(item.digest));
  return asset ? { name, url, size: asset.size, sha256: asset.digest.slice(7).toLowerCase() } : null;
}

export async function checkForUpdate(currentVersion, { platform, arch } = {}) {
  const current = semver.valid(currentVersion);
  if (!current) throw new Error('当前应用的版本号无效。');
  const response = await fetch(latestReleaseUrl, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'VeryMath' },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub 版本检查失败（HTTP ${response.status}）。`);
  const release = await response.json();
  const latestVersion = semver.valid(release?.tag_name);
  if (!latestVersion || semver.prerelease(latestVersion)
      || ![latestVersion, `v${latestVersion}`].includes(release.tag_name)
      || release.draft !== false || release.prerelease !== false
      || !release.published_at || !Array.isArray(release.assets)) {
    throw new Error('GitHub 返回的正式版本信息无效。');
  }
  const available = semver.gt(latestVersion, current);
  return {
    currentVersion: current,
    latestVersion,
    available,
    releaseUrl: `${releasesUrl}/tag/${encodeURIComponent(release.tag_name)}`,
    asset: available ? findInstaller(release, latestVersion, platform, arch) : null,
  };
}
