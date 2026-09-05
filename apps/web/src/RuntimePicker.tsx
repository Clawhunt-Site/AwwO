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
};
// `locked` (issue #452): the package exceeds the account's unlock ceiling — the
// kernel (`is_tier_locked`, surfaced by GET /api/relay/packages) decides this; the
// surface never re-derives a tier order (CLI single source of truth, 铁律6).
type RelayPackage = { id: string; name: string; tier?: string; locked?: boolean };
type RelayPackages = { available?: boolean; packages?: RelayPackage[]; tier_ceiling?: string | null };
type ReadJson = (path: string, init?: RequestInit & { headers?: Record<string, string> }) => Promise<any>;

const COPY = {
  zh: { runtime: 'Runtime', model: '模型', effort: '思考强度', effortDefault: '继续（runtime 默认）', modelDefault: '默认模型', inherit: '跟随 lead', lockedBadge: '需升级', pickRuntime: '选择 Runtime…' },
  en: { runtime: 'Runtime', model: 'Model', effort: 'Effort', effortDefault: 'Inherit (runtime default)', modelDefault: 'Default model', inherit: 'Use lead', lockedBadge: 'Upgrade', pickRuntime: 'Select a runtime…' },
} as const;

function toOptions(values: string[]): DropdownOption[] {
  return values.map((v) => ({ value: v, label: v }));
}

export function RuntimePicker({
  runtimes,
  value,
  onChange,
  readJson,
  lang = 'zh',
  allowInherit = false,
  disabled = false,
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
}) {
  const t = COPY[lang];
  const { backend, model, effort } = value;
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [modelCatalog, setModelCatalog] = useState<string[]>([]);
  const [relayPackages, setRelayPackages] = useState<RelayPackages | null>(null);

  // readJson is a fresh identity each parent render; hold it in a ref so the
  // per-backend fetch effect keys only on `backend`, never on identity churn.
  const readJsonRef = useRef(readJson);
  useEffect(() => {
    readJsonRef.current = readJson;
  });

  useEffect(() => {
    if (!backend) {
      setAgentInfo(null);
      setModelCatalog([]);
      setRelayPackages(null);
      return;
    }
    let stale = false;
    setAgentInfo(null); // fail-closed during the async gap (no prior-runtime contract)
    setModelCatalog([]);
    setRelayPackages(null);
    void readJsonRef.current(`/api/agents/${encodeURIComponent(backend)}/models`)
      .then((d) => {
        if (!stale) setModelCatalog(Array.isArray(d?.models) ? d.models.map(String) : []);
      })
      .catch(() => {});
    void readJsonRef.current('/api/agents')
      .then((d) => {
        if (stale) return;
        const list: AgentInfo[] = Array.isArray(d?.agents) ? d.agents : [];
        const info = list.find((a) => a?.name === backend) ?? null;
        setAgentInfo(info);
        if (info?.uses_relay_packages) {
          void readJsonRef.current('/api/relay/packages')
            .then((p) => {
              if (!stale) setRelayPackages(p && typeof p === 'object' ? (p as RelayPackages) : {});
            })
            .catch(() => {
              if (!stale) setRelayPackages({ available: false, packages: [] });
            });
        }
      })
      .catch(() => {
        if (!stale) setAgentInfo(null);
      });
    return () => {
      stale = true;
    };
  }, [backend]);

  const usesRelay = agentInfo?.uses_relay_packages === true;
  const supportsModel = agentInfo?.supports_model_selection === true;
  const supportsEffort = agentInfo?.supports_effort_selection === true;
  const effortMode = agentInfo?.effort_input_mode ?? null;
  const effortLevels = Array.isArray(agentInfo?.effort_levels) ? agentInfo!.effort_levels!.map(String) : [];
  const modelSuggestions = modelCatalog.length
    ? modelCatalog
    : Array.isArray(agentInfo?.suggested_models)
      ? agentInfo!.suggested_models!.map(String)
      : [];

  // Switching the runtime resets model + effort (neither is portable across runtimes).
  const setBackend = (next: string) => onChange({ backend: next, model: '', effort: '' });

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
          ...toOptions(runtimes),
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
      ) : backend && supportsModel ? (
        <ComboInput
          ariaLabel={t.model}
          value={model}
          suggestions={toOptions(modelSuggestions)}
          onChange={(m) => onChange({ ...value, model: m })}
          placeholder={t.modelDefault}
          disabled={disabled}
        />
      ) : null}
      {backend && supportsEffort ? (
        effortMode === 'text' ? (
          <ComboInput
            ariaLabel={t.effort}
            value={effort}
            suggestions={toOptions(effortLevels)}
            onChange={(e) => onChange({ ...value, effort: e })}
            disabled={disabled}
          />
        ) : (
          <Dropdown
            ariaLabel={t.effort}
            value={effort}
            options={[{ value: '', label: t.effortDefault }, ...toOptions(effortLevels)]}
            onChange={(e) => onChange({ ...value, effort: e })}
            disabled={disabled}
          />
        )
      ) : null}
    </>
  );
}
