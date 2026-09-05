// CommandBar — ONE overlay in two modes, sharing the same list + keyboard machinery.
//
//   commands (⌘P): every canvas action, each row showing its keybinding, plus one focus row per
//                  tile so "focus tile by name" is just typing the name.
//   search   (⌘K): fuzzy over node titles, personas, form field labels/values, and any transcript
//                  text ALREADY LOADED in the session store.
//
// The honesty this component owns:
//
//  - SEARCH NEVER FETCHES. It reads the session store as it stands; a tile whose conversation has
//    not been loaded (or could not be read) is NOT searched, and the bar SAYS SO — both on the row
//    (when that node matched on some other field) and as a standing footer count. Silently
//    searching only the loaded tiles would tell the operator "no match" about text the product
//    never looked at, which is the exact class of lie this project bans. 'unreadable' is reported
//    separately from 'not loaded yet': "we failed to read it" is not "it hasn't loaded".
//  - A COMMAND THAT CANNOT RUN IS NOT OFFERED. Rows are built only for the actions the host
//    actually supplied, 运行 and 停止 swap by real run state, and a row with nothing to act on
//    (delete with an empty selection) renders disabled rather than as a dead click.
//  - Keybinding labels are HINTS the host can override (`keyHints`): the real bindings live in
//    the host's key handler, and this bar must not become a second source of truth that drifts
//    into displaying a shortcut that does nothing.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AgentKind, CanvasNode } from './canvasDoc';
import { getSnapshot, type NodeSession } from './sessions';
import { canvasText, useCanvasI18n } from './i18n';
import type { UiLocale } from '../locale';

export type CommandBarMode = 'commands' | 'search';

export type CanvasCommandId =
  | 'add-session-llm'
  | 'add-session-coding'
  | 'add-session-image'
  | 'add-form'
  | 'run'
  | 'stop'
  | 'fit'
  | 'timeline'
  | 'minimap'
  | 'waypoint-save'
  | 'waypoint-recall'
  | 'delete'
  | 'undo'
  | 'redo'
  | 'run-selection'
  | 'rerun-node';

/** Default keybinding HINTS. The host owns the real bindings and can override any of these. */
export const DEFAULT_KEY_HINTS: Record<CanvasCommandId, string> = {
  'add-session-llm': 'L',
  'add-session-coding': 'C',
  'add-session-image': 'I',
  'add-form': 'F',
  run: '⌘↵',
  stop: '⌘.',
  fit: '⇧F',
  timeline: 'T',
  minimap: 'M',
  'waypoint-save': '⌘1–9',
  'waypoint-recall': '1–9',
  delete: '⌫',
  undo: '⌘Z',
  redo: '⌘⇧Z',
  'run-selection': '⌘⇧↵',
  'rerun-node': 'R',
};

/** Every action the bar can offer. An omitted action's row is simply not rendered. */
export interface CanvasCommandActions {
  addSession?: (kind: AgentKind) => void;
  addForm?: () => void;
  run?: () => void;
  stop?: () => void;
  fitAll?: () => void;
  toggleTimeline?: () => void;
  toggleMinimap?: () => void;
  saveWaypoint?: () => void;
  recallWaypoint?: () => void;
  deleteSelection?: () => void;
  /** Run the selection and everything downstream of it, reusing upstream outputs. */
  runSelection?: () => void;
  /** Re-run exactly one node, reusing every upstream's stored output. */
  rerunNode?: () => void;
  /** Present but inert when there is nothing to step back to — see the delete row's note. */
  undo?: () => void;
  redo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
}

export interface CommandRow {
  id: string;
  label: string;
  /** Keybinding hint shown at the row's right edge. */
  keys?: string;
  /** Secondary line: a match snippet, or an honest note about what was NOT searched. */
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

export interface CommandBarProps {
  mode: CommandBarMode;
  nodes: ReadonlyArray<CanvasNode>;
  actions: CanvasCommandActions;
  /** Center + focus a tile (used by the focus rows and every search hit). */
  onFocusNode: (nodeId: string) => void;
  onClose: () => void;
  running?: boolean;
  timelineOpen?: boolean;
  minimapOpen?: boolean;
  selectionCount?: number;
  keyHints?: Partial<Record<CanvasCommandId, string>>;
  /** Transcript reader. Defaults to the module session store; injected in tests. */
  readSession?: (nodeId: string) => NodeSession;
  style?: CSSProperties;
}

/** Rows rendered at once. A canvas can hold thousands of tiles; the overflow is reported, never
 *  silently truncated. */
export const MAX_ROWS = 50;

const OVERLAY_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'flex-start',
  paddingTop: '12vh',
};

