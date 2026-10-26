// The workspace home's own file chips and the note above them: a file's ✕ takes its chip away and the note's ✕ takes the
// note, each with the button the keyboard's focus is on. Pressed from the keyboard, neither may leave the focus on the
// page's body; pressed with the pointer, neither may take the focus from where it was.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/saas/canvasBridge', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/saas/canvasBridge')>()),
  uploadFileToCanvas: vi.fn(),
}));

import { WorkspaceHome } from '../src/saas/WorkspaceHome';
import { HomeFileChips, type HomeFile, type HomeFilesState } from '../src/saas/homeAttachments';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { Identity, Tenant } from '../src/saas/api';

const tenant: Tenant = { id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity: Identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' }, tenants: [tenant] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

let focusCalls: Array<unknown[]> = [];
/** Canvases the home created: a request it sent. */
let created: string[] = [];
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  created = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname.endsWith('/runtime')) return json({ available: true, configured: true, plannerAvailable: true, models: [{ id: 'fixture-model' }] });
    if (url.pathname.endsWith('/canvases') && init.method === 'POST') {
      const body = JSON.parse(init.body as string);
      created.push(body.name);
      return json({ id: 'new-canvas', tenantId: tenant.id, name: body.name, version: 1, document: body.document, createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z' }, 201);
    }
    if (url.pathname.endsWith('/canvases')) return json({ items: [], nextCursor: null });
    return json({ error: { message: `Unexpected ${url.pathname}` } }, 404);
  }));
  // What each focus() was asked: none may scroll the page.
  const focus = HTMLElement.prototype.focus;
  focusCalls = [];
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, ...args: unknown[]) {
    focusCalls.push(args);
    return focus.apply(this, args as [FocusOptions?]);
  });
});
// A press from the keyboard leaves its held-Enter guard armed until a key event; the window losing the focus ends it.
afterEach(() => { window.dispatchEvent(new Event('blur')); cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

const view = (onOpen = vi.fn()) => render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen} /></SaaSPreferencesProvider>);
/** Enter held down on what has the focus: an auto-repeat (the first press clicked the ✕). Returns whether it went on. */
const heldEnter = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Enter', code: 'Enter', repeat: true });
const box = () => screen.getByRole('textbox', { name: '画布需求' });
const attach = (...names: string[]) => fireEvent.change(document.querySelector<HTMLInputElement>('form.saas-home-composer input[type="file"]')!,
  { target: { files: names.map(name => new File(name.startsWith('empty') ? [] : ['bytes'], name, { type: 'application/octet-stream' })) } });
const remove = (name: string) => screen.getByRole('button', { name: `移除「${name}」`, exact: true });
const chipNames = () => Array.from(document.querySelectorAll('.saas-home-file .saas-home-file-name'), element => element.textContent);
const note = () => document.querySelector('.saas-home-files-note');
const dismiss = () => within(note() as HTMLElement).getByRole('button', { name: '关闭提示', exact: true });

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

it('hands the focus from a removed file’s ✕ to the file that takes its place, else the one before it, else the request’s text field', () => {
  view();
  fireEvent.change(box(), { target: { value: '做一个产品介绍页' } });
  attach('a.png', 'b.pdf', 'c.mp4');
  press(remove('b.pdf'));
  expect(chipNames()).toEqual(['a.png', 'c.mp4']);
  expect(document.activeElement).toBe(remove('c.mp4'));
  movedWithoutScrolling();
  press(remove('c.mp4'));
  expect(chipNames()).toEqual(['a.png']);
  expect(document.activeElement).toBe(remove('a.png'));
  movedWithoutScrolling();
  press(remove('a.png'));
  expect(chipNames()).toEqual([]);
  expect(screen.queryByRole('list', { name: '要一起发送的文件' })).toBeNull();
  expect(document.activeElement).toBe(box());
  expect(box()).toHaveValue('做一个产品介绍页');
  movedWithoutScrolling();
});

