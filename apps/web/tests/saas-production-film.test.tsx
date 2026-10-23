import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadProductionMediaManifest, type ProductionMediaFile, type ProductionRunRecord } from '../src/saas/productionRuns';
import { agentCount, EDIT_ROLE, MEDIA_ROLE, PRODUCTION_CASES } from '../src/saas/productionCatalog';
import { createRecordedCopyDocument, recordedCanvasText, recordedCopyDocument, type RecordedCanvas } from '../src/saas/recordedCanvas';
import { sanitizeDocument, type CanvasNode } from '../src/canvas/canvasDoc';
import ProductionShowcase from '../src/saas/ProductionShowcase';

// A film case (a recorded canvas, recordedCanvas.ts): its canvas is the run's own document, stored beside its record.
const RECORDS = import.meta.glob<ProductionRunRecord>('../src/saas/production-runs/*.ts', { eager: true, import: 'default' });
const CANVASES = import.meta.glob<RecordedCanvas>('../src/saas/production-canvases/*.ts', { eager: true, import: 'default' });
const MEDIA = import.meta.glob<Readonly<Record<string, ProductionMediaFile>>>('../src/saas/production-runs/*.media.json', { eager: true, import: 'default' });
const WEB = path.resolve(__dirname, '..');
const FILMS = Object.entries(CANVASES).map(([file, canvas]) => {
  const id = file.replace(/^.*\/|\.ts$/g, '');
  return { id, canvas, record: RECORDS[`../src/saas/production-runs/${id}.ts`], media: MEDIA[`../src/saas/production-runs/${id}.media.json`] ?? {} };
});
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
// The providers behind AwwO's media models, which the site never names (publish-recorded-run.mjs scans the same).
const MARKS = /tripo|x-?tasy|runninghub|bytedance|dreamina|jimeng|kuaishou|midjourney|pixverse|shengshu|seedance|seedream|minimax|nano.?banana|gemini|hailuo|kling/i;
// The English words that hold a name ("sparkling", "a tripod", the Geminids) are set aside first; any other word that holds
// one is refused ("KlingAI", "klingai.com").
const HARMLESS = /(?<![a-z])(?:(?:buc|cac|chuc|crac|crin|dar|duc|frec|hac|hec|in|knuc|pic|pric|ran|roc|shac|sic|spac|spar|spec|sprin|stic|suc|tac|tic|tin|tric|twin|wea|wrin)klings?|tripods?|geminids?)(?![a-z])/gi;
const unnamed = (text: string) => text.replace(HARMLESS, ' ');
// What each film case delivers: a record rooted at another edit would show another film.
const DELIVERED: Readonly<Record<string, string>> = { 'the-long-chord': 'episode-1.mp4' };
const isMedia = (node: CanvasNode) => node.kind === 'session' && ['image', 'video', 'audio', 'model3d'].includes(node.agentKind);

let ProductionFilm: typeof import('../src/saas/ProductionFilm').default;
beforeAll(async () => { ProductionFilm = (await import('../src/saas/ProductionFilm')).default; }, 300_000);
// jsdom makes no object URLs: a test that needs them defines them, and they go again after it.
const OBJECT_URLS = (['createObjectURL', 'revokeObjectURL'] as const).map(name => [name, Object.getOwnPropertyDescriptor(URL, name)] as const);
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const [name, descriptor] of OBJECT_URLS) { if (descriptor) Object.defineProperty(URL, name, descriptor); else Reflect.deleteProperty(URL, name); }
});
/** The film's subtitles as this site serves them (the published file), and the object URLs the player is given for them. */
function subtitlesServed() {
  const made: Blob[] = [];
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: vi.fn((blob: Blob) => { made.push(blob); return `blob:subtitles-${made.length}`; }) });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() });
  const fetched = vi.fn(async (url: string) => new Response(readFileSync(path.join(WEB, ...url.split('/').filter(Boolean)), 'utf8'), { status: 200 }));
  vi.stubGlobal('fetch', fetched);
  return { made, fetched };
}
const caseOf = (id: string) => PRODUCTION_CASES.find(value => value.id === id)!;
const deliveryOf = (record: ProductionRunRecord) => record.nodes.find(node => node.id === record.artifactNodeId)!;
const playerIn = () => waitFor(() => { const element = document.querySelector('video.production-film-player'); expect(element).not.toBeNull(); return element as HTMLVideoElement; }, { timeout: 30_000 });

