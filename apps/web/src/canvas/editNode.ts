// An edit node (canvasDoc.ts EditNode): the pure parts its settings and card use. Its run is the API's (edits.go): the
// timeline wired into it or its own, the files the nodes wired into it delivered, ffmpeg on the render worker. Nothing
// here runs an edit; the worker checks a timeline in full, so this only says what is plainly wrong before a run.
import type { CanvasEdge, CanvasNode, EditNode } from './canvasDoc';
import { parseMediaOutput } from './mediaOutput';

export const EDIT_TIMELINE_SCHEMA = 'awwo.timeline/1';
/** The local engine's failure for an edit node: it runs only in a cloud canvas run (surfaceMessages.ts says so). */
export const EDIT_CLOUD_ONLY = 'edit_cloud_only';

/** The ports media come in by, and the medium each takes. */
const MEDIA_PORTS = { clips: 'video', sounds: 'audio', pictures: 'image' } as const;
type MediaPort = keyof typeof MEDIA_PORTS;

/** The `<node id>/<file name>` a timeline can name, by the port its node is wired to. */
export type EditWiredFiles = Record<MediaPort, string[]>;

/** The timeline in a text as the API finds it (timelineJSON in edits.go): the whole text when it is a JSON object, else
 *  its first fenced block, else the text from its first { to its last }. */
export function timelineJSON(text: string): string {
  const body = text.trim();
  if (body.startsWith('{')) return body;
  const fence = body.indexOf('```');
  if (fence >= 0) {
    let rest = body.slice(fence + 3);
    const newline = rest.indexOf('\n');
    if (newline >= 0) rest = rest.slice(newline + 1);
    const end = rest.indexOf('```');
    if (end >= 0) return rest.slice(0, end).trim();
  }
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  return first >= 0 && last > first ? body.slice(first, last + 1) : body;
}

export type EditTimelineIssue = 'not_json' | 'schema' | 'tracks';

/** What is plainly wrong with a timeline text (null for an empty one, which a wired timeline may stand in for): not a
 *  JSON object, another schema, or tracks that are not lists with at least one clip or card in tracks.video. */
export function editTimelineIssue(text: string): EditTimelineIssue | null {
  if (!text.trim()) return null;
  let value: unknown;
  try { value = JSON.parse(timelineJSON(text)); } catch { return 'not_json'; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not_json';
  const doc = value as Record<string, unknown>;
  if (doc.schema !== EDIT_TIMELINE_SCHEMA) return 'schema';
  const tracks = doc.tracks as Record<string, unknown> | undefined;
  if (!tracks || typeof tracks !== 'object' || Array.isArray(tracks) || !Object.values(tracks).every(Array.isArray)
    || !(tracks.video as unknown[] | undefined)?.length) return 'tracks';
  return null;
}

/** The name a node's first file gets before it has run: the API names generated files <kind>-<n>.<ext> (the extension is
 *  known once the file is), and an edit names its film after its timeline. */
function firstFileName(node: CanvasNode, medium: string): string {
  if (node.kind === 'edit') {
    try {
      const name = (JSON.parse(timelineJSON(node.timeline)) as { name?: unknown }).name;
      if (typeof name === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(name)) return `${name}.mp4`;
    } catch { /* no readable timeline: the worker's default name */ }
    return 'edit.mp4';
  }
  return medium === 'video' ? 'video-1.mp4' : medium === 'audio' ? 'audio-1.mp3' : 'image-1.png';
}

/**
 * The files a timeline can name from the nodes wired into this edit, by port, in the order a run reads its inputs (by
 * where the nodes sit, top to bottom, then left to right): each node's delivered files of that medium, or before it has
 * delivered, the name its first file gets.
 */
export function editWiredFiles(node: EditNode, nodes: ReadonlyArray<CanvasNode>, edges: ReadonlyArray<CanvasEdge>): EditWiredFiles {
  const byId = new Map(nodes.map(candidate => [candidate.id, candidate]));
  const files: EditWiredFiles = { clips: [], sounds: [], pictures: [] };
  const wired = edges.filter(edge => edge.toNode === node.id && Object.hasOwn(MEDIA_PORTS, edge.toPort) && byId.has(edge.fromNode))
    .sort((a, b) => {
      const left = byId.get(a.fromNode)!; const right = byId.get(b.fromNode)!;
      return left.y - right.y || left.x - right.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  for (const edge of wired) {
    const port = edge.toPort as MediaPort;
    const source = byId.get(edge.fromNode)!;
    const media = parseMediaOutput(source.lastOutput?.text);
    const names = media ? media.items.filter(item => item.contentType.startsWith(`${MEDIA_PORTS[port]}/`)).map(item => item.name)
      : [firstFileName(source, MEDIA_PORTS[port])];
    for (const name of names) {
      const path = `${source.id}/${name}`;
      if (!files[port].includes(path)) files[port].push(path);
    }
  }
  return files;
}

/** The schema's own starter timeline, naming the files wired in now (`<node id>/…` where none is): two cuts of a clip
 *  with a crossfade, a title card, a voice line anchored to the second cut, music, a looped effect, a subtitle and a mix. */
export function editTimelineExample(files: EditWiredFiles, locale: 'zh' | 'en' = 'zh'): string {
  const clip = files.clips[0] ?? '<node id>/video-1.mp4';
  const sound = files.sounds[0] ?? '<node id>/audio-1.mp3';
  const zh = locale === 'zh';
  const card = '<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#000;color:#fff;'
    + `font:600 72px system-ui,sans-serif">${zh ? '片名' : 'Title'}</body></html>`;
  return JSON.stringify({
    schema: EDIT_TIMELINE_SCHEMA, name: 'R1',
    output: { width: 1920, height: 822, fit: 'cover', fps: 24, crf: 18, loudnessLUFS: -16, truePeakDb: -1, stillsEverySeconds: 8 },
    tracks: {
      video: [
        { id: 'v1', source: clip, in: 0.2, out: 4.8 },
        { id: 'v2', source: files.clips[1] ?? clip, in: 0, out: 5, transition: { type: 'crossfade', seconds: 0.5 } },
        { id: 'title', card, seconds: 4, transition: { type: 'dip', seconds: 0.5 } },
      ],
      dialogue: [{ source: sound, anchor: 'v2', offset: 0.3, fx: 'dry' }],
      music: [{ source: files.sounds[1] ?? sound, at: 0, out: 30, fadeIn: 2, fadeOut: 3 }],
      sfx: [{ source: files.sounds[2] ?? files.sounds[1] ?? sound, at: 5, out: 20, loop: true }],
      subtitles: [{ anchor: 'v2', offset: 0.3, seconds: 2, text: zh ? '一句台词。' : 'A line.' }],
    },
    mix: { levels: { dialogue: -20, music: -26, sfx: -24 }, ducking: { music: -9, sfx: -6 }, silence: [{ start: 30, end: 32 }] },
  }, null, 2);
}
