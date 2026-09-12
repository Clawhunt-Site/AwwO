import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureSaaSCanvas, clearSaaSCanvas } from '../src/saas/canvasBridge';
import { fetchConversationMessages } from '../src/canvasAgentChat';
import { collaborationInputSummary, collaborationMessageContext, htmlPreviewSummary } from '../src/canvas/readableTranscript';
import { TileTranscript } from '../src/canvas/TileTranscript';
import { LocaleProvider } from '../src/canvas/i18n';
import type { CollaborationMessageContext, Turn } from '../src/canvas/sessions';
import { appendTurn, resetAllSessions } from '../src/canvas/sessions';
import { SessionTile } from '../src/canvas/SessionTile';
import { createSessionNode } from '../src/canvas/canvasDoc';
import { sessionStoreKey } from '../src/canvas/nodeThreads';

const context: CollaborationMessageContext = { nodeId: 'node-a', sessionId: 'session-a', runId: 'run-a', phase: 'review', round: 1, goal: 'Improve the page\nKeep the mobile layout' };
const raw = '[AwwO collaboration review round 1]\nShared goal:\nImprove the page\n\nContract JSON\n{"peer":"<html><head></head><body>SECRET-PEER-HTML</body></html>"}';
afterEach(() => { cleanup(); resetAllSessions(); clearSaaSCanvas(); vi.unstubAllGlobals(); });

describe('server-attested collaboration transcript projection', () => {
  it('restores readable task metadata through the SaaS bridge on a fresh client without a local journal', async () => {
    configureSaaSCanvas({ tenant: { id: 'tenant-a', name: 'Workspace', role: 'owner', status: 'active' }, canvasId: 'canvas-a' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [
      { role: 'user', sessionId: 'session-a', runId: 'run-a', content: raw, collaboration: context },
      { role: 'assistant', sessionId: 'session-a', runId: 'run-a', content: 'Actual critique' },
    ] }))));
    const messages = await fetchConversationMessages('', 'tenant-a', 'session-a');
    expect(messages?.[0]).toMatchObject({ text: raw, collaboration: context, runId: 'run-a' });
    expect(messages?.[1]).not.toHaveProperty('collaboration');
    render(<LocaleProvider locale="zh"><TileTranscript turns={messages!.map((message, id) => ({ ...message, id }))} history="loaded" streaming={false} limit={Infinity} /></LocaleProvider>);
    expect(screen.getByText(/第 1 轮 · 互审/)).toHaveTextContent(context.goal.replace('\n', ' '));
    const details = screen.getByText('本轮输入与执行详情').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details.querySelector('pre')!.textContent).toBe(raw);
    expect(screen.getByText('Actual critique')).toBeVisible();
  });

  it.each([['proposal', '提案', 'Proposal'], ['review', '互审', 'Peer review'], ['synthesis', '汇总', 'Synthesis']] as const)('renders the authoritative %s phase and full goal in both locales', (phase, zh, en) => {
    const turn = { role: 'user' as const, runId: 'run-a', collaboration: { ...context, phase, round: 2 } };
    expect(collaborationInputSummary(turn, 'zh')).toBe(`第 2 轮 · ${zh}\n${context.goal}`);
    expect(collaborationInputSummary(turn, 'en')).toBe(`Round 2 · ${en}\n${context.goal}`);
  });

  it('never infers task metadata from user or peer content, and rejects mismatched identities', () => {
    const chat: Turn = { id: 1, role: 'user', runId: 'manual-run', text: raw };
    expect(collaborationInputSummary(chat, 'zh')).toBeNull();
    render(<TileTranscript turns={[chat]} history="loaded" streaming={false} limit={Infinity} />);
    expect(screen.queryByText(/第 1 轮 · 互审/)).toBeNull();
    expect(screen.getByText(/SECRET-PEER-HTML/).textContent).toBe(raw);
    expect(collaborationMessageContext(context, 'other-run', 'session-a')).toBeUndefined();
    expect(collaborationMessageContext(context, 'run-a', 'other-session')).toBeUndefined();
    expect(collaborationInputSummary({ ...chat, role: 'agent', runId: 'run-a', collaboration: context }, 'en')).toBeNull();
    expect(collaborationInputSummary({ ...chat, runId: 'run-a', nativeRunId: 'other', collaboration: context }, 'en')).toBeNull();
    expect(collaborationMessageContext({ ...context, round: 0 }, 'run-a', 'session-a')).toBeUndefined();
  });
});

it('summarizes complete HTML only without claiming completion or changing original content', () => {
  const html = '<!DOCTYPE html><html><head><title>Document</title></head><body>Visible page</body></html>';
  expect(htmlPreviewSummary(html, 'zh')).toBe('HTML 文档 · 打开预览');
  expect(htmlPreviewSummary('```html\n' + html + '\n```', 'en')).toBe('HTML document · Open preview');
  expect(htmlPreviewSummary('<html><head></head><body>Still streaming', 'zh')).toBeNull();
  expect(htmlPreviewSummary('Discuss <html> as literal text', 'en')).toBeNull();
});

it.each(['stored', 'live', 'json'] as const)('shows a readable compact card for %s HTML without changing the original output', source => {
  const html = '<!DOCTYPE html><html><head><title>Document</title></head><body>Visible page</body></html>';
  const raw = source === 'json' ? JSON.stringify({ artifact: html }) : html;
  const node = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'preview-node', preview: source === 'stored' ? html : '',
    contract: { version: 1 as const, inputs: [], outputs: [{ id: 'artifact', label: 'HTML', type: 'html' as const, required: true, value: '' }] },
    lastOutput: { text: raw, at: 1, source: 'run' as const, partial: true } };
  if (source !== 'stored') appendTurn(sessionStoreKey(node), { role: 'agent', text: raw });
  const before = structuredClone(node);
  const { container } = render(<SessionTile node={node} scale={1} compact />);
  expect(container.querySelector('.awwo-compact-summary')).toHaveTextContent('HTML 文档 · 打开预览');
  expect(container.querySelector('.awwo-compact-summary')).not.toHaveTextContent('<!DOCTYPE');
  expect(node).toEqual(before);
});
