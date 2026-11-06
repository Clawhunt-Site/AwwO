// Canvas keybindings (session-canvas rebuild).
//
// The interaction vocabulary is ported from termcanvas's spatial model — focus toggle, tile
// cycling, waypoints, palette, search — mapped onto OUR objects (a tile is an agent session,
// not a terminal). Only the interaction ideas are borrowed; no upstream code.
//
// Two rules govern everything here:
//  1. A key never fires while the operator is TYPING. Tiles contain live composers and the
//     inspector is a form; stealing Delete or Escape from a textarea would destroy work.
//  2. The bindings are DECLARED, not just handled — `canvasKeyBindings` is exported so the
//     command palette and the settings show the same truth the listener enforces (a palette that
//     lies about a shortcut is worse than one that shows none).

import { useEffect, useMemo, useRef } from 'react';
import type { CanvasCommandId } from './CommandBar';

export type CanvasKeyAction =
  | 'focus-toggle'
  | 'cycle-next'
  | 'cycle-prev'
  | 'palette'
  | 'search'
  | 'fit-all'
  | 'delete-selection'
  | 'escape'
  | 'save-waypoint'
  | 'recall-waypoint'
  | 'undo'
  | 'redo'
  | 'converge-toggle';

export interface CanvasKeyBinding {
  action: CanvasKeyAction;
  /** Human-readable hint shown in the palette and the settings, as this platform writes it (formatChord). */
  hint: string;
  label: string;
}

const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');

/**
 * A chord with Ctrl/⌘ (`mod`) and Shift as the platform writes it: on a Mac the glyphs with nothing between them
 * (⌘⇧Z, in the order this table has always shown), elsewhere the key names joined by + (Ctrl+Shift+Z), as the app
 * writes Shift+Enter. On a Mac the listener takes Ctrl as well as ⌘, so a Mac taken for another platform still reads
 * keys that work (the other way round, ⌘ would name the Windows key, which Windows keeps for itself).
 */
export function formatChord(key: string, { mod = false, shift = false }: { mod?: boolean; shift?: boolean } = {},
  mac = isMacPlatform()): string {
  if (mac) return `${mod ? '⌘' : ''}${shift ? '⇧' : ''}${key}`;
  return [mod ? 'Ctrl' : '', shift ? 'Shift' : '', key].filter(Boolean).join('+');
}

/** Binding table, each hint as this platform writes it (formatChord). */
export function canvasKeyBindings(mac = isMacPlatform()): CanvasKeyBinding[] {
  const mod = (key: string, shift = false) => formatChord(key, { mod: true, shift }, mac);
  return [
    { action: 'focus-toggle', hint: mod('E'), label: '聚焦 / 退出聚焦' },
    { action: 'cycle-next', hint: mod(']'), label: '下一个节点' },
    { action: 'cycle-prev', hint: mod('['), label: '上一个节点' },
    { action: 'palette', hint: mod('P'), label: '命令面板' },
    { action: 'search', hint: mod('K'), label: '搜索画布' },
    { action: 'fit-all', hint: mod('0'), label: '适应全部' },
    { action: 'converge-toggle', hint: mod('G'), label: '收敛成一个图标 / 展开全部组件' },
    { action: 'delete-selection', hint: 'Delete', label: '删除所选' },
    { action: 'undo', hint: mod('Z'), label: '撤销' },
    { action: 'redo', hint: mod('Z', true), label: '重做' },
    { action: 'save-waypoint', hint: mod('1–9', true), label: '保存路标' },
    { action: 'recall-waypoint', hint: mod('1–9'), label: '回到路标' },
    { action: 'escape', hint: 'Esc', label: '退出聚焦 / 关闭浮层' },
  ];
}

export interface CanvasKeyHandlers {
  onFocusToggle?: () => void;
  onCycle?: (dir: 1 | -1) => void;
  onPalette?: () => void;
  onSearch?: () => void;
  onFitAll?: () => void;
  onDeleteSelection?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onEscape?: () => void;
  onSaveWaypoint?: (slot: number) => void;
  onRecallWaypoint?: (slot: number) => void;
  /** ⌘G: the whole canvas drawn as one live icon, or as its cards again. */
  onConvergeToggle?: () => void;
}

