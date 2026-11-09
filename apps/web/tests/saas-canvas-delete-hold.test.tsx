// Who may delete a canvas (saas/canvasDeletion.ts), as the server judges it (resources.go, canvas_not_yours): a
// workspace's owners and admins any canvas, a member only one they made, nobody but owners and admins one with no maker
// recorded; and the home's canvas list (CanvasList.tsx), which holds a member's 删除 where the server would refuse it,
// saying who may. Every id and name here is made up.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasList } from '../src/saas/CanvasList';
import { canvasDeleteHold } from '../src/saas/canvasDeletion';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { CanvasListItem, Tenant } from '../src/saas/api';

const ME = 'user-member-0001';
const THEM = 'user-owner-0001';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const tenant = (role: string): Tenant => ({ id: 'tenant-one', name: 'Studio', role, status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 });
const item = (id: string, name: string, createdBy?: string | null): CanvasListItem => ({ id, tenantId: 'tenant-one', name, version: 1,
  createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', outline: { nodes: [], edges: [], nodeCount: 0 },
  ...(createdBy === undefined ? {} : { createdBy }) });
// Made by this person, by someone else, by nobody recorded, and listed by a server older than createdBy.
const CANVASES = [item('c-mine', '我的画布', ME), item('c-theirs', '别人的画布', THEM), item('c-unknown', '没记下创建者', null), item('c-older', '旧服务器的画布')];

describe('who may delete a canvas', () => {
  it('follows the server: owners and admins any canvas, a member their own, nobody recorded only owners and admins', () => {
    for (const role of ['owner', 'admin']) {
      for (const createdBy of [ME, THEM, null, '', undefined]) expect(canvasDeleteHold(role, ME, { createdBy })).toBeNull();
    }
    expect(canvasDeleteHold('member', ME, { createdBy: ME })).toBeNull();
    expect(canvasDeleteHold('member', ME, { createdBy: THEM })).toBe('maker');
    expect(canvasDeleteHold('member', ME, { createdBy: null })).toBe('admins');
    expect(canvasDeleteHold('member', ME, { createdBy: '' })).toBe('admins');
    // Not known here: a server older than createdBy, or a page that does not know who reads it. The server decides.
    expect(canvasDeleteHold('member', ME, {})).toBeNull();
    expect(canvasDeleteHold('member', undefined, { createdBy: THEM })).toBeNull();
  });
});