const PANEL_STYLE: CSSProperties = {
  width: 'min(620px, 92vw)',
  maxHeight: '68vh',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

// ---- pure matching -------------------------------------------------------------------------

/** Case-insensitive subsequence test ("fuzzy"). An empty needle matches everything. */
export function subsequenceMatch(hay: string, needle: string): boolean {
  if (!needle) return true;
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i += 1;
    if (i === n.length) return true;
  }
  return false;
}

/** Longest field length that is still fuzzy-matched. Beyond it a subsequence test matches almost
 *  any query, which would be noise dressed as a result — long text uses substring instead. */
export const FUZZY_MAX_LEN = 60;

export function matchField(text: string, query: string): boolean {
  if (!query) return false;
  if (!text) return false;
  if (text.toLowerCase().includes(query.toLowerCase())) return true;
  return text.length <= FUZZY_MAX_LEN && subsequenceMatch(text, query);
}

/** ±40 chars around the first substring hit (falls back to the head for a fuzzy-only match). */
export function snippetAround(text: string, query: string, radius = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = query ? flat.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return flat.slice(0, radius * 2) + (flat.length > radius * 2 ? '…' : '');
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + query.length + radius);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

export type SearchField = '标题' | '对话' | '人设' | '字段';

const SEARCH_FIELD_KEYS: Record<SearchField, 'command.fieldTitle' | 'command.fieldConversation' | 'command.fieldPersona' | 'command.fieldForm'> = {
  标题: 'command.fieldTitle', 对话: 'command.fieldConversation', 人设: 'command.fieldPersona', 字段: 'command.fieldForm',
};

export interface CanvasSearchHit {
  nodeId: string;
  title: string;
  field: SearchField;
  snippet: string;
  /** Set when THIS node's transcript was not part of the search — never left implicit. */
  historyNote: string | null;
}

export interface CanvasSearchResult {
  hits: CanvasSearchHit[];
  /** Session nodes whose transcript has not been loaded (or is still loading). */
  notLoaded: number;
  /** Session nodes whose transcript could NOT be read — a different fact from "not loaded". */
  unreadable: number;
}

function historyNoteFor(session: NodeSession, locale: UiLocale): string | null {
  if (session.history === 'loaded') return null;
  if (session.history === 'unreadable') return canvasText(locale, 'command.historyUnreadable');
  return canvasText(locale, 'command.historyNotLoaded');
}

/**
 * Search the graph. `read` supplies each session node's store snapshot; ONLY a 'loaded' history
 * contributes transcript text. One hit per node (field priority 标题 → 对话 → 人设 → 字段) so the
 * list stays a list of tiles, and every hit carries the honest note about its own transcript.
 */
export function searchCanvas(
  nodes: ReadonlyArray<CanvasNode>,
  query: string,
  read: (nodeId: string) => NodeSession,
  locale: UiLocale = 'zh',
): CanvasSearchResult {
  const q = query.trim();
  const result: CanvasSearchResult = { hits: [], notLoaded: 0, unreadable: 0 };
  if (!q) return result;
  for (const node of nodes) {
    const session = node.kind === 'session' ? read(node.id) : null;
    if (session) {
      if (session.history === 'unreadable') result.unreadable += 1;
      else if (session.history !== 'loaded') result.notLoaded += 1;
    }
    const note = session ? historyNoteFor(session, locale) : null;
    const push = (field: SearchField, text: string) => {
      result.hits.push({ nodeId: node.id, title: node.title, field, snippet: snippetAround(text, q), historyNote: note });
    };

    if (matchField(node.title, q)) {
      push('标题', node.title);
      continue;
    }
    if (session && session.history === 'loaded') {
      const turn = session.turns.find((t) => matchField(t.text, q));
      if (turn) {
        push('对话', turn.text);
        continue;
      }
    }
    if (node.kind === 'session') {
      if (matchField(node.persona, q)) {
        push('人设', node.persona);
        continue;
      }
    } else {
      const field = node.fields.find((f) => matchField(f.label, q) || matchField(f.value, q));
      if (field) {
        push('字段', `${field.label}: ${field.value}`);
        continue;
      }
    }
  }
  return result;
}

