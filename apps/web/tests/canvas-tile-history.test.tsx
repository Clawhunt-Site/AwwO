// Two features that existed but were never CONNECTED — the tile is where they belong.
//
//  1. HISTORY RESTORE. `restoreHistory` was written, documented and unit-tested, but nothing in
//     the app called it. So a bound node with a real server-side conversation rendered
//     "还没有对话。发第一条消息，唤醒这个 agent。" after every reload — an absent history presented
//     as "nothing was ever said", the one thing this canvas is not allowed to do. Observed live in
//     production after a successful graph run.
//  2. PERSISTED PREVIEW. `node.preview` is what the glance LOD renders (a far-away tile has no
//     transcript loaded), and canvasDoc documents it as "persisted so the glance-LOD tile reads
//     correctly right after a reload" — but nothing ever wrote it, so glance tiles read blank.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { SessionTile } from '../src/canvas/SessionTile';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import * as sessions from '../src/canvas/sessions';

const indexMock = vi.fn();
const messagesMock = vi.fn();
vi.mock('../src/canvasAgentChat', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/canvasAgentChat')>();
  return {
    ...orig,
    fetchConversationIndex: (...a: unknown[]) => indexMock(...a),
    fetchConversationMessages: (...a: unknown[]) => messagesMock(...a),
  };
});

function bound(over: Partial<SessionNode> = {}): SessionNode {
  return {
    ...createSessionNode('llm', { x: 0, y: 0 }),
    id: 's1',
    title: '策划会话',
    binding: { companyId: 'c1', agentId: 'a1', agentName: '策划' },
    issueId: 'issue-1',
    ...over,
  };
}

beforeEach(() => {
  cleanup();
  sessions.resetAllSessions();
  indexMock.mockReset();
  messagesMock.mockReset();
});

describe('SessionTile history restore', () => {
  it('replays the node OWN thread instead of claiming there is no conversation', async () => {
    indexMock.mockResolvedValue([{ issueId: 'issue-1' }]);
    messagesMock.mockResolvedValue([
      { role: 'user', text: '【工作流节点】策划会话' },
      { role: 'agent', text: '验证通过：这是一段真实的历史回复。' },
    ]);

    render(<SessionTile node={bound()} scale={1} focused={false} gatewayBase="/gw" />);

    await waitFor(() => expect(sessions.getSnapshot('s1').history).toBe('loaded'));
    expect(sessions.getSnapshot('s1').turns.map((t) => t.text)).toEqual([
      '【工作流节点】策划会话',
      '验证通过：这是一段真实的历史回复。',
    ]);
    expect(screen.getByTestId('canvas-tile-s1').textContent).toContain('真实的历史回复');
  });

  it('says the history was UNREADABLE rather than showing an empty transcript', async () => {
    indexMock.mockResolvedValue(null); // store unreadable
    render(<SessionTile node={bound()} scale={1} focused={false} gatewayBase="/gw" />);
    await waitFor(() => expect(sessions.getSnapshot('s1').history).toBe('unreadable'));
    expect(messagesMock).not.toHaveBeenCalled();
  });

  it('does not fetch for a node that has no thread of its own yet', async () => {
    render(<SessionTile node={bound({ issueId: null })} scale={1} focused={false} gatewayBase="/gw" />);
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1')).toBeTruthy());
    expect(indexMock).not.toHaveBeenCalled();
  });

  it('fetches only ONCE even as the tile re-renders', async () => {
    indexMock.mockResolvedValue([{ issueId: 'issue-1' }]);
    messagesMock.mockResolvedValue([{ role: 'agent', text: 'hi' }]);
    const { rerender } = render(<SessionTile node={bound()} scale={1} focused={false} gatewayBase="/gw" />);
    await waitFor(() => expect(sessions.getSnapshot('s1').history).toBe('loaded'));
    rerender(<SessionTile node={bound({ x: 40 })} scale={1} focused={false} gatewayBase="/gw" />);
    rerender(<SessionTile node={bound({ x: 80 })} scale={1.2} focused={false} gatewayBase="/gw" />);
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1')).toBeTruthy());
    expect(indexMock).toHaveBeenCalledTimes(1);
  });
});

