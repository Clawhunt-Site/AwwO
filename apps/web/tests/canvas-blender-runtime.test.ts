import { describe, expect, it } from 'vitest';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { withComputer, withModelChoice, withSandbox } from '../src/canvas/InspectorPanel';
import { automaticGroups, groupModels, sandboxGroups } from '../src/canvas/modelPalette';
import { automaticEntries, automaticEntry, BLENDER_RUNTIME, choosesRuntime, computerRuntime, pickedModelEntry, withAutomaticRuntime } from '../src/canvas/nodeRuntime';
import { nodeTeamRuntimeLabel } from '../src/canvas/nodeTeam';
import { NODE_RUNTIMES, runtimeDefinitions, type SaaSRuntimeStatus } from '../src/saas/runtimeCatalog';
import { readRunExecutionMetadata, workspaceToolLabel } from '../src/saas/workspaceActivity';
import { formFromNode } from '../src/saas/market/publishForm';
import { marketModelDecision } from '../src/saas/market/marketModel';
import { createRecordedCopyDocument } from '../src/saas/recordedCanvas';

// The Blender workstation (the 'blender' runtime) is a sandbox computer with Blender in it, as the API lists it
// (runs.go runtimeCatalogue): a node's own choice, by its settings' switch, which AwwO never makes or undoes.
const status: SaaSRuntimeStatus = {
  available: true, configured: true,
  models: [
    { id: 'bedrock.claude-opus-5-5', runtime: 'openai-agents', name: 'Claude Opus 5.5', provider: 'anthropic' },
    { id: 'bedrock.claude-opus-5-5', runtime: 'sandbox', name: 'Claude Opus 5.5', provider: 'anthropic' },
    { id: 'bedrock.claude-opus-5-5', runtime: 'blender', name: 'Claude Opus 5.5', provider: 'anthropic' },
    { id: 'qwen3.8-27b-p6', runtime: 'pi', name: 'Qwen', provider: 'llmgate' },
  ],
  runtimes: [
    { id: 'pi', name: 'Pi', available: true, configured: true, supportsEffortSelection: false, tools: [] },
    { id: 'openai-agents', name: 'OpenAI Agents', available: true, configured: true, supportsEffortSelection: false, tools: [] },
    { id: 'sandbox', name: 'Sandbox computer', available: true, configured: true, supportsEffortSelection: false, tools: [],
      workspace: { version: 1, available: true, maxModelCalls: 32 } },
    { id: 'blender', name: 'Blender workstation', available: true, configured: true, supportsEffortSelection: false, tools: [],
      workspace: { version: 1, available: true, maxModelCalls: 32 } },
  ],
};

const node = (patch: Partial<SessionNode> = {}): SessionNode => ({ ...createSessionNode('llm', { x: 0, y: 0 }), ...patch });

