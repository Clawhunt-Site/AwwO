import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PRODUCTION_RUN_SUMMARY, formatDuration, loadProductionMedia, type ProductionMediaFile, type ProductionRunRecord } from '../src/saas/productionRuns';
import { PRODUCTION_WORKFLOWS, PUBLISHED_EPICS, PUBLISHED_FLAGSHIPS } from '../src/saas/productionWorkflows';
import { canonicalCanvasText } from '../src/saas/productionCanvasText';
import { createOfficialDocument } from '../src/saas/examples/officialWorkflows';
import { PRODUCTION_CASES } from '../src/saas/productionCatalog';
import { isCompleteHtmlDocument } from '../src/canvas/htmlDeliverable';

const RECORDS = Object.values(import.meta.glob<ProductionRunRecord>('../src/saas/production-runs/*.ts', { eager: true, import: 'default' }));
const byCase = new Map(RECORDS.map(record => [record.caseId, record]));
const MEDIA = import.meta.glob<Readonly<Record<string, ProductionMediaFile>>>('../src/saas/production-runs/*.media.json', { eager: true, import: 'default' });
const WEB = path.resolve(__dirname, '..');

it('publishes exactly the generated files a media case’s page names as static files, and records its media nodes beside the agents', () => {
  for (const record of RECORDS) {
    const workflow = PRODUCTION_WORKFLOWS[record.caseId];
    const files = MEDIA[`../src/saas/production-runs/${record.caseId}.media.json`];
    if (!workflow?.media?.length) { expect(record.media, record.caseId).toBeUndefined(); expect(files, record.caseId).toBeUndefined(); continue; }
    expect(record.media?.map(item => [item.id, item.title, item.kind]), record.caseId).toEqual(workflow.media.map(item => [item.id, item.title, item.kind]));
    const page = record.nodes.find(node => node.id === record.artifactNodeId)?.output ?? '';
    // What the page names, and what the dialog shows beside the agents: a 3D model's preview picture, and the picture of an
    // image node the page does not name (PALLWARD's concepts).
    const strip = (item: NonNullable<ProductionRunRecord['media']>[number], file: string) =>
      (item.kind === 'model3d' && /\.(?:png|jpe?g|webp)$/i.test(file)) || (item.kind === 'image' && file === item.files[0] && !page.includes(file));
    const published = record.media!.flatMap(item => item.files.filter(file => page.includes(file) || strip(item, file)));
    expect(Object.keys(files ?? {}).sort(), record.caseId).toEqual(published.sort());
    const folder = path.join(WEB, 'showcase', 'media', record.caseId);
    for (const [reference, file] of Object.entries(files ?? {})) {
      const item = record.media!.find(value => value.files.includes(reference))!, kind = item.kind;
      const type = kind === 'video' ? 'video/mp4' : /\.glb$/i.test(reference) ? 'model/gltf-binary' : strip(item, reference) ? 'image/webp' : 'image/jpeg';
      expect(file.type, reference).toBe(type);
      // Served beside the case footage, named by its content.
      expect(file.src, reference).toBe(`/showcase/media/${record.caseId}/${file.sha256.slice(0, 16)}.${{ 'video/mp4': 'mp4', 'model/gltf-binary': 'glb', 'image/webp': 'webp', 'image/jpeg': 'jpg' }[type]}`);
      const bytes = readFileSync(path.join(WEB, ...file.src.split('/').filter(Boolean)));
      expect(bytes.length, reference).toBe(file.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), reference).toBe(file.sha256);
    }
    // Nothing else is in the case's folder.
    expect(readdirSync(folder).sort(), record.caseId).toEqual(Object.values(files ?? {}).map(file => path.basename(file.src)).sort());
    // The agents are the record's nodes; a media node is never one of them.
    expect(record.nodes.map(node => node.id).sort(), record.caseId).toEqual(workflow.nodes.map(node => node.id).sort());
  }
  // No folder is left for a case without media.
  for (const name of readdirSync(path.join(WEB, 'showcase', 'media'))) expect(MEDIA[`../src/saas/production-runs/${name}.media.json`], name).toBeDefined();
});

