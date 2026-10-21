// An edit node (2026-10-19): it joins the clips, sounds and pictures wired into it into one film by an awwo.timeline/1
// document, with no model, in a cloud canvas run (the API's edits.go, ffmpeg on the render worker). Its ports are the
// API's, its delivery is a video record with the edit's other files beside the film, and this device never makes it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AddNodeMenu } from '../src/canvas/AddNodeMenu';
import { createEditNode, createFormNode, createSessionNode, emptyDocument, sanitizeDocument, type CanvasDocument, type CanvasEdge, type CanvasNode,
  type EditNode, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasResult, deliveredItems } from '../src/canvas/canvasResultModel';
import { EDIT_CLOUD_ONLY, editTimelineExample, editTimelineIssue, editWiredFiles, timelineJSON } from '../src/canvas/editNode';
import { canvasText, LocaleProvider, type CanvasTextKey, type CanvasTextValues } from '../src/canvas/i18n';
import { InspectorPanel } from '../src/canvas/InspectorPanel';
import { invalidateOutputs } from '../src/canvas/invalidateOutputs';
import { mediaDeliveryText, mediaMissingText, parseEditFacts, parseMediaOutput } from '../src/canvas/mediaOutput';
import { prepareNodeConversation } from '../src/canvas/nodeConversation';
import { canConnect, isSoftMediaFeed, portsFor, reconcileEdges } from '../src/canvas/ports';
import { preflightGraphIssue, runGraph, type RunNodeStatus } from '../src/canvas/runGraph';
import { applyRecoveredDocument, runInputFingerprint } from '../src/canvas/runRecoveryDocument';
import { SessionTile } from '../src/canvas/SessionTile';
import { entryDownloadUrl, entryMediaUrl } from '../src/canvas/studio/studioData';
import { nodeEntries, studioGroups } from '../src/canvas/studio/studioModel';
import { preflightIssueMessage, recoveryDetailMessage } from '../src/canvas/surfaceMessages';
import { mediaPortGuide, TilePorts } from '../src/canvas/TilePorts';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { graphRecoveryJournal, mergeGraphSnapshot, type GraphRunSnapshot } from '../src/saas/graphRuns';

