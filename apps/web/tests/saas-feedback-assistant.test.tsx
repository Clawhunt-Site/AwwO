import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { FeedbackAssistant } from '../src/saas/FeedbackAssistant';
import { modalOpen, placeLauncher } from '../src/saas/feedbackPlacement';
import { clearFeedbackDiagnostics, feedbackContext, feedbackPageAddress } from '../src/saas/feedbackDiagnostics';
import { forgetFeedbackConversation } from '../src/saas/feedbackApi';
import { api } from '../src/saas/api';

// The feedback assistant in every page's corner (backend feedback.go): a person says what went wrong, the assistant
// writes the report, one press sends it to the support inbox with the page's context; without the assistant the
// person's own words go, and without the site's mail, their own mail client takes it.

type Call = { url: string; method: string; body: any };
let calls: Call[];
let answers: Array<{ status: number; body: unknown }>;
let status: Record<string, unknown>;
let sendStatus: { status: number; body: unknown };
/** A send held until the test lets it go. */
let hold: { promise: Promise<void>; release: () => void } | null;
const holdSend = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); hold = { promise, release }; return hold; };
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('superclaw_locale', 'en');
  // 普通用户模式, as the hosted app ships it (the test setup defaults to the developer mode).
  localStorage.setItem('awwo.ui-mode.v1', 'simple');
  clearFeedbackDiagnostics();
  window.history.replaceState(null, '', '/?tenant=t1&canvas=c1&invite=SECRET');
  calls = [];
  answers = [];
  status = { available: true, assistant: true, signedIn: true, email: 'me@example.com', supportEmail: 'support@clawhunt.store' };
  sendStatus = { status: 200, body: { id: 'FB-20261109-ABCDEF' } };
  hold = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url === '/api/v1/feedback' && method === 'GET') return json(status);
    if (url === '/api/v1/feedback/assistant') {
      // An answer still coming: it ends only when the page aborts it.
      if (answers[0]?.status === 0) {
        answers.shift();
        return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      }
      const next = answers.shift() ?? { status: 503, body: { error: { code: 'assistant_unavailable' } } };
      return json(next.body, next.status);
    }
    if (url === '/api/v1/feedback' && method === 'POST') {
      if (hold) { const wait = hold; await wait.promise; }
      return json(sendStatus.body, sendStatus.status);
    }
    return json({ error: { code: 'canvas_reload_required', message: 'Reload' } }, 409);
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const show = () => render(<SaaSPreferencesProvider><FeedbackAssistant /></SaaSPreferencesProvider>);
const open = async () => {
  fireEvent.click(screen.getByRole('button', { name: /AI feedback assistant/ }));
  await waitFor(() => expect(calls.some(call => call.url === '/api/v1/feedback' && call.method === 'GET')).toBe(true));
  return screen.getByRole('textbox', { name: 'Message the feedback assistant' });
};
const say = (box: HTMLElement, text: string) => { fireEvent.change(box, { target: { value: text } }); fireEvent.keyDown(box, { key: 'Enter' }); };
const sent = () => calls.filter(call => call.url === '/api/v1/feedback' && call.method === 'POST');

