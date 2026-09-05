import { describe, expect, it } from 'vitest';
import {
  applyCompactSeed,
  buildCompactBoundaryTurn,
  canCompactTurns,
  compactSummaryPrompt,
} from '../src/compactChat';

describe('compactChat', () => {
  it('gates compaction on a completed assistant turn with content', () => {
    expect(canCompactTurns([])).toBe(false);
    expect(canCompactTurns([{ role: 'user', content: 'hi' }])).toBe(false);
    // failed/stopped/working assistant turns are not compactable context
    expect(canCompactTurns([{ role: 'assistant', content: 'x', status: 'failed' }])).toBe(false);
    expect(canCompactTurns([{ role: 'assistant', content: 'x', status: 'stopped' }])).toBe(false);
    expect(canCompactTurns([{ role: 'assistant', content: 'working…', status: 'working' }])).toBe(false);
    // whitespace-only content is nothing to compact
    expect(canCompactTurns([{ role: 'assistant', content: '   ', status: 'completed' }])).toBe(false);
    // a completed reply makes the chat compactable (undefined status = legacy completed)
    expect(canCompactTurns([{ role: 'assistant', content: 'answer', status: 'completed' }])).toBe(true);
    expect(canCompactTurns([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }])).toBe(true);
  });

  it('builds a locale-matched summarize prompt', () => {
    expect(compactSummaryPrompt('zh')).toContain('压缩');
    expect(compactSummaryPrompt('en')).toContain('handoff summary');
  });

  it('builds a visible system boundary turn carrying the summary', () => {
    const turn = buildCompactBoundaryTurn('  key facts + next steps  ', 'zh');
    expect(turn.role).toBe('system');
    expect(turn.status).toBe('completed');
    expect(turn.content).toContain('上下文已压缩');
    expect(turn.content).toContain('key facts + next steps'); // trimmed summary embedded
    const en = buildCompactBoundaryTurn('summary', 'en');
    expect(en.content).toContain('Context compacted');
  });

  it('prefixes only the sent payload with the seed, keeping the user message intact', () => {
    const sent = applyCompactSeed('the summary', 'continue with step 3', 'en');
    expect(sent).toContain('Compacted summary of the previous conversation');
    expect(sent).toContain('the summary');
    // the user's own message survives verbatim after the delimiter
    expect(sent.endsWith('continue with step 3')).toBe(true);
    expect(sent).toContain('\n\n---\n\n');
    const zh = applyCompactSeed('摘要', '继续', 'zh');
    expect(zh).toContain('压缩摘要');
    expect(zh.endsWith('继续')).toBe(true);
  });
});
