import type { Artifact, Book, Chapter, Scope } from './types.ts';

type GraphArtifact = Extract<Artifact, { kind: 'mindmap' | 'knowledge-graph' }>;
type OutlineEntry = { chapter: Chapter; path: number[]; index: number };
type Placement = { key: number[]; label: string };
const missing = Number.MAX_SAFE_INTEGER;
const validPage = (page: unknown): page is number => typeof page === 'number' && Number.isSafeInteger(page) && page > 0;

function outlineEntries(chapters: Chapter[]): OutlineEntry[] {
  const counts: number[] = [];
  return chapters.map((chapter, index) => {
    counts.length = chapter.level + 1;
    counts[chapter.level] = (counts[chapter.level] ?? 0) + 1;
    return { chapter, index, path: Array.from(counts, count => count ?? 0) };
  });
}

function numbering(title: string): number[] | undefined {
  const dotted = title.match(/^\s*(\d+(?:[.．]\d+)+)(?=\s|[^\d.．]|$)/);
  if (dotted) return dotted[1].split(/[.．]/).map(Number);
  const section = title.match(/[（(]\s*第\s*(\d+(?:[.．]\d+)+)\s*节\s*[）)]/);
  if (section) return section[1].split(/[.．]/).map(Number);
  const chapter = title.match(/^\s*第\s*([\d一二三四五六七八九十百零〇两]+)\s*章/);
  if (!chapter) return undefined;
  const value = chapter[1];
  if (/^\d+$/.test(value)) return [Number(value)];
  const digits = '零一二三四五六七八九';
  let result = 0, digit = 0;
  for (const char of value.replaceAll('〇', '零').replaceAll('两', '二')) {
    if (char === '十' || char === '百') { result += (digit || 1) * (char === '十' ? 10 : 100); digit = 0; }
    else digit = digits.indexOf(char);
  }
  return [result + digit];
}

function topic(title: string): string {
  return title.split(/[·•|｜]/)[0]
    .replace(/^\s*第\s*[\d一二三四五六七八九十百零〇两]+\s*[章节]\s*/, '')
    .replace(/^\s*\d+(?:[.．]\d+)*[.．、]?\s*/, '')
    .replace(/(?:整章|整节|复习|总览|总|总体|综合)?(?:思维导图|知识图谱).*$/, '')
    .replace(/[\s：:—-]/g, '');
}

function rootPage(artifact: GraphArtifact): number | undefined {
  const pages = artifact.nodes.map(node => node.page).filter(validPage);
  // A knowledge network has no tree root; its edge directions cannot identify
  // where the source range starts. Saved source metadata is preferred below.
  if (artifact.kind === 'knowledge-graph') return pages.length ? Math.min(...pages) : undefined;
  const children = new Set(artifact.edges.map(edge => edge.target));
  const root = artifact.nodes.find(node => !children.has(node.id) && validPage(node.page));
  return root?.page ?? (pages.length ? Math.min(...pages) : undefined);
}

function entryAtPage(entries: OutlineEntry[], page?: number, within?: number[]): OutlineEntry | undefined {
  if (!page) return undefined;
  return entries.filter(entry => entry.chapter.page <= page
    && (!within || within.every((part, index) => entry.path[index] === part)))
    .sort((a, b) => b.chapter.page - a.chapter.page || b.index - a.index)[0];
}

function matchTitle(title: string, entries: OutlineEntry[], page?: number): OutlineEntry | undefined {
  const numbers = numbering(title);
  if (numbers) {
    // A PDF may carry printed numbering, or just unnumbered titles in tree order.
    const explicit = entries.filter(entry => numbering(entry.chapter.title)?.join('.') === numbers.join('.'));
    const positions = entries.filter(entry => entry.path.join('.') === numbers.join('.'));
    if (explicit.length === 1) return explicit[0];
    if (positions.length === 1) return positions[0];
  }
  const name = topic(title);
  if (!name) return undefined;
  const candidates = entries.filter(entry => topic(entry.chapter.title) === name);
  if (candidates.length === 1) return candidates[0];
  // Repeated names (including chapter/section names) need a page to disambiguate.
  if (page) {
    const exact = candidates.filter(entry => entry.chapter.page === page);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return undefined;
    const atPage = entryAtPage(entries, page);
    const ancestors = candidates.filter(entry => entry.path.every((part, index) => atPage?.path[index] === part));
    if (ancestors.length === 1) return ancestors[0];
  }
  return undefined;
}

function ambiguousTitleAncestor(title: string, entries: OutlineEntry[], page?: number): { entry?: OutlineEntry } | undefined {
  const candidates = entries.filter(entry => topic(entry.chapter.title) === topic(title) && entry.chapter.page === page);
  if (candidates.length < 2) return undefined;
  const shared: number[] = [];
  for (const [index, part] of candidates[0].path.entries()) {
    if (!candidates.every(entry => entry.path[index] === part)) break;
    shared.push(part);
  }
  return { entry: entries.find(entry => entry.path.join('.') === shared.join('.')) };
}

