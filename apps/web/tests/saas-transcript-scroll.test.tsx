import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TileTranscript } from '../src/canvas/TileTranscript';
import { LocaleProvider } from '../src/canvas/i18n';

afterEach(cleanup);

function transcript(text: string, { autoScroll = true, thread = 'first', locale = 'zh' as 'zh' | 'en' } = {}) {
  return <LocaleProvider locale={locale}><TileTranscript key={thread}
    turns={[{ id: 1, role: 'agent', text }]} history="loaded" streaming limit={Infinity} autoScroll={autoScroll} />
  </LocaleProvider>;
}

// jsdom has no layout engine. Give the actual scroll container a bounded viewport so the
// tests exercise user position and arriving content, rather than counting effect calls.
function viewport() {
  const el = screen.getByTestId('transcript-scroll');
  let height = 1000;
  Object.defineProperties(el, {
    clientHeight: { configurable: true, get: () => 300 },
    scrollHeight: { configurable: true, get: () => height },
    scrollTo: { configurable: true, value: vi.fn(({ top }: ScrollToOptions) => { el.scrollTop = Math.max(0, Math.min(top ?? 0, height - 300)); }) },
  });
  return {
    el,
    grow: (next: number) => { height = next; },
    scroll: (top: number) => { el.scrollTop = top; fireEvent.scroll(el); },
  };
}

describe('conversation reading position', () => {
  it('follows arriving output while the reader stays at the end', () => {
    const view = render(transcript('One'));
    const port = viewport();
    view.rerender(transcript('One two'));
    expect(port.el.scrollTop).toBe(700);
    port.grow(1300);
    view.rerender(transcript('One two three'));
    expect(port.el.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull();
  });

  it('pauses on an upward wheel before the browser dispatches its scroll event', () => {
    const view = render(transcript('One'));
    const port = viewport();
    view.rerender(transcript('One two'));
    fireEvent.wheel(port.el, { deltaY: -25 });
    port.grow(1300);
    view.rerender(transcript('One two three'));
    expect(port.el.scrollTop).toBe(700);
    expect(screen.getByRole('button', { name: '回到最新' })).toBeTruthy();
    port.scroll(400);
    view.rerender(transcript('One two three four'));
    expect(port.el.scrollTop).toBe(400);
  });

  it('preserves a scrollbar position and resumes only after scrolling down near the end', () => {
    const view = render(transcript('One'));
    const port = viewport();
    view.rerender(transcript('One two'));
    port.scroll(350);
    port.grow(1300);
    view.rerender(transcript('One two three'));
    expect(port.el.scrollTop).toBe(350);
    port.scroll(985);
    expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull();
    port.grow(1600);
    view.rerender(transcript('One two three four'));
    expect(port.el.scrollTop).toBe(1300);
  });

  it.each(['PageUp', 'Home', 'ArrowUp'])('keeps a %s reading gesture from being interrupted by output', key => {
    const view = render(transcript('One'));
    const port = viewport();
    view.rerender(transcript('One two'));
    fireEvent.keyDown(port.el, { key });
    port.grow(1300);
    view.rerender(transcript('One two three'));
    expect(port.el.scrollTop).toBe(700);
    expect(screen.getByRole('button', { name: '回到最新' })).toBeTruthy();
  });

  it('pauses while a touch gesture moves towards older messages', () => {
    const view = render(transcript('One'));
    const port = viewport();
    view.rerender(transcript('One two'));
    fireEvent.touchStart(port.el, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(port.el, { touches: [{ clientY: 150 }] });
    port.grow(1300);
    view.rerender(transcript('One two three'));
    expect(port.el.scrollTop).toBe(700);
  });

  it('jumps back on request and follows later output again', () => {
    const view = render(transcript('One', { locale: 'en' }));
    const port = viewport();
    view.rerender(transcript('One two', { locale: 'en' }));
    port.scroll(200);
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(port.el.scrollTop).toBe(700);
    expect(document.activeElement).toBe(port.el);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
    port.grow(1300);
    view.rerender(transcript('One two three', { locale: 'en' }));
    expect(port.el.scrollTop).toBe(1000);
  });

  it('starts following the selected thread instead of inheriting the old reading position', () => {
    const view = render(transcript('One'));
    const first = viewport();
    view.rerender(transcript('One two'));
    first.scroll(200);
    expect(screen.getByRole('button', { name: '回到最新' })).toBeTruthy();
    view.rerender(transcript('Another thread', { thread: 'second' }));
    const second = viewport();
    expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull();
    view.rerender(transcript('Another thread continues', { thread: 'second' }));
    expect(second.el.scrollTop).toBe(700);
  });

  it('leaves a compact transcript alone until its full conversation opens', () => {
    const view = render(transcript('One', { autoScroll: false }));
    const port = viewport();
    port.scroll(150);
    view.rerender(transcript('One two', { autoScroll: false }));
    expect(port.el.scrollTop).toBe(150);
    expect(screen.queryByRole('button', { name: '回到最新' })).toBeNull();
    view.rerender(transcript('One two'));
    expect(port.el.scrollTop).toBe(700);
  });
});