it('publishes each 3D model without its provider’s marks, keeping the bone and clip names its page looks up', () => {
  const marks = /tripo|x-?tasy|runninghub|bytedance|dreamina|jimeng|kuaishou|midjourney|pixverse|shengshu/i;
  let rigged = 0;
  for (const record of RECORDS) {
    const workflow = PRODUCTION_WORKFLOWS[record.caseId];
    for (const [reference, file] of Object.entries(MEDIA[`../src/saas/production-runs/${record.caseId}.media.json`] ?? {})) {
      if (file.type !== 'model/gltf-binary') continue;
      const bytes = readFileSync(path.join(WEB, ...file.src.split('/').filter(Boolean)));
      expect(bytes.toString('latin1', 0, 4), reference).toBe('glTF');
      const text = bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12));
      expect(text, `${record.caseId}/${reference}`).not.toMatch(marks);
      const gltf = JSON.parse(text) as { asset?: { generator?: string }; nodes?: { name?: string }[]; skins?: { joints: number[] }[]; animations?: { name?: string }[] };
      expect(gltf.asset?.generator, reference).toBe('AwwO');
      // A rigged model (its media node asks for a rig) keeps its joints' and clips' names: PALLWARD's page finds a biped's
      // 'Hip' or 'R_Hand' and plays 'idle' or 'slash' by name, and puts one file's clips on another's skeleton by bone
      // name. (Tripo names a biped's joints so; a quadruped's or hexapod's it names node_<n> and bone_<n> itself.)
      const spec = workflow.media?.find(item => item.id === reference.slice(0, reference.indexOf('/')));
      const rig = (spec?.params as { rig?: unknown } | undefined)?.rig;
      if (!rig || !gltf.skins?.length) continue;
      rigged += 1;
      const joints = new Set(gltf.skins.flatMap(skin => skin.joints.map(index => gltf.nodes?.[index]?.name ?? '')));
      expect(joints.has(''), reference).toBe(false);
      if (rig === 'biped') for (const bone of ['Hip', 'Spine02', 'Head', 'R_Hand', 'L_Hand', 'R_Index1', 'R_Pinky1', 'L_Forearm'])
        expect(joints.has(bone), `${reference}: ${bone}`).toBe(true);
      expect(gltf.animations?.length, reference).toBeGreaterThan(0);
      expect(gltf.animations!.some(clip => !clip.name || /^animation_\d+$/.test(clip.name)), reference).toBe(false);
    }
  }
  expect(rigged).toBeGreaterThanOrEqual(PUBLISHED_EPICS.length);
});

