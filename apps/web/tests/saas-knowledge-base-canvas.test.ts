import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SessionNode } from '../src/canvas/canvasDoc';
import type { ContractField } from '../src/canvas/nodeContracts';
import { createOfficialDocument, type RecordedCanvasNode } from '../src/saas/examples/officialWorkflows';
import { canonicalCanvasText } from '../src/saas/productionCanvasText';
import record from '../src/saas/production-runs/knowledge-base';
import { KNOWLEDGE_BASE_WORKFLOW, RECORDED_CASE_WORKFLOWS } from '../src/saas/recordedCanvases';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import { PRODUCTION_CASES } from '../src/saas/productionCatalog';

// The run's own evidence: the outputs every agent delivered, and what each node's message (the
// description of its canvas issue) was — its length, its SHA-256 and every wire it carried.
const EVIDENCE = resolve(process.cwd(), '../../docs/superpowers/evidence/2026-09-04-awwo');
const run = JSON.parse(readFileSync(resolve(EVIDENCE, 'codex-live-run.json'), 'utf8')) as { runs: Array<{ name: string; output: Record<string, string> }> };
const inputs = JSON.parse(readFileSync(resolve(EVIDENCE, 'codex-live-inputs.json'), 'utf8')) as {
  runs: Array<{ name: string; messageChars: number; outputFields: string[]; upstreamInputs: number }>;
  propagation: Array<{ targetName: string; inputLabel: string; inputType: string; sourceName: string; sourceField: string; messageSha256: string }>;
};
const canvas = KNOWLEDGE_BASE_WORKFLOW.canvas!;
const byTitle = new Map(canvas.nodes.map(node => [node.title, node]));
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The message a 2026-09-04 canvas node received, composed as that day's runGraph.buildNodeMessage did. */
function message(node: RecordedCanvasNode, upstream: ReadonlyMap<string, { fromTitle: string; output: string }>) {
  const parts = [`【工作流节点】${node.title}`];
  const fields: ContractField[] = node.inputs.map(field => upstream.has(field.id) ? { ...field, value: upstream.get(field.id)!.output } : field);
  for (const field of fields) {
    const wired = upstream.get(field.id), help = field.help?.trim();
    parts.push(`【输入 · ${field.label || field.id} (${field.type})${wired ? ` · 来自「${wired.fromTitle}」` : ' · 本地填写'}】${help ? `\n字段说明：${help}` : ''}\n${field.value || '（未填写）'}`);
  }
  const schema = node.outputs.map(field => {
    const help = field.help?.trim(), structure = field.placeholder?.trim();
    return `- ${JSON.stringify(field.id)}: ${field.type}，${field.required ? '必填' : '可选'}（${field.label || field.id}）`
      + (help ? `\n  字段说明：${help}` : '') + (structure && structure !== help ? `\n  结构参考（不代表已有产出）：${structure}` : '');
  }).join('\n');
  const singleText = node.outputs.length === 1 && (node.outputs[0].type === 'text' || node.outputs[0].type === 'markdown');
  parts.push(`【输出格式】\n${schema}\n${singleText ? '可直接返回该字段的文本，或返回以字段 ID 为键的 JSON 对象。' : '最终输出必须是以字段 ID 为键的 JSON 对象；number 使用 JSON 数字，boolean 使用 JSON 布尔值，其余字段使用字符串。'}文件字段仅填写文件引用，不表示文件已上传。`);
  parts.push(fields.length ? '请基于以上输入完成本节点的职责，并按声明的格式给出最终输出。' : '本节点没有输入，请按本节点职责完成任务，并按声明的格式给出最终输出。');
  return parts.join('\n\n');
}

it('is the canvas that ran: every node composes, from the agents’ own outputs, a message of the recorded length, and the six with wired inputs the very message the run hashed', () => {
  expect(canvas.nodes).toHaveLength(7);
  for (const node of canvas.nodes) {
    const upstream = new Map(canvas.wires.filter(wire => wire.to === node.id).map(wire => {
      const source = canvas.nodes.find(value => value.id === wire.from)!;
      return [wire.input, { fromTitle: source.title, output: run.runs.find(value => value.name === source.title)!.output[wire.output] }];
    }));
    const text = message(node, upstream);
    const recorded = new Set(inputs.propagation.filter(edge => edge.targetName === node.title).map(edge => edge.messageSha256));
    expect(text.length, node.id).toBe(inputs.runs.find(value => value.name === node.title)!.messageChars);
    // The first node has no wired input, so the run kept only its message's length; every other one is pinned byte for byte.
    if (node.id === 'product') expect(recorded.size).toBe(0);
    else expect([...recorded], node.id).toEqual([sha(text)]);
  }
});

