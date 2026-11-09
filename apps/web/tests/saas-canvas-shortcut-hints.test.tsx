// The canvas's shortcut hints name keys that work, as each platform writes them (2026-11-06). Off a Mac they read
// Ctrl+G and Ctrl+Shift+Z (they read CtrlG and Ctrl⇧Z), a Mac keeps ⌘G and ⌘⇧Z, and the command palette shows only
// the keys the canvas binds: its own defaults named ⌘↵, ⌘., ⇧F and single letters that nothing bound, Mac glyphs on
// Windows, and the wrong chords for its two viewpoint rows.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { buildCommandRows, CommandBar, type CanvasCommandActions } from '../src/canvas/CommandBar';
import {
  canvasKeyBindings, formatChord, keyHintMap, useCanvasKeys, type CanvasKeyAction, type CanvasKeyHandlers,
} from '../src/canvas/useCanvasKeys';

afterEach(cleanup);

const MAC = ['⌘E', '⌘]', '⌘[', '⌘P', '⌘K', '⌘0', '⌘G', 'Delete', '⌘Z', '⌘⇧Z', '⌘⇧1–9', '⌘1–9', 'Esc'];
const ELSEWHERE = ['Ctrl+E', 'Ctrl+]', 'Ctrl+[', 'Ctrl+P', 'Ctrl+K', 'Ctrl+0', 'Ctrl+G', 'Delete', 'Ctrl+Z', 'Ctrl+Shift+Z',
  'Ctrl+Shift+1–9', 'Ctrl+1–9', 'Esc'];

describe('formatChord', () => {
  it('writes a Mac chord in its glyphs and any other as key names joined by +', () => {
    expect(formatChord('G', { mod: true }, true)).toBe('⌘G');
    expect(formatChord('Z', { mod: true, shift: true }, true)).toBe('⌘⇧Z');
    expect(formatChord('G', { mod: true }, false)).toBe('Ctrl+G');
    expect(formatChord('Z', { mod: true, shift: true }, false)).toBe('Ctrl+Shift+Z');
    expect(formatChord('Enter', { shift: true }, false)).toBe('Shift+Enter');
    expect(formatChord('Delete', {}, false)).toBe('Delete');
    expect(formatChord('Delete', {}, true)).toBe('Delete');
  });
});

describe('the binding table', () => {
  it('keeps the Mac hints', () => {
    expect(canvasKeyBindings(true).map(binding => binding.hint)).toEqual(MAC);
  });

  it('writes every other platform\'s hints as Windows does, with no Mac glyph', () => {
    const hints = canvasKeyBindings(false).map(binding => binding.hint);
    expect(hints).toEqual(ELSEWHERE);
    for (const hint of hints) expect(hint).not.toMatch(/[⌘⇧⌥⌃↵↩⌫]/);
  });

  it('takes the platform the browser reports', () => {
    expect(canvasKeyBindings().map(binding => binding.hint)).toEqual(ELSEWHERE); // jsdom's platform is no Mac
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
    try {
      expect(canvasKeyBindings().map(binding => binding.hint)).toEqual(MAC);
    } finally {
      Reflect.deleteProperty(navigator, 'platform');
    }
    expect(canvasKeyBindings().map(binding => binding.hint)).toEqual(ELSEWHERE);
  });
});

