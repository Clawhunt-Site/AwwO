// 普通用户模式 / 开发者模式 and the card frames: a mode changes only what is shown, and a card's size is a view
// preference beside the canvas cache (never in the document), so it can change while a run holds the document.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CanvasUiModeProvider, UI_MODE_STORAGE_KEY, isUiMode, readUiMode, setDefaultUiMode, writeUiMode } from '../src/canvas/uiMode';
import { CARD_FRAMES_KEY, CARD_MAX, CARD_PREVIEW_DEFAULT, clampCard, loadCardFrames, saveCardFrames, showsPreview } from '../src/canvas/cardFrames';
import { canvasStorageKey } from '../src/canvas/canvasStorage';
import { COMPACT_SESSION_SIZE } from '../src/canvas/nodePresentation';
import { CANVAS_STORAGE_KEY, createFormNode, createSessionNode, type CanvasDocument } from '../src/canvas/canvasDoc';
import { resetAllSessions } from '../src/canvas/sessions';

class SilentResizeObserver { observe() {} unobserve() {} disconnect() {} }

function seed(): CanvasDocument {
  const form = { ...createFormNode({ x: 0, y: 0 }), id: 'f1', title: '需求表单' };
  const agent = { ...createSessionNode('llm', { x: 600, y: 0 }), id: 's1', title: '文案' };
  return { version: 2, updatedAt: 1, nodes: [form, agent],
    edges: [{ id: 'f1:data->s1:context', fromNode: 'f1', fromPort: 'data', toNode: 's1', toPort: 'context', dataType: 'text' }],
    waypoints: [], view: { x: 0, y: 0, scale: 1 } };
}

beforeEach(() => {
  cleanup(); resetAllSessions(); localStorage.clear(); vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', SilentResizeObserver);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed()));
});
afterEach(() => { setDefaultUiMode('developer'); });

describe('ui mode', () => {
  it('defaults to the product choice, and a saved choice wins', () => {
    setDefaultUiMode('simple');
    expect(readUiMode()).toBe('simple');
    writeUiMode('developer');
    expect(localStorage.getItem(UI_MODE_STORAGE_KEY)).toBe('developer');
    expect(readUiMode()).toBe('developer');
    localStorage.setItem(UI_MODE_STORAGE_KEY, 'bogus');
    expect(readUiMode()).toBe('simple');
    expect(isUiMode('simple')).toBe(true);
    expect(isUiMode('admin')).toBe(false);
    const broken = { getItem: () => { throw new Error('denied'); } };
    expect(readUiMode(broken)).toBe('simple');
  });

  it('simple mode keeps the chat and the model, and hides wiring, ports and configuration', () => {
    const { container } = render(<CanvasUiModeProvider mode="simple"><CanvasSurface /></CanvasUiModeProvider>);
    expect(screen.getByTestId('canvas-tile-s1')).toBeTruthy();
    // Ports are inert (the mode stylesheet also hides them); no minimap.
    expect([...container.querySelectorAll('.canvas-port')].every(port => (port as HTMLButtonElement).disabled)).toBe(true);
    expect(container.querySelector('.canvas-minimap')).toBeNull();
    // The graph stays readable.
    expect(container.querySelectorAll('.canvas-wire').length).toBeGreaterThan(0);
  });

  it('developer mode shows every control, unchanged', () => {
    const { container } = render(<CanvasUiModeProvider mode="developer"><CanvasSurface /></CanvasUiModeProvider>);
    expect(container.querySelectorAll('.canvas-port').length).toBeGreaterThan(0);
    expect([...container.querySelectorAll('.canvas-port')].some(port => !(port as HTMLButtonElement).disabled)).toBe(true);
  });

  it('a mode never changes the document', () => {
    const simple = render(<CanvasUiModeProvider mode="simple"><CanvasSurface /></CanvasUiModeProvider>);
    const afterSimple = JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument;
    simple.unmount();
    const developer = render(<CanvasUiModeProvider mode="developer"><CanvasSurface /></CanvasUiModeProvider>);
    const afterDeveloper = JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument;
    developer.unmount();
    expect(afterDeveloper.nodes).toEqual(afterSimple.nodes);
    expect(afterDeveloper.edges).toEqual(afterSimple.edges);
  });
});

describe('card frames', () => {
  it('clamps sizes to the compact card and the maximum, and previews from the threshold', () => {
    expect(clampCard(10, 10)).toEqual({ w: COMPACT_SESSION_SIZE.w, h: COMPACT_SESSION_SIZE.h });
    expect(clampCard(1e9, 1e9)).toEqual({ w: CARD_MAX.w, h: CARD_MAX.h });
    expect(clampCard(Number.NaN, 300)).toEqual({ w: COMPACT_SESSION_SIZE.w, h: 300 });
    expect(showsPreview(CARD_PREVIEW_DEFAULT)).toBe(true);
    expect(showsPreview(COMPACT_SESSION_SIZE)).toBe(false);
    expect(showsPreview(undefined)).toBe(false);
  });

  it('stores only cards still on the canvas and away from the compact size, and writes only on change', () => {
    const storage = { data: new Map<string, string>(), getItem(key: string) { return this.data.get(key) ?? null; },
      setItem: vi.fn(function (this: { data: Map<string, string> }, key: string, value: string) { this.data.set(key, value); }),
      removeItem: vi.fn(function (this: { data: Map<string, string> }, key: string) { this.data.delete(key); }) };
    const key = canvasStorageKey(CARD_FRAMES_KEY);
    saveCardFrames({ a: { w: 640, h: 460 }, gone: { w: 700, h: 500 }, small: { ...COMPACT_SESSION_SIZE } }, new Set(['a', 'small']), storage);
    expect(JSON.parse(storage.getItem(key)!)).toEqual({ a: { w: 640, h: 460 } });
    saveCardFrames({ a: { w: 640, h: 460 } }, new Set(['a']), storage);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    saveCardFrames({}, new Set(['a']), storage);
    saveCardFrames({}, new Set(['a']), storage);
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
    expect(loadCardFrames(storage)).toEqual({});
  });

  it('reads back sanitized frames and ignores malformed ones', () => {
    localStorage.setItem(canvasStorageKey(CARD_FRAMES_KEY), JSON.stringify({ a: { w: 9999, h: 500 }, b: 'x', c: { w: '1', h: 2 } }));
    expect(loadCardFrames()).toEqual({ a: { w: CARD_MAX.w, h: 500 } });
    localStorage.setItem(canvasStorageKey(CARD_FRAMES_KEY), '[1,2]');
    expect(loadCardFrames()).toEqual({});
  });
});
