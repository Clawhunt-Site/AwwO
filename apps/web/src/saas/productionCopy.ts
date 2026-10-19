import type { AssembleNode, CanvasDocument, CanvasNode, SessionNode } from '../canvas/canvasDoc';
import { parseContractOutput } from '../canvas/nodeContracts';
import { validateNodeOutput } from '../canvas/runGraph';
import { createOfficialCopyDocument, type OfficialCopyModel } from './examples/OfficialCopySetup';
import type { OfficialWorkflow } from './examples/officialWorkflows';
import type { ProductionRunNode, ProductionRunRecord } from './productionRuns';

/** A single text field is its own source; text that happens to be JSON naming the field is wrapped,
 * so what a downstream node reads is exactly what the case delivered. A node with two fields (a flagship's
 * tester: its page and its report) delivers both as one object, the record's output as `result` and its report
 * as `report`. */
function recordedText(node: SessionNode | AssembleNode, recorded: ProductionRunNode): string | null {
  const outputs = node.contract?.outputs ?? [];
  const output = recorded.output;
  if (!node.contract || !outputs.length || !output?.trim()) return null;
  const values = new Map<string, string>(outputs.length === 1 ? [[outputs[0].id, output]]
    : [['result', output], ...(recorded.report === undefined ? [] : [['report', recorded.report] as [string, string]])]);
  if (values.size !== outputs.length || outputs.some(field => !values.has(field.id))) return null;
  const keeps = (text: string) => {
    if (validateNodeOutput(node, text).length) return false;
    const parsed = parseContractOutput(node.contract!, text).values;
    return outputs.every(field => field.type === 'html' ? Boolean(parsed[field.id]?.trim()) : parsed[field.id] === values.get(field.id));
  };
  const object = JSON.stringify(Object.fromEntries(values));
  return (outputs.length === 1 ? [output, object] : [object]).find(keeps) ?? null;
}

/**
 * The case's canvas, as `createOfficialCopyDocument` mints it, with every node that delivered in the
 * case's recorded run carrying that delivery as its output: a member sees what each agent was asked,
 * what it received and what it handed over. Each output is marked `source: 'case'` with the run's
 * date and model, never as this workspace's run; running the graph replaces it.
 */
export function createProductionCopyDocument(workflow: OfficialWorkflow, record: ProductionRunRecord, model: OfficialCopyModel | null): CanvasDocument {
  // The record must be the run of this very canvas: the same agents and the same wires.
  const ids = (values: ReadonlyArray<{ id: string }>) => values.map(value => value.id).sort().join('\n');
  const wires = (values: ReadonlyArray<{ from: string; to: string }>) => values.map(value => `${value.from}>${value.to}`).sort().join('\n');
  if (record.caseId !== workflow.id || ids(record.nodes) !== ids(workflow.nodes) || wires(record.edges) !== wires(workflow.edges))
    throw new Error(`The run record of ${record.caseId} does not match the canvas of ${workflow.id}.`);
  const document = createOfficialCopyDocument(workflow, model);
  const at = Date.parse(`${record.capturedOn}T00:00:00Z`);
  // A media case's image and video nodes follow the agents and generate afresh in the copy; a page they feed names the
  // case run's own files, which the copy does not have, so its delivery is not pinned either: it is made on the first run.
  // So is a page that names them through a module it pastes (a 3D model's GLB, loaded by its path in the module's code).
  const fed = new Set((workflow.media ?? []).flatMap(item => item.feeds ?? []));
  const files = (record.media ?? []).flatMap(item => item.files);
  // createOfficialDocument mints one node per workflow node, in the workflow's order, then the media nodes.
  const nodes = document.nodes.map((node, index): CanvasNode => {
    const spec = workflow.nodes[index];
    if (!spec || fed.has(spec.id)) return node;
    const recorded = record.nodes.find(value => value.id === spec.id);
    // A case canvas has no edit node (createOfficialCopyDocument mints sessions and assemble nodes).
    if (node.kind === 'form' || node.kind === 'edit' || recorded?.status !== 'done') return node;
    if (spec.outputType === 'html' && files.some(file => recorded.output?.includes(file))) return node;
    // An assemble node that also delivers a file is made afresh on the copy's first run: the file it delivered is
    // stored in the case's workspace, and the copy's run makes it again in a moment, without a model.
    if (node.kind === 'assemble' && node.contract.outputs.some(field => field.type === 'file')) return node;
    // So is an agent that hands a file on (a flagship team's turn: the team's project as one file): its file is stored in
    // the case's workspace too, and the turn after it needs that file, so the copy's first run makes both again.
    if (node.kind !== 'assemble' && node.contract?.outputs.some(field => field.type === 'file')) return node;
    const text = recorded.output?.trim() ? recordedText(node, recorded) : null;
    // The copy dialog counts every delivered node as carried, so a delivery the canvas cannot hold stops the copy.
    if (text === null) throw new Error(`The run record of ${record.caseId} has a delivery of ${recorded.id} its canvas cannot hold.`);
    // An assemble node ran no model: its recording carries none.
    if (node.kind === 'assemble') return { ...node, lastOutput: { text, at, source: 'case' } };
    // Opened, the node shows its delivery beside the (still empty) conversation.
    return { ...node, lastOutput: { text, at, source: 'case', model: record.model }, deliverablesOpen: true };
  });
  return { ...document, nodes };
}
