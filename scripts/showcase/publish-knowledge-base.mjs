// Publishes the 2026-09-04 knowledge-base run (docs/superpowers/evidence/2026-09-04-awwo/codex-live-run.json)
// as the homepage record apps/web/src/saas/production-runs/knowledge-base.ts. Outputs stay verbatim except
// for redaction: local workspace paths keep only their artifacts/<file> tail and identifiers (UUIDs) become
// "…", because a public record carries no private run, agent or comment identifiers.
//   node scripts/showcase/publish-knowledge-base.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redact, writeRecord, writeSummary } from './publish-common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/superpowers/evidence/2026-09-04-awwo/codex-live-run.json'), 'utf8'));
const l = (zh, en) => ({ zh, en });
// The canvas as it ran — seven nodes in five stages, twelve wires — is the one a member copies
// (apps/web/src/saas/recordedCanvases.ts); the record names its nodes and wires the same way.
const { build } = await import(pathToFileURL(path.join(ROOT, 'apps/web/node_modules/rolldown/dist/index.mjs')).href);
const bundle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awwo-publish-')), 'publish-helpers.mjs');
await build({ input: path.join(ROOT, 'scripts/showcase/publish-helpers.ts'), platform: 'node', output: { file: bundle, format: 'esm' }, logLevel: 'warn' });
const { RECORDED_CASE_WORKFLOWS } = await import(pathToFileURL(bundle).href);
fs.rmSync(path.dirname(bundle), { recursive: true, force: true });
const workflow = RECORDED_CASE_WORKFLOWS['knowledge-base'];

const byTitle = new Map(run.runs.map(item => [item.name, item]));
const seconds = (start, end) => Math.round((Date.parse(end) - Date.parse(start)) / 1000);
const nodes = workflow.nodes.map(({ id, title, column, row }) => {
  const item = byTitle.get(title.zh);
  if (!item) throw new Error(`No recorded run for ${title.zh}`);
  if (item.status !== 'succeeded') throw new Error(`${title.zh} did not succeed`);
  return { id, title, column, row, status: 'done', seconds: seconds(item.startedAt, item.finishedAt), outputType: 'fields',
    fields: Object.entries(item.output).map(([field, value]) => ({ id: field, value: redact(value) })) };
});
const EDGES = workflow.edges;
const starts = run.runs.map(item => Date.parse(item.startedAt)), ends = run.runs.map(item => Date.parse(item.finishedAt));
const record = {
  caseId: 'knowledge-base',
  // It ran in AwwO's local development preview (localhost) against a local control plane, not in a desktop build.
  edition: l('AwwO 本地开发预览 · Codex 本地执行器（每个节点是一个可读写本地工作目录的 Codex 会话）', 'AwwO local development preview · Codex local runtime (each node is a Codex session with its own local working directory)'),
  runtime: 'codex_local', model: 'Codex', capturedOn: '2026-09-04',
  seconds: Math.round((Math.max(...ends) - Math.min(...starts)) / 1000), completed: nodes.length, total: nodes.length, outputLocale: 'zh',
  artifactNodeId: 'frontend', nodes, edges: EDGES,
  note: l('7 个节点全部完成。交付验收如实写了“部分通过，整体验收未通过”：它退回了两处演示缺陷（Straße 搜不到 STRASSE；标签恢复后旧的失败质检仍计入阻断），前端修复后复验通过。路径中的本机目录与内部 ID 已隐去，其余为节点原文。',
    'All 7 nodes completed. The delivery review recorded “partly passed, overall not accepted”: it sent back two demo defects (Straße not matching STRASSE; an old failed quality check still blocking after a tag was restored), and they passed re-verification after the front end fixed them. Local directories and internal IDs in paths are hidden; everything else is the nodes’ own text.'),
  verification: l('封面是交付的知识库工作台在演示模式（模拟数据）下的录屏。2026-09-05 的复验：模型与 Unicode 回归 31/31、应用 DOM 4/4、焦点回归 8/8 通过，两处被退回的缺陷复验通过；真实账号、后端服务与生产环境不在验收范围内。',
    'The cover is a recording of the delivered knowledge-base workspace in its demo mode with simulated data. Re-acceptance on 2026-09-05: model and Unicode regressions 31/31, app DOM 4/4 and focus regressions 8/8 passed, and both defects sent back passed re-verification; real accounts, backend services and production were outside its scope.'),
};
const RUNS = path.join(ROOT, 'apps/web/src/saas/production-runs');
writeRecord(path.join(RUNS, 'knowledge-base.ts'), record);
writeSummary(path.join(RUNS, 'summary.json'), record, true);