const tenant = { id: 'tenant-a', name: 'A', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const en = (key: CanvasTextKey, values?: CanvasTextValues) => canvasText('en', key, values);

const FILM = 'aFilmQ3v9Lm2Xp7k';
const SRT = 'aSubsR1x9Lm2Xp7k';
const REPORT = 'aReportQ3v9Lm2Xp';
const STILL = 'aStill001Q3v9Lm2';
/** The delivery the API stores for an edit node (edit_outputs.go editRecord). */
const RECORD = JSON.stringify({
  type: 'awwo.media', version: 1, kind: 'video', model: 'awwo-edit',
  items: [{ artifactId: FILM, name: 'R1.mp4', contentType: 'video/mp4', size: 123456 }],
  edit: {
    seconds: 12.5, frames: 300, fps: 24, width: 1920, height: 822, loudness: { integratedLUFS: -16, truePeakDb: -1.2, rangeLU: 3.1 },
    warnings: ['audio_cut_at_end:m1'],
    files: [
      { artifactId: SRT, name: 'R1.srt', contentType: 'application/x-subrip', size: 40, role: 'subtitles' },
      { artifactId: REPORT, name: 'report.json', contentType: 'application/json', size: 900, role: 'report' },
      { artifactId: STILL, name: 'still-001.jpg', contentType: 'image/jpeg', size: 30000, role: 'still' },
    ],
  },
});
const CLIP = JSON.stringify({ type: 'awwo.media', version: 1, kind: 'video', model: 'xt.seedance',
  items: [{ artifactId: 'aClipQ3v9Lm2Xp7k', name: 'video-1.webm', contentType: 'video/webm', size: 5000 }] });

const edit = (id = 'e1', patch: Partial<EditNode> = {}): EditNode => ({ ...createEditNode({ x: 400, y: 0 }, 'en'), id, title: 'Reel 1', ...patch });
function session(kind: SessionNode['agentKind'], id: string, y = 0): SessionNode {
  return { ...createSessionNode(kind, { x: 0, y }), id, title: `${kind} ${id}`, runtime: kind === 'llm' ? 'pi' : '', model: kind === 'llm' ? 'writer' : `${kind}-model`,
    binding: { companyId: tenant.id, agentId: `agent-${id}`, agentName: id } };
}
const wire = (from: string, to: string, toPort: string, dataType: CanvasEdge['dataType'], fromPort = 'result'): CanvasEdge =>
  ({ id: `${from}:${fromPort}->${to}:${toPort}`, fromNode: from, fromPort, toNode: to, toPort, dataType });
const made = (node: EditNode): EditNode => ({ ...node, lastOutput: { text: RECORD, at: 1_000, source: 'run' } });

afterEach(() => { cleanup(); clearSaaSCanvas(); });

describe('edit node document', () => {
  it('is created empty and survives a save and reload as just what an edit is', () => {
    const node = createEditNode({ x: 10, y: 20 }, 'en');
    expect(node).toMatchObject({ kind: 'edit', x: 10, y: 20, w: 320, h: 240, title: 'Edit', timeline: '' });
    expect(createEditNode({ x: 0, y: 0 }).title).toBe('剪辑');
    const stored = { ...made(edit('e1', { timeline: '{"schema":"awwo.timeline/1"}' })), contract: { version: 1, inputs: [], outputs: [] },
      binding: { companyId: 'c', agentId: 'a' }, agentKind: 'video', template: '<html>', persona: 'x', junk: true };
    const doc = sanitizeDocument(JSON.parse(JSON.stringify({ version: 2, nodes: [stored], edges: [] })));
    expect(doc.nodes[0]).toEqual({ id: 'e1', kind: 'edit', x: 400, y: 0, w: 320, h: 240, title: 'Reel 1', timeline: '{"schema":"awwo.timeline/1"}',
      lastOutput: { text: RECORD, at: 1_000, source: 'run' } });
    expect(sanitizeDocument({ nodes: [{ id: 'bare', kind: 'edit' }], edges: [] }).nodes[0]).toMatchObject({ kind: 'edit', timeline: '', title: '剪辑', lastOutput: null });
  });

  it('keeps the wires the API takes, each keeping its source type, and drops a mistyped one', () => {
    const doc = sanitizeDocument({ version: 2, nodes: [session('video', 'clip'), session('audio', 'voice', 300), edit()], edges: [
      wire('clip', 'e1', 'clips', 'text'), wire('voice', 'e1', 'sounds', 'audio'), wire('voice', 'e1', 'clips', 'audio'),
    ] });
    expect(doc.edges.map(edge => `${edge.fromNode}>${edge.toPort}:${edge.dataType}`)).toEqual(['clip>clips:video', 'voice>sounds:audio']);
  });
});

describe('edit node ports', () => {
  it('has the timeline, the three media inputs and the film, as the API types them', () => {
    expect(portsFor(edit()).map(port => `${port.side}:${port.id}:${port.dataType}:${port.multi ? 'multi' : 'one'}`)).toEqual([
      'input:timeline:text:one', 'input:clips:video:multi', 'input:sounds:audio:multi', 'input:pictures:image:multi', 'output:result:video:one',
    ]);
  });

  it('takes each medium in its own port, a timeline from any text, and its film onward', () => {
    const nodes: CanvasNode[] = [session('video', 'clip'), session('audio', 'voice'), session('image', 'still'), session('llm', 'writer'),
      { ...createFormNode({ x: 0, y: 0 }), id: 'form' }, edit(), edit('e2'), session('llm', 'page')];
    const can = (from: string, to: string, toPort: string, edges: CanvasEdge[] = [], fromPort = 'result') =>
      canConnect(nodes, edges, { nodeId: from, portId: fromPort }, { nodeId: to, portId: toPort });
    expect(can('clip', 'e1', 'clips')).toBe(true);
    expect(can('voice', 'e1', 'sounds')).toBe(true);
    expect(can('still', 'e1', 'pictures')).toBe(true);
    expect(can('writer', 'e1', 'timeline')).toBe(true);
    expect(can('form', 'e1', 'timeline', [], 'data')).toBe(true);
    expect(can('e1', 'e2', 'clips')).toBe(true);
    expect(can('e1', 'page', 'context')).toBe(true);
    expect(isSoftMediaFeed(nodes[5], nodes[7], { fromPort: 'result', toPort: 'context' })).toBe(true);
    // A medium in another's port, and a second timeline, are refused; clips take as many as are wired.
    expect(can('voice', 'e1', 'clips')).toBe(false);
    expect(can('clip', 'e1', 'pictures')).toBe(false);
    const timeline = [wire('writer', 'e1', 'timeline', 'text')];
    expect(can('form', 'e1', 'timeline', timeline, 'data')).toBe(false);
    expect(can('e2', 'e1', 'clips', [wire('clip', 'e1', 'clips', 'video')])).toBe(true);
  });
});

describe('edit node delivery', () => {
  it('reads as a video record of one film, its edit block apart and never loosening the item check', () => {
    const film = parseMediaOutput(RECORD);
    expect(film).toEqual({ kind: 'video', model: 'awwo-edit', items: [{ artifactId: FILM, name: 'R1.mp4', contentType: 'video/mp4', size: 123456 }] });
    expect(parseEditFacts(RECORD)).toMatchObject({ seconds: 12.5, frames: 300, fps: 24, width: 1920, height: 822, loudness: { integratedLUFS: -16 },
      warnings: ['audio_cut_at_end:m1'] });
    expect(parseEditFacts(RECORD)!.files.map(file => `${file.role}:${file.name}`)).toEqual(['subtitles:R1.srt', 'report:report.json', 'still:still-001.jpg']);
    // An item of another type in a video record is still no record; a bad edit block costs only the extras.
    const record = JSON.parse(RECORD);
    expect(parseMediaOutput(JSON.stringify({ ...record, items: [...record.items, record.edit.files[0]] }))).toBeNull();
    const badFile = JSON.stringify({ ...record, edit: { ...record.edit, files: [{ ...record.edit.files[0], contentType: 'text/html' }] } });
    expect(parseMediaOutput(badFile)?.items).toHaveLength(1);
    expect(parseEditFacts(badFile)).toBeNull();
    expect(parseEditFacts(JSON.stringify({ ...record, edit: { ...record.edit, loudness: null } }))?.loudness).toBeNull();
    expect(parseEditFacts(CLIP)).toBeNull();
  });

  it('tells a downstream node the film and the files the edit left, as the API does', () => {
    expect(mediaDeliveryText(edit(), RECORD).split('\n')).toEqual([
      '「Reel 1」生成的视频文件（存放在这张画布的成果里，这里只列文件，不含内容）：',
      '- e1/R1.mp4（video/mp4，123456 字节）',
      '这是剪辑好的成片（12.5 秒）。剪辑还留下了这些文件：',
      '- e1/R1.srt（application/x-subrip，40 字节；字幕（SRT））',
      '- e1/report.json（application/json，900 字节；剪辑报告（JSON：时长、响度、各轨数量、警告））',
      '- e1/still-001.jpg（image/jpeg，30000 字节；成片抽帧）',
      '网页可以用上面的相对路径引用这些文件，AwwO 的预览会换成真实文件；不要编造其他文件名。',
    ]);
    expect(mediaDeliveryText({ id: 'clip', title: 'Clip' }, CLIP)).not.toContain('剪辑');
    expect(mediaMissingText(edit())).toContain('「Reel 1」这次没有生成出视频文件');
  });

  it('hands a conversation wired from the film its file list', () => {
    const page: SessionNode = { ...session('llm', 'page'), contract: { version: 1, inputs: [{ id: 'film', label: 'Film', type: 'text', required: true, value: '' }],
      outputs: [{ id: 'result', label: 'Page', type: 'html', required: true, value: '' }] } };
    const context = prepareNodeConversation(page, [made(edit()), page], [wire('e1', 'page', 'in:film', 'video')]);
    expect(context.error).toBeUndefined();
    expect(context.messagePrefix).toContain('- e1/R1.mp4（video/mp4，123456 字节）');
    expect(context.messagePrefix).toContain('这是剪辑好的成片（12.5 秒）');
  });

  it('opens in the studio as the film, its subtitles and report to read, and its stills', () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    const entries = nodeEntries(made(edit()), 'run');
    expect(entries.map(entry => [entry.name, entry.kind, entry.source.type, Boolean(entry.primary)])).toEqual([
      ['R1.mp4', 'video', 'media', true], ['R1.srt', 'text', 'stored', false], ['report.json', 'data', 'stored', false], ['still-001.jpg', 'image', 'media', false],
    ]);
    expect(entries[1].source).toEqual({ type: 'stored', reference: `awwo-file:${SRT}` });
    expect(entryDownloadUrl(entries[2])).toBe(`/api/v1/tenants/tenant-a/artifacts/${REPORT}`);
    expect(entryMediaUrl(entries[3])).toBe(`/api/v1/tenants/tenant-a/artifacts/${STILL}/media`);
    expect(entryMediaUrl(entries[0])).toBe(`/api/v1/tenants/tenant-a/artifacts/${FILM}/media`);
    // A record whose edit block is not readable still shows its film, alone.
    const bare = { ...edit(), lastOutput: { text: JSON.stringify({ ...JSON.parse(RECORD), edit: { seconds: 'long' } }), at: 1, source: 'run' as const } };
    expect(nodeEntries(bare, 'run').map(entry => entry.name)).toEqual(['R1.mp4']);
  });

  it('is the canvas result like a video, and its film is listed like one', () => {
    const doc: CanvasDocument = { ...emptyDocument(), nodes: [{ ...session('video', 'clip'), lastOutput: { text: CLIP, at: 1, source: 'run' } }, made(edit())],
      edges: [wire('clip', 'e1', 'clips', 'video')] };
    expect(canvasResult(doc).final).toMatchObject({ node: { id: 'e1' }, kind: 'media', state: 'run' });
    expect(deliveredItems(doc).filter(item => item.nodeId === 'e1').map(item => [item.kind, item.label, item.artifactId])).toEqual([['video', 'R1.mp4', FILM]]);
    expect(studioGroups(doc).find(group => group.nodeId === 'e1')?.entries).toHaveLength(4);
  });
});

