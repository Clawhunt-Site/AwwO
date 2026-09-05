// /compact — context compaction for direct chat (CodePilot-style, reimplemented).
//
// ClawHunt chat continuity is NATIVE session-resume: the underlying agent runtime owns
// the context window, so the client cannot "trim" it. Faithful compaction is therefore
// an orchestration: (1) ask the agent — which still holds full context — to produce a
// handoff summary as a normal turn in the OLD session; (2) open a NEW session whose
// first message is seeded with that summary; (3) keep the old session untouched in the
// sidebar as the checkpoint (回溯 = reopen it from the sidebar).
//
// This module holds the PURE parts (prompt/marker/seed builders + the compactability
// gate) so they are unit-tested without loading App.tsx; the App wires them into the
// existing send pipeline.

export type CompactableTurn = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  status?: string;
};

// The summarize instruction sent (as a visible turn) to the OLD session. The agent has
// native context, so no transcript replay is needed in the prompt itself.
export function compactSummaryPrompt(locale: 'zh' | 'en'): string {
  return locale === 'zh'
    ? [
        '请把我们到目前为止的对话压缩成一份可交接的摘要，用于在一个全新的会话中无缝继续工作。要求：',
        '- 保留：总体目标、关键事实与数据、已做出的决定、当前进展/状态、未完成事项与下一步；',
        '- 保留用户表达过的持久偏好或约束；',
        '- 省略寒暄、试错过程和冗余细节；',
        '- 直接输出摘要正文，不要额外的开场白或结语。',
      ].join('\n')
    : [
        'Compress our conversation so far into a handoff summary that lets work continue seamlessly in a brand-new session. Requirements:',
        '- Keep: the overall goal, key facts and data, decisions made, current progress/state, open items and next steps;',
        '- Keep any lasting preferences or constraints the user expressed;',
        '- Drop pleasantries, trial-and-error noise, and redundant detail;',
        '- Output the summary body directly, with no preamble or sign-off.',
      ].join('\n');
}

// Compactable = there is at least one COMPLETED assistant turn to summarize. A chat
// that is empty, all-user, or whose only assistant turns failed/stopped has nothing
// worth compacting (and the summarize turn itself would have no context to compress).
export function canCompactTurns(turns: CompactableTurn[]): boolean {
  return turns.some(
    (turn) => turn.role === 'assistant' && (turn.status === 'completed' || turn.status === undefined) && turn.content.trim().length > 0,
  );
}

// The transcript the NEW (draft) session starts with: a system boundary marker carrying
// the summary, so the user sees exactly what context the new session continues from.
export function buildCompactBoundaryTurn(summary: string, locale: 'zh' | 'en'): CompactableTurn {
  const header =
    locale === 'zh'
      ? '——— 上下文已压缩 ———\n原会话完整保留在侧边栏（检查点），可随时回溯。新会话将携带以下摘要继续：'
      : '——— Context compacted ———\nThe original session is kept intact in the sidebar (checkpoint) — reopen it any time. This new session continues from the summary below:';
  return { role: 'system', content: `${header}\n\n${summary.trim()}`, status: 'completed' };
}

// Prefix applied to the FIRST message sent in the post-compact session, so the agent
// (which starts with a fresh, empty native context) receives the carried-over summary.
// Only the SENT payload is prefixed — the user's visible bubble stays their own text
// (the summary is already visible in the boundary turn above).
export function applyCompactSeed(seed: string, message: string, locale: 'zh' | 'en'): string {
  const label =
    locale === 'zh'
      ? '以下是上一段对话的压缩摘要（作为背景上下文，无需复述）：'
      : 'Compacted summary of the previous conversation (background context; no need to restate it):';
  return `${label}\n\n${seed.trim()}\n\n---\n\n${message}`;
}
