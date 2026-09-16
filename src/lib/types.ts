export type SkillId = 'chat' | 'textbook-parse' | 'explain' | 'quiz' | 'mindmap' | 'knowledge-graph' | 'slides' | 'video';
export type Scope = 'page' | 'section' | 'chapter' | 'selection' | 'range' | 'book' | 'none';
export type KnowledgeGraphDetail = 'overview' | 'detailed';

export interface KnowledgeGraphEvidence {
  page: number;
  summary: string;
  location?: string;
}

export interface KnowledgeGraphCoverageItem {
  title: string;
  pages: number[];
  status: 'covered' | 'omitted' | 'unread';
  note: string;
}

export interface KnowledgeGraphCoverage {
  summary: string;
  items: KnowledgeGraphCoverageItem[];
}

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  page?: number;
  originalLabel?: string;
  userText?: string;
  conceptKey?: string;
  type?: string;
  aliases?: string[];
  description?: string;
}

export interface KnowledgeGraphEdge {
  id?: string;
  source: string;
  target: string;
  label?: string;
  basis?: 'textbook' | 'inference';
  conditions?: string;
  evidence?: KnowledgeGraphEvidence[];
}

export interface PageRange { start: number; end: number }

export interface ArtifactSource {
  pageRange?: PageRange;
  scope: Scope;
  page: number;
  chapterId?: string;
  sectionId?: string;
}

export interface Chapter {
  id: string;
  title: string;
  page: number;
  level: number;
}

export interface Book {
  id: string;
  title: string;
  filename: string;
  url: string;
  totalPages?: number;
  chapters: Chapter[];
  initialPage?: number;
  local?: boolean;
  source?: 'included' | 'imported';
  directory?: string;
}

export interface PersonalSettings {
  activeCourseId?: string;
  columnWidths?: { sidebar?: number; copilot?: number };
}

export interface CourseReference {
  id: string;
  title: string;
  filename: string;
  description: string;
  size: number;
  format: string;
  createdAt: string;
  url: string;
  textIndex?: { status: 'pending' | 'queued' | 'processing' | 'ready' | 'error'; processedPages?: number; totalPages?: number; needsOcr?: boolean; message?: string; extractedAt?: string };
}

export interface ReferenceSearchResult {
  query: string; total: number; indexing: boolean; indexedDocuments: number; totalDocuments: number;
  hits: { referenceId: string; title: string; url: string; location: string; page?: number; slide?: number; paragraph?: number;
    source: 'text' | 'ocr'; snippet: string; matchStart: number; matchLength: number }[];
}

export interface StorageInfo { directory: string; settings: PersonalSettings }

export interface ReadingState {
  page: number;
  bookmarks: number[];
  notes: { id: string; page: number; content: string }[];
  conversationId: string;
  messages: Message[];
  artifacts: Artifact[];
}

export interface ConversationInfo { id: string; title: string; updatedAt: string; messageCount: number }

export interface SkillInfo {
  id: SkillId;
  title: string;
  description: string;
  available: boolean;
  templates?: { id: string; title: string; description: string }[];
}

export interface SkillRequest {
  skillId: SkillId;
  book: { id: string; title: string; filename: string; totalPages?: number; local?: boolean };
  chapter?: Chapter;
  page: number;
  scope: Scope;
  pageRange?: PageRange;
  selectedText: string;
  pageText: string;
  prompt: string;
  knowledgeGraphDetail?: KnowledgeGraphDetail;
  templateId?: string;
  artifact?: Artifact;
  referenceIds?: string[];
  history: { role: 'user' | 'assistant'; content: string }[];
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  knowledgePoint?: string;
  difficulty?: string;
  page?: number;
  hints?: string[];
  answer?: string;
  explanation?: string;
}

export type Artifact = (
  | { id: string; title: string; kind: 'quiz'; questions: QuizQuestion[] }
  | { id: string; title: string; kind: 'markdown'; content: string }
  | { id: string; title: string; kind: 'mindmap' | 'knowledge-graph'; nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[]; schemaVersion?: 2; detailLevel?: KnowledgeGraphDetail; coverage?: KnowledgeGraphCoverage }
  | { id: string; title: string; kind: 'slides'; slides?: { title: string; content: string }[]; url?: string;
      chapters?: { title: string; url: string; filename?: string }[]; sourceUrl?: string; templateId?: string }
  | { id: string; title: string; kind: 'video' | 'file'; url: string; filename?: string }
) & { source?: ArtifactSource };

export type SkillEvent =
  | { type: 'progress'; message: string }
  | { type: 'text'; content: string }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  references?: Pick<CourseReference, 'id' | 'title' | 'url'>[];
  skillId?: SkillId;
  startedAt?: number;
  status?: 'running' | 'done' | 'error' | 'stopped';
  progress?: string;
  artifacts?: Artifact[];
}
