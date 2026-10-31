// A delivered page runs in the studio's live frame (results studio, enlarged cards). No sandbox flag stops a script from
// sending that frame to another address, so a further load of one frame puts the delivered page back, and a page that
// keeps doing it is stopped, as the 成果 preview does. A frame loads its own document once by itself (jsdom fires that
// load a tick after insertion, as a browser does); every load after it is the page going elsewhere.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LivePage } from '../src/canvas/studio/LivePage';
import { LIVE_PAGE_SANDBOX } from '../src/canvas/studio/liveDocument';

afterEach(() => cleanup());

const frame = () => screen.queryByTitle(/交付页面/) as HTMLIFrameElement | null;
/** Let the frame load its own document. */
const ownLoad = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const RESTORED = '页面试图把预览跳转到别的网址，已换回交付的页面。';

describe('live page', () => {
  it('runs the page in its sandbox and puts it back when the page sends its frame elsewhere', async () => {
    render(<LivePage html="<p>交付的页面</p>" title="交付页面" />);
    await waitFor(() => expect(frame()).not.toBeNull());
    const first = frame()!;
    expect(first.getAttribute('sandbox')).toBe(LIVE_PAGE_SANDBOX);
    expect(first.getAttribute('srcdoc')).toContain('交付的页面');
    await ownLoad();
    expect(screen.queryByText(RESTORED)).toBeNull();
    expect(frame()).toBe(first);
    fireEvent.load(first);
    expect(await screen.findByText(RESTORED)).toBeTruthy();
    const restored = frame()!;
    expect(restored).not.toBe(first);
    expect(restored.getAttribute('srcdoc')).toContain('交付的页面');
  });

  it('stops a page that keeps sending its frame elsewhere', async () => {
    render(<LivePage html="<p>x</p>" title="交付页面" />);
    await waitFor(() => expect(frame()).not.toBeNull());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await ownLoad();
      fireEvent.load(frame()!);
    }
    expect(await screen.findByRole('alert')).toHaveTextContent('页面反复试图跳转到别的网址，已停止运行。');
    expect(frame()).toBeNull();
  });
});

// The canvas hands every page a new resolver whenever any of its nodes publishes (CanvasSurface's canvasEntries): on the
// board an enlarged card's page, a 预览展示 window's or the studio's was started again in a new frame each time, a flash
// on every page for every node that finished in a run (2026-10-31). Only a changed document is a new frame.
describe('live page given a new resolver', () => {
  const PAGE = '<p>交付的页面</p><img src="pic.png">';
  const resolverOf = (bytes: number[]) => async (path: string) => path === 'pic.png' ? { bytes: new Uint8Array(bytes), name: 'pic.png' } : null;
  /** Let a build that awaits the resolver finish. */
  const settle = () => act(async () => { for (let tick = 0; tick < 5; tick += 1) await new Promise(resolve => setTimeout(resolve, 0)); });

  it('keeps the running frame when the page builds into the same document', async () => {
    const view = render(<LivePage html={PAGE} title="交付页面" resolve={resolverOf([1, 2, 3])} />);
    await waitFor(() => expect(frame()?.getAttribute('srcdoc')).toContain('data:image/png;base64,AQID'));
    const first = frame()!;
    await ownLoad();
    let asked = 0;
    const same = resolverOf([1, 2, 3]);
    view.rerender(<LivePage html={PAGE} title="交付页面" resolve={async path => { asked += 1; return same(path); }} />);
    await settle();
    expect(asked).toBeGreaterThan(0);
    expect(frame()).toBe(first);
    expect(screen.queryByText(RESTORED)).toBeNull();
  });

  it('does not take a frame mounted again under the same key for a page sending itself elsewhere', async () => {
    // A market page the reader ran, replaced by another delivery (shown still) and then back: the same document keeps
    // its key, and the frame mounted again loads its own document once more.
    const view = render(<LivePage html={PAGE} title="交付页面" market resolve={resolverOf([1, 2, 3])} />);
    fireEvent.click(await screen.findByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(frame()?.getAttribute('sandbox')).toBe(LIVE_PAGE_SANDBOX));
    await ownLoad();
    view.rerender(<LivePage html="<p>另一份交付</p>" title="交付页面" market resolve={resolverOf([1, 2, 3])} />);
    await waitFor(() => expect(frame()?.getAttribute('sandbox')).toBe(''));
    view.rerender(<LivePage html={PAGE} title="交付页面" market resolve={resolverOf([1, 2, 3])} />);
    await waitFor(() => expect(frame()?.getAttribute('sandbox')).toBe(LIVE_PAGE_SANDBOX));
    await ownLoad();
    await settle();
    expect(screen.queryByText(RESTORED)).toBeNull();
  });

  it('starts a new frame when a file the page shows changed', async () => {
    const view = render(<LivePage html={PAGE} title="交付页面" resolve={resolverOf([1, 2, 3])} />);
    await waitFor(() => expect(frame()?.getAttribute('srcdoc')).toContain('data:image/png;base64,AQID'));
    const first = frame()!;
    await ownLoad();
    view.rerender(<LivePage html={PAGE} title="交付页面" resolve={resolverOf([4, 5, 6])} />);
    await waitFor(() => expect(frame()?.getAttribute('srcdoc')).toContain('data:image/png;base64,BAUG'));
    expect(frame()).not.toBe(first);
  });
});