it('publishes each film case as a recorded canvas whose stored document hashes to its record', () => {
  expect(FILMS.length).toBeGreaterThan(0);
  for (const { id, canvas, record } of FILMS) {
    expect(record, id).toBeDefined();
    expect(record.canvas, id).toBe('recorded');
    expect(sha256(recordedCanvasText(canvas)), id).toBe(record.canvasSHA256);
    const item = PRODUCTION_CASES.find(value => value.id === id)!;
    expect(item, id).toMatchObject({ kind: 'film', recording: true, excerpt: true });
    for (const extension of ['mp4', 'jpg']) expect(existsSync(path.join(WEB, 'showcase', `${item.footage}.${extension}`)), `${item.footage}.${extension}`).toBe(true);
    // The record's nodes are its agents and edits, its media nodes beside them; together they are the stored canvas.
    expect([...record.nodes.map(node => node.id), ...(record.media ?? []).map(value => value.id)].sort(), id).toEqual(canvas.nodes.map(node => node.id).sort());
    expect(record.edges.map(edge => `${edge.from}>${edge.to}`).sort(), id).toEqual(canvas.edges.map(edge => `${edge.fromNode}>${edge.toNode}`).sort());
    // The delivery is the last edit's film, by its bytes' checksum.
    const delivery = record.nodes.find(node => node.id === record.artifactNodeId)!;
    expect(delivery.kind, id).toBe('edit');
    expect(record.artifactSHA256, id).toBe(delivery.film!.sha256);
    expect(record.edges.some(edge => edge.from === delivery.id), id).toBe(false);
  }
});

