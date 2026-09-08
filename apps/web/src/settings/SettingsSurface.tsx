// Settings surface, extracted verbatim from App.tsx (settings-redesign PR-2).
// Pure presentation move: all state and API handlers stay in App and arrive
// via props, so behavior is byte-identical to the inline version. The
// follow-up PRs (primitives, IA regroup, contract-driven config) build on
// this isolation instead of growing the App monolith further.
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  Activity,
  ArrowLeft,
  Bell,
  CalendarDays,
  ChevronRight,
  Clock3,
  Coins,
  Copy,
  Download,
  ExternalLink,
  Flame,
  Globe,
  Languages,
  Palette,
  RefreshCw,
  ShieldCheck,
  Square,
  UserRound,
} from 'lucide-react';
import type { DesktopShellInfo } from '../desktop';
import type { AppearanceCanvas, AppearancePayload, AppearanceToken } from '../appearance';
import { isValidHex, resolveOverrides } from '../appearance';
import { DialogShell } from '../ui/DialogShell';
import { SegmentedControl, SettingRow, SettingsPanel, ToggleSwitch } from './primitives';
import { RuntimeRoster } from './RuntimeRoster';
import './settings.css';
import type {
  AgentInventoryInfo,
  AppCopyKey,
  AppThemePreference,
  ClawHuntAuthPayload,
  DesktopAlertEntry,
  DesktopIncidentExport,
  Locale,
  RuntimeConfigPayload,
  RuntimeProbeResult,
  RuntimeStatusPayload,
  SettingsSectionId,
  ShellCopy,
} from '../App';

type Translate = (key: AppCopyKey) => string;

export type AccountTokenUsageMode = 'daily' | 'weekly' | 'yearly';

export interface AccountCostSummary {
  event_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_input_tokens?: number;
  duration_seconds?: number;
  total_cost_cents?: number;
}

export interface AccountTokenCostEvent {
  occurred_at?: number;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_input_tokens?: number | null;
  duration_seconds?: number | null;
  cost_cents?: number | null;
}

export interface AccountTokenUsageData {
  summary: AccountCostSummary | null;
  lifetime: AccountCostSummary | null;
  events: AccountTokenCostEvent[];
  loading: boolean;
  error: string | null;
}

