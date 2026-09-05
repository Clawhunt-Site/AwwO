import { errorState } from './api.mjs';

// Own one controller per mounted workspace view. All retained data is in memory.
export function createWorkspaceState(api) {
  let epoch = 0;
  let pending;
  let state = { workspaceId: null, filters: { query: '', tags: [] }, cursor: null,
    selectedDocument: null, data: null, status: 'idle', error: null };
  const listeners = new Set();
  const snapshot = () => structuredClone(state);
  const emit = () => listeners.forEach(listener => listener(snapshot()));
  const cancel = () => { epoch++; pending?.abort(); pending = null; };
  const clearView = () => { state.cursor = null; state.selectedDocument = null; state.data = null; state.error = null; };
  function resetSession() {
    cancel(); api.clearSession?.(); state = { workspaceId: null, filters: { query: '', tags: [] }, cursor: null,
      selectedDocument: null, data: null, status: 'login', error: null }; emit();
  }
  return {
    snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    switchWorkspace(workspaceId) {
      cancel(); clearView(); state.workspaceId = workspaceId; state.status = 'idle'; emit();
      // Keep query/category/tags/collection exactly; server returns empty for invisible filters.
    },
    setFilters(filters) {
      cancel(); clearView(); state.filters = { ...state.filters, ...structuredClone(filters) }; state.status = 'idle'; emit();
    },
    selectDocument(documentId) { state.selectedDocument = documentId; emit(); },
    async search({ nextPage = false } = {}) {
      if (!state.workspaceId) return;
      cancel(); const current = epoch; pending = new AbortController();
      const cursor = nextPage ? state.cursor : null;
      state.data = null; state.status = 'loading'; state.error = null; emit();
      try {
        const data = await api.search(state.workspaceId, { ...state.filters, cursor }, { signal: pending.signal });
        if (current !== epoch) return;
        state.data = data; state.cursor = data.next_cursor; state.status = data.total ? 'ready' : 'empty'; emit();
        return structuredClone(data);
      } catch (error) {
        if (current !== epoch || error.name === 'AbortError') return;
        if (error.status === 401) { resetSession(); return; }
        state.error = errorState(error); state.data = null; state.status = state.error.kind;
        if (error.code === 'CURSOR_STALE') state.cursor = null;
        emit();
      }
    },
    resetSession,
    dispose() { cancel(); listeners.clear(); },
  };
}
