import type { UiLocale } from '../locale';
import summary from './production-runs/summary.json';

export type ProductionNodeStatus = 'done' | 'failed' | 'blocked' | 'cancelled' | 'cached';

/** One node of a recorded case run, as the run stored it. Outputs are verbatim: the published
 * record is generated from the raw run (scripts/showcase/publish-run.mjs) and never edited. */
export interface ProductionRunNode {
  readonly id: string;
  readonly title: string;
  readonly column: number;
  readonly row: number;
  readonly status: ProductionNodeStatus;
  /** From admission to completion, in seconds. */
  readonly seconds?: number;
  /** `text`: code or data (a module, a sheet, a timeline), shown as it is rather than as Markdown. */
  readonly outputType: 'markdown' | 'html' | 'video' | 'text';
  /** The delivered field value: Markdown text, a complete HTML document, or plain text. */
  readonly output?: string;
  /** A recorded canvas's agent: its other text fields beside the result and the report (a director's sheet), verbatim. */
  readonly extras?: ReadonlyArray<{ readonly label: string; readonly text: string }>;
  /** Why the node did not complete, exactly as recorded. */
  readonly detail?: string;
  /** Over all of the node's model calls. */
  readonly tokens?: { readonly input?: number; readonly output?: number };
  /** An assemble node: it made its page from the modules by its template, with no model. An edit node: it joined clips
   * and sounds into a film (`film`), with no model. */
  readonly kind?: 'assemble' | 'edit';
  /** The file an assemble node made, as the run stored it. */
  readonly file?: { readonly name: string; readonly bytes: number };
  /** An assemble node with no inputs: its file is its template alone (a tool file, such as Errand's recorder). */
  readonly fromTemplate?: true;
  /** The node worked in its own sandbox computer: real files, commands and checks. */
  readonly sandbox?: true;
  /** How many model calls the node made, when more than one. */
  readonly calls?: number;
  /** A second, Markdown output beside the result: what the node reports for those downstream. */
  readonly report?: string;
  /** An edit node (a recorded canvas's): it joined clips and sounds into a film by a timeline, with no model. */
  readonly film?: ProductionRunFilm;
  /** A recorded canvas's agent: its brief (persona) exactly as it ran, since no workflow definition holds it. */
  readonly brief?: string;
}

/** The film an edit node delivered, as its run stored it (the API's edit facts, edit_outputs.go). */
export interface ProductionRunFilm {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly seconds: number;
  readonly frames: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly loudness?: { readonly integratedLUFS: number; readonly truePeakDb: number; readonly rangeLU?: number };
  readonly warnings: ReadonlyArray<string>;
  /** The timeline's still interval: still n (from 1) is the frame at (n − 1) × this many seconds. */
  readonly stillsEverySeconds?: number;
  /** Its timeline: the answer of the agent wired into it (`from`), or its own, written on the node (`own`). */
  readonly timeline: { readonly from: string } | { readonly own: string };
}

/** One image, video, 3D model or audio node of a recorded case run, as the run stored it. */
export interface ProductionRunMedia {
  readonly id: string;
  readonly title: string;
  readonly kind: 'image' | 'video' | 'model3d' | 'audio';
  readonly status: ProductionNodeStatus;
  readonly seconds?: number;
  /** The files it generated, by the `<node id>/<file name>` path the canvas handed the page. */
  readonly files: ReadonlyArray<string>;
  readonly detail?: string;
  /** A recorded canvas's media node: its stage (dependency depth) and place, and the words it generated from. */
  readonly column?: number;
  readonly row?: number;
  readonly words?: string;
}