describe('edit node runs', () => {
  it('fails on this device with the cloud-only reason, and a page fed from its film goes on without it', async () => {
    const nodes: CanvasNode[] = [session('video', 'clip'), edit(), session('llm', 'page')];
    const edges = reconcileEdges(nodes, [wire('clip', 'e1', 'clips', 'video'), wire('e1', 'page', 'context', 'video')]);
    const statuses: Record<string, RunNodeStatus> = {};
    const messages: Record<string, string> = {};
    const summary = await runGraph({ nodes, edges, onStatus: (id, status) => { statuses[id] = status; },
      execAgent: async (node, message) => { messages[node.id] = message; return { ok: true, output: node.id === 'clip' ? CLIP : 'PAGE', detail: '' }; } });
    expect(statuses.e1).toEqual({ state: 'failed', detail: EDIT_CLOUD_ONLY });
    expect(Object.keys(messages).sort()).toEqual(['clip', 'page']);
    expect(messages.page).toContain('「Reel 1」这次没有生成出视频文件');
    expect(summary).toMatchObject({ failed: 1, done: 2 });
    expect(recoveryDetailMessage(en, statuses.e1.detail, 'en')).toBe('An edit node runs in a cloud canvas run.');
  });

  it('needs one timeline before a run, wired or its own', () => {
    const writer = session('llm', 'writer');
    expect(preflightGraphIssue([edit()], [], ['e1'])).toMatchObject({ code: 'edit_timeline', values: { nodeTitle: 'Reel 1' } });
    expect(preflightIssueMessage(en, preflightGraphIssue([edit()], [], ['e1']), 'en')).toBe('“Reel 1” needs a timeline: wire one into it, or write one in its settings.');
    expect(preflightGraphIssue([edit('e1', { timeline: editTimelineExample({ clips: [], sounds: [], pictures: [] }) })], [], ['e1'])).toBeNull();
    expect(preflightGraphIssue([writer, edit()], [wire('writer', 'e1', 'timeline', 'text')], ['e1'])).toBeNull();
    expect(preflightGraphIssue([writer, { ...session('llm', 'other') }, edit()],
      [wire('writer', 'e1', 'timeline', 'text'), wire('other', 'e1', 'timeline', 'text')], ['e1'])?.code).toBe('multiple_inputs');
    // Out of the run's scope, an edit without a timeline holds nothing back.
    expect(preflightGraphIssue([writer, edit()], [], ['writer'])).toBeNull();
  });

  it('takes its film from a cloud run into its delivery, and a failure keeps the worker’s words', () => {
    const doc: CanvasDocument = { ...emptyDocument(), nodes: [{ ...session('video', 'clip'), lastOutput: { text: CLIP, at: 1, source: 'run' } }, edit('e1', { timeline: '{}' })],
      edges: [wire('clip', 'e1', 'clips', 'video')] };
    const snapshot = (node: GraphRunSnapshot['nodes'][number]): GraphRunSnapshot => ({ id: 'graph-e', operationId: 'op-e', canvasId: 'canvas-a', documentVersion: 3,
      document: doc, scope: ['e1'], status: 'completed', createdAt: '2026-10-19T00:00:00.000Z', nodes: [{ nodeId: 'clip', state: 'cached', output: CLIP }, node] });
    const done = graphRecoveryJournal(snapshot({ nodeId: 'e1', state: 'done', output: RECORD }), tenant.id, doc);
    expect(done.nodes.e1).toMatchObject({ threadId: 'form', state: 'done', output: RECORD });
    const applied = applyRecoveredDocument(doc, { ...done, inputFingerprint: runInputFingerprint(doc, done.scope) });
    expect(applied.nodes.find(node => node.id === 'e1')?.lastOutput).toMatchObject({ text: RECORD, source: 'run' });
    const refused = mergeGraphSnapshot(done, snapshot({ nodeId: 'e1', state: 'failed', detail: 'edit_rejected: tracks.video[0].source must name a wired file' }));
    expect(recoveryDetailMessage(en, refused.nodes.e1.detail, 'en')).toBe('The render worker refused the timeline: tracks.video[0].source must name a wired file');
    const named = 'The timeline names clip/video-9.mp4, which none of the nodes wired into this edit delivered';
    expect(recoveryDetailMessage(en, named, 'en')).toBe(named);
    expect(recoveryDetailMessage(en, 'edit_allowance', 'en')).toContain('Today’s edits are used up');
  });

  it('is a new run input when its timeline changes, which clears its film and what used it', () => {
    const page = { ...session('llm', 'page'), lastOutput: { text: 'PAGE', at: 2, source: 'run' as const } };
    const before: CanvasDocument = { ...emptyDocument(), nodes: [made(edit('e1', { timeline: 'A' })), page], edges: [wire('e1', 'page', 'context', 'video')] };
    const after = { ...before, nodes: [{ ...before.nodes[0], timeline: 'B' } as EditNode, page] };
    expect(runInputFingerprint(after, ['e1'])).not.toBe(runInputFingerprint(before, ['e1']));
    expect(invalidateOutputs(before, after).nodes.map(node => node.lastOutput ?? null)).toEqual([null, null]);
  });
});

