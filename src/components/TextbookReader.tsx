import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, ExternalLink, LoaderCircle, Maximize, Minus, Plus, RotateCw } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import type { Book, Chapter } from '../lib/types';
import './textbook-reader.css';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface TextbookReaderProps {
  book: Book;
  page: number;
  onPageChange: (page: number) => void;
  navigationId: number;
  onVisiblePageChange: (bookId: string, page: number) => void;
  onDocumentReady: (data: { totalPages: number; chapters: Chapter[] }) => void;
  onTextChange: (bookId: string, page: number, text: string) => void;
  onSelectionChange: (text: string, pages?: { start: number; end: number }) => void;
}

async function readOutline(pdf: PDFDocumentProxy): Promise<Chapter[]> {
  const outline = await pdf.getOutline();
  if (!outline) return [];
  type OutlineItem = (typeof outline)[number];
  async function visit(items: OutlineItem[], level: number, prefix: string): Promise<Chapter[]> {
    const groups = await Promise.all(items.map(async (item, index) => {
      const id = `${prefix}-${index + 1}`;
      let pageNumber: number | undefined;
      try {
        const destination = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
        if (Array.isArray(destination) && destination[0] != null) {
          pageNumber = typeof destination[0] === 'number'
            ? destination[0] + 1
            : (await pdf.getPageIndex(destination[0])) + 1;
        }
      } catch {
        // A malformed outline destination must not prevent reading the PDF.
      }
      const current = pageNumber && pageNumber >= 1 && pageNumber <= pdf.numPages
        ? [{ id, title: item.title, page: pageNumber, level }]
        : [];
      return [...current, ...await visit(item.items ?? [], level + 1, id)];
    }));
    return groups.flat();
  }
  return visit(outline, 0, 'outline');
}

function pdfErrorMessage(error: unknown) {
  const name = error instanceof Error ? error.name : '';
  if (name === 'PasswordException') return '这份 PDF 需要密码，请先使用 PDF 阅读器解锁后重新导入。';
  if (name === 'InvalidPDFException') return '无法读取这份 PDF，请确认文件完整且格式正确。';
  if (name === 'MissingPDFException' || name === 'UnexpectedResponseException') return '暂时无法获取教材文件，请检查本地服务是否已经启动。';
  return '教材暂时无法显示，请重试，或在新窗口打开原 PDF。';
}