it('loads a media case’s files as data: URLs from the site, all or none: a file it cannot fetch, a short one or a stalled one fails the load', async () => {
  const record = RECORDS.find(value => value.media?.length)!;
  const manifest = MEDIA[`../src/saas/production-runs/${record.caseId}.media.json`];
  const [first, second] = Object.entries(manifest);
  const serve = (broken?: { src: string; as: 'missing' | 'short' | 'stalled' }) => {
    const seen: string[] = [];
    const fetchFile = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const src = String(input);
      seen.push(src);
      expect(init?.credentials).toBe('omit');
      if (src === broken?.src && broken.as === 'missing') return new Response('missing', { status: 404 });
      if (src === broken?.src && broken.as === 'stalled') return new Promise<Response>(() => {});
      const bytes = readFileSync(path.join(WEB, ...src.split('/').filter(Boolean)));
      return new Response(src === broken?.src ? bytes.subarray(1) : bytes, { status: 200 });
    }) as typeof fetch;
    return { seen, fetchFile };
  };
  const whole = serve();
  const files = await loadProductionMedia(record.caseId, whole.fetchFile);
  expect(whole.seen.sort()).toEqual(Object.values(manifest).map(file => file.src).sort());
  expect(Object.keys(files).sort()).toEqual(Object.keys(manifest).sort());
  for (const [reference, url] of Object.entries(files)) expect(url.startsWith(`data:${manifest[reference].type};base64,`), reference).toBe(true);
  await expect(loadProductionMedia(record.caseId, serve({ src: first[1].src, as: 'missing' }).fetchFile)).rejects.toThrow('production_media_unavailable');
  await expect(loadProductionMedia(record.caseId, serve({ src: second[1].src, as: 'short' }).fetchFile)).rejects.toThrow('production_media_unavailable');
  await expect(loadProductionMedia(record.caseId, serve({ src: first[1].src, as: 'stalled' }).fetchFile, 50, undefined, Infinity)).rejects.toThrow('production_media_unavailable');
  // A manifest chunk that never arrives ends at the same deadline, and nothing is fetched for it.
  const idle = serve();
  await expect(loadProductionMedia(record.caseId, idle.fetchFile, 50, () => new Promise(() => {}))).rejects.toThrow('production_media_unavailable');
  expect(idle.seen).toEqual([]);
  // The files get the time their bytes take at a slow link's speed on top of the deadline: a file 200 ms late fails a
  // 50 ms deadline alone, and arrives when the case's bytes are given five seconds more.
  const total = Object.values(manifest).reduce((sum, file) => sum + file.bytes, 0);
  const late = (fetchFile: typeof fetch) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    await new Promise(resolve => setTimeout(resolve, 200));
    return fetchFile(input, init);
  }) as typeof fetch;
  await expect(loadProductionMedia(record.caseId, late(serve().fetchFile), 50, undefined, Infinity)).rejects.toThrow('production_media_unavailable');
  expect(Object.keys(await loadProductionMedia(record.caseId, late(serve().fetchFile), 50, undefined, total / 5)).sort()).toEqual(Object.keys(manifest).sort());
  expect(await loadProductionMedia('no-such-case', whole.fetchFile)).toEqual({});
});

it('publishes a record for real cases only, and summarises each one exactly', () => {
  const ids = new Set(PRODUCTION_CASES.map(item => item.id));
  for (const record of RECORDS) expect(ids.has(record.caseId), record.caseId).toBe(true);
  expect(Object.keys(PRODUCTION_RUN_SUMMARY).sort()).toEqual([...byCase.keys()].sort());
  expect(byCase.has('knowledge-base')).toBe(true);
  for (const record of RECORDS) {
    const delivery = record.nodes.find(node => node.id === record.artifactNodeId);
    expect(PRODUCTION_RUN_SUMMARY[record.caseId], record.caseId).toEqual({ completed: record.completed, total: record.total, seconds: record.seconds,
      delivered: delivery?.status === 'done' && delivery.outputType === 'html' && Boolean(delivery.output),
      capturedOn: record.capturedOn, model: record.model, runtime: record.runtime,
      ...(record.media?.length ? { media: { completed: record.media.filter(item => item.status === 'done').length, total: record.media.length } } : {}) });
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
    // A canvas that ran again: its runs, and how long they took, which is never more than from the first start to the
    // last finish; its receipt names each node's revisions once, the last run's last.
    if (record.runs === undefined) expect(record.activeSeconds, record.caseId).toBeUndefined();
    else {
      expect(record.runs, record.caseId).toBeGreaterThan(1);
      expect(record.activeSeconds, record.caseId).toBeGreaterThan(0);
      expect(record.activeSeconds!, record.caseId).toBeLessThanOrEqual(record.seconds);
    }
    if (record.source.runs) {
      expect(record.source.runs.flatMap(entry => entry.nodes).sort(), record.caseId).toEqual(record.nodes.map(node => node.id).sort());
      expect(record.source.runs.at(-1), record.caseId).toMatchObject({ api: record.source.api, worker: record.source.worker });
      for (const entry of record.source.runs) expect(`${entry.api} ${entry.worker}`, record.caseId).toMatch(/^[0-9a-f]{8,40} [0-9a-f]{8,40}$/);
    }
    // English, as every case is, down to what each agent delivered.
    for (const text of [record.edition, record.note, record.verification]) {
      expect(text.trim(), record.caseId).not.toBe('');
      expect(text, record.caseId).not.toMatch(/\p{Script=Han}/u);
    }
    for (const node of record.nodes) expect(`${node.title}\n${node.output ?? ''}\n${node.detail ?? ''}`, `${record.caseId}/${node.id}`).not.toMatch(/\p{Script=Han}/u);
    for (const node of record.nodes) {
      if (node.kind === 'assemble') {
        // An assemble node makes a file with no model: it has no text output, and its file is recorded when it ran.
        expect(node.output, `${record.caseId}/${node.id}`).toBeUndefined();
        if (node.status === 'done') expect(node.file?.bytes, `${record.caseId}/${node.id}`).toBeGreaterThan(0);
      } else if (node.status === 'done') {
        expect(node.output?.trim(), `${record.caseId}/${node.id}`).toBeTruthy();
        if (node.outputType === 'html') expect(isCompleteHtmlDocument(node.output!), `${record.caseId}/${node.id}`).toBe(true);
      } else expect(node.output, `${record.caseId}/${node.id}`).toBeUndefined();
      expect(`${node.report ?? ''}`, `${record.caseId}/${node.id}`).not.toMatch(/\p{Script=Han}/u);
    }
    const ids = new Set(record.nodes.map(node => node.id));
    for (const edge of record.edges) expect(ids.has(edge.from) && ids.has(edge.to), `${record.caseId}: ${edge.from}->${edge.to}`).toBe(true);
    const artifact = record.nodes.find(node => node.id === record.artifactNodeId);
    if (record.artifactSHA256) expect(createHash('sha256').update(artifact!.output!).digest('hex'), record.caseId).toBe(record.artifactSHA256);
  }
});

