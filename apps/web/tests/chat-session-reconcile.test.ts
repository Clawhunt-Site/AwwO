import { describe, expect, it } from 'vitest';

import { reconcileIncomingChatSessions } from '../src/App';

// Build a minimal BackendChatSession-shaped object for the reconcile helper.
// Only session_id + messages matter to the merge; the rest satisfy the type.
function session(
  id: string,
  messages: Array<{ role: string; content: string; status?: string }>,
  extra: Record<string, unknown> = {},
) {
  return {
    session_id: id,
    title: id,
    created_at: 0,
    updated_at: 0,
    messages,
    ...extra,
  } as unknown as Parameters<typeof reconcileIncomingChatSessions>[0][number];
}

describe('reconcileIncomingChatSessions', () => {
  it('keeps the LONGER local transcript when the server snapshot is lagging (the wipe bug)', () => {
    // The client already knows [user, reply] optimistically; a reload lands
    // before the reply is persisted server-side, so incoming has only [user].
    const local = [session('s1', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'reply' }])];
    const incoming = [session('s1', [{ role: 'user', content: 'hi' }], { archived: false })];

    const [merged] = reconcileIncomingChatSessions(local, incoming);
    // Longer local messages are preserved (turn not blanked)...
    expect(merged.messages).toHaveLength(2);
    expect(merged.messages[1]?.content).toBe('reply');
    // ...but the server stays authoritative for the rest of the record.
    expect((merged as { archived?: boolean }).archived).toBe(false);
  });

  it('takes the server snapshot once it has caught up (equal length → server wins)', () => {
    const local = [session('s1', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'optimistic' }])];
    const incoming = [session('s1', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'persisted' }])];

    const [merged] = reconcileIncomingChatSessions(local, incoming);
    expect(merged.messages).toHaveLength(2);
    // Server's version (its run-linked reply) is authoritative once not shorter.
    expect(merged.messages[1]?.content).toBe('persisted');
  });

  it('takes the server snapshot when it is longer than local', () => {
    const local = [session('s1', [{ role: 'user', content: 'hi' }])];
    const incoming = [session('s1', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'reply' }])];

    const [merged] = reconcileIncomingChatSessions(local, incoming);
    expect(merged.messages).toHaveLength(2);
  });

  it('passes through a session the client has never seen', () => {
    const incoming = [session('newbie', [{ role: 'user', content: 'hi' }])];
    const merged = reconcileIncomingChatSessions([], incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.session_id).toBe('newbie');
  });

  it('keeps a local WORKING tail against an equal-length operational-comment snapshot', () => {
    // Local has an in-flight [user, assistant(working)]; the server returns 2 too,
    // but its 2nd is an operational agent comment (workspace-ready → projected as
    // assistant, no 'working' status). Equal length must NOT let it replace the
    // live working turn.
    const local = [session('s1', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', status: 'working' },
    ])];
    const incoming = [session('s1', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'workspace ready' },
    ])];

    const [merged] = reconcileIncomingChatSessions(local, incoming);
    expect(merged.messages[1]?.status).toBe('working');
    expect(merged.messages[1]?.content).toBe('');
  });

  it('lets the server win when it has strictly more CONVERSATIONAL turns, even if local has a working tail', () => {
    const local = [session('s1', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', status: 'working' },
    ])];
    const incoming = [session('s1', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'real reply' },
      { role: 'user', content: 'next' },
    ])];

    const [merged] = reconcileIncomingChatSessions(local, incoming);
    expect(merged.messages).toHaveLength(3);
    expect(merged.messages[1]?.content).toBe('real reply');
  });

  it('keeps a local WORKING tail when the server is longer ONLY due to system notices', () => {
    // The run writes workspace-ready / runtime-service `system` notices mid-turn.
    // Raw length: server 3 > local 2 — a plain length compare would drop the live
    // working turn. Conversational count (excluding system) is server 1 < local 2,
    // so the in-flight working turn survives (this is the case Codex flagged).
    const local = [session('s1', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', status: 'working' },
    ])];
    const incoming = [session('s1', [
      { role: 'user', content: 'hi' },
      { role: 'system', content: '## Workspace Ready' },
      { role: 'system', content: 'runtime service up' },
    ])];

    const [merged] = reconcileIncomingChatSessions(local, incoming);
    expect(merged.messages).toHaveLength(2);
    expect(merged.messages[1]?.status).toBe('working');
  });

  it('keeps a just-finished local reply when the server is longer only due to system notices', () => {
    // Completion race: client already has [user, reply(completed)]; server has
    // written the system notices but not yet persisted the reply comment. The
    // completed reply must not be dropped until the server's real reply lands.
    const local = [session('s1', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'my reply', status: 'completed' },
    ])];
    const incoming = [session('s1', [
      { role: 'user', content: 'hi' },
      { role: 'system', content: '## Workspace Ready' },
      { role: 'system', content: 'runtime service up' },
    ])];

    const [merged] = reconcileIncomingChatSessions(local, incoming);
    expect(merged.messages).toHaveLength(2);
    expect(merged.messages[1]?.content).toBe('my reply');
  });

  it('never resurrects a local-only session (drafts are merged separately in loadChatSessions)', () => {
    const local = [session('gone', [{ role: 'user', content: 'x' }])];
    const incoming = [session('s1', [{ role: 'user', content: 'hi' }])];
    const merged = reconcileIncomingChatSessions(local, incoming);
    expect(merged.map((s) => s.session_id)).toEqual(['s1']);
  });
});
