import type { CanvasEdge, CanvasNode, SessionNode } from './canvasDoc';
import { mediaKindOf } from './mediaCatalog';
import { validateContractFields } from './nodeContracts';
import { reconcileEdges } from './ports';
import type { RunNodeStatus } from './runGraph';

/** One thing the assistant offers to do next. Each names exactly what it acts on, so the host can carry it out. */
export type NextStep =
  | { kind: 'upgrade' }
  | { kind: 'switch-model'; nodeId: string }
  | { kind: 'open-failed'; nodeId: string }
  | { kind: 'rerun-failed'; nodeIds: string[] }
  | { kind: 'fill-inputs'; nodeId: string }
  | { kind: 'run-all' }
  | { kind: 'run-rest'; nodeIds: string[] }
  | { kind: 'results' };

/** Why those steps, in one line the host words. */
export type NextSituation =
  | { kind: 'premium'; nodeTitle: string }
  | { kind: 'failed'; nodeTitle: string; count: number }
  | { kind: 'inputs'; nodeTitle: string; fields: string[] }
  | { kind: 'fresh' }
  | { kind: 'partial'; count: number }
  | { kind: 'complete' };

export interface NextSteps { situation: NextSituation; steps: NextStep[] }

export interface NextStepsInput {
  nodes: ReadonlyArray<CanvasNode>;
  edges: ReadonlyArray<CanvasEdge>;
  /** The latest run's state per node. */
  runs: Readonly<Record<string, RunNodeStatus | undefined>>;
  running: boolean;
  /** The canvas can run now: not read-only and the host's execution is available. */
  canRun: boolean;
  /** The host has a results view to open. */
  resultsAvailable: boolean;
  /** The host can offer the paid plans (a hosted workspace). */
  upgradeAvailable: boolean;
  /** Whether a failure's detail is a refusal by the free premium allowance (the host knows its wording). */
  isPremiumRefusal: (detail: string) => boolean;
}

const MAX_STEPS = 3;

/** Text Agents a canvas run executes; image and video nodes run on their own, so they are never "left to run". */
function agentNodes(nodes: ReadonlyArray<CanvasNode>): SessionNode[] {
  return nodes.filter((node): node is SessionNode => node.kind === 'session' && !mediaKindOf(node.agentKind));
}

const delivered = (node: SessionNode) => Boolean(node.lastOutput && !node.lastOutput.partial);

/** The first Agent whose own required inputs are empty: a wired input is checked once its value arrives, as the
 * run's preflight does, so only fields the reader has to fill in count. */
function missingInputs(agents: ReadonlyArray<SessionNode>, nodes: ReadonlyArray<CanvasNode>, edges: ReadonlyArray<CanvasEdge>) {
  const wired = reconcileEdges(nodes, edges.filter(edge => edge.kind !== 'feedback'));
  for (const node of agents) {
    if (!node.contract) continue;
    const fields = node.contract.inputs
      .filter(field => !wired.some(edge => edge.toNode === node.id && edge.toPort === `in:${field.id}`))
      .filter(field => validateContractFields([field]).length > 0)
      .map(field => field.label || field.id);
    if (fields.length) return { node, fields };
  }
  return null;
}

/** What to do next with this canvas, worked out from the canvas alone, so the assistant can offer it unasked. The most
 * urgent situation wins: a failure, then inputs a run would refuse, then what has not run yet, then the results.
 * Nothing is offered while a run is going, or when no step could act. */
export function nextSteps(input: NextStepsInput): NextSteps | null {
  const { nodes, edges, runs, running, canRun, resultsAvailable, upgradeAvailable, isPremiumRefusal } = input;
  if (running) return null;
  const agents = agentNodes(nodes);
  if (!agents.length) return null;
  const offer = (situation: NextSituation, steps: NextStep[]): NextSteps | null => steps.length ? { situation, steps: steps.slice(0, MAX_STEPS) } : null;

  const failed = agents.filter(node => runs[node.id]?.state === 'failed');
  if (failed.length) {
    const first = failed[0];
    const rerun: NextStep[] = canRun ? [{ kind: 'rerun-failed', nodeIds: failed.map(node => node.id) }] : [];
    if (isPremiumRefusal(runs[first.id]?.detail ?? '')) {
      return offer({ kind: 'premium', nodeTitle: first.title },
        [...(upgradeAvailable ? [{ kind: 'upgrade' as const }] : []), { kind: 'switch-model', nodeId: first.id }, ...rerun]);
    }
    return offer({ kind: 'failed', nodeTitle: first.title, count: failed.length }, [{ kind: 'open-failed', nodeId: first.id }, ...rerun]);
  }

  const missing = missingInputs(agents, nodes, edges);
  if (missing) return offer({ kind: 'inputs', nodeTitle: missing.node.title, fields: missing.fields }, [{ kind: 'fill-inputs', nodeId: missing.node.id }]);

  const pending = agents.filter(node => !delivered(node));
  if (pending.length === agents.length) return offer({ kind: 'fresh' }, canRun ? [{ kind: 'run-all' }] : []);
  if (pending.length) {
    return offer({ kind: 'partial', count: pending.length },
      [...(canRun ? [{ kind: 'run-rest' as const, nodeIds: pending.map(node => node.id) }] : []), ...(resultsAvailable ? [{ kind: 'results' as const }] : [])]);
  }
  return offer({ kind: 'complete' }, resultsAvailable ? [{ kind: 'results' }] : []);
}