interface AccountTokenActivityBucket {
  key: string;
  groupKey: string;
  label: string;
  tokens: number;
  cachedTokens: number;
  durationSeconds: number;
  costCents: number;
  events: number;
  level: number;
  column: number;
  empty?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_ACTIVITY_DAYS = 365;

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function eventTokenMass(event: AccountTokenCostEvent): number {
  return (
    numberOrZero(event.input_tokens) +
    numberOrZero(event.output_tokens) +
    numberOrZero(event.cached_input_tokens)
  );
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfLocalWeek(date: Date): Date {
  const day = startOfLocalDay(date);
  return addDays(day, -((day.getDay() + 6) % 7));
}

function daysBetween(start: Date, end: Date): number {
  return Math.round((startOfLocalDay(end).getTime() - startOfLocalDay(start).getTime()) / DAY_MS);
}

function parseDateKey(key: string): Date | null {
  const [year, month, day] = key.split('-').map((part) => Number(part));
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function localeTag(locale: Locale): string {
  return locale === 'zh' ? 'zh-CN' : 'en-US';
}

function formatCompactNumber(value: number, locale: Locale): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  return new Intl.NumberFormat(localeTag(locale), {
    notation: 'compact',
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(Math.round(value));
}

function formatDurationSeconds(value: number, locale: Locale): string {
  if (!Number.isFinite(value) || value <= 0) return '0m';
  const totalMinutes = Math.max(1, Math.round(value / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (locale === 'zh') {
    if (hours > 0 && minutes > 0) return `${hours} 小时 ${minutes} 分`;
    if (hours > 0) return `${hours} 小时`;
    return `${minutes} 分`;
  }
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function formatUsdCents(value: number, locale: Locale): string {
  if (!Number.isFinite(value) || value <= 0) return 'USD 0';
  return new Intl.NumberFormat(localeTag(locale), {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value / 100);
}

function formatActivityDateLabel(key: string, locale: Locale): string {
  const date = parseDateKey(key);
  if (!date) return key;
  return new Intl.DateTimeFormat(localeTag(locale), {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function formatMonthAxisLabel(date: Date, locale: Locale): string {
  if (locale === 'zh') return `${date.getMonth() + 1}月`;
  return new Intl.DateTimeFormat(localeTag(locale), { month: 'short' }).format(date);
}

function formatAccountTokenTooltip(
  bucket: AccountTokenActivityBucket,
  mode: AccountTokenUsageMode,
  locale: Locale,
  t: Translate,
): string {
  const date = formatActivityDateLabel(bucket.label, locale);
  const tokens = formatCompactNumber(bucket.tokens, locale);
  const key =
    mode === 'weekly'
      ? 'Token usage tooltip weekly'
      : mode === 'yearly'
        ? 'Token usage tooltip yearly'
        : 'Token usage tooltip daily';
  return t(key).replace('{date}', date).replace('{tokens}', tokens);
}

function buildAccountTokenActivity(
  events: AccountTokenCostEvent[],
  mode: AccountTokenUsageMode,
  locale: Locale,
): {
  buckets: AccountTokenActivityBucket[];
  monthLabels: { key: string; label: string; column: number }[];
  activeBuckets: number;
  peakBucket: AccountTokenActivityBucket | null;
} {
  const today = startOfLocalDay(new Date());
  const rangeStart = addDays(today, -(TOKEN_ACTIVITY_DAYS - 1));
  const displayStart = startOfLocalWeek(rangeStart);
  const displayEnd = addDays(startOfLocalWeek(today), 7);
  const dayCount = daysBetween(displayStart, displayEnd);
  const columns = Math.ceil(dayCount / 7);
  const rangeEnd = addDays(today, 1);
  const monthLabels: { key: string; label: string; column: number }[] = [];
  const buckets: AccountTokenActivityBucket[] = [];

  const accumulate = (bucket: AccountTokenActivityBucket, event: AccountTokenCostEvent) => {
    bucket.tokens += eventTokenMass(event);
    bucket.cachedTokens += numberOrZero(event.cached_input_tokens);
    bucket.durationSeconds = Math.max(bucket.durationSeconds, numberOrZero(event.duration_seconds));
    bucket.costCents += numberOrZero(event.cost_cents);
    bucket.events += 1;
  };

  const dailyBuckets = new Map<string, AccountTokenActivityBucket>();
  for (let index = 0; index < dayCount; index += 1) {
    const bucketDate = addDays(displayStart, index);
    const isOutsideRange = bucketDate < rangeStart || bucketDate > today;
    const column = Math.floor(index / 7);
    if (bucketDate.getDate() === 1 || index === 0) {
      monthLabels.push({
        key: `${bucketDate.getFullYear()}-${bucketDate.getMonth() + 1}`,
        label: formatMonthAxisLabel(bucketDate, locale),
        column,
      });
    }
    const key = formatDateKey(bucketDate);
    const bucket: AccountTokenActivityBucket = {
      key,
      groupKey: key,
      label: key,
      tokens: 0,
      cachedTokens: 0,
      durationSeconds: 0,
      costCents: 0,
      events: 0,
      level: 0,
      column,
      empty: isOutsideRange,
    };
    buckets.push(bucket);
    if (!isOutsideRange) dailyBuckets.set(key, bucket);
  }

  if (mode === 'weekly') {
    const weeklyTotals = new Map<string, AccountTokenActivityBucket>();
    for (let column = 0; column < columns; column += 1) {
      const weekStart = addDays(displayStart, column * 7);
      const weekEnd = addDays(weekStart, 6);
      const weekEndKey = formatDateKey(weekEnd > today ? today : weekEnd);
      weeklyTotals.set(weekEndKey, {
        key: weekEndKey,
        groupKey: weekEndKey,
        label: weekEndKey,
        tokens: 0,
        cachedTokens: 0,
        durationSeconds: 0,
        costCents: 0,
        events: 0,
        level: 0,
        column,
      });
    }
    for (const event of events) {
      if (typeof event.occurred_at !== 'number' || !Number.isFinite(event.occurred_at)) continue;
      const eventDate = startOfLocalDay(new Date(event.occurred_at * 1000));
      if (eventDate < rangeStart || eventDate >= rangeEnd) continue;
      const weekEnd = addDays(startOfLocalWeek(eventDate), 6);
      const key = formatDateKey(weekEnd > today ? today : weekEnd);
      const weekBucket = weeklyTotals.get(key);
      if (weekBucket) accumulate(weekBucket, event);
    }
    for (const bucket of buckets) {
      const bucketDate = parseDateKey(bucket.key);
      if (!bucketDate) continue;
      const weekEnd = addDays(startOfLocalWeek(bucketDate), 6);
      const key = formatDateKey(weekEnd > today ? today : weekEnd);
      const weekBucket = weeklyTotals.get(key);
      if (!weekBucket) continue;
      bucket.groupKey = key;
      bucket.label = weekBucket.label;
      bucket.tokens = weekBucket.tokens;
      bucket.cachedTokens = weekBucket.cachedTokens;
      bucket.durationSeconds = weekBucket.durationSeconds;
      bucket.costCents = weekBucket.costCents;
      bucket.events = weekBucket.events;
      bucket.empty = false;
    }
  } else {
    for (const event of events) {
      if (typeof event.occurred_at !== 'number' || !Number.isFinite(event.occurred_at)) continue;
      const eventDate = startOfLocalDay(new Date(event.occurred_at * 1000));
      if (eventDate < rangeStart || eventDate >= rangeEnd) continue;
      const bucket = dailyBuckets.get(formatDateKey(eventDate));
      if (bucket) accumulate(bucket, event);
    }
  }

  if (mode === 'yearly') {
    let runningTokens = 0;
    let runningCached = 0;
    let runningCost = 0;
    let runningEvents = 0;
    for (const bucket of buckets) {
      if (bucket.empty) continue;
      runningTokens += bucket.tokens;
      runningCached += bucket.cachedTokens;
      runningCost += bucket.costCents;
      runningEvents += bucket.events;
      bucket.tokens = runningTokens;
      bucket.cachedTokens = runningCached;
      bucket.costCents = runningCost;
      bucket.events = runningEvents;
    }
  }

  const representativeBuckets =
    mode === 'weekly'
      ? Array.from(
          buckets
            .filter((bucket) => !bucket.empty)
            .reduce((map, bucket) => map.set(bucket.groupKey, bucket), new Map<string, AccountTokenActivityBucket>())
            .values(),
        )
      : buckets.filter((bucket) => !bucket.empty);
  const maxTokens = Math.max(0, ...representativeBuckets.map((bucket) => bucket.tokens));
  let peakBucket: AccountTokenActivityBucket | null = null;
  let activeBuckets = 0;
  const levelByGroup = new Map<string, number>();
  for (const bucket of representativeBuckets) {
    if (bucket.tokens > 0) {
      activeBuckets += 1;
      const level = Math.max(1, Math.ceil((bucket.tokens / Math.max(maxTokens, 1)) * 4));
      levelByGroup.set(bucket.groupKey, level);
      if (!peakBucket || bucket.tokens > peakBucket.tokens) peakBucket = bucket;
    }
  }
  for (const bucket of buckets) {
    bucket.level = levelByGroup.get(bucket.groupKey) ?? 0;
  }
  return { buckets, monthLabels, activeBuckets, peakBucket };
}

// Render a masked relay amount (balance / credits / quota) as "<currency> <value>".
// Returns null when the value is absent (relay omitted it) so the caller can show a
// localized "unknown" instead — a missing amount must never read as a real 0, which
// would mislead the user into thinking their balance/quota is exhausted. Trailing
// zeros are trimmed for readability (5.0000 → 5, 0.0012 stays 0.0012).
function formatRelayAmount(value: number | null, currency: string): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const trimmed = value.toFixed(4).replace(/\.?0+$/, '');
  return `${currency} ${trimmed === '' || trimmed === '-0' ? '0' : trimmed}`;
}

export interface SettingsNavItem {
  label: string;
  target: string;
  icon: ReactNode;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

export interface ThemePreferenceOption {
  value: AppThemePreference;
  label: string;
  ariaLabel: string;
  icon: ReactNode;
}

export interface SettingsSidebarProps {
  copy: ShellCopy;
  navGroups: SettingsNavGroup[];
  activeSettingsTarget: string;
  onSelectTarget: (target: string) => void;
  onBackToApp: () => void;
}

export function SettingsSidebar({
  copy,
  navGroups,
  activeSettingsTarget,
  onSelectTarget,
  onBackToApp,
}: SettingsSidebarProps) {
  return (
    <aside className="settings-sidebar" aria-label={copy.settingsNavigation}>
      <button className="settings-back-button" type="button" onClick={onBackToApp}>
        <ArrowLeft size={17} aria-hidden="true" />
        {copy.backToApp}
      </button>
      <nav className="settings-nav-list">
        {navGroups.map((group) => (
          <section key={group.label} className="settings-nav-group" aria-label={group.label}>
            <span>{group.label}</span>
            {group.items.map((item) => (
              <button
                key={item.label}
                className={activeSettingsTarget === item.target ? 'active' : ''}
                type="button"
                onClick={() => onSelectTarget(item.target)}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </section>
        ))}
      </nav>
    </aside>
  );
}

export interface SettingsContentProps {
  t: Translate;
  copy: ShellCopy;
  activeSettingsSection: SettingsSectionId;
  // overview
  themePreferenceOptions: ThemePreferenceOption[];
  themePreference: AppThemePreference;
  switchThemePreference: (preference: AppThemePreference) => void;
  // appearance: color-scheme presets + custom palette (kernel-owned, see appearance.ts)
  appearance: AppearancePayload | null;
  activeCanvas: AppearanceCanvas;
  selectAppearancePreset: (presetId: string) => void;
  setAppearanceCustomColor: (canvas: AppearanceCanvas, tokenId: string, hex: string) => void;
  resetAppearance: () => void;
  exportAppearance: () => Promise<void> | void;
  importAppearanceBundle: (bundle: unknown) => Promise<AppearancePayload> | void;
  locale: Locale;
  switchLocale: (locale: Locale) => void;
  // security: reference-viewer "confirm before preview" preference
  previewConfirmEnabled: boolean;
  setPreviewConfirm: (next: boolean) => void;
  // security: route the preview fetch through the OS proxy (fake-IP/VPN support)
  previewProxyEnabled: boolean;
  setPreviewProxy: (next: boolean) => void;
  // runtime: agent runtime configuration
  selectedAgentAvailable: boolean;
  selectedBackend: string;
  agentInventory: AgentInventoryInfo[];
  openAgentSetupFor: (agentName: string) => void;
  agentExecutableDraft: string;
  setAgentExecutableDraft: (value: string) => void;
  selectedAgentExecutableConfigName: string;
  selectedAgentInfo: AgentInventoryInfo | null;
  runtimeConfig: RuntimeConfigPayload | null;
  runtimeStatus: RuntimeStatusPayload | null;
  selectedAgentReadinessText: string;
  saveAgentRuntimeSetup: () => Promise<void>;
  setAgentSetupOpen: (open: boolean) => void;
  // runtime: ClawHunt login
  authStatus: ClawHuntAuthPayload | null;
  // Normalized account overview (kernel account_overview() via GET /api/relay/account):
  // purchased package (billing_plan) vs effective entitlement (+source) vs self-funded
  // relay usage — distinct sources so an admin's unlimited bypass is never shown as a
  // purchase. null = not yet loaded; ok=false = surface unreachable.
  accountOverview: {
    ok: boolean;
    code?: string;
    error?: string;
    logged_in?: boolean;
    billing_plan?: string | null; // basic/standard/advanced or null (what you bought)
    entitlement?: string | null; // 'unlimited' | <plan> | 'payg' | 'free' (what you can use)
    entitlement_source?: string | null; // admin/trial/grant/subscription/payg/free
    unlimited?: boolean;
    free_chats_remaining?: number | null;
    free_chat_limit?: number | null;
    chat_credits?: number | null;
    relay?: {
      ok?: boolean;
      account_balance?: number | null;
      key_credits_used?: number | null;
      key_quota_limit?: number | null;
      currency?: string;
    } | null;
  } | null;
  loadAccountOverview: () => Promise<void>;
  accountTokenUsageMode: AccountTokenUsageMode;
  setAccountTokenUsageMode: (mode: AccountTokenUsageMode) => void;
  accountTokenUsage: AccountTokenUsageData;
  loadAccountTokenUsage: () => Promise<void>;
  clawHuntAccountName: string;
  // Verified main-site SSO identity. This signs the human into the canvas but
  // does not imply that a relay agent key has been provisioned.
  clawHuntSsoSignedIn: boolean;
  // Account avatar URL (empty when none); rendered as the signed-in account header
  // alongside the name, reusing the bottom-left account menu's visual language.
  clawHuntAccountAvatar: string;
  clawHuntBrowserLoginBusy: string;
  accountLoginBusy: boolean;
  // Starts the main-site token bridge. SuperClaw never renders or submits the
  // user's main-site password.
  openLoginDialog: () => void;
  logoutClawHunt: () => Promise<void>;
  // runtime: runtime settings (schema-driven; see RuntimeRoster)
  saveRuntimeConfigValue: (name: string, value: string) => Promise<boolean>;
  // desktop shell metadata (rendered in the Diagnostics → updater card)
  desktopShellInfo: DesktopShellInfo | null;
  // operations
  copyWorkspaceUpdateCommand: () => Promise<void>;
  desktopAlertsEnabled: boolean;
  desktopAlertPermission: string;
  desktopAlertHistory: DesktopAlertEntry[];
  enableDesktopAlerts: () => Promise<void>;
  disableDesktopAlerts: () => void;
  sendTestDesktopAlert: () => void;
  generateIncidentExport: () => void;
  desktopIncidentExport: DesktopIncidentExport | null;
  // diagnostics
  probeResults: Record<string, RuntimeProbeResult>;
  probingBackends: Record<string, boolean>;
  probeAllBusy: boolean;
  probeRuntime: (backend: string) => void;
  probeRuntimeDeep: (backend: string) => void;
  probeAllRuntimes: () => void;
  invalidateProbe: (backend: string) => void;
}

// Convert a computed `rgb(...)`/`rgba(...)`/`#hex` string into a `#rrggbb` value an
// `<input type="color">` accepts. Falls back to a neutral grey on anything unparseable.
function toHexColor(value: string): string {
  const trimmed = value.trim();
  if (isValidHex(trimmed)) {
    let body = trimmed.slice(1).toLowerCase();
    if (body.length === 3) body = body.split('').map((c) => c + c).join('');
    return `#${body}`;
  }
  const match = trimmed.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (match) {
    const hex = match
      .slice(1, 4)
      .map((n) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0'))
      .join('');
    return `#${hex}`;
  }
  return '#888888';
}

interface ColorSchemeDialogProps {
  t?: (zh: string, en: string) => string;
  busy?: boolean;
  serializeChanges?: boolean;
  serverError?: string;
  onReload?: () => void;
  open: boolean;
  onClose: () => void;
  appearance: AppearancePayload;
  activeCanvas: AppearanceCanvas;
  selectPreset: (presetId: string) => void;
  setCustomColor: (canvas: AppearanceCanvas, tokenId: string, hex: string) => void;
  resetAppearance: () => void;
  exportAppearance: () => Promise<void> | void;
  importBundle: (bundle: unknown) => Promise<AppearancePayload> | void;
}

// The color scheme lives in a focused modal (DialogShell) launched from the
// Appearance row, instead of a sprawling inline panel — it matches the rest of
// the settings surface (one row + a control) and keeps the heavy preset/token
// grid out of the page until the user asks for it.
export function ColorSchemeDialog({
  t = (_zh, en) => en,
  busy = false,
  serializeChanges = false,
  serverError,
  onReload,
  open,
  onClose,
  appearance,
  activeCanvas,
  selectPreset,
  setCustomColor,
  resetAppearance,
  exportAppearance,
  importBundle,
}: ColorSchemeDialogProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // Per-token editing + bundle import/export are advanced: they stay collapsed so the
  // default view is just the constrained preset list. Picking "Custom" auto-expands it.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const customActive = appearance.active_preset === appearance.custom_preset_id;
  // The colors actually in effect for this canvas under the active scheme, read
  // from the kernel payload (NOT getComputedStyle). The payload updates the same
  // tick a preset is chosen, so an *overridden* swatch reflects the new scheme
  // immediately, with no lag.
  const activeOverrides = resolveOverrides(appearance, activeCanvas);

  // Stylesheet-default colors for tokens the active scheme does NOT override (so they
  // fall back to the stock theme). These can only come from the live DOM — but reading
  // getComputedStyle during render would capture the PREVIOUS scheme, because the
  // authoritative var-clearing (App's applyAppearance effect) runs after this child
  // renders, and with no further re-render the swatch would stay stale forever. So we
  // read them in a post-commit requestAnimationFrame (after applyAppearance has settled
  // the DOM) and store them in state; its re-render reverts the swatch to the correct
  // stock color. Seeded synchronously on mount too (scheme already applied → no flash).
  function readFallbackSeeds(): Record<string, string> {
    if (typeof document === 'undefined') return {};
    const root = document.documentElement;
    const out: Record<string, string> = {};
    for (const token of appearance.tokens) {
      const computed = getComputedStyle(root).getPropertyValue(token.css_var);
      if (computed) out[token.id] = toHexColor(computed);
    }
    return out;
  }
  const [fallbackSeeds, setFallbackSeeds] = useState<Record<string, string>>(readFallbackSeeds);
  useEffect(() => {
    if (typeof requestAnimationFrame === 'undefined') {
      setFallbackSeeds(readFallbackSeeds());
      return;
    }
    const raf = requestAnimationFrame(() => setFallbackSeeds(readFallbackSeeds()));
    return () => cancelAnimationFrame(raf);
    // readFallbackSeeds closes over the current appearance; re-read whenever the scheme
    // or canvas changes so a switch to a lighter preset reverts uncovered swatches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appearance, activeCanvas]);

  // The hex to seed a token's color input: the active scheme's value if it overrides the
  // token (from the payload, immediate); otherwise the settled stock default; else grey.
  function seedColor(token: AppearanceToken): string {
    const active = activeOverrides[token.id];
    if (active && isValidHex(active)) return toHexColor(active);
    return fallbackSeeds[token.id] ?? '#888888';
  }

  async function onImportFile(event: ChangeEvent<HTMLInputElement>) {
    setImportError(null);
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-importing the same file
    if (!file) return;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      await importBundle(bundle);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    }
  }

  return (
    <DialogShell
      open={open}
      variant="default"
      titleId="settings-color-scheme-title"
      title={t('配色', 'Color scheme')}
      subtitle={t(`预设和自定义颜色应用于${activeCanvas === 'dark' ? '深色' : '浅色'}主题。`, `Presets and custom colors layer on top of the ${activeCanvas} theme.`)}
      closeLabel={t('关闭', 'Close')}
      onClose={onClose}
      dismissable
    >
      <div className="color-scheme-dialog">
        {serverError && <p role="alert" className="color-scheme-error">{serverError} {onReload && <button type="button" disabled={busy} onClick={onReload}>{t('重新加载配色', 'Reload color scheme')}</button>}</p>}
        {busy && <p role="status">{t('正在保存配色…', 'Saving color scheme…')}</p>}
        <fieldset disabled={busy && !serializeChanges} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <section className="color-scheme-section">
          <h3 className="color-scheme-section-title">{t('预设', 'Preset')}</h3>
          <div className="color-scheme-presets" role="radiogroup" aria-label={t('配色预设', 'Color scheme presets')}>
            {appearance.presets.map((preset) => {
              const selected = !customActive && appearance.active_preset === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`color-scheme-preset${selected ? ' is-selected' : ''}`}
                  onClick={() => selectPreset(preset.id)}
                  title={preset.description}
                >
                  <span className="color-scheme-swatch" style={{ background: preset.swatch }} aria-hidden="true" />
                  <span className="color-scheme-preset-label">{preset.label}</span>
                </button>
              );
            })}
            <button
              type="button"
              role="radio"
              aria-checked={customActive}
              className={`color-scheme-preset${customActive ? ' is-selected' : ''}`}
              onClick={() => {
                selectPreset(appearance.custom_preset_id);
                setAdvancedOpen(true);
              }}
              title={t('使用自定义配色', 'Use your custom palette')}
            >
              <span className="color-scheme-swatch color-scheme-swatch-custom" aria-hidden="true" />
              <span className="color-scheme-preset-label">{t('自定义', 'Custom')}</span>
            </button>
          </div>
        </section>

        <details className="color-scheme-advanced" open={advancedOpen}>
          <summary
            className="color-scheme-advanced-summary"
            onClick={(event) => {
              // Fully React-controlled: suppress the browser's native toggle so `open` is
              // driven solely by `advancedOpen` (no semi-controlled DOM-vs-state flicker,
              // and no conflict with the programmatic expand when "Custom" is picked).
              event.preventDefault();
              setAdvancedOpen((prev) => !prev);
            }}
          >
            <ChevronRight size={16} aria-hidden="true" className="color-scheme-advanced-caret" />
            <span>{t('高级 — 自定义颜色', 'Advanced — custom colors')}</span>
          </summary>
          <div className="color-scheme-advanced-body">
            <p className="color-scheme-section-hint">{t('编辑颜色将切换到自定义配色。', 'Editing a color switches to your custom palette.')}</p>
            <div className="color-scheme-tokens">
              {appearance.tokens.map((token) => (
                <label key={token.id} className="color-scheme-token">
                  <span className="color-scheme-token-swatch">
                    <input
                      type="color"
                      value={seedColor(token)}
                      aria-label={`${token.label} color`}
                      onChange={(event) => setCustomColor(activeCanvas, token.id, event.target.value)}
                    />
                  </span>
                  <span className="color-scheme-token-label">{token.label}</span>
                </label>
              ))}
            </div>
            <div className="color-scheme-advanced-actions">
              <button type="button" className="text-button" onClick={() => fileInputRef.current?.click()}>
                <ExternalLink size={15} aria-hidden="true" /> {t('导入', 'Import')}
              </button>
              <button type="button" disabled={busy} className="text-button" onClick={() => void exportAppearance()}>
                <Download size={15} aria-hidden="true" /> {t('导出', 'Export')}
              </button>
            </div>
          </div>
        </details>

        {importError ? (
          <p className="color-scheme-error" role="alert">
            {importError}
          </p>
        ) : null}

        <footer className="color-scheme-dialog-actions">
          <button type="button" className="text-button" onClick={resetAppearance}>
            <RefreshCw size={15} aria-hidden="true" /> {t('恢复默认', 'Reset to default')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={onImportFile}
          />
        </footer>
        </fieldset>
      </div>
    </DialogShell>
  );
}

export function SettingsContent({
  t,
  copy,
  activeSettingsSection,
  themePreferenceOptions,
  themePreference,
  switchThemePreference,
  appearance,
  activeCanvas,
  selectAppearancePreset,
  setAppearanceCustomColor,
  resetAppearance,
  exportAppearance,
  importAppearanceBundle,
  locale,
  switchLocale,
  previewConfirmEnabled,
  setPreviewConfirm,
  previewProxyEnabled,
  setPreviewProxy,
  selectedAgentAvailable,
  selectedBackend,
  agentInventory,
  openAgentSetupFor,
  agentExecutableDraft,
  setAgentExecutableDraft,
  selectedAgentExecutableConfigName,
  selectedAgentInfo,
  runtimeConfig,
  runtimeStatus,
  selectedAgentReadinessText,
  saveAgentRuntimeSetup,
  setAgentSetupOpen,
  authStatus,
  accountOverview,
  loadAccountOverview,
  accountTokenUsageMode,
  setAccountTokenUsageMode,
  accountTokenUsage,
  loadAccountTokenUsage,
  clawHuntAccountName,
  clawHuntSsoSignedIn,
  clawHuntAccountAvatar,
  clawHuntBrowserLoginBusy,
  accountLoginBusy,
  openLoginDialog,
  logoutClawHunt,
  saveRuntimeConfigValue,
  desktopShellInfo,
  copyWorkspaceUpdateCommand,
  desktopAlertsEnabled,
  desktopAlertPermission,
  desktopAlertHistory,
  enableDesktopAlerts,
  disableDesktopAlerts,
  sendTestDesktopAlert,
  generateIncidentExport,
  desktopIncidentExport,
  probeResults,
  probingBackends,
  probeAllBusy,
  probeRuntime,
  probeRuntimeDeep,
  probeAllRuntimes,
  invalidateProbe,
}: SettingsContentProps) {
  // The color-scheme editor opens in a modal launched from the Appearance row.
  const [colorSchemeOpen, setColorSchemeOpen] = useState(false);
  // Derived ClawHunt link state for the decluttered Account card: the card shows one
  // human-readable identity line + a status pill instead of the raw authStatus fields.
  // Escape hatches the advisors flagged: surface the agent-key-only mode (key set but no
  // account) and the half-linked failure (account set but agent key never
  // provisioned) instead of letting either read as a clean signed-in/out state.
  const clawHuntAccountState = authStatus?.clawhunt.account;
  const clawHuntAgentKeyState = authStatus?.clawhunt.agent_api_key;
  const clawHuntSignedIn = clawHuntSsoSignedIn || clawHuntAccountState === 'set';
  const clawHuntKeyOnly = !clawHuntSignedIn && clawHuntAgentKeyState === 'set';
  const clawHuntAgentKeyNotReady = clawHuntSignedIn && clawHuntAgentKeyState !== 'set';
  // clawHuntAccountName is 'unset' when signed out and falls back to 'set' when the
  // account has no human-readable field — never render "Signed in as set/unset".
  const clawHuntAccountLabel =
    clawHuntAccountName && !['set', 'unset', ''].includes(clawHuntAccountName) ? clawHuntAccountName : null;
  // Secondary identity line (email) for the signed-in account header — only when it
  // exists and differs from the primary label, so we never print it twice.
  const clawHuntAccountEmail = authStatus?.clawhunt.account_user?.email;
  const clawHuntAccountSecondary =
    typeof clawHuntAccountEmail === 'string' && clawHuntAccountEmail && clawHuntAccountEmail !== clawHuntAccountLabel
      ? clawHuntAccountEmail
      : null;
  const clawHuntLinkTone = clawHuntAgentKeyNotReady
    ? 'warn'
    : clawHuntSignedIn
      ? 'good'
      : clawHuntKeyOnly
        ? 'warn'
        : 'neutral';
  const clawHuntLinkLabel =
    clawHuntSignedIn && !clawHuntAgentKeyNotReady
      ? t('ClawHunt link linked')
      : clawHuntSignedIn || clawHuntKeyOnly
        ? t('ClawHunt link limited')
        : t('ClawHunt link required');
  // 账户信息分源派生（kernel account_overview()）：购买套餐 / 有效权益(+来源) / 自费中转
  // 余额 / 套餐额度——绝不混。admin 的无限旁路显示为"权益"而非"购买的套餐"。
  const acct = accountOverview;
  const relay = acct?.relay ?? null;
  const relayCurrency = relay?.currency ?? 'USD';
  // ① 当前套餐（买了哪个 v18 卡包）：首字母大写；未购/admin → null（JSX 显示"未订阅"）。
  const billingPlanRaw = acct?.billing_plan ?? null;
  const billingPlanName = billingPlanRaw
    ? billingPlanRaw.charAt(0).toUpperCase() + billingPlanRaw.slice(1)
    : null;
  // ② 当前权益（能用什么）+ 来源（admin/trial/grant 才单独标，subscription/payg/free 不赘）。
  const entitlement = acct?.entitlement ?? null;
  const _sourceKeys: Record<string, AppCopyKey> = {
    admin: 'Source admin',
    trial: 'Source trial',
    grant: 'Source grant',
  };
  const _srcKey = acct?.entitlement_source ? _sourceKeys[acct.entitlement_source] : undefined;
  const entitlementSourceLabel = _srcKey ? t(_srcKey) : null;
  let entitlementLabel: string | null = null;
  if (entitlement === 'unlimited') entitlementLabel = t('Entitlement unlimited');
  else if (entitlement === 'payg') entitlementLabel = t('Relay plan none');
  else if (entitlement === 'free') entitlementLabel = t('Entitlement free');
  else if (entitlement) entitlementLabel = entitlement.charAt(0).toUpperCase() + entitlement.slice(1);
  // ③ 中转余额（自费 LLMgate 积分）：明确标"自费"，不当头条；relay 子查询失败 → null。
  const relayBalanceText = relay?.ok
    ? formatRelayAmount(relay.account_balance ?? null, relayCurrency)
    : null;
  // ④ 套餐额度（relay key 配额）：有真实上限(quota>0)才画进度条；==0 不限额；否则暂未同步。
  const relayQuota = relay?.key_quota_limit ?? null;
  const relayUsed = relay?.key_credits_used ?? null;
  const relayUsedText = formatRelayAmount(relayUsed, relayCurrency);
  const relayQuotaText =
    relayQuota === 0 ? t('Relay quota unlimited') : formatRelayAmount(relayQuota, relayCurrency);
  const relayQuotaPct =
    typeof relayQuota === 'number' && relayQuota > 0 && typeof relayUsed === 'number'
      ? Math.min(100, Math.max(0, (relayUsed / relayQuota) * 100))
      : null;
  // ClawHunt main-site wallet + subscription, mirroring the main ClawHunt site. Sourced from
  // account_user (the /api/auth/me UserResponse fields, now passed through the auth
  // whitelist); *_balance arrive as integer cents.
  const clawHuntAccountUser = authStatus?.clawhunt.account_user ?? null;
  const clawHuntWalletCents =
    typeof clawHuntAccountUser?.wallet_balance === 'number' ? clawHuntAccountUser.wallet_balance : null;
  const clawHuntFrozenCents =
    typeof clawHuntAccountUser?.frozen_balance === 'number' ? clawHuntAccountUser.frozen_balance : null;
  const clawHuntWalletText = clawHuntWalletCents != null ? `$${(clawHuntWalletCents / 100).toFixed(2)}` : null;
  const clawHuntFrozenText =
    clawHuntFrozenCents != null && clawHuntFrozenCents > 0 ? `$${(clawHuntFrozenCents / 100).toFixed(2)}` : null;
  const clawHuntPlanRaw =
    (typeof clawHuntAccountUser?.superclaw_plan === 'string' && clawHuntAccountUser.superclaw_plan) ||
    (typeof clawHuntAccountUser?.tier === 'string' && clawHuntAccountUser.tier) ||
    null;
  const clawHuntPlanText = clawHuntPlanRaw
    ? clawHuntPlanRaw.charAt(0).toUpperCase() + clawHuntPlanRaw.slice(1)
    : null;
  const [activeAccountTokenGroup, setActiveAccountTokenGroup] = useState<string | null>(null);
  const accountActivity = buildAccountTokenActivity(accountTokenUsage.events, accountTokenUsageMode, locale);
  const periodSummary = accountTokenUsage.summary;
  const lifetimeSummary = accountTokenUsage.lifetime ?? periodSummary;
  const peakBucket = accountActivity.peakBucket;
  const activeTokenBucket = activeAccountTokenGroup
    ? accountActivity.buckets.find((bucket) => !bucket.empty && bucket.groupKey === activeAccountTokenGroup)
    : null;
  const activeTokenTooltip = activeTokenBucket
    ? formatAccountTokenTooltip(activeTokenBucket, accountTokenUsageMode, locale, t)
    : null;
  const accountActivityColumnCount = Math.max(1, ...accountActivity.buckets.map((bucket) => bucket.column + 1));
  const longestTaskSeconds = Math.max(
    0,
    ...accountTokenUsage.events.map((event) => numberOrZero(event.duration_seconds)),
  );
  const accountTokenBreakdown = t('Token usage breakdown')
    .replace('{input}', formatCompactNumber(numberOrZero(periodSummary?.input_tokens), locale))
    .replace('{cached}', formatCompactNumber(numberOrZero(periodSummary?.cached_input_tokens), locale))
    .replace('{output}', formatCompactNumber(numberOrZero(periodSummary?.output_tokens), locale));
  const lifetimeTokenBreakdown = t('Token usage breakdown')
    .replace('{input}', formatCompactNumber(numberOrZero(lifetimeSummary?.input_tokens), locale))
    .replace('{cached}', formatCompactNumber(numberOrZero(lifetimeSummary?.cached_input_tokens), locale))
    .replace('{output}', formatCompactNumber(numberOrZero(lifetimeSummary?.output_tokens), locale));
  const accountTokenModeOptions: {
    value: AccountTokenUsageMode;
    label: string;
    ariaLabel: string;
  }[] = [
    { value: 'daily', label: t('Token usage daily'), ariaLabel: t('Token usage daily') },
    { value: 'weekly', label: t('Token usage weekly'), ariaLabel: t('Token usage weekly') },
    { value: 'yearly', label: t('Token usage yearly'), ariaLabel: t('Token usage yearly') },
  ];
  return (
    <div
      className={[
        'settings-content-stack',
        activeSettingsSection === 'account' ? 'settings-content-stack-account' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {activeSettingsSection === 'preferences' ? (
      <section className="settings-section" aria-labelledby="settings-preferences-heading">
        <header className="settings-section-header">
          <span className="settings-section-kicker">{copy.settingsPreferences}</span>
          <div>
            <h2 id="settings-preferences-heading">{t('Settings section preferences')}</h2>
            <p>{t('Settings section preferences description')}</p>
          </div>
        </header>
        <SettingsPanel ariaLabel="Appearance">
          <SettingRow
            id="settings-appearance"
            icon={<Palette size={18} aria-hidden="true" />}
            label={t('Appearance settings')}
            description={t('Appearance settings description')}
            control={
              <>
                <SegmentedControl
                  ariaLabel={copy.themePreference}
                  options={themePreferenceOptions}
                  value={themePreference}
                  onChange={switchThemePreference}
                />
                {appearance ? (
                  <button
                    type="button"
                    className="color-scheme-trigger"
                    aria-label="Customize color scheme"
                    title="Color scheme"
                    onClick={() => setColorSchemeOpen(true)}
                  >
                    <Palette size={17} aria-hidden="true" />
                  </button>
                ) : null}
              </>
            }
          />
          <SettingRow
            id="settings-language"
            icon={<Languages size={18} aria-hidden="true" />}
            label={copy.language}
            control={
              <SegmentedControl
                ariaLabel={copy.language}
                options={[
                  { value: 'en', label: 'EN', ariaLabel: copy.switchToEnglish },
                  { value: 'zh', label: '中文', ariaLabel: copy.switchToChinese },
                ]}
                value={locale}
                onChange={switchLocale}
              />
            }
          />
        </SettingsPanel>
        {appearance && colorSchemeOpen ? (
          <ColorSchemeDialog
            open
            onClose={() => setColorSchemeOpen(false)}
            appearance={appearance}
            activeCanvas={activeCanvas}
            selectPreset={selectAppearancePreset}
            setCustomColor={setAppearanceCustomColor}
            resetAppearance={resetAppearance}
            exportAppearance={exportAppearance}
            importBundle={importAppearanceBundle}
          />
        ) : null}
        <SettingsPanel ariaLabel={t('Desktop alerts')}>
          <SettingRow
            icon={<Bell size={18} aria-hidden="true" />}
            label={t('Desktop alerts')}
            description={`Permission: ${desktopAlertPermission}`}
            control={
              <ToggleSwitch
                ariaLabel={t('Desktop alerts')}
                checked={desktopAlertsEnabled}
                onChange={(next) => {
                  if (next) {
                    void enableDesktopAlerts();
                  } else {
                    disableDesktopAlerts();
                  }
                }}
              />
            }
          />
          <SettingRow
            label={t('Send test alert')}
            description={`History: ${desktopAlertHistory.length} recent alerts`}
            control={
              <button className="text-button compact" onClick={() => sendTestDesktopAlert()}>
                {t('Send test alert')}
              </button>
            }
            footer={
              <div className="timeline-list" aria-label="Desktop alert history">
                {desktopAlertHistory.length ? (
                  desktopAlertHistory.map((entry) => (
                    <article key={entry.id} className={`timeline-item ${entry.severity === 'bad' ? 'ready' : 'complete'}`}>
                      <div>
                        <strong>{entry.title}</strong>
                        <p>{entry.detail}</p>
                        <p>{entry.created_at}</p>
                      </div>
                      <span>{entry.severity}</span>
                    </article>
                  ))
                ) : (
                  <article className="timeline-item ready">
                    <div>
                      <strong>{t('No desktop alerts yet')}</strong>
                      <p>{t('No desktop alerts description')}</p>
                    </div>
                    <span>idle</span>
                  </article>
                )}
              </div>
            }
          />
        </SettingsPanel>
      </section>
      ) : null}
      {activeSettingsSection === 'account' ? (
      <section className="settings-section" aria-labelledby="settings-account-heading">
        <header className="settings-section-header">
          <span className="settings-section-kicker">{copy.settingsAccount}</span>
          <div>
            <h2 id="settings-account-heading">{t('Settings section account')}</h2>
            <p>{t('Settings section account description')}</p>
          </div>
        </header>
        <div className="control-grid" aria-label="ClawHunt account">
        <article id="settings-clawhunt" className="control-card">
          <div className="control-card-head">
            <UserRound size={18} aria-hidden="true" />
            <strong>{t('ClawHunt login')}</strong>
            <span className={`status-pill ${clawHuntLinkTone}`}>{clawHuntLinkLabel}</span>
          </div>
          {/* Signed-in account header (avatar + name + email), reusing the bottom-
              left account menu's visual language. Replaces the raw authStatus fields,
              which are no longer surfaced on the Account card. */}
          {clawHuntSignedIn ? (
            <div className="settings-account-identity">
              {clawHuntAccountAvatar ? (
                <img
                  className="account-avatar"
                  src={clawHuntAccountAvatar}
                  alt=""
                  aria-hidden="true"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <UserRound className="account-avatar-fallback" size={34} aria-hidden="true" />
              )}
              <div>
                {clawHuntAccountLabel ? (
                  <>
                    <span className="account-kicker">{copy.signedInAs}</span>
                    <strong>{clawHuntAccountLabel}</strong>
                    {clawHuntAccountSecondary ? (
                      <span className="settings-account-handle">{clawHuntAccountSecondary}</span>
                    ) : null}
                  </>
                ) : (
                  <strong>{t('ClawHunt signed in')}</strong>
                )}
              </div>
            </div>
          ) : clawHuntKeyOnly ? (
            <>
              <p>{t('ClawHunt agent key only')}</p>
              <p className="settings-hint">{t('ClawHunt agent key only hint')}</p>
            </>
          ) : (
            <p>{t('ClawHunt not signed in')}</p>
          )}
          {/* Escape hatch: signed in but the agent key never provisioned — surface
              it instead of letting the card read as a clean signed-in state. */}
          {clawHuntAgentKeyNotReady ? (
            <div className="settings-inline-notice" role="alert">
              <span className="status-pill warn">{t('ClawHunt link limited')}</span>
              <span>{t('ClawHunt agent key not ready')}</span>
            </div>
          ) : null}
          {/* ClawHunt main-site wallet + subscription, mirroring the main ClawHunt site. Shown
              when signed in; sits above the relay LLM meters so the two are never
              conflated (wallet = your ClawHunt credits; relay = this key's LLM usage). */}
          {clawHuntSignedIn && (clawHuntWalletText || clawHuntPlanText) ? (
            <div className="relay-usage" aria-label={t('ClawHunt wallet')}>
              <div className="relay-usage-stats">
                <div className="relay-usage-stat">
                  <span className="relay-usage-label">{t('ClawHunt wallet balance')}</span>
                  <span className={`relay-usage-value${clawHuntWalletText ? '' : ' muted'}`}>
                    {clawHuntWalletText ?? t('Relay value unknown')}
                  </span>
                </div>
                {clawHuntFrozenText ? (
                  <div className="relay-usage-stat">
                    <span className="relay-usage-label">{t('ClawHunt wallet frozen')}</span>
                    <span className="relay-usage-value">{clawHuntFrozenText}</span>
                  </div>
                ) : null}
                <div className="relay-usage-stat">
                  <span className="relay-usage-label">{t('ClawHunt plan')}</span>
                  <span className={`relay-usage-value${clawHuntPlanText ? '' : ' muted'}`}>
                    {clawHuntPlanText ?? t('ClawHunt plan none')}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
          {/* Relay balance/usage needs a real account login (own-balance key), so
              it is gated strictly on account === 'set'. Rendered as a sunken stat
              grid (balance / used / quota) instead of bare paragraphs; a null value
              shows a muted "unknown" so the panel stays legible before data lands. */}
          {authStatus?.clawhunt.account === 'set' ? (
            <div className="relay-usage" aria-label={t('Relay account')}>
              <div className="relay-usage-stats">
                {/* ① 当前套餐：买了哪个 v18 卡包；未购/admin → 未订阅。 */}
                <div className="relay-usage-stat">
                  <span className="relay-usage-label">{t('Relay plan')}</span>
                  <span className={`relay-usage-value${billingPlanName ? '' : ' muted'}`}>
                    {billingPlanName ?? t('Account not subscribed')}
                  </span>
                </div>
                {/* ② 当前权益：能用什么 + 来源（admin/trial/grant 才单独标）。主值包成叶子
                    span，来源/自费另起叶子 span，便于测试与样式弱化。 */}
                <div className="relay-usage-stat">
                  <span className="relay-usage-label">{t('Account entitlement')}</span>
                  <span className="relay-usage-value">
                    <span className={entitlementLabel ? undefined : 'muted'}>
                      {entitlementLabel ?? t('Relay value unknown')}
                    </span>
                    {entitlementSourceLabel ? (
                      <span className="relay-usage-source"> · {entitlementSourceLabel}</span>
                    ) : null}
                  </span>
                </div>
                {/* ③ 中转余额（自费 LLMgate 积分）：明确标自费，不当头条。 */}
                <div className="relay-usage-stat">
                  <span className="relay-usage-label">{t('Account relay balance')}</span>
                  <span className="relay-usage-value">
                    <span className={relayBalanceText ? undefined : 'muted'}>
                      {relayBalanceText ?? t('Relay value unknown')}
                    </span>
                    {relayBalanceText ? (
                      <span className="relay-usage-source"> · {t('Account self funded')}</span>
                    ) : null}
                  </span>
                </div>
                {/* ④ 套餐额度：有真实配额上限(quota>0)才画进度条；==0 不限额；否则暂未同步。 */}
                <div className="relay-usage-stat relay-usage-quota">
                  <span className="relay-usage-label">{t('Relay quota')}</span>
                  {relayQuota === 0 ? (
                    <span className="relay-usage-value muted">{t('Relay quota unlimited')}</span>
                  ) : relayQuotaPct !== null ? (
                    <>
                      <div
                        className="relay-usage-bar"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(relayQuotaPct)}
                      >
                        <div
                          className="relay-usage-bar-fill"
                          style={{ width: `${relayQuotaPct}%` }}
                        />
                      </div>
                      <span className="relay-usage-value">
                        {(relayUsedText ?? t('Relay value unknown')) +
                          ' / ' +
                          (relayQuotaText ?? t('Relay value unknown'))}
                      </span>
                    </>
                  ) : (
                    <span className="relay-usage-value muted">{t('Account quota unsynced')}</span>
                  )}
                </div>
              </div>
              <div className="relay-usage-foot">
                {acct && !acct.ok ? (
                  <p className="relay-usage-note">{t('Relay usage unavailable')}</p>
                ) : (
                  <span aria-hidden="true" />
                )}
                <button
                  className="text-button compact"
                  type="button"
                  onClick={() => void loadAccountOverview()}
                >
                  <RefreshCw size={16} />
                  {t('Refresh relay usage')}
                </button>
              </div>
            </div>
          ) : (
            <p className="settings-hint">{t('Relay usage signed out')}</p>
          )}
          {/* Primary action: when any auth is linked (SSO, runtime account, or a manual agent
              key) offer Logout so it can always be cleared; otherwise a single
              Sign-in entry starts the main-site bridge. */}
          <div className="inline-form">
            {clawHuntSsoSignedIn || authStatus?.clawhunt.account === 'set' || authStatus?.clawhunt.agent_api_key === 'set' ? (
              <button className="text-button compact" type="button" onClick={() => void logoutClawHunt()}>
                <Square size={16} />
                {t('Logout ClawHunt')}
              </button>
            ) : (
              <button
                className="text-button compact primary-action"
                type="button"
                onClick={openLoginDialog}
                disabled={Boolean(clawHuntBrowserLoginBusy) || accountLoginBusy}
              >
                <UserRound size={16} />
                {t('Sign in to ClawHunt')}
              </button>
            )}
          </div>
        </article>
        <article className="control-card account-token-usage-card" aria-label={t('Token usage')}>
          <div className="account-token-usage-head">
            <div>
              <div className="control-card-head account-token-title">
                <Activity size={18} aria-hidden="true" />
                <strong>{t('Token usage')}</strong>
              </div>
              <p>{t('Token usage description')}</p>
            </div>
            <div className="account-token-actions">
              <SegmentedControl
                ariaLabel={t('Token usage range')}
                options={accountTokenModeOptions}
                value={accountTokenUsageMode}
                onChange={setAccountTokenUsageMode}
              />
              <button
                className="text-button compact"
                type="button"
                onClick={() => void loadAccountTokenUsage()}
                disabled={accountTokenUsage.loading}
                aria-label={t('Refresh token usage')}
              >
                <RefreshCw size={16} aria-hidden="true" />
                {t('Refresh relay usage')}
              </button>
            </div>
          </div>
          {accountTokenUsage.error ? (
            <div className="settings-inline-notice" role="alert">
              <span className="status-pill warn">{t('Token usage unavailable')}</span>
              <span>{accountTokenUsage.error}</span>
            </div>
          ) : null}
          <div className="account-token-stat-grid">
            <div className="account-token-stat">
              <CalendarDays size={16} aria-hidden="true" />
              <span>{t('Token usage lifetime total')}</span>
              <strong>{formatCompactNumber(numberOrZero(lifetimeSummary?.total_tokens), locale)}</strong>
              <small>{lifetimeTokenBreakdown}</small>
            </div>
            <div className="account-token-stat">
              <Activity size={16} aria-hidden="true" />
              <span>{t('Token usage range total')}</span>
              <strong>{formatCompactNumber(numberOrZero(periodSummary?.total_tokens), locale)}</strong>
              <small>
                {formatCompactNumber(numberOrZero(periodSummary?.event_count), locale)} {t('Token usage events')}
              </small>
            </div>
            <div className="account-token-stat">
              <Flame size={16} aria-hidden="true" />
              <span>{t('Token usage peak tokens')}</span>
              <strong>{formatCompactNumber(peakBucket?.tokens ?? 0, locale)}</strong>
              <small>{peakBucket?.label || t('Token usage no data')}</small>
            </div>
            <div className="account-token-stat">
              <Clock3 size={16} aria-hidden="true" />
              <span>{t('Token usage longest task')}</span>
              <strong>{formatDurationSeconds(longestTaskSeconds, locale)}</strong>
              <small>{formatCompactNumber(accountActivity.activeBuckets, locale)} {t('Token usage active buckets')}</small>
            </div>
            <div className="account-token-stat">
              <Coins size={16} aria-hidden="true" />
              <span>{t('Token usage estimated cost')}</span>
              <strong>{formatUsdCents(numberOrZero(periodSummary?.total_cost_cents), locale)}</strong>
              <small>
                {formatCompactNumber(numberOrZero(periodSummary?.cached_input_tokens), locale)} {t('Token usage cached label')}
              </small>
            </div>
          </div>
          <div className="account-token-activity-head">
            <strong>{t('Token activity')}</strong>
            <span>{accountTokenBreakdown}</span>
          </div>
          <div className="account-token-map-scroll">
            <div className="account-token-map-inner">
              <div
                className={`account-token-heatmap ${accountTokenUsageMode}`}
                aria-label={t('Token activity')}
                onMouseLeave={() => setActiveAccountTokenGroup(null)}
              >
                {accountActivity.buckets.map((bucket) => {
                  const cellLabel = bucket.empty
                    ? undefined
                    : formatAccountTokenTooltip(bucket, accountTokenUsageMode, locale, t);
                  return (
                    <span
                      key={bucket.key}
                      className={[
                        'account-token-cell',
                        bucket.empty ? 'empty' : '',
                        activeAccountTokenGroup === bucket.groupKey ? 'active' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      data-level={bucket.level}
                      title={cellLabel}
                      aria-label={cellLabel}
                      tabIndex={bucket.empty ? undefined : 0}
                      onMouseEnter={() => {
                        if (!bucket.empty) setActiveAccountTokenGroup(bucket.groupKey);
                      }}
                      onFocus={() => {
                        if (!bucket.empty) setActiveAccountTokenGroup(bucket.groupKey);
                      }}
                      onClick={() => {
                        if (!bucket.empty) setActiveAccountTokenGroup(bucket.groupKey);
                      }}
                      onBlur={() => setActiveAccountTokenGroup(null)}
                    />
                  );
                })}
              </div>
              {activeTokenTooltip ? (
                <div className="account-token-tooltip" role="status">
                  {activeTokenTooltip}
                </div>
              ) : null}
              <div
                className="account-token-month-labels"
                style={{
                  gridTemplateColumns: `repeat(${accountActivityColumnCount}, var(--token-cell-size))`,
                }}
                aria-hidden="true"
              >
                {accountActivity.monthLabels.map((label) => (
                  <span key={label.key} style={{ gridColumnStart: label.column + 1 }}>
                    {label.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
          {!accountTokenUsage.loading && !accountActivity.activeBuckets ? (
            <p className="settings-hint">{t('Token usage no data')}</p>
          ) : null}
        </article>
        </div>
      </section>
      ) : null}
      {activeSettingsSection === 'security' ? (
      <section className="settings-section" aria-labelledby="settings-security-heading">
        <header className="settings-section-header">
          <span className="settings-section-kicker">{copy.settingsSecurity}</span>
          <div>
            <h2 id="settings-security-heading">{t('Settings section security')}</h2>
            <p>{t('Settings section security description')}</p>
          </div>
        </header>
        <SettingsPanel ariaLabel={t('Settings section security')}>
          <SettingRow
            id="settings-preview-confirm"
            icon={<ShieldCheck size={18} aria-hidden="true" />}
            label={t('Preview confirmation')}
            description={t('Preview confirmation description')}
            control={
              <ToggleSwitch
                ariaLabel={t('Preview confirmation')}
                checked={previewConfirmEnabled}
                onChange={(next) => setPreviewConfirm(next)}
              />
            }
          />
          <SettingRow
            id="settings-preview-proxy"
            icon={<Globe size={18} aria-hidden="true" />}
            label={t('Preview proxy')}
            description={t('Preview proxy description')}
            control={
              <ToggleSwitch
                ariaLabel={t('Preview proxy')}
                checked={previewProxyEnabled}
                onChange={(next) => setPreviewProxy(next)}
              />
            }
          />
        </SettingsPanel>
      </section>
      ) : null}
      {activeSettingsSection === 'runtime' ? (
      <section className="settings-section" aria-labelledby="settings-runtime-heading">
        <header className="settings-section-header">
          <span className="settings-section-kicker">{copy.settingsRuntime}</span>
          <div>
            <h2 id="settings-runtime-heading">{t('Settings section runtime')}</h2>
            <p>{t('Settings section runtime description')}</p>
          </div>
        </header>
        <article id="runtime-settings" className="control-card agent-runtime-card">
          <RuntimeRoster
            t={t}
            agents={agentInventory}
            defaultBackend={runtimeConfig?.defaults.backend ?? runtimeStatus?.backend ?? ''}
            configEntries={runtimeConfig?.entries ?? []}
            probeResults={probeResults}
            probingBackends={probingBackends}
            probeAllBusy={probeAllBusy}
            onProbe={probeRuntime}
            onProbeDeep={probeRuntimeDeep}
            onProbeAll={probeAllRuntimes}
            onSaveConfig={saveRuntimeConfigValue}
            onInvalidateProbe={invalidateProbe}
          />
        </article>
      </section>
      ) : null}
      {activeSettingsSection === 'diagnostics' ? (
      <section className="settings-section" aria-labelledby="settings-diagnostics-heading">
        <header className="settings-section-header">
          <span className="settings-section-kicker">{copy.settingsAgents}</span>
          <div>
            <h2 id="settings-diagnostics-heading">{t('Settings section diagnostics')}</h2>
            <p>{t('Settings section diagnostics description')}</p>
          </div>
        </header>
        <div className="control-grid" aria-label="Recovery tools">
        <article className="control-card">
          <div className="control-card-head">
            <Download size={18} aria-hidden="true" />
            <strong>{t('Crash and log export')}</strong>
            <span className="status-pill neutral">{desktopIncidentExport ? 'ready' : 'idle'}</span>
          </div>
          <p>{t('Crash export description')}</p>
          <p>{t('Crash export nullable description')}</p>
          <div className="button-row">
            <button className="text-button compact" onClick={() => generateIncidentExport()}>
              {t('Generate incident export')}
            </button>
            {desktopIncidentExport ? (
              <a className="download-link" href={desktopIncidentExport.href} download={desktopIncidentExport.fileName}>
                {t('Download incident bundle')}
              </a>
            ) : null}
          </div>
          <p>Latest export: {desktopIncidentExport?.generatedAt ?? 'not generated yet'}</p>
        </article>

        <article className="control-card">
          <div className="control-card-head">
            <Download size={18} aria-hidden="true" />
            <strong>{t('Manual update path')}</strong>
            <span className="status-pill neutral">
              {(desktopShellInfo?.productName ?? 'ClawHunt')} {desktopShellInfo?.version ?? '0.1.0'} ({desktopShellInfo?.releaseChannel ?? 'beta'})
            </span>
          </div>
          <p>
            {t('No auto updater description')} {t('Update guide')}: <code>{desktopShellInfo?.updateGuidePath ?? 'docs/desktop-manual-update.md'}</code>
          </p>
          {desktopShellInfo?.workspaceUpdateCommand ? (
            <div className="button-row">
              <button className="text-button compact" type="button" onClick={() => void copyWorkspaceUpdateCommand()}>
                <Copy size={16} aria-hidden="true" />
                {t('Copy update command')}
              </button>
            </div>
          ) : null}
        </article>
        </div>
      </section>
      ) : null}
    </div>
  );
}
