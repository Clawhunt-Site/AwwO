import { createContext, runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import training from '../src/saas/examples/generated/trainingResult';

afterEach(() => vi.useRealTimers());

/** No automatic jsdom scripts/resources: execute only this reviewed, checked-in inline script. */
function trainingHarness() {
  const dom = new JSDOM(training);
  const { document } = dom.window;
  let width = 0;
  const canvasIds = ['lossChart', 'accChart', 'boundaryChart'];
  const canvases = canvasIds.map(id => document.getElementById(id) as HTMLCanvasElement);
  const draws = new Map<HTMLCanvasElement, number>(canvases.map(canvas => [canvas, 0]));
  const hasPixels = new Map<HTMLCanvasElement, boolean>(canvases.map(canvas => [canvas, false]));
  const contexts = new Map<HTMLCanvasElement, CanvasRenderingContext2D>();
  const rect = (element: Element) => {
    const height = element.id === 'boundaryChart' || element.querySelector('#boundaryChart') ? 400 : 300;
    return { x: 0, y: 0, top: 0, left: 0, bottom: width ? height : 0, right: width, width, height: width ? height : 0, toJSON: () => ({}) };
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', { get: () => width });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get: () => width });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return rect(this); };
  Object.defineProperty(dom.window, 'devicePixelRatio', { value: 2 });
  for (const canvas of canvases) {
    // Assigning either bitmap dimension clears a real canvas even when the value is unchanged.
    let bitmapWidth = canvas.width;
    let bitmapHeight = canvas.height;
    Object.defineProperty(canvas, 'width', {
      get: () => bitmapWidth,
      set: (value: number) => { bitmapWidth = value; hasPixels.set(canvas, false); },
    });
    Object.defineProperty(canvas, 'height', {
      get: () => bitmapHeight,
      set: (value: number) => { bitmapHeight = value; hasPixels.set(canvas, false); },
    });
    const context: Record<string, unknown> = { canvas };
    for (const method of ['clearRect', 'fillRect', 'strokeRect', 'fillText', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill', 'save', 'restore', 'translate', 'rotate', 'setLineDash']) {
      context[method] = () => {
        if (method === 'clearRect') hasPixels.set(canvas, false);
        if (['fillRect', 'strokeRect', 'stroke', 'fill'].includes(method)) {
          draws.set(canvas, draws.get(canvas)! + 1);
          if (canvas.width > 0 && canvas.height > 0) hasPixels.set(canvas, true);
        }
      };
    }
    contexts.set(canvas, context as unknown as CanvasRenderingContext2D);
    Object.defineProperty(canvas, 'getContext', { value: () => contexts.get(canvas) });
  }

  const observers: Array<{ callback: ResizeObserverCallback; elements: Set<Element> }> = [];
  class ResizeObserverMock {
    private readonly entry: typeof observers[number];
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, elements: new Set() };
      observers.push(this.entry);
    }
    observe(element: Element) { this.entry.elements.add(element); }
    unobserve(element: Element) { this.entry.elements.delete(element); }
    disconnect() { this.entry.elements.clear(); }
  }
  const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16);
  const cancelAnimationFrame = (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle);
  Object.assign(dom.window, { ResizeObserver: ResizeObserverMock, requestAnimationFrame, cancelAnimationFrame });
  const context = createContext({
    document, window: dom.window, navigator: dom.window.navigator,
    ResizeObserver: ResizeObserverMock, requestAnimationFrame, cancelAnimationFrame,
    setTimeout, clearTimeout, console, devicePixelRatio: 2,
  }, { codeGeneration: { strings: false, wasm: false } });
  const scripts = Array.from(document.querySelectorAll('script')).map(script => script.textContent || '');
  expect(scripts.length).toBeGreaterThan(0);
  scripts.forEach(script => runInContext(script, context, { timeout: 2_000 }));

  function triggerResize(nextWidth: number, trigger: 'container' | 'window') {
    width = nextWidth;
    if (trigger === 'window') dom.window.dispatchEvent(new dom.window.Event('resize'));
    else for (const observer of observers) {
      const entries = Array.from(observer.elements).map(target => ({ target, contentRect: rect(target) })) as ResizeObserverEntry[];
      if (entries.length) observer.callback(entries, {} as ResizeObserver);
    }
  }

  return {
    document, canvases, draws, hasPixels, triggerResize,
    state: () => runInContext('JSON.stringify({ weights: app.model.weights, bias: app.model.bias, history: app.model.history, isTraining: app.isTraining })', context) as string,
    observedTargets: () => observers.reduce((count, observer) => count + observer.elements.size, 0),
    pagehide: () => dom.window.dispatchEvent(new dom.window.Event('pagehide')),
    async resize(nextWidth: number, trigger: 'container' | 'window') {
      triggerResize(nextWidth, trigger);
      await vi.runAllTimersAsync();
    },
    dispose() { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); },
  };
}

