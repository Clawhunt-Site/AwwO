import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TileTranscript } from '../src/canvas/TileTranscript';
import type { Turn } from '../src/canvas/sessions';

afterEach(cleanup);

function transcript(turns: Turn[], options: { limit?: number; streaming?: boolean } = {}) {
  return <TileTranscript
    turns={turns}
    history="loaded"
    streaming={options.streaming ?? false}
    limit={options.limit ?? Infinity}
    renderTurnDetails={(turn, latest) => <section
      data-testid={`details-${turn.runId ?? 'legacy'}`}
      data-owner={turn.id}
      data-role={turn.role}
      data-latest={String(latest)}
    >{turn.runId ?? 'legacy'}</section>}
  />;
}

describe('team run details for failed restored conversations', () => {
  it('shows a user-only accepted run without inventing an agent reply', () => {
    const { container } = render(transcript([
      { id: 1, role: 'user', text: '请继续讨论', runId: 'failed-run' },
    ]));

    const details = screen.getByTestId('details-failed-run');
    expect(details.previousElementSibling).toHaveTextContent('请继续讨论');
    expect(details).toHaveAttribute('data-role', 'user');
    expect(details).toHaveAttribute('data-latest', 'true');
    expect(container.querySelector('.canvas-transcript-turn--agent')).toBeNull();
  });

  it('moves the single details slot to the accepted empty agent placeholder', () => {
    const user: Turn = { id: 1, role: 'user', text: '请继续讨论', runId: 'live-run' };
    const { rerender } = render(transcript([user], { streaming: true }));
    expect(screen.getByTestId('details-live-run')).toHaveAttribute('data-owner', '1');

    rerender(transcript([user,
      { id: 2, role: 'agent', text: '', runId: 'live-run' },
    ], { streaming: true }));

    expect(screen.getAllByTestId('details-live-run')).toHaveLength(1);
    const details = screen.getByTestId('details-live-run');
    expect(details).toHaveAttribute('data-owner', '2');
    expect(details.previousElementSibling).toHaveClass('canvas-transcript-turn--agent');
    expect(details).toHaveAttribute('data-latest', 'true');
  });

  it('keeps same-text failed and completed runs associated with their own identities', () => {
    render(transcript([
      { id: 1, role: 'user', text: '再说一次', runId: 'failed-first' },
      { id: 2, role: 'user', text: '再说一次', runId: 'completed-second' },
      { id: 3, role: 'agent', text: '再说一次', runId: 'completed-second' },
      { id: 4, role: 'user', text: '再说一次', runId: 'failed-third' },
    ]));

    expect(screen.getAllByTestId('details-failed-first')).toHaveLength(1);
    expect(screen.getByTestId('details-failed-first')).toHaveAttribute('data-owner', '1');
    expect(screen.getAllByTestId('details-completed-second')).toHaveLength(1);
    expect(screen.getByTestId('details-completed-second')).toHaveAttribute('data-owner', '3');
    expect(screen.getByTestId('details-failed-third')).toHaveAttribute('data-owner', '4');
    expect(screen.getByTestId('details-failed-first')).toHaveAttribute('data-latest', 'false');
  });

  it('keeps a cropped agent reply and later failed run without exposing hidden earlier details', () => {
    render(transcript([
      { id: 1, role: 'user', text: '旧问题', runId: 'hidden-failure' },
      { id: 2, role: 'user', text: '当前问题', runId: 'completed-run' },
      { id: 3, role: 'agent', text: '当前回答', runId: 'completed-run' },
      { id: 4, role: 'user', text: '追问', runId: 'visible-failure' },
    ], { limit: 2 }));

    expect(screen.queryByTestId('details-hidden-failure')).toBeNull();
    expect(screen.getAllByTestId('details-completed-run')).toHaveLength(1);
    expect(screen.getByTestId('details-completed-run')).toHaveAttribute('data-owner', '3');
    expect(screen.getByTestId('details-visible-failure')).toHaveAttribute('data-owner', '4');
    expect(screen.queryByText('当前问题')).toBeNull();
  });

  it('keeps failed details visible before a trailing system error without treating it as an agent reply', () => {
    render(transcript([
      { id: 1, role: 'user', text: '请继续', runId: 'failed-run' },
      { id: 2, role: 'system', text: '运行失败', tone: 'error', runId: 'failed-run' },
    ]));

    expect(screen.getAllByTestId('details-failed-run')).toHaveLength(1);
    const details = screen.getByTestId('details-failed-run');
    expect(details).toHaveAttribute('data-owner', '1');
    expect(details.nextElementSibling).toHaveTextContent('运行失败');
  });

  it('renders one slot for repeated recovered entries of the same run', () => {
    render(transcript([
      { id: 1, role: 'user', text: '失败问题', runId: 'failed-run' },
      { id: 2, role: 'user', text: '失败问题', runId: 'failed-run' },
      { id: 3, role: 'user', text: '成功问题', runId: 'completed-run' },
      { id: 4, role: 'agent', text: '回复', runId: 'completed-run' },
      { id: 5, role: 'agent', text: '回复', runId: 'completed-run' },
    ]));

    expect(screen.getAllByTestId('details-failed-run')).toHaveLength(1);
    expect(screen.getByTestId('details-failed-run')).toHaveAttribute('data-owner', '2');
    expect(screen.getAllByTestId('details-completed-run')).toHaveLength(1);
    expect(screen.getByTestId('details-completed-run')).toHaveAttribute('data-owner', '5');
  });

  it('preserves legacy agent details without adding details to unidentified user turns', () => {
    render(transcript([
      { id: 1, role: 'user', text: '旧消息' },
      { id: 2, role: 'agent', text: '旧回复' },
      { id: 3, role: 'user', text: '未接纳的新消息' },
    ]));

    expect(screen.getAllByTestId('details-legacy')).toHaveLength(1);
    expect(screen.getByTestId('details-legacy')).toHaveAttribute('data-owner', '2');
    expect(screen.getByTestId('details-legacy')).toHaveAttribute('data-latest', 'false');
  });
});
