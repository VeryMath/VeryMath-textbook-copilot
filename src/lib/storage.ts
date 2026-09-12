import type { Artifact, Book, Chapter, ConversationInfo, CourseReference, Message, PersonalSettings, ReadingState, ReferenceSearchResult, StorageInfo } from './types';

const coursePath = (courseId: string) => `/api/courses/${encodeURIComponent(courseId)}`;

async function request(path: string, options: RequestInit = {}): Promise<Response> {
  let response: Response;
  try { response = await fetch(path, { cache: 'no-store', ...options }); }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('无法连接本机课程服务，请确认服务仍在运行。');
  }
  if (!response.ok) {
    let detail = '';
    try {
      const value: unknown = await response.json();
      if (isObject(value)) detail = typeof value.error === 'string' ? value.error : typeof value.message === 'string' ? value.message : '';
    } catch { /* Some server errors have no JSON body. */ }
    throw new Error(detail || `课程数据操作失败（${response.status}），请稍后重试。`);
  }
  return response;
}

async function getJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await request(path, options);
  try { return await response.json() as T; }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('课程服务返回了无法读取的数据，请重试。');
  }
}

const jsonBody = (value: unknown): RequestInit => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

export function getStorageInfo(signal?: AbortSignal): Promise<StorageInfo> {
  return getJson('/api/storage', { signal });
}

export function getCourses(signal?: AbortSignal): Promise<Book[]> {
  return getJson('/api/courses', { signal });
}

export function listReferences(courseId: string, signal?: AbortSignal): Promise<CourseReference[]> {
  return getJson(`${coursePath(courseId)}/references`, { signal });
}

export function extractReferenceText(courseId: string, id: string, ocr = false): Promise<CourseReference> {
  return getJson(`${coursePath(courseId)}/references/${encodeURIComponent(id)}/text`, { method: 'POST', ...jsonBody({ ocr }) });
}

export function searchReferences(courseId: string, query: string, signal?: AbortSignal): Promise<ReferenceSearchResult> {
  return getJson(`${coursePath(courseId)}/references/search?q=${encodeURIComponent(query)}`, { signal });
}

export function uploadReference(courseId: string, file: File): Promise<CourseReference> {
  if (file.size > 100 * 1024 * 1024) return Promise.reject(new Error('单份辅助资料最大 100 MiB（104857600 字节）。'));
  return getJson(`${coursePath(courseId)}/references`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file,
  });
}

export function updateReference(courseId: string, id: string, value: { title: string; description: string }): Promise<CourseReference> {
  return getJson(`${coursePath(courseId)}/references/${encodeURIComponent(id)}`, { method: 'PATCH', ...jsonBody(value) });
}

export async function deleteReference(courseId: string, id: string): Promise<void> {
  await request(`${coursePath(courseId)}/references/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function getCourseState(courseId: string, signal?: AbortSignal): Promise<ReadingState> {
  const state = await getJson<ReadingState>(`${coursePath(courseId)}/state`, { signal });
  return { ...state, messages: state.messages.map(stopPreviousMessage) };
}

export async function saveCourseState(courseId: string, state: ReadingState, options: { keepalive?: boolean } = {}): Promise<void> {
  const body = JSON.stringify(state);
  if (options.keepalive && new TextEncoder().encode(body).length > 64 * 1024) {
    throw new Error('当前对话较长，无法在关闭页面时补存。请保持页面打开，等待“已保存”后再离开。');
  }
  await request(`${coursePath(courseId)}/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: options.keepalive });
}

export function updateSettings(patch: Partial<PersonalSettings>): Promise<PersonalSettings> {
  return getJson('/api/settings', { method: 'PATCH', ...jsonBody(patch) });
}

