// The curated Bedrock catalog (bedrock-models.json) and the settings that turn it into
// worker model profiles. Shared by the Pi and OpenAI Agents workers; the Python worker
// reads the same JSON with an equivalent loader.
//
// Settings (each worker reads its own environment):
//   AWWO_BEDROCK_CATALOG   ''/off (default); builtin: the models verified with a real call;
//                          builtin-all: also those that need cross-region inference permission
//   AWWO_BEDROCK_REGION    Bedrock runtime region, default us-east-1
//   AWWO_BEDROCK_MODELS    empty: every entry the mode offers whose preferred runtime is this
//                          worker; otherwise a comma list of catalog ids (an explicit opt-in)
//   AWWO_BEDROCK_API_KEY   optional Bedrock API key (bearer); without it the worker signs
//                          with its own AWS credential chain (an EC2 instance role)
//   AWWO_PLATFORM_PROVIDERS  operator destinations allowed under AWWO_LLMGATE_ONLY,
//                          default llmgate; add bedrock to allow Bedrock profiles there
import { readFileSync } from 'node:fs';
import { BEDROCK_REGIONS, bedrockBridgeBaseURL, validBedrockRegion } from './bedrock-bridge.ts';

export type BedrockRuntime = 'pi' | 'openai-agents';
export type BedrockCatalogEntry = Readonly<{
  id: string; name: string; vendor: string; target: string;
  contextWindow: number; maxTokens: number; input: readonly string[];
  tools: boolean; runtime: BedrockRuntime; verified: string;
}>;
export type BedrockProfile = Readonly<{
  id: string; provider: 'bedrock'; model: string; name: string; vendor: string;
  region: string; baseURL: string; apiKey: string; contextWindow: number; maxTokens: number;
}>;

export const PLATFORM_PROVIDERS: readonly string[] = Object.freeze(['llmgate', 'bedrock']);
const ENTRY_FIELDS = ['id', 'name', 'vendor', 'target', 'contextWindow', 'maxTokens', 'input', 'tools', 'runtime', 'verified'];
const CATALOG_ID = /^bedrock\.[a-z0-9][a-z0-9-]{0,62}$/;
// A Converse modelId: an optional geographic/global profile prefix, a provider and a model.
const TARGET = /^(?:(?:global|us|eu|apac|jp|au|ca)\.)?[a-z0-9-]+\.[A-Za-z0-9.:-]{1,120}$/;
const VENDOR = /^[a-z][a-z0-9-]{0,31}$/;
const BEARER = /^[\x21-\x7e]{16,8192}$/;
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

function validName(name: unknown): name is string {
  if (typeof name !== 'string' || /[\p{Cc}\p{Cf}]/u.test(name) || [...name].length < 1 || [...name].length > 80) return false;
  // encodeURIComponent throws on a lone surrogate, so this is String#isWellFormed on ES2023.
  try { encodeURIComponent(name); return true; } catch { return false; }
}

export type BedrockCatalog = Readonly<{ regions: readonly string[]; entries: readonly BedrockCatalogEntry[] }>;

/**
 * The strictly validated catalog: the regions its entries were verified in and the entries in
 * file order. Model IDs and inference profiles differ by region, so the catalog names where it
 * holds. A malformed file stops the worker instead of guessing.
 */
