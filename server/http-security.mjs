import { randomBytes, timingSafeEqual } from 'node:crypto';
import { MIMEType } from 'node:util';
import { parseCookie, stringifySetCookie } from 'cookie';

const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function sameSecret(value, expected) {
  if (typeof value !== 'string') return false;
  const bytes = Buffer.from(value);
  const secret = Buffer.from(expected);
  return bytes.length === secret.length && timingSafeEqual(bytes, secret);
}

export function requireContentType(req, expected) {
  const value = req.headers['content-type'];
  if (typeof value !== 'string') fail(415, `请求需要使用 ${expected}。`);
  let type;
  try { type = new MIMEType(value); }
  catch { fail(415, '请求的 Content-Type 格式无效。'); }
  if (type.essence !== expected) fail(415, `请求需要使用 ${expected}。`);
}

export function createLocalAccess() {
  const launchSecret = randomBytes(32).toString('base64url');
  const sessionSecret = randomBytes(32).toString('base64url');
  const browserHostname = `course-${randomBytes(16).toString('hex')}.localhost`;

  function launchUrl(address) {
    if (!address || typeof address === 'string' || !loopbackAddresses.has(address.address)) {
      throw new Error('课程服务只能监听 127.0.0.1 或 ::1。');
    }
    return `http://${browserHostname}:${address.port}/?access=${launchSecret}`;
  }

  function check(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    if (!loopbackAddresses.has(req.socket.remoteAddress)) fail(403, '课程服务仅接受本机请求。');
    const port = req.socket.localPort;
    const browserHost = new URL(`http://${browserHostname}:${port}`).host;
    const allowedHosts = [browserHostname, '127.0.0.1', 'localhost', '[::1]'].map(host => new URL(`http://${host}:${port}`).host);
    if (!allowedHosts.includes(req.headers.host)) fail(403, '请求的 Host 不属于本机课程服务。');
    const origin = `http://${req.headers.host}`;
    if (req.headers.origin !== undefined && req.headers.origin !== origin) fail(403, '请求来源与课程服务不一致。');
    const url = new URL(req.url || '/', origin);
    if (url.origin !== origin) fail(403, '请求地址与课程服务不一致。');
    const cookieName = `course_session_${port}`;

    if (url.pathname === '/' && url.searchParams.has('access')) {
      if (req.headers.host !== browserHost) fail(403, '请使用本次启动链接中的专用主机地址。');
      if (req.method !== 'GET') fail(405, '请使用启动链接打开课程服务。');
      if (url.searchParams.getAll('access').length !== 1 || !sameSecret(url.searchParams.get('access'), launchSecret)) {
        fail(401, '启动链接无效，请使用本次启动时提供的完整地址。');
      }
      res.writeHead(303, {
        'Set-Cookie': stringifySetCookie({ name: cookieName, value: sessionSecret, httpOnly: true, sameSite: 'strict', path: '/' }),
        'Cache-Control': 'no-store', Location: '/',
      });
      res.end();
      return false;
    }

    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') fail(403, '请从课程页面发起请求。');
    const bearer = req.headers.authorization;
    const explicitCredential = typeof bearer === 'string' && bearer.startsWith('Bearer ')
      && sameSecret(bearer.slice(7), launchSecret);
    // Cookie 仅用于本次启动的专用主机，localhost 与 IP 地址供 CLI 使用。
    const cookie = req.headers.host === browserHost ? parseCookie(req.headers.cookie || '')[cookieName] : undefined;
    if (!explicitCredential && !sameSecret(cookie, sessionSecret)) {
      fail(401, '请使用终端或桌面应用提供的启动链接打开课程服务。');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== origin && !explicitCredential) {
      fail(403, '写入请求需要同源 Origin 或明确的访问凭据。');
    }
    return true;
  }

  return { check, launchUrl };
}
