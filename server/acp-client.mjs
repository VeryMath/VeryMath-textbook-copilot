import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { client as acpClient, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { startProcess, stopProcess } from './agent-process.mjs';

function optionsList(options = []) {
  return options.flatMap(option => Array.isArray(option.options) ? optionsList(option.options) : [option]);
}

export class AcpClient extends EventEmitter {
  constructor(executable, cwd, config) {
    super();
    Object.assign(this, { executable, cwd, config, closed: false, ready: false, models: [] });
  }

  async initialize() {
    const environment = this.config.prepareEnvironment ? await this.config.prepareEnvironment(this.cwd) : process.env;
    this.process = startProcess(this.executable, this.config.args, this.cwd, { ...environment, ...this.config.environment });
    this.processEnded = new Promise(resolve => this.process.once('close', resolve));
    this.process.stderr.on('data', () => {});
    this.process.once('error', error => this.close(error));
    this.process.once('close', () => this.close(new Error(`${this.config.name} 已退出，请检查 ACP 启动参数、版本和登录状态。`)));
    const app = acpClient({ name: 'VeryMath' })
      .onRequest('session/request_permission', ({ params }) => {
        if (!this.active || this.active.signal.aborted || params.sessionId !== this.active.session?.sessionId) return { outcome: { outcome: 'cancelled' } };
        // 仅回应本次课程任务的单次工具请求，不改变 Agent 的长期权限设置。
        const option = params.options.find(item => item.kind === 'allow_once');
        return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
      });
    this.connection = app.connect(ndJsonStream(Writable.toWeb(this.process.stdin), Readable.toWeb(this.process.stdout)));
    void this.connection.closed.then(() => this.close(new Error(`${this.config.name} 的 ACP 连接已关闭，请重新连接。`)));
    this.agent = this.connection.agent;
    const result = await this.wait(this.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'verymath', title: 'VeryMath智慧教材', version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }));
    if (result.protocolVersion !== PROTOCOL_VERSION) throw new Error('该 Agent 的 ACP 协议版本暂不兼容，请更新 Agent 或使用自定义命令行接入。');
    this.capabilities = result.agentCapabilities || {};
    this.authMethods = result.authMethods || [];
    this.agentName = result.agentInfo?.title || result.agentInfo?.name || this.config.name;
  }

  async wait(promise, milliseconds = 30000, signal) {
    const signals = [this.connection.signal, signal].filter(Boolean);
    let timer;
    let rejectWait;
    const interrupted = new Promise((_, reject) => { rejectWait = reject; });
    const abort = () => rejectWait(signals.find(item => item.aborted)?.reason || new Error('Agent 连接已中断。'));
    for (const item of signals) {
      item.addEventListener('abort', abort, { once: true });
      if (item.aborted) abort();
    }
    if (milliseconds) timer = setTimeout(() => {
      const error = new Error(`${this.config.name} 响应超时，请检查启动参数和登录状态。`);
      rejectWait(error);
      this.close(error);
    }, milliseconds);
    try { return await Promise.race([promise, interrupted]); }
    finally { clearTimeout(timer); for (const item of signals) item.removeEventListener('abort', abort); }
  }

  readModels(session) {
    this.modelOption = session.configOptions?.find(option => option.category === 'model' && option.type === 'select');
    this.legacyModels = session.models;
    this.models = this.modelOption
      ? optionsList(this.modelOption.options).map(option => ({ id: option.value, name: option.name || option.value, isDefault: option.value === this.modelOption.currentValue }))
      : (session.models?.availableModels || []).map(model => ({ id: model.modelId, name: model.name || model.modelId, isDefault: model.modelId === session.models.currentModelId }));
  }

  async release(session) {
    if (!session) return;
    session.dispose();
    if (!this.closed && this.capabilities.sessionCapabilities?.close) {
      await this.wait(this.agent.request('session/close', { sessionId: session.sessionId }), 5000).catch(() => {});
    }
  }

  async getInfo() {
    if (this.authError) throw new Error(this.authError);
    if (!this.ready && !this.authTask) {
      let session;
      try {
        session = await this.wait(this.agent.buildSession({ cwd: this.cwd, mcpServers: [] }).start());
        this.readModels(session.newSessionResponse);
        this.ready = true;
      } catch (error) {
        if (error.code !== -32000) throw error;
      } finally { await this.release(session); }
    }
    return {
      ready: this.ready && !this.closed, signedIn: this.ready, models: this.models,
      authMethods: (this.authMethods || []).map(({ id, name }) => ({ id, name })),
      accountLabel: this.ready ? `${this.agentName} 已接受会话；使用它已有的登录或模型配置` : '',
      modelInput: 'select',
      modelNote: this.models.length ? '模型列表由 Agent 的 ACP 会话返回。' : 'Agent 未提供模型列表，请跟随原设置，或在 Agent 自身配置和启动参数中选择模型。',
    };
  }

  async startLogin(methodId) {
    const quote = value => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
    const command = this.config.loginCommand || [this.executable, ...(this.config.loginArgs || [])];
    const prefix = process.platform === 'win32'
      ? `${process.env.ELECTRON_RUN_AS_NODE === '1' && command[0] === process.execPath ? "$env:ELECTRON_RUN_AS_NODE='1'; " : ''}& ` : '';
    this.login = { loginId: 'acp-login', manual: true, command: prefix + command.map(quote).join(' ') };
    this.authError = '';
    if (methodId) {
      if (!this.authMethods.some(method => method.id === methodId)) throw new Error('请选择 Agent 提供的认证方式。');
      this.authTask = this.wait(this.agent.request('authenticate', { methodId }), 0).then(() => {
        this.ready = false; this.login = undefined; this.authTask = undefined;
      }, error => {
        if (!this.closed) this.authError = `Agent 认证未完成：${error.message}。可在本机终端登录后重新连接。`;
        this.authTask = undefined;
      });
    }
    return this.login;
  }
  async cancelLogin() { this.login = undefined; this.authError = ''; if (this.authTask) this.close(); }

  close(error) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.login = undefined;
    this.connection?.close(error);
    stopProcess(this.process);
    if (error) this.emit('closed', error);
  }

  async *runCourse({ instructions, prompt, model, courseDir, outputsDir }, signal) {
    signal.throwIfAborted();
    const active = { signal, session: undefined };
    this.active = active;
    let timer;
    let stopped = false;
    const cancel = () => {
      if (active.session) void this.agent.notify('session/cancel', { sessionId: active.session.sessionId }).catch(() => {});
      timer ||= setTimeout(() => this.close(new Error('任务已停止，请重新连接 Agent。')), 2000);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const cwd = this.config.workspace === 'outputs' ? outputsDir : courseDir;
      yield { type: 'progress', message: `正在为本次任务创建 ${this.config.name} 会话…` };
      active.session = await this.wait(this.agent.buildSession({ cwd, mcpServers: [] }).start(), 30000, signal);
      signal.throwIfAborted();
      const sessionId = active.session.sessionId;
      this.readModels(active.session.newSessionResponse);
      if (model) {
        if (this.models.length && !this.models.some(item => item.id === model)) throw new Error(`该 Agent 当前不提供模型“${model}”，请重新选择或跟随 Agent 设置。`);
        if (this.modelOption) await this.wait(this.agent.request('session/set_config_option', { sessionId, configId: this.modelOption.id, value: model }));
        else if (this.legacyModels) await this.wait(this.agent.request('session/set_model', { sessionId, modelId: model }));
        else throw new Error('该 Agent 没有提供切换模型的接口，请将模型留空，并在 Agent 自身的配置或启动参数中选择。');
      }
      yield { type: 'progress', message: `会话已就绪，等待 ${this.config.name} 回复…` };
      void active.session.prompt(`${instructions}\n\n${prompt}`).catch(() => {});
      let wroteText = false;
      let separateText = false;
      let thinking = false;
      while (true) {
        const message = await this.wait(active.session.nextUpdate(), 0, signal);
        if (message.kind === 'stop') stopped = true;
        signal.throwIfAborted();
        if (message.kind === 'stop') {
          if (message.stopReason !== 'end_turn') throw new Error(`${this.config.name} 尚未完成回答（${message.stopReason}），可以调整要求后继续。`);
          if (!wroteText) throw new Error(`${this.config.name} 结束了任务，但没有返回正文。`);
          yield { type: 'done' };
          return;
        }
        const update = message.update;
        if (update.sessionUpdate === 'agent_thought_chunk' && !thinking) {
          thinking = true;
          yield { type: 'progress', message: `${this.config.name} 正在分析课程要求…` };
        }
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          if (separateText) yield { type: 'text', content: '\n\n' };
          yield { type: 'text', content: update.content.text };
          wroteText ||= !!update.content.text.trim();
          separateText = false;
          thinking = false;
        }
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          separateText = wroteText;
          yield { type: 'progress', message: update.title || `${this.config.name} 正在处理课程文件…` };
        }
        if (update.sessionUpdate === 'config_option_update') this.readModels({ configOptions: update.configOptions, models: this.legacyModels });
      }
    } catch (error) {
      if (error.code === -32000) this.ready = false;
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (!stopped && !this.closed) {
        if (active.session) void this.agent.notify('session/cancel', { sessionId: active.session.sessionId }).catch(() => {});
        this.close();
      }
      await this.release(active.session);
      // The course saver restores historical files after this iterator returns.
      // Session cancellation/connection shutdown alone is not proof that the
      // owned Agent and its file commands have physically stopped writing.
      if (this.closed) await this.processEnded;
      this.active = undefined;
    }
  }
}