// ---- command rows --------------------------------------------------------------------------

export interface CommandContext {
  running: boolean;
  timelineOpen: boolean;
  minimapOpen: boolean;
  selectionCount: number;
}

/** Build the fixed command rows for the actions the host actually supplied. Pure + exported. */
export function buildCommandRows(
  actions: CanvasCommandActions,
  ctx: CommandContext,
  keyHints: Partial<Record<CanvasCommandId, string>> = {},
  locale: UiLocale = 'zh',
): CommandRow[] {
  const key = (id: CanvasCommandId) => keyHints[id] ?? DEFAULT_KEY_HINTS[id];
  const text = (key: Parameters<typeof canvasText>[1], values?: Record<string, string | number>) => canvasText(locale, key, values);
  const kindLabel = (kind: AgentKind) => text(kind === 'coding' ? 'node.coding' : kind === 'image' ? 'node.image' : 'node.llm');
  const rows: CommandRow[] = [];
  if (actions.addSession) {
    (['llm', 'coding', 'image'] as AgentKind[]).forEach((kind) => {
      rows.push({
        id: `add-session-${kind}`,
        label: text('command.addSession', { type: kindLabel(kind) }),
        keys: key(`add-session-${kind}` as CanvasCommandId),
        run: () => actions.addSession!(kind),
      });
    });
  }
  if (actions.addForm) {
    rows.push({ id: 'add-form', label: text('command.addForm'), keys: key('add-form'), run: actions.addForm });
  }
  // 运行 / 停止 swap by REAL run state — never both, never a run button during a run.
  if (!ctx.running && actions.run) {
    rows.push({ id: 'run', label: text('command.run'), keys: key('run'), run: actions.run });
  }
  if (ctx.running && actions.stop) {
    rows.push({ id: 'stop', label: text('command.stop'), keys: key('stop'), run: actions.stop });
  }
  if (actions.fitAll) {
    rows.push({ id: 'fit', label: text('command.fit'), keys: key('fit'), run: actions.fitAll });
  }
  if (actions.toggleTimeline) {
    rows.push({
      id: 'timeline',
      label: text(ctx.timelineOpen ? 'command.hideTimeline' : 'command.showTimeline'),
      keys: key('timeline'),
      run: actions.toggleTimeline,
    });
  }
  if (actions.toggleMinimap) {
    rows.push({
      id: 'minimap',
      label: text(ctx.minimapOpen ? 'command.hideMinimap' : 'command.showMinimap'),
      keys: key('minimap'),
      run: actions.toggleMinimap,
    });
  }
  if (actions.saveWaypoint) {
    rows.push({ id: 'waypoint-save', label: text('command.saveWaypoint'), keys: key('waypoint-save'), run: actions.saveWaypoint });
  }
  if (actions.recallWaypoint) {
    rows.push({ id: 'waypoint-recall', label: text('command.recallWaypoint'), keys: key('waypoint-recall'), run: actions.recallWaypoint });
  }
  if (actions.deleteSelection) {
    rows.push({
      id: 'delete',
      label: text('command.deleteSelection', { count: ctx.selectionCount }),
      keys: key('delete'),
      // Offered but inert with an empty selection: hiding it would make the operator wonder
      // whether the canvas can delete at all.
      disabled: ctx.selectionCount === 0,
      hint: ctx.selectionCount === 0 ? text('command.noSelection') : undefined,
      run: actions.deleteSelection,
    });
  }
  // Undo/redo are always LISTED once the surface supports them, disabled when the stack is empty:
  // the palette is where an operator learns what the canvas can do, and a canvas that silently
  // omits undo reads as a canvas that has none.
  // Scoped runs are the iteration loop: look at an output, adjust one node, carry it forward
  // without paying for the work above it again. They are listed next to 运行图 rather than hidden,
  // because an operator who cannot find them will keep re-running the whole canvas.
  if (actions.runSelection) {
    rows.push({
      id: 'run-selection',
      label: text('command.runSelection', { count: ctx.selectionCount }),
      keys: key('run-selection'),
      disabled: ctx.selectionCount === 0 || ctx.running,
      hint: ctx.selectionCount === 0 ? text('command.noSelection') : ctx.running ? text('command.running') : undefined,
      run: actions.runSelection,
    });
  }
  if (actions.rerunNode) {
    rows.push({
      id: 'rerun-node',
      label: text('command.rerunNode'),
      keys: key('rerun-node'),
      disabled: ctx.selectionCount !== 1 || ctx.running,
      hint:
        ctx.selectionCount !== 1
          ? text('command.selectOne')
          : ctx.running
            ? text('command.running')
            : text('command.reuseUpstream'),
      run: actions.rerunNode,
    });
  }
  if (actions.undo) {
    rows.push({
      id: 'undo',
      label: text('command.undo'),
      keys: key('undo'),
      disabled: actions.canUndo === false,
      hint: actions.canUndo === false ? text('command.noUndo') : undefined,
      run: actions.undo,
    });
  }
  if (actions.redo) {
    rows.push({
      id: 'redo',
      label: text('command.redo'),
      keys: key('redo'),
      disabled: actions.canRedo === false,
      hint: actions.canRedo === false ? text('command.noRedo') : undefined,
      run: actions.redo,
    });
  }
  return rows;
}