it('stores the canvas as it ran and nothing private: no binding, conversation, output, credential or run-time field', () => {
  for (const { id, canvas } of FILMS) {
    for (const node of canvas.nodes) {
      const where = `${id}/${node.id}`;
      expect('lastOutput' in node, where).toBe(false);
      if (node.kind === 'edit') { expect(typeof node.timeline, where).toBe('string'); continue; }
      expect(node.kind, where).toBe('session');
      if (node.kind !== 'session') continue;
      expect([node.binding, node.bindAttempt, node.issueId, node.preview], where).toEqual([null, null, null, '']);
      expect(node.agentRef ?? node.team, where).toBeUndefined();
      expect((node.skills ?? []).every(skill => skill.startsWith('builtin:')), where).toBe(true);
      if (isMedia(node)) {
        // A media node keeps the model it generates with and the words it generated from: one conversation, its draft.
        expect(node.model.trim(), where).not.toBe('');
        expect(node.threads?.length, where).toBe(1);
        expect(node.threads![0].draft.trim(), where).not.toBe('');
        expect([node.threads![0].issueId, node.threads![0].lastOutput, node.threads![0].outputValues], where).toEqual([null, undefined, undefined]);
      } else {
        // An agent's runtime and model are the member's choice when copying.
        expect([node.runtime, node.model, node.effort], where).toEqual(['', '', '']);
        expect(node.persona.trim(), where).not.toBe('');
      }
    }
    const text = JSON.stringify(canvas);
    expect(text, id).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(text, id).not.toMatch(/(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\/Users\/|\/home\//);
    // No provider is named in what the canvas says; the media models' ids stay in their settings, never displayed.
    for (const node of canvas.nodes) {
      const said = node.kind === 'edit' ? [node.title, node.timeline] : node.kind === 'session' ? [node.title, node.persona, ...(node.threads ?? []).map(thread => thread.draft)] : [];
      for (const value of said) expect(unnamed(value ?? ''), `${id}/${node.id}`).not.toMatch(MARKS);
    }
  }
  // The publisher scans with these two patterns: a word set aside in one file only would make the two disagree.
  const publisher = readFileSync(path.resolve(WEB, '..', '..', 'scripts', 'showcase', 'publish-recorded-run.mjs'), 'utf8');
  expect(publisher).toContain(`const MARKS = ${MARKS};`);
  expect(publisher).toContain(`const HARMLESS = ${HARMLESS};`);
});

it('wires every node as it ran: each wire joins two of its nodes, there is no cycle, and every file a brief or timeline names is wired in', () => {
  for (const { id, canvas } of FILMS) {
    const ids = new Set(canvas.nodes.map(node => node.id));
    for (const edge of canvas.edges) expect(ids.has(edge.fromNode) && ids.has(edge.toNode), `${id}: ${edge.id}`).toBe(true);
    const into = (target: string) => canvas.edges.filter(edge => edge.toNode === target).map(edge => edge.fromNode);
    const state = new Map<string, 'open' | 'done'>();
    const visit = (node: string): void => {
      expect(state.get(node), `${id}: a cycle through ${node}`).not.toBe('open');
      if (state.get(node) === 'done') return;
      state.set(node, 'open'); into(node).forEach(visit); state.set(node, 'done');
    };
    canvas.nodes.forEach(node => visit(node.id));
    for (const node of canvas.nodes) {
      const text = node.kind === 'edit' ? node.timeline : node.kind === 'session' && !isMedia(node) ? node.persona : '';
      const wired = new Set(into(node.id));
      for (const [, source] of text.matchAll(/\b([a-z][a-z0-9_]*)\/(?:video|audio|image)-\d+\.\w+|\b([a-z][a-z0-9_]*)\/[a-z0-9-]+\.mp4/g)) {
        if (source) expect(wired.has(source), `${id}/${node.id} names ${source}'s file but ${source} is not wired into it`).toBe(true);
      }
      for (const [, source] of text.matchAll(/\b(edit_[A-Za-z0-9]+)\/[a-z0-9-]+\.mp4/g)) expect(wired.has(source), `${id}/${node.id} names ${source}`).toBe(true);
    }
    // A member's copy holds every node and wire, through the canvas's own document check.
    const copy = sanitizeDocument(createRecordedCopyDocument(canvas, null));
    expect(copy.nodes.map(node => node.id).sort(), id).toEqual([...ids].sort());
    expect(copy.edges.length, id).toBe(canvas.edges.length);
    // A chosen execution model goes to the agents only; a media node keeps the model it generates with.
    const before = new Map(canvas.nodes.map(node => [node.id, node]));
    for (const node of createRecordedCopyDocument(canvas, { runtime: 'openai-agents', model: 'claude-test', label: 'Test' }).nodes) {
      const ran = before.get(node.id)!;
      if (node.kind === 'session' && ran.kind === 'session') expect(node.model, `${id}/${node.id}`).toBe(isMedia(node) ? ran.model : 'claude-test');
    }
  }
});

it('publishes the posters, stills and subtitles in the repo and stages the film outside it, each by its checksum', () => {
  for (const { id, record, media } of FILMS) {
    const folder = path.join(WEB, 'showcase', 'media', id);
    const inRepo = Object.entries(media).filter(([, file]) => !file.staged);
    for (const [reference, file] of inRepo) {
      expect(file.src, reference).toBe(`/showcase/media/${id}/${file.sha256.slice(0, 16)}.${{ 'image/webp': 'webp', 'image/jpeg': 'jpg', 'text/vtt': 'vtt' }[file.type]}`);
      const bytes = readFileSync(path.join(WEB, ...file.src.split('/').filter(Boolean)));
      expect([bytes.length, sha256(bytes)], reference).toEqual([file.bytes, file.sha256]);
    }
    expect(readdirSync(folder).sort(), id).toEqual(inRepo.map(([, file]) => path.basename(file.src)).sort());
    // A poster for every picture and clip, none for a sound; the last edit's stills and its subtitles.
    for (const value of record.media ?? []) for (const file of value.files)
      expect(media[`${file}#poster`]?.type, `${id}/${file}`).toBe(value.kind === 'audio' ? undefined : 'image/webp');
    const delivery = record.nodes.find(node => node.id === record.artifactNodeId)!;
    const film = media[`${delivery.id}/${delivery.film!.name}`];
    expect(film, id).toMatchObject({ type: 'video/mp4', staged: true });
    expect(film.src, id).toBe(`/showcase/staged/${id}/${film.sha256.slice(0, 16)}.mp4`);
    expect(film.original, id).toMatchObject({ src: `/showcase/staged/${id}/${delivery.film!.sha256.slice(0, 16)}.mp4`, bytes: delivery.film!.bytes, sha256: delivery.film!.sha256 });
    expect(existsSync(path.join(WEB, 'showcase', 'staged')), 'staged files are never in the repo').toBe(false);
    expect(media[`${delivery.id}/${delivery.film!.name.replace(/\.mp4$/, '.vtt')}`]?.type, id).toBe('text/vtt');
    expect(inRepo.filter(([key]) => key.startsWith(`${delivery.id}/still-`)).length, id).toBeGreaterThan(0);
  }
  // A release carries no large file: a film is staged once on the host instead.
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => statSync(path.join(dir, name)).isDirectory() ? walk(path.join(dir, name)) : [path.join(dir, name)]);
  for (const file of walk(path.join(WEB, 'showcase'))) expect(statSync(file).size, file).toBeLessThan(10 * 1024 * 1024);
});

it('shows a film case: the film from its staged URL with English subtitles, no sandboxed page, every node by stage, and a copy', async () => {
  const { made, fetched } = subtitlesServed();
  for (const { id, record, media } of FILMS) {
    const item = caseOf(id), copy = vi.fn();
    render(<ProductionShowcase item={item} onCopyRecorded={copy} />);
    const player = await playerIn();
    const delivery = deliveryOf(record), film = media[`${delivery.id}/${delivery.film!.name}`];
    expect(player).toHaveAttribute('src', film.src);
    expect(player).toHaveAttribute('controls');
    // The subtitles are fetched as text and given to the player as WebVTT, whatever type the server sends them with.
    const vtt = media[`${delivery.id}/${delivery.film!.name.replace(/\.mp4$/, '.vtt')}`];
    await waitFor(() => expect(player.querySelector('track')).toHaveAttribute('src', `blob:subtitles-${made.length}`));
    expect(fetched).toHaveBeenCalledWith(vtt.src, { credentials: 'omit' });
    expect([made.at(-1)!.type, made.at(-1)!.size]).toEqual(['text/vtt', vtt.bytes]);
    expect(player.querySelector('track')).toHaveAttribute('srclang', 'en');
    expect(document.querySelector('iframe')).toBeNull();
    expect(delivery.film!.name, id).toBe(DELIVERED[id]);
    expect(screen.getByRole('link', { name: name => name.startsWith(`Download ${DELIVERED[id]} as delivered`) })).toHaveAttribute('href', film.original!.src);
    // The heading counts agents, media nodes and edits apart.
    const agents = record.nodes.filter(node => node.kind !== 'edit').length, edits = record.nodes.filter(node => node.kind === 'edit').length;
    expect(screen.getByRole('heading', { level: 3, name: new RegExp(`^${agents} agents, ${record.media!.length} media nodes, ${edits} edits, `) })).toBeVisible();
    // An editor shows its brief and its answer; a clip its words.
    const rail = screen.getByRole('list', { name: 'Every node, stage by stage' });
    const editor = record.nodes.find(node => node.kind !== 'edit')!;
    fireEvent.click(within(rail).getByRole('button', { name: new RegExp(`^${editor.title}`) }));
    expect(screen.getByText(new RegExp(`^Its brief, as it ran \\(${editor.brief!.length.toLocaleString('en')} characters\\)$`))).toBeInTheDocument();
    const clip = record.media!.find(value => value.kind === 'video')!;
    fireEvent.click(within(rail).getByRole('button', { name: clip.title }));
    expect(screen.getByText(clip.words!)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy this canvas' }));
    expect(copy).toHaveBeenCalledWith(item);
    cleanup();
    // Its object URL goes with the dialog.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(`blob:subtitles-${made.length}`);
  }
}, 60_000);

it('says when the film cannot be loaded and tries again: its list of files first, then the player', async () => {
  for (const { id, record } of FILMS) {
    const load = vi.fn(loadProductionMediaManifest).mockRejectedValueOnce(new Error('chunk failed'));
    render(<ProductionFilm item={caseOf(id)} record={record} loadManifest={load} />);
    expect(screen.getByText('Loading the film…')).toBeVisible();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/^The film could not be loaded\.Try again$/);
    expect(document.querySelector('video')).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    const player = await playerIn();
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('group', { name: 'Stills from the film' })).toBeVisible();
    // The player's own failure (no staged file on this site, say): the film and its stills give way to the offer, and
    // trying again reloads the film, not its list of files.
    const reload = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    fireEvent.error(player);
    expect(player).not.toBeVisible();
    expect(screen.queryByRole('group', { name: 'Stills from the film' })).toBeNull();
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(player).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
    cleanup();
  }
}, 60_000);

