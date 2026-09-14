import type { SkillEvent, SkillInfo, SkillRequest } from './types';

export type AgentProvider = string;
export type AgentConnectionMode = 'acp' | 'native' | 'cli';
export interface AgentLaunchSettings { mode?: AgentConnectionMode; executable?: string; args?: string[]; modelFlag?: string }

export interface AgentStatus {
  connected: boolean;
  phase: 'disconnected' | 'connecting' | 'login-required' | 'connected' | 'error';
  name: string;
  message: string;
  installed: boolean;
  signedIn: boolean;
  accountLabel: string;
  executable: string;
  note: string;
  busy: boolean;
  providers: { id: AgentProvider; name: string }[];
  connectionModes: { id: AgentConnectionMode; name: string }[];
  defaultCommand: string;
  bundledAdapter: boolean;
  modelInput: 'select' | 'manual';
  authMethods: { id: string; name: string }[];
  config: { provider: AgentProvider; mode: AgentConnectionMode; executable: string; args: string[]; modelFlag: string; model: string; skillPaths: Record<string, string> };
  latex?: { engine: string; version: string; missing: string[]; preferredMathFonts: boolean; ready: boolean; message: string };
  models: { id: string; name: string; isDefault: boolean }[];
  modelNote: string;
  login?: { loginId: string; authUrl?: string; command?: string; manual?: boolean };
  skills: (Omit<SkillInfo, 'available'> & { path: string | null; configured: boolean })[];
}

async function responseError(response: Response): Promise<Error> {
  try {
    const body = await response.json() as { error?: string };
    if (typeof body.error === 'string') return new Error(body.error);
  } catch {
    // 非 JSON 错误页面仍然给出能读懂的提示。
  }
  return new Error(`请求失败（${response.status}），请稍后重试。`);
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<T>;
}

export function getSkills(signal?: AbortSignal): Promise<SkillInfo[]> {
  return getJson('/api/skills', signal);
}

export function getAgentStatus(signal?: AbortSignal): Promise<AgentStatus> {
  return getJson('/api/agent/status', signal);
}

async function agentAction(action: string, value: unknown = {}): Promise<AgentStatus> {
  const response = await fetch(`/api/agent/${action}`, {
    method: action === 'config' ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<AgentStatus>;
}

export const connectAgent = (settings: AgentLaunchSettings) => agentAction('connect', settings);
export const disconnectAgent = () => agentAction('disconnect');
export const startAgentLogin = (authMethod?: string) => agentAction('login', {authMethod});
export const cancelAgentLogin = () => agentAction('login/cancel');
export const saveAgentConfig = (value: AgentLaunchSettings & { provider?: AgentProvider; model?: string; skillPaths?: Record<string, string> }) => agentAction('config', value);

export function skillsFromStatus(status: AgentStatus): SkillInfo[] {
  return [
    { id: 'chat', title: '自由提问', description: '围绕教材提问，接着讨论上一轮内容。', available: status.connected },
    ...status.skills.map(({ id, title, description, configured, templates }) => ({ id, title, description, templates, available: status.connected && configured })),
  ];
}

export async function runSkill(
  request: SkillRequest,
  onEvent: (event: SkillEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/agent/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request), signal,
  });
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error('没有收到 Coding Agent 返回的内容。');
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
    throw new Error('Coding Agent 返回格式不正确，请检查服务端接入。');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let completed = false;
  let queuedText = '';
  let textTimer: ReturnType<typeof setTimeout> | undefined;
  let lastProgress = '';
  function flushText() {
    clearTimeout(textTimer); textTimer = undefined;
    if (!queuedText) return;
    const content = queuedText; queuedText = '';
    if (!signal.aborted) onEvent({ type: 'text', content });
  }
  function deliver(line: string) {
    if (!line.trim() || completed) return;
    let event: SkillEvent;
    try {
      event = JSON.parse(line) as SkillEvent;
    } catch {
      throw new Error('Coding Agent 返回内容无法读取，请检查接口输出。');
    }
    if (!event || !['progress', 'text', 'artifact', 'done', 'error'].includes(event.type)) {
      throw new Error('Coding Agent 返回了无法识别的内容。');
    }
    if (event.type === 'text') {
      queuedText += event.content;
      lastProgress = '';
      textTimer ??= setTimeout(flushText, 50);
      return;
    }
    flushText();
    if (event.type === 'progress') {
      if (event.message === lastProgress) return;
      lastProgress = event.message;
    }
    onEvent(event);
    if (event.type === 'error') throw new Error(event.message || 'Coding Agent 执行失败，请稍后重试。');
    if (event.type === 'done') completed = true;
  }

  try {
    while (!completed) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1 && !completed) {
        deliver(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (done) {
        if (pending.trim() && !completed) deliver(pending);
        break;
      }
    }
    signal.throwIfAborted();
    if (!completed) throw new Error('连接已结束，但 Coding Agent 尚未返回完成信息，请重试。');
  } finally {
    flushText();
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