describe('generated Model Lab chart visibility and resize regression', () => {
  it('recovers from a zero-width mount and redraws both resize paths without discarding trained state', async () => {
    vi.useFakeTimers();
    const harness = trainingHarness();
    try {
      await vi.runAllTimersAsync();
      await harness.resize(360, 'container');
      for (const canvas of harness.canvases) {
        expect(canvas.width, `${canvas.id} after becoming visible`).toBeGreaterThan(0);
        expect(canvas.height, `${canvas.id} after becoming visible`).toBeGreaterThan(0);
      }

      (harness.document.getElementById('epochs') as HTMLInputElement).value = '10';
      (harness.document.getElementById('trainBtn') as HTMLButtonElement).click();
      await vi.runAllTimersAsync();
      expect(harness.document.getElementById('progressText')?.textContent).toBe('10 / 10');
      const trained = harness.state();
      expect(JSON.parse(trained).history.trainLoss).toHaveLength(10);
      expect(JSON.parse(trained).isTraining).toBe(false);
      expect(harness.canvases.map(canvas => harness.hasPixels.get(canvas))).toEqual([true, true, true]);
      const metrics = ['trainLoss', 'holdoutLoss', 'trainAcc', 'holdoutAcc'].map(id => harness.document.getElementById(id)?.textContent);

      for (const [nextWidth, trigger] of [[520, 'window'], [420, 'container']] as const) {
        const previousWidths = harness.canvases.map(canvas => canvas.width);
        const previousDraws = harness.canvases.map(canvas => harness.draws.get(canvas)!);
        await harness.resize(nextWidth, trigger);
        harness.canvases.forEach((canvas, index) => {
          expect(canvas.width, `${canvas.id} ${trigger} resize`).not.toBe(previousWidths[index]);
          expect(harness.draws.get(canvas)!, `${canvas.id} ${trigger} redraw`).toBeGreaterThan(previousDraws[index]);
          expect(harness.hasPixels.get(canvas), `${canvas.id} ${trigger} painted`).toBe(true);
        });
        expect(harness.state()).toBe(trained);
      }

      const bitmapSizes = harness.canvases.map(canvas => [canvas.width, canvas.height]);
      await harness.resize(0, 'container');
      expect(harness.canvases.map(canvas => [canvas.width, canvas.height])).toEqual(bitmapSizes);
      expect(harness.canvases.map(canvas => harness.hasPixels.get(canvas))).toEqual([true, true, true]);
      expect(harness.state()).toBe(trained);
      await harness.resize(420, 'container');
      expect(harness.canvases.map(canvas => [canvas.width, canvas.height])).toEqual(bitmapSizes);
      expect(harness.canvases.map(canvas => harness.hasPixels.get(canvas))).toEqual([true, true, true]);
      expect(harness.state()).toBe(trained);
      expect(['trainLoss', 'holdoutLoss', 'trainAcc', 'holdoutAcc'].map(id => harness.document.getElementById(id)?.textContent)).toEqual(metrics);

      // Test artifact cleanup before closing jsdom, so window.close cannot mask leaked listeners.
      expect(harness.observedTargets()).toBe(3);
      harness.triggerResize(540, 'container');
      expect(vi.getTimerCount()).toBe(1);
      const drawsBeforePagehide = harness.canvases.map(canvas => harness.draws.get(canvas));
      harness.pagehide();
      expect(vi.getTimerCount()).toBe(0);
      expect(harness.observedTargets()).toBe(0);
      harness.triggerResize(620, 'window');
      await vi.runAllTimersAsync();
      expect(vi.getTimerCount()).toBe(0);
      expect(harness.canvases.map(canvas => harness.draws.get(canvas))).toEqual(drawsBeforePagehide);
      expect(harness.canvases.map(canvas => [canvas.width, canvas.height])).toEqual(bitmapSizes);
    } finally {
      harness.dispose();
    }
  });
});
