import { describe, expect, it } from 'vitest';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { withSandbox } from '../src/canvas/InspectorPanel';
import { automaticGroups, groupModels, sandboxGroups } from '../src/canvas/modelPalette';
import { automaticEntries, automaticEntry, choosesRuntime, withAutomaticRuntime } from '../src/canvas/nodeRuntime';
import { runtimeDefinitions, type SaaSRuntimeStatus } from '../src/saas/runtimeCatalog';

const status: SaaSRuntimeStatus = {
  available: true, configured: true,
  models: [
    { id: 'bedrock.claude-opus-5-5', runtime: 'openai-agents', name: 'Claude Opus 5.5', provider: 'anthropic' },
    { id: 'bedrock.claude-opus-5-5', runtime: 'sandbox', name: 'Claude Opus 5.5', provider: 'anthropic' },
    { id: 'qwen3.8-27b-p6', runtime: 'pi', name: 'Qwen', provider: 'llmgate' },
  ],
  runtimes: [
    { id: 'pi', name: 'Pi', available: true, configured: true, supportsEffortSelection: false, tools: [] },
    { id: 'openai-agents', name: 'OpenAI Agents', available: true, configured: true, supportsEffortSelection: false, tools: [] },
    { id: 'sandbox', name: 'Sandbox computer', available: true, configured: true, supportsEffortSelection: false, tools: [],
      workspace: { version: 1, available: true, maxModelCalls: 32 } },
  ],
};

const node = (patch: Partial<SessionNode> = {}): SessionNode => ({ ...createSessionNode('llm', { x: 0, y: 0 }), ...patch });

describe('sandbox computer runtime', () => {
  it('is read from the catalogue with its sandbox capability', () => {
    const sandbox = runtimeDefinitions(status).find(runtime => runtime.id === 'sandbox');
    expect(sandbox?.workspace).toEqual({ version: 1, available: true, maxModelCalls: 32 });
  });

  it('is never chosen for a node by AwwO, and a sandbox node is never moved off it', () => {
    const groups = groupModels(status, 'en');
    const entries = groups.flatMap(group => group.models);
    expect(automaticEntry('bedrock.claude-opus-5-5', entries)?.runtime).toBe('openai-agents');
    expect(automaticEntries(entries).map(entry => entry.runtime)).not.toContain('sandbox');
    expect(automaticGroups(groups).flatMap(group => group.models).map(entry => entry.runtime)).not.toContain('sandbox');
    const sandboxNode = node({ runtime: 'sandbox', model: 'bedrock.claude-opus-5-5' });
    expect(choosesRuntime(sandboxNode)).toBe(false);
    expect(withAutomaticRuntime(sandboxNode, entries, () => [])).toBe(sandboxNode);
    // A sandbox-only model is not a reason to put a plain node into a sandbox.
    expect(automaticEntry('sandbox-only', [{ runtime: 'sandbox', model: 'sandbox-only', available: true }])).toBeUndefined();
  });

  it('offers its models through the sandbox switch, and the switch keeps or replaces the model', () => {
    const sandbox = sandboxGroups(groupModels(status, 'en')).flatMap(group => group.models);
    expect(sandbox.map(entry => `${entry.runtime}:${entry.model}:${entry.execution}`)).toEqual(['sandbox:bedrock.claude-opus-5-5:workspace']);
    const on = withSandbox(node({ runtime: '', model: 'bedrock.claude-opus-5-5', effort: 'high' }), true, sandbox);
    expect(on).toMatchObject({ runtime: 'sandbox', model: 'bedrock.claude-opus-5-5', effort: '' });
    expect(withSandbox(node({ model: 'qwen3.8-27b-p6' }), true, sandbox)).toMatchObject({ runtime: 'sandbox', model: 'bedrock.claude-opus-5-5' });
    expect(withSandbox(on, false, sandbox)).toMatchObject({ runtime: '', model: 'bedrock.claude-opus-5-5' });
    const plain = node({ runtime: 'openai-agents' });
    expect(withSandbox(plain, false, sandbox)).toBe(plain);
  });
});