it('plays the film from the frame each still shows, and stays there when the browser refuses to play', async () => {
  for (const { id, record, media } of FILMS) {
    const delivery = deliveryOf(record), every = delivery.film!.stillsEverySeconds!, fps = delivery.film!.fps;
    expect(every, id).toBeGreaterThan(0);
    // ffmpeg's fps=1/N keeps, for still n, the last frame before (n − ½) × N (measured on the act's own stills): the
    // film plays from the middle of that frame.
    const shown = (index: number) => (index + 0.5) * every - 0.5 / fps;
    render(<ProductionFilm item={caseOf(id)} record={record} />);
    const player = await playerIn();
    const buttons = within(screen.getByRole('group', { name: 'Stills from the film' })).getAllByRole('button');
    expect(buttons, id).toHaveLength(Object.keys(media).filter(key => key.startsWith(`${delivery.id}/still-`)).length);
    expect(shown(buttons.length - 1), id).toBeLessThan(delivery.film!.seconds);
    buttons.forEach((button, index) => {
      const seconds = Math.round(shown(index));
      expect(button).toHaveAccessibleName(`Play from ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
    });
    // A play refused without a gesture is no error: the film waits, paused, at that still. (A plain function, not a
    // vi.fn: a mock's own bookkeeping handles the promise it returns, which would hide an unhandled refusal.)
    const play = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'play')!, unhandled = vi.fn();
    let plays = 0;
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { ...play, value() { plays += 1; return Promise.reject(new DOMException('No gesture yet', 'NotAllowedError')); } });
    process.on('unhandledRejection', unhandled);
    try {
      fireEvent.click(buttons[2]);
      expect([player.currentTime, plays]).toEqual([shown(2), 1]);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); Object.defineProperty(HTMLMediaElement.prototype, 'play', play); }
    // Focusing the film hides the canvas's stages, and gives them back.
    const focus = screen.getByRole('button', { name: 'Focus the film' });
    fireEvent.click(focus);
    expect(focus).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('list', { name: 'Every node, stage by stage', hidden: true })).not.toBeVisible();
    fireEvent.click(focus);
    expect(focus).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('list', { name: 'Every node, stage by stage' })).toBeVisible();
    cleanup();
  }
}, 60_000);

it('copies a recorded canvas only while it is the canvas its record pins, by the browser’s own SHA-256, and never unchecked', async () => {
  const model = { runtime: 'openai-agents', model: 'claude-test', label: 'Test' };
  const pinned = async (text: string) => sha256(text);
  const parts = (document: { nodes: unknown; edges: unknown } | null) => document && { nodes: document.nodes, edges: document.edges };
  for (const { id, canvas, record } of FILMS) {
    // Web Crypto, over the text the publisher hashed, gives the publisher's hash.
    expect(parts(await recordedCopyDocument(record, canvas, model)), id).toEqual(parts(createRecordedCopyDocument(canvas, model)));
    expect(await recordedCopyDocument({ ...record, canvasSHA256: '0'.repeat(64) }, canvas, model, pinned), id).toBeNull();
    const changed = { ...canvas, nodes: [{ ...canvas.nodes[0], title: `${canvas.nodes[0].title} (changed)` }, ...canvas.nodes.slice(1)] } as RecordedCanvas;
    expect(await recordedCopyDocument(record, changed, model, pinned), id).toBeNull();
    expect(await recordedCopyDocument({ ...record, canvas: undefined }, canvas, model, pinned), id).toBeNull();
    // No Web Crypto (an insecure context) or a failed digest: no copy, rather than one made unchecked.
    expect(await recordedCopyDocument(record, canvas, model, async () => null), id).toBeNull();
    expect(await recordedCopyDocument(record, canvas, model, () => Promise.reject(new Error('digest failed'))), id).toBeNull();
  }
});

it('draws a film case’s card from its record: a media step for each stage of media nodes, an entry for each editor and edit', () => {
  for (const { id, record } of FILMS) {
    const media = record.media ?? [];
    const columns = [...new Set([...record.nodes.map(node => node.column), ...media.flatMap(value => value.column ?? [])])].sort((a, b) => a - b);
    const expected = columns.map(column => [...(media.some(value => value.column === column) ? [MEDIA_ROLE] : []),
      ...record.nodes.filter(node => node.column === column).sort((a, b) => a.row - b.row).map(node => (node.kind === 'edit' ? EDIT_ROLE : 'agent'))]);
    expect(caseOf(id).stages.map(stage => stage.map(role => (role === MEDIA_ROLE || role === EDIT_ROLE ? role : 'agent'))), id).toEqual(expected);
    expect(agentCount(caseOf(id)), id).toBe(record.nodes.filter(node => node.kind !== 'edit').length);
  }
});

it('plays the web copy by default, the file as delivered on request, and names the frame it is actually showing', async () => {
  for (const { id, record, media } of FILMS) {
    const delivery = deliveryOf(record), film = delivery.film!;
    const published = media[`${delivery.id}/${film.name}`];
    expect(published, id).toBeDefined();
    // Only a case published with the film beside its web copy offers the switch; the rest keep one file and no button.
    const delivered = published.original;
    render(<ProductionFilm item={caseOf(id)} record={record} />);
    const player = await playerIn();
    const minutes = `${Math.floor(film.seconds / 60)}:${String(Math.round(film.seconds) % 60).padStart(2, '0')}`;
    // Before the player has decoded a frame the heading names none: naming the delivered frame over a narrower copy is
    // the very thing this heading used to get wrong.
    expect(screen.getByText(`The delivered film · ${minutes}`), id).toBeInTheDocument();
    expect(player.getAttribute('src'), id).toBe(published.src);
    if (!delivered) { expect(screen.queryByRole('button', { name: /^As delivered/ }), id).toBeNull(); cleanup(); continue; }

    // The web copy is smaller than the film: that is why it is the default, and why the heading must not keep claiming
    // the delivered frame once the player has decoded the copy's own, narrower one.
    expect(delivered.bytes, id).toBeGreaterThan(published.bytes);
    // A player that has just loaded another file, as a browser leaves one: the load algorithm rewinds it to 0 and
    // pauses it. jsdom does neither on a src change, so the rewind is done here — without it an assertion about the
    // restored moment would only read back the number the test itself wrote, and would pass with no restore at all.
    const frame = (element: HTMLVideoElement, width: number, height: number) => {
      for (const [name, value] of [['videoWidth', width], ['videoHeight', height], ['duration', film.seconds]] as const) {
        Object.defineProperty(element, name, { configurable: true, value });
      }
      element.currentTime = 0;
      fireEvent(element, new Event('loadedmetadata'));
    };
    const copyWidth = Math.min(1280, film.width), copyHeight = Math.round((film.height * copyWidth) / film.width / 2) * 2;
    frame(player, copyWidth, copyHeight);
    expect(screen.getByText(`The delivered film · ${minutes} · ${copyWidth}×${copyHeight}`), id).toBeInTheDocument();

    // Asking for the film as delivered plays that file, from where the viewer had got to, and says so. The label says
    // what the click does, so it carries no pressed state — a pressed state and a changing label contradict each other.
    player.currentTime = 42;
    const toDelivered = screen.getByRole('button', { name: /^As delivered/ });
    expect(toDelivered, id).toHaveAccessibleName(`As delivered · ${Math.round(delivered.bytes / 1e6).toLocaleString('en')} MB`);
    expect(toDelivered, id).not.toHaveAttribute('aria-pressed');
    // It was playing, so it goes on playing from that moment on the other file. (A plain function, not a vi.fn, so a
    // mock's own bookkeeping cannot hide an unhandled refusal; jsdom has no playback of its own.)
    const play = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'play')!;
    const paused = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'paused')!;
    let plays = 0;
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { configurable: true, get: () => false });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { ...play, value() { plays += 1; return Promise.resolve(); } });
    try {
      fireEvent.click(toDelivered);
      const onDelivered = await playerIn();
      expect(onDelivered.getAttribute('src'), id).toBe(delivered.src);
      expect(screen.getByRole('button', { name: /^Web copy/ }), id).toBeInTheDocument();
      frame(onDelivered, film.width, film.height);
      expect([onDelivered.currentTime, plays], id).toEqual([42, 1]);
      expect(screen.getByText(`The delivered film · ${minutes} · ${film.width}×${film.height}`), id).toBeInTheDocument();

      // A second switch before the first has loaded keeps the moment the viewer saw, not the fresh element's 0.
      onDelivered.currentTime = 73;
      fireEvent.click(screen.getByRole('button', { name: /^Web copy/ }));
      fireEvent.click(screen.getByRole('button', { name: /^As delivered/ }));
      const back = await playerIn();
      expect(back.getAttribute('src'), id).toBe(delivered.src);
      frame(back, film.width, film.height);
      expect(back.currentTime, id).toBe(73);
    } finally {
      Object.defineProperty(HTMLMediaElement.prototype, 'play', play);
      Object.defineProperty(HTMLMediaElement.prototype, 'paused', paused);
    }
    cleanup();
  }
}, 60_000);
