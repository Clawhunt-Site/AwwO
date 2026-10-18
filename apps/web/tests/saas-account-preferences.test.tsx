import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { AccountPreferencesProvider, currentAccountPreferences, emptyAccountPreferences, type AccountPreferences } from '../src/saas/accountPreferences';
import { executionModelKey, useManagedExecution } from '../src/saas/useManagedExecution';
import { notifyTaskFinished } from '../src/saas/taskNotifications';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const runtime = { ready: true, capabilities: { workspace: true, approvals: true }, models: [
  { id: 'first', label: 'First', runtime: 'pi' }, { id: 'opus', label: 'Opus', runtime: 'pi' }, { id: 'kimi', label: 'Kimi', runtime: 'pi' },
] };
function serve(preferences: Partial<AccountPreferences>, { holdPreferences = false } = {}) {
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/auth/preferences')) {
      if (holdPreferences) await held;
      return json({ preferences: { ...emptyAccountPreferences(), ...preferences }, version: 1 });
    }
    if (url.endsWith('/computer-runtime')) return json(runtime);
    if (url.endsWith('/computer-runs')) return json({ items: [] });
    return json({ error: { code: 'not_found' } }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, release };
}
const wrapper = ({ children }: { children: ReactNode }) => <SaaSPreferencesProvider><AccountPreferencesProvider userId="user-1">{children}</AccountPreferencesProvider></SaaSPreferencesProvider>;
const MODEL_KEY = 'awwo.saas:user-1:tenant-a:awwo.assistant.model.v1';

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it('starts the canvas assistant on the account’s default model where the workspace offers it', async () => {
  serve({ defaultModel: { runtime: 'pi', model: 'opus' } });
  const { result } = renderHook(() => useManagedExecution('tenant-a', 'canvas-a', { userId: 'user-1' }), { wrapper });
  act(() => result.current.activate());
  await waitFor(() => expect(result.current.choice.key).toBe(executionModelKey('pi', 'opus')));
  // The account default is the assistant's alone: the components a plan adds keep the workspace default.
  expect(result.current.componentModel).toBeUndefined();
});

it('applies a default that arrives after the catalogue, but never over a pick of the reader’s', async () => {
  const { release } = serve({ defaultModel: { runtime: 'pi', model: 'opus' } }, { holdPreferences: true });
  const { result } = renderHook(() => useManagedExecution('tenant-a', 'canvas-a', { userId: 'user-1' }), { wrapper });
  act(() => result.current.activate());
  await waitFor(() => expect(result.current.choice.key).toBe(executionModelKey('pi', 'first')));
  release();
  await waitFor(() => expect(result.current.choice.key).toBe(executionModelKey('pi', 'opus')));
  cleanup();
  const later = serve({ defaultModel: { runtime: 'pi', model: 'opus' } }, { holdPreferences: true });
  const second = renderHook(() => useManagedExecution('tenant-a', 'canvas-a', { userId: 'user-1' }), { wrapper });
  act(() => second.result.current.activate());
  await waitFor(() => expect(second.result.current.runtime).not.toBeNull());
  act(() => second.result.current.chooseModel(executionModelKey('pi', 'kimi')));
  later.release();
  await waitFor(() => expect(currentAccountPreferences()?.defaultModel).toEqual({ runtime: 'pi', model: 'opus' }));
  expect(second.result.current.choice.key).toBe(executionModelKey('pi', 'kimi'));
});

it('keeps the reader’s own choice for the workspace over the account default', async () => {
  localStorage.setItem(MODEL_KEY, JSON.stringify(['pi', 'kimi']));
  serve({ defaultModel: { runtime: 'pi', model: 'opus' } });
  const { result } = renderHook(() => useManagedExecution('tenant-a', 'canvas-a', { userId: 'user-1' }), { wrapper });
  act(() => result.current.activate());
  await waitFor(() => expect(result.current.runtime).not.toBeNull());
  await waitFor(() => expect(currentAccountPreferences()).not.toBeNull());
  expect(result.current.choice.key).toBe(executionModelKey('pi', 'kimi'));
});

it('falls back to the service’s first model when the workspace does not offer the default', async () => {
  serve({ defaultModel: { runtime: 'pi', model: 'elsewhere-only' } });
  const { result } = renderHook(() => useManagedExecution('tenant-a', 'canvas-a', { userId: 'user-1' }), { wrapper });
  act(() => result.current.activate());
  await waitFor(() => expect(currentAccountPreferences()).not.toBeNull());
  await waitFor(() => expect(result.current.runtime).not.toBeNull());
  expect(result.current.choice.key).toBe(executionModelKey('pi', 'first'));
});

