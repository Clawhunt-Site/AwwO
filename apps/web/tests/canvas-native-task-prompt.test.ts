import { describe, expect, it } from 'vitest';
import { DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE, joinPromptSections, renderTemplate, renderPaperclipWakePrompt } from '../../../server/packages/adapter-utils/src/server-utils';
import { buildHireBody } from '../src/canvasHire';

describe('Codex canvas task transport through the native adapter', () => {
  it('renders first-turn rich-text inputs and output requirements through the native comment wake with its default prompt', () => {
    const body = buildHireBody({ name: 'Spec', missionRole: 'implement', adapterType: 'codex_local', model: '', effort: '' });
    const config = body.adapterConfig as Record<string, unknown>;
    const task = '任务：写 artifacts/spec.md\n包含 AWWO-TASK-CONTEXT\n最终仅返回 {"result":"...","followups":""}';
    expect(config).not.toHaveProperty('promptTemplate');
    expect(config).not.toHaveProperty('bootstrapPromptTemplate');
    const wake = renderPaperclipWakePrompt({
      reason: 'issue_commented', issue: { id: 'issue-1', title: 'Spec', status: 'in_progress' },
      comments: [{ id: 'comment-1', body: task, authorType: 'user', authorId: 'operator', createdAt: '2026-09-07T00:00:00Z' }],
      commentIds: ['comment-1'], latestCommentId: 'comment-1', fallbackFetchNeeded: false,
    }, { resumedSession: false });
    // execute.ts joins this wake separately from the optional/default prompt. No
    // legacy template or task-markdown variable is needed for the first comment.
    const rendered = joinPromptSections([wake, renderTemplate(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE, {
      agent: { id: 'agent-1', name: 'Spec' },
    })]);
    expect(rendered).toContain(task);
    expect(rendered.split('AWWO-TASK-CONTEXT')).toHaveLength(2);
    expect(rendered).not.toContain('{{context.');
    expect(config.dangerouslyBypassApprovalsAndSandbox).toBe(false);
  });

  it('keeps the new message in the native resume delta without depending on first-turn template reinjection', () => {
    const latest = '读取 stop-started.txt，写 resume-ok.txt，不要继续此前等待。';
    const delta = renderPaperclipWakePrompt({
      reason: 'issue_commented', issue: { id: 'issue-1', title: 'Spec', status: 'in_progress' },
      comments: [{ id: 'comment-2', body: latest, authorType: 'user', authorId: 'operator', createdAt: '2026-09-06T00:00:00Z' }],
      commentIds: ['comment-2'], latestCommentId: 'comment-2', fallbackFetchNeeded: false,
    }, { resumedSession: true });
    expect(delta).toContain(latest);
    expect(delta).toContain('Resume Delta');
    expect(delta.split(latest)).toHaveLength(2);
  });
});