export function parseBedrockCatalogFile(value: unknown): BedrockCatalog {
  const fail = (): never => { throw new Error('The Bedrock model catalog is invalid'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const catalog = value as Record<string, unknown>;
  if (catalog.version !== 1 || !Array.isArray(catalog.models) || catalog.models.length < 1 || catalog.models.length > 255) return fail();
  const regions = catalog.regions;
  if (!Array.isArray(regions) || regions.length < 1 || new Set(regions).size !== regions.length || !regions.every(validBedrockRegion)) return fail();
  const ids = new Set<string>();
  const targets = new Set<string>();
  const entries = (catalog.models as unknown[]).map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail();
    const e = item as Record<string, unknown>;
    if (Object.keys(e).length !== ENTRY_FIELDS.length || ENTRY_FIELDS.some(key => !Object.hasOwn(e, key))) return fail();
    if (typeof e.id !== 'string' || !CATALOG_ID.test(e.id) || ids.has(e.id)
      || !validName(e.name) || typeof e.vendor !== 'string' || !VENDOR.test(e.vendor)
      || typeof e.target !== 'string' || !TARGET.test(e.target) || targets.has(e.target)
      || !integer(e.contextWindow, 4096, 2_000_000) || !integer(e.maxTokens, 128, 32_768)
      || (e.maxTokens as number) + 256 >= (e.contextWindow as number)
      || !Array.isArray(e.input) || !e.input.length || e.input.some(kind => kind !== 'text' && kind !== 'image') || !e.input.includes('text')
      || typeof e.tools !== 'boolean' || (e.runtime !== 'pi' && e.runtime !== 'openai-agents')
      // The OpenAI Agents runtime offers tools and project execution, so it only hosts tool-capable models.
      || (e.runtime === 'openai-agents' && e.tools !== true)
      || typeof e.verified !== 'string' || (e.verified !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(e.verified))) return fail();
    ids.add(e.id);
    targets.add(e.target);
    return Object.freeze({ id: e.id, name: e.name as string, vendor: e.vendor, target: e.target,
      contextWindow: e.contextWindow as number, maxTokens: e.maxTokens as number, input: Object.freeze([...(e.input as string[])]),
      tools: e.tools, runtime: e.runtime as BedrockRuntime, verified: e.verified });
  });
  return Object.freeze({ regions: Object.freeze([...(regions as string[])]), entries: Object.freeze(entries) });
}
/** The entries of a strictly validated catalog. */
export function parseBedrockCatalog(value: unknown): readonly BedrockCatalogEntry[] {
  return parseBedrockCatalogFile(value).entries;
}

let builtin: BedrockCatalog | undefined;
function builtinCatalog(): BedrockCatalog {
  builtin ??= parseBedrockCatalogFile(JSON.parse(readFileSync(new URL('./bedrock-models.json', import.meta.url), 'utf8')));
  return builtin;
}
export function readBedrockCatalog(): readonly BedrockCatalogEntry[] { return builtinCatalog().entries; }
/** The regions the built-in catalog was verified in. */
export function readBedrockCatalogRegions(): readonly string[] { return builtinCatalog().regions; }

/** The platform destinations an operator allows under AWWO_LLMGATE_ONLY. LLM Gate is always first. */
export function parsePlatformProviders(value: string | undefined): readonly string[] {
  const list = value === undefined || value.trim() === '' ? ['llmgate'] : value.split(',').map(item => item.trim());
  if (list.some(item => !PLATFORM_PROVIDERS.includes(item)) || new Set(list).size !== list.length || !list.includes('llmgate')) {
    throw new Error(`AWWO_PLATFORM_PROVIDERS must list distinct values from ${PLATFORM_PROVIDERS.join(', ')} and include llmgate`);
  }
  return Object.freeze(PLATFORM_PROVIDERS.filter(item => list.includes(item)));
}

/**
 * The platform destinations a worker's profiles actually reach, in canonical order: LLM Gate,
 * plus Bedrock only when a profile uses it. Health claims these, never the wider policy, so a
 * worker whose policy allows Bedrock but which serves no Bedrock model stays exactly Gate-only.
 */
export function platformProvidersInUse(policy: readonly string[], models: readonly { provider: string }[]): readonly string[] {
  return Object.freeze(policy.filter(item => item === 'llmgate' || models.some(model => model.provider === item)));
}

/** Bedrock is an operator destination: a worker serving personal connections refuses it at startup. */
export function assertOperatorOnlyBedrock(userCredentials: boolean, models: readonly { provider: string }[]): void {
  if (userCredentials && models.some(model => model.provider === 'bedrock')) {
    throw new Error('Bedrock models use operator credentials; a worker with AWWO_CREDENTIAL_MODE=user serves personal LLM Gate connections only');
  }
}

