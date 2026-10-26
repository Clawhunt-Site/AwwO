import { emptyDocument, type CanvasDocument, type CanvasNode } from '../canvas/canvasDoc';
import { mediaKindOf } from '../canvas/mediaCatalog';
import { SANDBOX_RUNTIME } from '../canvas/nodeRuntime';
import type { OfficialCopyModel } from './examples/OfficialCopySetup';
import type { ProductionRunRecord } from './productionRuns';
import { recordedCanvasText, type RecordedCanvas } from './recordedCanvasText';

export type { RecordedCanvas } from './recordedCanvasText';
export { recordedCanvasText };

/**
 * A recorded-canvas case (a film, 2026-10-20): the canvas a member copies is the run's own document, stored beside its
 * record (production-canvases/<case>.ts), not a workflow definition compiled into one. Its clips, takes, editors and
 * edits name each other's files by node id (an editor's brief lists `vid_s05_04/video-1.mp4`; an edit's own timeline
 * names `edit_R1/r1.mp4`), and a video numbers its pictures and its voice by where their nodes sit, so a compiled copy,
 * with fresh ids and its own layout, would not be the canvas that ran. scripts/showcase/publish-recorded-run.mjs writes
 * the stored document from the frozen documents of the graph runs that made each published output, without any binding,
 * conversation, output or run-time field; the record pins it by recordedCanvasText (recordedCanvasText.ts).
 */
/** Each stored canvas loads on its own when its case is copied; none is in the homepage bundle (its own folder, so the
 * tests that load every record do not load these too). */
const CANVASES = import.meta.glob<{ default: RecordedCanvas }>('./production-canvases/*.ts');
export function loadRecordedCanvas(id: string): Promise<RecordedCanvas | undefined> {
  const load = CANVASES[`./production-canvases/${id}.ts`];
  return load ? load().then(module => module.default) : Promise.resolve(undefined);
}

/**
 * A member's copy of a recorded canvas: the stored document as it ran, minted as a new canvas (its node ids stay, since
 * its texts name them), with nothing pre-filled: a film canvas's deliveries are files (clips, takes, cuts), which a copy
 * does not carry, and its editors' answers name the run's own clips, so the copy makes everything again on its first
 * run. An agent node takes the execution model a member picks (none: a draft); a media node keeps its media model,
 * which generates the pictures, clips and voices. An agent that works in its own sandbox computer (a film written as
 * code: it writes, runs and publishes files there) stays in it, as a flagship's copy does, and takes the chosen model
 * when the sandbox offers it, else the sandbox's own default.
 */
export function createRecordedCopyDocument(canvas: RecordedCanvas, model: OfficialCopyModel | null): CanvasDocument {
  const nodes = canvas.nodes.map((node): CanvasNode => {
    const copy = structuredClone(node) as CanvasNode;
    if (copy.kind === 'edit' || copy.kind === 'assemble') return { ...copy, lastOutput: null };
    if (copy.kind !== 'session') return copy;
    const fresh = { ...copy, binding: null, bindAttempt: null, issueId: null, preview: '', lastOutput: null };
    if (mediaKindOf(copy.agentKind) || !model) return fresh;
    if (copy.runtime === SANDBOX_RUNTIME) return { ...fresh, model: model.sandbox ? model.model : copy.model, effort: '' };
    return { ...fresh, runtime: model.runtime, model: model.model, effort: '' };
  });
  return { ...emptyDocument(), nodes, edges: canvas.edges.map(edge => ({ ...edge })) };
}

/** SHA-256 of a text's UTF-8 bytes, as hex; null where the browser offers no Web Crypto (an insecure context). */
async function sha256Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** The copy of a recorded-canvas case, made only while its stored canvas is still the one its record pins (the
 * SHA-256 of its recordedCanvasText, as the publisher computed it); null when it is not, or cannot be checked. */
export async function recordedCopyDocument(record: ProductionRunRecord, canvas: RecordedCanvas, model: OfficialCopyModel | null,
  digest: (text: string) => Promise<string | null> = sha256Hex): Promise<CanvasDocument | null> {
  if (record.canvas !== 'recorded') return null;
  const hash = await digest(recordedCanvasText(canvas)).catch(() => null);
  return hash !== null && hash === record.canvasSHA256 ? createRecordedCopyDocument(canvas, model) : null;
}
