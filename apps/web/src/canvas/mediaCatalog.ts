import type { UiLocale } from '../locale';
import { api, tenantPath } from '../saas/api';
import { currentSaaSCanvas } from '../saas/canvasBridge';
import type { MediaParams, MediaParamValue } from './canvasDoc';

// The image and video models this workspace can run, as the server publishes them. The server is
// the only source: no model, parameter or choice is named here, a malformed entry is dropped rather
// than repaired, and a parameter's default is only ever displayed — an untouched parameter stays
// absent from the node, and the server applies the model's default when the run is admitted.

export type MediaKind = 'image' | 'video';
export type MediaParamType = 'enum' | 'integer' | 'number' | 'boolean' | 'text';

export interface MediaParam {
  name: string;
  type: MediaParamType;
  values?: string[];
  min?: number;
  max?: number;
  maxLength?: number;
  default?: MediaParamValue;
  /** [Chinese, English]. */
  label: [string, string];
}

export interface MediaModel {
  id: string;
  name: string;
  vendor: string;
  kind: MediaKind;
  prompt: { minLength: number; maxLength: number };
  params: MediaParam[];
}

export interface MediaCatalogue {
  configured: boolean;
  available: boolean;
  models: MediaModel[];
  runsPerDay: number;
  timeoutSeconds: number;
}

const PARAM_NAME = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
const MODEL_ID = /^rh\.[a-z0-9][a-z0-9-]{0,62}$/;
const PARAM_TYPES: ReadonlySet<string> = new Set(['enum', 'integer', 'number', 'boolean', 'text']);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const label = (value: unknown): value is [string, string] =>
  Array.isArray(value) && value.length === 2 && value.every(part => typeof part === 'string' && part.length > 0 && part.length <= 40);

function parseParam(raw: unknown): MediaParam | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || !PARAM_NAME.test(r.name) || typeof r.type !== 'string' || !PARAM_TYPES.has(r.type) || !label(r.label)) return null;
  const param: MediaParam = { name: r.name, type: r.type as MediaParamType, label: [r.label[0], r.label[1]] };
  switch (param.type) {
    case 'enum': {
      if (!Array.isArray(r.values) || !r.values.length || r.values.some(value => typeof value !== 'string')) return null;
      param.values = r.values as string[];
      if (typeof r.default !== 'string' || !param.values.includes(r.default)) return null;
      param.default = r.default;
      break;
    }
    case 'integer':
    case 'number': {
      if (!finite(r.min) || !finite(r.max) || r.min > r.max) return null;
      param.min = r.min; param.max = r.max;
      if (r.default !== undefined) {
        if (!finite(r.default) || r.default < r.min || r.default > r.max) return null;
        param.default = r.default;
      }
      break;
    }
    case 'boolean':
      if (typeof r.default !== 'boolean') return null;
      param.default = r.default;
      break;
    case 'text':
      if (!finite(r.maxLength) || r.maxLength < 1) return null;
      param.maxLength = r.maxLength;
      break;
  }
  return param;
}

function parseModel(raw: unknown): MediaModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const prompt = r.prompt as Record<string, unknown> | undefined;
  if (typeof r.id !== 'string' || !MODEL_ID.test(r.id) || typeof r.name !== 'string' || !r.name || r.name.length > 80
    || typeof r.vendor !== 'string' || !r.vendor || (r.kind !== 'image' && r.kind !== 'video')
    || !prompt || !finite(prompt.minLength) || !finite(prompt.maxLength) || !Array.isArray(r.params)) return null;
  const params: MediaParam[] = [];
  for (const entry of r.params) {
    const param = parseParam(entry);
    // A model whose parameters cannot be read cannot be configured honestly; drop the model.
    if (!param) return null;
    params.push(param);
  }
  return { id: r.id, name: r.name, vendor: r.vendor, kind: r.kind, prompt: { minLength: prompt.minLength, maxLength: prompt.maxLength }, params };
}

