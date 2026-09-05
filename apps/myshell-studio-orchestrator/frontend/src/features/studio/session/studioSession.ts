export const LAST_STUDIO_PROJECT_KEY = 'dreamy-studio:last-project-id';
export const STUDIO_DISPATCH_SESSION_KEY = 'dreamy-studio:dispatch-session';
export const STUDIO_SESSION_CHANGED_EVENT = 'dreamy-studio:session-changed';

export interface StudioDispatchSession {
  projectId: string;
  sessionId?: string;
  targetId?: string;
  pageId?: string;
  pageName?: string;
  navigationPath?: string;
  studioReturnPath?: string;
  updatedAt: string;
}

function notifyStudioSessionChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(STUDIO_SESSION_CHANGED_EVENT));
}

export function readLastStudioProjectId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(LAST_STUDIO_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function saveLastStudioProjectId(projectId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_STUDIO_PROJECT_KEY, projectId);
    notifyStudioSessionChanged();
  } catch {
    // Storage can be unavailable in embedded browsers; persistence is best-effort.
  }
}

export function forgetLastStudioProjectId(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(LAST_STUDIO_PROJECT_KEY);
    notifyStudioSessionChanged();
  } catch {
    // Storage can be unavailable in embedded browsers; reset still works server-side.
  }
}

export function normalizeStudioNavigationPath(path: string | undefined): string {
  if (!path) return '';
  if (!path.startsWith('/')) return '';
  if (path.startsWith('//')) return '';
  return path;
}

function appendSearchParam(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = (value || '').trim();
  if (trimmed) params.set(key, trimmed);
}

function pathWithSearchAndHash(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

const STUDIO_DISPATCH_URL_PARAMS = [
  'studio_project_id',
  'dispatch_session_id',
  'dispatch_target_id',
  'studio_page_id',
  'studio_return_path',
  'project_id',
  'session_id',
  'target_id',
];

export function buildStudioDispatchNavigationPath(
  path: string | undefined,
  session: Partial<Omit<StudioDispatchSession, 'updatedAt'>>,
): string {
  const normalized = normalizeStudioNavigationPath(path);
  if (!normalized) return '';
  const url = new URL(normalized, 'https://studio.local');
  appendSearchParam(url.searchParams, 'studio_project_id', session.projectId);
  appendSearchParam(url.searchParams, 'dispatch_session_id', session.sessionId);
  appendSearchParam(url.searchParams, 'dispatch_target_id', session.targetId);
  appendSearchParam(url.searchParams, 'studio_page_id', session.pageId);
  appendSearchParam(url.searchParams, 'studio_return_path', session.studioReturnPath);
  return pathWithSearchAndHash(url);
}

export function getStudioReturnPath(session: Pick<StudioDispatchSession, 'projectId' | 'sessionId' | 'targetId' | 'studioReturnPath'>): string {
  const explicitReturnPath = normalizeStudioNavigationPath(session.studioReturnPath);
  if (explicitReturnPath && explicitReturnPath !== '/dreamy') return explicitReturnPath;
  const params = new URLSearchParams();
  appendSearchParam(params, 'project_id', session.projectId);
  appendSearchParam(params, 'dispatch_session_id', session.sessionId);
  appendSearchParam(params, 'target_id', session.targetId);
  const query = params.toString();
  return `/dreamy${query ? `?${query}` : ''}`;
}

export function readStudioDispatchSessionFromUrl(location: { pathname?: string; search?: string }): StudioDispatchSession | null {
  const params = new URLSearchParams(location.search || '');
  const projectId = params.get('studio_project_id') || params.get('project_id') || '';
  const sessionId = params.get('dispatch_session_id') || params.get('session_id') || '';
  const targetId = params.get('dispatch_target_id') || params.get('target_id') || '';
  if (!projectId && !sessionId && !targetId) return null;
  return {
    projectId,
    sessionId: sessionId || undefined,
    targetId: targetId || undefined,
    pageId: params.get('studio_page_id') || undefined,
    navigationPath: normalizeStudioNavigationPath(location.pathname || '') || undefined,
    studioReturnPath: params.get('studio_return_path') || undefined,
    updatedAt: new Date().toISOString(),
  };
}

export function stripStudioDispatchNavigationParams(location: { pathname?: string; search?: string; hash?: string }): string {
  const pathname = normalizeStudioNavigationPath(location.pathname || '') || '/';
  const params = new URLSearchParams(location.search || '');
  for (const key of STUDIO_DISPATCH_URL_PARAMS) {
    params.delete(key);
  }
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ''}${location.hash || ''}`;
}

export function saveStudioDispatchSession(session: Omit<StudioDispatchSession, 'updatedAt'>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      STUDIO_DISPATCH_SESSION_KEY,
      JSON.stringify({ ...session, updatedAt: new Date().toISOString() }),
    );
    notifyStudioSessionChanged();
  } catch {
    // Storage can be unavailable in embedded browsers; the dispatch still works.
  }
}

export function readStudioDispatchSession(): StudioDispatchSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STUDIO_DISPATCH_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StudioDispatchSession>;
    if (!parsed.projectId && !parsed.sessionId && !parsed.targetId && !parsed.pageId) return null;
    return {
      projectId: parsed.projectId || '',
      sessionId: parsed.sessionId,
      targetId: parsed.targetId,
      pageId: parsed.pageId,
      pageName: parsed.pageName,
      navigationPath: parsed.navigationPath,
      studioReturnPath: parsed.studioReturnPath,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function clearStudioDispatchSession(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STUDIO_DISPATCH_SESSION_KEY);
    notifyStudioSessionChanged();
  } catch {
    // Storage can be unavailable in embedded browsers; dismissal is best-effort.
  }
}