it('records each SaaS case run on the very canvas a member can copy today', () => {
  for (const record of RECORDS) {
    const workflow = PRODUCTION_WORKFLOWS[record.caseId];
    expect(workflow, record.caseId).toBeDefined();
    expect(record.nodes.map(node => [node.id, node.title, node.column, node.row, node.outputType])).toEqual(
      workflow.nodes.map(node => [node.id, node.title, node.column, node.row, node.outputType ?? 'markdown']));
    expect(record.edges).toEqual(workflow.edges);
    // Every task, persona, brief, contract and wire the run used is the copyable canvas today, word for word.
    expect(createHash('sha256').update(canonicalCanvasText(createOfficialDocument(workflow))).digest('hex'), record.caseId).toBe(record.canvasSHA256);
    expect(record.artifactNodeId === undefined || record.artifactNodeId === workflow.nodes.findLast(node => node.outputType === 'html')!.id).toBe(true);
    expect(record.source?.api).toMatch(/^[0-9a-f]{8,40}$/);
    expect(record.source?.worker).toMatch(/^[0-9a-f]{8,40}$/);
    expect(record.limits!.concurrency, record.caseId).toBeLessThanOrEqual(workflow.nodes.length);
    if ((PUBLISHED_FLAGSHIPS as readonly string[]).includes(record.caseId)) {
      // A flagship's agents work in sandbox computers, dozens of model calls each: every agent node ran there, and its
      // nine builders side by side.
      expect(record.runtime, record.caseId).toBe('sandbox');
      expect(record.nodes.filter(node => node.kind !== 'assemble').every(node => node.sandbox), record.caseId).toBe(true);
      expect(record.nodes.filter(node => node.kind === 'assemble').map(node => node.id), record.caseId).toEqual(workflow.nodes.filter(node => node.assemble).map(node => node.id));
      expect(record.limits, record.caseId).toMatchObject({ contextWindow: 200000, maxOutputTokens: 32000, modelCallsPerNode: 64 });
      expect(record.limits!.concurrency, record.caseId).toBe(9);
      continue;
    }
    if ((PUBLISHED_EPICS as readonly string[]).includes(record.caseId)) {
      // An epic's agents work in sandbox computers too, on Claude Opus 5.5 with its 64,000 output tokens a call and its own
      // thinking; its twenty builders ran at most eight side by side (the sandbox worker's slots).
      expect(record.runtime, record.caseId).toBe('sandbox');
      expect(record.nodes.filter(node => node.kind !== 'assemble').every(node => node.sandbox), record.caseId).toBe(true);
      expect(record.nodes.filter(node => node.kind === 'assemble').map(node => node.id), record.caseId).toEqual(workflow.nodes.filter(node => node.assemble).map(node => node.id));
      expect(record.limits, record.caseId).toMatchObject({ contextWindow: 200000, maxOutputTokens: 64000, modelCallsPerNode: 64, concurrency: 8, thinking: true });
      continue;
    }
    // The settings it ran with on production: Claude Opus 5.5's own limits, one model call per node, its thinking on.
    expect(record.model, record.caseId).toBe('Claude Opus 5.5');
    expect(record.limits, record.caseId).toMatchObject({ contextWindow: 200000, maxOutputTokens: 32000, modelCallsPerNode: 1, thinking: true });
    // The most agents that ran at once: the larger cases run six modules side by side.
    expect([1, 2, 3, 4, 5, 6], record.caseId).toContain(record.limits?.concurrency);
    expect(record.runtime).toBe('openai-agents');
  }
});