describe('the canvas list’s 删除', () => {
  let calls: Array<[string, string]> = [];
  // `userId` undefined: a page that does not know who reads it.
  const show = (role: string, userId: string | undefined) => render(<SaaSPreferencesProvider><CanvasList tenant={tenant(role)} userId={userId} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
  // A card's menu, opened (its label is 画布选项：<name>, Canvas options: <name> in English).
  const menu = async (name: string) => {
    const card = (await screen.findByRole('heading', { name })).closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: new RegExp(`^(画布选项：|Canvas options: )${name}$`) }));
    return within(screen.getByRole('dialog', { name: new RegExp(`${name}$`) }));
  };
  beforeEach(() => {
    localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); calls = [];
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      calls.push([init.method ?? 'GET', input]);
      return init.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ items: CANVASES, nextCursor: null });
    }));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('holds a member’s 删除 on a canvas someone else made, saying who may, and offers it on their own', async () => {
    show('member', ME);
    let actions = await menu('别人的画布');
    // Renaming is anyone's who edits; deleting is the maker's, or an owner's or admin's.
    expect(actions.getByRole('button', { name: '改名' })).toBeEnabled();
    let held = actions.getByRole('button', { name: '删除' });
    expect(held).toHaveAttribute('aria-disabled', 'true');
    expect(held).toHaveAccessibleDescription('只有创建这张画布的人，或工作区的所有者和管理员，能删除它。');
    // Held, not disabled: Tab reaches it after 改名, so the line saying who may is read as it takes the focus.
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(actions.getByRole('button', { name: '改名' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(held).toHaveFocus();
    // Pressed, it does nothing: no confirmation, and the menu stays open with the focus on it.
    fireEvent.click(held);
    expect(screen.queryByRole('dialog', { name: '确认删除画布' })).toBeNull();
    expect(held).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('dialog', { name: /别人的画布/ }), { key: 'Escape' });
    actions = await menu('没记下创建者');
    held = actions.getByRole('button', { name: '删除' });
    expect(held).toHaveAttribute('aria-disabled', 'true');
    expect(held).toHaveAccessibleDescription('这张画布没有记下创建者，只有工作区的所有者和管理员能删除它。');
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(held).toHaveFocus();
    fireEvent.click(held);
    expect(screen.queryByRole('dialog', { name: '确认删除画布' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog', { name: /没记下创建者/ }), { key: 'Escape' });
    // A server older than createdBy decides for itself.
    actions = await menu('旧服务器的画布');
    expect(actions.getByRole('button', { name: '删除' })).toBeEnabled();
    expect(actions.getByRole('button', { name: '删除' })).not.toHaveAttribute('aria-disabled');
    expect(actions.queryByText(/能删除它/)).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog', { name: /旧服务器的画布/ }), { key: 'Escape' });
    actions = await menu('我的画布');
    expect(actions.getByRole('button', { name: '删除' })).toBeEnabled();
    expect(actions.getByRole('button', { name: '删除' })).not.toHaveAttribute('aria-disabled');
    expect(actions.getByRole('button', { name: '删除' })).not.toHaveAttribute('aria-describedby');
    fireEvent.click(actions.getByRole('button', { name: '删除' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '确认删除画布' })).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(calls).toContainEqual(['DELETE', '/api/v1/tenants/tenant-one/canvases/c-mine']));
    expect(calls.filter(([method]) => method === 'DELETE')).toHaveLength(1);
  });

  it('offers an owner and an admin 删除 on every canvas, and leaves a page that does not know its reader to the server', async () => {
    for (const [role, userId] of [['owner', THEM], ['admin', 'user-admin-0001'], ['member', undefined]] as const) {
      show(role, userId);
      for (const canvas of CANVASES) {
        const actions = await menu(canvas.name);
        expect(actions.getByRole('button', { name: '删除' })).toBeEnabled();
        expect(actions.getByRole('button', { name: '删除' })).not.toHaveAttribute('aria-disabled');
        expect(actions.queryByText(/能删除它/)).toBeNull();
        fireEvent.keyDown(screen.getByRole('dialog', { name: new RegExp(canvas.name) }), { key: 'Escape' });
      }
      cleanup();
    }
  });

  it('says who may in English', async () => {
    localStorage.setItem('superclaw_locale', 'en');
    show('member', ME);
    let actions = await menu('别人的画布');
    expect(actions.getByRole('button', { name: 'Rename' })).toBeEnabled();
    expect(actions.getByRole('button', { name: 'Delete' })).toHaveAttribute('aria-disabled', 'true');
    expect(actions.getByRole('button', { name: 'Delete' })).toHaveAccessibleDescription('Only the person who made this canvas, or a workspace owner or admin, can delete it.');
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(actions.getByRole('button', { name: 'Delete' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('dialog', { name: /别人的画布/ }), { key: 'Escape' });
    actions = await menu('没记下创建者');
    expect(actions.getByRole('button', { name: 'Delete' })).toHaveAccessibleDescription('No maker is recorded for this canvas, so only a workspace owner or admin can delete it.');
    fireEvent.keyDown(screen.getByRole('dialog', { name: /没记下创建者/ }), { key: 'Escape' });
    actions = await menu('我的画布');
    expect(actions.getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(actions.getByRole('button', { name: 'Delete' })).not.toHaveAttribute('aria-disabled');
  });

  it('still gives a reader no menu at all', async () => {
    show('reader', ME);
    const card = (await screen.findByRole('heading', { name: '别人的画布' })).closest('article')!;
    expect(within(card).queryByRole('button', { name: /画布选项/ })).toBeNull();
  });
});
