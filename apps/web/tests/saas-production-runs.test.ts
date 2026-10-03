import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PRODUCTION_RUN_SUMMARY, formatDuration, type ProductionRunRecord } from '../src/saas/productionRuns';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import { canonicalCanvasText } from '../src/saas/productionCanvasText';
import { createOfficialDocument } from '../src/saas/examples/officialWorkflows';
import { PRODUCTION_CASES } from '../src/saas/productionCatalog';
import { isCompleteHtmlDocument } from '../src/canvas/htmlDeliverable';

const RECORDS = Object.values(import.meta.glob<ProductionRunRecord>('../src/saas/production-runs/*.ts', { eager: true, import: 'default' }));
const byCase = new Map(RECORDS.map(record => [record.caseId, record]));

it('publishes a record for real cases only, and summarises each one exactly', () => {
  const ids = new Set(PRODUCTION_CASES.map(item => item.id));
  for (const record of RECORDS) expect(ids.has(record.caseId), record.caseId).toBe(true);
  expect(Object.keys(PRODUCTION_RUN_SUMMARY).sort()).toEqual([...byCase.keys()].sort());
  expect(byCase.has('knowledge-base')).toBe(true);
  for (const record of RECORDS) {
    const delivery = record.nodes.find(node => node.id === record.artifactNodeId);
    expect(PRODUCTION_RUN_SUMMARY[record.caseId], record.caseId).toEqual({ completed: record.completed, total: record.total, seconds: record.seconds,
      delivered: record.caseId === 'knowledge-base' ? true : delivery?.status === 'done' && delivery.outputType === 'html' && Boolean(delivery.output),
      capturedOn: record.capturedOn, model: record.model, runtime: record.runtime });
  }
});

it('has published a run for every case before the homepage says so', () => {
  expect(Object.keys(PRODUCTION_RUN_SUMMARY).sort()).toEqual(PRODUCTION_CASES.map(item => item.id).sort());
});

it('keeps every record internally consistent: counts, statuses, outputs and the result checksum', () => {
  for (const record of RECORDS) {
    expect(record.total, record.caseId).toBe(record.nodes.length);
    expect(record.completed, record.caseId).toBe(record.nodes.filter(node => node.status === 'done').length);
    expect(record.capturedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(record.seconds).toBeGreaterThan(0);
    for (const text of [record.edition, record.note, record.verification]) { expect(text.zh.trim()).not.toBe(''); expect(text.en.trim()).not.toBe(''); }
    for (const node of record.nodes) {
      if (node.status === 'done') {
        if (node.outputType === 'fields') expect(node.fields?.length, `${record.caseId}/${node.id}`).toBeGreaterThan(0);
        else expect(node.output?.trim(), `${record.caseId}/${node.id}`).toBeTruthy();
        if (node.outputType === 'html') expect(isCompleteHtmlDocument(node.output!), `${record.caseId}/${node.id}`).toBe(true);
      } else expect(node.output, `${record.caseId}/${node.id}`).toBeUndefined();
    }
    const ids = new Set(record.nodes.map(node => node.id));
    for (const edge of record.edges) expect(ids.has(edge.from) && ids.has(edge.to), `${record.caseId}: ${edge.from}->${edge.to}`).toBe(true);
    const artifact = record.nodes.find(node => node.id === record.artifactNodeId);
    if (record.artifactSHA256) expect(createHash('sha256').update(artifact!.output!).digest('hex'), record.caseId).toBe(record.artifactSHA256);
  }
});

it('records each SaaS case run on the very canvas a member can copy today', () => {
  for (const record of RECORDS.filter(value => value.caseId !== 'knowledge-base')) {
    const workflow = PRODUCTION_WORKFLOWS[record.caseId];
    expect(workflow, record.caseId).toBeDefined();
    expect(record.nodes.map(node => [node.id, node.title, node.column, node.row, node.outputType])).toEqual(
      workflow.nodes.map(node => [node.id, node.title, node.column, node.row, node.outputType ?? 'markdown']));
    expect(record.edges).toEqual(workflow.edges);
    // Every task, persona, brief, contract and wire the run used is the copyable canvas today, word for word.
    expect(createHash('sha256').update(canonicalCanvasText(createOfficialDocument(workflow, record.outputLocale))).digest('hex'), record.caseId).toBe(record.canvasSHA256);
    expect(record.artifactNodeId === undefined || record.artifactNodeId === workflow.nodes.find(node => node.outputType === 'html')!.id).toBe(true);
    // The default execution settings, as on production when it ran.
    expect(record.limits).toEqual({ contextWindow: 32768, maxOutputTokens: 4096, modelCallsPerNode: 1, concurrency: 2, thinking: false });
    expect(record.source?.api).toMatch(/^[0-9a-f]{8,40}$/);
    expect(record.source?.worker).toMatch(/^[0-9a-f]{8,40}$/);
    expect(record.runtime).toBe('openai-agents');
  }
});

it('changes the canvas digest when any task or wire changes, but not with the fresh node IDs of a copy', () => {
  const workflow = PRODUCTION_WORKFLOWS['party-game'];
  const document = createOfficialDocument(workflow, 'zh');
  const text = canonicalCanvasText(document);
  expect(canonicalCanvasText(createOfficialDocument(workflow, 'zh'))).toBe(text);
  expect(canonicalCanvasText({ ...document, edges: document.edges.slice(1) })).not.toBe(text);
  expect(canonicalCanvasText({ ...document, edges: document.edges.map((edge, index) => index ? edge : { ...edge, toPort: 'in:brief' }) })).not.toBe(text);
  expect(canonicalCanvasText({ ...document, nodes: document.nodes.map((node, index) => index ? node : { ...node, persona: `${(node as { persona?: string }).persona} ` }) })).not.toBe(text);
});

it('carries no private identifiers or machine paths into a public record', () => {
  for (const record of RECORDS) {
    const text = JSON.stringify(record);
    expect(text, record.caseId).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(text, record.caseId).not.toMatch(/(?<![A-Za-z0-9])[A-Za-z]:[\\/](?![\\/])/);
    expect(text, record.caseId).not.toMatch(/\bcv-[a-z0-9]{8}-/);              // canvas node identifiers
    expect(text, record.caseId).not.toMatch(/"(?:tenantId|canvasId|sessionId|runId|operationId)"/);
  }
});

it('formats run times the way the case pages say them', () => {
  expect(formatDuration(2664, 'zh')).toBe('44 分 24 秒');
  expect(formatDuration(2664, 'en')).toBe('44 min 24 s');
  expect(formatDuration(120, 'zh')).toBe('2 分钟');
  expect(formatDuration(120, 'en')).toBe('2 min');
  expect(formatDuration(41.4, 'zh')).toBe('41 秒');
  expect(formatDuration(-3, 'en')).toBe('0 s');
});
