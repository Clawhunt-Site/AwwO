import { runtimeReadiness } from './settings/runtimeReadiness';
import { memo, startTransition, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type AnchorHTMLAttributes } from 'react';
import type {
  CSSProperties,
  ChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  SyntheticEvent,
} from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BadgeCheck,
  Bell,
  Bot,
  Users,
  Cable,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Compass,
  Copy,
  Download,
  ExternalLink,
  FileCheck,
  Folder,
  FolderInput,
  FolderOpen,
  Gauge,
  Globe,
  Image as ImageIcon,
  Paperclip,
  FileText,
  KeyRound,
  Layers,
  ListTodo,
  CalendarClock,
  LogIn,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Moon,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Pencil,
  PenTool,
  Pin,
  Play,
  Plus,
  Puzzle,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Sparkles,
  Settings2,
  ShieldCheck,
  SlashSquare,
  Square,
  Sun,
  Target,
  TerminalSquare,
  Trash2,
  UserRound,
  Video,
  X,
} from 'lucide-react';
import { CanvasSurface } from './canvas/CanvasSurface';
import { CanvasAccountControl } from './CanvasAccountControl';
import { createCanvasRuntimeReader } from './canvasRuntimeReader';
import { LocaleProvider, LOCALE_STORAGE_KEY, localeHtmlLang, readInitialLocale, type UiLocale } from './i18n';
import {
  buildDesktopApiUrl,
  buildDesktopEventStreamUrl,
  desktopControlToken,
  detectDesktopInvoke,
  openDesktopExternalUrl,
  revealDesktopPath,
  revealDesktopImage,
  readDesktopShellInfo,
  setDesktopWindowTheme,
  startDesktopWindowDrag,
  startDesktopRuntime,
  stopDesktopRuntime,
  toggleDesktopWindowMaximize,
  type DesktopRuntimeSession,
  type DesktopShellInfo,
  type DesktopInvoke,
} from './desktop';
import { canRevealImage, dataUrlToBlob, parseImageDataUrl } from './chatImageActions';
import { CompanyBoard } from './CompanyBoard';
import { prewarmCompanyBoard } from './companyBoardPrewarm';
import { useBoardNavState, goToCompanyList } from './companyBoardNav';
import {
  createPaperclipCompany,
  listPaperclipCompanies,
  paperclipApiBase,
  paperclipUnreadTotal,
  type ComposerCompany,
} from './paperclipBridge';
import {
  applyAppearance,
  applyCachedScheme,
  cacheScheme,
  createSerialQueue,
  type AppearanceCanvas,
  type AppearanceCustom,
  type AppearanceExportBundle,
  type AppearancePayload,
} from './appearance';
import { skillComposerSuggestions } from './composerSkills';
import { applyCompactSeed, buildCompactBoundaryTurn, canCompactTurns, compactSummaryPrompt } from './compactChat';
import { recordStartupMark } from './startupTrace';
import { probeCanvasReadiness } from './startupReadiness';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SettingsContent, SettingsSidebar } from './settings/SettingsSurface';
import type {
  AccountCostSummary,
  AccountTokenCostEvent,
  AccountTokenUsageData,
  AccountTokenUsageMode,
} from './settings/SettingsSurface';
import { DialogShell } from './ui/DialogShell';
import { GoogleLogo } from './ui/GoogleLogo';
import { EscalationGate } from './EscalationGate';
import { GoalModeDialog } from './GoalModeDialog';
import type { GoalRecord } from './GoalModeDialog';
import { submitGoalPlanFlow } from './goalModeSend';
import { OnboardingTour } from './OnboardingTour';
import { foldSkillProposalForDisplay } from './skillProposal';
import { FileViewerPanel, fileLinkPath, type FileViewLoad } from './FileViewerPanel';
import { WebPreviewPanel, type PreviewLoad } from './WebPreviewPanel';
import { NativeBrowserPanel } from './NativeBrowserPanel';
import { ConversationTabHost } from './ui/PanelHost';
import { Popover } from './ui/Popover';
import type { ConversationTab, NewTabOption, TabKind, TabMeta } from './ui/PanelHost';
import { ChatAutomationControl } from './ChatAutomationControl';
import { gatewayApiBase, listAutomationSessionIds } from './chatAutomations';
import {
  CONTEXT_PANEL_DEFAULT_WIDTH,
  CONTEXT_PANEL_MAX_WIDTH,
  clampContextPanelWidth,
  contextPanelInteraction,
} from './lib/contextPanelGeometry';
import { ComboInput, Dropdown } from './ui/Dropdown';
import type { DropdownOption } from './ui/Dropdown';
import { TurnDisplay, formatUsageMeter, formatTokenCount, cardTitle } from './ToolCallCard';
import { DisplayAccumulator, isChatDisplayEvent } from './displayProtocol';
import type { DisplaySnapshot } from './displayProtocol';
import { pickServiceUrl } from './app-env';
import {
  buildClawHuntSsoBridgeUrl,
  captureClawHuntSsoCallback,
  clearClawHuntSsoToken,
  readClawHuntSsoToken,
  storeClawHuntSsoToken,
  verifyClawHuntSsoToken,
  type ClawHuntSsoIdentity,
} from './clawhuntSso';

const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> & { DEV?: boolean } }).env ?? {};
// Localhost fallbacks apply only on the local Vite dev server (`npm run dev`, where
// import.meta.env.DEV is true); a built bundle — staging OR production — must point
// these at real services explicitly via VITE_* vars. There are only two environments
// (staging/production) and the build-time check (apps/desktop/scripts/app-env.mjs)
// already guarantees the frontend and backend identities match, so appEnv no longer
// distinguishes a local dev server from a distributed bundle — import.meta.env.DEV does.
const isDevServer = Boolean(viteEnv.DEV);
const envUrl = (name: string, localDefault: string) => pickServiceUrl(viteEnv[name], localDefault, isDevServer);
const DEFAULT_CLAWHUNT_BASE_URL = envUrl('VITE_CLAWHUNT_BASE_URL', 'http://127.0.0.1:8787') || 'unconfigured';

function localDateParam(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfLocalWeek(date: Date): Date {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return addLocalDays(day, -((day.getDay() + 6) % 7));
}

function accountTokenUsageQuery(mode: AccountTokenUsageMode): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let since = addLocalDays(today, -364);
  let until = addLocalDays(today, 1);
  if (mode === 'weekly') {
    since = startOfLocalWeek(since);
  } else if (mode === 'yearly') {
    until = addLocalDays(today, 1);
  }
  const params = new URLSearchParams({
    since: localDateParam(since),
    until: localDateParam(until),
  });
  return `?${params.toString()}`;
}

function normalizeAccountCostSummary(data: Partial<AccountCostSummary> | null | undefined): AccountCostSummary {
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    event_count: num(data?.event_count),
    input_tokens: num(data?.input_tokens),
    output_tokens: num(data?.output_tokens),
    total_tokens: num(data?.total_tokens),
    cached_input_tokens: num(data?.cached_input_tokens),
    duration_seconds: num(data?.duration_seconds),
    total_cost_cents: num(data?.total_cost_cents),
  };
}

function normalizeAccountCostEvents(data: unknown): AccountTokenCostEvent[] {
  const records = data && typeof data === 'object' && Array.isArray((data as { events?: unknown[] }).events)
    ? (data as { events: unknown[] }).events
    : [];
  return records
    .filter((record): record is Record<string, unknown> => Boolean(record && typeof record === 'object'))
    .map((record) => ({
      occurred_at: typeof record.occurred_at === 'number' ? record.occurred_at : undefined,
      input_tokens: typeof record.input_tokens === 'number' ? record.input_tokens : 0,
      output_tokens: typeof record.output_tokens === 'number' ? record.output_tokens : 0,
      cached_input_tokens: typeof record.cached_input_tokens === 'number' ? record.cached_input_tokens : 0,
      duration_seconds: typeof record.duration_seconds === 'number' ? record.duration_seconds : 0,
      cost_cents: typeof record.cost_cents === 'number' ? record.cost_cents : 0,
    }));
}

export type SettingsSectionId = 'preferences' | 'account' | 'security' | 'runtime' | 'diagnostics';

const SETTINGS_TARGET_SECTIONS: Record<string, SettingsSectionId> = {
  'settings-general': 'preferences',
  'settings-appearance': 'preferences',
  'settings-language': 'preferences',
  'settings-alerts': 'preferences',
  'settings-security': 'security',
  'settings-preview-confirm': 'security',
  'runtime-dependency-doctor': 'diagnostics',
  'settings-clawhunt': 'account',
  'runtime-settings': 'runtime',
  'settings-evidence-review': 'runtime',
  'settings-acceptance': 'runtime',
  // legacy target: the operations group dissolved into preferences (alerts)
  // and diagnostics (crash export, update path) in the 4-group IA
  'settings-operations': 'diagnostics',
  'settings-agent-doctor': 'diagnostics',
};

const MACOS_OVERLAY_DRAG_HEIGHT = 36;
const MACOS_TRAFFIC_LIGHT_SPACE = 96;
const MACOS_DRAG_START_DISTANCE = 4;
const MACOS_DOUBLE_CLICK_DISTANCE = 12;
const MACOS_DOUBLE_CLICK_MS = 450;
const MACOS_DRAG_BLOCKING_SELECTOR = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
].join(',');

type MacosWindowDragGesture = {
  activePointerId: number | null;
  dragStarted: boolean;
  lastClickAt: number;
  lastClickX: number;
  lastClickY: number;
  startX: number;
  startY: number;
};

function settingsSectionForTarget(targetId?: string): SettingsSectionId {
  if (!targetId) return 'preferences';
  return SETTINGS_TARGET_SECTIONS[targetId] ?? 'preferences';
}

function shouldStartMacosWindowDrag(event: ReactPointerEvent<HTMLElement>) {
  if (event.button !== 0) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(MACOS_DRAG_BLOCKING_SELECTOR)) return false;
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  return y >= 0 && y <= MACOS_OVERLAY_DRAG_HEIGHT && x >= MACOS_TRAFFIC_LIGHT_SPACE;
}

type BackendInfo = {
  name: string;
  available: boolean;
  executable?: string | null;
  version?: string | null;
  reason?: string | null;
};

type HarnessInfo = {
  harness_id: string;
  display_name: string;
  parallel_agents: boolean;
  tool_allowlist_per_agent: boolean;
  skill_body_max_bytes: number;
  context_file_name?: string | null;
};

type RunEvent = {
  type: string;
  payload: Record<string, unknown>;
};

type RunTask = {
  task_id: string;
  role: string;
  title: string;
  depends_on?: string[];
  status?: string;
};

type RunSessionState = {
  goal_id: string;
  run_id: string;
  status: string;
  effective_status?: string;
  liveness?: string;
  is_live?: boolean;
  stale_reason?: string | null;
  dry_run: boolean;
  chat_session_id?: string | null;
  depth?: number;
  parent_run_id?: string | null;
  parent_task_id?: string | null;
  execution_context?: Record<string, unknown>;
  child_executions?: Array<{ child_run_id: string; status: string; backend: string; depth: number }>;
  task_graph?: {
    goal_id: string;
    tasks: RunTask[];
  } | null;
  active_mutation_lease?: {
    lease_id: string;
    owner: string;
    mode: string;
    worker_pid?: number | null;
    worker_host?: string | null;
  } | null;
};

type EvidenceBundle = {
  run_id: string;
  chain_verdict: string;
  commands: Array<{ command: string; exit_code: number; output: string; status?: string; cwd?: string | null }>;
  worker_results: Array<{
    backend: string;
    role: string;
    exit_code: number;
    output: string;
    status?: string;
    artifact_id?: string | null;
    transcript_artifact_id?: string | null;
  }>;
  artifacts: Array<{
    artifact_id: string;
    kind: string;
    path: string;
    sensitivity?: string;
    metadata?: Record<string, unknown>;
  }>;
  findings: Array<{ name: string; passed: boolean; detail: string }>;
  child_executions?: Array<{ child_run_id: string; status: string; backend?: string; chain_verdict?: string | null }>;
};

type ProtocolExportPayload = {
  adapter_name: string;
  request_json: {
    solution_text?: string;
    github_pr_url?: string;
    github_pr_number?: number;
    attachments?: string[];
    agent_package_manifest?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
};

type EvalLane = {
  agent: string;
  status: string;
  verdict: string;
  score: number;
  failure_reason?: string;
  artifacts?: Array<{ artifact_id: string; kind: string; path?: string }>;
  phase_scores?: Array<{
    category: string;
    phase: string;
    label: string;
    score: number;
    max_score: number;
    status: string;
    detail: string;
  }>;
  differentiators?: string[];
};

type EvalReport = {
  eval_id: string;
  case_id: string;
  status: string;
  verdict: string;
  agents: EvalLane[];
  score_summary: { max_score: number; average_score: number; agents: Record<string, number> };
};

type PaySwitchStatus = {
  mode: string;
  probe?: Record<string, { status_code?: number; ok?: boolean }>;
};


export type RuntimeStatusPayload = {
  runtime_version: string;
  backend: string;
  mode: string;
  service: {
    name: string;
    version: string;
    pid: number;
    bind: string;
    control_token: 'set' | 'unset';
    uptime_seconds: number;
    control_token_required: boolean;
    health?: {
      status: string;
      summary?: string;
    };
  };
  state: {
    path: string;
    active_run_ids: string[];
    recent_run_id: string | null;
    context?: {
      counts?: {
        runs?: number;
        evidence?: number;
        events?: number;
      };
    };
  };
  agents: {
    count: number;
    ready_count: number;
    status_url: string;
  };
  plugins: {
    plugin_count: number;
    status_url: string;
  };
  config: {
    path: string;
    status_url: string;
  };
  // Node coexistence readiness (server-refactor). The startup gate waits for the
  // co-launched Node control plane via this kernel-reported signal. enabled=false ⇒ no
  // Node in this deployment (don't wait). Optional: older backends omit it (treat as
  // not-enabled → don't block).
  node?: {
    enabled: boolean;
    ready: boolean;
    url: string | null;
    port: number | null;
    // Reason a REQUIRED Node (SUPERCLAW_NODE_SERVER=on) is not ready, else null. The gate
    // still waits (enabled=true) so the failure surfaces as a held splash → timeout,
    // rather than being masked as "no Node here".
    error?: string | null;
  };
};

type DirectChatPayload = {
  intent: string;
  backend: string;
  status: string;
  response?: string;
  failure_reason?: string;
};

type ChatTurnPayload = DirectChatPayload & {
  session_id: string;
  run_id?: string;
  chain_verdict?: string;
  events_url?: string;
};

type ComposerContextRefType =
  | 'chat_session'
  | 'run'
  | 'evidence'
  | 'plugin'
  | 'message'
  | 'artifact'
  | 'file'
  | 'company'
  | 'company_create';

type ComposerContextRef = {
  type: ComposerContextRefType;
  id: string;
  label?: string;
  source?: string;
  visible_token: string;
  metadata?: Record<string, unknown>;
};

type ComposerAttachment = {
  id: string;
  kind: 'file' | 'image' | 'local_path';
  name: string;
  path?: string;
  mime?: string;
  size?: number;
  data_url?: string;
  source: 'picker' | 'paste' | 'drop' | 'path';
};

type ComposerTrigger = {
  trigger: '/' | '@';
  query: string;
  start: number;
  end: number;
};

type ComposerCommand = {
  id: 'chat' | 'new' | 'plugins' | 'settings' | 'clawhunt' | 'cost' | 'compact';
  token: string;
  label: string;
  description: string;
};

type ComposerSuggestion = {
  id: string;
  // 'skill' inserts a plain `@skill:<slug>` text token (the kernel parses @skill
  // from the message — no context_ref channel), so picking a skill is pure surface
  // discovery over the same contract the CLI uses; it adds no structured ref.
  kind: 'command' | 'context' | 'skill';
  token: string;
  label: string;
  description: string;
  command?: ComposerCommand;
  ref?: ComposerContextRef;
};

type DirectChatTurn = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  status?: string;
  run_id?: string | null;
  // Attachments staged with the turn, kept only on the in-memory transcript for
  // live display. They are NOT persisted/cached (rememberBackendChatSession drops
  // them), so reloading a session shows text without the heavy data_url payloads.
  attachments?: ComposerAttachment[];
  // Context refs (@file/@symbol) the turn was sent with — carried so "re-edit"
  // can faithfully restore them into the composer. Backend persists these
  // (BackendChatMessage.context_refs), so they survive a session reload too.
  contextRefs?: ComposerContextRef[];
  // Live Display Protocol state for an assistant turn: canonical tool cards,
  // streamed reasoning, and token usage. EPHEMERAL — rememberBackendChatSession
  // drops these (like attachments), so they show during/after the live turn but
  // do NOT survive a reload (v1 cut, docs/agent-runtime-display-protocol §D).
  display?: DisplaySnapshot;
  // Kernel-PERSISTED per-turn metering, threaded from BackendChatMessage so the
  // chat metering row (token usage + elapsed + "completed X ago") survives a
  // reload — unlike ``display`` above, which is dropped. ``createdAt`` is epoch
  // seconds (kernel ChatMessage.created_at); normalize to ms before formatting.
  usage?: Record<string, number> | null;
  elapsedMs?: number | null;
  createdAt?: number | null;
  // Epoch-ms when this (live, still-streaming) assistant turn started, used only
  // to tick a live "用时 Ns" counter in the running status line. EPHEMERAL — like
  // ``display``, it is not persisted; a reloaded turn shows ``elapsedMs`` instead.
  startedAt?: number | null;
};

type ChatQueueItem = {
  id: string;
  text: string;
  // Chat turns are Node-native only; the deprecated Python `delivery` run path is
  // gone, so a queued turn's mode is structurally `auto`. (Narrowed from
  // `'auto' | 'delivery'` when the run-creation surface was removed.)
  mode: 'auto';
  contextRefs: ComposerContextRef[];
  attachments: ComposerAttachment[];
  createdAt: number;
  // The session active when this item was queued. The pump runs it against
  // THIS session, never whatever the user has since switched to (without it a
  // queued turn would execute on the currently-open chat — a session leak).
  // Empty when queued from a brand-new draft chat that had no server id yet —
  // the pump then starts a fresh session rather than guessing one (any guess
  // risks executing the turn against an unrelated session).
  originBackendSessionId: string;
  originLocalSessionId: string;
  // Runtime selection captured at submit time, so a queued turn runs on the
  // backend/model/permission the user picked then — not on whatever the
  // composer shows when it finally dequeues.
  runtimeBackend: string;
  runtimeModel: string;
  runtimeEffort: string;
  runtimeHarness: string;
  runtimeDryRun: boolean;
  runtimePermissionPreset: 'ask' | 'allow';
  // The project a brand-new pinned chat was opened in, captured at enqueue so a
  // queued turn keeps its target even after the live pin is cleared/changed.
  // null for ordinary turns (the execution boundary then follows the bound
  // session, or stays flat).
  originPinnedWorkspaceId: string | null;
};

type BlockingModalState =
  | { kind: 'runtime-config'; reason: 'clawhunt-task' | 'manual' }
  | { kind: 'login'; reason: 'clawhunt-task' | 'clawhunt-action' }
  | null;

const CHAT_QUEUE_LIMIT = 20;
const COMPOSER_ATTACHMENT_LIMIT = 8;
const COMPOSER_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

function composerAttachmentId(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function fileLooksLikeImage(file: File) {
  return file.type.startsWith('image/') || /\.(avif|gif|jpe?g|png|webp)$/i.test(file.name);
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  });
}

function detectLocalPathAttachments(text: string): ComposerAttachment[] {
  const matches = new Map<string, ComposerAttachment>();
  const quotedPathPattern = /(["'])(\/(?:[^"'\n\r])+?)\1/g;
  const barePathPattern = /(^|\s)(\/(?:Users|Volumes|private|tmp|var|opt|Applications)\/[^\s"'<>]+)/g;
  const addPath = (path: string) => {
    const cleanPath = path.trim().replace(/[),.;:!?]+$/, '');
    if (!cleanPath || matches.has(cleanPath)) return;
    matches.set(cleanPath, {
      id: composerAttachmentId('path'),
      kind: 'local_path',
      name: cleanPath.split('/').filter(Boolean).pop() ?? cleanPath,
      path: cleanPath,
      source: 'path',
    });
  };
  for (const match of text.matchAll(quotedPathPattern)) addPath(match[2] ?? '');
  for (const match of text.matchAll(barePathPattern)) addPath(match[2] ?? '');
  return [...matches.values()];
}

function mergeComposerAttachments(current: ComposerAttachment[], incoming: ComposerAttachment[]) {
  const merged = [...current];
  const seen = new Set(merged.map((item) => item.path ? `path:${item.path}` : `${item.name}:${item.size ?? ''}:${item.mime ?? ''}`));
  for (const item of incoming) {
    if (merged.length >= COMPOSER_ATTACHMENT_LIMIT) break;
    const key = item.path ? `path:${item.path}` : `${item.name}:${item.size ?? ''}:${item.mime ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function attachmentRequestPayload(attachments: ComposerAttachment[]) {
  return attachments.map((attachment) => ({
    kind: attachment.kind,
    name: attachment.name,
    path: attachment.path,
    mime: attachment.mime,
    size: attachment.size,
    data_url: attachment.data_url,
    source: attachment.source,
  }));
}

type LocalChatSession = {
  session_id: string;
  title: string;
  status: string;
  updated_at: number;
  turns: DirectChatTurn[];
};

type BackendChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  status?: string;
  run_id?: string | null;
  created_at?: number;
  context_refs?: ComposerContextRef[];
  // Kernel-persisted per-turn metering (display-only): the runtime's token tally
  // for this assistant turn and its wall-clock elapsed. Both absent on user/system
  // rows and on legacy rows persisted before the field existed.
  usage?: Record<string, number> | null;
  elapsed_ms?: number | null;
};

type ChatSessionActivity = {
  status: 'live' | 'waiting' | 'pending' | 'interrupted' | 'idle';
  is_live: boolean;
  run_id?: string | null;
  effective_run_status?: string | null;
  reason?: string | null;
  legacy_incomplete_tail?: boolean;
};

type BackendChatSession = {
  session_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  messages: BackendChatMessage[];
  metadata?: Record<string, unknown>;
  activity?: ChatSessionActivity;
  workspace_id?: string | null;
  archived?: boolean;
  // Sidebar pin (cross-surface). The pin moment (epoch seconds) or null/absent
  // when not pinned; surfaces float pinned sessions to the top "Pinned" zone.
  pinned_at?: number | null;
};

// Workspace projection from ui_contracts (workspace_projection): the sidebar
// renders grouping/trust from this contract and never derives semantics itself.
type WorkspaceInfo = {
  workspace_id: string;
  name: string;
  kind: string;
  trust_status: string;
  is_trusted: boolean;
  repo_path: string;
  builtin_chat: boolean;
  session_count?: number;
  // Sidebar pin (cross-surface): pinned groups float to the top "Pinned" zone,
  // ordered by pinned_at. Absent on legacy projections (treated as not pinned).
  pinned?: boolean;
  pinned_at?: number | null;
};

type SidebarSessionItem = {
  kind: 'backend-chat' | 'local-chat';
  id: string;
  title: string;
  status: string;
  // Liveness-backed: true only when the backend proves an executor owns the
  // work (activity.is_live / run.is_live) or this tab itself has the turn in
  // flight. The sidebar spinner renders from this, never from status strings.
  live: boolean;
  timeLabel: string;
  readKey: string;
  unread: boolean;
  updated_at: number;
  run_id?: string | null;
  chat_session_id?: string | null;
  workspace_id?: string | null;
  archived?: boolean;
  // Sidebar pin (cross-surface, backend chat only). ``pinned`` floats the item
  // into the top "Pinned" zone; ``pinned_at`` orders that zone.
  pinned: boolean;
  pinned_at: number | null;
};

// One project group rendered in the sidebar (Projects list or the Pinned zone).
type SidebarProjectGroup = {
  key: string;
  label: string;
  trustRequired: boolean;
  repoPath: string;
  builtin: boolean;
  pinned: boolean;
  pinnedAt: number | null;
  items: SidebarSessionItem[];
};

// Right-click menu over a WORKSPACE head (pin / reveal / rename / remove). Kept
// separate from the per-session menu so each renders only its own actions.
type WorkspaceContextMenuState = {
  workspaceId: string;
  name: string;
  repoPath: string;
  pinned: boolean;
  builtin: boolean;
  trustRequired: boolean;
  x: number;
  y: number;
};

// Right-click menu for an image in the chat (thumbnail or lightbox). Captured at
// open time so the menu renders the right actions without re-deriving from the DOM.
type ImageContextMenuState = {
  x: number;
  y: number;
  // The rendered image source — a base64 data URL for attachments (used to copy
  // the bytes and, absent a path, to materialize a file for reveal).
  src: string;
  name: string;
  // Declared MIME when the image came from an attachment; null for the lightbox
  // (which carries only src+name and is parsed from the data URL instead).
  mime: string | null;
  // Real on-disk path when the image is a local_path attachment — revealed directly.
  path: string | null;
};

type SidebarContextMenuState = {
  sessionId: string;
  x: number;
  y: number;
  // Only backend chat sessions can be archived/moved; local drafts expose just
  // the copy-id action. Captured at open time so the menu renders the right
  // actions without re-deriving from the item.
  canManage: boolean;
  archived: boolean;
  workspaceId: string | null;
};

const LOCAL_CHAT_SESSIONS_STORAGE_KEY = 'superclaw_local_chat_sessions';
const LOCAL_CHAT_SESSION_LIMIT = 24;
// A Paperclip-native (Node) company id is a uuid; a legacy Python company is `company_*`.
// Used to decide whether an @company turn can run natively on Node (uuid) or must stay
// on the default chat company (legacy, no Node home). Mirrors the Node chat UUID_RE.
const NODE_COMPANY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIDEBAR_READ_RECEIPTS_STORAGE_KEY = 'superclaw_sidebar_read_receipts';
const SIDEBAR_KNOWN_UPDATES_STORAGE_KEY = 'superclaw_sidebar_known_updates';
const SIDEBAR_COLLAPSED_GROUPS_STORAGE_KEY = 'superclaw_sidebar_collapsed_groups';
// Reserved collapse keys for the top-level sidebar sections — they share the
// per-group collapsed-state map (and its localStorage persistence) with real
// workspaces. Every section (not just Pinned) is collapsible.
const PINNED_ZONE_KEY = '__pinned__';
const PROJECTS_SECTION_KEY = '__projects__';
const CHATS_SECTION_KEY = '__chats__';
const SIDEBAR_RELATIVE_TIME_REFRESH_MS = 60_000;
// How often the sidebar polls the kernel message roll-up for the unread badge.
const TEAM_UNREAD_POLL_MS = 30_000;

function localChatSessionId() {
  return `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function localChatTitle(content: string) {
  const title = content.replace(/\s+/g, ' ').trim();
  return title.length > 48 ? `${title.slice(0, 45)}...` : title || 'New session';
}

function readLocalChatSessions(): LocalChatSession[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LOCAL_CHAT_SESSIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is LocalChatSession => {
        return (
          item &&
          typeof item === 'object' &&
          typeof item.session_id === 'string' &&
          typeof item.title === 'string' &&
          typeof item.status === 'string' &&
          Array.isArray(item.turns)
        );
      })
      .slice(0, LOCAL_CHAT_SESSION_LIMIT);
  } catch {
    localStorage.removeItem(LOCAL_CHAT_SESSIONS_STORAGE_KEY);
    return [];
  }
}

function writeLocalChatSessions(sessions: LocalChatSession[]) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(LOCAL_CHAT_SESSIONS_STORAGE_KEY, JSON.stringify(sessions.slice(0, LOCAL_CHAT_SESSION_LIMIT)));
}

function readSidebarTimestampMap(key: string): Record<string, number> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([id, value]) => [id, typeof value === 'number' && Number.isFinite(value) ? value : Number(value)])
        .filter((entry): entry is [string, number] => typeof entry[0] === 'string' && Number.isFinite(entry[1])),
    );
  } catch {
    localStorage.removeItem(key);
    return {};
  }
}

function writeSidebarTimestampMap(key: string, timestamps: Record<string, number>) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(key, JSON.stringify(timestamps));
}

function detectComposerTrigger(value: string, caret: number): ComposerTrigger | null {
  const beforeCaret = value.slice(0, caret);
  const match = /(^|\s)([/@][^\s/@]*)$/.exec(beforeCaret);
  if (!match) return null;
  const token = match[2];
  const trigger = token[0] as '/' | '@';
  const start = caret - token.length;
  return {
    trigger,
    query: token.slice(1).toLowerCase(),
    start,
    end: caret,
  };
}

function replaceComposerToken(value: string, trigger: ComposerTrigger, replacement: string) {
  return `${value.slice(0, trigger.start)}${replacement}${value.slice(trigger.end)}`;
}

function syncContextRefsWithPrompt(_promptValue: string, refs: ComposerContextRef[]) {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = contextRefKey(ref);
    if (!ref.visible_token || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function contextRefKey(ref: ComposerContextRef) {
  return `${ref.type}:${ref.id}`;
}

function chatSessionContextLabel(sessionId: string) {
  return `聊天 ID: ${sessionId}`;
}

function contextSuggestionLabel(ref: ComposerContextRef) {
  if (ref.type === 'chat_session') return chatSessionContextLabel(ref.id);
  return ref.label ?? ref.visible_token;
}

function contextSuggestionDescription(ref: ComposerContextRef) {
  if (ref.type === 'chat_session') {
    const title = typeof ref.metadata?.title === 'string' ? ref.metadata.title : ref.label;
    return title && title !== ref.id ? `标题: ${title}` : ref.visible_token;
  }
  if (ref.type === 'company') {
    const status = typeof ref.metadata?.status === 'string' ? ref.metadata.status : 'active';
    return `公司 · ${status}`;
  }
  return ref.visible_token;
}

function composerSuggestionDomId(suggestion: ComposerSuggestion) {
  return `composer-suggestion-${suggestion.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function contextRefLogoUrl(ref: ComposerContextRef): string | undefined {
  return pluginLogoUrl(ref.metadata?.logo_url);
}

function contextRefIcon(ref: ComposerContextRef): PluginCatalogIconKey {
  if (ref.type === 'plugin') {
    const icon = ref.metadata?.icon;
    return typeof icon === 'string' ? catalogIconKey(icon, 'local') : 'local';
  }
  if (ref.type === 'file' || ref.type === 'artifact' || ref.type === 'evidence') return 'data';
  if (ref.type === 'run') return 'runtime';
  if (ref.type === 'company' || ref.type === 'company_create') return 'productivity';
  return 'productivity';
}

function chatSessionLinkedRunId(session: Pick<BackendChatSession, 'messages'>) {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const runId = session.messages[index]?.run_id;
    if (runId) return runId;
  }
  return null;
}

function backendChatTurns(session: BackendChatSession): DirectChatTurn[] {
  return session.messages.map((message) => ({
    role: message.role,
    content: message.content,
    run_id: message.run_id ?? null,
    status: message.status ?? (message.run_id ? 'run-linked' : message.role === 'user' ? 'sent' : 'completed'),
    contextRefs: message.context_refs && message.context_refs.length > 0 ? message.context_refs : undefined,
    // Persisted metering survives reload (display does not) — feeds the hover meta row.
    usage: message.usage ?? undefined,
    elapsedMs: typeof message.elapsed_ms === 'number' ? message.elapsed_ms : undefined,
    createdAt: typeof message.created_at === 'number' ? message.created_at : undefined,
  }));
}

// Merge a fresh `/api/chat/sessions` snapshot over the current cache WITHOUT
// letting the server SHRINK a session's transcript below what the client already
// knows. The assistant reply is persisted only AFTER a run reaches terminal
// status (heartbeat writes the comment post-status), while the client's
// loadChatSessions reload fires on EVERY turn's completion — so a refresh that
// lands mid-turn or just-after-completion returns a session whose `.messages`
// is missing the latest (in-flight or just-finished) reply. Overwriting the
// cache with that lagging snapshot blanks the turn, which surfaces as the
// "发一条再发一条旧回复闪没 / 运行中切走切回思考态没了 / 切出切回才回来" bug: every
// read of the cache (switch-back openSidebarSessionItem, queued-turn
// originBaseTurns) then bases on the shortened transcript.
//
// The server stays authoritative for ordering / metadata / archival, so we take
// the incoming session verbatim EXCEPT when the local cache is optimistically
// AHEAD for that id — then we keep the local `.messages` until the server catches
// up, after which incoming wins naturally. "Ahead" is measured in CONVERSATIONAL
// turns (user/assistant), EXCLUDING operational `system` notices: a run writes
// workspace-ready / runtime-service `system_notice` comments mid-turn that inflate
// the raw server length, so a plain length compare would let a lagging snapshot
// (more system notices, but still missing the live reply) drop the in-flight or
// just-finished turn. Tradeoff: a session whose real turns were genuinely deleted
// server-side stays at the longer local view until the next turn/refresh —
// acceptable versus blanking live turns.
function conversationalTurnCount(messages: Array<{ role: string }>): number {
  return messages.filter((message) => message.role !== 'system').length;
}

export function reconcileIncomingChatSessions(
  current: BackendChatSession[],
  incoming: BackendChatSession[],
): BackendChatSession[] {
  const currentById = new Map(current.map((session) => [session.session_id, session]));
  return incoming.map((inc) => {
    const local = currentById.get(inc.session_id);
    if (!local) return inc;
    // The in-flight optimistic turn carries a 'working' tail the server never has
    // (status is client-only). Keep local when it has strictly more conversational
    // turns than the server (server lagging), OR when it holds a working tail and
    // has at least as many conversational turns (an equal-conversation snapshot —
    // e.g. one whose extra rows are system notices — must not replace the live turn).
    const localConv = conversationalTurnCount(local.messages);
    const incConv = conversationalTurnCount(inc.messages);
    const localWorkingTail =
      local.messages.length > 0 && local.messages[local.messages.length - 1]?.status === 'working';
    return localConv > incConv || (localWorkingTail && localConv >= incConv)
      ? { ...inc, messages: local.messages }
      : inc;
  });
}

function chatSessionActivityStatus(turns: DirectChatTurn[]) {
  const latestNonUser = [...turns].reverse().find((turn) => turn.role !== 'user');
  if (latestNonUser?.status) return latestNonUser.status;
  const latestTurn = turns.at(-1);
  if (!latestTurn) return 'completed';
  if (latestTurn.role === 'user') return latestTurn.status === 'sent' ? 'pending' : latestTurn.status ?? 'pending';
  return latestTurn.status ?? 'completed';
}

const TERMINAL_ASSISTANT_TURN_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled', 'canceled']);

function hasTerminalAssistantTail(session: Pick<BackendChatSession, 'messages'>) {
  const latest = session.messages.at(-1);
  if (latest?.role !== 'assistant' || !latest.status) return false;
  return TERMINAL_ASSISTANT_TURN_STATUSES.has(latest.status.toLowerCase());
}

export function formatRelativeTaskAge(timestamp: number, now: number, locale: Locale = 'en') {
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(now)) return locale === 'zh' ? '时间未知' : 'unknown age';
  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (elapsedMinutes < 1) return locale === 'zh' ? '刚刚' : 'now';
  if (elapsedMinutes < 60) return locale === 'zh' ? `${elapsedMinutes}分钟` : `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    if (locale === 'zh') return `${elapsedHours}小时`;
    return `${elapsedHours}h`;
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (locale === 'zh') return `${elapsedDays}天`;
  return `${elapsedDays}d`;
}

// "完成于 16 分钟前" / "completed 16 minutes ago" — the full localized phrase for
// when an assistant turn finished, shown in the chat turn's hover meta row.
// ``timestampMs``/``nowMs`` are epoch milliseconds; granularity goes down to
// seconds (the sidebar's compact formatRelativeTaskAge floors at minutes).
export function formatCompletedAgo(timestampMs: number, nowMs: number, locale: Locale = 'en') {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0 || !Number.isFinite(nowMs)) {
    return locale === 'zh' ? '完成时间未知' : 'completed at unknown time';
  }
  const seconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (seconds < 10) return locale === 'zh' ? '刚刚完成' : 'completed just now';
  if (seconds < 60) return locale === 'zh' ? `完成于 ${seconds} 秒前` : `completed ${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    if (locale === 'zh') return `完成于 ${minutes} 分钟前`;
    return `completed ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    if (locale === 'zh') return `完成于 ${hours} 小时前`;
    return `completed ${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(hours / 24);
  if (locale === 'zh') return `完成于 ${days} 天前`;
  return `completed ${days} day${days === 1 ? '' : 's'} ago`;
}

// "用时 12.3 秒" / "took 12.3s" — localized wall-clock duration of a turn. Rounding
// is derived from a single rounded total-seconds value so the minute path can never
// carry to ":60" (e.g. 119.6s → "2m 0s", never "1m 60s"); a sub-minute value that
// rounds up to 60 promotes to "1m 0s". Kept in lockstep with the CLI _format_elapsed
// (cli.py) so CLI and Web show the same number — half-up rounding on both.
export function formatElapsedDuration(elapsedMs: number, locale: Locale = 'en') {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return '';
  const seconds = elapsedMs / 1000;
  if (seconds < 10) {
    const value = seconds.toFixed(1);
    return locale === 'zh' ? `用时 ${value} 秒` : `took ${value}s`;
  }
  const totalSeconds = Math.round(seconds);
  if (totalSeconds < 60) {
    return locale === 'zh' ? `用时 ${totalSeconds} 秒` : `took ${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const restSeconds = totalSeconds % 60;
  if (locale === 'zh') return `用时 ${minutes} 分 ${restSeconds} 秒`;
  return `took ${minutes}m ${restSeconds}s`;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// The per-session run/queue identity. Each chat session runs independently, so
// run-state and queue ownership are keyed by this, never globally. A backend
// session and a local session live in separate namespaces (prefixed so their
// ids can never collide); a brand-new chat with no server id yet shares the
// single in-composer 'draft' slot (the composer edits one draft at a time).
function chatTurnKey(backendSessionId: string, localSessionId: string): string {
  if (backendSessionId) return `b:${backendSessionId}`;
  if (localSessionId) return `l:${localSessionId}`;
  return 'draft';
}

function chatQueueItemKey(item: ChatQueueItem): string {
  return chatTurnKey(item.originBackendSessionId, item.originLocalSessionId);
}

// A runtime backend that failed to AUTHENTICATE (e.g. claude 401 / not logged
// in) surfaces friendly_chat_failure()'s actionable text. Detecting it lets the
// UI raise a prominent "log in" banner above the composer, not just an
// in-transcript error line. The markers are the fixed phrases that helper emits.
const RUNTIME_AUTH_FAILURE_MARKERS = ['登录已失效', '认证失败', 'not logged in', 'authenticat'];
function runtimeAuthFailureNotice(failureReason: string | null | undefined): string | null {
  const reason = (failureReason || '').trim();
  if (!reason) return null;
  const lowered = reason.toLowerCase();
  return RUNTIME_AUTH_FAILURE_MARKERS.some((m) => reason.includes(m) || lowered.includes(m)) ? reason : null;
}

function provisionalRunSession(run_id: string, goal_id: string, status: string, dry_run: boolean): RunSessionState {
  return {
    goal_id,
    run_id,
    status,
    dry_run,
    task_graph: null,
  };
}

export type RuntimeConfigPayload = {
  config_path: string;
  defaults: {
    backend: string;
    mode: string;
  };
  auth: {
    clawhunt_agent_api_key: string;
    control_token: string;
    anthropic_api_key: string;
    gemini_api_key: string;
    runninghub_api_keys?: string;
  };
  entries: Array<{
    name: string;
    category: string;
    description: string;
    default?: string | null;
    configured: boolean;
    persist_allowed: boolean;
    persisted: boolean;
    secret: boolean;
    source: string;
    value?: string | null;
    display_value: string | null;
    // kernel field-level UI schema (runtime_config.runtime_config_ui_descriptor);
    // optional so older/frozen backends degrade to plain text fields
    ui?: {
      type: string;
      section: string;
      choices: string[] | null;
    };
  }>;
};

type AgentControlInfo = BackendInfo & {
  readiness?: string;
  kind: string;
  configure: string;
  config_env?: string | null;
  model_env?: string | null;
  config_state?: string | null;
  model_state?: string | null;
  config_source?: string | null;
  model_source?: string | null;
  // runtime-selector contract (served by /api/agents; never hardcode lists here)
  label?: string;
  supports_model_selection?: boolean;
  default_model?: string | null;
  suggested_models?: string[];
  // reasoning-effort / thinking-level selector contract (served by /api/agents).
  // effort_input_mode "select" => effort_levels is the authoritative enum
  // (constrained dropdown); "text" => suggestions + free-form. default_effort is
  // display-only and must never be sent back as an explicit request.
  supports_effort_selection?: boolean;
  effort_levels?: string[];
  effort_input_mode?: 'select' | 'text' | null;
  default_effort?: string | null;
  // Relay-backed runtime: selects a ClawHunt package (套餐) from the relay's
  // super groups instead of a raw model id. Surfaces render the package selector
  // (GET /api/relay/packages) when this is set, never hardcoding the backend name.
  uses_relay_packages?: boolean;
  chat_capable?: boolean;
  chat_tier?: string;
};

export type AgentInventoryInfo = BackendInfo & Partial<Omit<AgentControlInfo, keyof BackendInfo>>;

// Mirrors the kernel runtime_probe.ProbeResult (GET /api/agents/probe). Rendered
// verbatim — the surface never re-derives the verdict or reclassifies the reason.
export type RuntimeProbeVerdict = 'runtime_ready' | 'runtime_present' | 'runtime_fail';
export type RuntimeProbeResult = {
  backend: string;
  verdict: RuntimeProbeVerdict;
  detail: string;
  depth: string;
  present: boolean;
  version?: string | null;
  models_count?: number | null;
  default_model?: string | null;
  latency_ms?: number | null;
  failure_reason?: string | null;
};

export type AgentControlPayload = {
  agents: AgentControlInfo[];
  summary: {
    count: number;
    ready_count: number;
  };
};

type DesktopDependencyTarget = {
  name: string;
  label: string;
  installed: boolean;
  detail: string;
  remediation: string;
  configName?: string;
};

type DesktopToolchainTool = {
  name: string;
  label: string;
  available: boolean;
  detail: string | null;
  remediation: string;
};

type DesktopToolchainPayload = {
  workspace_root: string;
  desktop_root: string;
  source_workspace: boolean;
  tools: DesktopToolchainTool[];
  summary: {
    required_count: number;
    ready_count: number;
    source_build_ready: boolean;
  };
  status_url: string;
};

type DesktopAcceptanceStep = {
  name: string;
  command: string;
  ok: boolean;
  code: number | null;
  signal: string | null;
  started_at: string;
  duration_ms: number;
  stdout_tail: string[];
  stderr_tail: string[];
};

type DesktopAcceptancePayload = {
  workspace_root: string;
  desktop_root: string;
  source_workspace: boolean;
  report_path: string;
  status_url: string;
  generate_command: string;
  quickstart_path: string;
  exists: boolean;
  report: {
    generated_at?: string | null;
    success?: boolean | null;
    failed_step?: string | null;
    steps?: DesktopAcceptanceStep[];
  } | null;
  summary: {
    ready: boolean;
    success: boolean | null;
    failed_step: string | null;
    generated_at: string | null;
    completed_steps: number;
    total_steps: number;
    error?: string;
  };
};

type TuiAcceptanceStep = DesktopAcceptanceStep;

type TuiAcceptancePayload = {
  workspace_root: string;
  report_path: string;
  status_url: string;
  generate_command: string;
  exists: boolean;
  report: {
    generated_at?: string | null;
    success?: boolean | null;
    failed_step?: string | null;
    steps?: TuiAcceptanceStep[];
  } | null;
  summary: {
    ready: boolean;
    success: boolean | null;
    failed_step: string | null;
    generated_at: string | null;
    completed_steps: number;
    total_steps: number;
    error?: string;
  };
};

type DesktopOnboardingCheck = {
  title: string;
  ready: boolean;
  detail: string;
  remediation: string;
};

// Interactive streaming runtimes (native session + streaming). These are the only
// runtimes eligible to be SILENTLY auto-selected as the composer default.
function isInteractiveRuntimeAgent(agent: AgentInventoryInfo) {
  return agent.chat_tier === 'native' || agent.chat_tier === 'upgradeable';
}

// Composer runtime-dropdown MEMBERSHIP: interactive runtimes PLUS relay-backed
// runtimes (uses_relay_packages, e.g. clawwork). A relay-backed runtime runs a turn
// via the relay with a 套餐 (package) selector instead of a raw model picker, so it
// must be directly pickable too — parity with the CLI's `chat --backend clawwork`.
// Keyed off the contract signal, never a hardcoded backend name (see the
// uses_relay_packages contract note). Relay-backed runtimes are deliberately NOT
// in the auto-default pool (preferredComposerRuntimeAgent below): they need a
// ClawHunt login + a provisioned relay key, so they are pick-only, never the
// silent default.
function isComposerRuntimeAgent(agent: AgentInventoryInfo) {
  return isInteractiveRuntimeAgent(agent) || Boolean(agent.uses_relay_packages);
}

function preferredComposerRuntimeAgent(agents: AgentInventoryInfo[], configuredDefaultBackend = '') {
  const configured = configuredDefaultBackend.trim();
  // A backend the inventory EXPLICITLY marks non-chat-capable (chat_tier === null,
  // e.g. the disabled acpx_local) is never a silent default — the run path rejects
  // it. An undefined chat_tier (legacy inventory) or a not-yet-ready runtime stays
  // eligible, so a configured default can still be honored + prompt setup.
  const isDisabledRuntime = (agent: AgentInventoryInfo) => agent.chat_tier === null;
  const configuredAgent = configured ? agents.find((agent) => agent.name === configured) : undefined;
  // Honor a configured default unless it is explicitly disabled (chat_tier null).
  if (configuredAgent && !isDisabledRuntime(configuredAgent)) return configured;
  // Auto-default NEVER lands on a relay-backed runtime (clawwork): it requires an
  // explicit ClawHunt login + provisioned relay key, so it is pick-only. Excluding
  // relay-backed runtimes from EVERY default path (interactive-preferred AND the
  // generic last-resort fallbacks) — only an explicitly configured default may be
  // clawwork (honored above). For non-relay inventories this is a no-op.
  const defaultable = agents.filter(
    (agent) => !agent.uses_relay_packages && !isDisabledRuntime(agent),
  );
  const runtimeAgents = defaultable.filter(isInteractiveRuntimeAgent);
  return (
    // Prefer Claude as the silent default. The coexist Node inventory names it
    // `claude_local`; the legacy Python backend named it `claude` — accept either
    // so the default never falls through to the first alphabetical runtime (e.g.
    // acpx_local), which is not the intended out-of-box chat backend.
    runtimeAgents.find(
      (backend) => (backend.name === 'claude_local' || backend.name === 'claude') && backend.available,
    )?.name ??
    runtimeAgents.find((agent) => agent.available)?.name ??
    // No interactive (chat-capable) runtime: fall back to ANY non-relay backend
    // over a relay-backed one (relay is login-gated, pick-only). This degenerate
    // path has no usable chat backend regardless, so a non-chat-capable non-relay
    // (e.g. an infra gateway) is the least-bad default. The user-facing concern —
    // a non-chat-capable CONFIGURED/persisted default being silently selected when
    // a real runtime IS present — is handled by the isComposerRuntimeAgent guard on
    // the configured branch above (and the loadRuntimeConfig adopt guard).
    defaultable.find((agent) => agent.available)?.name ??
    runtimeAgents[0]?.name ??
    defaultable[0]?.name ??
    // Absolute last resort: a configured default that simply isn't in the inventory
    // yet (legacy/loading) is still echoed — but NEVER an explicitly-disabled one
    // (e.g. acpx_local with chat_tier null), which would re-surface it in the
    // composer via `name === selectedBackend`.
    (configuredAgent && isDisabledRuntime(configuredAgent) ? '' : configured)
  );
}

// Map a chat session's persisted backend id to the current inventory's canonical
// agent name. A chat stores `metadata.runtime.backend` as whatever the creating
// client wrote: the Node composer writes inventory names ("codex_local"/
// "claude_local"); the legacy Python CLI wrote bare names ("codex"/
// "codex-app-server"/"claude"). The composer gates the model + effort selectors on
// `selectedAgentInfo`, which resolves by EXACT `name === selectedBackend` — so a
// restored id that is not an exact inventory name yields a null contract and both
// selectors silently vanish (only the runtime pill, a synthetic raw-string option,
// remains). Resolve exact-first, then a small set of known legacy→node aliases, so
// the contract (and its supports_model/effort flags) is found regardless of which
// client created the chat. Returns '' when nothing in the inventory plausibly
// matches (a genuinely unknown backend, left as-is by callers).
export function canonicalComposerBackend(
  stored: string,
  inventoryNames: readonly string[],
): string {
  if (!stored) return '';
  const names = new Set(inventoryNames);
  if (names.has(stored)) return stored;
  // Explicit legacy→node pairs the generic rules below don't cover 1:1.
  const explicit: Record<string, string> = {
    'codex-app-server': 'codex_local',
    codex: 'codex_local',
    claude: 'claude_local',
  };
  const candidates = [
    explicit[stored],
    `${stored}_local`, // codex -> codex_local, claude -> claude_local, grok -> grok_local
    stored.replace(/-/g, '_'), // hyphenated legacy id -> underscored
    stored.replace(/_local$/, ''), // codex_local -> codex (reverse: node id vs a legacy inventory)
  ];
  for (const candidate of candidates) {
    if (candidate && candidate !== stored && names.has(candidate)) return candidate;
  }
  return '';
}

type DesktopOnboardingPayload = {
  workspace_root: string;
  quickstart_path: string;
  status_url: string;
  summary: {
    ready: boolean;
    ready_count: number;
    total_count: number;
  };
  checks: DesktopOnboardingCheck[];
  dependency_targets: DesktopDependencyTarget[];
};

type CachedPluginInfo = {
  id: string;
  version: string;
  name: string;
  path: string;
  logo?: string;
  logo_url?: string;
  skill_origin?: boolean;
};

type SkillProjectionRecord = {
  plugin_id: string;
  version: string;
  target: string;
  path: string;
  tier: string;
  synced_at: string;
};

type NativeSkillLabel = 'official' | 'reviewed' | 'community' | 'local-dev';

type NativeSkillRecord = {
  id: string;
  // The `@skill:<slug>` token slug (kernel-parsed). Distinct from `id`: the
  // composer's `/v1/skills` picker keys on `slug`, so the workshop "use in chat"
  // action must insert THIS, not `id`, to reference the same skill the kernel sees.
  slug: string;
  name: string;
  summary: string;
  version?: string | null;
  source?: string | null;
  path?: string | null;
  package_digest?: string | null;
  artifact_blob_digest?: string | null;
  acceptance_level?: string | null;
  trust?: string | null;
  status?: string | null;
  capability_status?: string | null;
  labels: string[];
  tier?: string | null;
  executable: boolean;
  scripts: string[];
  assets: string[];
};

type NativeSkillStorePayload = {
  skills?: unknown[];
  items?: unknown[];
  records?: unknown[];
  error?: string | null;
};

type PluginStatusPayload = {
  cache_root: string;
  cloud_root: string;
  developer_submission_root: string;
  clawhunt_ingestion_root: string;
  plugin_count: number;
  plugins: CachedPluginInfo[];
  verification: {
    public_key_configured: boolean;
    install_url: string;
    local_install_url: string;
    uninstall_url: string;
  };
  registry: {
    count: number;
    status_url: string;
    error?: string | null;
  };
  governance: {
    revocation_count: number;
    policy_count: number;
    revocations_url: string;
    policy_url: string;
    revocation_error?: string | null;
    policy_error?: string | null;
  };
  configuration: {
    status_url: string;
    setting_url: string;
    secret_url: string;
    secret_delete_url: string;
  };
  diagnostics: {
    status_url: string;
    events_url: string;
  };
};

type PluginDiagnosticsFinding = {
  code: string;
  severity: string;
  plugin_id: string;
  plugin_version: string;
  tool_name: string;
  artifact_id?: string;
  duration_ms?: number;
  threshold_ms?: number;
  failures?: number;
  total?: number;
  failure_rate?: number;
  sandbox_kills?: number;
  sample_artifact_ids?: string[];
};

type PluginDiagnosticsPayload = {
  ok: boolean;
  artifact_count: number;
  artifact_dir: string;
  summary: {
    plugins: number;
    tools: number;
    failures: number;
    slow_calls: number;
    sandbox_kills: number;
  };
  thresholds: {
    slow_call_ms: number;
    failure_rate_threshold: number;
    failure_rate_min_invocations: number;
    sandbox_kill_threshold: number;
  };
  findings: PluginDiagnosticsFinding[];
  status_url: string;
  events_url: string;
};

type RegistryPluginInfo = {
  kind?: 'plugin' | 'skill' | 'company' | string;
  plugin_id: string;
  version: string;
  name: string;
  summary: string;
  category?: string;
  runtime?: string;
  platforms?: string[];
  acceptance_level?: string;
  verified: boolean;
  pricing_model?: string;
  package_digest?: string;
  artifact_blob_digest?: string;
  logo?: string;
  logo_url?: string;
  compatibility?: Record<string, string>;
  entitlement_required?: boolean;
  skill_origin?: boolean;
  trust?: 'official' | 'developer' | 'local' | 'untrusted' | string;
  trust_reasons?: string[];
  signer_class?: string;
  namespace_reserved?: boolean;
  install_state?: Record<string, unknown>;
  entitlement_state?: string;
  status?: string;
  capability_status?: string;
  revoked?: boolean;
  sources?: string[];
  instantiable?: boolean;
};

type CatalogConflict = {
  reason?: string;
  plugin_id?: string;
  id?: string;
  version?: string;
  severity?: string;
  blocks_install?: boolean;
  [key: string]: unknown;
};

type CatalogResolutionPayload = {
  ok?: boolean;
  items?: RegistryPluginInfo[];
  conflicts?: CatalogConflict[];
  registry_freshness?: Record<string, unknown>;
};

type CatalogContractPayload = {
  copy?: {
    trust?: Record<string, string>;
    conflict_banner?: string;
    refresh_failed?: string;
    company_instantiate_cta?: string;
    company_developer_disabled?: string;
    company_untrusted_disabled?: string;
  };
  install_blocking?: Record<string, boolean>;
  instantiable_semantics?: {
    plugin?: string;
    skill?: string;
    company?: string;
    derived_from_trust?: boolean;
    company_instantiable_trust?: string[];
    company_developer_disabled_reason?: string;
  };
  trust_states?: string[];
  kinds?: string[];
};

type CapabilityUploadContentItem = {
  path: string;
  required?: boolean;
  detail?: string;
};

type CapabilityUploadKind = {
  value: DeveloperCapabilityKind;
  label: string;
  id_field: string;
  id_placeholder: string;
  summary?: string;
  package_format?: string;
  contents: CapabilityUploadContentItem[];
  review?: string;
};

type CapabilityUploadLevel = {
  value: string;
  label: string;
  detail?: string;
};

type CapabilityUploadContract = {
  capability: string;
  schema_version: string;
  artifact_source?: string;
  excludes?: string[];
  kinds: CapabilityUploadKind[];
  acceptance_levels: CapabilityUploadLevel[];
  copy?: {
    source_hint?: string;
    signing_excluded?: string;
    review_note?: string;
    smoke_note?: string;
  };
};

type MarketplaceCatalogPluginInfo = {
  plugin_id: string;
  version: string;
  name?: string | Partial<LocalizedText>;
  summary?: string | Partial<LocalizedText>;
  category?: string;
  category_label?: string | Partial<LocalizedText>;
  icon?: string;
  logo?: string;
  logo_url?: string;
  runtime?: string;
  pricing_model?: string;
  verified?: boolean;
  entitlement_required?: boolean;
  featured?: boolean;
  skill_origin?: boolean;
  kind?: 'plugin' | 'skill' | 'company';
  capability_status?: string;
  signature_verified?: boolean;
  // Kernel-derived trust state (set by the API ONLY after it re-verified the
  // official co-signature against the baked official key). 'official' lights the
  // "officially endorsed" badge; absent => no official badge (fail-closed).
  trust?: string;
  instantiable?: boolean;
};

type PluginRevocationPayload = {
  revoked: Array<{
    plugin_id: string;
    version?: string | null;
    package_digest?: string | null;
    reason: string;
  }>;
};

type PluginPolicyPayload = {
  policies: Array<{
    plugin_id?: string | null;
    version?: string | null;
    max_model_output_bytes?: number | null;
    max_tool_timeout_ms?: number | null;
    denylisted_permissions?: string[];
    secret_descriptors?: Array<{ name: string; required?: boolean }>;
    minimum_runtime_version?: string | null;
    risk_level?: string | null;
    requires_live_metering?: boolean | null;
  }>;
};

type PluginSettingDescriptor = {
  name: string;
  type?: 'string' | 'integer' | 'number' | 'boolean' | string | null;
  description?: string | null;
  default?: unknown;
  required?: boolean;
  configured: boolean;
  value?: unknown;
  updated_at?: string | null;
  validation?: {
    enum?: Array<string | number | boolean>;
    minimum?: number;
    maximum?: number;
    step?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  };
  ui?: PluginConfigUi;
  options_source?: { tool: string; label?: string; arguments?: Record<string, unknown> } | null;
  actions?: Array<{ id?: string; tool: string; label?: string; arguments?: Record<string, unknown> }>;
};

// Two-tier configuration contract (mirrors superclaw.plugin_config.CONFIG_UI_SECTIONS).
// `section` places an item in the up-front step-by-step "basic" tier or the
// collapsed "advanced" tier; `step` orders basic items into Step 1 / 2 / …;
// `step_title`/`step_description` label that step. Legacy `advanced: true` is
// honored as section === 'advanced'.
type PluginConfigUi = {
  control?: 'text' | 'textarea' | 'url' | 'number' | 'switch' | 'select' | string;
  label?: string;
  placeholder?: string;
  help?: string;
  advanced?: boolean;
  section?: 'basic' | 'advanced' | string;
  step?: number;
  step_title?: string;
  step_description?: string;
};

type PluginSecretDescriptor = {
  name: string;
  env_name: string;
  description?: string | null;
  required: boolean;
  configured: boolean;
  version_range?: string | null;
  updated_at?: string | null;
  ui?: PluginConfigUi;
  // Auto-provisioned credential: the kernel derives the value from account/login
  // state (e.g. the ClawHunt account bridge) instead of requiring the user to
  // paste it. The kernel forces these into the advanced tier and never counts
  // them as a required step; the surface just renders status + an optional
  // manual override. See plugin_config.plugin_configuration_status().
  auto_provisioned?: boolean;
  provisioning_provider?: string | null;
  provisioning_status?: 'available' | 'unavailable' | string | null;
};

type PluginDynamicOption = { value: unknown; label: string; name?: string; email?: string; user_data_dir?: string };

type PaySwitchBrowserExtensionStatus = {
  reachable?: boolean;
  connected?: boolean;
  relay_base_url?: string;
  url?: string;
  error?: string;
  version?: string;
  manifest_version?: string | number;
  last_heartbeat?: {
    extension_id?: string;
    received_at?: number;
    payload?: {
      version?: string;
      manifest_version?: string | number;
      capabilities?: Record<string, unknown>;
    };
  } | null;
  extensions?: Array<Record<string, unknown>>;
};

type PaySwitchBrowserExtensionInstall = {
  reachable?: boolean;
  relay_base_url?: string;
  extension_dir?: string;
  load_url?: string;
  instructions?: string[];
  relay_token_present?: boolean;
  error?: string;
};

type PluginConfigToolResult = {
  text?: string;
  browser_extension?: PaySwitchBrowserExtensionStatus;
  install?: PaySwitchBrowserExtensionInstall;
};

type PluginConfigurationPayload = {
  plugin_id: string;
  version: string;
  name: string;
  runtime: Record<string, unknown>;
  configuration: {
    settings: PluginSettingDescriptor[];
    secrets: PluginSecretDescriptor[];
  };
};

// An item belongs to the collapsed "advanced" tier when it opts in via
// ui.section or the legacy ui.advanced flag; everything else is a basic,
// up-front step. Keeping this in one place mirrors the CLI/contract default
// (missing section === basic) so surfaces never diverge.
function isAdvancedConfigItem(ui: PluginConfigUi | undefined): boolean {
  return ui?.section === 'advanced' || ui?.advanced === true;
}

function settingDraftText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function settingDraftBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return Boolean(value);
}

function normalizePluginSettingDraft(setting: PluginSettingDescriptor, draft: unknown): unknown {
  if (setting.type === 'boolean') return settingDraftBoolean(draft);
  if (setting.type === 'integer') {
    if (typeof draft === 'number') return Math.trunc(draft);
    const parsed = Number.parseInt(settingDraftText(draft), 10);
    return Number.isFinite(parsed) ? parsed : settingDraftText(draft);
  }
  if (setting.type === 'number') {
    if (typeof draft === 'number') return draft;
    const parsed = Number.parseFloat(settingDraftText(draft));
    return Number.isFinite(parsed) ? parsed : settingDraftText(draft);
  }
  return settingDraftText(draft);
}

function pluginSettingPlaceholder(setting: PluginSettingDescriptor): string {
  return setting.ui?.placeholder ?? (settingDraftText(setting.default) || 'value');
}

function pluginConfigActionResultKey(settingName: string, actionId: string | undefined): string {
  return `${settingName}:${actionId ?? ''}`;
}

function isPaySwitchProfileSetting(pluginId: string | undefined, setting: PluginSettingDescriptor): boolean {
  return pluginId === 'dev.clawhunt.pay-switch-agent' && setting.name === 'chrome_profile_directory';
}

function paySwitchExtensionStatusLabel(status: PaySwitchBrowserExtensionStatus | undefined): string {
  if (!status) return 'checking';
  if (status.connected) return 'connected';
  if (status.reachable === false) return 'relay offline';
  if (status.last_heartbeat) return 'heartbeat stale';
  return 'not connected';
}

function paySwitchExtensionStatusClass(status: PaySwitchBrowserExtensionStatus | undefined): string {
  if (status?.connected) return 'good';
  if (status?.reachable === false || status?.last_heartbeat) return 'warn';
  return 'neutral';
}

function paySwitchHeartbeatTime(status: PaySwitchBrowserExtensionStatus | undefined): string {
  const receivedAt = status?.last_heartbeat?.received_at;
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt)) return '';
  return new Date(receivedAt * 1000).toLocaleTimeString();
}

type EntitlementSyncPayload = {
  entitlements: Array<{
    plugin_id: string;
    version?: string | null;
    version_range?: string | null;
    subject?: string | null;
    device_id?: string | null;
    runtime_version?: string | null;
    entitlement_id: string;
    expires_at?: string | null;
    synced_at?: string | null;
    offline_grace_expires_at?: string | null;
    offline_grace_disabled_reason?: string | null;
  }>;
};

type DeveloperSubmissionPayload = {
  schema_version: string;
  submission_id: string;
  kind?: 'plugin' | 'skill' | 'company' | string;
  status: string;
  capability_status?: string | null;
  capability_id?: string | null;
  developer_id?: string | null;
  plugin_id?: string | null;
  skill_id?: string | null;
  company_id?: string | null;
  version?: string | null;
  artifact_uploaded?: boolean;
  ready_for_signing?: boolean;
  ready_for_review?: boolean;
  requested_acceptance_level?: string | null;
  listing_review_level?: string | null;
  acceptance_recommendation?: string | null;
  certified_allowed?: boolean | null;
  l3_allowed?: boolean | null;
  package_digest?: string | null;
  artifact_blob_digest?: string | null;
  gates?: Array<{
    name: string;
    passed: boolean;
    detail?: string | null;
  }>;
  signature_issued?: boolean;
  signed_package_ref?: string;
  signing_public_key?: string | null;
  out_of_scope?: string[];
};

type DeveloperCapabilityKind = 'plugin' | 'skill' | 'company';

export type ClawHuntAuthPayload = {
  clawhunt: {
    account: string;
    agent_api_key: string;
    base_url: string;
    account_user?: Record<string, unknown> | null;
    agent_key_source?: string | null;
    agent_key_name?: string | null;
    account_source?: string | null;
    login_source?: string | null;
    browser_login_start_url?: string;
    account_login_url?: string;
    account_login_probe_url?: string;
    account_profile_url?: string;
    account_agents_url?: string;
    agent_key_create_url?: string;
    profile_url: string;
    login_url: string;
    logout_url: string;
  };
};

export type ClawHuntLoginProbePayload = {
  ok: boolean;
  reachable: boolean;
  login_endpoint: boolean;
  base_url: string;
  status_code: number;
  detail: string;
  body_detail?: string | null;
};

export type ClawHuntProfilePayload = {
  ok: boolean;
  status_code: number;
  body: Record<string, unknown>;
};

type ClawHuntBrowserLoginPayload = {
  ok: boolean;
  source: string;
  provider: string;
  login_url: string;
  callback_url: string;
  expires_in_seconds: number;
};

export type ClawHuntAccountAgent = {
  id: number;
  name?: string;
  handle?: string;
  title?: string;
  status?: string;
};

export type DesktopAlertEntry = {
  id: string;
  title: string;
  detail: string;
  severity: 'info' | 'good' | 'bad';
  created_at: string;
};

export type DesktopIncidentExport = {
  fileName: string;
  href: string;
  generatedAt: string;
};

const ACTIVE_RUN_STATUSES = new Set(['created', 'queued', 'running', 'verifying', 'WAITING_FOR_HUMAN_GATE']);
// SSE 服务端的 stream-closed 集（Display Protocol T1/DL9）：处于这些状态的 run
// 不订阅 live SSE（终态/人审 gate 无新事件流）。刻意不复用 ACTIVE_RUN_STATUSES
// （它把人审 gate 当 active，会让 gate/终态 run 误开一条不必要的 live 流）。
// 与内核 display_contracts.SNAPSHOT_STATES 保持一致。
const SNAPSHOT_STATES = new Set(['completed', 'failed', 'cancelled', 'WAITING_FOR_HUMAN_GATE']);

export type Locale = UiLocale;
type AppTheme = 'light' | 'dark';
// Appearance is a fixed light/dark choice — the "follow system" option was removed,
// so the preference no longer carries 'system' (DesktopThemePreference still accepts
// it for the desktop shell, but the web surface only ever sends light/dark).
export type AppThemePreference = 'light' | 'dark';

const THEME_STORAGE_KEY = 'superclaw_theme';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'superclaw_sidebar_collapsed';
// The initial sidebar-collapsed state depends ONLY on the user's explicit stored preference —
// collapsed iff they pinned it collapsed. It deliberately does NOT consider the landing surface:
// the 纯画布 shell already hides the rail entirely on the canvas surfaces
// (.workspace-canvas .rail{display:none}), so collapsing on a canvas landing
// would have no effect on the canvas AND would bleed a collapsed rail — with the chat
// recents/session list hidden by `.sidebar-collapsed .sidebar-recents{display:none}` — into the
// chat surface when the user navigates back to it, breaking the rule that chat keeps its rail
// AND recents. Kept as a pure exported helper so this invariant is unit-testable without
// mounting the canvas embed.
export function computeInitialSidebarCollapsed(storedPreference: string | null): boolean {
  return storedPreference === '1';
}
const SIDEBAR_WIDTH_STORAGE_KEY = 'superclaw_sidebar_width';
const AGENT_ONBOARDING_DISMISSED_STORAGE_KEY = 'superclaw_agent_onboarding_dismissed';
// Product-tour completion lives ONLY in the kernel config (web_onboarding), read
// and written through /api/onboarding — the single source of truth (no local
// mirror). Bump this version when the tour content materially changes so finished
// users see the new walkthrough exactly once.
const ONBOARDING_TOUR_VERSION = 1;
// Security preference: require a second "click to preview" confirmation before the
// reference viewer fetches a URL. Defaults ON (fail-safe: no auto-fetch). When the
// user turns it off, link clicks auto-load the sandboxed preview. Persisted like
// the other UI preferences (theme/locale) — this is a presentation-layer choice,
// not a kernel capability, so it lives in web-local storage.
const PREVIEW_CONFIRM_STORAGE_KEY = 'superclaw_preview_confirm';
// Security preference: let the server-side preview fetch route through the OS
// proxy when one is configured, so the reader works behind a fake-IP/split-tunnel
// proxy (Clash/Surge/…). Defaults ON; turning it off forces the resolve-and-pin
// SSRF path on the kernel. The value is sent (signed into the ticket) per request.
const PREVIEW_PROXY_STORAGE_KEY = 'superclaw_preview_proxy';
const SIDEBAR_DEFAULT_WIDTH = 300;
const SIDEBAR_MIN_WIDTH = 280;
const SIDEBAR_MAX_WIDTH = 460;
const SIDEBAR_COLLAPSED_WIDTH = 84;
// Right-side conversation/context panel: drag-to-resize width. Presentation-only
// preference (mirrors the left sidebar), persisted in web-local storage. The sizing
// math (clamp / viewport-fit / effective width) lives in lib/contextPanelGeometry so
// it stays unit-testable without rendering the whole workbench.
const CONTEXT_PANEL_WIDTH_STORAGE_KEY = 'superclaw_context_panel_width';
const THEME_PREFERENCES: AppThemePreference[] = ['light', 'dark'];
const AGENT_EXECUTABLE_CONFIG_BY_BACKEND: Record<string, string> = {
  bobo: 'SUPERCLAW_BOBO_EXECUTABLE',
  claude: 'SUPERCLAW_CLAUDE_EXECUTABLE',
  codex: 'SUPERCLAW_CODEX_EXECUTABLE',
  'codex-app-server': 'SUPERCLAW_CODEX_EXECUTABLE',
  hermes: 'SUPERCLAW_HERMES_EXECUTABLE',
  openclaw: 'SUPERCLAW_OPENCLAW_EXECUTABLE',
};
const AGENT_INVENTORY_CONTRACT_FALLBACKS: Record<string, Partial<AgentInventoryInfo>> = {
  'codex-app-server': {
    label: 'Codex',
    kind: 'cli',
    chat_tier: 'native',
    config_env: 'SUPERCLAW_CODEX_EXECUTABLE',
    configure: '/config set SUPERCLAW_CODEX_EXECUTABLE /path/to/codex',
  },
  claude: {
    label: 'Claude Code',
    kind: 'cli',
    chat_tier: 'upgradeable',
    config_env: 'SUPERCLAW_CLAUDE_EXECUTABLE',
    configure: '/config set SUPERCLAW_CLAUDE_EXECUTABLE /path/to/claude',
  },
  opencode: {
    label: 'OpenCode',
    kind: 'cli',
    chat_tier: 'upgradeable',
    config_env: 'SUPERCLAW_OPENCODE_EXECUTABLE',
    configure: '/config set SUPERCLAW_OPENCODE_EXECUTABLE /path/to/opencode',
  },
  grok: {
    label: 'Grok',
    kind: 'cli',
    chat_tier: 'upgradeable',
    config_env: 'SUPERCLAW_GROK_EXECUTABLE',
    configure: '/config set SUPERCLAW_GROK_EXECUTABLE /path/to/grok',
  },
  cursor: {
    label: 'Cursor CLI',
    kind: 'cli',
    chat_tier: 'upgradeable',
    config_env: 'SUPERCLAW_CURSOR_EXECUTABLE',
    configure: '/config set SUPERCLAW_CURSOR_EXECUTABLE /path/to/cursor-agent',
  },
  hermes: {
    label: 'Hermes',
    kind: 'cli',
    chat_tier: 'upgradeable',
    config_env: 'SUPERCLAW_HERMES_EXECUTABLE',
    configure: '/config set SUPERCLAW_HERMES_EXECUTABLE /path/to/hermes',
  },
  openclaw: {
    label: 'OpenClaw',
    kind: 'cli',
    chat_tier: 'upgradeable',
    config_env: 'SUPERCLAW_OPENCLAW_EXECUTABLE',
    configure: '/config set SUPERCLAW_OPENCLAW_EXECUTABLE /path/to/openclaw',
  },
};

function enrichAgentInventory(agent: AgentInventoryInfo): AgentInventoryInfo {
  const fallback = AGENT_INVENTORY_CONTRACT_FALLBACKS[agent.name];
  if (!fallback) return agent;
  return {
    ...fallback,
    ...agent,
    label: agent.label ?? fallback.label,
    kind: agent.kind ?? fallback.kind,
    chat_tier: agent.chat_tier ?? fallback.chat_tier,
    config_env: agent.config_env ?? fallback.config_env,
    configure: agent.configure ?? fallback.configure,
  };
}

type LocalizedText = Record<Locale, string>;

type PluginCatalogIconKey =
  | 'analytics'
  | 'browser'
  | 'commerce'
  | 'data'
  | 'design'
  | 'developer'
  | 'github'
  | 'local'
  | 'presentation'
  | 'productivity'
  | 'runtime';

type PluginCatalogItem = {
  kind?: 'plugin' | 'skill' | 'company' | string;
  plugin_id: string;
  version: string;
  name: LocalizedText;
  summary: LocalizedText;
  category: string;
  category_label: LocalizedText;
  icon: PluginCatalogIconKey;
  logo_url?: string;
  runtime: string;
  pricing_model: string;
  package_digest?: string;
  artifact_blob_digest?: string;
  acceptance_level?: string;
  verified: boolean;
  entitlement_required?: boolean;
  featured?: boolean;
  source: 'mock' | 'registry' | 'server' | 'local';
  skill_origin?: boolean;
  trust?: string;
  trust_reasons?: string[];
  signer_class?: string;
  namespace_reserved?: boolean;
  install_state?: Record<string, unknown>;
  entitlement_state?: string;
  status?: string;
  capability_status?: string;
  revoked?: boolean;
  sources?: string[];
  instantiable?: boolean;
  // Which store an INSTALLED card came from (drives uninstall routing). Absent => legacy cache.
  origin?: 'cache' | 'node-workshop';
  // Whether the installed capability has a (Python-cache) configuration surface. A Node-landed
  // capability is configurable:false, so the Configure action must be hidden (it would 404).
  configurable?: boolean;
  // Node store identity (the Node pluginKey) used to DELETE a node-workshop install — NOT assumed
  // equal to plugin_id. Present only on node-workshop cards.
  native_key?: string;
};

/** One entry from the neutral /api/capabilities/installed BFF (cache or Node S4 store). */
type NodeInstalledCapability = {
  origin: 'cache' | 'node-workshop';
  kind: string;
  capability_id: string;
  native_key: string;
  version: string | null;
  name: string;
  official: boolean;
  configurable: boolean;
  uninstallable: boolean;
};

/** Map a node-workshop installed capability to an installed (local) catalog card. */
export function nodeCapToCatalogItem(cap: NodeInstalledCapability): PluginCatalogItem {
  const ver = cap.version ?? '';
  return {
    kind: cap.kind === 'skill' || cap.kind === 'company' ? cap.kind : 'plugin',
    plugin_id: cap.native_key,
    version: ver,
    name: { en: cap.name, zh: cap.name },
    summary: { en: `${cap.capability_id}@${ver}`, zh: `${cap.capability_id}@${ver}` },
    category: 'local',
    category_label: { en: 'Local installed', zh: '本地已安装' },
    icon: 'local',
    runtime: 'local',
    pricing_model: 'installed',
    verified: cap.official,
    source: 'local',
    skill_origin: cap.kind === 'skill',
    origin: 'node-workshop',
    configurable: cap.configurable,
    native_key: cap.native_key,
  };
}

/** Enrich a catalog card item with its Node-S4 install origin/configurable when it matches a node
 * install (keyed `${plugin_id}@${version}`). This is what lets a REMOTE marketplace card that was
 * overlaid as installed still route uninstall to the Node store and hide the (404-ing) Configure
 * action. Items that already carry an origin (the local installed cards) are returned unchanged. */
export function enrichCardItemWithNodeInstall(
  item: PluginCatalogItem,
  nodeInstalledByIdentity: Map<string, NodeInstalledCapability>,
): PluginCatalogItem {
  if (item.origin) return item;
  // Kind-aware match (catalogIdentityKey = `kind:id@version`): a skill/company sharing an id with
  // a plugin must NOT be cross-matched.
  const cap = nodeInstalledByIdentity.get(catalogIdentityKey(item));
  if (!cap) return item;
  return { ...item, origin: 'node-workshop', configurable: cap.configurable, native_key: cap.native_key };
}

// D3 PR-5: the company instantiate (proposal->review->commit) flow state. Presentation
// only — every field comes from the existing /api/team/bootstrap contract.
type CompanyInstantiatePhase = 'proposing' | 'review' | 'committing' | 'done';
type CompanyInstantiateState = {
  item: PluginCatalogItem;
  phase: CompanyInstantiatePhase;
  proposal: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
};

// The capability the workshop detail sub-page is showing. A plugin/company is a
// catalog item; a skill is a native-skill record. Presentation only — opening a
// detail page never mutates kernel state; every action it offers routes through
// the SAME existing handler the list card used (install / instantiate / configure
// / uninstall / use-in-chat), so the sub-page adds NO new capability semantics.
// `authoringAllowed` is inherited from the surface the detail was opened from:
// a card opened from the read-only Overview carries false, so the detail page
// must NOT expose install / instantiate / configure / uninstall (read-only
// follows the capability into its sub-page — no privilege escalation via routing).
type WorkshopDetailTarget = { authoringAllowed: boolean } & (
  | { kind: 'plugin' | 'company'; item: PluginCatalogItem }
  | { kind: 'skill'; skill: NativeSkillRecord }
);

// Unified, presentation-only projection of the three capability shapes (plugin /
// company catalog item, native skill) onto ONE card model so Overview and every
// tab render an identical row. Trust→badge tone stays fail-closed (see
// workshopVerifiedBadge): only a kernel 'official'/'developer' verdict lights a
// badge; everything else renders none.
type WorkshopCardModel = {
  key: string;
  kind: 'plugin' | 'company' | 'skill';
  title: string;
  summary: string;
  logoUrl?: string;
  icon?: PluginCatalogIconKey;
  verifiedTone: 'official' | 'developer' | null;
  verifiedLabel: string;
  installed: boolean;
  item?: PluginCatalogItem;
  skill?: NativeSkillRecord;
};

const PLUGIN_CATALOG_ICON: Record<PluginCatalogIconKey, LucideIcon> = {
  analytics: Activity,
  browser: Compass,
  commerce: BadgeCheck,
  data: Layers,
  design: Palette,
  developer: TerminalSquare,
  github: FileCheck,
  local: Puzzle,
  presentation: PenTool,
  productivity: Bot,
  runtime: Cable,
};

function catalogLocalizedText(value: MarketplaceCatalogPluginInfo['name'], fallback: string): LocalizedText {
  if (value && typeof value === 'object') {
    const en = typeof value.en === 'string' && value.en.trim() ? value.en : fallback;
    const zh = typeof value.zh === 'string' && value.zh.trim() ? value.zh : en;
    return { en, zh };
  }
  const text = typeof value === 'string' && value.trim() ? value : fallback;
  return { en: text, zh: text };
}

function catalogIconKey(value: string | undefined, fallback: PluginCatalogIconKey): PluginCatalogIconKey {
  return value && value in PLUGIN_CATALOG_ICON ? (value as PluginCatalogIconKey) : fallback;
}

function pluginLogoUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('/') || trimmed.startsWith('data:image/') || /^https?:\/\//i.test(trimmed)) return trimmed;
  return undefined;
}

// Single capability identity key used everywhere a catalog list is de-duped, so
// every layer (loadPluginControl merge + selector) agrees on the SAME identity.
// It is kind-aware: a workshop skill/company and a legacy plugin that happen to
// share an id@version are distinct capabilities and must both survive.
export function catalogIdentityKey(item: {
  kind?: string;
  plugin_id: string;
  version: string;
  skill_origin?: boolean;
}): string {
  const kind = item.kind ?? (item.skill_origin ? 'skill' : 'plugin');
  return `${kind}:${item.plugin_id}@${item.version}`;
}

// Project one marketplace/workshop server entry into a display catalog item.
function mapMarketplaceServerPlugin(plugin: MarketplaceCatalogPluginInfo, index: number): PluginCatalogItem {
  const category = plugin.category || 'marketplace';
  // Preserve the kernel-declared kind; fall back to skill_origin only when the
  // server omitted it. Collapsing every non-skill into 'plugin' would turn a
  // company template into an installable plugin (wrong governance).
  const kind: PluginCatalogItem['kind'] = plugin.kind ?? (plugin.skill_origin ? 'skill' : 'plugin');
  return {
    kind,
    plugin_id: plugin.plugin_id,
    version: plugin.version,
    name: catalogLocalizedText(plugin.name, plugin.plugin_id),
    summary: catalogLocalizedText(plugin.summary, `${plugin.plugin_id}@${plugin.version}`),
    category,
    category_label: catalogLocalizedText(plugin.category_label, category === 'featured' ? 'Featured' : category),
    icon: catalogIconKey(plugin.icon, index % 3 === 0 ? 'developer' : index % 3 === 1 ? 'runtime' : 'productivity'),
    logo_url: pluginLogoUrl(plugin.logo_url),
    runtime: plugin.runtime || 'mcp_sidecar',
    pricing_model: plugin.pricing_model || 'free',
    // ``verified`` reflects developer-signature verification only (passed through
    // from the kernel). Lifecycle/review state is carried by capability_status so
    // the two signals are never conflated.
    verified: plugin.verified ?? false,
    capability_status: plugin.capability_status,
    entitlement_required: plugin.entitlement_required ?? false,
    featured: plugin.featured ?? index === 0,
    source: 'server',
    skill_origin: Boolean(plugin.skill_origin),
    // Carry the API's kernel-verified trust state through so the existing
    // source-badge logic (trust === 'official' -> official badge) lights up. The
    // API sets 'official' only after re-verifying the co-signature locally; the
    // surface never upgrades trust on its own.
    trust: plugin.trust,
    // Company templates are not installable; honor an explicit false.
    instantiable: plugin.instantiable ?? kind !== 'company',
  };
}

// Pure capability-workshop catalog selector. Exported so precedence, the live
// merge, and the fail-closed rule are unit-testable without mounting the App:
//   - When the kernel catalog answered (catalogLiveLoaded), MERGE the local
//     registry items with the live ClawHunt workshop feed (registry wins on an
//     id@version collision; workshop entries not present locally are appended).
//     This keeps real-time workshop capabilities visible even when the local
//     registry is non-empty — returning registry alone would silently drop them.
//   - An empty merged result is the honest truth; never fall back to the static
//     MOCK, which would mask an upstream workshop failure with fake cards.
//   - Offline (kernel never reached): legacy registry, else the workshop feed,
//     else the MOCK onboarding catalog.
export function selectMarketplaceCatalogItems(params: {
  catalogLiveLoaded: boolean;
  marketplaceServerPlugins: MarketplaceCatalogPluginInfo[];
  registryCatalogItems: PluginCatalogItem[];
  mock: PluginCatalogItem[];
}): PluginCatalogItem[] {
  const { catalogLiveLoaded, marketplaceServerPlugins, registryCatalogItems, mock } = params;
  const identityKey = catalogIdentityKey;
  const workshopItems = marketplaceServerPlugins.map(mapMarketplaceServerPlugin);
  if (catalogLiveLoaded) {
    // De-dupe across registry AND within the server feed itself. ``seen`` is
    // updated as we append so a server feed that repeats the same
    // kind:id@version (ClawHunt allows duplicate same-version publishes) yields
    // a single card, not two. Registry items win an id collision.
    const seen = new Set(registryCatalogItems.map(identityKey));
    const merged: PluginCatalogItem[] = [...registryCatalogItems];
    for (const item of workshopItems) {
      const key = identityKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    // Fail-closed: a live-loaded-but-empty catalog returns [] (NOT the mock) so an
    // upstream workshop failure / a genuinely empty published set is never masked by
    // fake tiles (see marketplace-catalog-selector.test.ts). The blank Workshop is a
    // view-layer empty-state, and fills in once capabilities are published on
    // the main ClawHunt site — do not fabricate catalog data here.
    return merged;
  }
  if (workshopItems.length) return workshopItems;
  if (registryCatalogItems.length) return registryCatalogItems;
  return mock;
}

// Pure selector for the Skills tab's READ-ONLY "remote published skills" section
// (capability-workshop IA, phase P1). Intentionally skills-scoped — it does NOT
// touch the plugin/company catalog path. The canonical cross-kind merge sinks to a
// backend unified endpoint in P2; this is the temporary, skills-only front-end view
// that P2 removes (tech debt, tracked in docs/capability-workshop-ia-redesign.md).
// Exported so the filter + Local>Remote dedupe are unit-testable without mounting App.
//   - Keep only remote published SKILLS (``kind === 'skill'`` or ``skill_origin``).
//   - Local wins: a skill already in the native /v1/skills store is shown in the
//     local section, so drop it here (never shown twice). Match is best-effort on a
//     namespace-normalized id ("skill." prefix stripped); P2's unified endpoint does
//     the authoritative cross-source dedupe.
//   - Apply the same free-text query the rest of the workshop uses.
export function selectRemoteSkillCatalogItems(params: {
  marketplaceCatalogItems: PluginCatalogItem[];
  nativeSkillIds: string[];
  query?: string;
}): PluginCatalogItem[] {
  const { marketplaceCatalogItems, nativeSkillIds, query } = params;
  // Remote catalog data is UNTRUSTED (external/backend): read every field
  // defensively so a missing/odd shape can never throw and white-screen the App.
  // ``normalize`` also coerces non-strings and strips a "skill." prefix even when it
  // sits behind an org/namespace segment ("acme/skill.x" -> "acme/x"). Cross-source
  // identity is still best-effort here; the authoritative dedupe lands in P2's
  // unified endpoint (tech debt tracked in docs/capability-workshop-ia-redesign.md).
  const normalize = (id: unknown) =>
    String(id ?? '').trim().toLowerCase().replace(/(^|\/)skill\./, '$1');
  const localIds = new Set(nativeSkillIds.map(normalize));
  const needle = String(query ?? '').trim().toLowerCase();
  return marketplaceCatalogItems.filter((item) => {
    if (!isSkillCapability(item)) return false;
    if (localIds.has(normalize(item.plugin_id))) return false; // Local>Remote: already local
    if (!needle) return true;
    return [item.plugin_id, item.version, item.name?.en, item.name?.zh, item.summary?.en, item.summary?.zh].some(
      (value) => String(value ?? '').toLowerCase().includes(needle),
    );
  });
}

// Front-end MIRROR of the kernel single source ``plugins.is_skill_origin_plugin``: a
// capability is a SKILL when skill_origin is set OR its id carries the "skill." prefix
// (backward-compat fallback), plus the surface-projected kind. Keeping this in lockstep
// with the kernel is what makes "single source, mirrored by every surface" actually true.
export function isSkillCapability(entry: { kind?: string | null; skill_origin?: boolean | null; plugin_id?: string | null }): boolean {
  return entry.kind === 'skill' || entry.skill_origin === true || String(entry.plugin_id ?? '').startsWith('skill.');
}

// "May this entry be installed via the PLUGIN flow?" — never if it is a skill
// (capability-workshop red line: skills are equipped from the Skills tab, never
// side-loaded as a plugin). Used by filteredRegistryPlugins (hide from operator panels),
// installRegistryPlugin + installPluginCatalogItem (refuse), and the Plugins-tab filter.
export function isPluginInstallable(entry: { kind?: string | null; skill_origin?: boolean | null; plugin_id?: string | null }): boolean {
  return !isSkillCapability(entry);
}

function PluginLogoMark({
  logoUrl,
  icon,
  label,
  className = '',
  size = 18,
}: {
  logoUrl?: string;
  icon?: PluginCatalogIconKey;
  label: string;
  className?: string;
  size?: number;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const src = !logoFailed ? pluginLogoUrl(logoUrl) : undefined;
  const FallbackIcon = PLUGIN_CATALOG_ICON[icon ?? 'local'];
  return (
    <span className={`plugin-logo-mark ${className}`.trim()} aria-hidden="true">
      {src ? (
        <img src={src} alt="" onError={() => setLogoFailed(true)} />
      ) : (
        <FallbackIcon size={size} aria-hidden="true" />
      )}
      <span className="sr-only">{label}</span>
    </span>
  );
}

// X-style scalloped "verified" badge geometry (single source, reused at every
// size). Purely presentational — the tone is a projection of the kernel-derived
// trust verdict, never a client-fabricated one (see VerifiedBadge below).
const VERIFIED_BADGE_SCALLOP =
  'M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z';
const VERIFIED_BADGE_CHECK = 'M9.6 16.6l-3.9-3.9 1.4-1.4 2.5 2.5 5.3-5.3 1.4 1.4z';

// Capability Workshop trust badge. The ONLY two tones are 'official' (green) and
// 'developer' (blue); any other trust state (local/untrusted/absent/unknown)
// renders NO badge — the caller passes a tone only when the kernel-derived
// trust verdict warrants it (fail-closed: a verification mark can never be
// fabricated for an unverified capability). This replaces the old text source
// pill; the trust→tone decision still lives in pluginCatalogSourceBadge /
// nativeSkillVerifiedTone (the logic layer is unchanged) — this only renders it.
function VerifiedBadge({
  tone,
  label,
  size = 15,
}: {
  tone: 'official' | 'developer';
  label: string;
  size?: number;
}) {
  return (
    <span className={`verified-badge ${tone}`} role="img" aria-label={label} title={label}>
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <path className="vb-scallop" d={VERIFIED_BADGE_SCALLOP} />
        <path className="vb-check" d={VERIFIED_BADGE_CHECK} />
      </svg>
    </span>
  );
}

// Plugins whose signed .scplug is fetched from a public GitHub release at install
// time (via POST /api/plugins/install-github) instead of the local registry. Their
// marketplace card installs directly even though they appear as catalog entries.
const GITHUB_BACKED_PLUGIN_IDS = new Set<string>(['dev.clawhunt.pay-switch-agent']);

const MOCK_PLUGIN_CATALOG: PluginCatalogItem[] = [
  {
    plugin_id: 'dev.superclaw.computer-use',
    version: '0.1.0',
    name: { en: 'Computer Use', zh: 'Computer Use' },
    summary: { en: 'Control Mac apps from ClawHunt.', zh: '让 ClawHunt 控制 Mac 桌面应用。' },
    category: 'featured',
    category_label: { en: 'Featured', zh: '推荐' },
    icon: 'runtime',
    runtime: 'desktop',
    pricing_model: 'free',
    verified: true,
    featured: true,
    source: 'mock',
  },
  {
    plugin_id: 'dev.superclaw.chrome',
    version: '0.1.0',
    name: { en: 'Chrome', zh: 'Chrome' },
    summary: { en: 'Operate Chrome with existing browser state.', zh: '使用已有浏览器状态操作 Chrome。' },
    category: 'featured',
    category_label: { en: 'Featured', zh: '推荐' },
    icon: 'browser',
    runtime: 'desktop',
    pricing_model: 'free',
    verified: true,
    source: 'mock',
  },
  {
    plugin_id: 'dev.superclaw.spreadsheets',
    version: '0.1.0',
    name: { en: 'Spreadsheets', zh: '表格' },
    summary: { en: 'Create, edit, and inspect spreadsheet files.', zh: '创建、编辑并检查电子表格文件。' },
    category: 'productivity',
    category_label: { en: 'Productivity', zh: '生产力' },
    icon: 'data',
    runtime: 'tool',
    pricing_model: 'free',
    verified: true,
    source: 'mock',
  },
  {
    plugin_id: 'dev.superclaw.presentations',
    version: '0.1.0',
    name: { en: 'Presentations', zh: '演示文稿' },
    summary: { en: 'Create and edit presentation decks.', zh: '创建和编辑演示文稿。' },
    category: 'productivity',
    category_label: { en: 'Productivity', zh: '生产力' },
    icon: 'presentation',
    runtime: 'tool',
    pricing_model: 'free',
    verified: true,
    source: 'mock',
  },
  {
    plugin_id: 'dev.superclaw.github',
    version: '0.1.0',
    name: { en: 'GitHub', zh: 'GitHub' },
    summary: { en: 'Triage PRs, issues, CI, and publish flows.', zh: '处理 PR、Issue、CI 和发布流程。' },
    category: 'developer',
    category_label: { en: 'Developer tools', zh: '开发者工具' },
    icon: 'github',
    runtime: 'connector',
    pricing_model: 'free',
    verified: true,
    source: 'mock',
  },
  {
    plugin_id: 'dev.superclaw.data-analytics',
    version: '0.1.0',
    name: { en: 'Data Analytics', zh: '数据分析' },
    summary: { en: 'Turn local data into clear decisions.', zh: '把本地数据转成可判断的结果。' },
    category: 'business',
    category_label: { en: 'Business', zh: '业务能力' },
    icon: 'analytics',
    runtime: 'tool',
    pricing_model: 'free',
    verified: false,
    source: 'mock',
  },
  {
    plugin_id: 'dev.superclaw.product-design',
    version: '0.1.0',
    name: { en: 'Product Design', zh: '产品设计' },
    summary: { en: 'Explore product ideas and prototype flows.', zh: '探索产品想法并生成原型流程。' },
    category: 'business',
    category_label: { en: 'Business', zh: '业务能力' },
    icon: 'design',
    runtime: 'tool',
    pricing_model: 'free',
    verified: false,
    source: 'mock',
  },
  {
    plugin_id: 'dev.superclaw.sales',
    version: '0.1.0',
    name: { en: 'Sales', zh: '销售' },
    summary: { en: 'Prepare account notes, outreach, and follow-up work.', zh: '准备客户记录、触达和跟进工作。' },
    category: 'business',
    category_label: { en: 'Business', zh: '业务能力' },
    icon: 'commerce',
    runtime: 'tool',
    pricing_model: 'free',
    verified: false,
    source: 'mock',
  },
];

const SHELL_COPY = {
  en: {
    navLabel: 'ClawHunt navigation',
    brandSubtitle: 'AgentOS runtime',
    pluginsMarketplace: 'Capability Workshop',
    teamSurface: 'Team',
    newChat: 'New Session',
    chats: 'Recent Sessions',
    noChats: 'No recent sessions',
    workspaceInbox: 'Chats',
    workspaceTrustRequired: 'Trust required',
    projects: 'Projects',
    projectsEmpty: 'No projects yet — use + to create one.',
    newProject: 'New project',
    newProjectChat: 'New chat in this project',
    composerWorkspaceAria: 'Chat workspace',
    composerWorkspaceChat: 'Chat (no project)',
    newWorkspace: 'New project',
    newWorkspaceTitle: 'New project',
    newWorkspaceSubtitle: 'Create a real project folder you own, or attach an existing repository.',
    newWorkspaceNameLabel: 'Name',
    newWorkspaceNamePlaceholder: 'e.g. Research notes',
    newWorkspaceFolderHint: 'Creates a real folder under ~/SuperClaw that you own and can open in Finder; the agent works inside it.',
    newWorkspaceAttachToggle: 'Attach a code repository instead',
    newWorkspaceAttachLabel: 'Repository path',
    newWorkspaceAttachPlaceholder: '/path/to/repo',
    newWorkspaceTrustLabel: 'I trust this directory for agent execution',
    newWorkspaceTrustHint: 'Attaching a real directory lets agents read and write there. Confirm you trust it before continuing.',
    newWorkspaceCreate: 'Create project',
    newWorkspaceCreating: 'Creating…',
    workspaceCreated: 'Project created',
    workspaceCreateFailed: 'Could not create project',
    archiveSession: 'Archive',
    unarchiveSession: 'Unarchive',
    sessionArchived: 'Conversation archived',
    sessionUnarchived: 'Conversation restored',
    sessionActionFailed: 'Action failed',
    showArchived: 'Show archived',
    hideArchived: 'Hide archived',
    archivedBadge: 'Archived',
    moveToWorkspace: 'Move to project…',
    moveToWorkspaceTitle: 'Move conversation',
    moveToWorkspaceSubtitle: 'Choose where this conversation lives.',
    moveTargetInbox: 'Chats (no project)',
    sessionMoved: 'Conversation moved',
    moveBoundaryTitle: 'This changes the execution boundary',
    moveBoundaryBody:
      "Moving into a repository workspace resets this conversation's runtime resume (the agent's remembered session). The conversation and its full history are kept.",
    moveConfirm: 'Move anyway',
    collapseGroup: 'Collapse group',
    expandGroup: 'Expand group',
    pinnedSection: 'Pinned',
    collapsePinned: 'Collapse pinned',
    expandPinned: 'Expand pinned',
    pinConversation: 'Pin',
    unpinConversation: 'Unpin',
    pinProject: 'Pin project',
    unpinProject: 'Unpin project',
    revealInFinder: 'Show in Finder',
    renameProject: 'Rename project',
    removeProject: 'Remove',
    renameProjectTitle: 'Rename project',
    renameProjectLabel: 'Project name',
    workspaceRenamed: 'Project renamed',
    workspaceRenameFailed: 'Rename failed',
    removeProjectTitle: 'Remove project?',
    removeProjectBody:
      'This removes the project from the list only — files on disk are NOT deleted. Its conversations are archived (find them under “Show archived”).',
    removeProjectConfirm: 'Remove',
    workspaceRemoved: 'Project removed',
    workspaceRemoveFailed: 'Remove failed',
    workspaceRevealFailed: 'Could not open the folder',
    openPluginMarketplace: 'Open Capability Workshop',
    openAccountMenu: 'Open account menu',
    accountMenu: 'Account menu',
    signedInAs: 'Signed in as',
    operator: 'Operator',
    clawhuntLinked: 'ClawHunt linked',
    clawhuntUnset: 'ClawHunt unset',
    settings: 'Settings',
    replayTour: 'Replay tour',
    login: 'Login',
    openSettings: 'Open settings workspace',
    home: 'Home',
    titlePlugins: 'Capabilities',
    titleSettings: 'Settings',
    collapseSidebar: 'Collapse sidebar',
    expandSidebar: 'Expand sidebar',
    resizeSidebar: 'Resize sidebar',
    resizeContextPanel: 'Resize panel',
    language: 'Language',
    switchToEnglish: 'Switch language to English',
    switchToChinese: 'Switch language to Chinese',
    appearance: 'Appearance',
    themePreference: 'Theme preference',
    switchThemeToLight: 'Use light appearance',
    switchThemeToDark: 'Use dark appearance',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeActiveLight: 'Active: light',
    themeActiveDark: 'Active: dark',
    chatSurface: 'Direct Chat',
    welcomeHeading: 'Build something with ClawHunt',
    subtitle: 'Ask questions and execute verified delivery work from one local AgentOS workspace.',
    composerLabel: 'ClawHunt composer',
    directPrompt: 'Direct chat prompt',
    composerPlaceholder: 'Ask ClawHunt anything, or describe a task to get started...',
    userTurnLabel: 'You',
    assistantTurnLabel: 'ClawHunt',
    directChatWorking: 'Thinking...',
    thinkingStatus: 'thinking',
    liveThinking: 'Thinking deeply…',
    liveGenerating: 'Writing reply…',
    liveWorkingGeneric: 'Working…',
    liveIdlePhrases: ['Thinking', 'Reading the context', 'Connecting the dots', 'Drafting an answer', 'Planning the next step'],
    liveCallingToolPrefix: 'Running ',
    statusFailedShort: 'failed',
    statusCancelledShort: 'cancelled',
    newContentBelow: 'New content',
    ready: 'Ready',
    working: 'Working',
    replyBatch: 'reply: batch',
    eventsStatus: 'events',
    ask: 'Ask',
    run: 'Run',
    cancel: 'Cancel',
    stop: 'Stop',
    stopping: 'Stopping…',
    stopped: 'Stopped',
    connecting: 'Connecting…',
    attachFiles: 'Add photos and files',
    removeAttachment: 'Remove attachment',
    previewImage: 'Preview image',
    closePreview: 'Close preview',
    copyImage: 'Copy image',
    copyImageDone: 'Image copied',
    copyImageFailed: "Couldn't copy image",
    revealImageFailed: "Couldn't reveal image",
    slashMenuLabel: 'Insert command',
    sendHint: 'Enter to send · Shift+Enter for newline',
    sendHintQueue: 'Enter to queue · Shift+Enter for newline',
    enqueue: 'Queue',
    queued: 'Queued',
    queueNext: 'Next',
    queueFull: 'Queue is full (max 20)',
    queueClear: 'Clear',
    queueResume: 'Resume',
    queuePaused: 'Paused',
    queueEdit: 'Edit',
    queueRemove: 'Remove',
    queueMoveUp: 'Move up',
    queueMoveDown: 'Move down',
    copyMessage: 'Copy',
    messageCopied: 'Copied',
    copyFailed: 'Copy failed',
    editMessage: 'Edit',
    reEditOverwriteConfirm: 'Replace the unsent draft in your composer with this message?',
    planPanel: 'Plan',
    automationPanel: 'Scheduled tasks',
    closePanel: 'Close panel',
    conversationPanel: 'Panel',
    newTab: 'New tab',
    newTabMenu: 'New tab',
    closeTab: 'Close tab',
    newWebPage: 'Web page',
    webTabPlaceholder: 'Enter a URL to preview…',
    webTabPreview: 'Preview',
    webTabInvalid: 'Enter a valid http(s) URL.',
    conversationTabsEmpty: 'Open a file or link from the conversation, or click + to create a tab.',
    chat: 'Chat',
    evidence: 'Evidence',
    settingsTitle: 'Settings and local agents',
    pluginTitle: 'Capability Workshop',
    backToMain: 'Back to main menu',
    backToApp: 'Back to app',
    settingsNavigation: 'Settings navigation',
    settingsCurrentPage: 'Current page',
    settingsPreferences: 'Preferences',
    settingsAccount: 'Account',
    settingsSecurity: 'Security',
    settingsAgents: 'Diagnostics',
    settingsSecrets: 'Secrets',
    settingsRuntime: 'Runtime',
    settingsSubtitle: 'Preferences, account, runtime, and diagnostics for this ClawHunt workspace.',
    pluginsSubtitle: 'Discover, submit, verify, and manage governed ClawHunt capabilities.',
    sidebarContextMenu: 'Conversation actions',
    copyConversationId: 'Copy conversation ID',
    conversationIdCopied: 'conversation ID copied',
    conversationIdCopyFailed: 'conversation ID copy failed',
  },
  zh: {
    navLabel: 'ClawHunt 导航',
    brandSubtitle: 'AgentOS 运行时',
    pluginsMarketplace: '能力工坊',
    teamSurface: 'Agent 组',
    newChat: '新建会话',
    chats: '最近会话',
    noChats: '暂无会话',
    workspaceInbox: '聊天',
    workspaceTrustRequired: '待信任',
    projects: '项目',
    projectsEmpty: '还没有项目 —— 点 + 新建一个。',
    newProject: '新建项目',
    newProjectChat: '在此项目内新建对话',
    composerWorkspaceAria: '对话所属',
    composerWorkspaceChat: '聊天（无项目）',
    newWorkspace: '新建项目',
    newWorkspaceTitle: '新建项目',
    newWorkspaceSubtitle: '新建一个你拥有的真实项目文件夹,或接入一个已有代码库。',
    newWorkspaceNameLabel: '名称',
    newWorkspaceNamePlaceholder: '例如:调研笔记',
    newWorkspaceFolderHint: '会在 ~/SuperClaw 下创建一个你拥有、Finder 可见的真实文件夹,agent 在里面干活。',
    newWorkspaceAttachToggle: '改为接入代码库',
    newWorkspaceAttachLabel: '代码库路径',
    newWorkspaceAttachPlaceholder: '/path/to/repo',
    newWorkspaceTrustLabel: '我信任此目录用于 agent 执行',
    newWorkspaceTrustHint: '接入真实目录会允许 agent 在其中读写。继续前请确认你信任它。',
    newWorkspaceCreate: '创建项目',
    newWorkspaceCreating: '创建中…',
    workspaceCreated: '已创建项目',
    workspaceCreateFailed: '无法创建项目',
    archiveSession: '归档',
    unarchiveSession: '取消归档',
    sessionArchived: '会话已归档',
    sessionUnarchived: '会话已恢复',
    sessionActionFailed: '操作失败',
    showArchived: '显示已归档',
    hideArchived: '隐藏已归档',
    archivedBadge: '已归档',
    moveToWorkspace: '移动到项目…',
    moveToWorkspaceTitle: '移动会话',
    moveToWorkspaceSubtitle: '选择此会话所属的位置。',
    moveTargetInbox: '聊天(无项目)',
    sessionMoved: '会话已移动',
    moveBoundaryTitle: '这会改变执行边界',
    moveBoundaryBody:
      '移入代码库项目会重置此会话的运行时续接(agent 记住的会话状态)。会话与完整历史都会保留。',
    moveConfirm: '仍然移动',
    collapseGroup: '折叠分组',
    expandGroup: '展开分组',
    pinnedSection: '置顶',
    collapsePinned: '折叠置顶',
    expandPinned: '展开置顶',
    pinConversation: '置顶',
    unpinConversation: '取消置顶',
    pinProject: '置顶项目',
    unpinProject: '取消置顶',
    revealInFinder: '在 Finder 中显示',
    renameProject: '重命名项目',
    removeProject: '移除',
    renameProjectTitle: '重命名项目',
    renameProjectLabel: '项目名称',
    workspaceRenamed: '项目已重命名',
    workspaceRenameFailed: '重命名失败',
    removeProjectTitle: '移除项目？',
    removeProjectBody:
      '这只会将该项目从列表中移除 —— 磁盘上的文件不会被删除。它的对话会被归档（可在“显示已归档”中找回）。',
    removeProjectConfirm: '移除',
    workspaceRemoved: '项目已移除',
    workspaceRemoveFailed: '移除失败',
    workspaceRevealFailed: '无法打开该文件夹',
    openPluginMarketplace: '打开能力工坊',
    openAccountMenu: '打开账号菜单',
    accountMenu: '账号菜单',
    signedInAs: '当前账号',
    operator: '操作者',
    clawhuntLinked: 'ClawHunt 已连接',
    clawhuntUnset: 'ClawHunt 未配置',
    settings: '设置',
    replayTour: '重新查看引导',
    login: '登录',
    openSettings: '打开设置工作区',
    home: '首页',
    titlePlugins: '能力',
    titleSettings: '设置',
    collapseSidebar: '折叠侧边栏',
    expandSidebar: '展开侧边栏',
    resizeSidebar: '调整侧边栏宽度',
    resizeContextPanel: '调整面板宽度',
    language: '语言',
    switchToEnglish: '切换到英文',
    switchToChinese: '切换到中文',
    appearance: '外观',
    themePreference: '主题偏好',
    switchThemeToLight: '使用浅色外观',
    switchThemeToDark: '使用深色外观',
    themeLight: '浅色',
    themeDark: '深色',
    themeActiveLight: '当前：浅色',
    themeActiveDark: '当前：深色',
    chatSurface: '直接对话',
    welcomeHeading: '和 ClawHunt 一起做点什么？',
    subtitle: '在一个本地 AgentOS 工作区里对话、执行验收交付。',
    composerLabel: 'ClawHunt 输入框',
    directPrompt: '直接对话提示词',
    composerPlaceholder: '询问 ClawHunt，或直接描述你要做的任务...',
    userTurnLabel: '你',
    assistantTurnLabel: 'ClawHunt',
    directChatWorking: '思考中...',
    thinkingStatus: '思考中',
    liveThinking: '正在深度思考…',
    liveGenerating: '正在生成回复…',
    liveWorkingGeneric: '处理中…',
    liveIdlePhrases: ['正在思考', '正在梳理上下文', '正在串联线索', '正在组织答案', '正在推演下一步'],
    liveCallingToolPrefix: '正在调用 ',
    statusFailedShort: '失败',
    statusCancelledShort: '已取消',
    newContentBelow: '有新内容',
    ready: '就绪',
    working: '运行中',
    replyBatch: '回复：批量',
    eventsStatus: '事件',
    ask: '提问',
    run: '运行',
    cancel: '取消',
    stop: '终止',
    stopping: '正在终止…',
    stopped: '已终止',
    connecting: '连接中…',
    attachFiles: '添加照片和文件',
    removeAttachment: '移除附件',
    previewImage: '预览图片',
    closePreview: '关闭预览',
    copyImage: '复制图片',
    copyImageDone: '图片已复制',
    copyImageFailed: '复制图片失败',
    revealImageFailed: '定位图片失败',
    slashMenuLabel: '插入命令',
    sendHint: '回车发送 · Shift+回车换行',
    sendHintQueue: '回车入队 · Shift+回车换行',
    enqueue: '入队',
    queued: '已排队',
    queueNext: '下一个',
    queueFull: '队列已满（最多 20 条）',
    queueClear: '清空',
    queueResume: '继续',
    queuePaused: '已暂停',
    queueEdit: '编辑',
    queueRemove: '删除',
    queueMoveUp: '上移',
    queueMoveDown: '下移',
    copyMessage: '复制',
    messageCopied: '已复制',
    copyFailed: '复制失败',
    editMessage: '重新编辑',
    reEditOverwriteConfirm: '用这条消息替换你输入栏里尚未发送的草稿？',
    planPanel: '任务',
    automationPanel: '定时任务',
    closePanel: '关闭面板',
    conversationPanel: '面板',
    newTab: '新建标签页',
    newTabMenu: '新建标签页',
    closeTab: '关闭标签页',
    newWebPage: '网页',
    webTabPlaceholder: '输入网址预览…',
    webTabPreview: '预览',
    webTabInvalid: '请输入有效的 http(s) 网址。',
    conversationTabsEmpty: '从对话里点开文件或链接，或点 + 新建一个标签页。',
    chat: '聊天',
    evidence: '证据',
    settingsTitle: '设置与本地 Agent',
    pluginTitle: '能力工坊',
    backToMain: '返回主菜单',
    backToApp: '返回应用',
    settingsNavigation: '设置导航',
    settingsCurrentPage: '当前页面',
    settingsPreferences: '偏好',
    settingsAccount: '账户',
    settingsSecurity: '安全',
    settingsAgents: '诊断',
    settingsSecrets: '密钥',
    settingsRuntime: '运行时',
    settingsSubtitle: '此 ClawHunt 工作区的偏好、账户、运行时与诊断设置。',
    pluginsSubtitle: '发现、提交、验证并管理受治理的 ClawHunt 能力。',
    sidebarContextMenu: '会话操作',
    copyConversationId: '复制此对话 ID',
    conversationIdCopied: '已复制对话 ID',
    conversationIdCopyFailed: '复制对话 ID 失败',
  },
} as const;

export type ShellCopy = (typeof SHELL_COPY)[Locale];

const APP_COPY = {
  en: {
    'Chat queued behind running turn': 'Message queued — it will run automatically after the current reply finishes.',
    'Desktop home overview': 'Desktop home overview',
    'Appearance settings': 'Appearance settings',
    'Appearance settings description': 'Choose whether ClawHunt uses a light or a dark workspace.',
    'Runtime health': 'Runtime health',
	    'ClawHunt account': 'ClawHunt account',
	    'Active/recent runs': 'Active/recent runs',
	    'Agent readiness': 'Agent readiness',
	    'Agent setup required': 'Agent setup required',
	    'Agent recheck': 'Recheck',
	    'Agent recheck hint': 'Re-probe every agent executable now (e.g. after installing or reinstalling a CLI)',
	    'Agent setup description': 'Choose the local runtime agent ClawHunt should call before starting chat or delivery work. ClawHunt checks the executable on launch and will ask you to reconfigure it when it is missing.',
	    'Choose runtime agent': 'Choose runtime agent',
	    'Default runtime agent': 'Default runtime agent',
	    'Agent executable path': 'Agent executable path',
	    'Agent executable path description': 'Use an absolute executable path when auto-discovery cannot find this agent.',
	    'Agent setup ready': 'Selected agent is ready.',
	    'Agent setup choose first': 'Choose a local runtime agent before saving.',
	    'Agent setup none found': 'No local runtime agents were reported. Recheck discovery after installing an agent CLI, then choose the agent to configure.',
	    'Agent setup unavailable': 'Selected agent is not available. Configure its executable path, then save and recheck.',
	    'Agent setup save': 'Save and recheck',
	    'Agent setup later': 'Later',
	    'Configure selected agent': 'Configure selected agent',
	    'Open runtime settings': 'Open runtime settings',
	    'Test': 'Test',
	    'Deep test': 'Deep test',
	    'Deep test: run the runtime end-to-end (may use provider quota/tokens)':
	      'Deep test: run the runtime end-to-end (may use provider quota/tokens)',
	    'Test all runtimes': 'Test all',
	    'Testing…': 'Testing…',
	    'installed': 'installed',
	    'missing': 'missing',
	    'present': 'present',
	    'models': 'models',
	    'Diagnostics details': 'Details',
	    'Healthy': 'Healthy',
	    'Present, unverified': 'Present, unverified',
	    'Unreachable': 'Unreachable',
	    'Ready, untested': 'Ready, untested',
	    'Not ready': 'Not ready',
	    'Credentials rejected': 'Credentials rejected',
	    'Network unreachable': 'Network / timeout',
	    'Missing credentials': 'Missing credentials',
	    'Executable not found': 'Executable not found',
	    'Not configured': 'Not configured',
	    'Default runtime': 'Default runtime',
	    'Default': 'Default',
	    'Verified via authenticated model-list': 'Verified by an authenticated GET /v1/models — valid credentials and the provider is reachable',
	    'Save the config before testing': 'Save the config before testing',
	    'Set as default': 'Set as default',
	    'Verification': 'Verification',
	    'Collapse': 'Collapse',
	    'reason': 'reason',
	    'Agent runtime configuration': 'Agent runtime configuration',
	    'Agent runtime configuration description': 'Set the default underlying agent and its executable path. This is the runtime ClawHunt will call for direct chat and delivery orchestration.',
	    'Current default agent': 'Current default agent',
	    'Selected agent readiness': 'Selected agent readiness',
	    'Open agent setup': 'Open agent setup',
	    'ClawHunt login required': 'ClawHunt login required',
	    'ClawHunt login required description': 'Sign in or provide an agent key before using ClawHunt task actions. Local chat and local dry-runs do not require this login.',
	    'Close dialog': 'Close dialog',
    'Acceptance': 'Acceptance',
    'Evidence review': 'Evidence review',
    'Review agent doctor': 'Review agent doctor',
    'Review desktop acceptance': 'Review desktop acceptance',
    'Review TUI acceptance': 'Review TUI acceptance',
    'Desktop onboarding': 'Desktop onboarding',
    'Runtime dependency doctor': 'Runtime dependency doctor',
    'ClawHunt login': 'ClawHunt login',
    'ClawHunt signed in': 'Signed in',
    'ClawHunt agent key only': 'Agent key linked',
    'ClawHunt agent key only hint': 'Sign in with an account to view your relay balance.',
    'ClawHunt not signed in': 'Not signed in',
    'ClawHunt agent key not ready': 'Account linked, but the agent key is not ready yet.',
    'ClawHunt link linked': 'Signed in',
    'ClawHunt link limited': 'Limited',
    'ClawHunt link required': 'Required',
    'Relay account': 'Relay account',
    'Relay used': 'Used (this key)',
    'Relay quota': 'Quota',
    'Relay plan': 'Current package',
    'Relay plan none': 'Pay-as-you-go',
    'Account not subscribed': 'Not subscribed',
    'Account entitlement': 'Entitlement',
    'Entitlement unlimited': 'Pro · unlimited',
    'Entitlement free': 'Free',
    'Account relay balance': 'Relay balance',
    'Account self funded': 'self-funded',
    'Account quota unsynced': 'not synced yet',
    'Source admin': 'admin',
    'Source trial': 'trial',
    'Source grant': 'granted',
    'Relay quota unlimited': 'unlimited',
    'Relay value unknown': 'unknown',
    'Relay usage signed out': 'Sign in to view your relay balance and usage.',
    'Relay usage unavailable': 'Relay balance/usage is temporarily unavailable.',
    'Refresh relay usage': 'Refresh',
    'ClawHunt wallet': 'ClawHunt wallet',
    'ClawHunt wallet balance': 'Wallet credits',
    'ClawHunt wallet frozen': 'Frozen',
    'ClawHunt plan': 'Card pack',
    'ClawHunt plan none': 'None',
    'Token usage': 'Token usage',
    'Token usage description': 'Total SuperClaw token activity across chats, runs, and every company task in this workspace.',
    'Token usage range': 'Token usage range',
    'Token usage daily': 'Daily',
    'Token usage weekly': 'Weekly',
    'Token usage yearly': 'Yearly',
    'Token usage tooltip daily': '{date} used {tokens} tokens',
    'Token usage tooltip weekly': 'Week ending {date} used {tokens} tokens',
    'Token usage tooltip yearly': 'Up to {date}, yearly total is {tokens} tokens',
    'Refresh token usage': 'Refresh token usage',
    'Token usage unavailable': 'Token usage unavailable',
    'Token usage lifetime total': 'Lifetime tokens',
    'Token usage range total': 'Range tokens',
    'Token usage peak tokens': 'Peak tokens',
    'Token usage longest task': 'Longest task',
    'Token usage estimated cost': 'Estimated cost',
    'Token usage active buckets': 'active buckets',
    'Token usage events': 'events',
    'Token usage cached label': 'cached',
    'Token usage breakdown': '{input} input · {cached} cached · {output} output',
    'Token usage no data': 'No token usage recorded in this range.',
    'Token activity': 'Token activity',
    'Runtime settings': 'Runtime settings',
    'Desktop shell': 'Desktop shell',
    'Desktop source toolchain': 'Desktop source toolchain',
    'Desktop beta acceptance': 'Desktop beta acceptance',
    'TUI acceptance': 'TUI acceptance',
    'Manual update path': 'Manual update path',
    'Desktop alerts': 'Desktop alerts',
    'Crash and log export': 'Crash and log export',
    'Agent doctor': 'Agent dependency doctor',
    'Settings section preferences': 'Appearance, language & notifications',
    'Settings section preferences description': 'Local preferences for this device. Changes apply immediately and never affect how tasks run.',
    'Settings section account': 'ClawHunt account',
    'Settings section account description': 'Sign in to ClawHunt to let ClawHunt act on your behalf.',
    'Settings section security': 'Security',
    'Settings section security description': 'Controls for how ClawHunt handles potentially sensitive actions in the app.',
    'Preview confirmation': 'Confirm before previewing links',
    'Preview confirmation description': 'When on, clicking a link opens the viewer but waits for a second "Click to preview" before fetching the page. When off, link clicks load the sandboxed preview right away.',
    'Preview proxy': 'Use system proxy for previews',
    'Preview proxy description': 'When on, the in-app preview fetches through your OS proxy if one is set — needed for fake-IP / split-tunnel VPNs (Clash/Surge), where previews otherwise fail. Internal hosts (localhost, private IPs) stay blocked. When off, the stricter resolve-and-pin path is used and proxied sites cannot be previewed.',
    'Preview open in browser': 'Open in browser',
    'Browser back': 'Back',
    'Browser forward': 'Forward',
    'Browser reload': 'Reload',
    'Browser address': 'Address',
    'Preview click to load': 'Click to preview this page',
    'Preview reader note': 'The page is fetched under server-side safety guards and rendered here with its real styling and images — scripts never run.',
    'Preview loading': 'Loading preview…',
    'Preview truncated': 'truncated',
    'Preview links heading': 'Links on this page',
    'Preview of': 'Preview of',
    'Preview error proxy':
      "This page can't be previewed in-app — its address resolves through a proxy (e.g. a VPN in fake-IP mode) rather than to a public server, so the sandboxed reader can't reach it. Open it in your browser instead.",
    'Preview error protocol': 'Only http and https pages can be previewed. Open this link in your browser instead.',
    'Preview error redirect': 'This page redirected too many times to preview. Open it in your browser instead.',
    'Preview error content type': "This isn't a text or HTML page, so it can't be shown in the reader. Open it in your browser instead.",
    'Preview error too large': 'This page is too large to preview safely. Open it in your browser instead.',
    'Preview error timeout': 'The page took too long to fetch and the preview timed out. Open it in your browser instead.',
    'Preview error throttled': 'The preview proxy is busy right now. Try again in a moment, or open it in your browser.',
    'Preview error fetch failed': "Couldn't fetch this page for preview — the server may be unreachable or returned something unexpected. Open it in your browser instead.",
    'Preview error expired': 'This preview request expired. Click to preview again, or open it in your browser.',
    'Preview error generic': 'This page could not be previewed. Open it in your browser instead.',
    'Settings section runtime': 'Agents & execution',
    'Settings section runtime description': "Choose which local agent runs your tasks and configure each agent's executable, model and thinking effort.",
    'Settings section diagnostics': 'Diagnostics & recovery',
    'Settings section diagnostics description': 'Crash and log export, and the manual update guide. Per-runtime health and tests now live in Runtime.',
    'Plugin section discover': 'Discover and install',
    'Plugin section discover description': 'Search governed capability packages, inspect trust gates, then install only packages that pass local verification.',
    'Plugin section installed': 'Installed and local packages',
    'Plugin section installed description': 'Manage installed plugins and install signed local packages without mixing this with capability discovery.',
    'Plugin section operator': 'Operator governance and developer tools',
    'Plugin section operator description': 'Advanced diagnostics, revocations, runtime policies, and audit export stay behind this operator-only section.',
    'Marketplace hero title': 'Choose trusted capabilities for local agents',
    'Marketplace hero subtitle': 'Browse governed capabilities, inspect trust gates, then install and configure without exposing protected package internals.',
    'Marketplace catalog': 'Capability catalog',
    'Marketplace search placeholder': 'Search by capability, plugin, skill, company, runtime, or pricing',
    'Plugin catalog tab all': 'Overview',
    'Plugin catalog tab plugins': 'Plugins',
    'Plugin catalog tab skills': 'Skills',
    'Plugin catalog tab companies': 'Companies',
    'Overview section plugins': 'Plugins',
    'Overview section skills': 'Skills',
    'Overview section companies': 'Companies',
    'Overview class empty': 'No capabilities in this class yet.',
    'Use in chat': 'Use in chat',
    'Workshop open detail': 'View details',
    'Workshop back': 'Back',
    'Workshop more actions': 'More actions',
    'Workshop detail provides': 'What it provides',
    'Workshop detail provenance': 'Source and signature',
    'Workshop detail status': 'Status',
    'Workshop detail trust': 'Trust',
    'Workshop detail signer': 'Signer',
    'Workshop detail runtime': 'Runtime',
    'Workshop detail version': 'Version',
    'Workshop detail scripts': 'Scripts and assets',
    'Workshop detail no extras': 'No additional configuration for this capability.',
    'Workshop detail view signature': 'View signature evidence',
    'Skill projections title': 'Skill projections',
    'Remote skill catalog title': 'Remote published skills',
    'Remote skill catalog subtitle': 'Skills published to the workshop. View only for now — one-click get arrives in a later release.',
    'Remote skill view only': 'View only',
    'Remote skill official': 'Official',
    'Skill projections subtitle': 'Governed skills projected into native runtime directories (Codex, Claude, Gemini).',
    'Skill sync all': 'Sync skills',
    'Skill sync busy': 'Syncing…',
    'Skill sync targets': 'Targets',
    'Skill unsync': 'Reclaim',
    'Skill projections empty': 'No skills projected yet. Sync to make installed skills discoverable in each runtime.',
    'Native skill store title': 'Native skill store',
    'Native skill store subtitle': 'Skills loaded from the runtime skill registry.',
    'Native skills refresh': 'Refresh skills',
    'Native skills loading': 'Loading skills...',
    'Native skills empty': 'No native skills found.',
    'Native skills error': 'Skill registry failed',
    'Skill build title': 'Build & install (equippable)',
    'Skill build subtitle': 'Wrap a local SKILL.md into a governed, equippable skill. Local-origin skills install sign-free and are graded "local".',
    'Skill build path placeholder': 'Path to a SKILL.md file or directory',
    'Skill build action': 'Build & install',
    'Skill build busy': 'Building...',
    'Skill build success': 'Built and installed',
    'Skill build equippable': 'Equippable',
    'Skill build error': 'Build failed',
    'Native skill approved': 'Approved',
    'Native skill pending': 'Pending review',
    'Native skill rejected': 'Rejected',
    'Native skill revoked': 'Revoked',
    'Skill executable warning': 'Executable skill',
    'Skill executable details': 'Scripts/assets',
    'Plugin catalog manage': 'Manage',
    'Plugin catalog create': 'Create',
    'Plugin create action': 'Create capability',
    'Plugin creator title': 'Submit a developer capability',
    'Plugin creator description': 'Create a review record, attach a local package artifact, and track verification without mutating approved registry entries.',
    'Capability kind': 'Capability kind',
    'Capability id': 'Capability id',
    'Capability registry sync': 'Refresh',
    'Capability registry syncing': 'Refreshing',
    'Capability registry synced': 'Capabilities refreshed',
    'Capability registry sync failed': 'Capability refresh failed',
    'Capability catalog loading': 'Loading capability catalog...',
    'Capability catalog error': 'Capability catalog failed',
    'Node workshop unavailable title': 'Node capability store unavailable',
    'Node workshop unavailable body':
      'Capabilities installed via the Node workshop can’t be listed right now (the Node service is not running). Cached plugins are still shown.',
    'Open notifications': 'Open notifications',
    'Notification history': 'Notification history',
    'No notifications yet': 'No notifications yet',
    'Clear notifications': 'Clear',
    'Dismiss notification': 'Dismiss',
    'Capability approved': 'Approved',
    'Capability pending review': 'Pending review',
    'Capability rejected': 'Rejected',
    'Capability revoked': 'Revoked',
    'Capability provenance': 'Provenance',
    'Capability digest': 'Digest',
    'Capability artifact digest': 'Artifact digest',
    'Plugin catalog title': 'Let ClawHunt work your way',
    'Plugin catalog subtitle': 'Browse workshop packages and local installations across plugins, skills, and companies.',
    'Plugin catalog filter all': 'All',
    'Plugin catalog filter installed': 'Installed',
    'Plugin catalog filter available': 'Available',
    'Plugin catalog featured': 'Featured',
    'Plugin catalog local': 'Local installed',
    'Plugin catalog server source': 'Server catalog',
    'Plugin catalog mock source': 'Mock catalog',
    'Plugin catalog local source': 'Local package',
    'Plugin catalog conflict banner': 'Catalog conflicts require review before install.',
    'Plugin catalog company template': 'Company template',
    'Plugin catalog not instantiable': 'Discoverable only',
    'Plugin catalog source official': 'Official',
    'Plugin catalog source developer': 'Developer',
    'Plugin catalog source local': 'Local',
    'Company instantiate would create': 'Would create',
    'Company instantiate dropped equipment': 'Dropped equipment (not available/governed)',
    'Company instantiate high risk': 'High-risk approvals required',
    'Company instantiate blocked': 'Blocked — resolve rejections before committing.',
    'Company instantiate confirm': 'Confirm & commit',
    'Company instantiate committed': 'Company instantiated.',
    'Company instantiate approval pending': 'Submitted for human approval; nothing was written yet.',
    'Company instantiate no change': 'No change (already exists).',
    'Plugin catalog untrusted block': 'Install blocked by catalog trust state.',
    'Plugin coming soon': 'Coming soon',
    'Coming soon badge': 'Coming soon',
    'Coming soon heading': 'More capabilities on the way',
    'Coming soon lede': 'Workshop packages and team tools are rolling out. This space fills in automatically as new skills, plugins, companies, and team features are published — nothing here is broken, there is just more coming.',
    'Plugin installed status': 'Installed',
    'Plugin install action': 'Install',
    'Plugin configure action': 'Configure',
    'Plugin grouped list empty': 'No plugins match this filter.',
    'Trust and install': 'Trust and install',
    'Installed plugins': 'Installed plugins',
    'No marketplace plugins': 'No capability packages',
    'No skill plugins': 'No skills yet',
    'Skill catalog empty': 'Imported SKILL.md files appear here and can be synced into native runtime skill directories.',
    'Company catalog empty': 'Company templates appear here after a trusted catalog refresh.',
    'No marketplace plugins description': 'Refresh the registry or clear the search filter to see installable capabilities.',
    'Installed plugins empty': 'Installed plugins will appear here after a verified install.',
    'Advanced plugin operations': 'Advanced plugin operations',
    'Advanced plugin operations description': 'Diagnostics, governance feeds, audit export, and raw registry tooling are kept here for operators.',
    'Cached plugins': 'Cached plugins',
    'Marketplace summary': 'Capability summary',
    'Governance state': 'Governance state',
    'Plugin runtime diagnostics': 'Plugin runtime diagnostics',
    'Registry search': 'Registry search',
    'Local verified install': 'Local verified install',
    'Plugin marketplace detail': 'Capability package detail',
    'Install readiness': 'Install readiness',
    'Entitlement readiness': 'Entitlement readiness',
    'Update readiness': 'Update readiness',
    'Governance detail': 'Governance detail',
    'Runtime policy viewer': 'Runtime policy viewer',
    'Revocation sync viewer': 'Revocation sync viewer',
    'Developer upload': 'Developer upload',
    'Developer id label': 'Developer ID',
    'Capability package contents': 'What to include in the package',
    'Capability package format': 'Package format',
    'Package path on this machine': 'Package path (on this machine)',
    'Acceptance level label': 'Requested acceptance level',
    'Smoke timeout label': 'Smoke timeout (seconds, optional)',
    'Capability required': 'required',
    'Capability optional': 'optional',
    'Developer review': 'Developer review',
    'Plugin configuration': 'Plugin configuration',
    'Secret and config manager': 'Secret and config manager',
    'Plugin governance': 'Plugin governance',
    'Refresh onboarding': 'Refresh onboarding',
    'Download onboarding JSON': 'Download onboarding JSON',
    'Refresh acceptance': 'Refresh acceptance',
    'Download acceptance JSON': 'Download acceptance JSON',
    'Refresh TUI acceptance': 'Refresh TUI acceptance',
    'Download TUI acceptance JSON': 'Download TUI acceptance JSON',
    'Login ClawHunt': 'Login ClawHunt',
    'Sign in ClawHunt account': 'Sign in ClawHunt account',
    'Continue with ClawHunt Google': 'Continue with ClawHunt Google',
    'Open ClawHunt website login': 'Open ClawHunt website login',
    'Refresh login status': 'Refresh login status',
    'Create ClawHunt agent key': 'Create ClawHunt agent key',
    'Manual agent key': 'Manual agent key',
    'ClawHunt username': 'ClawHunt username',
    'ClawHunt password': 'ClawHunt password',
    'Sign in to ClawHunt': 'Sign in to ClawHunt',
    'Sign in with your ClawHunt account or continue with Google':
      'Sign in with your ClawHunt account or continue with Google',
    'Sign in': 'Sign in',
    or: 'or',
    'Enter your ClawHunt username and password': 'Enter your ClawHunt username and password',
    'Incorrect ClawHunt username or password': 'Incorrect ClawHunt username or password',
    'ClawHunt agent': 'ClawHunt agent',
    'No ClawHunt agents loaded': 'No ClawHunt agents loaded',
    'ClawHunt login server': 'ClawHunt login server',
    'Probe login server': 'Probe login server',
    reachable: 'reachable',
    unreachable: 'unreachable',
    probing: 'probing',
    'no response': 'no response',
    'Logout ClawHunt': 'Logout ClawHunt',
    'Save config key': 'Save config key',
    'Advanced configuration': 'Advanced configuration',
    'Send test alert': 'Send test alert',
    'Generate incident export': 'Generate incident export',
    'Download incident bundle': 'Download incident bundle',
    'Refresh diagnostics': 'Refresh diagnostics',
    'Download diagnostics JSON': 'Download diagnostics JSON',
    'Refresh plugins': 'Refresh plugins',
    'Verify and install local package': 'Verify and install local package',
    'Toggle local package install': 'Show local package install',
    'Open config': 'Open config',
    'Uninstall local': 'Uninstall local',
    'Sync entitlements': 'Sync entitlements',
    'Syncing entitlements': 'Syncing entitlements',
    'Download policy JSON': 'Download policy JSON',
    'Download revocation JSON': 'Download revocation JSON',
    'Use selected plugin': 'Use selected plugin',
    'Create submission': 'Create submission',
    'Creating submission': 'Creating submission',
    'Upload package': 'Upload package',
    'Uploading package': 'Uploading package',
    'Refresh review': 'Refresh review',
    'Refreshing review': 'Refreshing review',
    'Load review payload': 'Load review payload',
    'Manage config': 'Manage config',
    'Install': 'Install',
    'Inspect': 'Inspect',
    'Update': 'Update',
    'Reinstall': 'Reinstall',
    'Install selected': 'Install selected',
    'Update selected': 'Update selected',
    'Reinstall selected': 'Reinstall selected',
    'Uninstall plugin': 'Uninstall plugin',
    'Workshop uninstall': 'Uninstall',
    'Save setting': 'Save setting',
    'Save secret': 'Save secret',
    'Clear secret': 'Clear secret',
    'Working': 'Working',
    'Cache root': 'Cache root',
    'Developer uploads': 'Developer uploads',
    'ClawHunt ingestion': 'ClawHunt ingestion',
    'Registry indexed': 'Registry indexed',
    'Verified': 'Verified',
    'Entitled': 'Entitled',
    'Installed locally': 'Installed locally',
    'Selected plugin': 'Selected plugin',
    'Cloud root': 'Cloud root',
    'Revocations': 'Revocations',
    'Policies': 'Policies',
    'Root key': 'Root key',
    'Health': 'Health',
    'Stream': 'Stream',
    'Artifacts': 'Artifacts',
    'Failures / slow calls / sandbox kills': 'Failures / slow calls / sandbox kills',
    'Showing registry plugins': 'Showing {shown} of {total} registry plugins.',
    'Search plugins': 'Search plugins',
    'Runtime Console': 'Runtime Console',
    'ClawHunt App Shell': 'ClawHunt App Shell',
    'Command palette': 'Command palette',
    'Configure path': 'Configure path',
    'No recent runs description': 'Run a local dry-run or direct chat turn to populate the desktop home overview.',
    'Supported desktop agents description': 'Supported desktop agents: Codex, Hermes, Claude Code, OpenClaw.',
    'Missing agents description': 'Missing agents get an explicit remediation command before you hit a run failure.',
    'Rotate token': 'Rotate token',
    'Packaged update helper': 'Use the manual update path or packaged beta app flow if you are not building ClawHunt from this repo.',
    'No desktop acceptance report loaded': 'No desktop acceptance report loaded',
    'No TUI acceptance report loaded': 'No TUI acceptance report loaded',
    'No auto updater description': 'No auto-updater yet. Update the desktop beta manually before broad distribution.',
    'Update guide': 'Update guide',
    'Copy update command': 'Copy update command',
    'Update command copied': 'Update command copied to clipboard',
    'No desktop alerts yet': 'No desktop alerts yet',
    'No desktop alerts description': 'Enable alerts to get run completion or failure notifications in this workbench.',
    'Crash export description': 'Bundle current desktop shell, runtime, run, evidence, protocol export, and recent alert state into a local JSON file.',
    'Crash export nullable description': 'Missing evidence or protocol export stays nullable so you can still export runtime-only diagnostics after a bad run.',
    'No plugin runtime findings': 'No plugin runtime findings',
    'No plugin runtime findings description': 'ClawHunt has not seen repeated failures, slow calls, or sandbox-kill clusters in the local plugin evidence.',
    'Local install description': 'Use a signed local plugin directory or `.scplug` archive to install it into the local cache.',
    'Local install after description': 'After install, ClawHunt opens the plugin configuration panel so required settings and secrets are immediately visible.',
    'Select registry metadata description': 'Select a registry capability to inspect metadata and install readiness.',
    'Select registry install description': 'Select a registry plugin to see install state, update readiness, and runtime-policy gates.',
    'Select registry entitlement description': 'Select a registry plugin to inspect entitlement sync, expiry, and offline-grace state.',
    'Select registry update description': 'Select a registry capability to compare local install versions against the registry version.',
    'Select registry governance description': 'Select a registry plugin to inspect revocation and runtime-policy state.',
    'Published runtime policy payload': 'Published runtime policy payload',
    'Policies loading description': 'Policies are still loading. Refresh plugins if the runtime-policy feed has changed.',
    'Published revocation payload': 'Published revocation payload',
    'Revocations loading description': 'Revocations are still loading. Refresh plugins if the governance feed has changed.',
    'Developer review empty description': 'Create a submission and upload a local package to inspect verification status and review gates.',
    'Registry plugins': 'Registry plugins',
    'Registry plugins empty description': 'No registry plugins match the current filter.',
    'Plugin configuration empty description': 'Select an installed plugin to inspect required local settings and secrets.',
    'Basic configuration': 'Basic configuration',
    'Basic configuration description': 'Complete these required steps in order. When every step is done the plugin is configured and ready to use.',
    'Advanced settings': 'Advanced settings',
    'Advanced settings description': 'Optional values, diagnostics, and configuration export — expand only when you need them.',
    'Plugin ready': 'Ready — required steps complete',
    'Complete required steps': 'Complete the required steps below to enable this plugin',
    'No basic configuration required': 'No required configuration — this plugin is ready to use.',
    'Step': 'Step',
    'Done': 'Done',
    'Auto-provisioned': 'Auto-provided',
    'Auto provisioned hint': 'Provided automatically from your login — no action needed. You can optionally override it below.',
    'Login available': 'Login available',
    'Login required': 'Not signed in',
    'Manual override (optional)': 'Manual override (optional)',
    'Renderer safety description': 'Renderer safety: secret values are never rendered in this view or export.',
    'Download config status JSON': 'Download config status JSON',
    'Sanitized configuration status': 'Sanitized configuration status',
    'Secret manager empty description': 'Select an installed plugin to inspect missing settings and secrets without leaking values.',
    'Waiting for governance metadata': 'Waiting for governance metadata.',
    'Backend': 'Backend',
    'Harness': 'Harness',
    'Runtime model': 'Model',
    'Runtime model default': 'use backend model',
    'Runtime effort': 'Effort',
    'Runtime effort default': 'use runtime default',
    'Runtime effort hint': 'Reasoning effort / thinking level for this chat — empty inherits the runtime’s own default. Honored only by effort-capable runtimes (codex / codex-app-server / claude / opencode).',
    'Runtime package': 'Package',
    'Runtime package hint': 'ClawHunt package (套餐) for this chat — the relay’s super-group tiers (core/plus/max…) exposed after ClawHunt login, not raw models.',
    'Runtime package default': 'relay default',
    'Runtime package login required': 'sign in to ClawHunt',
    'Runtime package model': 'Model',
    'Runtime package model hint': 'Specific model inside the selected package tier (clawwork only). Leave on tier default to let the relay pick.',
    'Runtime package model default': 'tier default',
    'Runtime backend hint': 'Runtime for this chat — sticky per chat; switching backend mid-chat hands the conversation over in place and clears the model selection.',
    'Runtime not configured': 'Not configured',
    'Runtime not configured hint': 'Select to open runtime settings and finish configuring this agent.',
    'Runtime model hint': 'Model for this chat — pick a suggestion or type any model id; empty runs the backend default.',
    'Permission mode': 'Permissions',
    'Permission ask': 'Standard',
    'Permission allow': 'Allow all',
    'Permission ask hint': 'Runs this agent at the runtime’s maximum permission (same as Allow today). The runtime is a pure execution engine; ClawHunt governs sensitive actions at its own layer. A gated ask returns once the approval inbox ships.',
    'Permission allow hint': 'Allow all actions — maps to the runtime bypass/full-access mode.',
    'Control token': 'Control token',
    'Save backend default': 'Save backend default',
    'Evaluation lane': 'Evaluation lane',
    'Agent': 'Agent',
    'Case': 'Case',
    'Run eval': 'Run eval',
    'Cancel eval': 'Cancel eval',
    'Report': 'Report',
    'Worker Timeline': 'Worker Timeline',
    'Plan empty hint': 'Task plans and live progress appear here while a task is running.',
    'Planning in progress': 'Planning tasks…',
    'No plan recorded': 'No task breakdown was recorded for this run.',
    'Task Sidebar': 'Task Sidebar',
    'Task Attention': 'Needs attention',
    'Task awaiting review': 'Task awaiting review',
    'Task awaiting review description': 'The selected run is waiting for an operator decision.',
    'Task failed': 'Task failed',
    'Task failed description': 'Open settings to inspect evidence, diagnostics, and acceptance details.',
    'Evidence needs review': 'Evidence needs review',
    'Evidence needs review description': 'The selected run evidence is not passing yet.',
    'Resume run': 'Resume run',
    'Cancel run': 'Cancel run',
    'Proof before payment': 'Proof before payment',
    'No evidence artifacts': 'No evidence artifacts recorded yet.',
    'No task graph loaded': 'No task graph loaded',
    'Task graph empty': 'Select a run to inspect its task graph and lease state.',
    'Protocol export': 'Protocol export',
    'No protocol export loaded': 'No protocol export loaded',
    'Break-it profile': 'Break-it profile',
    'Open a file or link from the conversation to preview it here.':
      'Open a file or link from the conversation to preview it here.',
    'Loading imported product surfaces…': 'Loading imported product surfaces…',
    'Surface status unavailable.': 'Surface status unavailable.',
    'Start': 'Start',
    'to preview it here.': 'to preview it here.',
  },
  zh: {
    'Chat queued behind running turn': '消息已排队，将在当前回合结束后自动执行。',
    'Desktop home overview': '桌面主页概览',
    'Appearance settings': '外观设置',
    'Appearance settings description': '选择 ClawHunt 使用浅色或深色工作区。',
    'Runtime health': '运行时健康度',
	    'ClawHunt account': 'ClawHunt 账号',
	    'Active/recent runs': '活跃/最近运行',
	    'Agent readiness': 'Agent 就绪状态',
	    'Agent setup required': '需要配置底层 Agent',
	    'Agent recheck': '重新检测',
	    'Agent recheck hint': '立即重新探测所有 Agent 可执行文件(例如刚安装/重装某个 CLI 后)',
	    'Agent setup description': '先选择 ClawHunt 要调用的本地运行时 Agent，再开始对话或交付任务。ClawHunt 启动时会检查可执行文件，缺失时会提醒你重新配置。',
	    'Choose runtime agent': '选择运行时 Agent',
	    'Default runtime agent': '默认运行时 Agent',
	    'Agent executable path': 'Agent 可执行路径',
	    'Agent executable path description': '自动发现不到该 Agent 时，请填写绝对可执行路径。',
	    'Agent setup ready': '当前所选 Agent 已就绪。',
	    'Agent setup choose first': '请先选择一个本地运行时 Agent，再保存。',
	    'Agent setup none found': '尚未识别到本地运行时 Agent。安装 Agent CLI 后请重新检测，再选择要配置的 Agent。',
	    'Agent setup unavailable': '当前所选 Agent 不可用。请配置可执行路径后保存并重新检查。',
	    'Agent setup save': '保存并重新检查',
	    'Agent setup later': '稍后再说',
	    'Configure selected agent': '配置所选 Agent',
	    'Open runtime settings': '前往运行时设置',
	    'Test': '测试',
	    'Deep test': '深度测试',
	    'Deep test: run the runtime end-to-end (may use provider quota/tokens)':
	      '深度测试：端到端真实跑一次该运行时（可能消耗提供方额度/tokens）',
	    'Test all runtimes': '全部测试',
	    'Testing…': '测试中…',
	    'installed': '已安装',
	    'missing': '未安装',
	    'present': '在位',
	    'models': '个模型',
	    'Diagnostics details': '详情',
	    'Healthy': '健康',
	    'Present, unverified': '在位未验证',
	    'Unreachable': '不可达',
	    'Ready, untested': '就绪待测',
	    'Not ready': '未就绪',
	    'Credentials rejected': '凭证被拒绝',
	    'Network unreachable': '网络 / 超时',
	    'Missing credentials': '缺少凭证',
	    'Executable not found': '可执行文件未找到',
	    'Not configured': '未配置',
	    'Default runtime': '默认运行时',
	    'Default': '默认',
	    'Verified via authenticated model-list': '已通过带凭证的 GET /v1/models 验证——凭证有效且提供方可达',
	    'Save the config before testing': '请先保存配置再测试',
	    'Set as default': '设为默认',
	    'Verification': '验证方式',
	    'Collapse': '收起',
	    'reason': '原因',
	    'Agent runtime configuration': 'Agent 运行时配置',
	    'Agent runtime configuration description': '设置默认底层 Agent 和它的可执行路径。直接对话和交付编排都会调用这个运行时。',
	    'Current default agent': '当前默认 Agent',
	    'Selected agent readiness': '所选 Agent 就绪状态',
	    'Open agent setup': '打开 Agent 配置',
	    'ClawHunt login required': '需要登录 ClawHunt',
	    'ClawHunt login required description': '使用 ClawHunt 任务操作前，请先登录账号或提供 Agent Key。本地对话和本地演练不需要登录。',
	    'Close dialog': '关闭弹窗',
    'Acceptance': '验收',
    'Evidence review': '证据审查',
    'Review agent doctor': '检查 Agent 诊断',
    'Review desktop acceptance': '检查桌面验收',
    'Review TUI acceptance': '检查 TUI 验收',
    'Desktop onboarding': '桌面初始化',
    'Runtime dependency doctor': '运行时依赖诊断',
    'ClawHunt login': 'ClawHunt 登录',
    'ClawHunt signed in': '已登录',
    'ClawHunt agent key only': 'Agent key 已连接',
    'ClawHunt agent key only hint': '登录账户后可查看中转站余额。',
    'ClawHunt not signed in': '未登录',
    'ClawHunt agent key not ready': '账户已连接，但 agent key 尚未就绪。',
    'ClawHunt link linked': '已登录',
    'ClawHunt link limited': '受限',
    'ClawHunt link required': '待登录',
    'Relay account': '中转站账户',
    'Relay used': '已消费（本 key）',
    'Relay quota': '配额',
    'Relay plan': '当前套餐',
    'Relay plan none': '按量付费',
    'Account not subscribed': '未订阅',
    'Account entitlement': '当前权益',
    'Entitlement unlimited': 'Pro · 无限',
    'Entitlement free': '免费',
    'Account relay balance': '中转余额',
    'Account self funded': '自费',
    'Account quota unsynced': '暂未同步',
    'Source admin': '管理员',
    'Source trial': '试用',
    'Source grant': '赠送',
    'Relay quota unlimited': '不限额',
    'Relay value unknown': '未知',
    'Relay usage signed out': '登录后可查看中转站余额与用量。',
    'Relay usage unavailable': '中转站余额/用量暂时不可用。',
    'Refresh relay usage': '刷新',
    'ClawHunt wallet': 'ClawHunt 钱包',
    'ClawHunt wallet balance': '钱包积分',
    'ClawHunt wallet frozen': '冻结',
    'ClawHunt plan': '卡包',
    'ClawHunt plan none': '未订阅',
    'Token usage': 'Token 用量',
    'Token usage description': '汇总此工作区内所有聊天、运行和公司任务的 SuperClaw token 活动。',
    'Token usage range': 'Token 用量范围',
    'Token usage daily': '每日',
    'Token usage weekly': '每周',
    'Token usage yearly': '每年',
    'Token usage tooltip daily': '{date} 使用了 {tokens} 个 Token',
    'Token usage tooltip weekly': '截至 {date} 当周累计使用 {tokens} 个 Token',
    'Token usage tooltip yearly': '截至 {date} 年内累计使用 {tokens} 个 Token',
    'Refresh token usage': '刷新 Token 用量',
    'Token usage unavailable': 'Token 用量不可用',
    'Token usage lifetime total': '累计 Token',
    'Token usage range total': '当前范围 Token',
    'Token usage peak tokens': '峰值 Token',
    'Token usage longest task': '最长任务',
    'Token usage estimated cost': '预估成本',
    'Token usage active buckets': '活跃格',
    'Token usage events': '事件',
    'Token usage cached label': '缓存',
    'Token usage breakdown': '{input} 输入 · {cached} 缓存 · {output} 输出',
    'Token usage no data': '当前范围暂无 Token 记录。',
    'Token activity': 'Token 活动',
    'Runtime settings': '运行时设置',
    'Desktop shell': '桌面壳',
    'Desktop source toolchain': '桌面源码工具链',
    'Desktop beta acceptance': '桌面 Beta 验收',
    'TUI acceptance': 'TUI 验收',
    'Manual update path': '手动更新路径',
    'Desktop alerts': '桌面通知',
    'Crash and log export': '崩溃与日志导出',
    'Agent doctor': 'Agent 依赖诊断',
    'Settings section preferences': '外观、语言与通知',
    'Settings section preferences description': '只影响这台设备的本地偏好，修改即时生效，不会改变任务的执行方式。',
    'Settings section account': 'ClawHunt 账户',
    'Settings section account description': '登录 ClawHunt，让 ClawHunt 代表你执行任务。',
    'Settings section security': '安全',
    'Settings section security description': '控制 ClawHunt 在应用内处理潜在敏感操作的方式。',
    'Preview confirmation': '预览链接前先确认',
    'Preview confirmation description': '开启时，点击链接会打开查看器，但需再点一次「点击预览」才会抓取页面；关闭时，点击链接将直接加载沙箱预览。',
    'Preview proxy': '预览经系统代理抓取',
    'Preview proxy description': '开启时，应用内预览会在你设置了系统代理时经其抓取——fake-IP / 分流模式的 VPN（Clash/Surge）下必需，否则预览会失败。内网主机（localhost、私有 IP）仍被拦截。关闭时使用更严格的「解析并 pin IP」路径，经代理的站点将无法预览。',
    'Preview open in browser': '在浏览器中打开',
    'Browser back': '后退',
    'Browser forward': '前进',
    'Browser reload': '刷新',
    'Browser address': '地址',
    'Preview click to load': '点击预览此页面',
    'Preview reader note': '页面经服务端安全防护抓取后，在此按其真实样式与图片渲染——绝不运行任何脚本。',
    'Preview loading': '正在加载预览…',
    'Preview truncated': '已截断',
    'Preview links heading': '此页面上的链接',
    'Preview of': '预览：',
    'Preview error proxy':
      '此页面无法在应用内预览——它的地址是经代理（如 fake-IP 模式的 VPN）解析的，而非指向公网服务器，沙箱阅读器无法访问。请改用浏览器打开。',
    'Preview error protocol': '只能预览 http 和 https 页面。请改用浏览器打开此链接。',
    'Preview error redirect': '此页面重定向次数过多，无法预览。请改用浏览器打开。',
    'Preview error content type': '这不是文本或 HTML 页面，无法在阅读器中显示。请改用浏览器打开。',
    'Preview error too large': '此页面过大，无法安全预览。请改用浏览器打开。',
    'Preview error timeout': '页面抓取耗时过长，预览已超时。请改用浏览器打开。',
    'Preview error throttled': '预览代理当前繁忙。请稍后重试，或改用浏览器打开。',
    'Preview error fetch failed': '无法抓取此页面进行预览——服务器可能不可达或返回了异常内容。请改用浏览器打开。',
    'Preview error expired': '此预览请求已过期。请重新点击预览，或改用浏览器打开。',
    'Preview error generic': '此页面无法预览。请改用浏览器打开。',
    'Settings section runtime': 'Agent 与执行',
    'Settings section runtime description': '选择执行任务的本地 agent，并为每个 agent 配置可执行文件、模型与思考强度。',
    'Settings section diagnostics': '诊断与恢复',
    'Settings section diagnostics description': '崩溃与日志导出、手动更新指引；各运行时的健康检查与测试已移到「运行时」。',
    'Plugin section discover': '发现与安装',
    'Plugin section discover description': '搜索受治理的能力包，检查信任门禁，只安装通过本地验证的包。',
    'Plugin section installed': '已安装与本地包',
    'Plugin section installed description': '管理已安装插件，并安装已签名本地包，避免和能力发现流程混在一起。',
    'Plugin section operator': '操作者治理与开发者工具',
    'Plugin section operator description': '高级诊断、撤销、运行时策略和审计导出保留在操作者专区。',
    'Marketplace hero title': '为本地 Agent 选择可信能力',
    'Marketplace hero subtitle': '浏览受治理的能力，先检查信任门槛，再安装和配置，不暴露受保护的插件内部实现。',
    'Marketplace catalog': '能力目录',
    'Marketplace search placeholder': '按能力、插件、技能、公司、运行时或价格搜索',
    'Plugin catalog tab all': '总览',
    'Plugin catalog tab plugins': '插件',
    'Plugin catalog tab skills': '技能',
    'Plugin catalog tab companies': '公司',
    'Overview section plugins': '插件',
    'Overview section skills': '技能',
    'Overview section companies': '公司',
    'Overview class empty': '该类暂无能力。',
    'Use in chat': '在 chat 中使用',
    'Workshop open detail': '查看详情',
    'Workshop back': '返回',
    'Workshop more actions': '更多操作',
    'Workshop detail provides': '提供的能力',
    'Workshop detail provenance': '来源与签名',
    'Workshop detail status': '审核状态',
    'Workshop detail trust': '信任级别',
    'Workshop detail signer': '签名者',
    'Workshop detail runtime': '运行时',
    'Workshop detail version': '版本',
    'Workshop detail scripts': '脚本与资源',
    'Workshop detail no extras': '该能力暂无额外配置。',
    'Workshop detail view signature': '查看签名证据',
    'Skill projections title': '技能投射',
    'Remote skill catalog title': '云端已发布技能',
    'Remote skill catalog subtitle': '已发布到工坊的技能。当前仅可查看 —— 一键获取将在后续版本支持。',
    'Remote skill view only': '仅查看',
    'Remote skill official': '官方',
    'Skill projections subtitle': '将受治理的技能投射到各 runtime 的原生技能目录（Codex、Claude、Gemini）。',
    'Skill sync all': '同步技能',
    'Skill sync busy': '同步中…',
    'Skill sync targets': '目标',
    'Skill unsync': '回收',
    'Skill projections empty': '尚未投射任何技能。同步后已装技能即可在各 runtime 被发现。',
    'Native skill store title': '原生技能库',
    'Native skill store subtitle': '从 runtime 技能注册表读取的技能。',
    'Native skills refresh': '刷新技能',
    'Skill build title': '构建并安装（可装备）',
    'Skill build subtitle': '把本地 SKILL.md 包装为受治理、可装备的技能。本地来源免签安装，分级为「local」。',
    'Skill build path placeholder': 'SKILL.md 文件或目录路径',
    'Skill build action': '构建并安装',
    'Skill build busy': '构建中…',
    'Skill build success': '已构建并安装',
    'Skill build equippable': '可装备',
    'Skill build error': '构建失败',
    'Native skills loading': '技能加载中...',
    'Native skills empty': '未找到原生技能。',
    'Native skills error': '技能注册表读取失败',
    'Native skill approved': '已批准',
    'Native skill pending': '待审核',
    'Native skill rejected': '已拒绝',
    'Native skill revoked': '已撤销',
    'Skill executable warning': '可执行技能',
    'Skill executable details': '脚本/资产',
    'Plugin catalog manage': '管理',
    'Plugin catalog create': '创建',
    'Plugin create action': '我要创建',
    'Plugin creator title': '提交开发者能力',
    'Plugin creator description': '创建审核记录，附加本地包产物，并跟踪验证状态；已批准注册表条目不会被覆盖。',
    'Capability kind': '能力类型',
    'Capability id': '能力 ID',
    'Capability registry sync': '刷新',
    'Capability registry syncing': '刷新中',
    'Capability registry synced': '已刷新最新能力',
    'Capability registry sync failed': '刷新失败',
    'Capability catalog loading': '能力目录加载中...',
    'Capability catalog error': '能力目录加载失败',
    'Node workshop unavailable title': 'Node 能力库不可用',
    'Node workshop unavailable body': '经 Node 工坊安装的能力暂时无法列出(Node 服务未运行)。已缓存的插件仍会显示。',
    'Open notifications': '打开通知',
    'Notification history': '通知历史',
    'No notifications yet': '暂无通知',
    'Clear notifications': '清空',
    'Dismiss notification': '关闭通知',
    'Capability approved': '已批准',
    'Capability pending review': '待审核',
    'Capability rejected': '已拒绝',
    'Capability revoked': '已撤销',
    'Capability provenance': '来源',
    'Capability digest': '摘要',
    'Capability artifact digest': '产物摘要',
    'Plugin catalog title': '让 ClawHunt 按你的方式工作',
    'Plugin catalog subtitle': '用分组列表浏览能力工坊包和本地已安装能力。',
    'Plugin catalog filter all': '全部',
    'Plugin catalog filter installed': '已安装',
    'Plugin catalog filter available': '可安装',
    'Plugin catalog featured': '精选',
    'Plugin catalog local': '本地已安装',
    'Plugin catalog server source': '服务器目录',
    'Plugin catalog mock source': 'Mock 目录',
    'Plugin catalog local source': '本地包',
    'Plugin catalog conflict banner': '目录冲突需要先审核，才能安装。',
    'Plugin catalog company template': '公司模板',
    'Plugin catalog not instantiable': '仅可发现',
    'Plugin catalog source official': '官方',
    'Plugin catalog source developer': '开发者',
    'Plugin catalog source local': '本地',
    'Company instantiate would create': '将创建',
    'Company instantiate dropped equipment': '被丢弃的装备（不可用/未治理）',
    'Company instantiate high risk': '需人审的高风险项',
    'Company instantiate blocked': '已阻断——提交前请先解决拒绝项。',
    'Company instantiate confirm': '确认并提交',
    'Company instantiate committed': '公司已实例化。',
    'Company instantiate approval pending': '已提交人审；尚未写入任何状态。',
    'Company instantiate no change': '无变化（已存在）。',
    'Plugin catalog untrusted block': '目录信任状态阻止安装。',
    'Plugin coming soon': '即将接入',
    'Coming soon badge': '即将上线',
    'Coming soon heading': '更多能力即将上线',
    'Coming soon lede': '工坊能力与团队工具正在陆续上线。随着新的技能、插件、公司与团队功能发布，这里会自动补充——目前内容偏少并非故障，只是还有更多正在路上。',
    'Plugin installed status': '已安装',
    'Plugin install action': '安装',
    'Plugin configure action': '配置',
    'Plugin grouped list empty': '当前筛选下暂无插件。',
    'Trust and install': '信任与安装',
    'Installed plugins': '已安装插件',
    'No marketplace plugins': '暂无能力包',
    'No skill plugins': '暂无技能',
    'Skill catalog empty': '导入的 SKILL.md 会显示在这里，并可同步到各 runtime 的原生技能目录。',
    'Company catalog empty': '受信目录刷新后，公司模板会显示在这里。',
    'No marketplace plugins description': '刷新注册表或清空搜索条件后查看可安装能力。',
    'Installed plugins empty': '通过验证安装后，插件会显示在这里。',
    'Advanced plugin operations': '高级插件运维',
    'Advanced plugin operations description': '诊断、治理源、审计导出和原始注册表工具保留给操作者使用。',
    'Cached plugins': '已缓存插件',
    'Marketplace summary': '能力概览',
    'Governance state': '治理状态',
    'Plugin runtime diagnostics': '插件运行时诊断',
    'Registry search': '注册表搜索',
    'Local verified install': '本地验证安装',
    'Plugin marketplace detail': '能力包详情',
    'Install readiness': '安装就绪状态',
    'Entitlement readiness': '授权就绪状态',
    'Update readiness': '更新就绪状态',
    'Governance detail': '治理详情',
    'Runtime policy viewer': '运行时策略查看器',
    'Revocation sync viewer': '撤销同步查看器',
    'Developer upload': '开发者上传',
    'Developer id label': '开发者 ID',
    'Capability package contents': '能力包需要包含什么',
    'Capability package format': '包格式',
    'Package path on this machine': '能力包路径（本机）',
    'Acceptance level label': '申请验收等级',
    'Smoke timeout label': 'Smoke 超时（秒，可选）',
    'Capability required': '必需',
    'Capability optional': '可选',
    'Developer review': '开发者审查',
    'Plugin configuration': '插件配置',
    'Secret and config manager': '密钥与配置管理',
    'Plugin governance': '插件治理',
    'Refresh onboarding': '刷新初始化',
    'Download onboarding JSON': '下载初始化 JSON',
    'Refresh acceptance': '刷新验收',
    'Download acceptance JSON': '下载验收 JSON',
    'Refresh TUI acceptance': '刷新 TUI 验收',
    'Download TUI acceptance JSON': '下载 TUI 验收 JSON',
    'Login ClawHunt': '登录 ClawHunt',
    'Sign in ClawHunt account': '登录 ClawHunt 账号',
    'Continue with ClawHunt Google': '使用 ClawHunt Google 登录',
    'Open ClawHunt website login': '打开 ClawHunt 网站登录',
    'Refresh login status': '刷新登录状态',
    'Create ClawHunt agent key': '创建 ClawHunt agent key',
    'Manual agent key': '手动 agent key',
    'ClawHunt username': 'ClawHunt 用户名',
    'ClawHunt password': 'ClawHunt 密码',
    'Sign in to ClawHunt': '登录 ClawHunt',
    'Sign in with your ClawHunt account or continue with Google':
      '使用 ClawHunt 账号登录，或继续使用 Google',
    'Sign in': '登录',
    or: '或',
    'Enter your ClawHunt username and password': '请输入 ClawHunt 用户名和密码',
    'Incorrect ClawHunt username or password': 'ClawHunt 用户名或密码错误',
    'ClawHunt agent': 'ClawHunt Agent',
    'No ClawHunt agents loaded': '尚未加载 ClawHunt Agent',
    'ClawHunt login server': 'ClawHunt 登录服务器',
    'Probe login server': '探测登录服务器',
    reachable: '可达',
    unreachable: '不可达',
    probing: '探测中',
    'no response': '无响应',
    'Logout ClawHunt': '退出 ClawHunt',
    'Save config key': '保存配置项',
    'Advanced configuration': '高级配置',
    'Send test alert': '发送测试通知',
    'Generate incident export': '生成事故导出',
    'Download incident bundle': '下载事故包',
    'Refresh diagnostics': '刷新诊断',
    'Download diagnostics JSON': '下载诊断 JSON',
    'Refresh plugins': '刷新插件',
    'Verify and install local package': '验证并安装本地包',
    'Toggle local package install': '显示本地包安装入口',
    'Open config': '打开配置',
    'Uninstall local': '卸载本地版本',
    'Sync entitlements': '同步授权',
    'Syncing entitlements': '正在同步授权',
    'Download policy JSON': '下载策略 JSON',
    'Download revocation JSON': '下载撤销 JSON',
    'Use selected plugin': '使用所选插件',
    'Create submission': '创建提交',
    'Creating submission': '正在创建提交',
    'Upload package': '上传包',
    'Uploading package': '正在上传包',
    'Refresh review': '刷新审查',
    'Refreshing review': '正在刷新审查',
    'Load review payload': '加载审查载荷',
    'Manage config': '管理配置',
    'Install': '安装',
    'Inspect': '检查',
    'Update': '更新',
    'Reinstall': '重新安装',
    'Install selected': '安装所选',
    'Update selected': '更新所选',
    'Reinstall selected': '重新安装所选',
    'Uninstall plugin': '卸载插件',
    'Workshop uninstall': '卸载',
    'Save setting': '保存设置',
    'Save secret': '保存密钥',
    'Clear secret': '清除密钥',
    'Working': '处理中',
    'Cache root': '缓存根目录',
    'Developer uploads': '开发者上传',
    'ClawHunt ingestion': 'ClawHunt 导入',
    'Registry indexed': '注册表索引',
    'Verified': '已验证',
    'Entitled': '已授权',
    'Installed locally': '本地已安装',
    'Selected plugin': '所选插件',
    'Cloud root': '云端根目录',
    'Revocations': '撤销记录',
    'Policies': '策略',
    'Root key': '根密钥',
    'Health': '健康度',
    'Stream': '事件流',
    'Artifacts': '产物',
    'Failures / slow calls / sandbox kills': '失败 / 慢调用 / 沙箱终止',
    'Showing registry plugins': '正在显示 {shown} / {total} 个注册表插件。',
    'Search plugins': '搜索插件',
    'Runtime Console': '运行时控制台',
    'ClawHunt App Shell': 'ClawHunt 应用壳',
    'Command palette': '命令面板',
    'Configure path': '配置路径',
    'No recent runs description': '运行一次本地演练或直接对话后，这里会显示桌面主页概览。',
    'Supported desktop agents description': '支持的桌面 Agent：Codex、Hermes、Claude Code、OpenClaw。',
    'Missing agents description': '缺失 Agent 会在运行失败前给出明确修复命令。',
    'Rotate token': '轮换令牌',
    'Packaged update helper': '如果你不是从当前仓库构建 ClawHunt，请使用手动更新路径或打包 Beta 应用流程。',
    'No desktop acceptance report loaded': '尚未加载桌面验收报告',
    'No TUI acceptance report loaded': '尚未加载 TUI 验收报告',
    'No auto updater description': '当前还没有自动更新器。大范围分发前请手动更新桌面 Beta。',
    'Update guide': '更新指引',
    'Copy update command': '复制更新命令',
    'Update command copied': '更新命令已复制到剪贴板',
    'No desktop alerts yet': '暂无桌面通知',
    'No desktop alerts description': '启用通知后，可在此工作台接收运行完成或失败提醒。',
    'Crash export description': '把当前桌面壳、运行时、运行记录、证据、协议导出和最近通知状态打成一个本地 JSON 文件。',
    'Crash export nullable description': '缺失证据或协议导出会保留为空，这样坏运行后也能导出仅运行时诊断。',
    'No plugin runtime findings': '暂无插件运行时发现',
    'No plugin runtime findings description': 'ClawHunt 尚未在本地插件证据中发现重复失败、慢调用或沙箱终止聚集。',
    'Local install description': '使用已签名的本地插件目录或 `.scplug` 归档安装到本地缓存。',
    'Local install after description': '安装后 ClawHunt 会打开插件配置面板，立即显示必需设置和密钥项。',
    'Select registry metadata description': '选择一个注册表能力来查看元数据和安装就绪状态。',
    'Select registry install description': '选择一个注册表插件来查看安装状态、更新就绪状态和运行时策略门禁。',
    'Select registry entitlement description': '选择一个注册表插件来查看授权同步、到期和离线宽限状态。',
    'Select registry update description': '选择一个注册表能力，将本地安装版本与注册表版本进行比较。',
    'Select registry governance description': '选择一个注册表插件来查看撤销和运行时策略状态。',
    'Published runtime policy payload': '已发布的运行时策略载荷',
    'Policies loading description': '策略仍在加载。如果运行时策略 feed 已变化，请刷新插件。',
    'Published revocation payload': '已发布的撤销载荷',
    'Revocations loading description': '撤销记录仍在加载。如果治理 feed 已变化，请刷新插件。',
    'Developer review empty description': '创建提交并上传本地包，用于查看验证状态和审查门禁。',
    'Registry plugins': '注册表插件',
    'Registry plugins empty description': '当前筛选条件下没有匹配的注册表插件。',
    'Plugin configuration empty description': '选择一个已安装插件，查看必需的本地设置和密钥。',
    'Basic configuration': '基本配置',
    'Basic configuration description': '按顺序完成下面这些必填步骤。全部完成后，插件即进入 configured（可用）状态。',
    'Advanced settings': '高级设置',
    'Advanced settings description': '可选项、诊断与配置导出 —— 需要时再展开。',
    'Plugin ready': '已就绪 —— 必填步骤已全部完成',
    'Complete required steps': '完成下面的必填步骤即可启用此插件',
    'No basic configuration required': '无需必填配置 —— 此插件开箱即用。',
    'Step': '第',
    'Done': '已完成',
    'Auto-provisioned': '自动提供',
    'Auto provisioned hint': '由你的登录态自动提供，通常无需操作。如需可在下方手动覆盖。',
    'Login available': '登录态可用',
    'Login required': '未检测到登录态',
    'Manual override (optional)': '手动覆盖（可选）',
    'Renderer safety description': '渲染器安全：此视图或导出中绝不渲染密钥原文。',
    'Download config status JSON': '下载配置状态 JSON',
    'Sanitized configuration status': '已脱敏配置状态',
    'Secret manager empty description': '选择一个已安装插件，在不泄露值的情况下查看缺失设置和密钥。',
    'Waiting for governance metadata': '等待治理元数据。',
    'Backend': '后端',
    'Harness': '执行框架',
    'Runtime model': '模型',
    'Runtime model default': '沿用后端模型',
    'Runtime effort': '思考强度',
    'Runtime effort default': '沿用运行时设置',
    'Runtime effort hint': '本会话的思考强度 / 推理力度——留空则沿用运行时自身设置；仅 effort 能力的运行时生效（codex / codex-app-server / claude / opencode）。',
    'Runtime package': '套餐',
    'Runtime package hint': '本会话使用的 ClawHunt 套餐——登录 ClawHunt 账户后由中转站 super 分组提供的档位（core/plus/max…），不是裸模型。',
    'Runtime package default': '中转站默认',
    'Runtime package login required': '请先登录 ClawHunt',
    'Runtime package model': '模型',
    'Runtime package model hint': '所选套餐档位内的具体模型（仅 clawwork）。留在「档位默认」则由中转站自动选择。',
    'Runtime package model default': '档位默认',
    'Runtime backend hint': '本会话使用的运行时——按会话记忆；会话中途切换后端会就地交接对话并清空模型选择。',
    'Runtime not configured': '未配置',
    'Runtime not configured hint': '选择后将打开运行时设置，完成该 Agent 的配置。',
    'Runtime model hint': '本会话使用的模型——可选推荐项或输入任意模型 id；留空则使用后端默认。',
    'Permission mode': '权限',
    'Permission ask': '标准',
    'Permission allow': '全部允许',
    'Permission ask hint': '以该运行时的最大权限运行（当前与「全部允许」一致）。运行时只是纯执行引擎，敏感操作由 ClawHunt 在上层治理；待审批收件箱上线后会恢复带门的「先询问」。',
    'Permission allow hint': '全部允许——映射到该运行时的 bypass/完全访问模式。',
    'Control token': '控制令牌',
    'Save backend default': '保存默认后端',
    'Evaluation lane': '评测通道',
    'Agent': 'Agent',
    'Case': '用例',
    'Run eval': '运行评测',
    'Cancel eval': '取消评测',
    'Report': '报告',
    'Worker Timeline': 'Worker 时间线',
    'Plan empty hint': '任务运行时，这里会显示任务拆解与实时进度。',
    'Planning in progress': '正在拆解任务…',
    'No plan recorded': '该运行没有记录任务拆解。',
    'Task Sidebar': '任务侧栏',
    'Task Attention': '需要关注',
    'Task awaiting review': '任务等待确认',
    'Task awaiting review description': '所选运行正在等待操作者决策。',
    'Task failed': '任务失败',
    'Task failed description': '打开设置查看证据、诊断和验收细节。',
    'Evidence needs review': '证据需要审查',
    'Evidence needs review description': '所选运行的证据链尚未通过。',
    'Resume run': '恢复运行',
    'Cancel run': '取消运行',
    'Proof before payment': '付款前证明',
    'No evidence artifacts': '尚未记录证据产物。',
    'No task graph loaded': '尚未加载任务图',
    'Task graph empty': '选择一个运行来查看任务图和租约状态。',
    'Protocol export': '协议导出',
    'No protocol export loaded': '尚未加载协议导出',
    'Break-it profile': '破坏性检查画像',
    'Open a file or link from the conversation to preview it here.':
      '从对话中打开文件或链接以在此预览。',
    'Loading imported product surfaces…': '正在加载导入的产品界面…',
    'Surface status unavailable.': '界面状态不可用。',
    'Start': '启动',
    'to preview it here.': '以在此预览。',
  },
} as const;

export type AppCopyKey = keyof typeof APP_COPY.en;


function isThemePreference(value: string | null): value is AppThemePreference {
  return THEME_PREFERENCES.includes(value as AppThemePreference);
}

function readInitialThemePreference(): AppThemePreference {
  const storedValue = localStorage.getItem(THEME_STORAGE_KEY);
  if (isThemePreference(storedValue)) return storedValue;
  // No stored choice (or a legacy 'system' value that no longer exists): seed once
  // from the OS appearance so the first paint isn't jarring, then it stays a fixed
  // light/dark preference.
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

// Default ON (require confirmation) unless the user explicitly stored '0'. The
// fail-safe default keeps the no-auto-fetch security posture for anyone who never
// touches the setting.
function readInitialPreviewConfirm(): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(PREVIEW_CONFIRM_STORAGE_KEY) !== '0';
}

// Default ON (route through the system proxy when present) unless explicitly '0'.
function readInitialPreviewProxy(): boolean {
  if (typeof localStorage === 'undefined') return true;
  return localStorage.getItem(PREVIEW_PROXY_STORAGE_KEY) !== '0';
}

function resolveThemePreference(preference: AppThemePreference): AppTheme {
  // Preference is a fixed light/dark choice (no 'system' to resolve anymore).
  return preference === 'dark' ? 'dark' : 'light';
}

function applyDocumentTheme(preference: AppThemePreference): AppTheme {
  const resolvedTheme = resolveThemePreference(preference);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }
  return resolvedTheme;
}

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function readInitialSidebarWidth() {
  const storedValue = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
  if (storedValue === null) return SIDEBAR_DEFAULT_WIDTH;
  const value = Number(storedValue);
  return Number.isFinite(value) ? clampSidebarWidth(value) : SIDEBAR_DEFAULT_WIDTH;
}

function readInitialContextPanelWidth() {
  const storedValue = localStorage.getItem(CONTEXT_PANEL_WIDTH_STORAGE_KEY);
  if (storedValue === null) return CONTEXT_PANEL_DEFAULT_WIDTH;
  const value = Number(storedValue);
  return Number.isFinite(value) ? clampContextPanelWidth(value) : CONTEXT_PANEL_DEFAULT_WIDTH;
}

function eventSummary(event: RunEvent) {
  const role = event.payload.role ? ` ${String(event.payload.role)}` : '';
  const backend = event.payload.backend ? ` via ${String(event.payload.backend)}` : '';
  return `${event.type}${role}${backend}`;
}

function shortId(value: string) {
  return value.length > 14 ? `${value.slice(0, 14)}…` : value;
}

function persistedLocalId(storageKey: string, prefix: string) {
  const existing = localStorage.getItem(storageKey);
  if (existing) return existing;
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(16).slice(2) + Date.now().toString(16);
  const created = `${prefix}${random}`;
  localStorage.setItem(storageKey, created);
  return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function collectStringValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => {
        if (typeof item === 'string') return [item];
        if (isRecord(item)) return [item.name, item.id, item.path].filter((part): part is string => typeof part === 'string');
        return [];
      })
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (isRecord(value)) {
    return Object.values(value)
      .flatMap((item) => collectStringValues(item))
      .filter(Boolean);
  }
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

function safeSkillArtifactName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) return null;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) return null;
  return trimmed;
}

const NATIVE_SKILL_LABELS: NativeSkillLabel[] = ['official', 'reviewed', 'community', 'local-dev'];

function normalizeNativeSkill(raw: unknown, index: number): NativeSkillRecord | null {
  if (!isRecord(raw)) return null;
  const id =
    stringValue(raw.id) ??
    stringValue(raw.skill_id) ??
    stringValue(raw.name) ??
    stringValue(raw.slug) ??
    `skill-${index + 1}`;
  // Slug for the `@skill:<slug>` composer token. Prefer the explicit slug/skill_id
  // (what /v1/skills exposes to the picker); fall back to id so the field is always
  // populated even for legacy rows that only carry an id.
  const slug = stringValue(raw.slug) ?? stringValue(raw.skill_id) ?? id;
  const name = stringValue(raw.name) ?? stringValue(raw.title) ?? id;
  const summary =
    stringValue(raw.summary) ??
    stringValue(raw.description) ??
    stringValue(raw.detail) ??
    `${id}${stringValue(raw.version) ? `@${stringValue(raw.version)}` : ''}`;
  const labelValues = [
    ...collectStringValues(raw.labels),
    ...collectStringValues(raw.label),
    ...collectStringValues(raw.tier),
    ...collectStringValues(raw.trust),
  ]
    .map((label) => label.toLowerCase())
    .filter((label, labelIndex, labels) => labels.indexOf(label) === labelIndex);
  const executable = raw.executable === true;
  const scriptCandidates = [
    ...collectStringValues(raw.scripts),
    ...collectStringValues(raw.script_names),
    ...collectStringValues(raw.entrypoints),
  ];
  const assetCandidates = [
    ...collectStringValues(raw.assets),
    ...collectStringValues(raw.asset_names),
  ];
  return {
    id,
    slug,
    name,
    summary,
    version: stringValue(raw.version),
    source: stringValue(raw.source) ?? stringValue(raw.origin),
    path: stringValue(raw.path) ?? stringValue(raw.source_path),
    package_digest: stringValue(raw.package_digest),
    artifact_blob_digest: stringValue(raw.artifact_blob_digest),
    acceptance_level: stringValue(raw.acceptance_level),
    trust: stringValue(raw.trust),
    status: stringValue(raw.status),
    capability_status: stringValue(raw.capability_status),
    labels: labelValues,
    tier: stringValue(raw.tier),
    executable,
    scripts: scriptCandidates.map(safeSkillArtifactName).filter((name): name is string => Boolean(name)),
    assets: assetCandidates.map(safeSkillArtifactName).filter((name): name is string => Boolean(name)),
  };
}

function nativeSkillList(payload: NativeSkillStorePayload): NativeSkillRecord[] {
  const rawItems = payload.skills ?? payload.items ?? payload.records ?? [];
  return rawItems.map(normalizeNativeSkill).filter((item): item is NativeSkillRecord => Boolean(item));
}

function formatSeconds(seconds: number | undefined) {
  if (!seconds && seconds !== 0) return 'unknown';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}


function artifactFileLabel(path: string) {
  const normalized = path.trim();
  if (!normalized) return 'Artifact file';
  return normalized.split('/').filter(Boolean).pop() ?? normalized;
}

const TASK_DONE_STATUSES = new Set(['completed', 'success', 'succeeded', 'passed', 'done']);
const TASK_FAILED_STATUSES = new Set(['failed', 'error', 'cancelled']);
const TASK_RUNNING_STATUSES = new Set(['running', 'started', 'leased', 'in_progress', 'verifying']);

function taskStatusTone(status?: string): 'good' | 'bad' | 'live' | 'neutral' {
  const normalized = (status ?? 'pending').toLowerCase();
  if (TASK_DONE_STATUSES.has(normalized)) return 'good';
  if (TASK_FAILED_STATUSES.has(normalized)) return 'bad';
  if (TASK_RUNNING_STATUSES.has(normalized)) return 'live';
  return 'neutral';
}

function toneForStatus(status: string) {
  if (status === 'completed') return 'good';
  if (status === 'failed' || status === 'cancelled') return 'bad';
  if (status === 'stopped') return 'warn';
  if (status === 'WAITING_FOR_HUMAN_GATE' || status === 'verifying') return 'warn';
  if (status === 'working' || status === 'pending' || status === 'running') return 'live';
  if (ACTIVE_RUN_STATUSES.has(status)) return 'live';
  return 'neutral';
}

function errorStatus(error: unknown) {
  if (!error || typeof error !== 'object' || !('status' in error)) return null;
  const value = (error as { status?: unknown }).status;
  return typeof value === 'number' ? value : null;
}

function clawHuntAccountUserLabel(user?: Record<string, unknown> | null) {
  if (!user) return 'unset';
  for (const key of ['handle', 'username', 'email', 'display_name', 'github_username', 'id']) {
    const value = user[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number') return String(value);
  }
  return 'set';
}

// Stable per-account identity key for account-scoped reloads/isolation — prefers the
// immutable account id, then email, never the display LABEL (two accounts can share a
// display name; the label is not an identity, Codex blocker). '' when signed out.
function clawHuntAccountStableKey(user?: Record<string, unknown> | null): string {
  if (!user) return '';
  const id = user['id'];
  if (typeof id === 'number' || (typeof id === 'string' && id.trim())) return `id:${id}`;
  const email = user['email'];
  if (typeof email === 'string' && email.trim()) return `email:${email}`;
  return `u:${JSON.stringify(user)}`;
}

function clawHuntAccountAvatarUrl(user?: Record<string, unknown> | null) {
  if (!user) return '';
  for (const key of ['avatar_url', 'avatar', 'picture', 'image_url', 'photo_url']) {
    const value = user[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) return trimmed;
    }
  }
  return '';
}

function clawHuntAgentLabel(agent: ClawHuntAccountAgent) {
  return agent.name || agent.handle || agent.title || `Agent ${agent.id}`;
}

function extractClawHuntAccountAgents(payload: unknown): ClawHuntAccountAgent[] {
  const normalize = (value: unknown): ClawHuntAccountAgent | null => {
    if (!value || typeof value !== 'object') return null;
    const item = value as Record<string, unknown>;
    const rawId = item.id ?? item.agent_id;
    const id = typeof rawId === 'number' ? rawId : typeof rawId === 'string' ? Number.parseInt(rawId, 10) : Number.NaN;
    if (!Number.isFinite(id) || id <= 0) return null;
    return {
      id,
      name: typeof item.name === 'string' ? item.name : undefined,
      handle: typeof item.handle === 'string' ? item.handle : undefined,
      title: typeof item.title === 'string' ? item.title : undefined,
      status: typeof item.status === 'string' ? item.status : undefined,
    };
  };
  const collect = (value: unknown): ClawHuntAccountAgent[] => {
    if (Array.isArray(value)) return value.map(normalize).filter((agent): agent is ClawHuntAccountAgent => Boolean(agent));
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    for (const key of ['agents', 'items', 'data', 'results']) {
      const nested = collect(record[key]);
      if (nested.length > 0) return nested;
    }
    const single = normalize(record);
    return single ? [single] : [];
  };
  return collect(payload);
}

const MARKDOWN_PLUGINS = [remarkGfm];
const MARKDOWN_SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

// Defense-in-depth: only ever hand http/https/mailto links to the OS/browser.
// react-markdown already neutralizes javascript:/data: hrefs, but we re-check
// here so a future urlTransform override or library change can't open them.
export function safeMarkdownExternalHref(rawHref: string | null): string | null {
  if (!rawHref) return null;
  const href = rawHref.trim();
  if (!href || href.startsWith('#')) return null;
  // Require an ABSOLUTE external href. A bare relative path (e.g. ``../foo`` or
  // ``setup.sh``) resolves to http(s) against our own origin and would otherwise
  // be handed to the OS/browser opener — a path-escape into the desktop opener.
  // Only genuinely-schemed http/https/mailto links may ever be opened externally.
  if (!/^(?:https?:|mailto:)/i.test(href)) return null;
  try {
    const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost';
    const protocol = new URL(href, base).protocol.toLowerCase();
    return MARKDOWN_SAFE_LINK_PROTOCOLS.has(protocol) ? href : null;
  } catch {
    return null;
  }
}

export const AssistantMarkdown = memo(function AssistantMarkdown({
  content,
  desktopInvoke,
  fileRunId,
  onFileView,
  onWebView,
}: {
  content: string;
  desktopInvoke: DesktopInvoke | null;
  /** The run whose checkout a relative-path link in this content refers to. */
  fileRunId?: string | null;
  /** When set (with fileRunId), markdown links that are plain relative paths open
   * the file viewer for THAT run instead of the browser (only AST link nodes —
   * no free-text path scanning; the link belongs to its own run's checkout). */
  onFileView?: (runId: string, path: string) => void;
  /** When set, an absolute http(s) link opens in the in-app web preview (a
   * server-sanitized reader) instead of the browser; mailto: still opens out. */
  onWebView?: (url: string) => void;
}) {
  const onLinkClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const rawHref = event.currentTarget.getAttribute('href');
    // A plain relative path -> open in the reference viewer for this run (the
    // kernel re-checks path/trust/sensitivity fail-closed).
    if (onFileView && fileRunId) {
      const filePath = fileLinkPath(rawHref);
      if (filePath) {
        onFileView(fileRunId, filePath);
        return;
      }
    }
    // Otherwise only a genuinely-absolute external URL may be opened — a relative
    // path that did not qualify as a file link is NOT handed to the OS opener.
    const href = safeMarkdownExternalHref(rawHref);
    if (!href) return;
    // An absolute http(s) URL opens in the in-app web preview (server-sanitized
    // reader) when the host wired one in; other schemes (mailto:) still open out.
    if (onWebView && /^https?:/i.test(href)) {
      onWebView(href);
      return;
    }
    if (desktopInvoke) {
      void openDesktopExternalUrl(desktopInvoke, href);
    } else if (typeof window !== 'undefined') {
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  };
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={MARKDOWN_PLUGINS}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" onClick={onLinkClick} />
          ),
          // Don't auto-load remote images (IP/tracking leak). Render a safe,
          // click-to-open link instead, reusing the same protocol allowlist.
          img: ({ node: _node, src, alt, ...props }) => {
            const safeSrc = safeMarkdownExternalHref(typeof src === 'string' ? src : null);
            const label = (typeof alt === 'string' && alt.trim()) || safeSrc || 'image';
            if (!safeSrc) return <span className="markdown-image-link">🖼 {label}</span>;
            return (
              <a
                {...(props as AnchorHTMLAttributes<HTMLAnchorElement>)}
                href={safeSrc}
                target="_blank"
                rel="noreferrer noopener"
                onClick={onLinkClick}
                className="markdown-image-link"
              >
                🖼 {label}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

// Helper for a number-or-undefined usage field (provider-native keys vary).
function usageNum(usage: Record<string, unknown>, key: string): number | undefined {
  const v = usage[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined;
}

// Canonical token-field groups (mirror ToolCallCard's USAGE_FIELDS): each group's
// FIRST present provider-native alias contributes once, so claude's
// cache_read_input_tokens and a codex-style cached_input_tokens never double-count.
const USAGE_TOTAL_KEY_GROUPS: string[][] = [
  ['input_tokens', 'prompt_tokens'],
  ['output_tokens', 'completion_tokens'],
  ['cache_read_input_tokens', 'cached_input_tokens', 'cache_read_tokens'],
  ['cache_creation_input_tokens', 'cache_creation_tokens'],
];

// Compact grand-total tokens for a turn's usage, for the always-visible top metric
// (痛点6). Returns 0 when the runtime reported NO usage (codex/gemini) so the
// caller shows 用时 alone — never a fabricated "0 tokens" (Full Disclosure).
//
// Prefer an authoritative provider total when present (e.g. OpenAI-style
// `total_tokens`, where prompt_tokens already INCLUDES cached tokens — summing the
// groups would double-count). Only when no explicit total exists do we sum the
// mutually-exclusive groups (claude's input/output/cache_* are disjoint).
function usageTokenTotal(usage: Record<string, unknown> | null | undefined): number {
  if (!usage) return 0;
  const explicit = usageNum(usage, 'total_tokens') ?? usageNum(usage, 'total');
  if (typeof explicit === 'number') return explicit;
  let total = 0;
  for (const group of USAGE_TOTAL_KEY_GROUPS) {
    for (const key of group) {
      const v = usageNum(usage, key);
      if (typeof v === 'number') {
        total += v;
        break;
      }
    }
  }
  return total;
}

// Mid-stream, a fenced code block (```) may be open but not yet closed — the
// parser would then swallow the entire tail as code (or leak the bare ``` glyphs).
// Provisionally close an odd fence count so the partial message renders as prose
// while it streams. We deliberately do NOT touch single backticks: a global count
// can't tell an unclosed inline span from an odd number of backticks legitimately
// inside a (closed) fence, and over-closing makes the tail flicker. Streaming is
// transient — a briefly-imperfect inline span beats a corrupted render. Pure
// cosmetics on the LIVE string only; the authoritative final content parses verbatim.
export function closeStreamingMarkdown(text: string): string {
  if (!text) return text;
  // Close whichever fence kind is currently open (``` or ~~~), so a mid-stream
  // code block still renders as code instead of leaking the raw fence/swallowing
  // the tail. Fall back to balancing a lone inline backtick only when no fence is
  // open. Pure cosmetics on the LIVE string; the final content parses verbatim.
  const backticks = (text.match(/^[ \t]*```/gm) ?? []).length;
  const tildes = (text.match(/^[ \t]*~~~/gm) ?? []).length;
  if (backticks % 2 === 1) return text + '\n```';
  if (tildes % 2 === 1) return text + '\n~~~';
  if (((text.match(/`/g) ?? []).length) % 2 === 1) return text + '`';
  return text;
}

// AssistantMarkdown for a STILL-STREAMING turn (Q2 — smoothness without breaking
// markdown). Two levers, both structure-safe (we always parse the WHOLE valid
// document, never split it):
//   1. requestAnimationFrame batching — coalesce a burst of SSE deltas into ONE
//      parse per paint frame (smooth cadence vs the old steppy 60ms interval).
//      The pending frame is NEVER cancelled on a content change (that would starve
//      flush under sub-frame-rate deltas and freeze the UI); it just reads the
//      latest content off a ref. The frame is cancelled only on unmount.
//   2. useDeferredValue — the markdown parse runs at LOW priority, so even a very
//      long reply degrades to "markdown lags a frame" instead of freezing input/
//      scroll. (We deliberately dropped structural chunking: splitting markdown at
//      blank lines corrupts loose lists / blockquotes / nested fences.)
export const StreamingAssistantMarkdown = memo(function StreamingAssistantMarkdown({
  content,
  streaming,
  desktopInvoke,
  fileRunId,
  onFileView,
  onWebView,
}: {
  content: string;
  streaming: boolean;
  desktopInvoke: DesktopInvoke | null;
  fileRunId?: string | null;
  onFileView?: (runId: string, path: string) => void;
  onWebView?: (url: string) => void;
}) {
  const latestRef = useRef(content);
  latestRef.current = content;
  const [shown, setShown] = useState(content);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!streaming) {
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Flush the authoritative final content once the turn settles.
      setShown(latestRef.current);
      return;
    }
    // Schedule at most ONE frame; do NOT cancel a queued frame on each delta, or a
    // fast stream (delta < frame) would perpetually re-queue and never paint.
    if (rafRef.current == null) {
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        setShown(latestRef.current);
      });
    }
  }, [content, streaming]);

  // Cancel only on unmount.
  useEffect(
    () => () => {
      if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const deferred = useDeferredValue(shown);
  if (!streaming) {
    return (
      <AssistantMarkdown
        content={content}
        desktopInvoke={desktopInvoke}
        fileRunId={fileRunId}
        onFileView={onFileView}
        onWebView={onWebView}
      />
    );
  }
  // Cross-session reuse / divergence: if the throttled value is no longer a prefix
  // of the live content, paint the live content directly THIS frame (no stale flash
  // before the next rAF).
  const base = deferred && content.startsWith(deferred) ? deferred : content;
  return (
    <AssistantMarkdown
      content={closeStreamingMarkdown(base)}
      desktopInvoke={desktopInvoke}
      fileRunId={fileRunId}
      onFileView={onFileView}
      onWebView={onWebView}
    />
  );
});

// Live "用时 Ns" counter for a streaming turn (痛点4). Self-contained: it owns its
// own 1s interval and local state, so ONLY this tiny node re-renders each second —
// never the whole App (a global clock state would re-render the entire tree). The
// interval lives exactly as long as the component is mounted (i.e. the turn is
// working); when the turn settles the meta row drops it and the interval is cleared.
const LiveTurnElapsed = memo(function LiveTurnElapsed({ startedAt, locale }: { startedAt: number; locale: Locale }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const text = formatElapsedDuration(now - startedAt, locale);
  return text ? <span className="chat-live-elapsed">{text}</span> : null;
});

const SUPERCLAW_PINCER_LOADER_APNG_SRC = '/superclaw-pincer-loader.png';
const SUPERCLAW_PINCER_LOADER_WEBP_SRC = '/superclaw-pincer-loader.webp';
const SUPERCLAW_PINCER_LOADER_STILL_SRC = '/superclaw-pincer-loader-first-frame.png';

const SuperClawLoadingMark = memo(function SuperClawLoadingMark({ className = '' }: { className?: string }) {
  return (
    <span className={`superclaw-loading-mark${className ? ` ${className}` : ''}`} aria-hidden="true">
      <picture className="superclaw-loading-mark-frame superclaw-loading-mark-animated">
        <source srcSet={SUPERCLAW_PINCER_LOADER_WEBP_SRC} type="image/webp" />
        <img className="superclaw-loading-mark-image" src={SUPERCLAW_PINCER_LOADER_APNG_SRC} alt="" draggable={false} />
      </picture>
      <img
        className="superclaw-loading-mark-frame superclaw-loading-mark-image superclaw-loading-mark-static"
        src={SUPERCLAW_PINCER_LOADER_STILL_SRC}
        alt=""
        draggable={false}
      />
    </span>
  );
});

const LIVE_PHRASE_ROTATE_MS = 2400;

// The live running indicator (痛点1): a shimmering activity word + an
// animated "…" + the ticking 用时. Real stages (tool → reasoning → generating)
// always win; ONLY when no signal has arrived yet do we gently rotate "思考中"-style
// phrases so the wait never feels frozen. All motion is CSS (no high-frequency React
// state) and degrades under prefers-reduced-motion.
const ChatLiveStatus = memo(function ChatLiveStatus({
  runningToolLabel,
  hasReasoning,
  hasContent,
  startedAt,
  locale,
  copy,
}: {
  runningToolLabel: string | null;
  hasReasoning: boolean;
  hasContent: boolean;
  startedAt?: number | null;
  locale: Locale;
  copy: {
    liveCallingToolPrefix: string;
    liveThinking: string;
    liveGenerating: string;
    liveIdlePhrases: readonly string[];
  };
}) {
  const idle = !runningToolLabel && !hasReasoning && !hasContent;
  const [phrase, setPhrase] = useState(0);
  useEffect(() => {
    if (!idle) {
      setPhrase(0);
      return;
    }
    const id = window.setInterval(() => setPhrase((v) => v + 1), LIVE_PHRASE_ROTATE_MS);
    return () => window.clearInterval(id);
  }, [idle]);

  const raw = runningToolLabel
    ? `${copy.liveCallingToolPrefix}${runningToolLabel}`
    : hasReasoning && !hasContent
      ? copy.liveThinking
      : hasContent
        ? copy.liveGenerating
        : copy.liveIdlePhrases[phrase % copy.liveIdlePhrases.length];
  // The animated dots provide the trailing "…"; strip any in the source string so
  // we never show "正在生成回复……".
  const activity = raw.replace(/[.…]+$/u, '');

  // Screen-reader cue: a polite status that announces ONLY the real stage (and a
  // stable "thinking" when idle) — never the per-second 用时 or the rotating idle
  // phrases, so there's no announcement spam. The visual indicator below is
  // decorative (aria-hidden); this sr-only node is what assistive tech reads.
  const srStage = runningToolLabel
    ? `${copy.liveCallingToolPrefix}${runningToolLabel}`.replace(/[.…]+$/u, '')
    : hasContent
      ? copy.liveGenerating.replace(/[.…]+$/u, '')
      : copy.liveThinking.replace(/[.…]+$/u, '');
  return (
    <>
      <span className="sr-only" role="status">
        {srStage}
      </span>
      <span className="chat-live-status" data-testid="chat-live-status" aria-hidden="true">
        <span className="chat-live-activity">{activity}</span>
        <span className="chat-live-dots" aria-hidden="true" />
        {typeof startedAt === 'number' ? <LiveTurnElapsed startedAt={startedAt} locale={locale} /> : null}
      </span>
    </>
  );
});

function StartupLoadingScreen({ title, message }: { title: string; message: string }) {
  // Startup tracing: fires when React has committed the loading UI to the DOM
  // (useLayoutEffect runs after mutations, before paint). The gap from
  // `react-render-called` to here is React's initial render of the (large) App
  // tree; the gap from here to the next paint shows whether the loading UI
  // actually became visible — central to diagnosing the "no animation" window.
  useLayoutEffect(() => {
    recordStartupMark('react-startup-screen-committed');
  }, []);
  return (
    <main className="startup-screen" role="status" aria-live="polite">
      <section className="startup-card" aria-label="ClawHunt startup">
        <div className="startup-logo-shell">
          <img src="/superclaw-icon.png" alt="ClawHunt" />
        </div>
        <div className="startup-copy">
          <span className="startup-product-name">{title}</span>
          <span>{message}</span>
        </div>
      </section>
    </main>
  );
}

// --- 对话侧边栏 tab 辅助 -----------------------------------------------------
// tab 是「会话内临时态」：刻意不持久化到 localStorage。file tab 携带 runId，
// 若跨刷新从本地存储恢复，会让「文件查看必须来自该 turn 显式 runId」的 provenance
// 边界从"用户点了该 turn 的链接"退化成"本地存储里有 runId" —— 故不落盘，
// file/web tab 永远只能由当前 transcript 的真实交互产生。

/** 网页 tab 标题：取域名，解析失败则原样截断 URL。 */
function webTabTitle(url: string, fallback: string): string {
  const trimmed = url.trim();
  if (!trimmed) return fallback;
  try {
    return new URL(trimmed).host || trimmed;
  } catch {
    return trimmed.length > 28 ? `${trimmed.slice(0, 27)}…` : trimmed;
  }
}

/** 文件 tab 标题：取路径末段文件名。 */
function fileTabTitle(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : path;
}

// 地址栏输入归一化为后端可用的 http(s) URL。后端 canonical_preview_url 只接受
// http/https，外部打开走 scheme allowlist。
//
// 策略（避免"补 https:// 把非 http(s) scheme 静默改写"的坑）：
//   1. 先按原样解析 —— 若已带任何 scheme（http(s)/mailto:/javascript:/data:/ftp: …），
//      只放行 http/https，其余 scheme 一律拒绝（return null），绝不前缀改写。
//   2. 仅当原样无法解析（即真的没有 scheme，如裸 host `example.com`、`example.com/docs`）
//      才补 `https://` 再解析。
// 边界取舍：无 scheme 的 `host:port`（如 `example.com:8080`）会被第 1 步当作 scheme
//   解析而拒绝；用户需显式写 `https://example.com:8080`（fail-closed，可接受）。
function normalizeWebTabUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const accept = (value: string): string | null => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return parsed.toString();
    } catch {
      return null;
    }
  };
  // 已带 scheme：原样判定（http(s) 放行，其余拒绝），不做任何前缀改写。
  try {
    // eslint-disable-next-line no-new
    new URL(trimmed);
    return accept(trimmed);
  } catch {
    // 无 scheme：补 https:// 再判定。
    return accept(`https://${trimmed}`);
  }
}

// 新建/空白网页 tab 的地址栏：WebPreviewPanel 只接收一个确定 URL，没有地址输入，
// 所以空白网页 tab 先呈现这个输入框，提交（归一化为 http(s)）后把 URL 写回该 tab
// → 转入沙箱预览。归一化失败（空 / 非 http(s) scheme）时本地标记错误、不提交。
function WebTabAddressBar({
  onSubmit,
  placeholder,
  submitLabel,
  invalidLabel,
}: {
  onSubmit: (url: string) => void;
  placeholder: string;
  submitLabel: string;
  invalidLabel: string;
}) {
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      className="web-tab-address"
      onSubmit={(event) => {
        event.preventDefault();
        const normalized = normalizeWebTabUrl(value);
        if (!normalized) {
          setInvalid(true);
          return;
        }
        setInvalid(false);
        onSubmit(normalized);
      }}
    >
      <div className="web-tab-address-row">
        <Globe size={16} aria-hidden="true" />
        <input
          type="text"
          inputMode="url"
          className="web-tab-address-input"
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-invalid={invalid}
          onChange={(event) => {
            setValue(event.target.value);
            if (invalid) setInvalid(false);
          }}
        />
        <button type="submit" className="text-button compact" disabled={!value.trim()}>
          {submitLabel}
        </button>
      </div>
      {invalid ? (
        <p className="web-tab-address-error" role="alert">
          {invalidLabel}
        </p>
      ) : null}
    </form>
  );
}

// Unified toast overlay. Transient global notifications (copy confirmations,
// sync results, action failures, …) funnel through here instead of the old
// inline `.composer-message` bar. Persistent in-context errors (catalog/skill
// load failures) intentionally stay as their own banners with retry.
// Toast tone. We only ever assert 'error'; everything else is neutral 'info' — an
// unrecognized transient message is NEVER painted green as a confirmed "success".
export type ToastTone = 'error' | 'info';
type Toast = { id: number; text: string; tone: ToastTone };

// Session-local notification history (the expandable "notification center"). Kept
// in MEMORY ONLY — transient UI text can carry session ids or URLs, so it is
// deliberately not written to disk, and of course never shipped to the kernel
// diagnostics system or any backend. It answers "I missed that toast, what did it
// say?" within the current session.
type NotificationEntry = { id: number; text: string; tone: ToastTone; ts: number };
const NOTIFICATION_HISTORY_LIMIT = 50;

// Classify a transient message. Conservative: only a clear failure/refusal signal
// is 'error'; all else is neutral 'info'. Over-flagging a benign message as info is
// harmless; mislabeling a failure as success is the bug this guards against.
export function inferToastTone(text: string): ToastTone {
  return /fail|error|refus|denied|reject|blocked|invalid|unable|cannot|must |require|unavailable|失败|错误|拒绝|无法|不可|不能|需要|请先/i.test(
    text,
  )
    ? 'error'
    : 'info';
}

export function formatNotificationTime(ts: number, locale: 'en' | 'zh'): string {
  const deltaSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (deltaSec < 45) return locale === 'zh' ? '刚刚' : 'just now';
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return locale === 'zh' ? `${min} 分钟前` : `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return locale === 'zh' ? `${hr} 小时前` : `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return locale === 'zh' ? `${day} 天前` : `${day}d ago`;
}

// "Background" status texts are diagnostic / degraded-mode load noise that must
// never surface as a transient toast — the inline bar suppressed them, and the
// toast bridge does too. The capability catalog/workshop load failures join their
// sibling load diagnostics here: the *persistent* catalog failure is surfaced by
// the in-context `pluginCatalogError` banner (with retry), so a duplicate
// auto-dismissing toast would only add noise.
export function isBackgroundStatusText(text: string): boolean {
  return (
    text.includes('probe failed:') ||
    text.startsWith('desktop runtime failed:') ||
    text.startsWith('backend probe failed:') ||
    text.startsWith('harness probe failed:') ||
    text.startsWith('config probe failed:') ||
    text.startsWith('agent probe failed:') ||
    text.startsWith('auth probe failed:') ||
    text.startsWith('plugin status failed:') ||
    text.startsWith('plugin registry failed:') ||
    text.startsWith('plugin revocations failed:') ||
    text.startsWith('plugin policy failed:') ||
    text.startsWith('plugin diagnostics failed:') ||
    text.startsWith('run probe failed:') ||
    text.startsWith('eval probe failed:') ||
    text.startsWith('capability catalog failed') ||
    text.startsWith('capability workshop failed')
  );
}

// Each toast owns its own auto-dismiss timer via this child's effect, so the timer
// is cleaned up exactly when the toast unmounts (manual dismiss, eviction past the
// visible cap, or app teardown). This removes the whole class of orphaned-timer /
// StrictMode-ghost bugs that a parent-managed timer map invites.
function ToastItem({
  toast,
  onDismiss,
  dismissLabel,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
  dismissLabel: string;
}) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.tone === 'error' ? 6500 : 3500);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.tone, onDismiss]);
  return (
    <div className={`toast-item toast-item--${toast.tone}`}>
      <span className="toast-item-text">{toast.text}</span>
      <button type="button" className="toast-item-dismiss" onClick={() => onDismiss(toast.id)} aria-label={dismissLabel}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

function ToastStack({
  toasts,
  onDismiss,
  dismissLabel,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
  dismissLabel: string;
}) {
  // The live region is always mounted (not conditional on toasts.length) so screen
  // readers reliably announce items appended into it.
  return (
    <div className="toast-stack" aria-live="polite" aria-label="Notifications">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} dismissLabel={dismissLabel} />
      ))}
    </div>
  );
}

function NotificationCenter({
  history,
  open,
  unread,
  locale,
  labels,
  onToggle,
  onClose,
  onClear,
}: {
  history: NotificationEntry[];
  open: boolean;
  unread: number;
  locale: 'en' | 'zh';
  labels: { open: string; history: string; empty: string; clear: string };
  onToggle: () => void;
  onClose: () => void;
  onClear: () => void;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="notification-center">
      <button
        ref={anchorRef}
        type="button"
        className="notification-bell"
        aria-label={unread > 0 ? `${labels.open} (${unread})` : labels.open}
        aria-expanded={open}
        onClick={onToggle}
      >
        <Bell size={16} aria-hidden="true" />
        {unread > 0 ? (
          <span className="notification-bell-badge" aria-hidden="true">
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>
      <Popover
        open={open}
        anchorRef={anchorRef}
        ariaLabel={labels.history}
        className="notification-popover"
        onClose={onClose}
      >
        <div className="notification-panel">
          <header className="notification-panel-head">
            <strong>{labels.history}</strong>
            {history.length > 0 ? (
              <button type="button" className="notification-clear" onClick={onClear}>
                {labels.clear}
              </button>
            ) : null}
          </header>
          {history.length === 0 ? (
            <p className="notification-empty">{labels.empty}</p>
          ) : (
            <ul className="notification-list">
              {history.map((entry) => (
                <li key={entry.id} className={`notification-row notification-row--${entry.tone}`}>
                  <span className="notification-row-dot" aria-hidden="true" />
                  <span className="notification-row-text">{entry.text}</span>
                  <time className="notification-row-time">{formatNotificationTime(entry.ts, locale)}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Popover>
    </div>
  );
}

export function App() {
  const desktopInvoke = useMemo(() => detectDesktopInvoke(), []);
  const canvasRuntimeReader = useMemo(() => createCanvasRuntimeReader(), []);
  const desktopMode = Boolean(desktopInvoke);
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [selectedBackend, setSelectedBackend] = useState('');
  // Per-chat model selection ('' = backend default). Kernel rule mirrored from
  // the CLI shell: switching backend clears the model (ids are not portable).
  const [selectedModel, setSelectedModel] = useState('');
  // Per-chat reasoning-effort / thinking level. The composer state IS the per-turn
  // request, mirroring the model field EXACTLY: a non-empty value sets/keeps the
  // sticky effort; an empty value is the explicit "use the runtime's configured
  // default this turn" request (REQUEST_CLEAR — it clears any sticky override,
  // same as an empty model). The composer syncs this from the chat's sticky effort
  // on load, so leaving it untouched re-sends (preserves) the sticky value. Cleared
  // on a backend switch like the model, since effort levels are runtime-specific.
  const [selectedEffort, setSelectedEffort] = useState('');
  const [selectedHarness, setSelectedHarness] = useState('codex');
  // Two-state permission shell (docs/permission-mode-framework.md). Under the
  // max-permission doctrine both presets map to bypassPermissions (the runtime
  // is a pure execution engine), so 'ask' (shown as "Standard") and 'allow' run
  // identically at max today; the slot is kept for a future gated ask. Persisted
  // across sessions.
  const [permissionPreset, setPermissionPreset] = useState<'ask' | 'allow'>(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('superclaw.permissionPreset') : null;
    return stored === 'allow' ? 'allow' : 'ask';
  });
  const selectPermissionPreset = (preset: 'ask' | 'allow') => {
    setPermissionPreset(preset);
    try {
      localStorage.setItem('superclaw.permissionPreset', preset);
    } catch {
      // persistence is best-effort
    }
  };
  const selectComposerBackend = (backend: string) => {
    setSelectedBackend((previous) => {
      if (previous !== backend) {
        setSelectedModel(''); // kernel rule: model ids do not cross a backend switch
        setSelectedEffort(''); // same rule: effort levels are runtime-specific
      }
      return backend;
    });
  };
  // Guards the sticky-runtime restore effect: one application per
  // session+runtime payload, so a sessions refresh never fights user edits,
  // and the optimistic just-created session (no runtime yet) keeps the
  // selection the user just sent with instead of resetting to the default.
  const appliedChatRuntimeRef = useRef('');
  const backendDefaultAppliedRef = useRef(false);
  // Freshest client-side turns per backend session (keyed by session id), carrying
  // the in-flight 'working' status + reasoning/tool `display` that the persisted
  // cache and the server projection both drop. A background run keeps updating this
  // even while its session is not focused, so switching back to a still-running (or
  // just-finished) chat can re-attach the accumulated live state instead of a bare
  // placeholder. Preferred over the cache in openSidebarSessionItem when not shorter.
  const liveChatTurnsRef = useRef<Map<string, DirectChatTurn[]>>(new Map());
  const [prompt, setPrompt] = useState('');
  // /compact orchestration state: the summary pending injection into the FIRST turn of
  // the post-compact draft session (consumed-or-dropped exactly once), and a re-entrancy
  // guard so a double /compact can't run two summarize turns. Refs, not state — nothing
  // renders from them; the boundary marker turn carries the visible summary.
  const compactSeedRef = useRef<string | null>(null);
  const compactingRef = useRef(false);
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(null);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [selectedContextRefs, setSelectedContextRefs] = useState<ComposerContextRef[]>([]);
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  // Composer mode controls — the permission preset pill ("Standard"/"Allow") and
  // the Goal toggle — are temporarily hidden on web + desktop per product decision.
  // The underlying state/handlers stay live (permissionPreset keeps its safe 'ask'
  // default, goalModeOn stays off), so flipping this back to `true` fully restores
  // both controls with no other change.
  const SHOW_COMPOSER_MODE_CONTROLS = false;
  // Goal Mode (目标模式): when on, sending plans the message into a goal and opens
  // the confirmation dialog instead of running a plain chat turn.
  const [goalModeOn, setGoalModeOn] = useState(false);
  const [goalModeRecord, setGoalModeRecord] = useState<GoalRecord | null>(null);
  // Single in-flight lock for /api/goals/plan: a ref drives the submit guard (always
  // the live value), the state drives the send-button disabled UI.
  const [goalPlanBusy, setGoalPlanBusy] = useState(false);
  const goalPlanBusyRef = useRef(false);
  // Per-chat prompt history recall (like Claude Code / a shell): ArrowUp/ArrowDown
  // in the composer walk the prompts the user already submitted IN THIS CHAT.
  // `null` = editing the live draft; 0..n-1 indexes history oldest→newest. Held in a
  // ref (not state) because nothing renders on it AND a ref is read/written
  // SYNCHRONOUSLY, so a key-repeat / batched burst of ArrowUp keydowns never
  // recomputes from a stale value. The live draft (full payload) is stashed when
  // navigation begins so ArrowDown past the newest entry restores it intact.
  const composerHistoryIndexRef = useRef<number | null>(null);
  const composerHistoryDraftRef = useRef<{
    content: string;
    contextRefs: ComposerContextRef[];
    attachments: ComposerAttachment[];
  }>({ content: '', contextRefs: [], attachments: [] });
  // The exact text history navigation last wrote into the composer. If the live
  // value diverges from it while "browsing", SOMETHING ELSE rewrote the composer
  // (re-edit, slash command, queue edit, …) — so we self-heal out of browse mode
  // instead of clobbering that fresh content on the next ArrowDown.
  const composerHistoryAppliedRef = useRef<string | null>(null);
  // Hidden mirror used to decide whether the caret sits on the FIRST VISUAL ROW of
  // the textarea (so ArrowUp recall fires from a single-line draft's end too, yet
  // never hijacks ArrowUp inside a long SOFT-WRAPPED paragraph).
  const composerCaretMirrorRef = useRef<HTMLDivElement | null>(null);
  // IME guard for Enter-to-send. WKWebView/Safari dispatch `compositionend` BEFORE
  // the committing Enter's keydown, and that keydown reports `isComposing === false`
  // — so a flag set on compositionend marks the brief window the keydown handler must
  // treat as "still finishing the IME commit" (e.g. confirming a Chinese candidate)
  // rather than a send. Chrome/Firefox are covered by `isComposing`/keyCode 229.
  const composerImeComposingRef = useRef(false);
  const composerImeJustEndedRef = useRef(false);
  const [deliveryDryRun] = useState(true);
  const [runId, setRunId] = useState('');
  const [selectedRun, setSelectedRun] = useState<RunSessionState | null>(null);
  const [runs, setRuns] = useState<RunSessionState[]>([]);
  const [status, setStatus] = useState('idle');
  // run 事件日志（incident export 的 recent_events 取它的尾段；run live SSE 追加）。
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [evidence, setEvidence] = useState<EvidenceBundle | null>(null);
  const [imageLightbox, setImageLightbox] = useState<
    { src: string; name: string; mime?: string | null; path?: string | null } | null
  >(null);
  const [imageContextMenu, setImageContextMenu] = useState<ImageContextMenuState | null>(null);
  // Transient "copied" affordance for chat-turn copy buttons; keyed by turn index.
  const [copiedChatTurn, setCopiedChatTurn] = useState<number | null>(null);
  const copiedChatTurnTimerRef = useRef<number | null>(null);
  const [protocolExport] = useState<ProtocolExportPayload | null>(null);
  const [paySwitch, setPaySwitch] = useState<PaySwitchStatus | null>(null);
  const [message, setMessage] = useState('');
  // Unified toast overlay state. `message` itself is left intact (a downstream
  // desktop-alert effect still reads it as a fallback detail) — we only mirror
  // each transient change into a floating, auto-dismissing toast.
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const lastToastedMessageRef = useRef<string | null>(null);
  // Stable identity: each ToastItem owns its dismiss timer and lists this in effect
  // deps, so dismissToast must not be re-created every render (that would re-arm the
  // timer endlessly and the toast would never auto-dismiss).
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);
  // Session-local notification history (the expandable "notification center").
  // In-memory only — never written to disk or shipped anywhere.
  const [notificationHistory, setNotificationHistory] = useState<NotificationEntry[]>([]);
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const [notificationUnread, setNotificationUnread] = useState(0);
  const toggleNotificationPanel = () => {
    setNotificationPanelOpen((openNow) => {
      if (!openNow) setNotificationUnread(0);
      return !openNow;
    });
  };
  const clearNotificationHistory = () => {
    setNotificationHistory([]);
    setNotificationUnread(0);
  };
  const [controlToken, setControlToken] = useState(() => localStorage.getItem('superclaw_control_token') ?? '');
  const [desktopStatus, setDesktopStatus] = useState<'browser' | 'starting' | 'connected' | 'failed' | 'stopped'>(
    desktopMode ? 'starting' : 'browser',
  );
  const [desktopShellInfo, setDesktopShellInfo] = useState<DesktopShellInfo | null>(null);
  const [desktopSession, setDesktopSession] = useState<DesktopRuntimeSession | null>(null);
  // Splash dismissal is bounded independently of service readiness. Browser canvas
  // checks Node + gateway; legacy surfaces retain the Python runtime/list contract.
  const [startupGateReady, setStartupGateReady] = useState(false);
  const [canvasStartupStatus, setCanvasStartupStatus] = useState<'checking' | 'ready' | 'unavailable'>('checking');
  const [canvasStartupAttempt, setCanvasStartupAttempt] = useState(0);
  // Monotonic epochs for the two sidebar-list loaders. A loader captures the epoch at
  // entry and only applies its setState writes if it is still the latest call — so a
  // late-failing request (e.g. one issued before Node was reachable, resolving AFTER a
  // newer success) can never clobber fresh data back to empty. This closes the startup
  // race between this pump and the parallel run-state refresh (both call these loaders).
  const chatSessionsLoadEpochRef = useRef(0);
  const runsLoadEpochRef = useRef(0);
  const desktopRuntimeStartPromiseRef = useRef<Promise<DesktopRuntimeSession | null> | null>(null);
  // Bounds the "already in progress" retry loop (see ensureDesktopRuntimeSession)
  // so a pathological shell state can never produce an unbounded 600ms IPC storm.
  const desktopStartRetriesRef = useRef(0);
  const [directChatTurns, setDirectChatTurns] = useState<DirectChatTurn[]>([]);
  // Sticky auto-scroll: true while the user is parked at the bottom of the
  // transcript. A manual scroll-up flips it false so streaming output stops
  // yanking the view down; a "新内容" pill (and reaching the bottom) re-pins it.
  // (The live "用时" counter is owned by the per-turn <LiveTurnElapsed> node, NOT a
  // global clock — a global tick would re-render the whole App every second.)
  const [chatPinnedToBottom, setChatPinnedToBottom] = useState(true);
  // Prompts the user submitted IN THE CHAT ON SCREEN, oldest→newest. Sourced from the
  // active chat's transcript so it stays per-chat and survives a session reload; empties
  // are dropped and consecutive duplicates collapsed so ArrowUp recall stays useful.
  // Each entry carries the turn's FULL input payload (text + context refs + attachments)
  // so recall faithfully reproduces what was sent — never the live draft's leftovers.
  const composerPromptHistory = useMemo<
    { content: string; contextRefs?: ComposerContextRef[]; attachments?: ComposerAttachment[] }[]
  >(() => {
    const out: { content: string; contextRefs?: ComposerContextRef[]; attachments?: ComposerAttachment[] }[] = [];
    // Signature over the FULL payload (text + refs + attachments) so two adjacent
    // turns with identical text but different @refs/attachments are kept as DISTINCT
    // history entries — collapsing only on content would lose a real, sent payload.
    const signature = (entry: { content: string; contextRefs?: ComposerContextRef[]; attachments?: ComposerAttachment[] }) =>
      JSON.stringify([
        entry.content,
        (entry.contextRefs ?? []).map((ref) => contextRefKey(ref)),
        (entry.attachments ?? []).map((att) => att.id),
      ]);
    for (const turn of directChatTurns) {
      if (turn.role !== 'user') continue;
      const content = turn.content;
      if (!content.trim()) continue;
      const entry = { content, contextRefs: turn.contextRefs, attachments: turn.attachments };
      if (out.length > 0 && signature(out[out.length - 1]) === signature(entry)) continue;
      out.push(entry);
    }
    return out;
  }, [directChatTurns]);
  const [localChatSessions, setLocalChatSessions] = useState<LocalChatSession[]>(readLocalChatSessions);
  const [backendChatSessions, setBackendChatSessions] = useState<BackendChatSession[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  // PR-C sidebar: archived view toggle (drives include_archived on the fetch),
  // per-workspace collapse state (persisted), and the new-workspace / move
  // dialogs. All presentation — the kernel owns archive/move/create semantics.
  const [showArchived, setShowArchived] = useState(false);
  // Read by loadChatSessions (called from intervals whose closures would
  // otherwise capture a stale value) so the archived view always re-fetches
  // with the current toggle state.
  const showArchivedRef = useRef(showArchived);
  showArchivedRef.current = showArchived;
  // IDs of optimistic chat sessions added client-side before the backend has
  // confirmed them. Only THESE are carried across a refetch — a persisted
  // session that the scoped/archived fetch excludes must NOT be re-kept as a
  // "draft" (else archiving an unassigned Chats session never hides it).
  const optimisticChatIdsRef = useRef<Set<string>>(new Set());
  // IDs that have appeared in a SUCCESSFUL backend fetch — i.e. the backend owns
  // them. Once confirmed, a session is never re-added to the optimistic set (the
  // per-turn rememberBackendChatSession refresh fires for existing sessions too),
  // so its later archive/exclusion is honored even if a refetch is swallowed.
  const confirmedChatIdsRef = useRef<Set<string>>(new Set());
  const [collapsedWorkspaceGroups, setCollapsedWorkspaceGroups] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem(SIDEBAR_COLLAPSED_GROUPS_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [newWorkspaceAttach, setNewWorkspaceAttach] = useState(false);
  const [newWorkspaceRepo, setNewWorkspaceRepo] = useState('');
  const [newWorkspaceTrust, setNewWorkspaceTrust] = useState(false);
  const [newWorkspaceBusy, setNewWorkspaceBusy] = useState(false);
  // Inline error for the create-project dialog: the kernel rejects a name that
  // collides with an existing ~/SuperClaw/<name> folder (422). We surface that
  // message INSIDE the modal (next to the name field) so the user can rename and
  // retry in place, instead of as a global chat-bar toast.
  const [newWorkspaceError, setNewWorkspaceError] = useState<string | null>(null);
  // A brand-new chat the user opened from a project's "+" is pinned to that
  // workspace: the FIRST turn carries workspace_id (+ repo_path:null) so the
  // kernel files the new session into the project and executes inside the
  // workspace's own root — never the dev server's cwd. Cleared once the chat
  // owns a session id (the binding then lives on the session). Same kernel
  // capability the CLI exposes via `superclaw chat --workspace <id>`.
  const [pinnedWorkspaceId, setPinnedWorkspaceId] = useState<string | null>(null);
  const [pinnedWorkspaceName, setPinnedWorkspaceName] = useState<string | null>(null);
  // Move dialog: the session being moved; the pending target awaiting a
  // boundary-change acknowledgement (set only after the kernel returns 409).
  const [moveSessionId, setMoveSessionId] = useState<string | null>(null);
  const [moveBusyTarget, setMoveBusyTarget] = useState<string | null>(null);
  const [movePendingTarget, setMovePendingTarget] = useState<{ workspaceId: string | null; label: string } | null>(null);
  const [sidebarNow, setSidebarNow] = useState(() => Date.now());
  // Unread count for the "Agent 组" sidebar badge. Sourced from the Paperclip
  // control plane (summed sidebar-badges via paperclipBridge), with a transitional
  // fallback to the Python /api/team/messages roll-up when Paperclip is
  // unreachable — never re-derived on the surface. 0 = no badge.
  const [teamUnread, setTeamUnread] = useState(0);
  // Existing companies offered in the composer `@` menu (manage / view tasks).
  // Sourced from the UNION of both company homes — Paperclip-native (GET /companies
  // via paperclipBridge) and legacy Python (/api/team/companies) — so every company
  // is visible regardless of which store created it. See the @-menu load effect.
  // The "create a new company" entry is synthesized in composerSuggestions, not here.
  const [composerTeamCompanies, setComposerTeamCompanies] = useState<
    { company_profile_id: string; name: string; status?: string }[]
  >([]);
  // Native skills offered in the composer `@` menu. The kernel (GET /v1/skills) is
  // the single source — never re-derived. Picking one inserts a `@skill:<slug>` text
  // token (the same contract the CLI/kernel parse); it does NOT add a context_ref.
  const [composerSkills, setComposerSkills] = useState<
    { slug: string; name: string; description: string }[]
  >([]);
  const sidebarReadBaselineRef = useRef(Date.now());
  const [sidebarReadReceipts, setSidebarReadReceipts] = useState<Record<string, number>>(() =>
    readSidebarTimestampMap(SIDEBAR_READ_RECEIPTS_STORAGE_KEY),
  );
  const [sidebarKnownUpdates, setSidebarKnownUpdates] = useState<Record<string, number>>(() =>
    readSidebarTimestampMap(SIDEBAR_KNOWN_UPDATES_STORAGE_KEY),
  );
  const [activeLocalChatSessionId, setActiveLocalChatSessionId] = useState('');
  const [activeBackendChatSessionId, setActiveBackendChatSessionId] = useState('');
  // Chat-session ids that have a scheduled automation — drives the sidebar "automated"
  // badge. One fetch covers all; refreshed when the session list changes.
  const [automationSessionIds, setAutomationSessionIds] = useState<Set<string>>(() => new Set());
  // Copy feedback is keyed by transcript index; the transcript is swapped wholesale
  // on session switch, so clear any stale ✓ (and the pending timer) when the active
  // session changes — otherwise it could briefly land on a same-index turn in the
  // newly-opened session. The cleanup also cancels the timer on unmount.
  useEffect(() => {
    setCopiedChatTurn(null);
    return () => {
      if (copiedChatTurnTimerRef.current !== null) {
        window.clearTimeout(copiedChatTurnTimerRef.current);
        copiedChatTurnTimerRef.current = null;
      }
    };
  }, [activeBackendChatSessionId, activeLocalChatSessionId]);
  // Per-session run state: every chat session (a backend id, a local id, or the
  // single in-composer draft slot) runs INDEPENDENTLY. A turn in flight in chat
  // A must NEVER block sending in chat B — they run concurrently, each with its
  // own queue. runningTurnsRef maps a session key -> the AbortController of its
  // in-flight turn (synchronous source of truth); runningKeys mirrors its keys
  // for rendering. See chatTurnKey() for how a session maps to its key.
  const runningTurnsRef = useRef<Map<string, AbortController>>(new Map());
  const [runningKeys, setRunningKeys] = useState<string[]>([]);
  // Per-session map of the delivery run_id this chat's in-flight turn spawned,
  // so Stop cancels ONLY that run — never whatever run is globally selected.
  // Per-session "stopping" (abort requested, awaiting unwind). Keyed so one
  // chat's Stop never freezes another's composer.
  const stoppingKeysRef = useRef<Set<string>>(new Set());
  const [stoppingKeys, setStoppingKeys] = useState<string[]>([]);
  // Per-session "Stop pressed before chat.started returned the server id". The
  // backing run is already spawned but its session id is unknown, so we can't
  // cancel it yet; aborting now would only detach. We park the intent here and
  // fire the native cancel the instant chat.started delivers the id.
  const pendingStopKeysRef = useRef<Set<string>>(new Set());
  const [chatQueue, setChatQueue] = useState<ChatQueueItem[]>([]);
  const [chatQueueExpanded, setChatQueueExpanded] = useState(false);
  // Per-session login banner: a runtime backend auth failure (claude 401, …)
  // maps a chat key → the actionable "log in" text. Keyed (not global) so a
  // background turn's failure never lands on the chat in view, and the banner
  // follows the conversation the user is looking at. Cleared on that chat's next
  // success or an explicit dismiss.
  const [runtimeLoginNotices, setRuntimeLoginNotices] = useState<Record<string, string>>({});
  // Per-session pause: Stop halts THAT session's chain so a prompt added during
  // the async abort window does not auto-run; other sessions keep pumping.
  const pausedKeysRef = useRef<Set<string>>(new Set());
  const [pausedKeys, setPausedKeys] = useState<string[]>([]);
  const [evalAgent, setEvalAgent] = useState('all');
  const [evalCase, setEvalCase] = useState('mini-pay-webhook');
  const [evalId, setEvalId] = useState('');
  const [evalStatus, setEvalStatus] = useState('idle');
  const [evalReport, setEvalReport] = useState<EvalReport | null>(null);
  const [evalHistory, setEvalHistory] = useState<EvalReport[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatusPayload | null>(null);
  // Deep runtime-reachability probe results (on-demand "Test" — GET /api/agents/probe).
  // Keyed by backend name; absent = not yet tested this session.
  const [probeResults, setProbeResults] = useState<Record<string, RuntimeProbeResult>>({});
  const [probingBackends, setProbingBackends] = useState<Record<string, boolean>>({});
  const [probeAllBusy, setProbeAllBusy] = useState(false);
  // Re-entry guard for the serial "Test all" sweep — a double-click / keyboard /
  // programmatic trigger must not start a second concurrent sweep before the React
  // disabled state has flushed (that would fan parallel probes at one provider).
  const probeAllRunningRef = useRef(false);
  // Per-backend in-flight guard for single probes — a double-click on one row's
  // Test (or a Test-all + manual Test on the same backend before the disabled
  // state flushes) must not fire two live probes at once.
  const probeInFlightRef = useRef<Set<string>>(new Set());
  // Global probe generation. Any invalidation bumps it; a probe captures the
  // generation at dispatch and only writes its result if it is unchanged on
  // return — so an in-flight probe whose config changed mid-flight can never
  // write a stale "reachable" back. A single global counter (not a per-backend
  // map read from a render closure) is what makes invalidate-all correct under
  // the "probe returns BEFORE the config-save resolves" interleave: invalidation
  // bumps the ref synchronously, never reading a stale probeResults snapshot.
  const probeGenerationRef = useRef(0);
  // Config env a read-only Diagnostics deep-link wants the runtime-config editor
  // to highlight (an agent's executable env) — never changes chat or the default.
  const [settingsConfigFocus, setSettingsConfigFocus] = useState('');
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfigPayload | null>(null);
  const [runtimeConfigLoaded, setRuntimeConfigLoaded] = useState(false);
  const [agentControl, setAgentControl] = useState<AgentControlPayload | null>(null);
  const [pluginStatus, setPluginStatus] = useState<PluginStatusPayload | null>(null);
  const [pluginDiagnostics, setPluginDiagnostics] = useState<PluginDiagnosticsPayload | null>(null);
  const [pluginDiagnosticsStreamState, setPluginDiagnosticsStreamState] = useState<'idle' | 'connecting' | 'live' | 'failed'>('idle');
  const [registryPlugins, setRegistryPlugins] = useState<RegistryPluginInfo[]>([]);
  const [pluginCatalogLoading, setPluginCatalogLoading] = useState(false);
  const [pluginCatalogError, setPluginCatalogError] = useState<string | null>(null);
  const [catalogSyncBusy, setCatalogSyncBusy] = useState(false);
  const [catalogLiveLoaded, setCatalogLiveLoaded] = useState(false);
  const [catalogCompanyItems, setCatalogCompanyItems] = useState<RegistryPluginInfo[]>([]);
  // D3 PR-5: company instantiate flow — pure presentation over the existing
  // proposal->review->commit contract. `phase` drives the review modal; `proposal`
  // is the dry-run diff from POST /api/team/bootstrap {mode:proposal}; `result` holds
  // the commit outcome (committed or a pending human approval). No client trust logic:
  // instantiability is the contract `instantiable` field; trust is the kernel gate.
  const [companyInstantiate, setCompanyInstantiate] = useState<CompanyInstantiateState | null>(null);
  const [catalogConflicts, setCatalogConflicts] = useState<CatalogConflict[]>([]);
  const [catalogContract, setCatalogContract] = useState<CatalogContractPayload | null>(null);
  const [capabilityUploadContract, setCapabilityUploadContract] = useState<CapabilityUploadContract | null>(null);
  const [marketplaceServerPlugins, setMarketplaceServerPlugins] = useState<MarketplaceCatalogPluginInfo[]>([]);
  const [pluginRevocations, setPluginRevocations] = useState<PluginRevocationPayload | null>(null);
  const [pluginPolicies, setPluginPolicies] = useState<PluginPolicyPayload | null>(null);
  const [selectedPluginKey, setSelectedPluginKey] = useState('');
  const [pluginConfiguration, setPluginConfiguration] = useState<PluginConfigurationPayload | null>(null);
  const [pluginConfigModalOpen, setPluginConfigModalOpen] = useState(false);
  const [pluginSettingDrafts, setPluginSettingDrafts] = useState<Record<string, unknown>>({});
  const [pluginDynamicOptions, setPluginDynamicOptions] = useState<Record<string, PluginDynamicOption[]>>({});
  const [pluginConfigActionResults, setPluginConfigActionResults] = useState<Record<string, PluginConfigToolResult>>({});
  const [pluginOptionsError, setPluginOptionsError] = useState<Record<string, string>>({});
  const pluginOptionsInFlightRef = useRef<Set<string>>(new Set());
  const [pluginConfigBusy, setPluginConfigBusy] = useState<string | null>(null);
  const [pluginSecretDrafts, setPluginSecretDrafts] = useState<Record<string, string>>({});
  const [pluginActionBusy, setPluginActionBusy] = useState('');
  const [localPluginPackagePath, setLocalPluginPackagePath] = useState('');
  const [entitlementDeviceId] = useState(() => persistedLocalId('superclaw_entitlement_device_id', 'scdev_'));
  const [pluginEntitlements, setPluginEntitlements] = useState<EntitlementSyncPayload['entitlements']>([]);
  // GitHub-backed plugin ids come from the backend download kit (/api/plugins/github-catalog).
  // Seeded with the static fallback so install still works if that fetch hasn't returned yet.
  const [githubBackedIds, setGithubBackedIds] = useState<Set<string>>(() => new Set(GITHUB_BACKED_PLUGIN_IDS));
  // Workshop capabilities the kernel can fetch+install from a trusted distribution
  // point (/api/plugins/workshop-distribution), keyed by ``pluginKey(id, version)``.
  // A workshop card whose id@version is here offers a REAL install (download ->
  // official co-signature + digest verify -> cache) instead of being discovery-only;
  // empty until that fetch returns.
  const [workshopInstallableIds, setWorkshopInstallableIds] = useState<Set<string>>(() => new Set());
  // Capabilities landed by the Node S4 super-workshop (origin=node-workshop), from the neutral
  // /api/capabilities/installed BFF — unioned into the installed view alongside the Python cache.
  const [nodeInstalledCaps, setNodeInstalledCaps] = useState<NodeInstalledCapability[]>([]);
  // false => Node store read degraded (not co-launched / loopback failed); the surface shows a
  // notice rather than silently implying "nothing installed".
  const [nodeWorkshopAvailable, setNodeWorkshopAvailable] = useState<boolean>(true);
  const [entitlementSyncState, setEntitlementSyncState] = useState<'idle' | 'syncing' | 'ready' | 'failed'>('idle');
  const [selectedRegistryPluginKey, setSelectedRegistryPluginKey] = useState('');
  const [developerDraft, setDeveloperDraft] = useState({
    kind: 'plugin' as DeveloperCapabilityKind,
    developerId: 'dev_local',
    capabilityId: '',
    requestedAcceptanceLevel: 'L1',
    packagePath: '',
    // Blank by default → the field is omitted on submit so the server applies its
    // own default smoke timeout (and the env-overridable floor). Aligns with the
    // API's None semantics instead of pinning a divergent client-side 10s.
    smokeTimeoutSeconds: '',
  });
  const [developerSubmissionId, setDeveloperSubmissionId] = useState('');
  const [developerSubmission, setDeveloperSubmission] = useState<DeveloperSubmissionPayload | null>(null);
  const [developerSubmissionBusy, setDeveloperSubmissionBusy] = useState<'create' | 'upload' | 'refresh' | ''>('');
  const [authStatus, setAuthStatus] = useState<ClawHuntAuthPayload | null>(null);
  const [clawHuntSsoIdentity, setClawHuntSsoIdentity] = useState<ClawHuntSsoIdentity | null>(null);
  const [clawHuntProfile, setClawHuntProfile] = useState<ClawHuntProfilePayload | null>(null);
  const [clawHuntLoginProbe, setClawHuntLoginProbe] = useState<ClawHuntLoginProbePayload | null>(null);
  const [clawHuntKeyInput, setClawHuntKeyInput] = useState('');
  const [clawHuntBrowserLoginBusy, setClawHuntBrowserLoginBusy] = useState('');
  const [clawHuntAccountAgents, setClawHuntAccountAgents] = useState<ClawHuntAccountAgent[]>([]);
  const [selectedClawHuntAgentId, setSelectedClawHuntAgentId] = useState<number | null>(null);
  const [clawHuntAgentKeyName, setClawHuntAgentKeyName] = useState('ClawHunt Desktop');
	  const [agentExecutableDraft, setAgentExecutableDraft] = useState('');
	  const [agentSetupOpen, setAgentSetupOpen] = useState(false);
	  const [agentRecheckBusy, setAgentRecheckBusy] = useState(false);
	  // Live model catalog per backend (kernel model_discovery via
	  // /api/agents/{name}/models). Fetched lazily when the model field is
	  // focused; static contract hints remain the instant fallback.
	  const [modelCatalogs, setModelCatalogs] = useState<Record<string, { models: string[]; source: string }>>({});
  // ClawHunt packages (套餐) for relay-backed runtimes: the relay's super groups
  // (core/plus/max…) shown after ClawHunt login, NOT raw models. Single source
  // with the CLI/kernel relay_packages() via GET /api/relay/packages.
  const [relayPackages, setRelayPackages] = useState<{
    // `locked` (issue #452): package exceeds the account unlock ceiling — kernel decides
    // via /api/relay/packages (is_tier_locked); surface never re-derives a tier order (铁律6).
    packages: { id: string; name: string; tier: string; group_slug: string; locked?: boolean }[];
    source: string;
    available: boolean;
  } | null>(null);
  // Level-2 (per-tier) model lists for relay packages — clawwork's two-level menu only.
  // On-demand + cached per tier (GET /api/relay/packages/{tier}/models, kernel
  // relay_package_models()); listing a tier's models binds the relay key to that tier
  // server-side, so we never pre-fetch all tiers — only the one the user selects, once.
  // Map value: undefined = not yet fetched, [] = fetched-empty (fail-soft), [..] = models.
  const [relayPackageModels, setRelayPackageModels] = useState<Record<string, string[]>>({});
  const [relayPackageModelsLoading, setRelayPackageModelsLoading] = useState<string | null>(null);
  // Relay account balance + this key's usage/quota, shown after ClawHunt login.
  // Single source with the CLI `superclaw relay usage` / kernel relay_usage() via
  // GET /api/relay/usage (the usage endpoint already carries account_balance, so
  // one call covers balance + credits used + quota). `ok=false` = not logged in /
  // relay unreachable (a fail-soft envelope, never a thrown error); numeric fields
  // are null when the relay omitted them (rendered "unknown"), never faked to 0.
  // Normalized account overview (GET /api/relay/account, kernel account_overview()):
  // purchased package (billing_plan) vs effective entitlement (+source) vs self-funded
  // relay usage — kept as distinct sources so an admin's unlimited bypass is never
  // shown as a purchase. null = not yet loaded; ok=false = surface unreachable.
  const [accountOverview, setAccountOverview] = useState<{
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
  } | null>(null);
  const [accountTokenUsageMode, setAccountTokenUsageMode] = useState<AccountTokenUsageMode>('daily');
  const [accountTokenUsage, setAccountTokenUsage] = useState<AccountTokenUsageData>({
    summary: null,
    lifetime: null,
    events: [],
    loading: false,
    error: null,
  });
  // Monotonic request generation: each loadAccountOverview() bumps it; a response only
  // commits if it is still the latest, so a slow request for account A that lands after
  // a switch to B can never overwrite B's card (in-flight race, Codex blocker).
  const accountOverviewReqRef = useRef(0);
  const accountTokenUsageReqRef = useRef(0);
  // Tracks the previously-seen ClawHunt account so we reset an account-scoped relay
  // composite ONLY on a real switch (A->B), never on the initial mount where a restored
  // chat's saved ``<tier>::<model>`` must survive (Codex re-review #3).
  const prevClawHuntAccountKeyRef = useRef<string | null>(null);
	  const [agentSetupDismissed, setAgentSetupDismissed] = useState(
	    () => localStorage.getItem(AGENT_ONBOARDING_DISMISSED_STORAGE_KEY) === '1',
	  );
	  const agentOnboardingPromptedRef = useRef(false);
	  const [blockingModal, setBlockingModal] = useState<BlockingModalState>(null);
  const [pluginQuery, setPluginQuery] = useState('');
  const [pluginCatalogFilter, setPluginCatalogFilter] = useState<'all' | 'installed' | 'available'>('all');
  // Marketplace view tab. "skills" renders the native skill-store inventory from
  // /v1/skills; plugin-origin skills stay hidden from the plugin install channel.
  const [pluginStoreTab, setPluginStoreTab] = useState<'all' | 'plugins' | 'skills' | 'companies'>('plugins');
  // Capability detail sub-page (Codex-style). null => the list/grid is shown;
  // a target => its detail page replaces the grid within the plugins surface.
  const [workshopDetail, setWorkshopDetail] = useState<WorkshopDetailTarget | null>(null);
  // Detail-page "more actions" (configure / uninstall) kebab menu.
  const [workshopDetailMenuOpen, setWorkshopDetailMenuOpen] = useState(false);
  const workshopDetailMenuRef = useRef<HTMLButtonElement | null>(null);
  // List-card "more actions" (configure / uninstall) kebab. One shared Popover
  // anchored to whichever card's kebab was clicked (ref set on click). Only
  // installed plugins on an authoring-allowed surface get a kebab (Overview =
  // read-only => no kebab), matching the detail page's manage menu.
  const [cardMenuModel, setCardMenuModel] = useState<WorkshopCardModel | null>(null);
  const cardMenuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [skillSyncContract, setSkillSyncContract] = useState<{ targets: { name: string }[] } | null>(null);
  const [skillProjections, setSkillProjections] = useState<{ records: SkillProjectionRecord[] } | null>(null);
  const [skillSyncBusy, setSkillSyncBusy] = useState(false);
  const [nativeSkills, setNativeSkills] = useState<NativeSkillRecord[]>([]);
  const [nativeSkillsLoading, setNativeSkillsLoading] = useState(false);
  const [nativeSkillsError, setNativeSkillsError] = useState<string | null>(null);
  // PR-5: build a local SKILL.md into an equippable governed skill. Pure
  // presentation over POST /v1/skills/build — the kernel derives the grade; the
  // Web renders it verbatim and never upgrades it (no client-side trust logic).
  const [skillBuildPath, setSkillBuildPath] = useState('');
  const [skillBuildBusy, setSkillBuildBusy] = useState(false);
  const [skillBuildError, setSkillBuildError] = useState<string | null>(null);
  const [skillBuildResult, setSkillBuildResult] = useState<{
    plugin_id: string;
    version: string;
    package_digest: string;
    trust_state: string;
    equippable: boolean;
    signed: boolean;
  } | null>(null);
  const [pluginCreatorOpen, setPluginCreatorOpen] = useState(false);
  const [pluginLocalInstallOpen, setPluginLocalInstallOpen] = useState(false);
  const [pluginAdvancedOpen, setPluginAdvancedOpen] = useState(false);
  // Default landing surface stays Direct Chat. "Open straight onto the company list"
  // is deferred until the packaged-desktop Node front door lands (server-refactor
  // follow-up, owned by the coexist front-door work): defaulting to Team before then
  // would open the desktop app onto an unreachable /paperclip-api board. Clicking "Team"
  // reaches the full-page company directory; the topbar back-hierarchy handles in-board nav.
  // 纯画布 shell (owner direction 2026-07-16): the product IS one clean canvas — open the app
  // directly onto the Fleet Canvas (agent-companies infinite canvas), not the chat workbench.
  // The canvas is a self-contained surface; other surfaces (chat/settings/plugins) remain
  // reachable but are no longer the landing. Full chrome-collapse is layered in incrementally.
  // The landing surface is config-driven (localStorage 'superclaw_landing_surface') so the
  // product defaults to the canvas while tests/desktop can pin a different landing.
  const [workspaceSurface, setWorkspaceSurface] = useState<'chat' | 'control' | 'plugins' | 'team' | 'canvas'>(() => {
    try {
      const pinned = localStorage.getItem('superclaw_landing_surface');
      if (
        pinned === 'chat' ||
        pinned === 'canvas' ||
        pinned === 'team' ||
        pinned === 'plugins' ||
        pinned === 'control'
      ) {
        return pinned;
      }
      // fleet-canvas / creative-canvas / studio were all retired by the session-canvas rebuild.
      // A stale pin from any of them lands on the canvas, never falls through to chat.
      if (pinned === 'fleet-canvas' || pinned === 'creative-canvas' || pinned === 'studio') {
        return 'canvas';
      }
    } catch {
      /* localStorage unavailable (SSR/sandbox) — fall through to the canvas default */
    }
    // The product IS the canvas: every node is an agent session. Land here by default.
    return 'canvas';
  });
  // Embedded company board's nav level (directory home vs inside a company), so the
  // team-page topbar can render the back hierarchy (main menu → company list → company).
  const boardNav = useBoardNavState();
  const nodeCanvasMode = !desktopMode && workspaceSurface === 'canvas';
  const [activeSettingsTarget, setActiveSettingsTarget] = useState('settings-general');
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  // Reference viewer: which file (in which run's checkout) the file sub-view shows.
  // 对话侧边栏：浏览器式多 tab 模型（取代旧的单槽 viewerTarget + 固定面板 activePanelId）。
  // tabs 与 activeId 合并为单一原子 state：所有变更走纯函数式 updater，一次更新里
  // 同时算出新 tabs 与新 activeId —— 杜绝 ref 快照竞态、updater 内套 setState、
  // 以及 active 指向已删 tab 的「幽灵 active id」。会话内临时态，不落 localStorage。
  const [panelState, setPanelState] = useState<{ tabs: ConversationTab[]; activeId: string | null }>(
    () => ({ tabs: [], activeId: null }),
  );
  // 派生只读别名：所有读取点（渲染 / 懒加载 effect / 宿主 props）共用同一份「校正后」
  // 的激活 tab，activeId 永远落在真实存在的 tab 上（兜底首个），消除视觉与逻辑分裂。
  const conversationTabs = panelState.tabs;
  const resolvedActiveTab =
    conversationTabs.find((tab) => tab.id === panelState.activeId) ?? conversationTabs[0] ?? null;
  const activeTabId = resolvedActiveTab?.id ?? null;
  const tabSeqRef = useRef(0);
  const nextTabId = useCallback(
    () => `tab-${Date.now().toString(36)}-${(tabSeqRef.current += 1).toString(36)}`,
    [],
  );
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [sidebarContextMenu, setSidebarContextMenu] = useState<SidebarContextMenuState | null>(null);
  const [workspaceContextMenu, setWorkspaceContextMenu] = useState<WorkspaceContextMenuState | null>(null);
  // Pin / archive a chat in flight: dim that row's actions so a double-click
  // can't fire two mutations. Keyed by the React item key (`${kind}-${id}`).
  const [sidebarItemBusy, setSidebarItemBusy] = useState<Record<string, boolean>>({});
  // Workspace rename dialog (null = closed); remove-confirm dialog (null = closed).
  const [workspaceRename, setWorkspaceRename] = useState<{ workspaceId: string; name: string } | null>(null);
  const [workspaceRenameBusy, setWorkspaceRenameBusy] = useState(false);
  const [workspaceRemove, setWorkspaceRemove] = useState<WorkspaceContextMenuState | null>(null);
  const [workspaceRemoveBusy, setWorkspaceRemoveBusy] = useState(false);
  const accountMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const sidebarContextMenuRef = useRef<HTMLDivElement | null>(null);
  const workspaceContextMenuRef = useRef<HTMLDivElement | null>(null);
  const imageContextMenuRef = useRef<HTMLDivElement | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    computeInitialSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)),
  );
  const [sidebarWidth, setSidebarWidth] = useState(readInitialSidebarWidth);
  const [contextPanelWidth, setContextPanelWidth] = useState(readInitialContextPanelWidth);
  // Live viewport width — drives the context panel's viewport-aware ceiling so a
  // stored (or just-dragged) width can never render wider than the window can hold.
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? CONTEXT_PANEL_MAX_WIDTH * 3 : window.innerWidth,
  );
  const [locale, setLocale] = useState<Locale>(() => readInitialLocale());
  useEffect(() => { document.documentElement.lang = localeHtmlLang(locale); }, [locale]);
  const [tourOpen, setTourOpen] = useState(false);
  const tourPromptedRef = useRef(false);
  const [themePreference, setThemePreference] = useState<AppThemePreference>(() => readInitialThemePreference());
  const [previewConfirmEnabled, setPreviewConfirmEnabled] = useState<boolean>(() => readInitialPreviewConfirm());
  const [previewProxyEnabled, setPreviewProxyEnabled] = useState<boolean>(() => readInitialPreviewProxy());
  const [activeTheme, setActiveTheme] = useState<AppTheme>(() => resolveThemePreference(readInitialThemePreference()));
  const [appearance, setAppearance] = useState<AppearancePayload | null>(null);
  const appearanceQueue = useRef(createSerialQueue());
  const [desktopAlertsEnabled, setDesktopAlertsEnabled] = useState(() => localStorage.getItem('superclaw_desktop_alerts') === '1');
  const [desktopAlertPermission, setDesktopAlertPermission] = useState(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const [desktopAlertHistory, setDesktopAlertHistory] = useState<DesktopAlertEntry[]>([]);
  const [desktopIncidentExport, setDesktopIncidentExport] = useState<DesktopIncidentExport | null>(null);
  const chatScrollRegionRef = useRef<HTMLDivElement | null>(null);
  const composerTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);
  const chatQueueRef = useRef<ChatQueueItem[]>([]);
  const activeBackendChatSessionIdRef = useRef('');
  const activeLocalChatSessionIdRef = useRef('');
  // session_id → the workspace it was CREATED in (recorded on chat.started).
  // Lets a brand-new project chat's immediate follow-up resolve its project
  // before the optimistic record gains the kernel's workspace_id — WITHOUT ever
  // consulting the (possibly already-changed) live pin, so a turn bearing a
  // session id can never be dragged into the wrong project.
  const chatSessionWorkspaceRef = useRef<Map<string, string>>(new Map());
  const chatQueueIdRef = useRef(0);
  const contextRailRef = useRef<HTMLElement | null>(null);
  const clawHuntAgentKeyAutoProvisionRef = useRef(false);
  const previousRunSnapshotRef = useRef<{ runId: string; status: string } | null>(null);
  const macosWindowDragGestureRef = useRef<MacosWindowDragGesture>({
    activePointerId: null,
    dragStarted: false,
    lastClickAt: 0,
    lastClickX: 0,
    lastClickY: 0,
    startX: 0,
    startY: 0,
  });

  useEffect(() => {
    activeBackendChatSessionIdRef.current = activeBackendChatSessionId;
  }, [activeBackendChatSessionId]);

  useEffect(() => {
    activeLocalChatSessionIdRef.current = activeLocalChatSessionId;
  }, [activeLocalChatSessionId]);

  // Refresh the set of sessions that have a scheduled automation (sidebar badge). Fail-soft:
  // a transient gateway failure keeps the last set. Called on session-list change AND after
  // the automation panel mutates (create/approve/delete) so the badge never goes stale.
  const refreshAutomationSessionIds = useCallback(() => {
    void listAutomationSessionIds().then((ids) => {
      if (ids) setAutomationSessionIds(ids);
    });
  }, []);
  useEffect(() => {
    refreshAutomationSessionIds();
  }, [backendChatSessions, refreshAutomationSessionIds]);

  // The main site returns its JWT in the URL fragment so it is never sent to the
  // Python front door or Cloud Run access logs. Capture it once, scrub the address
  // bar immediately, and verify it through the same-origin gateway before showing
  // any identity. A failed/expired token is removed locally; the canvas remains
  // usable anonymously.
  useEffect(() => {
    let cancelled = false;
    const callback = captureClawHuntSsoCallback(window.location.href, localStorage);
    if (callback.cleanedUrl) {
      window.history.replaceState(window.history.state, '', callback.cleanedUrl);
    }
    if (callback.token) {
      storeClawHuntSsoToken(localStorage, callback.token);
    }
    if (callback.error) {
      setMessage(`clawhunt sign-in did not complete: ${callback.error}`);
    }
    if (!callback.token) return () => {
      cancelled = true;
    };
    const verifyingToken = callback.token;
    void verifyClawHuntSsoToken(verifyingToken)
      .then((identity) => {
        // Bail if unmounted OR if the token was cleared meanwhile (e.g. the operator logged out
        // during this in-flight verify) — otherwise a late resolve would resurrect the just-cleared
        // identity and print "signed in as X" over a logged-out session.
        if (cancelled || readClawHuntSsoToken(localStorage) !== verifyingToken) return;
        setClawHuntSsoIdentity(identity);
        setMessage(`signed in to ClawHunt as ${identity.username}`);
      })
      .catch((error) => {
        if (cancelled) return;
        if (errorStatus(error) === 401) clearClawHuntSsoToken(localStorage);
        setClawHuntSsoIdentity(null);
        setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);


  const selectedInfo = useMemo(
    () => backends.find((backend) => backend.name === selectedBackend),
    [backends, selectedBackend],
  );
  const clawHuntDisplayUser =
    clawHuntSsoIdentity ?? authStatus?.clawhunt.account_user ?? null;
  const clawHuntAccountName = clawHuntAccountUserLabel(
    clawHuntDisplayUser as Record<string, unknown> | null,
  );
  // Stable identity (id/email, not display label) for account-scoped reload + isolation.
  const clawHuntAccountKey = clawHuntAccountStableKey(authStatus?.clawhunt.account_user);
  const clawHuntAccountAvatar = clawHuntAccountAvatarUrl(
    clawHuntDisplayUser as Record<string, unknown> | null,
  );
  const clawHuntAgentProfileName = clawHuntProfile?.body?.handle ? String(clawHuntProfile.body.handle) : '';
  const clawHuntOperatorName =
    clawHuntSsoIdentity || authStatus?.clawhunt.account === 'set'
      ? clawHuntAccountName
      : clawHuntAgentProfileName || 'local-user';
  const clawHuntRuntimeAccountSignedIn = authStatus?.clawhunt.account === 'set';
  const clawHuntAccountSignedIn = Boolean(clawHuntSsoIdentity) || clawHuntRuntimeAccountSignedIn;
  const clawHuntExecutionLinked =
    clawHuntRuntimeAccountSignedIn || authStatus?.clawhunt.agent_api_key === 'set';
  const clawHuntOperatorLinked = clawHuntAccountSignedIn || authStatus?.clawhunt.agent_api_key === 'set';
  const clawHuntAgentKeySource = authStatus?.clawhunt.agent_key_source ? ` (${authStatus.clawhunt.agent_key_source})` : '';
	  const editableConfigEntries = useMemo(
	    () => (runtimeConfig?.entries ?? []).filter((entry) => entry.persist_allowed && !entry.secret),
	    [runtimeConfig],
	  );
	  const backendDefaultEntry = useMemo(
	    () => editableConfigEntries.find((entry) => entry.name === 'backend'),
	    [editableConfigEntries],
	  );
	  const backendDefaultKnown = Boolean(backendDefaultEntry);
	  const backendDefaultPersisted = Boolean(backendDefaultEntry?.persisted || backendDefaultEntry?.configured);
	  const agentInventory = useMemo<AgentInventoryInfo[]>(() => {
	    const source = agentControl?.agents?.length ? agentControl.agents : (backends as AgentInventoryInfo[]);
	    return source.map(enrichAgentInventory);
	  }, [agentControl, backends]);
	  const selectedAgentInfo = useMemo(() => {
	    const exact = agentInventory.find((agent) => agent.name === selectedBackend);
	    if (exact) return exact;
	    // A restored/legacy backend id (e.g. "codex" from the Python CLI) is not an
	    // exact inventory name; resolve it to the canonical entry so its contract —
	    // and thus the model + effort selectors — still renders (bug: selectors
	    // vanished after switching to such a chat because this returned null).
	    const canonical = canonicalComposerBackend(
	      selectedBackend,
	      agentInventory.map((agent) => agent.name),
	    );
	    return canonical ? agentInventory.find((agent) => agent.name === canonical) ?? null : null;
	  }, [agentInventory, selectedBackend]);
	  // Snap a restored/legacy backend id to the canonical inventory name once the
	  // inventory is known, so the value SUBMITTED (and the runtime pill) is a real
	  // current runtime, not a stale alias the run path would reject. Only fires when
	  // the current value is unresolvable-but-aliasable — never fights a valid live
	  // selection (an exact inventory name early-returns).
	  useEffect(() => {
	    if (!agentInventory.length || !selectedBackend) return;
	    if (agentInventory.some((agent) => agent.name === selectedBackend)) return;
	    const canonical = canonicalComposerBackend(
	      selectedBackend,
	      agentInventory.map((agent) => agent.name),
	    );
	    if (canonical && canonical !== selectedBackend) setSelectedBackend(canonical);
	  }, [agentInventory, selectedBackend]);
	  // The concrete model that a BLANK per-chat selection actually runs. Shown as
	  // the model field's PLACEHOLDER (never the input value) so the user can see
	  // which model an empty field will use, without the field claiming an explicit
	  // selection. Priority mirrors the kernel resolve order: the configured env
	  // value (model_state) first, then the backend's baked default (default_model).
	  // Sentinels ('unset'/'configured-default') are not concrete ids and fall
	  // through to a neutral hint. Display-only: selectedModel (and the '' =
	  // REQUEST_CLEAR send semantics) is untouched, so the input stays clearable
	  // and what-you-see-is-what-you-send holds.
	  const composerEffectiveModel = useMemo(() => {
	    if (!selectedAgentInfo?.supports_model_selection) return '';
	    const state = selectedAgentInfo?.model_state;
	    if (state && state !== 'unset' && state !== 'configured-default') return state;
	    const baked = selectedAgentInfo?.default_model;
	    if (baked && baked !== 'configured-default') return baked;
	    return '';
	  }, [
	    selectedAgentInfo?.supports_model_selection,
	    selectedAgentInfo?.model_state,
	    selectedAgentInfo?.default_model,
	  ]);
	  const selectedAgentConfigName = selectedAgentInfo?.config_env ?? AGENT_EXECUTABLE_CONFIG_BY_BACKEND[selectedBackend] ?? '';
	  const selectedAgentConfigEntry = useMemo(
	    () => editableConfigEntries.find((entry) => entry.name === selectedAgentConfigName) ?? null,
	    [editableConfigEntries, selectedAgentConfigName],
	  );
	  const selectedAgentExecutableConfigName = selectedAgentConfigEntry?.name ?? '';
	  const selectedAgentAvailable = selectedAgentInfo?.available ?? selectedInfo?.available ?? false;
	  const backendDefaultNeedsChoice = backendDefaultKnown && !backendDefaultPersisted;
	  const agentSetupRequired = backendDefaultNeedsChoice || (Boolean(agentInventory.length) && !selectedAgentAvailable);
	  const runtimeOnboardingAgents = useMemo(
	    () => agentInventory.filter(isComposerRuntimeAgent),
	    [agentInventory],
	  );
	  useEffect(() => {
	    if (!runtimeConfigLoaded || !agentInventory.length) return;
	    if (
      selectedBackend &&
      (agentInventory.some((agent) => agent.name === selectedBackend) ||
        // A canonicalizable legacy alias (restored "codex" → "codex_local") is a
        // valid selection; the reconcile effect above snaps it. Treat it as resolved
        // so this default-picker never races that snap and clobbers the chat's
        // persisted runtime with the configured default.
        canonicalComposerBackend(selectedBackend, agentInventory.map((agent) => agent.name)) !== '')
    )
      return;
	    if (backendDefaultKnown && !backendDefaultPersisted) return;
	    const preferred = preferredComposerRuntimeAgent(
	      agentInventory,
	      backendDefaultPersisted ? runtimeConfig?.defaults?.backend ?? '' : '',
	    );
	    if (preferred) setSelectedBackend(preferred);
	  }, [
	    agentInventory,
	    backendDefaultKnown,
	    backendDefaultPersisted,
	    runtimeConfig?.defaults?.backend,
	    runtimeConfigLoaded,
	    selectedBackend,
	  ]);
	  const runtimeSetupDialogOpen = agentSetupOpen || blockingModal?.kind === 'runtime-config';
	  useEffect(() => {
	    // The agent grid must show LIVE availability: /api/agents re-probes every
	    // executable per request, so refresh on open instead of trusting the
	    // snapshot loaded at startup (e.g. the user just reinstalled a CLI).
	    if (runtimeSetupDialogOpen) void loadAgentControl();
	    // eslint-disable-next-line react-hooks/exhaustive-deps
	  }, [runtimeSetupDialogOpen]);

	  useEffect(() => {
	    if (!desktopMode || agentSetupDismissed || agentOnboardingPromptedRef.current || runtimeSetupDialogOpen) return;
	    if (!runtimeConfigLoaded || !backendDefaultKnown) return;
	    if (!agentSetupRequired || agentControl === null) return;
	    agentOnboardingPromptedRef.current = true;
	    setAgentSetupOpen(true);
	  }, [
	    agentControl,
	    agentSetupDismissed,
	    agentSetupRequired,
	    backendDefaultKnown,
	    desktopMode,
	    runtimeConfigLoaded,
	    runtimeSetupDialogOpen,
	  ]);

	  async function recheckAgents() {
	    setAgentRecheckBusy(true);
	    try {
	      await loadAgentControl();
	    } finally {
	      setAgentRecheckBusy(false);
	    }
	  }

	  async function loadModelCatalog(backendName: string) {
	    // Always re-fetch on focus: the KERNEL owns the TTL cache (60s live /
	    // 10s failed), so this stays cheap while never pinning a stale catalog
	    // for the whole app session (Codex review).
	    if (!backendName) return;
	    try {
	      const data = (await readJson(`/api/agents/${encodeURIComponent(backendName)}/models`)) as {
	        models?: string[];
	        source?: string;
	      };
	      setModelCatalogs((current) => ({
	        ...current,
	        [backendName]: { models: data.models ?? [], source: data.source ?? 'static' },
	      }));
	    } catch {
	      // fail-soft: the static suggested_models from the contract still render
	    }
	  }
	  async function loadRelayPackages() {
    // Relay-backed runtimes show the relay's super-group packages (套餐), not raw
    // models. Pass-through of the kernel relay_packages() (catalog → groups →
    // defaults, all fail-safe), so CLI / API / Web stay zero-divergence.
    try {
      const data = (await readJson('/api/relay/packages')) as {
        packages?: { id: string; name: string; tier: string; group_slug: string; locked?: boolean }[];
        source?: string;
        available?: boolean;
      };
      setRelayPackages({
        packages: data.packages ?? [],
        source: data.source ?? 'default',
        available: Boolean(data.available),
      });
    } catch {
      // fail-soft: a failure reaching OUR api (the endpoint itself is kernel
      // fail-safe) must still show the package floor, never an empty selector.
      // Mirrors the kernel default_relay_packages() tier floor; available=false
      // so the UI flags the degraded/login state.
      setRelayPackages({
        packages: [
          { id: 'core', name: 'core', tier: 'core', group_slug: 'superclaw-core' },
          { id: 'plus', name: 'plus', tier: 'plus', group_slug: 'superclaw-plus' },
          { id: 'max', name: 'max', tier: 'max', group_slug: 'superclaw-max' },
        ],
        source: 'default',
        available: false,
      });
    }
  }
  // Fetch (once, then cache) the concrete models inside a relay package tier — the
  // level-2 menu for clawwork. Pass-through of kernel relay_package_models() via
  // GET /api/relay/packages/{tier}/models. Returns the model list (always an array;
  // [] on any failure, fail-soft so the level-2 menu degrades to "tier default" and
  // the level-1 tier still routes via the relay default). Caches [] too, so a failed
  // tier is not re-fetched on every render.
  async function loadRelayPackageModels(tier: string): Promise<string[]> {
    const norm = (tier || '').trim().toLowerCase();
    if (!norm) return [];
    const cached = relayPackageModels[norm];
    if (cached !== undefined) return cached;
    setRelayPackageModelsLoading(norm);
    try {
      const data = (await readJson(`/api/relay/packages/${encodeURIComponent(norm)}/models`)) as {
        ok?: boolean;
        models?: string[];
      };
      const models =
        data.ok && Array.isArray(data.models)
          ? data.models.filter((m): m is string => typeof m === 'string' && m.length > 0)
          : [];
      setRelayPackageModels((prev) => ({ ...prev, [norm]: models }));
      return models;
    } catch {
      // fail-soft: cache empty so we degrade to "tier default" without re-fetching.
      setRelayPackageModels((prev) => ({ ...prev, [norm]: [] }));
      return [];
    } finally {
      setRelayPackageModelsLoading((cur) => (cur === norm ? null : cur));
    }
  }
  // Level-1 (package tier) selection for clawwork. Sets the tier as the submit value,
  // then lazily loads that tier's models; a single-model tier auto-selects its one
  // model (业主: no extra fanfare for the single-model case) so the composite carries
  // the concrete model without a redundant level-2 click.
  async function handleSelectPackageTier(tier: string): Promise<void> {
    const norm = (tier || '').trim();
    if (!norm) {
      // empty = relay default; clear any composite model selection.
      setSelectedModel('');
      return;
    }
    setSelectedModel(norm);
    const models = await loadRelayPackageModels(norm);
    if (models.length === 1) {
      // Only auto-bind if the user hasn't since moved off this tier.
      setSelectedModel((cur) => (cur.split('::', 1)[0] === norm ? `${norm}::${models[0]}` : cur));
    }
  }
  async function loadAccountOverview() {
    // Pass-through of the kernel account_overview() (GET /api/relay/account): purchased
    // package, effective entitlement (+source), and self-funded relay usage — kept as
    // distinct sources. Single source with the CLI `superclaw relay account`, so CLI /
    // API / Web stay zero-divergence. The endpoint never throws for not-logged-in /
    // unreachable sub-queries (best-effort); the catch only covers a failure reaching
    // OUR api, surfaced as ok=false.
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    // Capture this request's generation; only commit if still latest when it returns.
    const gen = ++accountOverviewReqRef.current;
    try {
      const data = (await readJson('/api/relay/account')) as {
        ok?: boolean;
        logged_in?: boolean;
        billing_plan?: string | null;
        entitlement?: string | null;
        entitlement_source?: string | null;
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
      };
      if (gen !== accountOverviewReqRef.current) return; // a newer load started → drop stale
      const relay = data.relay ?? null;
      setAccountOverview({
        ok: Boolean(data.ok),
        logged_in: Boolean(data.logged_in),
        billing_plan: typeof data.billing_plan === 'string' ? data.billing_plan : null,
        entitlement: typeof data.entitlement === 'string' ? data.entitlement : null,
        entitlement_source:
          typeof data.entitlement_source === 'string' ? data.entitlement_source : null,
        unlimited: Boolean(data.unlimited),
        // Preserve null (omitted) vs a real number — never coerce missing to 0.
        free_chats_remaining: num(data.free_chats_remaining),
        free_chat_limit: num(data.free_chat_limit),
        chat_credits: num(data.chat_credits),
        relay: relay
          ? {
              ok: Boolean(relay.ok),
              account_balance: num(relay.account_balance),
              key_credits_used: num(relay.key_credits_used),
              key_quota_limit: num(relay.key_quota_limit),
              currency: relay.currency ?? 'USD',
            }
          : null,
      });
    } catch (error) {
      if (gen !== accountOverviewReqRef.current) return; // stale failure → drop
      setAccountOverview({
        ok: false,
        code: 'RELAY_ACCOUNT_SURFACE_UNREACHABLE',
        error: String(error),
        relay: null,
      });
    }
  }
  async function loadAccountTokenUsage(mode: AccountTokenUsageMode = accountTokenUsageMode) {
    // Global SuperClaw cost ledger: no company/chat/run filter, so the Account page
    // shows the user's aggregate tokens across every chat, run, and company task.
    const gen = ++accountTokenUsageReqRef.current;
    setAccountTokenUsage((current) => ({ ...current, loading: true, error: null }));
    try {
      const query = accountTokenUsageQuery(mode);
      const [summary, lifetime, events] = await Promise.all([
        readJson(`/api/cost/summary${query}`),
        readJson('/api/cost/summary'),
        readJson(`/api/cost/events${query}`),
      ]);
      if (gen !== accountTokenUsageReqRef.current) return;
      setAccountTokenUsage({
        summary: normalizeAccountCostSummary(summary as Partial<AccountCostSummary>),
        lifetime: normalizeAccountCostSummary(lifetime as Partial<AccountCostSummary>),
        events: normalizeAccountCostEvents(events),
        loading: false,
        error: null,
      });
    } catch (error) {
      if (gen !== accountTokenUsageReqRef.current) return;
      setAccountTokenUsage((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  const filteredRegistryPlugins = useMemo(() => {
    // Skill-origin registry entries are never installable via the plugin flow
    // (capability-workshop red line) — exclude at the source so no operator panel can
    // surface an "Install" for a skill (defense-in-depth with the installRegistryPlugin
    // guard above).
    const base = registryPlugins.filter(isPluginInstallable);
    const needle = pluginQuery.trim().toLowerCase();
    if (!needle) return base;
    return base.filter((plugin) =>
      [plugin.plugin_id, plugin.name, plugin.summary, plugin.category, plugin.runtime, plugin.pricing_model]
        .filter(Boolean)
        .some((value) => (value ?? '').toLowerCase().includes(needle)),
    );
  }, [pluginQuery, registryPlugins]);
  // Node S4 installs indexed by the kind-aware catalog identity (`kind:native_key@version`, same
  // shape as catalogIdentityKey) — used to overlay installed-state + enrich origin/configurable
  // onto the matching workshop cards. Kept SEPARATE from installedPluginKeys so the legacy
  // registry/readiness panels (which read installedPluginKeys for cache-config affordances) never
  // treat a Node-landed capability as a cache-configurable plugin.
  const nodeInstalledByIdentity = useMemo(
    () =>
      new Map(
        nodeInstalledCaps.map((cap) => {
          const kind = cap.kind === 'skill' || cap.kind === 'company' ? cap.kind : 'plugin';
          return [`${kind}:${cap.native_key}@${cap.version ?? ''}`, cap];
        }),
      ),
    [nodeInstalledCaps],
  );
  // Cache-only installed set (unchanged): the legacy registry/readiness UIs key cache-config off
  // this — Node installs must NOT leak in here (they have no cache config surface).
  const installedPluginKeys = useMemo(
    () => new Set((pluginStatus?.plugins ?? []).map((plugin) => `${plugin.id}@${plugin.version}`)),
    [pluginStatus],
  );
  const installedPluginVersionsById = useMemo(() => {
    const index = new Map<string, string[]>();
    for (const plugin of pluginStatus?.plugins ?? []) {
      const versions = index.get(plugin.id) ?? [];
      versions.push(plugin.version);
      index.set(plugin.id, versions);
    }
    return index;
  }, [pluginStatus]);
  const selectedInstalledPlugin = useMemo(() => {
    const parsed = parsePluginKey(selectedPluginKey);
    if (!parsed) return null;
    return (
      (pluginStatus?.plugins ?? []).find(
        (plugin) => plugin.id === parsed.pluginId && plugin.version === parsed.version,
      ) ?? null
    );
  }, [pluginStatus, selectedPluginKey]);
  const selectedRegistryPlugin = useMemo(
    () => filteredRegistryPlugins.find((plugin) => pluginKey(plugin.plugin_id, plugin.version) === selectedRegistryPluginKey) ?? filteredRegistryPlugins[0] ?? null,
    [filteredRegistryPlugins, selectedRegistryPluginKey],
  );
  const selectedRegistryInstalledVersions = useMemo(
    () => (selectedRegistryPlugin ? installedPluginVersionsById.get(selectedRegistryPlugin.plugin_id) ?? [] : []),
    [installedPluginVersionsById, selectedRegistryPlugin],
  );
  const selectedRegistryExactInstalled = Boolean(
    selectedRegistryPlugin && installedPluginKeys.has(pluginKey(selectedRegistryPlugin.plugin_id, selectedRegistryPlugin.version)),
  );
  const selectedRegistryInstalledVersion = selectedRegistryInstalledVersions.at(-1) ?? null;
  const selectedRegistryUpdateAvailable = Boolean(
    selectedRegistryPlugin &&
      selectedRegistryInstalledVersions.length &&
      !selectedRegistryExactInstalled &&
      selectedRegistryInstalledVersion,
  );
  const selectedRegistryConfigVersion = selectedRegistryExactInstalled
    ? selectedRegistryPlugin?.version ?? null
    : selectedRegistryInstalledVersion;
  const selectedRegistryStatusLabel = selectedRegistryExactInstalled
    ? 'installed'
    : selectedRegistryUpdateAvailable
      ? 'update available'
      : 'available';
  const selectedRegistryPolicy = useMemo(
    () =>
      (pluginPolicies?.policies ?? []).find(
        (item) =>
          item.plugin_id === selectedRegistryPlugin?.plugin_id &&
          (!item.version || item.version === selectedRegistryPlugin?.version),
      ) ?? null,
    [pluginPolicies, selectedRegistryPlugin],
  );
  const selectedRegistryRevocation = useMemo(
    () =>
      (pluginRevocations?.revoked ?? []).find(
        (item) =>
          item.plugin_id === selectedRegistryPlugin?.plugin_id &&
          (!item.version || item.version === selectedRegistryPlugin?.version),
      ) ?? null,
    [pluginRevocations, selectedRegistryPlugin],
  );
  const selectedRegistryEntitlement = useMemo(() => {
    if (!selectedRegistryPlugin) return null;
    return (
      pluginEntitlements.find(
        (item) =>
          item.plugin_id === selectedRegistryPlugin.plugin_id &&
          (!item.version || item.version === selectedRegistryPlugin.version),
      ) ??
      pluginEntitlements.find((item) => item.plugin_id === selectedRegistryPlugin.plugin_id) ??
      null
    );
  }, [pluginEntitlements, selectedRegistryPlugin]);
  const runtimePolicyViewer = useMemo(() => {
    if (!pluginPolicies) return null;
    const selected = selectedRegistryPolicy ? [selectedRegistryPolicy] : pluginPolicies.policies;
    const scope = selectedRegistryPolicy ? 'selected plugin policy' : 'all published policies';
    const fileName = selectedRegistryPlugin
      ? `${selectedRegistryPlugin.plugin_id.replace(/[^a-z0-9_.-]+/gi, '-')}-runtime-policy.json`
      : 'superclaw-runtime-policies.json';
    const payload = {
      schema_version: '0.1.0',
      generated_at: new Date().toISOString(),
      scope,
      policy_url: pluginStatus?.governance.policy_url ?? '/v1/policies/runtime',
      selected_plugin_id: selectedRegistryPlugin?.plugin_id ?? null,
      selected_plugin_version: selectedRegistryPlugin?.version ?? null,
      policies: selected,
    };
    return {
      scope,
      count: selected.length,
      fileName,
      href: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload, null, 2))}`,
      preview: JSON.stringify(payload, null, 2),
    };
  }, [pluginPolicies, pluginStatus, selectedRegistryPlugin, selectedRegistryPolicy]);
  const revocationViewer = useMemo(() => {
    if (!pluginRevocations) return null;
    const selected = selectedRegistryRevocation ? [selectedRegistryRevocation] : pluginRevocations.revoked;
    const scope = selectedRegistryRevocation ? 'selected plugin revocation' : 'all synced revocations';
    const fileName = selectedRegistryPlugin
      ? `${selectedRegistryPlugin.plugin_id.replace(/[^a-z0-9_.-]+/gi, '-')}-revocations.json`
      : 'superclaw-plugin-revocations.json';
    const payload = {
      schema_version: '0.1.0',
      generated_at: new Date().toISOString(),
      scope,
      revocations_url: pluginStatus?.governance.revocations_url ?? '/v1/plugins/revocations',
      selected_plugin_id: selectedRegistryPlugin?.plugin_id ?? null,
      selected_plugin_version: selectedRegistryPlugin?.version ?? null,
      revoked: selected,
    };
    return {
      scope,
      count: selected.length,
      fileName,
      href: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload, null, 2))}`,
      preview: JSON.stringify(payload, null, 2),
    };
  }, [pluginRevocations, pluginStatus, selectedRegistryPlugin, selectedRegistryRevocation]);
  const configurationManagerViewer = useMemo(() => {
    if (!pluginConfiguration) return null;
    const settings = pluginConfiguration.configuration.settings ?? [];
    const secrets = pluginConfiguration.configuration.secrets ?? [];
    const missingSettings = settings.filter((item) => item.required && !item.configured).map((item) => item.name);
    const missingSecrets = secrets.filter((item) => item.required && !item.configured).map((item) => item.name);
    const payload = {
      schema_version: '0.1.0',
      generated_at: new Date().toISOString(),
      plugin_id: pluginConfiguration.plugin_id,
      version: pluginConfiguration.version,
      runtime_type: String(pluginConfiguration.runtime.type ?? 'unknown'),
      configuration_url: pluginStatus?.configuration.status_url ?? '/api/plugins/{plugin_id}/configuration',
      summary: {
        configured_settings: settings.filter((item) => item.configured).length,
        total_settings: settings.length,
        configured_secrets: secrets.filter((item) => item.configured).length,
        total_secrets: secrets.length,
        missing_settings: missingSettings,
        missing_secrets: missingSecrets,
      },
      settings: settings.map((item) => ({
        name: item.name,
        type: item.type ?? null,
        description: item.description ?? null,
        required: Boolean(item.required),
        configured: item.configured,
        updated_at: item.updated_at ?? null,
      })),
      secrets: secrets.map((item) => ({
        name: item.name,
        env_name: item.env_name,
        description: item.description ?? null,
        required: item.required,
        configured: item.configured,
        version_range: item.version_range ?? null,
        updated_at: item.updated_at ?? null,
      })),
    };
    return {
      fileName: `${pluginConfiguration.plugin_id.replace(/[^a-z0-9_.-]+/gi, '-')}-config-status.json`,
      href: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload, null, 2))}`,
      preview: JSON.stringify(payload, null, 2),
      missingSettings,
      missingSecrets,
    };
  }, [pluginConfiguration, pluginStatus]);
  const selectedRegistryInstallBlockedReason = useMemo(() => {
    if (!selectedRegistryPlugin) return 'Select a capability package first.';
    if (!pluginStatus?.verification.public_key_configured) return 'Configure the plugin trust root before installing registry packages.';
    if (selectedRegistryRevocation) return `Install blocked by revocation: ${selectedRegistryRevocation.reason}.`;
    if (selectedRegistryPlugin.entitlement_required && !selectedRegistryEntitlement) {
      return 'Sync a valid entitlement for this plugin before workshop install.';
    }
    return null;
  }, [pluginStatus, selectedRegistryEntitlement, selectedRegistryPlugin, selectedRegistryRevocation]);
  const marketplaceSummary = useMemo(
    () => {
      const summaryPlugins = catalogLiveLoaded || !marketplaceServerPlugins.length ? registryPlugins : marketplaceServerPlugins;
      return {
        total: summaryPlugins.length,
        verified: summaryPlugins.filter((plugin) => plugin.verified).length,
        entitled: summaryPlugins.filter((plugin) => plugin.entitlement_required).length,
        installed: summaryPlugins.filter((plugin) => installedPluginKeys.has(pluginKey(plugin.plugin_id, plugin.version))).length,
      };
    },
    [catalogLiveLoaded, installedPluginKeys, marketplaceServerPlugins, registryPlugins],
  );
  const registryCatalogItems = useMemo<PluginCatalogItem[]>(
    () =>
      registryPlugins.map((plugin, index) => {
        const category = plugin.kind === 'skill' || plugin.skill_origin ? 'skills' : plugin.category || 'marketplace';
        return {
          kind: plugin.kind ?? (plugin.skill_origin ? 'skill' : 'plugin'),
          plugin_id: plugin.plugin_id,
          version: plugin.version,
          name: { en: plugin.name, zh: plugin.name },
          summary: { en: plugin.summary || `${plugin.plugin_id}@${plugin.version}`, zh: plugin.summary || `${plugin.plugin_id}@${plugin.version}` },
          category,
          category_label: {
            en: category === 'skills' ? 'Skills' : category || 'Workshop',
            zh: category === 'skills' ? '技能' : category || '能力包',
          },
          icon: plugin.kind === 'skill' || plugin.skill_origin ? 'presentation' : index % 3 === 0 ? 'developer' : index % 3 === 1 ? 'runtime' : 'productivity',
          logo_url: pluginLogoUrl(plugin.logo_url),
          runtime: plugin.runtime || (plugin.kind === 'skill' ? 'skill' : 'mcp_sidecar'),
          pricing_model: plugin.pricing_model || plugin.entitlement_state || 'free',
          package_digest: plugin.package_digest,
          artifact_blob_digest: plugin.artifact_blob_digest,
          acceptance_level: plugin.acceptance_level,
          verified: plugin.verified || plugin.trust === 'official' || plugin.trust === 'developer',
          entitlement_required: Boolean(plugin.entitlement_required || plugin.entitlement_state === 'required'),
          featured: index === 0,
          source: 'registry',
          skill_origin: plugin.kind === 'skill' || Boolean(plugin.skill_origin),
          trust: plugin.trust,
          trust_reasons: plugin.trust_reasons,
          signer_class: plugin.signer_class,
          namespace_reserved: plugin.namespace_reserved,
          install_state: plugin.install_state,
          entitlement_state: plugin.entitlement_state,
          status: plugin.status,
          capability_status: plugin.capability_status,
          revoked: plugin.revoked,
          sources: plugin.sources,
          instantiable: plugin.instantiable,
        };
      }),
    [registryPlugins],
  );
  const marketplaceCatalogItems = useMemo<PluginCatalogItem[]>(
    () =>
      selectMarketplaceCatalogItems({
        catalogLiveLoaded,
        marketplaceServerPlugins,
        registryCatalogItems,
        mock: MOCK_PLUGIN_CATALOG,
      }),
    [catalogLiveLoaded, marketplaceServerPlugins, registryCatalogItems],
  );
  const companyCatalogItems = useMemo<PluginCatalogItem[]>(
    () =>
      catalogCompanyItems.map((item) => ({
        kind: 'company',
        plugin_id: item.plugin_id,
        version: item.version,
        name: { en: item.name, zh: item.name },
        summary: { en: item.summary || `${item.plugin_id}@${item.version}`, zh: item.summary || `${item.plugin_id}@${item.version}` },
        category: 'companies',
        category_label: { en: 'Company templates', zh: '公司模板' },
        icon: 'developer',
        logo_url: pluginLogoUrl(item.logo_url),
        runtime: 'company',
        pricing_model: item.entitlement_state || 'template',
        package_digest: item.package_digest,
        artifact_blob_digest: item.artifact_blob_digest,
        acceptance_level: item.acceptance_level,
        verified: item.verified || item.trust === 'official' || item.trust === 'developer',
        featured: false,
        source: 'registry',
        skill_origin: false,
        trust: item.trust,
        trust_reasons: item.trust_reasons,
        signer_class: item.signer_class,
        namespace_reserved: item.namespace_reserved,
        install_state: item.install_state,
        entitlement_state: item.entitlement_state,
        status: item.status,
        capability_status: item.capability_status,
        revoked: item.revoked,
        sources: item.sources,
        instantiable: item.instantiable,
      })),
    [catalogCompanyItems],
  );
  const installedCatalogItems = useMemo<PluginCatalogItem[]>(() => {
    const cacheItems: PluginCatalogItem[] = (pluginStatus?.plugins ?? []).map((plugin) => ({
      plugin_id: plugin.id,
      version: plugin.version,
      name: { en: plugin.name, zh: plugin.name },
      summary: { en: `${plugin.id}@${plugin.version}`, zh: `${plugin.id}@${plugin.version}` },
      category: 'local',
      category_label: { en: 'Local installed', zh: '本地已安装' },
      icon: 'local',
      logo_url: pluginLogoUrl(plugin.logo_url),
      runtime: 'local',
      pricing_model: 'installed',
      verified: true,
      source: 'local',
      skill_origin: Boolean(plugin.skill_origin),
      origin: 'cache',
      configurable: true,
    }));
    // Union the Node S4 store as distinct origin-tagged cards (never merged across origin: a
    // cache plugin/foo@1 and a Node plugin/foo@1 stay two separately-manageable cards — the card
    // key includes origin so they don't collide).
    const nodeItems = nodeInstalledCaps.map(nodeCapToCatalogItem);
    return [...cacheItems, ...nodeItems];
  }, [pluginStatus, nodeInstalledCaps]);
  const pluginCatalogItems = useMemo(
    () => [...marketplaceCatalogItems, ...companyCatalogItems, ...installedCatalogItems],
    [companyCatalogItems, installedCatalogItems, marketplaceCatalogItems],
  );
  const visiblePluginCatalogItems = useMemo(() => {
    const needle = pluginQuery.trim().toLowerCase();
    return pluginCatalogItems.filter((item) => {
      // The Skills tab renders the native /v1/skills store, not plugin-origin records.
      if (pluginStoreTab === 'skills') return false;
      const isCompany = item.kind === 'company';
      // Single-category tabs filter to one kind. The Overview ('all') tab keeps BOTH
      // plugins and companies so each renders in its own section side by side.
      if (pluginStoreTab === 'companies') return isCompany;
      if (pluginStoreTab === 'plugins' && isCompany) return false;
      // A skill (by kind OR skill_origin) is never a plugin-catalog item — it is
      // equipped from the Skills tab, never installed via the plugin flow. Use the
      // single red-line source so a kind:'skill' without skill_origin is also excluded.
      // Companies are exempt (they are templates, not installable plugins).
      if (!isCompany && !isPluginInstallable(item)) return false;
      // Overview is an unfiltered birds-eye view: it ignores the (hidden) install-state
      // filter and the search box — both live only on the Plugins tab — so switching to
      // Overview can NEVER silently drop remote items or companies (which have no
      // installed state) behind a filter the user cannot see or clear here.
      if (pluginStoreTab === 'all') return true;
      // Reuse the SAME installed predicate the card model uses (incl. the Node S4 overlay) so the
      // Installed/Available filter never disagrees with a card's rendered installed state.
      const exactInstalled = pluginCatalogIsInstalled(item);
      if (pluginCatalogFilter === 'installed' && !exactInstalled) return false;
      if (pluginCatalogFilter === 'available' && exactInstalled) return false;
      if (!needle) return true;
      return [
        item.plugin_id,
        item.version,
        item.name.en,
        item.name.zh,
        item.summary.en,
        item.summary.zh,
        item.category,
        item.category_label.en,
        item.category_label.zh,
        item.runtime,
        item.pricing_model,
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [installedPluginKeys, nodeInstalledByIdentity, pluginCatalogFilter, pluginCatalogItems, pluginQuery, pluginStoreTab]);
  // Skills-tab-only read-only view of remote published skills (workshop IA P1).
  // Data already exists in marketplaceCatalogItems; the plugin/company path
  // (visiblePluginCatalogItems above) deliberately stays untouched.
  const remoteSkillCatalogItems = useMemo(
    () =>
      pluginStoreTab === 'skills' || pluginStoreTab === 'all'
        ? selectRemoteSkillCatalogItems({
            marketplaceCatalogItems,
            nativeSkillIds: nativeSkills.map((skill) => skill.id),
            // No query: the catalog search box only renders on the Plugins tab, so
            // feeding pluginQuery here would invisibly filter the Skills tab by a word
            // typed elsewhere (Codex blocker). Skills tab gets its own search in P2.
          })
        : [],
    [pluginStoreTab, marketplaceCatalogItems, nativeSkills],
  );
	  const groupedPluginCatalogItems = useMemo(() => {
    const groups: Array<{ key: string; label: string; items: PluginCatalogItem[] }> = [];
    const seen = new Map<string, { key: string; label: string; items: PluginCatalogItem[] }>();
    const localGroupLabel = locale === 'zh' ? '本地已安装' : 'Local installed';
    const overview = pluginStoreTab === 'all';
    for (const item of visiblePluginCatalogItems) {
      // Overview groups by top-level KIND (Plugins vs Companies) so each capability
      // class renders in its own section; single-category tabs keep the source split.
      const groupKey = overview
        ? item.kind === 'company'
          ? 'companies'
          : 'plugins'
        : item.source === 'local'
          ? 'local'
          : item.category || 'marketplace';
      const groupLabel = overview
        ? item.kind === 'company'
          ? APP_COPY[locale]['Overview section companies']
          : APP_COPY[locale]['Overview section plugins']
        : item.source === 'local'
          ? localGroupLabel
          : item.category_label[locale];
      let group = seen.get(groupKey);
      if (!group) {
        group = { key: groupKey, label: groupLabel, items: [] };
        seen.set(groupKey, group);
        groups.push(group);
      }
      group.items.push(item);
    }
    if (pluginStoreTab === 'plugins' && !seen.has('local') && pluginCatalogFilter !== 'available') {
      groups.push({ key: 'local', label: localGroupLabel, items: [] });
    }
    if (overview) {
      // Overview always renders both class sections in a stable Plugins→Companies
      // order, even when one is empty, so the user sees the full taxonomy.
      return ['plugins', 'companies'].map(
        (key) =>
          seen.get(key) ?? {
            key,
            label:
              key === 'companies'
                ? APP_COPY[locale]['Overview section companies']
                : APP_COPY[locale]['Overview section plugins'],
            items: [],
          },
      );
    }
    return groups;
  }, [locale, pluginCatalogFilter, pluginStoreTab, visiblePluginCatalogItems]);
  const pluginDiagnosticsViewer = useMemo(() => {
    if (!pluginDiagnostics) return null;
    return {
      fileName: 'plugin-runtime-diagnostics.json',
      href: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(pluginDiagnostics, null, 2))}`,
      preview: JSON.stringify(pluginDiagnostics, null, 2),
    };
  }, [pluginDiagnostics]);
  const developerGateSummary = useMemo(() => {
    const gates = developerSubmission?.gates ?? [];
    return {
      total: gates.length,
      passed: gates.filter((gate) => gate.passed).length,
    };
  }, [developerSubmission]);
  const effectiveControlToken = desktopControlToken(desktopSession) ?? controlToken;
  const apiReady = !desktopMode || desktopStatus === 'connected';
	  const copy = SHELL_COPY[locale];
	  const t = (key: AppCopyKey) => APP_COPY[locale][key];

  // Kind/level options + the per-kind "what to upload" guidance come from the kernel
  // contract (build_capability_upload_contract), which is the single source of truth
  // (铁律 3) and overrides everything below whenever it loads. The static shape here is
  // only a minimal offline fallback (kind/level values mirror the kernel, no invented
  // business semantics) so the panel stays usable if the contract fetch transiently
  // fails — it carries no per-kind contents guidance, that comes only from the contract.
  const uploadKinds: CapabilityUploadKind[] = useMemo(
    () =>
      capabilityUploadContract?.kinds ?? [
        { value: 'plugin', label: t('Plugin catalog tab plugins'), id_field: 'plugin_id', id_placeholder: 'dev.namespace.plugin', contents: [] },
        { value: 'skill', label: t('Plugin catalog tab skills'), id_field: 'skill_id', id_placeholder: 'skill.namespace.name', contents: [] },
        { value: 'company', label: t('Plugin catalog tab companies'), id_field: 'company_id', id_placeholder: 'company.namespace.name', contents: [] },
      ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [capabilityUploadContract, locale],
  );
  const uploadLevels: CapabilityUploadLevel[] = useMemo(
    () =>
      capabilityUploadContract?.acceptance_levels ??
      ['L1', 'L2', 'L3'].map((level) => ({ value: level, label: level })),
    [capabilityUploadContract],
  );
  const selectedUploadKind = useMemo(
    () => uploadKinds.find((entry) => entry.value === developerDraft.kind) ?? uploadKinds[0],
    [uploadKinds, developerDraft.kind],
  );
  const uploadCopy = capabilityUploadContract?.copy;

	  // Onboarding tour persistence. The kernel config (web_onboarding), read via
	  // /api/onboarding, is the SINGLE source of truth — there is deliberately no
	  // localStorage mirror (a second store could override the kernel after a CLI
	  // `onboarding --reset`, violating the single-source-of-truth rule). When the
	  // API can't answer we simply don't decide this load (returns null), rather
	  // than guess from a stale local copy.
	  async function loadTourCompleted(): Promise<boolean | null> {
	    try {
	      const data = (await readJson('/api/onboarding')) as { completed?: boolean; version?: number };
	      return data?.completed === true && Number(data?.version ?? 0) >= ONBOARDING_TOUR_VERSION;
	    } catch {
	      // Unknown — let the effect retry on the next ready state instead of
	      // latching a guess.
	      return null;
	    }
	  }

	  function persistTourCompleted(): void {
	    // The kernel config is the only record. If this POST fails the next launch's
	    // GET simply re-shows the tour (fail toward the kernel's authority), so we
	    // never strand a divergent local "completed" flag.
	    void readJson('/api/onboarding/complete', {
	      method: 'POST',
	      body: JSON.stringify({ version: ONBOARDING_TOUR_VERSION }),
	    }).catch(() => {
	      /* offline / unauthorized — kernel stays authoritative; re-shows next load */
	    });
	  }

	  function handleTourClose(_completed: boolean): void {
	    // Finishing and skipping both dismiss the auto-prompt; the user can always
	    // reopen it from the account menu, so we record completion either way and
	    // never nag on the next launch.
	    setTourOpen(false);
	    persistTourCompleted();
	  }

	  function replayOnboardingTour(): void {
	    setTourOpen(true);
	  }

	  // Auto-open the tour once per machine on the first ready workbench, unless
	  // the kernel config says it's already been completed for this version. The
	  // "prompted" latch is set only AFTER a definite answer so React StrictMode's
	  // mount→unmount→remount (and any apiReady flicker mid-flight) can't swallow
	  // the first auto-open: a cancelled run leaves the latch unset to retry.
	  useEffect(() => {
	    if (!apiReady || !runtimeConfigLoaded) return;
	    if (tourPromptedRef.current || tourOpen) return;
	    let cancelled = false;
	    void loadTourCompleted().then((completed) => {
	      if (cancelled || completed === null) return;
	      tourPromptedRef.current = true;
	      if (completed === false) setTourOpen(true);
	    });
	    return () => {
	      cancelled = true;
	    };
	    // loadTourCompleted is a stable closure over readJson; intentionally omitted.
	    // eslint-disable-next-line react-hooks/exhaustive-deps
	  }, [apiReady, runtimeConfigLoaded, tourOpen]);
	  const clawHuntLoginServerText = clawHuntLoginProbe
	    ? `${clawHuntLoginProbe.reachable ? t('reachable') : t('unreachable')} (${clawHuntLoginProbe.status_code || t('no response')})`
	    : t('probing');
	  const selectedAgentReadinessText = runtimeReadiness(selectedAgentInfo, locale).detail;
	  // 聊天 runtime 选择器选项：可用（已配置）的排前面；未配置的置底并打「未配置」角标，
	  // 仍可点击——选中后跳转运行时设置完成配置（见 selectComposerBackendOrConfigure）。
	  const composerRuntimeOptions = useMemo(() => {
	    // Unified chat entry: chat is an agent-runtime session, so the selector lists
	    // interactive runtimes (native/upgradeable) PLUS relay-backed runtimes
	    // (uses_relay_packages, e.g. clawwork) — the latter run a turn via the relay
	    // with a 套餐 selector, matching CLI `chat --backend clawwork` (see
	    // isComposerRuntimeAgent). One-shot exec forms (codex exec) and plain
	    // plumbing (gateway/test worker/http) stay reachable via config/runs but are
	    // not chat substrates.
	    // codex-app-server renders as "Codex" — the CLI/app-server split is an
	    // implementation detail no chat user should choose between. The current
	    // selection always stays listed so a sticky session is never orphaned.
	    const agents = agentInventory.filter(
	      (agent) =>
	        agent.name === selectedBackend ||
	        isComposerRuntimeAgent(agent),
	    );
	    const displayLabel = (agent: AgentInventoryInfo) =>
	      agent.name === 'codex-app-server' ? 'Codex' : agent.label ?? agent.name;
	    const toOption = (agent: AgentInventoryInfo) =>
	      agent.available
	        ? { value: agent.name, label: displayLabel(agent) }
	        : {
	            value: agent.name,
	            label: displayLabel(agent),
	            badge: t('Runtime not configured'),
	            description: t('Runtime not configured hint'),
	          };
	    const options = [
	      ...agents.filter((agent) => agent.available).map(toOption),
	      ...agents.filter((agent) => !agent.available).map(toOption),
	    ];
	    if (!agents.some((agent) => agent.name === selectedBackend)) {
	      options.push({ value: selectedBackend, label: selectedBackend });
	    }
	    return options;
	    // eslint-disable-next-line react-hooks/exhaustive-deps
	  }, [agentInventory, selectedBackend, locale]);

  // Workspace target for a brand-new chat (Codex-style): "Chat (no project)" —
  // the flat default — plus every personal project. Picking a project pins it so
  // the first turn files the session there (workspace_id + repo_path:null, CLI
  // parity with `chat --workspace <id>`); an untrusted project is shown but
  // disabled (a chat there would fail the kernel trust gate).
  const composerWorkspaceOptions = useMemo<DropdownOption[]>(() => {
    const options: DropdownOption[] = [
      { value: '', label: copy.composerWorkspaceChat, icon: <Bot size={14} aria-hidden="true" /> },
    ];
    for (const workspace of workspaces) {
      if (workspace.builtin_chat) continue;
      options.push({
        value: workspace.workspace_id,
        label: workspace.name,
        icon: <FolderInput size={14} aria-hidden="true" />,
        disabled: !workspace.is_trusted,
        badge: workspace.is_trusted ? undefined : copy.workspaceTrustRequired,
      });
    }
    return options;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, locale]);

	  useEffect(() => {
	    // Pre-fetch the REAL selectable list for the selected runtime. Relay-backed
	    // runtimes resolve super-group packages (套餐); everyone else resolves the
	    // kernel model catalog (both 60s TTL server-side, so this stays cheap).
	    if (!selectedBackend) return;
	    if (selectedAgentInfo?.uses_relay_packages) {
	      void loadRelayPackages();
	    } else {
	      void loadModelCatalog(selectedAgentInfo?.name ?? selectedBackend);
	    }
	    // Depend on uses_relay_packages too: the inventory (hence selectedAgentInfo)
	    // can resolve AFTER selectedBackend is set, so without it the effect could
	    // fetch the wrong list (raw models) and never switch to packages.
	    // eslint-disable-next-line react-hooks/exhaustive-deps
	  }, [selectedBackend, apiReady, selectedAgentInfo?.uses_relay_packages]);
	  useEffect(() => {
	    // When a relay-package tier is already selected (e.g. a composite "<tier>::<model>"
	    // restored from a chat's saved runtime), lazily backfill that tier's level-2 model
	    // list so the second dropdown can render. On-demand + cached: only the selected tier,
	    // and only once. No-op for non-clawwork runtimes or the bare relay-default ("").
	    if (!selectedAgentInfo?.uses_relay_packages) return;
	    // Normalize to the canonical lowercase tier (the cache is keyed lowercase in
	    // loadRelayPackageModels) so a restored composite with a dirty-cased tier (e.g.
	    // "Plus::…") still resolves its cache entry instead of refetching forever.
	    const tier = selectedModel.split('::', 1)[0].trim().toLowerCase();
	    if (!tier) return;
	    if (relayPackageModels[tier] !== undefined) return;
	    void loadRelayPackageModels(tier);
	    // eslint-disable-next-line react-hooks/exhaustive-deps
	  }, [selectedModel, selectedAgentInfo?.uses_relay_packages, apiReady]);
	  useEffect(() => {
	    // Account overview is per-account: (re)load on login AND whenever the linked
	    // account changes (A->B, both signed-in); clear first so one account's data
	    // never lingers under another's card (deps include the stable clawHuntAccountKey).
	    accountOverviewReqRef.current += 1; // drop any in-flight request (incl. on logout)
	    setAccountOverview(null);
	    // The level-2 model lists are RELAY-KEY scoped (the key is bound per ClawHunt
	    // account); a tier-only cache would otherwise let account A's models drive
	    // account B's composer after a switch/logout (Codex adversarial finding #3).
	    // Drop the per-tier cache on any account change so it re-fetches under the new key.
	    setRelayPackageModels({});
	    setRelayPackageModelsLoading(null);
	    // On a REAL account switch (A signed-in -> B signed-in), strip any account-scoped
	    // concrete model from the selected composite — account A's ``plus::A-model`` must
	    // not keep being SUBMITTED under account B (clearing only the cache hid the level-2
	    // dropdown but left the stale value live; Codex re-review #3). Drop to the bare tier
	    // (the user's level-1 choice is account-agnostic); the backfill effect re-fetches
	    // B's models so level-2 reappears.
	    //
	    // The ref only ever records a SIGNED-IN account key (never reset on sign-out), so it
	    // remembers the LAST account whose relay key bound the composite — across an
	    // intervening signed-out state too. That distinguishes the cases exactly:
	    //   - initial mount / slow auth resolving AFTER a chat restored a ``<tier>::<model>``:
	    //     prevKey is null -> NOT a switch -> the restored composite survives.
	    //   - sign back in as the SAME account: prevKey == key -> NOT a switch -> keep.
	    //   - sign in as a DIFFERENT account (direct A->B, or logout-A -> login-B):
	    //     prevKey != key -> strip the account-scoped model to the bare tier so account
	    //     A's ``plus::A-model`` is never submitted under B.
	    if (clawHuntRuntimeAccountSignedIn) {
	      const prevKey = prevClawHuntAccountKeyRef.current;
	      if (prevKey !== null && prevKey !== clawHuntAccountKey) {
	        setSelectedModel((cur) => (cur.includes('::') ? cur.split('::', 1)[0] : cur));
	      }
	      prevClawHuntAccountKeyRef.current = clawHuntAccountKey;
	      void loadAccountOverview();
	    }
	    // eslint-disable-next-line react-hooks/exhaustive-deps
	  }, [clawHuntRuntimeAccountSignedIn, clawHuntAccountKey, apiReady]);
  useEffect(() => {
    if (!apiReady || nodeCanvasMode) return;
    void loadAccountTokenUsage(accountTokenUsageMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiReady, accountTokenUsageMode, nodeCanvasMode]);
  const formatAppCopy = (key: AppCopyKey, values: Record<string, string | number>) =>
    t(key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));

  function switchLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // A restricted webview can still switch language for the current visit.
    }
  }

  function switchThemePreference(nextPreference: AppThemePreference) {
    setThemePreference(nextPreference);
    localStorage.setItem(THEME_STORAGE_KEY, nextPreference);
  }

  // Persist a color-scheme change through the kernel (POST /api/appearance/set), then
  // adopt the authoritative payload it returns. The kernel is the source of truth;
  // the web never persists colors on its own (localStorage is only a FOUC cache).
  // All mutations run through `appearanceQueue` so the request itself (not just its
  // response) is serialized: edit N+1 is only SENT after edit N has fully settled. That
  // makes the kernel observe writes in user-intent order, so the persisted file always
  // ends on the user's last choice, and the adopted responses arrive in that same order.
  function adoptAppearance(makeRequest: () => Promise<AppearancePayload>): Promise<AppearancePayload> {
    return appearanceQueue.current.run(async () => {
      const payload = await makeRequest();
      setAppearance(payload);
      cacheScheme(payload);
      return payload;
    });
  }

  // `custom` is the API REQUEST shape (a partial canvas map the kernel normalizes against
  // its own CANVASES), not the fully-populated `AppearanceCustom` response type — so `{}`
  // (a full reset) and a single-canvas map are both valid without hardcoding light/dark.
  function persistAppearance(body: { active_preset?: string; custom?: Partial<AppearanceCustom> }) {
    return adoptAppearance(
      () => readJson('/api/appearance/set', { method: 'POST', body: JSON.stringify(body) }) as Promise<AppearancePayload>,
    );
  }

  function selectAppearancePreset(presetId: string) {
    void persistAppearance({ active_preset: presetId }).catch(() => undefined);
  }

  // True reset, matching the CLI's `superclaw appearance reset`: back to the stock
  // default preset AND drop the whole custom palette. The kernel's set endpoint
  // replaces `custom` wholesale and normalizes an empty object against ITS OWN canvas
  // list, so we send `{}` rather than hardcoding `{ light, dark }` here — that keeps the
  // canvas vocabulary owned by the kernel (a future canvas is cleared without a web change).
  function resetAppearance() {
    void persistAppearance({
      active_preset: appearance?.default_preset ?? 'default',
      custom: {},
    }).catch(() => undefined);
  }

  // One token at a time through the kernel's atomic merge endpoint — never a whole-map
  // replace built from possibly-stale render state — and serialized via the queue so a
  // burst of edits lands on disk in the exact order the user made them.
  function setAppearanceCustomColor(canvas: AppearanceCanvas, tokenId: string, hex: string) {
    return adoptAppearance(
      () =>
        readJson('/api/appearance/custom-color', {
          method: 'POST',
          body: JSON.stringify({ canvas, token: tokenId, color: hex }),
        }) as Promise<AppearancePayload>,
    );
  }

  async function exportAppearance() {
    const bundle = (await readJson('/api/appearance/export')) as AppearanceExportBundle;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'superclaw-appearance.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function importAppearanceBundle(bundle: unknown) {
    return adoptAppearance(
      () => readJson('/api/appearance/import', { method: 'POST', body: JSON.stringify({ bundle }) }) as Promise<AppearancePayload>,
    );
  }

  function setPreviewConfirm(next: boolean) {
    setPreviewConfirmEnabled(next);
    // Persist '1'/'0' explicitly (rather than removing on default) so the choice
    // survives even when it matches the default — a stored value is the record.
    localStorage.setItem(PREVIEW_CONFIRM_STORAGE_KEY, next ? '1' : '0');
  }

  function setPreviewProxy(next: boolean) {
    setPreviewProxyEnabled(next);
    localStorage.setItem(PREVIEW_PROXY_STORAGE_KEY, next ? '1' : '0');
  }

  useEffect(() => {
    const timer = window.setInterval(() => setSidebarNow(Date.now()), SIDEBAR_RELATIVE_TIME_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Sidebar unread badge: total "actionable" count summed across companies from
  // the Paperclip control plane (GET /companies/{id}/sidebar-badges via the
  // paperclipBridge). The surface only displays the count, never re-derives it.
  //
  // Dual-source (transitional): prefer Paperclip; when it is UNREACHABLE
  // (paperclipUnreadTotal ⇒ null — e.g. the /paperclip-api proxy is absent in the
  // packaged desktop app, or the Node server is down) fall back to the legacy
  // Python /api/team/messages roll-up so the badge never regresses. Both sources
  // are fail-soft: on failure we keep the last known count, never blanking it.
  // De-dupe guard for the expensive per-company sidebar-badge fan-out below. Held
  // while a fan-out is in flight so an overlapping caller — a 30s poll landing on a
  // still-running fan-out, or React StrictMode's dev setup→cleanup→setup double
  // invoke of the ready effect — skips instead of firing a second concurrent fan-out.
  const teamUnreadInFlightRef = useRef(false);
  const refreshTeamUnread = useCallback(
    async (known?: number) => {
      // Fast path: a caller that just computed the count hands it in, so the badge
      // updates without a duplicate GET. Never gated — it does no fan-out.
      if (typeof known === 'number') {
        setTeamUnread(known > 0 ? known : 0);
        return;
      }
      // A fan-out is already running ⇒ skip (its result will set the latest count).
      // StrictMode's cleanup→setup happens within one synchronous commit tick, so the
      // in-flight fetch cannot resolve in between ⇒ the second invoke deterministically
      // skips ⇒ exactly one fan-out on ready (not the dev double-fan-out).
      if (teamUnreadInFlightRef.current) return;
      teamUnreadInFlightRef.current = true;
      try {
        const total = await paperclipUnreadTotal();
        if (typeof total === 'number') {
          setTeamUnread(total > 0 ? total : 0);
          return;
        }
        // Paperclip unreachable ⇒ fall back to the Python roll-up (keep last on error).
        try {
          const data = (await readJson('/api/team/messages')) as { total_unread?: number };
          const fallback = data?.total_unread;
          if (typeof fallback === 'number') setTeamUnread(fallback > 0 ? fallback : 0);
        } catch {
          /* both sources unavailable ⇒ keep the last known count */
        }
      } finally {
        teamUnreadInFlightRef.current = false;
      }
    },
    [readJson],
  );

  // The interval effect below must fire EXACTLY ONCE when the API becomes ready —
  // not every time refreshTeamUnread's identity changes. refreshTeamUnread depends
  // on readJson, whose identity churns several times during the shell's initial
  // render; keying the interval effect on it re-ran the effect ~8×, and each re-run
  // re-fired the per-company sidebar-badge fan-out, flooding the browser's
  // 6-connection HTTP/1.1 limit (~200 requests) and stalling the embedded board's
  // own initial data fetches for seconds. A ref holds the latest refreshTeamUnread
  // so the 30s interval always calls the current one without re-subscribing.
  // Render-time assignment (not a passive effect) so the interval never reads a
  // stale callback after readJson churns. The in-flight guard inside
  // refreshTeamUnread keeps the fan-out exactly-once even under StrictMode.
  const refreshTeamUnreadRef = useRef(refreshTeamUnread);
  refreshTeamUnreadRef.current = refreshTeamUnread;

  useEffect(() => {
    if (!apiReady) return undefined;
    void refreshTeamUnreadRef.current();
    const timer = window.setInterval(() => void refreshTeamUnreadRef.current(), TEAM_UNREAD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [apiReady]);

  useEffect(() => {
    if (!apiReady) return undefined;
    // ON-DEMAND, not a global poll: fetch the company list ONLY while the composer's
    // `@` menu is open. The chat/app-shell surface deliberately does NOT auto-load team
    // data (it is lazy until the company board is opened) — a background poller here
    // would both violate that invariant and add fetch-timing noise. The trigger dep is
    // `=== '@'` (not the query), so this fires once per menu-open, not per keystroke.
    if (composerTrigger?.trigger !== '@') return undefined;
    let cancelled = false;
    const load = async () => {
      // UNION of both company homes (a company's store IS its home; the two sets
      // are DISJOINT by id format — Paperclip-native uuids vs legacy Python
      // `company_*`). The @-menu shows EVERY company regardless of which store
      // created it (board-native via GET /companies, or chat/CLI/legacy via the
      // Python /api/team/companies), so chat and the company board see the
      // same directory. Both fetches are fail-soft and run in parallel: a source
      // that is unreachable contributes nothing; only when BOTH are unreachable
      // do we keep the last-known list (never clear). A genuinely empty result
      // from a reachable source contributes [].
      const pyList = readJson('/api/team/companies')
        .then((data) => {
          const raw =
            (data as { companies?: { company_profile_id?: string; name?: string; status?: string }[] } | null)
              ?.companies ?? [];
          return raw
            .filter((c): c is { company_profile_id: string; name?: string; status?: string } =>
              Boolean(c && typeof c.company_profile_id === 'string' && c.company_profile_id),
            )
            .map((c) => ({
              company_profile_id: c.company_profile_id,
              name: c.name || c.company_profile_id,
              status: c.status,
            })) as ComposerCompany[];
        })
        .catch(() => null as ComposerCompany[] | null);
      const [nodeCompanies, legacyCompanies] = await Promise.all([listPaperclipCompanies(), pyList]);
      if (cancelled) return;
      // Both sources unreachable ⇒ keep the last-known list (fail-soft).
      if (nodeCompanies === null && legacyCompanies === null) return;
      const seen = new Set<string>();
      const union: ComposerCompany[] = [];
      for (const c of [...(nodeCompanies ?? []), ...(legacyCompanies ?? [])]) {
        if (seen.has(c.company_profile_id)) continue;
        seen.add(c.company_profile_id);
        union.push(c);
      }
      setComposerTeamCompanies(union);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [apiReady, composerTrigger?.trigger, readJson]);

  useEffect(() => {
    if (!apiReady) return undefined;
    // ON-DEMAND (same discipline as the company list above): fetch the native skill
    // list ONLY while the `@` menu is open, once per menu-open (dep is `=== '@'`, not
    // the query). The kernel GET /v1/skills is the single source; picking a result
    // inserts a `@skill:<slug>` text token the kernel already parses (no new channel).
    if (composerTrigger?.trigger !== '@') return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const data = (await readJson('/v1/skills')) as {
          skills?: { slug?: string; name?: string; description?: string }[];
        };
        if (cancelled) return;
        const skills = (data?.skills ?? [])
          .filter((s): s is { slug: string; name?: string; description?: string } =>
            Boolean(s && typeof s.slug === 'string' && s.slug),
          )
          .map((s) => ({ slug: s.slug, name: s.name || s.slug, description: s.description || '' }));
        setComposerSkills(skills);
      } catch {
        /* keep the last known list on a transient error — fail-soft, never clear */
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [apiReady, composerTrigger?.trigger, readJson]);

  useEffect(() => {
    // Appearance is a fixed light/dark choice — just apply it. (The "follow system"
    // mode and its matchMedia listener were removed.)
    setActiveTheme(applyDocumentTheme(themePreference));
    // Persist the active preference so the first-run seed from the OS appearance — and
    // the migration of any legacy 'system' value — is written back once. Without this,
    // an unstored/legacy user would re-sample the OS on every reload instead of keeping
    // a concrete light/dark choice.
    try {
      localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    } catch {
      /* storage unavailable (e.g. private mode) — fall back to in-memory only */
    }
  }, [themePreference]);

  useEffect(() => {
    if (!desktopInvoke) return;
    void setDesktopWindowTheme(desktopInvoke, themePreference).catch(() => undefined);
  }, [desktopInvoke, themePreference]);

  // Before the authoritative payload arrives, paint the cached (validated) scheme so
  // there's no flash of the stock colors. Once `appearance` is set, the effect below
  // takes over (and clears any stale cached var that the new scheme doesn't override).
  useEffect(() => {
    if (appearance) return;
    applyCachedScheme(activeTheme as AppearanceCanvas);
  }, [appearance, activeTheme]);

  // Re-project the authoritative color scheme onto the document root whenever it or the
  // resolved canvas (light/dark) changes. The kernel owns the choice; this only renders
  // it (clearing all scheme-owned vars first, so it never depends on prior state).
  useEffect(() => {
    if (!appearance) return;
    applyAppearance(appearance, activeTheme as AppearanceCanvas);
  }, [appearance, activeTheme]);

  // Load the authoritative appearance config when the API is reachable, then cache a
  // resolved snapshot for the next cold start. A failure leaves the cached/stock look.
  // Deps are the AUTH inputs, NOT `readJson`: its identity changes every render, so
  // depending on it would re-fetch on every render (a loop, since each success sets a
  // fresh object). But we DO depend on `controlToken`/`desktopSession` so that when the
  // user supplies/rotates the control token in browser mode (where `apiReady` is true
  // before any token exists), an initial 401 is retried with the new token instead of
  // leaving the Color Scheme panel hidden forever. Mirrors the other authed effects.
  useEffect(() => {
    if (!apiReady || nodeCanvasMode) return;
    let cancelled = false;
    void (async () => {
      try {
        const payload = (await readJson('/api/appearance')) as AppearancePayload;
        if (cancelled || !payload || !Array.isArray(payload.tokens)) return;
        setAppearance(payload);
        cacheScheme(payload);
      } catch {
        // keep the cached/stock scheme; theming must never hard-fail
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readJson identity is per-render; depending on it would loop. controlToken/desktopSession are the auth inputs that gate a retry.
  }, [apiReady, controlToken, desktopSession, nodeCanvasMode]);

  useEffect(() => {
    if (!sidebarContextMenu) return;

    function handleDocumentPointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && sidebarContextMenuRef.current?.contains(target)) return;
      setSidebarContextMenu(null);
    }

    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setSidebarContextMenu(null);
    }

    document.addEventListener('pointerdown', handleDocumentPointerDown);
    document.addEventListener('keydown', handleDocumentKeyDown);
    window.addEventListener('resize', closeSidebarContextMenu);
    window.addEventListener('scroll', closeSidebarContextMenu, true);
    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointerDown);
      document.removeEventListener('keydown', handleDocumentKeyDown);
      window.removeEventListener('resize', closeSidebarContextMenu);
      window.removeEventListener('scroll', closeSidebarContextMenu, true);
    };
  }, [sidebarContextMenu]);

  useEffect(() => {
    if (!workspaceContextMenu) return;
    const close = () => setWorkspaceContextMenu(null);
    function handleDocumentPointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && workspaceContextMenuRef.current?.contains(target)) return;
      close();
    }
    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    document.addEventListener('pointerdown', handleDocumentPointerDown);
    document.addEventListener('keydown', handleDocumentKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointerDown);
      document.removeEventListener('keydown', handleDocumentKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [workspaceContextMenu]);

  useEffect(() => {
    if (!imageContextMenu) return;
    const close = () => setImageContextMenu(null);
    function handleDocumentPointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && imageContextMenuRef.current?.contains(target)) return;
      close();
    }
    function handleDocumentKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    document.addEventListener('pointerdown', handleDocumentPointerDown);
    document.addEventListener('keydown', handleDocumentKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointerDown);
      document.removeEventListener('keydown', handleDocumentKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [imageContextMenu]);

  // Track viewport width so the context panel's rendered width stays clamped to what
  // the window can hold (a width stored on a wide screen must shrink on a narrow one).
  useEffect(() => {
    function handleResize() {
      setViewportWidth(window.innerWidth);
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);


  useEffect(() => {
    if (!imageLightbox) return;

    function handleLightboxKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setImageLightbox(null);
    }

    document.addEventListener('keydown', handleLightboxKeyDown);
    return () => document.removeEventListener('keydown', handleLightboxKeyDown);
  }, [imageLightbox]);

  // Entering the settings surface should not carry over a stale status banner
  // (e.g. a lingering "plugin installed" message); settings-action feedback is
  // set afterward and stays because this only fires on a surface change.
  useEffect(() => {
    if (workspaceSurface === 'control') setMessage('');
  }, [workspaceSurface]);

  // Switching the chat in view resets prompt-history recall: ArrowUp must walk the
  // NEW chat's prompts, never the previous one's indices.
  useEffect(() => {
    composerHistoryIndexRef.current = null;
  }, [activeBackendChatSessionId, activeLocalChatSessionId]);

  // Tear down the hidden caret-measuring mirror when the app unmounts.
  useEffect(() => {
    return () => {
      composerCaretMirrorRef.current?.remove();
      composerCaretMirrorRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (workspaceSurface === 'plugins' && (pluginStoreTab === 'skills' || pluginStoreTab === 'all')) {
      void loadNativeSkills();
      void loadSkillProjections();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSurface, pluginStoreTab]);

  // Close the list-card uninstall menu on ANY navigation — tab switch, surface
  // change, or entering/leaving a detail page — including keyboard / programmatic
  // switches that fire no outside-click. The menu's anchor card unmounts on
  // navigation, so a lingering menu must never survive to uninstall a stale plugin
  // (Codex blocker: setPluginStoreTab / keyboard tab switch left the menu open).
  useEffect(() => {
    setCardMenuModel(null);
  }, [pluginStoreTab, workspaceSurface, workshopDetail]);

  // Keep the transcript pinned to the bottom as turns/streamed content grow —
  // but ONLY while the user is parked there (chatPinnedToBottom). A manual
  // scroll-up suspends it so live output never yanks the view back down. Depends
  // on the whole array (a new identity per stream delta) so it follows streaming
  // growth, not just new turns. ALWAYS an instant jump (never smooth): a smooth
  // animation on a session switch fires intermediate onScroll events that see
  // "not at bottom yet" and would flip pinned=false mid-flight, ghost-flashing the
  // "新内容" pill. Instant lands at the bottom in one frame so onScroll sees ~0.
  useEffect(() => {
    if (directChatTurns.length === 0) return;
    if (!chatPinnedToBottom) return;
    const scrollRegion = chatScrollRegionRef.current;
    if (!scrollRegion) return;
    scrollRegion.scrollTop = scrollRegion.scrollHeight;
  }, [directChatTurns, chatPinnedToBottom]);

  // Re-pin to the bottom whenever the open conversation changes (switch session,
  // New Chat, open from sidebar). Without this, a scroll-up in one chat leaves
  // pinned=false and the NEXT chat opens stuck mid-scroll with a false "新内容"
  // pill. Submitting a new turn re-pins separately (see the submit path).
  useEffect(() => {
    setChatPinnedToBottom(true);
  }, [activeBackendChatSessionId, activeLocalChatSessionId]);

  useEffect(() => {
    resizeComposerTextArea();
  }, [prompt]);

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, next ? '1' : '0');
      return next;
    });
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (sidebarCollapsed) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;

    function handlePointerMove(moveEvent: PointerEvent) {
      const nextWidth = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      setSidebarWidth(nextWidth);
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth));
    }

    function handlePointerUp() {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  }

  // Persist the user's chosen panel width. Stored value is kept in the nominal
  // [MIN, MAX] range; the rendered width may be smaller in cramped viewports (see
  // effectiveContextWidth), and the stored intent restores when the window grows back.
  function commitContextPanelWidth(width: number) {
    const next = clampContextPanelWidth(width);
    setContextPanelWidth(next);
    localStorage.setItem(CONTEXT_PANEL_WIDTH_STORAGE_KEY, String(next));
    return next;
  }

  // Live interaction geometry — reads the actual window width so it is correct even
  // between React renders. `effective` is the CURRENTLY VISIBLE width, which is the
  // origin every gesture/keypress must start from (a drag that started from the hidden
  // preferred width would desync the handle from the panel in cramped viewports).
  function currentContextInteraction() {
    const sidebarFootprint = sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth;
    return contextPanelInteraction(contextPanelWidth, window.innerWidth, sidebarFootprint);
  }

  function startContextPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    // Capture the pointer on the handle so a drag that wanders over a sandboxed web
    // preview iframe still delivers move/up to us (otherwise the iframe swallows them
    // and the drag "sticks"). Capture also guarantees a terminal pointerup/cancel.
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // setPointerCapture can throw if the pointer is already gone; the window
      // listeners below still drive the drag, so this is non-fatal.
    }
    const startX = event.clientX;
    // Start from the VISIBLE width and clamp to what's reachable now, so the handle
    // tracks the cursor 1:1 from the first pixel even when the stored preference is
    // wider than the cramped viewport currently allows.
    const { lowerBound, upperBound, effective: startWidth } = currentContextInteraction();

    function handlePointerMove(moveEvent: PointerEvent) {
      // Handle lives on the panel's left edge: dragging left (negative delta) widens it.
      const raw = Math.round(startWidth - (moveEvent.clientX - startX));
      commitContextPanelWidth(Math.min(upperBound, Math.max(lowerBound, raw)));
    }

    function stopDrag() {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // Already released (e.g. capture was never granted) — nothing to do.
      }
    }

    // pointercancel covers touch interruptions / the element being unmounted mid-drag,
    // so the window listeners never outlive the gesture.
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
  }

  // Keyboard control for the resize separator (WCAG 2.1.1): arrows nudge, Home/End jump.
  // Like the drag, every key steps from the VISIBLE width and clamps to the reachable
  // [lowerBound, upperBound], so the announced value never diverges from the panel.
  function handleContextResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 48 : 16;
    const { lowerBound, upperBound, effective } = currentContextInteraction();
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = effective + step; // left edge: left = wider
    else if (event.key === 'ArrowRight') next = effective - step;
    else if (event.key === 'Home') next = upperBound;
    else if (event.key === 'End') next = lowerBound;
    if (next === null) return;
    event.preventDefault();
    commitContextPanelWidth(Math.min(upperBound, Math.max(lowerBound, next)));
  }

  function resizeComposerTextArea() {
    const textArea = composerTextAreaRef.current;
    if (!textArea) return;
    textArea.style.height = 'auto';
    textArea.style.height = `${Math.min(textArea.scrollHeight, 200)}px`;
  }

  const sidebarSessionItems = useMemo(() => {
    const isUnreadSidebarItem = (readKey: string, updatedAt: number, active: boolean, running: boolean) => {
      if (active || running || !Number.isFinite(updatedAt) || updatedAt <= 0) return false;
      const readAt = sidebarReadReceipts[readKey];
      const knownAt = sidebarKnownUpdates[readKey];
      const hasKnownSidebarHistory = Object.keys(sidebarKnownUpdates).length > 0;
      const firstSeenExistingItem =
        readAt == null && knownAt == null && (!hasKnownSidebarHistory || updatedAt <= sidebarReadBaselineRef.current);
      if (firstSeenExistingItem) return false;
      return updatedAt > (readAt ?? knownAt ?? 0);
    };
    const sidebarRunsById = new Map(runs.map((item) => [item.run_id, item]));
    if (selectedRun) sidebarRunsById.set(selectedRun.run_id, selectedRun);
    const rememberFallbackRun = (fallbackRunId: string | null | undefined, fallbackStatus: string) => {
      if (!fallbackRunId || sidebarRunsById.has(fallbackRunId)) return;
      sidebarRunsById.set(fallbackRunId, provisionalRunSession(fallbackRunId, fallbackRunId, fallbackStatus, deliveryDryRun));
    };
    rememberFallbackRun(runId, status === 'idle' ? 'active' : status);
    rememberFallbackRun(runtimeStatus?.state.recent_run_id, 'recent');
    for (const activeRunId of runtimeStatus?.state.active_run_ids ?? []) rememberFallbackRun(activeRunId, 'active');
    const sidebarRuns = Array.from(sidebarRunsById.values());
    const backendSessionById = new Map(backendChatSessions.map((session) => [session.session_id, session]));
    const backendItems = backendChatSessions.map((session): SidebarSessionItem => {
      const linkedRunId =
        chatSessionLinkedRunId(session) ?? sidebarRuns.find((run) => run.chat_session_id === session.session_id)?.run_id ?? null;
      const updatedAt = session.updated_at * 1000;
      const readKey = `backend-chat:${session.session_id}`;
      // Spinner truth: the kernel's liveness verdict, or this tab itself
      // having the turn in flight. A local terminal assistant tail can only
      // suppress stale live activity after Stop/completion; message shapes never
      // claim progress.
      const localRunning = runningKeys.includes(chatTurnKey(session.session_id, ''));
      const live = localRunning || (!hasTerminalAssistantTail(session) && session.activity?.is_live === true);
      return {
        kind: 'backend-chat',
        id: session.session_id,
        title: session.title,
        status: session.activity?.status ?? 'idle',
        live,
        timeLabel: formatRelativeTaskAge(updatedAt, sidebarNow, locale),
        readKey,
        unread: isUnreadSidebarItem(readKey, updatedAt, activeBackendChatSessionId === session.session_id, live),
        updated_at: updatedAt,
        run_id: linkedRunId,
        chat_session_id: session.session_id,
        workspace_id: session.workspace_id ?? null,
        archived: session.archived === true,
        pinned: typeof session.pinned_at === 'number',
        pinned_at: typeof session.pinned_at === 'number' ? session.pinned_at : null,
      };
    });
    const localItems = localChatSessions.map((session): SidebarSessionItem => {
      const itemStatus = chatSessionActivityStatus(session.turns);
      const updatedAt = Number.isFinite(session.updated_at) ? session.updated_at : 0;
      const readKey = `local-chat:${session.session_id}`;
      // Local sessions are this tab's own state: only a session with a request
      // actually in flight may spin — a stale "working" tail rehydrated from
      // localStorage proves nothing.
      const live = runningKeys.includes(chatTurnKey('', session.session_id));
      return {
        kind: 'local-chat',
        id: session.session_id,
        title: session.title,
        status: itemStatus,
        live,
        timeLabel: formatRelativeTaskAge(session.updated_at, sidebarNow, locale),
        readKey,
        unread: isUnreadSidebarItem(readKey, updatedAt, activeLocalChatSessionId === session.session_id, live),
        updated_at: updatedAt,
        // Local drafts aren't kernel-persisted, so cross-surface pin doesn't
        // apply (they pin once they become a backend session).
        pinned: false,
        pinned_at: null,
      };
    });
    // The dedicated "Runs" sidebar surface was removed: execution runs no longer
    // render as their own sidebar items. The backend run engine and the
    // chat↔run linkage above are unchanged — only this projection is dropped.
    const chatItems = [...backendItems, ...localItems].sort((left, right) => right.updated_at - left.updated_at);
    return chatItems;
  }, [
    activeBackendChatSessionId,
    activeLocalChatSessionId,
    backendChatSessions,
    deliveryDryRun,
    runningKeys,
    localChatSessions,
    locale,
    runId,
    runs,
    runtimeStatus,
    selectedRun,
    sidebarKnownUpdates,
    sidebarNow,
    sidebarReadReceipts,
    status,
  ]);

  // Sidebar grouping (workspace-sidebar-rework PR-C): the built-in Chat
  // workspace + unassigned/legacy sessions render FLAT under "Chats"; every
  // user-created workspace renders as its own collapsible group. With no
  // registered workspaces the sidebar renders the flat legacy list unchanged
  // (§3 two-surface view).
  const sidebarGroups = useMemo(() => {
    const chatItems = sidebarSessionItems;
    const knownWorkspaces = new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace]));
    const isFlatWorkspace = (workspaceId: string | null | undefined) =>
      !workspaceId || knownWorkspaces.get(workspaceId)?.builtin_chat === true;
    // Pinned chats float to the top "Pinned" zone regardless of their workspace —
    // membership underneath is unchanged, so they appear ONLY in the zone (not
    // also in their group) and return home on unpin. Ordered by pin time.
    const pinnedChats = chatItems
      .filter((item) => item.pinned)
      .sort((left, right) => (right.pinned_at ?? 0) - (left.pinned_at ?? 0));
    const byWorkspace = new Map<string, SidebarSessionItem[]>();
    const flatChats: SidebarSessionItem[] = [];
    for (const item of chatItems) {
      if (item.pinned) continue; // already floated to the pin zone
      if (isFlatWorkspace(item.workspace_id)) {
        flatChats.push(item);
      } else {
        const bucket = byWorkspace.get(item.workspace_id as string) ?? [];
        bucket.push(item);
        byWorkspace.set(item.workspace_id as string, bucket);
      }
    }
    const groups: SidebarProjectGroup[] = [];
    // Workspace order follows the inventory contract; sessions whose workspace
    // is unknown to the inventory still get their own group (never silently
    // dropped). The built-in Chat workspace never becomes a group (it's flat).
    for (const workspace of workspaces) {
      if (workspace.builtin_chat) continue;
      // Every personal project renders, even with zero chats: a freshly created
      // project must appear under "Projects" immediately so its "+" is reachable.
      const items = byWorkspace.get(workspace.workspace_id) ?? [];
      groups.push({
        key: workspace.workspace_id,
        label: workspace.name,
        trustRequired: !workspace.is_trusted,
        repoPath: workspace.repo_path,
        builtin: Boolean(workspace.builtin_chat),
        pinned: workspace.pinned === true || typeof workspace.pinned_at === 'number',
        pinnedAt: typeof workspace.pinned_at === 'number' ? workspace.pinned_at : null,
        items,
      });
      byWorkspace.delete(workspace.workspace_id);
    }
    for (const [workspaceId, items] of byWorkspace) {
      const known = knownWorkspaces.get(workspaceId);
      groups.push({
        key: workspaceId,
        label: known?.name ?? workspaceId,
        // fail-closed: a workspace the inventory doesn't project is NOT assumed
        // openable — without a kernel trust verdict the group is gated (the UI
        // never grants execution access the kernel hasn't confirmed).
        trustRequired: known ? !known.is_trusted : true,
        repoPath: known?.repo_path ?? '',
        builtin: false,
        pinned: known?.pinned === true || typeof known?.pinned_at === 'number',
        pinnedAt: typeof known?.pinned_at === 'number' ? known.pinned_at : null,
        items,
      });
    }
    // A pinned workspace floats its WHOLE group into the pin zone (ordered by pin
    // time); the rest stay under "Projects".
    const pinnedGroups = groups
      .filter((group) => group.pinned)
      .sort((left, right) => (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0));
    const projectGroups = groups.filter((group) => !group.pinned);
    return { groups: projectGroups, pinnedGroups, pinnedChats, flatChats };
  }, [sidebarSessionItems, workspaces]);

  useEffect(() => {
    rememberSidebarKnownUpdates(sidebarSessionItems.filter((item) => !item.unread));
    const activeItems = sidebarSessionItems.filter((item) => {
      if (item.kind === 'backend-chat') return item.id === activeBackendChatSessionId;
      if (item.kind === 'local-chat') return item.id === activeLocalChatSessionId;
      return Boolean(runId) && item.run_id === runId;
    });
    markSidebarItemsRead(activeItems);
  }, [activeBackendChatSessionId, activeLocalChatSessionId, runId, sidebarSessionItems]);

  const activeBackendChatSession = useMemo(
    () => backendChatSessions.find((session) => session.session_id === activeBackendChatSessionId) ?? null,
    [activeBackendChatSessionId, backendChatSessions],
  );
  const activeLocalChatSession = useMemo(
    () => localChatSessions.find((session) => session.session_id === activeLocalChatSessionId) ?? null,
    [activeLocalChatSessionId, localChatSessions],
  );
  // The composer reflects the session in view: it shows "running" / the stop
  // affordance ONLY when the turn in flight belongs to that very session (a
  // brand-new draft's '' matches the pre-id running state). Switching away no
  // longer drags the running indicator onto the newly viewed chat.
  // Per-session: the composer reflects ONLY the chat in view. Busy = this chat's
  // own turn is in flight; a turn running in another chat leaves this composer
  // free. The 'draft' key covers a brand-new chat (active backend/local both '').
  const composerKey = chatTurnKey(activeBackendChatSessionId, activeLocalChatSessionId);
  const composerIsBusy = runningKeys.includes(composerKey);
  // Login banner for the chat in view (per-key), if its last turn hit an auth failure.
  const composerLoginNotice = runtimeLoginNotices[composerKey] ?? null;
  // This chat's own pending items — the queue panel shows ONLY these, so another
  // chat's backlog never appears under the composer.
  const composerQueue = chatQueue.filter((item) => chatQueueItemKey(item) === composerKey);
  // Submitting now would QUEUE: this chat is already running or has its own
  // pending items. A turn in a different chat never makes this one enqueue.
  const composerWillEnqueue = composerIsBusy || composerQueue.length > 0;
  const composerIsStopping = stoppingKeys.includes(composerKey);
  const composerPaused = pausedKeys.includes(composerKey);
  const configuredDefaultBackend = runtimeConfig?.defaults?.backend ?? '';
  const activeChatRuntime = (activeBackendChatSession?.metadata?.runtime ?? null) as
    | { backend?: string; model?: string; effort?: string }
    | null;
  const activeChatRuntimeKey = JSON.stringify(activeChatRuntime);
  useEffect(() => {
    // Per-chat runtime stickiness: switching to a chat restores the backend +
    // model + effort it runs on (ChatSession.metadata.runtime, kernel-owned
    // semantics, now surfaced from executionState.runtime). A chat WITHOUT a
    // recorded runtime INHERITS the current composer selection (last-used
    // carry-over — 规范3): switching into it must NOT snap back to the configured
    // default. Keyed by session + runtime payload (metadata can arrive after the
    // id via the sessions refresh) and applied once per change so it never fights
    // live user edits.
    if (!activeBackendChatSessionId) return; // a fresh draft keeps the visible selection
    const applyKey = `${activeBackendChatSessionId}:${activeChatRuntimeKey}`;
    if (appliedChatRuntimeRef.current === applyKey) return;
    appliedChatRuntimeRef.current = applyKey;
    if (activeChatRuntime?.backend) {
      // A restore IS an explicit selection — the one-shot config-default
      // initialization must not overwrite it afterwards.
      backendDefaultAppliedRef.current = true;
      setSelectedBackend(activeChatRuntime.backend);
      setSelectedModel(typeof activeChatRuntime.model === 'string' ? activeChatRuntime.model : '');
      setSelectedEffort(typeof activeChatRuntime.effort === 'string' ? activeChatRuntime.effort : '');
    }
    // else: no recorded runtime → inherit the current composer selection. We
    // deliberately leave backendDefaultAppliedRef untouched so the one-shot
    // config default can still seed an as-yet-empty selection (its
    // setSelectedBackend uses `previous || default`, so it never clobbers an
    // inherited runtime).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBackendChatSessionId, activeChatRuntimeKey]);
  const activeContextRunId =
    activeBackendChatSession
      ? chatSessionLinkedRunId(activeBackendChatSession)
      : [...directChatTurns].reverse().find((turn) => turn.run_id)?.run_id ?? null;
  const composerCommands = useMemo<ComposerCommand[]>(
    () => [
      { id: 'chat', token: '/chat', label: '/chat', description: 'Switch to direct chat' },
      { id: 'new', token: '/new', label: '/new', description: 'Start a new chat session' },
      { id: 'plugins', token: '/plugins', label: '/plugins', description: 'Open Capability Workshop' },
      { id: 'settings', token: '/settings', label: '/settings', description: 'Open settings and local agents' },
      { id: 'clawhunt', token: '/clawhunt', label: '/clawhunt', description: 'Open ClawHunt settings' },
      { id: 'cost', token: '/cost', label: '/cost', description: "Show this session's token usage" },
      { id: 'compact', token: '/compact', label: '/compact', description: 'Compact this chat into a summary and continue in a fresh session' },
    ],
    [],
  );
  const composerContextRefs = useMemo<ComposerContextRef[]>(() => {
    const refs: ComposerContextRef[] = [];
    const seen = new Set<string>();
    const addRef = (ref: ComposerContextRef) => {
      const key = contextRefKey(ref);
      if (!ref.id || seen.has(key)) return;
      seen.add(key);
      refs.push(ref);
    };
    if (activeBackendChatSession) {
      addRef({
        type: 'chat_session',
        id: activeBackendChatSession.session_id,
        label: chatSessionContextLabel(activeBackendChatSession.session_id),
        source: 'backend',
        visible_token: `@session:${activeBackendChatSession.session_id}`,
        metadata: { title: activeBackendChatSession.title || 'Current session' },
      });
    }
    backendChatSessions.slice(0, 8).forEach((session) =>
      addRef({
        type: 'chat_session',
        id: session.session_id,
        label: chatSessionContextLabel(session.session_id),
        source: 'backend',
        visible_token: `@session:${session.session_id}`,
        metadata: { title: session.title || session.session_id },
      }),
    );
    // @run / @evidence / @artifact / @file context refs are intentionally NOT offered in
    // the chat composer: they reference run/evidence data served by the Python /api/runs*
    // path (NOT Node-owned — absent from node_routes.json), i.e. the deprecated run-cockpit
    // surface the chat box no longer uses. They return once an equivalent Node-owned
    // read-only evidence context exists.
    (pluginStatus?.plugins ?? []).slice(0, 8).forEach((plugin) =>
      addRef({
        type: 'plugin',
        id: plugin.id,
        label: plugin.name || plugin.id,
        source: 'installed',
        visible_token: `@plugin:${plugin.id}`,
        metadata: { version: plugin.version, path: plugin.path, installed: true, logo: plugin.logo, logo_url: plugin.logo_url, icon: 'local' },
      }),
    );
    registryPlugins.slice(0, 8).forEach((plugin, index) =>
      addRef({
        type: 'plugin',
        id: plugin.plugin_id,
        label: plugin.name || plugin.plugin_id,
        source: 'marketplace',
        visible_token: `@plugin:${plugin.plugin_id}`,
        metadata: {
          version: plugin.version,
          runtime: plugin.runtime,
          category: plugin.category,
          verified: plugin.verified,
          logo: plugin.logo,
          logo_url: plugin.logo_url,
          icon: index % 3 === 0 ? 'developer' : index % 3 === 1 ? 'runtime' : 'productivity',
          installed: installedPluginKeys.has(pluginKey(plugin.plugin_id, plugin.version)),
        },
      }),
    );
    composerTeamCompanies.slice(0, 24).forEach((company) =>
      addRef({
        type: 'company',
        id: company.company_profile_id,
        label: company.name,
        source: 'team',
        visible_token: `@company:${company.company_profile_id}`,
        metadata: { status: company.status ?? 'active' },
      }),
    );
    return refs.slice(0, 64);
  }, [
    activeBackendChatSession,
    activeContextRunId,
    backendChatSessions,
    composerTeamCompanies,
    directChatTurns,
    evidence,
    installedPluginKeys,
    pluginStatus,
    registryPlugins,
    runId,
    runs,
    selectedRun,
  ]);
  const composerSuggestions = useMemo<ComposerSuggestion[]>(() => {
    if (!composerTrigger) return [];
    const query = composerTrigger.query.trim().toLowerCase();
    if (composerTrigger.trigger === '/') {
      return composerCommands
        .filter((command) => `${command.token} ${command.description}`.toLowerCase().includes(query))
        .map((command) => ({
          id: command.id,
          kind: 'command' as const,
          token: command.token,
          label: command.label,
          description: command.description,
          command,
        }));
    }
    const contextSuggestions = composerContextRefs
      .filter((ref) => `${ref.visible_token} ${ref.label ?? ''} ${ref.id} ${ref.type}`.toLowerCase().includes(query))
      .map((ref) => ({
        id: contextRefKey(ref),
        kind: 'context' as const,
        token: ref.visible_token,
        label: contextSuggestionLabel(ref),
        description: contextSuggestionDescription(ref),
        ref,
      }))
      .slice(0, 24);
    // Native skills (existing + just-created): picking one inserts a `@skill:<slug>`
    // text token the kernel parses into an explicit overlay — no context_ref, same
    // contract as the CLI. Listed under the context refs so a bare `@` still defaults
    // to sessions/runs/files first. (Derivation lives in ./composerSkills for testing.)
    const skillSuggestions: ComposerSuggestion[] = skillComposerSuggestions(composerSkills, query);
    // The "create a new company" entry is an INTENT, not an existing ref — always
    // offered at the TOP when the user is plausibly reaching for a company (empty @,
    // a company-ish word, or a typed name that matches one). The typed text rides as
    // a name hint the kernel's company_create tool can use (chip still reads "新建公司").
    const rawQuery = composerTrigger.query.trim();
    // Only offer "create a company" when the user is plausibly reaching for one — a
    // company-ish word or a typed name that matches an existing company. NOT on a bare
    // `@` (that must keep its existing default: sessions/runs/files first, so `@`+Enter
    // never silently turns into "create a company"). (advisor codex)
    const showCreate =
      query.length > 0 &&
      (/公司|company|新建|create|new/i.test(rawQuery) ||
        composerTeamCompanies.some((c) => c.name.toLowerCase().includes(query)));
    if (!showCreate) return [...contextSuggestions, ...skillSuggestions];
    const createRef: ComposerContextRef = {
      type: 'company_create',
      id: '__create__',
      label: '新建公司',
      source: 'intent',
      visible_token: '@company:create',
      metadata: rawQuery ? { name_hint: rawQuery } : {},
    };
    const createSuggestion: ComposerSuggestion = {
      id: 'company_create',
      kind: 'context',
      token: createRef.visible_token,
      label: rawQuery ? `新建公司「${rawQuery}」` : '新建公司',
      description: locale === 'zh' ? '让内核创建一个真公司（不是建文件夹）' : 'Create a real company in the kernel',
      ref: createRef,
    };
    return [createSuggestion, ...contextSuggestions, ...skillSuggestions];
  }, [composerCommands, composerContextRefs, composerSkills, composerTeamCompanies, composerTrigger, locale]);

  useEffect(() => {
    setSelectedSuggestionIndex(0);
  }, [composerSuggestions.length, composerTrigger?.query, composerTrigger?.trigger]);

  function rememberLocalChatSession(session: LocalChatSession) {
    setLocalChatSessions((current) => {
      const next = [session, ...current.filter((item) => item.session_id !== session.session_id)].slice(
        0,
        LOCAL_CHAT_SESSION_LIMIT,
      );
      writeLocalChatSessions(next);
      return next;
    });
  }

  function rememberRunSession(session: RunSessionState) {
    setRuns((current) => [session, ...current.filter((item) => item.run_id !== session.run_id)]);
  }

  function rememberBackendChatSession(sessionId: string, title: string, turns: DirectChatTurn[]) {
    const now = Date.now() / 1000;
    const session: BackendChatSession = {
      session_id: sessionId,
      title,
      created_at: now,
      updated_at: now,
      messages: turns.map((turn) => ({
        role: turn.role,
        content: turn.content,
        status: turn.status,
        run_id: turn.run_id ?? null,
        created_at: typeof turn.createdAt === 'number' ? turn.createdAt : now,
        // Persist context refs into the optimistic cache too — they are light
        // (no data_url payload, unlike attachments) and "re-edit" must restore
        // them even when a session is reopened from cache before /api/chat/sessions
        // refreshes. Dropping them here silently strips the chips on reopen.
        context_refs: turn.contextRefs ?? [],
        // Carry the metering forward so reopening from the optimistic cache (before
        // the backend refresh) keeps the meter row consistent. Live turns expose
        // usage via display.usage; persisted turns carry turn.usage directly.
        usage: turn.usage ?? (turn.display?.usage as Record<string, number> | undefined) ?? null,
        elapsed_ms: typeof turn.elapsedMs === 'number' ? turn.elapsedMs : null,
      })),
      // Optimistically stamp the runtime this turn used so a switch back restores
      // the per-chat model/effort even BEFORE the sessions refresh delivers the
      // authoritative executionState.runtime from the backend (mirrors the server
      // `metadata.runtime` shape: backend required, model/effort only when set).
      // Only applied when this record is a fresh insert; existing records keep the
      // server-owned metadata (rememberBackendChatSession's existing branch).
      metadata: selectedBackend
        ? {
            runtime: {
              // Canonical resolved runtime — matches what the server persists from
              // the (now-canonical) submitted runtimeBackend, so the optimistic
              // record never seeds a legacy alias back into metadata.runtime.
              backend: selectedAgentInfo?.name ?? selectedBackend,
              ...(selectedModel ? { model: selectedModel } : {}),
              ...(selectedEffort ? { effort: selectedEffort } : {}),
            },
          }
        : {},
    };
    // Only treat as an optimistic draft if the backend has NOT already confirmed
    // this id — this refresh fires on every turn (chat.started/completed/…) for
    // existing sessions too, and a confirmed session must follow backend truth
    // (incl. archive exclusion), not be re-kept as a stale draft.
    if (!confirmedChatIdsRef.current.has(sessionId)) optimisticChatIdsRef.current.add(sessionId);
    setBackendChatSessions((current) => {
      const existing = current.find((item) => item.session_id === sessionId);
      if (existing) {
        // The backend already owns this session and it's in the list — a per-turn
        // content refresh. Only title/timestamp/messages change; PRESERVE the
        // kernel's workspace_id / archived / activity (the synthetic record carries
        // none, and overwriting them would flatten a workspace-bound or archived
        // session into a plain Chats item — a client rewrite of the kernel trust
        // boundary that would persist if the next refetch fails).
        const next: BackendChatSession = { ...existing, title, updated_at: now, messages: session.messages };
        return [next, ...current.filter((item) => item.session_id !== sessionId)];
      }
      // No local record. A CONFIRMED session that's absent was deliberately
      // removed (archived) or excluded by the scoped fetch — never RESURRECT it
      // with a synthetic record lacking the kernel's workspace/trust/archived
      // fields (e.g. archiving a session that still has an in-flight turn whose
      // completion event fires here). The next successful fetch is the only thing
      // that may bring it back, with full kernel semantics.
      if (confirmedChatIdsRef.current.has(sessionId)) return current;
      // A genuinely new, not-yet-confirmed session: insert the optimistic record
      // so its first turn is visible before the backend confirms it.
      return [session, ...current];
    });
  }

  function rememberSidebarKnownUpdates(items: SidebarSessionItem[]) {
    if (items.length === 0) return;
    setSidebarKnownUpdates((current) => {
      let changed = false;
      const next = { ...current };
      for (const item of items) {
        if (!Number.isFinite(item.updated_at) || item.updated_at <= 0) continue;
        if ((next[item.readKey] ?? 0) < item.updated_at) {
          next[item.readKey] = item.updated_at;
          changed = true;
        }
      }
      if (changed) writeSidebarTimestampMap(SIDEBAR_KNOWN_UPDATES_STORAGE_KEY, next);
      return changed ? next : current;
    });
  }

  function markSidebarItemsRead(items: SidebarSessionItem[]) {
    if (items.length === 0) return;
    rememberSidebarKnownUpdates(items);
    setSidebarReadReceipts((current) => {
      let changed = false;
      const next = { ...current };
      for (const item of items) {
        if (!Number.isFinite(item.updated_at) || item.updated_at <= 0) continue;
        const readAt = item.updated_at;
        if ((next[item.readKey] ?? 0) < readAt) {
          next[item.readKey] = readAt;
          changed = true;
        }
      }
      if (changed) writeSidebarTimestampMap(SIDEBAR_READ_RECEIPTS_STORAGE_KEY, next);
      return changed ? next : current;
    });
  }

  function closeSidebarContextMenu() {
    setSidebarContextMenu(null);
  }

  function sidebarItemSessionId(item: SidebarSessionItem) {
    if (item.kind === 'backend-chat') return item.id;
    return null;
  }

  function openSidebarContextMenu(event: ReactMouseEvent<HTMLButtonElement>, item: SidebarSessionItem) {
    event.preventDefault();
    event.stopPropagation();
    const sessionId = sidebarItemSessionId(item);
    if (!sessionId) {
      setSidebarContextMenu(null);
      return;
    }
    // Only persisted backend chat sessions support archive/move (unsynced local
    // drafts expose just copy-id).
    const canManage = item.kind === 'backend-chat';
    const menuWidth = 230;
    const menuHeight = canManage ? 156 : 48;
    setAccountMenuOpen(false);
    setSidebarContextMenu({
      sessionId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      canManage,
      archived: item.archived === true,
      workspaceId: item.workspace_id ?? null,
    });
  }

  function persistCollapsedWorkspaceGroups(next: Record<string, boolean>) {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // localStorage best-effort: a write failure just means collapse state
      // doesn't survive a reload; never block the toggle.
    }
  }

  function toggleWorkspaceGroup(key: string) {
    setCollapsedWorkspaceGroups((current) => {
      const next = { ...current, [key]: !current[key] };
      persistCollapsedWorkspaceGroups(next);
      return next;
    });
  }

  function setSidebarItemBusyFlag(key: string, busy: boolean) {
    setSidebarItemBusy((current) => {
      if (!busy) {
        if (!current[key]) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      return { ...current, [key]: true };
    });
  }

  // Pin/unpin a backend chat to the top "Pinned" zone (Req 4/5). Cross-surface
  // kernel state; only backend-chat items are pinnable. Optimistic local flip so
  // the row floats/returns immediately, reconciled by the refetch.
  async function togglePinSessionItem(item: SidebarSessionItem) {
    if (item.kind !== 'backend-chat') return;
    const key = `${item.kind}-${item.id}`;
    if (sidebarItemBusy[key]) return;
    const nextPinned = !item.pinned;
    setSidebarItemBusyFlag(key, true);
    setBackendChatSessions((current) =>
      current.map((session) =>
        session.session_id === item.id
          ? { ...session, pinned_at: nextPinned ? Date.now() / 1000 : null }
          : session,
      ),
    );
    try {
      await readJson(`/api/chat/sessions/${item.id}/pin`, {
        method: 'POST',
        body: JSON.stringify({ pinned: nextPinned }),
      });
      await loadChatSessions();
    } catch (error) {
      setMessage(`${copy.sessionActionFailed}: ${String(error)}`);
      await loadChatSessions(); // re-sync the authoritative truth on failure
    } finally {
      setSidebarItemBusyFlag(key, false);
    }
  }

  // Archive a backend chat straight from its hover action (mirrors the menu path).
  async function archiveSessionItem(item: SidebarSessionItem) {
    if (item.kind !== 'backend-chat') return;
    const key = `${item.kind}-${item.id}`;
    if (sidebarItemBusy[key]) return;
    setSidebarItemBusyFlag(key, true);
    try {
      await readJson(`/api/chat/sessions/${item.id}/archive`, {
        method: 'POST',
        body: JSON.stringify({ archived: true }),
      });
      optimisticChatIdsRef.current.delete(item.id);
      confirmedChatIdsRef.current.add(item.id);
      setBackendChatSessions((current) =>
        showArchivedRef.current
          ? current.map((session) => (session.session_id === item.id ? { ...session, archived: true } : session))
          : current.filter((session) => session.session_id !== item.id),
      );
      setMessage(copy.sessionArchived);
      await loadChatSessions();
    } catch (error) {
      setMessage(`${copy.sessionActionFailed}: ${String(error)}`);
    } finally {
      setSidebarItemBusyFlag(key, false);
    }
  }

  function openWorkspaceContextMenu(event: ReactMouseEvent<HTMLElement>, group: SidebarProjectGroup) {
    event.preventDefault();
    event.stopPropagation();
    setSidebarContextMenu(null);
    setAccountMenuOpen(false);
    const menuWidth = 230;
    const menuHeight = 220;
    setWorkspaceContextMenu({
      workspaceId: group.key,
      name: group.label,
      repoPath: group.repoPath,
      pinned: group.pinned,
      builtin: group.builtin,
      trustRequired: group.trustRequired,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    });
  }

  async function togglePinWorkspace(menu: WorkspaceContextMenuState) {
    const nextPinned = !menu.pinned;
    setWorkspaceContextMenu(null);
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.workspace_id === menu.workspaceId
          ? { ...workspace, pinned: nextPinned, pinned_at: nextPinned ? Date.now() / 1000 : null }
          : workspace,
      ),
    );
    try {
      await readJson(`/api/workspaces/${menu.workspaceId}/pin`, {
        method: 'POST',
        body: JSON.stringify({ pinned: nextPinned }),
      });
      await loadChatSessions();
    } catch (error) {
      setMessage(`${copy.sessionActionFailed}: ${String(error)}`);
      await loadChatSessions();
    }
  }

  async function performWorkspaceRename() {
    if (!workspaceRename) return;
    const name = workspaceRename.name.trim();
    if (!name) return;
    setWorkspaceRenameBusy(true);
    try {
      await readJson(`/api/workspaces/${workspaceRename.workspaceId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      setWorkspaceRename(null);
      setMessage(copy.workspaceRenamed);
      await loadChatSessions();
    } catch (error) {
      const detail = (error as { detail?: string } | null)?.detail;
      setMessage(detail && detail.trim() ? detail : `${copy.workspaceRenameFailed}: ${String(error)}`);
    } finally {
      setWorkspaceRenameBusy(false);
    }
  }

  async function performWorkspaceRemove() {
    if (!workspaceRemove) return;
    setWorkspaceRemoveBusy(true);
    try {
      await readJson(`/api/workspaces/${workspaceRemove.workspaceId}`, { method: 'DELETE' });
      setWorkspaceRemove(null);
      setMessage(copy.workspaceRemoved);
      await loadChatSessions();
    } catch (error) {
      const detail = (error as { detail?: string } | null)?.detail;
      setMessage(detail && detail.trim() ? detail : `${copy.workspaceRemoveFailed}: ${String(error)}`);
    } finally {
      setWorkspaceRemoveBusy(false);
    }
  }

  async function revealWorkspaceInFinder(menu: WorkspaceContextMenuState) {
    setWorkspaceContextMenu(null);
    if (!desktopInvoke || !menu.repoPath) return;
    try {
      await revealDesktopPath(desktopInvoke, menu.repoPath);
    } catch (error) {
      setMessage(`${copy.workspaceRevealFailed}: ${String(error)}`);
    }
  }

  // Re-encode an image Blob to PNG via a canvas. The async Clipboard API only
  // reliably accepts image/png across browsers (and the Tauri WKWebview), so we
  // normalize jpeg/webp/gif before writing rather than gambling on format support.
  function imageBlobToPng(blob: Blob): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth || image.width;
          canvas.height = image.naturalHeight || image.height;
          const ctx = canvas.getContext('2d');
          if (!ctx || !canvas.width || !canvas.height) {
            URL.revokeObjectURL(url);
            reject(new Error('canvas unavailable'));
            return;
          }
          ctx.drawImage(image, 0, 0);
          canvas.toBlob((out) => {
            URL.revokeObjectURL(url);
            if (out) resolve(out);
            else reject(new Error('png encode failed'));
          }, 'image/png');
        } catch (error) {
          URL.revokeObjectURL(url);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('image decode failed'));
      };
      image.src = url;
    });
  }

  async function copyImageToClipboard(src: string) {
    const blob = dataUrlToBlob(src);
    if (!blob) throw new Error('image is not copyable');
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.write !== 'function' || typeof ClipboardItem === 'undefined') {
      throw new Error('clipboard image write unsupported');
    }
    // Hand ClipboardItem a Promise<Blob>, NOT an already-awaited Blob. WebKit/WKWebView
    // require clipboard.write() to be invoked synchronously within the click's
    // user-activation window; awaiting the canvas→PNG re-encode first would drop that
    // activation and make jpeg/webp/gif copies fail with NotAllowedError. The API
    // accepts a Promise value precisely so the async encode can resolve lazily.
    const pngBlob = blob.type === 'image/png' ? Promise.resolve(blob) : imageBlobToPng(blob);
    await clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
  }

  async function copyImageFromMenu(menu: ImageContextMenuState) {
    setImageContextMenu(null);
    try {
      await copyImageToClipboard(menu.src);
      setMessage(copy.copyImageDone);
    } catch (error) {
      setMessage(`${copy.copyImageFailed}: ${String(error)}`);
    }
  }

  async function revealImageInFinder(menu: ImageContextMenuState) {
    setImageContextMenu(null);
    if (!desktopInvoke) return;
    try {
      // A local_path attachment already has a real file — reveal it directly.
      if (menu.path && menu.path.trim()) {
        await revealDesktopPath(desktopInvoke, menu.path);
        return;
      }
      // Otherwise the image lives only as base64 bytes; hand them to the shell to
      // materialize + reveal. Prefer the attachment's declared MIME, falling back
      // to the one parsed from the data URL.
      const parts = parseImageDataUrl(menu.src);
      if (!parts) throw new Error('image has no revealable source');
      await revealDesktopImage(desktopInvoke, {
        mime: menu.mime ?? parts.mime,
        dataBase64: parts.base64,
        name: menu.name,
      });
    } catch (error) {
      setMessage(`${copy.revealImageFailed}: ${String(error)}`);
    }
  }

  function openImageContextMenu(
    event: ReactMouseEvent<HTMLElement>,
    image: { src: string; name: string; mime?: string | null; path?: string | null },
  ) {
    if (!image.src) return;
    event.preventDefault();
    setImageContextMenu({
      x: event.clientX,
      y: event.clientY,
      src: image.src,
      name: image.name,
      mime: image.mime ?? null,
      path: image.path ?? null,
    });
  }

  async function archiveSidebarSession(menu: SidebarContextMenuState) {
    const archived = !menu.archived;
    setSidebarContextMenu(null);
    try {
      await readJson(`/api/chat/sessions/${menu.sessionId}/archive`, {
        method: 'POST',
        body: JSON.stringify({ archived }),
      });
      // The session is backend-owned now (we just mutated it). Drop any pending
      // optimistic claim so the refetch's archive exclusion is honored even for a
      // session archived before its first confirming fetch.
      optimisticChatIdsRef.current.delete(menu.sessionId);
      confirmedChatIdsRef.current.add(menu.sessionId);
      // Apply the result LOCALLY now (don't wait for the refetch, which may fail):
      // when archiving while the archived view is off, drop it from the list so it
      // hides instantly and STAYS hidden even if loadChatSessions errors; otherwise
      // just flip its archived flag. The refetch below reconciles best-effort.
      setBackendChatSessions((current) =>
        archived && !showArchivedRef.current
          ? current.filter((session) => session.session_id !== menu.sessionId)
          : current.map((session) =>
              session.session_id === menu.sessionId ? { ...session, archived } : session,
            ),
      );
      setMessage(archived ? copy.sessionArchived : copy.sessionUnarchived);
      await loadChatSessions();
    } catch (error) {
      setMessage(`${copy.sessionActionFailed}: ${String(error)}`);
    }
  }

  // Single move path: ask the kernel first with acknowledge=false. A 409 means
  // the move crosses an execution boundary (§4.5) — surface the warning dialog
  // and only re-send with acknowledge=true on explicit confirmation. The kernel
  // is the sole authority on whether a boundary changed; the UI never guesses.
  async function performMove(sessionId: string, workspaceId: string | null, label: string, acknowledge: boolean) {
    setMoveBusyTarget(workspaceId ?? '__inbox__');
    try {
      await readJson(`/api/chat/sessions/${sessionId}/move`, {
        method: 'POST',
        body: JSON.stringify({ workspace_id: workspaceId, acknowledge_boundary_change: acknowledge }),
      });
      setMoveSessionId(null);
      setMovePendingTarget(null);
      setMessage(copy.sessionMoved);
      // Apply the new binding LOCALLY now — don't wait for the refetch, which may
      // fail and leave a stale workspace_id. Without this, the next turn would send
      // the OLD id and the kernel would silently move the session back (it treats a
      // differing explicit workspace_id as a move). Mirrors the archive handler.
      setBackendChatSessions((current) =>
        current.map((session) =>
          session.session_id === sessionId ? { ...session, workspace_id: workspaceId } : session,
        ),
      );
      await loadChatSessions();
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status === 409 && !acknowledge) {
        setMovePendingTarget({ workspaceId, label });
      } else {
        setMessage(`${copy.sessionActionFailed}: ${String(error)}`);
      }
    } finally {
      setMoveBusyTarget(null);
    }
  }

  async function createPersonalWorkspace() {
    const name = newWorkspaceName.trim();
    if (!name) return;
    const attachRepo = newWorkspaceAttach ? newWorkspaceRepo.trim() : '';
    // Fail-closed in the handler itself, not just via the disabled button: never
    // emit attach_repo without an explicit trust attestation (§4.4). The kernel
    // also 422s, but the client must not even attempt it (defense in depth).
    if (newWorkspaceAttach && (!attachRepo || !newWorkspaceTrust)) return;
    setNewWorkspaceError(null);
    setNewWorkspaceBusy(true);
    try {
      const created = (await readJson('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({
          name,
          // fail-closed: attach a real dir only with an explicit trust attestation
          // (the kernel 422s otherwise — §4.4). Folder-only scratch needs neither.
          attach_repo: attachRepo || null,
          trust_confirmed: newWorkspaceAttach ? newWorkspaceTrust : false,
        }),
      })) as WorkspaceInfo;
      setNewWorkspaceOpen(false);
      setNewWorkspaceName('');
      setNewWorkspaceAttach(false);
      setNewWorkspaceRepo('');
      setNewWorkspaceTrust(false);
      setMessage(copy.workspaceCreated);
      // Enter a fresh chat pinned to the just-created project so the user's
      // first message lands in the new project's sidebar group instead of
      // falling back to "Chat (no project)". Without this the composer keeps
      // pinnedWorkspaceId=null, the turn ships workspace_id=undefined, the
      // kernel resolves the default Chat workspace, and the conversation is
      // grouped under Chat. Reuses the project group's "new chat" pin+reset+focus.
      //
      // Pin BEFORE the await: startProjectChat is synchronous, so there is no
      // interactive window where the modal is closed (composer exposed) but the
      // pin is still null — a fast user could otherwise send the first turn with
      // workspace_id=undefined (reproducing the bug) or have their draft cleared
      // by a late resetComposerSession. The pin's id+name come from the POST
      // result, not the workspace list, so it needs nothing from the refresh;
      // loadChatSessions() below only repaints the sidebar groups. The is_trusted
      // guard keeps a (future) non-active projection from pinning past the
      // disabled-UI trust gate — the kernel still fail-closes, but we never
      // desync the composer into a trust-barrier workspace.
      if (typeof created?.workspace_id === 'string' && created.workspace_id && created.is_trusted !== false) {
        startProjectChat(created.workspace_id, created.name ?? name);
      }
      await loadChatSessions();
    } catch (error) {
      // Show the failure INSIDE the dialog (keeps the modal open so the user can
      // rename and retry). Prefer the bare kernel detail (e.g. the collision
      // message) over the URL/status-noisy Error.toString().
      const detail = (error as { detail?: string } | null)?.detail;
      setNewWorkspaceError(
        detail && detail.trim() ? detail : `${copy.workspaceCreateFailed}: ${String(error)}`,
      );
    } finally {
      setNewWorkspaceBusy(false);
    }
  }

  async function writeClipboardText(text: string) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('clipboard unavailable');
  }

  async function copySidebarConversationId(menu: SidebarContextMenuState) {
    try {
      await writeClipboardText(menu.sessionId);
      setMessage(`${copy.conversationIdCopied}: ${menu.sessionId}`);
    } catch (error) {
      setMessage(`${copy.conversationIdCopyFailed}: ${String(error)}`);
    } finally {
      setSidebarContextMenu(null);
    }
  }

  function openSidebarSessionItem(item: SidebarSessionItem) {
    markSidebarItemsRead([item]);
    setMessage('');
    setSidebarContextMenu(null);
    setAccountMenuOpen(false);
    // Opening any chat session clears the composer to that chat's draft — leave
    // history browse so a later ArrowDown can't restore the previous chat's draft
    // (the chat-switch effect already resets on id change; this also covers
    // re-opening the SAME session, whose id does not change).
    exitComposerHistoryBrowse();
    // Navigating to any existing chat drops a pending project pin — otherwise
    // a stale pin could hijack a fresh local draft (whose session id is still
    // empty) into the wrong project. The opened chat's own binding drives its
    // execution boundary instead.
    setPinnedWorkspaceId(null);
    setPinnedWorkspaceName(null);
    if (item.kind === 'local-chat') {
      const session = localChatSessions.find((chatSession) => chatSession.session_id === item.id);
      if (!session) return;
      setActiveBackendChatSessionId('');
      setActiveLocalChatSessionId(session.session_id);
      setDirectChatTurns(session.turns);
      setWorkspaceSurface('chat');
      setRightPanelOpen(false);
      setPrompt('');
      return;
    }
    if (item.kind === 'backend-chat') {
      const session = backendChatSessions.find((chatSession) => chatSession.session_id === item.id);
      if (!session) return;
      const linkedRunId = item.run_id ?? chatSessionLinkedRunId(session);
      setActiveLocalChatSessionId('');
      setActiveBackendChatSessionId(session.session_id);
      // Prefer the live turns when they are at least as complete as the persisted
      // cache: they carry the in-flight 'working' state + reasoning/tool display the
      // server projection drops, so switching back to a running/just-finished chat
      // restores the thinking state instead of a bare placeholder. Completeness is
      // compared in CONVERSATIONAL turns (excluding operational `system` notices the
      // run writes mid-turn) — otherwise a cache inflated by system notices would
      // win over a live buffer that still holds the working turn. A live working
      // tail wins on ties; the cache wins only with strictly more real turns.
      const cachedTurns = backendChatTurns(session);
      const liveTurns = liveChatTurnsRef.current.get(session.session_id);
      const liveWorkingTail = Boolean(liveTurns?.length) && liveTurns![liveTurns!.length - 1]?.status === 'working';
      const preferLive =
        liveTurns != null &&
        (liveWorkingTail
          ? conversationalTurnCount(liveTurns) >= conversationalTurnCount(cachedTurns)
          : conversationalTurnCount(liveTurns) > conversationalTurnCount(cachedTurns));
      setDirectChatTurns(preferLive ? liveTurns : cachedTurns);
      setWorkspaceSurface('chat');
      setRightPanelOpen(false);
      setPrompt('');
      if (linkedRunId) setRunId(linkedRunId);
      return;
    }
  }

  function authHeaders(session: DesktopRuntimeSession | null = desktopSession): Record<string, string> {
    const token = desktopControlToken(session) ?? controlToken;
    return token ? { 'X-SuperClaw-Token': token } : {};
  }

  async function resolveDesktopApiSession(sessionOverride: DesktopRuntimeSession | null = desktopSession) {
    if (!desktopMode) return sessionOverride;
    if (sessionOverride?.handle?.base_url) return sessionOverride;
    if (desktopStatus === 'failed') {
      throw new Error('desktop runtime is not connected');
    }
    const runtimeSession = await ensureDesktopRuntimeSession();
    if (!runtimeSession?.handle?.base_url) {
      throw new Error('desktop runtime is not connected');
    }
    return runtimeSession;
  }

  async function readJson(
    path: string,
    init?: RequestInit & { headers?: Record<string, string> },
    sessionOverride: DesktopRuntimeSession | null = desktopSession,
  ) {
    const resolvedSession = await resolveDesktopApiSession(sessionOverride);
    const resolvedPath = buildDesktopApiUrl(path, resolvedSession);
    const headers = { ...(init?.headers ?? {}) };
    if (typeof init?.body === 'string' && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(resolvedPath, {
      ...init,
      headers: { ...headers, ...authHeaders(resolvedSession) },
    });
    if (!response.ok) {
      let detail = '';
      let rawDetail = '';
      try {
        const body = await response.clone().json();
        if (body && typeof body.detail === 'string') {
          rawDetail = body.detail;
          detail = `: ${body.detail}`;
        }
      } catch {
        /* non-JSON error body — fall back to the status line */
      }
      const error = new Error(`${resolvedPath} returned ${response.status}${detail}`) as Error & {
        status?: number;
        detail?: string;
      };
      error.status = response.status;
      // Expose the bare kernel message (no URL/status noise) so callers can show
      // it inline, e.g. the create-project dialog's collision error.
      if (rawDetail) error.detail = rawDetail;
      throw error;
    }
    return response.json();
  }

  // Reference viewer loader: GET /api/runs/{runId}/files mapped to a FileViewLoad
  // (structured {code,message} on refusal — readJson collapses error bodies to a
  // string, so this reads the typed body directly). Stable identity so the
  // FileViewerPanel effect does not re-fetch on every render.
  const loadRunFile = useCallback(
    async (runId: string, filePath: string): Promise<FileViewLoad> => {
      const resolvedSession = await resolveDesktopApiSession(desktopSession);
      const url = buildDesktopApiUrl(
        `/api/runs/${encodeURIComponent(runId)}/files?path=${encodeURIComponent(filePath)}`,
        resolvedSession,
      );
      const response = await fetch(url, { headers: { ...authHeaders(resolvedSession) } });
      if (response.ok) {
        return { kind: 'ok', result: await response.json() };
      }
      let code = 'request_refused';
      let message = 'request refused';
      try {
        const body = await response.json();
        const d = body && typeof body === 'object' ? body.detail : null;
        if (d && typeof d === 'object') {
          if (typeof d.code === 'string') code = d.code;
          if (typeof d.message === 'string') message = d.message;
        }
      } catch {
        /* non-JSON error body — keep the safe defaults */
      }
      return { kind: 'error', code, message };
    },
    // controlToken is part of authHeaders in browser mode (the user can rotate it
    // at runtime), so it must be a dep or this loader would send a stale token.
    [desktopSession, controlToken],
  );

  // URL preview loader: POST a ticket (control-token header), then GET the
  // sanitized reader JSON. The token rides in the fetch header — never the URL.
  const loadPreview = useCallback(
    async (targetUrl: string): Promise<PreviewLoad> => {
      const resolvedSession = await resolveDesktopApiSession(desktopSession);
      const parseErr = async (response: Response): Promise<PreviewLoad> => {
        let code = 'request_refused';
        let message = 'request refused';
        try {
          const d = (await response.json())?.detail;
          if (d && typeof d === 'object') {
            if (typeof d.code === 'string') code = d.code;
            if (typeof d.message === 'string') message = d.message;
          }
        } catch {
          /* keep defaults */
        }
        return { kind: 'error', code, message };
      };
      const ticketResp = await fetch(buildDesktopApiUrl('/api/preview/tickets', resolvedSession), {
        method: 'POST',
        headers: { ...authHeaders(resolvedSession), 'Content-Type': 'application/json' },
        // allow_proxy is bound into the signed ticket server-side; the GET fetch
        // honours it. Default on so previews work behind a fake-IP proxy.
        body: JSON.stringify({ url: targetUrl, allow_proxy: previewProxyEnabled }),
      });
      if (!ticketResp.ok) return parseErr(ticketResp);
      const ticket = (await ticketResp.json())?.ticket;
      if (!ticket || typeof ticket !== 'string') {
        return { kind: 'error', code: 'request_refused', message: 'request refused' };
      }
      const previewResp = await fetch(
        buildDesktopApiUrl(`/api/preview/${encodeURIComponent(ticket)}`, resolvedSession),
        { headers: { ...authHeaders(resolvedSession) } },
      );
      if (!previewResp.ok) return parseErr(previewResp);
      return { kind: 'ok', data: await previewResp.json() };
    },
    // controlToken rides in authHeaders (browser mode, user-rotatable) — keep it
    // a dep so a rotated token is not stuck behind a stale closure. previewProxy
    // is read into the request body, so it must be a dep too.
    [desktopSession, controlToken, previewProxyEnabled],
  );

  async function readText(
    path: string,
    init?: RequestInit & { headers?: Record<string, string> },
    sessionOverride: DesktopRuntimeSession | null = desktopSession,
  ) {
    const resolvedSession = await resolveDesktopApiSession(sessionOverride);
    const resolvedPath = buildDesktopApiUrl(path, resolvedSession);
    const response = await fetch(resolvedPath, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...authHeaders(resolvedSession) },
    });
    if (!response.ok) {
      const error = new Error(`${resolvedPath} returned ${response.status}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return response.text();
  }

  async function streamChatTurn(
    payload: Record<string, unknown>,
    onEvent: (event: string, data: any) => void,
    sessionOverride: DesktopRuntimeSession | null = desktopSession,
    signal?: AbortSignal,
  ) {
    const resolvedSession = await resolveDesktopApiSession(sessionOverride);
    const resolvedPath = buildDesktopApiUrl('/api/chat/stream', resolvedSession);
    const response = await fetch(resolvedPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(resolvedSession) },
      body: JSON.stringify(payload),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`/api/chat/stream returned ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        let parsed: any = {};
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = { raw: data };
        }
        onEvent(event, parsed);
      }
    }
  }

  function saveControlToken(value: string) {
    setControlToken(value);
    if (value) localStorage.setItem('superclaw_control_token', value);
    else localStorage.removeItem('superclaw_control_token');
  }

  async function rotateControlToken() {
    try {
      const payload = (await readJson('/api/runtime/control-token/rotate', { method: 'POST' })) as {
        control_token: string;
      };
      saveControlToken(payload.control_token);
      setDesktopSession((current) =>
        current?.handle
          ? {
              ...current,
              handle: {
                ...current.handle,
                control_token: payload.control_token,
              },
            }
          : current,
      );
      await Promise.allSettled([loadRuntimeStatus(), loadRuntimeConfig(), loadAuthStatus()]);
      setMessage('control token rotated');
    } catch (error) {
      setMessage(`control token rotation failed: ${String(error)}`);
    }
  }

  async function openMarketplaceSurface() {
    setWorkspaceSurface('plugins');
    setRightPanelOpen(false);
    await Promise.allSettled([loadPluginControl(), loadRuntimeStatus()]);
  }

  async function openTeamSurface() {
    setWorkspaceSurface('team');
    setRightPanelOpen(false);
    setAccountMenuOpen(false);
    if (desktopMode && !desktopSession?.handle?.base_url && desktopStatus !== 'failed') {
      await ensureDesktopRuntimeSession();
    }
  }

  // THE canvas the product opens on: every node is an agent session with its own chat, wired to
  // upstream nodes so one node's output becomes the next node's precondition.
  function openCanvasSurface() {
    setWorkspaceSurface('canvas');
    setRightPanelOpen(false);
    setAccountMenuOpen(false);
  }

  function focusSettingsTarget(targetId: string, behavior: ScrollBehavior = 'smooth') {
    const settingsContent = document.querySelector('.settings-fullscreen-page');
    settingsContent?.scrollTo?.({ top: 0, behavior: 'auto' });
    // Land on the section header (the tab's "home" view) instead of scrolling the
    // target card flush to the top — most nav targets point at the section's first
    // card (e.g. account → settings-clawhunt, runtime → runtime-settings), and
    // scrolling that card to block:'start' pushes the section title off-screen.
    // Every section renders standalone from its header, so the header is the
    // correct landing point for tab navigation.
    const section = settingsSectionForTarget(targetId);
    const header = document.getElementById(`settings-${section}-heading`);
    if (header) {
      header.scrollIntoView?.({ behavior, block: 'start' });
    } else {
      document.getElementById(targetId)?.scrollIntoView?.({ behavior, block: 'start' });
    }
  }

  // Where to land when leaving Settings. Recorded HERE (the single choke point every Settings
  // entry routes through — dock, account menu, composer /settings, runtime deep-links), so no
  // entry path can bypass it. Entering from the canvas returns to the canvas; entering from chat
  // returns to chat. Guarded so in-Settings tab switches never clobber the recorded origin.
  // Never defaults to 'chat' blindly — the product's home surface is the canvas.
  const settingsReturnRef = useRef<'chat' | 'plugins' | 'team' | 'canvas'>('canvas');

  function selectSettingsTarget(targetId = 'settings-general') {
    if (workspaceSurface !== 'control') {
      settingsReturnRef.current = workspaceSurface;
    }
    setWorkspaceSurface('control');
    setRightPanelOpen(false);
    setAccountMenuOpen(false);
    setActiveSettingsTarget(targetId);
    window.setTimeout(() => focusSettingsTarget(targetId), 0);
  }

	  function closeBlockingModal() {
	    setBlockingModal(null);
	    setAgentSetupOpen(false);
	  }

	  function markAgentSetupDismissed() {
	    localStorage.setItem(AGENT_ONBOARDING_DISMISSED_STORAGE_KEY, '1');
	    setAgentSetupDismissed(true);
	  }

	  function closeRuntimeSetupDialog() {
	    if (blockingModal?.kind !== 'runtime-config' && selectedAgentAvailable) {
	      markAgentSetupDismissed();
	    }
	    closeBlockingModal();
	  }

	  function openAgentSetupFor(agentName = selectedAgentInfo?.name ?? selectedBackend) {
	    const agent = agentInventory.find((item) => item.name === agentName);
	    const configName = agent?.config_env ?? AGENT_EXECUTABLE_CONFIG_BY_BACKEND[agentName] ?? '';
	    const configEntry = editableConfigEntries.find((entry) => entry.name === configName);
	    selectComposerBackend(agentName);
	    setAgentExecutableDraft(configEntry ? configEntry.display_value ?? configEntry.default ?? agent?.executable ?? '' : '');
	    setAgentSetupOpen(true);
	    setBlockingModal(null);
	  }

	  // `mutateComposer` defaults true (the composer's own runtime selector wants to
	  // switch the active chat backend). The READ-ONLY Diagnostics surface passes
	  // false: navigating to runtime settings to view/configure an agent must never
	  // change the current chat's backend or clear its selected model — a diagnostics
	  // deep-link is read-only, not a runtime switch.
	  function openRuntimeSettingsForAgent(agentName: string, options?: { mutateComposer?: boolean }) {
	    const mutateComposer = options?.mutateComposer ?? true;
	    const agent = agentInventory.find((item) => item.name === agentName);
	    const configName = agent?.config_env ?? AGENT_EXECUTABLE_CONFIG_BY_BACKEND[agentName] ?? '';
	    if (mutateComposer) {
	      const configEntry = editableConfigEntries.find((entry) => entry.name === configName);
	      selectComposerBackend(agentName);
	      setAgentExecutableDraft(configEntry ? configEntry.display_value ?? configEntry.default ?? agent?.executable ?? '' : '');
	      // The composer path focuses the runtime-agent card itself; clear any stale
	      // per-field focus so the two deep-link styles never collide.
	      setSettingsConfigFocus('');
	    } else {
	      // Read-only diagnostics deep-link: don't touch chat/default — instead point
	      // the per-env config editor at THIS agent's executable env (configName), so
	      // the deep-link lands on the right, side-effect-free target.
	      setSettingsConfigFocus(configName);
	    }
	    selectSettingsTarget('runtime-settings');
	  }

	  // On-demand reachability probe (GET /api/agents/probe). Default depth is
	  // LIGHTWEIGHT — the adapter's own command-resolvable check (real on-disk
	  // reachability, spend-free). opts.deep runs the adapter's native end-to-end
	  // testEnvironment (may spend tokens), so deep is only ever dispatched from an
	  // explicit per-row action — never on page load. Verdict rendered verbatim.
	  async function probeRuntime(backend: string, opts?: { deep?: boolean }) {
	    if (probeInFlightRef.current.has(backend)) return; // synchronous in-flight dedupe
	    probeInFlightRef.current.add(backend);
	    const generation = probeGenerationRef.current; // captured at dispatch
	    setProbingBackends((cur) => ({ ...cur, [backend]: true }));
	    try {
	      const payload = (await readJson(`/api/agents/probe?backend=${encodeURIComponent(backend)}${opts?.deep ? "&depth=deep" : ""}`)) as {
	        probes: RuntimeProbeResult[];
	      };
	      const result = payload.probes?.[0];
	      // Drop a result whose config was invalidated mid-flight (generation bumped)
	      // — it would be a stale "reachable" written over the invalidated state.
	      if (result && probeGenerationRef.current === generation) {
	        setProbeResults((cur) => ({ ...cur, [backend]: result }));
	      }
	    } catch (error) {
	      setMessage(`runtime probe failed: ${String(error)}`);
	    } finally {
	      probeInFlightRef.current.delete(backend);
	      setProbingBackends((cur) => {
	        const next = { ...cur };
	        delete next[backend];
	        return next;
	      });
	    }
	  }

	  // Test installed runtimes SERIALLY (client-side), one request each, so every
	  // row shows its own spinner/result live and we never fan a burst of model-list
	  // calls from one IP (which a provider's per-IP flow control could false-red).
	  // Skips not-installed runtimes — there is nothing to reach.
	  async function probeAllRuntimes() {
	    if (probeAllRunningRef.current) return; // re-entry guard (see ref decl)
	    probeAllRunningRef.current = true;
	    setProbeAllBusy(true);
	    try {
	      const targets = agentInventory.filter((agent) => agent.available);
	      for (const agent of targets) {
	        await probeRuntime(agent.name);
	      }
	    } finally {
	      probeAllRunningRef.current = false;
	      setProbeAllBusy(false);
	    }
	  }

	  // A config edit invalidates a runtime's last probe — its reachability is no
	  // longer proven, so the row reverts to "untested" instead of a stale green.
	  // Bumps the epoch FIRST so any in-flight probe for this backend drops its
	  // (now stale) result on return, then clears the stored result.
	  function invalidateProbe(backend: string) {
	    probeGenerationRef.current += 1; // any in-flight probe now drops on return
	    setProbeResults((cur) => {
	      if (!(backend in cur)) return cur;
	      const next = { ...cur };
	      delete next[backend];
	      return next;
	    });
	  }

	  // Invalidate EVERY runtime's last probe. Called from every mutation that can
	  // change any runtime's reachability/availability — config writes (executable,
	  // keys, base URLs, governance ext) AND auth/relay flows (ClawHunt login/logout,
	  // key rotation, which flip the ClawWork relay credential). The surface cannot
	  // enumerate which mutation affects which backend, so any such mutation clears
	  // all and the user re-tests with one click (a rare, deliberate action). Bumps
	  // the generation + clears via a direct set (never reads a render-closure
	  // probeResults snapshot), so it is correct even when an in-flight probe
	  // returned and wrote its result AFTER this function's closure was created.
	  function invalidateAllProbes() {
	    probeGenerationRef.current += 1;
	    setProbeResults({});
	  }

	  // 聊天 runtime 选择：已配置的直接切换；未配置的选中后直接带去运行时设置完成配置，
	  // 配置入口与选择器合一（契约本身返回全量 + available，过滤/跳转都是表现层行为）。
	  function selectComposerBackendOrConfigure(agentName: string) {
	    const agent = agentInventory.find((item) => item.name === agentName);
	    if (agent && !agent.available) {
	      openRuntimeSettingsForAgent(agentName);
	      return;
	    }
	    selectComposerBackend(agentName);
	  }

	  function dismissAgentSetup() {
	    if (!selectedAgentAvailable) return;
	    markAgentSetupDismissed();
	    closeBlockingModal();
	  }

	  function saveDesktopAlertPreference(value: boolean) {
    setDesktopAlertsEnabled(value);
    if (value) localStorage.setItem('superclaw_desktop_alerts', '1');
    else localStorage.removeItem('superclaw_desktop_alerts');
  }

  function pluginKey(pluginId: string, version: string) {
    return `${pluginId}@${version}`;
  }

  function parsePluginKey(value: string) {
    const pivot = value.lastIndexOf('@');
    if (pivot <= 0) return null;
    return { pluginId: value.slice(0, pivot), version: value.slice(pivot + 1) };
  }

  function pluginCatalogTitle(item: PluginCatalogItem) {
    return item.name[locale] || item.name.en;
  }

  function pluginCatalogSummary(item: PluginCatalogItem) {
    return item.summary[locale] || item.summary.en;
  }

  function pluginCatalogIsInstalled(item: PluginCatalogItem) {
    return (
      item.source === 'local' ||
      installedPluginKeys.has(pluginKey(item.plugin_id, item.version)) ||
      // Overlay Node S4 installs (kind-aware) so a remote workshop card reads as installed —
      // without leaking into the cache-only installedPluginKeys the legacy panels consume.
      nodeInstalledByIdentity.has(catalogIdentityKey(item))
    );
  }

  function pluginCatalogSourceLabel(item: PluginCatalogItem) {
    if (item.trust && catalogContract?.copy?.trust?.[item.trust]) return catalogContract.copy.trust[item.trust];
    if (item.trust) return item.trust;
    if (item.source === 'local') return t('Plugin catalog local source');
    if (item.source === 'mock') return t('Plugin catalog mock source');
    return t('Plugin catalog server source');
  }

  // Presentation-only classification of a catalog entry into one of the three
  // source families surfaced as badges in the workshop. The authoritative input
  // is the kernel-supplied, verification-derived `trust` state (official/
  // developer/local/untrusted); this helper only chooses how to render that
  // existing verdict and never fabricates a stronger one. fail-closed: a revoked
  // or untrusted entry shows no badge, and the "official" tone is ONLY ever
  // emitted when the kernel itself stamped trust === 'official' (root-signed,
  // first-party). The trust-absent fallback (legacy /v1/plugins rows that
  // pre-date the catalog contract) deliberately never claims 'official'.
  const officialBadge = { tone: 'official' as const, label: t('Plugin catalog source official') };
  const developerBadge = { tone: 'developer' as const, label: t('Plugin catalog source developer') };
  const localBadge = { tone: 'local' as const, label: t('Plugin catalog source local') };
  function pluginCatalogSourceBadge(
    item: PluginCatalogItem,
  ): { tone: 'official' | 'developer' | 'local'; label: string } | null {
    if (item.revoked) return null;
    const trust = item.trust;
    if (trust === 'untrusted') return null;
    if (trust === 'official') return officialBadge;
    if (trust === 'developer') return developerBadge;
    if (trust === 'local') return localBadge;
    if (trust) return null; // unknown/future trust state — fail closed, no badge.
    // Trust-absent fallback (legacy plugin-view rows). We cannot prove first-party
    // root signing without the kernel trust state, so we never upgrade to
    // 'official' here: local cache → local; a verified registry upload → at most
    // 'developer'; everything else (mock/server/unverified) → no badge.
    if (item.source === 'local') return localBadge;
    if (item.source === 'registry' && item.verified) return developerBadge;
    return null;
  }

  function capabilityStatusLabel(value: string | null | undefined, options: { revoked?: boolean; approved?: boolean } = {}) {
    const normalized = (value ?? '').toLowerCase();
    if (options.revoked || normalized.includes('revoked')) return t('Capability revoked');
    if (['rejected', 'failed', 'denied'].includes(normalized)) return t('Capability rejected');
    if (['pending', 'pending_review', 'review', 'draft', 'created', 'submitted'].includes(normalized)) return t('Capability pending review');
    if (options.approved || ['approved', 'verified', 'published', 'active', 'accepted'].includes(normalized)) {
      return t('Capability approved');
    }
    return value || (options.approved ? t('Capability approved') : t('Capability pending review'));
  }

  function capabilityStatusTone(value: string | null | undefined, options: { revoked?: boolean; approved?: boolean } = {}) {
    const normalized = (value ?? '').toLowerCase();
    if (options.revoked || normalized.includes('revoked') || ['rejected', 'failed', 'denied'].includes(normalized)) return 'bad';
    if (options.approved || ['approved', 'verified', 'published', 'active', 'accepted'].includes(normalized)) return 'good';
    if (['pending', 'pending_review', 'review', 'draft', 'created', 'submitted'].includes(normalized)) return 'warn';
    return 'neutral';
  }

  function shortDigest(value: string | null | undefined) {
    if (!value) return null;
    const trimmed = value.trim();
    if (trimmed.length <= 22) return trimmed;
    const [algorithm, digest] = trimmed.includes(':') ? trimmed.split(':', 2) : ['', trimmed];
    const shortHash = `${digest.slice(0, 12)}...${digest.slice(-6)}`;
    return algorithm ? `${algorithm}:${shortHash}` : shortHash;
  }

  function pluginCatalogInstallBlockedReason(item: PluginCatalogItem) {
    if (item.kind === 'company' || item.instantiable === false) return t('Plugin catalog not instantiable');
    if (item.revoked) return 'Install blocked by catalog revocation.';
    if (item.trust && catalogContract?.install_blocking?.[item.trust]) return t('Plugin catalog untrusted block');
    if (item.namespace_reserved && item.trust !== 'official') {
      return t('Plugin catalog untrusted block');
    }
    // GitHub-backed plugins install directly from a public release; not blocked by
    // the registry/mock gate. Entitlement/login is enforced later at invocation.
    if (githubBackedIds.has(item.plugin_id)) return null;
    // Workshop capabilities with a configured distribution install via download +
    // official-co-signature/digest verification (install-workshop). They are no
    // longer discovery-only, so they skip ONLY the "coming soon" gate below — they
    // STILL honor the governance revocation feed (the kernel re-checks revocation at
    // install too). Registry-only requirements (trust root configured, entitlement
    // sync) do not apply to the co-signature-verified workshop path.
    if (workshopInstallableIds.has(pluginKey(item.plugin_id, item.version))) {
      const workshopRevoked = (pluginRevocations?.revoked ?? []).find(
        (revocation) => revocation.plugin_id === item.plugin_id && (!revocation.version || revocation.version === item.version),
      );
      if (workshopRevoked) return `Install blocked by revocation: ${workshopRevoked.reason}.`;
      return null;
    }
    if (item.source !== 'registry') return t('Plugin coming soon');
    if (!pluginStatus?.verification.public_key_configured) return 'Configure the plugin trust root before installing registry packages.';
    const revoked = (pluginRevocations?.revoked ?? []).find(
      (revocation) => revocation.plugin_id === item.plugin_id && (!revocation.version || revocation.version === item.version),
    );
    if (revoked) return `Install blocked by revocation: ${revoked.reason}.`;
    if (
      item.entitlement_required &&
      !pluginEntitlements.some(
        (entitlement) => entitlement.plugin_id === item.plugin_id && (!entitlement.version || entitlement.version === item.version),
      )
    ) {
      return 'Sync a valid entitlement for this plugin before workshop install.';
    }
    return null;
  }

  function installPluginCatalogItem(item: PluginCatalogItem) {
    // Company has its own instantiate flow (proposal->review->commit); never the
    // plugin install pipeline (no domain pollution). A non-instantiable item is inert.
    if (item.kind === 'company') return;
    // Red line: a skill (kind or skill_origin) is NEVER installed via the plugin
    // pipeline from ANY catalog entry point (github/workshop/registry below) — this is
    // the catalog-side counterpart to the installRegistryPlugin guard.
    if (!isPluginInstallable(item)) return;
    if (item.instantiable === false) return;
    if (githubBackedIds.has(item.plugin_id)) {
      void installPluginFromGithub(item.plugin_id, item.version);
      return;
    }
    if (workshopInstallableIds.has(pluginKey(item.plugin_id, item.version))) {
      void installPluginFromWorkshop(item.plugin_id, item.version);
      return;
    }
    if (item.source !== 'registry') return;
    setSelectedRegistryPluginKey(pluginKey(item.plugin_id, item.version));
    void installRegistryPlugin(item.plugin_id, item.version);
  }

  // D3 PR-5: the per-kind instantiable verb for company is "may be offered to
  // proposal-mode bootstrap" (contract `instantiable_semantics.company`). The button is
  // enabled iff the kernel-derived `instantiable` field is true; the disabled reason is
  // contract-driven, never a client trust rule (developer/untrusted => disabled).
  function companyInstantiateDisabledReason(item: PluginCatalogItem): string | null {
    if (item.instantiable === true) return null;
    if (item.revoked) return catalogContract?.copy?.company_untrusted_disabled ?? t('Plugin catalog not instantiable');
    if (item.trust === 'developer') {
      return catalogContract?.copy?.company_developer_disabled ?? t('Plugin catalog not instantiable');
    }
    if (item.trust === 'untrusted') {
      return catalogContract?.copy?.company_untrusted_disabled ?? t('Plugin catalog not instantiable');
    }
    return t('Plugin catalog not instantiable');
  }

  async function startCompanyInstantiate(item: PluginCatalogItem) {
    if (item.kind !== 'company' || item.instantiable !== true) return;
    setCompanyInstantiate({ item, phase: 'proposing', proposal: null, result: null, error: null });
    try {
      // Dry-run: the kernel resolves the cataloged company id -> its local source and
      // runs the verify-before-instantiate gate; proposal mode writes NOTHING.
      const proposal = (await readJson('/api/team/bootstrap', {
        method: 'POST',
        body: JSON.stringify({ company_catalog_id: item.plugin_id, company_version: item.version, mode: 'proposal' }),
      })) as Record<string, unknown>;
      setCompanyInstantiate({ item, phase: 'review', proposal, result: null, error: null });
    } catch (error) {
      const detail = (error as { detail?: string }).detail ?? String(error);
      setCompanyInstantiate({ item, phase: 'review', proposal: null, result: null, error: detail });
    }
  }

  async function confirmCompanyInstantiate() {
    const current = companyInstantiate;
    if (!current || current.phase !== 'review' || !current.proposal) return;
    setCompanyInstantiate({ ...current, phase: 'committing', error: null });
    try {
      // Commit through the SAME kernel path: high-risk proposals park at a human
      // approval (no state written); clean ones materialize transactionally.
      const result = (await readJson('/api/team/bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          company_catalog_id: current.item.plugin_id,
          company_version: current.item.version,
          mode: 'commit',
        }),
      })) as Record<string, unknown>;
      setCompanyInstantiate({ ...current, phase: 'done', result, error: null });
    } catch (error) {
      const detail = (error as { detail?: string }).detail ?? String(error);
      setCompanyInstantiate({ ...current, phase: 'review', error: detail });
    }
  }

  function closeCompanyInstantiate() {
    setCompanyInstantiate(null);
  }

  // ----- Unified workshop capability card (Codex-style) ---------------------
  // Presentation-only: projects the three capability shapes onto one card model
  // and reuses the EXISTING handlers (install / instantiate / configure /
  // uninstall / use-in-chat). The trust→badge decision stays fail-closed.

  // Plugin/company: derive the verified-badge tone from the kernel trust verdict
  // (pluginCatalogSourceBadge). Only 'official'/'developer' light a badge; 'local'
  // and the trust-absent fallback render NO badge (user spec: no badge = local/
  // unsigned). The official verdict is never fabricated here — it can only come
  // from pluginCatalogSourceBadge, whose official path requires trust==='official'.
  function workshopVerifiedBadge(
    item: PluginCatalogItem,
  ): { tone: 'official' | 'developer'; label: string } | null {
    const badge = pluginCatalogSourceBadge(item);
    if (!badge) return null;
    if (badge.tone === 'official') return { tone: 'official', label: badge.label };
    if (badge.tone === 'developer') return { tone: 'developer', label: badge.label };
    return null;
  }

  // Native skill: same fail-closed mapping over its labels/trust. A revoked or
  // explicitly-untrusted skill never shows a verified mark; only an 'official'
  // (kernel/curated) skill goes green and a 'reviewed'/'developer' one goes blue.
  function nativeSkillVerifiedBadge(
    skill: NativeSkillRecord,
  ): { tone: 'official' | 'developer'; label: string } | null {
    // fail-closed: the verified badge reflects ONLY the kernel-derived `trust`
    // verdict, never the skill-store `label`. A developer-supplied / self-signed
    // skill can carry an 'official'/'reviewed' LABEL without root-official trust;
    // lighting a green badge off a label would forge a verification mark. Labels
    // still render as plain-text chips on the detail page (information preserved,
    // trust claim not).
    if (skill.labels.includes('revoked')) return null;
    const trust = (skill.trust ?? '').toLowerCase();
    if (trust === 'official') return { tone: 'official', label: t('Plugin catalog source official') };
    if (trust === 'developer') return { tone: 'developer', label: t('Plugin catalog source developer') };
    return null;
  }

  function catalogItemCardModel(rawItem: PluginCatalogItem): WorkshopCardModel {
    // Enrich ANY card that matches a Node S4 install (remote marketplace card OR local card) with
    // its origin + configurable, so the manage menu routes uninstall to the right store and hides
    // Configure for a Node-landed capability (which has no Python-cache config surface → 404).
    // The local installed cards already carry these (nodeCapToCatalogItem); this also covers the
    // remote marketplace card that was overlaid as installed.
    const item = enrichCardItemWithNodeInstall(rawItem, nodeInstalledByIdentity);
    const badge = workshopVerifiedBadge(item);
    return {
      // Include origin so a cache and a Node card for the same identity get distinct React keys.
      key: `${item.source}:${item.origin ?? 'cache'}:${catalogIdentityKey(item)}`,
      kind: item.kind === 'company' ? 'company' : 'plugin',
      title: pluginCatalogTitle(item),
      summary: pluginCatalogSummary(item),
      logoUrl: item.logo_url,
      icon: item.icon,
      verifiedTone: badge?.tone ?? null,
      verifiedLabel: badge?.label ?? '',
      installed: pluginCatalogIsInstalled(item),
      item,
    };
  }

  function nativeSkillCardModel(skill: NativeSkillRecord): WorkshopCardModel {
    const badge = nativeSkillVerifiedBadge(skill);
    return {
      key: `skill:${skill.id}`,
      kind: 'skill',
      title: skill.name,
      summary: skill.summary,
      icon: 'developer',
      verifiedTone: badge?.tone ?? null,
      verifiedLabel: badge?.label ?? '',
      installed: true,
      skill,
    };
  }

  function openCapabilityDetail(model: WorkshopCardModel, authoringAllowed: boolean) {
    // Reset BOTH menus so neither lingers stale on the next page. Critically, a
    // lingering LIST kebab (whose anchor card unmounts when the detail page replaces
    // the grid) could otherwise fire "uninstall" against the PREVIOUS card's plugin.
    setWorkshopDetailMenuOpen(false);
    setCardMenuModel(null);
    if (model.kind === 'skill' && model.skill) {
      setWorkshopDetail({ kind: 'skill', skill: model.skill, authoringAllowed });
    } else if (model.item) {
      setWorkshopDetail({
        kind: model.kind === 'company' ? 'company' : 'plugin',
        item: model.item,
        authoringAllowed,
      });
    }
  }

  function closeCapabilityDetail() {
    setWorkshopDetailMenuOpen(false);
    setWorkshopDetail(null);
  }

  // "Use in chat": surface navigation only. Jump to the chat surface and, for a
  // skill, pre-insert the `@skill:<slug>` TEXT token the kernel already parses
  // (no new channel). Plugins are auto-available to the backend runtime once
  // installed, and a company has its own governed instantiate flow — so for those
  // we only focus the composer. Never writes kernel state.
  function useCapabilityInChat(model: WorkshopCardModel) {
    setCardMenuModel(null);
    setWorkshopDetail(null);
    setWorkspaceSurface('chat');
    exitComposerHistoryBrowse();
    setComposerTrigger(null);
    if (model.kind === 'skill' && model.skill) {
      const token = `@skill:${model.skill.slug}`;
      setPrompt((current) => {
        const base = current.replace(/[ \t]+$/, '');
        return base ? `${base} ${token} ` : `${token} `;
      });
    }
    // setSelectionRange clamps an out-of-range index to the text end, so this
    // lands the caret after whatever the composer now holds.
    focusComposer(Number.MAX_SAFE_INTEGER);
  }

  // The single right-side action on a list card. `authoringAllowed=false` (the
  // read-only Overview) suppresses install/instantiate authoring entirely; only
  // the use-in-chat NAVIGATION (which writes nothing) is offered there. This
  // keeps the Overview a read-only birds-eye view while still unifying the look.
  type WorkshopCardAction = {
    kind: 'use-in-chat' | 'install' | 'instantiate';
    label: string;
    title: string;
    ariaLabel: string;
    onClick: () => void;
    disabled: boolean;
    busy: boolean;
  };
  function workshopCardPrimaryAction(
    model: WorkshopCardModel,
    opts: { authoringAllowed: boolean },
  ): WorkshopCardAction | null {
    // Installed skill/plugin => "use in chat" (navigation, allowed everywhere).
    if (model.installed && (model.kind === 'skill' || model.kind === 'plugin')) {
      return {
        kind: 'use-in-chat',
        label: t('Use in chat'),
        title: t('Use in chat'),
        ariaLabel: `${t('Use in chat')} ${model.title}`,
        onClick: () => useCapabilityInChat(model),
        disabled: false,
        busy: false,
      };
    }
    if (!opts.authoringAllowed) return null;
    // Company template => governed instantiate flow (proposal->review->commit).
    if (model.kind === 'company' && model.item) {
      const disabledReason = companyInstantiateDisabledReason(model.item);
      // In-flight guard (parity with the old row): disable + spin while THIS
      // company's proposal/commit is running so the button can't be re-fired.
      const inFlight =
        companyInstantiate?.item.plugin_id === model.item.plugin_id &&
        companyInstantiate?.item.version === model.item.version &&
        (companyInstantiate.phase === 'proposing' || companyInstantiate.phase === 'committing');
      const cta = catalogContract?.copy?.company_instantiate_cta ?? t('Plugin catalog company template');
      return {
        kind: 'instantiate',
        label: disabledReason ?? cta,
        title: disabledReason ?? cta,
        ariaLabel: `${cta} ${model.title}`,
        onClick: () => void startCompanyInstantiate(model.item!),
        disabled: disabledReason !== null || inFlight,
        busy: inFlight,
      };
    }
    // Not-installed plugin => install. Skill-origin rows are NEVER installed via
    // the plugin pipeline (red line) and surface no install button — fail-closed.
    if (model.kind === 'plugin' && model.item && !model.item.skill_origin) {
      const blocked = pluginCatalogInstallBlockedReason(model.item);
      // In-flight guard (parity with the old row): disable + spin while THIS
      // plugin's install is running to prevent re-fire / concurrent races.
      const busy = pluginActionBusy === pluginKey(model.item.plugin_id, model.item.version);
      return {
        kind: 'install',
        label: t('Plugin install action'),
        title: blocked ?? t('Plugin install action'),
        ariaLabel: `${t('Plugin install action')} ${model.title}`,
        onClick: () => installPluginCatalogItem(model.item!),
        disabled: blocked !== null || busy,
        busy,
      };
    }
    return null;
  }

  function renderWorkshopCardAction(action: WorkshopCardAction) {
    const icon = action.busy ? (
      <LoaderCircle size={15} className="spin" aria-hidden="true" />
    ) : action.kind === 'use-in-chat' ? (
      <MessageSquare size={15} aria-hidden="true" />
    ) : action.kind === 'instantiate' ? (
      <Sparkles size={15} aria-hidden="true" />
    ) : (
      <Plus size={15} aria-hidden="true" />
    );
    return (
      <button
        type="button"
        className={`workshop-card-primary ${action.kind}`}
        onClick={action.onClick}
        disabled={action.disabled}
        title={action.title}
        aria-label={action.ariaLabel}
      >
        {icon}
        <span>{action.label}</span>
      </button>
    );
  }

  function renderWorkshopCard(model: WorkshopCardModel, opts: { authoringAllowed: boolean }) {
    const action = workshopCardPrimaryAction(model, opts);
    // Owner decision: EVERY installed plugin card gets a quick uninstall kebab —
    // including the Overview. (Read-only there only bars INSTALLING new capabilities
    // / instantiating companies, which stays gated in workshopCardPrimaryAction; it
    // does not bar removing something the user already installed.) Skills/companies
    // have no plugin-uninstall path, so the kebab is plugin-only.
    const canCardManage = model.kind === 'plugin' && model.installed && !!model.item;
    return (
      <article className={`workshop-card ${model.installed ? 'installed' : ''}`} key={model.key}>
        <button
          type="button"
          className="workshop-card-main"
          onClick={() => openCapabilityDetail(model, opts.authoringAllowed)}
          // A button's aria-label overrides its subtree, so the inner VerifiedBadge
          // aria-label would be lost — fold the trust label in so a screen-reader
          // user still hears "official"/"developer" on the list.
          aria-label={`${t('Workshop open detail')}: ${model.title}${model.verifiedLabel ? `, ${model.verifiedLabel}` : ''}`}
        >
          {/* Logo is decorative (aria-hidden) and the title is shown right next to
              it — pass an empty sr-only label so the title text isn't duplicated
              into the accessibility tree / test queries. */}
          <PluginLogoMark
            className="workshop-card-logo"
            logoUrl={model.logoUrl}
            icon={model.icon}
            label=""
            size={22}
          />
          <span className="workshop-card-copy">
            <span className="workshop-card-title">
              <span className="workshop-card-name">{model.title}</span>
              {model.verifiedTone ? (
                <VerifiedBadge tone={model.verifiedTone} label={model.verifiedLabel} size={14} />
              ) : null}
            </span>
            <span className="workshop-card-summary">{model.summary}</span>
          </span>
        </button>
        {action || canCardManage ? (
          <div className="workshop-card-actions">
            {action ? renderWorkshopCardAction(action) : null}
            {canCardManage ? (
              <button
                type="button"
                className="workshop-card-kebab"
                aria-label={`${t('Workshop more actions')} ${model.title}`}
                aria-haspopup="menu"
                aria-expanded={cardMenuModel?.key === model.key}
                onClick={(event) => {
                  cardMenuAnchorRef.current = event.currentTarget;
                  setCardMenuModel((prev) => (prev?.key === model.key ? null : model));
                }}
              >
                <MoreHorizontal size={16} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}
      </article>
    );
  }

  function renderWorkshopGrid(
    models: WorkshopCardModel[],
    opts: { authoringAllowed: boolean; emptyLabel: string },
  ) {
    if (!models.length) {
      return <p className="workshop-grid-empty">{opts.emptyLabel}</p>;
    }
    return (
      <div className="workshop-card-grid">
        {models.map((model) => renderWorkshopCard(model, { authoringAllowed: opts.authoringAllowed }))}
      </div>
    );
  }

  // Codex-style capability detail sub-page. Every action it offers routes through
  // the SAME existing handler the list used (install / instantiate / use-in-chat /
  // configure / uninstall) — the page adds no new capability semantics, it only
  // gives those existing actions a roomier home + surfaces signature provenance.
  function renderCapabilityDetail(target: WorkshopDetailTarget) {
    const model =
      target.kind === 'skill' ? nativeSkillCardModel(target.skill) : catalogItemCardModel(target.item);
    const item = target.kind === 'skill' ? null : target.item;
    const skill = target.kind === 'skill' ? target.skill : null;
    // Inherit the source surface's read-only context: a capability opened from the
    // read-only Overview keeps authoringAllowed=false, so the detail page offers no
    // install/instantiate authoring and no configure/uninstall — only use-in-chat
    // navigation (read-only follows the capability, no escalation via routing).
    const action = workshopCardPrimaryAction(model, { authoringAllowed: target.authoringAllowed });
    // Configure/uninstall only apply to an INSTALLED plugin (skills are projected,
    // companies use the instantiate flow) AND only when authoring is allowed —
    // fail-closed: no manage menu from the read-only Overview.
    const canManage = target.authoringAllowed && model.kind === 'plugin' && model.installed && item !== null;

    const metaParts: string[] = [];
    if (item) {
      if (item.runtime) metaParts.push(item.runtime);
      if (item.version) metaParts.push(item.version);
    }
    if (skill) {
      if (skill.version) metaParts.push(skill.version);
      if (skill.source) metaParts.push(skill.source);
    }
    if (model.verifiedLabel) metaParts.push(model.verifiedLabel);

    const trustLabel = item ? pluginCatalogSourceLabel(item) : skill?.trust ?? null;
    const signer = item?.signer_class ?? null;
    const version = item?.version ?? skill?.version ?? null;
    const digest = shortDigest(item?.package_digest ?? skill?.package_digest);
    const acceptance = item?.acceptance_level ?? skill?.acceptance_level ?? null;
    const scriptsAndAssets = skill ? [...skill.scripts, ...skill.assets] : [];
    // Review lifecycle status (approved / pending / revoked) — a governance signal
    // distinct from trust. The compact card drops the status pill; it surfaces here.
    const lifecycleStatus = item
      ? item.capability_status ?? item.status ?? (item.revoked ? 'revoked' : 'pending')
      : skill?.capability_status ?? skill?.status;
    const lifecycleLabel = capabilityStatusLabel(lifecycleStatus, {
      approved: skill ? skill.labels.includes('official') || skill.labels.includes('reviewed') : undefined,
      revoked: item?.revoked || skill?.labels.includes('revoked'),
    });

    return (
      <section className="workshop-detail" aria-label={model.title}>
        <button type="button" className="workshop-detail-back" onClick={closeCapabilityDetail}>
          <ArrowLeft size={16} aria-hidden="true" />
          <span>{t('Workshop back')}</span>
        </button>
        <header className="workshop-detail-head">
          <PluginLogoMark
            className="workshop-detail-logo"
            logoUrl={model.logoUrl}
            icon={model.icon}
            label=""
            size={30}
          />
          <div className="workshop-detail-headmain">
            <div className="workshop-detail-title">
              <h2>{model.title}</h2>
              {model.verifiedTone ? (
                <VerifiedBadge tone={model.verifiedTone} label={model.verifiedLabel} size={18} />
              ) : null}
            </div>
            {metaParts.length ? <p className="workshop-detail-sub">{metaParts.join(' · ')}</p> : null}
          </div>
          <div className="workshop-detail-actions">
            {action ? renderWorkshopCardAction(action) : null}
            {canManage ? (
              <>
                <button
                  ref={workshopDetailMenuRef}
                  type="button"
                  className="workshop-detail-kebab"
                  aria-label={t('Workshop more actions')}
                  aria-haspopup="menu"
                  aria-expanded={workshopDetailMenuOpen}
                  onClick={() => setWorkshopDetailMenuOpen((open) => !open)}
                >
                  <MoreHorizontal size={18} aria-hidden="true" />
                </button>
                <Popover
                  open={workshopDetailMenuOpen}
                  anchorRef={workshopDetailMenuRef}
                  ariaLabel={t('Workshop more actions')}
                  className="workshop-detail-menu"
                  onClose={() => setWorkshopDetailMenuOpen(false)}
                >
                  {item!.configurable === false ? null : (
                    <button
                      type="button"
                      className="workshop-detail-menu-item"
                      onClick={() => {
                        setWorkshopDetailMenuOpen(false);
                        openPluginConfiguration(item!.plugin_id, item!.version);
                      }}
                    >
                      <Settings2 size={16} aria-hidden="true" />
                      <span>{t('Plugin configure action')}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="workshop-detail-menu-item danger"
                    onClick={() => {
                      setWorkshopDetailMenuOpen(false);
                      void uninstallPlugin(item!.plugin_id, item!.version, item!.origin, item!.native_key);
                    }}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                    <span>{t('Uninstall plugin')}</span>
                  </button>
                </Popover>
              </>
            ) : null}
          </div>
        </header>
        <p className="workshop-detail-desc">{model.summary}</p>
        {skill && skill.labels.length ? (
          <div className="workshop-detail-labels" aria-label="Skill labels">
            {NATIVE_SKILL_LABELS.filter((label) => skill.labels.includes(label)).map((label) => (
              <span
                className={`skill-label-badge skill-label-${label.replace(/[^a-z0-9-]+/g, '-')}`}
                key={label}
              >
                {label}
              </span>
            ))}
            {skill.executable ? (
              <span className="skill-label-badge skill-label-executable">
                <TerminalSquare size={13} aria-hidden="true" />
                {t('Skill executable warning')}
              </span>
            ) : null}
          </div>
        ) : null}
        {scriptsAndAssets.length ? (
          <div className="workshop-detail-section">
            <h3>{t('Workshop detail scripts')}</h3>
            <p className="workshop-detail-scripts">{scriptsAndAssets.join(', ')}</p>
          </div>
        ) : null}
        <div className="workshop-detail-section">
          <h3>{t('Workshop detail provenance')}</h3>
          <dl className="workshop-detail-meta">
            <div>
              <dt>{t('Workshop detail status')}</dt>
              <dd>{lifecycleLabel}</dd>
            </div>
            {trustLabel ? (
              <div>
                <dt>{t('Workshop detail trust')}</dt>
                <dd>{trustLabel}</dd>
              </div>
            ) : null}
            {signer ? (
              <div>
                <dt>{t('Workshop detail signer')}</dt>
                <dd>{signer}</dd>
              </div>
            ) : null}
            {acceptance ? (
              <div>
                <dt>{t('Acceptance level label')}</dt>
                <dd>{acceptance}</dd>
              </div>
            ) : null}
            {version ? (
              <div>
                <dt>{t('Workshop detail version')}</dt>
                <dd>{version}</dd>
              </div>
            ) : null}
            {digest ? (
              <div>
                <dt>{t('Capability digest')}</dt>
                <dd className="workshop-detail-digest">{digest}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      </section>
    );
  }

  async function ensureDesktopRuntimeSession() {
    if (!desktopInvoke) return desktopSession;
    if (desktopSession?.handle?.base_url) return desktopSession;
    if (desktopRuntimeStartPromiseRef.current) return desktopRuntimeStartPromiseRef.current;
    setDesktopStatus('starting');
    // Definite-assignment `!`: the IIFE's own `finally` references `startPromise`, which TS
    // can't prove is assigned at the self-reference (TS2454) even though it always is by the
    // time the async body's finally runs.
    let startPromise!: Promise<DesktopRuntimeSession | null>;
    startPromise = (async () => {
      try {
        // Startup tracing: stamp the moment we hand off to the desktop runtime
        // bootstrap. This covers BOTH IPCs in the Promise.all below — the cheap
        // `desktop_shell_info` and the (synchronous, main-thread-blocking)
        // `desktop_runtime_start` — so the label is "bootstrap", not "runtime start".
        // The span from here to `runtime-connected` is the backend cold-start the
        // user sees as "frozen".
        recordStartupMark('runtime-bootstrap-sent');
        const [info, session] = await Promise.all([readDesktopShellInfo(desktopInvoke), startDesktopRuntime(desktopInvoke)]);
        setDesktopShellInfo(info);
        setDesktopSession(session);
        if (session.ok && session.handle?.base_url) {
          // Desktop D1: point the board + apps/web's own board-data reads at the
          // Python front door's loopback ORIGIN. The window stays on tauri://localhost
          // (IPC stays local-origin-only, the app's security boundary is preserved);
          // only DATA urls go cross-origin to the front door. Set BEFORE the board
          // renders so its apiBase / WebSocket / /_plugins URLs resolve to the loopback
          // front door (the runtime picked a random port, so this is runtime-only).
          try {
            const frontDoorOrigin = new URL(session.handle.base_url).origin;
            (globalThis as { __SUPERCLAW_PY_ORIGIN__?: string }).__SUPERCLAW_PY_ORIGIN__ = frontDoorOrigin;
            (globalThis as { __SUPERCLAW_REFRESH_API_BASE__?: () => string }).__SUPERCLAW_REFRESH_API_BASE__?.();
          } catch {
            /* malformed base_url -> leave same-origin defaults */
          }
          desktopStartRetriesRef.current = 0;
          recordStartupMark('runtime-connected');
          setDesktopStatus('connected');
          const runtimePayload = session.status?.runtime;
          if (runtimePayload && typeof runtimePayload === 'object') {
            setRuntimeStatus(runtimePayload as RuntimeStatusPayload);
          }
          setMessage('');
          return session;
        }
        setDesktopStatus('failed');
        setMessage('desktop runtime start returned no handle');
        return null;
      } catch (error) {
        const detail = String(error);
        // The shell's re-entrancy guard rejected because a start is already in
        // flight (e.g. a reload during the cold boot spun up a fresh frontend while
        // the first start kept running in the persistent shell process). That first
        // start will bring the runtime up — so don't surface a failure: stay in
        // 'starting' (splash keeps animating) and retry shortly. Once the in-flight
        // start finishes and clears the guard, the retry attaches to the now-running
        // sidecar. The guard is always cleared in Rust, so this converges.
        if (detail.includes('already in progress')) {
          // Bounded retry: the shell's re-entrancy guard always clears once the
          // in-flight start's blocking work completes, so this converges within a
          // boot's worth of attempts. The cap must comfortably exceed the longest
          // LEGITIMATE cold start, or a reload during a slow boot would prematurely
          // give up while the original start is still finishing. The shell's CLI
          // wrapper hard-caps a start at 120s (DESKTOP_CLI_COMMAND_TIMEOUT_SECONDS;
          // backend default boot timeout is 60s, plus up to ~13s watchdog reap), so
          // budget past 120s with margin: 240 * 600ms ≈ 144s. Beyond that the start
          // has itself errored and cleared the guard, so falling through to the
          // failure surface is correct.
          const MAX_START_RETRIES = 240;
          if (desktopStartRetriesRef.current < MAX_START_RETRIES) {
            desktopStartRetriesRef.current += 1;
            window.setTimeout(() => {
              void connectDesktopRuntime();
            }, 600);
            return null;
          }
          desktopStartRetriesRef.current = 0;
          setDesktopSession(null);
          setDesktopStatus('failed');
          setMessage('desktop runtime start kept reporting busy; please relaunch the app');
          return null;
        }
        setDesktopSession(null);
        setDesktopStatus('failed');
        setMessage(`desktop runtime failed: ${detail}`);
        return null;
      } finally {
        if (desktopRuntimeStartPromiseRef.current === startPromise) {
          desktopRuntimeStartPromiseRef.current = null;
        }
      }
    })();
    desktopRuntimeStartPromiseRef.current = startPromise;
    return startPromise;
  }

  async function connectDesktopRuntime() {
    await ensureDesktopRuntimeSession();
  }

  async function disconnectDesktopRuntime() {
    if (!desktopInvoke || !desktopSession?.handle) return;
    try {
      const result = await stopDesktopRuntime(desktopInvoke, desktopSession.handle);
      setDesktopSession(null);
      setDesktopStatus('stopped');
      setRuntimeStatus(null);
      setRuns([]);
      setSelectedRun(null);
      setRunId('');
      setEvents([]);
      setEvidence(null);
      setMessage(result.stopped ? 'desktop runtime stopped' : 'desktop runtime already detached');
    } catch (error) {
      setMessage(`desktop runtime stop failed: ${String(error)}`);
    }
  }

  async function loadRuntimeStatus() {
    try {
      const data = (await readJson('/api/runtime/status')) as RuntimeStatusPayload;
      setRuntimeStatus(data);
    } catch {
      setRuntimeStatus(null);
    }
  }

  async function loadBackends() {
    try {
      const data = (await readJson('/api/backends')) as { backends?: BackendInfo[] };
      const list = data.backends ?? [];
      setBackends(list);
    } catch (error) {
      setBackends([]);
      setMessage(`backend probe failed: ${String(error)}`);
    }
  }

  async function loadHarnesses() {
    try {
      const data = (await readJson('/api/harnesses')) as { harnesses?: Record<string, HarnessInfo> };
      const values = Object.values(data.harnesses ?? {});
      setHarnesses(values);
      const selectedStillExists = values.some((item) => item.harness_id === selectedHarness);
      if (!selectedStillExists) {
        const preferred = values.find((item) => item.harness_id === 'codex') ?? values[0];
        if (preferred) setSelectedHarness(preferred.harness_id);
      }
    } catch (error) {
      setHarnesses([]);
      setMessage(`harness probe failed: ${String(error)}`);
    }
  }

  async function loadEvalHistory() {
    try {
      const data = (await readJson('/api/evals')) as { evals?: EvalReport[] };
      setEvalHistory(data.evals ?? []);
    } catch {
      setEvalHistory([]);
    }
  }

  async function loadRuntimeConfig() {
    try {
      const data = (await readJson('/api/config')) as RuntimeConfigPayload;
      setRuntimeConfig(data);
      const configuredBackend = data.entries?.some(
        (entry) => entry.name === 'backend' && (entry.persisted || entry.configured),
      );
      // One-shot initialization from the configured default. An implicit
      // schema default is not a user/runtime decision; leave first-run desktop
      // selection to live agent inventory instead of treating "claude" as an
      // "untouched" sentinel.
      if (!backendDefaultAppliedRef.current && configuredBackend && data.defaults.backend) {
        // Only adopt a persisted default that is STILL a usable composer runtime;
        // a stale/disabled default (e.g. acpx_local, now non-chat-capable) must not
        // become the selection — the inventory-driven effect picks a proper default
        // instead. If inventory hasn't loaded yet, defer (same effect handles it).
        const persistedDefault = data.defaults.backend;
        const persistedAgent = agentInventory.find((agent) => agent.name === persistedDefault);
        // Adopt the persisted default unless the inventory EXPLICITLY marks it
        // non-chat-capable (chat_tier === null, e.g. disabled acpx_local). If the
        // entry isn't in the (possibly not-yet-loaded) inventory, defer to the
        // inventory-driven effect rather than adopt a possibly-disabled default.
        if (persistedAgent && persistedAgent.chat_tier !== null) {
          backendDefaultAppliedRef.current = true;
          setSelectedBackend((previous) => previous || persistedDefault);
        }
      }
    } catch (error) {
      if (errorStatus(error) === 401) {
        setRuntimeConfig(null);
        setRuntimeConfigLoaded(true);
        return;
      }
      setMessage(`config probe failed: ${String(error)}`);
    } finally {
      setRuntimeConfigLoaded(true);
    }
  }

  function focusContextRail() {
    const target = contextRailRef.current;
    if (!target) return;
    const moveFocus = () => {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      target.focus();
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => moveFocus());
      return;
    }
    setTimeout(moveFocus, 0);
  }

  function openContextRail() {
    setWorkspaceSurface('chat');
    setRightPanelOpen(true);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => focusContextRail());
      return;
    }
    setTimeout(() => focusContextRail(), 0);
  }


  async function loadAgentControl() {
    try {
      const data = (await readJson('/api/agents')) as AgentControlPayload;
      setAgentControl(data);
    } catch (error) {
      if (errorStatus(error) === 401) {
        setAgentControl(null);
        return;
      }
      setMessage(`agent probe failed: ${String(error)}`);
    }
  }

  async function loadClawHuntLoginProbe() {
    const url = authStatus?.clawhunt.account_login_probe_url ?? '/api/auth/clawhunt/account/login-probe';
    try {
      const data = (await readJson(url)) as ClawHuntLoginProbePayload;
      setClawHuntLoginProbe(data);
      return data;
    } catch (error) {
      setClawHuntLoginProbe({
        ok: false,
        reachable: false,
        login_endpoint: false,
        base_url: authStatus?.clawhunt.base_url ?? DEFAULT_CLAWHUNT_BASE_URL,
        status_code: 0,
        detail: String(error),
        body_detail: null,
      });
      if (errorStatus(error) !== 401) setMessage(`clawhunt login server probe failed: ${String(error)}`);
      return null;
    }
  }

  async function loadAuthStatus() {
    try {
      let data = (await readJson('/api/auth/status')) as ClawHuntAuthPayload;
      setAuthStatus(data);
      try {
        const probe = (await readJson(data.clawhunt.account_login_probe_url ?? '/api/auth/clawhunt/account/login-probe')) as ClawHuntLoginProbePayload;
        setClawHuntLoginProbe(probe);
      } catch {
        setClawHuntLoginProbe(null);
      }
      if (data.clawhunt.account === 'set') {
        try {
          const agents = (await readJson('/api/auth/clawhunt/account/agents')) as ClawHuntProfilePayload;
          const accountAgents = extractClawHuntAccountAgents(agents.body);
          const defaultAgentId = accountAgents[0]?.id ?? null;
          setClawHuntAccountAgents(accountAgents);
          setSelectedClawHuntAgentId((current) => (current && accountAgents.some((agent) => agent.id === current) ? current : defaultAgentId));
          if (data.clawhunt.agent_api_key !== 'set' && defaultAgentId && !clawHuntAgentKeyAutoProvisionRef.current) {
            clawHuntAgentKeyAutoProvisionRef.current = true;
            try {
              const keyPayload = (await readJson('/api/auth/clawhunt/agent-key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agent_id: defaultAgentId, name: clawHuntAgentKeyName }),
              })) as { auth?: ClawHuntAuthPayload };
              if (keyPayload.auth) {
                data = keyPayload.auth;
                setAuthStatus(data);
              }
              invalidateAllProbes(); // auto-provisioned a relay credential — ClawWork reachability may differ
              setMessage('clawhunt account configured');
            } catch (error) {
              setMessage(`clawhunt account linked; agent key setup pending: ${String(error)}`);
            }
          }
        } catch {
          setClawHuntAccountAgents([]);
          setSelectedClawHuntAgentId(null);
        }
      } else {
        clawHuntAgentKeyAutoProvisionRef.current = false;
        setClawHuntAccountAgents([]);
        setSelectedClawHuntAgentId(null);
      }
      if (data.clawhunt.agent_api_key === 'set') {
        try {
          const profile = (await readJson('/api/auth/clawhunt/me')) as ClawHuntProfilePayload;
          setClawHuntProfile(profile);
        } catch {
          setClawHuntProfile(null);
        }
      } else {
        setClawHuntProfile(null);
      }
      if ((data.clawhunt.account === 'set' || data.clawhunt.agent_api_key === 'set') && blockingModal?.kind === 'login') {
        setBlockingModal(null);
      }
      return data;
    } catch (error) {
      if (errorStatus(error) === 401) {
        setAuthStatus(null);
        setClawHuntProfile(null);
        setClawHuntLoginProbe(null);
        setClawHuntAccountAgents([]);
        setSelectedClawHuntAgentId(null);
        return null;
      }
      setMessage(`auth probe failed: ${String(error)}`);
      return null;
    }
  }

  async function loadNativeSkills() {
    setNativeSkillsLoading(true);
    setNativeSkillsError(null);
    try {
      const payload = (await readJson('/v1/skills')) as NativeSkillStorePayload;
      setNativeSkills(nativeSkillList(payload));
      setNativeSkillsError(payload.error ?? null);
    } catch (error) {
      setNativeSkills([]);
      setNativeSkillsError(String(error));
    } finally {
      setNativeSkillsLoading(false);
    }
  }

  async function buildSkillFromPath() {
    const path = skillBuildPath.trim();
    if (!path || skillBuildBusy) return;
    setSkillBuildBusy(true);
    setSkillBuildError(null);
    setSkillBuildResult(null);
    try {
      // The kernel grades the result by provenance; the Web renders whatever
      // trust_state it returns and NEVER upgrades it (§2.3 no grade spoofing).
      const payload = (await readJson('/v1/skills/build', {
        method: 'POST',
        body: JSON.stringify({ path }),
      })) as {
        skill?: {
          plugin_id: string;
          version: string;
          package_digest: string;
          trust_state: string;
          equippable: boolean;
          signed: boolean;
        };
      };
      if (payload.skill) {
        setSkillBuildResult(payload.skill);
        setSkillBuildPath('');
      }
      // A built skill is a GOVERNED, plugin-cache skill-origin package — it
      // surfaces in the catalog / equipment universe (loadPluginControl), NOT the
      // native chat-runtime store (/v1/skills). Refresh both so the new local
      // skill is immediately visible wherever a governed skill lives (the catalog
      // and the gated equipment picker), mirroring the install flows.
      await Promise.allSettled([loadPluginControl(), loadNativeSkills()]);
    } catch (error) {
      setSkillBuildError(String(error));
    } finally {
      setSkillBuildBusy(false);
    }
  }

  async function loadSkillProjections() {
    try {
      const [contract, projections] = await Promise.all([
        readJson('/api/plugins/skills/contract'),
        readJson('/api/plugins/skills/projections'),
      ]);
      setSkillSyncContract(contract as { targets: { name: string }[] });
      setSkillProjections(projections as { records: SkillProjectionRecord[] });
    } catch (error) {
      console.error('Failed to load skill projections', error);
    }
  }

  async function syncSkills() {
    try {
      setSkillSyncBusy(true);
      const result = (await readJson('/api/plugins/skills/sync', {
        method: 'POST',
        body: JSON.stringify({}),
      })) as { written?: string[]; reclaimed?: string[]; tombstoned?: string[] };
      setMessage(
        `skills synced: ${result.written?.length ?? 0} written, ${result.reclaimed?.length ?? 0} reclaimed, ${result.tombstoned?.length ?? 0} tombstoned`,
      );
      await loadSkillProjections();
    } catch (error) {
      setMessage(`skill sync failed: ${String(error)}`);
    } finally {
      setSkillSyncBusy(false);
    }
  }

  async function unsyncSkillsForPlugin(pluginId: string) {
    try {
      setSkillSyncBusy(true);
      await readJson('/api/plugins/skills/unsync', {
        method: 'POST',
        body: JSON.stringify({ plugin_id: pluginId }),
      });
      setMessage(`skills reclaimed for ${pluginId}`);
      await loadSkillProjections();
    } catch (error) {
      setMessage(`skill unsync failed: ${String(error)}`);
    } finally {
      setSkillSyncBusy(false);
    }
  }

  async function loadPluginControl() {
    const hadCatalog =
      registryPlugins.length > 0 || catalogCompanyItems.length > 0 || marketplaceServerPlugins.length > 0 || Boolean(pluginStatus);
    if (!hadCatalog) setPluginCatalogLoading(true);
    setPluginCatalogError(null);
    const [
      statusResult,
      catalogContractResult,
      uploadContractResult,
      catalogResult,
      registryResult,
      marketplaceResult,
      revocationsResult,
      policyResult,
      githubResult,
      workshopResult,
      workshopDistributionResult,
      capabilityInstalledResult,
    ] = await Promise.allSettled([
      readJson('/api/plugins/status'),
      readJson('/api/contracts/catalog'),
      readJson('/api/contracts/capability-upload'),
      readJson('/v1/catalog'),
      readJson('/v1/plugins'),
      readJson('/api/plugins/marketplace-catalog'),
      readJson('/v1/plugins/revocations'),
      readJson('/v1/policies/runtime'),
      readJson('/api/plugins/github-catalog'),
      readJson('/api/plugins/workshop-catalog'),
      // Neutral all-kinds distribution (plugin/skill/company), via the Node S4 install path.
      readJson('/api/capabilities/distribution'),
      // Neutral installed union (Python cache + Node S4 store), origin-tagged.
      readJson('/api/capabilities/installed'),
    ]);
    if (githubResult.status === 'fulfilled') {
      const payload = githubResult.value as { plugins?: { plugin_id: string }[] };
      setGithubBackedIds(new Set((payload.plugins ?? []).map((entry) => entry.plugin_id)));
    }
    if (workshopDistributionResult.status === 'fulfilled') {
      const payload = workshopDistributionResult.value as {
        capabilities?: { kind: string; capability_id: string; version: string }[];
      };
      // This gates the PLUGIN install button (installPluginFromWorkshop posts kind:'plugin'), so
      // only plugin-kind entries belong here — a skill/company sharing an id/version must NOT make
      // a plugin card installable. Key by id@version (digest-bound to one published version).
      setWorkshopInstallableIds(
        new Set(
          (payload.capabilities ?? [])
            .filter((entry) => entry.kind === 'plugin')
            .map((entry) => pluginKey(entry.capability_id, entry.version)),
        ),
      );
    }
    if (capabilityInstalledResult.status === 'fulfilled') {
      const payload = capabilityInstalledResult.value as {
        capabilities?: NodeInstalledCapability[];
        node_available?: boolean;
      };
      // ONLY node-workshop entries; cache installs already arrive via /api/plugins/status.
      setNodeInstalledCaps((payload.capabilities ?? []).filter((c) => c && c.origin === 'node-workshop'));
      setNodeWorkshopAvailable(payload.node_available !== false);
    } else {
      setNodeInstalledCaps([]);
      setNodeWorkshopAvailable(false);
    }
    // On failure keep whatever set we had — don't clear it (parity with githubBackedIds).
    // On failure keep the seeded fallback set — don't clear it.
    if (statusResult.status === 'fulfilled') {
      setPluginStatus(statusResult.value as PluginStatusPayload);
    } else {
      setPluginStatus(null);
      if (errorStatus(statusResult.reason) !== 401) setMessage(`plugin status failed: ${String(statusResult.reason)}`);
    }
    if (catalogContractResult.status === 'fulfilled') {
      setCatalogContract(catalogContractResult.value as CatalogContractPayload);
    } else {
      setCatalogContract(null);
    }
    if (uploadContractResult.status === 'fulfilled') {
      setCapabilityUploadContract(uploadContractResult.value as CapabilityUploadContract);
    } else {
      setCapabilityUploadContract(null);
    }
    if (catalogResult.status === 'fulfilled') {
      const payload = catalogResult.value as CatalogResolutionPayload;
      const items = payload.items ?? [];
      setCatalogLiveLoaded(true);
      setRegistryPlugins(items.filter((item) => item.kind !== 'company'));
      setCatalogCompanyItems(items.filter((item) => item.kind === 'company'));
      setCatalogConflicts(payload.conflicts ?? []);
    } else if (registryResult.status === 'fulfilled') {
      const payload = registryResult.value as { plugins?: RegistryPluginInfo[] };
      setCatalogLiveLoaded(false);
      setRegistryPlugins(payload.plugins ?? []);
      setCatalogCompanyItems([]);
      setCatalogConflicts([]);
      if (errorStatus(catalogResult.reason) !== 401) setMessage(`capability catalog failed; using legacy registry: ${String(catalogResult.reason)}`);
    } else {
      setCatalogLiveLoaded(false);
      setRegistryPlugins([]);
      setCatalogCompanyItems([]);
      setCatalogConflicts([]);
      const reason = errorStatus(catalogResult.reason) !== 401 ? catalogResult.reason : registryResult.reason;
      if (errorStatus(reason) !== 401) {
        const detail = String(reason);
        setPluginCatalogError(detail);
        setMessage(`plugin registry failed: ${detail}`);
      }
    }
    // Live ClawHunt capability-workshop entries (approved/published) are the
    // real-time source; the legacy plugin marketplace feed is merged in behind
    // them. Workshop entries win on id+version collisions. When both are empty,
    // the catalog selector falls back to the static MOCK_PLUGIN_CATALOG.
    const workshopPlugins =
      workshopResult.status === 'fulfilled'
        ? ((workshopResult.value as { plugins?: MarketplaceCatalogPluginInfo[] }).plugins ?? [])
        : [];
    const legacyMarketplacePlugins =
      marketplaceResult.status === 'fulfilled'
        ? ((marketplaceResult.value as { plugins?: MarketplaceCatalogPluginInfo[] }).plugins ?? [])
        : [];
    // Kind-aware identity (same key the selector uses): a workshop skill/company
    // must NOT shadow a legacy plugin that merely shares an id@version.
    const workshopKeys = new Set(workshopPlugins.map(catalogIdentityKey));
    setMarketplaceServerPlugins([
      ...workshopPlugins,
      ...legacyMarketplacePlugins.filter((plugin) => !workshopKeys.has(catalogIdentityKey(plugin))),
    ]);
    if (
      workshopResult.status === 'rejected' &&
      marketplaceResult.status === 'rejected' &&
      errorStatus(workshopResult.reason) !== 401
    ) {
      setMessage(`capability workshop failed: ${String(workshopResult.reason)}`);
    }
    if (revocationsResult.status === 'fulfilled') {
      setPluginRevocations(revocationsResult.value as PluginRevocationPayload);
    } else {
      setPluginRevocations(null);
      if (errorStatus(revocationsResult.reason) !== 401) setMessage(`plugin revocations failed: ${String(revocationsResult.reason)}`);
    }
    if (policyResult.status === 'fulfilled') {
      setPluginPolicies(policyResult.value as PluginPolicyPayload);
    } else {
      setPluginPolicies(null);
      if (errorStatus(policyResult.reason) !== 401) setMessage(`plugin policy failed: ${String(policyResult.reason)}`);
    }
    setPluginCatalogLoading(false);
  }

  async function syncCapabilityRegistry() {
    setCatalogSyncBusy(true);
    // Remote registry sync and local view reload are decoupled on purpose: a
    // transient remote failure (offline, registry 503) must never block the
    // surface from reflecting local install/policy state — that parity with the
    // removed local-only refresh is why we DON'T setPluginCatalogError here (it
    // would tear the whole local catalog view down on a network blip) and why we
    // always loadPluginControl() regardless of the remote outcome.
    let remoteError: string | null = null;
    let remoteStatus: number | null = null;
    let payload: { ok?: boolean; detail?: string; error?: string } = {};
    try {
      payload = (await readJson('/v1/catalog/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })) as { ok?: boolean; detail?: string; error?: string };
    } catch (error) {
      remoteStatus = errorStatus(error);
      remoteError = String(error);
    }
    try {
      await loadPluginControl();
    } finally {
      // The kernel TUF trust-registry refresh (/v1/catalog/refresh) is an OPTIONAL
      // governance step. On installs without a local TUF metadata backend (e.g. the
      // packaged desktop app) it answers 503 "registry metadata backend is not
      // configured" — an EXPECTED, benign state, not a failure. The refresh the user
      // actually wants is the live catalog + ClawHunt workshop feed reload
      // (loadPluginControl above), which just ran. So a 503 must NOT surface as
      // "refresh failed"; only a genuine remote error (non-503) does.
      if (remoteError !== null && remoteStatus !== 503) {
        setMessage(`${t('Capability registry sync failed')}: ${remoteError}`);
      } else {
        setMessage(`${t('Capability registry synced')}${payload.ok === false ? `: ${payload.detail ?? payload.error ?? 'review required'}` : ''}`);
      }
      setCatalogSyncBusy(false);
    }
  }

  async function loadPluginDiagnostics() {
    try {
      const payload = (await readJson(pluginStatus?.diagnostics.status_url ?? '/api/plugins/diagnostics')) as PluginDiagnosticsPayload;
      setPluginDiagnostics(payload);
    } catch (error) {
      if (errorStatus(error) === 401) {
        setPluginDiagnostics(null);
        return;
      }
      setMessage(`plugin diagnostics failed: ${String(error)}`);
    }
  }

  async function syncSelectedPluginEntitlement() {
    if (!selectedRegistryPlugin) {
      setMessage('entitlement sync failed: no selected capability package');
      return;
    }
    if (!selectedRegistryPlugin.entitlement_required) {
      setMessage(`entitlement sync skipped: ${selectedRegistryPlugin.plugin_id} is free`);
      return;
    }
    if (!runtimeStatus?.service.version) {
      setMessage('entitlement sync failed: runtime version is not available yet');
      return;
    }
    try {
      setEntitlementSyncState('syncing');
      const payload = (await readJson('/v1/entitlements/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: entitlementDeviceId,
          runtime_version: runtimeStatus.service.version,
          plugin_ids: [selectedRegistryPlugin.plugin_id],
        }),
      })) as EntitlementSyncPayload;
      setPluginEntitlements((current) => [
        ...current.filter((item) => item.plugin_id !== selectedRegistryPlugin.plugin_id),
        ...(payload.entitlements ?? []),
      ]);
      setEntitlementSyncState('ready');
      setMessage(`entitlements synced: ${selectedRegistryPlugin.plugin_id}`);
    } catch (error) {
      setEntitlementSyncState('failed');
      setMessage(`entitlement sync failed: ${String(error)}`);
    }
  }

  async function loadPluginConfiguration(pluginId: string, version: string) {
    try {
      const data = (await readJson(
        `/api/plugins/${encodeURIComponent(pluginId)}/configuration?version=${encodeURIComponent(version)}`,
      )) as PluginConfigurationPayload;
      setPluginConfiguration(data);
      setPluginSettingDrafts(
        Object.fromEntries((data.configuration.settings ?? []).map((setting) => [setting.name, setting.value ?? setting.default ?? ''])),
      );
      setPluginSecretDrafts((current) => {
        const next = { ...current };
        for (const secret of data.configuration.secrets ?? []) {
          if (!(secret.name in next)) next[secret.name] = '';
        }
        return next;
      });
      // NOTE: do NOT blank pluginDynamicOptions here. This function re-runs on
      // every controlToken/desktopSession identity change (status polling), and
      // the dynamic scan is slow (~7s); clearing it each time would perpetually
      // wipe the list before the scan returns. loadPluginSettingOptions dedupes
      // in-flight work and only overwrites with non-empty results.
      // Eagerly populate searchable selects for settings that declare a dynamic
      // options_source (e.g. "list my Chrome profiles").
      for (const setting of data.configuration.settings ?? []) {
        if (setting.options_source?.tool) void loadPluginSettingOptions(pluginId, version, setting.name);
      }
      if (pluginId === 'dev.clawhunt.pay-switch-agent') {
        void loadPaySwitchExtensionStatus(pluginId, version, { silent: true });
      }
    } catch (error) {
      setPluginConfiguration(null);
      if (errorStatus(error) !== 401) setMessage(`plugin configuration failed: ${String(error)}`);
    }
  }

  async function loadPaySwitchExtensionStatus(
    pluginId: string,
    version: string,
    options: { silent?: boolean } = {},
  ) {
    try {
      const data = (await readJson(`/api/plugins/${encodeURIComponent(pluginId)}/configuration/action`, {
        method: 'POST',
        body: JSON.stringify({
          version,
          setting: 'chrome_profile_directory',
          action_id: 'extension_status',
        }),
      })) as { result?: PluginConfigToolResult };
      const result = data.result ?? {};
      setPluginConfigActionResults((current) => ({
        ...current,
        [pluginConfigActionResultKey('chrome_profile_directory', 'extension_status')]: result,
      }));
      if (!options.silent && result.text) setMessage(result.text);
    } catch (error) {
      if (!options.silent && errorStatus(error) !== 401) {
        setMessage(`PaySwitch Browser Relay status failed: ${String(error)}`);
      }
    }
  }

  async function loadPluginSettingOptions(
    pluginId: string,
    version: string,
    settingName: string,
    options: { force?: boolean } = {},
  ) {
    const inFlightKey = `${pluginId}@${version}:${settingName}`;
    // Dedup concurrent scans: the effect that triggers eager loads re-runs on
    // status polling, but the scan is slow — collapse duplicate requests so we
    // don't fire (and re-clear) the same 7s scan repeatedly.
    if (!options.force && pluginOptionsInFlightRef.current.has(inFlightKey)) return;
    pluginOptionsInFlightRef.current.add(inFlightKey);
    setPluginConfigBusy(`options:${settingName}`);
    setPluginOptionsError((current) => {
      if (!(settingName in current)) return current;
      const next = { ...current };
      delete next[settingName];
      return next;
    });
    try {
      const data = (await readJson(`/api/plugins/${encodeURIComponent(pluginId)}/configuration/options`, {
        method: 'POST',
        body: JSON.stringify({ version, setting: settingName }),
      })) as { options?: PluginDynamicOption[] };
      const fetched = data.options ?? [];
      setPluginDynamicOptions((current) => {
        // Never clobber a populated list with an empty result (transient scan
        // miss) unless the caller explicitly forced a refresh.
        if (fetched.length === 0 && (current[settingName]?.length ?? 0) > 0 && !options.force) return current;
        return { ...current, [settingName]: fetched };
      });
    } catch (error) {
      if (errorStatus(error) !== 401) {
        const detail = String((error as Error)?.message ?? error);
        setPluginOptionsError((current) => ({ ...current, [settingName]: detail }));
        setMessage(`load options failed (${settingName}): ${detail}`);
      }
    } finally {
      pluginOptionsInFlightRef.current.delete(inFlightKey);
      setPluginConfigBusy(null);
    }
  }

  async function runPluginConfigAction(pluginId: string, version: string, settingName: string, actionId: string | undefined, actionLabel: string) {
    setPluginConfigBusy(`action:${settingName}:${actionId ?? ''}`);
    try {
      const data = (await readJson(`/api/plugins/${encodeURIComponent(pluginId)}/configuration/action`, {
        method: 'POST',
        body: JSON.stringify({ version, setting: settingName, action_id: actionId ?? null }),
      })) as { result?: PluginConfigToolResult };
      const result = data.result ?? {};
      setPluginConfigActionResults((current) => ({
        ...current,
        [pluginConfigActionResultKey(settingName, actionId)]: result,
      }));
      if ((actionId === 'extension_status' || actionId === 'extension_install') && result.browser_extension) {
        setPluginConfigActionResults((current) => ({
          ...current,
          [pluginConfigActionResultKey(settingName, 'extension_status')]: result,
        }));
      }
      setMessage(result.text || `plugin action done: ${actionLabel}`);
      // Bind/login actions may change available options; relay status/install actions do not.
      if (actionId !== 'extension_status' && actionId !== 'extension_install') {
        await loadPluginSettingOptions(pluginId, version, settingName, { force: true });
      }
    } catch (error) {
      if (errorStatus(error) !== 401) setMessage(`plugin action failed (${actionLabel}): ${String(error)}`);
    } finally {
      setPluginConfigBusy(null);
    }
  }

  function openPluginConfiguration(pluginId: string, version: string) {
    setSelectedPluginKey(pluginKey(pluginId, version));
    setWorkspaceSurface('plugins');
    setPluginConfigModalOpen(true);
    setPluginConfigActionResults({});
    void loadPluginConfiguration(pluginId, version);
  }

  useEffect(() => {
    if (!pluginConfigModalOpen || pluginConfiguration?.plugin_id !== 'dev.clawhunt.pay-switch-agent') return undefined;
    const version = pluginConfiguration.version;
    void loadPaySwitchExtensionStatus(pluginConfiguration.plugin_id, version, { silent: true });
    const intervalId = window.setInterval(() => {
      void loadPaySwitchExtensionStatus('dev.clawhunt.pay-switch-agent', version, { silent: true });
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [pluginConfigModalOpen, pluginConfiguration?.plugin_id, pluginConfiguration?.version]);

  async function installRegistryPlugin(pluginId: string, version: string) {
    // Red line (capability-workshop): a skill-origin registry entry must NEVER be
    // installed via the plugin install flow. Refuse at the DATA layer so every entry
    // point (any tab / any panel) is covered — not merely by hiding UI affordances.
    const target = registryPlugins.find(
      (plugin) => plugin.plugin_id === pluginId && plugin.version === version,
    );
    if (target && !isPluginInstallable(target)) {
      setMessage(`refused: ${pluginId}@${version} is a skill, not installable via the plugin flow`);
      return;
    }
    try {
      setPluginActionBusy(pluginKey(pluginId, version));
      await readJson('/api/plugins/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugin_id: pluginId, version }),
      });
      setSelectedPluginKey(pluginKey(pluginId, version));
      setWorkspaceSurface('plugins');
      setPluginConfigModalOpen(true);
      setMessage(`plugin installed: ${pluginId}@${version}`);
      await Promise.allSettled([loadPluginControl(), loadRuntimeStatus()]);
      await loadPluginConfiguration(pluginId, version);
    } catch (error) {
      setMessage(`plugin install failed: ${String(error)}`);
    } finally {
      setPluginActionBusy('');
    }
  }

  async function installPluginFromGithub(pluginId: string, version: string) {
    try {
      setPluginActionBusy(pluginKey(pluginId, version));
      setMessage(`Downloading ${pluginId} from GitHub…`);
      await readJson('/api/plugins/install-github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugin_id: pluginId, version }),
      });
      setSelectedPluginKey(pluginKey(pluginId, version));
      setWorkspaceSurface('plugins');
      setPluginConfigModalOpen(true);
      setMessage(`plugin installed from GitHub: ${pluginId}@${version}`);
      await Promise.allSettled([loadPluginControl(), loadRuntimeStatus()]);
      await loadPluginConfiguration(pluginId, version);
    } catch (error) {
      setMessage(`plugin install failed: ${String(error)}`);
    } finally {
      setPluginActionBusy('');
    }
  }

  async function installPluginFromWorkshop(pluginId: string, version: string) {
    try {
      setPluginActionBusy(pluginKey(pluginId, version));
      setMessage(`Downloading ${pluginId} from the capability workshop…`);
      // Neutral install: the kernel bridge re-verifies the official co-signature, binds the bytes
      // to the co-signed digest, and LANDS via the co-launched Node S4 super-workshop (browser
      // only names the capability — no URL -> no SSRF). Returns the kernel envelope.
      const result = (await readJson('/api/capabilities/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capability_id: pluginId, version, kind: 'plugin' }),
      })) as { capability_id?: string; version?: string };
      const installedId = result.capability_id ?? pluginId;
      const installedVersion = result.version ?? version;
      setWorkspaceSurface('plugins');
      setMessage(`installed from workshop: ${installedId}@${installedVersion}`);
      // A Node-landed capability has NO Python-cache configuration surface, so we do NOT open the
      // cache config modal (it would 404). The refreshed installed list (which unions the Node
      // store via /api/capabilities/installed) surfaces it.
      await Promise.allSettled([loadPluginControl(), loadRuntimeStatus()]);
    } catch (error) {
      setMessage(`plugin install failed: ${String(error)}`);
    } finally {
      setPluginActionBusy('');
    }
  }

  async function installLocalPlugin(packagePath: string) {
    const trimmedPath = packagePath.trim();
    if (!trimmedPath) {
      setMessage('local plugin install failed: package path is required');
      return;
    }
    try {
      setPluginActionBusy(`local:${trimmedPath}`);
      const response = (await readJson(pluginStatus?.verification.local_install_url ?? '/api/plugins/install-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package_path: trimmedPath }),
      })) as { plugin_id: string; version: string };
      setSelectedPluginKey(pluginKey(response.plugin_id, response.version));
      setWorkspaceSurface('plugins');
      setPluginConfigModalOpen(true);
      setMessage(`local plugin installed: ${response.plugin_id}@${response.version}`);
      await Promise.allSettled([loadPluginControl(), loadRuntimeStatus()]);
      await loadPluginConfiguration(response.plugin_id, response.version);
    } catch (error) {
      setMessage(`local plugin install failed: ${String(error)}`);
    } finally {
      setPluginActionBusy('');
    }
  }

  async function uninstallPlugin(
    pluginId: string,
    version: string,
    origin?: 'cache' | 'node-workshop',
    nativeKey?: string,
  ) {
    try {
      setPluginActionBusy(pluginKey(pluginId, version));
      // Route by the CARD's explicit origin (a cache and a Node install can share an id, so only
      // the clicked card decides which store to remove from). The Node store DELETEs by the card's
      // native_key (the Node pluginKey) — not assumed equal to plugin_id.
      if (origin === 'node-workshop') {
        await readJson('/api/capabilities/uninstall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            origin: 'node-workshop',
            capability_id: pluginId,
            version,
            native_key: nativeKey ?? pluginId,
          }),
        });
      } else {
        await readJson('/api/plugins/uninstall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plugin_id: pluginId, version }),
        });
      }
      if (selectedPluginKey === pluginKey(pluginId, version)) {
        setSelectedPluginKey('');
        setPluginConfiguration(null);
      }
      setWorkspaceSurface('plugins');
      setMessage(`plugin uninstalled: ${pluginId}@${version}`);
      await Promise.allSettled([loadPluginControl(), loadRuntimeStatus()]);
    } catch (error) {
      setMessage(`plugin uninstall failed: ${String(error)}`);
    } finally {
      setPluginActionBusy('');
    }
  }

  async function savePluginSetting(pluginId: string, version: string, name: string) {
    const writeSetting = async (settingName: string) => {
      const desc = pluginConfiguration?.configuration.settings.find((item) => item.name === settingName);
      await readJson('/api/plugins/config/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plugin_id: pluginId,
          version,
          name: settingName,
          value: desc ? normalizePluginSettingDraft(desc, pluginSettingDrafts[settingName]) : pluginSettingDrafts[settingName] ?? '',
        }),
      });
    };
    try {
      await writeSetting(name);
      // PaySwitch: the Chrome profile and its User Data dir are a bound pair.
      // onPick captures the sibling user_data_dir into the draft, but a single
      // "Save setting" click only persists `name` — so persist the captured
      // user_data_dir too, otherwise the binding breaks on non-default roots.
      if (
        pluginId === 'dev.clawhunt.pay-switch-agent' &&
        name === 'chrome_profile_directory' &&
        settingDraftText(pluginSettingDrafts.chrome_user_data_dir)
      ) {
        await writeSetting('chrome_user_data_dir');
      }
      setMessage(`plugin setting saved: ${name}`);
      await loadPluginConfiguration(pluginId, version);
    } catch (error) {
      setMessage(`plugin setting save failed: ${String(error)}`);
    }
  }

  async function savePluginSecret(pluginId: string, version: string, name: string) {
    try {
      await readJson('/api/plugins/secret/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugin_id: pluginId, version, name, value: pluginSecretDrafts[name] ?? '', version_range: `=${version}` }),
      });
      setPluginSecretDrafts((current) => ({ ...current, [name]: '' }));
      setMessage(`plugin secret saved: ${name}`);
      await loadPluginConfiguration(pluginId, version);
    } catch (error) {
      setMessage(`plugin secret save failed: ${String(error)}`);
    }
  }

  async function clearPluginSecret(pluginId: string, version: string, name: string) {
    try {
      await readJson('/api/plugins/secret/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugin_id: pluginId, version, name }),
      });
      setPluginSecretDrafts((current) => ({ ...current, [name]: '' }));
      setMessage(`plugin secret cleared: ${name}`);
      await loadPluginConfiguration(pluginId, version);
    } catch (error) {
      setMessage(`plugin secret clear failed: ${String(error)}`);
    }
  }

  async function createDeveloperSubmission() {
    try {
      setDeveloperSubmissionBusy('create');
      const requestBody = {
        kind: developerDraft.kind,
        developer_id: developerDraft.developerId.trim() || undefined,
        capability_id: developerDraft.capabilityId.trim() || undefined,
        requested_acceptance_level: developerDraft.requestedAcceptanceLevel || undefined,
      };
      let payload: DeveloperSubmissionPayload;
      try {
        payload = (await readJson('/v1/developer/capabilities', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        })) as DeveloperSubmissionPayload;
      } catch (error) {
        if (developerDraft.kind !== 'plugin' || errorStatus(error) !== 404) throw error;
        payload = (await readJson('/v1/developer/plugins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            developer_id: requestBody.developer_id,
            plugin_id: requestBody.capability_id,
            requested_acceptance_level: requestBody.requested_acceptance_level,
          }),
        })) as DeveloperSubmissionPayload;
      }
      setDeveloperSubmission(payload);
      setDeveloperSubmissionId(payload.submission_id);
      setMessage(`developer submission created: ${payload.submission_id}`);
    } catch (error) {
      setMessage(`developer submission failed: ${String(error)}`);
    } finally {
      setDeveloperSubmissionBusy('');
    }
  }

  async function uploadDeveloperArtifact() {
    if (!developerSubmissionId) {
      setMessage('developer upload requires a submission id');
      return;
    }
    if (!developerDraft.packagePath.trim()) {
      setMessage('developer upload requires a package path');
      return;
    }
    const smokeTimeoutSeconds = Number.parseFloat(developerDraft.smokeTimeoutSeconds);
    try {
      setDeveloperSubmissionBusy('upload');
      const body = JSON.stringify({
        package_path: developerDraft.packagePath.trim(),
        // Signing is a separate post-review step; the upload endpoint rejects a
        // signing key (HTTP 400), so this surface never collects or sends one.
        // Omit when blank → server default + floor; only send an explicit value
        // the user actually entered (the API still bounds it to (0, 60]).
        smoke_timeout_seconds: Number.isFinite(smokeTimeoutSeconds) ? smokeTimeoutSeconds : undefined,
      });
      let payload: DeveloperSubmissionPayload;
      try {
        payload = (await readJson(`/v1/developer/capabilities/${encodeURIComponent(developerSubmissionId)}/artifact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })) as DeveloperSubmissionPayload;
      } catch (error) {
        if (developerDraft.kind !== 'plugin' || errorStatus(error) !== 404) throw error;
        payload = (await readJson(`/v1/developer/plugins/${encodeURIComponent(developerSubmissionId)}/artifact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })) as DeveloperSubmissionPayload;
      }
      setDeveloperSubmission(payload);
      setMessage(`developer review ready: ${payload.status}`);
    } catch (error) {
      setMessage(`developer upload failed: ${String(error)}`);
    } finally {
      setDeveloperSubmissionBusy('');
    }
  }

  async function refreshDeveloperSubmission() {
    if (!developerSubmissionId) {
      setMessage('developer review requires a submission id');
      return;
    }
    try {
      setDeveloperSubmissionBusy('refresh');
      let payload: DeveloperSubmissionPayload;
      try {
        payload = (await readJson(
          `/v1/developer/capabilities/${encodeURIComponent(developerSubmissionId)}/status`,
        )) as DeveloperSubmissionPayload;
      } catch (error) {
        if (developerDraft.kind !== 'plugin' || errorStatus(error) !== 404) throw error;
        payload = (await readJson(
          `/v1/developer/plugins/${encodeURIComponent(developerSubmissionId)}/verification`,
        )) as DeveloperSubmissionPayload;
      }
      setDeveloperSubmission(payload);
      setMessage(`developer review refreshed: ${payload.status}`);
    } catch (error) {
      setMessage(`developer review refresh failed: ${String(error)}`);
    } finally {
      setDeveloperSubmissionBusy('');
    }
  }

  // Returns true only when the runs list actually loaded — the startup gate reads this
  // as proof that whichever backend serves /api/runs (Node in coexist dev/preview;
  // Python's own route on desktop until the front door lands) is reachable and the
  // run list is populated (runs back chat↔run linking + the active selectedRun, not a
  // sidebar surface). Epoch-guarded so a stale late response never clobbers a newer
  // load (see chatSessionsLoadEpochRef/runsLoadEpochRef).
  async function loadRuns(_preferredRunId?: string): Promise<boolean> {
    // The chat app no longer surfaces the run cockpit, so it does NOT load runs over the
    // Python /api/runs* path (NOT Node-owned — absent from node_routes.json), i.e. the
    // deprecated run/delivery surface. Report an empty, ready run list so the startup splash
    // gate still releases. Returns once an equivalent Node-owned run surface exists.
    setRuns([]);
    setSelectedRun(null);
    setStatus('idle');
    return true;
  }

  // Returns true only when BOTH the chat-session list and the workspace inventory
  // loaded — the startup gate reads this as proof that whichever backend serves
  // /api/chat/sessions + /api/workspaces (Node in coexist dev/preview; Python's own
  // routes on desktop until the front door lands) is reachable and the sidebar's local
  // conversation/project lists are populated. Errors stay swallowed (optimistic chats
  // survive, the inventory degrades to flat) so a transient miss never wipes the UI.
  // Epoch-guarded so a stale late response cannot clobber a newer load.
  async function loadChatSessions(): Promise<boolean> {
    const epoch = ++chatSessionsLoadEpochRef.current;
    let chatOk = false;
    let workspacesOk = false;
    try {
      // personal_only: the chat sidebar shows unassigned + company="local"
      // sessions only — a company workspace's sessions are Team executions and
      // must not leak into chat grouping (workspace-sidebar-rework §4.2). Scoping
      // at the fetch keeps company sessions out of backendChatSessions entirely.
      // include_archived follows the "show archived" toggle (§4.6); default-off
      // hides archived sessions, the kernel stays the source of truth.
      const data = (await readJson(
        `/api/chat/sessions?personal_only=true&include_archived=${showArchivedRef.current ? 'true' : 'false'}`,
      )) as { sessions?: BackendChatSession[] };
      const incoming = data.sessions ?? [];
      chatOk = true;
      // Apply the write only if this is still the latest call — a newer load owns the
      // state. The fetch itself succeeded, so chatOk stays true for the gate.
      if (epoch === chatSessionsLoadEpochRef.current) {
        setBackendChatSessions((current) => {
          const incomingIds = new Set(incoming.map((session) => session.session_id));
          // A session now present in incoming is confirmed-persisted → mark it
          // backend-owned and drop it from the pending-draft set. This is what lets
          // a LATER archive (which drops it from incoming) actually hide it, instead
          // of the merge re-keeping it as a "draft".
          for (const id of incomingIds) {
            confirmedChatIdsRef.current.add(id);
            optimisticChatIdsRef.current.delete(id);
          }
          // Carry over ONLY still-pending optimistic drafts (tracked explicitly);
          // never re-introduce a backend session the scoped/archived truth excluded
          // (a company OR an archived session must not linger via the merge).
          const keptDrafts = current.filter(
            (session) => optimisticChatIdsRef.current.has(session.session_id) && !incomingIds.has(session.session_id),
          );
          // Reconcile so a lagging server snapshot never SHRINKS a transcript the
          // client already knows to be longer (see reconcileIncomingChatSessions):
          // the assistant reply persists only AFTER the run's terminal status, and
          // this reload fires on every turn's completion, so a mid-/just-after-turn
          // refresh returns a session missing its latest reply.
          return [...reconcileIncomingChatSessions(current, incoming), ...keptDrafts];
        });
      }
    } catch {
      // Keep optimistic chat sessions visible if the authenticated refresh is
      // temporarily unavailable.
    }
    try {
      const inventory = (await readJson('/api/workspaces')) as { workspaces?: WorkspaceInfo[] };
      workspacesOk = true;
      if (epoch === chatSessionsLoadEpochRef.current) setWorkspaces(inventory.workspaces ?? []);
    } catch {
      // Degrade to the flat list whenever the inventory is unavailable — never keep
      // stale trust state from an earlier successful fetch. Only the latest call may
      // blank it, so a stale failure cannot wipe a fresher success.
      if (epoch === chatSessionsLoadEpochRef.current) setWorkspaces([]);
    }
    return chatOk && workspacesOk;
  }

  function appendDesktopAlert(entry: Omit<DesktopAlertEntry, 'id' | 'created_at'>) {
    const next: DesktopAlertEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      created_at: new Date().toISOString(),
    };
    setDesktopAlertHistory((current) => [next, ...current].slice(0, 8));
    if (desktopAlertsEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(entry.title, { body: entry.detail });
      } catch {
        // Best-effort desktop notification only.
      }
    }
  }

  async function enableDesktopAlerts() {
    if (typeof Notification === 'undefined') {
      setDesktopAlertPermission('unsupported');
      setMessage('desktop alerts are not available in this renderer');
      return;
    }
    if (Notification.permission === 'granted') {
      saveDesktopAlertPreference(true);
      setDesktopAlertPermission('granted');
      setMessage('desktop alerts enabled');
      return;
    }
    const permission = await Notification.requestPermission();
    setDesktopAlertPermission(permission);
    if (permission === 'granted') {
      saveDesktopAlertPreference(true);
      setMessage('desktop alerts enabled');
      return;
    }
    setMessage(`desktop alerts ${permission}`);
  }

  function disableDesktopAlerts() {
    saveDesktopAlertPreference(false);
    setMessage('desktop alerts disabled');
  }

  function sendTestDesktopAlert() {
    appendDesktopAlert({
      title: 'ClawHunt desktop test',
      detail: desktopMode ? 'Desktop shell notification pipeline is connected.' : 'Browser-mode notification preview.',
      severity: 'info',
    });
    setMessage('desktop alert queued');
  }

  async function copyWorkspaceUpdateCommand() {
    const command = desktopShellInfo?.workspaceUpdateCommand;
    if (!command) return;
    try {
      await writeClipboardText(command);
      setMessage(t('Update command copied'));
    } catch (error) {
      setMessage(`clipboard: ${String(error)}`);
    }
  }

  function generateIncidentExport() {
    const generatedAt = new Date().toISOString();
    const payload = {
      schema_version: '0.1.0',
      generated_at: generatedAt,
      desktop: {
        mode: desktopMode ? 'tauri' : 'browser',
        status: desktopStatus,
        shell: desktopShellInfo,
        runtime: desktopSession?.handle
          ? {
              base_url: desktopSession.handle.base_url,
              state_path: desktopSession.handle.state_path,
              owned: desktopSession.handle.owned,
              pid: desktopSession.handle.pid ?? null,
            }
          : null,
      },
      runtime_status: runtimeStatus,
      runtime_defaults: runtimeConfig?.defaults ?? null,
      selected_backend: selectedBackend,
      selected_harness: selectedHarness,
      selected_run_id: runId || null,
      selected_run: selectedRun,
      evidence_summary: evidence
        ? {
            chain_verdict: evidence.chain_verdict,
            command_count: evidence.commands.length,
            worker_count: evidence.worker_results.length,
            artifact_count: evidence.artifacts.length,
            finding_count: evidence.findings.length,
          }
        : null,
      protocol_export: protocolExport,
      recent_events: events.slice(-20),
      direct_chat_transcript: directChatTurns.slice(-12),
      alert_history: desktopAlertHistory,
      latest_message: message,
      plugin_summary: pluginStatus
        ? {
            plugin_count: pluginStatus.plugin_count,
            registry_count: pluginStatus.registry.count,
            revocation_count: pluginStatus.governance.revocation_count,
          }
        : null,
    };
    const fileName = `superclaw-incident-${generatedAt.replace(/[:.]/g, '-')}.json`;
    const href = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload, null, 2))}`;
    setDesktopIncidentExport({ fileName, href, generatedAt });
    setMessage('desktop incident export ready');
  }

  async function refreshRunState(preferredRunId?: string) {
    await Promise.allSettled([
      loadRuntimeStatus(),
      loadRuns(preferredRunId),
      loadChatSessions(),
      loadRuntimeConfig(),
      loadAgentControl(),
      loadAuthStatus(),
      loadPluginControl(),
      loadPluginDiagnostics(),
    ]);
  }

  async function refreshEval(id: string) {
    try {
      const report = (await readJson(`/api/evals/${id}`)) as EvalReport;
      setEvalReport(report);
      setEvalStatus(report.status);
    } catch (error) {
      setMessage(`eval probe failed: ${String(error)}`);
    }
  }

  useEffect(() => {
    if (!apiReady || nodeCanvasMode) return;
    void readJson('/api/pay-switch/status')
      .then((data) => setPaySwitch(data))
      .catch(() => setPaySwitch({ mode: 'governed_optional' }));
  }, [apiReady, desktopSession, effectiveControlToken, nodeCanvasMode]);

  useEffect(() => {
    if (!apiReady || nodeCanvasMode) return;
    void Promise.allSettled([refreshRunState(), loadBackends(), loadHarnesses(), loadEvalHistory()]);
  }, [apiReady, controlToken, desktopSession, effectiveControlToken, nodeCanvasMode]);

  useEffect(() => {
    if (!desktopMode) return;
    void connectDesktopRuntime();
  }, [desktopMode]);

  // Browser canvas readiness comes from its actual Node + gateway services. The
  // initial splash is bounded, but releasing it on timeout must expose the failure.
  useEffect(() => {
    if (!nodeCanvasMode) return;
    const controller = new AbortController();
    let cancelled = false;
    let retryTimer: number | undefined;
    setCanvasStartupStatus('checking');
    const hardTimer = window.setTimeout(() => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(retryTimer);
      setCanvasStartupStatus('unavailable');
      setStartupGateReady(true);
    }, 8000);
    const probe = async () => {
      const ready = await probeCanvasReadiness(controller.signal);
      if (cancelled) return;
      if (ready) {
        window.clearTimeout(hardTimer);
        setCanvasStartupStatus('ready');
        setStartupGateReady(true);
      } else {
        retryTimer = window.setTimeout(() => { void probe(); }, 600);
      }
    };
    void probe();
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(hardTimer);
      window.clearTimeout(retryTimer);
    };
  }, [nodeCanvasMode, canvasStartupAttempt]);

  // Legacy startup pump: keep the splash up until Python is reachable AND the co-launched
  // Node control plane is ready AND the conversation/project/run lists have
  // loaded once. One /api/runtime/status read yields both Python reachability (the
  // response) and Node readiness (its kernel-reported `node` section) — so Node is proven
  // even on desktop, where the lists are Python-served and could never themselves prove
  // Node; when Node isn't enabled in this deployment the gate doesn't wait for it. The
  // lists must also load so the splash never lifts onto an empty sidebar. A HARD timeout
  // (an independent timer, not an in-loop deadline) forces the gate open even if a probe
  // hangs forever, so a slow or unreachable backend can never strand the user — the shell
  // then reveals and degrades to its own empty/loading copy.
  useEffect(() => {
    if (startupGateReady || nodeCanvasMode) return;
    // Never hold the splash past a runtime that failed/stopped to come up — the shell
    // surfaces its own "runtime not connected" banner (graceful degradation).
    if (desktopMode && (desktopStatus === 'failed' || desktopStatus === 'stopped')) {
      setStartupGateReady(true);
      return;
    }
    // Desktop: wait for the Python sidecar to connect (apiReady === desktopStatus==='connected').
    if (!apiReady) return;
    let cancelled = false;
    const STARTUP_GATE_TIMEOUT_MS = 8000;
    const release = () => {
      if (!cancelled) setStartupGateReady(true);
    };
    // Hard ceiling: fires regardless of where the async loop is parked (even mid-hang on
    // a probe that never resolves), guaranteeing the splash always lifts.
    const hardTimer = window.setTimeout(release, STARTUP_GATE_TIMEOUT_MS);
    void (async () => {
      let backoff = 150;
      while (!cancelled) {
        // Python reachability AND Node coexistence readiness, both from one
        // /api/runtime/status read. Python proven by the response itself; Node proven by
        // the kernel-reported `node` contract (the service probes the co-launched Node's
        // health) — so this holds on desktop too, where the lists are served by Python
        // and could never themselves prove Node. node.enabled=false ⇒ no Node in this
        // deployment, so don't wait for it; absent field (older backend) ⇒ same.
        let pythonOk = true;
        let nodeOk = true;
        try {
          const status = (await readJson('/api/runtime/status')) as RuntimeStatusPayload;
          nodeOk = !status?.node?.enabled || status?.node?.ready === true;
        } catch {
          pythonOk = false;
          nodeOk = false;
        }
        if (cancelled) return;
        // Core lists loaded: a clean load means conversations, projects, and runs are
        // populated before the splash lifts (never onto an empty sidebar).
        const chatOk = await loadChatSessions();
        const runsOk = await loadRuns();
        if (cancelled) return;
        if (pythonOk && nodeOk && chatOk && runsOk) {
          release();
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, 600);
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(hardTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiReady, desktopMode, desktopStatus, startupGateReady, nodeCanvasMode]);

  useEffect(() => {
    // Each surface checks its own service chain before dismissing the static splash.
    // A bounded timeout reveals the shell and its connection failure state.
    if (!startupGateReady) return;
    const splash = document.getElementById('superclaw-startup-splash');
    if (!splash) return;
    // Startup tracing: the static splash is being dismissed. This is the end of the
    // visible loading window — its delta from `first-paint` is how long the loading UI
    // was actually on screen.
    recordStartupMark('static-splash-hidden');
    splash.classList.add('startup-splash-hidden');
    const removeTimer = window.setTimeout(() => splash.remove(), 220);
    return () => window.clearTimeout(removeTimer);
  }, [startupGateReady]);

  // Prewarm the embedded Team/Company board's data as soon as the runtime is reachable,
  // so the first open of the Team tab renders straight from cache instead of paying the
  // board's cold data cascade + spinner. Approach A (owner-chosen): warm the DATA at
  // startup but still mount the board UI on demand — no always-mounted keep-alive, so
  // the board's global keyboard shortcuts (Cmd+K command palette, etc.) never leak into
  // the chat surface. Best-effort: if the Node control plane is still coming up the warm
  // fails and is retried a couple of times; either way the board fetches live on click.
  useEffect(() => {
    if (!apiReady) return;
    let cancelled = false;
    let attempts = 0;
    let retryTimer: number | undefined;
    const warm = () => {
      if (cancelled) return;
      attempts += 1;
      void prewarmCompanyBoard().then((ok) => {
        if (ok || cancelled || attempts >= 3) return;
        retryTimer = window.setTimeout(warm, 2500);
      });
    };
    warm();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [apiReady]);

	  useEffect(() => {
	    setAgentExecutableDraft(selectedAgentConfigEntry?.display_value ?? selectedAgentConfigEntry?.default ?? selectedAgentInfo?.executable ?? '');
	    // Reset only when the SELECTED AGENT (or its config entry) changes —
	    // not on every availability re-probe, which would wipe a path the user
	    // is typing into the setup dialog.
	    // eslint-disable-next-line react-hooks/exhaustive-deps
	  }, [selectedAgentConfigEntry?.name, selectedAgentInfo?.name]);

  useEffect(() => {
    const plugins = pluginStatus?.plugins ?? [];
    if (!plugins.length) {
      setSelectedPluginKey('');
      setPluginConfiguration(null);
      return;
    }
    const selectedInstalled = plugins.some((plugin) => pluginKey(plugin.id, plugin.version) === selectedPluginKey);
    if (!selectedInstalled) {
      const first = plugins[0];
      setSelectedPluginKey(pluginKey(first.id, first.version));
    }
  }, [pluginStatus, selectedPluginKey]);

  useEffect(() => {
    if (!apiReady) return;
    const parsed = parsePluginKey(selectedPluginKey);
    if (!parsed) {
      setPluginConfiguration(null);
      return;
    }
    void loadPluginConfiguration(parsed.pluginId, parsed.version);
  }, [apiReady, selectedPluginKey, controlToken, desktopSession]);

  useEffect(() => {
    if (!apiReady || workspaceSurface !== 'plugins') return;
    setPluginDiagnosticsStreamState('connecting');
    const stream = new EventSource(
      buildDesktopEventStreamUrl(
        pluginStatus?.diagnostics.events_url ?? '/api/plugins/diagnostics/events',
        effectiveControlToken,
        desktopSession,
      ),
    );
    stream.onopen = () => setPluginDiagnosticsStreamState('live');
    stream.onerror = () => {
      setPluginDiagnosticsStreamState('failed');
      stream.close();
    };
    stream.addEventListener('plugin.diagnostics', (event) => {
      try {
        setPluginDiagnostics(JSON.parse((event as MessageEvent).data) as PluginDiagnosticsPayload);
        setPluginDiagnosticsStreamState('live');
      } catch {
        setPluginDiagnosticsStreamState('failed');
      }
    });
    return () => stream.close();
  }, [apiReady, desktopSession, effectiveControlToken, pluginStatus, workspaceSurface]);

  useEffect(() => {
    if (!filteredRegistryPlugins.length) {
      setSelectedRegistryPluginKey('');
      return;
    }
    const selectedStillExists = filteredRegistryPlugins.some(
      (plugin) => pluginKey(plugin.plugin_id, plugin.version) === selectedRegistryPluginKey,
    );
    if (!selectedStillExists) {
      const first = filteredRegistryPlugins[0];
      setSelectedRegistryPluginKey(pluginKey(first.plugin_id, first.version));
    }
  }, [filteredRegistryPlugins, selectedRegistryPluginKey]);

  useEffect(() => {
    if (!selectedRegistryPlugin || developerDraft.kind !== 'plugin' || developerDraft.capabilityId.trim()) return;
    setDeveloperDraft((current) => ({ ...current, capabilityId: selectedRegistryPlugin.plugin_id }));
  }, [developerDraft.capabilityId, developerDraft.kind, selectedRegistryPlugin]);


  // Post-commit queue pump: whenever a session frees up (runningKeys shrinks), a
  // pause lifts, or the queue changes, advance every idle session's next item.
  // Runs after React commits, so runDirectChat reads fresh transcript/session
  // state; pump's own per-session running check makes re-entry safe.
  useEffect(() => {
    pumpChatQueue();
  }, [runningKeys, pausedKeys, chatQueue]);

  // Collapse the (now hidden) panel once the queue drains. Pause is intentionally NOT cleared here;
  // it is cleared on resume, clear, or the next fresh idle submit — so a Stop keeps the chain halted
  // even if a prompt lands during the abort window.
  useEffect(() => {
    if (chatQueue.length === 0 && chatQueueExpanded) setChatQueueExpanded(false);
  }, [chatQueue.length, chatQueueExpanded]);

  useEffect(() => {
    if (!selectedRun?.run_id || !selectedRun.status) return;
    const current = { runId: selectedRun.run_id, status: selectedRun.status };
    const previous = previousRunSnapshotRef.current;
    previousRunSnapshotRef.current = current;
    if (!previous || previous.runId !== current.runId || previous.status === current.status) return;
    if (current.status === 'completed') {
      appendDesktopAlert({
        title: `Run completed: ${current.runId}`,
        detail: evidence?.chain_verdict ? `Evidence verdict ${evidence.chain_verdict}.` : 'Delivery run completed.',
        severity: 'good',
      });
      return;
    }
    if (current.status === 'failed' || current.status === 'cancelled') {
      appendDesktopAlert({
        title: `Run ${current.status}: ${current.runId}`,
        detail: message || 'Inspect run evidence and recent events from this chat.',
        severity: 'bad',
      });
    }
  }, [evidence, message, selectedRun]);

  // Bridge: surface every transient global `message` as a unified toast (instead
  // of the old inline `.composer-message` bar) and mirror it into the in-memory
  // notification history. We never mutate `message` here — the desktop-alert effect
  // above still reads it. The dedupe ref absorbs React StrictMode's double-invoke
  // and re-renders that re-run this effect. Each toast's auto-dismiss timer lives in
  // its own ToastItem, so there is nothing to schedule or clean up here.
  useEffect(() => {
    if (!message) {
      lastToastedMessageRef.current = null;
      return;
    }
    if (isBackgroundStatusText(message)) return;
    if (lastToastedMessageRef.current === message) return;
    lastToastedMessageRef.current = message;
    const tone = inferToastTone(message);
    const id = (toastIdRef.current += 1);
    setToasts((prev) => [...prev.slice(-3), { id, text: message, tone }]);
    setNotificationHistory((prev) =>
      [{ id, text: message, tone, ts: Date.now() }, ...prev].slice(0, NOTIFICATION_HISTORY_LIMIT),
    );
    setNotificationUnread((count) => count + 1);
  }, [message]);

  function watchEval(id: string) {
    const stream = new EventSource(buildDesktopEventStreamUrl(`/api/evals/${id}/events`, effectiveControlToken, desktopSession));
    const watched = ['eval.started', 'lane.started', 'lane.completed', 'eval.completed'];
    watched.forEach((type) => {
      stream.addEventListener(type, () => {
        if (type === 'eval.completed') {
          setEvalStatus('completed');
          void refreshEval(id);
          stream.close();
        }
      });
    });
    stream.onerror = () => {
      stream.close();
    };
  }

	  async function saveBackendDefault() {
	    try {
	      const payload = (await readJson('/api/config/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'backend', value: selectedAgentInfo?.name ?? selectedBackend }),
      })) as { defaults?: { backend?: string } };
      setMessage(`backend default saved to ${payload.defaults?.backend ?? (selectedAgentInfo?.name ?? selectedBackend)}`);
      await Promise.allSettled([loadRuntimeConfig(), loadRuntimeStatus()]);
    } catch (error) {
	      setMessage(`config save failed: ${String(error)}`);
	    }
	  }

	  async function saveAgentRuntimeSetup() {
	    if (!selectedBackend) {
	      setAgentSetupOpen(true);
	      setMessage(t('Agent setup choose first'));
	      return;
	    }
	    try {
	      await readJson('/api/config/set', {
	        method: 'POST',
	        headers: { 'Content-Type': 'application/json' },
	        body: JSON.stringify({ name: 'backend', value: selectedAgentInfo?.name ?? selectedBackend }),
	      });
	      const executableValue = agentExecutableDraft.trim();
	      if (selectedAgentExecutableConfigName && executableValue) {
	        await readJson('/api/config/set', {
	          method: 'POST',
	          headers: { 'Content-Type': 'application/json' },
	          body: JSON.stringify({ name: selectedAgentExecutableConfigName, value: executableValue }),
	        });
	      }
	      markAgentSetupDismissed();
	      invalidateAllProbes(); // executable/backend write — a probe may now be stale
	      setMessage(`agent runtime saved: ${selectedAgentInfo?.name ?? selectedBackend}`);
	      await Promise.allSettled([loadRuntimeConfig(), loadRuntimeStatus(), loadAgentControl(), loadBackends()]);
	      setAgentSetupOpen(false);
	      setBlockingModal(null);
	    } catch (error) {
	      setMessage(`agent runtime save failed: ${String(error)}`);
	    }
	  }

  // Single save path for schema-driven runtime config fields; the kernel
  // validates (choices, secrets, control characters) and this surface only
  // reports the outcome. Returns success so the field can clear its draft.
  async function saveRuntimeConfigValue(name: string, value: string): Promise<boolean> {
    try {
      await readJson('/api/config/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, value }),
      });
      setMessage(`config saved: ${name}`);
      // A runtime-config change invalidates every runtime's last probe (see
      // invalidateAllProbes). 'backend'/'mode' just select a default — they change
      // no runtime's reachability, so they are excluded.
      if (name !== 'backend' && name !== 'mode') invalidateAllProbes();
      await Promise.allSettled([loadRuntimeConfig(), loadRuntimeStatus(), loadAgentControl(), loadAuthStatus()]);
      return true;
    } catch (error) {
      setMessage(`config save failed: ${String(error)}`);
      return false;
    }
  }

  async function loginClawHunt() {
    try {
      await readJson('/api/auth/clawhunt/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_api_key: clawHuntKeyInput }),
      });
      setClawHuntKeyInput('');
      setMessage('clawhunt login updated');
      invalidateAllProbes(); // relay credential changed — ClawWork reachability may differ
      await Promise.allSettled([loadAuthStatus(), loadRuntimeStatus()]);
    } catch (error) {
      setMessage(`clawhunt login failed: ${String(error)}`);
    }
  }

  async function startClawHuntBrowserLogin(provider: 'google' | 'website') {
    try {
      setClawHuntBrowserLoginBusy(provider);
      const startUrl = authStatus?.clawhunt.browser_login_start_url ?? '/api/auth/clawhunt/browser/start';
      const payload = (await readJson(`${startUrl}?provider=${encodeURIComponent(provider)}`)) as ClawHuntBrowserLoginPayload;
      if (!payload.ok || !payload.login_url) throw new Error('ClawHunt did not return a login URL');
      if (desktopInvoke) {
        await openDesktopExternalUrl(desktopInvoke, payload.login_url);
      } else {
        const opened = window.open(payload.login_url, '_blank', 'noopener,noreferrer');
        if (!opened) throw new Error(`browser blocked the ClawHunt login window: ${payload.login_url}`);
      }
      setMessage(`clawhunt ${provider} login opened with source=${payload.source}`);
      const expiresInMs = Math.max(10, Math.min(payload.expires_in_seconds ?? 600, 600)) * 1000;
      const deadline = Date.now() + expiresInMs;
      const pollLoginStatus = async () => {
        const [authResult] = await Promise.allSettled([loadAuthStatus(), loadRuntimeStatus()]);
        const latestAuth = authResult.status === 'fulfilled' ? authResult.value : null;
        if (latestAuth?.clawhunt.account === 'set') {
          setClawHuntBrowserLoginBusy('');
          invalidateAllProbes(); // relay credential changed on login
          setMessage(`clawhunt ${provider} login complete`);
          return;
        }
        if (Date.now() < deadline) {
          window.setTimeout(() => {
            void pollLoginStatus();
          }, 2500);
          return;
        }
        setClawHuntBrowserLoginBusy('');
        setMessage(`clawhunt ${provider} login pending; refresh login status if the browser flow completed`);
      };
      window.setTimeout(() => {
        void pollLoginStatus();
      }, 2500);
    } catch (error) {
      setMessage(`clawhunt browser login failed: ${String(error)}`);
      setClawHuntBrowserLoginBusy('');
    }
  }

  function startClawHuntAccountShortcutLogin() {
    setAccountMenuOpen(false);
    try {
      // Packaged desktop cannot receive a fragment back from the system browser at
      // its private `tauri://localhost` origin. Use the existing state-bound
      // loopback callback there: credentials, when needed, are still entered only
      // on the ClawHunt main site, while the local backend receives the verified
      // handoff. The fragment bridge below remains the same-tab browser path.
      if (desktopInvoke) {
        void startClawHuntBrowserLogin('website');
        return;
      }
      const baseUrl = authStatus?.clawhunt.base_url;
      if (!baseUrl || baseUrl === 'unconfigured') {
        throw new Error('ClawHunt sign-in is not configured');
      }
      const bridgeUrl = buildClawHuntSsoBridgeUrl(baseUrl, window.location.href);
      // `_self` keeps the flow in this tab, which is required because the main-site
      // token lives in that site's localStorage. The bridge returns it only in the
      // URL fragment, and the mount effect above scrubs it immediately.
      window.open(bridgeUrl, '_self');
    } catch (error) {
      setMessage(`clawhunt sign-in failed: ${String(error)}`);
    }
  }

  async function createClawHuntAgentKey() {
    if (!selectedClawHuntAgentId) {
      setMessage('select a ClawHunt agent first');
      return;
    }
    try {
      await readJson('/api/auth/clawhunt/agent-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: selectedClawHuntAgentId, name: clawHuntAgentKeyName }),
      });
      setMessage('clawhunt agent key created');
      invalidateAllProbes(); // relay credential changed
      await Promise.allSettled([loadAuthStatus(), loadRuntimeStatus()]);
    } catch (error) {
      setMessage(`clawhunt agent key creation failed: ${String(error)}`);
    }
  }

  async function logoutClawHunt() {
    clearClawHuntSsoToken(localStorage);
    setClawHuntSsoIdentity(null);
    try {
      await readJson('/api/auth/clawhunt/logout', { method: 'POST' });
      clawHuntAgentKeyAutoProvisionRef.current = false;
      setMessage('clawhunt auth cleared');
      invalidateAllProbes(); // relay credential cleared on logout — ClawWork no longer reachable
      await Promise.allSettled([loadAuthStatus(), loadRuntimeStatus()]);
    } catch (error) {
      setMessage(`clawhunt logout failed: ${String(error)}`);
    }
  }

  async function startEval() {
    try {
      setEvalStatus('starting');
      setEvalReport(null);
      const body = (await readJson('/api/evals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: evalAgent, case_id: evalCase, async_execution: true, timeout_seconds: 900 }),
      })) as { eval_id: string; status?: string };
      setEvalId(body.eval_id);
      setEvalStatus(body.status ?? 'running');
      watchEval(body.eval_id);
    } catch (error) {
      setEvalStatus('failed');
      setMessage(`eval start failed: ${String(error)}`);
    }
  }

  async function cancelEval() {
    if (!evalId) return;
    try {
      const body = (await readJson(`/api/evals/${evalId}/cancel`, { method: 'POST' })) as { status?: string };
      setEvalStatus(body.status ?? 'cancel_requested');
    } catch (error) {
      setMessage(`eval cancel failed: ${String(error)}`);
    }
  }

  function updateComposerTrigger(value: string, caret: number | null | undefined) {
    setComposerTrigger(detectComposerTrigger(value, typeof caret === 'number' ? caret : value.length));
  }

  function focusComposer(position: number) {
    window.setTimeout(() => {
      const textArea = composerTextAreaRef.current;
      if (!textArea) return;
      textArea.focus();
      textArea.setSelectionRange(position, position);
      resizeComposerTextArea();
    }, 0);
  }

  // Leave prompt-history browse mode. Any path that PROGRAMMATICALLY rewrites the
  // composer (re-edit, slash command, queue edit, ref removal, attachments, new
  // session) calls this so a subsequent ArrowDown can't clobber that fresh content
  // by restoring a stale draft. (The keydown handler also self-heals when the live
  // text diverges from the last recalled text — this covers identical-text rewrites.)
  function exitComposerHistoryBrowse() {
    composerHistoryIndexRef.current = null;
  }

  function resetComposerSession() {
    setWorkspaceSurface('chat');
    setRightPanelOpen(false);
    setAccountMenuOpen(false);
    setActiveBackendChatSessionId('');
    setActiveLocalChatSessionId('');
    setDirectChatTurns([]);
    setSelectedContextRefs([]);
    setComposerAttachments([]);
    setComposerTrigger(null);
    setPinnedWorkspaceId(null);
    setPinnedWorkspaceName(null);
    setPrompt('');
    // A pending /compact seed belongs ONLY to the draft it was created with — a fresh
    // chat opened after it (or any navigation that resets the composer) must not
    // inherit the previous conversation's summary.
    compactSeedRef.current = null;
    exitComposerHistoryBrowse();
  }

  // Open a fresh chat pinned to a project (workspace): clear the composer, then
  // remember the target so the first turn lands the new session in it. Presentation
  // only — the binding is the kernel's `workspace_id` turn field, identical to
  // `superclaw chat --workspace <id>`.
  function startProjectChat(workspaceId: string, workspaceName: string) {
    resetComposerSession();
    setPinnedWorkspaceId(workspaceId);
    setPinnedWorkspaceName(workspaceName);
    focusComposer(0);
  }

  function openSettingsSurface(targetId?: string) {
    // The return-surface recording lives in selectSettingsTarget (the shared choke point).
    selectSettingsTarget(targetId ?? 'settings-general');
    setComposerTrigger(null);
  }

  // Push a client-only toast on demand (mirrors the message-driven producer, but
  // callable from command handlers). Also lands in the notification history so a
  // dismissed toast is recoverable. Reusable across composer commands.
  function pushLocalToast(text: string, tone: ToastTone = 'info') {
    const id = (toastIdRef.current += 1);
    setToasts((prev) => [...prev.slice(-3), { id, text, tone }]);
    setNotificationHistory((prev) =>
      [{ id, text, tone, ts: Date.now() }, ...prev].slice(0, NOTIFICATION_HISTORY_LIMIT),
    );
    setNotificationUnread((count) => count + 1);
  }

  // /cost — aggregate this session's per-turn token metering into a single summary.
  // Per-turn usage already renders on each assistant turn; this rolls it up so the
  // user can see the session total at a glance (CodePilot-style /cost). Reads the
  // in-memory transcript only (no network); prefers kernel-persisted `usage`, falls
  // back to the live display usage for a turn still in flight.
  function showSessionUsage() {
    let totalTokens = 0;
    let meteredReplies = 0;
    let elapsedMs = 0;
    for (const turn of directChatTurns) {
      if (turn.role !== 'assistant') continue;
      const usage = (turn.usage ?? turn.display?.usage ?? null) as Record<string, unknown> | null;
      const tokens = usageTokenTotal(usage);
      if (tokens > 0) {
        totalTokens += tokens;
        meteredReplies += 1;
      }
      if (typeof turn.elapsedMs === 'number' && turn.elapsedMs > 0) elapsedMs += turn.elapsedMs;
    }
    const zh = locale === 'zh';
    if (meteredReplies === 0) {
      pushLocalToast(zh ? '本次会话暂无可统计的用量。' : 'No token usage recorded in this session yet.');
      return;
    }
    const secs = Math.round(elapsedMs / 1000);
    const tokensText = `${formatTokenCount(totalTokens)} tokens`;
    const text = zh
      ? `本次会话：${meteredReplies} 条回复 · ${tokensText}${secs > 0 ? ` · 累计用时 ${secs}s` : ''}`
      : `This session: ${meteredReplies} replies · ${tokensText}${secs > 0 ? ` · ${secs}s total` : ''}`;
    pushLocalToast(text);
  }

  // /compact — ask the agent (which still holds this chat's native context) to produce a
  // handoff summary as a normal turn in the OLD session, then continue in a fresh session
  // seeded with that summary. The old session stays intact in the sidebar as the
  // checkpoint — reopening it is the "rewind". Pure parts live in compactChat.ts.
  async function compactSession() {
    const zh = locale === 'zh';
    const loc = zh ? ('zh' as const) : ('en' as const);
    if (compactingRef.current) return;
    const busyKey = chatTurnKey(activeBackendChatSessionId, activeLocalChatSessionId);
    if (runningTurnsRef.current.has(busyKey)) {
      pushLocalToast(zh ? '当前回合还在进行，请等它完成后再压缩。' : 'A turn is still running — compact after it finishes.');
      return;
    }
    if (!canCompactTurns(directChatTurns)) {
      pushLocalToast(zh ? '这个会话还没有可压缩的内容。' : 'Nothing to compact in this chat yet.');
      return;
    }
    compactingRef.current = true;
    pushLocalToast(zh ? '正在压缩对话上下文…' : 'Compacting conversation context…');
    try {
      // The summarize turn runs through the NORMAL send pipeline (visible in the old
      // session's transcript and persisted with it — that persisted pair IS the
      // checkpoint record). runDirectChat returns the finalized outcome.
      const outcome = await runDirectChat(compactSummaryPrompt(loc), 'auto', [], []);
      const summary = outcome?.status === 'completed' ? outcome.text.trim() : '';
      if (!summary) {
        pushLocalToast(zh ? '压缩失败，会话保持不变。' : 'Compaction failed — the chat is unchanged.', 'error');
        return;
      }
      // Open the post-compact draft: same "new chat" semantics as /new, but keep the
      // project pin (the continuation belongs to the same project) and start the
      // transcript at a boundary marker so the carried context is visible.
      const keepWorkspaceId = pinnedWorkspaceId;
      const keepWorkspaceName = pinnedWorkspaceName;
      resetComposerSession();
      if (keepWorkspaceId) {
        setPinnedWorkspaceId(keepWorkspaceId);
        setPinnedWorkspaceName(keepWorkspaceName);
      }
      setDirectChatTurns([buildCompactBoundaryTurn(summary, loc)]);
      compactSeedRef.current = summary; // consumed by the new session's first turn
      pushLocalToast(
        zh
          ? '已压缩：新会话将携带摘要继续；原会话保留在侧边栏，可随时回溯。'
          : 'Compacted: this new session continues from the summary; the original chat stays in the sidebar.',
      );
      focusComposer(0);
    } finally {
      compactingRef.current = false;
    }
  }

  function executeComposerCommand(command: ComposerCommand, nextPrompt = prompt) {
    let resolvedPrompt = nextPrompt;
    if (command.id === 'chat') {
      // Chat is the only composer mode; nothing to switch.
    } else if (command.id === 'new') {
      resetComposerSession();
      focusComposer(0);
      return;
    } else if (command.id === 'plugins') {
      void openMarketplaceSurface();
    } else if (command.id === 'settings') {
      openSettingsSurface();
    } else if (command.id === 'clawhunt') {
      openSettingsSurface('settings-clawhunt');
    } else if (command.id === 'cost') {
      showSessionUsage();
    } else if (command.id === 'compact') {
      void compactSession();
    }
    exitComposerHistoryBrowse();
    setPrompt(resolvedPrompt);
    setSelectedContextRefs((current) => syncContextRefsWithPrompt(resolvedPrompt, current));
    setComposerTrigger(null);
    focusComposer(resolvedPrompt.length);
  }

  function openSlashMenu() {
    // Programmatically open the slash-command menu (replaces the old static command bar).
    exitComposerHistoryBrowse();
    const base = prompt.startsWith('/') ? prompt : `/${prompt}`;
    setPrompt(base);
    setSelectedContextRefs((current) => syncContextRefsWithPrompt(base, current));
    updateComposerTrigger(base, 1);
    focusComposer(1);
  }

  function applyComposerSuggestion(suggestion: ComposerSuggestion) {
    if (!composerTrigger) return;
    if (suggestion.kind === 'command' && suggestion.command) {
      const nextPrompt = replaceComposerToken(prompt, composerTrigger, '').replace(/[ \t]{2,}/g, ' ');
      executeComposerCommand(suggestion.command, nextPrompt);
      return;
    }
    if (suggestion.kind === 'skill') {
      // Insert the `@skill:<slug>` token as plain text — the kernel parses @skill from
      // the message into an explicit overlay (no context_ref channel). Trailing space
      // so the user keeps typing after the token.
      const nextPrompt = replaceComposerToken(prompt, composerTrigger, `${suggestion.token} `).replace(/[ \t]{2,}/g, ' ');
      const caret = Math.min(composerTrigger.start + suggestion.token.length + 1, nextPrompt.length);
      setPrompt(nextPrompt);
      setComposerTrigger(null);
      focusComposer(caret);
      return;
    }
    if (suggestion.kind === 'context' && suggestion.ref) {
      const nextPrompt = replaceComposerToken(prompt, composerTrigger, '').replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+/, '');
      const caret = Math.min(composerTrigger.start, nextPrompt.length);
      exitComposerHistoryBrowse();
      // "Create a company" is an INTENT, not a context ref to attach. Provision it
      // DIRECTLY on the Paperclip Node control plane — the SAME native endpoint the
      // board's onboarding uses (createPaperclipCompany → POST /companies) — instead of
      // attaching an @company:create chip that would steer an agent through the
      // deprecated Python orchestrator delivery run + kernel company_create tool. The
      // new company is born in its single home (a Node uuid) and shows up immediately
      // in the @-menu union.
      if (suggestion.ref.type === 'company_create') {
        setPrompt(nextPrompt);
        setComposerTrigger(null);
        focusComposer(caret);
        void createCompanyDirect(suggestion.ref);
        return;
      }
      setPrompt(nextPrompt);
      setSelectedContextRefs((current) => {
        const withoutDuplicate = current.filter((ref) => contextRefKey(ref) !== contextRefKey(suggestion.ref!));
        return syncContextRefsWithPrompt(nextPrompt, [...withoutDuplicate, suggestion.ref!]);
      });
      setComposerTrigger(null);
      focusComposer(caret);
    }
  }

  // Provision a company directly on the Paperclip Node control plane (no Python
  // orchestrator run, no kernel company_create tool). THREE outcomes, all surfaced via
  // setMessage: (1) created → prepend to the @-menu union; (2) Node present but refused
  // (validation/governance) → surface the rejection, NEVER retry on Python (that would
  // bypass Node's authorization); (3) Node UNREACHABLE (pure-Python / no front door) →
  // fall back to the legacy path by attaching the @company:create overlay so the next
  // send provisions it through the Python kernel (no pure-Python regression).
  async function createCompanyDirect(ref: ComposerContextRef) {
    const name = String(ref.metadata?.name_hint ?? '').trim();
    if (!name) {
      setMessage(locale === 'zh' ? '请先输入公司名再创建' : 'Type a company name first');
      return;
    }
    setMessage(locale === 'zh' ? `正在创建公司「${name}」…` : `Creating company "${name}"…`);
    const created = await createPaperclipCompany(name);
    if (created) {
      setComposerTeamCompanies((current) => [
        created,
        ...current.filter((c) => c.company_profile_id !== created.company_profile_id),
      ]);
      setMessage(locale === 'zh' ? `已创建公司「${created.name}」` : `Created company "${created.name}"`);
      return;
    }
    // Recoverability is decided from an EXPLICIT deployment-mode signal, NOT the create's
    // HTTP status (a 404 is ambiguous; inferring "Node absent" from it would be fail-open).
    // The legacy Python fallback is allowed ONLY when the kernel EXPLICITLY reports Node is
    // not enabled (a pure-Python deployment). Every other state is fail-closed and never
    // falls back: Node enabled (engine is Node — bypassing it would skip Node governance);
    // Node enabled-but-not-ready (TRANSIENT — starting / crash-restart / failed health
    // check, not pure-Python); and unknown (runtimeStatus null / node section absent /
    // status not yet loaded) — an unknown state must not be optimistically treated as
    // pure-Python. So: fallback ⟺ enabled === false; everything else ⇒ fail-closed.
    const nodePureMode = runtimeStatus?.node?.enabled === false;
    if (!nodePureMode) {
      // Node is (or may be) this deployment's engine — never silently retry on Python (would
      // bypass Node authorization). Distinguish a known-not-ready from a generic failure.
      const knownNotReady = runtimeStatus?.node?.enabled === true && runtimeStatus?.node?.ready !== true;
      setMessage(
        knownNotReady
          ? locale === 'zh'
            ? 'Node 服务尚未就绪,请稍后重试'
            : 'Node service not ready yet — try again'
          : locale === 'zh'
            ? `创建公司「${name}」失败`
            : `Failed to create company "${name}"`,
      );
      return;
    }
    // Node EXPLICITLY not enabled (pure-Python deployment): FAIL CLOSED — do NOT fall back
    // to the Python kernel create path. Attaching the @company:create overlay would route
    // the next send to the deprecated Python orchestrator delivery (Python
    // `_has_company_overlay` classifies company/company_create context refs as delivery),
    // which this surface no longer uses. The chat composer creates companies on Node only.
    setMessage(
      locale === 'zh'
        ? `Node 不可用,暂不能创建公司「${name}」`
        : `Node unavailable — can't create company "${name}" right now`,
    );
  }

  function handleComposerChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const value = event.currentTarget.value;
    setPrompt(value);
    // A real edit takes the composer out of history-recall mode: the next ArrowUp
    // starts a fresh walk from the newest prompt (history nav sets `prompt` directly
    // and never routes through onChange, so this only fires on genuine typing/paste).
    composerHistoryIndexRef.current = null;
    setSelectedContextRefs((current) => syncContextRefsWithPrompt(value, current));
    updateComposerTrigger(value, event.currentTarget.selectionStart);
  }

  function handleComposerCaretChange(event: SyntheticEvent<HTMLTextAreaElement>) {
    updateComposerTrigger(event.currentTarget.value, event.currentTarget.selectionStart);
  }

  function removeSelectedContextRef(ref: ComposerContextRef) {
    exitComposerHistoryBrowse();
    setSelectedContextRefs((current) => current.filter((item) => contextRefKey(item) !== contextRefKey(ref)));
    setPrompt((current) => current.replace(ref.visible_token, '').replace(/[ \t]{2,}/g, ' ').trimStart());
    setComposerTrigger(null);
  }

  async function stageComposerFiles(files: File[], source: ComposerAttachment['source']) {
    const accepted: ComposerAttachment[] = [];
    for (const file of files) {
      if (file.size > COMPOSER_ATTACHMENT_MAX_BYTES) {
        setMessage(`${file.name} is larger than 10MB`);
        continue;
      }
      try {
        accepted.push({
          id: composerAttachmentId(source),
          kind: fileLooksLikeImage(file) ? 'image' : 'file',
          name: file.name || 'attachment',
          mime: file.type || undefined,
          size: file.size,
          data_url: await readFileAsDataUrl(file),
          source,
        });
      } catch (error) {
        setMessage(`attachment read failed: ${String(error)}`);
      }
    }
    if (accepted.length === 0) return;
    // Staging an attachment is a deliberate edit of the live draft → leave browse mode
    // so a later ArrowDown won't drop the file by restoring the stashed draft.
    exitComposerHistoryBrowse();
    setComposerAttachments((current) => {
      const next = mergeComposerAttachments(current, accepted);
      if (next.length < current.length + accepted.length) setMessage(`attachments capped at ${COMPOSER_ATTACHMENT_LIMIT}`);
      return next;
    });
  }

  function openAttachmentPicker() {
    composerFileInputRef.current?.click();
  }

  function handleComposerFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    void stageComposerFiles(files, 'picker');
  }

  function handleComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length === 0) return;
    void stageComposerFiles(files, 'paste');
  }

  function handleComposerDrop(event: ReactDragEvent<HTMLDivElement>) {
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void stageComposerFiles(files, 'drop');
  }

  function handleComposerDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  }

  function removeComposerAttachment(id: string) {
    exitComposerHistoryBrowse();
    setComposerAttachments((current) => current.filter((item) => item.id !== id));
  }

  function handleComposerCompositionStart() {
    composerImeComposingRef.current = true;
  }

  function handleComposerCompositionEnd() {
    composerImeComposingRef.current = false;
    // Safari/WKWebView fire compositionend BEFORE the committing Enter's keydown,
    // and that keydown reports `isComposing === false`. Keep a "just committed" flag
    // up across that synchronous keydown, then drop it on the next macrotask so a
    // later, deliberate Enter still sends. (setTimeout, not rAF — a backgrounded
    // WKWebView can starve rAF; see desktop-startup notes.)
    composerImeJustEndedRef.current = true;
    window.setTimeout(() => {
      composerImeJustEndedRef.current = false;
    }, 0);
  }

  // Whether this keydown happens DURING an IME composition or in the brief window
  // right after it committed — in any browser flavor. Chrome/Firefox set
  // `isComposing`/keyCode 229 on the committing keydown itself; Safari/WKWebView fire
  // `compositionend` first, so the committing keydown reports `isComposing === false`
  // and only the `composerImeJustEndedRef` window catches it. While true, the keyboard
  // belongs to the IME: never send, never drive the suggestion menu, never recall.
  function composerKeyDuringIme(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    return (
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      composerImeComposingRef.current ||
      composerImeJustEndedRef.current
    );
  }

  // True when the collapsed caret sits on the FIRST VISUAL ROW of the textarea.
  // A hard `\n` before the caret rules it out immediately; otherwise a hidden mirror
  // (same width/font/wrap as the textarea) measures whether the text BEFORE the caret
  // wraps past one row — so a long soft-wrapped paragraph with the caret mid-text is
  // NOT first-row (no hijack), while a single-line draft with the caret at its end IS.
  function composerCaretInFirstVisualRow(ta: HTMLTextAreaElement): boolean {
    if (ta.selectionStart !== ta.selectionEnd) return false;
    const before = ta.value.slice(0, ta.selectionStart);
    if (before.includes('\n')) return false;
    if (before.length === 0) return true;
    const cs = window.getComputedStyle(ta);
    let mirror = composerCaretMirrorRef.current;
    if (!mirror) {
      mirror = document.createElement('div');
      composerCaretMirrorRef.current = mirror;
      document.body.appendChild(mirror);
    }
    const s = mirror.style;
    s.position = 'absolute';
    s.visibility = 'hidden';
    s.left = '-9999px';
    s.top = '0';
    s.height = 'auto';
    s.whiteSpace = 'pre-wrap';
    s.overflowWrap = cs.overflowWrap;
    s.wordBreak = cs.wordBreak;
    s.font = cs.font;
    s.letterSpacing = cs.letterSpacing;
    s.textTransform = cs.textTransform;
    s.padding = '0';
    s.border = '0';
    s.boxSizing = 'content-box';
    const contentWidth = ta.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
    s.width = `${Math.max(0, contentWidth)}px`;
    mirror.textContent = before;
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3 || 16;
    // jsdom (tests) has no layout → scrollHeight is 0 → treated as first row, which is
    // the correct unit-test outcome (the soft-wrap case can only be exercised in a
    // real browser with real layout).
    return mirror.scrollHeight <= lineHeight * 1.5;
  }

  // Load a recalled history turn into the composer, reproducing its FULL input
  // payload (text + context refs + attachments) exactly like re-editing a turn —
  // so the current draft's leftover refs/attachments can never leak into a send.
  function applyComposerHistoryEntry(entry: {
    content: string;
    contextRefs?: ComposerContextRef[];
    attachments?: ComposerAttachment[];
  }) {
    setPrompt(entry.content);
    setSelectedContextRefs(syncContextRefsWithPrompt(entry.content, entry.contextRefs ?? []));
    setComposerAttachments(entry.attachments ?? []);
    setComposerTrigger(null);
    composerHistoryAppliedRef.current = entry.content;
    focusComposer(entry.content.length);
  }

  // Restore the live draft (full payload) stashed when history navigation began.
  function restoreComposerDraft() {
    const draft = composerHistoryDraftRef.current;
    setPrompt(draft.content);
    setSelectedContextRefs(draft.contextRefs);
    setComposerAttachments(draft.attachments);
    setComposerTrigger(null);
    composerHistoryAppliedRef.current = draft.content;
    focusComposer(draft.content.length);
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const imeActive = composerKeyDuringIme(event);
    // When the slash/mention autocomplete is open, the keyboard drives the menu.
    if (composerTrigger) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setComposerTrigger(null);
        return;
      }
      // ...unless an IME candidate is being composed/committed — then Enter/Arrows
      // belong to the IME (committing a Chinese candidate must not pick a suggestion).
      if (imeActive) return;
      if (composerSuggestions.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedSuggestionIndex((current) => (current + 1) % composerSuggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedSuggestionIndex((current) => (current - 1 + composerSuggestions.length) % composerSuggestions.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        applyComposerSuggestion(composerSuggestions[selectedSuggestionIndex] ?? composerSuggestions[0]);
      }
      return;
    }
    // No menu open: ArrowUp/ArrowDown recall prompts submitted earlier IN THIS CHAT
    // (shell / Claude-Code style). Never hijack with a modifier held or during IME.
    const plainArrow =
      !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && !imeActive;
    // Self-heal: if we think we're browsing but the composer no longer holds the text
    // we last recalled, some other path (re-edit, slash command, queue edit, …) rewrote
    // it — drop out of browse mode so the next arrow can't clobber that fresh content.
    if (
      composerHistoryIndexRef.current !== null &&
      event.currentTarget.value !== composerHistoryAppliedRef.current
    ) {
      composerHistoryIndexRef.current = null;
    }
    const browsing = composerHistoryIndexRef.current !== null;
    if (event.key === 'ArrowUp' && plainArrow) {
      const ta = event.currentTarget;
      // ENTER history when the caret is on the first VISUAL row (covers an empty
      // composer, a single-line draft's end, and the first row of multi-line text)
      // WITHOUT hijacking ArrowUp inside long soft-wrapped text. Once browsing,
      // vertical arrows page history regardless of caret position.
      if ((browsing || composerCaretInFirstVisualRow(ta)) && composerPromptHistory.length > 0) {
        event.preventDefault();
        const cur = composerHistoryIndexRef.current;
        if (cur === null) {
          // Entering history: stash the live draft (full payload) so ArrowDown restores it.
          composerHistoryDraftRef.current = {
            content: prompt,
            contextRefs: selectedContextRefs,
            attachments: composerAttachments,
          };
          const next = composerPromptHistory.length - 1;
          composerHistoryIndexRef.current = next;
          applyComposerHistoryEntry(composerPromptHistory[next]);
        } else if (cur > 0) {
          const next = cur - 1;
          composerHistoryIndexRef.current = next;
          applyComposerHistoryEntry(composerPromptHistory[next]);
        }
        // Already at the oldest entry: swallow the key so the caret stays put.
        return;
      }
    }
    if (event.key === 'ArrowDown' && plainArrow && browsing) {
      event.preventDefault();
      const cur = composerHistoryIndexRef.current;
      if (cur !== null && cur < composerPromptHistory.length - 1) {
        const next = cur + 1;
        composerHistoryIndexRef.current = next;
        applyComposerHistoryEntry(composerPromptHistory[next]);
      } else {
        // Past the newest entry (or index drifted out of range) → restore the draft.
        composerHistoryIndexRef.current = null;
        restoreComposerDraft();
      }
      return;
    }
    // Enter sends, Shift+Enter inserts a newline. Skip every flavor of IME commit
    // (e.g. confirming a Chinese candidate with Enter) so it never leaks as a send.
    if (event.key === 'Enter' && !event.shiftKey && !imeActive) {
      event.preventDefault();
      if (!prompt.trim() && composerAttachments.length === 0) return;
      // While a turn is running this enqueues instead of sending; submitDirectChat decides.
      // Always Node-native chat (never legacy delivery mode).
      submitDirectChat();
    }
  }

  // Keep the queue ref and state in lockstep so the (synchronous) pump never reads stale data.
  function updateChatQueue(updater: (items: ChatQueueItem[]) => ChatQueueItem[]) {
    chatQueueRef.current = updater(chatQueueRef.current);
    setChatQueue(chatQueueRef.current);
  }

  // --- Per-session run-state mirrors (ref = synchronous truth, state = render) ---
  function markTurnRunning(key: string, abort: AbortController) {
    runningTurnsRef.current.set(key, abort);
    setRunningKeys([...runningTurnsRef.current.keys()]);
  }
  function clearTurnRunning(key: string) {
    runningTurnsRef.current.delete(key);
    setRunningKeys([...runningTurnsRef.current.keys()]);
  }
  // A brand-new chat starts on the 'draft' key; once its server id arrives the
  // in-flight handle (and any pause/stopping flags) migrate to the real key so
  // the spinner, Stop and queue all track the session it became.
  function migrateTurnKey(from: string, to: string) {
    if (from === to) return;
    const abort = runningTurnsRef.current.get(from);
    if (abort) {
      runningTurnsRef.current.delete(from);
      runningTurnsRef.current.set(to, abort);
      setRunningKeys([...runningTurnsRef.current.keys()]);
    }
    if (pausedKeysRef.current.delete(from)) {
      pausedKeysRef.current.add(to);
      setPausedKeys([...pausedKeysRef.current]);
    }
    if (stoppingKeysRef.current.delete(from)) {
      stoppingKeysRef.current.add(to);
      setStoppingKeys([...stoppingKeysRef.current]);
    }
    // Carry a deferred Stop intent across, so the cancel fires under the real key.
    if (pendingStopKeysRef.current.delete(from)) pendingStopKeysRef.current.add(to);
    // A LOCAL session that just became a backend session must drag its queued
    // items onto the new backend key, so they stay serial behind the running
    // turn AND carry the real session_id (continuing the same conversation).
    // Draft is deliberately excluded: by direction B, a second prompt fired at
    // a brand-new chat opens its OWN session, so its queued items must NOT be
    // re-homed onto the first turn's session.
    if (from.startsWith('l:') && to.startsWith('b:')) {
      const backendId = to.slice(2);
      let changed = false;
      const next = chatQueueRef.current.map((item) => {
        if (chatQueueItemKey(item) !== from) return item;
        changed = true;
        return { ...item, originBackendSessionId: backendId, originLocalSessionId: '' };
      });
      if (changed) updateChatQueue(() => next);
    }
  }
  function setSessionPaused(key: string, value: boolean) {
    if (value) pausedKeysRef.current.add(key);
    else pausedKeysRef.current.delete(key);
    setPausedKeys([...pausedKeysRef.current]);
  }
  function setSessionStopping(key: string, value: boolean) {
    if (value) stoppingKeysRef.current.add(key);
    else stoppingKeysRef.current.delete(key);
    setStoppingKeys([...stoppingKeysRef.current]);
  }

  // Per-session pump driven by the post-commit effect (and resume). Starts EVERY
  // queued item whose session is idle and not paused — different sessions run
  // concurrently. A session already running (or paused) is skipped, so its own
  // turns stay serial while never blocking another session.
  function pumpChatQueue() {
    // Loop because one pump can launch several different-session turns at once.
    // markTurnRunning updates runningTurnsRef synchronously (before runDirectChat
    // awaits), so the next find() already sees that session as busy.
    for (;;) {
      const next = chatQueueRef.current.find((item) => {
        const key = chatQueueItemKey(item);
        return !runningTurnsRef.current.has(key) && !pausedKeysRef.current.has(key);
      });
      if (!next) return;
      updateChatQueue((items) => items.filter((entry) => entry.id !== next.id));
      void runDirectChat(next.text, next.mode, next.contextRefs, next.attachments, {
        backend: next.originBackendSessionId,
        local: next.originLocalSessionId,
        runtimeBackend: next.runtimeBackend,
        runtimeModel: next.runtimeModel,
        runtimeEffort: next.runtimeEffort,
        runtimeHarness: next.runtimeHarness,
        runtimeDryRun: next.runtimeDryRun,
        runtimePermissionPreset: next.runtimePermissionPreset,
        pinnedWorkspaceId: next.originPinnedWorkspaceId,
      });
    }
  }

  function removeChatQueueItem(id: string) {
    updateChatQueue((items) => items.filter((item) => item.id !== id));
  }

  function moveChatQueueItem(id: string, direction: -1 | 1) {
    updateChatQueue((items) => {
      const item = items.find((entry) => entry.id === id);
      if (!item) return items;
      // Reorder WITHIN this item's own session subsequence — sessions interleave
      // in the global array, but the panel shows one session, so up/down must
      // swap with the neighbouring item of the SAME session, not the array.
      const key = chatQueueItemKey(item);
      const sameKeyIdx = items.reduce<number[]>((acc, entry, i) => {
        if (chatQueueItemKey(entry) === key) acc.push(i);
        return acc;
      }, []);
      const pos = sameKeyIdx.indexOf(items.indexOf(item));
      const targetPos = pos + direction;
      if (targetPos < 0 || targetPos >= sameKeyIdx.length) return items;
      const a = sameKeyIdx[pos];
      const b = sameKeyIdx[targetPos];
      const next = items.slice();
      [next[a], next[b]] = [next[b], next[a]];
      return next;
    });
  }

  // "Edit" pulls the item back into the composer (its own mode + mentions restored) so it can be
  // reworked. Any unsent draft already in the composer is preserved by re-queueing it, so editing
  // never silently discards typed-but-unsent text.
  function editChatQueueItem(id: string) {
    const item = chatQueueRef.current.find((entry) => entry.id === id);
    if (!item) return;
    const draft = prompt.trim();
    if (draft || composerAttachments.length > 0) {
      // Enqueuing a draft captures the composer runtime; block while it's unresolved
      // so a raw/legacy backend id can't enter the queue and reach backend_policy via
      // the pump. The composer keeps the draft so the user can retry once ready.
      if (chatRuntimeUnresolved()) return;
      chatQueueIdRef.current += 1;
      const draftItem: ChatQueueItem = {
        id: `q${chatQueueIdRef.current}`,
        text: draft || 'Inspect the attached file(s).',
        // Chat turns are Node-native only — never the retired Python delivery mode.
        mode: 'auto',
        contextRefs: syncContextRefsWithPrompt(prompt, selectedContextRefs),
        attachments: composerAttachments,
        createdAt: Date.now(),
        originBackendSessionId: activeBackendChatSessionId,
        originLocalSessionId: activeLocalChatSessionId,
        // Submit the RESOLVED canonical runtime (selectedAgentInfo is alias-aware),
        // never a stale legacy alias — closes the brief window before the reconcile
        // effect snaps selectedBackend, and the run path only accepts real adapters.
        runtimeBackend: selectedAgentInfo?.name ?? selectedBackend,
        runtimeModel: selectedAgentInfo?.supports_model_selection ? selectedModel : '',
        runtimeEffort: selectedAgentInfo?.supports_effort_selection ? selectedEffort : '',
        runtimeHarness: selectedHarness,
        runtimeDryRun: deliveryDryRun,
        runtimePermissionPreset: permissionPreset,
        originPinnedWorkspaceId: pinnedWorkspaceId,
      };
      updateChatQueue((items) => [...items.filter((entry) => entry.id !== id), draftItem]);
    } else {
      removeChatQueueItem(id);
    }
    exitComposerHistoryBrowse();
    setPrompt(item.text);
    // Restore exactly the item's own context refs — do not merge in the previous draft's refs.
    setSelectedContextRefs(syncContextRefsWithPrompt(item.text, item.contextRefs));
    setComposerAttachments(item.attachments);
    focusComposer(item.text.length);
  }

  // Copy a chat-turn's text to the clipboard, with a transient per-turn checkmark.
  async function copyChatTurn(index: number, text: string) {
    try {
      await writeClipboardText(text);
      if (copiedChatTurnTimerRef.current !== null) {
        window.clearTimeout(copiedChatTurnTimerRef.current);
      }
      setCopiedChatTurn(index);
      copiedChatTurnTimerRef.current = window.setTimeout(() => {
        setCopiedChatTurn(null);
        copiedChatTurnTimerRef.current = null;
      }, 1500);
    } catch (error) {
      setMessage(`${copy.copyFailed}: ${String(error)}`);
    }
  }

  // "Re-edit" a prior user turn: drop its text (+ attachments + context refs)
  // back into the composer. Re-editing REPLACES the composer, so guard against
  // silently discarding an in-progress draft (text, attachments, or context
  // chips the user already staged) — confirm before clobbering it.
  function reEditChatTurn(turn: DirectChatTurn) {
    const composerHasDraft =
      prompt.trim().length > 0 || composerAttachments.length > 0 || selectedContextRefs.length > 0;
    if (composerHasDraft && !window.confirm(copy.reEditOverwriteConfirm)) return;
    exitComposerHistoryBrowse();
    setPrompt(turn.content);
    setSelectedContextRefs(syncContextRefsWithPrompt(turn.content, turn.contextRefs ?? []));
    setComposerAttachments(turn.attachments ?? []);
    focusComposer(turn.content.length);
  }

  // Clear/resume act on the CURRENT chat's queue only — the queue panel shows
  // just this session's pending prompts, so its controls must not touch others.
  function clearChatQueue() {
    const key = chatTurnKey(activeBackendChatSessionId, activeLocalChatSessionId);
    updateChatQueue((items) => items.filter((item) => chatQueueItemKey(item) !== key));
    setSessionPaused(key, false);
    setChatQueueExpanded(false);
  }

  function resumeChatQueue() {
    const key = chatTurnKey(activeBackendChatSessionId, activeLocalChatSessionId);
    setSessionPaused(key, false);
    pumpChatQueue();
  }

  // Public entry for Enter / send button: run now when idle, otherwise queue behind in-flight work.
  // Goal Mode: plan THIS message into a goal (awaiting_confirmation) and open the
  // confirmation dialog. The toggle routes a send here instead of a chat turn; the
  // plan/confirm lifecycle then lives entirely in the kernel (via /api/goals/*).
  function submitGoalPlan(content: string) {
    // Delegates to the extracted, unit-tested flow (goalModeSend.ts): single
    // in-flight, prompt cleared only on success-and-unchanged, preserved on failure.
    void submitGoalPlanFlow(content, {
      readJson,
      isBusy: () => goalPlanBusyRef.current,
      setBusy: (busy) => {
        goalPlanBusyRef.current = busy;
        setGoalPlanBusy(busy);
      },
      setGoalModeRecord,
      setPrompt,
      setMessage,
    });
  }

  // A chat turn / queued draft can only carry a runtime the run path accepts. When
  // selectedAgentInfo is null the composer backend has NO inventory contract — the
  // agent inventory is still loading, or the restored/legacy id is unknown — so its
  // (possibly legacy) id would be submitted raw as backend_policy and rejected. Hold
  // the turn instead of firing a doomed request. selectedAgentInfo already resolves
  // aliases, so `!selectedAgentInfo` ⟺ the backend is unresolvable (a separate
  // canonicalizable check would be exactly redundant). Returns true (and surfaces a
  // message) when the runtime is not ready; callers `if (chatRuntimeUnresolved()) return;`.
  function chatRuntimeUnresolved(): boolean {
    if (selectedAgentInfo) return false;
    setMessage(
      locale === 'zh'
        ? '运行时尚未就绪，请稍候重试'
        : 'Runtime is still initializing — try again in a moment',
    );
    return true;
  }

  function submitDirectChat() {
    const pathAttachments = detectLocalPathAttachments(prompt);
    const submittedAttachments = mergeComposerAttachments(composerAttachments, pathAttachments);
    const content = prompt.trim() || (submittedAttachments.length > 0 ? 'Inspect the attached file(s).' : '');
    if (!content) {
      setMessage('chat turn requires a prompt');
      return;
    }
    // Fail-closed: the composer drives ONLY Node-native chat now. Refuse to SEND any text
    // the Python fallback would classify as a legacy delivery turn — this MIRRORS Python's
    // exact detection (chat_turn.py: `"@delivery" in lowered` || `startswith("/delivery")`
    // || `" /delivery" in lowered`) so `please /delivery ship` and `(@delivery)` are caught
    // too, not just a leading token. None of these may reach /api/chat/stream (the Python
    // path would route them to the deprecated orchestrator delivery run).
    const loweredContent = content.toLowerCase();
    if (
      loweredContent.includes('@delivery') ||
      loweredContent.startsWith('/delivery') ||
      loweredContent.includes(' /delivery')
    ) {
      setMessage(
        locale === 'zh'
          ? 'delivery 已停用,直接描述你的任务即可(或用目标模式)'
          : 'delivery is retired — just describe your task (or use Goal mode)',
      );
      return;
    }
    // Goal Mode short-circuit: send plans a goal + opens the dialog, never a turn.
    if (goalModeOn) {
      // The goal planner takes only the message today; refuse rather than SILENTLY
      // drop attachments / context refs the user added (no data loss). They are
      // kept in the composer so the user can remove them or turn Goal Mode off.
      if (submittedAttachments.length > 0 || selectedContextRefs.length > 0) {
        setMessage(
          locale === 'zh'
            ? '目标模式暂不携带附件或上下文引用，请先移除后再发送'
            : 'Goal mode does not carry attachments or context refs yet — remove them first',
        );
        return;
      }
      // The prompt is cleared inside submitGoalPlan ONLY on success, so a failed
      // /api/goals/plan never discards the user's typed text.
      // Submitting (planning a goal) leaves prompt-history browse mode, same as the
      // normal turn path below — so a later ArrowDown can't restore a stale draft.
      composerHistoryIndexRef.current = null;
      void submitGoalPlan(content);
      return;
    }
    // Runtime must be resolved before an actual chat turn (this is AFTER the Goal
    // Mode short-circuit, which plans a goal and sends no backend_policy).
    if (chatRuntimeUnresolved()) return;
    // The chat composer drives ONLY Node-native chat — the deprecated Python
    // orchestrator delivery path is gone, so a turn's mode is structurally "auto".
    const turnMode = 'auto' as const;
    const submittedContextRefs = syncContextRefsWithPrompt(prompt, selectedContextRefs);
    // Fail-closed: a legacy Python company (company_*) has no Node home, so it cannot run
    // a chat turn on the Node engine. Left unguarded the turn would reach Node with no
    // company_id and SILENTLY execute in the default personal-chat company — a
    // wrong-company / fail-open break (the user @-selected a specific company and expects
    // its context/agents/permissions). Block it with a clear prompt to recreate the
    // company natively, instead of running it somewhere the user did not intend. Checked
    // BEFORE the composer is cleared so the user keeps their input.
    const legacyCompanyRef = submittedContextRefs.find(
      (r) => r.type === 'company' && typeof r.id === 'string' && !NODE_COMPANY_UUID_RE.test(r.id),
    );
    if (legacyCompanyRef) {
      setMessage(
        locale === 'zh'
          ? `存量公司「${legacyCompanyRef.label ?? legacyCompanyRef.id}」暂不能在 chat 中使用,请在工作台重建为 Node 公司`
          : `Legacy company "${legacyCompanyRef.label ?? legacyCompanyRef.id}" can't be used in chat yet — recreate it natively`,
      );
      return;
    }
    // Enqueue only when THIS chat is already busy or has its own pending items —
    // a turn running in a different chat must never push this one into a queue.
    const composerKey = chatTurnKey(activeBackendChatSessionId, activeLocalChatSessionId);
    const queuedForKey = chatQueueRef.current.filter((item) => chatQueueItemKey(item) === composerKey).length;
    const willEnqueue = runningTurnsRef.current.has(composerKey) || queuedForKey > 0;
    if (willEnqueue && queuedForKey >= CHAT_QUEUE_LIMIT) {
      setMessage(copy.queueFull);
      return;
    }
    setPrompt('');
    composerHistoryIndexRef.current = null;
    setSelectedContextRefs([]);
    setComposerAttachments([]);
    setComposerTrigger(null);
    if (willEnqueue) {
      chatQueueIdRef.current += 1;
      const item: ChatQueueItem = {
        id: `q${chatQueueIdRef.current}`,
        text: content,
        mode: turnMode,
        contextRefs: submittedContextRefs,
        attachments: submittedAttachments,
        createdAt: Date.now(),
        // Pin the queued turn to the session AND runtime in view at submit
        // time, so the pump runs it there even after the user navigates or
        // changes the backend/model.
        originBackendSessionId: activeBackendChatSessionId,
        originLocalSessionId: activeLocalChatSessionId,
        // Submit the RESOLVED canonical runtime (selectedAgentInfo is alias-aware),
        // never a stale legacy alias — closes the brief window before the reconcile
        // effect snaps selectedBackend, and the run path only accepts real adapters.
        runtimeBackend: selectedAgentInfo?.name ?? selectedBackend,
        runtimeModel: selectedAgentInfo?.supports_model_selection ? selectedModel : '',
        runtimeEffort: selectedAgentInfo?.supports_effort_selection ? selectedEffort : '',
        runtimeHarness: selectedHarness,
        runtimeDryRun: deliveryDryRun,
        runtimePermissionPreset: permissionPreset,
        originPinnedWorkspaceId: pinnedWorkspaceId,
      };
      updateChatQueue((items) => [...items, item]);
      return;
    }
    // Running a fresh prompt from idle clears any lingering pause from an earlier
    // Stop on THIS chat only.
    setSessionPaused(composerKey, false);
    void runDirectChat(content, turnMode, submittedContextRefs, submittedAttachments);
  }

  async function runDirectChat(
    content: string,
    turnMode: 'auto',
    submittedContextRefs: ComposerContextRef[],
    submittedAttachments: ComposerAttachment[],
    // Queued turns carry the session AND runtime selection active when they
    // were enqueued; the immediate path passes none and uses the live values.
    origin?: {
      backend: string;
      local: string;
      runtimeBackend: string;
      runtimeModel: string;
      runtimeEffort: string;
      runtimeHarness: string;
      runtimeDryRun: boolean;
      runtimePermissionPreset: 'ask' | 'allow';
      pinnedWorkspaceId: string | null;
    },
  ) {
    // A queued turn is PINNED to its recorded origin — never the live selection
    // (which may have drifted as the user navigated). A non-empty origin.backend
    // locks directly. An EMPTY origin (a draft queued before its server id
    // existed) deliberately does NOT try to guess a session: every guess —
    // falling back to the active chat, or inheriting whatever turn happened to
    // be in flight at enqueue — can route the turn into an unrelated session.
    // Empty stays empty and the turn opens its own fresh session; the cost is
    // that two prompts fired in instant succession at a brand-new chat land in
    // two sessions, which is safe (no data crosses chats) and rare.
    const originBackend = origin ? origin.backend : activeBackendChatSessionId;
    const originLocal = origin ? origin.local : activeLocalChatSessionId;
    // This turn's per-session key — its run-state/queue/Stop all hang off it.
    // Starts on 'draft' for a brand-new chat, then migrates to the real backend
    // key once chat.started returns the server id (see below).
    let turnKey = chatTurnKey(originBackend, originLocal);
    // Idle/immediate send: use the RESOLVED canonical runtime (selectedAgentInfo is
    // alias-aware), never a stale legacy alias like a restored "codex" that the run
    // path would reject. Queued turns already captured their canonical origin.
    const turnBackend = origin ? origin.runtimeBackend : (selectedAgentInfo?.name ?? selectedBackend);
    const turnModel = origin
      ? origin.runtimeModel
      : selectedAgentInfo?.supports_model_selection
        ? selectedModel
        : '';
    const turnEffort = origin
      ? origin.runtimeEffort
      : selectedAgentInfo?.supports_effort_selection
        ? selectedEffort
        : '';
    const turnHarness = origin ? origin.runtimeHarness : selectedHarness;
    const turnDryRun = origin ? origin.runtimeDryRun : deliveryDryRun;
    const turnPermissionPreset = origin ? origin.runtimePermissionPreset : permissionPreset;
    // /compact seed: the FIRST turn of a post-compact draft session carries the summary
    // to the agent's fresh native context. Consumed-or-dropped exactly once: only a turn
    // that opens a brand-new session (no origin ids) may use it; any other submit drops
    // it as stale so it can never leak into an unrelated chat. Only the SENT payload is
    // prefixed — the visible user bubble stays the user's own text (the summary is
    // already on screen in the boundary marker turn).
    let sentContent = content;
    if (compactSeedRef.current) {
      const compactSeed = compactSeedRef.current;
      compactSeedRef.current = null;
      if (!originBackend && !originLocal) {
        sentContent = applyCompactSeed(compactSeed, content, locale === 'zh' ? 'zh' : 'en');
      }
    }
    const userTurn: DirectChatTurn = {
      role: 'user',
      content,
      status: 'sent',
      attachments: submittedAttachments.length > 0 ? submittedAttachments : undefined,
      contextRefs: submittedContextRefs.length > 0 ? submittedContextRefs : undefined,
    };
    // Base the optimistic transcript on the ORIGIN session's history (a queued
    // turn whose session the user has navigated away from must not append onto
    // — or persist into — whatever chat is currently on screen).
    const originBaseTurns: DirectChatTurn[] = origin
      ? (backendChatSessions.find((session) => session.session_id === originBackend)?.messages ?? []).map((m) => ({
          role: m.role,
          content: m.content,
          status: m.status,
          run_id: m.run_id ?? undefined,
          contextRefs: m.context_refs && m.context_refs.length > 0 ? m.context_refs : undefined,
        }))
      : activeBackendChatSessionId || activeLocalChatSessionId
        ? directChatTurns
        : [];
    const pendingTurns = [...originBaseTurns, userTurn];
    // Shared start stamp for THIS turn's live "用时 Ns" counter (痛点4); carried on
    // every working-turn snapshot below so the meta-row timer ticks from one origin.
    const turnStartedAt = Date.now();
    const workingTurns = [...pendingTurns, { role: 'assistant' as const, content: copy.directChatWorking, status: 'working', startedAt: turnStartedAt }];
    const sessionTitle =
      (originBackend ? backendChatSessions.find((session) => session.session_id === originBackend)?.title : undefined) ??
      localChatTitle(content);
    let resolvedSessionId = originBackend;
    const focusOrigin = {
      backend: originBackend,
      local: originLocal,
    };
    const shouldKeepDirectChatFocus = (sessionId: string | null | undefined = resolvedSessionId) => {
      const currentBackend = activeBackendChatSessionIdRef.current;
      const currentLocal = activeLocalChatSessionIdRef.current;
      if (focusOrigin.backend) {
        return !currentLocal && (currentBackend === focusOrigin.backend || (Boolean(sessionId) && currentBackend === sessionId));
      }
      if (focusOrigin.local) {
        return (
          currentLocal === focusOrigin.local ||
          (!currentBackend && !currentLocal) ||
          (Boolean(sessionId) && currentBackend === sessionId)
        );
      }
      return !currentLocal && (!currentBackend || (Boolean(sessionId) && currentBackend === sessionId));
    };
    const setFocusedDirectChatTurns = (turns: DirectChatTurn[], sessionId: string | null | undefined = resolvedSessionId) => {
      // Record the live turns for this session (incl. reasoning/tool display + the
      // 'working' status) REGARDLESS of focus, so switching back to a still-running
      // or just-finished BACKGROUND session can re-attach the accumulated live state
      // (openSidebarSessionItem consults this). Only the focused paint is gated.
      if (sessionId) liveChatTurnsRef.current.set(sessionId, turns);
      if (shouldKeepDirectChatFocus(sessionId)) setDirectChatTurns(turns);
    };
    const activateBackendChatSessionIfFocused = (sessionId: string | null | undefined) => {
      if (!sessionId || !shouldKeepDirectChatFocus(sessionId)) return false;
      setActiveLocalChatSessionId('');
      setActiveBackendChatSessionId(sessionId);
      return true;
    };
    // Immediate path leaves the local-chat surface (a backend turn supersedes
    // it); a queued turn must not disturb whatever surface the user now views.
    if (!origin) setActiveLocalChatSessionId('');
    const abortController = new AbortController();
    // Mark THIS session running (synchronous, before any await) so the pump and
    // submit see it busy and other sessions stay unblocked. A brand-new chat
    // runs on the 'draft' key; chat.started migrates it to the real backend key
    // below, so its spinner/Stop attach to the session it becomes.
    markTurnRunning(turnKey, abortController);
    setSessionStopping(turnKey, false);
    // Submitting a turn means the user wants to watch its reply — re-pin to the
    // bottom even if they'd scrolled up earlier (D). But ONLY when this turn targets
    // the transcript the user is actually viewing: a queued/background session must
    // not reset the open conversation's scroll state. Reuse the SAME focus guard
    // that gates the optimistic repaint below, so re-pin and repaint never desync.
    if (shouldKeepDirectChatFocus()) setChatPinnedToBottom(true);
    // Show the optimistic transcript ONLY if the user is still on that session
    // (a queued turn for a backgrounded chat must not paint onto the open one).
    setFocusedDirectChatTurns(workingTurns);
    let assistantText = '';
    // Finalized outcome of this turn, returned to programmatic callers (/compact needs
    // the summary text). Existing call sites use `void runDirectChat(...)` — unaffected.
    let turnOutcome: { status: string; text: string } | undefined;
    // Aggregates canonical Display Protocol events (tool.*/reasoning.*/usage)
    // streamed for this turn into renderable cards. Ephemeral: attached to the
    // live assistant turn, dropped on reload (v1 cut).
    const displayAcc = new DisplayAccumulator();
    const liveDisplay = (): DisplaySnapshot | undefined =>
      displayAcc.hasContent() ? displayAcc.snapshot() : undefined;
    try {
      setMessage('');
      const runtimeSession = await ensureDesktopRuntimeSession();
      if (desktopMode && !runtimeSession?.handle?.base_url) {
        throw new Error('desktop runtime is not connected');
      }
      let handledDelivery = false;
      let finalized = false;
      // The execution boundary for EVERY turn (not just the first) follows the
      // project this chat belongs to — the kernel runs the turn in
      // request.repo_path, so a follow-up that fell back to '.' would execute in
      // the server cwd (or 403 at the trust gate). When set we send workspace_id
      // + repo_path:null so the kernel resolves the workspace's own root (mirrors
      // `superclaw chat --workspace <id>`); built-in Chat and unassigned chats
      // keep the flat '.' behaviour byte-for-byte.
      //
      // Source of truth, in order:
      // - A turn WITH a session id follows the SESSION, never the pin: its real
      //   workspace (backendChatSessions) is authoritative, so a mid-conversation
      //   "move to project" is honoured and a stale pin can't drag it back. The
      //   per-session create map covers the brief lag before the optimistic
      //   record gains the kernel's workspace_id (it holds the same id we filed
      //   it under) — still never the global pin.
      // - A brand-new draft (no session id yet) uses the live pin, or the pin the
      //   queued turn captured at enqueue.
      // When set we send workspace_id + repo_path:null so the kernel executes in
      // the workspace's own root (CLI parity: `chat --workspace <id>`); built-in
      // Chat / unassigned chats keep the flat '.' behaviour byte-for-byte.
      let turnWorkspaceId: string | null = null;
      if (!originBackend) {
        // Brand-new draft → the project it was opened in (live pin, or the pin a
        // queued turn captured at enqueue). Never consulted once a session id exists.
        turnWorkspaceId = origin ? origin.pinnedWorkspaceId : pinnedWorkspaceId;
      } else if (confirmedChatIdsRef.current.has(originBackend)) {
        // Backend-CONFIRMED session → its real binding is authoritative, full stop.
        // Flat ('.') ONLY when truly unassigned (no id) or bound to the KNOWN
        // built-in Chat workspace (F2: byte-identical to main). ANY other bound id —
        // including one the current inventory doesn't project (a transient fetch gap
        // or a non-personal workspace) — is sent as-is so the kernel governs it
        // fail-closed (403 untrusted / 404 gone), NEVER silently downgraded to the
        // server cwd. The create map is not consulted here, so a moved session can
        // never be dragged back.
        const boundId = backendChatSessions.find((s) => s.session_id === originBackend)?.workspace_id ?? null;
        const known = boundId ? workspaces.find((w) => w.workspace_id === boundId) : undefined;
        turnWorkspaceId = boundId && !known?.builtin_chat ? boundId : null;
      } else {
        // Optimistic lag ONLY: a brand-new session whose confirmed record (carrying
        // the kernel's workspace_id) hasn't arrived yet. Use the project we filed it
        // under on chat.started — never the global pin (which may have moved on).
        turnWorkspaceId = chatSessionWorkspaceRef.current.get(originBackend) ?? null;
      }
      // @company runs the turn natively INSIDE that company on the Node engine when the
      // company is Node-native (a uuid): the Node chat route hosts the session as an issue
      // in that company and wakes its agents. Legacy Python companies (company_*) have no
      // Node home and are rejected fail-closed BEFORE this point (the legacyCompanyRef
      // guard above returns early), so by here only a uuid company can be present — this
      // find never matches a legacy id. uuid detection mirrors the Node UUID_RE.
      const turnCompanyId = submittedContextRefs.find(
        (r) => r.type === 'company' && typeof r.id === 'string' && NODE_COMPANY_UUID_RE.test(r.id),
      )?.id;
      await streamChatTurn(
        {
          // sentContent = the user's text, plus the one-time /compact summary prefix
          // when this turn opens the post-compact session (see seed block above).
          message: sentContent,
          // Node-native @company home for this turn (see above); undefined ⇒ omitted
          // (default personal-chat company).
          company_id: turnCompanyId,
          // The turn's OWN session (origin for a queued turn), never the live
          // selection — a queued turn must reach the session it was sent from.
          // BUT: when this turn targets a Node-native @company (turnCompanyId), the
          // current session belongs to the personal-chat company, so sending its
          // session_id would make the Node engine look it up INSIDE turnCompanyId, miss,
          // and fail the turn with session_not_found. We omit it so the backend creates a
          // fresh company-scoped session. (The composer's loaded sessions are personal;
          // full company-scoped session continuity is a follow-up.)
          session_id: turnCompanyId ? undefined : resolvedSessionId || undefined,
          mode: turnMode,
          dry_run: turnDryRun,
          backend_policy: turnBackend,
          // visible composer state IS the per-turn request ('' = explicit
          // backend-default), mirroring the CLI shell semantics. A backend
          // without model selection never receives a stale hidden model — the
          // field is not offered, so the request carries the explicit clear.
          model: turnModel,
          // Per-turn reasoning effort — composer state IS the request (mirrors
          // `model`): '' is the explicit "use the runtime default this turn"
          // (clears any sticky override); a backend without effort selection is
          // gated to '' above so it never receives a stale hidden value.
          effort: turnEffort,
          // direct_chat_backend is intentionally NOT sent: a plain chat turn
          // executes on the resolved runtime (the backend pill), same as the CLI.
          harness_policy: turnHarness,
          // Execution boundary: with a project, null + workspace_id resolves the
          // project's own root. With NO project, a pure chat runs in the managed
          // Chat scratch (repo_path:null → kernel ensure_chat_workspace) — this is
          // PR-B's "pure chat → scratch", at CLI parity with `chat` defaulting
          // --repo to None. Chat turns are Node-native only (the Python delivery
          // path that used '.' is gone), so repo_path is always null here.
          repo_path: null,
          // The project this turn executes in (CLI parity: `chat --workspace
          // <id>`). Omitted (undefined → dropped) for flat/unassigned turns. A flat
          // chat then resolves to the Chat scratch.
          workspace_id: turnWorkspaceId ?? undefined,
          // A chat turn dispatches to a real agent runtime whose own startup +
          // remote-API round-trip can be slow (e.g. grok via a proxy to xAI is
          // ~25-30s before any token); 60s clipped legitimate replies. 180s
          // gives slow runtimes headroom while still bounding a wedged turn.
          budget_seconds: 180,
          verification_policy: 'adversarial',
          context_refs: submittedContextRefs,
          attachments: attachmentRequestPayload(submittedAttachments),
          permission_preset: turnPermissionPreset,
        },
        (event, data) => {
          if (data?.session_id) {
            resolvedSessionId = data.session_id;
            // Record the project this session was created in so its immediate
            // follow-up resolves correctly even before the optimistic record
            // (which carries no workspace_id) is replaced by the kernel fetch.
            if (turnWorkspaceId) chatSessionWorkspaceRef.current.set(data.session_id, turnWorkspaceId);
            // The pin is NOT cleared here: clearing in this async callback races
            // with a fresh pin the user may have just set on another project
            // (the in-flight turn would wipe it). The pin is cleared only on
            // explicit navigation (openSidebarSessionItem) or a new draft
            // (resetComposerSession); a turn bearing a session id never reads the
            // pin anyway (it follows the session), so a lingering pin is inert.
            // Migrate this turn's run-state key now that a brand-new chat (or a
            // local-only chat) has its server id, so its spinner/Stop/queue all
            // track the backend session it became. No-op once already migrated.
            const realKey = chatTurnKey(data.session_id, '');
            if (turnKey !== realKey) {
              migrateTurnKey(turnKey, realKey);
              turnKey = realKey;
            }
            // A Stop pressed during the draft window (before this server id was
            // known) deferred its abort + native cancel. Now that we have the id,
            // fire it: kill the backing run, then abort the client stream. Runs
            // once (delete), so later session_id events don't re-fire.
            if (pendingStopKeysRef.current.delete(turnKey)) {
              void stopBackendChatSession(data.session_id);
              abortController.abort();
            }
          }
          if (isChatDisplayEvent(event)) {
            // Canonical tool/reasoning/usage/adapter.diagnostic event: fold into
            // the live display state and re-render the working assistant turn
            // (tool cards, reasoning, usage, or BATCH "no live tools" note).
            displayAcc.apply(data);
            setFocusedDirectChatTurns([
              ...pendingTurns,
              { role: 'assistant' as const, content: foldSkillProposalForDisplay(assistantText) || copy.directChatWorking, status: 'working', startedAt: turnStartedAt, display: liveDisplay() },
            ]);
            return;
          }
          if (event === 'chat.started' && data.session_id) {
            // The optimistic session has no runtime metadata yet — mark it as
            // applied so the restore effect keeps the selection this turn was
            // sent with instead of resetting the pill to the default.
            appliedChatRuntimeRef.current = `${data.session_id}:null`;
            activateBackendChatSessionIfFocused(data.session_id);
            setFocusedDirectChatTurns(workingTurns, data.session_id);
            rememberBackendChatSession(data.session_id, sessionTitle, workingTurns);
          } else if (event === 'delivery') {
            // Fail-closed: the chat surface no longer runs legacy Python delivery, so a
            // `delivery` SSE handle (a deprecated orchestrator run) must NOT reopen the run
            // cockpit or record a run in chat. Mark it handled (so the turn isn't treated as
            // an empty no-response) and surface a notice instead of expanding the cockpit.
            handledDelivery = true;
            setMessage(
              locale === 'zh'
                ? 'delivery 已停用,该响应不再在 chat 中展开'
                : 'delivery is retired — this response is not expanded in chat',
            );
          } else if (event === 'message.delta') {
            assistantText += data.text ?? '';
            // Fold a (still-streaming) skill-proposal block to a placeholder so the
            // raw <superclaw_skill_proposal> tags never show live; chat.completed
            // then replaces the bubble with the sanitized confirmation.
            setFocusedDirectChatTurns([...pendingTurns, { role: 'assistant' as const, content: foldSkillProposalForDisplay(assistantText) || copy.directChatWorking, status: 'working', startedAt: turnStartedAt, display: liveDisplay() }]);
          } else if (event === 'message.completed') {
            if (data.text) assistantText = data.text;
            setFocusedDirectChatTurns([...pendingTurns, { role: 'assistant' as const, content: foldSkillProposalForDisplay(assistantText), status: 'working', startedAt: turnStartedAt, display: liveDisplay() }]);
          } else if (event === 'chat.completed') {
            finalized = true;
            const status = data.status || 'completed';
            // "queued" is NOT a failure: a second prompt sent while this chat's
            // agent is still running THIS turn is durably enqueued (the in-flight
            // run promotes it on completion), and the backend reports
            // status:"queued"/failure_reason:"wakeup_deferred". Show a friendly
            // queued notice instead of folding the raw reason code into the bubble.
            const statusIsQueued = status === 'queued';
            // Success uses the backend-sanitized response; the assistantText
            // fallback (failure/anomaly with no response) is folded so a raw
            // proposal block never lands in the final bubble either.
            const finalText = statusIsQueued
              ? t('Chat queued behind running turn')
              : (data.response || foldSkillProposalForDisplay(assistantText) || data.failure_reason || '').trim();
            turnOutcome = { status, text: finalText };
            // Carry the server-authoritative metering onto the LIVE turn so the hover
            // meta row shows token usage + 用时 + "刚刚完成" the instant the turn ends —
            // without waiting for a session reload. ONLY for a successfully-completed
            // turn: a failed/stopped turn carries no metering and must not show a
            // "completed X ago" line (the meter render also gates on status, but we
            // don't even stamp the fields here). createdAt is the client clock (the
            // message was just created → "刚刚完成"); elapsedMs/usage come from the
            // completion event so live and the persisted reload agree (zero jump).
            const turnSucceeded = status === 'completed';
            const liveUsage =
              turnSucceeded && data.usage && typeof data.usage === 'object' && !Array.isArray(data.usage)
                ? (data.usage as Record<string, number>)
                : undefined;
            const completedTurns = [
              ...pendingTurns,
              {
                role: 'assistant' as const,
                content: finalText,
                status,
                run_id: data.run_id ?? null,
                display: liveDisplay(),
                usage: liveUsage,
                elapsedMs: turnSucceeded && typeof data.elapsed_ms === 'number' ? data.elapsed_ms : undefined,
                createdAt: turnSucceeded ? Date.now() / 1000 : undefined,
              },
            ];
            setFocusedDirectChatTurns(completedTurns);
            if (resolvedSessionId) {
              activateBackendChatSessionIfFocused(resolvedSessionId);
              rememberBackendChatSession(resolvedSessionId, sessionTitle, completedTurns);
            }
            if (data.run_id) {
              rememberRunSession(provisionalRunSession(data.run_id, 'chat-turn', status, false));
              if (shouldKeepDirectChatFocus(resolvedSessionId)) setRunId(data.run_id);
            }
            // Raise a prominent login banner on an auth failure, keyed to THIS
            // turn's chat (turnKey is the migrated, real key by now) — a real
            // reply clears it. Per-key, so a background turn never touches the
            // banner of the chat in view; the banner shows only when the user is
            // looking at the chat whose key has a notice.
            setRuntimeLoginNotices((prev) => {
              if (status === 'completed') {
                if (!(turnKey in prev)) return prev;
                const next = { ...prev };
                delete next[turnKey];
                return next;
              }
              const notice = runtimeAuthFailureNotice(data.failure_reason);
              return notice ? { ...prev, [turnKey]: notice } : prev;
            });
            setMessage(
              status === 'completed'
                ? `chat completed via ${data.backend || selectedBackend || 'codex'}`
                : statusIsQueued
                  ? t('Chat queued behind running turn')
                  : data.failure_reason || 'direct chat failed',
            );
          }
        },
        runtimeSession,
        abortController.signal,
      );
      if (handledDelivery) {
        // refresh sessions so the chat's persisted runtime metadata arrives and
        // the sticky-restore effect can re-apply it from the source of truth
        await loadChatSessions();
        return;
      }
      setSelectedContextRefs([]);
      if (!finalized) {
        const completedTurns = [...pendingTurns, { role: 'assistant' as const, content: foldSkillProposalForDisplay(assistantText) || 'direct chat produced no output', status: assistantText ? 'completed' : 'failed', display: liveDisplay() }];
        setFocusedDirectChatTurns(completedTurns);
        if (resolvedSessionId) rememberBackendChatSession(resolvedSessionId, sessionTitle, completedTurns);
        turnOutcome = { status: assistantText ? 'completed' : 'failed', text: foldSkillProposalForDisplay(assistantText) };
      }
      await loadChatSessions();
    } catch (error) {
      const isAbort = error instanceof DOMException ? error.name === 'AbortError' : abortController.signal.aborted;
      if (isAbort) {
        // User-initiated stop: keep whatever streamed so far (text AND the tool
        // cards already shown — losing them would drop live-session evidence),
        // mark the turn as stopped.
        const stoppedTurns = [
          ...pendingTurns,
          { role: 'assistant' as const, content: foldSkillProposalForDisplay(assistantText.trim()) || copy.stopped, status: 'stopped', display: liveDisplay() },
        ];
        setFocusedDirectChatTurns(stoppedTurns);
        if (resolvedSessionId) {
          activateBackendChatSessionIfFocused(resolvedSessionId);
          rememberBackendChatSession(resolvedSessionId, sessionTitle, stoppedTurns);
        }
        setMessage(copy.stopped);
      } else {
        const detail = `chat turn failed: ${String(error)}`;
        const failedTurns = [...pendingTurns, { role: 'assistant' as const, content: detail, status: 'failed', display: liveDisplay() }];
        setFocusedDirectChatTurns(failedTurns);
        if (resolvedSessionId) {
          activateBackendChatSessionIfFocused(resolvedSessionId);
          rememberBackendChatSession(resolvedSessionId, sessionTitle, failedTurns);
        }
        setMessage(detail);
      }
    } finally {
      // Release THIS session's slot (turnKey is the migrated, real key by now).
      clearTurnRunning(turnKey);
      setSessionStopping(turnKey, false);
      // Drop any deferred-Stop intent that never resolved (e.g. the turn ended
      // before a session_id event arrived), so it can't leak across turns.
      pendingStopKeysRef.current.delete(turnKey);
      // NOTE: do not pump here. The just-completed turn's state (transcript, session id) has only
      // been *scheduled*, so this stale closure would start the next item with old data (dropping
      // the prior turn and its session_id). The effect below pumps after the commit, reading fresh
      // state. runningKeys changing is the trigger.
    }
    return turnOutcome;
  }

  // Stop halts the CURRENT chat's turn only — a turn running in another chat
  // keeps going. We pause this session's chain (even with an empty queue) so a
  // prompt added during the async abort window doesn't auto-run; its queue is
  // kept for resume/edit/clear.
  function stopActiveTurn() {
    const key = chatTurnKey(activeBackendChatSessionId, activeLocalChatSessionId);
    const abort = runningTurnsRef.current.get(key);
    if (!abort || stoppingKeysRef.current.has(key)) return;
    setSessionStopping(key, true);
    setSessionPaused(key, true);
    const backendSessionId = activeBackendChatSessionId;
    if (backendSessionId) {
      // We know the server session id: abort the client stream AND natively kill
      // the backing run. abort() alone only detaches — the agent keeps running.
      // The cancel endpoint is keyed by session id (chat runs expose no run_id)
      // and kills the agent runtime's process group.
      abort.abort();
      void stopBackendChatSession(backendSessionId);
      return;
    }
    // Draft race: the turn was sent but chat.started hasn't returned the server
    // session id yet, so the just-spawned run can't be cancelled. Aborting NOW
    // would only detach and orphan it (a true "fake Stop"). Defer: park the
    // intent and let the stream keep reading until chat.started delivers the id,
    // then cancel + abort there (see the chat.started handler).
    pendingStopKeysRef.current.add(key);
  }

  // Stop the Node-native chat run for a session (the heartbeat run that backs a
  // pure-chat turn). Keyed by session id, since pure chat reports run_id: null.
  async function stopBackendChatSession(sessionId: string) {
    try {
      await readJson(`/api/chat/sessions/${sessionId}/cancel`, { method: 'POST' });
    } catch (error) {
      setMessage(`stop failed: ${String(error)}`);
    }
  }

  async function downloadEvalReport(format: 'md' | 'pdf') {
    if (!evalReport) {
      setMessage('eval report is not ready');
      return;
    }
    const response = await fetch(`/api/evals/${evalReport.eval_id}/report${format === 'pdf' ? '.pdf' : ''}`, { headers: authHeaders() });
    if (!response.ok) {
      setMessage(`eval report download failed: ${response.status}`);
      return;
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `${evalReport.eval_id}-report.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
    setMessage(`eval ${format.toUpperCase()} report downloaded: ${evalReport.eval_id}`);
  }


  // Rendered panel width + live interaction bounds (see lib/contextPanelGeometry). In
  // cramped windows `effective` shrinks to fit (never overflowing/clipping its own
  // controls) and the bounds collapse accordingly; the chat column keeps its
  // CHAT_MIN_WIDTH floor in every case. The ARIA separator reports these — never the
  // raw preferred width — so assistive tech matches what's on screen.
  const contextSidebarFootprint = sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth;
  const contextInteraction = contextPanelInteraction(
    contextPanelWidth,
    viewportWidth,
    contextSidebarFootprint,
  );
  const effectiveContextWidth = contextInteraction.effective;
  const shellStyle = {
    '--sidebar-width': `${sidebarWidth}px`,
    '--context-width': `${effectiveContextWidth}px`,
  } as CSSProperties;
  const themePreferenceOptions = [
    { value: 'light' as const, label: copy.themeLight, ariaLabel: copy.switchThemeToLight, icon: <Sun size={17} aria-hidden="true" /> },
    { value: 'dark' as const, label: copy.themeDark, ariaLabel: copy.switchThemeToDark, icon: <Moon size={17} aria-hidden="true" /> },
  ];
  const activeSettingsSection = settingsSectionForTarget(activeSettingsTarget);
  const settingsNavGroups = [
    {
      label: copy.settingsCurrentPage,
      items: [
        { label: copy.settingsPreferences, target: 'settings-general', icon: <Palette size={17} aria-hidden="true" /> },
        { label: copy.settingsAccount, target: 'settings-clawhunt', icon: <UserRound size={17} aria-hidden="true" /> },
        { label: copy.settingsSecurity, target: 'settings-security', icon: <ShieldCheck size={17} aria-hidden="true" /> },
        { label: copy.settingsRuntime, target: 'runtime-settings', icon: <Server size={17} aria-hidden="true" /> },
        { label: copy.settingsAgents, target: 'settings-agent-doctor', icon: <Cable size={17} aria-hidden="true" /> },
      ],
    },
  ];
  const activeSettingsTitle =
    settingsNavGroups.flatMap((group) => group.items).find((item) => item.target === activeSettingsTarget)?.label ?? copy.settingsPreferences;
  const sidebarToggleButton = (
    <button
      className="window-sidebar-toggle"
      type="button"
      aria-label={sidebarCollapsed ? copy.expandSidebar : copy.collapseSidebar}
      onClick={toggleSidebar}
    >
      {sidebarCollapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
      <span>{sidebarCollapsed ? copy.expandSidebar : copy.collapseSidebar}</span>
    </button>
  );
  function handleMacosWindowDragPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!desktopMode || !shouldStartMacosWindowDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const now = globalThis.performance?.now() ?? Date.now();
    const gesture = macosWindowDragGestureRef.current;
    const clickDistance = Math.hypot(event.clientX - gesture.lastClickX, event.clientY - gesture.lastClickY);
    if (now - gesture.lastClickAt <= MACOS_DOUBLE_CLICK_MS && clickDistance <= MACOS_DOUBLE_CLICK_DISTANCE) {
      gesture.activePointerId = null;
      gesture.dragStarted = false;
      gesture.lastClickAt = 0;
      void toggleDesktopWindowMaximize().catch(() => undefined);
      return;
    }
    gesture.activePointerId = event.pointerId;
    gesture.dragStarted = false;
    gesture.lastClickAt = now;
    gesture.lastClickX = event.clientX;
    gesture.lastClickY = event.clientY;
    gesture.startX = event.clientX;
    gesture.startY = event.clientY;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleMacosWindowDragPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const gesture = macosWindowDragGestureRef.current;
    if (!desktopMode || gesture.activePointerId !== event.pointerId || gesture.dragStarted) return;
    const dragDistance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
    if (dragDistance < MACOS_DRAG_START_DISTANCE) return;
    gesture.dragStarted = true;
    gesture.activePointerId = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    void startDesktopWindowDrag().catch(() => undefined);
  }

  function handleMacosWindowDragPointerEnd(event: ReactPointerEvent<HTMLElement>) {
    const gesture = macosWindowDragGestureRef.current;
    if (gesture.activePointerId !== event.pointerId) return;
    gesture.activePointerId = null;
    gesture.dragStarted = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function handleWorkbenchContextMenu(event: ReactMouseEvent<HTMLElement>) {
    event.preventDefault();
    setSidebarContextMenu(null);
  }

  // 打开/复用一个 tab。点对话里的文件/链接默认「在当前同类 tab 内打开」（替换内容），
  // 当前激活 tab 不是同类时才新建一个；与真实浏览器默认行为一致。
  // run id 由调用方（该 turn 自己的 run）显式传入，而非读全局选中 run，
  // 这样 run A 的链接永远不会读到 run B 的检出（confused-deputy 防护）。
  //
  // 全部走纯函数式 updater：在同一次更新里基于 prev 同时算出 tabs 与 activeId，
  // 既消除 ref 快照竞态（同批多次打开不会互相覆盖），也避免 active 指向已删 tab。
  const openFileViewer = useCallback(
    (runId: string, path: string) => {
      if (!runId) return;
      const id = nextTabId();
      setPanelState((prev) => {
        const active = prev.tabs.find((tab) => tab.id === prev.activeId);
        if (active && active.kind === 'file') {
          return {
            tabs: prev.tabs.map((tab) => (tab.id === active.id ? { id: tab.id, kind: 'file', runId, path } : tab)),
            activeId: active.id,
          };
        }
        return { tabs: [...prev.tabs, { id, kind: 'file', runId, path }], activeId: id };
      });
      setRightPanelOpen(true);
    },
    [nextTabId],
  );
  const openWebView = useCallback(
    (url: string) => {
      if (!url) return;
      const id = nextTabId();
      setPanelState((prev) => {
        const active = prev.tabs.find((tab) => tab.id === prev.activeId);
        if (active && active.kind === 'web') {
          return {
            tabs: prev.tabs.map((tab) => (tab.id === active.id ? { id: tab.id, kind: 'web', url } : tab)),
            activeId: active.id,
          };
        }
        return { tabs: [...prev.tabs, { id, kind: 'web', url }], activeId: id };
      });
      setRightPanelOpen(true);
    },
    [nextTabId],
  );
  // tab 栏交互：选中 / 关闭 / 新建。
  const selectTab = useCallback((tabId: string) => {
    setPanelState((prev) => (prev.tabs.some((tab) => tab.id === tabId) ? { ...prev, activeId: tabId } : prev));
  }, []);
  const closeTab = useCallback((tabId: string) => {
    setPanelState((prev) => {
      const index = prev.tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return prev;
      const tabs = prev.tabs.filter((tab) => tab.id !== tabId);
      // 关掉激活 tab 时把激活项落到相邻 tab（优先右侧，否则左侧），与浏览器一致；
      // 关闭非激活 tab 时激活项不变。
      const activeId =
        prev.activeId !== tabId ? prev.activeId : tabs.length === 0 ? null : (tabs[index] ?? tabs[index - 1]).id;
      return { tabs, activeId };
    });
  }, []);
  const openNewTab = useCallback(
    (kind: TabKind) => {
      const id = nextTabId();
      // 「+」菜单只提供 web/plan/automation；file tab 仅由点对话里的文件链接产生。
      const tab: ConversationTab =
        kind === 'web'
          ? { id, kind: 'web', url: '' }
          : kind === 'automation'
            ? { id, kind: 'automation' }
            : { id, kind: 'plan' };
      setPanelState((prev) => ({ tabs: [...prev.tabs, tab], activeId: id }));
      setRightPanelOpen(true);
    },
    [nextTabId],
  );
  // 把某个网页 tab 的地址写回（空白网页 tab 的地址栏提交时调用，已归一化为 http(s)）。
  const setWebTabUrl = useCallback((tabId: string, url: string) => {
    setPanelState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) => (tab.id === tabId && tab.kind === 'web' ? { id: tab.id, kind: 'web', url } : tab)),
    }));
  }, []);
  const previewOpenExternal = useCallback(
    (rawUrl: string) => {
      // Defense-in-depth: a link surfaced by the preview reader is still routed
      // through the SAME scheme allowlist as every other external open, so a
      // javascript:/data: scheme can never reach the OS opener from this path.
      const url = safeMarkdownExternalHref(rawUrl);
      if (!url) return;
      if (desktopInvoke) void openDesktopExternalUrl(desktopInvoke, url);
      else if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
    },
    [desktopInvoke],
  );
  if (desktopMode && desktopStatus === 'starting') {
    return (
      <StartupLoadingScreen
        title={locale === 'zh' ? '欢迎来到 ClawHunt' : 'Welcome to ClawHunt'}
        message={locale === 'zh' ? '正在启动引擎…' : 'Starting the engine…'}
      />
    );
  }
  // NOTE: 'failed' deliberately does NOT take over the whole screen — the shell
  // stays navigable and surfaces a "Desktop runtime is not connected" banner
  // (graceful degradation). The blank-startup symptom was the TCC data-root bug,
  // fixed in the Rust shell, not this state.

  // tab 内容渲染：按 kind 分派。web/file 复用既有 WebPreviewPanel/FileViewerPanel
  // （治理仍在它们内部：web 走 web_preview 沙箱、file 走 read_run_file）；
  // plan 沿用原面板渲染体。空白网页 tab 先给地址栏，提交后转入预览。
  const renderTabContent = (tab: ConversationTab): ReactNode => {
    switch (tab.kind) {
      case 'web':
        if (!tab.url) {
          return (
            <WebTabAddressBar
              onSubmit={(url) => setWebTabUrl(tab.id, url)}
              placeholder={copy.webTabPlaceholder}
              submitLabel={copy.webTabPreview}
              invalidLabel={copy.webTabInvalid}
            />
          );
        }
        // Desktop: a real, interactive native browser (Tauri child webview). Web
        // client: the sanitized, inert reader (no native webview, and iframes are
        // blocked by X-Frame-Options on most sites anyway).
        return desktopInvoke ? (
          <NativeBrowserPanel key={tab.id} url={tab.url} invoke={desktopInvoke} onOpenExternal={previewOpenExternal} t={t} />
        ) : (
          <WebPreviewPanel key={tab.url} url={tab.url} load={loadPreview} onOpenExternal={previewOpenExternal} t={t} confirmBeforeLoad={previewConfirmEnabled} />
        );
      case 'file':
        return tab.runId ? (
          <FileViewerPanel
            runId={tab.runId}
            path={tab.path}
            load={loadRunFile}
            renderMarkdown={(c) => (
              <AssistantMarkdown
                content={c}
                desktopInvoke={desktopInvoke}
                fileRunId={tab.runId}
                onFileView={openFileViewer}
                onWebView={openWebView}
              />
            )}
          />
        ) : (
          <div className="file-viewer file-viewer-empty" role="note">
            {t('Open a file or link from the conversation to preview it here.')}
          </div>
        );
      case 'plan':
        return (
        <section className="task-progress-card task-plan-card" aria-label="Task plan">
          <div className="section-heading compact">
            <span>{copy.planPanel}</span>
          </div>
          <p className="context-hint">{t('Plan empty hint')}</p>
        </section>
        );
      case 'automation':
        return (
          <ChatAutomationControl
            sessionIssueId={activeBackendChatSessionId || null}
            locale={locale}
            initialPrompt={message}
            onChanged={refreshAutomationSessionIds}
          />
        );
    }
  };
  // tab 图标 + 标题：按 kind + 载荷动态计算（网页用域名、文件用文件名）。
  const conversationTabMeta = (tab: ConversationTab): TabMeta => {
    switch (tab.kind) {
      case 'web':
        return { icon: Globe, title: webTabTitle(tab.url, copy.newTab) };
      case 'file':
        return { icon: FileText, title: tab.path ? fileTabTitle(tab.path) : copy.newTab };
      case 'plan':
        return { icon: ListTodo, title: copy.planPanel };
      case 'automation':
        return { icon: CalendarClock, title: copy.automationPanel };
    }
  };
  // 「+」可新建的 tab 类型。file 不在此列：文件 tab 由点对话里的文件链接产生。
  // 未来加入终端时，在此追加 { kind: 'terminal', ... } 并扩展 ConversationTab union 与上面的 switch。
  const conversationNewTabOptions: NewTabOption[] = [
    { kind: 'web', label: copy.newWebPage, icon: Globe },
    { kind: 'plan', label: copy.planPanel, icon: ListTodo },
    { kind: 'automation', label: copy.automationPanel, icon: CalendarClock },
  ];
  const conversationTabsEmptyState = (
    <div className="file-viewer file-viewer-empty" role="note">
      {copy.conversationTabsEmpty}
    </div>
  );

  // 纯画布 shell — a floating dock that folds the workbench rail's navigation into the
  // canvas itself, so a canvas surface reads as one clean full-bleed canvas (the rail is
  // hidden via CSS on canvas surfaces). Icon-only (labels via title + aria-label) to stay
  // out of the canvas's way; the active surface is highlighted. Reuses the same surface
  // handlers the rail uses, so navigation semantics are identical.
  const canvasLauncherItems: Array<{
    key: typeof workspaceSurface;
    label: string;
    icon: LucideIcon;
    onClick: () => void;
  }> = [
    // The dock is just the canvas plus the one non-canvas utility (Settings) — the retired
    // fleet / creative / studio surfaces no longer have entries.
    { key: 'canvas', label: locale === 'zh' ? '画布' : 'Canvas', icon: Layers, onClick: () => openCanvasSurface() },
    { key: 'control', label: copy.settings, icon: Settings2, onClick: () => openSettingsSurface() },
  ];
  const canvasLauncher = (
    <nav className="canvas-launcher" aria-label={locale === 'zh' ? '画布导航' : 'Canvas navigation'}>
      {canvasLauncherItems.map((item) => {
        const Icon = item.icon;
        const active = workspaceSurface === item.key;
        return (
          <button
            key={item.key}
            type="button"
            className={`canvas-launcher-item${active ? ' is-active' : ''}`}
            aria-label={item.label}
            aria-current={active ? 'page' : undefined}
            title={item.label}
            onClick={item.onClick}
          >
            <Icon size={17} aria-hidden="true" />
            {/* Label is always in the DOM (for a11y it doubles the aria-label) but
                visually collapsed to icon-only; it expands for the active surface and
                for the whole row on hover, so the dock is self-explanatory without a
                permanent tab bar. */}
            <span className="canvas-launcher-label">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );

  return (
    <main
      className={`workbench-shell ${rightPanelOpen ? 'context-open' : 'context-closed'} ${sidebarCollapsed ? 'sidebar-collapsed' : 'sidebar-expanded'} chat-only workspace-${workspaceSurface}`}
      style={shellStyle}
      onPointerDown={handleMacosWindowDragPointerDown}
      onPointerMove={handleMacosWindowDragPointerMove}
      onPointerUp={handleMacosWindowDragPointerEnd}
      onPointerCancel={handleMacosWindowDragPointerEnd}
      onContextMenu={handleWorkbenchContextMenu}
    >
      {desktopMode && workspaceSurface !== 'canvas' ? (
        <div className="macos-window-drag-region" data-tauri-drag-region="" aria-hidden="true" />
      ) : null}
      {nodeCanvasMode && startupGateReady && canvasStartupStatus !== 'ready' ? (
        <div
          role={canvasStartupStatus === 'unavailable' ? 'alert' : 'status'}
          style={{ position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 1200, maxWidth: 'calc(100vw - 32px)', padding: '12px 16px', borderRadius: 12, background: 'var(--bg-panel, #fff)', color: 'var(--text-primary, #222)', border: '1px solid var(--border-color, #d3d9d6)', boxShadow: '0 4px 20px #0002' }}
        >
          {canvasStartupStatus === 'unavailable'
            ? (locale === 'zh' ? '服务尚未就绪：Node 服务或 Agent 网关未连接。请检查本地服务后重试。' : 'Services are not ready. Check the local control plane and Agent gateway, then retry.')
            : (locale === 'zh' ? '正在检查 Node 服务与 Agent 网关…' : 'Checking the control plane and Agent gateway…')}
          {canvasStartupStatus === 'unavailable' ? (
            <button type="button" onClick={() => setCanvasStartupAttempt((attempt) => attempt + 1)} style={{ marginLeft: 12 }}>{locale === 'zh' ? '重试连接' : 'Retry connection'}</button>
          ) : null}
        </div>
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismissToast} dismissLabel={t('Dismiss notification')} />
      <NotificationCenter
        history={notificationHistory}
        open={notificationPanelOpen}
        unread={notificationUnread}
        locale={locale}
        labels={{
          open: t('Open notifications'),
          history: t('Notification history'),
          empty: t('No notifications yet'),
          clear: t('Clear notifications'),
        }}
        onToggle={toggleNotificationPanel}
        onClose={() => setNotificationPanelOpen(false)}
        onClear={clearNotificationHistory}
      />
      {/* Direction 4 D3: surface the kernel escalation queue as a runtime approval popup
          + pending badge. Self-contained (polls /api/escalations, no new authority). */}
      {!nodeCanvasMode ? <EscalationGate readJson={readJson} /> : null}
      <GoalModeDialog
        open={goalModeRecord !== null}
        record={goalModeRecord}
        readJson={readJson}
        lang={locale === 'zh' ? 'zh' : 'en'}
        onClose={() => setGoalModeRecord(null)}
        onConfirmed={(next) => {
          setGoalModeRecord(null);
          setMessage(
            locale === 'zh'
              ? `目标已确认（${next.status}）`
              : `Goal confirmed (${next.status})`,
          );
        }}
        onReplanned={(next) => setGoalModeRecord(next)}
      />
      <DialogShell
        open={Boolean(runtimeSetupDialogOpen)}
        role="alertdialog"
        titleId="agent-setup-title"
        title={t('Agent setup required')}
        subtitle={t('Agent setup description')}
        statusPill={
          <>
            <span className={`status-pill ${selectedAgentAvailable ? 'good' : 'bad'}`}>
              {runtimeReadiness(selectedAgentInfo, locale).label}
            </span>
            <button
              type="button"
              className="text-button compact"
              title={t('Agent recheck hint')}
              disabled={agentRecheckBusy}
              onClick={() => void recheckAgents()}
            >
              <RefreshCw size={14} className={agentRecheckBusy ? 'spin' : undefined} aria-hidden="true" />
              {t('Agent recheck')}
            </button>
          </>
        }
        closeLabel={t('Close dialog')}
        onClose={closeRuntimeSetupDialog}
      >
	            <div className="agent-choice-grid" aria-label={t('Choose runtime agent')}>
		              {agentInventory.length ? (
		                agentInventory.map((agent) => (
		                  <button
		                    key={agent.name}
		                    type="button"
		                    className={`agent-choice-card ${agent.name === selectedBackend ? 'active' : ''}`}
		                    onClick={() => openAgentSetupFor(agent.name)}
		                  >
		                    <span>
		                      <strong>{agent.name}</strong>
		                      <small>{agent.kind ?? 'agent'}</small>
		                    </span>
		                    <span className={`status-pill ${agent.available ? 'good' : 'bad'}`}>{runtimeReadiness(agent, locale).label}</span>
		                    <small>{runtimeReadiness(agent, locale).detail}</small>
                          {agent.executable ? <small>{agent.executable}</small> : null}
		                  </button>
		                ))
		              ) : (
		                <p className="agent-readiness-note bad">{t('Agent setup none found')}</p>
		              )}
		            </div>
	            <label className="stacked-field">
	              <span>{t('Default runtime agent')}</span>
	              <Dropdown
	                variant="field"
	                ariaLabel={t('Default runtime agent')}
	                value={selectedBackend}
	                placeholder={t('Agent setup choose first')}
	                options={agentInventory.map((agent) => ({
	                  value: agent.name,
	                  label: agent.name,
	                }))}
	                onChange={openAgentSetupFor}
	              />
	            </label>
	            {selectedAgentExecutableConfigName ? (
	              <label className="stacked-field">
	                <span>{t('Agent executable path')}</span>
	                <input
	                  aria-label={t('Agent executable path')}
	                  value={agentExecutableDraft}
	                  placeholder={selectedAgentConfigEntry?.description ?? '/opt/homebrew/bin/codex'}
	                  onChange={(event) => setAgentExecutableDraft(event.target.value)}
	                />
	                <small>{selectedAgentExecutableConfigName} · {t('Agent executable path description')}</small>
	              </label>
	            ) : null}
	            <p className={`agent-readiness-note ${selectedAgentAvailable ? 'good' : 'bad'}`}>
	              {selectedAgentReadinessText}
	            </p>
	            <div className="agent-setup-actions">
	              {selectedAgentAvailable ? (
	                <button type="button" className="text-button compact" onClick={dismissAgentSetup}>
	                  {t('Agent setup later')}
	                </button>
	              ) : null}
	              <button
	                type="button"
	                className="text-button compact primary-action"
	                disabled={!selectedBackend}
	                onClick={() => void saveAgentRuntimeSetup()}
	              >
	                <Server size={16} />
	                {t('Agent setup save')}
	              </button>
	            </div>
      </DialogShell>
      <DialogShell
        open={Boolean(companyInstantiate)}
        role="dialog"
        titleId="company-instantiate-title"
        title={catalogContract?.copy?.company_instantiate_cta ?? t('Plugin catalog company template')}
        subtitle={companyInstantiate ? pluginCatalogTitle(companyInstantiate.item) : undefined}
        closeLabel={t('Close dialog')}
        onClose={closeCompanyInstantiate}
      >
        {companyInstantiate ? (
          (() => {
            const proposal = companyInstantiate.proposal;
            const wouldCreate = (proposal?.would_create ?? {}) as Record<string, unknown>;
            const agents = Array.isArray(wouldCreate.agent_profiles) ? (wouldCreate.agent_profiles as unknown[]) : [];
            const issues = Array.isArray(wouldCreate.issues) ? (wouldCreate.issues as unknown[]) : [];
            const company = (wouldCreate.company_profile ?? {}) as Record<string, unknown>;
            const approvals = Array.isArray(proposal?.approvals_required) ? (proposal!.approvals_required as unknown[]) : [];
            const equipment = Array.isArray(proposal?.equipment_resolution) ? (proposal!.equipment_resolution as Record<string, unknown>[]) : [];
            const dropped = equipment.flatMap((row) => {
              const d = (row?.dropped ?? {}) as Record<string, unknown>;
              const plugins = Array.isArray(d.plugins) ? (d.plugins as unknown[]) : [];
              const skills = Array.isArray(d.skills) ? (d.skills as unknown[]) : [];
              return [...plugins, ...skills];
            });
            const result = companyInstantiate.result;
            const committed = result ? Boolean(result.committed) : false;
            const approvalRequired = result ? Boolean(result.approval_required) : false;
            return (
              <div className="company-instantiate-review">
                {companyInstantiate.error ? (
                  <p className="agent-readiness-note bad">{companyInstantiate.error}</p>
                ) : null}
                {companyInstantiate.phase === 'proposing' ? (
                  <p className="agent-readiness-note">{t('Working')}</p>
                ) : null}
                {companyInstantiate.phase === 'done' ? (
                  <p className={`agent-readiness-note ${committed || approvalRequired ? 'good' : 'bad'}`}>
                    {approvalRequired
                      ? t('Company instantiate approval pending')
                      : committed
                        ? t('Company instantiate committed')
                        : t('Company instantiate no change')}
                  </p>
                ) : null}
                {proposal && companyInstantiate.phase !== 'done' ? (
                  <div className="company-instantiate-diff">
                    <p>
                      <strong>{String(company.name ?? company.company_profile_id ?? companyInstantiate.item.plugin_id)}</strong>
                      {' · '}
                      {t('Company instantiate would create')}: {agents.length} agents, {issues.length} issues
                    </p>
                    {dropped.length ? (
                      <p className="agent-readiness-note warn">
                        {t('Company instantiate dropped equipment')}: {dropped.length}
                      </p>
                    ) : null}
                    {approvals.length ? (
                      <p className="agent-readiness-note warn">
                        {t('Company instantiate high risk')}: {approvals.length}
                      </p>
                    ) : null}
                    {Boolean(proposal.blocked) ? (
                      <p className="agent-readiness-note bad">{t('Company instantiate blocked')}</p>
                    ) : null}
                  </div>
                ) : null}
                <div className="agent-setup-actions">
                  <button type="button" className="text-button compact" onClick={closeCompanyInstantiate}>
                    {t('Close dialog')}
                  </button>
                  {companyInstantiate.phase === 'review' && proposal && !proposal.blocked ? (
                    <button
                      type="button"
                      className="text-button compact primary-action"
                      onClick={() => void confirmCompanyInstantiate()}
                    >
                      <Sparkles size={16} aria-hidden="true" />
                      {t('Company instantiate confirm')}
                    </button>
                  ) : null}
                  {companyInstantiate.phase === 'committing' ? (
                    <span className="status-pill neutral">
                      <LoaderCircle size={14} className="spin" aria-hidden="true" /> {t('Working')}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })()
        ) : null}
      </DialogShell>
      <DialogShell
        open={blockingModal?.kind === 'login'}
        role="alertdialog"
        variant="wide"
        titleId="clawhunt-login-modal-title"
        title={t('ClawHunt login required')}
        subtitle={t('ClawHunt login required description')}
        statusPill={
          <span className={`status-pill ${clawHuntExecutionLinked ? 'good' : 'bad'}`}>
            {clawHuntExecutionLinked ? 'linked' : 'required'}
          </span>
        }
        closeLabel={t('Close dialog')}
        onClose={closeBlockingModal}
      >
            <div className="login-setup-body">
              <p>Base URL: {authStatus?.clawhunt.base_url ?? 'probing'}</p>
              <p>
                {t('ClawHunt login server')}: {clawHuntLoginServerText}
              </p>
              <p>
                Account: {authStatus?.clawhunt.account ?? 'unset'} / {clawHuntAccountName}
              </p>
              <p>
                Agent key: {authStatus?.clawhunt.agent_api_key ?? 'unset'}
                {clawHuntAgentKeySource}
              </p>
              <p>
                Source: {authStatus?.clawhunt.login_source ?? 'unset'}
                {authStatus?.clawhunt.account_source ? ` / ${authStatus.clawhunt.account_source}` : ''}
              </p>
              <div className="inline-form">
                <button
                  className="text-button compact primary-action"
                  type="button"
                  onClick={startClawHuntAccountShortcutLogin}
                >
                  <LogIn size={16} />
                  {t('Sign in to ClawHunt')}
                </button>
                <button
                  className="text-button compact"
                  type="button"
                  onClick={() => void startClawHuntBrowserLogin('google')}
                  disabled={Boolean(clawHuntBrowserLoginBusy)}
                >
                  <GoogleLogo />
                  {t('Continue with ClawHunt Google')}
                </button>
                <button
                  className="text-button compact"
                  type="button"
                  onClick={() => void startClawHuntBrowserLogin('website')}
                  disabled={Boolean(clawHuntBrowserLoginBusy)}
                >
                  <ExternalLink size={16} />
                  {t('Open ClawHunt website login')}
                </button>
                <button className="text-button compact" type="button" onClick={() => void loadClawHuntLoginProbe()}>
                  <RefreshCw size={16} />
                  {t('Probe login server')}
                </button>
                <button className="text-button compact" type="button" onClick={() => void loadAuthStatus()}>
                  <RefreshCw size={16} />
                  {t('Refresh login status')}
                </button>
                <button className="text-button compact" type="button" onClick={() => void logoutClawHunt()}>
                  <Square size={16} />
                  {t('Logout ClawHunt')}
                </button>
              </div>
              <div className="inline-form">
                <Dropdown
                  variant="field"
                  ariaLabel={t('ClawHunt agent')}
                  value={selectedClawHuntAgentId != null ? String(selectedClawHuntAgentId) : ''}
                  placeholder={t('No ClawHunt agents loaded')}
                  options={
                    clawHuntAccountAgents.length === 0
                      ? [{ value: '', label: t('No ClawHunt agents loaded') }]
                      : clawHuntAccountAgents.map((agent) => ({
                          value: String(agent.id),
                          label: clawHuntAgentLabel(agent),
                        }))
                  }
                  onChange={(next) => setSelectedClawHuntAgentId(next ? Number.parseInt(next, 10) : null)}
                />
                <input
                  aria-label="ClawHunt agent key name"
                  type="text"
                  value={clawHuntAgentKeyName}
                  onChange={(event) => setClawHuntAgentKeyName(event.target.value)}
                />
                <button className="text-button compact" type="button" onClick={() => void createClawHuntAgentKey()} disabled={!selectedClawHuntAgentId}>
                  <KeyRound size={16} />
                  {t('Create ClawHunt agent key')}
                </button>
              </div>
              <p>{t('Manual agent key')}</p>
              <div className="inline-form">
                <input
                  aria-label="ClawHunt agent key"
                  type="password"
                  value={clawHuntKeyInput}
                  placeholder="cph_..."
                  onChange={(event) => setClawHuntKeyInput(event.target.value)}
                />
                <button className="text-button compact" type="button" onClick={() => void loginClawHunt()}>
                  <KeyRound size={16} />
                  {t('Login ClawHunt')}
                </button>
              </div>
              <p>Profile: {clawHuntProfile?.body?.handle ? String(clawHuntProfile.body.handle) : 'not loaded'}</p>
            </div>
      </DialogShell>
	      <aside className="rail" aria-label={copy.navLabel}>
        <div className="rail-top">
          <button className="sidebar-marketplace" type="button" aria-label={copy.openPluginMarketplace} onClick={() => {
            void openMarketplaceSurface();
            setAccountMenuOpen(false);
          }}>
            <Puzzle size={18} />
            <span>{copy.pluginsMarketplace}</span>
          </button>
          <button className="sidebar-marketplace" type="button" aria-label={copy.teamSurface} onClick={() => {
            void openTeamSurface();
          }}>
            <Users size={18} />
            <span>{copy.teamSurface}</span>
            {teamUnread > 0 ? (
              <span className="sidebar-unread-badge" aria-label={`${teamUnread} ${locale === 'zh' ? '条未读' : 'unread'}`}>
                {teamUnread > 99 ? '99+' : teamUnread}
              </span>
            ) : null}
          </button>
          {/* ONE canvas entry — the session canvas is the whole product surface. */}
          <button className="sidebar-marketplace" type="button" aria-label={locale === 'zh' ? '画布' : 'Canvas'} onClick={() => {
            openCanvasSurface();
          }}>
            <Layers size={18} />
            <span>{locale === 'zh' ? '画布' : 'Canvas'}</span>
          </button>
          <button className="sidebar-primary" type="button" onClick={() => {
            resetComposerSession();
          }}>
            <Bot size={18} />
            <span>{copy.newChat}</span>
          </button>
          <div className="sidebar-recents" aria-label={copy.chats}>
            {(() => {
              const renderItem = (
                item: SidebarSessionItem,
                options: { trustRequired?: boolean; nested?: boolean } = {},
              ) => {
                const trustRequired = options.trustRequired ?? false;
                const nested = options.nested ?? false;
                const running = item.live;
                const metaState = running ? 'live' : item.unread ? 'unread' : 'time';
                const itemKey = `${item.kind}-${item.id}`;
                const busy = sidebarItemBusy[itemKey] === true;
                // Pin/archive hover actions only for kernel-persisted backend chats
                // (local drafts aren't cross-surface pinnable/archivable).
                const canAct = item.kind === 'backend-chat' && !trustRequired;
                return (
                  <div key={itemKey} className={`sidebar-session-wrap${nested ? ' sidebar-session-nested' : ''}`}>
                    <button
                      type="button"
                      className={`sidebar-session-row${item.archived ? ' sidebar-session-archived' : ''}`}
                      aria-label={`Open chat session ${item.title}`}
                      disabled={trustRequired}
                      onClick={() => {
                        if (!trustRequired) openSidebarSessionItem(item);
                      }}
                      onContextMenu={(event) => openSidebarContextMenu(event, item)}
                    >
                      <span className="sidebar-session-title">
                        {item.title}
                        {item.kind === 'backend-chat' && automationSessionIds.has(item.id) ? (
                          <CalendarClock
                            size={12}
                            className="sidebar-session-automation-badge"
                            aria-label={copy.automationPanel}
                          />
                        ) : null}
                        {item.archived ? <em className="sidebar-archived-badge">{copy.archivedBadge}</em> : null}
                      </span>
                      <span
                        className={`sidebar-session-meta ${metaState}`}
                        aria-label={`${item.status} · ${item.timeLabel}${item.unread ? ' · unread' : ''}${item.archived ? ' · archived' : ''}`}
                      >
                        {running ? (
                          <SuperClawLoadingMark className="sidebar-session-running-mark" />
                        ) : item.unread ? (
                          <span className="sidebar-session-dot" aria-hidden="true" />
                        ) : (
                          <small>{item.timeLabel}</small>
                        )}
                      </span>
                    </button>
                    {canAct ? (
                      <div className="sidebar-session-actions">
                        <button
                          type="button"
                          className={`sidebar-session-action${item.pinned ? ' is-pinned' : ''}`}
                          aria-label={item.pinned ? copy.unpinConversation : copy.pinConversation}
                          title={item.pinned ? copy.unpinConversation : copy.pinConversation}
                          disabled={busy}
                          onClick={(event) => {
                            event.stopPropagation();
                            void togglePinSessionItem(item);
                          }}
                        >
                          <Pin size={14} fill={item.pinned ? 'currentColor' : 'none'} aria-hidden="true" />
                        </button>
                        {!item.archived ? (
                          <button
                            type="button"
                            className="sidebar-session-action"
                            aria-label={copy.archiveSession}
                            title={copy.archiveSession}
                            disabled={busy}
                            onClick={(event) => {
                              event.stopPropagation();
                              void archiveSessionItem(item);
                            }}
                          >
                            <Archive size={14} aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              };
              const renderProjectGroup = (group: SidebarProjectGroup) => {
                const collapsed = collapsedWorkspaceGroups[group.key] === true;
                return (
                  <div key={group.key} className="sidebar-workspace-group sidebar-project" aria-label={group.label}>
                    <div
                      className="sidebar-workspace-head"
                      onContextMenu={(event) => openWorkspaceContextMenu(event, group)}
                    >
                      <button
                        type="button"
                        className="account-kicker sidebar-workspace-kicker sidebar-workspace-toggle"
                        aria-expanded={!collapsed}
                        aria-label={`${collapsed ? copy.expandGroup : copy.collapseGroup}: ${group.label}`}
                        onClick={() => toggleWorkspaceGroup(group.key)}
                      >
                        {/* Folder by default; the collapse/expand chevron only
                            surfaces on hover/focus (Req 1) — both glyphs share one
                            fixed icon slot so the name never shifts. */}
                        <span className="sidebar-workspace-iconslot">
                          <Folder size={16} className="sidebar-workspace-folder-icon" aria-hidden="true" />
                          <ChevronRight
                            size={16}
                            className={`sidebar-workspace-chevron${collapsed ? '' : ' open'}`}
                            aria-hidden="true"
                          />
                        </span>
                        <span className="sidebar-workspace-name">{group.label}</span>
                        {group.trustRequired ? (
                          <em className="sidebar-trust-badge">{copy.workspaceTrustRequired}</em>
                        ) : null}
                      </button>
                      {/* New chat inside this project. Disabled for an untrusted
                          workspace — a chat there would 403 at the kernel trust
                          gate, so never offer it. */}
                      <button
                        type="button"
                        className="sidebar-section-add"
                        aria-label={`${copy.newProjectChat}: ${group.label}`}
                        title={copy.newProjectChat}
                        disabled={group.trustRequired}
                        onClick={() => startProjectChat(group.key, group.label)}
                      >
                        <Plus size={15} aria-hidden="true" />
                      </button>
                    </div>
                    {collapsed
                      ? null
                      : group.items.map((item) => renderItem(item, { trustRequired: group.trustRequired, nested: true }))}
                  </div>
                );
              };
              // One collapsible header for EVERY top-level section (Pinned /
              // Projects / Chats) — a chevron + a label at the same font
              // size as the sidebar content (not the old uppercase mini-kicker),
              // plus an optional "+" affordance. Clicking the chevron/label
              // collapses the whole section (persisted per reserved key).
              const renderSectionHeader = (
                sectionKey: string,
                label: string,
                add?: { onClick: () => void; ariaLabel: string },
              ) => {
                const collapsed = collapsedWorkspaceGroups[sectionKey] === true;
                return (
                  <div className="sidebar-section-head">
                    <button
                      type="button"
                      className="sidebar-section-toggle"
                      aria-expanded={!collapsed}
                      aria-label={`${collapsed ? copy.expandGroup : copy.collapseGroup}: ${label}`}
                      onClick={() => toggleWorkspaceGroup(sectionKey)}
                    >
                      <ChevronRight
                        size={14}
                        className={`sidebar-section-chevron${collapsed ? '' : ' open'}`}
                        aria-hidden="true"
                      />
                      <span className="sidebar-section-label">{label}</span>
                    </button>
                    {add ? (
                      <button
                        type="button"
                        className="sidebar-section-add"
                        aria-label={add.ariaLabel}
                        title={add.ariaLabel}
                        onClick={add.onClick}
                      >
                        <Plus size={15} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                );
              };
              // No workspace inventory (legacy install or fetch failure): keep
              // the old flat list untouched — without the contract the
              // Projects/Chats split can't be derived. With an inventory present
              // the grouped structure always renders (even with zero sessions),
              // so a freshly created project and its "+" stay reachable.
              if (workspaces.length === 0) {
                return (
                  <>
                    <span className="account-kicker">{copy.chats}</span>
                    {sidebarSessionItems.length === 0 ? (
                      <p>{copy.noChats}</p>
                    ) : (
                      sidebarSessionItems.map((item) => renderItem(item))
                    )}
                  </>
                );
              }
              const hasPinned =
                sidebarGroups.pinnedChats.length > 0 || sidebarGroups.pinnedGroups.length > 0;
              const pinnedCollapsed = collapsedWorkspaceGroups[PINNED_ZONE_KEY] === true;
              // Inventory present → Pinned zone (only when non-empty) floats above
              // Projects (each personal workspace) and the flat Chats list. Both
              // section headers always render so their "+" affordances stay
              // reachable even when empty.
              const projectsCollapsed = collapsedWorkspaceGroups[PROJECTS_SECTION_KEY] === true;
              const chatsCollapsed = collapsedWorkspaceGroups[CHATS_SECTION_KEY] === true;
              return (
                <>
                  {hasPinned ? (
                    <div className="sidebar-workspace-group sidebar-pinned" aria-label={copy.pinnedSection}>
                      {renderSectionHeader(PINNED_ZONE_KEY, copy.pinnedSection)}
                      {pinnedCollapsed ? null : (
                        <>
                          {sidebarGroups.pinnedChats.map((item) => renderItem(item))}
                          {sidebarGroups.pinnedGroups.map((group) => renderProjectGroup(group))}
                        </>
                      )}
                    </div>
                  ) : null}
                  <div className="sidebar-workspace-group sidebar-projects" aria-label={copy.projects}>
                    {renderSectionHeader(PROJECTS_SECTION_KEY, copy.projects, {
                      onClick: () => {
                        setNewWorkspaceError(null);
                        setNewWorkspaceOpen(true);
                      },
                      ariaLabel: copy.newProject,
                    })}
                    {projectsCollapsed ? null : sidebarGroups.groups.length === 0 ? (
                      sidebarGroups.pinnedGroups.length === 0 ? (
                        <p className="sidebar-projects-empty">{copy.projectsEmpty}</p>
                      ) : null
                    ) : (
                      sidebarGroups.groups.map((group) => renderProjectGroup(group))
                    )}
                  </div>
                  {/* Flat "Chats" section: built-in Chat workspace +
                      unassigned/legacy sessions. Collapsible like every section. */}
                  <div className="sidebar-workspace-group sidebar-chats" aria-label={copy.workspaceInbox}>
                    {renderSectionHeader(CHATS_SECTION_KEY, copy.workspaceInbox, {
                      onClick: () => resetComposerSession(),
                      ariaLabel: copy.newChat,
                    })}
                    {chatsCollapsed ? null : sidebarGroups.flatChats.length === 0 ? (
                      <p className="sidebar-projects-empty">{copy.noChats}</p>
                    ) : (
                      sidebarGroups.flatChats.map((item) => renderItem(item))
                    )}
                  </div>
                </>
              );
            })()}
            <button
              className="sidebar-archived-toggle"
              type="button"
              aria-pressed={showArchived}
              onClick={() => {
                const next = !showArchived;
                // Sync the ref BEFORE the immediate refetch — the render that
                // updates it hasn't run yet, so loadChatSessions would otherwise
                // read the stale value.
                showArchivedRef.current = next;
                setShowArchived(next);
                void loadChatSessions();
              }}
            >
              <Archive size={13} aria-hidden="true" />
              <span>{showArchived ? copy.hideArchived : copy.showArchived}</span>
            </button>
          </div>
        </div>
        {sidebarContextMenu ? (
          <div
            ref={sidebarContextMenuRef}
            className="sidebar-context-menu"
            role="menu"
            aria-label={copy.sidebarContextMenu}
            style={{ left: sidebarContextMenu.x, top: sidebarContextMenu.y }}
          >
            <button type="button" role="menuitem" onClick={() => void copySidebarConversationId(sidebarContextMenu)}>
              <Copy size={15} aria-hidden="true" />
              <span>{copy.copyConversationId}</span>
            </button>
            {sidebarContextMenu.canManage ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoveSessionId(sidebarContextMenu.sessionId);
                    setMovePendingTarget(null);
                    setSidebarContextMenu(null);
                  }}
                >
                  <FolderInput size={15} aria-hidden="true" />
                  <span>{copy.moveToWorkspace}</span>
                </button>
                <button type="button" role="menuitem" onClick={() => void archiveSidebarSession(sidebarContextMenu)}>
                  <Archive size={15} aria-hidden="true" />
                  <span>{sidebarContextMenu.archived ? copy.unarchiveSession : copy.archiveSession}</span>
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {workspaceContextMenu ? (
          <div
            ref={workspaceContextMenuRef}
            className="sidebar-context-menu"
            role="menu"
            aria-label={workspaceContextMenu.name}
            style={{ left: workspaceContextMenu.x, top: workspaceContextMenu.y }}
          >
            <button type="button" role="menuitem" onClick={() => void togglePinWorkspace(workspaceContextMenu)}>
              <Pin size={15} aria-hidden="true" fill={workspaceContextMenu.pinned ? 'currentColor' : 'none'} />
              <span>{workspaceContextMenu.pinned ? copy.unpinProject : copy.pinProject}</span>
            </button>
            {/* Reveal in the OS file manager — desktop only (the web surface has no
                shell to open a folder). repoPath comes from the kernel projection. */}
            {desktopMode && workspaceContextMenu.repoPath ? (
              <button type="button" role="menuitem" onClick={() => void revealWorkspaceInFinder(workspaceContextMenu)}>
                <FolderOpen size={15} aria-hidden="true" />
                <span>{copy.revealInFinder}</span>
              </button>
            ) : null}
            {!workspaceContextMenu.builtin ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setWorkspaceRename({ workspaceId: workspaceContextMenu.workspaceId, name: workspaceContextMenu.name });
                    setWorkspaceContextMenu(null);
                  }}
                >
                  <Pencil size={15} aria-hidden="true" />
                  <span>{copy.renameProject}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sidebar-context-menu-danger"
                  onClick={() => {
                    setWorkspaceRemove(workspaceContextMenu);
                    setWorkspaceContextMenu(null);
                  }}
                >
                  <Trash2 size={15} aria-hidden="true" />
                  <span>{copy.removeProject}</span>
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        <DialogShell
          open={workspaceRename !== null}
          role="dialog"
          titleId="workspace-rename-title"
          title={copy.renameProjectTitle}
          closeLabel={copy.cancel}
          onClose={() => {
            if (!workspaceRenameBusy) setWorkspaceRename(null);
          }}
        >
          <form
            className="workspace-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              void performWorkspaceRename();
            }}
          >
            <label className="workspace-field">
              <span>{copy.renameProjectLabel}</span>
              <input
                type="text"
                value={workspaceRename?.name ?? ''}
                onChange={(event) =>
                  setWorkspaceRename((current) => (current ? { ...current, name: event.target.value } : current))
                }
                disabled={workspaceRenameBusy}
                autoFocus
              />
            </label>
            <div className="workspace-create-actions">
              <button
                type="submit"
                className="sidebar-primary"
                disabled={workspaceRenameBusy || (workspaceRename?.name.trim().length ?? 0) === 0}
              >
                {copy.renameProject}
              </button>
            </div>
          </form>
        </DialogShell>
        <DialogShell
          open={workspaceRemove !== null}
          role="alertdialog"
          titleId="workspace-remove-title"
          title={workspaceRemove ? `${copy.removeProject} “${workspaceRemove.name}”?` : copy.removeProjectTitle}
          closeLabel={copy.cancel}
          onClose={() => {
            if (!workspaceRemoveBusy) setWorkspaceRemove(null);
          }}
        >
          <div className="workspace-remove-body">
            <p className="workspace-hint">{copy.removeProjectBody}</p>
            <div className="workspace-create-actions workspace-remove-actions">
              <button
                type="button"
                className="text-button"
                onClick={() => setWorkspaceRemove(null)}
                disabled={workspaceRemoveBusy}
              >
                {copy.cancel}
              </button>
              <button
                type="button"
                className="sidebar-danger-button"
                onClick={() => void performWorkspaceRemove()}
                disabled={workspaceRemoveBusy}
              >
                {copy.removeProjectConfirm}
              </button>
            </div>
          </div>
        </DialogShell>
        <DialogShell
          open={newWorkspaceOpen}
          role="dialog"
          titleId="new-workspace-title"
          title={copy.newWorkspaceTitle}
          subtitle={copy.newWorkspaceSubtitle}
          closeLabel={copy.cancel}
          onClose={() => {
            if (!newWorkspaceBusy) {
              setNewWorkspaceError(null);
              setNewWorkspaceOpen(false);
            }
          }}
        >
          <form
            className="workspace-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              void createPersonalWorkspace();
            }}
          >
            <label className="workspace-field">
              <span>{copy.newWorkspaceNameLabel}</span>
              <input
                type="text"
                value={newWorkspaceName}
                placeholder={copy.newWorkspaceNamePlaceholder}
                onChange={(event) => {
                  setNewWorkspaceName(event.target.value);
                  // Renaming is the fix for a collision — clear the stale error
                  // as soon as the user edits the name.
                  if (newWorkspaceError) setNewWorkspaceError(null);
                }}
                // Lock every field while a create is in flight: otherwise the
                // user could edit the name, then the in-flight 422 for the OLD
                // name would write a now-wrong "<old> already exists" error.
                disabled={newWorkspaceBusy}
                autoFocus
              />
            </label>
            {newWorkspaceAttach ? (
              <>
                <label className="workspace-field">
                  <span>{copy.newWorkspaceAttachLabel}</span>
                  <input
                    type="text"
                    value={newWorkspaceRepo}
                    placeholder={copy.newWorkspaceAttachPlaceholder}
                    onChange={(event) => {
                      setNewWorkspaceRepo(event.target.value);
                      // The collision message suggests "attach existing
                      // directory" as a fix — any edit toward that fix clears it.
                      if (newWorkspaceError) setNewWorkspaceError(null);
                    }}
                    disabled={newWorkspaceBusy}
                  />
                </label>
                <label className="workspace-check">
                  <input
                    type="checkbox"
                    checked={newWorkspaceTrust}
                    onChange={(event) => {
                      setNewWorkspaceTrust(event.target.checked);
                      if (newWorkspaceError) setNewWorkspaceError(null);
                    }}
                    disabled={newWorkspaceBusy}
                  />
                  <span>{copy.newWorkspaceTrustLabel}</span>
                </label>
                <p className="workspace-hint workspace-hint-warn">{copy.newWorkspaceTrustHint}</p>
                <button
                  type="button"
                  className="workspace-link-button"
                  onClick={() => {
                    setNewWorkspaceAttach(false);
                    // Switching modes changes the form — never carry a stale
                    // collision error across (esp. into folder mode).
                    if (newWorkspaceError) setNewWorkspaceError(null);
                  }}
                  disabled={newWorkspaceBusy}
                >
                  {copy.newWorkspaceFolderHint}
                </button>
              </>
            ) : (
              <>
                <p className="workspace-hint">{copy.newWorkspaceFolderHint}</p>
                <button
                  type="button"
                  className="workspace-link-button"
                  onClick={() => {
                    setNewWorkspaceAttach(true);
                    // The collision message offers "attach existing directory"
                    // as a fix path — clear the error as the user takes it.
                    if (newWorkspaceError) setNewWorkspaceError(null);
                  }}
                  disabled={newWorkspaceBusy}
                >
                  {copy.newWorkspaceAttachToggle}
                </button>
              </>
            )}
            {newWorkspaceError ? (
              <p className="workspace-hint workspace-hint-warn" role="alert">
                {newWorkspaceError}
              </p>
            ) : null}
            <div className="workspace-create-actions">
              <button
                type="submit"
                className="sidebar-primary"
                disabled={
                  newWorkspaceBusy ||
                  newWorkspaceName.trim().length === 0 ||
                  (newWorkspaceAttach && (newWorkspaceRepo.trim().length === 0 || !newWorkspaceTrust))
                }
              >
                {newWorkspaceBusy ? copy.newWorkspaceCreating : copy.newWorkspaceCreate}
              </button>
            </div>
          </form>
        </DialogShell>
        <DialogShell
          open={moveSessionId !== null}
          role="dialog"
          titleId="move-session-title"
          title={movePendingTarget ? copy.moveBoundaryTitle : copy.moveToWorkspaceTitle}
          subtitle={movePendingTarget ? undefined : copy.moveToWorkspaceSubtitle}
          closeLabel={copy.cancel}
          onClose={() => {
            if (moveBusyTarget) return;
            setMoveSessionId(null);
            setMovePendingTarget(null);
          }}
        >
          {movePendingTarget ? (
            <div className="workspace-move-warning">
              <p>{copy.moveBoundaryBody}</p>
              <div className="workspace-create-actions">
                <button
                  type="button"
                  onClick={() => setMovePendingTarget(null)}
                  disabled={moveBusyTarget !== null}
                >
                  {copy.cancel}
                </button>
                <button
                  type="button"
                  className="sidebar-primary"
                  disabled={moveBusyTarget !== null}
                  onClick={() =>
                    moveSessionId &&
                    void performMove(moveSessionId, movePendingTarget.workspaceId, movePendingTarget.label, true)
                  }
                >
                  {copy.moveConfirm}
                </button>
              </div>
            </div>
          ) : (
            <ul className="workspace-move-list">
              {(() => {
                const movingSession = backendChatSessions.find((session) => session.session_id === moveSessionId);
                const currentWorkspaceId = movingSession?.workspace_id ?? null;
                // A session under the built-in Chat workspace already lives in the
                // flat "Chats" bucket — same place as unassigned — so the
                // "Chats (no workspace)" target IS its current location (a move to
                // null would be a confusing visual no-op). Treat both as "flat".
                const currentIsFlat =
                  currentWorkspaceId === null ||
                  workspaces.find((workspace) => workspace.workspace_id === currentWorkspaceId)?.builtin_chat === true;
                const targets: Array<{ workspaceId: string | null; label: string }> = [
                  { workspaceId: null, label: copy.moveTargetInbox },
                  ...workspaces
                    .filter((workspace) => !workspace.builtin_chat)
                    .map((workspace) => ({ workspaceId: workspace.workspace_id, label: workspace.name })),
                ];
                return targets.map((target) => {
                  const isCurrent =
                    target.workspaceId === null ? currentIsFlat : target.workspaceId === currentWorkspaceId;
                  const busy = moveBusyTarget === (target.workspaceId ?? '__inbox__');
                  return (
                    <li key={target.workspaceId ?? '__inbox__'}>
                      <button
                        type="button"
                        disabled={isCurrent || moveBusyTarget !== null}
                        onClick={() =>
                          moveSessionId && void performMove(moveSessionId, target.workspaceId, target.label, false)
                        }
                      >
                        <span>{target.label}</span>
                        {isCurrent ? <em aria-hidden="true">✓</em> : busy ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : null}
                      </button>
                    </li>
                  );
                });
              })()}
            </ul>
          )}
        </DialogShell>
        <div className="account-shell">
          <Popover
            open={accountMenuOpen}
            anchorRef={accountMenuButtonRef}
            ariaLabel={copy.accountMenu}
            className="account-popover"
            placement="top"
            onClose={() => setAccountMenuOpen(false)}
          >
            {clawHuntAccountSignedIn ? (
              <div className="account-popover-user">
                {clawHuntAccountAvatar ? (
                  <img className="account-avatar" src={clawHuntAccountAvatar} alt="" aria-hidden="true" referrerPolicy="no-referrer" />
                ) : (
                  <UserRound className="account-avatar-fallback" size={24} aria-hidden="true" />
                )}
                <div>
                  <span className="account-kicker">{copy.signedInAs}</span>
                  <strong>{clawHuntOperatorName}</strong>
                  <span>{clawHuntOperatorLinked ? copy.clawhuntLinked : copy.clawhuntUnset}</span>
                  <span>Backend {runtimeConfig?.defaults.backend ?? runtimeStatus?.backend ?? 'claude'}</span>
                </div>
              </div>
            ) : (
              <button
                className="account-popover-user account-popover-user-button"
                type="button"
                aria-label={t('Sign in ClawHunt account')}
                onClick={startClawHuntAccountShortcutLogin}
                disabled={Boolean(clawHuntBrowserLoginBusy)}
              >
                {clawHuntAccountAvatar ? (
                  <img className="account-avatar" src={clawHuntAccountAvatar} alt="" aria-hidden="true" referrerPolicy="no-referrer" />
                ) : (
                  <UserRound className="account-avatar-fallback" size={24} aria-hidden="true" />
                )}
                <div>
                  <span className="account-kicker">{copy.signedInAs}</span>
                  <strong>{clawHuntOperatorName}</strong>
                  <span>{clawHuntOperatorLinked ? copy.clawhuntLinked : copy.clawhuntUnset}</span>
                  <span>Backend {runtimeConfig?.defaults.backend ?? runtimeStatus?.backend ?? 'claude'}</span>
                </div>
              </button>
            )}
            <div className="account-popover-actions">
              <button
                type="button"
                aria-label={copy.openSettings}
                onClick={() => {
                  setAccountMenuOpen(false);
                  openSettingsSurface();
                }}
              >
                <Settings2 size={16} />
                {copy.settings}
              </button>
              <button type="button" onClick={() => { setAccountMenuOpen(false); replayOnboardingTour(); }}>
                <Sparkles size={16} />
                {copy.replayTour}
              </button>
              {!clawHuntAccountSignedIn ? (
                <button
                  type="button"
                  onClick={startClawHuntAccountShortcutLogin}
                  disabled={Boolean(clawHuntBrowserLoginBusy)}
                >
                  <LogIn size={16} />
                  {copy.login}
                </button>
              ) : null}
            </div>
          </Popover>
          <div className="sidebar-footer-actions">
            <button
              ref={accountMenuButtonRef}
              className="account-block"
              type="button"
              aria-label={copy.openAccountMenu}
              onClick={() => setAccountMenuOpen((current) => !current)}
            >
              {clawHuntAccountAvatar ? (
                <img className="account-avatar account-block-avatar" src={clawHuntAccountAvatar} alt="" aria-hidden="true" referrerPolicy="no-referrer" />
              ) : (
                <UserRound className="account-avatar-fallback account-block-avatar" size={24} aria-hidden="true" />
              )}
              <span className="account-block-copy">
                <span className="account-block-name">{clawHuntOperatorName}</span>
              </span>
            </button>
            {sidebarToggleButton}
          </div>
        </div>
        <div
          className="rail-resize-handle"
          role="separator"
          aria-label={copy.resizeSidebar}
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth}
          onPointerDown={startSidebarResize}
        />
      </aside>

      {workspaceSurface === 'chat' ? (
      <section
        className={`goal-pane ${directChatTurns.length > 0 ? 'chat-session-active' : 'chat-empty'}`}
        aria-labelledby={directChatTurns.length > 0 ? undefined : 'goal-composer-title'}
        aria-label={directChatTurns.length > 0 ? copy.chatSurface : undefined}
      >
        <div className="section-heading">
          <span>{copy.chatSurface}</span>
        </div>
        <div className="goal-pane-actions">
          {/* 右上角只剩一个开关按钮：开/收侧边栏。切换功能的职责整个移进侧边栏内部的 tab 栏。 */}
          <button
            className={`text-button compact ${rightPanelOpen ? 'selected' : ''}`}
            type="button"
            aria-expanded={rightPanelOpen}
            aria-controls={rightPanelOpen ? 'conversation-panel' : undefined}
            onClick={() => {
              const next = !rightPanelOpen;
              // 首次打开且无 tab：默认开一个任务列表 tab，避免呈现空面板。
              if (next) {
                const id = nextTabId();
                setPanelState((prev) => (prev.tabs.length === 0 ? { tabs: [{ id, kind: 'plan' }], activeId: id } : prev));
              }
              setRightPanelOpen(next);
            }}
          >
            <PanelRight size={16} />
            {copy.conversationPanel}
          </button>
        </div>
        <div
          className="chat-scroll-region"
          ref={chatScrollRegionRef}
          onScroll={() => {
            const el = chatScrollRegionRef.current;
            if (!el) return;
            // Re-pin once the user is back near the bottom; un-pin the moment they
            // scroll up, so streaming output stops chasing the viewport (sticky).
            const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
            setChatPinnedToBottom(distance < 80);
          }}
        >
          {directChatTurns.length === 0 ? (
            <div className="chat-welcome">
              <h1 id="goal-composer-title">{copy.welcomeHeading}</h1>
              <p className="app-subtitle">
                {copy.subtitle}
              </p>
            </div>
          ) : null}
          {agentSetupRequired ? (
            <div className="agent-readiness-banner" role="status">
              <div>
                <strong>{t('Selected agent readiness')}</strong>
                <p>{selectedAgentReadinessText}</p>
              </div>
              <button type="button" className="text-button compact" onClick={() => openAgentSetupFor()}>
                <Server size={16} />
                {t('Open agent setup')}
              </button>
            </div>
          ) : null}
          {directChatTurns.length > 0 ? (
            <div className="chat-transcript" aria-label="Direct chat transcript">
              {directChatTurns.map((turn, index) => {
                const status = turn.status ?? (turn.role === 'user' ? 'sent' : 'completed');
                const label =
                  turn.role === 'user' ? copy.userTurnLabel : turn.role === 'system' ? 'system' : copy.assistantTurnLabel;
                return (
                  <article key={`${turn.role}-${index}`} className={`chat-turn ${turn.role} ${toneForStatus(status)}`}>
                    <div className="chat-turn-meta">
                      {turn.role !== 'user' && status === 'working' ? (
                        <>
                          <strong className="sr-only">{label}</strong>
                          <SuperClawLoadingMark className="chat-turn-loading-mark" />
                        </>
                      ) : (
                        <strong>{label}</strong>
                      )}
                      {turn.role !== 'user' && status === 'working'
                        ? (() => {
                            // 痛点4: ONE live activity line replacing the standalone
                            // "思考中" pill — derives what the turn is doing RIGHT NOW
                            // from the live display snapshot, and ticks elapsed. It is
                            // the live summary of the expandable ReasoningBlock below
                            // (the two are now connected, not duplicated).
                            const running = turn.display?.toolCards?.find((c) => c.status === 'running');
                            const hasText = Boolean(turn.content && turn.content !== copy.directChatWorking);
                            return (
                              <ChatLiveStatus
                                runningToolLabel={running ? cardTitle(running) : null}
                                hasReasoning={Boolean(turn.display?.reasoning)}
                                hasContent={hasText}
                                startedAt={turn.startedAt}
                                locale={locale}
                                copy={copy}
                              />
                            );
                          })()
                        : null}
                      {turn.role !== 'user' && status !== 'working'
                        ? (() => {
                            // 痛点1/5: no heavy color box. Failure/stop → a small muted
                            // note with an icon. Success → the quiet "用时 · tokens"
                            // metric surfaced at the TOP and always visible (痛点6); full
                            // token breakdown stays on the title for hover. Plain
                            // `completed` no longer prints a green block at all.
                            const tone = toneForStatus(status);
                            if (tone === 'bad') {
                              const noteLabel =
                                status === 'cancelled' ? copy.statusCancelledShort : copy.statusFailedShort;
                              return (
                                <span className="chat-status-note bad" data-testid="chat-status-note">
                                  <X size={12} aria-hidden="true" />
                                  {noteLabel}
                                </span>
                              );
                            }
                            if (status === 'stopped') {
                              return (
                                <span className="chat-status-note warn" data-testid="chat-status-note">
                                  <Square size={11} aria-hidden="true" />
                                  {copy.stopped}
                                </span>
                              );
                            }
                            if (tone === 'warn') {
                              return (
                                <span className="chat-status-note warn" data-testid="chat-status-note">
                                  {status}
                                </span>
                              );
                            }
                            // pending/interrupted carry meaning but NO metering — keep a
                            // quiet box-free note instead of vanishing (a silent
                            // interrupted tail would hide real backend activity). 'sent'
                            // on an assistant/system turn is a no-op, render nothing.
                            if (status === 'interrupted') {
                              return (
                                <span className="chat-status-note warn" data-testid="chat-status-note">
                                  {status}
                                </span>
                              );
                            }
                            if (status === 'pending') {
                              return (
                                <span className="chat-status-note neutral" data-testid="chat-status-note">
                                  {status}
                                </span>
                              );
                            }
                            if (status === 'sent') return null;
                            const usageSource = turn.display?.usage ?? turn.usage ?? null;
                            const usageText = usageSource ? formatUsageMeter(usageSource, locale) : '';
                            const elapsedText =
                              typeof turn.elapsedMs === 'number' ? formatElapsedDuration(turn.elapsedMs, locale) : '';
                            const createdAtMs = typeof turn.createdAt === 'number' ? timestampMs(turn.createdAt) : null;
                            const agoText = createdAtMs ? formatCompletedAgo(createdAtMs, sidebarNow, locale) : '';
                            // Compact grand-total token chip, INLINE next to 用时 — but
                            // ONLY when this turn's runtime actually reported usage
                            // (claude/clawwork/anthropic-agent). codex/gemini report none,
                            // so we show 用时 alone rather than a fake "0 tokens"
                            // (Full Disclosure — never fabricate). Full per-field token
                            // breakdown AND "completed X ago" stay on the hover title to
                            // keep the always-visible line clean (痛点6).
                            const tokenTotal = usageTokenTotal(usageSource);
                            const tokenText = tokenTotal > 0 ? `${formatTokenCount(tokenTotal)} tokens` : '';
                            const metricsVisible = [elapsedText, tokenText].filter(Boolean).join('  ·  ');
                            const metricsTitle = [elapsedText, usageText, agoText].filter(Boolean).join(' · ');
                            // 'completed' is the silent happy path (no badge — 痛点1/5).
                            // Any OTHER neutral status (e.g. run-linked) still carries
                            // meaning, so keep it as quiet, box-free text.
                            const statusText = status === 'completed' ? '' : status;
                            if (!statusText && !metricsVisible) return null;
                            return (
                              <>
                                {statusText ? (
                                  <span className="chat-status-note neutral" data-testid="chat-status-note">
                                    {statusText}
                                  </span>
                                ) : null}
                                {metricsVisible ? (
                                  <span
                                    className="chat-turn-metrics"
                                    data-testid="chat-turn-metrics"
                                    title={metricsTitle}
                                  >
                                    {metricsVisible}
                                  </span>
                                ) : null}
                              </>
                            );
                          })()
                        : null}
                    </div>
                    <div className={turn.role === 'user' ? 'chat-bubble' : 'assistant-response'}>
                      {turn.role === 'user' ? (
                        <p>{turn.content}</p>
                      ) : status === 'working' && (!turn.content || turn.content === copy.directChatWorking) ? (
                        // No answer text yet — the live status line in the meta row
                        // carries "正在思考/调用工具…", so don't also echo the
                        // placeholder in the body.
                        null
                      ) : (
                        // 痛点3: render Markdown LIVE while streaming (throttled re-parse
                        // inside the wrapper) instead of only after completion.
                        <StreamingAssistantMarkdown
                          // Identity key: remount on a DIFFERENT turn so the live
                          // throttle state can't bleed across sessions even when the
                          // new reply shares a prefix with the old one (e.g. "Sure"
                          // → "Sure, here…"). A streaming turn always has startedAt;
                          // run_id/index back it up for reloaded/non-streaming turns.
                          key={`sam-${turn.run_id ?? turn.startedAt ?? index}`}
                          content={turn.content}
                          streaming={status === 'working'}
                          desktopInvoke={desktopInvoke}
                          // ONLY the message's own run — never a session-latest
                          // fallback, which would bind a run_id-less message's
                          // relative links to a different run (confused deputy).
                          // No own run => fail-closed (the link is not viewable).
                          fileRunId={turn.run_id ?? null}
                          onFileView={openFileViewer}
                          onWebView={openWebView}
                        />
                      )}
                      {turn.role !== 'user' && turn.display ? (
                        <TurnDisplay display={turn.display} hideUsage locale={locale} />
                      ) : null}
                      {turn.attachments && turn.attachments.length > 0 ? (
                        <div className="chat-turn-attachments" aria-label={copy.attachFiles}>
                          {turn.attachments.map((attachment) =>
                            attachment.kind === 'image' && attachment.data_url ? (
                              <button
                                type="button"
                                key={attachment.id}
                                className="chat-attachment-thumb"
                                title={attachment.name}
                                onClick={() =>
                                  setImageLightbox({
                                    src: attachment.data_url!,
                                    name: attachment.name,
                                    mime: attachment.mime,
                                    path: attachment.path,
                                  })
                                }
                                onContextMenu={(event) =>
                                  openImageContextMenu(event, {
                                    src: attachment.data_url!,
                                    name: attachment.name,
                                    mime: attachment.mime,
                                    path: attachment.path,
                                  })
                                }
                              >
                                <img src={attachment.data_url} alt={attachment.name} />
                              </button>
                            ) : (
                              <span
                                key={attachment.id}
                                className="chat-attachment-file"
                                title={attachment.path ?? attachment.name}
                              >
                                <Paperclip size={13} aria-hidden="true" />
                                <span>{attachment.path ?? attachment.name}</span>
                              </span>
                            ),
                          )}
                        </div>
                      ) : null}
                    </div>
                    {status !== 'working' && turn.content ? (
                      <div className="chat-turn-actions">
                        <button
                          type="button"
                          className="chat-turn-action"
                          aria-label={copiedChatTurn === index ? copy.messageCopied : copy.copyMessage}
                          title={copiedChatTurn === index ? copy.messageCopied : copy.copyMessage}
                          onClick={() => copyChatTurn(index, turn.content)}
                        >
                          {copiedChatTurn === index ? (
                            <Check size={13} aria-hidden="true" />
                          ) : (
                            <Copy size={13} aria-hidden="true" />
                          )}
                        </button>
                        {turn.role === 'user' ? (
                          <button
                            type="button"
                            className="chat-turn-action"
                            aria-label={copy.editMessage}
                            title={copy.editMessage}
                            onClick={() => reEditChatTurn(turn)}
                          >
                            <Pencil size={13} aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          ) : null}
          {/* Politely announce copy success to screen readers (the button only
              swaps its icon/label, which a reader may not pick up on its own). */}
          <span className="sr-only" role="status" aria-live="polite">
            {copiedChatTurn !== null ? copy.messageCopied : ''}
          </span>
        </div>
        <div className="chat-bottom-bar">
          {directChatTurns.length > 0 && !chatPinnedToBottom ? (
            <button
              type="button"
              className="chat-jump-bottom"
              onClick={() => {
                const el = chatScrollRegionRef.current;
                if (el) el.scrollTop = el.scrollHeight;
                setChatPinnedToBottom(true);
              }}
            >
              <ArrowDown size={14} aria-hidden="true" />
              {copy.newContentBelow}
            </button>
          ) : null}
          <div
            className="composer-card"
            aria-label={copy.composerLabel}
            onDrop={handleComposerDrop}
            onDragOver={handleComposerDragOver}
          >
            {composerLoginNotice ? (
              <div className="runtime-login-notice" role="alert">
                <span className="runtime-login-notice-icon" aria-hidden="true">⚠️</span>
                <span className="runtime-login-notice-text">{composerLoginNotice}</span>
                <button
                  type="button"
                  className="runtime-login-notice-dismiss"
                  onClick={() => setRuntimeLoginNotices((prev) => {
                    if (!(composerKey in prev)) return prev;
                    const next = { ...prev };
                    delete next[composerKey];
                    return next;
                  })}
                  aria-label={copy.closePanel}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            ) : null}
            {composerQueue.length > 0 ? (
              <div className={`chat-queue ${composerPaused ? 'paused' : ''}`} aria-label="Queued prompts">
                <div className="chat-queue-head">
                  <button
                    type="button"
                    className="chat-queue-toggle"
                    aria-expanded={chatQueueExpanded}
                    onClick={() => setChatQueueExpanded((value) => !value)}
                  >
                    {chatQueueExpanded ? (
                      <ChevronDown size={14} aria-hidden="true" />
                    ) : (
                      <ChevronUp size={14} aria-hidden="true" />
                    )}
                    <span className="chat-queue-count">
                      {copy.queued} · {composerQueue.length}
                    </span>
                    {composerPaused ? <span className="chat-queue-flag">{copy.queuePaused}</span> : null}
                    {!chatQueueExpanded ? (
                      <span className="chat-queue-peek">
                        {copy.queueNext}: {composerQueue[0].text}
                      </span>
                    ) : null}
                  </button>
                  <div className="chat-queue-head-actions">
                    {composerPaused ? (
                      <button type="button" className="chat-queue-link" onClick={resumeChatQueue}>
                        <Play size={13} aria-hidden="true" />
                        {copy.queueResume}
                      </button>
                    ) : null}
                    <button type="button" className="chat-queue-link" onClick={clearChatQueue}>
                      {copy.queueClear}
                    </button>
                  </div>
                </div>
                {chatQueueExpanded ? (
                  <ul className="chat-queue-list">
                    {composerQueue.map((item, index) => (
                      <li key={item.id} className="chat-queue-item">
                        <span className="chat-queue-pos">{index + 1}</span>
                        <span className="chat-queue-text">{item.text}</span>
                        <span className="chat-queue-item-actions">
                          <button
                            type="button"
                            aria-label={copy.queueMoveUp}
                            title={copy.queueMoveUp}
                            disabled={index === 0}
                            onClick={() => moveChatQueueItem(item.id, -1)}
                          >
                            <ArrowUp size={13} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={copy.queueMoveDown}
                            title={copy.queueMoveDown}
                            disabled={index === composerQueue.length - 1}
                            onClick={() => moveChatQueueItem(item.id, 1)}
                          >
                            <ArrowDown size={13} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={copy.queueEdit}
                            title={copy.queueEdit}
                            onClick={() => editChatQueueItem(item.id)}
                          >
                            <Pencil size={13} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={copy.queueRemove}
                            title={copy.queueRemove}
                            onClick={() => removeChatQueueItem(item.id)}
                          >
                            <Trash2 size={13} aria-hidden="true" />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <input
              ref={composerFileInputRef}
              className="composer-file-input"
              type="file"
              multiple
              accept="image/*,.csv,.doc,.docx,.html,.json,.log,.md,.pdf,.txt,.xls,.xlsx,.yaml,.yml"
              aria-label="Composer file input"
              onChange={handleComposerFileInputChange}
            />
            {composerAttachments.length > 0 ? (
              <div className="composer-attachments" aria-label="Staged attachments">
                {composerAttachments.map((attachment) => (
                  <div key={attachment.id} className={`composer-attachment-chip ${attachment.kind === 'image' ? 'image' : ''}`}>
                    {attachment.kind === 'image' && attachment.data_url ? (
                      <button
                        type="button"
                        className="composer-attachment-thumb"
                        aria-label={`${copy.previewImage}: ${attachment.name}`}
                        title={copy.previewImage}
                        onClick={() =>
                          setImageLightbox({
                            src: attachment.data_url!,
                            name: attachment.name,
                            mime: attachment.mime,
                            path: attachment.path,
                          })
                        }
                        onContextMenu={(event) =>
                          openImageContextMenu(event, {
                            src: attachment.data_url!,
                            name: attachment.name,
                            mime: attachment.mime,
                            path: attachment.path,
                          })
                        }
                      >
                        <img src={attachment.data_url} alt="" aria-hidden="true" />
                      </button>
                    ) : (
                      <Paperclip size={14} aria-hidden="true" />
                    )}
                    <span title={attachment.path ?? attachment.name}>{attachment.path ?? attachment.name}</span>
                    <button
                      type="button"
                      aria-label={`${copy.removeAttachment}: ${attachment.name}`}
                      title={copy.removeAttachment}
                      onClick={() => removeComposerAttachment(attachment.id)}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="composer-textarea-shell">
              {selectedContextRefs.length > 0 ? (
                <div className="composer-context-chips" aria-label="Selected context">
                  {selectedContextRefs.map((ref) => {
                    const label = ref.label || ref.id;
                    return (
                      <button
                        key={contextRefKey(ref)}
                        type="button"
                        className={`composer-context-chip ${ref.type === 'plugin' ? 'plugin' : ''}`}
                        aria-label={`Remove ${label}`}
                        title={ref.visible_token}
                        onClick={() => removeSelectedContextRef(ref)}
                      >
                        <PluginLogoMark logoUrl={contextRefLogoUrl(ref)} icon={contextRefIcon(ref)} label={label} size={15} />
                        <span>{label}</span>
                        <X size={12} aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <textarea
                ref={composerTextAreaRef}
                aria-label={copy.directPrompt}
                aria-expanded={Boolean(composerTrigger)}
                aria-controls={composerTrigger ? 'composer-suggestions' : undefined}
                aria-activedescendant={
                  composerTrigger && composerSuggestions[selectedSuggestionIndex]
                    ? composerSuggestionDomId(composerSuggestions[selectedSuggestionIndex])
                    : undefined
                }
                placeholder={copy.composerPlaceholder}
                value={prompt}
                onChange={handleComposerChange}
                onClick={handleComposerCaretChange}
                onCompositionStart={handleComposerCompositionStart}
                onCompositionEnd={handleComposerCompositionEnd}
                onInput={resizeComposerTextArea}
                onKeyDown={handleComposerKeyDown}
                onPaste={handleComposerPaste}
                onSelect={handleComposerCaretChange}
              />
              {!prompt ? (
                <span className="composer-send-hint" aria-hidden="true">
                  {composerWillEnqueue ? copy.sendHintQueue : copy.sendHint}
                </span>
              ) : null}
            </div>
            {composerTrigger ? (
              <div className="composer-suggestions" id="composer-suggestions" role="listbox" aria-label={composerTrigger.trigger === '/' ? 'Slash commands' : 'Context mentions'}>
                {composerSuggestions.length > 0 ? (
                  composerSuggestions.map((suggestion, index) => (
                    <button
                      type="button"
                      key={suggestion.id}
                      id={composerSuggestionDomId(suggestion)}
                      role="option"
                      aria-selected={index === selectedSuggestionIndex}
                      className={index === selectedSuggestionIndex ? 'active' : undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => applyComposerSuggestion(suggestion)}
                    >
                      <span className="composer-suggestion-main">
                        {suggestion.kind === 'context' && suggestion.ref?.type === 'plugin' ? (
                          <PluginLogoMark
                            logoUrl={contextRefLogoUrl(suggestion.ref)}
                            icon={contextRefIcon(suggestion.ref)}
                            label={suggestion.label}
                            size={16}
                          />
                        ) : null}
                        <span>{suggestion.label}</span>
                      </span>
                      <small>{suggestion.description}</small>
                    </button>
                  ))
                ) : (
                  <div className="composer-suggestion-empty" role="option" aria-selected="false">
                    No matches
                  </div>
                )}
              </div>
            ) : null}
            <div className="composer-footer">
              <button
                type="button"
                className="composer-command-button"
                aria-label={copy.attachFiles}
                title={copy.attachFiles}
                onClick={openAttachmentPicker}
              >
                <Plus size={18} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="composer-command-button"
                aria-label={copy.slashMenuLabel}
                title={copy.slashMenuLabel}
                onClick={openSlashMenu}
              >
                <SlashSquare size={16} aria-hidden="true" />
              </button>
              {/* Flex spacer: pins the command affordances left and the whole
                  control cluster right, robustly (a real child, not a sibling
                  selector), and shrinks first when the row is tight. */}
              <div className="composer-footer-spacer" aria-hidden="true" />
              {/* Workspace target — only for a brand-new chat (no bound session
                  yet). An existing chat's workspace is fixed by its binding;
                  changing it is the "Move to project" action, not a per-turn
                  pick. Hidden in the inventory-absent fallback. */}
              {!activeBackendChatSessionId && workspaces.length > 0 ? (
                <Dropdown
                  className="runtime-select"
                  ariaLabel={copy.composerWorkspaceAria}
                  title={copy.composerWorkspaceAria}
                  icon={pinnedWorkspaceId ? <FolderInput size={14} aria-hidden="true" /> : <Bot size={14} aria-hidden="true" />}
                  value={pinnedWorkspaceId ?? ''}
                  options={composerWorkspaceOptions}
                  renderValue={(selected) => selected?.label ?? pinnedWorkspaceName ?? pinnedWorkspaceId ?? ''}
                  onChange={(next) => {
                    if (!next) {
                      setPinnedWorkspaceId(null);
                      setPinnedWorkspaceName(null);
                      return;
                    }
                    const workspace = workspaces.find((w) => w.workspace_id === next);
                    setPinnedWorkspaceId(next);
                    setPinnedWorkspaceName(workspace?.name ?? null);
                  }}
                />
              ) : null}
              <Dropdown
                className="runtime-select"
                ariaLabel={t('Backend')}
                title={t('Runtime backend hint')}
                icon={<Bot size={14} aria-hidden="true" />}
                value={selectedBackend}
                options={composerRuntimeOptions}
                onChange={selectComposerBackendOrConfigure}
              />
              {selectedAgentInfo?.uses_relay_packages ? (
                // Two-level menu (clawwork only — uses_relay_packages): level-1 picks the
                // package tier (closed set of relay super-groups), level-2 picks a concrete
                // model WITHIN that tier. The submit value `selectedModel` is the composite
                // "<tier>::<model>" (or bare "<tier>" = relay default model for the tier,
                // or "" = relay default). Both levels are constrained Dropdowns (never a
                // free ComboInput) so a user can never type a raw model id. The level-2
                // model list is fetched on-demand per tier (binds the relay key to that
                // tier server-side), cached, and a single-model tier auto-selects.
                (() => {
                  // Canonical lowercase tier: matches the lowercase pkg.id options and the
                  // lowercase-keyed model cache, so a dirty-cased restored composite still
                  // renders level-2 (agy review note) and submits a normalized tier.
                  const composerTier = selectedModel.split('::', 1)[0].trim().toLowerCase();
                  const composerTierModel = selectedModel.includes('::')
                    ? selectedModel.slice(selectedModel.indexOf('::') + 2)
                    : '';
                  const tierModels = composerTier ? relayPackageModels[composerTier] : undefined;
                  const tierModelsLoading = relayPackageModelsLoading === composerTier;
                  // Level-2 only matters when the tier holds MORE than one model — a
                  // single-model tier is already auto-bound (业主: no extra design there).
                  const showLevel2 = Boolean(composerTier) && Array.isArray(tierModels) && tierModels.length > 1;
                  return (
                    <>
                      <Dropdown
                        className="runtime-model-select"
                        ariaLabel={t('Runtime package')}
                        title={t('Runtime package hint')}
                        icon={<Bot size={14} aria-hidden="true" />}
                        value={composerTier}
                        disabled={Boolean(relayPackages) && !relayPackages?.available}
                        options={[
                          {
                            value: '',
                            label:
                              relayPackages && !relayPackages.available
                                ? t('Runtime package login required')
                                : selectedAgentInfo?.default_model || t('Runtime package default'),
                          },
                          ...(relayPackages?.packages ?? []).map((pkg) => ({
                            value: pkg.id,
                            label: pkg.name,
                            description: pkg.tier !== pkg.name ? pkg.tier : undefined,
                            // 越级档（locked，来自内核 is_tier_locked）：禁选 + 锁图标，前端零计算只渲染。
                            disabled: pkg.locked === true,
                            badge: pkg.locked === true ? '🔒' : undefined,
                          })),
                        ]}
                        onChange={(value) => {
                          void handleSelectPackageTier(value);
                        }}
                      />
                      {showLevel2 ? (
                        <Dropdown
                          className="runtime-model-select"
                          ariaLabel={t('Runtime package model')}
                          title={t('Runtime package model hint')}
                          icon={<Bot size={14} aria-hidden="true" />}
                          value={composerTierModel}
                          disabled={tierModelsLoading}
                          options={[
                            { value: '', label: t('Runtime package model default') },
                            ...(tierModels ?? []).map((m) => ({ value: m, label: m })),
                          ]}
                          onChange={(model) => {
                            setSelectedModel(model ? `${composerTier}::${model}` : composerTier);
                          }}
                        />
                      ) : null}
                    </>
                  );
                })()
              ) : selectedAgentInfo?.supports_model_selection ? (
                <ComboInput
                  className="runtime-model-select"
                  ariaLabel={t('Runtime model')}
                  title={t('Runtime model hint')}
                  // value stays bound to selectedModel ('' = REQUEST_CLEAR, the
                  // input remains clearable and what-you-see-is-what-you-send).
                  // The concrete default model rides the PLACEHOLDER instead, so a
                  // blank field still shows which model it will run (e.g.
                  // claude-opus-4-8) without faking an explicit selection.
                  value={selectedModel}
                  placeholder={composerEffectiveModel || t('Runtime model default')}
                  onChange={setSelectedModel}
                  suggestions={((modelCatalogs[selectedAgentInfo?.name ?? selectedBackend]?.models?.length
                    ? modelCatalogs[selectedAgentInfo?.name ?? selectedBackend].models
                    : selectedAgentInfo?.suggested_models ?? []
                  )).map((model) => ({
                    value: model,
                    label: model,
                  }))}
                />
              ) : null}
              {selectedAgentInfo?.supports_effort_selection ? (
                selectedAgentInfo?.effort_input_mode === 'text' ? (
                  // Provider-specific levels (opencode --variant): free-form combo
                  // with suggestions, mirroring the model input.
                  <ComboInput
                    className="runtime-effort-select"
                    ariaLabel={t('Runtime effort')}
                    title={t('Runtime effort hint')}
                    value={selectedEffort}
                    placeholder={t('Runtime effort default')}
                    onChange={setSelectedEffort}
                    suggestions={(selectedAgentInfo?.effort_levels ?? []).map((level) => ({
                      value: level,
                      label: level,
                    }))}
                  />
                ) : (
                  // Closed enum (codex / claude): constrained dropdown; the
                  // leading empty option inherits the runtime default (never a
                  // backfilled explicit request).
                  <Dropdown
                    className="runtime-effort-select"
                    ariaLabel={t('Runtime effort')}
                    title={t('Runtime effort hint')}
                    icon={<Gauge size={14} aria-hidden="true" />}
                    value={selectedEffort}
                    options={[
                      { value: '', label: t('Runtime effort default') },
                      ...(selectedAgentInfo?.effort_levels ?? []).map((level) => ({
                        value: level,
                        label: level,
                      })),
                    ]}
                    onChange={setSelectedEffort}
                  />
                )
              ) : null}
              {SHOW_COMPOSER_MODE_CONTROLS ? (
                <Dropdown
                  ariaLabel={t('Permission mode')}
                  title={permissionPreset === 'allow' ? t('Permission allow hint') : t('Permission ask hint')}
                  icon={<ShieldCheck size={14} aria-hidden="true" />}
                  value={permissionPreset}
                  options={[
                    { value: 'ask', label: t('Permission ask'), description: t('Permission ask hint') },
                    { value: 'allow', label: t('Permission allow'), description: t('Permission allow hint') },
                  ]}
                  onChange={(next) => selectPermissionPreset(next as 'ask' | 'allow')}
                />
              ) : null}

              <div className="button-row">
                {/* Goal Mode (目标模式) toggle: when on, a chat send plans the
                    message into a goal + opens the confirmation dialog. */}
                {SHOW_COMPOSER_MODE_CONTROLS ? (
                  <button
                    type="button"
                    className={`text-button compact${goalModeOn ? ' is-active' : ''}`}
                    aria-pressed={goalModeOn}
                    aria-label={locale === 'zh' ? '目标模式' : 'Goal mode'}
                    title={locale === 'zh' ? '把本次对话转为目标（目标模式）' : 'Turn this into a goal (goal mode)'}
                    onClick={() => setGoalModeOn((v) => !v)}
                  >
                    <Target size={16} aria-hidden="true" />
                    {locale === 'zh' ? '目标模式' : 'Goal'}
                  </button>
                ) : null}
                {composerIsBusy ? (
                  <>
                    {prompt.trim() || composerAttachments.length > 0 ? (
                      <button
                        className="text-button compact"
                        aria-label="Queue prompt"
                        onClick={() => submitDirectChat()}
                      >
                        <Plus size={16} aria-hidden="true" />
                        {copy.enqueue}
                      </button>
                    ) : null}
                    <button
                      className="text-button compact primary-action danger"
                      aria-label="Stop run"
                      onClick={stopActiveTurn}
                      disabled={composerIsStopping}
                    >
                      {composerIsStopping ? (
                        <LoaderCircle size={16} className="spin" aria-hidden="true" />
                      ) : (
                        <Square size={16} aria-hidden="true" />
                      )}
                      {composerIsStopping ? copy.stopping : copy.stop}
                    </button>
                  </>
                ) : (
                  <button
                    className="text-button compact primary-action"
                    aria-label="Submit chat turn"
                    onClick={() => submitDirectChat()}
                    disabled={
                      (!prompt.trim() && composerAttachments.length === 0) ||
                      (goalModeOn && goalPlanBusy)
                    }
                  >
                    <Bot size={16} aria-hidden="true" />
                    {composerWillEnqueue ? copy.enqueue : copy.ask}
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="composer-status-row" aria-label="Composer status">
            <span className="status-pill neutral">
              {copy.chat}
            </span>
            <span
              className={`agent-status-pill ${composerIsBusy ? 'running' : 'idle'}`}
              title={composerIsBusy ? copy.working : copy.ready}
            >
              <span className="agent-status-dot" aria-hidden="true" />
              <span className="agent-status-name">{selectedBackend}</span>
              <span className="agent-status-state">{composerIsBusy ? copy.working : copy.ready}</span>
            </span>
          </div>
        </div>
        {(workspaceSurface as string) === 'control' ? (
          <>
	            <div className="meta-grid" aria-label="Goal constraints">
	              <label>
	                {t('Backend')}
                <Dropdown
                  variant="field"
                  ariaLabel={t('Backend')}
                  value={selectedBackend}
                  options={[
                    ...backends.map((backend) => ({ value: backend.name, label: backend.name })),
                    { value: 'all', label: 'all' },
                  ]}
                  onChange={selectComposerBackend}
                />
              </label>
	              <label>
	                {t('Harness')}
                <Dropdown
                  variant="field"
                  ariaLabel={t('Harness')}
                  value={selectedHarness}
                  options={harnesses.map((harness) => ({
                    value: harness.harness_id,
                    label: harness.harness_id,
                  }))}
                  onChange={setSelectedHarness}
                />
              </label>
              <span>Backend: {selectedInfo?.available ? 'available' : selectedInfo?.reason ?? 'probing'}</span>
              <span>Harness: {selectedHarness}</span>
              <span>Runtime mode: {runtimeStatus?.mode ?? 'auto'}</span>
              <span>Runtime uptime: {formatSeconds(runtimeStatus?.service?.uptime_seconds)}</span>
              <span>Runtime bind: {runtimeStatus?.service?.bind ?? 'probing'}</span>
              <span>Runtime pid: {runtimeStatus?.service?.pid ?? 'probing'}</span>
              <span>Token state: {runtimeStatus?.service?.control_token ?? 'unset'}</span>
              <span>Shell default backend: {runtimeConfig?.defaults?.backend ?? runtimeStatus?.backend ?? 'claude'}</span>
              <span>Shell default mode: {runtimeConfig?.defaults?.mode ?? runtimeStatus?.mode ?? 'auto'}</span>
              <span>Config file: {runtimeConfig?.config_path ?? runtimeStatus?.config?.path ?? 'unlock with control token'}</span>
	              <label>
	                {t('Control token')}
                <input
                  aria-label="Control token"
                  type="password"
                  value={controlToken}
                  onChange={(event) => saveControlToken(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="text-button compact"
                onClick={() => void rotateControlToken()}
                disabled={runtimeStatus?.service?.control_token !== 'set'}
              >
	                {t('Rotate token')}
              </button>
              <button type="button" className="text-button compact" onClick={() => void saveBackendDefault()}>
	                {t('Save backend default')}
              </button>
            </div>
            <details className="eval-drawer">
	              <summary>{t('Evaluation lane')}</summary>
              <div className="eval-controls" aria-label="Eval dashboard">
                <label>
	                  {t('Agent')}
                  <Dropdown
                    variant="field"
                    ariaLabel={t('Agent')}
                    value={evalAgent}
                    options={['all', 'superclaw', 'claude', 'codex'].map((name) => ({
                      value: name,
                      label: name,
                    }))}
                    onChange={setEvalAgent}
                  />
                </label>
                <label>
	                  {t('Case')}
                  <Dropdown
                    variant="field"
                    ariaLabel={t('Case')}
                    value={evalCase}
                    options={[
                      'mini-pay-webhook',
                      'mini-order-ledger',
                      'mini-awd-arena',
                    ].map((name) => ({ value: name, label: name }))}
                    onChange={setEvalCase}
                  />
                </label>
                <button className="text-button" onClick={() => void startEval()}>
                  <Play size={16} />
	                  {t('Run eval')}
                </button>
                <button className="text-button" onClick={() => void cancelEval()}>
                  <Square size={16} />
	                  {t('Cancel eval')}
                </button>
                {evalReport && (
                  <button className="download-link eval-report-download-button" type="button" onClick={() => downloadEvalReport('md')}>
                    <Download size={16} />
	                    {t('Report')}
                  </button>
                )}
                {evalReport && (
                  <button className="download-link eval-report-download-button" type="button" onClick={() => downloadEvalReport('pdf')}>
                    <Download size={16} />
                    PDF
                  </button>
                )}
              </div>
              {/* Eval delivery gap coverage stays a first-class surface (team
                  fix f033604) — re-homed onto the eval summary in the redesign */}
              <div className="eval-summary" aria-label="Eval delivery gap summary">
                <span>Eval: {evalId || 'none'}</span>
                <span>Status: {evalStatus}</span>
                <span>Case: {evalReport?.case_id ?? evalCase}</span>
                <span>Verdict: {evalReport?.verdict ?? 'none'}</span>
              </div>
            </details>
          </>
        ) : null}
      </section>
      ) : null}

      {workspaceSurface === 'chat' && rightPanelOpen ? (
      <ConversationTabHost
        tabs={conversationTabs}
        activeTabId={activeTabId}
        id="conversation-panel"
        className="timeline-pane context-drawer tab-host"
        shellRef={contextRailRef}
        tabMeta={conversationTabMeta}
        renderContent={renderTabContent}
        emptyState={conversationTabsEmptyState}
        newTabOptions={conversationNewTabOptions}
        labels={{
          region: copy.conversationPanel,
          close: copy.closePanel,
          newTab: copy.newTab,
          newTabMenu: copy.newTabMenu,
          closeTab: copy.closeTab,
        }}
        onSelectTab={selectTab}
        onCloseTab={closeTab}
        onNewTab={openNewTab}
        onClose={() => setRightPanelOpen(false)}
        resizeHandle={
          <div
            className="context-resize-handle"
            role="separator"
            aria-label={copy.resizeContextPanel}
            aria-orientation="vertical"
            aria-valuemin={Math.round(contextInteraction.lowerBound)}
            aria-valuemax={Math.round(contextInteraction.upperBound)}
            aria-valuenow={Math.round(effectiveContextWidth)}
            tabIndex={0}
            onPointerDown={startContextPanelResize}
            onKeyDown={handleContextResizeKeyDown}
          />
        }
      />
      ) : null}

      {workspaceSurface !== 'chat' && workspaceSurface !== 'team' && workspaceSurface !== 'canvas' ? (
      <section
        className={`workspace-page ${workspaceSurface}-page${workspaceSurface === 'control' ? ' settings-fullscreen-page' : ''}`}
        aria-labelledby="workspace-page-title"
      >
        {workspaceSurface === 'control' ? (
          <SettingsSidebar
            copy={copy}
            navGroups={settingsNavGroups}
            activeSettingsTarget={activeSettingsTarget}
            onSelectTarget={selectSettingsTarget}
            onBackToApp={() => setWorkspaceSurface(settingsReturnRef.current)}
          />
        ) : null}
        <div className="workspace-topbar">
          <button className="workspace-back-button" type="button" aria-label={copy.backToMain} onClick={() => setWorkspaceSurface(workspaceSurface === 'control' ? settingsReturnRef.current : 'chat')}>
            <ArrowLeft size={16} />
            {copy.backToMain}
          </button>
        </div>
        {/* Capability Workshop (plugins surface) renders no visible eyebrow/title/lede —
            those three lines pulled the visual centre of gravity above the tabs. The
            heading is kept sr-only so it still anchors aria-labelledby and satisfies the
            heading-role assertions in the tests; the header box is collapsed via
            workspace-header--bare so the tablist leads the surface. Settings is unchanged. */}
        <header className={`workspace-header${workspaceSurface === 'plugins' ? ' workspace-header--bare' : ''}`}>
          <div>
            {workspaceSurface !== 'plugins' ? (
              <span className="workspace-kicker">{workspaceSurface === 'control' ? copy.settings : copy.pluginsMarketplace}</span>
            ) : null}
            <h1 id="workspace-page-title" className={workspaceSurface === 'plugins' ? 'sr-only' : undefined}>{workspaceSurface === 'control' ? activeSettingsTitle : copy.pluginTitle}</h1>
            {workspaceSurface !== 'plugins' ? (
              <p className="workspace-lede">{workspaceSurface === 'control' ? copy.settingsSubtitle : copy.pluginsSubtitle}</p>
            ) : null}
          </div>
        </header>
        {workspaceSurface === 'control' ? (
          <SettingsContent
            t={t}
            copy={copy}
            activeSettingsSection={activeSettingsSection}
            themePreferenceOptions={themePreferenceOptions}
            themePreference={themePreference}
            switchThemePreference={switchThemePreference}
            appearance={appearance}
            activeCanvas={activeTheme as AppearanceCanvas}
            selectAppearancePreset={selectAppearancePreset}
            setAppearanceCustomColor={setAppearanceCustomColor}
            resetAppearance={resetAppearance}
            exportAppearance={exportAppearance}
            importAppearanceBundle={importAppearanceBundle}
            locale={locale}
            switchLocale={switchLocale}
            previewConfirmEnabled={previewConfirmEnabled}
            setPreviewConfirm={setPreviewConfirm}
            previewProxyEnabled={previewProxyEnabled}
            setPreviewProxy={setPreviewProxy}
            selectedAgentAvailable={selectedAgentAvailable}
            selectedBackend={selectedBackend}
            agentInventory={agentInventory}
            openAgentSetupFor={openAgentSetupFor}
            agentExecutableDraft={agentExecutableDraft}
            setAgentExecutableDraft={setAgentExecutableDraft}
            selectedAgentExecutableConfigName={selectedAgentExecutableConfigName}
            selectedAgentInfo={selectedAgentInfo}
            runtimeConfig={runtimeConfig}
            runtimeStatus={runtimeStatus}
            selectedAgentReadinessText={selectedAgentReadinessText}
            saveAgentRuntimeSetup={saveAgentRuntimeSetup}
            setAgentSetupOpen={setAgentSetupOpen}
            authStatus={authStatus}
            accountOverview={accountOverview}
            loadAccountOverview={loadAccountOverview}
            accountTokenUsageMode={accountTokenUsageMode}
            setAccountTokenUsageMode={setAccountTokenUsageMode}
            accountTokenUsage={accountTokenUsage}
            loadAccountTokenUsage={loadAccountTokenUsage}
            clawHuntAccountName={clawHuntAccountName}
            clawHuntSsoSignedIn={Boolean(clawHuntSsoIdentity)}
            clawHuntAccountAvatar={clawHuntAccountAvatar}
            clawHuntBrowserLoginBusy={clawHuntBrowserLoginBusy}
            accountLoginBusy={Boolean(clawHuntBrowserLoginBusy)}
            openLoginDialog={startClawHuntAccountShortcutLogin}
            logoutClawHunt={logoutClawHunt}
            saveRuntimeConfigValue={saveRuntimeConfigValue}
            desktopShellInfo={desktopShellInfo}
            copyWorkspaceUpdateCommand={copyWorkspaceUpdateCommand}
            desktopAlertsEnabled={desktopAlertsEnabled}
            desktopAlertPermission={desktopAlertPermission}
            desktopAlertHistory={desktopAlertHistory}
            enableDesktopAlerts={enableDesktopAlerts}
            disableDesktopAlerts={disableDesktopAlerts}
            sendTestDesktopAlert={sendTestDesktopAlert}
            generateIncidentExport={generateIncidentExport}
            desktopIncidentExport={desktopIncidentExport}
            probeResults={probeResults}
            probingBackends={probingBackends}
            probeAllBusy={probeAllBusy}
            probeRuntime={probeRuntime}
            probeRuntimeDeep={(b: string) => probeRuntime(b, { deep: true })}
            probeAllRuntimes={probeAllRuntimes}
            invalidateProbe={invalidateProbe}
          />
        ) : workspaceSurface === 'plugins' ? (
          <>
            {/* Shared list-card manage menu — uninstall only (configure lives on the
                detail page), anchored to whichever installed-plugin card's kebab was
                clicked. Never render it on the detail page: the anchor card unmounts
                there, so a lingering menu must not fire against a stale plugin. */}
            {!workshopDetail && cardMenuModel?.item ? (
              <Popover
                open
                anchorRef={cardMenuAnchorRef}
                ariaLabel={t('Workshop more actions')}
                className="workshop-detail-menu"
                onClose={() => setCardMenuModel(null)}
              >
                <button
                  type="button"
                  className="workshop-detail-menu-item danger"
                  onClick={() => {
                    const it = cardMenuModel.item!;
                    setCardMenuModel(null);
                    void uninstallPlugin(it.plugin_id, it.version, it.origin, it.native_key);
                  }}
                >
                  <Trash2 size={16} aria-hidden="true" />
                  <span>{t('Workshop uninstall')}</span>
                </button>
              </Popover>
            ) : null}
            {workshopDetail ? (
              <div className="plugin-marketplace-shell workshop-detail-shell" aria-label={t('Marketplace catalog')}>
                {renderCapabilityDetail(workshopDetail)}
              </div>
            ) : null}
            {!workshopDetail ? (
            <div className="plugin-marketplace-shell" aria-label={t('Marketplace catalog')}>
              <section className="plugin-store-topbar" aria-label={t('Marketplace catalog')}>
                <div className="plugin-store-tabs" role="tablist" aria-label={t('Marketplace catalog')}>
                  <button
                    className={pluginStoreTab === 'all' ? 'active' : ''}
                    type="button"
                    role="tab"
                    aria-selected={pluginStoreTab === 'all'}
                    onClick={() => setPluginStoreTab('all')}
                  >
                    {t('Plugin catalog tab all')}
                  </button>
                  <button
                    className={pluginStoreTab === 'plugins' ? 'active' : ''}
                    type="button"
                    role="tab"
                    aria-selected={pluginStoreTab === 'plugins'}
                    onClick={() => setPluginStoreTab('plugins')}
                  >
                    {t('Plugin catalog tab plugins')}
                  </button>
                  <button
                    className={pluginStoreTab === 'skills' ? 'active' : ''}
                    type="button"
                    role="tab"
                    aria-selected={pluginStoreTab === 'skills'}
                    onClick={() => setPluginStoreTab('skills')}
                  >
                    {t('Plugin catalog tab skills')}
                  </button>
                  <button
                    className={pluginStoreTab === 'companies' ? 'active' : ''}
                    type="button"
                    role="tab"
                    aria-selected={pluginStoreTab === 'companies'}
                    onClick={() => setPluginStoreTab('companies')}
                  >
                    {t('Plugin catalog tab companies')}
                  </button>
                </div>
                <div className="plugin-store-actions">
                  {/* The advanced operator panel is a PLUGIN registry/install tool. Hide
                      its toggle on the Skills tab AND the read-only Overview so there is no
                      entry point to install a skill-origin registry item via the plugin
                      install flow (Codex blocker: card-read-only must mean page-read-only). */}
                  {pluginStoreTab !== 'skills' && pluginStoreTab !== 'all' ? (
                    <button
                      className={`icon-text-button ${pluginAdvancedOpen ? 'active' : ''}`}
                      type="button"
                      onClick={() => setPluginAdvancedOpen((open) => !open)}
                      aria-expanded={pluginAdvancedOpen}
                      aria-controls="plugin-operator-section"
                    >
                      <Settings2 size={17} aria-hidden="true" />
                      {t('Plugin catalog manage')}
                    </button>
                  ) : null}
                </div>
              </section>

              {pluginStoreTab === 'all' ? (
                <section className="plugin-marketplace-hero plugin-store-showcase">
                  <div>
                    <span className="workspace-kicker">{copy.pluginsMarketplace}</span>
                    <h2>{t('Plugin catalog title')}</h2>
                    <p>{t('Plugin catalog subtitle')}</p>
                  </div>
                </section>
              ) : null}

              {pluginStoreTab === 'all' ? (
                <section className="workshop-overview" aria-label={t('Plugin catalog title')}>
                  {/* Overview: three peer sections (Skills / Plugins / Companies)
                      rendered with the SAME unified card. Read-only birds-eye view
                      (authoringAllowed=false): cards offer use-in-chat navigation +
                      open-detail only — never install/instantiate authoring here. */}
                  <div className="workshop-overview-section">
                    <header className="workshop-overview-head">
                      <h2>{t('Overview section skills')}</h2>
                      <span className="workshop-overview-count">
                        {nativeSkills.length + remoteSkillCatalogItems.length}
                      </span>
                    </header>
                    {renderWorkshopGrid(
                      [
                        ...nativeSkills.map(nativeSkillCardModel),
                        ...remoteSkillCatalogItems.map(catalogItemCardModel),
                      ],
                      { authoringAllowed: false, emptyLabel: t('Overview class empty') },
                    )}
                  </div>
                  {groupedPluginCatalogItems.map((group) => (
                    <div className="workshop-overview-section" key={`overview-${group.key}`}>
                      <header className="workshop-overview-head">
                        <h2>{group.label}</h2>
                        <span className="workshop-overview-count">{group.items.length}</span>
                      </header>
                      {renderWorkshopGrid(group.items.map(catalogItemCardModel), {
                        authoringAllowed: false,
                        emptyLabel: t('Overview class empty'),
                      })}
                    </div>
                  ))}
                  <div className="workshop-overview-section coming-soon-module">
                    <header className="workshop-overview-head">
                      <h2>{t('Coming soon heading')}</h2>
                      <span className="coming-soon-badge">{t('Coming soon badge')}</span>
                    </header>
                    <p className="coming-soon-lede">{t('Coming soon lede')}</p>
                  </div>
                </section>
              ) : null}

              {pluginStoreTab === 'skills' ? (
                <>
                  <section className="native-skill-store" aria-label={t('Native skill store title')}>
                    <header className="native-skill-store-header">
                      <div>
                        <span className="workspace-kicker">{t('Native skill store title')}</span>
                        <p>{t('Native skill store subtitle')}</p>
                      </div>
                      <button
                        className="text-button compact"
                        type="button"
                        onClick={() => void loadNativeSkills()}
                        disabled={nativeSkillsLoading}
                      >
                        <RefreshCw size={16} className={nativeSkillsLoading ? 'spin' : ''} aria-hidden="true" />
                        {nativeSkillsLoading ? t('Native skills loading') : t('Native skills refresh')}
                      </button>
                    </header>
                    {pluginStoreTab === 'skills' ? (
                    <div className="skill-build-panel">
                      <div className="skill-build-copy">
                        <strong>{t('Skill build title')}</strong>
                        <p>{t('Skill build subtitle')}</p>
                      </div>
                      <form
                        className="skill-build-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void buildSkillFromPath();
                        }}
                      >
                        <input
                          type="text"
                          value={skillBuildPath}
                          onChange={(event) => setSkillBuildPath(event.target.value)}
                          placeholder={t('Skill build path placeholder')}
                          aria-label={t('Skill build path placeholder')}
                          disabled={skillBuildBusy}
                        />
                        <button
                          className="primary-button compact"
                          type="submit"
                          disabled={skillBuildBusy || !skillBuildPath.trim()}
                        >
                          {skillBuildBusy ? t('Skill build busy') : t('Skill build action')}
                        </button>
                      </form>
                      {skillBuildError ? (
                        <p className="skill-build-error" role="alert">
                          {t('Skill build error')}: {skillBuildError}
                        </p>
                      ) : null}
                      {skillBuildResult ? (
                        <div className="skill-build-result" role="status">
                          <span className="skill-build-success">{t('Skill build success')}</span>
                          <span className="skill-build-id">{skillBuildResult.plugin_id}</span>
                          <span className="skill-build-id">{skillBuildResult.version}</span>
                          {/* Provenance badge: render the KERNEL-derived grade verbatim
                              (shared catalog trust copy); the Web never upgrades it. */}
                          <span
                            className={`skill-label-badge skill-label-${(skillBuildResult.trust_state || 'untrusted').replace(/[^a-z0-9-]+/g, '-')}`}
                          >
                            {catalogContract?.copy?.trust?.[skillBuildResult.trust_state] ?? skillBuildResult.trust_state}
                          </span>
                          {skillBuildResult.equippable ? (
                            <span className="status-pill ok">{t('Skill build equippable')}</span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    ) : null}
                    {nativeSkillsError ? (
                      <article className="plugin-catalog-conflict-banner" role="alert">
                        <div>
                          <strong>{t('Native skills error')}</strong>
                          <p>{nativeSkillsError}</p>
                        </div>
                      </article>
                    ) : nativeSkillsLoading && nativeSkills.length === 0 ? (
                      <p className="skill-projection-empty">{t('Native skills loading')}</p>
                    ) : nativeSkills.length ? (
                      renderWorkshopGrid(nativeSkills.map(nativeSkillCardModel), {
                        authoringAllowed: true,
                        emptyLabel: t('Native skills empty'),
                      })
                    ) : (
                      <article className="plugin-catalog-row empty">
                        <span className="plugin-icon-tile">
                          <Puzzle size={22} aria-hidden="true" />
                        </span>
                        <div className="plugin-catalog-row-copy">
                          <strong>{t('No skill plugins')}</strong>
                          <p>{t('Native skills empty')}</p>
                        </div>
                      </article>
                    )}
                  </section>

                  {remoteSkillCatalogItems.length > 0 ? (
                    <section className="remote-skill-catalog" aria-label={t('Remote skill catalog title')}>
                      <div className="remote-skill-catalog-head">
                        <span className="workspace-kicker">{t('Remote skill catalog title')}</span>
                        <p>{t('Remote skill catalog subtitle')}</p>
                      </div>
                      {/* Remote published skills are view-only (not installed, not
                          installable here): the unified card with authoringAllowed=false
                          + not-installed => no action button, click opens the read-only
                          detail. The section subtitle states the view-only intent. */}
                      {renderWorkshopGrid(remoteSkillCatalogItems.map(catalogItemCardModel), {
                        authoringAllowed: false,
                        emptyLabel: t('Native skills empty'),
                      })}
                    </section>
                  ) : null}

                  {pluginStoreTab === 'skills' ? (
                  <section className="skill-sync-panel" aria-label={t('Skill projections title')}>
                    <div className="skill-sync-header">
                      <div>
                        <span className="workspace-kicker">{t('Skill projections title')}</span>
                        <p>{t('Skill projections subtitle')}</p>
                        {skillSyncContract ? (
                          <p className="skill-sync-targets">
                            {t('Skill sync targets')}: {skillSyncContract.targets.map((target) => target.name).join(', ')}
                          </p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="skill-sync-action"
                        onClick={() => void syncSkills()}
                        disabled={skillSyncBusy}
                      >
                        {skillSyncBusy ? t('Skill sync busy') : t('Skill sync all')}
                      </button>
                    </div>
                    {skillProjections && skillProjections.records.length > 0 ? (
                      <ul className="skill-projection-list">
                        {skillProjections.records.map((record) => (
                          <li key={record.path} className="skill-projection-row">
                            <div className="skill-projection-meta">
                              <strong>{record.plugin_id}</strong>
                              <span className="skill-projection-target">{record.target}</span>
                              <code>{record.path}</code>
                            </div>
                            <button
                              type="button"
                              className="text-button compact"
                              onClick={() => void unsyncSkillsForPlugin(record.plugin_id)}
                              disabled={skillSyncBusy}
                            >
                              {t('Skill unsync')}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="skill-projection-empty">{t('Skill projections empty')}</p>
                    )}
                  </section>
                  ) : null}
                </>
              ) : null}

              {pluginStoreTab === 'plugins' ? (
                <>
                  <section className="plugin-marketplace-hero plugin-store-showcase">
                    <div>
                      <span className="workspace-kicker">{copy.pluginsMarketplace}</span>
                      <h2>{t('Plugin catalog title')}</h2>
                      <p>{t('Plugin catalog subtitle')}</p>
                    </div>
                  </section>

                  <section className="plugin-store-controls" aria-label={t('Marketplace catalog')}>
                    <label className="plugin-store-search">
                      <Search size={18} aria-hidden="true" />
                      <input
                        aria-label={t('Search plugins')}
                        value={pluginQuery}
                        onChange={(event) => setPluginQuery(event.target.value)}
                        placeholder={t('Marketplace search placeholder')}
                      />
                    </label>
                    <div className="plugin-store-filter" role="group" aria-label={t('Marketplace catalog')}>
                      {[
                        ['all', t('Plugin catalog filter all')],
                        ['installed', t('Plugin catalog filter installed')],
                        ['available', t('Plugin catalog filter available')],
                      ].map(([value, label]) => (
                        <button
                          key={value}
                          className={pluginCatalogFilter === value ? 'active' : ''}
                          type="button"
                          onClick={() => setPluginCatalogFilter(value as 'all' | 'installed' | 'available')}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <button
                      className="text-button compact"
                      type="button"
                      onClick={() => void syncCapabilityRegistry()}
                      disabled={catalogSyncBusy}
                    >
                      <RefreshCw size={16} className={catalogSyncBusy ? 'spin' : ''} />
                      {catalogSyncBusy ? t('Capability registry syncing') : t('Capability registry sync')}
                    </button>
                    <button
                      className={`icon-text-button plugin-store-create-button ${pluginCreatorOpen ? 'active' : ''}`}
                      type="button"
                      onClick={() => setPluginCreatorOpen((open) => !open)}
                      aria-expanded={pluginCreatorOpen}
                      aria-controls="plugin-creator-panel"
                    >
                      <Plus size={17} aria-hidden="true" />
                      {t('Plugin create action')}
                    </button>
                  </section>
                </>
              ) : null}

              {pluginStoreTab === 'plugins' && pluginCreatorOpen ? (
                <section id="plugin-creator-panel" className="plugin-creator-panel" aria-labelledby="plugin-creator-heading">
                  <header className="plugin-creator-header">
                    <div>
                      <span className="workspace-kicker">{t('Plugin catalog create')}</span>
                      <h2 id="plugin-creator-heading">{t('Plugin creator title')}</h2>
                      <p>{t('Plugin creator description')}</p>
                    </div>
                    <span className={`status-pill ${developerSubmission ? capabilityStatusTone(developerSubmission.capability_status ?? developerSubmission.status) : 'neutral'}`}>
                      {developerSubmission?.status ?? (developerSubmissionId || 'new submission')}
                    </span>
                  </header>
                  <div className="plugin-creator-grid" aria-label="Developer review surfaces">
                    <article className="control-card">
                      <div className="control-card-head">
                        <UserRound size={18} aria-hidden="true" />
                        <strong>{t('Developer upload')}</strong>
                        <span className="status-pill neutral">{developerSubmissionId || 'new submission'}</span>
                      </div>
                      <div className="capability-upload-form">
                        {uploadCopy?.source_hint ? (
                          <p className="capability-upload-hint">{uploadCopy.source_hint}</p>
                        ) : null}
                        <div className="capability-field-grid">
                          <label className="capability-field">
                            <span>{t('Developer id label')}</span>
                            <input
                              aria-label={t('Developer id label')}
                              value={developerDraft.developerId}
                              onChange={(event) => setDeveloperDraft((current) => ({ ...current, developerId: event.target.value }))}
                              placeholder="dev_local"
                            />
                          </label>
                          <div className="capability-field">
                            <span>{t('Capability kind')}</span>
                            <Dropdown
                              variant="field"
                              ariaLabel={t('Capability kind')}
                              value={developerDraft.kind}
                              options={uploadKinds.map((entry) => ({ value: entry.value, label: entry.label }))}
                              onChange={(next) =>
                                setDeveloperDraft((current) => ({
                                  ...current,
                                  kind: next as DeveloperCapabilityKind,
                                  capabilityId: next === 'plugin' ? current.capabilityId : '',
                                }))
                              }
                            />
                          </div>
                          <label className="capability-field">
                            <span>{t('Capability id')}</span>
                            <input
                              aria-label={t('Capability id')}
                              value={developerDraft.capabilityId}
                              onChange={(event) => setDeveloperDraft((current) => ({ ...current, capabilityId: event.target.value }))}
                              placeholder={selectedUploadKind?.id_placeholder ?? 'dev.namespace.plugin'}
                            />
                          </label>
                          <div className="capability-field">
                            <span>{t('Acceptance level label')}</span>
                            <Dropdown
                              variant="field"
                              ariaLabel={t('Acceptance level label')}
                              value={developerDraft.requestedAcceptanceLevel}
                              options={uploadLevels.map((level) => ({ value: level.value, label: level.label }))}
                              onChange={(next) =>
                                setDeveloperDraft((current) => ({ ...current, requestedAcceptanceLevel: next }))
                              }
                            />
                          </div>
                          <label className="capability-field capability-field-wide">
                            <span>{t('Package path on this machine')}</span>
                            <input
                              aria-label={t('Package path on this machine')}
                              value={developerDraft.packagePath}
                              onChange={(event) => setDeveloperDraft((current) => ({ ...current, packagePath: event.target.value }))}
                              placeholder="/path/to/your/capability"
                            />
                          </label>
                          <label className="capability-field">
                            <span>{t('Smoke timeout label')}</span>
                            <input
                              aria-label={t('Smoke timeout label')}
                              value={developerDraft.smokeTimeoutSeconds}
                              onChange={(event) =>
                                setDeveloperDraft((current) => ({ ...current, smokeTimeoutSeconds: event.target.value }))
                              }
                              placeholder="server default"
                            />
                          </label>
                        </div>
                        {selectedUploadKind &&
                        (selectedUploadKind.contents.length > 0 ||
                          selectedUploadKind.summary ||
                          selectedUploadKind.review) ? (
                          <div className="capability-contents-card">
                            <div className="capability-contents-head">
                              <strong>{t('Capability package contents')}</strong>
                              {selectedUploadKind.package_format ? (
                                <span className="capability-contents-format">{selectedUploadKind.package_format}</span>
                              ) : null}
                            </div>
                            {selectedUploadKind.summary ? (
                              <p className="capability-contents-summary">{selectedUploadKind.summary}</p>
                            ) : null}
                            {selectedUploadKind.contents.length ? (
                              <ul className="capability-contents-list">
                                {selectedUploadKind.contents.map((item) => (
                                  <li key={item.path}>
                                    <code>{item.path}</code>
                                    <span className={`capability-contents-badge ${item.required ? 'req' : 'opt'}`}>
                                      {item.required ? t('Capability required') : t('Capability optional')}
                                    </span>
                                    {item.detail ? (
                                      <span className="capability-contents-detail">{item.detail}</span>
                                    ) : null}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                            {selectedUploadKind.review ? (
                              <p className="capability-contents-review">{selectedUploadKind.review}</p>
                            ) : null}
                          </div>
                        ) : null}
                        {uploadCopy?.review_note || uploadCopy?.smoke_note || uploadCopy?.signing_excluded ? (
                          <div className="capability-upload-notes">
                            {uploadCopy?.review_note ? <p>{uploadCopy.review_note}</p> : null}
                            {uploadCopy?.smoke_note ? <p>{uploadCopy.smoke_note}</p> : null}
                            {uploadCopy?.signing_excluded ? <p>{uploadCopy.signing_excluded}</p> : null}
                          </div>
                        ) : null}
                      </div>
                      <div className="button-row">
                        <button
                          className="text-button compact"
                          type="button"
                          onClick={() => void createDeveloperSubmission()}
                          disabled={developerSubmissionBusy !== ''}
                        >
                          {developerSubmissionBusy === 'create' ? t('Creating submission') : t('Create submission')}
                        </button>
                        <button
                          className="text-button compact"
                          type="button"
                          onClick={() =>
                            setDeveloperDraft((current) => ({
                              ...current,
                              kind: 'plugin',
                              capabilityId: selectedRegistryPlugin?.plugin_id ?? current.capabilityId,
                            }))
                          }
                        >
                          {t('Use selected plugin')}
                        </button>
                        <button
                          className="text-button compact"
                          type="button"
                          onClick={() => void uploadDeveloperArtifact()}
                          disabled={developerSubmissionBusy !== '' || !developerSubmissionId}
                        >
                          {developerSubmissionBusy === 'upload' ? t('Uploading package') : t('Upload package')}
                        </button>
                      </div>
                    </article>

                    <article className="control-card">
                      <div className="control-card-head">
                        <FileCheck size={18} aria-hidden="true" />
                        <strong>{t('Developer review')}</strong>
                        <span className={`status-pill ${developerSubmission ? capabilityStatusTone(developerSubmission.capability_status ?? developerSubmission.status) : 'neutral'}`}>
                          {developerSubmission?.status ?? 'pending'}
                        </span>
                      </div>
                      {developerSubmission ? (
                        <>
                          <p>Submission: {developerSubmission.submission_id}</p>
                          <p>Kind: {developerSubmission.kind ?? developerDraft.kind}</p>
                          <p>
                            Capability: {developerSubmission.capability_id ?? developerSubmission.plugin_id ?? developerSubmission.skill_id ?? developerSubmission.company_id ?? 'not set yet'}
                          </p>
                          <p>Version: {developerSubmission.version ?? 'pending artifact upload'}</p>
                          <p>Status: {capabilityStatusLabel(developerSubmission.capability_status ?? developerSubmission.status)}</p>
                          <p>Ready for review: {developerSubmission.ready_for_review ? 'yes' : developerSubmission.artifact_uploaded ? 'uploaded' : 'pending artifact'}</p>
                          <p>Listing review: {developerSubmission.listing_review_level ?? 'pending'}</p>
                          <p>Acceptance: {developerSubmission.acceptance_recommendation ?? developerSubmission.requested_acceptance_level ?? 'pending'}</p>
                          <p>Signing: {developerSubmission.signature_issued ? 'issued' : developerSubmission.ready_for_signing ? 'ready' : 'pending'}</p>
                          <p>Package digest: {shortDigest(developerSubmission.package_digest) ?? 'pending verification'}</p>
                          <p>Artifact digest: {shortDigest(developerSubmission.artifact_blob_digest) ?? 'pending upload'}</p>
                          <p>Signed package: {developerSubmission.signed_package_ref ?? 'not issued'}</p>
                          <p>Gates: {developerGateSummary.passed}/{developerGateSummary.total}</p>
                          <div className="button-row">
                            <button
                              className="text-button compact"
                              type="button"
                              onClick={() => void refreshDeveloperSubmission()}
                              disabled={developerSubmissionBusy !== ''}
                            >
                              <RefreshCw size={16} />
                              {developerSubmissionBusy === 'refresh' ? t('Refreshing review') : t('Refresh review')}
                            </button>
                          </div>
                          {(developerSubmission.gates ?? []).length ? (
                            <div className="review-gate-list">
                              {(developerSubmission.gates ?? []).map((gate) => (
                                <article key={gate.name} className="agent-card">
                                  <div className="control-card-head">
                                    <ShieldCheck size={18} aria-hidden="true" />
                                    <strong>{gate.name}</strong>
                                    <span className={`status-pill ${gate.passed ? 'good' : 'bad'}`}>
                                      {gate.passed ? 'pass' : 'fail'}
                                    </span>
                                  </div>
                                  <p>{gate.detail ?? 'No detail provided.'}</p>
                                </article>
                              ))}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <p>{t('Developer review empty description')}</p>
                      )}
                    </article>
                  </div>
                </section>
              ) : null}

              {pluginStoreTab !== 'skills' && pluginStoreTab !== 'all' ? (
              <section className="plugin-grouped-catalog" aria-label={t('Marketplace catalog')}>
                {pluginCatalogLoading ? (
                  <article className="plugin-catalog-row empty">
                    <span className="plugin-icon-tile">
                      <LoaderCircle size={22} className="spin" aria-hidden="true" />
                    </span>
                    <div className="plugin-catalog-row-copy">
                      <strong>{t('Capability catalog loading')}</strong>
                    </div>
                  </article>
                ) : null}
                {pluginCatalogError ? (
                  <article className="plugin-catalog-conflict-banner" role="alert">
                    <div>
                      <strong>{t('Capability catalog error')}</strong>
                      <p>{pluginCatalogError}</p>
                    </div>
                  </article>
                ) : null}
                {!nodeWorkshopAvailable ? (
                  <article className="plugin-catalog-conflict-banner" role="status">
                    <div>
                      <strong>{t('Node workshop unavailable title')}</strong>
                      <p>{t('Node workshop unavailable body')}</p>
                    </div>
                  </article>
                ) : null}
                {catalogConflicts.length ? (
                  <article className="plugin-catalog-conflict-banner" role="alert">
                    <div>
                      <strong>{catalogContract?.copy?.conflict_banner ?? t('Plugin catalog conflict banner')}</strong>
                      <p>
                        {catalogConflicts
                          .map((conflict) => conflict.plugin_id ?? conflict.id ?? conflict.reason ?? 'catalog conflict')
                          .map(String)
                          .join(', ')}
                      </p>
                    </div>
                    <span className="status-pill warn">{catalogConflicts.length}</span>
                  </article>
                ) : null}
                {groupedPluginCatalogItems.map((group) => (
                  <section className="plugin-catalog-group" key={group.key} aria-labelledby={`plugin-group-${group.key}`}>
                    <header className="plugin-catalog-group-header">
                      <h2 id={`plugin-group-${group.key}`}>{group.label}</h2>
                      <div className="plugin-catalog-group-actions">
                        <span>{group.items.length}</span>
                        {pluginStoreTab === 'plugins' && group.key === 'local' ? (
                          <button
                            className={`plugin-row-icon-button ${pluginLocalInstallOpen ? 'active' : ''}`}
                            type="button"
                            aria-label={t('Toggle local package install')}
                            title={t('Toggle local package install')}
                            onClick={() => setPluginLocalInstallOpen((open) => !open)}
                          >
                            <Download size={17} aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    </header>
                    {renderWorkshopGrid(group.items.map(catalogItemCardModel), {
                      authoringAllowed: true,
                      emptyLabel:
                        pluginStoreTab === 'companies' ? t('Company catalog empty') : t('Installed plugins empty'),
                    })}
                    {pluginStoreTab === 'plugins' && group.key === 'local' && pluginLocalInstallOpen ? (
                      <div className="plugin-local-install-row">
                        <input
                          aria-label="Local plugin package path"
                          value={localPluginPackagePath}
                          onChange={(event) => setLocalPluginPackagePath(event.target.value)}
                          placeholder="/path/to/plugin-or.scplug"
                        />
                        <button
                          className="text-button compact"
                          type="button"
                          onClick={() => void installLocalPlugin(localPluginPackagePath)}
                          disabled={pluginActionBusy === `local:${localPluginPackagePath.trim()}` || !pluginStatus?.verification.public_key_configured}
                        >
                          <Download size={16} />
                          {pluginActionBusy === `local:${localPluginPackagePath.trim()}` ? t('Working') : t('Verify and install local package')}
                        </button>
                      </div>
                    ) : null}
                  </section>
                ))}
                {groupedPluginCatalogItems.length ? null : (
                  <article className="plugin-catalog-row empty">
                    <span className="plugin-icon-tile">
                      <Puzzle size={22} aria-hidden="true" />
                    </span>
                    <div className="plugin-catalog-row-copy">
                      <strong>
                        {pluginStoreTab === 'companies' ? t('Plugin catalog tab companies') : t('No marketplace plugins')}
                      </strong>
                      <p>
                        {pluginStoreTab === 'companies' ? t('Company catalog empty') : t('Plugin grouped list empty')}
                      </p>
                    </div>
                  </article>
                )}
              </section>
              ) : null}
            </div>
            ) : null}

            {!workshopDetail && pluginAdvancedOpen && pluginStoreTab !== 'skills' && pluginStoreTab !== 'all' ? (
            <section id="plugin-operator-section" className="plugin-section plugin-operator-section" aria-labelledby="plugin-operator-heading">
              <header className="plugin-section-header">
                <span className="settings-section-kicker">{t('Advanced plugin operations')}</span>
                <div>
                  <h2 id="plugin-operator-heading">{t('Plugin section operator')}</h2>
                  <p>{t('Plugin section operator description')}</p>
                </div>
              </header>
            <details className="plugin-operations-disclosure">
              <summary>
                <span>{t('Advanced plugin operations')}</span>
                <small>{t('Advanced plugin operations description')}</small>
              </summary>
            <div className="plugin-overview-grid" aria-label="Plugin control plane">
              <article className="control-card">
                <div className="control-card-head">
                  <Layers size={18} aria-hidden="true" />
                  <strong>{t('Cached plugins')}</strong>
                  <span className="status-pill neutral">{pluginStatus?.plugin_count ?? 0}</span>
                </div>
                <p>{t('Cache root')}: {pluginStatus?.cache_root ?? 'unlock with control token'}</p>
                <p>{t('Developer uploads')}: {pluginStatus?.developer_submission_root ?? 'probing'}</p>
                <p>{t('ClawHunt ingestion')}: {pluginStatus?.clawhunt_ingestion_root ?? 'probing'}</p>
                <p>{t('Registry indexed')}: {pluginStatus?.registry.count ?? 'probing'}</p>
              </article>

              <article className="control-card">
                <div className="control-card-head">
                  <Compass size={18} aria-hidden="true" />
                  <strong>{t('Marketplace summary')}</strong>
                  <span className="status-pill neutral">{marketplaceSummary.total}</span>
                </div>
                <p>{t('Verified')}: {marketplaceSummary.verified}</p>
                <p>{t('Entitled')}: {marketplaceSummary.entitled}</p>
                <p>{t('Installed locally')}: {marketplaceSummary.installed}</p>
                <p>{t('Selected plugin')}: {selectedRegistryPlugin?.name ?? 'none'}</p>
              </article>

              <article className="control-card">
                <div className="control-card-head">
                  <ShieldCheck size={18} aria-hidden="true" />
                  <strong>{t('Governance state')}</strong>
                  <span className="status-pill warn">{pluginStatus?.governance.revocation_count ?? 0} revoked</span>
                </div>
                <p>{t('Cloud root')}: {pluginStatus?.cloud_root ?? 'probing'}</p>
                <p>{t('Revocations')}: {pluginStatus?.governance.revocation_count ?? 'probing'}</p>
                <p>{t('Policies')}: {pluginStatus?.governance.policy_count ?? 'probing'}</p>
                <p>{t('Root key')}: {pluginStatus?.verification.public_key_configured ? 'configured' : 'missing'}</p>
                <p>
                  {t('Health')}: {pluginStatus?.registry.error || pluginStatus?.governance.revocation_error || pluginStatus?.governance.policy_error ? 'needs review' : 'clean'}
                </p>
              </article>

              <article className="control-card">
                <div className="control-card-head">
                  <Activity size={18} aria-hidden="true" />
                  <strong>{t('Plugin runtime diagnostics')}</strong>
                  <span
                    className={`status-pill ${
                      pluginDiagnostics?.ok ? 'good' : pluginDiagnostics ? 'warn' : 'neutral'
                    }`}
                  >
                    {pluginDiagnostics?.ok ? 'healthy' : pluginDiagnostics ? 'review' : 'probing'}
                  </span>
                </div>
                <p>{t('Stream')}: {pluginDiagnosticsStreamState}</p>
                <p>{t('Artifacts')}: {pluginDiagnostics?.artifact_count ?? 'probing'}</p>
                <p>
                  {t('Failures / slow calls / sandbox kills')}: {pluginDiagnostics?.summary.failures ?? '0'} /{' '}
                  {pluginDiagnostics?.summary.slow_calls ?? '0'} / {pluginDiagnostics?.summary.sandbox_kills ?? '0'}
                </p>
                <div className="button-row">
                  <button className="text-button compact" onClick={() => void loadPluginDiagnostics()}>
                    <RefreshCw size={16} />
                    {t('Refresh diagnostics')}
                  </button>
                  {pluginDiagnosticsViewer ? (
                    <a className="download-link" href={pluginDiagnosticsViewer.href} download={pluginDiagnosticsViewer.fileName}>
                      {t('Download diagnostics JSON')}
                    </a>
                  ) : null}
                </div>
                <div className="timeline-list" aria-label="Plugin runtime diagnostics">
                  {(pluginDiagnostics?.findings ?? []).length ? (
                    pluginDiagnostics!.findings.slice(0, 5).map((finding, index) => (
                      <article key={`${finding.code}:${finding.plugin_id}:${finding.tool_name}:${index}`} className="timeline-item ready">
                        <div>
                          <strong>{finding.code}</strong>
                          <p>
                            {finding.plugin_id}@{finding.plugin_version} / {finding.tool_name}
                          </p>
                          <p>
                            {finding.duration_ms ? `duration ${finding.duration_ms}ms` : null}
                            {finding.failure_rate !== undefined ? ` failure rate ${finding.failure_rate}` : null}
                            {finding.sandbox_kills !== undefined ? ` sandbox kills ${finding.sandbox_kills}` : null}
                          </p>
                        </div>
                        <span>{finding.severity}</span>
                      </article>
                    ))
                  ) : (
                    <article className="timeline-item complete">
                      <div>
                        <strong>{t('No plugin runtime findings')}</strong>
                        <p>{t('No plugin runtime findings description')}</p>
                      </div>
                      <span>clean</span>
                    </article>
                  )}
                </div>
              </article>

              <article className="control-card">
                <div className="control-card-head">
                  <Compass size={18} aria-hidden="true" />
                  <strong>{t('Registry search')}</strong>
                </div>
                <div className="inline-form">
                  <input
                    aria-label={t('Search plugins')}
                    value={pluginQuery}
                    onChange={(event) => setPluginQuery(event.target.value)}
                    placeholder="search plugin id, summary, runtime"
                  />
                  <button className="text-button compact" onClick={() => void loadPluginControl()}>
                    <RefreshCw size={16} />
                    {t('Refresh plugins')}
                  </button>
                </div>
                <p>{formatAppCopy('Showing registry plugins', { shown: filteredRegistryPlugins.length, total: registryPlugins.length })}</p>
              </article>

              <article className="control-card">
                <div className="control-card-head">
                  <Download size={18} aria-hidden="true" />
                  <strong>{t('Local verified install')}</strong>
                </div>
                <div className="inline-form">
                  <input
                    aria-label="Local plugin package path"
                    value={localPluginPackagePath}
                    onChange={(event) => setLocalPluginPackagePath(event.target.value)}
                    placeholder="/path/to/plugin-or.scplug"
                  />
                  <button
                    className="text-button compact"
                    type="button"
                    onClick={() => void installLocalPlugin(localPluginPackagePath)}
                    disabled={pluginActionBusy === `local:${localPluginPackagePath.trim()}` || !pluginStatus?.verification.public_key_configured}
                  >
                    <Download size={16} />
                    {pluginActionBusy === `local:${localPluginPackagePath.trim()}` ? t('Working') : t('Verify and install local package')}
                  </button>
                </div>
                <p>{t('Local install description')}</p>
                <p>{t('Local install after description')}</p>
              </article>
            </div>

            <div className="plugin-detail-grid" aria-label={t('Plugin marketplace detail')}>
              <article className="control-card">
                <div className="control-card-head">
                  <Puzzle size={18} aria-hidden="true" />
                  <strong>{t('Plugin marketplace detail')}</strong>
                  <span className={`status-pill ${selectedRegistryPlugin?.verified ? 'good' : 'warn'}`}>
                    {selectedRegistryPlugin?.acceptance_level ?? 'none selected'}
                  </span>
                </div>
                {selectedRegistryPlugin ? (
                  <>
                    <p>ID: {selectedRegistryPlugin.plugin_id}</p>
                    <p>{selectedRegistryPlugin.summary}</p>
                    <div className="plugin-meta-row">
                      <span>{selectedRegistryPlugin.runtime}</span>
                      <span>{selectedRegistryPlugin.pricing_model}</span>
                      <span>{selectedRegistryPlugin.entitlement_required ? 'entitled' : 'free'}</span>
                    </div>
                    <p>Compatibility: {Object.entries(selectedRegistryPlugin.compatibility ?? {}).map(([key, value]) => `${key} ${value}`).join(', ') || 'n/a'}</p>
                    <p>Platforms: {(selectedRegistryPlugin.platforms ?? []).join(', ') || 'n/a'}</p>
                    <p>Digest: {selectedRegistryPlugin.package_digest ?? 'n/a'}</p>
                  </>
                ) : (
                  <p>{t('Select registry metadata description')}</p>
                )}
              </article>

              <article className="control-card">
                <div className="control-card-head">
                  <Download size={18} aria-hidden="true" />
                  <strong>{t('Install readiness')}</strong>
                  <span className={`status-pill ${selectedRegistryExactInstalled ? 'good' : selectedRegistryUpdateAvailable ? 'warn' : 'warn'}`}>
                    {selectedRegistryStatusLabel}
                  </span>
                </div>
                {selectedRegistryPlugin ? (
                  <>
                    <p>Root key: {pluginStatus?.verification.public_key_configured ? 'configured' : 'missing'}</p>
                    <p>Local install: {selectedRegistryInstalledVersions.join(', ') || 'not installed locally'}</p>
                    <p>Registry version: {selectedRegistryPlugin.version}</p>
                    <p>Entitlement: {selectedRegistryPlugin.entitlement_required ? 'required before paid use' : 'not required'}</p>
                    <p>Revocation: {selectedRegistryRevocation ? selectedRegistryRevocation.reason : 'clean'}</p>
                    <p>Runtime policy: {selectedRegistryPolicy ? 'attached' : 'none published'}</p>
                    <div className="button-row">
                      <button
                        className="text-button compact"
                        type="button"
                        onClick={() => void installRegistryPlugin(selectedRegistryPlugin.plugin_id, selectedRegistryPlugin.version)}
                        disabled={
                          pluginActionBusy === pluginKey(selectedRegistryPlugin.plugin_id, selectedRegistryPlugin.version) ||
                          selectedRegistryInstallBlockedReason !== null
                        }
                      >
                        <Download size={16} />
                        {selectedRegistryPlugin
                          ? pluginActionBusy === pluginKey(selectedRegistryPlugin.plugin_id, selectedRegistryPlugin.version)
                            ? t('Working')
                            : selectedRegistryExactInstalled
                              ? t('Reinstall selected')
                              : selectedRegistryUpdateAvailable
                                ? t('Update selected')
                                : t('Install selected')
                          : t('Install selected')}
                      </button>
                      {selectedRegistryConfigVersion ? (
                        <button
                          className="text-button compact"
                          type="button"
                          onClick={() => openPluginConfiguration(selectedRegistryPlugin.plugin_id, selectedRegistryConfigVersion)}
                        >
                          {t('Open config')}
                        </button>
                      ) : null}
                      {selectedRegistryInstalledVersion ? (
                        <button
                          className="text-button compact"
                          type="button"
                          onClick={() => void uninstallPlugin(selectedRegistryPlugin.plugin_id, selectedRegistryInstalledVersion)}
                          disabled={pluginActionBusy === pluginKey(selectedRegistryPlugin.plugin_id, selectedRegistryInstalledVersion)}
                        >
                          {t('Uninstall local')}
                        </button>
                      ) : null}
                    </div>
                    <p>{selectedRegistryInstallBlockedReason ?? 'Install gates satisfied.'}</p>
                  </>
                ) : (
                  <p>{t('Select registry install description')}</p>
                )}
              </article>

              <article className="control-card">
                <div className="control-card-head">
                  <ShieldCheck size={18} aria-hidden="true" />
                  <strong>{t('Entitlement readiness')}</strong>
                  <span
                    className={`status-pill ${
                      !selectedRegistryPlugin
                        ? 'neutral'
                        : !selectedRegistryPlugin.entitlement_required
                          ? 'good'
                          : selectedRegistryEntitlement
                            ? 'good'
                            : entitlementSyncState === 'failed'
                              ? 'bad'
                              : entitlementSyncState === 'syncing'
                                ? 'live'
                                : 'warn'
                    }`}
                  >
                    {!selectedRegistryPlugin
                      ? 'none selected'
                      : !selectedRegistryPlugin.entitlement_required
                        ? 'not required'
                        : selectedRegistryEntitlement
                          ? 'synced'
                          : entitlementSyncState === 'syncing'
                            ? 'syncing'
                            : entitlementSyncState === 'failed'
                              ? 'sync failed'
                              : 'required'}
                  </span>
                </div>
                {selectedRegistryPlugin ? (
                  <>
                    <p>Device id: {shortId(entitlementDeviceId)}</p>
                    <p>Runtime version: {runtimeStatus?.service.version ?? 'probing'}</p>
                    <p>Plugin pricing: {selectedRegistryPlugin.pricing_model}</p>
                    <p>Entitlement required: {selectedRegistryPlugin.entitlement_required ? 'yes' : 'no'}</p>
                    <p>Entitlement id: {selectedRegistryEntitlement?.entitlement_id ?? 'not synced'}</p>
                    <p>Expires: {selectedRegistryEntitlement?.expires_at ?? 'not published'}</p>
                    <p>Offline grace: {selectedRegistryEntitlement?.offline_grace_expires_at ?? 'not synced'}</p>
                    <p>Disabled reason: {selectedRegistryEntitlement?.offline_grace_disabled_reason ?? 'none'}</p>
                    <div className="button-row">
                      <button
                        className="text-button compact"
                        type="button"
                        onClick={() => void syncSelectedPluginEntitlement()}
                        disabled={
                          !selectedRegistryPlugin.entitlement_required ||
                          entitlementSyncState === 'syncing' ||
                          !runtimeStatus?.service.version
                        }
                      >
                        <ShieldCheck size={16} />
                        {entitlementSyncState === 'syncing' ? t('Syncing entitlements') : t('Sync entitlements')}
                      </button>
                    </div>
                    <p>
                      {selectedRegistryPlugin.entitlement_required
                        ? selectedRegistryEntitlement
                          ? 'Workshop install is unlocked for this entitled plugin.'
                          : 'Sync entitlement first; workshop install fails closed until a valid device grant is present.'
                        : 'Free plugins do not require entitlement sync.'}
                    </p>
                  </>
                ) : (
                  <p>{t('Select registry entitlement description')}</p>
                )}
              </article>

              <article className="control-card">
                <div className="control-card-head">
                  <RotateCcw size={18} aria-hidden="true" />
                  <strong>{t('Update readiness')}</strong>
                  <span className={`status-pill ${selectedRegistryExactInstalled ? 'good' : selectedRegistryUpdateAvailable ? 'warn' : 'neutral'}`}>
                    {selectedRegistryExactInstalled ? 'up to date' : selectedRegistryUpdateAvailable ? 'update available' : 'no local install'}
                  </span>
                </div>
                {selectedRegistryPlugin ? (
                  <>
                    <p>
                      Installed versions: {selectedRegistryInstalledVersions.join(', ') || 'none'}
                    </p>
                    <p>Selected registry version: {selectedRegistryPlugin.version}</p>
                    <p>
                      Action:
                      {' '}
                      {selectedRegistryExactInstalled
                        ? 'The selected version is already installed locally.'
                        : selectedRegistryUpdateAvailable
                          ? 'A newer registry version is available for this plugin id.'
                          : 'Install the selected version to make it available to local runtimes.'}
                    </p>
                  </>
                ) : (
                  <p>{t('Select registry update description')}</p>
                )}
              </article>

              <article className="control-card">
                <div className="control-card-head">
                  <ShieldCheck size={18} aria-hidden="true" />
                  <strong>{t('Governance detail')}</strong>
                  <span className="status-pill neutral">{selectedRegistryPolicy ? 'policy' : selectedRegistryRevocation ? 'revoked' : 'clean'}</span>
                </div>
                {selectedRegistryPlugin ? (
                  <>
                    <p>Policy plugin: {selectedRegistryPolicy?.plugin_id ?? 'none'}</p>
                    <p>Max output: {selectedRegistryPolicy?.max_model_output_bytes ?? 'n/a'}</p>
                    <p>Max timeout: {selectedRegistryPolicy?.max_tool_timeout_ms ?? 'n/a'}</p>
                    <p>Denied permissions: {(selectedRegistryPolicy?.denylisted_permissions ?? []).join(', ') || 'none'}</p>
                    <p>Revocation digest: {selectedRegistryRevocation?.package_digest ?? 'not revoked'}</p>
                  </>
                ) : (
                  <p>{t('Select registry governance description')}</p>
                )}
              </article>

              <article className="control-card">
                <div className="control-card-head">
                  <ShieldCheck size={18} aria-hidden="true" />
                  <strong>{t('Runtime policy viewer')}</strong>
                  <span className="status-pill neutral">
                    {runtimePolicyViewer ? `${runtimePolicyViewer.count} loaded` : 'probing'}
                  </span>
                </div>
                {runtimePolicyViewer ? (
                  <>
                    <p>Policy source: {pluginStatus?.governance.policy_url ?? '/v1/policies/runtime'}</p>
                    <p>Scope: {runtimePolicyViewer.scope}</p>
                    <p>Selected plugin: {selectedRegistryPlugin ? `${selectedRegistryPlugin.plugin_id}@${selectedRegistryPlugin.version}` : 'none'}</p>
                    <p>Denied permissions: {(selectedRegistryPolicy?.denylisted_permissions ?? []).join(', ') || 'none in selected view'}</p>
                    <p>Minimum runtime: {selectedRegistryPolicy?.minimum_runtime_version ?? 'not set'}</p>
                    <p>Risk level: {selectedRegistryPolicy?.risk_level ?? 'not declared'}</p>
                    <p>Live metering: {selectedRegistryPolicy?.requires_live_metering ? 'required' : 'not required'}</p>
                    <p>
                      Secret descriptors:
                      {' '}
                      {(selectedRegistryPolicy?.secret_descriptors ?? []).map((item) => item.name).join(', ') || 'none declared'}
                    </p>
                    <div className="button-row">
                      <a className="download-link" href={runtimePolicyViewer.href} download={runtimePolicyViewer.fileName}>
                        {t('Download policy JSON')}
                      </a>
                    </div>
                    <div className="artifact-preview-card">
                      <p>{t('Published runtime policy payload')}</p>
                      <pre>{runtimePolicyViewer.preview}</pre>
                    </div>
                  </>
                ) : (
                  <p>{t('Policies loading description')}</p>
                )}
              </article>

              <article className="control-card">
                <div className="control-card-head">
                  <ShieldCheck size={18} aria-hidden="true" />
                  <strong>{t('Revocation sync viewer')}</strong>
                  <span className="status-pill neutral">
                    {revocationViewer ? `${revocationViewer.count} loaded` : 'probing'}
                  </span>
                </div>
                {revocationViewer ? (
                  <>
                    <p>Revocation source: {pluginStatus?.governance.revocations_url ?? '/v1/plugins/revocations'}</p>
                    <p>Scope: {revocationViewer.scope}</p>
                    <p>Selected plugin: {selectedRegistryPlugin ? `${selectedRegistryPlugin.plugin_id}@${selectedRegistryPlugin.version}` : 'none'}</p>
                    <p>Selected reason: {selectedRegistryRevocation?.reason ?? 'not revoked in selected view'}</p>
                    <p>Selected digest: {selectedRegistryRevocation?.package_digest ?? 'not revoked in selected view'}</p>
                    <p>Total synced revocations: {pluginRevocations?.revoked?.length ?? 0}</p>
                    <div className="button-row">
                      <a className="download-link" href={revocationViewer.href} download={revocationViewer.fileName}>
                        {t('Download revocation JSON')}
                      </a>
                    </div>
                    <div className="artifact-preview-card">
                      <p>{t('Published revocation payload')}</p>
                      <pre>{revocationViewer.preview}</pre>
                    </div>
                  </>
                ) : (
                  <p>{t('Revocations loading description')}</p>
                )}
              </article>
            </div>

            <div className="plugin-detail-grid" aria-label="Developer review payload">
              <article className="control-card">
                <div className="control-card-head">
                  <FileCheck size={18} aria-hidden="true" />
                  <strong>{t('Developer review')}</strong>
                  <span className="status-pill neutral">{developerSubmissionId || 'new submission'}</span>
                </div>
                <p>{t('Developer review empty description')}</p>
                <div className="button-row">
                  <button
                    className="text-button compact"
                    type="button"
                    onClick={() => void refreshDeveloperSubmission()}
                    disabled={developerSubmissionBusy !== '' || !developerSubmissionId}
                  >
                    {t('Load review payload')}
                  </button>
                </div>
              </article>
            </div>

            <div className="plugin-list-grid" aria-label="Cached plugins">
              {(pluginStatus?.plugins ?? []).map((plugin) => (
                <article
                  key={`${plugin.id}:${plugin.version}`}
                  className={`agent-card ${selectedPluginKey === pluginKey(plugin.id, plugin.version) ? 'active' : ''}`}
                >
                  <div className="control-card-head">
                    <BadgeCheck size={18} aria-hidden="true" />
                    <strong>{plugin.name}</strong>
                    <span className="status-pill good">{plugin.version}</span>
                  </div>
                  <p>ID: {plugin.id}</p>
                  <p>Path: {plugin.path}</p>
                  <button
                    className="text-button compact"
                    type="button"
                    onClick={() => openPluginConfiguration(plugin.id, plugin.version)}
                  >
                    {t('Manage config')}
                  </button>
                </article>
              ))}
              {pluginStatus?.plugins?.length ? null : (
                <article className="agent-card">
                  <div className="control-card-head">
                    <Layers size={18} aria-hidden="true" />
                    <strong>{t('Cached plugins')}</strong>
                  </div>
                  <p>Waiting for `/api/plugins/status`.</p>
                </article>
              )}
            </div>

            <div className="plugin-list-grid" aria-label="Registry plugins">
              {filteredRegistryPlugins.map((plugin) => (
                <article
                  key={`${plugin.plugin_id}:${plugin.version}`}
                  className={`agent-card ${selectedRegistryPluginKey === pluginKey(plugin.plugin_id, plugin.version) ? 'active' : ''}`}
                >
                  <div className="control-card-head">
                    <Puzzle size={18} aria-hidden="true" />
                    <strong>{plugin.name}</strong>
                    <span className={`status-pill ${plugin.verified ? 'good' : 'warn'}`}>{plugin.acceptance_level}</span>
                  </div>
                  <p>ID: {plugin.plugin_id}</p>
                  <p>{plugin.summary}</p>
                  <div className="plugin-meta-row">
                    <span>{plugin.runtime ?? 'n/a'}</span>
                    <span>{plugin.pricing_model ?? plugin.entitlement_state ?? 'free'}</span>
                    <span>{plugin.entitlement_required ? 'entitled' : 'free'}</span>
                  </div>
                  <p>Platforms: {(plugin.platforms ?? []).join(', ') || 'n/a'}</p>
                  <div className="button-row">
                    <button
                      className="text-button compact"
                      type="button"
                      onClick={() => setSelectedRegistryPluginKey(pluginKey(plugin.plugin_id, plugin.version))}
                    >
                      {t('Inspect')}
                    </button>
                    <button
                      className="text-button compact"
                      type="button"
                      onClick={() => void installRegistryPlugin(plugin.plugin_id, plugin.version)}
                      disabled={
                        pluginActionBusy === pluginKey(plugin.plugin_id, plugin.version) ||
                        !pluginStatus?.verification.public_key_configured
                      }
                    >
                      <Download size={16} />
                      {pluginActionBusy === pluginKey(plugin.plugin_id, plugin.version)
                        ? t('Working')
                        : installedPluginKeys.has(pluginKey(plugin.plugin_id, plugin.version))
                          ? t('Reinstall')
                          : (installedPluginVersionsById.get(plugin.plugin_id) ?? []).length
                            ? t('Update')
                            : t('Install')}
                    </button>
                    {installedPluginKeys.has(pluginKey(plugin.plugin_id, plugin.version)) ? (
                      <button
                        className="text-button compact"
                        type="button"
                        onClick={() => openPluginConfiguration(plugin.plugin_id, plugin.version)}
                      >
                        {t('Open config')}
                      </button>
                    ) : null}
                  </div>
                </article>
              ))}
              {filteredRegistryPlugins.length ? null : (
                <article className="agent-card">
                  <div className="control-card-head">
                    <Compass size={18} aria-hidden="true" />
                    <strong>{t('Registry plugins')}</strong>
                  </div>
                  <p>{t('Registry plugins empty description')}</p>
                </article>
              )}
            </div>
            </details>
            </section>
            ) : null}

            <DialogShell
              open={pluginConfigModalOpen}
              variant="full"
              titleId="plugin-config-modal-title"
              title={pluginConfiguration?.name ?? selectedInstalledPlugin?.name ?? t('Plugin configuration')}
              subtitle={
                pluginConfiguration
                  ? `${pluginConfiguration.plugin_id}@${pluginConfiguration.version}`
                  : selectedPluginKey || t('Plugin configuration empty description')
              }
              kicker={<span className="settings-section-kicker">{t('Installed plugins')}</span>}
              closeLabel="Close plugin configuration"
              onClose={() => setPluginConfigModalOpen(false)}
              dismissable
            >

            {(() => {
              const cfg = pluginConfiguration;
              if (!cfg) {
                return (
                  <div className="plugin-config-modal-body">
                    <p className="muted-copy">{t('Plugin configuration empty description')}</p>
                  </div>
                );
              }
              const isPaySwitch = cfg.plugin_id === 'dev.clawhunt.pay-switch-agent';

              // ---- shared control renderers (reused by both tiers) ----
              const renderSettingControl = (setting: PluginSettingDescriptor) => {
                const draft = pluginSettingDrafts[setting.name] ?? '';
                const options = Array.isArray(setting.validation?.enum) ? setting.validation.enum : [];
                const control = setting.ui?.control;
                if (setting.options_source?.tool) {
                  const dyn = pluginDynamicOptions[setting.name] ?? [];
                  const busy = pluginConfigBusy === `options:${setting.name}`;
                  const draftValue = settingDraftText(draft);
                  const selected = dyn.find((option) => String(option.value) === draftValue) ?? null;
                  const onPick = (value: string) => {
                    const picked = dyn.find((option) => String(option.value) === value) ?? null;
                    setPluginSettingDrafts((current) => {
                      const next = { ...current, [setting.name]: value };
                      if (picked?.user_data_dir) next.chrome_user_data_dir = picked.user_data_dir;
                      return next;
                    });
                  };
                  const optionText = (option: PluginDynamicOption) => {
                    if (option.name && option.email) return `${option.name} — ${option.email}`;
                    return option.label || String(option.value);
                  };
                  return (
                    <div className="plugin-setting-dynamic">
                      <Dropdown
                        variant="field"
                        ariaLabel={`Plugin setting ${setting.name}`}
                        value={busy ? '' : draftValue}
                        disabled={busy}
                        options={[
                          // 原生 select 的空占位项：保留它才能把已选 profile 清回空值
                          {
                            value: '',
                            label: busy
                              ? 'loading profiles…'
                              : dyn.length
                                ? `Select ${setting.options_source.label || 'an option'}…`
                                : 'No Chrome profiles found — open Chrome, then ↻',
                          },
                          ...(draftValue && !selected
                            ? [{ value: draftValue, label: `${draftValue} (saved)` }]
                            : []),
                          ...dyn.map((option) => ({
                            value: String(option.value),
                            label: optionText(option),
                          })),
                        ]}
                        onChange={onPick}
                      />
                      <button
                        className="text-button compact"
                        type="button"
                        disabled={busy}
                        onClick={() => void loadPluginSettingOptions(cfg.plugin_id, cfg.version, setting.name, { force: true })}
                      >
                        {busy ? '…' : dyn.length ? `↻ ${dyn.length} profiles` : '↻ refresh'}
                      </button>
                      {busy ? (
                        <p className="muted-copy" role="status">
                          正在实时扫描本地 Chrome profile…(首次约需几秒)
                        </p>
                      ) : pluginOptionsError[setting.name] ? (
                        <p className="muted-copy" role="alert" style={{ color: 'var(--danger, #ef4444)' }}>
                          扫描失败:{pluginOptionsError[setting.name]} — 点 ↻ refresh 重试
                        </p>
                      ) : selected ? (
                        <p className="muted-copy">
                          {[selected.name, selected.email].filter(Boolean).join(' — ') || String(selected.value)}
                          {selected.user_data_dir ? ` · ${selected.user_data_dir}` : ''}
                        </p>
                      ) : null}
                    </div>
                  );
                }
                if ((control === 'select' || options.length > 0) && options.length > 0) {
                  return (
                    <Dropdown
                      variant="field"
                      ariaLabel={`Plugin setting ${setting.name}`}
                      value={settingDraftText(draft)}
                      options={options.map((option) => ({
                        value: String(option),
                        label: String(option),
                      }))}
                      onChange={(next) =>
                        setPluginSettingDrafts((current) => ({ ...current, [setting.name]: next }))
                      }
                    />
                  );
                }
                if (control === 'switch' || setting.type === 'boolean') {
                  return (
                    <label className="plugin-setting-toggle">
                      <input
                        aria-label={`Plugin setting ${setting.name}`}
                        type="checkbox"
                        checked={settingDraftBoolean(draft)}
                        onChange={(event) => setPluginSettingDrafts((current) => ({ ...current, [setting.name]: event.target.checked }))}
                      />
                      <span>{settingDraftBoolean(draft) ? 'enabled' : 'disabled'}</span>
                    </label>
                  );
                }
                if (control === 'textarea') {
                  return (
                    <textarea
                      aria-label={`Plugin setting ${setting.name}`}
                      value={settingDraftText(draft)}
                      onChange={(event) => setPluginSettingDrafts((current) => ({ ...current, [setting.name]: event.target.value }))}
                      placeholder={pluginSettingPlaceholder(setting)}
                      minLength={setting.validation?.minLength}
                      maxLength={setting.validation?.maxLength}
                    />
                  );
                }
                const numeric = control === 'number' || setting.type === 'integer' || setting.type === 'number';
                return (
                  <input
                    aria-label={`Plugin setting ${setting.name}`}
                    type={numeric ? 'number' : control === 'url' ? 'url' : 'text'}
                    value={settingDraftText(draft)}
                    onChange={(event) => setPluginSettingDrafts((current) => ({ ...current, [setting.name]: event.target.value }))}
                    placeholder={pluginSettingPlaceholder(setting)}
                    min={setting.validation?.minimum}
                    max={setting.validation?.maximum}
                    step={setting.validation?.step ?? (setting.type === 'integer' ? 1 : undefined)}
                    minLength={numeric ? undefined : setting.validation?.minLength}
                    maxLength={numeric ? undefined : setting.validation?.maxLength}
                    pattern={numeric ? undefined : setting.validation?.pattern}
                  />
                );
              };

              const renderRelayPanel = (setting: PluginSettingDescriptor) => {
                const statusResult = pluginConfigActionResults[pluginConfigActionResultKey(setting.name, 'extension_status')];
                const installResult = pluginConfigActionResults[pluginConfigActionResultKey(setting.name, 'extension_install')];
                const relayStatus = statusResult?.browser_extension;
                const install = installResult?.install;
                const heartbeatTime = paySwitchHeartbeatTime(relayStatus);
                const heartbeat = relayStatus?.last_heartbeat ?? null;
                const heartbeatPayload = heartbeat?.payload ?? {};
                const version = relayStatus?.version || heartbeatPayload.version || '';
                const manifestVersion = relayStatus?.manifest_version || heartbeatPayload.manifest_version || '';
                return (
                  <div className="payswitch-relay-panel" aria-label="PaySwitch Browser Relay status">
                    <div className="payswitch-relay-panel__head">
                      <span className={`status-pill ${paySwitchExtensionStatusClass(relayStatus)}`}>
                        {paySwitchExtensionStatusLabel(relayStatus)}
                      </span>
                      {heartbeat?.extension_id ? <code>{heartbeat.extension_id}</code> : null}
                    </div>
                    <p className="muted-copy">
                      {[relayStatus?.relay_base_url || relayStatus?.url, heartbeatTime ? `heartbeat ${heartbeatTime}` : '', version ? `v${version}` : '', manifestVersion ? `MV${manifestVersion}` : '']
                        .filter(Boolean)
                        .join(' · ') || 'Waiting for PaySwitch Browser Relay heartbeat.'}
                    </p>
                    {relayStatus?.error ? <p className="muted-copy" role="alert">{relayStatus.error}</p> : null}
                    {install ? (
                      <div className="payswitch-relay-install">
                        {install.extension_dir ? (
                          <p className="muted-copy">
                            Extension dir: <code>{install.extension_dir}</code>
                          </p>
                        ) : null}
                        <p className="muted-copy">
                          {[install.load_url, install.relay_base_url, install.relay_token_present ? 'relay token ready in PaySwitch' : '']
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                        {(install.instructions ?? []).slice(0, 4).map((item) => (
                          <p className="muted-copy" key={item}>{item}</p>
                        ))}
                        {install.error ? <p className="muted-copy" role="alert">{install.error}</p> : null}
                      </div>
                    ) : null}
                  </div>
                );
              };

              const renderSettingActions = (setting: PluginSettingDescriptor, opts?: { includeSave?: boolean }) => {
                const includeSave = opts?.includeSave !== false;
                return (
                  <>
                    {includeSave ? (
                      <button
                        className="text-button compact"
                        type="button"
                        onClick={() => void savePluginSetting(cfg.plugin_id, cfg.version, setting.name)}
                      >
                        {t('Save setting')}
                      </button>
                    ) : null}
                    {(setting.actions ?? []).map((action) => {
                      const actionKey = action.id ?? action.tool;
                      const busy = pluginConfigBusy === `action:${setting.name}:${action.id ?? ''}`;
                      return (
                        <button
                          key={`${setting.name}:action:${actionKey}`}
                          className="text-button compact"
                          type="button"
                          disabled={busy}
                          onClick={() => void runPluginConfigAction(cfg.plugin_id, cfg.version, setting.name, action.id, action.label || actionKey)}
                        >
                          {busy ? '…' : action.label || actionKey}
                        </button>
                      );
                    })}
                  </>
                );
              };

              const renderSettingCard = (setting: PluginSettingDescriptor) => (
                <article key={setting.name} className="control-card">
                  <div className="control-card-head">
                    <PenTool size={18} aria-hidden="true" />
                    <strong>{setting.name}</strong>
                    <span className="control-card-head-pills">
                      <span className={`status-pill ${setting.configured ? 'good' : setting.required ? 'warn' : 'neutral'}`}>
                        {setting.configured ? 'configured' : setting.required ? 'required' : 'default'}
                      </span>
                    </span>
                  </div>
                  <p>{setting.description || 'No description provided.'}</p>
                  {renderSettingControl(setting)}
                  {setting.ui?.help ? <p className="muted-copy">{setting.ui.help}</p> : null}
                  <div className="plugin-setting-actions">{renderSettingActions(setting)}</div>
                </article>
              );

              const renderSecretInput = (secret: PluginSecretDescriptor) => (
                <>
                  <input
                    aria-label={`Plugin secret ${secret.name}`}
                    type="password"
                    value={pluginSecretDrafts[secret.name] ?? ''}
                    onChange={(event) => setPluginSecretDrafts((current) => ({ ...current, [secret.name]: event.target.value }))}
                    placeholder={secret.configured ? 'rotate secret value' : 'secret value'}
                  />
                  <div className="button-row">
                    <button className="text-button compact" type="button" onClick={() => void savePluginSecret(cfg.plugin_id, cfg.version, secret.name)}>
                      {t('Save secret')}
                    </button>
                    <button className="text-button compact" type="button" onClick={() => void clearPluginSecret(cfg.plugin_id, cfg.version, secret.name)}>
                      {t('Clear secret')}
                    </button>
                  </div>
                </>
              );

              const renderSecretControl = (secret: PluginSecretDescriptor) => {
                if (!secret.auto_provisioned) return renderSecretInput(secret);
                // Auto-provisioned: the kernel supplies this from login state. Show
                // status + fold the manual override away so it never reads as a
                // required field. A locally-saved override (secret.configured) is
                // honored over the auto value, so surface that too.
                const loginOk = secret.provisioning_status === 'available';
                const provider = secret.provisioning_provider || 'ClawHunt';
                return (
                  <div className="plugin-secret-autoprovision">
                    <div className="plugin-secret-autoprovision__status">
                      <span className={`status-pill ${loginOk ? 'good' : 'warn'}`}>
                        {loginOk ? t('Login available') : t('Login required')}
                      </span>
                      <span className="muted-copy">{provider}</span>
                    </div>
                    <p className="muted-copy">{t('Auto provisioned hint')}</p>
                    <details className="plugin-secret-override">
                      <summary>{t('Manual override (optional)')}</summary>
                      {renderSecretInput(secret)}
                    </details>
                  </div>
                );
              };

              const renderSecretCard = (secret: PluginSecretDescriptor) => (
                <article key={secret.name} className="control-card">
                  <div className="control-card-head">
                    <KeyRound size={18} aria-hidden="true" />
                    <strong>{secret.name}</strong>
                    <span
                      className={`status-pill ${
                        secret.auto_provisioned ? 'neutral' : secret.configured ? 'good' : 'warn'
                      }`}
                    >
                      {secret.auto_provisioned
                        ? t('Auto-provisioned')
                        : secret.configured
                          ? 'configured'
                          : secret.required
                            ? 'required'
                            : 'optional'}
                    </span>
                  </div>
                  <p>{secret.description || `Injected as ${secret.env_name}.`}</p>
                  {renderSecretControl(secret)}
                </article>
              );

              // ---- classify exposed config into the two-tier contract ----
              const allSettings = cfg.configuration.settings;
              const allSecrets = cfg.configuration.secrets;
              const advancedSettings = allSettings.filter((s) => isAdvancedConfigItem(s.ui));
              const advancedSecrets = allSecrets.filter((s) => isAdvancedConfigItem(s.ui));
              const basicSettings = allSettings.filter((s) => !isAdvancedConfigItem(s.ui));
              const basicSecrets = allSecrets.filter((s) => !isAdvancedConfigItem(s.ui));

              // ---- build ordered step blocks (one required operation per step) ----
              const blocks: Array<{ key: string; order: number; title: string; description?: string; done: boolean; body: ReactNode }> = [];
              basicSettings.forEach((setting, idx) => {
                if (isPaySwitch && setting.name === 'chrome_profile_directory') {
                  const baseStep = setting.ui?.step ?? 1000 + idx;
                  blocks.push({
                    key: 'ps-profile',
                    order: baseStep,
                    title: setting.ui?.step_title || setting.ui?.label || setting.name,
                    description: setting.ui?.step_description || setting.description || undefined,
                    done: setting.configured,
                    body: (
                      <>
                        {renderSettingControl(setting)}
                        <div className="plugin-setting-actions">{renderSettingActions(setting, { includeSave: true })}</div>
                      </>
                    ),
                  });
                  const relayStatus = pluginConfigActionResults[pluginConfigActionResultKey(setting.name, 'extension_status')]?.browser_extension;
                  blocks.push({
                    key: 'ps-relay',
                    order: baseStep + 0.5,
                    title: '安装并验证 Browser Relay',
                    description:
                      '在所选 profile 中安装 PaySwitch Browser Relay 扩展，并确认心跳（heartbeat）正常。这是 Pay-Switch 驱动本地真实支付的前提。',
                    done: Boolean(relayStatus?.connected),
                    body: (
                      <>
                        {renderRelayPanel(setting)}
                        <div className="plugin-setting-actions">{renderSettingActions(setting, { includeSave: false })}</div>
                      </>
                    ),
                  });
                  return;
                }
                blocks.push({
                  key: setting.name,
                  // Explicit steps first; unnumbered basic items fall in after them
                  // in declaration order (matches the protocol doc §4a).
                  order: setting.ui?.step ?? 1000 + idx,
                  title: setting.ui?.step_title || setting.ui?.label || setting.name,
                  description: setting.ui?.step_description || setting.description || undefined,
                  done: setting.configured,
                  body: (
                    <>
                      {renderSettingControl(setting)}
                      {setting.ui?.help ? <p className="muted-copy">{setting.ui.help}</p> : null}
                      <div className="plugin-setting-actions">{renderSettingActions(setting)}</div>
                    </>
                  ),
                });
              });
              basicSecrets.forEach((secret, idx) => {
                blocks.push({
                  key: `secret:${secret.name}`,
                  order: secret.ui?.step ?? 2000 + idx,
                  title: secret.ui?.step_title || secret.ui?.label || secret.name,
                  description: secret.ui?.step_description || secret.description || undefined,
                  done: secret.configured,
                  body: renderSecretControl(secret),
                });
              });
              blocks.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));

              const totalSteps = blocks.length;
              const doneSteps = blocks.filter((b) => b.done).length;
              // Ready = every basic step done AND no required item (any tier) left
              // unconfigured. The contract forbids required+advanced, but guard
              // anyway so the banner can never claim ready with a mandatory gap.
              const requiredUnmet = [...allSettings, ...allSecrets].filter((item) => item.required && !item.configured);
              const ready = (totalSteps === 0 || doneSteps === totalSteps) && requiredUnmet.length === 0;

              return (
                <div className="plugin-config-modal-body">
                  <section className="plugin-config-basic" aria-label={t('Basic configuration')}>
                    <header className="plugin-config-section-head">
                      <div>
                        <span className="settings-section-kicker">{t('Basic configuration')}</span>
                        <p>{t('Basic configuration description')}</p>
                      </div>
                      <div className={`plugin-config-readiness ${ready ? 'ready' : ''}`} role="status">
                        {ready ? (
                          <>
                            <BadgeCheck size={16} aria-hidden="true" />
                            <span>{t('Plugin ready')}</span>
                          </>
                        ) : (
                          <>
                            <span className="plugin-config-readiness__count">{doneSteps}/{totalSteps}</span>
                            <span>{t('Complete required steps')}</span>
                          </>
                        )}
                      </div>
                    </header>

                    {totalSteps > 0 ? (
                      <ol className="plugin-config-steps">
                        {blocks.map((block, index) => (
                          <li key={block.key} className={`plugin-config-step ${block.done ? 'done' : ''}`}>
                            <div className="plugin-config-step__index" aria-hidden="true">
                              {block.done ? <Check size={16} /> : index + 1}
                            </div>
                            <div className="plugin-config-step__body">
                              <div className="plugin-config-step__head">
                                <h3>{block.title}</h3>
                                {block.done ? <span className="status-pill good">{t('Done')}</span> : null}
                              </div>
                              {block.description ? <p className="muted-copy">{block.description}</p> : null}
                              {block.body}
                            </div>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="muted-copy">{t('No basic configuration required')}</p>
                    )}
                  </section>

                  <details className="plugin-config-advanced plugin-operations-disclosure">
                    <summary>
                      <span>{t('Advanced settings')}</span>
                      <small>{t('Advanced settings description')}</small>
                    </summary>
                    <div className="plugin-config-advanced__grid">
                      {advancedSettings.map(renderSettingCard)}
                      {advancedSecrets.map(renderSecretCard)}

                      <article className="control-card">
                        <div className="control-card-head">
                          <KeyRound size={18} aria-hidden="true" />
                          <strong>{t('Plugin configuration')}</strong>
                          <span className="status-pill neutral">{cfg.plugin_id}@{cfg.version}</span>
                        </div>
                        <p>Runtime: {String(cfg.runtime.type ?? 'unknown')}</p>
                        <p>Local package: {cfg.plugin_id}@{cfg.version}</p>
                        <p>
                          Settings: {cfg.configuration.settings.filter((item) => item.configured).length}/
                          {cfg.configuration.settings.length}
                        </p>
                        <p>
                          Secrets: {cfg.configuration.secrets.filter((item) => item.configured).length}/
                          {cfg.configuration.secrets.length}
                        </p>
                        <div className="button-row">
                          <button
                            className="text-button compact"
                            type="button"
                            onClick={() => void uninstallPlugin(cfg.plugin_id, cfg.version)}
                            disabled={pluginActionBusy === pluginKey(cfg.plugin_id, cfg.version)}
                          >
                            {pluginActionBusy === pluginKey(cfg.plugin_id, cfg.version) ? 'Working' : t('Uninstall plugin')}
                          </button>
                        </div>
                      </article>

                      <article className="control-card">
                        <div className="control-card-head">
                          <KeyRound size={18} aria-hidden="true" />
                          <strong>{t('Secret and config manager')}</strong>
                          <span className="status-pill neutral">
                            {configurationManagerViewer
                              ? `${configurationManagerViewer.missingSettings.length + configurationManagerViewer.missingSecrets.length} missing`
                              : 'no plugin selected'}
                          </span>
                        </div>
                        {configurationManagerViewer ? (
                          <>
                            <p>Configuration source: {pluginStatus?.configuration.status_url ?? '/api/plugins/{plugin_id}/configuration'}</p>
                            <p>Selected plugin: {cfg.plugin_id}@{cfg.version}</p>
                            <p>Missing settings: {configurationManagerViewer.missingSettings.join(', ') || 'none'}</p>
                            <p>Missing secrets: {configurationManagerViewer.missingSecrets.join(', ') || 'none'}</p>
                            <p>{t('Renderer safety description')}</p>
                            <div className="button-row">
                              <a className="download-link" href={configurationManagerViewer.href} download={configurationManagerViewer.fileName}>
                                {t('Download config status JSON')}
                              </a>
                            </div>
                            <div className="artifact-preview-card">
                              <p>{t('Sanitized configuration status')}</p>
                              <pre>{configurationManagerViewer.preview}</pre>
                            </div>
                          </>
                        ) : (
                          <p>{t('Secret manager empty description')}</p>
                        )}
                      </article>
                    </div>
                  </details>
                </div>
              );
            })()}
            </DialogShell>

            {(pluginRevocations?.revoked?.length || 0) + (pluginPolicies?.policies?.length || 0) ? (
            <div className="plugin-governance-grid" aria-label={t('Plugin governance')}>
              {(pluginRevocations?.revoked ?? []).map((item) => (
                <article key={`${item.plugin_id}:${item.version ?? 'any'}`} className="control-card">
                  <div className="control-card-head">
                    <ShieldCheck size={18} aria-hidden="true" />
                    <strong>{item.plugin_id}</strong>
                    <span className="status-pill bad">{item.reason}</span>
                  </div>
                  <p>Version: {item.version ?? 'all'}</p>
                  <p>Digest: {item.package_digest ?? 'not provided'}</p>
                </article>
              ))}
              {(pluginPolicies?.policies ?? []).map((item, index) => (
                <article key={`${item.plugin_id ?? 'global'}:${item.version ?? 'any'}:${index}`} className="control-card">
                  <div className="control-card-head">
                    <Server size={18} aria-hidden="true" />
                    <strong>{item.plugin_id ?? 'global policy'}</strong>
                    <span className="status-pill neutral">{item.version ?? 'any version'}</span>
                  </div>
                  <p>Max output: {item.max_model_output_bytes ?? 'n/a'}</p>
                  <p>Max timeout: {item.max_tool_timeout_ms ?? 'n/a'}</p>
                  <p>Denied permissions: {(item.denylisted_permissions ?? []).join(', ') || 'none'}</p>
                </article>
              ))}
            </div>
            ) : null}
          </>
        ) : null}
      </section>
      ) : null}

      {workspaceSurface === 'team' ? (
      <section className="workspace-page team-page" aria-label={locale === 'zh' ? 'Agent 公司' : 'Agent companies'}>
        <div className="workspace-topbar">
          {/* 纯画布 shell: the canvas launcher (folded from the workbench rail) is now the
              surface-level nav here too — jump to chat / canvas / plugins / settings — so
              the old "Main" home crumb is dropped. The outer rail is hidden on this surface
              (.workspace-team .rail); the board keeps its OWN drill-down breadcrumb below,
              which the launcher does not cover. */}
          {canvasLauncher}
          <nav className="workspace-topbar-trail" aria-label={locale === 'zh' ? '公司导航' : 'Company navigation'}>
            {/* "Companies" is always a link back to the directory — never marked
                aria-current, so non-company board routes (the directory itself,
                onboarding, any global/auth page) don't falsely claim to be the
                "Companies" page. The only terminal/current crumb is the company name,
                shown when inside a company. */}
            <button type="button" className="workspace-trail-link" onClick={() => goToCompanyList()}>
              {locale === 'zh' ? '公司列表' : 'Companies'}
            </button>
            {boardNav.inCompany && boardNav.companyName ? (
              <>
                <span className="workspace-trail-sep" aria-hidden="true">›</span>
                <span className="workspace-trail-current" aria-current="page">{boardNav.companyName}</span>
              </>
            ) : null}
          </nav>
        </div>
        {/* company = reuse Paperclip backend, supplement frontend UI: the company
            board UI (server/ui) is compiled into apps/web and mounted natively here
            (no iframe; see CompanyBoard). The board owns its own header/nav and
            readiness, so super's redundant workspace-header is intentionally gone —
            only the unified topbar trail remains so the board can own the full panel. */}
        <CompanyBoard
          locale={locale}
          theme={activeTheme}
          onOpenCapabilityStore={() => {
            // The embedded board's plugin page "Get Plugins" entry delegates to
            // super's Capability Workshop, landed on its plugins tab.
            setPluginStoreTab('plugins');
            void openMarketplaceSurface();
          }}
        />
      </section>
      ) : null}

      {workspaceSurface === 'canvas' ? (
        <LocaleProvider locale={locale}>
        <section
          className="workspace-page canvas-page"
          aria-label={locale === 'zh' ? '画布' : 'Canvas'}
          style={{ display: 'flex', flexDirection: 'column' }}
        >
          <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
            <CanvasSurface runtimeReadJson={nodeCanvasMode ? canvasRuntimeReader : readJson} onCreateCompany={() => setWorkspaceSurface('team')}
              onOpenSettings={() => openSettingsSurface('settings-runtime')}
              accountControl={<><button type="button" className="awwo-icon-button"
                aria-label={locale === 'zh' ? 'Switch to English' : '切换为中文'}
                title={locale === 'zh' ? 'Switch to English' : '切换为中文'}
                onClick={() => switchLocale(locale === 'zh' ? 'en' : 'zh')}>
                <span aria-hidden="true">{locale === 'zh' ? 'EN' : '中'}</span>
              </button><button type="button" className="awwo-icon-button"
                aria-label={locale === 'zh'
                  ? (activeTheme === 'dark' ? '切换浅色主题' : '切换深色主题')
                  : (activeTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme')}
                onClick={() => switchThemePreference(activeTheme === 'dark' ? 'light' : 'dark')}>
                {activeTheme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
              </button><div className="canvas-auth-chip">
              <CanvasAccountControl locale={locale} identity={clawHuntSsoIdentity}
                onLogin={() => { if (!clawHuntBrowserLoginBusy) void startClawHuntAccountShortcutLogin(); }}
                onLogout={() => void logoutClawHunt()}
                onOpenWorkspaceAuth={() => setWorkspaceSurface('team')} />
            </div></>}
            />
          </div>
        </section>
        </LocaleProvider>
      ) : null}

      {imageLightbox ? (
        <div
          className="image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={imageLightbox.name}
          onClick={() => setImageLightbox(null)}
        >
          <button
            type="button"
            className="image-lightbox-close"
            aria-label={copy.closePreview}
            title={copy.closePreview}
            onClick={() => setImageLightbox(null)}
          >
            <X size={20} aria-hidden="true" />
          </button>
          <img
            src={imageLightbox.src}
            alt={imageLightbox.name}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => {
              event.stopPropagation();
              openImageContextMenu(event, {
                src: imageLightbox.src,
                name: imageLightbox.name,
                mime: imageLightbox.mime,
                path: imageLightbox.path,
              });
            }}
          />
          {imageLightbox.name ? <span className="image-lightbox-caption">{imageLightbox.name}</span> : null}
        </div>
      ) : null}

      {imageContextMenu ? (
        <div
          ref={imageContextMenuRef}
          className="sidebar-context-menu image-context-menu"
          role="menu"
          aria-label={imageContextMenu.name || copy.copyImage}
          style={{ left: imageContextMenu.x, top: imageContextMenu.y }}
        >
          <button type="button" role="menuitem" onClick={() => void copyImageFromMenu(imageContextMenu)}>
            <Copy size={15} aria-hidden="true" />
            <span>{copy.copyImage}</span>
          </button>
          {/* Reveal in the OS file manager — desktop only, and only when the image
              has a real file to select (a local_path attachment, or base64 bytes we
              can materialize). A pure remote URL has neither, so the item hides. */}
          {canRevealImage({ desktopMode, path: imageContextMenu.path, src: imageContextMenu.src }) ? (
            <button type="button" role="menuitem" onClick={() => void revealImageInFinder(imageContextMenu)}>
              <FolderOpen size={15} aria-hidden="true" />
              <span>{copy.revealInFinder}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      <OnboardingTour open={tourOpen} locale={locale} onClose={handleTourClose} />
    </main>
  );
}