export interface ProductionRunRecord {
  readonly caseId: string;
  /** Where it ran, for the receipt. */
  readonly edition: string;
  readonly runtime: string;
  readonly model: string;
  /** YYYY-MM-DD, UTC. */
  readonly capturedOn: string;
  /** Wall time of the whole graph run: from the first run's start to the last one's end. */
  readonly seconds: number;
  /** A canvas that ran again for what had not finished: how many graph runs there were (more than one), and how long
   * they took, without the time between them. */
  readonly runs?: number;
  readonly activeSeconds?: number;
  readonly completed: number;
  readonly total: number;
  /** `thinking: false` when the runtime switched the model's hidden reasoning off. */
  readonly limits: { readonly contextWindow: number; readonly maxOutputTokens: number; readonly modelCallsPerNode: number; readonly concurrency: number; readonly thinking: boolean };
  /** The revisions the run ran on. When its nodes ran on more than one (a canvas that ran again between releases),
   * `runs` says which nodes ran on which, in order; `api` and `worker` are then the last run's. */
  readonly source: { readonly api: string; readonly worker: string;
    readonly runs?: ReadonlyArray<{ readonly api: string; readonly worker: string; readonly nodes: ReadonlyArray<string> }>;
    /** A recorded canvas's media nodes, by the API release that ran each one's graph run (they run in the API itself). */
    readonly media?: ReadonlyArray<{ readonly api: string; readonly nodes: ReadonlyArray<string> }> };
  /** SHA-256 of the canvas text the run ran with (productionCanvasText.ts; for a recorded canvas, recordedCanvas.ts). */
  readonly canvasSHA256: string;
  /** The case's canvas is the run's own document, stored beside its record (production-canvases/<case>.ts), not a
   * workflow definition compiled into one: a film case, whose clips, takes and timelines name each other by node id. */
  readonly canvas?: 'recorded';
  readonly artifactNodeId?: string;
  readonly artifactSHA256?: string;
  readonly nodes: ReadonlyArray<ProductionRunNode>;
  /** The canvas's wires, as the workflow declares them: `port` when a wire carries a file or a report. */
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string; readonly label: string; readonly port?: 'file' | 'report' }>;
  /** The canvas's image, video and 3D model nodes (not agents, so not in `nodes`): what each generated in this run.
   * Their files are published as static files (production-runs/<case>.media.json lists them), keyed by the
   * `<node id>/<file>` paths the page names. */
  readonly media?: ReadonlyArray<ProductionRunMedia>;
  /** What happened in the run, failures included. */
  readonly note: string;
  /** What was checked in a browser before publishing, and only that. */
  readonly verification: string;
}

/** 44 分 24 秒 / 44 min 24 s; under a minute in seconds only. */
export function formatDuration(seconds: number, locale: UiLocale): string {
  const total = Math.max(0, Math.round(seconds)), minutes = Math.floor(total / 60), rest = total % 60;
  if (locale === 'zh') return minutes ? `${minutes} 分${rest ? ` ${rest} 秒` : '钟'}` : `${rest} 秒`;
  return minutes ? `${minutes} min${rest ? ` ${rest} s` : ''}` : `${rest} s`;
}

/** What a homepage card shows about its run, without loading the record. */
export interface ProductionRunSummary {
  readonly completed: number;
  readonly total: number;
  readonly seconds: number;
  /** The run delivered the case's deliverable. */
  readonly delivered: boolean;
  readonly capturedOn: string;
  readonly model: string;
  readonly runtime: string;
  /** A case with image or video nodes: how many of them completed (nodes, but not agents). */
  readonly media?: { readonly completed: number; readonly total: number };
}
// Tests pin every summary.json entry to its published record.
export const PRODUCTION_RUN_SUMMARY = summary as Readonly<Record<string, ProductionRunSummary>>;

/** Each record loads on its own when its case opens; none is in the homepage bundle. */
const RECORDS = import.meta.glob<{ default: ProductionRunRecord }>('./production-runs/*.ts');
export function loadProductionRun(id: string): Promise<ProductionRunRecord | undefined> {
  const load = RECORDS[`./production-runs/${id}.ts`];
  return load ? load().then(module => module.default) : Promise.resolve(undefined);
}