/** Each binding's key as the listener takes it, the handler it calls and that handler's arguments. */
const PRESSES: Array<[CanvasKeyAction, KeyboardEventInit, keyof CanvasKeyHandlers, unknown[]]> = [
  ['focus-toggle', { key: 'e', code: 'KeyE', ctrlKey: true }, 'onFocusToggle', []],
  ['cycle-next', { key: ']', code: 'BracketRight', ctrlKey: true }, 'onCycle', [1]],
  ['cycle-prev', { key: '[', code: 'BracketLeft', ctrlKey: true }, 'onCycle', [-1]],
  ['palette', { key: 'p', code: 'KeyP', ctrlKey: true }, 'onPalette', []],
  ['search', { key: 'k', code: 'KeyK', ctrlKey: true }, 'onSearch', []],
  ['fit-all', { key: '0', code: 'Digit0', ctrlKey: true }, 'onFitAll', []],
  ['converge-toggle', { key: 'g', code: 'KeyG', ctrlKey: true }, 'onConvergeToggle', []],
  ['delete-selection', { key: 'Delete', code: 'Delete' }, 'onDeleteSelection', []],
  ['undo', { key: 'z', code: 'KeyZ', ctrlKey: true }, 'onUndo', []],
  ['redo', { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }, 'onRedo', []],
  ['save-waypoint', { key: '(', code: 'Digit9', ctrlKey: true, shiftKey: true }, 'onSaveWaypoint', [9]],
  ['recall-waypoint', { key: '1', code: 'Digit1', ctrlKey: true }, 'onRecallWaypoint', [1]],
  // Escape hands its event over: the canvas leaves following alone for a key something else took (defaultPrevented).
  ['escape', { key: 'Escape', code: 'Escape' }, 'onEscape', [expect.any(KeyboardEvent)]],
];
const HANDLERS: Array<keyof CanvasKeyHandlers> = ['onFocusToggle', 'onCycle', 'onPalette', 'onSearch', 'onFitAll',
  'onDeleteSelection', 'onUndo', 'onRedo', 'onEscape', 'onSaveWaypoint', 'onRecallWaypoint', 'onConvergeToggle'];

function Keys({ handlers }: { handlers: CanvasKeyHandlers }) {
  useCanvasKeys(handlers);
  return null;
}

describe('every hint names a key that works', () => {
  it('presses a key for every binding the table shows (the listener also takes Ctrl+Y and Backspace, unshown)', () => {
    expect(canvasKeyBindings(false).map(binding => binding.action)).toEqual(PRESSES.map(([action]) => action));
  });

  it.each(PRESSES)('%s: the key its hint names calls its handler and no other, with Ctrl and with ⌘', (action, init, handler, args) => {
    // A Ctrl chord's Mac hint names ⌘: press it both ways.
    for (const press of init.ctrlKey ? [init, { ...init, ctrlKey: false, metaKey: true }] : [init]) {
      const handlers = Object.fromEntries(HANDLERS.map(name => [name, vi.fn()])) as unknown as Record<keyof CanvasKeyHandlers, ReturnType<typeof vi.fn>>;
      const { unmount } = render(<Keys handlers={handlers as CanvasKeyHandlers} />);
      fireEvent.keyDown(window, press);
      expect(handlers[handler], JSON.stringify(press)).toHaveBeenCalledTimes(1);
      expect(handlers[handler]).toHaveBeenCalledWith(...args);
      for (const other of HANDLERS) if (other !== handler) expect(handlers[other], `${action} also called ${other}`).not.toHaveBeenCalled();
      unmount();
    }
  });

  it.each(PRESSES)('%s: the hint off a Mac spells that very key', (action, init) => {
    const hint = canvasKeyBindings(false).find(binding => binding.action === action)?.hint ?? '';
    const parts = hint.split('+');
    const key = parts[parts.length - 1];
    expect(parts.includes('Ctrl'), hint).toBe(Boolean(init.ctrlKey));
    expect(parts.includes('Shift'), hint).toBe(Boolean(init.shiftKey));
    expect(parts.length, hint).toBe(1 + Number(Boolean(init.ctrlKey)) + Number(Boolean(init.shiftKey)));
    const spelt = key === 'Esc' ? init.key === 'Escape'
      : key === '1–9' ? /^Digit[1-9]$/.test(init.code ?? '')
        : /^[A-Z]$/.test(key) ? init.code === `Key${key}`
          : /^[0-9]$/.test(key) ? init.code === `Digit${key}`
            : init.key === key;
    expect(spelt, `${hint} for ${JSON.stringify(init)}`).toBe(true);
  });
});

