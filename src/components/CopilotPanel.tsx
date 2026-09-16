import { useEffect, useRef, useState } from 'react';
import { ArrowUp, BookOpen, Check, ChevronDown, ClipboardList, CornerDownLeft, FileSliders, FileText, MessageCircle, Network, Plus, Quote, Sparkles, Square, Video, Waypoints, X, ArrowUpRight, AlertCircle, History } from 'lucide-react';
import type { Artifact, Book, Chapter, CourseReference, KnowledgeGraphDetail, Message, PageRange, Scope, SkillId, SkillInfo } from '../lib/types';
import Markdown from './Markdown';
import './slide-template-picker.css';
import './scope-picker.css';
import TaskProgress from './TaskProgress';
import { pageRangeError } from '../../shared/page-range.mjs';

const tools = [
  { id: 'textbook-parse', title: '教材解析', subtitle: '提取正文公式与图片', icon: FileText, prompt: '请解析所选范围的教材，提取正文、LaTeX 公式、图片和目录，保留对应的 PDF 页码，并保存为学习资料。' },
  { id: 'explain', title: '讲解内容', subtitle: '把难点讲明白', icon: BookOpen, prompt: '请讲解当前内容，先给出直观理解，再展开关键步骤。' },
  { id: 'quiz', title: '知识点出题', subtitle: '围绕知识点练一练', icon: ClipboardList, prompt: '请围绕当前知识点生成由浅入深的练习题，保存为逐题练习卡片，答案先隐藏，提供渐进提示、参考答案和解析。' },
  { id: 'mindmap', title: '思维导图', subtitle: '梳理章节脉络', icon: Waypoints, prompt: '请将当前内容整理为层次清晰的思维导图。' },
  { id: 'knowledge-graph', title: '知识图谱', subtitle: '发现知识间的联系', icon: Network, prompt: '请梳理当前内容中的知识点，以及它们之间的关系。' },
  { id: 'slides', title: '生成课件', subtitle: '把知识变成课件', icon: FileSliders, prompt: '请根据当前内容生成适合课堂讲解的课件。' },
  { id: 'video', title: '讲解视频', subtitle: '跟着讲解学一遍', icon: Video, prompt: '请为当前内容生成讲解视频。' },
  { id: 'chat', title: '自由问答', subtitle: '聊聊你的疑问', icon: MessageCircle, prompt: '' },
] as const;

interface Props {
  references: CourseReference[]; referenceQuestionId: number; onRemoveReference: (id: string) => void;
  book: Book; page: number; chapter?: Chapter; selectedText: string; onClearSelection: () => void; onShowTextbook: () => void;
  contextArtifact?: Artifact; onClearArtifact: () => void;
  skills: SkillInfo[]; messages: Message[]; busy: boolean; running: boolean; onSend: (id: SkillId, prompt: string, scope: Scope, knowledgeGraphDetail?: KnowledgeGraphDetail, templateId?: string, pageRange?: PageRange) => void;
  onStop: () => void; onReset: () => void; onHistory: () => void; onArtifact: (artifact: Artifact) => void; onSettings: () => void;
}