describe('Blender workstation runtime', () => {
  it('is read from the catalogue with its workspace, and named', () => {
    expect(NODE_RUNTIMES).toContain('blender');
    expect(runtimeDefinitions(status).find(runtime => runtime.id === 'blender')?.workspace).toEqual({ version: 1, available: true, maxModelCalls: 32 });
    expect(nodeTeamRuntimeLabel('blender')).toBe('Blender workstation');
    expect([computerRuntime('blender'), computerRuntime('sandbox'), computerRuntime('openai-agents'), computerRuntime('')]).toEqual([true, true, false, false]);
  });

  it('is never chosen for a node by AwwO, and a workstation node is never moved off it', () => {
    const groups = groupModels(status, 'en');
    const entries = groups.flatMap(group => group.models);
    expect(automaticEntry('bedrock.claude-opus-5-5', entries)?.runtime).toBe('openai-agents');
    expect(automaticEntries(entries).map(entry => entry.runtime)).not.toContain('blender');
    expect(automaticGroups(groups).flatMap(group => group.models).map(entry => entry.runtime)).not.toContain('blender');
    const station = node({ runtime: BLENDER_RUNTIME, model: 'bedrock.claude-opus-5-5' });
    expect(choosesRuntime(station)).toBe(false);
    expect(withAutomaticRuntime(station, entries, () => [])).toBe(station);
    expect(automaticEntry('blender-only', [{ runtime: 'blender', model: 'blender-only', available: true }])).toBeUndefined();
  });

  it('offers its models through its own switch, which moves a node off the sandbox and back to AwwO\'s choice', () => {
    const groups = groupModels(status, 'en');
    const blender = sandboxGroups(groups, 'blender').flatMap(group => group.models);
    const sandbox = sandboxGroups(groups).flatMap(group => group.models);
    expect(blender.map(entry => `${entry.runtime}:${entry.model}`)).toEqual(['blender:bedrock.claude-opus-5-5']);
    expect(sandbox.map(entry => entry.runtime)).toEqual(['sandbox']);
    const on = withComputer(node({ runtime: '', model: 'bedrock.claude-opus-5-5', effort: 'high' }), BLENDER_RUNTIME, true, blender);
    expect(on).toMatchObject({ runtime: 'blender', model: 'bedrock.claude-opus-5-5', effort: '' });
    // A model the workstation does not offer gives way to its first ready one.
    expect(withComputer(node({ model: 'qwen3.8-27b-p6' }), BLENDER_RUNTIME, true, blender)).toMatchObject({ runtime: 'blender', model: 'bedrock.claude-opus-5-5' });
    expect(withComputer(on, BLENDER_RUNTIME, false, blender)).toMatchObject({ runtime: '', model: 'bedrock.claude-opus-5-5' });
    // Switching the sandbox on moves a workstation node there; switching the sandbox off leaves a workstation node alone.
    expect(withSandbox(on, true, sandbox)).toMatchObject({ runtime: 'sandbox' });
    expect(withSandbox(on, false, sandbox)).toBe(on);
    const plain = node({ runtime: 'openai-agents' });
    expect(withComputer(plain, BLENDER_RUNTIME, false, blender)).toBe(plain);
    // The model picker's default choice names no runtime: a workstation (or sandbox) node stays on its computer.
    expect(withModelChoice(on, { runtime: '', model: '', effort: '' })).toMatchObject({ runtime: 'blender', model: '', effort: '' });
    expect(withModelChoice(node({ runtime: 'sandbox', model: 'm' }), { runtime: '', model: '', effort: '' }).runtime).toBe('sandbox');
    expect(withModelChoice(plain, { runtime: 'pi', model: 'qwen3.8-27b-p6', effort: '' }).runtime).toBe('pi');
  });

  it('keeps a workstation node there when a model is picked under its composer', () => {
    const entries = groupModels(status, 'en').flatMap(group => group.models);
    const key = (runtime: string, model: string) => JSON.stringify([runtime, model]);
    const station = node({ runtime: BLENDER_RUNTIME, model: 'bedrock.claude-opus-5-5' });
    // The workstation's own entry, and the workstation's entry for a model picked from another runtime's list.
    expect(pickedModelEntry(station, key('blender', 'bedrock.claude-opus-5-5'), entries)?.key).toBe(key('blender', 'bedrock.claude-opus-5-5'));
    expect(pickedModelEntry(station, key('openai-agents', 'bedrock.claude-opus-5-5'), entries)?.key).toBe(key('blender', 'bedrock.claude-opus-5-5'));
    // A model the workstation does not offer, or offers but cannot run now, moves nothing; nor does an unknown pick.
    expect(pickedModelEntry(station, key('pi', 'qwen3.8-27b-p6'), entries)).toBeUndefined();
    const down = entries.map(entry => entry.runtime === 'blender' ? { ...entry, available: false } : entry);
    expect(pickedModelEntry(station, key('openai-agents', 'bedrock.claude-opus-5-5'), down)).toBeUndefined();
    expect(pickedModelEntry(station, key('blender', 'missing'), entries)).toBeUndefined();
    // A node in no computer takes the entry picked, never the workstation's.
    const plain = node({ runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5' });
    expect(pickedModelEntry(plain, key('pi', 'qwen3.8-27b-p6'), entries)?.runtime).toBe('pi');
    expect(pickedModelEntry(plain, key('blender', 'bedrock.claude-opus-5-5'), entries)).toBeUndefined();
    expect(pickedModelEntry(node({ runtime: '' }), key('blender', 'bedrock.claude-opus-5-5'), entries)).toBeUndefined();
    expect(pickedModelEntry(plain, key('openai-agents', 'bedrock.claude-opus-5-5'), down.map(entry => ({ ...entry, available: false })))).toBeUndefined();
  });

  it('is treated as the sandbox is by the market and by case copies', () => {
    // A market Agent is a text Agent: published from a workstation node it suggests no runtime, and a workstation entry
    // is never the one a market Agent's suggestion takes.
    const station = node({ runtime: BLENDER_RUNTIME, model: 'bedrock.claude-opus-5-5', title: 'Lamp maker' });
    expect(formFromNode(station, 't1').model.runtime).toBe('');
    const decision = marketModelDecision({ runtime: 'openai-agents', id: 'bedrock.claude-opus-5-5', effort: '', locked: false },
      [{ runtime: 'blender', model: 'bedrock.claude-opus-5-5', available: true, label: 'Claude Opus 5.5', displayName: 'Claude Opus 5.5', efforts: [] }]);
    expect(decision.kind).toBe('keep');
    // A recorded case's workstation node stays on its workstation, taking the chosen model where the workstation offers it.
    const copy = createRecordedCopyDocument({ nodes: [station], edges: [] } as never,
      { runtime: 'openai-agents', model: 'bedrock.claude-sonnet-5-5', label: 'Sonnet', blender: true });
    expect(copy.nodes[0]).toMatchObject({ runtime: 'blender', model: 'bedrock.claude-sonnet-5-5', effort: '' });
    const unoffered = createRecordedCopyDocument({ nodes: [station], edges: [] } as never, { runtime: 'openai-agents', model: 'qwen3.8-27b-p6', label: 'Qwen' });
    expect(unoffered.nodes[0]).toMatchObject({ runtime: 'blender', model: 'bedrock.claude-opus-5-5' });
  });

  it('shows a workstation run\'s Blender steps, past the sixteenth', () => {
    expect(workspaceToolLabel('workspace_blender', 'en')).toBe('Work in Blender');
    expect(workspaceToolLabel('workspace_blender', 'zh')).toBe('在 Blender 里操作');
    const items = Array.from({ length: 30 }, (_, index) => ({ step: index + 1, tool: index % 2 ? 'workspace_blender' : 'workspace_write' }));
    expect(readRunExecutionMetadata({ executionKind: 'workspace', workspaceActivity: { items, truncated: false } })?.workspaceActivity?.items).toHaveLength(30);
    expect(readRunExecutionMetadata({ executionKind: 'workspace', workspaceActivity: { items: [{ step: 65, tool: 'workspace_blender' }], truncated: false } })).toBeNull();
    expect(readRunExecutionMetadata({ executionKind: 'workspace', workspaceActivity: { items: [{ step: 1, tool: 'execute_blender_code' }], truncated: false } })).toBeNull();
  });
});