/** Is the event aimed at something the operator is typing into? */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/**
 * Bind the canvas keyboard layer for as long as the component is mounted.
 *
 * Escape is the ONE key allowed through from a typing target — it is how an operator gets out
 * of a composer — but it is then reported as a plain escape so the surface can decide (blur the
 * field, or unwind focus) rather than this hook guessing.
 */
export function useCanvasKeys(handlers: CanvasKeyHandlers, enabled = true): CanvasKeyBinding[] {
  // Handlers change identity every render; read them through a ref so the listener binds once.
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const h = ref.current;
      const typing = isTypingTarget(e.target);

      if (e.key === 'Escape') {
        // Allowed from anywhere — including a composer — because it is the escape hatch.
        h.onEscape?.();
        return;
      }
      if (typing) return; // every binding below would otherwise eat real typing

      const mod = e.metaKey || e.ctrlKey;

      if (!mod) {
        if ((e.key === 'Delete' || e.key === 'Backspace') && h.onDeleteSelection) {
          e.preventDefault();
          h.onDeleteSelection();
        }
        return;
      }

      // Digits: ⌘⇧1-9 saves a waypoint, ⌘1-9 recalls it. e.code is used rather than e.key
      // because Shift rewrites the printed character on most layouts (⌘⇧1 arrives as '!').
      const digitMatch = /^Digit([1-9])$/.exec(e.code || '');
      if (digitMatch) {
        const slot = Number(digitMatch[1]);
        if (e.shiftKey) {
          if (h.onSaveWaypoint) {
            e.preventDefault();
            h.onSaveWaypoint(slot);
          }
        } else if (h.onRecallWaypoint) {
          e.preventDefault();
          h.onRecallWaypoint(slot);
        }
        return;
      }
      if ((e.code === 'Digit0' || e.key === '0') && h.onFitAll) {
        e.preventDefault();
        h.onFitAll();
        return;
      }

      switch (e.key.toLowerCase()) {
        // ⌘Z undo, ⌘⇧Z (and ⌘Y, the Windows habit) redo. preventDefault always, even when the
        // handler is absent: letting the browser's own undo reach a canvas would edit whatever
        // input it last touched, which is worse than doing nothing.
        case 'z':
          e.preventDefault();
          if (e.shiftKey) h.onRedo?.();
          else h.onUndo?.();
          break;
        case 'y':
          e.preventDefault();
          h.onRedo?.();
          break;
        case 'e':
          if (!h.onFocusToggle) return;
          e.preventDefault();
          h.onFocusToggle();
          break;
        case 'p':
          if (!h.onPalette) return;
          e.preventDefault(); // browser print
          h.onPalette();
          break;
        case 'k':
          if (!h.onSearch) return;
          e.preventDefault(); // browser search bar focus
          h.onSearch();
          break;
        case ']':
          if (!h.onCycle) return;
          e.preventDefault();
          h.onCycle(1);
          break;
        case '[':
          if (!h.onCycle) return;
          e.preventDefault();
          h.onCycle(-1);
          break;
        case 'g':
          // The browser's find-next on this page, as design tools take it; never while typing (checked above). Held
          // down, it toggles once: a key repeat would flap the board between the icon and the cards.
          if (!h.onConvergeToggle || e.shiftKey) return;
          e.preventDefault();
          if (!e.repeat) h.onConvergeToggle();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);

  return useMemo(() => canvasKeyBindings(), []);
}

/** The command palette's ids for the actions this table names otherwise (a type-only import: no runtime cycle). */
const PALETTE_IDS: Partial<Record<CanvasKeyAction, CanvasCommandId>> = {
  'fit-all': 'fit',
  'delete-selection': 'delete',
  'save-waypoint': 'waypoint-save',
  'recall-waypoint': 'waypoint-recall',
};

/**
 * Palette hint map: action → printable shortcut, for CommandBar's keyHints, also under the palette's id where it
 * names the action otherwise. The palette shows no key of its own, so a row whose action has none here shows none.
 */
export function keyHintMap(bindings: ReadonlyArray<CanvasKeyBinding>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const b of bindings) {
    map[b.action] = b.hint;
    const id = PALETTE_IDS[b.action];
    if (id) map[id] = b.hint;
  }
  return map;
}