it('changes the canvas digest when any task or wire changes, but not with the fresh node IDs of a copy', () => {
  const workflow = PRODUCTION_WORKFLOWS['party-game'];
  const document = createOfficialDocument(workflow);
  const text = canonicalCanvasText(document);
  expect(canonicalCanvasText(createOfficialDocument(workflow))).toBe(text);
  expect(canonicalCanvasText({ ...document, edges: document.edges.slice(1) })).not.toBe(text);
  expect(canonicalCanvasText({ ...document, edges: document.edges.map((edge, index) => index ? edge : { ...edge, toPort: 'in:brief' }) })).not.toBe(text);
  expect(canonicalCanvasText({ ...document, nodes: document.nodes.map((node, index) => index ? node : { ...node, persona: `${(node as { persona?: string }).persona} ` }) })).not.toBe(text);
});

it('carries no private identifiers or machine paths into a public record', () => {
  for (const record of RECORDS) {
    const text = JSON.stringify(record);
    // Every string as it is, not JSON-escaped, so a backslash path is caught too. A recorded turn or session script
    // (Roost's and Errand's) is checked as the data it adds, whose strings are the recorded commands, outputs and files:
    // the script's own JSON escapes (a regex's \b in a recorded command, written \\b) are not paths.
    const strings: string[] = [];
    const added = (script: string) => {
      let data: unknown = null;
      const library = { add: (value: unknown) => { data = value; } };
      new Function('window', script)({ Roost: { library }, Errand: { library } });
      return data;
    };
    const walk = (value: unknown): void => {
      if (typeof value === 'string') {
        if (/^window\.(Roost|Errand)&&window\.\1\.library\.add\(/.test(value)) walk(added(value)); else strings.push(value);
      } else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(record);
    for (const value of strings) {
      expect(value, record.caseId).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(value, record.caseId).not.toMatch(/(?<![A-Za-z0-9])[A-Za-z]:[\\/]/);
      // /home/errand and /home/roost are the homes of the computers inside Errand's and Roost's own pages (their
      // kernels'), not a machine's. A network path is two backslashes, a host, a backslash and a share (\\host\share):
      // two backslashes and a letter alone are also code's escaped escapes ('\\u2019' in a module's string).
      expect(value, record.caseId).not.toMatch(/(?:^|[^A-Za-z0-9.])(?:\/Users\/|\/home\/(?!errand\b|roost\b)|~\/|\\\\[A-Za-z][\w.-]*\\[\w$.-])/);
    }
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