export function parseMediaCatalogue(raw: unknown): MediaCatalogue {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const limits = r.limits && typeof r.limits === 'object' ? r.limits as Record<string, unknown> : {};
  const models: MediaModel[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(r.models) ? r.models : []) {
    const model = parseModel(entry);
    if (model && !seen.has(model.id)) { seen.add(model.id); models.push(model); }
  }
  const configured = r.configured === true;
  return { configured, available: configured && r.available === true && models.length > 0, models: configured ? models : [],
    runsPerDay: finite(limits.runsPerDay) ? limits.runsPerDay : 0, timeoutSeconds: finite(limits.timeoutSeconds) ? limits.timeoutSeconds : 0 };
}

/** The current workspace's media catalogue. */
export async function readMediaCatalogue(signal?: AbortSignal): Promise<MediaCatalogue> {
  signal?.throwIfAborted();
  const captured = currentSaaSCanvas();
  if (!captured) throw new Error('No workspace canvas is open');
  const raw = await api<unknown>(tenantPath(captured.tenant.id, '/media'), { signal });
  signal?.throwIfAborted();
  if (currentSaaSCanvas() !== captured) throw new Error('The workspace changed');
  return parseMediaCatalogue(raw);
}

export const mediaKindOf = (agentKind: string): MediaKind | null => agentKind === 'image' || agentKind === 'video' ? agentKind : null;

export function mediaModelsOf(catalogue: MediaCatalogue | null | undefined, kind: MediaKind): MediaModel[] {
  return catalogue?.available ? catalogue.models.filter(model => model.kind === kind) : [];
}

/** The value a control shows: the node's choice, or the model's default when there is none. */
export function mediaParamValue(param: MediaParam, params: MediaParams | undefined): MediaParamValue | undefined {
  return params && Object.hasOwn(params, param.name) ? params[param.name] : param.default;
}

/**
 * The same closed rules the server applies at admission, so a choice it would refuse cannot be
 * saved: every key belongs to the model, every value has the parameter's type and lies within its
 * choices or range. Returns the names of the parameters that fail.
 */
export function invalidMediaParams(model: MediaModel, params: MediaParams | undefined): string[] {
  if (!params) return [];
  const failed: string[] = [];
  for (const [name, value] of Object.entries(params)) {
    const param = model.params.find(entry => entry.name === name);
    if (!param || !validMediaValue(param, value)) failed.push(name);
  }
  return failed;
}

function validMediaValue(param: MediaParam, value: MediaParamValue): boolean {
  switch (param.type) {
    case 'enum': return typeof value === 'string' && Boolean(param.values?.includes(value));
    case 'integer': return typeof value === 'number' && Number.isInteger(value) && value >= param.min! && value <= param.max!;
    case 'number': return typeof value === 'number' && Number.isFinite(value) && value >= param.min! && value <= param.max!;
    case 'boolean': return typeof value === 'boolean';
    case 'text': return typeof value === 'string' && [...value].length <= param.maxLength! && !value.includes('\u0000');
  }
}

/** Set one parameter; choosing the default again removes the key, so the node keeps no copy of it. */
export function withMediaParam(params: MediaParams | undefined, param: MediaParam, value: MediaParamValue | undefined): MediaParams {
  const next: MediaParams = { ...(params ?? {}) };
  if (value === undefined || value === param.default || (param.type === 'text' && value === '')) delete next[param.name];
  else next[param.name] = value;
  return next;
}

const VENDORS: Record<string, [string, string]> = {
  bytedance: ['字节跳动', 'ByteDance'], google: ['Google', 'Google'], openai: ['OpenAI', 'OpenAI'], alibaba: ['阿里巴巴', 'Alibaba'],
  midjourney: ['Midjourney', 'Midjourney'], xai: ['xAI', 'xAI'], kuaishou: ['快手', 'Kuaishou'], minimax: ['MiniMax', 'MiniMax'],
  shengshu: ['生数科技', 'Shengshu'], pixverse: ['PixVerse', 'PixVerse'],
};

/** A display name for a vendor slug; an unknown slug is shown as it is. */
export function mediaVendorLabel(vendor: string, locale: UiLocale): string {
  const known = VENDORS[vendor];
  return known ? known[locale === 'zh' ? 0 : 1] : vendor;
}
