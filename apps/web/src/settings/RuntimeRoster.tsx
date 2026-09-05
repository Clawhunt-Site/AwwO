// Object-centric runtime roster (Diagnostics UX redesign). ONE list of every
// local agent runtime: each row carries its lifecycle status (installed vs
// actually reachable), an on-demand reachability test, an expandable configure
// area (executable path), and a "set as default" action — so the user deals with
// a runtime in one place instead of selecting it in one tab and checking it in
// another. Read (status) and write (config/default) live in the same row but are
// strictly layered: status + test up front, configuration behind the expander.
//
// Surface-only: status verdicts come verbatim from the kernel probe
// (/api/agents/probe → runtime_probe) and are NEVER re-derived here; configuration
// writes go through the existing /api/config kernel endpoints. No install / repair
// / enable state is invented — the CLI stays the single source of truth.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
  Server,
  Star,
  XCircle,
} from 'lucide-react';
import type { AgentInventoryInfo, AppCopyKey, RuntimeConfigPayload, RuntimeProbeResult } from '../App';

type Translate = (key: AppCopyKey) => string;
type ConfigEntry = RuntimeConfigPayload['entries'][number];

type RuntimeRosterProps = {
  t: Translate;
  agents: AgentInventoryInfo[];
  defaultBackend: string;
  configEntries: ConfigEntry[];
  probeResults: Record<string, RuntimeProbeResult>;
  probingBackends: Record<string, boolean>;
  probeAllBusy: boolean;
  onProbe: (backend: string) => void;
  onProbeDeep: (backend: string) => void;
  onProbeAll: () => void;
  onSaveConfig: (name: string, value: string) => Promise<boolean>;
  onInvalidateProbe: (backend: string) => void;
};

type Lifecycle = 'unconfigured' | 'untested' | 'healthy' | 'present' | 'fail';

function lifecycleOf(agent: AgentInventoryInfo, probe: RuntimeProbeResult | undefined): Lifecycle {
  if (!agent.available) return 'unconfigured';
  if (!probe) return 'untested';
  if (probe.verdict === 'runtime_ready') return 'healthy';
  if (probe.verdict === 'runtime_present') return 'present';
  return 'fail';
}

// Short reason for the collapsed row. The probe path uses the KERNEL's own
// classification (probe.failure_reason — auth/network) mapped to a label; this is
// display mapping, not re-classification. The availability path shows the kernel's
// raw reason VERBATIM — the surface never re-derives a diagnosis category from it
// (that would invent classification the CLI does not own; see the iron rule in
// runtime_probe). Falls back to a generic label only when there is no reason.
function shortReason(t: Translate, agent: AgentInventoryInfo, probe: RuntimeProbeResult | undefined): string {
  if (probe?.failure_reason === 'auth') return t('Credentials rejected');
  if (probe?.failure_reason === 'network') return t('Network unreachable');
  if (probe?.failure_reason) return probe.failure_reason;
  return agent.reason ?? t('Not ready');
}

function StatusIcon({ lifecycle, spinning }: { lifecycle: Lifecycle; spinning: boolean }) {
  if (spinning) return <Loader2 size={16} className="runtime-status-icon spin" aria-hidden="true" />;
  switch (lifecycle) {
    case 'healthy':
      return <CheckCircle2 size={16} className="runtime-status-icon good" aria-hidden="true" />;
    case 'present':
      return <AlertTriangle size={16} className="runtime-status-icon warn" aria-hidden="true" />;
    case 'fail':
      return <XCircle size={16} className="runtime-status-icon bad" aria-hidden="true" />;
    case 'untested':
      return <Circle size={16} className="runtime-status-icon neutral" aria-hidden="true" />;
    default:
      return <Circle size={16} className="runtime-status-icon muted" aria-hidden="true" />;
  }
}

function statusLabel(t: Translate, lifecycle: Lifecycle, probe: RuntimeProbeResult | undefined): string {
  switch (lifecycle) {
    case 'healthy':
      return probe?.latency_ms != null ? `${t('Healthy')} · ${probe.latency_ms}ms` : t('Healthy');
    case 'present':
      return t('Present, unverified');
    case 'fail':
      return t('Unreachable');
    case 'untested':
      return t('Ready, untested');
    default:
      return t('Not ready');
  }
}

// What the probe actually did, derived from the kernel's `depth` field — never
// hardcoded, so the detail line tracks the real method (lightweight CLI-presence
// vs deep end-to-end testEnvironment) instead of always claiming a model-list call.
function probeMethodLabel(depth: string): string {
  switch (depth) {
    case 'live':
      return 'testEnvironment (end-to-end)';
    case 'shallow':
      return 'CLI presence (PATH + exec-bit)';
    case 'registry':
      return 'registry only';
    case 'none':
      return 'CLI not found';
    default:
      return depth;
  }
}

