import type { UiLocale } from '../locale';
import summary from './production-runs/summary.json';

type Localized = Readonly<Record<UiLocale, string>>;
export type ProductionNodeStatus = 'done' | 'failed' | 'blocked' | 'cancelled' | 'cached';

/** One node of a recorded case run, as the run stored it. Outputs are verbatim: the published
 * record is generated from the raw run (scripts/showcase/publish-run.mjs) and never edited. */
export interface ProductionRunNode {
  readonly id: string;
  readonly title: Localized;
  readonly column: number;
  readonly row: number;
  readonly status: ProductionNodeStatus;
  /** From admission to completion, in seconds. */
  readonly seconds?: number;
  readonly outputType: 'markdown' | 'html' | 'fields';
  /** The delivered field value: Markdown text or a complete HTML document. */
  readonly output?: string;
  /** Several named output fields, for a record whose nodes delivered more than one. */
  readonly fields?: ReadonlyArray<{ readonly id: string; readonly value: string }>;
  /** Why the node did not complete, exactly as recorded. */
  readonly detail?: string;
  readonly tokens?: { readonly input?: number; readonly output?: number };
}

/** One image or video node of a recorded case run, as the run stored it. */
export interface ProductionRunMedia {
  readonly id: string;
  readonly title: Localized;
  readonly kind: 'image' | 'video';
  readonly status: ProductionNodeStatus;
  readonly seconds?: number;
  /** The files it generated, by the `<node id>/<file name>` path the canvas handed the page. */
  readonly files: ReadonlyArray<string>;
  readonly detail?: string;
}

export interface ProductionRunRecord {
  readonly caseId: string;
  /** Where it ran, for the receipt. */
  readonly edition: Localized;
  readonly runtime: string;
  readonly model: string;
  /** YYYY-MM-DD, UTC. */
  readonly capturedOn: string;
  /** Wall time of the whole graph run. */
  readonly seconds: number;
  readonly completed: number;
  readonly total: number;
  /** The language the agents worked in; the outputs are shown as delivered. */
  readonly outputLocale: UiLocale;
  /** `thinking: false` when the runtime switched the model's hidden reasoning off. */
  readonly limits?: { readonly contextWindow: number; readonly maxOutputTokens: number; readonly modelCallsPerNode: number; readonly concurrency: number; readonly thinking: boolean };
  readonly source?: { readonly api: string; readonly worker: string };
  /** SHA-256 of the canvas text the run ran with (productionCanvasText.ts); absent for a record that
   * did not run on a canvas from productionWorkflows.ts. */
  readonly canvasSHA256?: string;
  readonly artifactNodeId?: string;
  readonly artifactSHA256?: string;
  readonly nodes: ReadonlyArray<ProductionRunNode>;
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string; readonly label: Localized }>;
  /** The canvas's image and video nodes (not agents, so not in `nodes`): what each generated in this run. Their files,
   * shrunk, are in production-runs/<case>.media.ts, keyed by the `<node id>/<file>` paths the page names. */
  readonly media?: ReadonlyArray<ProductionRunMedia>;
  /** What happened in the run, failures included. */
  readonly note: Localized;
  /** What was checked in a browser before publishing, and only that. */
  readonly verification: Localized;
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
  /** The language the agents worked in. */
  readonly outputLocale: UiLocale;
}
// summary.json types its locale as a plain string; tests pin every entry to its published record.
export const PRODUCTION_RUN_SUMMARY = summary as Readonly<Record<string, ProductionRunSummary>>;

/** Each record loads on its own when its case opens; none is in the homepage bundle. */
const RECORDS = import.meta.glob<{ default: ProductionRunRecord }>(['./production-runs/*.ts', '!./production-runs/*.media.ts']);
export function loadProductionRun(id: string): Promise<ProductionRunRecord | undefined> {
  const load = RECORDS[`./production-runs/${id}.ts`];
  return load ? load().then(module => module.default) : Promise.resolve(undefined);
}

/** A media case's generated files as data: URLs, keyed by the paths its page names; loaded with the case, never before. */
const MEDIA = import.meta.glob<{ default: Readonly<Record<string, string>> }>('./production-runs/*.media.ts');
export function loadProductionMedia(id: string): Promise<Readonly<Record<string, string>>> {
  const load = MEDIA[`./production-runs/${id}.media.ts`];
  return load ? load().then(module => module.default) : Promise.resolve({});
}