const tones: number[] = [];
function stubAlerts() {
  const shown: Array<{ title: string; body?: string }> = [];
  class FakeNotification { static permission = 'granted'; onclick: (() => void) | null = null; constructor(title: string, options?: { body?: string }) { shown.push({ title, body: options?.body }); } close() {} }
  vi.stubGlobal('Notification', FakeNotification);
  // The page keeps one AudioContext for good, so the tones go to one list shared by every test.
  tones.length = 0;
  class FakeAudio {
    currentTime = 0; destination = {};
    createOscillator() { const tone = { type: '', frequency: { value: 0 }, connect: (gain: unknown) => gain, start: () => tones.push(tone.frequency.value), stop() {} }; return tone; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (target: unknown) => target }; }
  }
  vi.stubGlobal('AudioContext', FakeAudio);
  return { shown, tones };
}
async function signedIn(preferences: Partial<AccountPreferences>) {
  serve(preferences);
  render(<AccountPreferencesProvider userId="user-1"><span /></AccountPreferencesProvider>);
  await waitFor(() => expect(currentAccountPreferences()).not.toBeNull());
}

it('tells a reader who is away that a task ended, the ways they chose', async () => {
  const { shown, tones } = stubAlerts();
  await signedIn({ notifications: { browser: true, sound: true } });
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  notifyTaskFinished({ title: '画布运行已完成', body: 'Launch plan' });
  expect(shown).toEqual([{ title: '画布运行已完成', body: 'Launch plan' }]);
  expect(tones).toEqual([660, 880]);
});

it('stays quiet while the reader is on the page, when they chose nothing, or before the settings are read', async () => {
  const { shown, tones } = stubAlerts();
  notifyTaskFinished({ title: 'before', body: '' });
  await signedIn({ notifications: { browser: true, sound: true } });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  notifyTaskFinished({ title: 'on the page', body: '' });
  cleanup();
  await signedIn({ notifications: { browser: false, sound: false } });
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  notifyTaskFinished({ title: 'nothing chosen', body: '' });
  expect(shown).toEqual([]);
  expect(tones).toEqual([]);
});

it('does not show a notification the browser has not allowed, though it still plays the chime', async () => {
  const { shown, tones } = stubAlerts();
  (globalThis.Notification as unknown as { permission: string }).permission = 'denied';
  await signedIn({ notifications: { browser: true, sound: true } });
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  notifyTaskFinished({ title: 'done', body: '' });
  expect(shown).toEqual([]);
  expect(tones).toHaveLength(2);
});

function TaskWatcher() {
  const execution = useManagedExecution('tenant-a', 'canvas-a', { userId: 'user-1' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { execution.activate(); execution.setVisible(true); }, []);
  return <span>{execution.run?.status || ''}</span>;
}
function serveTask(statuses: string[]) {
  const run = (status: string) => ({ id: 'run-a', status, prompt: '做一份发布计划', createdAt: '2026-10-18T06:00:00Z', updatedAt: '2026-10-18T06:01:00Z', error: '',
    output: '', canRespond: false, canCancel: false, truncated: false, messages: [], approvals: [], artifacts: [], calls: 1, refundedCalls: 0 });
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/auth/preferences')) return json({ preferences: { ...emptyAccountPreferences(), notifications: { browser: true, sound: false } }, version: 1 });
    if (url.endsWith('/computer-runtime')) return json(runtime);
    if (url.endsWith('/computer-runs')) return json({ items: [run(statuses[0])] });
    return json(run(statuses[Math.min(reads++, statuses.length - 1)]));
  }));
}

it('tells a reader who is away when a direct task it watched running ends', async () => {
  const { shown } = stubAlerts();
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  serveTask(['running', 'completed']);
  const page = render(<SaaSPreferencesProvider><AccountPreferencesProvider userId="user-1"><TaskWatcher /></AccountPreferencesProvider></SaaSPreferencesProvider>);
  await waitFor(() => expect(page.container).toHaveTextContent('completed'), { timeout: 8000 });
  expect(shown).toEqual([{ title: '任务已完成', body: '回到 AwwO 查看结果。' }]);
}, 15000);

it('says nothing about a direct task that was already over when the page opened', async () => {
  const { shown } = stubAlerts();
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  serveTask(['completed']);
  const page = render(<SaaSPreferencesProvider><AccountPreferencesProvider userId="user-1"><TaskWatcher /></AccountPreferencesProvider></SaaSPreferencesProvider>);
  await waitFor(() => expect(page.container).toHaveTextContent('completed'));
  await waitFor(() => expect(currentAccountPreferences()).not.toBeNull());
  expect(shown).toEqual([]);
});
