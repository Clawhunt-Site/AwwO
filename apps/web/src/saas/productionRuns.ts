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
  readonly outputType: 'markdown' | 'html';
  /** The delivered field value: Markdown text or a complete HTML document. */
  readonly output?: string;
  /** Why the node did not complete, exactly as recorded. */
  readonly detail?: string;
  readonly tokens?: { readonly input?: number; readonly output?: number };
}

/** One image, video or 3D model node of a recorded case run, as the run stored it. */
export interface ProductionRunMedia {
  readonly id: string;
  readonly title: string;
  readonly kind: 'image' | 'video' | 'model3d';
  readonly status: ProductionNodeStatus;
  readonly seconds?: number;
  /** The files it generated, by the `<node id>/<file name>` path the canvas handed the page. */
  readonly files: ReadonlyArray<string>;
  readonly detail?: string;
}

export interface ProductionRunRecord {
  readonly caseId: string;
  /** Where it ran, for the receipt. */
  readonly edition: string;
  readonly runtime: string;
  readonly model: string;
  /** YYYY-MM-DD, UTC. */
  readonly capturedOn: string;
  /** Wall time of the whole graph run. */
  readonly seconds: number;
  readonly completed: number;
  readonly total: number;
  /** `thinking: false` when the runtime switched the model's hidden reasoning off. */
  readonly limits: { readonly contextWindow: number; readonly maxOutputTokens: number; readonly modelCallsPerNode: number; readonly concurrency: number; readonly thinking: boolean };
  readonly source: { readonly api: string; readonly worker: string };
  /** SHA-256 of the canvas text the run ran with (productionCanvasText.ts). */
  readonly canvasSHA256: string;
  readonly artifactNodeId?: string;
  readonly artifactSHA256?: string;
  readonly nodes: ReadonlyArray<ProductionRunNode>;
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string; readonly label: string }>;
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
 * its dialog offers to try again.
 */
export async function loadProductionMedia(id: string, fetchFile: typeof fetch = (input, init) => fetch(input, init),
  deadlineMs = 120_000): Promise<Readonly<Record<string, string>>> {
  const manifest = await loadProductionMediaManifest(id);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('production_media_unavailable')); }, deadlineMs);
  });
  try {
    const entries = await Promise.race([Promise.all(Object.entries(manifest).map(async ([path, file]) => {
      const response = await fetchFile(file.src, { credentials: 'omit', signal: controller.signal });
      if (!response.ok) throw new Error('production_media_unavailable');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== file.bytes) throw new Error('production_media_unavailable');
      return [path, await asDataUrl(new Blob([bytes], { type: file.type }))] as const;
    })), deadline]);
    return Object.fromEntries(entries);
  } catch {
    // One file failed: the others stop downloading too.
    controller.abort();
    throw new Error('production_media_unavailable');
  } finally {
    clearTimeout(timer);
  }
}