/** Older results have no source metadata. Only an explicit title identifies a total. */
export function graphPlacement(artifact: GraphArtifact, book?: Pick<Book, 'chapters'>): Placement {
  const entries = outlineEntries(book?.chapters ?? []);
  const source = artifact.source;
  const hasSource = source && ['book', 'chapter', 'section', 'page', 'selection', 'range'].includes(source.scope) && validPage(source.page);
  const page = hasSource ? source.page : rootPage(artifact);
  let scope: Scope | 'detail' | undefined = hasSource ? source.scope : undefined;
  const localTitle = /选文|选中内容|当前页|单页/.test(artifact.title);
  if (!scope && !localTitle && /全书|整本教材|整本书/.test(artifact.title)) scope = 'book';
  if (scope === 'book') return { key: [0], label: '全书' };

  const named = matchTitle(artifact.title, entries, page);
  const ambiguous = !hasSource && !named ? ambiguousTitleAncestor(artifact.title, entries, page) : undefined;
  const byId = hasSource ? entries.find(entry => entry.chapter.id === source.sectionId && entry.chapter.level === 1)
    ?? entries.find(entry => entry.chapter.id === source.chapterId && entry.chapter.level === 0) : undefined;
  const located = entryAtPage(entries, page);
  // Source pages outrank titles; titles may only distinguish entries starting on that same page.
  const sourceAnchor = byId ?? (named?.chapter.page === page && named?.path[0] === located?.path[0] ? named : located);
  const anchor = hasSource ? sourceAnchor : ambiguous ? ambiguous.entry : named ?? located;
  let path = anchor?.path ?? numbering(artifact.title);
  if (!scope) {
    if (localTitle) scope = /选文|选中内容/.test(artifact.title) ? 'selection' : 'page';
    else if (named) scope = named.chapter.level === 0 ? 'chapter' : named.chapter.level === 1 ? 'section' : 'detail';
    else if (!entries.length && path) scope = path.length === 1 ? 'chapter' : path.length === 2 ? 'section' : 'detail';
    else scope = 'detail';
  }
  if (scope === 'chapter' && path) path = path.slice(0, 1);
  if (scope === 'section' && path) path = path.slice(0, 2);
  // Metadata may only identify the chapter. Find its section from the source page.
  if (path?.length === 1 && scope !== 'chapter' && !ambiguous) path = entryAtPage(entries, page, path)?.path ?? path;
  const range = scope === 'chapter' ? '整章' : scope === 'section' ? '整节'
    : scope === 'range' && source?.pageRange ? `PDF 第${source.pageRange.start}–${source.pageRange.end}页` : scope === 'selection' ? '选文' : scope === 'page' ? '单页' : '局部内容';
  if (!path?.[0]) return { key: [2, page ?? missing], label: page ? `${range} · PDF 第${page}页` : '范围未标注' };
  const [chapter, section = 0] = path;
  const prefix = `第${chapter}章${section ? ` · 第${section}节` : ''}`;
  if (scope === 'chapter') return { key: [1, chapter, 0], label: `${prefix} · 整章` };
  if (scope === 'section' && section) return { key: [1, chapter, 1, section, 0], label: `${prefix} · 整节` };
  return { key: [1, chapter, 1, section, 1, page ?? anchor?.chapter.page ?? missing], label: `${prefix} · ${range}` };
}

function compareKeys(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference) return difference;
  }
  return 0;
}

export const mindmapPlacement = graphPlacement;

function sortGraphKind(artifacts: Artifact[], kind: GraphArtifact['kind'], book?: Pick<Book, 'chapters'>): Artifact[] {
  const sorted = artifacts.filter(artifact => artifact.kind === kind)
    .map((artifact, index) => ({ artifact, index, key: graphPlacement(artifact as GraphArtifact, book).key }))
    .sort((a, b) => compareKeys(a.key, b.key) || a.index - b.index);
  let next = 0;
  return artifacts.map(artifact => artifact.kind === kind ? sorted[next++].artifact : artifact);
}

/** Reorder mindmap slots only; leave other material types in their existing positions. */
export function sortMindmaps(artifacts: Artifact[], book?: Pick<Book, 'chapters'>): Artifact[] {
  return sortGraphKind(artifacts, 'mindmap', book);
}

/** Both graph libraries use the same source order; each kind keeps its own slots
 * in the mixed materials list, and equal placements retain their original order. */
export function sortGraphArtifacts(artifacts: Artifact[], book?: Pick<Book, 'chapters'>): Artifact[] {
  return sortGraphKind(sortMindmaps(artifacts, book), 'knowledge-graph', book);
}