describe('SessionTile persisted preview', () => {
  it('reports the settled last line so the glance LOD survives a reload', async () => {
    const onPreview = vi.fn();
    render(<SessionTile node={bound()} scale={1} focused={false} gatewayBase="" onPreview={onPreview} />);

    sessions.appendTurn('s1', { role: 'agent', text: '第一行\n验证通过：最后一行' });
    await waitFor(() => expect(onPreview).toHaveBeenCalledWith('s1', '验证通过：最后一行', 'default'));
  });

  it('stays quiet while the stream is still running', async () => {
    const onPreview = vi.fn();
    render(<SessionTile node={bound()} scale={1} focused={false} gatewayBase="" onPreview={onPreview} />);

    sessions.setStreaming('s1', true);
    sessions.appendTurn('s1', { role: 'agent', text: '半截' });
    await waitFor(() => expect(sessions.getSnapshot('s1').turns).toHaveLength(1));
    expect(onPreview).not.toHaveBeenCalled();

    sessions.setStreaming('s1', false);
    await waitFor(() => expect(onPreview).toHaveBeenCalledWith('s1', '半截', 'default'));
  });

  it('does not re-report a value the node already stores', async () => {
    const onPreview = vi.fn();
    render(
      <SessionTile
        node={bound({ preview: '已经是这一行' })}
        scale={1}
        focused={false}
        gatewayBase=""
        onPreview={onPreview}
      />,
    );
    sessions.appendTurn('s1', { role: 'agent', text: '已经是这一行' });
    await waitFor(() => expect(sessions.getSnapshot('s1').turns).toHaveLength(1));
    expect(onPreview).not.toHaveBeenCalled();
  });
});

describe('SessionTile compact contract preview', () => {
  const outputs = [
    { id: 'result', label: 'Result', type: 'markdown' as const, required: true, value: '' },
    { id: 'followups', label: 'Followups', type: 'text' as const, required: false, value: '' },
  ];

  it.each([false, true])('shows and persists the first declared JSON result (fenced=%s)', async (fenced) => {
    const onPreview = vi.fn();
    const node = bound({ contract: { version: 1, inputs: [], outputs } });
    render(<SessionTile node={node} scale={1} focused={false} compact gatewayBase="" onPreview={onPreview} />);
    // JSON key order differs from the output form; the second line must not replace the summary.
    const json = JSON.stringify({ followups: 'Next steps', result: 'Architecture is ready\nDetails follow' }, null, 2);
    sessions.appendTurn('s1', { role: 'agent', text: fenced ? `\`\`\`json\n${json}\n\`\`\`` : json });
    await waitFor(() => expect(onPreview).toHaveBeenCalledWith('s1', 'Architecture is ready', 'default'));
    expect(screen.getByTestId('canvas-tile-s1').querySelector('.awwo-compact-summary')?.textContent).toBe('Architecture is ready');
  });

  it.each([0, false])('keeps a valid scalar result %s instead of treating it as empty', async (value) => {
    const onPreview = vi.fn();
    const node = bound({ contract: { version: 1, inputs: [], outputs: [
      { ...outputs[0], type: typeof value === 'number' ? 'number' : 'boolean' }, outputs[1],
    ] } });
    render(<SessionTile node={node} scale={1} focused={false} compact gatewayBase="" onPreview={onPreview} />);
    sessions.appendTurn('s1', { role: 'agent', text: JSON.stringify({ result: value, followups: 'Later' }, null, 2) });
    await waitFor(() => expect(onPreview).toHaveBeenCalledWith('s1', String(value), 'default'));
    expect(screen.getByTestId('canvas-tile-s1').querySelector('.awwo-compact-summary')?.textContent).toBe(String(value));
  });

  it.each([
    { text: '# Markdown\nExisting last line', expected: 'Existing last line' },
    { text: '{\n  "result": "Incomplete', expected: '"result": "Incomplete' },
    { text: '{\n  "other": "Unrelated JSON"\n}', expected: '}' },
  ])('preserves the existing fallback for $text', async ({ text, expected }) => {
    const onPreview = vi.fn();
    render(<SessionTile node={bound({ contract: { version: 1, inputs: [], outputs } })}
      scale={1} focused={false} compact gatewayBase="" onPreview={onPreview} />);
    sessions.appendTurn('s1', { role: 'agent', text });
    await waitFor(() => expect(onPreview).toHaveBeenCalledWith('s1', expected, 'default'));
    expect(screen.getByTestId('canvas-tile-s1').querySelector('.awwo-compact-summary')?.textContent).toBe(expected);
  });
});
