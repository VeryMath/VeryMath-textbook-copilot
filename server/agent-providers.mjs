import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { CodexClient } from './codex-client.mjs';
import { ClaudeClient } from './claude-client.mjs';
import { OpenCodeClient } from './opencode-client.mjs';
import { AcpClient } from './acp-client.mjs';
import { CommandClient } from './command-client.mjs';
import { courseOpenCodeEnvironment } from './opencode-environment.mjs';

const acp = (command, args = [], extra = {}) => ({ command, args, Client: AcpClient, ...extra });
export const agents = {
  codex: { name: 'Codex', connections: {
    acp: acp('codex-acp', [], { adapter: '../node_modules/@agentclientprotocol/codex-acp/dist/index.js',
      loginCommand: ['codex', 'login'], workspace: 'outputs', environment: { INITIAL_AGENT_MODE: 'agent' } }),
    native: { command: 'codex', Client: CodexClient },
  } },
  claude: { name: 'Claude Code', connections: {
    acp: acp('claude-agent-acp', [], { adapter: '../node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js', loginCommand: ['claude', 'auth', 'login'] }),
    native: { command: 'claude', Client: ClaudeClient },
  } },
  opencode: { name: 'OpenCode', connections: {
    acp: acp('opencode', ['acp'], { loginArgs: ['auth', 'login'], prepareEnvironment: courseOpenCodeEnvironment }),
    native: { command: 'opencode', Client: OpenCodeClient },
  } },
  cursor: { name: 'Cursor', connections: { acp: acp('agent', ['acp'], { loginArgs: ['login'] }) } },
  gemini: { name: 'Gemini CLI', connections: { acp: acp('gemini', ['--acp']) } },
  copilot: { name: 'GitHub Copilot CLI', connections: { acp: acp('copilot', ['--acp', '--stdio'], { loginArgs: ['login'] }) } },
  qwen: { name: 'Qwen Code', connections: { acp: acp('qwen', ['--acp']) } },
  kimi: { name: 'Kimi Code', connections: { acp: acp('kimi', ['acp'], { loginArgs: ['login'] }) } },
  kiro: { name: 'Kiro CLI', connections: { acp: acp('kiro-cli', ['acp'], { loginArgs: ['login'] }) } },
  custom: { name: '自定义 Agent', connections: {
    acp: acp(''), cli: { command: '', args: [], Client: CommandClient },
  } },
};

export function agentConnection(id, mode = 'acp') {
  const agent = agents[id];
  const connection = agent?.connections[mode];
  if (!connection) throw new Error('这个 Agent 不支持所选连接方式。');
  return { ...connection, name: agent.name, type: mode };
}

export function agentPreferences(saved = {}) {
  const provider = ['custom-acp', 'custom-cli'].includes(saved.provider) ? 'custom'
    : Object.hasOwn(agents, saved.provider) ? saved.provider : 'codex';
  const connections = Object.fromEntries(Object.entries(agents).map(([id, agent]) => {
    const previous = saved.connections?.[id] || (id === 'codex' ? saved : {});
    const legacyMode = agent.connections.native ? 'native' : 'acp';
    const mode = Object.hasOwn(agent.connections, previous.mode) ? previous.mode
      : id === 'custom' && saved.provider === 'custom-cli' ? 'cli' : 'acp';
    const profiles = Object.fromEntries(Object.entries(agent.connections).map(([kind, defaults]) => {
      const legacy = id === 'custom' ? saved.connections?.[`custom-${kind}`] || {}
        : kind === legacyMode ? previous : { model: previous.model };
      const source = previous.profiles?.[kind] || legacy;
      return [kind, { executable: source.executable || '', model: source.model || '',
        args: Array.isArray(source.args) ? [...source.args] : [...(defaults.args || [])], modelFlag: source.modelFlag ?? '--model' }];
    }));
    return [id, { mode, profiles }];
  }));
  return { provider, connections, skillPaths: saved.skillPaths || {} };
}

export async function connectionCandidates(provider, mode, profile) {
  const spec = agentConnection(provider, mode);
  if (spec.adapter && !profile.executable) {
    const script = fileURLToPath(new URL(spec.adapter, import.meta.url));
    try { await access(script, constants.R_OK); }
    catch { throw new Error('缺少项目自带的 Agent 连接组件，请在项目目录运行 npm install。'); }
    let loginCommand = spec.loginCommand;
    if (provider === 'codex') {
      const codex = createRequire(script).resolve('@openai/codex/bin/codex.js');
      loginCommand = [...(process.env.ELECTRON_RUN_AS_NODE === '1' ? ['env', 'ELECTRON_RUN_AS_NODE=1'] : []), process.execPath, codex, 'login'];
    }
    return [{ path: process.execPath, displayPath: script, args: [script, ...profile.args], loginCommand }];
  }
  const paths = await executableCandidates(profile.executable || spec.command, mode === 'native' ? provider : undefined);
  return paths.map(path => ({ path, displayPath: path, args: profile.args }));
}

export async function executableCandidates(command, provider) {
  if (!command) return [];
  const paths = isAbsolute(command) ? [command] : [
    ...(process.env.PATH?.split(delimiter).filter(Boolean).map(path => resolve(path, command)) || []),
    resolve(homedir(), '.local/bin', command), resolve('/usr/local/bin', command),
    ...(process.platform === 'darwin' ? [resolve('/opt/homebrew/bin', command)] : []),
  ];
  if (provider === 'codex' && command === 'codex' && process.platform === 'darwin') paths.push(
    '/Applications/Codex.app/Contents/Resources/codex', '/Applications/ChatGPT.app/Contents/Resources/codex',
    resolve(homedir(), 'Applications/Codex.app/Contents/Resources/codex'), resolve(homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex'),
  );
  const found = [];
  for (const path of new Set(paths)) {
    try { await access(path, constants.X_OK); found.push(path); } catch { /* 继续查找其他安装位置。 */ }
  }
  return found;
}
