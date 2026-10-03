import { expect, it } from 'vitest';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import { PRODUCTION_CASES } from '../src/saas/productionCatalog';
import { createOfficialDocument } from '../src/saas/examples/officialWorkflows';
import type { SessionNode } from '../src/canvas/canvasDoc';

const WORKFLOWS = Object.values(PRODUCTION_WORKFLOWS);
const stagesOf = (id: string) => {
  const workflow = PRODUCTION_WORKFLOWS[id];
  return [...new Set(workflow.nodes.map(node => node.column))].sort((a, b) => a - b).map(column => workflow.nodes.filter(node => node.column === column).length);
};

it('gives every illustrated case a canvas and no canvas to anything else', () => {
  const illustrated = PRODUCTION_CASES.filter(item => !item.recording).map(item => item.id).sort();
  expect(Object.keys(PRODUCTION_WORKFLOWS).sort()).toEqual(illustrated);
  for (const item of WORKFLOWS) expect(PRODUCTION_WORKFLOWS[item.id]).toBe(item);
});

it('shows on each card exactly the team its canvas has, stage by stage', () => {
  for (const item of PRODUCTION_CASES.filter(value => !value.recording))
    expect(item.stages.map(stage => stage.length), item.id).toEqual(stagesOf(item.id));
});

it('is a valid DAG that runs left to right and compiles in both languages', () => {
  for (const item of WORKFLOWS) {
    const ids = item.nodes.map(node => node.id);
    expect(new Set(ids).size, item.id).toBe(ids.length);
    const column = new Map(item.nodes.map(node => [node.id, node.column]));
    const keys = item.edges.map(edge => `${edge.from}->${edge.to}`);
    expect(new Set(keys).size, item.id).toBe(keys.length);
    for (const edge of item.edges) {
      expect(column.has(edge.from) && column.has(edge.to), `${item.id}: ${edge.from}->${edge.to}`).toBe(true);
      // Every handoff goes to a later stage, so stages are the dependency order and there is no cycle.
      expect(column.get(edge.to)!, `${item.id}: ${edge.from}->${edge.to}`).toBeGreaterThan(column.get(edge.from)!);
    }
    // A column is a stage: each node past the first stage receives something from the stage right before it.
    for (const node of item.nodes.filter(value => value.column > 0))
      expect(item.edges.some(edge => edge.to === node.id && column.get(edge.from) === node.column - 1), `${item.id}/${node.id}`).toBe(true);
    for (const locale of ['zh', 'en'] as const) {
      const document = createOfficialDocument(item, locale);
      expect(document.nodes).toHaveLength(item.nodes.length);
      expect(document.edges).toHaveLength(item.edges.length);
      for (const node of document.nodes as SessionNode[]) {
        const inputs = node.contract!.inputs.map(field => field.id);
        expect(new Set(inputs).size).toBe(inputs.length);
        // One source per input port, as the server's DAG check requires.
        for (const input of inputs.filter(value => value !== 'brief'))
          expect(document.edges.filter(edge => edge.toNode === node.id && edge.toPort === `in:${input}`)).toHaveLength(1);
      }
    }
  }
});

it('ends every canvas in a review and delivers exactly one self-contained HTML build', () => {
  for (const item of WORKFLOWS) {
    const last = Math.max(...item.nodes.map(node => node.column));
    expect(item.nodes.filter(node => node.column === last).map(node => node.role), item.id).toEqual(['review']);
    const builds = item.nodes.filter(node => node.outputType === 'html');
    expect(builds, item.id).toHaveLength(1);
    // Sized for the default execution settings: one model call, at most 4,096 output tokens.
    expect(builds[0].task.zh).toContain('整页不超过 8000 个字符');
    expect(builds[0].task.en).toContain('at most 8,000 characters');
    expect(builds[0].task.zh).toMatch(/不使用 localStorage、cookie、网络请求/);
    expect(item.edges.some(edge => edge.from === builds[0].id && item.nodes.find(node => node.id === edge.to)?.role === 'review'), item.id).toBe(true);
  }
});

it('writes every text in both languages and claims no real brand, footage or production system', () => {
  for (const item of WORKFLOWS) {
    const texts = [item.title, item.summary, item.description, item.pattern, item.brief, item.limitations, ...item.artifacts,
      ...item.nodes.flatMap(node => [node.title, node.task, node.output, ...node.acceptance]), ...item.edges.map(edge => edge.label)];
    for (const text of texts) { expect(text.zh.trim(), item.id).not.toBe(''); expect(text.en.trim(), item.id).not.toBe(''); }
    expect(item.limitations.zh).toContain('最多输出 4096 token');
    expect(JSON.stringify(item)).not.toMatch(/paperclip/i);
  }
  const ad = PRODUCTION_WORKFLOWS['summer-ad'];
  expect(ad.brief.zh).toContain('不生成、也不冒称拍摄或生成了真实视频素材');
  expect(ad.limitations.zh).toContain('不是成片');
  expect(PRODUCTION_WORKFLOWS['3d-configurator'].brief.zh).toContain('虚构品牌 Orvia');
  expect(PRODUCTION_WORKFLOWS['port-twin'].brief.zh).toContain('模拟数据');
});

it('keeps every node’s fixed prompt well inside the 28 KB the default model leaves for input', () => {
  for (const item of WORKFLOWS) for (const node of createOfficialDocument(item, 'zh').nodes as SessionNode[]) {
    // Persona, brief and output policy are sent twice (system and user); upstream outputs add the rest.
    const fixed = new TextEncoder().encode(node.persona + node.contract!.inputs[0].value).byteLength;
    expect(fixed, `${item.id}/${node.title}`).toBeLessThan(5000);
  }
});
