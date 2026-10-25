import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { componentModelEntry, planComponentModel, withAssistantModel } from '../src/canvas/assistantModel';
import { DEFAULT_NEW_NODE_MODEL } from '../src/canvas/planNewNodeModel';
import { createSessionNode, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { createNodeTeam, validateNodeTeam } from '../src/canvas/nodeTeam';
import { executionHost } from '../src/saas/AssistantExecution';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { executionModelKey, useManagedExecution } from '../src/saas/useManagedExecution';

const node = (id: string, extra: Partial<SessionNode> = {}): SessionNode => ({ ...createSessionNode('llm', { x: 0, y: 0 }), id, ...extra });
const doc = (nodes: SessionNode[]): CanvasDocument => ({ version: 2, updatedAt: 0, nodes, edges: [] } as unknown as CanvasDocument);
const palette = [
  { runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5', available: true },
  { runtime: 'pi', model: 'bedrock.claude-opus-5-5', available: true },
  { runtime: 'pi', model: 'qwen3.8-27b-p6', available: true, effort: 'low' },
  { runtime: 'pi', model: 'claude-opus-5', available: false },
];
const opus = { runtime: 'pi', model: 'bedrock.claude-opus-5-5' };

describe('the components a canvas-assistant plan adds', () => {
  it('start on the model chosen for the assistant, on the runtime AwwO runs that model on rather than the assistant’s', () => {
    const before = doc([node('kept', { runtime: 'pi', model: 'claude-opus-5' }), node('new-a'), node('new-b'), node('old')]);
    const after = withAssistantModel(before, ['kept', 'new-a', 'new-b'], opus, palette);
    const byId = Object.fromEntries(after.nodes.map(item => [item.id, item as SessionNode]));
    // The assistant's direct tasks run Opus 5.5 on Pi; a node runs it on openai-agents, where its long call is not cut off.
    expect([byId['new-a'].runtime, byId['new-a'].model, byId['new-a'].effort]).toEqual(['openai-agents', 'bedrock.claude-opus-5-5', '']);
    expect(byId['new-b'].model).toBe('bedrock.claude-opus-5-5');
    // A node the plan did not add, and one the plan already set, are left as they are.
    expect([byId.old.runtime, byId.old.model]).toEqual(['', '']);
    expect([byId.kept.runtime, byId.kept.model]).toEqual(['pi', 'claude-opus-5']);
  });

  it('use another runtime that offers the model, keep the entry’s effort, and leave media nodes alone', () => {
    expect(componentModelEntry({ runtime: 'pi', model: 'bedrock.claude-opus-5-5' }, palette.filter(item => item.runtime !== 'pi'))?.runtime).toBe('openai-agents');
    expect(componentModelEntry({ runtime: 'openai-agents', model: 'qwen3.8-27b-p6' }, palette)).toEqual(palette[2]);
    const image = { ...createSessionNode('image', { x: 0, y: 0 }), id: 'picture' } as SessionNode;
    const after = withAssistantModel(doc([image, node('agent')]), ['picture', 'agent'], { runtime: 'pi', model: 'qwen3.8-27b-p6' }, palette);
    expect((after.nodes[0] as SessionNode).model).toBe(image.model);
    expect([(after.nodes[1] as SessionNode).model, (after.nodes[1] as SessionNode).effort]).toEqual(['qwen3.8-27b-p6', 'low']);
  });

  it('stay on Pi only for a model no ready openai-agents worker offers', () => {
    const notReady = palette.map(item => item.runtime === 'openai-agents' ? { ...item, available: false } : item);
    expect(componentModelEntry(opus, notReady)?.runtime).toBe('pi');
    expect(componentModelEntry({ runtime: 'openai-agents', model: 'qwen3.8-27b-p6' }, palette)?.runtime).toBe('pi');
  });

  it('take a team the plan gave a node it added to the chosen model’s runtime, where its members inherit that model', () => {
    const fresh = node('team-new', { team: createNodeTeam({ title: '', persona: '', model: '', runtime: '' }) });
    const own = createNodeTeam({ title: '', persona: '', model: '', runtime: '' });
    const set = node('team-own', { team: { ...own, members: [{ ...own.members[0], model: 'claude-opus-5' }, own.members[1]] } });
    const after = withAssistantModel(doc([fresh, set]), ['team-new', 'team-own'], opus, palette);
    const [moved, kept] = after.nodes as SessionNode[];
    expect([moved.runtime, moved.model, moved.team?.runtime]).toEqual(['openai-agents', 'bedrock.claude-opus-5-5', 'openai-agents']);
    expect(moved.team?.members.every(member => member.runtime === '' && member.model === '')).toBe(true);
    expect(validateNodeTeam(moved.team)).toEqual([]);
    // A model AwwO runs on Pi takes the team there too, off the runtime a new team starts on (nodeTeam.ts newTeamRuntime).
    const onPi = withAssistantModel(doc([fresh]), ['team-new'], { runtime: 'pi', model: 'qwen3.8-27b-p6' }, palette).nodes[0] as SessionNode;
    expect([onPi.runtime, onPi.model, onPi.team?.runtime]).toEqual(['pi', 'qwen3.8-27b-p6', 'pi']);
    // A member set up its own way: the node and its team stay exactly as the plan left them.
    expect(kept).toBe(set);
    // A model on a runtime that runs no team (one a later catalogue might add) never splits a node from its team: both stay.
    const elsewhere = withAssistantModel(doc([fresh]), ['team-new'], { runtime: 'later', model: 'box' }, [{ runtime: 'later', model: 'box', available: true }]);
    expect(elsewhere.nodes[0]).toBe(fresh);
  });

  it('keep the workspace default when no model was chosen or the workspace offers the chosen one to no node', () => {
    const before = doc([node('new')]);
    expect(withAssistantModel(before, ['new'], undefined, palette)).toBe(before);
    expect(withAssistantModel(before, ['new'], { runtime: 'pi', model: 'claude-opus-5' }, palette)).toBe(before);
    expect(withAssistantModel(before, ['new'], { runtime: 'pi', model: 'gone' }, palette)).toBe(before);
  });

  it('never start on a model the workspace’s plan does not include now', () => {
    const locked = palette.map(item => item.model === 'bedrock.claude-opus-5-5' ? { ...item, requiresUpgrade: true } : item);
    const before = doc([node('new')]);
    expect(componentModelEntry(opus, locked)).toBeUndefined();
    expect(withAssistantModel(before, ['new'], opus, locked)).toBe(before);
  });
});

// The model a plan's planner sized the nodes it adds for (canvasPlan.ts planNewNodeModel) is the one they take, a
// resume's chosen before the reader changed it; "default" leaves them on the workspace default; a plan that names none,
// or names one they cannot take now, leaves the reader's choice now.
describe('the model the components a plan adds take', () => {
  const qwen = { runtime: 'pi', model: 'qwen3.8-27b-p6' };
  const choices = [...palette,
    { runtime: 'openai-agents', model: 'deepseek-flash', available: true, userChosen: true },
    { runtime: 'openai-agents', model: 'bedrock.claude-sonnet-5', available: true, requiresUpgrade: true }];

  it('is the model the plan was sized for, on the runtime AwwO runs it on, whatever the reader chose since', () => {
    expect(planComponentModel('bedrock.claude-opus-5-5', qwen, choices)).toEqual({ runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5' });
    expect(planComponentModel('qwen3.8-27b-p6', opus, choices)).toEqual(qwen);
    expect(planComponentModel('bedrock.claude-opus-5-5', undefined, choices)).toEqual({ runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5' });
  });

  it('is none for "default", whatever the reader chose since', () => {
    expect(planComponentModel(DEFAULT_NEW_NODE_MODEL, opus, choices)).toBeUndefined();
    expect(planComponentModel(DEFAULT_NEW_NODE_MODEL, undefined, choices)).toBeUndefined();
  });

  it('is the reader’s choice now where the plan names none or one its nodes cannot take now', () => {
    expect(planComponentModel(undefined, opus, choices)).toBe(opus);
    expect(planComponentModel(undefined, undefined, choices)).toBeUndefined();
    // No longer offered, no runtime ready for it, or a model the workspace's plan no longer includes.
    for (const model of ['gone', 'claude-opus-5', 'bedrock.claude-sonnet-5']) expect(planComponentModel(model, qwen, choices)).toBe(qwen);
  });

  it('is a model only a user may choose only while the reader still has it chosen', () => {
    const deepseek = { runtime: 'openai-agents', model: 'deepseek-flash' };
    expect(planComponentModel('deepseek-flash', deepseek, choices)).toEqual(deepseek);
    expect(planComponentModel('deepseek-flash', qwen, choices)).toBe(qwen);
    expect(planComponentModel('deepseek-flash', undefined, choices)).toBeUndefined();
  });
});

const KEY = 'awwo.saas:user-a:tenant-a:awwo.assistant.model.v1';
const catalogue = { ready: true, capabilities: { workspace: true, approvals: true }, models: [
  { id: 'qwen3.8-27b-p6', label: 'qwen3.8-27b-p6', runtime: 'pi', route: 'free' },
  { id: 'bedrock.claude-opus-5-5', label: 'Claude Opus 5.5', runtime: 'pi', route: 'bedrock' }] };
const wrapper = ({ children }: { children: ReactNode }) => <SaaSPreferencesProvider>{children}</SaaSPreferencesProvider>;
const opened = (canvasId = 'canvas-a') => {
  const hook = renderHook(() => useManagedExecution('tenant-a', canvasId, { userId: 'user-a' }), { wrapper });
  act(() => hook.result.current.activate());
  return hook;
};

describe('the canvas assistant’s model', () => {
  beforeEach(() => {
    localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/computer-runtime') ? catalogue : { items: [] }), { status: 200 })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('is the service’s first model until the reader chooses one, and only a chosen one goes to new components', async () => {
    const { result, unmount } = opened();
    // Until the service is read, no choice is known, so a plan names no model for the components it adds.
    expect(executionHost(result.current).componentModelRead).toBeUndefined();
    await waitFor(() => expect(result.current.choice.model?.id).toBe('qwen3.8-27b-p6'));
    expect(result.current.componentModel).toBeUndefined();
    expect(executionHost(result.current).componentModel).toBeUndefined();
    expect(executionHost(result.current).componentModelRead).toBe(true);
    act(() => result.current.chooseModel(executionModelKey('pi', 'bedrock.claude-opus-5-5')));
    expect(result.current.componentModel).toEqual({ runtime: 'pi', model: 'bedrock.claude-opus-5-5' });
    expect(executionHost(result.current).componentModel).toEqual({ runtime: 'pi', model: 'bedrock.claude-opus-5-5' });
    expect(localStorage.getItem(KEY)).toBe(executionModelKey('pi', 'bedrock.claude-opus-5-5'));
    unmount();
  });

  it('holds on another canvas of the workspace and after a reload, while the service still offers it', async () => {
    localStorage.setItem(KEY, executionModelKey('pi', 'bedrock.claude-opus-5-5'));
    const { result, unmount } = opened('canvas-b');
    await waitFor(() => expect(result.current.choice.model?.id).toBe('bedrock.claude-opus-5-5'));
    expect(result.current.componentModel).toEqual({ runtime: 'pi', model: 'bedrock.claude-opus-5-5' });
    unmount();
    // A stored model the service no longer offers is not used: the first model is, and nothing goes to new components.
    localStorage.setItem(KEY, executionModelKey('pi', 'retired-model'));
    const again = opened('canvas-c');
    await waitFor(() => expect(again.result.current.choice.model?.id).toBe('qwen3.8-27b-p6'));
    expect(again.result.current.componentModel).toBeUndefined();
    again.unmount();
  });
});