describe('the feedback assistant', () => {
  it('asks the assistant, shows its report and sends it with the page it came from', async () => {
    answers.push({ status: 200, body: { reply: 'Which canvas was it?', ready: false } });
    answers.push({ status: 200, body: { reply: 'Got it: check the summary below and press Send.', ready: true,
      report: { title: 'Run hangs on the landing page canvas', category: 'bug', severity: 'high', summary: 'The run never finishes.', steps: ['Open the canvas', 'Press Run'], expected: 'It runs', actual: 'It spins' } } });
    show();
    const box = await open();
    say(box, 'The run hangs');
    await screen.findByText('Which canvas was it?');
    expect(calls.find(call => call.url === '/api/v1/feedback/assistant')!.body).toEqual({ messages: [{ role: 'user', text: 'The run hangs' }], locale: 'en', page: 'canvas page, simple mode' });
    say(box, 'The landing page canvas');
    const report = await screen.findByRole('article', { name: 'Report to send' });
    expect(report.textContent).toContain('Run hangs on the landing page canvas');
    expect(report.textContent).toContain('High');
    // A conversation in progress outlives a move to another page of this tab.
    expect(JSON.parse(sessionStorage.getItem('awwo.feedback.v1')!).messages).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Send to the AwwO team' }));
    await screen.findByText('Sent to the AwwO team');
    expect(screen.getByText('FB-20261109-ABCDEF')).toBeTruthy();
    expect(screen.getByText(/reply to me@example\.com/)).toBeTruthy();
    const [post] = sent();
    expect(post.body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(post.body.report.title).toBe('Run hangs on the landing page canvas');
    expect(post.body.contact).toBe('');
    expect(post.body.context.url).toBe('http://localhost:3000/?tenant=t1&canvas=c1');
    expect(post.body.context.url).not.toContain('SECRET');
    expect(post.body.attachments).toEqual([]);
    // A report once sent is not kept, so it can never be sent twice.
    expect(sessionStorage.getItem('awwo.feedback.v1')).toBeNull();
  });

  it('sends the person\'s own words when the assistant does not answer', async () => {
    show();
    const box = await open();
    say(box, 'Everything is blank after sign-in');
    await screen.findByText(/isn't answering right now/);
    fireEvent.click(screen.getByRole('button', { name: 'Send it to the team as it is' }));
    await screen.findByText('Sent to the AwwO team');
    const [post] = sent();
    expect(post.body.messages).toEqual([{ role: 'user', text: 'Everything is blank after sign-in' }]);
    expect(post.body.report).toBeNull();
  });

  it('lets a visitor leave an address and checks it before sending', async () => {
    status = { available: true, assistant: false, signedIn: false, supportEmail: 'support@clawhunt.store' };
    show();
    const box = await open();
    fireEvent.change(box, { target: { value: 'I cannot sign in' } });
    const contact = screen.getByLabelText('Your email (optional, so we can reply)');
    fireEvent.change(contact, { target: { value: 'not an address' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send it to the team as it is' }));
    expect((await screen.findByRole('alert')).textContent).toContain('does not look right');
    expect(sent()).toHaveLength(0);
    fireEvent.change(contact, { target: { value: 'visitor@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send it to the team as it is' }));
    await screen.findByText('Sent to the AwwO team');
    expect(sent()[0].body.contact).toBe('visitor@example.com');
    // No assistant here: nothing was asked of it.
    expect(calls.some(call => call.url === '/api/v1/feedback/assistant')).toBe(false);
  });

  it('offers the person\'s own mail when the site cannot send', async () => {
    status = { available: false, assistant: false, signedIn: true, email: 'me@example.com', supportEmail: '' };
    show();
    const box = await open();
    fireEvent.change(box, { target: { value: 'Export fails' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send it to the team as it is' }));
    const link = await screen.findByRole('link', { name: 'Email it to support@clawhunt.store' });
    expect(link.getAttribute('href')).toMatch(/^mailto:support@clawhunt\.store\?subject=AwwO%20feedback&body=Export%20fails/);
    expect(sent()).toHaveLength(0);
  });

  it('keeps the report when sending fails, to try again', async () => {
    sendStatus = { status: 502, body: { error: { code: 'feedback_send_failed', message: 'not sent' } } };
    show();
    const box = await open();
    fireEvent.change(box, { target: { value: 'Uploads fail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send it to the team as it is' }));
    expect((await screen.findByRole('alert')).textContent).toContain('It was not sent');
    expect(screen.getByText('Uploads fail')).toBeTruthy();
    sendStatus = { status: 200, body: { id: 'FB-20261109-XYZ234' } };
    fireEvent.click(screen.getByRole('button', { name: 'Send it to the team as it is' }));
    await screen.findByText('FB-20261109-XYZ234');
  });

  it('opens again on the conversation an earlier page of the tab left, without taking the focus', async () => {
    sessionStorage.setItem('awwo.feedback.v1', JSON.stringify({ open: true, messages: [{ role: 'user', text: 'The canvas will not load' }, { role: 'system', text: 'dropped' }], report: { title: '' }, draft: 'more', contact: '', who: 'account:me@example.com' }));
    show();
    expect(await screen.findByText('The canvas will not load')).toBeTruthy();
    expect(screen.queryByText('dropped')).toBeNull();
    const box = screen.getByRole('textbox', { name: 'Message the feedback assistant' }) as HTMLTextAreaElement;
    expect(box.value).toBe('more');
    // A page that opens on the panel keeps its own focus (a sign-in form's, say).
    expect(document.activeElement).not.toBe(box);
    expect(screen.queryByRole('article', { name: 'Report to send' })).toBeNull();
    await waitFor(() => expect(calls.some(call => call.method === 'GET')).toBe(true));
    expect(screen.getByText('The canvas will not load')).toBeTruthy();
  });

  it('drops a conversation another person left in the tab before anything of it is sent', async () => {
    sessionStorage.setItem('awwo.feedback.v1', JSON.stringify({ open: true, messages: [{ role: 'user', text: 'Someone else wrote this' }], report: null, draft: 'theirs', contact: '', who: 'account:other@example.com' }));
    show();
    await waitFor(() => expect(screen.queryByText('Someone else wrote this')).toBeNull());
    expect((screen.getByRole('textbox', { name: 'Message the feedback assistant' }) as HTMLTextAreaElement).value).toBe('');
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('awwo.feedback.v1')!).who).toBe('account:me@example.com'));
  });

  it('keeps sending when Send is pressed while the assistant is still answering', async () => {
    answers.push({ status: 0, body: null });
    const held = holdSend();
    show();
    const box = await open();
    say(box, 'Billing page shows the wrong plan');
    await screen.findByRole('status', { name: 'The assistant is replying' });
    fireEvent.click(screen.getByRole('button', { name: 'Send it to the team as it is' }));
    // The answer is dropped and cannot end the send: the panel stays busy until the API answers.
    await waitFor(() => expect(screen.getByRole('button', { name: /Sending/ })).toBeTruthy());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.getByRole('button', { name: /Sending/ })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start over' }) as HTMLButtonElement).disabled).toBe(true);
    held.release();
    await screen.findByText('Sent to the AwwO team');
    expect(sent()).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a composing Escape inside the box, and closes on a plain one', async () => {
    show();
    const box = await open();
    fireEvent.keyDown(box, { key: 'Escape', isComposing: true });
    expect(screen.getByRole('dialog', { name: 'AwwO feedback assistant' })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'AwwO feedback assistant' })).toBeNull();
  });

  it('forgets the conversation on sign-out', () => {
    sessionStorage.setItem('awwo.feedback.v1', JSON.stringify({ open: false, messages: [{ role: 'user', text: 'x' }], report: null, draft: '', contact: '' }));
    forgetFeedbackConversation();
    expect(sessionStorage.getItem('awwo.feedback.v1')).toBeNull();
  });
});

describe('the app\'s own dialogs', () => {
  it('count as open while one is on screen, the feedback panel aside', () => {
    expect(modalOpen()).toBe(false);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    // jsdom draws nothing: an element with no size is not on screen.
    expect(modalOpen()).toBe(false);
    dialog.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON: () => ({}) });
    expect(modalOpen()).toBe(true);
    const ours = document.createElement('section');
    ours.className = 'awwo-feedback-panel';
    ours.appendChild(dialog);
    document.body.appendChild(ours);
    expect(modalOpen()).toBe(false);
    ours.remove();
  });
});

describe('what goes with a report', () => {
  it('notes the API requests that failed, without their query', async () => {
    await expect(api('/tenants/t1/canvases/c1?view=summary', { method: 'PUT', body: '{}' })).rejects.toThrow();
    const context = feedbackContext('simple');
    expect(context.requests).toHaveLength(1);
    expect(context.requests[0]).toMatch(/PUT \/tenants\/t1\/canvases\/c1 → 409 canvas_reload_required$/);
    expect(context.uiMode).toBe('simple');
  });

  it('keeps only where the person was in the page address', () => {
    expect(feedbackPageAddress('https://awwo.clawhunt.store/?tenant=a&invite=SECRET&reset=TOKEN&view=results#x')).toBe('https://awwo.clawhunt.store/?tenant=a&view=results');
    expect(feedbackPageAddress('https://awwo.clawhunt.store/admin')).toBe('https://awwo.clawhunt.store/admin');
  });
});

describe('where the button sits', () => {
  const view = { width: 1440, height: 900 };
  const size = { width: 96, height: 40 };
  const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

  it('takes the bottom-left corner when nothing is there', () => {
    expect(placeLauncher(view, size, null, [])).toEqual({ left: 16, bottom: 16 });
  });
  it('moves right of the canvas assistant and over the board\'s view tools', () => {
    const sidebar = { box: box(0, 120, 420, 900), mode: 'beside' as const };
    const tools = { box: box(436, 840, 640, 884), mode: 'above' as const };
    expect(placeLauncher(view, size, null, [sidebar, tools])).toEqual({ left: 436, bottom: 70 });
    // With the assistant closed, only the view tools are in the corner.
    expect(placeLauncher(view, size, null, [{ box: box(16, 840, 220, 884), mode: 'above' }])).toEqual({ left: 16, bottom: 70 });
  });
  it('docks in a page\'s slot, and steps away where no room is left', () => {
    expect(placeLauncher(view, size, box(28, 836, 252, 876), [])).toEqual({ left: 28, bottom: 24, width: 224 });
    expect(placeLauncher({ width: 390, height: 800 }, size, null, [{ box: box(0, 60, 390, 800), mode: 'beside' }])).toBeNull();
  });
});
