// A node's own message box is disabled while its node works (its reply, a run of it). Chrome then drops the keyboard's
// focus to the page (seen 2026-10-20 in Chrome 155 on a built app: "reply streaming … focus BODY", nothing brought it
// back), so the box takes it back when the work ends, unless the reader turned elsewhere meanwhile.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TileComposer, type TileComposerProps } from '../src/canvas/TileComposer';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { loadRunJournal } from '../src/canvas/runJournal';
import { resetAllSessions } from '../src/canvas/sessions';

/** jsdom leaves the focus on a control it disables; Chrome drops it to the page at its next rendering step, with a
 *  focusout and no focusin anywhere (checked in Chrome 155). Act that out on the disabled control. */
function dropFocusToPage(control: HTMLElement) {
  const disabled = control as HTMLTextAreaElement | HTMLButtonElement;
  expect(disabled).toBeDisabled();
  expect(disabled).toHaveFocus();
  disabled.disabled = false; disabled.blur(); disabled.disabled = true;
  expect(document.body).toHaveFocus();
}

const send = vi.fn();
const RUNNING = '任务执行中，结束后可继续对话。';
/** The page around the box: a reply to copy from, a control of the canvas and a preview frame, all outside the composer. */
function page(props: Partial<TileComposerProps> = {}) {
  return <>
    <p data-testid="reply">The reply, to copy from.</p>
    <button type="button">查找 Agent</button>
    <iframe title="preview" />
    <TileComposer streaming={false} onSend={send} {...props} />
  </>;
}
const LOCK: Partial<TileComposerProps> = { blocked: true, blockedReason: RUNNING, streaming: true };
const box = () => screen.getByTestId('composer-input') as HTMLTextAreaElement;
/** Sends a message from the box with Enter, as typed, and locks it the way the canvas does while the node's run goes. */
function sendAndLock(view: ReturnType<typeof render>, lock: Partial<TileComposerProps> = LOCK) {
  box().focus();
  fireEvent.change(box(), { target: { value: 'Write the level plan' } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  expect(send).toHaveBeenCalledWith('Write the level plan');
  view.rerender(page(lock));
  dropFocusToPage(box());
}

beforeEach(() => send.mockClear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the message box takes the focus back when its node’s work ends', () => {
  it('after a reply sent with Enter, the canvas’s lock (任务执行中) and the browser dropping the focus', () => {
    const view = render(page());
    sendAndLock(view);
    expect(screen.getByTestId('composer-blocked')).toHaveTextContent(RUNNING);
    view.rerender(page());
    expect(box()).toBeEnabled();
    expect(box()).toHaveFocus();
  });

  // Chrome focuses a button it presses, and the cleared box disables it before the lock comes (a host that sends at
  // once); Safari focuses neither. Either way the box has the focus once the message goes.
  it.each([['which Chrome focuses', true], ['which Safari leaves unfocused', false]])('after a reply sent with the send button, %s', (_how, focused) => {
    const focus = vi.spyOn(HTMLTextAreaElement.prototype, 'focus');
    const view = render(page());
    fireEvent.change(box(), { target: { value: 'Write the level plan' } });
    const button = screen.getByTestId('composer-send');
    if (focused) button.focus();
    fireEvent.click(button);
    expect(send).toHaveBeenCalledWith('Write the level plan');
    expect(button).toBeDisabled();
    expect(box()).toHaveFocus();
    view.rerender(page({ streaming: true }));
    dropFocusToPage(box());
    view.rerender(page());
    expect(box()).toHaveFocus();
    // Neither move scrolls the canvas to show the box.
    expect(focus).toHaveBeenCalledTimes(2);
    for (const [options] of focus.mock.calls) expect(options).toEqual({ preventScroll: true });
  });

  it('after a reply sent with the button and accepted in the commit that locks the box (the canvas’s way)', () => {
    let accept: (() => void) | undefined;
    const accepting = vi.fn((_message: string, accepted?: () => void) => { accept = accepted; });
    const view = render(page({ deferClear: true, onSend: accepting }));
    fireEvent.change(box(), { target: { value: 'Write the level plan' } });
    screen.getByTestId('composer-send').focus();
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(box()).toHaveValue('Write the level plan');
    act(() => { accept?.(); view.rerender(page({ ...LOCK, deferClear: true, onSend: accepting })); });
    expect(box()).toHaveValue('');
    dropFocusToPage(box());
    view.rerender(page({ deferClear: true, onSend: accepting }));
    expect(box()).toHaveFocus();
  });

  it('after a reply that only streams (no lock of the canvas), and without scrolling anything to show the box', () => {
    const focus = vi.spyOn(HTMLTextAreaElement.prototype, 'focus');
    const view = render(page());
    sendAndLock(view, { streaming: true });
    focus.mockClear();
    view.rerender(page());
    expect(box()).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('after a press on the box itself, or keys typed while it waits', () => {
    const view = render(page());
    sendAndLock(view);
    fireEvent.pointerDown(box());
    for (const key of ['n', 'N', 'Backspace', 'Enter', ' ']) fireEvent.keyDown(document.body, { key, shiftKey: key === 'N' });
    // A modifier pressed alone is no shortcut yet (say, the first key of Shift + a letter, or of Alt+Tab).
    for (const key of ['Shift', 'Control', 'Alt', 'Meta']) fireEvent.keyDown(document.body, { key, shiftKey: key === 'Shift', ctrlKey: key === 'Control', altKey: key === 'Alt', metaKey: key === 'Meta' });
    // Nor is typing that Windows reports with Ctrl and Alt (AltGr+Q gives @ on a German keyboard), macOS's Option
    // characters, an IME's keys, an editing chord (paste ahead, undo) or the browser's own (its menu, a page search).
    fireEvent.keyDown(document.body, { key: '@', code: 'KeyQ', ctrlKey: true, altKey: true });
    fireEvent.keyDown(document.body, { key: 'å', code: 'KeyA', altKey: true });
    fireEvent.keyDown(document.body, { key: 'Process', code: 'KeyA', keyCode: 229 });
    fireEvent.keyDown(document.body, { key: 'a', code: 'KeyA', isComposing: true, ctrlKey: true });
    for (const key of ['v', 'z', 'f', 'k']) fireEvent.keyDown(document.body, { key, code: `Key${key.toUpperCase()}`, ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'f', code: 'KeyF', altKey: true });
    // Nor saving a waypoint (Ctrl+Shift with a digit), which moves nothing.
    fireEvent.keyDown(document.body, { key: '#', code: 'Digit3', ctrlKey: true, shiftKey: true });
    view.rerender(page());
    expect(box()).toHaveFocus();
  });

  // A pen, a touch screen on a laptop: only a phone or a tablet (a coarse pointer first) holds the focus back.
  it('after a message sent by a touch or a pen where the first pointer is fine (a laptop’s touch screen, a pen tablet)', () => {
    const view = render(page());
    fireEvent.pointerDown(box(), { pointerType: 'touch' });
    sendAndLock(view);
    fireEvent.pointerDown(screen.getByTestId('composer-blocked'), { pointerType: 'pen' });
    view.rerender(page());
    expect(box()).toHaveFocus();
  });

  it('after another control of the composer had it as the box locked (the model, which the lock disables too)', () => {
    const model = (disabled: boolean) => <button type="button" disabled={disabled}>Claude Opus 5.5</button>;
    const view = render(page({ accessory: model(false) }));
    const picker = screen.getByRole('button', { name: 'Claude Opus 5.5' });
    picker.focus();
    view.rerender(page({ ...LOCK, accessory: model(true) }));
    dropFocusToPage(picker);
    view.rerender(page({ accessory: model(false) }));
    expect(box()).toHaveFocus();
  });

  it('from a control of the composer the browser left it on, still disabled (the send button of a box sent empty)', () => {
    const model = (disabled: boolean) => <button type="button" disabled={disabled}>Claude Opus 5.5</button>;
    const view = render(page({ accessory: model(false) }));
    const picker = screen.getByRole('button', { name: 'Claude Opus 5.5' });
    picker.focus();
    view.rerender(page({ ...LOCK, accessory: model(true) }));
    // Not dropped (jsdom, as a browser may), and still disabled once the box unlocks: keys would go nowhere.
    view.rerender(page({ accessory: model(true) }));
    expect(box()).toHaveFocus();
  });

  it('after the window lost the focus to another tab or app while it waited', () => {
    const view = render(page());
    sendAndLock(view);
    window.dispatchEvent(new FocusEvent('blur'));
    view.rerender(page());
    expect(box()).toHaveFocus();
  });

  it('each time: a second message, then its end', () => {
    const view = render(page());
    sendAndLock(view);
    view.rerender(page());
    expect(box()).toHaveFocus();
    sendAndLock(view);
    view.rerender(page());
    expect(box()).toHaveFocus();
  });
});

describe('the message box leaves the focus where the reader put it', () => {
  it('when the focus was elsewhere as the box locked', () => {
    const view = render(page());
    const other = screen.getByRole('button', { name: '查找 Agent' });
    other.focus();
    view.rerender(page(LOCK));
    // That control goes away meanwhile, say: the focus is on the page when the work ends.
    other.blur();
    view.rerender(page());
    expect(document.body).toHaveFocus();
  });

  it('after a press elsewhere while the box waits (in the reply, to copy from it)', () => {
    const view = render(page());
    sendAndLock(view);
    fireEvent.pointerDown(screen.getByTestId('reply'));
    view.rerender(page());
    expect(document.body).toHaveFocus();
  });

  it('after a focus elsewhere while the box waits, even once that control has let it go', () => {
    const view = render(page());
    sendAndLock(view);
    const other = screen.getByRole('button', { name: '查找 Agent' });
    other.focus(); other.blur();
    view.rerender(page());
    expect(document.body).toHaveFocus();
  });

  // The canvas's camera keys (Ctrl/⌘ with a digit recalls a waypoint, with 0 fits all: the camera leaves the node), and
  // Escape and Tab, which go elsewhere.
  it.each([['Ctrl+1', { key: '1', code: 'Digit1', ctrlKey: true }], ['⌘0', { key: '0', code: 'Digit0', metaKey: true }],
    ['Ctrl and the keypad’s 0', { key: '0', code: 'Numpad0', ctrlKey: true }], ['Ctrl+Shift+0', { key: ')', code: 'Digit0', ctrlKey: true, shiftKey: true }],
    ['AltGr+7 (a { on a German keyboard, a waypoint to the canvas)', { key: '{', code: 'Digit7', ctrlKey: true, altKey: true }],
    ['Ctrl+1 while an IME composes (the canvas still recalls the waypoint)', { key: '1', code: 'Digit1', keyCode: 229, isComposing: true, ctrlKey: true }],
    ['Escape', { key: 'Escape' }], ['Tab', { key: 'Tab' }]])('after a key that takes the reader elsewhere while the box waits (%s)', (_name, init) => {
    const view = render(page());
    sendAndLock(view);
    fireEvent.keyDown(document.body, init);
    view.rerender(page());
    expect(document.body).toHaveFocus();
  });

  it('after a wheel outside the composer while the box waits (it moves the canvas)', () => {
    const view = render(page());
    sendAndLock(view);
    fireEvent.wheel(screen.getByTestId('reply'), { deltaY: 120 });
    view.rerender(page());
    expect(document.body).toHaveFocus();
  });

  it('after the focus went into a frame (a preview), which gives the page no focusin', () => {
    const view = render(page());
    sendAndLock(view);
    const frame = screen.getByTitle('preview');
    // As in Chrome: no pointerdown or focusin reach the page; the window blurs with the frame as its active element.
    const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(frame);
    window.dispatchEvent(new FocusEvent('blur'));
    active.mockRestore();
    // Then that preview is replaced as the run delivers: the focus is on the page when the work ends.
    view.rerender(page());
    expect(document.body).toHaveFocus();
  });

  it('while the reader has a selection on the page (dragged from the box’s own notice into the reply, say)', () => {
    const view = render(page());
    sendAndLock(view);
    fireEvent.pointerDown(screen.getByTestId('composer-blocked'));
    getSelection()!.selectAllChildren(screen.getByTestId('reply'));
    view.rerender(page());
    expect(document.body).toHaveFocus();
    expect(String(getSelection())).toBe('The reply, to copy from.');
  });

  // On a phone or a tablet the box's keyboard would come up over the reply just in: nothing moves the focus there.
  const coarse = () => vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query === '(pointer: coarse)', media: query,
    onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));

  it('on a phone or a tablet, after a message sent with Enter from the box', () => {
    coarse();
    const view = render(page());
    sendAndLock(view);
    view.rerender(page());
    expect(document.body).toHaveFocus();
  });

  it('as the device is when the box unlocks, not when the message went (a keyboard detached, a mouse attached)', () => {
    const query = coarse();
    const view = render(page());
    sendAndLock(view);
    query.mockRestore();
    view.rerender(page());
    expect(box()).toHaveFocus();
    sendAndLock(view);
    coarse();
    view.rerender(page());
    expect(document.body).toHaveFocus();
  });

  it('on a phone or a tablet, after a message sent with the button', () => {
    coarse();
    const view = render(page());
    fireEvent.change(box(), { target: { value: 'Write the level plan' } });
    const button = screen.getByTestId('composer-send');
    button.focus();
    fireEvent.click(button);
    expect(send).toHaveBeenCalledWith('Write the level plan');
    expect(box()).not.toHaveFocus();
    view.rerender(page(LOCK));
    dropFocusToPage(button);
    view.rerender(page());
    expect(document.body).toHaveFocus();
  });

  it('on a control of the composer the reader focused while the box waited (用户须知)', () => {
    const view = render(page());
    sendAndLock(view, { streaming: true });
    const notes = screen.getByRole('button', { name: /用户须知|Good to know/ });
    notes.focus();
    view.rerender(page());
    expect(notes).toHaveFocus();
  });

  it('while the box stays locked for another reason, and gives it back once that ends too', () => {
    const view = render(page());
    sendAndLock(view);
    view.rerender(page({ blocked: true, blockedReason: '只读' }));
    expect(document.body).toHaveFocus();
    view.rerender(page());
    expect(box()).toHaveFocus();
  });
});

// The whole way on the canvas: a bound node's message, the node's run (its lane locks the box), the run's end.
const execute = vi.fn(async (_node: SessionNode) => ({ ok: true, output: 'unused' }));
vi.mock('../src/canvas/runTransport', () => ({
  createGatewayExecutor: (options: Parameters<typeof import('../src/canvas/runTransport').createGatewayExecutor>[0]) =>
    async (node: SessionNode) => {
      const identity = { issueId: `issue-${node.id}`, runId: `run-${node.id}` };
      options.onIssueId?.(node.id, identity.issueId);
      options.onRunAccepted?.(node.id, identity);
      return execute(node);
    },
}));

describe('an opened node’s message box on the canvas', () => {
  let finish!: (result: { ok: boolean; output: string }) => void;
  beforeEach(() => {
    resetAllSessions(); localStorage.clear(); execute.mockReset();
    execute.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => new Response(JSON.stringify(
      String(input).endsWith('/settle') && init?.method === 'POST'
        ? { confirmed: true, status: 'succeeded', holdId: `hold-${JSON.parse(String(init.body)).runId}` }
        : String(input).endsWith('/companies') ? [{ id: 'company', name: 'Test workspace' }] : {},
    ), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const node: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'manual', title: 'Manual', runtime: 'pi',
      binding: { companyId: 'company', agentId: 'agent-manual', agentName: 'Manual' } };
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node] }));
  });
  afterEach(() => { cleanup(); resetAllSessions(); localStorage.clear(); vi.unstubAllGlobals(); });

  async function sendFromTheNode(how: 'enter' | 'button' = 'enter') {
    render(<CanvasSurface />);
    fireEvent.click(screen.getByRole('button', { name: '打开 Manual', exact: true }));
    fireEvent.change(box(), { target: { value: 'Write the level plan' } });
    if (how === 'enter') { box().focus(); fireEvent.keyDown(box(), { key: 'Enter' }); }
    else { screen.getByTestId('composer-send').focus(); fireEvent.click(screen.getByTestId('composer-send')); }
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(box()).toBeDisabled();
    expect(screen.getByTestId('composer-blocked')).toHaveTextContent(RUNNING);
    dropFocusToPage(box());
  }
  async function replyEnds() {
    await act(async () => finish({ ok: true, output: 'The level plan' }));
    await waitFor(() => expect(loadRunJournal()).toBeNull());
    await waitFor(() => expect(box()).toBeEnabled());
  }

  it.each(['enter', 'button'] as const)('has the focus again once the node’s reply is in (sent with %s)', async how => {
    await sendFromTheNode(how);
    await replyEnds();
    expect(box()).toHaveFocus();
  });

  it('keeps that after a wheel over the node’s own reply while it streams (it scrolls the reply)', async () => {
    await sendFromTheNode();
    fireEvent.wheel(document.querySelector('.canvas-transcript-scroll')!, { deltaY: 120 });
    await replyEnds();
    expect(box()).toHaveFocus();
  });

  // The node's own reply, to copy from it (a press on a node stops there: SessionTile claims it), or the canvas, to pan it.
  it.each([['in the node’s reply', '.canvas-transcript-scroll'], ['on the canvas', '.canvas-viewport']])('leaves the focus on the page after a press %s during the reply', async (_where, selector) => {
    await sendFromTheNode();
    const target = document.querySelector<HTMLElement>(selector);
    expect(target).toBeTruthy();
    fireEvent.pointerDown(target!, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(target!, { button: 0, pointerId: 1 });
    await replyEnds();
    expect(document.body).toHaveFocus();
  });

  it('leaves the focus on the page after a wheel on the canvas during the reply (it moves the camera)', async () => {
    await sendFromTheNode();
    fireEvent.wheel(document.querySelector('.canvas-viewport')!, { deltaY: 120 });
    await replyEnds();
    expect(document.body).toHaveFocus();
  });
});
