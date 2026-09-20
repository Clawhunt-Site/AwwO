// RuntimePicker (PR4) — a reusable runtime + model + effort selector, 铁律6:
//   * the runtime list is passed in (the dialog fetches the live inventory once);
//   * the model catalog + effort contract are scoped to the CHOSEN runtime, fetched
//     here per backend, reset on switch (never leak the prior runtime's contract);
//   * model shows only on positive supports_model_selection; a relay runtime shows a
//     CLOSED package Dropdown (no raw model typing); effort shows only when advertised
//     and its default is never backfilled.
//
// Extracted from GoalModeDialog so the goal 选兵台 can render one picker for the lead
// plus one per plan slot (role) without duplicating this fail-closed logic.
import { useEffect, useRef, useState } from 'react';
import { Dropdown, ComboInput } from './ui/Dropdown';
import type { DropdownOption } from './ui/Dropdown';
import { modelLabel, modelLabels } from './modelLabels';

export type RuntimeValue = { backend: string; model: string; effort: string };

type AgentInfo = {
  name?: string;
  supports_model_selection?: boolean;
  supports_effort_selection?: boolean;
  effort_levels?: unknown;
  effort_input_mode?: 'select' | 'text' | null;
  suggested_models?: unknown;
  uses_relay_packages?: boolean;
  default_model?: string;
  model_catalog_source?: string;
};
type ModelCapability = { effort_levels: string[]; default_effort: string };
type ModelCatalog = {
  backend: string;
  status: 'loading' | 'ready' | 'error';
  models: string[];
  source?: string;
  capabilities: Record<string, ModelCapability>;
  labels?: Record<string, string>;
};
// `locked` (issue #452): the package exceeds the account's unlock ceiling — the
// kernel (`is_tier_locked`, surfaced by GET /api/relay/packages) decides this; the
// surface never re-derives a tier order (CLI single source of truth, 铁律6).
type RelayPackage = { id: string; name: string; tier?: string; locked?: boolean };
type RelayPackages = { available?: boolean; packages?: RelayPackage[]; tier_ceiling?: string | null };
type ReadJson = (path: string, init?: RequestInit & { headers?: Record<string, string> }) => Promise<any>;

const COPY = {
  zh: { runtime: 'Runtime', model: '模型', effort: '思考强度', effortDefault: '继续（runtime 默认）', modelDefault: '默认模型', inherit: '跟随 lead', lockedBadge: '需升级', pickRuntime: '选择 Runtime…', catalogUnavailable: 'Codex 模型目录暂不可用，请重试。', catalogRetry: '重试模型目录', savedModel: '已保存，当前目录未列出' },
  en: { runtime: 'Runtime', model: 'Model', effort: 'Effort', effortDefault: 'Inherit (runtime default)', modelDefault: 'Default model', inherit: 'Use lead', lockedBadge: 'Upgrade', pickRuntime: 'Select a runtime…', catalogUnavailable: 'The Codex model catalog is unavailable. Please retry.', catalogRetry: 'Retry model catalog', savedModel: 'Saved; not listed in the current catalog' },
} as const;

function toOptions(values: string[], labels?: Record<string, string>): DropdownOption[] {
  return values.map((v) => ({ value: v, label: modelLabel(v, labels) }));
}

function stringValues(values: unknown): string[] {
  return Array.isArray(values) ? [...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))] : [];
}

function modelCapabilities(value: unknown): Record<string, ModelCapability> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([model, capability]) => {
    if (!capability || typeof capability !== 'object' || Array.isArray(capability)) return [];
    const entry = capability as Record<string, unknown>;
    const levels = stringValues(entry.effort_levels);
    return [[model, { effort_levels: levels, default_effort: typeof entry.default_effort === 'string' && levels.includes(entry.default_effort) ? entry.default_effort : '' }]];
  }));
}