/** One generated file of a media case, published beside the homepage's case footage (showcase/media/<case>/), named by
 * its content so a cached copy can never be a stale one. Pictures and clips are re-encoded for the web when published
 * (scripts/showcase/publish-run.mjs); 3D models are the files the run made. */
export interface ProductionMediaFile {
  /** Its URL on this site, e.g. /showcase/media/neon-circuit/1f2e3d4c5b6a7980.glb */
  readonly src: string;
  readonly type: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Staged on the host once, outside the web releases (a film is too large to ship with every release): streamed
   * from its URL, never fetched whole (loadProductionMedia skips it). */
  readonly staged?: true;
  /** A film's web copy: the file the edit delivered, byte for byte, offered for download beside it. */
  readonly original?: { readonly src: string; readonly bytes: number; readonly sha256: string };
}

/** A media case's files by the `<node id>/<file>` path its page names (production-runs/<case>.media.json). */
const MEDIA = import.meta.glob<{ default: Readonly<Record<string, ProductionMediaFile>> }>('./production-runs/*.media.json');
export function loadProductionMediaManifest(id: string): Promise<Readonly<Record<string, ProductionMediaFile>>> {
  const load = MEDIA[`./production-runs/${id}.media.json`];
  return load ? load().then(module => module.default) : Promise.resolve({});
}

function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * A media case's generated files as data: URLs keyed by the paths its page names, fetched from this site when the case
 * opens, never before: the sandboxed page runs in an opaque origin that reaches no network, so the files go in as
 * data. All or nothing: a file that cannot be fetched, is not the size published, or is not here within the deadline
 * rejects the whole load (production_media_unavailable), so a case's page is never shown without the files it uses;
 * its dialog offers to try again. The deadline also covers the manifest's own chunk, so a stalled chunk ends in that
 * offer too rather than in a dialog that never stops loading. Once the manifest is here, the files get the deadline
 * again plus the time their bytes take at 128 KiB/s (PALLWARD's 88 files are 22.6 MB: 120 s alone needed 1.5 Mbit/s,
 * now about 0.6 do, and a dead connection is given up after about 5 minutes).
 */
export async function loadProductionMedia(id: string, fetchFile: typeof fetch = (input, init) => fetch(input, init),
  deadlineMs = 120_000, loadManifest: typeof loadProductionMediaManifest = loadProductionMediaManifest,
  slowBytesPerSecond = 128 * 1024): Promise<Readonly<Record<string, string>>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expire: (error: Error) => void = () => {};
  const deadline = new Promise<never>((_, reject) => { expire = reject; });
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => { controller.abort(); expire(new Error('production_media_unavailable')); }, ms);
  };
  arm(deadlineMs);
  try {
    const entries = await Promise.race([loadManifest(id).then(manifest => {
      // A manifest that came after the deadline starts nothing.
      if (controller.signal.aborted) throw new Error('production_media_unavailable');
      const bytes = Object.values(manifest).filter(file => !file.staged).reduce((sum, file) => sum + file.bytes, 0);
      arm(deadlineMs + Math.ceil((bytes / slowBytesPerSecond) * 1000));
      return manifest;
    // A staged file (a film) streams from its URL in its own player and is never fetched whole.
    }).then(manifest => Promise.all(Object.entries(manifest).filter(([, file]) => !file.staged).map(async ([path, file]) => {
      const response = await fetchFile(file.src, { credentials: 'omit', signal: controller.signal });
      if (!response.ok) throw new Error('production_media_unavailable');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== file.bytes) throw new Error('production_media_unavailable');
      return [path, await asDataUrl(new Blob([bytes], { type: file.type }))] as const;
    }))), deadline]);
    return Object.fromEntries(entries);
  } catch {
    // One file failed: the others stop downloading too.
    controller.abort();
    throw new Error('production_media_unavailable');
  } finally {
    clearTimeout(timer);
  }
}