it('takes no focus from a pointer press, so a click hands nothing on and leaves the focus where it was', () => {
  view();
  attach('a.png', 'b.pdf', 'c.mp4', 'empty.txt');
  expect(note()).toHaveTextContent('「empty.txt」是空文件，没有添加。');
  box().focus();
  // A pointer press is the ✕'s mousedown, refused, so Chrome does not move the focus onto the ✕ (jsdom never does): a
  // later Enter cannot remove the file the hand-off would have put the focus on.
  expect(fireEvent.mouseDown(remove('b.pdf'))).toBe(false);
  fireEvent.click(remove('b.pdf'), { detail: 1 });
  expect(chipNames()).toEqual(['a.png', 'c.mp4']);
  expect(document.activeElement).toBe(box());
  // Taking a file back answers the note; a new one comes with the next refused file.
  expect(note()).toBeNull();
  attach('empty.txt');
  expect(fireEvent.mouseDown(dismiss())).toBe(false);
  fireEvent.click(dismiss(), { detail: 1 });
  expect(note()).toBeNull();
  expect(document.activeElement).toBe(box());
});

it('leaves a focus that was not on the ✕ where it was, the page’s own included', () => {
  view();
  attach('a.png', 'b.pdf', 'c.mp4');
  const blank = screen.getByRole('button', { name: '空白画布', exact: true });
  blank.focus();
  fireEvent.click(remove('a.png'));
  expect(chipNames()).toEqual(['b.pdf', 'c.mp4']);
  expect(document.activeElement).toBe(blank);
  // A browser that focused nothing on the click (Safari), with nothing focused before either: nothing is handed on.
  blank.blur();
  expect(document.activeElement).toBe(document.body);
  fireEvent.click(remove('c.mp4'), { detail: 1 });
  expect(chipNames()).toEqual(['b.pdf']);
  expect(document.activeElement).toBe(document.body);
  attach('empty.txt');
  fireEvent.click(dismiss(), { detail: 1 });
  expect(note()).toBeNull();
  expect(document.activeElement).toBe(document.body);
});

it('lets a press go once it has handed the focus on: what the page draws later moves nothing', () => {
  view();
  attach('a.png', 'b.pdf');
  press(remove('a.png'));
  expect(document.activeElement).toBe(remove('b.pdf'));
  remove('b.pdf').blur();
  expect(document.activeElement).toBe(document.body);
  attach('c.mp4');
  fireEvent.change(box(), { target: { value: '换个说法' } });
  expect(chipNames()).toEqual(['b.pdf', 'c.mp4']);
  expect(document.activeElement).toBe(document.body);
});

