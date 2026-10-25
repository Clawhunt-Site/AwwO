// A part of an opened node that closes from its own button takes that button with it: the template guide's ✕, the delivery
// drawer's ✕, the sessions list's collapse (and the heading's 展开 Session 列表, which the list replaces), and an
// attachment chip's own ✕ in every attachment box. Pressed with the keyboard's focus on it, none of them may leave the
// focus on the page's body.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTile, type SessionTileProps } from '../src/canvas/SessionTile';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { createSessionNode, type CanvasDocument, type CanvasNode, type SessionNode } from '../src/canvas/canvasDoc';
import { invalidateOutputs } from '../src/canvas/invalidateOutputs';
import { getNodeThreads } from '../src/canvas/nodeThreads';
import { resetAllSessions } from '../src/canvas/sessions';
import { CanvasUiModeProvider, type CanvasUiMode } from '../src/canvas/uiMode';
import { TileComposer } from '../src/canvas/TileComposer';
import { CanvasAssistant, type CanvasAssistantProps } from '../src/canvas/CanvasAssistant';
import { ContractFields } from '../src/canvas/ContractFields';
import { attachmentKind, joinAttachments, type ComposerAttachment } from '../src/canvas/attachments';
import type { ContractField } from '../src/canvas/nodeContracts';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

const tenant = { id: 'tenant-a', name: 'A', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const ID_A = 'aUPLOADaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'aUPLOADbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ID_C = 'aUPLOADccccccccccccccccccccccccccc';
const FILES: ComposerAttachment[] = [{ id: ID_A, name: 'a.png' }, { id: ID_B, name: 'b.pdf' }, { id: ID_C, name: 'c.mp4' }];

/** The upload route: every request holds until told to finish (201 with the next id) or to fail. */
class FakeUpload {
  static sent: FakeUpload[] = [];
  static ids: string[] = [];
  url = ''; method = ''; body: unknown; status = 0; responseText = ''; withCredentials = false;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null;
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader() {}
  abort() { this.onabort?.(); }
  send(body: unknown) { this.body = body; FakeUpload.sent.push(this); }
  finish(status = 201) {
    const file = this.body as File;
    const id = FakeUpload.ids.shift() ?? ID_A;
    this.status = status;
    this.responseText = status === 201
      ? JSON.stringify({ id, reference: `awwo-file:${id}`, name: file.name, size: file.size, contentType: file.type || 'application/octet-stream', kind: attachmentKind(file.name), inline: false })
      : JSON.stringify({ error: { code: 'upload_quota_exceeded', message: 'quota' } });
    this.onload?.();
  }
}

let focusCalls: Array<unknown[]> = [];
/** What a browser does not draw, so cannot focus (jsdom loads no stylesheet and focuses it): a selector, set by a test. */
let undrawn: string | null = null;
beforeEach(() => {
  resetAllSessions(); localStorage.clear();
  FakeUpload.sent = []; FakeUpload.ids = []; undrawn = null;
  vi.stubGlobal('XMLHttpRequest', FakeUpload);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  // What each focus() was asked: none may scroll (the canvas root clips, so a scroll would shift it).
  const focus = HTMLElement.prototype.focus;
  focusCalls = [];
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, ...args: unknown[]) {
    focusCalls.push(args);
    if (undrawn && this.closest(undrawn)) return;
    return focus.apply(this, args as [FocusOptions?]);
  });
});
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
/** A browser that focused nothing on the click (Safari), with nothing focused before either. */
function clickUnfocused(button: HTMLElement) {
  (document.activeElement as HTMLElement | null)?.blur();
  expect(document.activeElement).toBe(document.body);
  fireEvent.click(button);
}