describe('edit node timeline help', () => {
  it('finds the timeline in an answer as the API does and says what is plainly wrong', () => {
    expect(timelineJSON('Here it is:\n```json\n{"schema":"awwo.timeline/1"}\n```\nDone.')).toBe('{"schema":"awwo.timeline/1"}');
    expect(timelineJSON('the cut: {"a":1} as asked')).toBe('{"a":1}');
    expect(editTimelineIssue('')).toBeNull();
    expect(editTimelineIssue('a list of cuts')).toBe('not_json');
    expect(editTimelineIssue('[1,2]')).toBe('not_json');
    expect(editTimelineIssue('{"schema":"awwo.timeline/2","tracks":{"video":[{}]}}')).toBe('schema');
    expect(editTimelineIssue('{"schema":"awwo.timeline/1","tracks":{"video":[]}}')).toBe('tracks');
    expect(editTimelineIssue('{"schema":"awwo.timeline/1","tracks":{"video":[{}],"music":{}}}')).toBe('tracks');
    expect(editTimelineIssue('```json\n{"schema":"awwo.timeline/1","tracks":{"video":[{"card":"<html></html>","seconds":2}]}}\n```')).toBeNull();
  });

  it('names the files wired in now, in canvas order, or the names they will have', () => {
    const intro = edit('intro', { y: -200, timeline: '{"schema":"awwo.timeline/1","name":"Intro"}' });
    const nodes: CanvasNode[] = [{ ...session('video', 'clip', 100), lastOutput: { text: CLIP, at: 1, source: 'run' } }, intro, session('audio', 'voice'), session('image', 'pic'), edit()];
    const edges = [wire('clip', 'e1', 'clips', 'video'), wire('intro', 'e1', 'clips', 'video'), wire('voice', 'e1', 'sounds', 'audio'), wire('pic', 'e1', 'pictures', 'image')];
    const files = editWiredFiles(edit(), nodes, edges);
    expect(files).toEqual({ clips: ['intro/Intro.mp4', 'clip/video-1.webm'], sounds: ['voice/audio-1.mp3'], pictures: ['pic/image-1.png'] });
    const example = JSON.parse(editTimelineExample(files, 'en'));
    expect(example).toMatchObject({ schema: 'awwo.timeline/1', name: 'R1', output: { width: 1920, height: 822, fps: 24 } });
    expect(example.tracks.video.map((item: { source?: string }) => item.source ?? 'card')).toEqual(['intro/Intro.mp4', 'clip/video-1.webm', 'card']);
    expect(example.tracks.dialogue[0]).toMatchObject({ source: 'voice/audio-1.mp3', anchor: 'v2' });
    expect(editTimelineIssue(editTimelineExample(files))).toBeNull();
    expect(JSON.parse(editTimelineExample({ clips: [], sounds: [], pictures: [] })).tracks.video[0].source).toBe('<node id>/video-1.mp4');
  });
});

