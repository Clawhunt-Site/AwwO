// An attachment box's notice (a file refused: empty, too large, one too many) closes from its own ✕ (关闭), which goes with
// it. Pressed with the keyboard's focus on it, the ✕ may not leave the focus on the page's body; pressed with the pointer,
// it may not take the focus from where it was. Every attachment box: a node's message box, the canvas assistant's, and the
// fields of a node's inputs.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTile, type SessionTileProps } from '../src/canvas/SessionTile';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import type { CanvasNode, SessionNode } from '../src/canvas/canvasDoc';
import { resetAllSessions } from '../src/canvas/sessions';
import { CanvasUiModeProvider } from '../src/canvas/uiMode';
import { TileComposer } from '../src/canvas/TileComposer';
import { CanvasAssistant, type CanvasAssistantProps } from '../src/canvas/CanvasAssistant';
import { ContractFields } from '../src/canvas/ContractFields';
import { AttachButton, AttachmentTray, useComposerAttachments } from '../src/canvas/ComposerAttachments';
import { refuseHeldEnter } from '../src/canvas/heldEnter';
import { joinAttachments, MAX_COMPOSER_ATTACHMENTS, type ComposerAttachment } from '../src/canvas/attachments';
import type { ContractField } from '../src/canvas/nodeContracts';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