function TileHost({ initial, mode = 'developer', initializeOnSend = true, ...props }: { initial: CanvasNode; mode?: CanvasUiMode; initializeOnSend?: boolean } & Partial<SessionTileProps>) {
  const [node, setNode] = useState(initial);
  return <CanvasUiModeProvider mode={mode}><SessionTile node={node} scale={1} focused initializeOnSend={initializeOnSend} onSend={vi.fn()}
    onUpdateNode={next => setNode(next)} {...props} /></CanvasUiModeProvider>;
}
/** A role node whose required inputs are filled in, so its message box is open. */
const templated = (): SessionNode => {
  const node = createAgentTemplate('frontend', { x: 0, y: 0 }, 'zh');
  return { ...node, id: 'n', contract: { ...node.contract!, inputs: node.contract!.inputs.map(field => field.required ? { ...field, value: '已约定' } : field) } };
};
/** A node that asks for rework: its note's toggle is the conversation's first control. */
const reworked = (): SessionNode => ({ ...templated(), taskFrame: { version: 1, source: 'manual', constraints: ['【验收返工·交付验收】交付结果没有列出检查过的文件。'], acceptanceCriteria: [] } });
const delivered = (): SessionNode => ({ ...templated(), lastOutput: { text: JSON.stringify({ summary: '## 已完成' }), source: 'run', at: 1 } });
const composerBox = () => screen.getByTestId('composer-input');
const more = () => screen.getByRole('button', { name: '更多节点操作', exact: true });

