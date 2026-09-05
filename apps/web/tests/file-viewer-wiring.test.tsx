import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AssistantMarkdown } from '../src/App';

afterEach(cleanup);

/**
 * Wiring tests for the conversation -> file-viewer hop. These catch the
 * confused-deputy bug (a link must open ITS turn's run, not a global selection)
 * and the file-vs-external routing boundary that the unit tests on fileLinkPath
 * alone could not.
 */
describe('AssistantMarkdown file-link routing', () => {
  it('routes a clean relative-path link to the viewer with the turn run id', () => {
    const onFileView = vi.fn();
    render(
      <AssistantMarkdown
        content={'see [the plan](docs/plan.md)'}
        desktopInvoke={null}
        fileRunId="run_A"
        onFileView={onFileView}
      />,
    );
    fireEvent.click(screen.getByText('the plan'));
    expect(onFileView).toHaveBeenCalledWith('run_A', 'docs/plan.md');
  });

  it('uses the provided run id, never a global selection (confused-deputy guard)', () => {
    const onFileView = vi.fn();
    render(
      <AssistantMarkdown content={'[f](a/b.md)'} desktopInvoke={null} fileRunId="run_B" onFileView={onFileView} />,
    );
    fireEvent.click(screen.getByText('f'));
    expect(onFileView).toHaveBeenCalledWith('run_B', 'a/b.md');
  });

  it('does not route an absolute external link into the viewer', () => {
    const onFileView = vi.fn();
    render(
      <AssistantMarkdown
        content={'see [site](https://example.com)'}
        desktopInvoke={null}
        fileRunId="run_A"
        onFileView={onFileView}
      />,
    );
    fireEvent.click(screen.getByText('site'));
    expect(onFileView).not.toHaveBeenCalled();
  });

  it('routes neither to the viewer NOR the OS opener for an escaping relative path', () => {
    const onFileView = vi.fn();
    const desktopInvoke = vi.fn().mockResolvedValue(undefined);
    render(
      <AssistantMarkdown
        content={'see [x](../../etc/passwd)'}
        desktopInvoke={desktopInvoke}
        fileRunId="run_A"
        onFileView={onFileView}
      />,
    );
    fireEvent.click(screen.getByText('x'));
    // ../.. fails fileLinkPath (not a clean path) AND the absolute-scheme guard
    // (not http/https/mailto) -> the desktop opener is never invoked.
    expect(onFileView).not.toHaveBeenCalled();
    expect(desktopInvoke).not.toHaveBeenCalled();
  });

  it('fail-closed when the message has no own run id (no session-latest fallback)', () => {
    // The render site passes ONLY turn.run_id (never activeContextRunId), so a
    // message persisted without run_id (direct/native/stream chat paths) gets
    // fileRunId=null here. Clicking its relative link must NOT open the viewer —
    // it must never be bound to the session's latest (different) run.
    const onFileView = vi.fn();
    const desktopInvoke = vi.fn().mockResolvedValue(undefined);
    render(
      <AssistantMarkdown content={'[f](a/b.md)'} desktopInvoke={desktopInvoke} fileRunId={null} onFileView={onFileView} />,
    );
    fireEvent.click(screen.getByText('f'));
    // neither the viewer (no run) nor the OS opener (relative path) fires
    expect(onFileView).not.toHaveBeenCalled();
    expect(desktopInvoke).not.toHaveBeenCalled();
  });
});