/** Health fields for the platform policy. A Gate-only worker reports exactly what it did before. */
export function platformHealth(llmgateOnly: boolean, providers: readonly string[]): Record<string, unknown> {
  if (!llmgateOnly) return {};
  return providers.length === 1 ? { llmgateOnly: true } : { platformOnly: true, platformProviders: [...providers] };
}

export function bedrockRegion(env: Record<string, string | undefined>): string {
  const region = (env.AWWO_BEDROCK_REGION ?? '').trim() || 'us-east-1';
  if (!validBedrockRegion(region)) throw new Error(`AWWO_BEDROCK_REGION must be one of ${BEDROCK_REGIONS.join(', ')}`);
  return region;
}

/** A Bedrock API key when one is configured; otherwise '' and the worker signs with its AWS credentials. */
export function bedrockApiKey(env: Record<string, string | undefined>, name = 'AWWO_BEDROCK_API_KEY'): string {
  const key = (env[name] ?? '').trim();
  if (key && !BEARER.test(key)) throw new Error(`${name} is not a valid Bedrock API key`);
  return key;
}

export function bedrockProfile(entry: Pick<BedrockCatalogEntry, 'id' | 'name' | 'vendor' | 'target' | 'contextWindow' | 'maxTokens'>, region: string, apiKey: string): BedrockProfile {
  return Object.freeze({ id: entry.id, provider: 'bedrock', model: entry.target, name: entry.name, vendor: entry.vendor,
    region, baseURL: bedrockBridgeBaseURL(region), apiKey, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens });
}

/** Profiles the built-in catalog contributes to one worker, or none when the catalog is off. */
export function bedrockCatalogProfiles(runtime: BedrockRuntime, env: Record<string, string | undefined>,
  catalogEntries?: readonly BedrockCatalogEntry[], catalogRegions?: readonly string[]): readonly BedrockProfile[] {
  const mode = (env.AWWO_BEDROCK_CATALOG ?? '').trim();
  if (mode === '' || mode === 'off') return Object.freeze([]);
  if (mode !== 'builtin' && mode !== 'builtin-all') throw new Error('AWWO_BEDROCK_CATALOG must be off, builtin or builtin-all');
  // The file is read only when the catalog is on, so a worker without Bedrock never depends on it.
  const entries = catalogEntries ?? readBedrockCatalog();
  const regions = catalogRegions ?? readBedrockCatalogRegions();
  const region = bedrockRegion(env);
  // In another region the same IDs may be missing or need other inference profiles.
  if (!regions.includes(region)) {
    throw new Error(`the built-in catalog is verified for ${regions.join(', ')}; for ${region} verify the models with scripts/bedrock-catalog-check.py and configure them as explicit MODELS_JSON profiles`);
  }
  const apiKey = bedrockApiKey(env);
  const raw = (env.AWWO_BEDROCK_MODELS ?? '').trim();
  let selected: readonly BedrockCatalogEntry[];
  // An entry without a verified call (one that needs cross-region inference permission) is only
  // offered once the operator says the account can call it: builtin-all, or naming it below.
  if (!raw) selected = entries.filter(entry => entry.runtime === runtime && (mode === 'builtin-all' || entry.verified !== ''));
  else {
    const ids = raw.split(',').map(id => id.trim());
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('AWWO_BEDROCK_MODELS must be a comma list of distinct catalog ids');
    for (const id of ids) {
      const entry = entries.find(item => item.id === id);
      if (!entry) throw new Error('AWWO_BEDROCK_MODELS names a model that is not in the Bedrock catalog');
      if (runtime === 'openai-agents' && !entry.tools) throw new Error('AWWO_BEDROCK_MODELS names a model without tool support for the OpenAI Agents runtime');
    }
    selected = entries.filter(entry => ids.includes(entry.id));
  }
  return Object.freeze(selected.map(entry => bedrockProfile(entry, region, apiKey)));
}