function RuntimeRow({
  t,
  agent,
  probe,
  probing,
  probeAllBusy,
  isDefault,
  configEntry,
  onProbe,
  onProbeDeep,
  onSaveConfig,
  onInvalidateProbe,
  onSetDefault,
  onDirtyChange,
}: {
  t: Translate;
  agent: AgentInventoryInfo;
  probe: RuntimeProbeResult | undefined;
  probing: boolean;
  probeAllBusy: boolean;
  isDefault: boolean;
  configEntry: ConfigEntry | undefined;
  onProbe: (backend: string) => void;
  onProbeDeep: (backend: string) => void;
  onSaveConfig: (name: string, value: string) => Promise<boolean>;
  onInvalidateProbe: (backend: string) => void;
  onSetDefault: (backend: string) => void;
  onDirtyChange: (backend: string, dirty: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lifecycle = lifecycleOf(agent, probe);
  const reason = lifecycle === 'fail' || lifecycle === 'unconfigured' ? shortReason(t, agent, probe) : '';
  const configValue = configEntry?.display_value ?? configEntry?.default ?? '';
  const value = draft ?? configValue;
  const dirty = draft !== null && draft !== configValue;
  const canEditExecutable = Boolean(agent.config_env && configEntry);

  // Lift this row's unsaved-edit state to the roster so a "Test all" sweep can be
  // blocked while ANY row is dirty (else it would probe stale on-disk config).
  useEffect(() => {
    onDirtyChange(agent.name, dirty);
    return () => onDirtyChange(agent.name, false);
  }, [agent.name, dirty, onDirtyChange]);

  async function saveExecutable() {
    if (!agent.config_env || !value.trim()) return;
    setBusy(true);
    try {
      const ok = await onSaveConfig(agent.config_env, value.trim());
      if (ok) {
        setDraft(null);
        onInvalidateProbe(agent.name); // reachability is no longer proven on the new path
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`runtime-row lifecycle-${lifecycle}${isDefault ? ' is-default' : ''}`}>
      <div className="runtime-row-main">
        <button
          type="button"
          className="runtime-row-toggle"
          aria-expanded={open}
          aria-label={open ? t('Collapse') : t('Diagnostics details')}
          onClick={() => setOpen((cur) => !cur)}
        >
          {open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
        </button>
        <StatusIcon lifecycle={lifecycle} spinning={probing} />
        <span className="runtime-row-name">
          {agent.name}
          {isDefault ? (
            <span className="runtime-default-badge" title={t('Default runtime')}>
              <Star size={12} aria-hidden="true" /> {t('Default')}
            </span>
          ) : null}
        </span>
        <span className="runtime-row-status" title={probe ? probeMethodLabel(probe.depth) : undefined}>
          {probing ? t('Testing…') : statusLabel(t, lifecycle, probe)}
        </span>
        {probe && lifecycle === 'healthy' && probe.models_count != null ? (
          <span className="runtime-chip">{probe.models_count} {t('models')}</span>
        ) : null}
        {reason ? <span className="runtime-row-reason">{reason}</span> : null}
        <div className="runtime-row-actions">
          <button
            type="button"
            className="text-button compact"
            disabled={probing || probeAllBusy || dirty || !agent.available}
            title={dirty ? t('Save the config before testing') : undefined}
            onClick={() => onProbe(agent.name)}
          >
            {probing ? t('Testing…') : t('Test')}
          </button>
          <button
            type="button"
            className="text-button compact"
            disabled={probing || probeAllBusy || dirty || !agent.available}
            title={t('Deep test: run the runtime end-to-end (may use provider quota/tokens)')}
            onClick={() => onProbeDeep(agent.name)}
          >
            {t('Deep test')}
          </button>
        </div>
      </div>
      {open ? (
        <div className="runtime-row-detail">
          {canEditExecutable ? (
            <label className="stacked-field">
              <span>{t('Agent executable path')}</span>
              <div className="runtime-exec-row">
                <input
                  aria-label={`${agent.name} ${t('Agent executable path')}`}
                  value={value}
                  placeholder={configEntry?.default ?? 'built-in'}
                  disabled={busy || probing}
                  onChange={(event) => setDraft(event.target.value)}
                />
                {dirty ? (
                  <button
                    type="button"
                    className="text-button compact"
                    disabled={busy || !value.trim()}
                    onClick={() => void saveExecutable()}
                  >
                    {t('Save config key')}
                  </button>
                ) : null}
              </div>
              <small><code>{agent.config_env}</code></small>
            </label>
          ) : null}
          {reason && agent.reason ? (
            <p className="runtime-row-detail-reason">
              {agent.reason}
              {agent.configure ? <> · <code>{agent.configure}</code></> : null}
            </p>
          ) : null}
          {probe ? (
            <p className="runtime-row-detail-reason">
              {t('Verification')}: <code>{probeMethodLabel(probe.depth)}</code>
              {probe.depth === 'live' && probe.default_model ? <> · {probe.default_model}</> : null}
              {probe.detail ? <><br />{probe.detail}</> : null}
            </p>
          ) : null}
          <dl className="runtime-row-meta">
            <div><dt>Kind</dt><dd>{agent.kind ?? 'agent'}</dd></div>
            <div><dt>Executable</dt><dd><code>{agent.executable ?? agent.reason ?? 'n/a'}</code></dd></div>
            <div><dt>Model</dt><dd>{agent.model_env ?? 'n/a'} / {agent.model_state ?? 'n/a'}</dd></div>
          </dl>
          {/* Set-as-default is a real write: only offered for an INSTALLED runtime
              with no unsaved edits — you cannot make a not-installed or mid-edit
              runtime the default and strand new turns on it. */}
          {!isDefault && agent.available ? (
            <div className="button-row">
              <button
                type="button"
                className="text-button compact"
                disabled={dirty || busy}
                title={dirty ? t('Save the config before testing') : undefined}
                onClick={() => onSetDefault(agent.name)}
              >
                <Star size={14} aria-hidden="true" />
                {t('Set as default')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function RuntimeRoster({
  t,
  agents,
  defaultBackend,
  configEntries,
  probeResults,
  probingBackends,
  probeAllBusy,
  onProbe,
  onProbeDeep,
  onProbeAll,
  onSaveConfig,
  onInvalidateProbe,
}: RuntimeRosterProps) {
  const configByName = useMemo(() => {
    const map: Record<string, ConfigEntry> = {};
    for (const entry of configEntries) map[entry.name] = entry;
    return map;
  }, [configEntries]);

  // Sort: default first (always, whatever its state), then installed, then
  // not-installed last (dimmed) — by user attention, not backend hardcode order.
  const ordered = useMemo(() => {
    const rank = (agent: AgentInventoryInfo) => {
      if (agent.name === defaultBackend) return 0;
      return agent.available ? 1 : 2;
    };
    return [...agents].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [agents, defaultBackend]);

  // Which rows have an unsaved config edit — a "Test all" sweep is blocked while
  // any is dirty, so it can never probe stale on-disk config (the single-row Test
  // already disables on its own dirty; this closes the batch path).
  const [dirtyRows, setDirtyRows] = useState<Record<string, boolean>>({});
  const onDirtyChange = useCallback((backend: string, dirty: boolean) => {
    setDirtyRows((cur) => {
      if (Boolean(cur[backend]) === dirty) return cur;
      const next = { ...cur };
      if (dirty) next[backend] = true;
      else delete next[backend];
      return next;
    });
  }, []);
  const anyDirty = Object.keys(dirtyRows).length > 0;

  const installed = agents.filter((agent) => agent.available).length;
  const tested = agents.filter((agent) => probeResults[agent.name]);
  const reachable = tested.filter((agent) => probeResults[agent.name].verdict === 'runtime_ready').length;
  const setDefault = (name: string) => void onSaveConfig('backend', name);

  return (
    <section className="runtime-roster" aria-label={t('Runtime health')}>
      <div className="runtime-roster-summary">
        <span>
          {t('Runtime health')}: <strong>{installed}/{agents.length}</strong> {t('installed')}
          {tested.length ? ` · ${reachable}/${tested.length} ${t('reachable')}` : ''}
          {probeAllBusy ? ` · ${t('Testing…')}` : ''}
        </span>
        <button
          type="button"
          className="text-button compact"
          disabled={probeAllBusy || installed === 0 || anyDirty}
          title={anyDirty ? t('Save the config before testing') : undefined}
          onClick={() => onProbeAll()}
        >
          {probeAllBusy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <Server size={16} aria-hidden="true" />}
          {probeAllBusy ? t('Testing…') : t('Test all runtimes')}
        </button>
      </div>
      <ul className="runtime-roster-list">
        {ordered.map((agent) => (
          <RuntimeRow
            key={agent.name}
            t={t}
            agent={agent}
            probe={probeResults[agent.name]}
            probing={Boolean(probingBackends[agent.name])}
            probeAllBusy={probeAllBusy}
            isDefault={agent.name === defaultBackend}
            configEntry={agent.config_env ? configByName[agent.config_env] : undefined}
            onProbe={onProbe}
            onProbeDeep={onProbeDeep}
            onSaveConfig={onSaveConfig}
            onInvalidateProbe={onInvalidateProbe}
            onSetDefault={setDefault}
            onDirtyChange={onDirtyChange}
          />
        ))}
        {agents.length ? null : <li className="runtime-row">{t('Agent doctor')}: /api/agents</li>}
      </ul>
    </section>
  );
}