export default function TextbookReader({ book, page, navigationId, onPageChange, onVisiblePageChange, onDocumentReady, onTextChange, onSelectionChange }: TextbookReaderProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const callbacks = useRef({ onDocumentReady, onTextChange, onSelectionChange, onVisiblePageChange });
  callbacks.current = { onDocumentReady, onTextChange, onSelectionChange, onVisiblePageChange };
  const [documentState, setDocumentState] = useState<{ url: string; pdf: PDFDocumentProxy } | null>(null);
  const [viewerReady, setViewerReady] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const [displayScale, setDisplayScale] = useState(1);
  const [pageInput, setPageInput] = useState(String(page));
  const [busy, setBusy] = useState(true);
  const [loadPercent, setLoadPercent] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [textNote, setTextNote] = useState('');
  const [pageErrors, setPageErrors] = useState<Record<number, string>>({});
  const [retry, setRetry] = useState(0);
  const pdf = documentState?.url === book.url ? documentState.pdf : null;
  const totalPages = pdf?.numPages ?? book.totalPages;
  const currentPage = Math.max(1, Math.min(page, totalPages ?? page));
  const readerNotice = pageErrors[currentPage] || textNote;
  const latest = useRef({ currentPage, zoom });
  latest.current = { currentPage, zoom };
  const lastNavigation = useRef(navigationId);

  useEffect(() => {
    const container = viewportRef.current;
    const pages = pagesRef.current;
    if (!container || !pages) return;
    let cancelled = false;
    let initialized = false;
    let needsInitialPosition = true;
    const lifecycle = new AbortController();
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2, externalLinkRel: 'noopener noreferrer', ignoreDestinationZoom: true });
    const options = {
      container, viewer: pages, eventBus, linkService,
      // PDF.js queues visible/nearby pages and evicts old canvases for long books.
      maxCanvasPixels: 8 * 1024 * 1024,
      abortSignal: lifecycle.signal,
    };
    const viewer = new PDFViewer(options);
    viewerRef.current = viewer;
    linkService.setViewer(viewer);
    setDocumentState(null);
    setViewerReady(false);
    setError('');
    setPageErrors({});
    setBusy(true);
    setLoadPercent(null);
    setZoom(null);
    callbacks.current.onSelectionChange('');

    const positionInitialPage = () => {
      if (!container.clientWidth || !container.clientHeight) return;
      viewer.currentScaleValue = 'page-width';
      viewer.currentPageNumber = Math.min(latest.current.currentPage, viewer.pagesCount);
      needsInitialPosition = false;
      viewer.update();
    };
    eventBus.on('pagesinit', () => {
      if (cancelled) return;
      positionInitialPage();
      initialized = true;
      setViewerReady(true);
      setBusy(false);
    });
    eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
      // Hidden tabs have no meaningful visible page. Scrolling only reports the
      // active page; the parent must not turn this notification into a jump.
      if (!cancelled && initialized && !needsInitialPosition && container.clientHeight > 0) {
        callbacks.current.onVisiblePageChange(book.id, pageNumber);
      }
    });
    eventBus.on('scalechanging', ({ scale }: { scale: number }) => {
      if (!cancelled) setDisplayScale(scale);
    });
    eventBus.on('pagerendered', ({ pageNumber, error: renderError }: { pageNumber: number; error?: unknown }) => {
      if (cancelled) return;
      setPageErrors(previous => {
        if (!renderError && !previous[pageNumber]) return previous;
        const next = { ...previous };
        if (renderError) next[pageNumber] = '这一页暂时无法显示，可继续滚动阅读其他页面，或刷新后重试。';
        else delete next[pageNumber];
        return next;
      });
    });

    // Refitting uses PDF.js's saved position, preserving the place within a page
    // when the reader column is resized or a hidden reader becomes visible.
    let resizeTimer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (cancelled || !initialized || !container.clientWidth || !container.clientHeight) return;
        if (needsInitialPosition) { positionInitialPage(); return; }
        if (latest.current.zoom === null) viewer.currentScaleValue = 'page-width';
        else viewer.currentScale = latest.current.zoom;
        viewer.update();
      }, 120);
    });
    observer.observe(container);

    const loadingTask = getDocument({
      url: book.url,
      cMapUrl: '/api/pdf-assets/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/api/pdf-assets/standard_fonts/',
      wasmUrl: '/api/pdf-assets/wasm/',
    });
    const showError = (reason: unknown) => {
      if (cancelled) return;
      setError(pdfErrorMessage(reason));
      setBusy(false);
    };
    loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
      if (!cancelled && total > 0) setLoadPercent(Math.min(100, Math.round(loaded / total * 100)));
    };
    void loadingTask.promise.then(async loadedPdf => {
      if (cancelled) return;
      setDocumentState({ url: book.url, pdf: loadedPdf });
      linkService.setDocument(loadedPdf);
      viewer.setDocument(loadedPdf);
      void viewer.pagesPromise.catch(showError);
      const chapters = book.chapters.length ? book.chapters : await readOutline(loadedPdf).catch(() => []);
      if (!cancelled) callbacks.current.onDocumentReady({ totalPages: loadedPdf.numPages, chapters });
    }).catch(showError);
    return () => {
      cancelled = true;
      observer.disconnect();
      clearTimeout(resizeTimer);
      lifecycle.abort();
      // The implementation accepts null to cancel/reset; its declaration omits it.
      // @ts-expect-error PDF.js supports clearing the document with null.
      viewer.setDocument(null);
      linkService.setDocument(null);
      if (viewerRef.current === viewer) viewerRef.current = null;
      void loadingTask.destroy().catch(() => {});
    };
  }, [book.id, book.url, retry]);

  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewerReady || !viewer) return;
    const explicitJump = lastNavigation.current !== navigationId;
    lastNavigation.current = navigationId;
    // A scroll-originated page change is already in view. Only navigation should
    // move the viewport, including a repeated jump to the current page's top.
    if (explicitJump) {
      viewer.scrollPageIntoView({ pageNumber: currentPage });
    }
  }, [currentPage, navigationId, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewerReady || !viewer || !viewer.container.clientWidth || !viewer.container.clientHeight) return;
    if (zoom === null) viewer.currentScaleValue = 'page-width';
    else viewer.currentScale = zoom;
  }, [zoom, viewerReady]);

  useEffect(() => {
    let cancelled = false;
    setTextNote('');
    callbacks.current.onTextChange(book.id, currentPage, '');
    if (pdf) void pdf.getPage(currentPage).then(pdfPage => pdfPage.getTextContent()).then(content => {
      if (cancelled) return;
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join('').trim();
      callbacks.current.onTextChange(book.id, currentPage, text);
      if (!text) setTextNote('这一页没有可选文字，可在 Copilot 中用“指定页码”处理扫描教材。');
    }).catch(() => {
      if (!cancelled) setTextNote('这一页的文字暂时无法提取，仍可阅读原文。');
    });
    return () => { cancelled = true; };
  }, [pdf, book.id, currentPage]);

  function submitPage(force = false) {
    const number = Number(pageInput);
    if (Number.isInteger(number) && number >= 1 && (!totalPages || number <= totalPages)) {
      if (force || number !== currentPage) onPageChange(number);
    } else {
      setPageInput(String(currentPage));
    }
  }

  useEffect(() => {
    let frame = 0;
    const capture = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Native selection handles and keyboard selection can finish after pointerup.
        // Preserve the quoted text when focus moves to the Copilot composer.
        if (window.getSelection()?.toString().trim()) captureSelection();
      });
    };
    document.addEventListener('selectionchange', capture);
    return () => { document.removeEventListener('selectionchange', capture); cancelAnimationFrame(frame); };
  }, [book.id]);

  function captureSelection() {
    const selection = window.getSelection();
    const paper = pagesRef.current;
    if (!selection || !paper) return;
    if (paper.contains(selection.anchorNode) && paper.contains(selection.focusNode)) {
      const range = selection.rangeCount ? selection.getRangeAt(0) : null;
      const sourcePage = (node: Node) => {
        const element = node instanceof Element ? node : node.parentElement;
        return Number(element?.closest('[data-page-number]')?.getAttribute('data-page-number'));
      };
      const start = range ? sourcePage(range.startContainer) : 0;
      const end = range ? sourcePage(range.endContainer) : 0;
      callbacks.current.onSelectionChange(selection.toString().trim(), start && end ? { start, end } : undefined);
    }
  }

  return (
    <section className="textbook-reader" aria-label="教材阅读器">
      <div className="reader-toolbar" aria-label="教材阅读工具">
        <div className="reader-page-controls">
          <button type="button" className="reader-icon-button" aria-label="上一页" title="上一页" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage <= 1 || !viewerReady}>
            <ChevronLeft size={17} />
          </button>
          <label className="reader-page-field">
            <span className="reader-page-label">页码</span>
            <input aria-label="跳转到页码" inputMode="numeric" value={pageInput} onChange={(event) => setPageInput(event.target.value)} onBlur={() => submitPage()} onKeyDown={(event) => { if (event.key === 'Enter') { submitPage(true); event.currentTarget.blur(); } }} disabled={!viewerReady} />
            <span className="reader-page-total">/ {totalPages ?? '—'}</span>
          </label>
          <button type="button" className="reader-icon-button" aria-label="下一页" title="下一页" onClick={() => onPageChange(currentPage + 1)} disabled={!viewerReady || currentPage >= (totalPages ?? 1)}>
            <ChevronRight size={17} />
          </button>
        </div>
        <div className="reader-zoom-controls">
          <button type="button" className="reader-icon-button" aria-label="缩小教材" title="缩小" disabled={!viewerReady || displayScale <= 0.35} onClick={() => setZoom(Math.max(0.35, displayScale - 0.15))}><Minus size={16} /></button>
          <span className="reader-zoom-value">{Math.round(displayScale * 100)}%</span>
          <button type="button" className="reader-icon-button" aria-label="放大教材" title="放大" disabled={!viewerReady || displayScale >= 3} onClick={() => setZoom(Math.min(3, displayScale + 0.15))}><Plus size={16} /></button>
          <span className="reader-toolbar-divider" />
          <button type="button" className={`reader-fit-button${zoom === null ? ' is-active' : ''}`} title="适合宽度" aria-label="适合宽度" disabled={!viewerReady} onClick={() => setZoom(null)}><Maximize size={15} /><span>适合宽度</span></button>
          <a className="reader-icon-button reader-open-link" href={`${book.url}#page=${currentPage}`} target="_blank" rel="noreferrer" title="在新窗口打开原 PDF" aria-label="在新窗口打开原 PDF"><ExternalLink size={15} /></a>
        </div>
      </div>
      <div className="reader-view-area">
        <div className="reader-viewport" ref={viewportRef} tabIndex={0} aria-label="连续滚动教材" onPointerUp={captureSelection} onKeyUp={captureSelection}>
          <div className="reader-pages pdfViewer" ref={pagesRef} />
        </div>
        {busy && !error && <div className="reader-status" role="status"><LoaderCircle className="reader-spinner" size={25} /><strong>正在载入教材</strong><span>{loadPercent !== null ? `已载入 ${loadPercent}%` : '保留教材原有的公式与排版'}</span></div>}
        {error && <div className="reader-status reader-error" role="alert"><AlertCircle size={27} /><strong>教材没有打开</strong><span>{error}</span><button type="button" onClick={() => setRetry(value => value + 1)}><RotateCw size={15} />重新加载</button></div>}
        {readerNotice && <div className="reader-notice" role="alert">{readerNotice}</div>}
      </div>
    </section>
  );
}