it('stops an Enter held down at the ✕ it pressed: its repeats neither remove the next file nor send the request', async () => {
  const onOpen = vi.fn();
  view(onOpen);
  fireEvent.change(box(), { target: { value: '做一个产品介绍页' } });
  attach('a.png', 'b.pdf');
  press(remove('a.png'));
  expect(document.activeElement).toBe(remove('b.pdf'));
  // A repeat refused at the window reaches no handler and has no default action (jsdom clicks no button on a key; that
  // the next ✕ is not clicked, Chrome shows: probe.mjs homeHoldEnter). In the text field below, its own Enter handler
  // refuses the default too: there what proves the guard is that nothing is sent.
  expect(heldEnter()).toBe(false);
  fireEvent.keyUp(remove('b.pdf'), { key: 'Enter', code: 'Enter' });
  press(remove('b.pdf'));
  expect(document.activeElement).toBe(box());
  expect(heldEnter()).toBe(false);
  expect(heldEnter()).toBe(false);
  // From the note's ✕ too, also with Shift+Enter, Shift let go while Enter is held (its bare repeats would send).
  fireEvent.keyUp(box(), { key: 'Enter', code: 'Enter' });
  attach('empty.txt');
  press(dismiss());
  expect(document.activeElement).toBe(box());
  expect(heldEnter()).toBe(false);
  fireEvent.keyUp(box(), { key: 'Shift', code: 'ShiftLeft' });
  expect(heldEnter()).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(created).toEqual([]);
  expect(onOpen).not.toHaveBeenCalled();
  // Once the key is up, Enter sends the request as ever.
  fireEvent.keyUp(box(), { key: 'Enter', code: 'Enter' });
  fireEvent.keyDown(box(), { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('new-canvas'));
  expect(created).toEqual(['做一个产品介绍页']);
});

it('hands it on from a click on the ✕ the keyboard is on, as Enter would', () => {
  view();
  attach('a.png', 'b.pdf');
  remove('a.png').focus();
  expect(fireEvent.mouseDown(remove('a.png'))).toBe(false);
  fireEvent.click(remove('a.png'), { detail: 1 });
  expect(chipNames()).toEqual(['b.pdf']);
  expect(document.activeElement).toBe(remove('b.pdf'));
});

it('gives the focus from the note’s ✕ to the request’s text field', () => {
  view();
  fireEvent.change(box(), { target: { value: '整理成周报' } });
  attach('a.png', 'empty.txt');
  expect(note()).toHaveTextContent('「empty.txt」是空文件，没有添加。');
  press(dismiss());
  expect(note()).toBeNull();
  expect(document.activeElement).toBe(box());
  expect(box()).toHaveValue('整理成周报');
  expect(chipNames()).toEqual(['a.png']);
  movedWithoutScrolling();
});

describe('the hand-off, whatever the chips’ owner does with the press', () => {
  // The home lets every file go at once and moves no focus of its own; the chips do not count on either.
  type Owner = (key: string, act: { drop: () => void; shut: () => void }) => void;
  function ChipsHost({ owner }: { owner: Owner }) {
    const [files, setFiles] = useState<HomeFile[]>(() => ['a.png', 'b.pdf', 'c.mp4'].map(name => ({ key: name, file: new File(['x'], name) })));
    const [shut, setShut] = useState(false);
    const input = useRef<HTMLTextAreaElement>(null);
    const drop = (key: string) => setFiles(current => current.filter(item => item.key !== key));
    const state = { files, remove: (key: string) => owner(key, { drop: () => drop(key), shut: () => setShut(true) }) } as unknown as HomeFilesState;
    return <><HomeFileChips state={state} disabled={shut} t={zh => zh} locale="zh" textField={input} />
      <textarea ref={input} aria-label="需求" />
      <button type="button" onClick={() => drop('a.png')}>别处撤下</button></>;
  }
  const field = () => screen.getByRole('textbox', { name: '需求' });

  it('keeps the focus on a file its owner keeps, and lets that press go', () => {
    render(<ChipsHost owner={() => {}} />);
    press(remove('a.png'));
    expect(chipNames()).toEqual(['a.png', 'b.pdf', 'c.mp4']);
    expect(document.activeElement).toBe(remove('a.png'));
    // The file leaves later, from elsewhere, with nothing focused: that press is long gone.
    remove('a.png').blur();
    fireEvent.click(screen.getByRole('button', { name: '别处撤下', exact: true }));
    expect(chipNames()).toEqual(['b.pdf', 'c.mp4']);
    expect(document.activeElement).toBe(document.body);
  });

  it('hands nothing on for a file that stays, even when the press shuts the chips', () => {
    // Chrome drops the focus from a ✕ that is disabled (jsdom keeps it there, so the owner drops it as Chrome does).
    render(<ChipsHost owner={(_key, act) => { act.shut(); (document.activeElement as HTMLElement | null)?.blur(); }} />);
    press(remove('b.pdf'));
    expect(chipNames()).toEqual(['a.png', 'b.pdf', 'c.mp4']);
    expect(remove('b.pdf')).toBeDisabled();
    expect(document.activeElement).toBe(document.body);
  });

  it('never takes the focus from where the owner put it', () => {
    render(<ChipsHost owner={(_key, act) => { act.drop(); screen.getByRole('button', { name: '别处撤下', exact: true }).focus(); }} />);
    press(remove('b.pdf'));
    expect(chipNames()).toEqual(['a.png', 'c.mp4']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '别处撤下', exact: true }));
  });

  it('tries each in turn until one takes the focus: a disabled ✕ takes none', () => {
    render(<ChipsHost owner={(_key, act) => { act.drop(); act.shut(); }} />);
    press(remove('b.pdf'));
    expect(chipNames()).toEqual(['a.png', 'c.mp4']);
    expect(remove('c.mp4')).toBeDisabled();
    expect(document.activeElement).toBe(field());
    movedWithoutScrolling();
  });
});
