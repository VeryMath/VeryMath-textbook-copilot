import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Eye, EyeOff, LoaderCircle, RefreshCw, Key, Plug } from 'lucide-react';
import { configureProvider, getAgentStatus, listModels, saveAgentConfig, type AgentProvider, type AgentStatus } from '../lib/skill-client';

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
  const [provider, setProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [modelDraft, setModelDraft] = useState('');
  const [models, setModels] = useState<{ id: string; name: string; isDefault: boolean }[]>([]);
  const [showKey, setShowKey] = useState(false);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const initialized = useRef(false);
  const locked = !!working || busy || !!status?.busy;
  const connected = !!status?.connected && provider === status.config.provider;
  const configured = status?.skills.filter(skill => skill.configured).length || 0;

  useEffect(() => {
    if (!status || initialized.current) return;
    initialized.current = true;
    setProvider(status.config.provider || '');
    setModelDraft(status.config.model || '');
    setPaths(Object.fromEntries(status.skills.map(skill => [skill.id, skill.path || ''])));
  }, [status]);

  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    getAgentStatus(abort.signal).then(onChange).catch(err => {
      if (!abort.signal.aborted) setError(err.message);
    });
    return () => abort.abort();
  }, [active, onChange]);

  useEffect(() => {
    let cancelled = false;
    if (provider && connected) {
      setModels(status?.models || []);
      listModels(provider).then(value => { if (!cancelled) setModels(value); }).catch(() => { if (!cancelled) setModels([]); });
    } else {
      setModels([]);
    }
    return () => { cancelled = true; };
  }, [provider, connected, status?.models]);

  async function perform(label: string, action: () => Promise<AgentStatus>, message = '') {
    if (locked) return null;
    setWorking(label); setError(''); setNotice('');
    try {
      const next = await action();
      onChange(next); setNotice(message);
      return next;
    }
    catch (err) {
      setError(err instanceof Error ? err.message : '操作未完成，请重试。');
      getAgentStatus().then(onChange).catch(() => {});
      return null;
    } finally { setWorking(''); }
  }

  function changeProvider(next: AgentProvider) {
    setProvider(next); setApiKey(''); setBaseUrl(''); setShowKey(false);
    setModelDraft(next === status?.config.provider ? status.config.model || '' : '');
    setModels([]); setError(''); setNotice('');
  }

  async function saveProvider() {
    if (!provider) return;
    const saved = await perform('保存配置', () => configureProvider({ provider, ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}), ...(provider === 'custom' && modelDraft ? { model: modelDraft } : {}) }), '配置已保存。');
    if (saved) { setApiKey(''); setShowKey(false); setModelDraft(saved.config.model || ''); }
  }

  const step = connected ? 3 : provider ? 2 : 1;

  return <div className="agent-setup">
    <ol className="connection-steps" aria-label="Agent 配置步骤">
      {['选择模型服务', '填写 API Key', '开始使用'].map((label, index) => <li key={label} className={step >= index + 1 ? 'current' : ''}>
        <span>{step > index + 1 || connected ? <Check size={12}/> : index + 1}</span>{label}
      </li>)}
    </ol>

    <label className="agent-field agent-choice">模型服务 Provider
      <select aria-label="Provider" value={provider} disabled={locked || !status} onChange={event => changeProvider(event.target.value)}>
        {!status && <option value="">正在读取…</option>}
        {status?.providers.filter(p => p.id !== 'custom').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        <option value="custom">自定义 API（OpenAI 兼容）</option>
      </select>
      <small>选择 LLM 服务商，或选"自定义 API"填入任意 OpenAI 兼容端点。</small>
    </label>

    <section className={`agent-card ${connected ? 'is-connected' : ''}`} aria-label="模型配置">
      <div className="agent-card-heading">
        <span className="agent-icon"><Key size={22}/></span>
        <div><h3>{status?.providers.find(item => item.id === provider)?.name || provider || '未选择'}</h3><p>直连 LLM API · 无需安装</p></div>
        <span className={`agent-phase ${connected ? 'ready' : ''}`}><span className={`status-dot ${connected ? 'online' : ''}`}/>{connected ? '已配置' : '待配置'}</span>
      </div>
      <p className="agent-description">{provider === status?.config.provider ? status.message : status ? '填写所选模型服务的配置，然后保存并连接。' : '正在读取配置…'}</p>

      {connected && <div className="agent-account"><Check size={14}/><span>API Key 已保存</span></div>}

      <label className="agent-field">API Key
        <span className="agent-model-input">
          <input type={showKey ? 'text' : 'password'} aria-label="API Key" value={apiKey} disabled={locked} onChange={event => setApiKey(event.target.value)} placeholder="sk-..." autoComplete="off" spellCheck={false}/>
          <button type="button" className="text-button" onClick={() => setShowKey(v => !v)} aria-label={showKey ? '隐藏' : '显示'}>{showKey ? <EyeOff size={15}/> : <Eye size={15}/>}</button>
        </span>
        <small>从模型服务商获取 API Key，保存在本机 agent 目录中。</small>
      </label>

      <label className="agent-field">Base URL{provider === 'custom' ? '' : '（可选）'}
        <input aria-label="Base URL" value={baseUrl} disabled={locked} onChange={event => setBaseUrl(event.target.value)} placeholder={provider === 'custom' ? 'https://api.example.com/v1' : '留空使用默认端点'} autoComplete="off" spellCheck={false}/>
        <small>{provider === 'custom' ? 'OpenAI 兼容 API 的完整端点地址。' : '使用自定义端点或代理时填写。'}</small>
      </label>

      {provider === 'custom' ? <label className="agent-field">模型名称
        <input aria-label="模型名称" value={modelDraft} disabled={locked} onChange={event => setModelDraft(event.target.value)} placeholder="gpt-4o / deepseek-chat / ..." autoComplete="off" spellCheck={false}/>
        <small>填入 API 支持的模型 ID，保存后生效。</small>
      </label> : <label className="agent-field">使用模型
        <select aria-label="使用模型" value={modelDraft} disabled={locked || !connected} onChange={event => { setModelDraft(event.target.value); void perform('保存模型', () => saveAgentConfig({ model: event.target.value }), '模型已保存。'); }}>
          <option value="">跟随默认</option>
          {models.map(m => <option key={m.id} value={m.id}>{m.name}{m.isDefault ? ' · 默认' : ''}</option>)}
        </select>
        <small>{connected ? status?.modelNote || '选择模型后即可提问。' : '配置 API Key 后可选择模型。'}</small>
      </label>}

      <div className="agent-vision-note">
        <p>读取教材截图、扫描页和图表，需要模型支持图片输入。</p>
      </div>

      <div className="agent-actions">
        <button className="primary-button" disabled={locked || !provider} onClick={() => void saveProvider()}>
          {working === '保存配置' ? <LoaderCircle size={16} className="spin"/> : <Plug size={16}/>}保存并连接
        </button>
        <button className="agent-refresh" disabled={locked} onClick={() => void perform('刷新', () => getAgentStatus(), '状态已更新。')}>
          <RefreshCw size={14} className={working === '刷新' ? 'spin' : ''}/>刷新状态
        </button>
      </div>
    </section>

    {error && <p className="agent-feedback error" role="alert">{error}</p>}
    {notice && <p className="agent-feedback" role="status">{notice}</p>}
    {busy && <p className="agent-feedback">当前任务结束后，可以更改配置。</p>}

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
      <button className="secondary-button" disabled={locked || !status} onClick={() => void perform('保存 Skill', () => saveAgentConfig({ skillPaths: paths }), 'Skill 路径已保存。')}>
        {working === '保存 Skill' ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>}保存 Skill 路径
      </button>
    </details>
    <p className="agent-footnote">问答、文件处理和 Skill 调用由内置 Agent 执行。API Key 保存在本机，不经过第三方中转。</p>
  </div>;
}