export function RuntimePicker({
  runtimes,
  value,
  onChange,
  readJson,
  lang = 'zh',
  allowInherit = false,
  disabled = false,
  runtimeLabels = {},
}: {
  runtimes: string[];
  value: RuntimeValue;
  onChange: (next: RuntimeValue) => void;
  readJson: ReadJson;
  lang?: 'zh' | 'en';
  // When true, the runtime list gets a leading empty option meaning "inherit the
  // lead runtime" — used for per-slot overrides that default to the lead.
  allowInherit?: boolean;
  disabled?: boolean;
  runtimeLabels?: Record<string, string>;
}) {
  const t = COPY[lang];
  const { backend, model, effort } = value;
  const [runtimeContract, setRuntimeContract] = useState<{ backend: string; info: AgentInfo | null } | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [relayPackages, setRelayPackages] = useState<RelayPackages | null>(null);
  const agentInfo = runtimeContract?.backend === backend ? runtimeContract.info : null;
  const modelCatalog = catalog?.backend === backend ? catalog.models : [];

  // readJson is a fresh identity each parent render; hold it in a ref so the
  // per-backend fetch effect keys only on `backend`, never on identity churn.
  const readJsonRef = useRef(readJson);
  useEffect(() => {
    readJsonRef.current = readJson;
  });

  useEffect(() => {
    if (!backend) {
      setRuntimeContract(null);
      setCatalog(null);
      setRelayPackages(null);
      return;
    }
    let stale = false;
    const controller = new AbortController();
    // Keep the same runtime's contract while retrying, so its controls stay visible
    // and disabled; never expose a previous runtime's contract in the async gap.
    setRuntimeContract((current) => current?.backend === backend ? current : null);
    setCatalog({ backend, status: 'loading', models: [], capabilities: {} });
    setRelayPackages(null);
    void readJsonRef.current(`/api/agents/${encodeURIComponent(backend)}/models`, { signal: controller.signal })
      .then((d) => {
        if (!stale) setCatalog({
          backend,
          status: Array.isArray(d?.models) ? 'ready' : 'error',
          models: stringValues(d?.models),
          source: typeof d?.source === 'string' ? d.source : undefined,
          capabilities: modelCapabilities(d?.model_capabilities),
          labels: modelLabels(d?.model_labels),
        });
      })
      .catch(() => {
        if (!stale) setCatalog({ backend, status: 'error', models: [], capabilities: {} });
      });
    void readJsonRef.current('/api/agents', { signal: controller.signal })
      .then((d) => {
        if (stale) return;
        const list: AgentInfo[] = Array.isArray(d?.agents) ? d.agents : [];
        const info = list.find((a) => a?.name === backend) ?? null;
        setRuntimeContract({ backend, info });
        if (info?.uses_relay_packages) {
          void readJsonRef.current('/api/relay/packages', { signal: controller.signal })
            .then((p) => {
              if (!stale) setRelayPackages(p && typeof p === 'object' ? (p as RelayPackages) : {});
            })
            .catch(() => {
              if (!stale) setRelayPackages({ available: false, packages: [] });
            });
        }
      })
      .catch(() => {
        if (!stale) setRuntimeContract(null);
      });
    return () => {
      stale = true;
      controller.abort();
    };
  }, [backend, catalogAttempt]);

  const usesRelay = agentInfo?.uses_relay_packages === true;
  const supportsModel = agentInfo?.supports_model_selection === true;
  const supportsEffort = agentInfo?.supports_effort_selection === true;
  const usesLiveCatalog = agentInfo?.model_catalog_source === 'codex_app_server' || agentInfo?.model_catalog_source === 'saas_runtime';
  const liveCatalogReady = catalog?.backend === backend && catalog.status === 'ready' && catalog.source === agentInfo?.model_catalog_source
    && (agentInfo?.model_catalog_source === 'saas_runtime' || modelCatalog.length > 0);
  const liveCatalogBlocked = usesLiveCatalog && !liveCatalogReady;
  const liveCatalogFailed = liveCatalogBlocked && catalog?.backend === backend && catalog.status !== 'loading';
  const capabilityFor = (selectedModel: string) => liveCatalogReady && modelCatalog.includes(selectedModel) && Object.prototype.hasOwnProperty.call(catalog.capabilities, selectedModel)
    ? catalog.capabilities[selectedModel]
    : undefined;
  const capability = usesLiveCatalog ? capabilityFor(model) : undefined;
  const effortMode = usesLiveCatalog ? 'select' : agentInfo?.effort_input_mode ?? null;
  const effortLevels = usesLiveCatalog ? capability?.effort_levels ?? [] : Array.isArray(agentInfo?.effort_levels) ? agentInfo!.effort_levels!.map(String) : [];
  const effortDefault = usesLiveCatalog && capability?.default_effort ? `${t.effortDefault} · ${capability.default_effort}` : t.effortDefault;
  const modelSuggestions = usesLiveCatalog ? modelCatalog : modelCatalog.length
    ? modelCatalog
    : Array.isArray(agentInfo?.suggested_models)
      ? agentInfo!.suggested_models!.map(String)
      : [];

  // Switching the runtime resets model + effort (neither is portable across runtimes).
  const setBackend = (next: string) => { if (!disabled) onChange({ backend: next, model: '', effort: '' }); };
  const setModel = (next: string) => {
    if (disabled || liveCatalogBlocked || (usesLiveCatalog && next !== '' && !modelCatalog.includes(next))) return;
    onChange({ ...value, model: next, effort: usesLiveCatalog && !capabilityFor(next)?.effort_levels.includes(effort) ? '' : effort });
  };
  const setEffort = (next: string) => {
    // Clearing is always allowed, so a stale saved level can be removed; a new level must be advertised.
    if (disabled || liveCatalogBlocked || (next !== '' && usesLiveCatalog && (!capability || !effortLevels.includes(next)))) return;
    onChange({ ...value, effort: next });
  };
  // A saved level the runtime or model no longer advertises stays visible and is never selectable. It can be
  // cleared in place when the runtime stopped advertising effort or the chosen model is known; for an unknown
  // saved model the control stays disabled (no capabilities are invented) and choosing a model resets it.
  const staleEffort = effort !== '' && !effortLevels.includes(effort);
  const clearableStale = staleEffort && (!supportsEffort || (liveCatalogReady && Boolean(capability)));
  const effortDisabled = disabled || liveCatalogBlocked || (usesLiveCatalog && effortLevels.length === 0 && !clearableStale);

  return (
    <>
      <Dropdown
        ariaLabel={t.runtime}
        value={backend}
        // With `allowInherit` the empty value is a real choice ("follow the lead") and carries
        // its own label. Without it, an empty value means NOTHING IS CHOSEN YET — and a trigger
        // that renders a blank strip reads as a broken control rather than as an invitation, so
        // the unset state says what to do.
        placeholder={allowInherit ? undefined : t.pickRuntime}
        options={[
          ...(allowInherit ? [{ value: '', label: t.inherit }] : []),
          ...(backend && !runtimes.includes(backend) ? [{ value: backend, label: runtimeLabels[backend] || backend, disabled: true }] : []),
          ...runtimes.map(runtime => ({ value: runtime, label: runtimeLabels[runtime] || runtime })),
        ]}
        onChange={setBackend}
        disabled={disabled}
      />
      {backend && usesRelay ? (
        <Dropdown
          ariaLabel={t.model}
          value={model}
          disabled={disabled || (relayPackages !== null && relayPackages.available === false)}
          options={[
            { value: '', label: agentInfo?.default_model || t.modelDefault },
            ...(relayPackages?.packages ?? []).map((pkg) => ({
              value: pkg.id,
              label: pkg.name,
              description: pkg.tier && pkg.tier !== pkg.name ? pkg.tier : undefined,
              // 越级档（超过账号解锁上限）：禁选 + 角标提示升级。裁决来自内核 is_tier_locked
              // （/api/relay/packages 的 locked），与 backends run 的硬 clamp 同源，零偏差。
              disabled: pkg.locked === true,
              badge: pkg.locked === true ? t.lockedBadge : undefined,
            })),
          ]}
          onChange={(m) => onChange({ ...value, model: m })}
        />
      ) : backend && supportsModel && usesLiveCatalog ? (
        <Dropdown
          key={`${backend}:model`}
          ariaLabel={t.model}
          value={model}
          options={[
            ...(model && !modelCatalog.includes(model) ? [{ value: model, label: model, description: t.savedModel, disabled: true }] : []),
            { value: '', label: t.modelDefault },
            ...toOptions(modelCatalog, catalog?.backend === backend ? catalog.labels : undefined),
          ]}
          onChange={setModel}
          disabled={disabled || liveCatalogBlocked}
        />
      ) : backend && supportsModel ? (
        <ComboInput
          key={`${backend}:model`}
          ariaLabel={t.model}
          value={model}
          suggestions={toOptions(modelSuggestions)}
          onChange={setModel}
          placeholder={t.modelDefault}
          disabled={disabled}
        />
      ) : null}
      {backend && (supportsEffort || effort !== '') ? (
        effortMode === 'text' && supportsEffort ? (
          <ComboInput
            key={`${backend}:effort`}
            ariaLabel={t.effort}
            value={effort}
            suggestions={toOptions(effortLevels)}
            onChange={setEffort}
            disabled={effortDisabled}
          />
        ) : (
          <Dropdown
            key={`${backend}:effort`}
            ariaLabel={t.effort}
            value={effort}
            options={[{ value: '', label: effortDefault }, ...(staleEffort ? [{ value: effort, label: `${effort} · ${t.savedModel}`, disabled: true }] : []), ...toOptions(effortLevels)]}
            onChange={setEffort}
            disabled={effortDisabled}
          />
        )
      ) : null}
      {liveCatalogFailed ? (
        <span role="status">
          {agentInfo?.model_catalog_source === 'saas_runtime' ? (lang === 'zh' ? '所选执行框架的模型目录暂不可用，请重试。' : 'The selected runtime’s model catalog is unavailable. Please retry.') : t.catalogUnavailable}{' '}
          <button type="button" disabled={disabled} onClick={() => setCatalogAttempt((attempt) => attempt + 1)}>{t.catalogRetry}</button>
        </span>
      ) : null}
    </>
  );
}
