// What a plan changed on the canvas, in the reader's words, worked out from the document before and after it: said
// under the assistant's reply, so a reader who only talks to the assistant sees which nodes it changed and how (owner
// request 2026-10-15: beginners stay in the assistant instead of opening every node in developer mode). The model's own
// summary says what it meant to do; these lines say what the canvas now holds.
import { nodeContract, type CanvasDocument, type CanvasEdge, type CanvasNode, type SessionNode } from './canvasDoc';
import type { CanvasTranslate } from './i18n';
import type { UiLocale } from '../locale';
import { mediaKindOf } from './mediaCatalog';
import { activeNodeThread } from './nodeThreads';
import { isTaskFrame } from './taskFrame';
import { effortLabel } from './NodeModelSettings';
import { nodeTeamFingerprint, nodeTeamTurnEstimate } from './nodeTeam';
import { nodeTeamModeLabel } from './NodeTeamEditor';

const MAX_NAMES = 4;
const MAX_LINES = 8;

const title = (node: CanvasNode) => node.title.trim() || node.id;

function names(locale: UiLocale, t: CanvasTranslate, nodes: ReadonlyArray<CanvasNode>): string {
  const shown = nodes.slice(0, MAX_NAMES).map(node => locale === 'zh' ? `「${title(node)}」` : `“${title(node)}”`).join(locale === 'zh' ? '、' : ', ');
  return nodes.length > MAX_NAMES ? t('planning.changeMoreNames', { names: shown, count: nodes.length - MAX_NAMES }) : shown;
}

/** A node without task requirements has none of either: a plan that only sets its acceptance criteria has not changed
 *  its constraints. A frame of a version this app cannot read compares as it is stored. */
function frameOf(node: SessionNode): { constraints: string; acceptance: string } {
  if (node.taskFrame === undefined || node.taskFrame === null) return { constraints: '[]', acceptance: '[]' };
  if (!isTaskFrame(node.taskFrame)) return { constraints: JSON.stringify(node.taskFrame), acceptance: '' };
  return { constraints: JSON.stringify(node.taskFrame.constraints), acceptance: JSON.stringify(node.taskFrame.acceptanceCriteria) };
}

function inputValues(node: CanvasNode): string {
  if (node.kind === 'form') return JSON.stringify(node.fields.map(field => [field.id, field.value]));
  return JSON.stringify(nodeContract(node)?.inputs.map(field => [field.id, field.value]) ?? []);
}

function fieldShape(node: SessionNode): string {
  const shape = (fields: ReadonlyArray<{ id: string; label: string; type: string; required: boolean }>) => fields.map(field => [field.id, field.label, field.type, field.required]);
  return JSON.stringify(node.contract ? [shape(node.contract.inputs), shape(node.contract.outputs)] : null);
}

const wire = (edge: CanvasEdge) => JSON.stringify([edge.fromNode, edge.fromPort, edge.toNode, edge.toPort]);

/** The lines saying what changed, at most MAX_LINES of them; none when the documents hold the same nodes and wires. */
export function describePlanChanges(before: CanvasDocument, after: CanvasDocument, locale: UiLocale, t: CanvasTranslate,
  modelName: (model: string) => string): string[] {
  const earlier = new Map(before.nodes.map(node => [node.id, node]));
  const later = new Map(after.nodes.map(node => [node.id, node]));
  const added = after.nodes.filter(node => !earlier.has(node.id));
  const removed = before.nodes.filter(node => !later.has(node.id));
  const lines: string[] = [];
  if (added.length) lines.push(t('planning.changeAdded', { count: added.length, names: names(locale, t, added) }));
  if (removed.length) lines.push(t('planning.changeRemoved', { names: names(locale, t, removed) }));
  const persona: CanvasNode[] = [], acceptance: CanvasNode[] = [], constraints: CanvasNode[] = [], inputs: CanvasNode[] = [], fields: CanvasNode[] = [], prompts: CanvasNode[] = [];
  const modelLines: string[] = [];
  for (const next of after.nodes) {
    const previous = earlier.get(next.id);
    if (!previous || previous.kind !== next.kind) continue;
    if (title(previous) !== title(next)) lines.push(t('planning.changeRenamed', { from: title(previous), to: title(next) }));
    if (inputValues(previous) !== inputValues(next)) inputs.push(next);
    if (previous.kind !== 'session' || next.kind !== 'session') continue;
    if (mediaKindOf(next.agentKind)) {
      if (activeNodeThread(previous).draft !== activeNodeThread(next).draft) prompts.push(next);
      continue;
    }
    if (previous.persona !== next.persona) persona.push(next);
    const [was, now] = [frameOf(previous), frameOf(next)];
    if (was.acceptance !== now.acceptance) acceptance.push(next);
    if (was.constraints !== now.constraints) constraints.push(next);
    if (fieldShape(previous) !== fieldShape(next)) fields.push(next);
    if (previous.model !== next.model || previous.effort !== next.effort) {
      modelLines.push(!next.model ? t('planning.changeModelDefault', { node: title(next) })
        : next.effort ? t('planning.changeModelEffort', { node: title(next), model: modelName(next.model), effort: effortLabel(t, next.effort) })
          : t('planning.changeModel', { node: title(next), model: modelName(next.model) }));
    }
  }
  if (persona.length) lines.push(t('planning.changePersona', { names: names(locale, t, persona) }));
  if (acceptance.length) lines.push(t('planning.changeAcceptance', { names: names(locale, t, acceptance) }));
  if (constraints.length) lines.push(t('planning.changeConstraints', { names: names(locale, t, constraints) }));
  if (fields.length) lines.push(t('planning.changeFields', { names: names(locale, t, fields) }));
  if (inputs.length) lines.push(t('planning.changeInputs', { names: names(locale, t, inputs) }));
  if (prompts.length) lines.push(t('planning.changePrompt', { names: names(locale, t, prompts) }));
  lines.push(...modelLines);
  // A team a plan gave a node, new or changed, with what one run of it costs: every member call is a model call.
  for (const next of after.nodes) {
    if (next.kind !== 'session' || !next.team) continue;
    const previous = earlier.get(next.id);
    if (previous?.kind === 'session' && nodeTeamFingerprint(previous.team) === nodeTeamFingerprint(next.team)) continue;
    lines.push(t('planning.changeTeam', { node: title(next), count: next.team.members.length, mode: nodeTeamModeLabel(next.team.mode, locale),
      calls: nodeTeamTurnEstimate(next.team) }));
  }
  const wiresBefore = new Set(before.edges.map(wire));
  const wiresAfter = new Set(after.edges.map(wire));
  const connected = after.edges.filter(edge => !wiresBefore.has(wire(edge))).length;
  // A wire that went with a removed node is said by the removal.
  const disconnected = before.edges.filter(edge => !wiresAfter.has(wire(edge)) && later.has(edge.fromNode) && later.has(edge.toNode)).length;
  if (connected) lines.push(t('planning.changeWiresAdded', { count: connected }));
  if (disconnected) lines.push(t('planning.changeWiresRemoved', { count: disconnected }));
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), t('planning.changeMoreLines', { count: lines.length - MAX_LINES + 1 })] : lines;
}
