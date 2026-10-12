import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { componentModelEntry, withAssistantModel } from '../src/canvas/assistantModel';
import { createSessionNode, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
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
  it('start on the model chosen for the assistant, on its runtime when the workspace offers it there', () => {
    const before = doc([node('kept', { runtime: 'pi', model: 'claude-opus-5' }), node('new-a'), node('new-b'), node('old')]);
    const after = withAssistantModel(before, ['kept', 'new-a', 'new-b'], opus, palette);
    const byId = Object.fromEntries(after.nodes.map(item => [item.id, item as SessionNode]));
    expect([byId['new-a'].runtime, byId['new-a'].model, byId['new-a'].effort]).toEqual(['pi', 'bedrock.claude-opus-5-5', '']);
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

  it('keep the workspace default when no model was chosen or the workspace offers the chosen one to no node', () => {
    const before = doc([node('new')]);
    expect(withAssistantModel(before, ['new'], undefined, palette)).toBe(before);
    expect(withAssistantModel(before, ['new'], { runtime: 'pi', model: 'claude-opus-5' }, palette)).toBe(before);
    expect(withAssistantModel(before, ['new'], { runtime: 'pi', model: 'gone' }, palette)).toBe(before);
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
    await waitFor(() => expect(result.current.choice.model?.id).toBe('qwen3.8-27b-p6'));
    expect(result.current.componentModel).toBeUndefined();
    expect(executionHost(result.current).componentModel).toBeUndefined();
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
