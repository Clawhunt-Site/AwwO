import type { CanvasDocument, CanvasNode, SessionNode } from '../canvas/canvasDoc';
import { parseContractOutput } from '../canvas/nodeContracts';
import { validateNodeOutput } from '../canvas/runGraph';
import type { UiLocale } from '../locale';
import { createOfficialCopyDocument, type OfficialCopyModel } from './examples/OfficialCopySetup';
import type { OfficialWorkflow } from './examples/officialWorkflows';
import type { ProductionRunRecord } from './productionRuns';

/** A single text field is its own source; text that happens to be JSON naming the field is wrapped,
 * so what a downstream node reads is exactly what the case delivered. */
function recordedText(node: SessionNode, output: string): string | null {
  const field = node.contract?.outputs.length === 1 ? node.contract.outputs[0] : undefined;
  if (!node.contract || !field) return null;
  const keeps = (text: string) => {
    if (validateNodeOutput(node, text).length) return false;
    const value = parseContractOutput(node.contract!, text).values[field.id];
    return field.type === 'html' ? Boolean(value?.trim()) : value === output;
  };
  return [output, JSON.stringify({ [field.id]: output })].find(keeps) ?? null;
}

/** Several named fields become the keyed JSON object the contract parses, in the contract's order;
 * a field the contract does not declare, or a value that would not come back unchanged, pins nothing.
 * An optional file left empty is no file, as the contract parser and the server read it. */
function recordedFields(node: SessionNode, fields: ReadonlyArray<{ readonly id: string; readonly value: string }>): string | null {
  const contract = node.contract;
  if (!contract || !fields.length || fields.some(field => !contract.outputs.some(output => output.id === field.id))) return null;
  const text = JSON.stringify(Object.fromEntries(contract.outputs.flatMap(output => fields.filter(field => field.id === output.id).map(field => [field.id, field.value]))));
  if (validateNodeOutput(node, text).length) return null;
  const values = parseContractOutput(contract, text).values;
  const absent = (id: string) => contract.outputs.some(output => output.id === id && output.type === 'file' && !output.required);
  return fields.every(field => values[field.id] === field.value || (field.value === '' && absent(field.id) && !(field.id in values))) ? text : null;
}

/**
 * The case's canvas, as `createOfficialCopyDocument` mints it, with every node that delivered in the
 * case's recorded run carrying that delivery as its output: a member sees what each agent was asked,
 * what it received and what it handed over. Each output is marked `source: 'case'` with the run's
 * date and model, never as this workspace's run; running the graph replaces it.
 */
export function createProductionCopyDocument(workflow: OfficialWorkflow, record: ProductionRunRecord, locale: UiLocale, model: OfficialCopyModel | null): CanvasDocument {
  // The record must be the run of this very canvas: the same agents and the same wires.
  const ids = (values: ReadonlyArray<{ id: string }>) => values.map(value => value.id).sort().join('\n');
  const wires = (values: ReadonlyArray<{ from: string; to: string }>) => values.map(value => `${value.from}>${value.to}`).sort().join('\n');
  if (record.caseId !== workflow.id || ids(record.nodes) !== ids(workflow.nodes) || wires(record.edges) !== wires(workflow.edges))
    throw new Error(`The run record of ${record.caseId} does not match the canvas of ${workflow.id}.`);
  const document = createOfficialCopyDocument(workflow, locale, model);
  const at = Date.parse(`${record.capturedOn}T00:00:00Z`);
  // createOfficialDocument mints one node per workflow node, in the workflow's order.
  const nodes = document.nodes.map((node, index): CanvasNode => {
    const recorded = record.nodes.find(value => value.id === workflow.nodes[index].id);
    if (node.kind !== 'session' || recorded?.status !== 'done') return node;
    const text = recorded.outputType === 'fields' ? recordedFields(node, recorded.fields ?? [])
      : recorded.output?.trim() ? recordedText(node, recorded.output) : null;
    // The copy dialog counts every delivered node as carried, so a delivery the canvas cannot hold stops the copy.
    if (text === null) throw new Error(`The run record of ${record.caseId} has a delivery of ${recorded.id} its canvas cannot hold.`);
    // Opened, the node shows its delivery beside the (still empty) conversation.
    return { ...node, lastOutput: { text, at, source: 'case', model: record.model }, deliverablesOpen: true };
  });
  return { ...document, nodes };
}
