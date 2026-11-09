// A cloud canvas on a page with 多人同屏, for the tests of what a person's own steps do to the agents' work: the
// surface with a live host whose others' changes the test hands in, a workspace with two chat models, and agent-made
// nodes. Every id and name here is made up.
import { act, cleanup, render } from '@testing-library/react';
import { vi } from 'vitest';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, type CanvasDocument, type CanvasEdge, type NodeOutput, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import type { CanvasMultiplayerHost, CanvasMultiplayerSurface } from '../src/canvas/multiplayer/host';
import { edgeId } from '../src/canvas/ports';
import { resetAllSessions } from '../src/canvas/sessions';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

const tenant = { id: 'workspace-mp', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const status = { configured: true, available: true, plannerAvailable: true,
  models: [{ id: 'opus-fixture', name: 'Opus fixture', runtime: 'openai-agents', provider: 'anthropic' }, { id: 'qwen-fixture', name: 'Qwen fixture', runtime: 'openai-agents', provider: 'openai' }],
  runtimes: [{ id: 'openai-agents', name: 'OpenAI Agents', configured: true, available: true, tools: [] }] };
const capabilities = { skills: { enabled: true, maxNodeSkills: 4, maxNodeSkillBytes: 20480 }, memory: { enabled: false, maxRunItems: 0, maxRunBytes: 0, maxPerScope: 0 },
  webReader: { enabled: false, perDay: 0, usedToday: 0 }, render: { enabled: false, perDay: 0, usedToday: 0, limits: { maxSeconds: 20, maxFps: 60, maxWidth: 1920, maxHeight: 1920, maxFrames: 1800, maxHtmlBytes: 1 } } };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

export const wire = (fromNode: string, fromPort: string, toNode: string, toPort: string): CanvasEdge =>
  ({ id: edgeId({ nodeId: fromNode, portId: fromPort }, { nodeId: toNode, portId: toPort }), fromNode, fromPort, toNode, toPort, dataType: 'text' });
/** A node an agent made over MCP: no runtime or model chosen (a person picks them), no Agent bound yet. */
export const agentNode = (id: string, title: string, x: number, y: number, extra: Partial<SessionNode> = {}): SessionNode =>
  ({ ...createSessionNode('llm', { x, y }), id, title, persona: `${title}, as the agents wrote it`, ...extra });
/** What the server keeps of an agent's hand-in (canvas_change_write.go): its text, as `manual`, at the time it came. */
export const handIn = (text: string): NodeOutput => ({ text, source: 'manual', at: Date.parse('2026-11-07T13:50:00Z') });
export const nodeIn = (doc: CanvasDocument, id: string) => doc.nodes.find(node => node.id === id) as SessionNode;

export interface LiveCanvas {
  /** The surface as the host holds it: `document()` is what this page has, and so what it sends. */
  surface(): CanvasMultiplayerSurface;
  /** Another participant's change as the host passes it on: applied to the document and to every undo step. */
  othersChange(change: (doc: CanvasDocument) => CanvasDocument): void;
}

export function openLiveCanvas(doc: CanvasDocument): LiveCanvas {
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
  let surface: CanvasMultiplayerSurface | null = null;
  const host: CanvasMultiplayerHost = { connect: next => { surface = next; }, presence: () => undefined };
  render(<CanvasSurface storageMode="cloud" multiplayer={host} runtimeReadJson={async () => ({ agents: [], models: [] })} />);
  return {
    surface: () => surface!,
    othersChange: change => act(() => surface!.rebase({ working: change, history: change })),
  };
}

export function setUpLiveCanvas() {
  localStorage.clear(); resetAllSessions(); configureCanvasStorage('user', tenant.id, 'canvas-mp');
  configureSaaSCanvas({ tenant, canvasId: 'canvas-mp' });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request) => {
    const url = String(input);
    if (url.endsWith('/runtime')) return json(status);
    if (url.endsWith('/capabilities')) return json(capabilities);
    return json({ items: [] });
  }));
}

export function tearDownLiveCanvas() {
  cleanup(); clearSaaSCanvas(); resetAllSessions(); vi.unstubAllGlobals(); vi.restoreAllMocks();
}