describe('edit node surfaces', () => {
  it('is offered in the add menu only where the host offers it', () => {
    const onPick = vi.fn();
    const view = render(<AddNodeMenu at={{ x: 0, y: 0 }} onPick={onPick} onClose={vi.fn()} withEdit />);
    fireEvent.click(screen.getByRole('menuitem', { name: '添加剪辑节点' }));
    expect(onPick).toHaveBeenCalledWith('edit');
    view.rerender(<AddNodeMenu at={{ x: 0, y: 0 }} onPick={onPick} onClose={vi.fn()} />);
    expect(screen.queryByRole('menuitem', { name: '添加剪辑节点' })).toBeNull();
  });

  it('edits its own timeline in the inspector, fills the example from what is wired, and saves a doubtful one with a note', () => {
    const onSave = vi.fn();
    render(<InspectorPanel node={edit()} liveCompanies={[]} apiBase="/api" onSave={onSave} onClose={vi.fn()}
      editFiles={{ clips: ['clip/video-1.mp4'], sounds: [], pictures: [] }} />);
    expect(screen.getByText(/剪辑节点按一份时间线/)).toBeInTheDocument();
    expect(screen.getByText('当前接入的文件：clip/video-1.mp4')).toBeInTheDocument();
    const area = screen.getByLabelText('时间线（awwo.timeline/1 JSON）') as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole('button', { name: '插入示例' }));
    expect(JSON.parse(area.value).tracks.video[0]).toMatchObject({ id: 'v1', source: 'clip/video-1.mp4' });
    expect(screen.getByRole('button', { name: '替换为示例' })).toBeInTheDocument();
    fireEvent.change(area, { target: { value: '{ "schema": "other" }' } });
    expect(screen.getByText('schema 必须是 "awwo.timeline/1"。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1', kind: 'edit', timeline: '{ "schema": "other" }' }));
  });

  it('shows its film, what the edit says of it and its other files on its card', () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    render(<LocaleProvider locale="en"><SessionTile node={made(edit())} scale={1} focused={false} /></LocaleProvider>);
    expect(screen.getByText('12.5 s · 1920×822 · −16 LUFS · Warnings: 1')).toBeInTheDocument();
    expect(screen.getByLabelText('R1.mp4').tagName).toBe('VIDEO');
    expect(screen.getByRole('link', { name: 'Download R1.srt' })).toHaveAttribute('href', `/api/v1/tenants/tenant-a/artifacts/${SRT}`);
    expect(screen.getByRole('link', { name: 'Download report.json' })).toBeInTheDocument();
    expect(screen.getByText('Stills: 1')).toBeInTheDocument();
    expect(screen.getByAltText('still-001.jpg')).toHaveAttribute('src', `/api/v1/tenants/tenant-a/artifacts/${STILL}/media`);
  });

  it('says what to wire before a film, and what stopped a failed one', () => {
    const view = render(<SessionTile node={edit()} scale={1} focused={false} />);
    expect(screen.getByText('还没有成片')).toBeInTheDocument();
    expect(screen.getByText('还没有自己的时间线：接入一份，或在设置里写一份。')).toBeInTheDocument();
    view.rerender(<SessionTile node={edit('e1', { timeline: '{}' })} scale={1} focused={false}
      run={{ state: 'failed', detail: 'edit_rejected: tracks.video[0].source must name a wired file' }} />);
    expect(screen.getByText('渲染服务拒绝了这份时间线：tracks.video[0].source must name a wired file')).toBeInTheDocument();
    expect(screen.getByText('已写好自己的时间线；接入的时间线会优先使用。')).toBeInTheDocument();
    // Too small to watch on screen, the card says its film in a line.
    view.rerender(<SessionTile node={made(edit())} scale={0.6} focused={false} />);
    expect(screen.getByText('12.5 秒 · 1920×822 · −16 LUFS · 警告：1 条')).toBeInTheDocument();
  });

  it('names its ports and says what each takes', () => {
    render(<TilePorts node={edit()} />);
    expect(screen.getByRole('button', { name: '输入端口 时间线（文本），未连接' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '输入端口 片段（视频），未连接' })).toHaveAttribute('title', '片段 · 视频 · 可多路输入');
    expect(screen.getByRole('button', { name: '输入端口 声音（音频），未连接' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '输出端口 成片（视频），未连接' })).toBeInTheDocument();
    const timeline = portsFor(edit())[0];
    expect(mediaPortGuide(en, 'en', edit(), timeline)).toContain('awwo.timeline/1');
  });
});
