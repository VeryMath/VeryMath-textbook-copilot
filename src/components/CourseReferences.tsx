import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, ExternalLink, FileText, LoaderCircle, Pencil, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react';
import { deleteReference, extractReferenceText, listReferences, searchReferences, updateReference, uploadReference } from '../lib/storage';
import type { Book, CourseReference, ReferenceSearchResult } from '../lib/types';
import './course-references.css';

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';

export default function CourseReferences({ book, busy, onWorkingChange, selected, onSelect, onAsk }: {
  book: Book; busy: boolean; onWorkingChange: (working: boolean) => void;
  selected: CourseReference[]; onSelect: (items: CourseReference[]) => void; onAsk: () => void;
}) {
  const [items, setItems] = useState<CourseReference[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [result, setResult] = useState<ReferenceSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const operation = useRef(false);
  const disabled = busy || working || loading;
  const extracting = items.some(item => ['queued', 'processing'].includes(item.textIndex?.status || ''));

  useEffect(() => {
    if (!extracting) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void listReferences(book.id, controller.signal).then(setItems).catch(error => {
        if (!controller.signal.aborted) setError(message(error));
      });
    }, 1500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [book.id, extracting]);

  useEffect(() => {
    if (!searchQuery) { setResult(null); setSearching(false); setSearchError(''); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setSearching(true); setSearchError(''); setResult(null);
    const run = async () => {
      try {
        const data = await searchReferences(book.id, searchQuery, controller.signal);
        if (controller.signal.aborted) return;
        setResult(data);
        setItems(await listReferences(book.id, controller.signal));
        if (data.indexing) timer = setTimeout(run, 1500);
      } catch (error) { if (!controller.signal.aborted) setSearchError(message(error)); }
      finally { if (!controller.signal.aborted) setSearching(false); }
    };
    void run();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [book.id, searchQuery, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    listReferences(book.id, controller.signal).then(setItems).catch(error => {
      if (!controller.signal.aborted) setError(message(error));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [book.id, refresh]);

  function begin() {
    if (disabled || operation.current) return false;
    operation.current = true; setWorking(true); onWorkingChange(true); setError(''); setNotice('');
    return true;
  }
  function finish() { operation.current = false; setWorking(false); onWorkingChange(false); }

  async function upload(files: File[]) {
    if (!files.length || !begin()) return;
    const failures: string[] = [];
    let saved = 0;
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        setNotice(`正在上传 ${index + 1}/${files.length}：${file.name}`);
        try {
          const reference = await uploadReference(book.id, file);
          setItems(current => [...current, reference]); saved++;
        } catch (error) { failures.push(`${file.name}：${message(error)}`); }
      }
      setNotice(`已添加 ${saved} 份辅助资料。`);
      setError(failures.join('\n'));
      setRefresh(value => value + 1);
    } finally { finish(); if (input.current) input.current.value = ''; }
  }

  async function save(id: string) {
    if (!begin()) return;
    try {
      const updated = await updateReference(book.id, id, { title, description });
      setItems(current => current.map(item => item.id === id ? updated : item));
      onSelect(selected.map(item => item.id === id ? updated : item));
      setEditing(null); setNotice('资料说明已保存。');
    } catch (error) { setError(message(error)); }
    finally { finish(); }
  }
  async function remove(id: string) {
    if (!begin()) return;
    try {
      await deleteReference(book.id, id);
      setItems(current => current.filter(item => item.id !== id));
      onSelect(selected.filter(item => item.id !== id));
      setDeleting(null); setNotice('辅助资料已删除。');
      setRefresh(value => value + 1);
    } catch (error) { setError(message(error)); }
    finally { finish(); }
  }

  async function extract(item: CourseReference, ocr: boolean) {
    if (!begin()) return;
    try {
      const updated = await extractReferenceText(book.id, item.id, ocr);
      setItems(current => current.map(reference => reference.id === item.id ? updated : reference));
      setNotice(ocr ? '已开始识别扫描文字。' : '已开始提取正文。');
      setRefresh(value => value + 1);
    } catch (error) { setError(message(error)); }
    finally { finish(); }
  }

  return <section className="course-references" aria-label="辅助资料">
    <div className="references-heading"><div><h1>辅助资料</h1><p>为《{book.title}》添加讲义、习题解答和参考文献。课程助手会按问题选读相关内容。</p></div>
      <button className="primary-button" disabled={disabled} onClick={() => input.current?.click()}>{working ? <LoaderCircle size={16} className="spin"/> : <Upload size={16}/>}添加资料</button>
      <input ref={input} type="file" multiple hidden accept=".pdf,.txt,.md,.docx,.pptx,.png,.jpg,.jpeg,.webp" onChange={event => void upload(Array.from(event.target.files || []))}/>
    </div>
    <p className="references-formats">支持 PDF、TXT、Markdown、DOCX、PPTX、PNG、JPEG、WebP，可一次选择多份。</p>
    <div className="references-question"><span>已选 {selected.length} 份资料</span><button className="primary-button" disabled={disabled || !selected.length} onClick={onAsk}>结合这些资料提问</button>{selected.length > 0 && <button className="text-button" disabled={disabled} onClick={() => onSelect([])}>清空选择</button>}</div>
    <form className="reference-search" onSubmit={event => { event.preventDefault(); setSearchQuery(query.trim()); setRefresh(value => value + 1); }}>
      <Search size={17}/><input aria-label="搜索辅助资料全文" placeholder="搜索资料中的文字…" value={query} maxLength={160} onChange={event => setQuery(event.target.value)}/>
      <button className="text-button" disabled={!query.trim() || working} type="submit">搜索全文</button>
      {searchQuery && <button className="icon-button" type="button" aria-label="清除全文搜索" onClick={() => {setQuery('');setSearchQuery('');}}><X size={16}/></button>}
    </form>
    {searching && <p role="status" className="references-notice">正在搜索资料正文…</p>}
    {searchError && <p role="alert" className="references-error">{searchError}</p>}
    {result && <section className="reference-search-results" aria-label="全文搜索结果">
      <p className="references-notice" role="status">已搜索 {result.indexedDocuments}/{result.totalDocuments} 份资料，找到 {result.total} 条结果{result.total > result.hits.length ? `，展示前 ${result.hits.length} 条` : ''}。{result.indexing ? '正在提取其余资料，结果会自动更新。' : ''}</p>
      {result.hits.map((hit, index) => <article className="reference-hit" key={`${hit.referenceId}-${index}`}>
        <a href={hit.url} target="_blank" rel="noreferrer">{hit.title} · {hit.location}<ExternalLink size={13}/></a>
        <p>{hit.snippet.slice(0, hit.matchStart)}<mark>{hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)}</mark>{hit.snippet.slice(hit.matchStart + hit.matchLength)}</p>
        <div>{hit.source === 'ocr' && <span>文字识别结果</span>}<button className="text-button" disabled={disabled} onClick={() => { const item = items.find(item => item.id === hit.referenceId); if (item) {onSelect([item]);onAsk();} }}>结合此资料提问</button></div>
      </article>)}
    </section>}
    {error && <div className="references-error" role="alert"><AlertCircle size={17}/><span>{error}</span></div>}
    {notice && <p className="references-notice" role="status">{notice}</p>}
    <div className="references-summary"><span>{loading ? '正在读取资料…' : `${items.length} 份资料`}</span><button className="text-button" disabled={disabled} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14}/>刷新</button></div>
    {!loading && !items.length && !error && <div className="references-empty"><FileText size={32}/><h2>收好课程的参考材料</h2><p>添加老师的讲义、补充阅读或习题解答，并用说明标记章节和用途。</p></div>}
    <div className="references-list">{items.map(item => <article className="reference-card" key={item.id}>
      <label className="reference-select"><input type="checkbox" checked={selected.some(reference => reference.id === item.id)} disabled={disabled || (selected.length >= 50 && !selected.some(reference => reference.id === item.id))} onChange={event => onSelect(event.target.checked ? [...selected, item] : selected.filter(reference => reference.id !== item.id))}/>选择《{item.title}》用于提问</label>
      <div className="reference-details"><span className="reference-format">{item.format.toUpperCase()}</span><h2>{item.title}</h2><p className="reference-meta">{item.filename} · {fileSize(item.size)} · {new Date(item.createdAt).toLocaleDateString('zh-CN')}</p>
        {item.description && <p className="reference-description">{item.description}</p>}
        {item.textIndex?.status !== 'ready' && <p className="reference-text-status">{item.textIndex?.status === 'queued' ? '等待提取正文…' : item.textIndex?.status === 'processing' ? `正在提取正文：${item.textIndex.processedPages || 0}/${item.textIndex.totalPages || '…'}` : item.textIndex?.status === 'error' ? '正文提取失败' : '正文待提取'}</p>}
        {item.textIndex?.message && <p className="reference-text-status" role={item.textIndex.status === 'error' ? 'alert' : undefined}>{item.textIndex.message}</p>}
        {!['queued', 'processing'].includes(item.textIndex?.status || '') && (item.textIndex?.status !== 'ready' || item.textIndex.needsOcr) && <div className="reference-actions">
          {item.textIndex?.status !== 'ready' && <button className="text-button" disabled={disabled} onClick={() => void extract(item, false)}>提取正文</button>}
          {['pdf', 'png', 'jpg', 'jpeg', 'webp'].includes(item.format) && <button className="text-button" disabled={disabled} onClick={() => void extract(item, true)}>识别扫描文字</button>}
        </div>}
      </div>
      {editing === item.id ? <form className="reference-edit" onSubmit={event => { event.preventDefault(); void save(item.id); }}>
        <label>资料名称<input value={title} required maxLength={200} disabled={disabled} onChange={event => setTitle(event.target.value)}/></label>
        <label>说明<textarea value={description} maxLength={2000} rows={3} placeholder="例如：第三章习题解答，包含梯度下降的收敛证明。" disabled={disabled} onChange={event => setDescription(event.target.value)}/></label>
        <div className="reference-actions"><button className="primary-button" disabled={disabled || !title.trim()} type="submit"><Check size={14}/>保存</button><button className="text-button" disabled={disabled} type="button" onClick={() => setEditing(null)}>取消</button></div>
      </form> : <div className="reference-actions">
        <a className="text-button" href={item.url} target="_blank" rel="noreferrer"><ExternalLink size={14}/>打开资料</a>
        <button className="text-button" disabled={disabled} onClick={() => { setEditing(item.id); setTitle(item.title); setDescription(item.description); setDeleting(null); }}><Pencil size={14}/>编辑说明</button>
        <button className="text-button reference-delete" disabled={disabled} onClick={() => setDeleting(item.id)}><Trash2 size={14}/>删除</button>
      </div>}
      {deleting === item.id && <div className="reference-confirm"><span>删除《{item.title}》及其原文件？</span><button className="text-button reference-delete" disabled={disabled} onClick={() => void remove(item.id)}>确认删除</button><button className="text-button" disabled={disabled} onClick={() => setDeleting(null)}>取消</button></div>}
    </article>)}</div>
  </section>;
}
