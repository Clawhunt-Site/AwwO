import { describe, expect, it } from 'vitest';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { followLiveNode, inspectorEdits, mergeIntoLive, openConflicts, savedInto, settleConflict, type InspectorView } from '../src/canvas/inspectorMerge';

// 多人同屏: the Configure panel's draft against a node others change while it is open (inspectorMerge.ts).

const opened = (): SessionNode => ({ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'n', title: 'Plan', persona: 'Plans the work.', model: 'model-a' });
const viewOf = (node: SessionNode): InspectorView<SessionNode> => ({ draft: node, base: node, conflicts: [] });

describe('the Configure panel against others’ changes', () => {
  it('names the fields the person changed, a removed one too', () => {
    const base = { ...opened(), taskFrame: { version: 1 as const, source: 'manual' as const, constraints: ['Keep it short'], acceptanceCriteria: [] } };
    const { taskFrame: _gone, ...withoutFrame } = base;
    expect(inspectorEdits({ ...withoutFrame, persona: 'Reviews the work.' }, base).sort()).toEqual(['persona', 'taskFrame']);
    expect(inspectorEdits(base, base)).toEqual([]);
  });

  it('follows another’s change of a field the person has not changed', () => {
    const view = viewOf(opened());
    const edited = { ...view, draft: { ...view.draft, persona: 'Reviews the work.' } };
    const live = { ...opened(), title: 'Plan by the member' };
    const next = followLiveNode(edited, live);
    expect(next.draft).toMatchObject({ title: 'Plan by the member', persona: 'Reviews the work.' });
    expect(next.conflicts).toEqual([]);
    // Saved, the person's change goes onto the node as it is, the member's title kept.
    expect(mergeIntoLive(next.draft, next.base, live)).toMatchObject({ title: 'Plan by the member', persona: 'Reviews the work.' });
  });

  it('asks about a field both changed otherwise, and settles one both changed alike', () => {
    const view = { ...viewOf(opened()), draft: { ...opened(), persona: 'Reviews the work.', model: 'model-b' } };
    const live = { ...opened(), persona: 'Tests the work.', model: 'model-b' };
    const next = followLiveNode(view, live);
    expect(next.conflicts).toEqual(['persona']);
    expect(next.draft.persona).toBe('Reviews the work.');
    // The same model both picked is no conflict, and no longer the person's change either.
    expect(inspectorEdits(next.draft, next.base)).toEqual(['persona']);
    // Asked again with nothing new, the panel stays as it is.
    expect(followLiveNode(next, live)).toBe(next);
  });

  it('keeps the person’s value or takes the other’s, as the person answers', () => {
    const asked = followLiveNode({ ...viewOf(opened()), draft: { ...opened(), persona: 'Reviews the work.' } }, { ...opened(), persona: 'Tests the work.' });
    const live = { ...opened(), persona: 'Tests the work.' };
    const kept = settleConflict(asked, live, 'persona', true);
    expect(kept.conflicts).toEqual([]);
    expect(mergeIntoLive(kept.draft, kept.base, live).persona).toBe('Reviews the work.');
    const taken = settleConflict(asked, live, 'persona', false);
    expect(taken.draft.persona).toBe('Tests the work.');
    expect(inspectorEdits(taken.draft, taken.base)).toEqual([]);
    // A field kept asks again when the other changes it once more.
    expect(followLiveNode(kept, { ...live, persona: 'Ships the work.' }).conflicts).toEqual(['persona']);
  });

  it('writes a field the person cleared as cleared, which a save reads so, not as the node holds it', () => {
    const base = { ...opened(), agentRef: { source: 'market' as const, agentId: 'agent-1', version: 1 } };
    const cleared = { ...base, agentRef: undefined };
    const live = { ...base, title: 'Renamed' };
    const merged = mergeIntoLive(cleared, base, live);
    expect(Object.hasOwn(merged, 'agentRef')).toBe(true);
    expect(merged).toMatchObject({ agentRef: undefined, title: 'Renamed' });
    const { agentRef: _gone, ...without } = base;
    expect(Object.hasOwn(mergeIntoLive(without as SessionNode, base, live), 'agentRef')).toBe(false);
  });

  it('closes a question nothing differs in any more: the other side went back, or the person did', () => {
    const asked = followLiveNode({ ...viewOf(opened()), draft: { ...opened(), model: 'model-b' } }, { ...opened(), model: 'model-c' });
    expect(asked.conflicts).toEqual(['model']);
    // The other side puts the model back.
    expect(followLiveNode(asked, opened()).conflicts).toEqual([]);
    // The person puts theirs back: nothing of theirs differs, and the other value comes in.
    const back = followLiveNode({ ...asked, draft: opened() }, { ...opened(), model: 'model-c' });
    expect(back.conflicts).toEqual([]);
    expect(back.draft.model).toBe('model-c');
    expect(openConflicts({ ...asked, draft: opened() }, { ...opened(), model: 'model-c' }).conflicts).toEqual([]);
  });

  it('puts an edit made from an older draft onto the newer one with only what the edit changed (the panel’s keystrokes)', () => {
    const older = opened();
    const newer = { ...older, title: 'Plan by the member' };
    const edit = { ...older, persona: 'Reviews the work.' };
    expect(mergeIntoLive(edit, older, newer)).toMatchObject({ title: 'Plan by the member', persona: 'Reviews the work.' });
  });

  it('merges a bind’s result against what the bind saved first, so a change made meanwhile to anything else stays', () => {
    const saved = { ...opened(), skills: ['builtin:critic'] };
    const bound = { ...saved, binding: { companyId: 'company', agentId: 'agent-1', agentName: 'Plan' } };
    // Someone changed the skills while the hire was out.
    const live = { ...saved, skills: ['builtin:researcher'] };
    const merged = mergeIntoLive(bound, saved, live, ['model']);
    expect(merged.skills).toEqual(['builtin:researcher']);
    expect(merged.binding).toMatchObject({ agentId: 'agent-1' });
    // Against the node from before the bind, the person's skills would go over theirs.
    expect(mergeIntoLive(bound, opened(), live, ['model']).skills).toEqual(['builtin:critic']);
  });

  it('tells a save that landed from one that did not', () => {
    const base = opened();
    const saved = { ...base, persona: 'Reviews the work.' };
    expect(savedInto(saved, base, { ...saved, title: 'Renamed since' })).toBe(true);
    expect(savedInto(saved, base, base)).toBe(false);
  });

  it('writes the fields a bind sent as the draft holds them, though the person did not change them', () => {
    const base = opened();
    const live = { ...base, model: 'model-b' };
    expect(mergeIntoLive(base, base, live).model).toBe('model-b');
    expect(mergeIntoLive(base, base, live, ['model', 'id']).model).toBe('model-a');
  });

  it('writes nothing of the person’s over a field they did not change, and leaves another node alone', () => {
    const view = viewOf(opened());
    const live = { ...opened(), model: 'model-c', title: 'Renamed' };
    expect(mergeIntoLive(view.draft, view.base, live)).toBe(live);
    const other = { ...opened(), id: 'm' };
    expect(followLiveNode(view, other)).toBe(view);
    expect(mergeIntoLive(view.draft, view.base, other)).toBe(view.draft);
  });
});
