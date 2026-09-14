import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ExternalLink, LoaderCircle, Plug, RefreshCw, Unplug } from 'lucide-react';
import { cancelAgentLogin, connectAgent, disconnectAgent, getAgentStatus, saveAgentConfig, startAgentLogin, type AgentProvider, type AgentStatus, type AgentConnectionMode } from '../lib/skill-client';

interface Props {
  status: AgentStatus | null;
  active: boolean;
  busy: boolean;
  onChange: (status: AgentStatus) => void;
}

const groups = [
  { name: '讲解与问答', owner: '同学 A', ids: ['textbook-parse', 'explain', 'quiz'] },
  { name: '知识结构', owner: '同学 B', ids: ['mindmap', 'knowledge-graph'] },
  { name: '课件与视频', owner: '同学 C', ids: ['slides', 'video'] },
];

export default function AgentConnection({ status, active, busy, onChange }: Props) {
  const [executable, setExecutable] = useState('');
  const [argumentsText, setArgumentsText] = useState('');
  const [modelFlag, setModelFlag] = useState('--model');
  const [modelDraft, setModelDraft] = useState('');
  const [authMethod, setAuthMethod] = useState('');
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const initialized = useRef(false);
  const locked = !!working || busy || !!status?.busy;
  const agentName = status?.name || 'Agent';
  const provider = status?.config.provider;
  const mode = status?.config.mode || 'acp';
  const extended = mode !== 'native';
  const commandAgent = mode === 'cli';
  const savedArguments = status?.config.args?.join('\n') || '';
  const presetCommand = status?.defaultCommand || '';

  useEffect(() => {
    if (!status || initialized.current) return;
    initialized.current = true;
    setPaths(Object.fromEntries(status.skills.map(skill => [skill.id, skill.path || ''])));
  }, [status]);

  useEffect(() => {
    setExecutable(status?.config.executable || '');
  }, [provider, mode, status?.config.executable]);

  useEffect(() => { setArgumentsText(savedArguments); setModelFlag(status?.config.modelFlag ?? '--model'); }, [provider, mode, savedArguments, status?.config.modelFlag]);
  useEffect(() => { setModelDraft(status?.config.model || ''); }, [provider, mode, status?.config.model]);
  useEffect(() => { setAuthMethod(status?.authMethods?.[0]?.id || ''); }, [provider, mode, status?.authMethods?.[0]?.id]);

  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    getAgentStatus(abort.signal).then(onChange).catch(error => {
      if (!abort.signal.aborted) setError(error.message);
    });
    return () => abort.abort();
  }, [active, onChange]);

  useEffect(() => {
    if (!active || (!status?.login && !status?.busy)) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { onChange(await getAgentStatus(abort.signal)); }
      catch (error) { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : '暂时无法读取登录状态。'); }
      if (!abort.signal.aborted) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 1500);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [active, status?.login?.loginId, status?.busy, onChange]);

  async function perform(label: string, action: () => Promise<AgentStatus>, message = '') {
    if (locked) return;
    setWorking(label); setError(''); setNotice('');
    try { onChange(await action()); setNotice(message); }
    catch (error) {
      setError(error instanceof Error ? error.message : '操作未完成，请重试。');
      getAgentStatus().then(onChange).catch(() => {});
    } finally { setWorking(''); }
  }

  const connected = !!status?.connected;
  const installed = !!status?.installed;
  const configured = status?.skills.filter(skill => skill.configured).length || 0;
  const phaseLabel = working === '连接' ? '正在连接' : status?.phase === 'error' ? '连接异常' : connected ? commandAgent ? '已配置' : '已连接' : installed ? '等待登录' : '待连接';
  const step = connected ? 3 : installed ? 2 : 1;

  return <div className="agent-setup">
    <ol className="connection-steps" aria-label="Agent 连接步骤">
      {['选择 Agent', '连接与登录', '开始使用'].map((label, index) => <li key={label} className={step >= index + 1 ? 'current' : ''}>
        <span>{step > index + 1 || connected ? <Check size={12}/> : index + 1}</span>{label}
      </li>)}
    </ol>

    <label className="agent-field agent-choice">Coding Agent
      <select aria-label="Coding Agent" value={provider || ''} disabled={locked || !status} onChange={event => {
        const provider = event.target.value as AgentProvider;
        void perform('切换 Agent', () => saveAgentConfig({ provider }), '已切换 Agent，点击连接即可使用。');
      }}>
        {!status && <option value="">正在读取…</option>}
        {status?.providers.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select>
      <small>使用本机已有账号，选择 Agent 后连接即可。</small>
    </label>

    <section className={`agent-card ${connected ? 'is-connected' : ''}`} aria-label={`${agentName} 连接`}>
      <div className="agent-card-heading">
        <span className="agent-icon"><Plug size={22}/></span>
        <div><h3>{agentName}</h3><p>本机运行 · 使用已有账号</p></div>
        <span className={`agent-phase ${connected ? 'ready' : ''}`}><span className={`status-dot ${connected ? 'online' : ''}`}/>{phaseLabel}</span>
      </div>
      <p className="agent-description">{working === '连接' ? `正在查找可用的 ${agentName}，并读取配置…` : status?.message || '正在读取连接设置…'}</p>

      {installed && <div className="agent-account"><Check size={14}/><span>{status?.accountLabel || '程序已连接，账号尚未登录'}</span></div>}

      <label className="agent-field">使用模型
        {status?.modelInput === 'manual' ? <span className="agent-model-input"><input aria-label="使用模型" value={modelDraft} disabled={locked || !connected} onChange={event => setModelDraft(event.target.value)} placeholder="留空跟随 Agent 设置" spellCheck={false}/><button type="button" className="text-button" disabled={locked || !connected || modelDraft === status.config.model} onClick={() => void perform('保存模型', () => saveAgentConfig({model:modelDraft.trim()}), '模型已保存，下次提问时生效。')}>保存</button></span> : <select aria-label="使用模型" value={status?.config.model || ''} disabled={locked || !connected} onChange={event => { const model = event.target.value; void perform('保存模型', () => saveAgentConfig({ model }), '模型已保存，下次提问时生效。'); }}>
          <option value="">跟随 {agentName} 设置</option>
          {status?.config.model && !status.models.some(model => model.id === status.config.model) && <option value={status.config.model} disabled>{status.config.model}{connected ? ' · 当前不可用，请重新选择' : ' · 已保存'}</option>}
          {status?.models.map(model => <option key={model.id} value={model.id}>{model.name}{model.isDefault ? ' · 默认' : ''}</option>)}
        </select>}
        <small>{connected ? status?.modelNote || `读取 ${agentName} 的模型配置。` : '连接后可以选择模型。'}</small>
      </label>

      <div className="agent-vision-note">
        <p>读取教材截图、扫描页和图表，需要模型、API 服务和 Agent 均支持图片输入；连接成功不代表已验证看图能力。</p>
        {provider === 'opencode' && <details>
          <summary>OpenCode 无法看图时如何配置？</summary>
          <p>若模型和 API 本身支持图片，请检查 OpenCode 对应模型的输入能力声明。在已有的 provider → 服务名称 → models → 模型名称下合并以下字段：</p>
          <pre><code>{JSON.stringify({modalities:{input:['text','image'],output:['text']}},null,2)}</code></pre>
          <p>保留原来的服务地址、凭据、其他参数及已支持的输入类型。修改后，在这里断开并重新连接 OpenCode，再用一张真实图片确认。这个声明不会让纯文本模型获得看图能力。</p>
        </details>}
      </div>

      {installed && !connected && !status?.login && !!status?.authMethods?.length && <label className="agent-field">认证方式
        <select aria-label="Agent 认证方式" value={authMethod} disabled={locked} onChange={event => setAuthMethod(event.target.value)}>{status.authMethods.map(method => <option key={method.id} value={method.id}>{method.name}</option>)}</select>
        <small>由 Agent 处理认证，也可以先在本机终端登录后重新连接。</small>
      </label>}
      <div className="agent-actions">
        {!installed && <button className="primary-button" disabled={locked || !status} onClick={() => void perform('连接', () => connectAgent({mode, executable, ...(extended ? {args: argumentsText.split('\n').filter(line => line.trim()), ...(commandAgent ? {modelFlag} : {})} : {})}))}>
          {working === '连接' ? <LoaderCircle size={16} className="spin"/> : <Plug size={16}/>}{working === '连接' ? '正在连接…' : `连接本机 ${agentName}`}
        </button>}
        {installed && !connected && !status?.signedIn && !status?.login && <button className="primary-button" disabled={locked} onClick={() => void perform('登录', () => startAgentLogin(authMethod || undefined))}>
          {working === '登录' ? <LoaderCircle size={16} className="spin"/> : <ExternalLink size={16}/>}{mode === 'native' && provider === 'codex' ? '使用 ChatGPT 登录' : mode === 'native' && provider === 'claude' ? '登录 Claude Code' : status?.authMethods?.length ? '开始登录' : '查看登录方式'}
        </button>}
        {installed && <button className="secondary-button" disabled={locked} onClick={() => void perform('断开', disconnectAgent, `${agentName} 已断开，账号配置仍保留。`)}><Unplug size={15}/>断开连接</button>}
        <button className="agent-refresh" disabled={locked} onClick={() => void perform('刷新', () => getAgentStatus(), '连接状态已更新。')}>
          <RefreshCw size={14} className={working === '刷新' ? 'spin' : ''}/>刷新状态
        </button>
      </div>
      {status?.login && <div className="agent-login" role="status">
        <strong>{status.login.authUrl ? '在浏览器完成登录' : `完成 ${agentName} 配置`}</strong>
        <p>{status.login.authUrl ? '打开登录页面，完成后这里会自动更新。' : status.login.command ? '在部署电脑的终端运行下方命令，按 Agent 的提示完成登录，然后刷新状态；若仍未更新，请断开后重新连接。' : '先按该 Agent 的说明，在部署电脑的终端中完成登录和模型配置，再重新连接。'}</p>
        {status.login.authUrl && <a className="primary-button" href={status.login.authUrl} target="_blank" rel="noreferrer">打开登录页面<ExternalLink size={14}/></a>}
        {!status.login.authUrl && status.login.command && <code className="agent-login-command">{status.login.command}</code>}
        <button className="agent-refresh" disabled={locked} onClick={() => void perform('取消登录', cancelAgentLogin)}>{status.login.manual ? '关闭提示' : '取消登录'}</button>
      </div>}
    </section>

    {error && <p className="agent-feedback error" role="alert">{error}</p>}
    {notice && <p className="agent-feedback" role="status">{notice}</p>}
    {busy && <p className="agent-feedback">当前任务结束后，可以更改连接设置。</p>}

    <details className="agent-details agent-advanced" key={provider} open={provider === 'custom' ? true : undefined}>
      <summary>高级设置<span>程序与兼容选项</span><ChevronDown size={15}/></summary>
      {status && (status.connectionModes?.length ?? 0) > 1 && <label className="agent-field">连接方式
        <select aria-label="Agent 连接方式" value={mode} disabled={locked} onChange={event => {
          const mode = event.target.value as AgentConnectionMode;
          void perform('切换连接方式', () => saveAgentConfig({mode}), '连接方式已切换，点击连接即可使用。');
        }}>{status.connectionModes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <small>默认使用 ACP。切换到兼容方式会保留各自的程序和模型设置。</small>
      </label>}
      <label className="agent-field">Agent 程序
        <input aria-label="Agent 程序" value={executable} disabled={locked || installed} onChange={event => setExecutable(event.target.value)} placeholder={status?.bundledAdapter ? '留空使用项目自带的适配器' : presetCommand ? `留空自动查找 ${presetCommand}` : '命令名或程序完整路径'} autoComplete="off" spellCheck={false}/>
        <small>{status?.bundledAdapter ? '适配器随项目安装，通常不需要指定程序位置。' : commandAgent ? '使用接收要求、输出纯文本并自行退出的非交互命令。' : mode === 'native' ? '使用该 Agent 的原生程序，通常无需修改。' : '通常使用默认程序；自定义程序需支持 ACP。'}</small>
      </label>
      {extended && <label className="agent-field">启动参数 · 每行一个
        <textarea aria-label="Agent 启动参数" value={argumentsText} disabled={locked || installed} onChange={event => setArgumentsText(event.target.value)} rows={3} spellCheck={false} placeholder={commandAgent ? '--print\n{prompt}' : '使用默认参数或留空'}/>
        <small>参数原样传给程序，无须添加外层引号。{commandAgent ? ' {prompt} 传入要求，{promptFile} 传入要求文件路径；都不用时通过标准输入传入。' : ''}</small>
      </label>}
      {commandAgent && <label className="agent-field">模型参数
        <input aria-label="Agent 模型参数" value={modelFlag} disabled={locked || installed} onChange={event => setModelFlag(event.target.value)} placeholder="--model" spellCheck={false}/>
        <small>只有填写了“使用模型”才会传入；不支持时留空。</small>
      </label>}
      {installed && <p>正在使用：<code>{status?.executable}</code></p>}
      {status?.note && <p>{status.note}</p>}
    </details>

    <details className="agent-details">
      <summary>课件编译环境<span>{status?.latex?.ready ? '依赖已找到' : '需要检查'}</span><ChevronDown size={15}/></summary>
      <p>{status?.latex?.message || '刷新状态以检查课件编译环境。'}</p>
      {status?.latex?.engine && <p>XeLaTeX：<code>{status.latex.engine}</code></p>}
      {status?.latex?.version && <p>{status.latex.version}</p>}
      {status?.latex && <p>{status.latex.preferredMathFonts ? '数学字体：Computer Modern 与 AMS Fonts。' : '数学字体将在生成时按编译环境检查并选择。'}</p>}
      <button className="agent-refresh" disabled={locked} onClick={() => void perform('检查课件环境', () => getAgentStatus(), '课件编译环境已检查。')}><RefreshCw size={14}/>重新检查</button>
    </details>

    <details className="agent-details skill-paths">
      <summary>接入 Skill<span>{configured} / {status?.skills.length ?? groups.reduce((total, group) => total + group.ids.length, 0)} 已配置</span><ChevronDown size={15}/></summary>
      {groups.map(group => <fieldset key={group.name} disabled={locked}>
        <legend>{group.name}<span>{group.owner}</span></legend>
        {group.ids.map(id => {
          const skill = status?.skills.find(item => item.id === id);
          return <label className="agent-field" key={id}><span>{skill?.title || id}<small>{skill?.configured ? '已配置' : '待配置'}</small></span>
            <input value={paths[id] || ''} onChange={event => setPaths(previous => ({ ...previous, [id]: event.target.value }))} placeholder="/你的 Skill 文件夹/SKILL.md" autoComplete="off" spellCheck={false}/>
          </label>;
        })}
      </fieldset>)}
      <button className="secondary-button" disabled={locked || !status} onClick={() => void perform('保存 Skill', () => saveAgentConfig({ skillPaths: paths }), 'Skill 路径已保存。连接 Agent 后即可调用。')}>
        {working === '保存 Skill' ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>}保存 Skill 路径
      </button>
    </details>
    <p className="agent-footnote">问答、文件处理和 Skill 调用由所选 Agent 执行，页面展示进度与结果。每个人使用自己的 Agent 账号与个人数据目录。</p>
  </div>;
}