describe('the template guide closed from its own button', () => {
  const toggle = () => screen.getByRole('button', { name: '模板指引', exact: true });
  const guide = () => screen.queryByRole('region', { name: '模板指引', exact: true });
  const close = () => within(guide()!).getByRole('button', { name: '收起模板指引', exact: true });

  it('gives the focus to the template toggle in the chat heading', () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    press(close());
    expect(guide()).toBeNull();
    expect(document.activeElement).toBe(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    movedWithoutScrolling();
    // A focus anywhere in the guide goes there too (in Safari a click on ✕ leaves it on the 编辑 the keyboard was on).
    fireEvent.click(toggle());
    within(guide()!).getAllByRole('button', { name: /编辑/ })[0].focus();
    fireEvent.click(close());
    expect(guide()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });

  it('leaves a focus that was not in it where it was', () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    composerBox().focus();
    fireEvent.click(close());
    expect(guide()).toBeNull();
    expect(document.activeElement).toBe(composerBox());
    fireEvent.click(toggle());
    clickUnfocused(close());
    expect(guide()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('gives it to the message box where no toggle opens it again, else to the conversation’s first control, else to the node menu', () => {
    // A guide left open as the canvas turned to its simple view, where no template toggle is drawn.
    const first = render(<TileHost initial={templated()} />);
    fireEvent.click(toggle());
    first.rerender(<TileHost initial={templated()} mode="simple" />);
    expect(document.querySelector('.awwo-template-toggle')).toBeNull();
    press(close());
    expect(guide()).toBeNull();
    expect(document.activeElement).toBe(composerBox());
    movedWithoutScrolling();
    first.unmount();
    // Not set up and with no way to start it here, the message box is shut: the rework note's toggle, not the guide's own controls.
    const second = render(<TileHost initial={reworked()} initializeOnSend={false} />);
    fireEvent.click(toggle());
    second.rerender(<TileHost initial={reworked()} initializeOnSend={false} mode="simple" />);
    expect(composerBox()).toBeDisabled();
    press(close());
    expect(guide()).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('.awwo-rework-note-toggle'));
    second.unmount();
    // Nothing in the conversation takes it but the guide's own controls: the node's menu button.
    const third = render(<TileHost initial={templated()} initializeOnSend={false} />);
    fireEvent.click(toggle());
    third.rerender(<TileHost initial={templated()} initializeOnSend={false} mode="simple" />);
    press(close());
    expect(guide()).toBeNull();
    expect(document.activeElement).toBe(more());
  });
});

describe('the delivery drawer closed from its own button', () => {
  const drawer = () => screen.queryByRole('region', { name: '交付物', exact: true });
  const close = () => within(drawer()!).getByRole('button', { name: '关闭交付物', exact: true });

  it.each([
    ['opened from the node tools', () => templated(), true],
    ['that opened by itself beside a delivery', () => delivered(), false],
  ])('gives the focus to the node tools’ 展开交付物 when %s', (_how, node, open) => {
    render(<TileHost initial={node()} />);
    if (open) fireEvent.click(screen.getByRole('button', { name: '展开交付物', exact: true }));
    expect(drawer()).not.toBeNull();
    press(close());
    expect(drawer()).toBeNull();
    const toggle = screen.getByRole('button', { name: '展开交付物', exact: true });
    expect(document.activeElement).toBe(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    movedWithoutScrolling();
  });

  it('does so while the node runs, when the drawer closes for this reader only', () => {
    const onToggleDeliverables = vi.fn();
    render(<TileHost initial={delivered()} run={{ state: 'running' }} onToggleDeliverables={onToggleDeliverables} />);
    press(close());
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '展开交付物', exact: true }));
    expect(onToggleDeliverables).not.toHaveBeenCalled();
  });

  it('does so from a drawer kept open while its output form is edited, the edit having taken its delivery back', () => {
    const contract = { version: 1 as const, inputs: [], outputs: [{ id: 'result', label: '交付结果', type: 'markdown' as const, required: true, value: '' }] };
    const made: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'd', title: '交付', contract,
      lastOutput: { text: '{"result":"## 第一版"}', source: 'run', at: 1 } };
    // As the canvas holds it: an edit of the output form takes the delivery back (invalidateOutputs).
    const doc = (node: CanvasNode): CanvasDocument => ({ version: 2, updatedAt: 0, nodes: [node], edges: [], waypoints: [], view: null });
    function Host() {
      const [node, setNode] = useState<SessionNode>({ ...made, threads: getNodeThreads(made) });
      return <SessionTile node={node} scale={1} focused onSend={vi.fn()} initializeOnSend
        onUpdateNode={next => setNode(invalidateOutputs(doc(node), doc(next)).nodes[0] as SessionNode)} />;
    }
    render(<Host />);
    fireEvent.click(within(drawer()!).getByText('编辑输出表单'));
    fireEvent.change(screen.getByLabelText('交付结果的值'), { target: { value: '## 第二版' } });
    expect(within(drawer()!).getByText('历史交付 · 未传递给下游')).toBeTruthy();
    press(close());
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '展开交付物', exact: true }));
    movedWithoutScrolling();
  });

  it('leaves a focus that was not in it where it was', () => {
    render(<TileHost initial={delivered()} />);
    composerBox().focus();
    fireEvent.click(close());
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(composerBox());
    fireEvent.click(screen.getByRole('button', { name: '展开交付物', exact: true }));
    clickUnfocused(close());
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('the sessions list collapsed from its own button, and the button that opens it in its place', () => {
  const list = () => screen.queryByRole('navigation', { name: 'Session 管理', exact: true });
  const expand = () => screen.getByRole('button', { name: '展开 Session 列表', exact: true });
  const collapse = () => within(list()!).getByRole('button', { name: '收起 Session 列表', exact: true });

  it('gives the focus to the chat heading’s 展开 Session 列表, drawn as the list closes', () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(expand());
    press(collapse());
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(expand());
    movedWithoutScrolling();
    // A focus anywhere in the list goes there too (in Safari a click leaves it on the conversation the keyboard was on).
    fireEvent.click(expand());
    within(list()!).getByRole('button', { name: '打开 对话 1', exact: true }).focus();
    fireEvent.click(collapse());
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(expand());
  });

  it('leaves a focus that was not in it where it was', () => {
    render(<TileHost initial={templated()} />);
    fireEvent.click(expand());
    composerBox().focus();
    fireEvent.click(collapse());
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(composerBox());
    fireEvent.click(expand());
    clickUnfocused(collapse());
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('takes the focus to its 收起 Session 列表 when 展开 Session 列表, which it replaces, opens it', () => {
    render(<TileHost initial={templated()} />);
    press(expand());
    expect(list()).not.toBeNull();
    expect(screen.queryByRole('button', { name: '展开 Session 列表', exact: true })).toBeNull();
    expect(document.activeElement).toBe(collapse());
    movedWithoutScrolling();
    // There and back from the keyboard.
    press(collapse());
    press(expand());
    expect(document.activeElement).toBe(collapse());
    // Opened by a click that focused nothing, or with the focus elsewhere, it moves nothing.
    composerBox().focus();
    fireEvent.click(collapse());
    fireEvent.click(expand());
    expect(document.activeElement).toBe(composerBox());
    fireEvent.click(collapse());
    clickUnfocused(expand());
    expect(document.activeElement).toBe(document.body);
  });

  it('gives it to the message box where no button opens it again, else to the conversation’s first control, else to the node menu', () => {
    // A list left open as the canvas turned to its simple view, which draws no 展开 Session 列表.
    const collapsedInSimpleView = (node: SessionNode, initializeOnSend = true) => {
      const view = render(<TileHost initial={node} initializeOnSend={initializeOnSend} />);
      fireEvent.click(expand());
      view.rerender(<TileHost initial={node} initializeOnSend={initializeOnSend} mode="simple" />);
      press(collapse());
      expect(list()).toBeNull();
      expect(screen.queryByRole('button', { name: '展开 Session 列表', exact: true })).toBeNull();
      return view;
    };
    const first = collapsedInSimpleView(templated());
    expect(document.activeElement).toBe(composerBox());
    movedWithoutScrolling();
    first.unmount();
    // The message box shut: the conversation's first control as the render that closed the list drew it (a starter).
    const second = collapsedInSimpleView(templated(), false);
    expect(composerBox()).toBeDisabled();
    expect(document.activeElement).toBe(document.querySelector('.awwo-starter-prompts button'));
    second.unmount();
    // With no control in the conversation either, the node's own menu button.
    collapsedInSimpleView({ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'p' }, false);
    expect(document.activeElement).toBe(more());
  });

  it('skips a control the opened inputs hide and goes on down the line', () => {
    // Beside the opened inputs the conversation gives way (awwo-node.css: its starters are not drawn, so take no focus).
    undrawn = '.awwo-node-chat.has-inputs .awwo-input-drawer + .awwo-node-panel--conversation > :is(.canvas-transcript, .awwo-node-empty)';
    const view = render(<TileHost initial={templated()} initializeOnSend={false} />);
    fireEvent.click(expand());
    view.rerender(<TileHost initial={templated()} initializeOnSend={false} mode="simple" />);
    fireEvent.click(within(list()!).getByRole('button', { name: '输入', exact: true }));
    expect(document.querySelector('.awwo-node-chat.has-inputs .awwo-starter-prompts button')).not.toBeNull();
    press(collapse());
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(more());
  });

  it('never takes the focus from where something else put it as the list closed or opened', () => {
    render(<div onClick={() => document.getElementById('elsewhere')!.focus()}><TileHost initial={templated()} />
      <button type="button" id="elsewhere">别处</button></div>);
    const elsewhere = screen.getByRole('button', { name: '别处', exact: true });
    press(expand());
    expect(list()).not.toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    press(collapse());
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe('an attachment chip’s own ✕', () => {
  beforeEach(() => configureSaaSCanvas({ tenant, canvasId: 'canvas-a' }));
  const removeButton = (name: string) => screen.getByRole('button', { name: `移除 ${name}`, exact: true });
  const chipNames = () => Array.from(document.querySelectorAll('.awwo-attachment-chip .awwo-attachment-name'), element => element.textContent);
  const pick = (input: Element, ...names: string[]) => fireEvent.change(input.querySelector('input[type=file]')!,
    { target: { files: names.map(name => new File(['x'], name, { type: 'application/octet-stream' })) } });

  function ComposerHost({ initial, streaming = false, blocked = false, refuse = false }: { initial: string; streaming?: boolean; blocked?: boolean; refuse?: boolean }) {
    const [draft, setDraft] = useState(initial);
    return <><TileComposer streaming={streaming} blocked={blocked} draft={draft} onDraftChange={refuse ? () => {} : setDraft} onSend={vi.fn()} attachNodeId="node-a" />
      <output data-testid="draft">{draft}</output></>;
  }

  it('in a node’s message box hands the focus to the chip that takes its place, else the one before it, else the box', () => {
    render(<TileHost initial={{ ...templated(), threads: [{ id: 'default', title: 'Session 1', issueId: null, preview: '', draft: joinAttachments('说明', FILES, 'zh'), createdAt: 1 }], activeThreadId: 'default' }} />);
    press(removeButton('b.pdf'));
    expect(chipNames()).toEqual(['a.png', 'c.mp4']);
    expect(document.activeElement).toBe(removeButton('c.mp4'));
    movedWithoutScrolling();
    press(removeButton('c.mp4'));
    expect(chipNames()).toEqual(['a.png']);
    expect(document.activeElement).toBe(removeButton('a.png'));
    press(removeButton('a.png'));
    expect(chipNames()).toEqual([]);
    expect(document.activeElement).toBe(composerBox());
    expect(composerBox()).toHaveValue('说明');
  });

  it('does the same for uploads going and failed: their cancel and dismiss', async () => {
    render(<ComposerHost initial={joinAttachments('', [FILES[0]], 'zh')} />);
    pick(document.querySelector('.canvas-composer')!, 'one.mov', 'two.mov', 'three.mov');
    await waitFor(() => expect(FakeUpload.sent).toHaveLength(3));
    act(() => FakeUpload.sent[2].finish(429));
    await screen.findByRole('alert');
    const cancel = (name: string) => screen.getByRole('button', { name: `取消上传 ${name}`, exact: true });
    press(cancel('one.mov'));
    expect(chipNames()).toEqual(['a.png', 'two.mov', 'three.mov']);
    expect(document.activeElement).toBe(cancel('two.mov'));
    movedWithoutScrolling();
    press(screen.getByRole('button', { name: '关闭 three.mov', exact: true }));
    expect(chipNames()).toEqual(['a.png', 'two.mov']);
    expect(document.activeElement).toBe(cancel('two.mov'));
    // The uploads come after the files: before the last one is the file's chip.
    press(cancel('two.mov'));
    expect(chipNames()).toEqual(['a.png']);
    expect(document.activeElement).toBe(removeButton('a.png'));
  });

  it('in a box that is shut while a reply streams gives it to a file’s link, then to what the box still offers', async () => {
    const shut = async (initial: string, upload: string) => {
      const view = render(<ComposerHost initial={initial} />);
      pick(document.querySelector('.canvas-composer')!, upload);
      await screen.findByText(upload);
      view.rerender(<ComposerHost initial={initial} streaming />);
      press(screen.getByRole('button', { name: `取消上传 ${upload}`, exact: true }));
      return view;
    };
    // Shut, the box's files cannot be taken back; an upload can still be stopped. The file before it is the one it goes to.
    const first = await shut(joinAttachments('', FILES.slice(0, 2), 'zh'), 'one.mov');
    expect(removeButton('b.pdf')).toBeDisabled();
    expect(chipNames()).toEqual(['a.png', 'b.pdf']);
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'b.pdf' }));
    first.unmount();
    // Nothing but the upload: its text shut too, the box's first control that takes the focus (用户须知).
    await shut('', 'two.mov');
    expect(chipNames()).toEqual([]);
    expect(composerBox()).toBeDisabled();
    expect(document.activeElement).toBe(document.querySelector('.awwo-composer-notes-button'));
    movedWithoutScrolling();
  });

  it('keeps the focus on a chip its box’s owner keeps', () => {
    render(<ComposerHost initial={joinAttachments('', FILES.slice(0, 2), 'zh')} refuse />);
    press(removeButton('a.png'));
    expect(chipNames()).toEqual(['a.png', 'b.pdf']);
    expect(document.activeElement).toBe(removeButton('a.png'));
  });

  it('hands nothing on for a chip that stays, even when its box shuts with the press', () => {
    // The canvas refuses the edit and locks the field in the same moment: Chrome drops the focus from the ✕ it disables
    // (jsdom keeps it there, so the test drops it as Chrome does). What the lock took is not the press's to hand on.
    function Locking() {
      const [locked, setLocked] = useState(false);
      return <ContractFields fields={[{ id: 'refs', label: '素材', type: 'file', required: false, value: joinAttachments('', FILES.slice(0, 2), 'zh') }]} readOnly={locked}
        onChange={() => { setLocked(true); (document.activeElement as HTMLElement | null)?.blur(); }} label="输入" valuesFirst />;
    }
    render(<Locking />);
    press(removeButton('a.png'));
    expect(chipNames()).toEqual(['a.png', 'b.pdf']);
    expect(removeButton('a.png')).toBeDisabled();
    expect(document.activeElement).toBe(document.body);
  });

  it('lets a refused press go at once: a file that leaves later, from elsewhere, moves nothing', () => {
    // An owner that draws nothing for a refused change (the inputs' canvas), and an undo outside the box.
    function Undo() {
      const [value, setValue] = useState<ContractField[]>([{ id: 'refs', label: '素材', type: 'file', required: false, value: joinAttachments('', FILES.slice(0, 2), 'zh') }]);
      return <><ContractFields fields={value} onChange={() => {}} label="输入" valuesFirst />
        <button type="button" onClick={() => setValue([{ ...value[0], value: joinAttachments('', [FILES[1]], 'zh') }])}>撤销</button></>;
    }
    render(<Undo />);
    press(removeButton('a.png'));
    expect(document.activeElement).toBe(removeButton('a.png'));
    removeButton('a.png').blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByRole('button', { name: '撤销', exact: true }));
    expect(chipNames()).toEqual(['b.pdf']);
    expect(document.activeElement).toBe(document.body);
  });

  it('takes no focus from a pointer press, so a click hands nothing on and leaves the focus where it was', async () => {
    render(<ComposerHost initial={joinAttachments('说明', FILES, 'zh')} />);
    pick(document.querySelector('.canvas-composer')!, 'one.mov');
    await screen.findByText('one.mov');
    composerBox().focus();
    for (const x of [removeButton('b.pdf'), screen.getByRole('button', { name: '取消上传 one.mov', exact: true })]) {
      // A pointer press is the ✕'s mousedown, refused, so Chrome does not move the focus onto the ✕ (jsdom never does):
      // a later Enter cannot remove the file the hand-off would have put the focus on.
      expect(fireEvent.mouseDown(x)).toBe(false);
      fireEvent.click(x, { detail: 1 });
      expect(document.activeElement).toBe(composerBox());
    }
    expect(chipNames()).toEqual(['a.png', 'c.mp4']);
  });

  it('hands it on from a click on the ✕ of a chip the keyboard is on, as Enter would', () => {
    render(<ComposerHost initial={joinAttachments('', FILES.slice(0, 2), 'zh')} />);
    screen.getByRole('link', { name: 'a.png' }).focus();
    expect(fireEvent.mouseDown(removeButton('a.png'))).toBe(false);
    fireEvent.click(removeButton('a.png'), { detail: 1 });
    expect(chipNames()).toEqual(['b.pdf']);
    expect(document.activeElement).toBe(removeButton('b.pdf'));
  });

  it('leaves a focus that was not in its chip where it was', () => {
    render(<ComposerHost initial={joinAttachments('说明', FILES, 'zh')} />);
    composerBox().focus();
    fireEvent.click(removeButton('b.pdf'));
    expect(chipNames()).toEqual(['a.png', 'c.mp4']);
    expect(document.activeElement).toBe(composerBox());
    clickUnfocused(removeButton('c.mp4'));
    expect(chipNames()).toEqual(['a.png']);
    expect(document.activeElement).toBe(document.body);
  });

  it('never takes the focus from where the box’s owner put it', () => {
    function Elsewhere() {
      const [draft, setDraft] = useState(joinAttachments('', FILES.slice(0, 2), 'zh'));
      return <><TileComposer streaming={false} draft={draft} onSend={vi.fn()}
        onDraftChange={value => { setDraft(value); document.getElementById('elsewhere')!.focus(); }} />
        <button type="button" id="elsewhere">别处</button></>;
    }
    render(<Elsewhere />);
    press(removeButton('a.png'));
    expect(chipNames()).toEqual(['b.pdf']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '别处', exact: true }));
  });

  it('in the canvas assistant hands it on, then to the assistant’s box', () => {
    function Host() {
      const [draft, setDraft] = useState(joinAttachments('', FILES.slice(0, 2), 'zh'));
      const props: CanvasAssistantProps = { mode: 'panel', messages: [], draft, onDraftChange: setDraft, busy: false, onSend: vi.fn(), onCancel: vi.fn() };
      return <CanvasAssistant {...props} />;
    }
    render(<Host />);
    press(removeButton('a.png'));
    expect(document.activeElement).toBe(removeButton('b.pdf'));
    press(removeButton('b.pdf'));
    expect(chipNames()).toEqual([]);
    expect(document.activeElement).toBe(screen.getByLabelText('画布需求'));
    movedWithoutScrolling();
  });

  describe('in a node’s inputs', () => {
    const fields = (): ContractField[] => [
      { id: 'refs', label: '素材', type: 'file', required: false, value: joinAttachments('', FILES.slice(0, 2), 'zh') },
      { id: 'notes', label: '说明', type: 'markdown', required: false, value: joinAttachments('初稿', [FILES[2]], 'zh') },
    ];
    function FieldsHost({ refuse = false }: { refuse?: boolean }) {
      const [value, setValue] = useState(fields);
      return <ContractFields fields={value} onChange={refuse ? () => {} : setValue} label="输入" valuesFirst />;
    }

    it('hands it to the next file of its field, then to the field’s own text', () => {
      render(<FieldsHost />);
      press(removeButton('a.png'));
      expect(document.activeElement).toBe(removeButton('b.pdf'));
      press(removeButton('b.pdf'));
      expect(document.activeElement).toBe(screen.getByLabelText('素材的值'));
      // A Markdown field's own text, never another field's.
      press(removeButton('c.mp4'));
      expect(document.activeElement).toBe(screen.getByLabelText('说明的值'));
      expect(screen.getByLabelText('说明的值')).toHaveValue('初稿');
      movedWithoutScrolling();
    });

    it('gives it to the field’s first control while a Markdown field shows its preview', () => {
      render(<FieldsHost />);
      fireEvent.click(screen.getByRole('button', { name: '预览说明', exact: true }));
      expect(screen.queryByLabelText('说明的值')).toBeNull();
      press(removeButton('c.mp4'));
      expect(chipNames()).toEqual(['a.png', 'b.pdf']);
      const box = document.querySelectorAll('.awwo-markdown')[0];
      expect(document.activeElement).toBe(within(box as HTMLElement).getByRole('button', { name: '添加文件', exact: true }));
    });

    it('keeps the focus on a file the canvas does not let go (an edit it refuses)', () => {
      render(<FieldsHost refuse />);
      press(removeButton('a.png'));
      expect(chipNames()).toEqual(['a.png', 'b.pdf', 'c.mp4']);
      expect(document.activeElement).toBe(removeButton('a.png'));
    });
  });

  it('in a node’s opened inputs hands it within the field (the tile’s own inputs drawer)', () => {
    const node = templated();
    const withFiles: SessionNode = { ...node, contract: { ...node.contract!, inputs: [...node.contract!.inputs, { id: 'refs', label: '素材', type: 'file', required: false, value: joinAttachments('', FILES.slice(0, 2), 'zh') }] } };
    render(<TileHost initial={withFiles} />);
    fireEvent.click(document.querySelector('.awwo-input-toggle')!);
    const drawer = screen.getByRole('region', { name: '输入表单', exact: true });
    press(within(drawer).getByRole('button', { name: '移除 a.png', exact: true }));
    expect(document.activeElement).toBe(within(drawer).getByRole('button', { name: '移除 b.pdf', exact: true }));
    press(within(drawer).getByRole('button', { name: '移除 b.pdf', exact: true }));
    expect(document.activeElement).toBe(within(drawer).getByLabelText('素材的值'));
  });
});