it('wires exactly the twelve hand-overs the run recorded, output field to input field', () => {
  expect(canvas.wires).toHaveLength(inputs.propagation.length);
  for (const edge of inputs.propagation) {
    const target = byTitle.get(edge.targetName)!, source = byTitle.get(edge.sourceName)!;
    const field = target.inputs.find(value => value.label === edge.inputLabel)!;
    expect(field.type, `${edge.targetName}/${edge.inputLabel}`).toBe(edge.inputType);
    expect(canvas.wires.filter(wire => wire.to === target.id && wire.input === field.id)).toEqual([{ from: source.id, output: edge.sourceField, to: target.id, input: field.id }]);
  }
  for (const node of canvas.nodes) expect(node.outputs.map(field => field.id), node.id).toEqual(inputs.runs.find(value => value.name === node.title)!.outputFields);
});

it('names its nodes and wires the way the published record does, and keeps no machine paths or identifiers', () => {
  expect(RECORDED_CASE_WORKFLOWS).toEqual({ 'knowledge-base': KNOWLEDGE_BASE_WORKFLOW });
  expect(PRODUCTION_WORKFLOWS['knowledge-base']).toBeUndefined();
  expect(PRODUCTION_CASES.find(item => item.id === 'knowledge-base')!.stages.map(stage => stage.length))
    .toEqual([...new Set(KNOWLEDGE_BASE_WORKFLOW.nodes.map(node => node.column))].sort((a, b) => a - b).map(column =>KNOWLEDGE_BASE_WORKFLOW.nodes.filter(node => node.column === column).length));
  expect(record.nodes.map(node => [node.id, node.title, node.column, node.row])).toEqual(KNOWLEDGE_BASE_WORKFLOW.nodes.map(node => [node.id, node.title, node.column, node.row]));
  expect(record.edges).toEqual(KNOWLEDGE_BASE_WORKFLOW.edges);
  for (const node of record.nodes) expect(node.fields!.map(field => field.id), node.id).toEqual(canvas.nodes.find(value => value.id === node.id)!.outputs.map(field => field.id));
  // Every string as it is, not JSON-escaped, so a backslash path is caught too.
  const strings: string[] = [];
  const walk = (value: unknown): void => { if (typeof value === 'string') strings.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(walk); };
  walk(canvas);
  expect(strings.length).toBeGreaterThan(300);
  for (const text of strings) {
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(text).not.toMatch(/(?<![A-Za-z0-9])[A-Za-z]:[\\/]/);
    expect(text).not.toMatch(/(?:^|[^A-Za-z0-9.])(?:\/Users\/|\/home\/|\/tmp\/|~\/|\\\\[A-Za-z])/);
  }
});

it('copies it word for word in the language it ran in, whatever the interface language', () => {
  const zh = createOfficialDocument(KNOWLEDGE_BASE_WORKFLOW, 'zh'), en = createOfficialDocument(KNOWLEDGE_BASE_WORKFLOW, 'en');
  expect(canonicalCanvasText(en)).toBe(canonicalCanvasText(zh));
  const nodes = zh.nodes as SessionNode[];
  nodes.forEach((node, index) => {
    const recorded = canvas.nodes[index];
    expect([node.title, node.persona], recorded.id).toEqual([recorded.title, recorded.persona]);
    expect(node.contract).toEqual({ version: 1, inputs: recorded.inputs, outputs: recorded.outputs });
    expect([node.model, node.runtime, node.binding, node.lastOutput]).toEqual(['', '', null, undefined]);
  });
  const at = new Map(nodes.map((node, index) => [node.id, canvas.nodes[index].id]));
  expect(zh.edges.map(edge => ({ from: at.get(edge.fromNode), output: edge.fromPort.slice('out:'.length), to: at.get(edge.toNode), input: edge.toPort.slice('in:'.length) }))).toEqual(canvas.wires);
  // One source per input, and every port is a declared field: the SaaS runner accepts it as it is.
  expect(new Set(zh.edges.map(edge => `${edge.toNode}/${edge.toPort}`)).size).toBe(zh.edges.length);
  for (const edge of zh.edges) {
    expect(nodes.find(node => node.id === edge.fromNode)!.contract!.outputs.some(field => `out:${field.id}` === edge.fromPort)).toBe(true);
    expect(nodes.find(node => node.id === edge.toNode)!.contract!.inputs.some(field => `in:${field.id}` === edge.toPort)).toBe(true);
  }
});