const EVERY_ACTION: CanvasCommandActions = {
  addSession: vi.fn(), addForm: vi.fn(), run: vi.fn(), stop: vi.fn(), fitAll: vi.fn(), toggleTimeline: vi.fn(),
  toggleMinimap: vi.fn(), saveWaypoint: vi.fn(), recallWaypoint: vi.fn(), deleteSelection: vi.fn(), runSelection: vi.fn(),
  rerunNode: vi.fn(), toggleConverged: vi.fn(), converged: false, canConverge: true, undo: vi.fn(), redo: vi.fn(),
  canUndo: true, canRedo: true,
};
const IDLE = { running: false, timelineOpen: false, minimapOpen: false, selectionCount: 1 };
const RUNNING = { ...IDLE, running: true };
/** The rows the canvas binds a key to, with their keys. */
const PALETTE_ELSEWHERE = {
  fit: 'Ctrl+0', 'converge-toggle': 'Ctrl+G', 'waypoint-save': 'Ctrl+Shift+1–9', 'waypoint-recall': 'Ctrl+1–9',
  delete: 'Delete', undo: 'Ctrl+Z', redo: 'Ctrl+Shift+Z',
};
const PALETTE_MAC = {
  fit: '⌘0', 'converge-toggle': '⌘G', 'waypoint-save': '⌘⇧1–9', 'waypoint-recall': '⌘1–9', delete: 'Delete', undo: '⌘Z',
  redo: '⌘⇧Z',
};
/** Rows the canvas binds no key to: they show none. */
const NO_KEY = ['add-session-llm', 'add-session-coding', 'add-session-image', 'add-form', 'run', 'stop', 'timeline',
  'minimap', 'run-selection', 'rerun-node'];

describe('the command palette', () => {
  it.each([[false, PALETTE_ELSEWHERE], [true, PALETTE_MAC]])('shows a key only on a row whose action the canvas binds (Mac %s)', (mac, want) => {
    const hints = keyHintMap(canvasKeyBindings(mac));
    const rows = [...buildCommandRows(EVERY_ACTION, IDLE, hints), ...buildCommandRows(EVERY_ACTION, RUNNING, hints)];
    expect(Object.fromEntries(rows.filter(row => row.keys).map(row => [row.id, row.keys]))).toEqual(want);
    for (const id of NO_KEY) {
      const row = rows.find(item => item.id === id);
      expect(row, id).toBeDefined();
      expect(row?.keys, id).toBeUndefined();
    }
  });

  it('shows no key of its own', () => {
    expect(buildCommandRows(EVERY_ACTION, IDLE).filter(row => row.keys)).toEqual([]);
    expect(buildCommandRows(EVERY_ACTION, RUNNING).filter(row => row.keys)).toEqual([]);
  });

  it('draws each row\'s own key off a Mac, with no Mac glyph', () => {
    render(<CommandBar mode="commands" nodes={[]} actions={EVERY_ACTION} selectionCount={1} onFocusNode={() => undefined}
      onClose={() => undefined} keyHints={keyHintMap(canvasKeyBindings(false))} />);
    const drawn = Object.fromEntries([...document.querySelectorAll('[data-testid^="cmdbar-row-"]')]
      .filter(row => row.querySelector('.canvas-cmdbar-row-keys'))
      .map(row => [row.getAttribute('data-testid')!.slice('cmdbar-row-'.length), row.querySelector('.canvas-cmdbar-row-keys')!.textContent ?? '']));
    expect(drawn).toEqual(PALETTE_ELSEWHERE);
    for (const text of Object.values(drawn)) expect(text).not.toMatch(/[⌘⇧↵⌫]/);
  });

  it('keeps a chord on one line', () => {
    // vitest runs with cwd = apps/web.
    const css = readFileSync(resolve(process.cwd(), 'src/canvas/canvas.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.canvas-cmdbar-row-keys\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toMatch(/white-space:\s*nowrap/);
  });
});
