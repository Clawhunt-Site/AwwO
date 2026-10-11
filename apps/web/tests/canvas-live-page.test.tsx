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