const tenant = { id: 'tenant-a', name: 'A', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const ID_A = 'aUPLOADaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'aUPLOADbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FILES: ComposerAttachment[] = [{ id: ID_A, name: 'a.png' }, { id: ID_B, name: 'b.pdf' }];

/** The upload route: every request holds (an upload going) until the test ends. */
class HeldUpload {
  static sent: HeldUpload[] = [];
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null;
  status = 0; responseText = ''; withCredentials = false;
  open() {}
  setRequestHeader() {}
  abort() { this.onabort?.(); }
  send() { HeldUpload.sent.push(this); }
}

let focusCalls: Array<unknown[]> = [];
beforeEach(() => {
  resetAllSessions(); localStorage.clear();
  configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
  HeldUpload.sent = [];
  vi.stubGlobal('XMLHttpRequest', HeldUpload);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
  // What each focus() was asked: none may scroll (the canvas root clips, so a scroll would shift it).
  const focus = HTMLElement.prototype.focus;
  focusCalls = [];
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, ...args: unknown[]) {
    focusCalls.push(args);
    return focus.apply(this, args as [FocusOptions?]);
  });
});
// A press from the keyboard leaves its held-Enter guard armed until a key event; the window losing the focus ends it.
afterEach(() => { window.dispatchEvent(new Event('blur')); cleanup(); clearSaaSCanvas(); resetAllSessions(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** A file the box refuses at once (an empty one), so its notice says why. */
const refuse = (box: Element, name = 'empty.txt') =>
  fireEvent.change(box.querySelector('input[type=file]')!, { target: { files: [new File([], name, { type: 'text/plain' })] } });
const notice = () => document.querySelector('.awwo-attachment-notice:not(.is-info)');
const closeButton = () => within(notice() as HTMLElement).getByRole('button', { name: '关闭', exact: true });
const composerBox = () => screen.getByTestId('composer-input');

/** From the keyboard: Enter or Space on a focused button is its click. */
function press(button: HTMLElement) {
  button.focus();
  focusCalls = [];
  fireEvent.click(button);
}
/** What the press moved the focus with: only ever without scrolling. */
const movedWithoutScrolling = () => {
  expect(focusCalls.length).toBeGreaterThan(0);
  for (const args of focusCalls) expect(args).toEqual([{ preventScroll: true }]);
};

function ComposerHost({ initial = '', streaming = false, blocked = false, onSend = vi.fn(), accessory }:
  { initial?: string; streaming?: boolean; blocked?: boolean; onSend?: (message: string) => void; accessory?: ReactNode }) {
  const [draft, setDraft] = useState(initial);
  return <><TileComposer streaming={streaming} blocked={blocked} draft={draft} onDraftChange={setDraft} onSend={onSend} attachNodeId="node-a" accessory={accessory} />
    <button type="button">别处</button></>;
}
/** Enter held down on what has the focus: an auto-repeat (the first press clicked the ✕). Returns whether it went on. */
const heldEnter = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Enter', code: 'Enter', repeat: true });

describe('an attachment notice’s ✕', () => {
  it('in a node’s message box gives the focus to the box’s text field', () => {
    render(<ComposerHost initial={joinAttachments('说明', FILES, 'zh')} />);
    refuse(document.querySelector('.canvas-composer')!);
    expect(notice()).toHaveTextContent('「empty.txt」是空文件');
    press(closeButton());
    expect(notice()).toBeNull();
    expect(document.activeElement).toBe(composerBox());
    expect(composerBox()).toHaveValue('说明');
    movedWithoutScrolling();
  });

  it('says one file too many and closes the same way', () => {
    const full = Array.from({ length: MAX_COMPOSER_ATTACHMENTS }, (_, index) => ({ id: `aUPLOAD${String(index).padStart(27, 'x')}`, name: `page-${index}.pdf` }));
    render(<ComposerHost initial={joinAttachments('', full, 'zh')} />);
    fireEvent.change(document.querySelector('.canvas-composer input[type=file]')!, { target: { files: [new File(['x'], 'more.pdf')] } });
    expect(notice()).toHaveTextContent(String(MAX_COMPOSER_ATTACHMENTS));
    press(closeButton());
    expect(notice()).toBeNull();
    expect(document.activeElement).toBe(composerBox());
  });

  it('in an opened node’s message box gives it to that box’s text field', () => {
    function TileHost({ initial, ...props }: { initial: CanvasNode } & Partial<SessionTileProps>) {
      const [node, setNode] = useState(initial);
      return <CanvasUiModeProvider mode="developer"><SessionTile node={node} scale={1} focused initializeOnSend onSend={vi.fn()}
        onUpdateNode={next => setNode(next)} {...props} /></CanvasUiModeProvider>;
    }
    const template = createAgentTemplate('frontend', { x: 0, y: 0 }, 'zh');
    const node: SessionNode = { ...template, id: 'n', contract: { ...template.contract!, inputs: template.contract!.inputs.map(field => field.required ? { ...field, value: '已约定' } : field) } };
    render(<TileHost initial={node} />);
    refuse(document.querySelector('.canvas-composer')!);
    press(closeButton());
    expect(notice()).toBeNull();
    expect(document.activeElement).toBe(composerBox());
    movedWithoutScrolling();
  });

  it('in the canvas assistant gives it to the assistant’s text field', () => {
    function Host() {
      const [draft, setDraft] = useState('');
      const props: CanvasAssistantProps = { mode: 'panel', messages: [], draft, onDraftChange: setDraft, busy: false, onSend: vi.fn(), onCancel: vi.fn() };
      return <CanvasAssistant {...props} />;
    }
    render(<Host />);
    refuse(document.querySelector('form.awwo-assistant-composer')!);
    press(closeButton());
    expect(notice()).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('画布需求'));
    movedWithoutScrolling();
  });

  describe('in a node’s inputs', () => {
    const fields = (): ContractField[] => [
      { id: 'refs', label: '素材', type: 'file', required: false, value: joinAttachments('', FILES, 'zh') },
      { id: 'notes', label: '说明', type: 'markdown', required: false, value: '初稿' },
    ];
    function FieldsHost() {
      const [value, setValue] = useState(fields);
      return <ContractFields fields={value} onChange={setValue} label="输入" valuesFirst />;
    }

    it('gives it to the field’s own text, never another field’s', () => {
      render(<FieldsHost />);
      refuse(document.querySelector('.awwo-file-field')!);
      press(closeButton());
      expect(notice()).toBeNull();
      expect(document.activeElement).toBe(screen.getByLabelText('素材的值'));
      // A held Enter would go on typing newlines into the field it went to: refused until the key is up.
      expect(heldEnter()).toBe(false);
      fireEvent.keyUp(document.activeElement!, { key: 'Enter', code: 'Enter' });
      refuse(document.querySelector('.awwo-markdown')!);
      press(closeButton());
      expect(notice()).toBeNull();
      expect(document.activeElement).toBe(screen.getByLabelText('说明的值'));
      expect(screen.getByLabelText('说明的值')).toHaveValue('初稿');
      movedWithoutScrolling();
    });

    it('gives it to the field’s first control while a Markdown field shows its preview', () => {
      render(<FieldsHost />);
      const markdown = document.querySelector('.awwo-markdown') as HTMLElement;
      refuse(markdown);
      fireEvent.click(screen.getByRole('button', { name: '预览说明', exact: true }));
      expect(screen.queryByLabelText('说明的值')).toBeNull();
      press(closeButton());
      expect(notice()).toBeNull();
      expect(document.activeElement).toBe(within(markdown).getByRole('button', { name: '添加文件', exact: true }));
      movedWithoutScrolling();
    });
  });

  it('in a box shut while its node works leaves the focus to the page, never to one of its files or what else it offers', async () => {
    // A node's reply is a run of its lane: its box is shut (blocked) as well as streaming. Its text takes no focus; the
    // focus falls to the page as before (where the box gives it back once it opens again), not to a file's link, an
    // upload's cancel (enabled in a shut box: a stray Enter there would stop it) or the model picker beside the box.
    const files = joinAttachments('说明', FILES, 'zh');
    const model = <select aria-label="模型"><option>模型 A</option></select>;
    const view = render(<ComposerHost initial={files} accessory={model} />);
    fireEvent.change(document.querySelector('.canvas-composer input[type=file]')!,
      { target: { files: [new File(['x'], 'one.mov'), new File([], 'empty.txt')] } });
    const cancel = await screen.findByRole('button', { name: '取消上传 one.mov', exact: true });
    await waitFor(() => expect(HeldUpload.sent).toHaveLength(1));
    view.rerender(<ComposerHost initial={files} accessory={model} streaming blocked />);
    expect(composerBox()).toBeDisabled();
    expect(cancel).toBeEnabled();
    expect(screen.getByRole('link', { name: 'a.png' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '模型' })).toBeEnabled();
    press(closeButton());
    expect(notice()).toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(screen.getByRole('button', { name: '取消上传 one.mov', exact: true })).toBe(cancel);
  });

  it('in the canvas assistant while it waits leaves the focus to the page, from where the assistant gives it back', () => {
    function Host({ busy }: { busy: boolean }) {
      const [draft, setDraft] = useState('');
      const props: CanvasAssistantProps = { mode: 'panel', messages: [], draft, onDraftChange: setDraft, busy, onSend: vi.fn(), onCancel: vi.fn() };
      return <CanvasAssistant {...props} />;
    }
    const view = render(<Host busy={false} />);
    refuse(document.querySelector('form.awwo-assistant-composer')!);
    // A plan started elsewhere (a next step, a node's request): the box waits with its notice still up.
    view.rerender(<Host busy />);
    expect(screen.getByLabelText('画布需求')).toBeDisabled();
    press(closeButton());
    expect(notice()).toBeNull();
    // Not on 用户须知, which the assistant would leave it on: from the page, its wait's end gives the box the focus.
    expect(document.activeElement).toBe(document.body);
    view.rerender(<Host busy={false} />);
    expect(document.activeElement).toBe(screen.getByLabelText('画布需求'));
  });

  it('in a box that draws no text field gives it to the first other control, never the notice’s own ✕ or a file’s', () => {
    // A box laid out with its files and its notice first, in a part of their own: the "+" after them, elsewhere in the box,
    // is where the focus goes.
    function NoField() {
      const [value, setValue] = useState(joinAttachments('', FILES, 'zh'));
      const attach = useComposerAttachments({ value, onChange: setValue });
      return <div {...attach.dropProps}><div className="tray"><AttachmentTray state={attach} /></div><AttachButton state={attach} /></div>;
    }
    render(<NoField />);
    refuse(document.querySelector('[data-attachment-box]')!);
    press(closeButton());
    expect(notice()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '添加文件', exact: true }));
    movedWithoutScrolling();
  });

  it('stops an Enter held down where the focus went: its repeats neither send the draft nor type', () => {
    const onSend = vi.fn();
    render(<ComposerHost initial="说明" onSend={onSend} />);
    refuse(document.querySelector('.canvas-composer')!);
    press(closeButton());
    expect(document.activeElement).toBe(composerBox());
    expect(heldEnter()).toBe(false);
    // Shift+Enter, then Shift let go with Enter still held: the bare repeats would send.
    fireEvent.keyUp(composerBox(), { key: 'Shift', code: 'ShiftLeft' });
    expect(heldEnter()).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(composerBox()).toHaveValue('说明');
    // Once the key is up, Enter sends as ever.
    fireEvent.keyUp(composerBox(), { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(composerBox(), { key: 'Enter', code: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('说明');
  });

  it('stops a held Enter at a file’s own ✕ too (its hand-off, close-focus’s): no next file, no send', () => {
    const onSend = vi.fn();
    render(<ComposerHost initial={joinAttachments('说明', FILES, 'zh')} onSend={onSend} />);
    const removeButton = (name: string) => screen.getByRole('button', { name: `移除 ${name}`, exact: true });
    press(removeButton('a.png'));
    expect(document.activeElement).toBe(removeButton('b.pdf'));
    expect(heldEnter()).toBe(false);
    fireEvent.keyUp(removeButton('b.pdf'), { key: 'Enter', code: 'Enter' });
    press(removeButton('b.pdf'));
    expect(document.activeElement).toBe(composerBox());
    expect(heldEnter()).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(composerBox()).toHaveValue('说明');
  });

  it('takes no focus from a pointer press, so a click leaves the focus where it was, the page’s own included', () => {
    render(<ComposerHost initial="说明" />);
    refuse(document.querySelector('.canvas-composer')!);
    composerBox().focus();
    // A pointer press is the ✕'s mousedown, refused, so Chrome does not move the focus onto the ✕ (jsdom never does).
    expect(fireEvent.mouseDown(closeButton())).toBe(false);
    fireEvent.click(closeButton(), { detail: 1 });
    expect(notice()).toBeNull();
    expect(document.activeElement).toBe(composerBox());
    // With nothing focused (the canvas's keys work from the page's body), a click leaves nothing focused.
    refuse(document.querySelector('.canvas-composer')!);
    composerBox().blur();
    expect(document.activeElement).toBe(document.body);
    expect(fireEvent.mouseDown(closeButton())).toBe(false);
    fireEvent.click(closeButton(), { detail: 1 });
    expect(notice()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('leaves a focus that was not in the notice where it was', () => {
    render(<ComposerHost />);
    refuse(document.querySelector('.canvas-composer')!);
    const elsewhere = screen.getByRole('button', { name: '别处', exact: true });
    elsewhere.focus();
    fireEvent.click(closeButton());
    expect(notice()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('hands it on from a click on the ✕ the keyboard is on, as Enter would', () => {
    render(<ComposerHost />);
    refuse(document.querySelector('.canvas-composer')!);
    closeButton().focus();
    expect(fireEvent.mouseDown(closeButton())).toBe(false);
    fireEvent.click(closeButton(), { detail: 1 });
    expect(notice()).toBeNull();
    expect(document.activeElement).toBe(composerBox());
  });
});

describe('refuseHeldEnter', () => {
  /** What a listener after the guard hears: the page's own handlers (React's among them) are there. */
  let heard: string[] = [];
  const listener = (event: KeyboardEvent) => heard.push(`${event.key}${event.repeat ? ' (repeat)' : ''}`);
  beforeEach(() => { heard = []; window.addEventListener('keydown', listener); });
  afterEach(() => window.removeEventListener('keydown', listener));
  const key = (init: KeyboardEventInit) => fireEvent.keyDown(document.body, init);
  const repeat = () => key({ key: 'Enter', code: 'Enter', repeat: true });

  it('after a key’s click, refuses the repeats of an Enter held down until a key comes up', () => {
    refuseHeldEnter({ detail: 0 });
    expect(repeat()).toBe(false);
    expect(repeat()).toBe(false);
    expect(heard).toEqual([]);
    fireEvent.keyUp(document.body, { key: 'Enter', code: 'Enter' });
    expect(repeat()).toBe(true);
    expect(heard).toEqual(['Enter (repeat)']);
  });

  it('lets a fresh press of Enter go, and refuses nothing after it', () => {
    refuseHeldEnter({ detail: 0 });
    expect(key({ key: 'Enter', code: 'Enter' })).toBe(true);
    expect(repeat()).toBe(true);
    expect(heard).toEqual(['Enter', 'Enter (repeat)']);
  });

  it('goes on through a modifier pressed or let go while Enter is held (Shift+Enter, then Shift up)', () => {
    refuseHeldEnter({ detail: 0 });
    expect(key({ key: 'Shift', code: 'ShiftLeft' })).toBe(true);
    expect(key({ key: 'Shift', code: 'ShiftLeft', repeat: true })).toBe(true);
    expect(repeat()).toBe(false);
    fireEvent.keyUp(document.body, { key: 'Shift', code: 'ShiftLeft' });
    expect(repeat()).toBe(false);
    fireEvent.keyUp(document.body, { key: 'Control', code: 'ControlLeft' });
    expect(repeat()).toBe(false);
    expect(heard).toEqual(['Shift', 'Shift (repeat)']);
    fireEvent.keyUp(document.body, { key: 'Enter', code: 'Enter' });
    expect(repeat()).toBe(true);
  });

  it('ends at another key, which goes through, and when the window loses the focus', () => {
    refuseHeldEnter({ detail: 0 });
    expect(key({ key: 'a', code: 'KeyA' })).toBe(true);
    expect(repeat()).toBe(true);
    refuseHeldEnter({ detail: 0 });
    window.dispatchEvent(new Event('blur'));
    expect(repeat()).toBe(true);
    expect(heard).toEqual(['a', 'Enter (repeat)', 'Enter (repeat)']);
  });

  it('refuses nothing after a pointer’s click', () => {
    refuseHeldEnter({ detail: 1 });
    expect(repeat()).toBe(true);
    expect(heard).toEqual(['Enter (repeat)']);
  });

  it('keeps one guard: a later key’s click takes the place of the one before', () => {
    const removed = vi.spyOn(window, 'removeEventListener');
    refuseHeldEnter({ detail: 0 });
    expect(removed).not.toHaveBeenCalled();
    refuseHeldEnter({ detail: 0 });
    expect(removed.mock.calls.map(([type]) => type)).toEqual(['keydown', 'keyup', 'blur']);
    expect(repeat()).toBe(false);
  });
});