export default function CopilotPanel(props: Props) {
  const { book, page, chapter, selectedText, contextArtifact, skills, messages, busy } = props;
  const [activeSkill, setActiveSkill] = useState<SkillId>('chat');
  const [prompt, setPrompt] = useState('');
  const [scope, setScope] = useState<Scope>('page');
  const [rangeStart, setRangeStart] = useState(String(page));
  const [rangeEnd, setRangeEnd] = useState(String(page));
  const [templateId, setTemplateId] = useState('');
  const [knowledgeGraphDetail, setKnowledgeGraphDetail] = useState<KnowledgeGraphDetail>('overview');
  const [toolsOpen, setToolsOpen] = useState(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const selectedInfo = skills.find(skill => skill.id === activeSkill);
  const activeTitle = tools.find(tool => tool.id === activeSkill)?.title;
  const connectedCount = skills.filter(skill => skill.available).length;
  const currentScope = scope;
  const pageRange = { start: Number(rangeStart), end: Number(rangeEnd) };
  const rangeError = currentScope === 'range' ? pageRangeError(pageRange, book.totalPages) : '';
  const scopeError = rangeError || (currentScope === 'selection' && !selectedText ? '请先在教材上拖选文字，或改用“指定页码”。' : '');
  const textbookTask = ['slides', 'mindmap', 'knowledge-graph', 'video'].includes(activeSkill)
    || ['slides', 'mindmap', 'knowledge-graph', 'video'].includes(contextArtifact?.kind || '');

  useEffect(() => {
    if (!props.referenceQuestionId) return;
    setActiveSkill('chat'); setScope('page'); setToolsOpen(false); input.current?.focus();
  }, [props.referenceQuestionId]);

  useEffect(() => { if (selectedText) setScope('selection'); else setScope(current => current === 'selection' ? 'page' : current); }, [selectedText]);
  useEffect(() => {
    const container = conversation.current;
    if (container?.clientHeight) container.scrollTo({ top: messages.length ? container.scrollHeight : 0, behavior: 'instant' });
  }, [messages]);
  useEffect(() => {
    const container = conversation.current;
    if (!container) return;
    let wasVisible = container.clientHeight > 0;
    const observer = new ResizeObserver(() => {
      const isVisible = container.clientHeight > 0;
      if (isVisible && !wasVisible) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      wasVisible = isVisible;
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setPrompt(''); setScope('page'); setRangeStart(String(page)); setRangeEnd(String(page)); setActiveSkill('chat'); setTemplateId(''); setKnowledgeGraphDetail('overview'); setToolsOpen(true); }, [book.id]);

  function submit() {
    if (!prompt.trim() || busy || scopeError) return;
    props.onSend(activeSkill, prompt.trim(), currentScope, activeSkill === 'knowledge-graph' ? knowledgeGraphDetail : undefined, activeSkill === 'slides' ? templateId || undefined : undefined, currentScope === 'range' ? pageRange : undefined);
    setPrompt('');
    setToolsOpen(false);
  }

  return <aside className="copilot-panel" aria-label="课程 Copilot" id="course-copilot">
    <header className="copilot-header">
      <div className="copilot-title"><span className="copilot-symbol"><Sparkles size={19}/></span><span>Copilot <small>课程学习助手</small></span></div>
      <div className="context-card"><BookOpen size={15}/><div><span>正在一起阅读</span><strong>{chapter?.title || book.title}</strong></div><span className="context-page">P.{page}</span></div>
      <div className="copilot-header-actions"><button className="icon-button" title="历史对话" aria-label="历史对话" onClick={props.onHistory} disabled={busy}><History size={17}/></button><button className="icon-button" title="新建对话" aria-label="新建对话" onClick={props.onReset} disabled={busy || !messages.length}><Plus size={19}/></button></div>
    </header>

    <div className="copilot-scroll" ref={conversation}>
      <section className="tool-section" aria-label="课程工具">
        <button className="section-label tool-heading" onClick={() => setToolsOpen(!toolsOpen)} aria-expanded={toolsOpen}><span>课程工具 <small>SKILLS</small></span><ChevronDown size={15} className={toolsOpen ? '' : 'rotated'}/></button>
        {toolsOpen && <div className="skill-grid">{tools.map(tool => <button key={tool.id} className={`skill-tile ${activeSkill === tool.id ? 'selected' : ''}`} aria-pressed={activeSkill === tool.id} onClick={() => { setActiveSkill(tool.id); setPrompt(tool.prompt); input.current?.focus(); }} title={skills.find(item => item.id === tool.id)?.available ? tool.subtitle : `${tool.title}尚待接入，可以先填写要求`}>
          <span className={`tool-icon tool-${tool.id}`}><tool.icon size={18}/></span><span className="tool-copy"><strong>{tool.title}</strong><small>{tool.subtitle}</small></span>
          {!skills.find(item => item.id === tool.id)?.available && <span className="pending-dot" aria-label="待接入"/>}
        </button>)}</div>}
      </section>

      {messages.length === 0 ? <div className="copilot-welcome">
        <span className="welcome-spark"><Sparkles size={24} strokeWidth={1.5}/></span>
        <h2>带着问题，读懂这一页</h2>
        <p>选择一个学习工具，或选中教材中的内容，<br/>把你的疑问留在这里。</p>
        <div className="starter-prompts">
          <button onClick={() => { setActiveSkill('explain'); setPrompt('这部分内容的核心思想是什么？请用一个直观的例子解释。'); input.current?.focus(); }}>这部分的核心思想是什么？<ArrowUpRight size={15}/></button>
          <button onClick={() => { setActiveSkill('chat'); setPrompt('学习当前内容前，需要先掌握哪些知识？'); input.current?.focus(); }}>我需要先掌握哪些知识？<ArrowUpRight size={15}/></button>
        </div>
      </div> : <div className="messages" aria-live="polite">{messages.map(message => <article key={message.id} className={`message message-${message.role}`}>
        {message.role === 'assistant' && <div className="message-name"><Sparkles size={14}/> Copilot</div>}
        {message.references?.length ? <div className="message-references">{message.references.map(reference => <a key={reference.id} href={reference.url} target="_blank" rel="noreferrer"><FileText size={12}/>{reference.title}</a>)}</div> : null}
        {message.content && <Markdown book={book}>{message.content}</Markdown>}
        {message.status === 'running' && <TaskProgress message={message}/>}
        {(message.status === 'error' || message.status === 'stopped') && <div className="message-error"><AlertCircle size={15}/><span>{message.progress || '暂时无法完成，请稍后重试。'}</span></div>}
        {message.artifacts?.map(artifact => <button className="artifact-message" key={artifact.id} onClick={() => props.onArtifact(artifact)}><FileSliders size={18}/><span>{artifact.title}<small>点击在左侧查看</small></span><ArrowUpRight size={16}/></button>)}
        {message.status === 'done' && !message.content && !message.artifacts?.length && <div className="message-progress"><Check size={14}/>已完成</div>}
      </article>)}</div>}
    </div>

    <div className="composer-area">
      {props.references.length > 0 && <div className="composer-references" aria-label="本轮参考的教材与资料">
        <span title={book.title}>教材</span>
        {!textbookTask && <span title={props.references.map(reference => reference.title).join('\n')}>{props.references.length} 份资料</span>}
      </div>}
      {contextArtifact && <div className="selection-context artifact-context"><FileSliders size={14}/><span title={contextArtifact.title}>正在讨论：{contextArtifact.title}</span><button className="icon-button" onClick={props.onClearArtifact} aria-label="清除资料上下文"><X size={14}/></button></div>}
      {selectedText && <div className="selection-context"><Quote size={14}/><span title={selectedText}>{currentScope === 'selection' ? '本轮选文：' : '已选文字（本轮未使用）：'}{selectedText}</span><button className="icon-button" onClick={props.onClearSelection} aria-label="清除选中内容"><X size={14}/></button></div>}
      <div className="composer">
        {activeSkill === 'slides' && <label className="slide-template-picker">课件模板
          <select aria-label="课件模板" value={templateId} disabled={busy} onChange={event => setTemplateId(event.target.value)}>
            <option value="">沿用原模板 · 新建用白底深蓝</option>
            {selectedInfo?.templates?.map(template => <option key={template.id} value={template.id}>{template.title}</option>)}
          </select>
          {templateId && <small>{selectedInfo?.templates?.find(template => template.id === templateId)?.description}</small>}
        </label>}
        <div className="composer-options"><span className="active-skill"><Sparkles size={12}/>{activeTitle}</span>{activeSkill === 'knowledge-graph' && <label className="scope-picker knowledge-detail-picker" title="概览突出核心关系；详细展开范围内的概念与关系，并记录覆盖情况。"><select aria-label="知识图谱详细程度" value={knowledgeGraphDetail} onChange={event => setKnowledgeGraphDetail(event.target.value as KnowledgeGraphDetail)}><option value="overview">概览</option><option value="detailed">详细</option></select><ChevronDown size={12}/></label>}<div className="scope-tags">{([['page','当前页'],['section','当前节'],['chapter','当前章'],['range','指定页码'],['selection','选中文字'],['book','整本教材'],['none','无范围']] as const).map(([value,label]) => <button key={value} className={`scope-tag ${currentScope===value?'active':''}`} disabled={busy} onClick={()=>setScope(value)}>{label}</button>)}</div></div>
        {currentScope === 'range' && <fieldset className="page-range-picker" disabled={busy}>
          <legend>教材 PDF 页码</legend>
          <div><label>起始页<input type="number" inputMode="numeric" min="1" max={book.totalPages} step="1" aria-label="起始页" aria-invalid={Boolean(rangeError)} aria-describedby="page-range-note" value={rangeStart} onChange={event=>setRangeStart(event.target.value)}/></label><span>—</span><label>结束页<input type="number" inputMode="numeric" min="1" max={book.totalPages} step="1" aria-label="结束页" aria-invalid={Boolean(rangeError)} aria-describedby="page-range-note" value={rangeEnd} onChange={event=>setRangeEnd(event.target.value)}/></label></div>
          <p id="page-range-note" className={rangeError ? 'scope-error' : ''} role={rangeError ? 'alert' : undefined}>{rangeError || `将处理第 ${pageRange.start}–${pageRange.end} 页，共 ${pageRange.end-pageRange.start+1} 页（PDF 页序，不是书内页码）。`}</p>
        </fieldset>}
        {currentScope === 'selection' && !selectedText && <div className="selection-help"><p>在教材上拖选文字即可引用。连续多页或扫描教材，请用“指定页码”。</p><button className="text-button" onClick={props.onShowTextbook}>去教材选文字</button><button className="text-button" onClick={()=>setScope('range')}>改用指定页码</button></div>}
        {currentScope === 'page' && <p className="scope-summary">本轮范围：PDF 第 {page} 页</p>}
        {currentScope === 'none' && <p className="scope-summary">不附加教材上下文，直接对话。</p>}
        <textarea ref={input} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={activeSkill === 'chat' ? '关于这本教材，你想了解什么？' : '补充你的要求…'} aria-label="向 Copilot 输入要求" rows={3} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}/>
        <div className="composer-bottom"><span><CornerDownLeft size={12}/> 发送 <i>·</i> Shift + Enter 换行</span>{props.running ? <button className="send-button" onClick={props.onStop} aria-label="停止任务"><Square size={15} fill="currentColor"/></button> : <button className="send-button" onClick={submit} disabled={busy || !prompt.trim() || Boolean(scopeError)} aria-label="发送要求" title={selectedInfo?.available ? '发送要求' : '此功能尚待接入'}><ArrowUp size={19}/></button>}</div>
      </div>
      <button className="connection-note" onClick={props.onSettings}><span className={`status-dot ${connectedCount ? 'online' : ''}`}/>{connectedCount ? `${connectedCount} 个工具已连接` : '学习工具待接入'}<span>查看连接<ArrowUpRight size={11}/></span></button>
    </div>
  </aside>;
}
