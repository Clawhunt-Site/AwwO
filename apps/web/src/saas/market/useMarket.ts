// What the market's surfaces read once and share: whether a workspace has the market (its capabilities), whether its
// owner's plan can pay a paid Agent (route-usage's plan), and the details of the Agents nodes are using, kept for the
// page so every card, chip and settings box of the same Agent reads one request.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, SaaSApiError, tenantPath } from '../api';
import { readCapabilities } from '../capabilitiesApi';
import { fetchRouteUsage } from '../routeUsage';
import type { SaaSRuntimeStatus } from '../runtimeCatalog';
import { groupModels, type ModelPaletteSelection } from '../../canvas/modelPalette';
import { marketSettingsOf, readMarketAgent, type MarketAgentDetail, type MarketSettings } from '../marketApi';
import { useMarketI18n } from './marketText';

/** The workspace's chat models: the ones the host holds (a canvas's palette), or read once from its runtime. `models` is
 *  null while they are read and when they cannot be (`failed`). */
export function useWorkspaceModels(tenantId: string | null | undefined, given: ReadonlyArray<ModelPaletteSelection> | undefined): { models: ReadonlyArray<ModelPaletteSelection> | null; failed: boolean } {
  const { locale } = useMarketI18n();
  const [read, setRead] = useState<{ tenantId: string; models: ModelPaletteSelection[]; failed: boolean } | null>(null);
  useEffect(() => {
    if (given || !tenantId) return;
    const controller = new AbortController();
    api<SaaSRuntimeStatus>(tenantPath(tenantId, '/runtime'), { signal: controller.signal }).then(status => {
      if (controller.signal.aborted) return;
      try { setRead({ tenantId, models: groupModels(status, locale).flatMap(group => group.models), failed: false }); }
      catch { setRead({ tenantId, models: [], failed: true }); }
    }, () => { if (!controller.signal.aborted) setRead({ tenantId, models: [], failed: true }); });
    return () => controller.abort();
  }, [given, tenantId, locale]);
  if (given) return { models: given, failed: false };
  const current = read?.tenantId === tenantId ? read : null;
  return { models: current && !current.failed ? current.models : null, failed: current?.failed === true };
}

/** The workspace's market: undefined while its capabilities are read, null where it is off (or they cannot be read). */
export function useMarketSettings(tenantId: string | null | undefined): MarketSettings | null | undefined {
  const [settings, setSettings] = useState<{ tenantId: string; value: MarketSettings | null } | null>(null);
  useEffect(() => {
    if (!tenantId) return;
    const controller = new AbortController();
    readCapabilities(tenantId, controller.signal).then(value => { if (!controller.signal.aborted) setSettings({ tenantId, value: marketSettingsOf(value) }); },
      () => { if (!controller.signal.aborted) setSettings({ tenantId, value: null }); });
    return () => controller.abort();
  }, [tenantId]);
  if (!tenantId) return null;
  return settings?.tenantId === tenantId ? settings.value : undefined;
}

/** Whether the workspace's owner has a paid plan (a paid Agent needs one): null while unknown or unreadable, when the
 *  server decides at the run (market_agent_plan_required). Read only while `wanted`. */
export function useWorkspacePaidPlan(tenantId: string | null | undefined, wanted: boolean): boolean | null {
  const [plan, setPlan] = useState<{ tenantId: string; paid: boolean } | null>(null);
  useEffect(() => {
    if (!tenantId || !wanted) return;
    const controller = new AbortController();
    fetchRouteUsage(tenantId, controller.signal).then(usage => { if (!controller.signal.aborted) setPlan({ tenantId, paid: Boolean(usage?.plan) }); }, () => undefined);
    return () => controller.abort();
  }, [tenantId, wanted]);
  return plan && plan.tenantId === tenantId ? plan.paid : null;
}

/** One Agent's detail as the page has read it: null detail for one the market does not have (or no longer shows). */
export type MarketAgentEntry = { state: 'loading' } | { state: 'ready'; detail: MarketAgentDetail | null } | { state: 'error'; error: unknown };
const entries = new Map<string, MarketAgentEntry>();
const listeners = new Set<() => void>();
const entryKey = (agentId: string, version?: number) => version ? `${agentId}@${version}` : agentId;
const changed = () => { for (const listener of [...listeners]) listener(); };
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Reads an Agent's listed detail (no version) or one version's, once per page unless forgotten. */
export function loadMarketAgent(agentId: string, version?: number): void {
  const key = entryKey(agentId, version);
  if (entries.has(key)) return;
  entries.set(key, { state: 'loading' }); changed();
  readMarketAgent(agentId, { version }).then(detail => { entries.set(key, { state: 'ready', detail }); changed(); }, error => {
    const missing = error instanceof SaaSApiError && (error.status === 404 || error.code === 'market_agent_not_found');
    entries.set(key, missing ? { state: 'ready', detail: null } : { state: 'error', error }); changed();
  });
}
/** Drops what the page holds of an Agent (after an author's change, or to read it again after a failure). */
export function forgetMarketAgent(agentId: string): void {
  for (const key of [...entries.keys()]) if (key === agentId || key.startsWith(`${agentId}@`)) entries.delete(key);
  changed();
}
/** Drops every Agent the page holds (a test's fresh page). */
export function forgetMarketAgents(): void { entries.clear(); changed(); }
/** Puts a detail the page already has (the market dialog's) where the chips read it. */
export function rememberMarketAgent(detail: MarketAgentDetail): void {
  entries.set(entryKey(detail.id), { state: 'ready', detail });
  entries.set(entryKey(detail.id, detail.version), { state: 'ready', detail });
  changed();
}

export interface MarketAgentInfo {
  /** The version listed now (its newest approved one); null when the market does not list the Agent. */
  listed: MarketAgentDetail | null | undefined;
  /** The node's own version, when the page knows it (the listed one, or one the server answered for that version). A
   *  node that names no version takes the listed one. */
  pinned: MarketAgentDetail | null | undefined;
  failed: boolean;
}

/** The Agent a node uses, at the version the node is locked to, read through the page's shared cache. */
export function useMarketAgentInfo(ref: { agentId: string; version?: number } | null | undefined): MarketAgentInfo {
  const id = ref?.agentId ?? '';
  const version = ref?.version ?? 0;
  const listed = useSyncExternalStore(subscribe, () => id ? entries.get(entryKey(id)) : undefined, () => undefined);
  const exact = useSyncExternalStore(subscribe, () => id && version ? entries.get(entryKey(id, version)) : undefined, () => undefined);
  const listedDetail = listed?.state === 'ready' ? listed.detail : undefined;
  const needsVersion = Boolean(version) && listed?.state === 'ready' && listedDetail?.version !== version;
  // Asked again whenever the page holds nothing (a first read, or one forgotten to be read again).
  useEffect(() => { if (id && !listed) loadMarketAgent(id); }, [id, listed]);
  useEffect(() => { if (id && version && needsVersion && !exact) loadMarketAgent(id, version); }, [id, version, needsVersion, exact]);
  const exactDetail = exact?.state === 'ready' && exact.detail?.version === version ? exact.detail : undefined;
  const pinned = !version || listedDetail?.version === version ? listedDetail : exactDetail ?? (exact?.state === 'ready' ? null : undefined);
  return { listed: listed?.state === 'ready' ? listed.detail : undefined, pinned, failed: listed?.state === 'error' || exact?.state === 'error' };
}
