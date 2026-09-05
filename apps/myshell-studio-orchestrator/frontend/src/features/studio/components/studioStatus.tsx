import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { StudioHealth, StudioMode, StudioReadiness } from '../api';
import { healthPillTone } from '../model/dreamyWorkspace';

export function Pill({ children, tone = 'default' }: { children: string; tone?: 'default' | 'hot' | 'success' | 'danger' }) {
  const toneClass = {
    default: 'border-Cr-border-default-v2 bg-Cr-beta-white-5-v2 text-Cr-text-subtler-v2',
    hot: 'border-dreamy-brand-hot-v2/50 bg-dreamy-brand-hot-v2/15 text-dreamy-brand-hot-v2',
    success: 'border-Cr-border-success-v2 bg-Cr-Bg-success-default-v2 text-Cr-text-success-default-v2',
    danger: 'border-Cr-border-critical-v2 bg-Cr-Bg-critical-default-v2 text-Cr-text-critical-bolder-v2',
  }[tone];
  return (
    <span className={`inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-md-v2 border px-2 text-[11px] font-semibold ${toneClass}`}>
      {children}
    </span>
  );
}

export function ModeSwitch({
  mode,
  onChange,
  labelScope = 'Switch studio mode to',
}: {
  mode: StudioMode;
  onChange: (mode: StudioMode) => void;
  labelScope?: string;
}) {
  return (
    <div className="grid h-9 w-[132px] shrink-0 grid-cols-2 rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 p-1">
      {(['player', 'canvas'] as StudioMode[]).map((item) => {
        const label = item === 'player' ? 'Player' : 'Canvas';
        return (
          <button
            key={item}
            type="button"
            aria-label={`${labelScope} ${label}`}
            aria-pressed={mode === item}
            onClick={() => onChange(item)}
            className={`rounded-md-v2 px-2 text-xs font-semibold transition-colors ${
              mode === item
                ? 'bg-Cr-beta-white-12-v2 text-Cr-text-default-v2 shadow-sm'
                : 'text-Cr-text-subtler-v2 active:text-Cr-text-default-v2'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function StudioHealthStrip({ health }: { health: StudioHealth | null }) {
  const components = [
    ['backend', 'Backend'],
    ['storage', 'Storage'],
    ['chromeCdp', 'CDP'],
    ['myshellCookies', 'Cookies'],
    ['cookieInjection', 'Injection'],
    ['dreamyApiAuth', 'Dreamy'],
    ['credentialSetup', 'Secrets'],
    ['liveGeneration', 'Live'],
  ] as const;

  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 px-3 py-2 [-webkit-overflow-scrolling:touch]">
      <Pill tone={healthPillTone(health?.status)}>{health ? `Health ${health.status}` : 'Health checking'}</Pill>
      {components.map(([id, label]) => {
        const component = health?.components?.[id];
        const status = component?.status || 'unknown';
        const detail = component?.message || component?.path || component?.url || component?.mode || '';
        const tone = healthPillTone(status);
        return (
          <span
            key={id}
            title={detail}
            className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-beta-white-5-v2 px-2 text-[11px] font-semibold text-Cr-text-subtler-v2"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                tone === 'success'
                  ? 'bg-Cr-text-success-default-v2'
                  : tone === 'danger'
                    ? 'bg-Cr-text-critical-default-v2'
                    : tone === 'hot'
                      ? 'bg-dreamy-brand-hot-v2'
                      : 'bg-Cr-text-subtlest-v2'
              }`}
            />
            {label} {status}
          </span>
        );
      })}
    </div>
  );
}

export function StudioReadinessStrip({ readiness }: { readiness: StudioReadiness | null }) {
  const gates = readiness?.gates || [];
  const summary = readiness?.summary;

  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 px-3 py-2 [-webkit-overflow-scrolling:touch]">
      <Pill tone={healthPillTone(readiness?.status)}>
        {readiness ? `Delivery ${readiness.status}` : 'Delivery checking'}
      </Pill>
      {summary && <Pill>{`${summary.ready}/${summary.total} ready`}</Pill>}
      {gates.map((gate) => {
        const tone = healthPillTone(gate.status);
        const Icon = tone === 'success' ? CheckCircle2 : AlertTriangle;
        return (
          <span
            key={gate.id}
            title={gate.message || gate.id}
            className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-beta-white-5-v2 px-2 text-[11px] font-semibold text-Cr-text-subtler-v2"
          >
            <Icon
              size={12}
              className={
                tone === 'success'
                  ? 'text-Cr-text-success-default-v2'
                  : tone === 'danger'
                    ? 'text-Cr-text-critical-default-v2'
                    : 'text-dreamy-brand-hot-v2'
              }
            />
            <span className="max-w-[120px] truncate">{gate.label}</span>
            <span className="text-Cr-text-subtlest-v2">{gate.status}</span>
          </span>
        );
      })}
    </div>
  );
}