/**
 * Next ENABLED row index, wrapping. Returns -1 when no row is selectable — never a fallback to
 * row 0, which would draw a highlight on a row that Enter then refuses to run.
 * A `from` outside the list starts at the near end for that direction.
 */
export function stepActive(rows: ReadonlyArray<CommandRow>, from: number, step: 1 | -1): number {
  if (rows.length === 0) return -1;
  const start = from >= 0 && from < rows.length ? from : step === 1 ? -1 : rows.length;
  let index = start;
  for (let i = 0; i < rows.length; i += 1) {
    index = (index + step + rows.length) % rows.length;
    if (!rows[index]?.disabled) return index;
  }
  return -1;
}

/** First selectable row, or -1 when every row is disabled. */
function firstEnabled(rows: ReadonlyArray<CommandRow>): number {
  return rows.findIndex((r) => !r.disabled);
}

// ---- component -----------------------------------------------------------------------------

export function CommandBar({
  mode,
  nodes,
  actions,
  onFocusNode,
  onClose,
  running = false,
  timelineOpen = false,
  minimapOpen = false,
  selectionCount = 0,
  keyHints,
  readSession = getSnapshot,
  style,
}: CommandBarProps) {
  const { locale, t } = useCanvasI18n();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const search = useMemo(
    () => (mode === 'search' ? searchCanvas(nodes, query, readSession, locale) : null),
    [mode, nodes, query, readSession, locale],
  );

  const rows: CommandRow[] = useMemo(() => {
    if (mode === 'search') {
      return (search?.hits ?? []).map((hit) => ({
        id: `hit-${hit.nodeId}`,
        label: hit.title,
        // The note rides ON the row: a node that matched on its title while its transcript was
        // never loaded must not read as "searched, matched on title, nothing else there".
        hint: [t('command.hit', { field: t(SEARCH_FIELD_KEYS[hit.field]), snippet: hit.snippet }), hit.historyNote].filter(Boolean).join(' · '),
        run: () => onFocusNode(hit.nodeId),
      }));
    }
    const commands = buildCommandRows(
      actions,
      { running, timelineOpen, minimapOpen, selectionCount },
      keyHints,
      locale,
    );
    const focusRows: CommandRow[] = nodes.map((n) => ({
      id: `focus-${n.id}`,
      label: t('command.focusNode', { title: n.title }),
      hint: n.kind === 'session' ? t(n.agentKind === 'coding' ? 'node.coding' : n.agentKind === 'image' ? 'node.image' : 'node.llm') : t('node.form'),
      run: () => onFocusNode(n.id),
    }));
    const all = [...commands, ...focusRows];
    const q = query.trim();
    return q ? all.filter((r) => matchField(r.label, q)) : all;
  }, [
    mode,
    search,
    actions,
    running,
    timelineOpen,
    minimapOpen,
    selectionCount,
    keyHints,
    nodes,
    query,
    onFocusNode,
    locale,
    t,
  ]);

  const shown = rows.slice(0, MAX_ROWS);
  const overflow = rows.length - shown.length;

  // The highlight is DERIVED, not just stored: if the list shrank or the row under the stored
  // index became disabled (the run finished, the selection emptied), fall back to the first
  // selectable row. Enter must always fire exactly the row that is drawn highlighted — a stored
  // index pointing past the end would either do nothing or, worse, point at a row the operator
  // never saw highlighted.
  const activeIndex =
    active >= 0 && active < shown.length && !shown[active]?.disabled ? active : firstEnabled(shown);

  // Typing (or switching modes) restarts the highlight at the top of the new list.
  useEffect(() => setActive(0), [mode, query]);
  useEffect(() => inputRef.current?.focus(), [mode]);

  // Keyboard: captured at the document so the keys work regardless of what inside the overlay
  // holds focus. Registered per rows/active identity and ALWAYS removed on unmount — a leaked
  // listener would keep answering keys for a bar that is no longer on screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        // Focus trap: nothing behind the overlay is reachable while it is open.
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        // Step from the DERIVED index (what is drawn), not the stored one.
        setActive(stepActive(shown, activeIndex, e.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (e.key === 'Enter') {
        const row = shown[activeIndex];
        if (!row || row.disabled) return;
        e.preventDefault();
        row.run();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [shown, activeIndex, onClose]);

  // Focus trap (pointer/programmatic): pull focus back if it escapes the panel.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const panel = panelRef.current;
      if (panel && e.target instanceof Node && !panel.contains(e.target)) inputRef.current?.focus();
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  const placeholder = t(mode === 'search' ? 'command.searchPlaceholder' : 'command.placeholder');

  return (
    <div
      className="canvas-cmdbar-overlay"
      style={{ ...OVERLAY_STYLE, ...style }}
      onPointerDown={(e) => {
        // A click on the backdrop dismisses; a click inside the panel must not.
        if (e.target === e.currentTarget) onClose();
        e.stopPropagation();
      }}
    >
      <div
        ref={panelRef}
        className="canvas-cmdbar"
        role="dialog"
        aria-modal="true"
        aria-label={t(mode === 'search' ? 'command.searchCanvas' : 'command.palette')}
        style={PANEL_STYLE}
      >
        <input
          ref={inputRef}
          className="canvas-cmdbar-input"
          role="combobox"
          aria-expanded
          aria-controls="canvas-cmdbar-list"
          aria-label={t(mode === 'search' ? 'command.searchCanvas' : 'command.palette')}
          placeholder={placeholder}
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div id="canvas-cmdbar-list" className="canvas-cmdbar-list" role="listbox">
          {shown.map((row, index) => (
            <div
              key={row.id}
              role="option"
              aria-selected={index === activeIndex}
              aria-disabled={row.disabled || undefined}
              data-testid={`cmdbar-row-${row.id}`}
              className={`canvas-cmdbar-row${index === activeIndex ? ' is-active' : ''}${row.disabled ? ' is-disabled' : ''}`}
              onPointerMove={() => {
                if (!row.disabled) setActive(index);
              }}
              onClick={() => {
                if (row.disabled) return;
                row.run();
                onClose();
              }}
            >
              <span className="canvas-cmdbar-row-label">{row.label}</span>
              {row.hint ? <span className="canvas-cmdbar-row-hint">{row.hint}</span> : null}
              {row.keys ? <kbd className="canvas-cmdbar-row-keys">{row.keys}</kbd> : null}
            </div>
          ))}
          {shown.length === 0 ? (
            <div className="canvas-cmdbar-empty">
              {t(mode === 'search' && !query.trim() ? 'command.startSearch' : 'command.noMatches')}
            </div>
          ) : null}
        </div>
        <footer className="canvas-cmdbar-foot">
          {overflow > 0 ? <span className="canvas-cmdbar-note">{t('command.overflow', { count: overflow })}</span> : null}
          {/* Standing honesty line: what the search could NOT look at. */}
          {mode === 'search' && search && search.notLoaded > 0 ? (
            <span className="canvas-cmdbar-note canvas-cmdbar-note--warn">
              {t('command.notLoaded', { count: search.notLoaded })}
            </span>
          ) : null}
          {mode === 'search' && search && search.unreadable > 0 ? (
            <span className="canvas-cmdbar-note canvas-cmdbar-note--err">
              {t('command.unreadable', { count: search.unreadable })}
            </span>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
