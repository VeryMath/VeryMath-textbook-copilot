import { get } from 'node:https';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, realpath, rm, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const downloadHosts = new Set(['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const redirectCodes = new Set([301, 302, 303, 307, 308]);
const maximumSize = 2 * 1024 * 1024 * 1024;

export function validateDownloadUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !downloadHosts.has(url.hostname) || url.username || url.password
      || url.port && url.port !== '443' || url.hash) throw new Error('安装包地址不属于允许的 GitHub HTTPS 下载服务。');
  return url;
}

function checkedAsset(value) {
  if (!value || typeof value.name !== 'string' || !value.name || value.name.length > 200
      || basename(value.name) !== value.name || /[\x00-\x1f<>:"/\\|?*]/.test(value.name)
      || /[. ]$/.test(value.name) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(value.name)
      || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > maximumSize
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('发布安装包的名称、大小或 SHA256 信息无效。');
  }
  return { name: value.name, size: value.size, sha256: value.sha256, url: validateDownloadUrl(value.url).href };
}

async function openDownload(url, signal) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const response = await new Promise((accept, reject) => {
      const request = get(validateDownloadUrl(url), { signal, headers: {
        'User-Agent': 'VeryMath-desktop-update', Accept: 'application/octet-stream', 'Accept-Encoding': 'identity',
      } }, accept);
      request.setTimeout(30000, () => request.destroy(new Error('下载连接超时，请稍后重试。')));
      request.on('error', reject);
    });
    if (redirectCodes.has(response.statusCode)) {
      const location = response.headers.location;
      response.destroy();
      if (!location) throw new Error('下载跳转缺少目标地址。');
      url = validateDownloadUrl(new URL(location, url).href).href;
      continue;
    }
    if (response.statusCode !== 200) {
      const status = response.statusCode;
      response.destroy();
      throw new Error(`GitHub 下载失败（HTTP ${status}），请稍后重试。`);
    }
    return response;
  }
  throw new Error('安装包下载跳转次数过多。');
}

export async function verifyDownloadedAsset(path, value, { signal } = {}) {
  const asset = checkedAsset(value);
  signal?.throwIfAborted();
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== asset.size) {
    throw new Error('安装包文件不完整或文件类型无效，请重新下载。');
  }
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    size += chunk.length;
    if (size > asset.size) throw new Error('安装包大小与官方发布信息不一致。');
    hash.update(chunk);
  }
  if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('安装包 SHA256 与官方发布信息不一致，请重新下载。');
  return resolve(path);
}

export async function downloadReleaseAsset(value, { directory, signal, onProgress } = {}) {
  const asset = checkedAsset(value);
  if (typeof directory !== 'string' || !directory) throw new Error('请指定应用私有下载目录。');
  const deadline = AbortSignal.timeout(30 * 60 * 1000);
  const activeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  activeSignal.throwIfAborted();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('应用下载目录不能使用链接文件。');
  await chmod(directory, 0o700);
  const folder = await mkdtemp(join(await realpath(directory), 'download-'));
  const path = join(folder, asset.name);
  const partialPath = `${path}.part`;
  let response;
  try {
    response = await openDownload(asset.url, activeSignal);
    const length = response.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== asset.size)) {
      throw new Error('下载长度与官方发布信息不一致。');
    }
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
      throw new Error('安装包下载使用了不支持的传输编码。');
    }
    let size = 0;
    let lastProgress = 0;
    const hash = createHash('sha256');
    const inspect = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > asset.size) return callback(new Error('下载内容超过官方安装包大小。'));
      hash.update(chunk);
      const now = Date.now();
      if (now - lastProgress >= 250 || size === asset.size) {
        lastProgress = now;
        try { onProgress?.(size, asset.size); } catch (error) { return callback(error); }
      }
      callback(null, chunk);
    } });
    await pipeline(response, inspect, createWriteStream(partialPath, { flags: 'wx', mode: 0o600 }), { signal: activeSignal });
    if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('下载的安装包未通过官方 SHA256 检查。');
    activeSignal.throwIfAborted();
    await link(partialPath, path);
    await unlink(partialPath);
    activeSignal.throwIfAborted();
    return path;
  } catch (error) {
    response?.destroy();
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