export function uploadBook(file: File, options: { legacyId?: string } = {}): Promise<Book> {
  if (file.size > 100 * 1024 * 1024) return Promise.reject(new Error('当前支持 100 MB 以内的 PDF。'));
  const query = options.legacyId ? `?legacyId=${encodeURIComponent(options.legacyId)}` : '';
  return getJson(`/api/courses${query}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name) }, body: file });
}

export async function saveBookMetadata(courseId: string, data: { totalPages: number; chapters: Chapter[] }): Promise<void> {
  await request(`${coursePath(courseId)}/textbook`, { method: 'PATCH', ...jsonBody(data) });
}

export async function savePageText(courseId: string, page: number, text: string): Promise<void> {
  await request(`${coursePath(courseId)}/pages/${page}`, { method: 'PUT', ...jsonBody({ text }) });
}

export function editMindmapNode(courseId: string, artifactId: string, nodeId: string, userText: string): Promise<Artifact> {
  return getJson(`${coursePath(courseId)}/artifacts/${encodeURIComponent(artifactId)}/nodes/${encodeURIComponent(nodeId)}`, { method: 'PATCH', ...jsonBody({ userText }) });
}

export function listConversations(courseId: string): Promise<ConversationInfo[]> {
  return getJson(`${coursePath(courseId)}/conversations`);
}

export async function getConversation(courseId: string, id: string): Promise<{ messages: Message[] }> {
  const result = await getJson<{ messages: Message[] }>(`${coursePath(courseId)}/conversations/${encodeURIComponent(id)}`);
  return { ...result, messages: result.messages.map(stopPreviousMessage) };
}

function stopPreviousMessage(message: Message): Message {
  return message.status === 'running' ? { ...message, status: 'stopped', progress: '上次任务已中断，可重新发送。' } : message;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const positivePage = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const textField = (object: Record<string, unknown>, field: string) => typeof object[field] === 'string';

function isArtifact(value: unknown): value is Artifact {
  if (!isObject(value) || !textField(value, 'id') || !textField(value, 'title')) return false;
  if (value.kind === 'quiz') return Array.isArray(value.questions) && value.questions.length > 0
    && value.questions.every(question => isObject(question) && textField(question, 'id') && textField(question, 'prompt')
      && ['knowledgePoint', 'difficulty', 'answer', 'explanation'].every(key => question[key] === undefined || textField(question, key))
      && (question.page === undefined || positivePage(question.page))
      && (question.hints === undefined || Array.isArray(question.hints) && question.hints.every(hint => typeof hint === 'string')));
  if (value.kind === 'markdown') return textField(value, 'content');
  if (value.kind === 'video' || value.kind === 'file') return textField(value, 'url') && (value.filename === undefined || textField(value, 'filename'));
  if (value.kind === 'slides') return (value.url === undefined || textField(value, 'url')) && Array.isArray(value.slides) && value.slides.every(slide => isObject(slide) && textField(slide, 'title') && textField(slide, 'content'));
  if (value.kind === 'mindmap' || value.kind === 'knowledge-graph') {
    return Array.isArray(value.nodes) && value.nodes.every(node => isObject(node) && textField(node, 'id') && textField(node, 'label') && (node.page === undefined || positivePage(node.page)) && (node.originalLabel === undefined || textField(node, 'originalLabel')) && (node.userText === undefined || textField(node, 'userText')))
      && Array.isArray(value.edges) && value.edges.every(edge => isObject(edge) && textField(edge, 'source') && textField(edge, 'target') && (edge.label === undefined || textField(edge, 'label')));
  }
  return false;
}

function isMessage(value: unknown): value is Message {
  return isObject(value) && textField(value, 'id') && textField(value, 'content') && (value.role === 'user' || value.role === 'assistant')
    && (value.status === undefined || ['running', 'done', 'error', 'stopped'].includes(String(value.status)))
    && (value.skillId === undefined || ['chat', 'textbook-parse', 'explain', 'quiz', 'mindmap', 'knowledge-graph', 'slides', 'video'].includes(String(value.skillId)))
    && (value.progress === undefined || textField(value, 'progress'))
    && (value.artifacts === undefined || Array.isArray(value.artifacts) && value.artifacts.every(isArtifact));
}

function parseLegacyState(raw: string, legacyId: string): ReadingState {
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) || !positivePage(value.page) || !Array.isArray(value.messages) || !value.messages.every(isMessage)
    || !Array.isArray(value.artifacts) || !value.artifacts.every(isArtifact)
    || (value.bookmarks !== undefined && (!Array.isArray(value.bookmarks) || !value.bookmarks.every(positivePage)))
    || (value.notes !== undefined && (!Array.isArray(value.notes) || !value.notes.every(note => isObject(note) && textField(note, 'id') && positivePage(note.page) && textField(note, 'content'))))) {
    throw new Error('旧记录内容不完整，已保留在浏览器中，请勿清除浏览器数据。');
  }
  return {
    page: value.page, messages: value.messages.map(stopPreviousMessage), artifacts: value.artifacts,
    bookmarks: (value.bookmarks as number[] | undefined) ?? [],
    notes: (value.notes as ReadingState['notes'] | undefined) ?? [], conversationId: `legacy-${legacyId}`,
  };
}

// Existing browser records are read only during migration. No new browser database is created.
async function openLegacyDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;
  if (typeof indexedDB.databases === 'function') {
    const databases = await indexedDB.databases();
    if (!databases.some(database => database.name === 'course-books')) return null;
  }
  return new Promise((resolve, reject) => {
    let missing = false;
    const opening = indexedDB.open('course-books');
    opening.onupgradeneeded = () => { missing = true; opening.transaction?.abort(); };
    opening.onsuccess = () => {
      if (!opening.result.objectStoreNames.contains('books')) { opening.result.close(); resolve(null); }
      else resolve(opening.result);
    };
    opening.onerror = () => missing ? resolve(null) : reject(opening.error);
    opening.onblocked = () => reject(new Error('旧教材数据库被其他页面占用，请关闭旧版课程页面后重试。'));
  });
}

async function readLegacyBook(): Promise<unknown> {
  const database = await openLegacyDatabase();
  if (!database) return undefined;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('books', 'readonly');
    const reading = transaction.objectStore('books').get('current');
    transaction.oncomplete = () => { database.close(); resolve(reading.result); };
    transaction.onerror = transaction.onabort = () => { database.close(); reject(transaction.error); };
  });
}

async function removeLegacyBook(legacyId: string): Promise<void> {
  const database = await openLegacyDatabase();
  if (!database) return;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('books', 'readwrite');
    const store = transaction.objectStore('books');
    const reading = store.get('current');
    reading.onsuccess = () => { if (reading.result?.book?.id === legacyId) store.delete('current'); };
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = transaction.onabort = () => { database.close(); reject(transaction.error); };
  });
}

type MigrationResult = { migrated: boolean; warnings: string[] };
let migrationInFlight: Promise<MigrationResult> | undefined;

export function migrateBrowserData(): Promise<MigrationResult> {
  if (!migrationInFlight) migrationInFlight = migrateLegacyData().finally(() => { migrationInFlight = undefined; });
  return migrationInFlight;
}

async function migrateLegacyData(): Promise<MigrationResult> {
  const warnings: string[] = [];
  let migrated = false;
  const legacyStates = new Map<string, string>();
  let active: string | null = null;
  let widths: string | null = null;
  try {
    active = localStorage.getItem('course:active');
    widths = localStorage.getItem('course:column-widths');
    const defaultState = localStorage.getItem('course:optimization');
    if (defaultState !== null) legacyStates.set('optimization', defaultState);
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key && /^course:local-[a-zA-Z0-9-]+$/.test(key)) {
        const raw = localStorage.getItem(key);
        if (raw !== null) legacyStates.set(key.slice('course:'.length), raw);
      }
    }
  } catch { warnings.push('浏览器不允许读取旧阅读记录，旧数据尚未迁移。'); }

  let oldBook: unknown;
  try { oldBook = await readLegacyBook(); }
  catch (error) { warnings.push(`旧教材尚未迁移：${error instanceof Error ? error.message : '无法读取浏览器中的教材文件。'}`); }
  if (!legacyStates.size && !oldBook && active === null && widths === null) return { migrated, warnings };

  const courses = await getCourses();
  const included = courses.find(course => course.source === 'included');
  let imported: Book | undefined;
  let importedLegacyId: string | undefined;
  let importedDataSaved = false;
  const savedStates = new Set<string>();
  const removeSetting = (key: string) => {
    try { localStorage.removeItem(key); }
    catch { warnings.push('课程已保存，但浏览器未允许清理对应旧记录；下次打开时会再次尝试迁移。'); }
  };
  const migrateState = async (courseId: string, legacyId: string) => {
    const raw = legacyStates.get(legacyId);
    if (raw === undefined) return true;
    try {
      const state = parseLegacyState(raw, legacyId);
      await request(`${coursePath(courseId)}/migrate`, { method: 'POST', ...jsonBody({ legacyId, state }) });
      savedStates.add(legacyId);
      removeSetting(`course:${legacyId}`);
      migrated = true;
      return true;
    } catch (error) {
      warnings.push(`旧课程 ${legacyId === 'optimization' ? '最优化方法' : legacyId} 尚未迁移：${error instanceof Error ? error.message : '保存失败，原记录仍在浏览器中。'}`);
      return false;
    }
  };

  if (legacyStates.has('optimization')) {
    if (included) await migrateState(included.id, 'optimization');
    else warnings.push('未找到原来的内置教材，旧阅读记录已保留在浏览器中。');
  }
  if (oldBook !== undefined && oldBook !== null) {
    if (!isObject(oldBook) || !isObject(oldBook.book) || typeof oldBook.book.id !== 'string' || !/^local-[a-zA-Z0-9-]+$/.test(oldBook.book.id)
      || typeof oldBook.book.filename !== 'string' || !(oldBook.file instanceof Blob)) {
      warnings.push('浏览器中的旧教材记录不完整，已保留原数据，请勿清除浏览器数据。');
    } else {
      importedLegacyId = oldBook.book.id;
      try {
        const file = oldBook.file instanceof File ? oldBook.file : new File([oldBook.file], oldBook.book.filename, { type: 'application/pdf' });
        imported = await uploadBook(file, { legacyId: importedLegacyId });
        migrated = true;
        importedDataSaved = await migrateState(imported.id, importedLegacyId);
      } catch (error) {
        warnings.push(`旧教材尚未全部迁移，浏览器原件已保留：${error instanceof Error ? error.message : '保存失败，请重试。'}`);
      }
    }
  }
  for (const legacyId of legacyStates.keys()) {
    if (legacyId !== 'optimization' && legacyId !== importedLegacyId && !savedStates.has(legacyId)) {
      warnings.push(`旧课程 ${legacyId} 的阅读记录仍在浏览器中，但未找到对应 PDF。该记录尚未迁移，恢复时需要对应原教材。`);
    }
  }

  try {
    // Read the latest settings after file migration so existing personal preferences win.
    const { settings } = await getStorageInfo();
    const patch: Partial<PersonalSettings> = {};
    let clearActive = false;
    let clearWidths = false;
    if (active !== null) {
      if (settings.activeCourseId) clearActive = true;
      else {
        const preferred = active === 'local' ? imported : active === 'default' ? included : undefined;
        if (preferred) { patch.activeCourseId = preferred.id; clearActive = true; }
        else warnings.push('旧的当前教材选择尚未迁移，对应记录仍在浏览器中。');
      }
    }
    if (widths !== null) {
      if (settings.columnWidths !== undefined) clearWidths = true;
      else {
        try {
          const value: unknown = JSON.parse(widths);
          if (!isObject(value) || Object.keys(value).some(key => key !== 'sidebar' && key !== 'copilot')) throw new Error();
          const columnWidths: NonNullable<PersonalSettings['columnWidths']> = {};
          for (const name of ['sidebar', 'copilot'] as const) {
            if (value[name] === undefined) continue;
            if (typeof value[name] !== 'number' || !Number.isFinite(value[name]) || value[name] <= 0) throw new Error();
            columnWidths[name] = value[name];
          }
          patch.columnWidths = columnWidths; clearWidths = true;
        } catch { warnings.push('旧栏宽设置无法读取，已保留原记录。'); }
      }
    }
    if (Object.keys(patch).length) { await updateSettings(patch); migrated = true; }
    if (clearActive) removeSetting('course:active');
    if (clearWidths) removeSetting('course:column-widths');
    // Retain the legacy book until the active-course preference is saved, so a retry can find it.
    if (importedDataSaved && importedLegacyId && (active !== 'local' || clearActive)) {
      try { await removeLegacyBook(importedLegacyId); }
      catch { warnings.push('教材已保存到个人目录，但浏览器原件暂时无法清理；下次打开会重试。'); }
    }
  } catch (error) {
    warnings.push(`旧个人设置尚未迁移，浏览器原记录已保留：${error instanceof Error ? error.message : '保存失败，请重试。'}`);
  }
  return { migrated, warnings };
}
