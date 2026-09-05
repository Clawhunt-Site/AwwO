import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';

// The company surface mounts the real Paperclip board (CompanyBoard), which pulls
// in the whole server/ui React app (react-router, react-query, the live Paperclip
// API). That is verified end-to-end in the browser, not here; for the app-shell
// unit tests we stub it so opening the Team tab stays light and deterministic.
vi.mock('../src/CompanyBoard', () => ({
  CompanyBoard: () => React.createElement('div', { 'data-testid': 'company-board' }),
}));

import {
  App,
  StreamingAssistantMarkdown,
  computeInitialSidebarCollapsed,
  formatRelativeTaskAge,
  formatCompletedAgo,
  formatElapsedDuration,
  safeMarkdownExternalHref,
} from '../src/App';
import { getUiZoom, initUiZoom, resetUiZoom } from '../src/zoom';
import { CLAWHUNT_SSO_STORAGE_KEY } from '../src/clawhuntSso';

describe('computeInitialSidebarCollapsed (纯画布 shell)', () => {
  // Regression guard (Codex review): the sidebar's initial collapsed state must depend ONLY on
  // the user's explicit stored preference, NEVER on the landing surface. Collapsing on a canvas
  // landing is (a) invisible there — the canvas surfaces hide the rail entirely — and (b) bleeds
  // a collapsed rail into chat, where `.sidebar-collapsed .sidebar-recents{display:none}` hides
  // the session list, breaking "chat keeps its rail AND recents".
  it('collapses only when the stored preference is exactly "1"', () => {
    expect(computeInitialSidebarCollapsed('1')).toBe(true);
    expect(computeInitialSidebarCollapsed('0')).toBe(false);
    expect(computeInitialSidebarCollapsed(null)).toBe(false); // first run: expanded, recents visible
    expect(computeInitialSidebarCollapsed('')).toBe(false);
    expect(computeInitialSidebarCollapsed('true')).toBe(false);
  });
});

describe('safeMarkdownExternalHref', () => {
  it('allows http, https and mailto links', () => {
    expect(safeMarkdownExternalHref('https://example.com/path')).toBe('https://example.com/path');
    expect(safeMarkdownExternalHref('http://example.com')).toBe('http://example.com');
    expect(safeMarkdownExternalHref('mailto:user@example.com')).toBe('mailto:user@example.com');
  });

  it('blocks dangerous and non-navigable protocols', () => {
    expect(safeMarkdownExternalHref('javascript:alert(1)')).toBeNull();
    expect(safeMarkdownExternalHref('  javascript:alert(1)')).toBeNull();
    expect(safeMarkdownExternalHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeMarkdownExternalHref('file:///etc/passwd')).toBeNull();
  });

  it('ignores empty, hash and unparsable hrefs', () => {
    expect(safeMarkdownExternalHref(null)).toBeNull();
    expect(safeMarkdownExternalHref('')).toBeNull();
    expect(safeMarkdownExternalHref('#section')).toBeNull();
  });
});

describe('formatRelativeTaskAge', () => {
  const now = Date.parse('2026-06-09T12:00:00Z');

  it('formats recent tasks with minutes and hours', () => {
    expect(formatRelativeTaskAge(now - 42 * 60_000, now, 'en')).toBe('42m');
    expect(formatRelativeTaskAge(now - (2 * 60 + 7) * 60_000, now, 'en')).toBe('2h');
    expect(formatRelativeTaskAge(now - (2 * 60 + 7) * 60_000, now, 'zh')).toBe('2小时');
  });

  it('formats older tasks by day', () => {
    expect(formatRelativeTaskAge(now - 3 * 24 * 60 * 60_000, now, 'en')).toBe('3d');
    expect(formatRelativeTaskAge(now - 3 * 24 * 60 * 60_000, now, 'zh')).toBe('3天');
  });
});

describe('formatCompletedAgo', () => {
  const now = Date.parse('2026-06-09T12:00:00Z');

  it('renders a full localized "completed X ago" phrase down to seconds', () => {
    expect(formatCompletedAgo(now - 3_000, now, 'en')).toBe('completed just now');
    expect(formatCompletedAgo(now - 3_000, now, 'zh')).toBe('刚刚完成');
    expect(formatCompletedAgo(now - 30_000, now, 'en')).toBe('completed 30 seconds ago');
    expect(formatCompletedAgo(now - 16 * 60_000, now, 'en')).toBe('completed 16 minutes ago');
    expect(formatCompletedAgo(now - 16 * 60_000, now, 'zh')).toBe('完成于 16 分钟前');
    expect(formatCompletedAgo(now - 60_000, now, 'en')).toBe('completed 1 minute ago');
    expect(formatCompletedAgo(now - 2 * 3_600_000, now, 'zh')).toBe('完成于 2 小时前');
    expect(formatCompletedAgo(now - 3 * 24 * 3_600_000, now, 'en')).toBe('completed 3 days ago');
  });

  it('fails closed for an invalid timestamp', () => {
    expect(formatCompletedAgo(0, now, 'en')).toBe('completed at unknown time');
    expect(formatCompletedAgo(0, now, 'zh')).toBe('完成时间未知');
  });
});

describe('formatElapsedDuration', () => {
  it('renders localized sub-minute and minute durations', () => {
    expect(formatElapsedDuration(12_300, 'en')).toBe('took 12s');
    expect(formatElapsedDuration(8_400, 'en')).toBe('took 8.4s');
    expect(formatElapsedDuration(8_400, 'zh')).toBe('用时 8.4 秒');
    expect(formatElapsedDuration(95_000, 'en')).toBe('took 1m 35s');
    expect(formatElapsedDuration(95_000, 'zh')).toBe('用时 1 分 35 秒');
  });

  it('never carries seconds to :60 at the minute boundary', () => {
    // 119.6s must not render "1m 60s"; it rounds to 2m 0s (derived from a single
    // rounded total-seconds value).
    expect(formatElapsedDuration(119_600, 'en')).toBe('took 2m 0s');
    // a sub-minute value that rounds up to 60 promotes to "1m 0s", never "60s".
    expect(formatElapsedDuration(59_600, 'en')).toBe('took 1m 0s');
    expect(formatElapsedDuration(59_600, 'zh')).toBe('用时 1 分 0 秒');
  });

  it('returns empty for a non-positive duration', () => {
    expect(formatElapsedDuration(0, 'en')).toBe('');
    expect(formatElapsedDuration(-5, 'zh')).toBe('');
  });
});

describe('ui zoom shortcuts', () => {
  beforeEach(() => {
    localStorage.clear();
    resetUiZoom();
  });

  it('steps zoom with cmd +/- , persists it, and resets with cmd 0', () => {
    const dispose = initUiZoom();
    try {
      fireEvent.keyDown(window, { key: '=', metaKey: true });
      expect(getUiZoom()).toBeCloseTo(1.1);
      expect(localStorage.getItem('superclaw.uiZoom')).toBe('1.1');

      fireEvent.keyDown(window, { key: '=', metaKey: true });
      expect(getUiZoom()).toBeCloseTo(1.25);

      fireEvent.keyDown(window, { key: '-', metaKey: true });
      expect(getUiZoom()).toBeCloseTo(1.1);

      fireEvent.keyDown(window, { key: '0', metaKey: true });
      expect(getUiZoom()).toBe(1);
      expect(localStorage.getItem('superclaw.uiZoom')).toBeNull();
    } finally {
      dispose();
    }
  });

  it('supports ctrl as the modifier and ignores unmodified keys', () => {
    const dispose = initUiZoom();
    try {
      fireEvent.keyDown(window, { key: '=' });
      expect(getUiZoom()).toBe(1);

      fireEvent.keyDown(window, { key: '-', ctrlKey: true });
      expect(getUiZoom()).toBeCloseTo(0.9);
    } finally {
      dispose();
    }
  });

  it('routes zoom through the native webview when running inside Tauri', () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    const dispose = initUiZoom();
    try {
      fireEvent.keyDown(window, { key: '=', metaKey: true });
      expect(invoke).toHaveBeenCalledWith('desktop_set_webview_zoom', { request: { factor: 1.1 } });
      expect(document.documentElement.style.getPropertyValue('zoom')).toBe('');
      expect(localStorage.getItem('superclaw.uiZoom')).toBe('1.1');
    } finally {
      dispose();
      delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
    }
  });

  it('restores the persisted zoom level on init and clamps invalid values', () => {
    localStorage.setItem('superclaw.uiZoom', '1.5');
    let dispose = initUiZoom();
    expect(getUiZoom()).toBe(1.5);
    dispose();

    localStorage.setItem('superclaw.uiZoom', '99');
    dispose = initUiZoom();
    expect(getUiZoom()).toBe(2);
    dispose();
  });
});

class MockEventSource {
  static instances: MockEventSource[] = [];

  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  close = vi.fn();
  addEventListener = vi.fn((type: string, handler: (event: MessageEvent) => void) => {
    const current = this.listeners.get(type) ?? [];
    current.push(handler);
    this.listeners.set(type, current);
  });
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  emit(type: string, payload: Record<string, unknown>) {
    const handlers = this.listeners.get(type) ?? [];
    const event = { data: JSON.stringify(payload) } as MessageEvent;
    for (const handler of handlers) handler(event);
  }
}

function requestPath(input: string | URL | Request) {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return new URL(raw, 'http://127.0.0.1').pathname;
}

// Build a Response-like object that streams SSE frames the way the desktop
// `/api/chat/stream` endpoint does, so tests exercise the real streaming path
// (`response.body.getReader()`) regardless of the JS environment's Response.body
// support.
function sseStreamResponse(frames: Array<[string, unknown]>) {
  const text = frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })),
        releaseLock: () => {},
        cancel: async () => {},
      }),
    },
  } as unknown as Response;
}

async function openSettingsWorkspace() {
  fireEvent.click(await screen.findByRole('button', { name: 'Open account menu' }));
  expect(await screen.findByLabelText('Account menu')).toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: 'Open settings workspace' }));
  expect(await screen.findByRole('heading', { name: 'Preferences' })).toBeInTheDocument();
  expect(await screen.findByLabelText('Settings navigation')).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Back to app' })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Diagnostics' })).toBeInTheDocument();
  // Secrets is a parked surface: end users don't manage agent-team credentials
  // in the shipped app, so the tab must stay out of the settings navigation
  // (kernel/CLI keep the capability — see SecretsSettings.tsx).
  expect(screen.queryByRole('button', { name: 'Secrets' })).not.toBeInTheDocument();
  expect(document.querySelector('.settings-fullscreen-page')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'MCP servers' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Profile' })).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
}

async function openContextPanel() {
  fireEvent.click(await screen.findByRole('button', { name: /^Panel/ }));
  expect(await screen.findByLabelText('Task plan')).toBeInTheDocument();
}

describe('App shell', () => {
  let latestRunStatus = 'queued';
  let latestGoalRequest: Record<string, unknown> | null = null;
  let latestRunRequest: Record<string, unknown> | null = null;
  let latestChatTurnRequest: Record<string, unknown> | null = null;
  let latestClawHuntAccountLoginRequest: Record<string, unknown> | null = null;
  let latestClawHuntBrowserLoginProvider: string | null = null;
  let latestClawHuntAgentKeyCreateRequest: Record<string, unknown> | null = null;
  let openedClawHuntLoginUrl = '';
  let latestMediaRequest: Record<string, unknown> | null = null;
  let githubScannerEntitled = false;
  let requestTokens: string[] = [];
  let additionalRuns: Array<Record<string, unknown>> = [];
  let additionalChatSessions: Array<Record<string, unknown>> = [];
  let workspacesInventory: Array<Record<string, unknown>> = [];
  let runsOverride: Array<Record<string, unknown>> | null = null;
  let runtimeActiveRunIds: string[] = [];
  let runtimeRecentRunId: string | null = null;
  let chatStreamFramesOverride: Array<[string, unknown]> | null = null;
  // When true, the Paperclip company API (/paperclip-api/companies) responds 500,
  // forcing apps/web's dual-source bridge to fall back to the Python /api/team/*.
  let paperclipUnreachable = false;
  // When true the kernel runtime status reports Node EXPLICITLY not enabled (pure-Python
  // deployment), the only state in which a failed Node-native create may fall back to the
  // Python kernel path.
  let nodeRuntimeDisabled = false;
  // Fusion surfacing: per-test overrides for the imported-surfaces status and
  // the docker run-status endpoint (default null -> mock's baseline response).
  let fusionStatusOverride: Record<string, unknown> | null = null;
  let fusionRunStatusOverride: Record<string, unknown> | null = null;
  // PR-C: when true the mock move endpoint returns 409 unless the request
  // acknowledges the boundary change (drives the warning-dialog test).
  let moveBoundaryConflict = false;
  // When true the mock POST /api/workspaces returns a 422 name-collision (the
  // kernel rejects a name whose ~/SuperClaw/<name> folder already exists) — drives
  // the create-project dialog's inline-error test.
  let workspaceCreateConflict = false;
  // PR-C: session ids the mock archive endpoint has flipped to archived; the
  // chat/sessions list honors include_archived against this set so a test can
  // prove an archived session disappears from the default view.
  let archivedSessionIds = new Set<string>();
  // Sidebar pin: session/workspace ids the mock pin endpoints have flipped on;
  // the list/inventory responses stamp pinned_at for them so the optimistic flip
  // survives the post-pin refetch (mirrors the kernel reflecting pinned state).
  let pinnedSessionIds = new Set<string>();
  let pinnedWorkspaceIds = new Set<string>();
  // PR-C: when true the mock chat/sessions LIST returns 500 — used to prove the
  // optimistic local archive removal survives a failed post-archive refetch.
  let failChatListReload = false;
  // When non-null the mock chat/sessions LIST awaits this promise before
  // responding — used to hold a refresh open and prove ordering (e.g. the
  // post-create project pin must land BEFORE the awaited refresh resolves).
  let deferChatListReload: Promise<void> | null = null;
  // When non-null the mock POST /api/workspaces awaits this before responding —
  // holds a create in flight so a test can assert the form is locked (disabled)
  // during busy, proving the stale-error race is impossible.
  let deferWorkspaceCreate: Promise<void> | null = null;
  // PR-C: when true the archive endpoint flips failChatListReload on, so the
  // post-archive refetch fails (exercises the optimistic-removal robustness).
  let failNextListAfterArchive = false;
  // When true the move endpoint flips failChatListReload on, so the post-move
  // refetch fails (exercises the optimistic local-binding update robustness).
  let failNextListAfterMove = false;

  beforeEach(() => {
    MockEventSource.instances = [];
    localStorage.clear();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.spyOn(window, 'open').mockImplementation(() => null);
    localStorage.setItem('superclaw_control_token', 'control-secret');
    // The product now lands on the Fleet Canvas (纯画布 shell); these app-shell tests exercise
    // the chat workbench, so pin the landing surface to 'chat' for them.
    localStorage.setItem('superclaw_landing_surface', 'chat');
    let helloWorldInstalled = true;
    let githubScannerInstalled = false;
    let paySwitchInstalled = false;
    githubScannerEntitled = false;
    requestTokens = [];
    additionalRuns = [];
    additionalChatSessions = [];
    workspacesInventory = [];
    moveBoundaryConflict = false;
    workspaceCreateConflict = false;
    archivedSessionIds = new Set<string>();
    pinnedSessionIds = new Set<string>();
    pinnedWorkspaceIds = new Set<string>();
    failChatListReload = false;
    deferChatListReload = null;
    deferWorkspaceCreate = null;
    failNextListAfterArchive = false;
    failNextListAfterMove = false;
    runsOverride = null;
    runtimeActiveRunIds = [];
    runtimeRecentRunId = null;
    chatStreamFramesOverride = null;
    paperclipUnreachable = false;
    nodeRuntimeDisabled = false;
    fusionStatusOverride = null;
    fusionRunStatusOverride = null;
    let githubScannerSetting = 'ClawHunt-Store';
    let githubScannerSettingConfigured = false;
    let githubScannerSecretConfigured = false;
    let mediaArtifactAttached = false;
    latestGoalRequest = null;
    latestRunRequest = null;
    latestChatTurnRequest = null;
    latestClawHuntAccountLoginRequest = null;
    latestClawHuntBrowserLoginProvider = null;
    latestClawHuntAgentKeyCreateRequest = null;
    openedClawHuntLoginUrl = '';
    let clawHuntAccountSet = false;
    let clawHuntAccountUser: Record<string, unknown> | null = null;
    let clawHuntAgentKeySet = true;
    let clawHuntAgentKeySource: string | null = 'manual';
    let clawHuntAgentKeyName: string | null = 'Manual agent key';
    const clawHuntAuthPayload = () => ({
      clawhunt: {
        account: clawHuntAccountSet ? 'set' : 'unset',
        agent_api_key: clawHuntAgentKeySet ? 'set' : 'unset',
        base_url: 'https://clawhunt.store',
        account_user: clawHuntAccountUser,
        agent_key_source: clawHuntAgentKeySource,
        agent_key_name: clawHuntAgentKeyName,
        account_source: clawHuntAccountSet ? 'clawhunt_google_browser' : null,
        login_source: clawHuntAccountSet ? 'superclaw' : null,
        browser_login_start_url: '/api/auth/clawhunt/browser/start',
        account_login_url: '/api/auth/clawhunt/account/login',
        account_login_probe_url: '/api/auth/clawhunt/account/login-probe',
        account_profile_url: '/api/auth/clawhunt/account/me',
        account_agents_url: '/api/auth/clawhunt/account/agents',
        agent_key_create_url: '/api/auth/clawhunt/agent-key',
        profile_url: '/api/auth/clawhunt/me',
        login_url: '/api/auth/clawhunt/login',
        logout_url: '/api/auth/clawhunt/logout',
      },
    });
    latestMediaRequest = null;
    let developerSubmissionRecord: Record<string, unknown> = {
      schema_version: '0.1.0',
      submission_id: 'plugsub_demo',
      kind: 'plugin',
      status: 'draft',
      capability_status: 'pending_review',
      developer_id: 'dev_local',
      capability_id: 'dev.superclaw.hello-world',
      plugin_id: 'dev.superclaw.hello-world',
      requested_acceptance_level: 'L1',
      artifact_uploaded: false,
      ready_for_review: false,
      out_of_scope: ['production_developer_upload_api'],
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = requestPath(input);
      const headers = new Headers(init?.headers);
      const token = headers.get('X-SuperClaw-Token');
      if (token) requestTokens.push(token);

      if (path === '/api/pay-switch/status') {
        return new Response(JSON.stringify({ mode: 'governed_optional' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/appearance') {
        // Minimal valid payload. A SUCCESS response here makes this suite a regression
        // guard against the appearance fetch effect looping: if it re-fetched on every
        // render (the old [apiReady, readJson] dep bug), this would be hit unbounded.
        return new Response(
          JSON.stringify({
            schema_version: '0.1.0',
            canvases: ['light', 'dark'],
            default_preset: 'default',
            custom_preset_id: 'custom',
            tokens: [{ id: 'accent', label: 'Accent', css_var: '--accent', group: 'accent' }],
            presets: [{ id: 'default', label: 'Default', description: '', swatch: '#4f5fd6', overrides: { light: {}, dark: {} } }],
            active_preset: 'default',
            custom: { light: {}, dark: {} },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/backends') {
        return new Response(JSON.stringify({ backends: [{ name: 'codex', available: true, version: '0.133.0' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/harnesses') {
        return new Response(
          JSON.stringify({
            harnesses: {
              codex: {
                harness_id: 'codex',
                display_name: 'Codex',
                parallel_agents: true,
                tool_allowlist_per_agent: true,
                skill_body_max_bytes: 32768,
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/evals') {
        return new Response(JSON.stringify({ evals: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/fusion/status') {
        return new Response(
          JSON.stringify(
            fusionStatusOverride ?? {
              schema_version: '1',
              capability_summary: { capability_count: 3, gated_capability_count: 1 },
              network_policy: { active_probe_default: 'governed_optional' },
              profiles: { default: ['osiris'] },
              components: {},
            },
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/fusion/run-status') {
        if (fusionRunStatusOverride === null) {
          return new Response(JSON.stringify({ detail: 'forced run-status failure' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(fusionRunStatusOverride), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/media/status') {
        return new Response(
          JSON.stringify({
            schema_version: '0.1.0',
            provider: 'runninghub',
            configured: true,
            configured_key_count: 3,
            key_rotation: 'round_robin',
            base_url: 'https://www.runninghub.ai',
            artifact_root: '.superclaw/artifacts/media',
            secret_policy: 'API keys are read from process environment only.',
            templates: [
              {
                id: 'text_to_image',
                label: 'RunningHub text to image',
                webapp_id: '2004543847939751938',
                mode: 'standard-api',
                api_detail_id: '2004543847939751938',
                endpoint_path: '/rhart-image-n-pro/text-to-image',
                docs_url: 'https://www.runninghub.ai/call-api/api-detail/2004543847939751938',
                output_kind: 'image',
                required_inputs: ['prompt'],
                default_inputs_configured: ['aspectRatio', 'resolution'],
                input_map_configured: [],
                default_nodes_configured: false,
                field_map_configured: [],
              },
              {
                id: 'text_to_video',
                label: 'RunningHub text to video',
                webapp_id: '2012065966164602881',
                mode: 'standard-api',
                api_detail_id: '2012065966164602881',
                endpoint_path: '/rhart-video-s-official/text-to-video-pro',
                docs_url: 'https://www.runninghub.ai/call-api/api-detail/2012065966164602881',
                output_kind: 'video',
                required_inputs: ['prompt'],
                default_inputs_configured: ['duration', 'size'],
                input_map_configured: [],
                default_nodes_configured: false,
                field_map_configured: [],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/media/templates') {
        return new Response(
          JSON.stringify({
            schema_version: '0.1.0',
            provider: 'runninghub',
            base_url: 'https://www.runninghub.ai',
            templates: [],
            node_contract: {},
            endpoints: { submit: '/api/media/generate', status: '/api/media/status', templates: '/api/media/templates' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/media/doctor') {
        return new Response(
          JSON.stringify({
            schema_version: '0.1.0',
            provider: 'runninghub',
            ok: true,
            live_metadata: true,
            configured_key_count: 3,
            ready_for_live_generation: true,
            summary: { check_count: 3, passed: 3, failed: 0, warnings: 0 },
            checks: [
              { name: 'api_keys.configured', passed: true, severity: 'error', detail: 'keys configured' },
              { name: 'template.text_to_image.standard_api_contract', passed: true, severity: 'error', detail: 'template ready' },
              { name: 'live_sku.text_to_image', passed: true, severity: 'error', detail: 'SKU endpoint ready' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/media/generate' || path === '/api/media/render') {
        latestMediaRequest = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        mediaArtifactAttached = Boolean(latestMediaRequest.run_id);
        if (path === '/api/media/render') {
          return new Response(
            JSON.stringify({
              status: 'outputs_ready',
              task_id: 'task_render_demo',
              evidence_attached: mediaArtifactAttached,
              artifact_count: 3,
              output_urls: ['https://cdn.runninghub.ai/render-demo.png'],
              artifacts: [
                {
                  step: 'generate',
                  attempt: 1,
                  artifact_id: 'runninghub_media_render_generate',
                  run_artifact_url: mediaArtifactAttached
                    ? '/api/runs/run_demo/artifacts/runninghub_media_render_generate'
                    : undefined,
                },
                {
                  step: 'status',
                  attempt: 1,
                  artifact_id: 'runninghub_media_render_status',
                  run_artifact_url: mediaArtifactAttached
                    ? '/api/runs/run_demo/artifacts/runninghub_media_render_status'
                    : undefined,
                },
                {
                  step: 'outputs',
                  attempt: 1,
                  artifact_id: 'runninghub_media_render_outputs',
                  run_artifact_url: mediaArtifactAttached
                    ? '/api/runs/run_demo/artifacts/runninghub_media_render_outputs'
                    : undefined,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            artifact_id: 'runninghub_media_demo',
            artifact_url: '/api/media/artifacts/runninghub_media_demo',
            run_artifact_url: mediaArtifactAttached ? '/api/runs/run_demo/artifacts/runninghub_media_demo' : undefined,
            evidence_attached: mediaArtifactAttached,
            task_id: 'dry_run_task_demo',
            dry_run: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/media/task-status' || path === '/api/media/outputs') {
        const mediaTaskRequest = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        mediaArtifactAttached = Boolean(mediaTaskRequest.run_id);
        return new Response(
          JSON.stringify({
            artifact_id: path.endsWith('/outputs') ? 'runninghub_media_outputs' : 'runninghub_media_status',
            run_artifact_url: mediaArtifactAttached
              ? `/api/runs/run_demo/artifacts/${path.endsWith('/outputs') ? 'runninghub_media_outputs' : 'runninghub_media_status'}`
              : undefined,
            evidence_attached: mediaArtifactAttached,
            task_id: mediaTaskRequest.task_id,
            query: path.endsWith('/outputs') ? 'outputs' : 'status',
            output_urls: path.endsWith('/outputs') ? ['https://cdn.runninghub.ai/demo.png'] : [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/runtime/status') {
        return new Response(
          JSON.stringify({
            runtime_version: '0.1.0',
            backend: 'codex',
            mode: 'auto',
            service: {
              name: 'superclaw',
              version: '0.1.0',
              pid: 4242,
              bind: '127.0.0.1',
              control_token: 'set',
              uptime_seconds: 12,
              control_token_required: true,
            },
            state: { path: '.superclaw/state.db', active_run_ids: runtimeActiveRunIds, recent_run_id: runtimeRecentRunId },
            ...(nodeRuntimeDisabled ? { node: { enabled: false, ready: false, url: null, port: null } } : {}),
            agents: { count: 1, ready_count: 1, status_url: '/api/agents' },
            plugins: { plugin_count: 1, status_url: '/api/plugins/status' },
            config: { path: '.superclaw/shell-config.toml', status_url: '/api/config' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/runtime/control-token/rotate') {
        return new Response(
          JSON.stringify({
            ok: true,
            control_token: 'rotated-secret',
            rotated_at: 1780001000.0,
            service: { control_token: 'set' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/desktop/onboarding') {
        return new Response(
          JSON.stringify({
            workspace_root: '/Users/leongong/Documents/superClaw',
            quickstart_path: 'docs/desktop-beta-quickstart.md',
            status_url: '/api/desktop/onboarding',
            summary: { ready: false, ready_count: 2, total_count: 6 },
            checks: [
              {
                title: 'Runtime service',
                ready: true,
                detail: '0.1.0 / backend codex / mode auto',
                remediation: 'The local ClawHunt runtime is already serving the control-plane APIs.',
              },
              {
                title: 'Desktop toolchain',
                ready: false,
                detail: 'Needs setup: Tauri CLI.',
                remediation:
                  'Run `npm install --prefix apps/desktop` so the local @tauri-apps/cli binary exists before `npm run tauri:build`.',
              },
              {
                title: 'Dependency doctor',
                ready: false,
                detail: 'Needs setup: Hermes, Claude Code, OpenClaw.',
                remediation: 'Install Hermes CLI or set SUPERCLAW_HERMES_EXECUTABLE to the local hermes binary.',
              },
              {
                title: 'Beta acceptance',
                ready: true,
                detail: 'Acceptance passed at 2026-06-04T12:00:00Z.',
                remediation:
                  'Run `npm --prefix apps/desktop run test:beta-acceptance` and review `/Users/leongong/Documents/superClaw/.superclaw/desktop/desktop-beta-acceptance.json`.',
              },
              {
                title: 'ClawHunt login',
                ready: false,
                detail: 'No ClawHunt agent key is configured yet.',
                remediation: 'Sign in with a ClawHunt account, then create or paste an agent key before browsing or submitting market work.',
              },
              {
                title: 'Plugin trust root',
                ready: false,
                detail: 'Registry signature root is not configured yet.',
                remediation: 'Configure the plugin public key before relying on marketplace installs.',
              },
            ],
            dependency_targets: [
              {
                name: 'codex',
                label: 'Codex',
                installed: true,
                detail: '/opt/homebrew/bin/codex',
                remediation: 'Ready for desktop use.',
              },
              {
                name: 'hermes',
                label: 'Hermes',
                installed: false,
                detail: 'hermes executable not found',
                remediation: 'Install Hermes CLI or set SUPERCLAW_HERMES_EXECUTABLE to the local hermes binary.',
              },
              {
                name: 'claude',
                label: 'Claude Code',
                installed: false,
                detail: 'claude executable not found',
                remediation: 'Install Claude Code or set SUPERCLAW_CLAUDE_EXECUTABLE to the local claude binary.',
              },
              {
                name: 'openclaw',
                label: 'OpenClaw',
                installed: false,
                detail: 'openclaw executable not found',
                remediation: 'Install OpenClaw or set SUPERCLAW_OPENCLAW_EXECUTABLE to the local openclaw binary.',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/desktop/toolchain') {
        return new Response(
          JSON.stringify({
            workspace_root: '/Users/leongong/Documents/superClaw',
            desktop_root: '/Users/leongong/Documents/superClaw/apps/desktop',
            source_workspace: true,
            tools: [
              { name: 'python3', label: 'Python 3', available: true, detail: 'Python 3.12.8', remediation: 'Install Python 3.11+.' },
              { name: 'node', label: 'Node.js', available: true, detail: 'v22.0.0', remediation: 'Install Node.js.' },
              { name: 'npm', label: 'npm', available: true, detail: '10.0.0', remediation: 'Install npm.' },
              { name: 'cargo', label: 'Cargo', available: true, detail: 'cargo 1.80.0', remediation: 'Install Cargo.' },
              {
                name: 'tauri',
                label: 'Tauri CLI',
                available: false,
                detail: 'apps/desktop/node_modules/.bin/tauri is missing',
                remediation: 'Run `npm install --prefix apps/desktop` so the local @tauri-apps/cli binary exists before `npm run tauri:build`.',
              },
            ],
            summary: { required_count: 5, ready_count: 4, source_build_ready: false },
            status_url: '/api/desktop/toolchain',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/desktop/acceptance') {
        return new Response(
          JSON.stringify({
            workspace_root: '/Users/leongong/Documents/superClaw',
            desktop_root: '/Users/leongong/Documents/superClaw/apps/desktop',
            source_workspace: true,
            report_path: '/Users/leongong/Documents/superClaw/.superclaw/desktop/desktop-beta-acceptance.json',
            status_url: '/api/desktop/acceptance',
            generate_command: 'npm --prefix apps/desktop run test:beta-acceptance',
            quickstart_path: 'docs/desktop-beta-quickstart.md',
            exists: true,
            summary: {
              ready: true,
              success: true,
              failed_step: null,
              generated_at: '2026-06-04T12:00:00Z',
              completed_steps: 6,
              total_steps: 6,
            },
            report: {
              generated_at: '2026-06-04T12:00:00Z',
              success: true,
              failed_step: null,
              steps: [
                {
                  name: 'config',
                  command: 'npm run test:config --prefix apps/desktop',
                  ok: true,
                  code: 0,
                  signal: null,
                  started_at: '2026-06-04T12:00:00Z',
                  duration_ms: 1200,
                  stdout_tail: ['ok'],
                  stderr_tail: [],
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/tui/acceptance') {
        return new Response(
          JSON.stringify({
            workspace_root: '/Users/leongong/Documents/superClaw',
            report_path: '/Users/leongong/Documents/superClaw/.superclaw/tui/tui-acceptance.json',
            status_url: '/api/tui/acceptance',
            generate_command: 'PYTHONPATH=packages/superclaw/src .venv/bin/python -m superclaw.cli tui-acceptance',
            exists: true,
            summary: {
              ready: true,
              success: true,
              failed_step: null,
              generated_at: '2026-06-04T12:05:00Z',
              completed_steps: 4,
              total_steps: 4,
            },
            report: {
              generated_at: '2026-06-04T12:05:00Z',
              success: true,
              failed_step: null,
              steps: [
                {
                  name: 'pytest',
                  command: 'python -m pytest tests/test_tui.py',
                  ok: true,
                  code: 0,
                  signal: null,
                  started_at: '2026-06-04T12:05:00Z',
                  duration_ms: 1800,
                  stdout_tail: ['ok'],
                  stderr_tail: [],
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
	      if (path === '/api/runs') {
	        if (init?.method === 'POST') {
	          latestRunRequest = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
	          return new Response(JSON.stringify({ run_id: 'run_demo', status: 'queued' }), {
	            status: 200,
	            headers: { 'Content-Type': 'application/json' },
	          });
	        }
	        return new Response(JSON.stringify({ runs: runsOverride ?? [{ goal_id: 'goal_demo', run_id: 'run_demo', chat_session_id: 'session_demo', status: latestRunStatus, dry_run: true, task_graph: { goal_id: 'goal_demo', tasks: [] } }, ...additionalRuns] }), {
	          status: 200,
	          headers: { 'Content-Type': 'application/json' },
	        });
	      }
      if (path === '/api/chat/stream') {
        latestChatTurnRequest = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (latestChatTurnRequest.mode === 'delivery') {
          return sseStreamResponse([
            [
              'delivery',
              {
                intent: 'delivery',
                session_id: 'session_demo',
                run_id: 'run_demo',
                status: 'queued',
                chain_verdict: 'CONTROL_PLANE_READY',
                events_url: '/api/runs/run_demo/events',
              },
            ],
          ]);
        }
        if (chatStreamFramesOverride) return sseStreamResponse(chatStreamFramesOverride);
        return sseStreamResponse([
          ['chat.started', { intent: 'chat', session_id: 'session_demo', backend: 'codex' }],
          ['message.delta', { text: 'Direct answer from Codex desktop mode.' }],
          ['message.completed', { text: 'Direct answer from Codex desktop mode.' }],
          [
            'chat.completed',
            {
              intent: 'chat',
              session_id: 'session_demo',
              backend: 'codex',
              status: 'completed',
              response: 'Direct answer from Codex desktop mode.',
            },
          ],
        ]);
      }
      if (path === '/api/workspaces' && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (deferWorkspaceCreate) await deferWorkspaceCreate;
        if (workspaceCreateConflict) {
          return new Response(
            JSON.stringify({
              detail: `a directory named '${String(body.name)}' already exists under /Users/leongong/SuperClaw; rename the project, or use 'attach existing directory' (requires trust)`,
            }),
            { status: 422, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            workspace_id: 'workspace_new',
            name: body.name,
            kind: body.attach_repo ? 'repo' : 'managed',
            trust_status: 'active',
            is_trusted: true,
            repo_path: (body.attach_repo as string) ?? '',
            builtin_chat: false,
            session_count: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const archiveMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)\/archive$/);
      if (archiveMatch) {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (body.archived === false) archivedSessionIds.delete(archiveMatch[1]);
        else archivedSessionIds.add(archiveMatch[1]);
        if (failNextListAfterArchive) failChatListReload = true;
        return new Response(JSON.stringify({ session_id: archiveMatch[1] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const pinSessionMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)\/pin$/);
      if (pinSessionMatch) {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (body.pinned === false) pinnedSessionIds.delete(pinSessionMatch[1]);
        else pinnedSessionIds.add(pinSessionMatch[1]);
        return new Response(JSON.stringify({ session_id: pinSessionMatch[1] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const pinWorkspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)\/pin$/);
      if (pinWorkspaceMatch) {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (body.pinned === false) pinnedWorkspaceIds.delete(pinWorkspaceMatch[1]);
        else pinnedWorkspaceIds.add(pinWorkspaceMatch[1]);
        return new Response(JSON.stringify({ workspace_id: pinWorkspaceMatch[1], pinned: body.pinned !== false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const workspaceIdMatch = path.match(/^\/api\/workspaces\/([^/]+)$/);
      if (workspaceIdMatch && (init?.method ?? 'GET').toUpperCase() === 'PATCH') {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        const next = workspacesInventory.find((w) => w.workspace_id === workspaceIdMatch[1]);
        if (next) next.name = body.name;
        return new Response(JSON.stringify({ workspace_id: workspaceIdMatch[1], name: body.name }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (workspaceIdMatch && (init?.method ?? 'GET').toUpperCase() === 'DELETE') {
        workspacesInventory = workspacesInventory.filter((w) => w.workspace_id !== workspaceIdMatch[1]);
        return new Response(JSON.stringify({ workspace_id: workspaceIdMatch[1], removed: true, archived_sessions: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const moveMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)\/move$/);
      if (moveMatch) {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (moveBoundaryConflict && body.acknowledge_boundary_change !== true) {
          return new Response(JSON.stringify({ detail: 'boundary change requires acknowledgement' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (failNextListAfterMove) failChatListReload = true;
        return new Response(JSON.stringify({ session_id: moveMatch[1], workspace_id: body.workspace_id ?? null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/workspaces') {
        // Reflect any pin toggled via the pin endpoint so the optimistic flip
        // survives the post-pin inventory refetch (mirrors the kernel).
        const projected = workspacesInventory.map((workspace) => {
          const id = workspace.workspace_id as string;
          const pinned = pinnedWorkspaceIds.has(id) || workspace.pinned === true || typeof workspace.pinned_at === 'number';
          return {
            ...workspace,
            pinned,
            pinned_at: pinned ? (workspace.pinned_at as number | undefined) ?? 1780669600 : null,
          };
        });
        return new Response(
          JSON.stringify({ count: projected.length, workspaces: projected, unassigned_session_count: 0 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
	      if (path === '/api/chat/sessions') {
        if (deferChatListReload) await deferChatListReload;
        if (failChatListReload) {
          return new Response(JSON.stringify({ detail: 'list unavailable' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
        const includeArchived = new URL(rawUrl, 'http://127.0.0.1').searchParams.get('include_archived') === 'true';
        const allSessions = [
          {
            session_id: 'session_demo',
            title: 'Backend persisted session',
            created_at: 1780669000,
            updated_at: 1780669100,
            messages: [
              { role: 'user', content: 'Explain persisted sessions', created_at: 1780669000 },
              {
                role: 'assistant',
                content: 'run_id=run_demo status=queued chain_verdict=CHAIN_PARTIAL',
                run_id: 'run_demo',
                created_at: 1780669100,
              },
            ],
            metadata: {},
          },
          ...additionalChatSessions,
        ];
        const sessions = allSessions
          .map((session) => {
            // A seeded pinned_at is preserved; the pin endpoint adds pinning on
            // top — so the optimistic flip survives this refetch either way.
            const seededPin = typeof session.pinned_at === 'number' ? (session.pinned_at as number) : null;
            return {
              ...session,
              archived: archivedSessionIds.has(session.session_id as string),
              pinned_at: pinnedSessionIds.has(session.session_id as string) ? seededPin ?? 1780669500 : seededPin,
            };
          })
          .filter((session) => includeArchived || !session.archived);
        return new Response(JSON.stringify({ sessions }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/runs/run_demo') {
        return new Response(
          JSON.stringify({
            goal_id: 'goal_demo',
            run_id: 'run_demo',
            chat_session_id: 'session_demo',
            status: latestRunStatus,
            dry_run: true,
            child_executions: [{ child_run_id: 'run_child_demo', status: 'completed', backend: 'codex', depth: 1 }],
            task_graph: {
              goal_id: 'goal_demo',
              tasks: [{ task_id: 'task_impl', role: 'implementer', title: 'Implement viewer', depends_on: [] }],
            },
            active_mutation_lease: { lease_id: 'lease_demo', owner: 'desktop', mode: 'exclusive', worker_pid: 1234, worker_host: 'local' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/runs/run_demo/evidence') {
        const artifacts = [
          { artifact_id: 'run_demo_log', kind: 'worker-log', path: '/tmp/run_demo.log', sensitivity: 'internal' },
          { artifact_id: 'run_demo_evidence', kind: 'evidence-json', path: '/tmp/run_demo-evidence.json', sensitivity: 'internal' },
        ];
        if (mediaArtifactAttached) {
          artifacts.push({
            artifact_id: 'runninghub_media_demo',
            kind: 'runninghub-media-task-json',
            path: '/tmp/runninghub_media_demo.json',
            sensitivity: 'internal',
          });
        }
        return new Response(
          JSON.stringify({
            run_id: 'run_demo',
            chain_verdict: 'CHAIN_PARTIAL',
            commands: [{ command: 'pytest tests/test_tui.py', exit_code: 0, output: '23 passed in 2.1s' }],
            worker_results: [{ backend: 'codex', role: 'implementer', exit_code: 0, output: 'Implemented evidence viewer and verified the UI.' }],
            artifacts,
            findings: [{ name: 'submission_artifact_consistency', passed: true, detail: 'artifact bundle is complete' }],
            child_executions: [{ child_run_id: 'run_child_demo', status: 'completed', backend: 'codex', chain_verdict: 'CHAIN_PARTIAL' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/runs/run_demo/artifacts/run_demo_log') {
        return new Response('worker transcript preview\nline 2', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      if (path === '/api/runs/run_demo/artifacts/run_demo_evidence') {
        return new Response(JSON.stringify({ run_id: 'run_demo', chain_verdict: 'CHAIN_PARTIAL' }, null, 2), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/runs/run_demo/artifacts/runninghub_media_demo') {
        return new Response(JSON.stringify({ artifact_id: 'runninghub_media_demo', dry_run: true }, null, 2), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/runs/run_demo/protocol-export') {
        return new Response(
          JSON.stringify({
            adapter_name: 'clawhunt.delivery_protocol.v1',
            request_json: {
              solution_text: 'ClawHunt completed run run_demo.',
              attachments: ['superclaw-run:run_demo'],
              agent_package_manifest: {
                name: 'Desktop evidence viewer',
                summary: 'Inspect evidence and export delivery payloads.',
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/goals') {
        latestGoalRequest = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return new Response(JSON.stringify({ goal_id: 'goal_demo' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/config') {
        return new Response(
          JSON.stringify({
            config_path: '.superclaw/shell-config.toml',
            defaults: { backend: 'codex', mode: 'auto' },
            auth: {
              clawhunt_agent_api_key: 'unset',
              control_token: 'set',
              anthropic_api_key: 'unset',
              gemini_api_key: 'unset',
              runninghub_api_keys: 'set',
            },
            ui_sections: ['basic', 'advanced'],
            entries: [
              {
                name: 'mode',
                category: 'shell',
                description: 'Default shell mode for new sessions.',
                default: 'auto',
                configured: false,
                persist_allowed: true,
                persisted: false,
                secret: false,
                source: 'default',
                value: 'auto',
                display_value: 'auto',
                ui: { type: 'select', section: 'basic', choices: ['auto', 'chat', 'delivery'] },
              },
              {
                name: 'CLAWHUNT_BASE_URL',
                category: 'auth',
                description: 'ClawHunt API base URL',
                default: 'http://127.0.0.1:8787',
                configured: true,
                persist_allowed: true,
                persisted: true,
                secret: false,
                source: 'file',
                value: 'http://127.0.0.1:8787',
                display_value: 'http://127.0.0.1:8787',
                ui: { type: 'url', section: 'basic', choices: null },
              },
              {
                name: 'SUPERCLAW_HTTP_ALLOW_PRIVATE',
                category: 'backend',
                description: 'Allow the HTTP backend to call private hosts.',
                default: 'false',
                configured: false,
                persist_allowed: true,
                persisted: false,
                secret: false,
                source: 'default',
                value: 'false',
                display_value: 'false',
                ui: { type: 'toggle', section: 'advanced', choices: null },
              },
              {
                name: 'SUPERCLAW_AUTO_PROJECT_PLUGINS',
                category: 'plugin',
                description: 'Auto-project installed plugins as callable tools.',
                default: '1',
                configured: true,
                persist_allowed: true,
                persisted: true,
                secret: false,
                source: 'persisted',
                value: '1',
                display_value: '1',
                ui: { type: 'toggle', section: 'advanced', choices: null },
              },
              {
                name: 'SUPERCLAW_GEMINI_API_KEY',
                category: 'backend',
                description: 'Gemini API key for local API-agent runs.',
                default: null,
                configured: false,
                persist_allowed: false,
                persisted: false,
                secret: true,
                source: 'default',
                value: null,
                display_value: 'unset',
                ui: { type: 'secret', section: 'advanced', choices: null },
              },
              {
                name: 'ANTHROPIC_API_KEY',
                category: 'backend',
                description: 'Anthropic API key for direct API-agent runs.',
                default: null,
                configured: true,
                persist_allowed: false,
                persisted: false,
                secret: true,
                source: 'environment',
                value: null,
                display_value: 'set',
                ui: { type: 'secret', section: 'advanced', choices: null },
              },
              {
                name: 'SUPERCLAW_CODEX_EXECUTABLE',
                category: 'backend',
                description: 'Path to the local Codex executable.',
                default: null,
                configured: true,
                persist_allowed: true,
                persisted: true,
                secret: false,
                source: 'file',
                display_value: '/opt/homebrew/bin/codex',
              },
              {
                name: 'SUPERCLAW_HERMES_EXECUTABLE',
                category: 'backend',
                description: 'Path to the local Hermes executable.',
                default: null,
                configured: false,
                persist_allowed: true,
                persisted: false,
                secret: false,
                source: 'default',
                display_value: null,
              },
              {
                name: 'SUPERCLAW_CLAUDE_EXECUTABLE',
                category: 'backend',
                description: 'Path to the local Claude Code executable.',
                default: null,
                configured: false,
                persist_allowed: true,
                persisted: false,
                secret: false,
                source: 'default',
                display_value: null,
              },
              {
                name: 'SUPERCLAW_OPENCLAW_EXECUTABLE',
                category: 'backend',
                description: 'Path to the local OpenClaw executable.',
                default: null,
                configured: false,
                persist_allowed: true,
                persisted: false,
                secret: false,
                source: 'default',
                display_value: null,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/agents') {
        return new Response(
          JSON.stringify({
            agents: [
              {
                name: 'codex',
                available: true,
                executable: '/opt/homebrew/bin/codex',
                version: '0.133.0',
                kind: 'cli',
                configure: '/config set SUPERCLAW_CODEX_EXECUTABLE /path/to/codex',
                config_env: 'SUPERCLAW_CODEX_EXECUTABLE',
                config_state: '/opt/homebrew/bin/codex',
                model_env: 'SUPERCLAW_CODEX_MODEL',
                model_state: 'configured-default',
                label: 'Codex CLI',
                supports_model_selection: true,
                default_model: 'configured-default',
                suggested_models: ['gpt-5.2-codex', 'gpt-5.1-codex-mini'],
                chat_capable: false,
                chat_tier: 'native',
              },
              {
                name: 'claude',
                available: true,
                executable: '/opt/homebrew/bin/claude',
                version: '2.0.0',
                kind: 'cli',
                configure: '/config set SUPERCLAW_CLAUDE_EXECUTABLE /path/to/claude',
                config_env: 'SUPERCLAW_CLAUDE_EXECUTABLE',
                config_state: '/opt/homebrew/bin/claude',
                model_env: 'SUPERCLAW_CLAUDE_MODEL',
                model_state: 'claude-opus-4-8',
                label: 'Claude Code',
                supports_model_selection: true,
                default_model: 'claude-opus-4-8',
                suggested_models: ['claude-opus-4-8', 'claude-sonnet-4-6'],
                chat_capable: false,
                chat_tier: 'upgradeable',
              },
            ],
            summary: { count: 2, ready_count: 2 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/status') {
        return new Response(
          JSON.stringify({
            cache_root: '.superclaw/plugins/cache',
            cloud_root: '.superclaw/plugins/cloud',
            developer_submission_root: '.superclaw/plugins/developer-submissions',
            clawhunt_ingestion_root: '.superclaw/plugins/clawhunt-ingestion',
            plugin_count: [helloWorldInstalled, githubScannerInstalled, paySwitchInstalled].filter(Boolean).length,
            plugins: [
              ...(helloWorldInstalled
                ? [
                    {
                      id: 'dev.superclaw.hello-world',
                      version: '0.1.0',
                      name: 'Hello World',
                      path: '.superclaw/plugins/cache/dev.superclaw.hello-world/0.1.0',
                      logo: 'assets/logo.svg',
                      logo_url: '/api/plugins/dev.superclaw.hello-world/logo?version=0.1.0',
                    },
                  ]
                : []),
              ...(githubScannerInstalled
                ? [
                    {
                      id: 'dev.superclaw.github-scanner',
                      version: '0.2.0',
                      name: 'GitHub Scanner',
                      path: '.superclaw/plugins/cache/dev.superclaw.github-scanner/0.2.0',
                    },
                  ]
                : []),
              ...(paySwitchInstalled
                ? [
                    {
                      id: 'dev.clawhunt.pay-switch-agent',
                      version: '0.2.0',
                      name: 'Pay-Switch Agent',
                      path: '.superclaw/plugins/cache/dev.clawhunt.pay-switch-agent/0.2.0',
                    },
                  ]
                : []),
            ],
            verification: {
              public_key_configured: true,
              install_url: '/api/plugins/install',
              local_install_url: '/api/plugins/install-local',
              uninstall_url: '/api/plugins/uninstall',
            },
            registry: { count: 2, status_url: '/v1/plugins', error: null },
            governance: {
              revocation_count: 1,
              policy_count: 1,
              revocations_url: '/v1/plugins/revocations',
              policy_url: '/v1/policies/runtime',
              revocation_error: null,
              policy_error: null,
            },
            configuration: {
              status_url: '/api/plugins/{plugin_id}/configuration',
              setting_url: '/api/plugins/config/set',
              secret_url: '/api/plugins/secret/set',
              secret_delete_url: '/api/plugins/secret/delete',
            },
            diagnostics: {
              status_url: '/api/plugins/diagnostics',
              events_url: '/api/plugins/diagnostics/events',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/marketplace-catalog') {
        return new Response(JSON.stringify({ source: 'clawhunt_server', total: 0, plugins: [], error: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/plugins/workshop-catalog') {
        return new Response(JSON.stringify({ source: 'clawhunt_workshop', total: 0, plugins: [], error: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/contracts/catalog') {
        return new Response(
          JSON.stringify({
            copy: {
              trust: {
                official: 'Official',
                developer: 'Developer signed',
                local: 'Local discovery',
                untrusted: 'Untrusted',
              },
              conflict_banner: 'Catalog conflicts require review before install.',
              refresh_failed: 'Catalog refresh failed.',
            },
            install_blocking: { untrusted: true },
            trust_states: ['official', 'developer', 'local', 'untrusted'],
            kinds: ['plugin', 'skill', 'company'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/contracts/capability-upload') {
        // Distinctive values (not the static fallback) so the test proves the
        // developer-upload panel is driven by the kernel contract payload.
        return new Response(
          JSON.stringify({
            capability: 'capability-upload',
            schema_version: '0.1.0',
            artifact_source: 'local_path',
            excludes: ['signing_private_key', 'publish', 'marketplace_listing'],
            kinds: [
              {
                value: 'plugin',
                label: 'Plugin',
                id_field: 'plugin_id',
                id_placeholder: 'contract.driven.plugin.id',
                summary: 'Contract-driven plugin summary.',
                package_format: 'directory or .scplug',
                contents: [
                  { path: 'CONTRACT_DRIVEN_MANIFEST.json', required: true, detail: 'from contract' },
                ],
                review: 'Contract-driven review note.',
              },
              {
                value: 'skill',
                label: 'Skill',
                id_field: 'skill_id',
                id_placeholder: 'contract.driven.skill.id',
                contents: [{ path: 'CONTRACT_DRIVEN_SKILL.md', required: true }],
              },
              {
                value: 'company',
                label: 'Company',
                id_field: 'company_id',
                id_placeholder: 'contract.driven.company.id',
                contents: [{ path: 'CONTRACT_DRIVEN_COMPANY.json', required: true }],
              },
            ],
            acceptance_levels: [{ value: 'L1', label: 'L1 · baseline', detail: 'baseline' }],
            copy: { source_hint: 'Contract-driven source hint.' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/v1/catalog/refresh') {
        return new Response(JSON.stringify({ ok: true, refreshed: true, source: 'mock-registry' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/v1/catalog') {
        return new Response(
          JSON.stringify({
            ok: true,
            conflicts: [{ plugin_id: 'dev.superclaw.shadow', version: '0.1.0', reason: 'same_id_different_signer' }],
            items: [
              {
                kind: 'plugin',
                plugin_id: 'dev.superclaw.hello-world',
                version: '0.2.0',
                name: 'Hello World',
                summary: 'Simple registry plugin.',
                category: 'utility',
                runtime: 'mcp_sidecar',
                verified: true,
                pricing_model: 'free',
                package_digest: 'sha256:abc',
                artifact_blob_digest: 'sha256:blobabc',
                status: 'approved',
                entitlement_required: false,
                trust: 'official',
                signer_class: 'root',
                sources: ['registry'],
                instantiable: true,
              },
              {
                kind: 'plugin',
                plugin_id: 'dev.superclaw.github-scanner',
                version: '0.2.0',
                name: 'GitHub Scanner',
                summary: 'Requires entitlement for repo scans.',
                category: 'delivery',
                runtime: 'mcp_sidecar',
                verified: true,
                pricing_model: 'seat',
                package_digest: 'sha256:def',
                artifact_blob_digest: 'sha256:blobdef',
                status: 'approved',
                entitlement_required: true,
                trust: 'developer',
                signer_class: 'developer',
                sources: ['registry'],
                instantiable: true,
              },
              {
                kind: 'plugin',
                plugin_id: 'dev.clawhunt.pay-switch-agent',
                version: '0.2.0',
                name: 'Pay-Switch Agent',
                summary: 'Local payment switch automation with a browser relay.',
                category: 'payment',
                runtime: 'mcp_sidecar',
                verified: true,
                pricing_model: 'free',
                package_digest: 'sha256:payswitch',
                status: 'approved',
                entitlement_required: false,
                trust: 'local',
                signer_class: 'local',
                sources: ['local_discovery'],
                instantiable: true,
              },
              {
                kind: 'plugin',
                plugin_id: 'dev.superclaw.untrusted-lab',
                version: '0.1.0',
                name: 'Untrusted Lab',
                summary: 'Unsigned catalog package used to prove install blocking.',
                category: 'security',
                runtime: 'mcp_sidecar',
                verified: false,
                pricing_model: 'free',
                package_digest: 'sha256:untrusted',
                status: 'rejected',
                entitlement_required: false,
                trust: 'untrusted',
                signer_class: 'unknown',
                sources: ['registry'],
                instantiable: true,
              },
              {
                kind: 'skill',
                plugin_id: 'skill.changelog-formatter',
                version: '0.1.0',
                name: 'Changelog Formatter',
                summary: 'Turn raw commits into grouped markdown changelog sections.',
                category: 'marketplace',
                runtime: 'mcp_sidecar',
                verified: true,
                pricing_model: 'free',
                package_digest: 'sha256:skill',
                artifact_blob_digest: 'sha256:skillblob',
                status: 'approved',
                entitlement_required: false,
                // Codex regression: a catalog entry with explicit kind:'skill' but
                // WITHOUT skill_origin:true must STILL be excluded from the Plugins tab
                // (assertion below) and never installable via the plugin flow — covered
                // by the single red-line source isPluginInstallable.
                skill_origin: false,
                trust: 'local',
                signer_class: 'local',
                sources: ['skill_projection'],
                instantiable: true,
              },
              {
                kind: 'company',
                plugin_id: 'company.superclaw.starter',
                version: '0.1.0',
                name: 'Starter Company',
                summary: 'A reusable company template.',
                trust: 'developer',
                package_digest: 'sha256:company',
                artifact_blob_digest: 'sha256:companyblob',
                capability_status: 'approved',
                signer_class: 'developer',
                sources: ['company_dir'],
                instantiable: false,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/diagnostics') {
        return new Response(
          JSON.stringify({
            ok: false,
            artifact_count: 2,
            artifact_dir: '.superclaw/artifacts/plugins',
            summary: {
              plugins: 1,
              tools: 1,
              failures: 1,
              slow_calls: 1,
              sandbox_kills: 1,
            },
            thresholds: {
              slow_call_ms: 30000,
              failure_rate_threshold: 0.5,
              failure_rate_min_invocations: 3,
              sandbox_kill_threshold: 2,
            },
            findings: [
              {
                code: 'PLUGIN_RUNTIME_SLOW_CALL',
                severity: 'warning',
                plugin_id: 'dev.superclaw.github-scanner',
                plugin_version: '0.2.0',
                tool_name: 'scan_repo',
                artifact_id: 'art_slow',
                duration_ms: 60000,
                threshold_ms: 30000,
              },
              {
                code: 'PLUGIN_RUNTIME_SANDBOX_KILLS',
                severity: 'critical',
                plugin_id: 'dev.superclaw.github-scanner',
                plugin_version: '0.2.0',
                tool_name: 'scan_repo',
                sandbox_kills: 1,
                threshold: 2,
              },
            ],
            status_url: '/api/plugins/diagnostics',
            events_url: '/api/plugins/diagnostics/events',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/install') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { plugin_id?: string; version?: string };
        if (body.plugin_id === 'dev.superclaw.hello-world') {
          helloWorldInstalled = true;
          return new Response(
            JSON.stringify({
              ok: true,
              plugin_id: 'dev.superclaw.hello-world',
              version: '0.2.0',
              digest: 'sha256:hello',
              installed: true,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (body.plugin_id === 'dev.clawhunt.pay-switch-agent') {
          paySwitchInstalled = true;
          return new Response(
            JSON.stringify({
              ok: true,
              plugin_id: 'dev.clawhunt.pay-switch-agent',
              version: '0.2.0',
              digest: 'sha256:payswitch',
              installed: true,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        githubScannerInstalled = true;
        return new Response(
          JSON.stringify({
            ok: true,
            plugin_id: 'dev.superclaw.github-scanner',
            version: '0.2.0',
            digest: 'sha256:def',
            installed: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/install-github') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { plugin_id?: string; version?: string };
        if (body.plugin_id === 'dev.clawhunt.pay-switch-agent') {
          paySwitchInstalled = true;
          return new Response(
            JSON.stringify({
              ok: true,
              plugin_id: 'dev.clawhunt.pay-switch-agent',
              version: body.version ?? '0.2.0',
              digest: 'sha256:payswitch',
              installed: true,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ ok: false, error: `unsupported github install ${body.plugin_id ?? 'unknown'}` }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/install-local') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { package_path?: string };
        githubScannerInstalled = true;
        return new Response(
          JSON.stringify({
            ok: true,
            plugin_id: 'dev.superclaw.github-scanner',
            version: '0.2.0',
            digest: 'sha256:def',
            installed: true,
            package_path: body.package_path ?? '/tmp/github-scanner',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/uninstall') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { plugin_id?: string; version?: string };
        if (body.plugin_id === 'dev.superclaw.hello-world') {
          helloWorldInstalled = false;
          return new Response(
            JSON.stringify({
              ok: true,
              plugin_id: 'dev.superclaw.hello-world',
              version: body.version ?? '0.1.0',
              removed: true,
              removed_versions: ['0.1.0'],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (body.plugin_id === 'dev.clawhunt.pay-switch-agent') {
          paySwitchInstalled = false;
          return new Response(
            JSON.stringify({
              ok: true,
              plugin_id: 'dev.clawhunt.pay-switch-agent',
              version: body.version ?? '0.2.0',
              removed: true,
              removed_versions: [body.version ?? '0.2.0'],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        githubScannerInstalled = false;
        return new Response(
          JSON.stringify({
            ok: true,
            plugin_id: body.plugin_id ?? 'dev.superclaw.github-scanner',
            version: body.version ?? '0.2.0',
            removed: true,
            removed_versions: [body.version ?? '0.2.0'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/config/set') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { value?: string };
        githubScannerSetting = body.value ?? githubScannerSetting;
        githubScannerSettingConfigured = true;
        return new Response(JSON.stringify({ ok: true, configured: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/plugins/secret/set') {
        githubScannerSecretConfigured = true;
        return new Response(JSON.stringify({ ok: true, configured: true, version_range: '=0.2.0' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/plugins/secret/delete') {
        githubScannerSecretConfigured = false;
        return new Response(JSON.stringify({ ok: true, configured: false, deleted: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/plugins/dev.superclaw.hello-world/configuration') {
        return new Response(
          JSON.stringify({
            plugin_id: 'dev.superclaw.hello-world',
            version: '0.1.0',
            name: 'Hello World',
            runtime: { type: 'mcp_sidecar' },
            configuration: { settings: [], secrets: [] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/dev.superclaw.github-scanner/configuration') {
        return new Response(
          JSON.stringify({
            plugin_id: 'dev.superclaw.github-scanner',
            version: '0.2.0',
            name: 'GitHub Scanner',
            runtime: { type: 'mcp_sidecar' },
            configuration: {
              settings: [
                {
                  name: 'default_owner',
                  type: 'string',
                  description: null,
                  default: 'ClawHunt-Store',
                  configured: githubScannerSettingConfigured,
                  value: githubScannerSetting,
                  updated_at: githubScannerSettingConfigured ? '2026-06-03T00:00:00Z' : null,
                },
              ],
              secrets: [
                {
                  name: 'GITHUB_TOKEN',
                  env_name: 'GITHUB_TOKEN',
                  description: 'GitHub token injected locally by ClawHunt credential manager.',
                  required: true,
                  configured: githubScannerSecretConfigured,
                  version_range: githubScannerSecretConfigured ? '=0.2.0' : null,
                  updated_at: githubScannerSecretConfigured ? '2026-06-03T00:00:00Z' : null,
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/dev.clawhunt.pay-switch-agent/configuration') {
        return new Response(
          JSON.stringify({
            plugin_id: 'dev.clawhunt.pay-switch-agent',
            version: '0.2.0',
            name: 'Pay-Switch Agent',
            runtime: { type: 'mcp_sidecar' },
            configuration: {
              settings: [
                {
                  name: 'config_url',
                  type: 'string',
                  description: 'HTTPS URL for resolving the active ClawHunt Pay-Switch plugin configuration.',
                  default: 'https://clawhunt.store/api/pay-switch/config',
                  configured: false,
                  value: 'https://clawhunt.store/api/pay-switch/config',
                  updated_at: null,
                },
                {
                  name: 'panel_url',
                  type: 'string',
                  description: 'HTTPS URL for opening the ClawHunt Pay-Switch operator panel.',
                  default: 'https://clawhunt.store/pay-switch',
                  configured: false,
                  value: 'https://clawhunt.store/pay-switch',
                  updated_at: null,
                },
                {
                  name: 'chrome_user_data_dir',
                  type: 'string',
                  description: 'Chrome User Data root directory Pay-Switch drives for live local payment. Leave empty to auto-discover.',
                  default: '',
                  configured: true,
                  value: '/Users/leongong/Library/Application Support/Google/Chrome',
                  updated_at: '2026-06-08T00:00:00Z',
                },
                {
                  name: 'chrome_profile_directory',
                  type: 'string',
                  description: 'Chrome profile used by PaySwitch.',
                  default: 'Default',
                  configured: true,
                  value: 'Default',
                  updated_at: '2026-06-08T00:00:00Z',
                  options_source: {
                    tool: 'payswitch',
                    action: 'list_profiles',
                    label: 'Chrome profiles',
                    value_field: 'profile_directory',
                    label_field: 'label',
                  },
                  actions: [
                    {
                      id: 'extension_status',
                      label: 'Refresh Browser Relay',
                      tool: 'payswitch',
                      arguments: { action: 'extension_status' },
                    },
                    {
                      id: 'extension_install',
                      label: 'Install Browser Relay',
                      tool: 'payswitch',
                      arguments: { action: 'extension_install' },
                    },
                  ],
                },
              ],
              secrets: [
                {
                  name: 'PAY_SWITCH_AGENT_TOKEN',
                  env_name: 'PAY_SWITCH_AGENT_TOKEN',
                  description: 'ClawHunt-issued scoped PayAgent token stored in the local OS credential store or injected by ClawHunt.',
                  required: false,
                  configured: false,
                  version_range: null,
                  updated_at: null,
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/dev.clawhunt.pay-switch-agent/configuration/options') {
        return new Response(
          JSON.stringify({
            options: [
              {
                value: 'Default',
                label: 'Leon — leon@example.test',
                name: 'Leon',
                email: 'leon@example.test',
                user_data_dir: '/Users/leongong/Library/Application Support/Google/Chrome',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/dev.clawhunt.pay-switch-agent/configuration/action') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { action_id?: string };
        const browserExtension = {
          connected: true,
          reachable: true,
          relay_base_url: 'http://127.0.0.1:8787',
          last_heartbeat: {
            extension_id: 'payswitch-ext-real',
            received_at: 1781000000,
            payload: { version: '0.1.3', manifest_version: 3 },
          },
          version: '0.1.3',
          manifest_version: 3,
        };
        if (body.action_id === 'extension_install') {
          return new Response(
            JSON.stringify({
              result: {
                text: 'PaySwitch Browser Relay install instructions resolved.',
                browser_extension: browserExtension,
                install: {
                  extension_dir: '/Users/leongong/Documents/payswitch/payswitch/browser_extension',
                  load_url: 'chrome://extensions/',
                  relay_base_url: 'http://127.0.0.1:8787',
                  relay_token_present: true,
                  instructions: ['Open chrome://extensions/ in the target Chrome profile.'],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            result: {
              text: 'PaySwitch Browser Relay is connected.',
              browser_extension: browserExtension,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/v1/developer/capabilities' || path === '/v1/developer/plugins') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          kind?: 'plugin' | 'skill' | 'company';
          developer_id?: string;
          plugin_id?: string;
          capability_id?: string;
          requested_acceptance_level?: string;
        };
        const kind = body.kind ?? 'plugin';
        const capabilityId = body.capability_id ?? body.plugin_id ?? 'dev.superclaw.hello-world';
        developerSubmissionRecord = {
          ...developerSubmissionRecord,
          kind,
          status: 'draft',
          capability_status: 'pending_review',
          developer_id: body.developer_id ?? 'dev_local',
          capability_id: capabilityId,
          plugin_id: kind === 'plugin' ? capabilityId : null,
          skill_id: kind === 'skill' ? capabilityId : null,
          company_id: kind === 'company' ? capabilityId : null,
          requested_acceptance_level: body.requested_acceptance_level ?? 'L1',
        };
        return new Response(JSON.stringify(developerSubmissionRecord), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/v1/developer/capabilities/plugsub_demo/artifact' || path === '/v1/developer/plugins/plugsub_demo/artifact') {
        developerSubmissionRecord = {
          ...developerSubmissionRecord,
          status: 'verified',
          capability_status: 'approved',
          artifact_uploaded: true,
          ready_for_review: true,
          version: '0.1.0',
          ready_for_signing: true,
          listing_review_level: 'Verified',
          acceptance_recommendation: 'L1',
          package_digest: 'sha256:artifact',
          artifact_blob_digest: 'sha256:artifactblob',
          signature_issued: true,
          signed_package_ref: 'superclaw-local://developer-submissions/plugsub_demo/signed-package',
          gates: [
            { name: 'manifest_valid', passed: true, detail: 'manifest schema matches the registry contract' },
            { name: 'support_contact_present', passed: true, detail: 'support contact is documented' },
          ],
        };
        return new Response(JSON.stringify(developerSubmissionRecord), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/v1/developer/capabilities/plugsub_demo/status' || path === '/v1/developer/plugins/plugsub_demo/verification') {
        return new Response(JSON.stringify(developerSubmissionRecord), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/v1/plugins') {
        return new Response(
          JSON.stringify({
            plugins: [
              {
                plugin_id: 'dev.superclaw.hello-world',
                version: '0.2.0',
                name: 'Hello World',
                summary: 'Simple registry plugin.',
                category: 'utility',
                runtime: 'mcp_sidecar',
                platforms: ['darwin-arm64'],
                acceptance_level: 'L1',
                verified: true,
                pricing_model: 'free',
                package_digest: 'sha256:abc',
                compatibility: { superclaw: '>=0.1.0' },
                entitlement_required: false,
              },
              {
                plugin_id: 'dev.superclaw.github-scanner',
                version: '0.2.0',
                name: 'GitHub Scanner',
                summary: 'Requires entitlement for repo scans.',
                category: 'delivery',
                runtime: 'mcp_sidecar',
                platforms: ['darwin-arm64', 'linux-x64'],
                acceptance_level: 'L2',
                verified: true,
                pricing_model: 'seat',
                package_digest: 'sha256:def',
                compatibility: { superclaw: '>=0.1.0' },
                entitlement_required: true,
              },
              {
                plugin_id: 'dev.clawhunt.pay-switch-agent',
                version: '0.2.0',
                name: 'Pay-Switch Agent',
                summary: 'Local payment switch automation with a browser relay.',
                category: 'payment',
                runtime: 'mcp_sidecar',
                platforms: ['darwin-arm64'],
                acceptance_level: 'L2',
                verified: true,
                pricing_model: 'free',
                package_digest: 'sha256:payswitch',
                compatibility: { superclaw: '>=0.1.0' },
                entitlement_required: false,
              },
              {
                plugin_id: 'skill.changelog-formatter',
                version: '0.1.0',
                name: 'Changelog Formatter',
                summary: 'Turn raw commits into grouped markdown changelog sections.',
                category: 'marketplace',
                runtime: 'mcp_sidecar',
                platforms: ['darwin-arm64', 'linux-x64'],
                acceptance_level: 'L1',
                verified: true,
                pricing_model: 'free',
                package_digest: 'sha256:skill',
                compatibility: { superclaw: '>=0.1.0' },
                entitlement_required: false,
                skill_origin: true,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/v1/skills') {
        return new Response(
          JSON.stringify({
            skills: [
              {
                id: 'native-changelog',
                slug: 'native-changelog',
                name: 'Native Changelog Formatter',
                description: 'Native skill-store record for grouped markdown release notes.',
                summary: 'Native skill-store record for grouped markdown release notes.',
                version: '0.2.0',
                source: 'native-store',
                path: '.superclaw/skills/native-changelog',
                package_digest: 'sha256:nativeskill',
                artifact_blob_digest: 'sha256:nativeartifact',
                acceptance_level: 'L1',
                capability_status: 'approved',
                labels: ['official', 'reviewed', 'community', 'local-dev'],
                executable: true,
                scripts: ['format.sh', 'unsafe/nested.sh'],
                assets: [{ name: 'template.md' }, { path: 'unsafe/secret.txt' }],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/v1/plugins/revocations') {
        return new Response(
          JSON.stringify({
            revoked: [
              {
                plugin_id: 'dev.superclaw.old-tool',
                version: '0.1.0',
                package_digest: 'sha256:bad',
                reason: 'broken_runtime',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/v1/policies/runtime') {
        return new Response(
          JSON.stringify({
            policies: [
              {
                plugin_id: 'dev.superclaw.github-scanner',
                version: '0.2.0',
                max_model_output_bytes: 1024,
                max_tool_timeout_ms: 30000,
                denylisted_permissions: ['network:*'],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/v1/entitlements/sync') {
        const request = JSON.parse(String(init?.body ?? '{}')) as {
          device_id?: string;
          runtime_version?: string;
          plugin_ids?: string[];
        };
        const entitlements =
          request.plugin_ids?.includes('dev.superclaw.github-scanner')
            ? [
                {
                  plugin_id: 'dev.superclaw.github-scanner',
                  version: '0.2.0',
                  version_range: '=0.2.0',
                  subject: request.device_id ?? 'scdev_demo',
                  device_id: request.device_id ?? 'scdev_demo',
                  runtime_version: request.runtime_version ?? '0.1.0',
                  entitlement_id: 'ent_demo',
                  expires_at: '2030-01-01T00:00:00Z',
                  synced_at: '2026-06-04T00:00:00Z',
                  offline_grace_expires_at: '2026-06-11T00:00:00Z',
                },
              ]
            : [];
        githubScannerEntitled = entitlements.length > 0;
        return new Response(JSON.stringify({ entitlements }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/auth/status') {
        return new Response(JSON.stringify(clawHuntAuthPayload()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/auth/clawhunt/me') {
        return new Response(JSON.stringify({ ok: true, status_code: 200, body: { handle: 'agent-01' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/auth/clawhunt/account/login-probe') {
        return new Response(JSON.stringify({ ok: true, reachable: true, login_endpoint: true, base_url: 'https://clawhunt.store', status_code: 401, detail: 'login endpoint reachable; credentials rejected as expected' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/auth/clawhunt/browser/start') {
        latestClawHuntBrowserLoginProvider = new URL(String(input), window.location.href).searchParams.get('provider');
        openedClawHuntLoginUrl =
          `https://clawhunt.store/google-oauth-bridge.html?redirect_uri=${encodeURIComponent('http://127.0.0.1:43123/api/auth/clawhunt/browser/callback?state=test-state&source=superclaw')}&source=superclaw&client=superclaw`;
        clawHuntAccountSet = true;
        clawHuntAccountUser = { username: 'leon', email: 'leon@example.test', avatar_url: 'https://example.test/avatar.png' };
        return new Response(
          JSON.stringify({
            ok: true,
            source: 'superclaw',
            provider: latestClawHuntBrowserLoginProvider,
            login_url: openedClawHuntLoginUrl,
            callback_url: 'http://127.0.0.1:43123/api/auth/clawhunt/browser/callback?state=test-state&source=superclaw',
            expires_in_seconds: 600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/auth/clawhunt/account/login') {
        latestClawHuntAccountLoginRequest = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        clawHuntAccountSet = true;
        clawHuntAccountUser = { username: 'leon', email: 'leon@example.test', avatar_url: 'https://example.test/avatar.png' };
        return new Response(JSON.stringify({ ok: true, auth: clawHuntAuthPayload(), user: clawHuntAccountUser }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/auth/clawhunt/account/me') {
        return new Response(JSON.stringify({ ok: true, status_code: 200, body: { user: clawHuntAccountUser } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/auth/clawhunt/account/agents') {
        return new Response(
          JSON.stringify({
            ok: true,
            status_code: 200,
            body: {
              agents: [
                {
                  id: 12,
                  name: 'desktop-agent',
                  slug: 'desktop-agent',
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/auth/clawhunt/agent-key') {
        latestClawHuntAgentKeyCreateRequest = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        clawHuntAgentKeySet = true;
        clawHuntAgentKeySource = 'account';
        clawHuntAgentKeyName = String(latestClawHuntAgentKeyCreateRequest.name ?? 'ClawHunt Desktop');
        return new Response(
          JSON.stringify({
            ok: true,
            auth: clawHuntAuthPayload(),
            agent_key: { status: 'set', source: clawHuntAgentKeySource, name: clawHuntAgentKeyName },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/auth/clawhunt/logout') {
        clawHuntAccountSet = false;
        clawHuntAccountUser = null;
        clawHuntAgentKeySet = false;
        clawHuntAgentKeySource = null;
        clawHuntAgentKeyName = null;
        return new Response(JSON.stringify({ ok: true, auth: clawHuntAuthPayload() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/cost/summary') {
        return new Response(
          JSON.stringify({
            event_count: 3,
            input_tokens: 285000,
            output_tokens: 116000,
            total_tokens: 401000,
            cached_input_tokens: 64000,
            duration_seconds: 12840,
            total_cost_cents: 4132,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/cost/events') {
        const nowSeconds = Math.floor(Date.now() / 1000);
        return new Response(
          JSON.stringify({
            events: [
              {
                occurred_at: nowSeconds - 3600,
                input_tokens: 150000,
                output_tokens: 62000,
                cached_input_tokens: 42000,
                duration_seconds: 11640,
                cost_cents: 2417,
              },
              {
                occurred_at: nowSeconds - 90000,
                input_tokens: 90000,
                output_tokens: 38000,
                cached_input_tokens: 17000,
                duration_seconds: 1200,
                cost_cents: 1260,
              },
              {
                occurred_at: nowSeconds - 220000,
                input_tokens: 45000,
                output_tokens: 16000,
                cached_input_tokens: 5000,
                duration_seconds: 420,
                cost_cents: 455,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/team/companies') {
        // One LEGACY Python company (company_* id, not a uuid) so the @-menu union and the
        // fail-closed "legacy company can't run on Node" guard can be exercised.
        return new Response(
          JSON.stringify({ companies: [{ company_profile_id: 'company_legacy1', name: 'Legacy Co', status: 'active' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/paperclip-api/companies') {
        // Paperclip company list (an array) — backs the sidebar badge + composer
        // @-company picker via paperclipBridge. When paperclipUnreachable is set we
        // respond 500 so the @-menu union degrades to the Python path alone.
        // Empty (200) ⇒ paperclipUnreadTotal short-circuits to 0 and never hits a
        // per-company sidebar-badges path.
        if (paperclipUnreachable) {
          return new Response('', { status: 500 });
        }
        // POST = the composer "create a company" action provisioning natively on Node
        // (createPaperclipCompany). Echo a created company so the @-menu can prepend it.
        if (init?.method === 'POST') {
          const body = init.body ? (JSON.parse(String(init.body)) as { name?: string }) : {};
          // A real Paperclip company id is a uuid — the composer only sends company_id for
          // uuid companies, so the echoed id MUST be a valid uuid for the "create then @ it"
          // path to be exercised honestly.
          return new Response(
            JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', name: body.name ?? 'Untitled', status: 'active' }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          );
        }
        // One Node-native company (uuid id) so the @-menu can exercise running a chat
        // turn natively INSIDE a Node company (company_id sent on the turn).
        return new Response(
          JSON.stringify([{ id: '22222222-2222-4222-8222-222222222222', name: 'NodeCo', status: 'active' }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/team/messages') {
        // Python fallback target for the sidebar badge (only hit when Paperclip is
        // unreachable). Benign empty roll-up.
        return new Response(JSON.stringify({ snapshot_as_of: 0, total_unread: 0, companies: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/team/agents') {
        return new Response(JSON.stringify({ agents: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/team/issues') {
        return new Response(JSON.stringify({ issues: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unhandled fetch path: ${path}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, '__TAURI__');
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    latestRunStatus = 'queued';
    additionalRuns = [];
    additionalChatSessions = [];
    workspacesInventory = [];
    moveBoundaryConflict = false;
    workspaceCreateConflict = false;
    archivedSessionIds = new Set<string>();
    pinnedSessionIds = new Set<string>();
    pinnedWorkspaceIds = new Set<string>();
    failChatListReload = false;
    deferChatListReload = null;
    deferWorkspaceCreate = null;
    failNextListAfterArchive = false;
    failNextListAfterMove = false;
    runsOverride = null;
    runtimeActiveRunIds = [];
    runtimeRecentRunId = null;
    latestMediaRequest = null;
  });

  it('releases the browser canvas splash from healthy Node and gateway services without Python or any configured agents', async () => {
    localStorage.setItem('superclaw_landing_surface', 'canvas');
    const splash = document.createElement('div');
    splash.id = 'superclaw-startup-splash';
    document.body.appendChild(splash);
    const baseFetch = globalThis.fetch;
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = requestPath(input);
      calls.push(path);
      if (path === '/paperclip-api/health') return Response.json({ status: 'ok' });
      if (path === '/gateway-api/health') return Response.json({ ok: true, upstream: { reachable: true, status: 200 } });
      return baseFetch(input, init);
    }));
    try {
      render(<App />);
      await waitFor(() => expect(splash.classList.contains('startup-splash-hidden')).toBe(true));
      expect(calls).toContain('/paperclip-api/health');
      expect(calls).toContain('/gateway-api/health');
      expect(calls.some((path) => path.startsWith('/api/escalations'))).toBe(false);
      expect(calls).not.toContain('/api/runtime/status');
      // An invisible native window-drag overlay previously swallowed canvas header clicks.
      expect(document.querySelector('.macos-window-drag-region')).toBeNull();
      expect(screen.queryByText(/Services are not ready/)).not.toBeInTheDocument();
    } finally {
      splash.remove();
    }
  });

  it.each(['unreachable', 'hanging'])('shows a real connection failure after bounded %s gateway startup and supports retry', async (failure) => {
    localStorage.setItem('superclaw_landing_surface', 'canvas');
    const splash = document.createElement('div');
    splash.id = 'superclaw-startup-splash';
    document.body.appendChild(splash);
    const baseFetch = globalThis.fetch;
    let gatewayReady = false;
    let resolveHanging: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/paperclip-api/health') return Response.json({ status: 'ok' });
      if (path === '/gateway-api/health') {
        if (failure === 'hanging' && !gatewayReady) return new Promise<Response>((resolve) => { resolveHanging = resolve; });
        return Response.json({ ok: true, upstream: { reachable: gatewayReady } });
      }
      return baseFetch(input, init);
    }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await React.act(async () => { render(<App />); });
      expect(splash.classList.contains('startup-splash-hidden')).toBe(false);
      await React.act(async () => { await vi.advanceTimersByTimeAsync(8000); });
      expect(splash.classList.contains('startup-splash-hidden')).toBe(true);
      expect(screen.getByRole('alert')).toHaveTextContent('Services are not ready');
      // A late result from the timed-out probe must not erase the failure state.
      await React.act(async () => { resolveHanging?.(Response.json({ ok: true, upstream: { reachable: true } })); });
      expect(screen.getByRole('alert')).toHaveTextContent('Services are not ready');
      gatewayReady = true;
      await React.act(async () => { fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry connection' })); });
      expect(screen.queryByText(/Services are not ready/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Checking Node services/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      splash.remove();
    }
  });

  it.each(['dialog', 'dismissed badge'])('unmounts a loaded legacy approval %s on canvas and refetches pending approvals on return', async (presentation) => {
    const baseFetch = globalThis.fetch;
    const escalationCalls: Array<{ path: string; method: string }> = [];
    const pending = {
      request_id: 'legacy-pending-1', kind: 'tool', status: 'pending',
      prompt_text: 'Allow the pending legacy shell action?',
      options: [{ id: 'deny', label: 'Deny' }, { id: 'approve', label: 'Approve once' }],
      default_option_id: 'deny', tool_name: 'run_shell', reserved_path: null, run_id: 'legacy-run-1',
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = requestPath(input);
      if (path.startsWith('/api/escalations')) {
        escalationCalls.push({ path, method: init?.method ?? 'GET' });
        return Response.json({ escalations: [pending] });
      }
      if (path === '/paperclip-api/health') return Response.json({ status: 'ok' });
      if (path === '/gateway-api/health') return Response.json({ ok: true, upstream: { reachable: true } });
      return baseFetch(input, init);
    }));
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      render(<App />);
      await screen.findByRole('alertdialog', { name: pending.prompt_text });
      if (presentation === 'dismissed badge') {
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss (stays pending)' }));
        expect(screen.getByRole('button', { name: 'Show pending approvals' })).toBeInTheDocument();
      }
      fireEvent.click(screen.getByRole('button', { name: 'Canvas', exact: true }));
      await screen.findByRole('button', { name: /Workspace settings/ });
      expect(screen.queryByRole('alertdialog', { name: pending.prompt_text })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Show pending approvals' })).not.toBeInTheDocument();
      const previousPolls = escalationCalls.length;
      await React.act(async () => { await vi.advanceTimersByTimeAsync(8000); });
      expect(escalationCalls).toHaveLength(previousPolls);
      // Returning to a legacy surface remounts the real gate and reads the unchanged queue.
      fireEvent.click(screen.getByRole('button', { name: /Workspace settings/ }));
      await screen.findByRole('alertdialog', { name: pending.prompt_text });
      expect(escalationCalls.length).toBeGreaterThan(previousPolls);
      expect(escalationCalls.every((call) => call.method === 'GET' && !call.path.includes('/respond'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the Capability Workshop sidebar entry reachable when the published feed and installed set are both empty', async () => {
    // Regression for the dead-end introduced by the (now reverted)
    // "hide the Capability Workshop when the published feed is empty" gate:
    // an empty upstream feed AND nothing installed must NOT remove the only
    // navigation entry — otherwise the user can never reach the workshop to
    // install anything (chicken-and-egg). The owner's decision is "always
    // visible"; this locks the sidebar entry + surface against re-gating.
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = requestPath(input);
        // Force the fully-empty environment: zero installed plugins on top of
        // the default empty workshop-catalog / marketplace-catalog feeds. Reuse
        // the real status payload (so every field the App reads — governance,
        // verification, etc. — stays present) and only blank the installed set.
        if (path === '/api/plugins/status') {
          const base = await baseFetch(input, init);
          const payload = (await base.json()) as Record<string, unknown>;
          payload.plugin_count = 0;
          payload.plugins = [];
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);

    // The entry is present despite the empty feed + empty installed set.
    const entry = await screen.findByRole('button', { name: 'Open Capability Workshop' });
    expect(entry).toBeInTheDocument();

    // And it actually opens the surface (no silent bounce-back / redirect guard),
    // so the workshop stays reachable to install the first capability.
    fireEvent.click(entry);
    expect(await screen.findByRole('heading', { name: 'Capability Workshop' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Back to main menu' })).toBeInTheDocument();

    // Returning to chat keeps the entry — it never disappears after a round-trip.
    fireEvent.click(screen.getByRole('button', { name: 'Back to main menu' }));
    expect(await screen.findByRole('button', { name: 'Open Capability Workshop' })).toBeInTheDocument();

    vi.stubGlobal('fetch', baseFetch);
  });

  it('collapses the Team unread-badge fan-out to one request per company despite readJson churn', async () => {
    // Regression for the ~200-request flood: the sidebar unread badge sums a
    // per-company GET /companies/{id}/sidebar-badges fan-out. The interval effect
    // that fires it used to key on refreshTeamUnread, whose useCallback dep
    // (readJson) churns several times during the shell's initial render — re-running
    // the effect ~8× and re-firing the whole fan-out each time, saturating the
    // browser's 6-connection limit and stalling the embedded board's own fetches.
    // The fix ref-stabilizes the effect (deps [apiReady], render-time ref) so
    // readJson identity churn never re-subscribes it, plus an in-flight de-dupe so
    // the fan-out runs once on ready then once per 30s poll. The precise signal is
    // the per-company sidebar-badges count: only the badge fan-out hits that path
    // (the composer's listPaperclipCompanies hits /companies but never
    // /sidebar-badges), so each company's badge fetched exactly once proves the
    // churn no longer multiplies it. (StrictMode's dev double-invoke is covered by
    // the in-flight de-dupe's deterministic argument — not asserted here, because
    // rendering the full App under StrictMode leaks App's diffuse, unmount-racing
    // /api/runtime/status refetches into the sibling desktop-mode test.)
    const baseFetch = globalThis.fetch;
    const badgeCalls = new Map<string, number>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === '/paperclip-api/companies') {
          return new Response(JSON.stringify([{ id: 'co-a', name: 'A' }, { id: 'co-b', name: 'B' }]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const m = path.match(/^\/paperclip-api\/companies\/([^/]+)\/sidebar-badges$/);
        if (m) {
          badgeCalls.set(m[1], (badgeCalls.get(m[1]) ?? 0) + 1);
          return new Response(JSON.stringify({ inbox: 3 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);

    // Badge resolves to the summed inbox (3 + 3) once the single fan-out completes.
    await waitFor(() => {
      expect(document.querySelector('.sidebar-unread-badge')?.textContent).toBe('6');
    });

    // Each company's sidebar-badge was fetched exactly once — the fan-out did not
    // re-fire on readJson churn.
    expect([...badgeCalls.entries()].sort()).toEqual([
      ['co-a', 1],
      ['co-b', 1],
    ]);

    vi.stubGlobal('fetch', baseFetch);
  });

  it('renders the control plane and sends the control token to protected endpoints', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Build something with ClawHunt', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Eval delivery gap', level: 1 })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'New Session' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Direct chat prompt')).toBeInTheDocument();
    expect(await screen.findByLabelText('Insert command')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Open Capability Workshop' })).toBeInTheDocument();
    const sidebarFooterActions = document.querySelector('.sidebar-footer-actions');
    expect(sidebarFooterActions).toBeInTheDocument();
    const footerCollapseButton = await screen.findByRole('button', { name: 'Collapse sidebar' });
    const footerAccountButton = await screen.findByRole('button', { name: 'Open account menu' });
    expect(sidebarFooterActions).toContainElement(footerCollapseButton);
    expect(sidebarFooterActions).toContainElement(footerAccountButton);
    expect(Array.from(sidebarFooterActions?.children ?? [])).toEqual([footerAccountButton, footerCollapseButton]);
    expect(await screen.findByLabelText('Recent Sessions')).toBeInTheDocument();
    const persistedSessionButton = await screen.findByRole('button', { name: 'Open chat session Backend persisted session' });
    expect(within(persistedSessionButton).getByText(/^(now|unknown age|\d+[mhd])$/)).toBeInTheDocument();
    expect(persistedSessionButton.querySelector('.sidebar-session-dot')).toBeNull();
    const shell = document.querySelector('.workbench-shell');
    expect(shell).toHaveClass('sidebar-expanded');
    const resizeHandle = await screen.findByRole('separator', { name: 'Resize sidebar' });
    expect(resizeHandle).toHaveAttribute('aria-valuenow', '300');
    fireEvent.pointerDown(resizeHandle, { clientX: 300 });
    fireEvent.pointerMove(window, { clientX: 364 });
    fireEvent.pointerUp(window);
    await waitFor(() => expect(localStorage.getItem('superclaw_sidebar_width')).toBe('364'));
    expect(shell).toHaveStyle({ '--sidebar-width': '364px' });
    expect(resizeHandle).toHaveAttribute('aria-valuenow', '364');
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse sidebar' }));
    expect(shell).toHaveClass('sidebar-collapsed');
    expect(localStorage.getItem('superclaw_sidebar_collapsed')).toBe('1');
    fireEvent.click(await screen.findByRole('button', { name: 'Open account menu' }));
    const collapsedAccountMenu = await screen.findByLabelText('Account menu');
    expect(collapsedAccountMenu.parentElement).toBe(document.body);
    expect(collapsedAccountMenu.closest('.account-shell')).toBeNull();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByLabelText('Account menu')).not.toBeInTheDocument());
    fireEvent.click(await screen.findByRole('button', { name: 'Expand sidebar' }));
    expect(shell).toHaveClass('sidebar-expanded');
    fireEvent.click(await screen.findByRole('button', { name: 'Open account menu' }));
    expect(await screen.findByLabelText('Account menu')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByLabelText('Account menu')).not.toBeInTheDocument());
    expect(await screen.findByLabelText('Insert command')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Settings and local agents' })).not.toBeInTheDocument();
    expect(screen.queryByText('chat-ready')).not.toBeInTheDocument();

    await openSettingsWorkspace();
    expect(document.querySelector('.workbench-shell')).toHaveClass('workspace-control');
    expect(document.querySelector('.settings-fullscreen-page')).toHaveClass('control-page');
    expect(document.querySelector('.settings-sidebar')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Appearance, language & notifications' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Agents & execution' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'ClawHunt account' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Diagnostics & recovery' })).not.toBeInTheDocument();
    const shellAccountButton = screen.getByRole('button', { name: 'Open account menu' });
    expect(within(shellAccountButton).getByText('agent-01')).toBeInTheDocument();
    // The bottom-left account block intentionally drops the link-status line —
    // only the avatar + name remain; the status lives in the account menu.
    expect(within(shellAccountButton).queryByText('ClawHunt linked')).not.toBeInTheDocument();
    expect(within(shellAccountButton).queryByText('Settings')).not.toBeInTheDocument();
    expect(shellAccountButton.querySelector('.account-block-avatar')).toBeInTheDocument();
    fireEvent.click(shellAccountButton);
    const shellAccountMenu = await screen.findByLabelText('Account menu');
    expect(within(shellAccountMenu).getByText('agent-01')).toBeInTheDocument();
    expect(within(shellAccountMenu).queryByRole('button', { name: 'Switch language to Chinese' })).not.toBeInTheDocument();
    expect(within(shellAccountMenu).queryByRole('button', { name: 'Switch language to English' })).not.toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByLabelText('Account menu')).not.toBeInTheDocument());
    fireEvent.click(await screen.findByRole('button', { name: 'Diagnostics' }));
    expect(await screen.findByRole('heading', { name: 'Diagnostics & recovery' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Appearance, language & notifications' })).not.toBeInTheDocument();
    expect(await screen.findByText('Manual update path')).toBeInTheDocument();
    expect(await screen.findByText(/No auto-updater yet/)).toBeInTheDocument();
    expect(await screen.findByText('docs/desktop-manual-update.md')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy update command' })).not.toBeInTheDocument();
    // the ClawHunt task browser lived inside the now-removed run cockpit; the
    // settings "Open task browser" link row was removed along with it.
    expect(screen.queryByRole('button', { name: 'Refresh tasks' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview (draft)' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open task browser' })).not.toBeInTheDocument();
    // Per-runtime health + the runtime roster now live in the Runtime tab (the
    // Diagnostics tab keeps only crash/log export + manual update).
    fireEvent.click(screen.getByRole('button', { name: 'Runtime' }));
    expect(await screen.findByRole('heading', { name: 'Agents & execution' })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll('.runtime-roster-list .runtime-row').length).toBeGreaterThan(0));
    expect(screen.queryByRole('alertdialog', { name: 'Agent setup required' })).not.toBeInTheDocument();
    // The diagnostic runtime-settings card (config path / bind / pid / token rotation)
    // and the desktop-shell card were removed from the Runtime tab — only the agent
    // roster remains.
    expect(screen.queryByText('Runtime bind: 127.0.0.1')).not.toBeInTheDocument();
    expect(screen.queryByText('Runtime pid: 4242')).not.toBeInTheDocument();
    expect(screen.queryByText('Token state: set')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate token' })).not.toBeInTheDocument();
    expect(screen.queryByText('Desktop shell')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Capability Workshop' }));
    expect(await screen.findByRole('heading', { name: 'Capability Workshop' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Back to main menu' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Let ClawHunt work your way' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'Plugins' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'All' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Installed' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Available' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Create capability' })).toBeInTheDocument();
    // Merged refresh: the top controls expose exactly one refresh control ("Refresh"),
    // not the removed local-only "Refresh plugins" (which now lives only in the
    // collapsed advanced-ops fold), and clicking it drives the remote catalog sync.
    expect(await screen.findByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh plugins' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(
          ([input, init]) =>
            requestPath(input as string | URL | Request) === '/v1/catalog/refresh' &&
            (init?.method ?? 'GET').toUpperCase() === 'POST',
        ),
      ).toBe(true),
    );
    expect(screen.queryByRole('heading', { name: 'Operator governance and developer tools' })).not.toBeInTheDocument();
    expect(screen.queryAllByLabelText('Local plugin package path')).toHaveLength(0);
    expect(await screen.findAllByLabelText('Search plugins')).not.toHaveLength(0);
    expect(await screen.findByRole('heading', { name: 'Local installed' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'Companies' })).toBeInTheDocument();
    expect(await screen.findByText('Catalog conflicts require review before install.')).toBeInTheDocument();
    // The text source pill became an X-style verified badge (role=img/title);
    // its digest/provenance moved to the capability detail sub-page.
    expect(await screen.findAllByTitle('Official')).not.toHaveLength(0);
    const untrustedLabel = (await screen.findAllByText('Untrusted Lab')).find((item) =>
      item.closest('article')?.textContent?.includes('Unsigned catalog package used to prove install blocking.'),
    );
    expect(untrustedLabel).toBeDefined();
    const untrustedCard = untrustedLabel!.closest('article') as HTMLElement;
    const untrustedInstallButton = within(untrustedCard).getByRole('button', { name: 'Install Untrusted Lab' });
    expect(untrustedInstallButton).toBeDisabled();
    expect(untrustedInstallButton).toHaveAttribute('title', 'Install blocked by catalog trust state.');
    fireEvent.click(await screen.findByRole('tab', { name: 'Companies' }));
    expect(await screen.findAllByText('Starter Company')).not.toHaveLength(0);
    expect(await screen.findByText('Discoverable only')).toBeInTheDocument();
    // A company is a template, never installed via the plugin flow (its digest now
    // lives on the detail sub-page) — the unified card offers no install button.
    expect(screen.queryByRole('button', { name: 'Install Starter Company' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('tab', { name: 'Plugins' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create capability' }));
    expect(await screen.findByRole('heading', { name: 'Submit a developer capability' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Capability kind' })).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'Capability id' })).toBeInTheDocument();
    expect(await screen.findByText('Developer upload')).toBeInTheDocument();
    expect(await screen.findByText('Developer review')).toBeInTheDocument();
    // The package field is framed as a local-machine path (local developer console).
    expect(await screen.findByLabelText('Package path (on this machine)')).toBeInTheDocument();
    // Signing is a separate post-review step the upload endpoint rejects (HTTP 400);
    // the upload surface must never collect a signing key.
    expect(screen.queryByLabelText('Developer signing key')).not.toBeInTheDocument();
    // Prove the panel is driven by the kernel contract payload (not the static
    // fallback): the contract's distinctive source hint, id placeholder and the
    // "what to include" checklist entry must all render from the mocked contract.
    expect(await screen.findByText('Contract-driven source hint.')).toBeInTheDocument();
    expect(await screen.findByText('CONTRACT_DRIVEN_MANIFEST.json')).toBeInTheDocument();
    expect((screen.getByLabelText('Capability id') as HTMLInputElement).placeholder).toBe(
      'contract.driven.plugin.id',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    expect(await screen.findByRole('heading', { name: 'Operator governance and developer tools' })).toBeInTheDocument();
    fireEvent.click((await screen.findAllByText('Advanced plugin operations')).at(-1)!);
    // (The operator "Audit export" / delivery-protocol export over /api/runs* was removed:
    // the chat app no longer surfaces the deprecated run/delivery path.)
      const fetchMock = vi.mocked(fetch);
      const protectedCalls = fetchMock.mock.calls.filter(([path]) =>
        typeof path === 'string' &&
        [
          '/api/backends',
          '/api/harnesses',
          '/api/evals',
          '/api/runtime/status',
          '/api/desktop/onboarding',
          '/api/desktop/toolchain',
          '/api/config',
          '/api/agents',
          '/api/plugins/status',
          '/api/contracts/catalog',
          '/api/contracts/capability-upload',
          '/v1/catalog',
          '/api/plugins/marketplace-catalog',
          '/api/plugins/diagnostics',
          '/api/plugins/install',
          '/api/plugins/uninstall',
          '/api/plugins/dev.superclaw.hello-world/configuration?version=0.1.0',
          '/v1/developer/capabilities',
          '/v1/developer/capabilities/plugsub_demo/artifact',
          '/v1/developer/capabilities/plugsub_demo/status',
          '/v1/developer/plugins',
          '/v1/developer/plugins/plugsub_demo/artifact',
          '/v1/developer/plugins/plugsub_demo/verification',
          '/v1/plugins',
          '/v1/entitlements/sync',
          '/v1/plugins/revocations',
          '/v1/policies/runtime',
          '/api/auth/status',
          '/api/auth/clawhunt/me',
        ].includes(path),
      );
      expect(protectedCalls.length).toBeGreaterThanOrEqual(14);
      for (const [, init] of protectedCalls) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers['X-SuperClaw-Token']).toBe('control-secret');
      }
      expect(
        MockEventSource.instances.some((instance) => instance.url.includes('/api/plugins/diagnostics/events')),
      ).toBe(true);
      }, 15_000);

      it('renders native skill-store records without regressing plugin catalog filtering', async () => {
        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: 'Open Capability Workshop' }));
        expect(await screen.findByRole('heading', { name: 'Capability Workshop' })).toBeInTheDocument();

        // Default plugins view: tool plugins are listed, the legacy skill-origin plugin is not.
        expect(await screen.findAllByText('GitHub Scanner')).not.toHaveLength(0);
        expect(screen.queryAllByText('Changelog Formatter')).toHaveLength(0);

        // Skills view: native /v1/skills records render instead of plugin-origin catalog rows.
        fireEvent.click(await screen.findByRole('tab', { name: 'Skills' }));
        // The unified card is a compact row: name + summary + verified badge. The
        // detailed governance metadata (labels, executable warning, scripts, digest)
        // moved to the capability detail sub-page — asserted after the list checks.
        expect(await screen.findByText('Native Changelog Formatter')).toBeInTheDocument();
        expect(await screen.findByText('Native skill-store record for grouped markdown release notes.')).toBeInTheDocument();
        // The remote published skill (skill_origin, hidden by the skills-tab filter
        // before) now renders as a unified read-only card in the remote section.
        expect(await screen.findByText('Changelog Formatter')).toBeInTheDocument();
        // Remote published skills are view-only: the unified card exposes no install
        // or use-in-chat action (not installed, not installable from here).
        expect(screen.queryByRole('button', { name: /^Install Changelog Formatter/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Use in chat Changelog Formatter/ })).not.toBeInTheDocument();
        // Workshop IA P1 (Codex blocker): the Skills tab must NOT expose the plugin
        // registry install path — no advanced "Manage" toggle here, so a skill-origin
        // registry item cannot be installed via the plugin flow from the Skills tab.
        expect(screen.queryByRole('button', { name: 'Manage' })).not.toBeInTheDocument();
        expect(screen.queryByText('unsafe/nested.sh')).not.toBeInTheDocument();
        await waitFor(() => expect(screen.queryAllByText('GitHub Scanner')).toHaveLength(0));
        expect(screen.queryByText('Let ClawHunt work your way')).not.toBeInTheDocument();
        expect(screen.queryByRole('textbox', { name: 'Search plugins' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Create capability' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Install Native Changelog Formatter' })).not.toBeInTheDocument();
        // Open the native skill's detail sub-page: its labels, executable warning,
        // scripts/assets and digest are surfaced here in the unified design.
        fireEvent.click(screen.getByRole('button', { name: 'View details: Native Changelog Formatter' }));
        expect(await screen.findByText('official')).toBeInTheDocument();
        expect(await screen.findByText('reviewed')).toBeInTheDocument();
        expect(await screen.findByText('community')).toBeInTheDocument();
        expect(await screen.findByText('local-dev')).toBeInTheDocument();
        expect(await screen.findByText('Executable skill')).toBeInTheDocument();
        expect(await screen.findByText('format.sh, template.md')).toBeInTheDocument();
        expect(await screen.findByText(/sha256:nativeskill/)).toBeInTheDocument();
        // Review lifecycle status (approved via official/reviewed labels) now lives
        // in the detail page's provenance block instead of a per-card pill.
        expect(await screen.findByText('Approved')).toBeInTheDocument();
        // Runtime fail-closed proof: this skill carries an 'official' LABEL but no
        // kernel `trust`, so the verified badge (role=img/title='Official') must NOT
        // light — the green badge is a trust verdict, never a self-supplied label.
        expect(screen.queryByTitle('Official')).not.toBeInTheDocument();
        // The unsafe nested script stays filtered out even on the detail page.
        expect(screen.queryByText(/nested\.sh/)).not.toBeInTheDocument();
        // Return to the list for the remaining /v1/skills fetch assertion.
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        await waitFor(() =>
          expect(vi.mocked(fetch).mock.calls.some(([input]) => requestPath(input as string | URL | Request) === '/v1/skills')).toBe(true),
        );
      });

      // Overview ('all') tab: one screen, every capability class. Verifies the user's
      // ask — plugins, skills AND companies all render together (installed + remote) —
      // and that the Overview stays a read-only birds-eye view (no authoring controls).
      it('Overview lists plugins/skills/companies; bars installing new but allows uninstalling installed plugins', async () => {
        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: 'Open Capability Workshop' }));
        fireEvent.click(await screen.findByRole('tab', { name: 'Overview' }));
        // Workshop-wide hero.
        expect(await screen.findByRole('heading', { name: 'Let ClawHunt work your way' })).toBeInTheDocument();
        // Plugin class section + a tool plugin.
        expect(await screen.findByRole('heading', { name: 'Plugins' })).toBeInTheDocument();
        expect(await screen.findAllByText('GitHub Scanner')).not.toHaveLength(0);
        // Company class section + a company template (excluded from the Plugins tab).
        expect(await screen.findByRole('heading', { name: 'Companies' })).toBeInTheDocument();
        // Parity with the Companies-tab assertion (a company can surface from more than
        // one source); the point is it renders in the Overview, not that it is unique.
        expect(await screen.findAllByText('Starter Company')).not.toHaveLength(0);
        // Skill class: the native installed skill AND the remote published skill render.
        expect(await screen.findByText('Native Changelog Formatter')).toBeInTheDocument();
        expect((await screen.findAllByText('Changelog Formatter')).length).toBeGreaterThanOrEqual(1);
        // Read-only birds-eye view: plugin authoring + skill build controls stay hidden.
        expect(screen.queryByRole('textbox', { name: 'Search plugins' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Create capability' })).not.toBeInTheDocument();
        expect(screen.queryByText('Build & install (equippable)')).not.toBeInTheDocument();
        expect(screen.queryByText('Skills loaded from the runtime skill registry.')).not.toBeInTheDocument();
        // Read-only = no AUTHORING surface: no operator Manage toggle, no skill-sync
        // ("Skill projections") panel, and the unified cards expose NO install /
        // configure / instantiate buttons in the Overview. (Use-in-chat navigation —
        // which writes nothing — is still allowed; configure/uninstall live on the
        // per-capability detail sub-page, reached by opening a card.)
        expect(screen.queryByRole('button', { name: 'Manage' })).not.toBeInTheDocument();
        expect(screen.queryByText('Skill projections')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Install / })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Configure / })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Company template/ })).not.toBeInTheDocument();
        // Owner decision (post-double-pass): an INSTALLED plugin gets a quick
        // uninstall kebab on its list card even in the Overview. "Read-only" here
        // bars INSTALLING new capabilities / instantiating companies (asserted
        // above) — NOT removing something already installed. Hello World is installed.
        const overviewKebab = await screen.findByRole('button', { name: /^More actions Hello World/ });
        fireEvent.click(overviewKebab);
        // The list kebab is uninstall-only (configure lives on the detail page).
        expect(await screen.findByRole('button', { name: 'Uninstall' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Configure' })).not.toBeInTheDocument();
        // Regression (Codex): switching tabs must CLEAR the list menu — covers
        // keyboard/programmatic switches that fire no outside-click. Switch to Plugins;
        // the menu (its 'Uninstall') must be gone, then switch back.
        fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }));
        expect(screen.queryByRole('button', { name: 'Uninstall' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
        // Skills have no plugin-uninstall path in the kernel, so skill cards get no
        // kebab (no fabricated client-only uninstall).
        expect(screen.queryByRole('button', { name: /^More actions Native Changelog Formatter/ })).not.toBeInTheDocument();
        // Re-open the Hello World kebab so the next assertion proves opening a DETAIL
        // page ALSO clears it (otherwise 'Uninstall' would be trivially absent).
        fireEvent.click(await screen.findByRole('button', { name: /^More actions Hello World/ }));
        expect(await screen.findByRole('button', { name: 'Uninstall' })).toBeInTheDocument();
        // Read-only still FOLLOWS the capability into its detail sub-page for the
        // authoring it does bar: opening an un-installed plugin/company from the
        // Overview must NOT expose install/configure/instantiate (no escalation via
        // the list→detail route, which earlier hardcoded authoringAllowed=true).
        fireEvent.click((await screen.findAllByRole('button', { name: /^View details: GitHub Scanner/ }))[0]);
        expect(await screen.findByRole('heading', { name: 'GitHub Scanner' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Install / })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Configure' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Uninstall plugin' })).not.toBeInTheDocument();
        // Regression (Codex): the Hello World list kebab was left OPEN above; opening
        // a detail page must CLEAR it. A lingering list menu (whose anchor card just
        // unmounted) must NOT survive on the detail page where it could uninstall the
        // previous card's plugin. So the list 'Uninstall' must be gone here.
        expect(screen.queryByRole('button', { name: 'Uninstall' })).not.toBeInTheDocument();
        // Same read-only inheritance for a COMPANY template opened from the Overview:
        // no instantiate ("Company template") authoring from the read-only birds-eye.
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        fireEvent.click((await screen.findAllByRole('button', { name: /^View details: Starter Company/ }))[0]);
        expect(await screen.findByRole('heading', { name: 'Starter Company' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Company template/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
      });

      // Regression (Codex/agy blocker): the Overview must IGNORE the Plugins-tab
      // install-state filter. Setting "Installed" on the Plugins tab then switching to
      // the Overview must NOT silently drop remote plugins or companies (which have no
      // installed state and would otherwise vanish behind a filter with no UI to clear).
      it('Overview ignores the hidden Plugins-tab install-state filter and search term', async () => {
        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: 'Open Capability Workshop' }));
        // Narrow hard on the Plugins tab: "Installed" filter + a search term matching nothing.
        fireEvent.click(await screen.findByRole('button', { name: 'Installed' }));
        fireEvent.change(await screen.findByRole('textbox', { name: 'Search plugins' }), {
          target: { value: 'zzzznomatch' },
        });
        fireEvent.click(await screen.findByRole('tab', { name: 'Overview' }));
        // The company (no installed state) and the remote skill still render — both would
        // have been dropped if the 'Installed' filter had leaked into the Overview.
        expect(await screen.findAllByText('Starter Company')).not.toHaveLength(0);
        expect((await screen.findAllByText('Changelog Formatter')).length).toBeGreaterThanOrEqual(1);
        expect(await screen.findAllByText('GitHub Scanner')).not.toHaveLength(0);
      });

      it('shows native skill-store empty and error states', async () => {
        const baseFetch = global.fetch;
        const fetchWrapper = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const path = requestPath(input);
          if (path === '/v1/skills') {
            return new Response(JSON.stringify({ skills: [] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return baseFetch(input, init);
        });
        vi.stubGlobal('fetch', fetchWrapper);

        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: 'Open Capability Workshop' }));
        fireEvent.click(await screen.findByRole('tab', { name: 'Skills' }));
        expect(await screen.findByText('No native skills found.')).toBeInTheDocument();
        cleanup();

        const errorFetchWrapper = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const path = requestPath(input);
          if (path === '/v1/skills') {
            return new Response(JSON.stringify({ detail: 'skill store unavailable' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return baseFetch(input, init);
        });
        vi.stubGlobal('fetch', errorFetchWrapper);

        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: 'Open Capability Workshop' }));
        fireEvent.click(await screen.findByRole('tab', { name: 'Skills' }));
        const alert = await screen.findByRole('alert');
        expect(within(alert).getByText('Skill registry failed')).toBeInTheDocument();
        expect(within(alert).getByText(/skill store unavailable/)).toBeInTheDocument();
      });

      it('treats a 503 from the optional TUF registry refresh as benign — reloads locally with no failure toast', async () => {
        // The kernel TUF trust-registry refresh (/v1/catalog/refresh) is OPTIONAL. On
        // installs without a local TUF metadata backend (e.g. the packaged desktop app)
        // it answers 503 "registry metadata backend is not configured" — an EXPECTED,
        // benign state, NOT a failure. The refresh the user wants is the live catalog +
        // ClawHunt workshop reload (loadPluginControl), which still runs. So a 503 must
        // surface as "refreshed", never the alarming "Capability refresh failed" toast.
        const baseFetch = global.fetch;
        const refreshUnconfiguredFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (requestPath(input) === '/v1/catalog/refresh') {
            return new Response(
              JSON.stringify({ ok: false, error: 'registry metadata backend is not configured', kept_cached: true }),
              { status: 503, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return baseFetch(input, init);
        });
        vi.stubGlobal('fetch', refreshUnconfiguredFetch);

        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: 'Open Capability Workshop' }));
        expect(await screen.findByRole('tab', { name: 'Plugins' })).toBeInTheDocument();
        expect(await screen.findByRole('heading', { name: 'Local installed' })).toBeInTheDocument();

        const localCatalogReloads = () =>
          refreshUnconfiguredFetch.mock.calls.filter(
            ([input]) => requestPath(input as string | URL | Request) === '/v1/catalog',
          ).length;
        const before = localCatalogReloads();

        fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));

        // The live local reload still runs...
        await waitFor(() => expect(localCatalogReloads()).toBeGreaterThan(before));
        // ...and the user sees the benign success toast, NOT a failure...
        expect(await screen.findByText(/Capabilities refreshed/)).toBeInTheDocument();
        expect(screen.queryByText(/Capability refresh failed/)).not.toBeInTheDocument();
        // ...and the local catalog view is never torn down.
        expect(screen.getByRole('heading', { name: 'Local installed' })).toBeInTheDocument();
        expect(screen.queryByText(/capability catalog failed/i)).not.toBeInTheDocument();
      });

      it('keeps the local catalog view alive but reports a toast when the merged refresh hits a GENUINE remote failure', async () => {
        // A non-503 remote failure (e.g. a 500 from a configured registry backend) is a
        // real error: it STILL reloads the local view (parity with the removed local-only
        // refresh) and surfaces as a toast — but never tears the local catalog down into a
        // pluginCatalogError banner.
        const baseFetch = global.fetch;
        const refreshFailFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (requestPath(input) === '/v1/catalog/refresh') {
            return new Response(JSON.stringify({ detail: 'registry backend exploded' }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return baseFetch(input, init);
        });
        vi.stubGlobal('fetch', refreshFailFetch);

        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: 'Open Capability Workshop' }));
        expect(await screen.findByRole('tab', { name: 'Plugins' })).toBeInTheDocument();
        expect(await screen.findByRole('heading', { name: 'Local installed' })).toBeInTheDocument();

        const localCatalogReloads = () =>
          refreshFailFetch.mock.calls.filter(
            ([input]) => requestPath(input as string | URL | Request) === '/v1/catalog',
          ).length;
        const before = localCatalogReloads();

        fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));

        // Remote sync failure still drives a fresh local reload...
        await waitFor(() => expect(localCatalogReloads()).toBeGreaterThan(before));
        // ...is reported as a toast...
        expect(await screen.findByText(/Capability refresh failed/)).toBeInTheDocument();
        // ...and never tears the local catalog view down into an error banner.
        expect(screen.getByRole('heading', { name: 'Local installed' })).toBeInTheDocument();
        expect(screen.queryByText(/capability catalog failed/i)).not.toBeInTheDocument();
      });

      it('uses the ClawHunt marketplace catalog before local registry and mock plugins', async () => {
        const baseFetch = global.fetch;
        const fetchWrapper = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const path = requestPath(input);
          if (path === '/v1/catalog') {
            return new Response(JSON.stringify({ detail: 'legacy fallback test' }), { status: 503 });
          }
          if (path === '/api/plugins/marketplace-catalog') {
            return new Response(
              JSON.stringify({
                source: 'clawhunt_server',
                total: 1,
                plugins: [
                  {
                    plugin_id: 'dev.clawhunt.pay-switch-agent',
                    version: '0.3.0',
                    name: { en: 'Pay-Switch Agent', zh: 'Pay-Switch Agent' },
                    summary: {
                      en: 'Server-listed Pay-Switch package from ClawHunt product catalog.',
                      zh: '来自 ClawHunt 产品目录的 Pay-Switch 服务端列表项。',
                    },
                    category: 'featured',
                    category_label: { en: 'Featured', zh: '推荐' },
                    icon: 'commerce',
                    runtime: 'mcp_sidecar',
                    pricing_model: 'private_beta',
                    verified: true,
                    entitlement_required: true,
                    featured: true,
                  },
                ],
                error: null,
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return baseFetch(input, init);
        });
        vi.stubGlobal('fetch', fetchWrapper);

        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: 'Open Capability Workshop' }));

        const paySwitchLabel = (await screen.findAllByText('Pay-Switch Agent')).find((item) =>
          item.closest('article')?.textContent?.includes('Server-listed Pay-Switch package from ClawHunt product catalog.'),
        );
        expect(paySwitchLabel).toBeDefined();
        const paySwitchCard = paySwitchLabel!.closest('article') as HTMLElement;
        expect(within(paySwitchCard).getByText('Server-listed Pay-Switch package from ClawHunt product catalog.')).toBeInTheDocument();
        // Catalog precedence: the server entry wins, so the GitHub/mock variants
        // never render (their names/source labels are absent from the list).
        expect(screen.queryAllByText('GitHub Scanner')).toHaveLength(0);
        expect(screen.queryAllByText('Mock catalog')).toHaveLength(0);
        // The source label moved to the detail sub-page — open it and confirm the
        // server-catalog provenance is surfaced there.
        fireEvent.click(within(paySwitchCard).getByRole('button', { name: /^View details:/ }));
        expect(await screen.findByText('Server catalog')).toBeInTheDocument();
      });

      it('installs a workshop capability via the neutral /api/capabilities/install (not "coming soon")', async () => {
        // A published workshop card (source=server) whose id is in the neutral
        // /api/capabilities/distribution kit must offer a REAL install (POST
        // /api/capabilities/install -> Node S4), NOT the discovery-only "coming soon" gate.
        const baseFetch = global.fetch;
        const fetchWrapper = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const path = requestPath(input);
          if (path === '/api/plugins/workshop-catalog') {
            return new Response(
              JSON.stringify({
                source: 'clawhunt_workshop',
                total: 1,
                plugins: [
                  {
                    plugin_id: 'dev.leon.text-stats',
                    version: '1.0.0',
                    name: { en: 'Text Stats', zh: 'Text Stats' },
                    summary: { en: 'Deterministic word and character counts.', zh: 'Deterministic word and character counts.' },
                    kind: 'plugin',
                    category: 'plugin',
                    category_label: { en: 'Plugin', zh: '插件' },
                    icon: 'runtime',
                    runtime: 'mcp_sidecar',
                    pricing_model: 'free',
                    verified: true,
                    trust: 'official',
                    instantiable: true,
                  },
                ],
                error: null,
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (path === '/api/capabilities/distribution') {
            return new Response(
              JSON.stringify({
                capabilities: [{ kind: 'plugin', capability_id: 'dev.leon.text-stats', version: '1.0.0' }],
                r2_configured: true,
                error: null,
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (path === '/api/capabilities/installed') {
            return new Response(JSON.stringify({ capabilities: [], node_available: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (path === '/api/capabilities/install') {
            return new Response(
              JSON.stringify({
                ok: true,
                kind: 'plugin',
                capability_id: 'dev.leon.text-stats',
                version: '1.0.0',
                package_digest: 'sha256:workshoptest',
                outcome: { kind: 'plugin', capabilityId: 'dev.leon.text-stats', version: '1.0.0', nativeId: 'n1', official: true },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return baseFetch(input, init);
        });
        vi.stubGlobal('fetch', fetchWrapper);

        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: 'Open Capability Workshop' }));

        const card = (await screen.findAllByText('Text Stats'))
          .map((node) => node.closest('article'))
          .find((article) => article?.textContent?.includes('Deterministic word and character counts.')) as HTMLElement;
        expect(card).toBeTruthy();

        const installButton = within(card).getByRole('button', { name: 'Install Text Stats' });
        // The card is installable, not discovery-only: the button is enabled.
        expect(installButton).not.toBeDisabled();
        fireEvent.click(installButton);

        await waitFor(() => {
          const calls = vi
            .mocked(fetch)
            .mock.calls.filter(([input]) => requestPath(input as string | URL | Request) === '/api/capabilities/install');
          expect(calls.length).toBeGreaterThan(0);
          const body = JSON.parse(String(calls[0][1]?.body ?? '{}')) as {
            capability_id?: string;
            version?: string;
            kind?: string;
          };
          expect(body.capability_id).toBe('dev.leon.text-stats');
          expect(body.version).toBe('1.0.0');
          expect(body.kind).toBe('plugin');
        });
      });

      it('uninstalls a Node-S4-installed capability via the neutral BFF with origin routing', async () => {
        // A capability landed by the Node store (origin=node-workshop) must surface as installed
        // and its kebab Uninstall must route to POST /api/capabilities/uninstall {origin}, NOT the
        // legacy cache /api/plugins/uninstall (the core origin-routing fix).
        const baseFetch = global.fetch;
        const fetchWrapper = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const path = requestPath(input);
          if (path === '/api/capabilities/installed') {
            return new Response(
              JSON.stringify({
                capabilities: [
                  {
                    origin: 'node-workshop',
                    kind: 'plugin',
                    capability_id: 'node.tool',
                    native_key: 'node.tool',
                    version: '1.0.0',
                    name: 'Node Tool',
                    official: true,
                    configurable: false,
                    uninstallable: true,
                  },
                ],
                node_available: true,
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (path === '/api/capabilities/distribution') {
            return new Response(JSON.stringify({ capabilities: [], r2_configured: true, error: null }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (path === '/api/capabilities/uninstall') {
            return new Response(JSON.stringify({ ok: true, origin: 'node-workshop', native_key: 'node.tool' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return baseFetch(input, init);
        });
        vi.stubGlobal('fetch', fetchWrapper);

        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: 'Open Capability Workshop' }));
        fireEvent.click(await screen.findByRole('tab', { name: 'Overview' }));

        // The Node-installed capability shows as an installed card with an uninstall kebab.
        const kebab = await screen.findByRole('button', { name: /^More actions Node Tool/ });
        fireEvent.click(kebab);
        fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }));

        await waitFor(() => {
          const calls = vi
            .mocked(fetch)
            .mock.calls.filter((c) => requestPath(c[0] as string | URL | Request) === '/api/capabilities/uninstall');
          expect(calls.length).toBeGreaterThan(0);
          const body = JSON.parse(String(calls[0][1]?.body ?? '{}')) as { origin?: string; native_key?: string };
          expect(body.origin).toBe('node-workshop');
          expect(body.native_key).toBe('node.tool');
        });
        // It must NOT have hit the legacy cache uninstall path.
        const cacheCalls = vi
          .mocked(fetch)
          .mock.calls.filter((c) => requestPath(c[0] as string | URL | Request) === '/api/plugins/uninstall');
        expect(cacheCalls.length).toBe(0);
      });

      it('shows PaySwitch Browser Relay heartbeat and user-approved install guidance in plugin config', async () => {
        render(<App />);

        fireEvent.click(await screen.findByRole('button', { name: 'Open Capability Workshop' }));
        expect(await screen.findByRole('heading', { name: 'Capability Workshop' })).toBeInTheDocument();

        const paySwitchLabel = (await screen.findAllByText('Pay-Switch Agent')).find((item) =>
          item.closest('article')?.textContent?.includes('Local payment switch automation with a browser relay'),
        );
        expect(paySwitchLabel).toBeDefined();
        const paySwitchCard = paySwitchLabel!.closest('article') as HTMLElement;
        fireEvent.click(within(paySwitchCard).getByRole('button', { name: 'Install Pay-Switch Agent' }));

        // After install the unified card flips to "use in chat"; Configure (and
        // Uninstall) now live on the capability detail sub-page's manage menu.
        await waitFor(() => {
          expect(within(paySwitchCard).getByRole('button', { name: 'Use in chat Pay-Switch Agent' })).toBeInTheDocument();
        });
        fireEvent.click(within(paySwitchCard).getByRole('button', { name: /^View details: Pay-Switch Agent/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Configure' }));

        const dialog = await screen.findByRole('dialog', { name: 'Pay-Switch Agent' });
        expect(dialog).toBeInTheDocument();
        expect(within(dialog).getByText('chrome_user_data_dir')).toBeInTheDocument();
        expect(within(dialog).getByText('PAY_SWITCH_AGENT_TOKEN')).toBeInTheDocument();
        const relayPanel = await screen.findByLabelText('PaySwitch Browser Relay status');
        expect(within(relayPanel).getByText('connected')).toBeInTheDocument();
        expect(within(relayPanel).getByText('payswitch-ext-real')).toBeInTheDocument();
        expect(within(relayPanel).getByText(/http:\/\/127\.0\.0\.1:8787/)).toBeInTheDocument();
        expect(within(relayPanel).getByText(/v0\.1\.3/)).toBeInTheDocument();
        expect(within(relayPanel).getByText(/MV3/)).toBeInTheDocument();

        fireEvent.click(within(dialog).getAllByRole('button', { name: 'Install Browser Relay' })[0]);
        expect(
          await screen.findByText('/Users/leongong/Documents/payswitch/payswitch/browser_extension'),
        ).toBeInTheDocument();
        expect(await screen.findByText(/relay token ready in PaySwitch/)).toBeInTheDocument();
        expect(screen.queryByText('secret-relay-token')).not.toBeInTheDocument();

        await waitFor(() => {
          const actionBodies = vi.mocked(fetch).mock.calls
            .filter(([input]) => requestPath(input as string | URL | Request) === '/api/plugins/dev.clawhunt.pay-switch-agent/configuration/action')
            .map(([, init]) => JSON.parse(String(init?.body ?? '{}')) as { action_id?: string });
          expect(actionBodies.some((body) => body.action_id === 'extension_status')).toBe(true);
          expect(actionBodies.some((body) => body.action_id === 'extension_install')).toBe(true);
        });
      });




  it('redirects the unsigned account shortcut through the main-site SSO bridge without collecting a password', async () => {
    vi.mocked(window.open).mockReturnValue({} as Window);
    render(<App />);

    await openSettingsWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Account' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Logout ClawHunt' }));
    expect(await screen.findByText('Not signed in')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Back to app' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open account menu' }));
    const accountMenu = await screen.findByLabelText('Account menu');
    const accountShortcut = within(accountMenu).getByRole('button', { name: 'Sign in ClawHunt account' });
    expect(within(accountShortcut).getByText('local-user')).toBeInTheDocument();
    expect(within(accountShortcut).getByText('ClawHunt unset')).toBeInTheDocument();
    expect(within(accountMenu).getByRole('button', { name: 'Open settings workspace' })).toBeInTheDocument();
    expect(within(accountMenu).getByRole('button', { name: 'Login' })).toBeInTheDocument();

    fireEvent.click(accountShortcut);

    expect(screen.queryByLabelText('ClawHunt username')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('ClawHunt password')).not.toBeInTheDocument();
    expect(latestClawHuntAccountLoginRequest).toBeNull();
    expect(window.open).toHaveBeenCalledOnce();
    const [bridgeUrl, target] = vi.mocked(window.open).mock.calls[0]!;
    const parsed = new URL(String(bridgeUrl));
    expect(parsed.origin).toBe('https://clawhunt.store');
    expect(parsed.pathname).toBe('/cn-auth-bridge.html');
    expect(parsed.searchParams.get('return_to')).toBe(window.location.href);
    expect(target).toBe('_self');
  });

  it('captures a main-site callback token, verifies it, scrubs the URL, and displays the identity', async () => {
    const baseFetch = global.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestPath(input) === '/gateway-api/auth/me') {
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer signed.jwt.token');
          return new Response(
            JSON.stringify({
              id: 42,
              username: 'sso-alice',
              email: 'alice@example.test',
              avatar_url: 'https://example.test/sso-avatar.png',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return baseFetch(input, init);
      }),
    );
    window.history.replaceState(
      null,
      '',
      '/#panel=chat&clawhunt_sso_token=signed.jwt.token',
    );
    render(<App />);

    await waitFor(() =>
      expect(localStorage.getItem(CLAWHUNT_SSO_STORAGE_KEY)).toBe('signed.jwt.token'),
    );
    expect(window.location.hash).toBe('#panel=chat');
    fireEvent.click(await screen.findByRole('button', { name: 'Open account menu' }));
    const accountMenu = await screen.findByLabelText('Account menu');
    expect(await within(accountMenu).findByText('sso-alice')).toBeInTheDocument();
    expect(within(accountMenu).getByText('ClawHunt linked')).toBeInTheDocument();
    expect(within(accountMenu).queryByRole('button', { name: 'Login' })).not.toBeInTheDocument();
  });

  it('clears an expired stored SSO token without deleting an existing runtime agent key', async () => {
    localStorage.setItem(CLAWHUNT_SSO_STORAGE_KEY, 'expired.jwt.token');
    const baseFetch = global.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestPath(input) === '/gateway-api/auth/me') {
          return new Response(JSON.stringify({ detail: 'ClawHunt session is invalid' }), {
            status: 401,
          });
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    await waitFor(() => expect(localStorage.getItem(CLAWHUNT_SSO_STORAGE_KEY)).toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: 'Open account menu' }));
    const accountMenu = await screen.findByLabelText('Account menu');
    expect(within(accountMenu).getByText('agent-01')).toBeInTheDocument();
    expect(within(accountMenu).getByRole('button', { name: 'Login' })).toBeInTheDocument();
  });

  it('routes settings login directly through the SSO bridge without rendering credentials', async () => {
    vi.mocked(window.open).mockReturnValue({} as Window);
    render(<App />);
    await openSettingsWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Account' }));
    // Drop the manual agent key so the panel offers its single Sign-in entry.
    fireEvent.click(await screen.findByRole('button', { name: 'Logout ClawHunt' }));
    const signIn = await screen.findByRole('button', { name: 'Sign in to ClawHunt' });

    // No SuperClaw surface receives a main-site username or password.
    expect(screen.queryByLabelText('ClawHunt username')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('ClawHunt password')).not.toBeInTheDocument();

    fireEvent.click(signIn);
    expect(window.open).toHaveBeenCalledOnce();
    expect(String(vi.mocked(window.open).mock.calls[0]![0])).toContain(
      'https://clawhunt.store/cn-auth-bridge.html?return_to=',
    );
    expect(vi.mocked(window.open).mock.calls[0]![1]).toBe('_self');
  });

  it('shows a three-state Account identity without the advanced connection disclosure', async () => {
    render(<App />);
    await openSettingsWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Account' }));

    // Default fixture = agent key set, no account → the "agent-key-only" escape
    // hatch (badge Limited), not a bare signed-out/in state.
    expect(await screen.findByText('Agent key linked')).toBeInTheDocument();
    expect(screen.getByText('Limited')).toBeInTheDocument();

    // The advanced (agent-key / login-server) disclosure was removed entirely — the
    // raw connection fields it held no longer render on the Account card.
    expect(screen.queryByText('Connection details')).not.toBeInTheDocument();
    expect(screen.queryByText('ClawHunt advanced')).not.toBeInTheDocument();
    expect(
      screen.queryByText((_, el) => el?.textContent?.startsWith('Base URL:') ?? false),
    ).not.toBeInTheDocument();

    // Logging out clears the key too → the not-signed-in state (badge Required).
    fireEvent.click(await screen.findByRole('button', { name: 'Logout ClawHunt' }));
    expect(await screen.findByText('Not signed in')).toBeInTheDocument();
    expect(screen.getByText('Required')).toBeInTheDocument();
  });

  it('renders global token usage on the SuperClaw account settings page without company filters', async () => {
    render(<App />);
    await openSettingsWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Account' }));

    const tokenCard = await screen.findByRole('article', { name: 'Token usage' });
    expect(within(tokenCard).getByText('Lifetime tokens')).toBeInTheDocument();
    expect(within(tokenCard).getByText('Range tokens')).toBeInTheDocument();
    expect(within(tokenCard).getByText('Peak tokens')).toBeInTheDocument();
    expect(within(tokenCard).getByText('Token activity')).toBeInTheDocument();
    expect(within(tokenCard).getByRole('radio', { name: 'Daily' })).toBeChecked();
    expect(within(tokenCard).getByRole('radio', { name: 'Weekly' })).toBeInTheDocument();
    expect(within(tokenCard).getByRole('radio', { name: 'Yearly' })).toBeInTheDocument();
    expect(within(tokenCard).queryByRole('radio', { name: 'Month' })).not.toBeInTheDocument();
    expect(within(tokenCard).queryByRole('radio', { name: '7D' })).not.toBeInTheDocument();

    fireEvent.click(within(tokenCard).getByRole('radio', { name: 'Weekly' }));
    await waitFor(() => {
      const costUrls = vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => requestPath(input as string | URL | Request).startsWith('/api/cost/'))
        .map(([input]) => {
          const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          return new URL(raw, 'http://127.0.0.1');
        });
      expect(costUrls.some((url) => url.pathname === '/api/cost/summary')).toBe(true);
      expect(costUrls.some((url) => url.pathname === '/api/cost/events' && url.searchParams.has('since'))).toBe(true);
      expect(costUrls.some((url) => url.searchParams.has('company'))).toBe(false);
    });
  });

  it('renders the signed-in account header with avatar, name and email', async () => {
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestPath(input) === '/api/auth/status') {
          return new Response(
            JSON.stringify({
              clawhunt: {
                account: 'set',
                agent_api_key: 'set',
                base_url: 'https://clawhunt.store',
                account_user: {
                  username: 'leon',
                  email: 'leon@example.test',
                  avatar_url: 'https://example.test/avatar.png',
                },
                agent_key_source: 'account',
                agent_key_name: 'ClawHunt Desktop',
                account_source: 'clawhunt_google_browser',
                login_source: 'superclaw',
                logout_url: '/api/auth/clawhunt/logout',
                profile_url: '/api/auth/clawhunt/me',
                login_url: '/api/auth/clawhunt/login',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (requestPath(input) === '/api/relay/account') {
          // Admin account (the owner's real case): no purchased card-pack
          // (billing_plan null) but unlimited via the admin bypass. The panel must
          // show package "Not subscribed" + entitlement "Pro · unlimited · admin",
          // never conflate the bypass with a purchase; quota=0 → no progress bar.
          return new Response(
            JSON.stringify({
              ok: true,
              logged_in: true,
              billing_plan: null,
              entitlement: 'unlimited',
              entitlement_source: 'admin',
              unlimited: true,
              free_chats_remaining: -1,
              free_chat_limit: 3,
              chat_credits: 50,
              relay: {
                ok: true,
                account_balance: 8.07,
                key_credits_used: 0,
                key_quota_limit: 0,
                currency: 'USD',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    await openSettingsWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Account' }));

    const card = (await screen.findByText('ClawHunt login')).closest('article') as HTMLElement;
    // Signed-in account header: "Signed in" badge + name + email + avatar image.
    expect(within(card).getByText('Signed in')).toBeInTheDocument();
    expect(within(card).getByText('leon')).toBeInTheDocument();
    expect(within(card).getByText('leon@example.test')).toBeInTheDocument();
    const avatar = card.querySelector('img.account-avatar') as HTMLImageElement | null;
    expect(avatar).not.toBeNull();
    expect(avatar?.getAttribute('src')).toBe('https://example.test/avatar.png');
    // Account info is distinct-sourced: purchased package vs effective entitlement vs
    // self-funded relay. Admin = "Not subscribed" package + "Pro · unlimited" (admin).
    expect(within(card).getByText('Current package')).toBeInTheDocument();
    expect(await within(card).findByText('Not subscribed')).toBeInTheDocument();
    expect(within(card).getByText('Entitlement')).toBeInTheDocument();
    expect(within(card).getByText('Pro · unlimited')).toBeInTheDocument(); // entitlement leaf
    expect(within(card).getByText('· admin')).toBeInTheDocument(); // source leaf
    // quota=0 → unlimited text, no progress bar; relay balance shown as self-funded.
    expect(within(card).queryByRole('progressbar')).not.toBeInTheDocument();
    expect(within(card).getByText('Relay balance')).toBeInTheDocument();
    expect(within(card).getByText('· self-funded')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('never renders a main-site credential form on account surfaces', async () => {
    render(<App />);
    await openSettingsWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Account' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Logout ClawHunt' }));
    expect(screen.queryByLabelText('ClawHunt username')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('ClawHunt password')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Sign in to ClawHunt' })).not.toBeInTheDocument();
  });

  it('uses the desktop loopback browser handoff instead of returning the SSO fragment to tauri://', async () => {
    let desktopOpenedUrl = '';
    const invokeMock = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'desktop_shell_info') {
        return {
          productName: 'ClawHunt',
          version: '0.1.0',
          releaseChannel: 'beta',
          updateMode: 'manual',
          workspaceRoot: '/Users/leongong/Documents/superClaw',
          webDevUrl: 'http://127.0.0.1:5173',
          webDistPath: '/Users/leongong/Documents/superClaw/apps/web/dist',
          cliExecutable: '/Users/leongong/Documents/superClaw/.venv/bin/superclaw',
          updateGuidePath: '/Users/leongong/Documents/superClaw/docs/desktop-manual-update.md',
          workspaceUpdateCommand:
            'git pull --ff-only && .venv/bin/python -m pip install -e ".[dev,tui]" && npm install --prefix apps/web && npm install --prefix apps/desktop && npm run build --prefix apps/web && npm run tauri:build --prefix apps/desktop',
        };
      }
      if (command === 'desktop_runtime_start') {
        return {
          ok: true,
          handle: {
            base_url: 'http://127.0.0.1:9988',
            control_token: 'desktop-secret',
            state_path: '.superclaw/state.db',
            owned: true,
            pid: 8123,
          },
          status: null,
        };
      }
      if (command === 'desktop_set_window_theme') {
        return { ok: true, theme: (args?.request as { theme?: string } | undefined)?.theme ?? 'system' };
      }
      if (command === 'desktop_open_external_url') {
        desktopOpenedUrl = String((args?.request as { url?: string } | undefined)?.url ?? '');
        return { ok: true, url: desktopOpenedUrl };
      }
      throw new Error(`Unhandled invoke command: ${command}`);
    });
    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: { core: { invoke: invokeMock } },
    });
    localStorage.setItem('superclaw_agent_onboarding_dismissed', '1');

    render(<App />);

    await openSettingsWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Account' }));
    // Drop the manual agent key so the settings panel offers the Sign-in entry.
    // The web-only fragment bridge cannot navigate back into a packaged Tauri
    // webview. Desktop must use its existing state-bound loopback callback flow.
    fireEvent.click(await screen.findByRole('button', { name: 'Logout ClawHunt' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to ClawHunt' }));

    await waitFor(() => expect(desktopOpenedUrl).toBe(openedClawHuntLoginUrl));
    expect(latestClawHuntBrowserLoginProvider).toBe('website');
    expect(window.open).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith('desktop_open_external_url', {
      request: { url: desktopOpenedUrl },
    });
    const callback = new URL(desktopOpenedUrl).searchParams.get('redirect_uri');
    expect(callback).toContain('http://127.0.0.1:43123/api/auth/clawhunt/browser/callback');
    expect(callback).not.toContain('tauri://');
  });

  it('switches the shell chrome between English and Chinese', async () => {
    render(<App />);

    await openSettingsWorkspace();
    expect(await screen.findByLabelText('Language')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('radio', { name: 'Switch language to Chinese' }));

    expect(await screen.findByRole('button', { name: '新建会话' })).toBeInTheDocument();
    expect(await screen.findByText('能力工坊')).toBeInTheDocument();
    expect(await screen.findByText('最近会话')).toBeInTheDocument();
    expect(localStorage.getItem('superclaw_locale')).toBe('zh');

    expect(await screen.findByRole('heading', { name: '偏好' })).toBeInTheDocument();
    expect(await screen.findByLabelText('设置导航')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '返回应用' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '诊断' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'MCP 服务器' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '个人资料' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '运行时' }));
    expect(await screen.findByRole('heading', { name: 'Agent 与执行' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '返回应用' }));
    expect(await screen.findByRole('heading', { name: '和 ClawHunt 一起做点什么？' })).toBeInTheDocument();
    expect(await screen.findByPlaceholderText('询问 ClawHunt，或直接描述你要做的任务...')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: '打开能力工坊' }));
    expect(await screen.findByRole('heading', { name: '能力工坊' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '让 ClawHunt 按你的方式工作' })).toBeInTheDocument();
    expect(await screen.findAllByLabelText('搜索插件')).not.toHaveLength(0);
    expect(await screen.findByRole('button', { name: '全部' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '我要创建' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '本地已安装' })).toBeInTheDocument();
    expect(screen.queryByText('已缓存插件')).not.toBeInTheDocument();
    expect(screen.queryAllByLabelText('Local plugin package path')).toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: '管理' }));
    fireEvent.click((await screen.findAllByText('高级插件运维')).at(-1)!);
    expect(await screen.findByText('已缓存插件')).toBeInTheDocument();
    expect(await screen.findByText('注册表搜索')).toBeInTheDocument();
    expect(await screen.findByText('本地验证安装')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '返回主菜单' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '返回主菜单' }));

    fireEvent.click(await screen.findByRole('button', { name: '打开账号菜单' }));
    expect(screen.queryByLabelText('语言')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '打开设置工作区' }));
    fireEvent.click(await screen.findByRole('radio', { name: '切换到英文' }));
    expect(await screen.findByRole('button', { name: 'New Session' })).toBeInTheDocument();
    expect(localStorage.getItem('superclaw_locale')).toBe('en');
  });

  it('persists and applies appearance settings from the settings workspace', async () => {
    render(<App />);

    await openSettingsWorkspace();
    expect(await screen.findByText('Appearance settings')).toBeInTheDocument();
    // The "follow system" option was removed — appearance is now a fixed light/dark choice.
    expect(screen.queryByRole('radio', { name: 'Use system appearance' })).not.toBeInTheDocument();
    // With no stored preference the surface seeds once from the OS appearance (light in
    // the test environment), so Light starts active.
    expect(await screen.findByRole('radio', { name: 'Use light appearance' })).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.dataset.theme).toBe('light');

    fireEvent.click(await screen.findByRole('radio', { name: 'Use dark appearance' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    expect(localStorage.getItem('superclaw_theme')).toBe('dark');
    expect(await screen.findByRole('radio', { name: 'Use dark appearance' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(await screen.findByRole('radio', { name: 'Use light appearance' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(localStorage.getItem('superclaw_theme')).toBe('light');
    expect(await screen.findByRole('radio', { name: 'Use light appearance' })).toHaveAttribute('aria-checked', 'true');
  });

  it('opens the color-scheme editor in a dialog with the custom-colors editor behind an Advanced disclosure', async () => {
    render(<App />);
    const fetchMock = vi.mocked(fetch);
    await openSettingsWorkspace();

    // The heavy preset/token grid is NOT rendered inline — it lives behind a trigger
    // button beside the Light/Dark control, so the Preferences page stays a clean list.
    expect(await screen.findByText('Appearance settings')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Color scheme presets' })).not.toBeInTheDocument();

    // Launch the focused modal from the palette button in the Appearance row.
    fireEvent.click(await screen.findByRole('button', { name: 'Customize color scheme' }));

    const dialog = await screen.findByRole('dialog', { name: 'Color scheme' });
    expect(within(dialog).getByRole('radiogroup', { name: 'Color scheme presets' })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Default/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Custom/ })).toBeInTheDocument();

    // The per-token editor starts COLLAPSED behind the Advanced disclosure — the default
    // view is just the constrained preset list, not the full token grid.
    const advanced = within(dialog).getByText('Advanced — custom colors').closest('details');
    expect(advanced).not.toHaveAttribute('open');

    // Expanding it reveals the editable token (a real toggle, driven by React state).
    fireEvent.click(within(dialog).getByText('Advanced — custom colors'));
    expect(advanced).toHaveAttribute('open');
    expect(within(dialog).getByText('Accent')).toBeInTheDocument();

    // "Reset to default" is a TRUE reset: it persists the stock default preset AND clears
    // the whole custom palette by sending `custom: {}` (kernel normalizes against its own
    // canvas list — no hardcoded light/dark on the web side).
    fireEvent.click(within(dialog).getByRole('button', { name: /Reset to default/ }));
    await waitFor(() => {
      const resetCall = fetchMock.mock.calls.find(
        ([input, init]) => requestPath(input) === '/api/appearance/set' && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(resetCall).toBeTruthy();
      const body = JSON.parse((resetCall![1] as RequestInit).body as string);
      expect(body.active_preset).toBe('default');
      expect(body.custom).toEqual({});
    });

    // Dismissable through the shared dialog shell's close button; reopening starts fresh
    // (the dialog unmounts on close, so the Advanced disclosure does not leak its open state).
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Color scheme' })).not.toBeInTheDocument());

    fireEvent.click(await screen.findByRole('button', { name: 'Customize color scheme' }));
    const reopened = await screen.findByRole('dialog', { name: 'Color scheme' });
    expect(within(reopened).getByText('Advanced — custom colors').closest('details')).not.toHaveAttribute('open');
  });

  it('migrates a legacy stored "system" theme to a concrete light/dark choice', async () => {
    // A user who saved the now-removed "follow system" mode must not get stuck re-sampling
    // the OS on every reload: the legacy value is treated as no preference, seeded once to
    // a concrete light/dark (light in the test env) and persisted back.
    localStorage.setItem('superclaw_theme', 'system');

    render(<App />);
    await openSettingsWorkspace();

    expect(await screen.findByText('Appearance settings')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Use system appearance' })).not.toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: 'Use light appearance' })).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.dataset.theme).toBe('light');
    // The legacy 'system' value is overwritten with the concrete seed, so it never survives.
    await waitFor(() => expect(localStorage.getItem('superclaw_theme')).toBe('light'));
  });

  it('lists every recent chat without truncating the sidebar', async () => {
    additionalChatSessions = Array.from({ length: 30 }, (_, index) => ({
      session_id: `overflow_session_${index}`,
      title: `Overflow persisted session ${index}`,
      created_at: 1780670000 + index,
      updated_at: 1780670000 + index,
      messages: [{ role: 'user', content: `overflow ${index}`, created_at: 1780670000 + index }],
      metadata: {},
    }));

    render(<App />);

    expect(await screen.findByRole('button', { name: 'Open chat session Overflow persisted session 0' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Open chat session Overflow persisted session 29' })).toBeInTheDocument();
  });

  it('renders the sidebar running animation only from liveness-backed activity, never from message shape', async () => {
    additionalChatSessions = [
      {
        session_id: 'session_ghost',
        title: 'Ghost tail session',
        created_at: 1780669000,
        updated_at: 1780669050,
        // Transcript ends in a user message — the historical forever-spinner shape.
        messages: [{ role: 'user', content: '你是什么模型', created_at: 1780669000 }],
        metadata: {},
        activity: {
          status: 'interrupted',
          is_live: false,
          run_id: null,
          effective_run_status: null,
          reason: 'turn ended without an assistant reply and no run backs it',
          legacy_incomplete_tail: true,
        },
      },
      {
        session_id: 'session_live',
        title: 'Live activity session',
        created_at: 1780669000,
        updated_at: 1780669200,
        messages: [{ role: 'user', content: 'do work', created_at: 1780669000 }],
        metadata: {},
        activity: {
          status: 'live',
          is_live: true,
          run_id: 'run_live',
          effective_run_status: 'running',
          reason: null,
          legacy_incomplete_tail: false,
        },
      },
      {
        session_id: 'session_stopped_stale_live',
        title: 'Stopped stale live session',
        created_at: 1780669000,
        updated_at: 1780669300,
        // Stop updates the visible transcript immediately; the sidebar must not
        // keep animating if the next session-list payload still says live.
        messages: [
          { role: 'user', content: 'stop this', created_at: 1780669000 },
          { role: 'assistant', content: 'Stopped', status: 'stopped', created_at: 1780669300 },
        ],
        metadata: {},
        activity: {
          status: 'live',
          is_live: true,
          run_id: 'run_stale_live',
          effective_run_status: 'running',
          reason: null,
          legacy_incomplete_tail: false,
        },
      },
      {
        session_id: 'session_legacy_payload',
        title: 'Legacy payload session',
        created_at: 1780669000,
        updated_at: 1780669010,
        // Old backend payload without activity: no liveness proof, no spinner.
        messages: [{ role: 'user', content: 'dangling turn', created_at: 1780669000 }],
        metadata: {},
      },
    ];

    render(<App />);

    const ghostButton = await screen.findByRole('button', { name: 'Open chat session Ghost tail session' });
    expect(ghostButton.querySelector('.sidebar-session-running-mark')).toBeNull();
    expect(within(ghostButton).getByText(/^(now|unknown age|\d+[mhd])$/)).toBeInTheDocument();

    const legacyButton = await screen.findByRole('button', { name: 'Open chat session Legacy payload session' });
    expect(legacyButton.querySelector('.sidebar-session-running-mark')).toBeNull();

    const stoppedStaleLiveButton = await screen.findByRole('button', {
      name: 'Open chat session Stopped stale live session',
    });
    expect(stoppedStaleLiveButton.querySelector('.sidebar-session-running-mark')).toBeNull();

    const liveButton = await screen.findByRole('button', { name: 'Open chat session Live activity session' });
    const liveMark = liveButton.querySelector('.sidebar-session-running-mark') as HTMLElement;
    expect(liveMark).toBeTruthy();
    expect(liveMark.querySelector('.superclaw-loading-mark-animated source')?.getAttribute('srcset')).toBe('/superclaw-pincer-loader.webp');
    expect(liveMark.querySelector('.superclaw-loading-mark-animated img')?.getAttribute('src')).toBe('/superclaw-pincer-loader.png');
  });

  it('groups sidebar sessions by workspace with an Inbox for legacy ones and disables untrusted groups', async () => {
    workspacesInventory = [
      {
        workspace_id: 'workspace_proj',
        name: 'superclaw',
        kind: 'repo',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '/tmp/superclaw',
        builtin_chat: false,
        session_count: 1,
      },
      {
        workspace_id: 'workspace_frozen',
        name: 'frozen-proj',
        kind: 'repo',
        trust_status: 'quarantined',
        is_trusted: false,
        repo_path: '/tmp/frozen',
        builtin_chat: false,
        session_count: 1,
      },
    ];
    additionalChatSessions = [
      {
        session_id: 'session_grouped',
        title: 'Grouped session',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [{ role: 'user', content: 'hello', created_at: 1780669000 }],
        metadata: {},
        workspace_id: 'workspace_proj',
      },
      {
        session_id: 'session_frozen',
        title: 'Frozen session',
        created_at: 1780669000,
        updated_at: 1780669280,
        messages: [{ role: 'user', content: 'hi', created_at: 1780669000 }],
        metadata: {},
        workspace_id: 'workspace_frozen',
      },
    ];

    render(<App />);

    // workspace group renders its sessions under the workspace name
    const projGroup = await screen.findByLabelText('superclaw');
    expect(within(projGroup as HTMLElement).getByRole('button', { name: 'Open chat session Grouped session' })).toBeEnabled();

    // legacy/unassigned sessions (session_demo has no workspace_id) land in the
    // flat "Chats" section (PR-C renamed Inbox → Chats)
    const inbox = await screen.findByLabelText('Chats');
    expect(
      within(inbox as HTMLElement).getByRole('button', { name: 'Open chat session Backend persisted session' }),
    ).toBeInTheDocument();

    // a non-trusted workspace shows the trust badge and its sessions are not openable
    const frozenGroup = await screen.findByLabelText('frozen-proj');
    expect(within(frozenGroup as HTMLElement).getByText('Trust required')).toBeInTheDocument();
    expect(
      within(frozenGroup as HTMLElement).getByRole('button', { name: 'Open chat session Frozen session' }),
    ).toBeDisabled();
  });

  it('renders an empty project group (with its new-chat +) when a project has no sessions yet', async () => {
    workspacesInventory = [
      {
        workspace_id: 'workspace_idle',
        name: 'idle-proj',
        kind: 'repo',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '/tmp/idle',
        builtin_chat: false,
        session_count: 0,
      },
    ];

    render(<App />);

    // legacy/unassigned sessions still land in the flat "Chats" section
    const inbox = await screen.findByLabelText('Chats');
    expect(
      within(inbox as HTMLElement).getByRole('button', { name: 'Open chat session Backend persisted session' }),
    ).toBeInTheDocument();
    // a freshly created project shows up immediately (even with zero chats) so
    // its "+" — the only way to open a chat inside it — stays reachable
    const idleGroup = await screen.findByLabelText('idle-proj');
    expect(
      within(idleGroup as HTMLElement).getByRole('button', { name: 'New chat in this project: idle-proj' }),
    ).toBeInTheDocument();
  });

  it('floats pinned chats and pinned project groups into a top Pinned zone', async () => {
    workspacesInventory = [
      {
        workspace_id: 'workspace_pinned',
        name: 'pinned-proj',
        kind: 'repo',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '/tmp/pinned',
        builtin_chat: false,
        session_count: 1,
        pinned: true,
        pinned_at: 1780669700,
      },
      {
        workspace_id: 'workspace_plain',
        name: 'plain-proj',
        kind: 'repo',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '/tmp/plain',
        builtin_chat: false,
        session_count: 1,
      },
    ];
    additionalChatSessions = [
      {
        session_id: 'session_pinned',
        title: 'Pinned chat',
        created_at: 1780669000,
        updated_at: 1780669400,
        messages: [{ role: 'user', content: 'hi', created_at: 1780669000 }],
        metadata: {},
        pinned_at: 1780669800,
      },
      {
        session_id: 'session_plain_ws',
        title: 'Plain ws chat',
        created_at: 1780669000,
        updated_at: 1780669200,
        messages: [{ role: 'user', content: 'hi', created_at: 1780669000 }],
        metadata: {},
        workspace_id: 'workspace_plain',
      },
    ];

    render(<App />);

    // A pinned loose chat lives in the top zone…
    const pinnedZone = await screen.findByLabelText('Pinned');
    expect(within(pinnedZone as HTMLElement).getByRole('button', { name: 'Open chat session Pinned chat' })).toBeInTheDocument();
    // …and a pinned workspace floats its whole group into the zone.
    expect(within(pinnedZone as HTMLElement).getByLabelText('pinned-proj')).toBeInTheDocument();
    // The pinned chat is NOT duplicated in the flat Chats list (it moved, not copied).
    const inbox = await screen.findByLabelText('Chats');
    expect(within(inbox as HTMLElement).queryByRole('button', { name: 'Open chat session Pinned chat' })).toBeNull();
    // A non-pinned project stays under Projects, never in the zone.
    const projects = await screen.findByLabelText('Projects');
    expect(within(projects as HTMLElement).getByLabelText('plain-proj')).toBeInTheDocument();
    expect(within(pinnedZone as HTMLElement).queryByLabelText('plain-proj')).toBeNull();
  });

  it('pins a chat from its hover action and floats it into the Pinned zone', async () => {
    // A workspace inventory (even just the built-in Chat home) is what switches the
    // sidebar from the legacy flat list to the grouped layout that owns the zone.
    workspacesInventory = [
      {
        workspace_id: 'workspace_chat',
        name: 'Chat',
        kind: 'managed',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '',
        builtin_chat: true,
        session_count: 0,
      },
    ];
    additionalChatSessions = [
      {
        session_id: 'session_topin',
        title: 'Pin me',
        created_at: 1780669000,
        updated_at: 1780669400,
        messages: [{ role: 'user', content: 'hi', created_at: 1780669000 }],
        metadata: {},
      },
    ];

    render(<App />);

    // No pinned zone yet; the chat is in the flat list.
    const row = await screen.findByRole('button', { name: 'Open chat session Pin me' });
    expect(screen.queryByLabelText('Pinned')).toBeNull();
    // Click the row's own Pin action (scoped to its wrapper to avoid the sibling
    // session's Pin button).
    const wrap = row.closest('.sidebar-session-wrap') as HTMLElement;
    fireEvent.click(within(wrap).getByRole('button', { name: 'Pin' }));

    // It floats into the Pinned zone after the optimistic flip + refetch.
    const pinnedZone = await screen.findByLabelText('Pinned');
    await waitFor(() =>
      expect(within(pinnedZone as HTMLElement).getByRole('button', { name: 'Open chat session Pin me' })).toBeInTheDocument(),
    );
  });

  it('exposes pin/rename/remove on a project right-click menu and confirms a non-destructive removal', async () => {
    workspacesInventory = [
      {
        workspace_id: 'workspace_ctx',
        name: 'ctx-proj',
        kind: 'repo',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '/tmp/ctx',
        builtin_chat: false,
        session_count: 0,
      },
    ];

    render(<App />);

    const group = await screen.findByLabelText('ctx-proj');
    const head = group.querySelector('.sidebar-workspace-head') as HTMLElement;
    fireEvent.contextMenu(head);

    // The workspace menu offers pin / rename / remove (reveal-in-Finder is
    // desktop-only and absent in the web test environment).
    expect(await screen.findByRole('menuitem', { name: 'Pin project' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Rename project' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));

    // The confirm dialog states the non-destructive semantics the owner asked for.
    expect(await screen.findByText(/files on disk are NOT deleted/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    // DELETE removes it from the registry → the group disappears after the refetch.
    await waitFor(() => expect(screen.queryByLabelText('ctx-proj')).toBeNull());
  });

  it('collapses a top-level section (Projects) from its header chevron', async () => {
    workspacesInventory = [
      {
        workspace_id: 'workspace_sec',
        name: 'sec-proj',
        kind: 'repo',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '/tmp/sec',
        builtin_chat: false,
        session_count: 1,
      },
    ];
    additionalChatSessions = [
      {
        session_id: 'session_sec',
        title: 'Sectioned chat',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [{ role: 'user', content: 'hi', created_at: 1780669000 }],
        metadata: {},
        workspace_id: 'workspace_sec',
      },
    ];

    render(<App />);

    // Section starts expanded — the project group is visible.
    expect(await screen.findByLabelText('sec-proj')).toBeInTheDocument();
    // Click the Projects section header toggle → the whole section collapses.
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse group: Projects' }));
    await waitFor(() => expect(screen.queryByLabelText('sec-proj')).toBeNull());
    // The toggle now offers to expand again (state flipped + persisted).
    expect(screen.getByRole('button', { name: 'Expand group: Projects' })).toBeInTheDocument();
  });

  it('keeps workspace-bound sessions visible in the flat list when the inventory is empty', async () => {
    // /api/workspaces unavailable (inventory empty) must degrade to the flat
    // list WITHOUT dropping sessions that carry a workspace_id.
    workspacesInventory = [];
    additionalChatSessions = [
      {
        session_id: 'session_orphan_group',
        title: 'Workspace-bound session',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [{ role: 'user', content: 'hello', created_at: 1780669000 }],
        metadata: {},
        workspace_id: 'workspace_gone',
      },
    ];

    render(<App />);

    expect(
      await screen.findByRole('button', { name: 'Open chat session Workspace-bound session' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Open chat session Backend persisted session' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Inbox')).toBeNull();
  });

  it('copies a recent chat session id from the sidebar context menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    });
    additionalChatSessions = [
      {
        session_id: 'session_copy_target',
        title: 'Copyable persisted session',
        created_at: 1780671200,
        updated_at: 1780671300,
        messages: [{ role: 'user', content: 'copy this session', created_at: 1780671200 }],
        metadata: {},
      },
    ];

    render(<App />);

    const shell = document.querySelector('main');
    expect(shell).toBeTruthy();
    const blockedEvent = createEvent.contextMenu(shell as HTMLElement, { button: 2, clientX: 400, clientY: 240 });
    fireEvent(shell as HTMLElement, blockedEvent);
    expect(blockedEvent.defaultPrevented).toBe(true);

    const sessionButton = await screen.findByRole('button', { name: 'Open chat session Copyable persisted session' });
    const contextMenuEvent = createEvent.contextMenu(sessionButton, { button: 2, clientX: 120, clientY: 180 });
    fireEvent(sessionButton, contextMenuEvent);

    expect(contextMenuEvent.defaultPrevented).toBe(true);
    const menu = await screen.findByRole('menu', { name: 'Conversation actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy conversation ID' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('session_copy_target'));
    expect(await screen.findByText('conversation ID copied: session_copy_target')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Conversation actions' })).not.toBeInTheDocument());
  });

  it('copies a chat turn and re-edits it back into the composer with its context refs', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    additionalChatSessions = [
      {
        session_id: 'session_turn_actions',
        title: 'Turn actions session',
        created_at: 1780672200,
        updated_at: 1780672300,
        messages: [
          {
            role: 'user',
            content: 'Draft the release notes',
            created_at: 1780672200,
            context_refs: [{ type: 'file', id: 'src/app.ts', label: 'app.ts', visible_token: '@app.ts' }],
          },
          { role: 'assistant', content: 'Here are the release notes.', created_at: 1780672300 },
        ],
        metadata: {},
      },
    ];

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open chat session Turn actions session' }));

    const userTurn = (await waitFor(() => {
      const el = document.querySelector('.chat-turn.user');
      expect(el).toBeTruthy();
      return el;
    })) as HTMLElement;
    expect(within(userTurn).getByText('Draft the release notes')).toBeInTheDocument();

    // Copy writes the turn's exact text to the clipboard and flips to a transient "Copied".
    fireEvent.click(within(userTurn).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Draft the release notes'));
    expect(await within(userTurn).findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    // Re-edit drops the text AND the original context refs back into the composer.
    fireEvent.click(within(userTurn).getByRole('button', { name: 'Edit' }));
    const composer = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;
    await waitFor(() => expect(composer.value).toBe('Draft the release notes'));
    expect(await screen.findByRole('button', { name: 'Remove app.ts' })).toBeInTheDocument();

    // The assistant turn offers Copy but never Edit.
    const assistantTurn = document.querySelector('.chat-turn.assistant') as HTMLElement;
    expect(within(assistantTurn).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(within(assistantTurn).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('lists native skills in the composer @ menu and inserts a @skill:<slug> token (no context ref)', async () => {
    render(<App />);
    const composer = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;

    // Open the `@` menu — the composer fetches /v1/skills on demand (mirrors @company).
    fireEvent.change(composer, { target: { value: '@', selectionStart: 1, selectionEnd: 1 } });

    // The native skill from /v1/skills appears as a selectable option…
    const option = await screen.findByRole('option', { name: /Native Changelog Formatter/ });
    fireEvent.click(option);

    // …and picking it inserts the plain `@skill:<slug>` text token the kernel parses.
    await waitFor(() => expect(composer.value).toContain('@skill:native-changelog'));
    // It is a TEXT token, not a context-ref chip: no "Remove …" chip is rendered for it.
    expect(screen.queryByRole('button', { name: /Remove .*Native Changelog/ })).toBeNull();
  });

  it('unions the Paperclip and Python company lists for the composer @ menu', async () => {
    render(<App />);
    const composer = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: '@', selectionStart: 1, selectionEnd: 1 } });

    const fetchMock = vi.mocked(fetch);
    // The @ menu loads from BOTH company homes (disjoint sets, shown as a union):
    // the Paperclip-native control plane…
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/paperclip-api/companies')).toBe(true),
    );
    // …AND the legacy Python list, so every company is visible regardless of which
    // store created it (board-native or chat/CLI legacy).
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/api/team/companies')).toBe(true),
    );
  });

  it('creates a company natively on Node (POST /companies) when the composer create action is picked', async () => {
    render(<App />);
    const composer = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;
    // A company-ish @ query surfaces the "新建公司" intent suggestion (name hint = query).
    fireEvent.change(composer, { target: { value: '@company', selectionStart: 8, selectionEnd: 8 } });

    const createOption = await screen.findByRole('option', { name: /新建公司/ });
    fireEvent.click(createOption);

    const fetchMock = vi.mocked(fetch);
    // Picking it provisions DIRECTLY on Node (POST /paperclip-api/companies) — the same
    // native endpoint the board uses — NOT a chat turn that would steer the deprecated
    // Python orchestrator delivery run.
    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(
        ([input, init]) => requestPath(input) === '/paperclip-api/companies' && init?.method === 'POST',
      );
      expect(createCall).toBeTruthy();
    });
    // It must NOT have sent a company_create chat turn to /api/chat/stream.
    const chatTurn = fetchMock.mock.calls.find(([input]) => requestPath(input) === '/api/chat/stream');
    expect(chatTurn).toBeFalsy();
  });

  it('runs a chat turn natively inside a Node company (sends company_id, omits the personal session_id)', async () => {
    render(<App />);
    const composer = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;
    // Surface and select the Node-native company (uuid id). The "新建公司" create entry also
    // shows for this query, so match the company option specifically (excludes 新建).
    fireEvent.change(composer, { target: { value: '@NodeCo', selectionStart: 7, selectionEnd: 7 } });
    fireEvent.click(
      await screen.findByRole('option', { name: (name) => name.includes('NodeCo') && !name.includes('新建') }),
    );
    // Send a message.
    fireEvent.change(composer, { target: { value: 'do some work', selectionStart: 12, selectionEnd: 12 } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    // The turn runs natively INSIDE the Node company: company_id is the uuid, and the
    // personal session_id is omitted so the Node engine creates a company-scoped session
    // (sending the personal session_id would make Node look it up inside the wrong company
    // and fail the turn with session_not_found).
    await waitFor(() => expect(latestChatTurnRequest).toBeTruthy());
    expect(latestChatTurnRequest?.company_id).toBe('22222222-2222-4222-8222-222222222222');
    expect(latestChatTurnRequest?.session_id).toBeUndefined();
  });

  it('fails closed (no Python fallback) when Node-native create fails and Node is not explicitly disabled', async () => {
    // POST /companies fails (Paperclip unreachable). The default runtime status carries no
    // node section ⇒ node.enabled is undefined ⇒ NOT an explicit pure-Python deployment, so
    // the create must fail CLOSED — never fall back to the Python kernel path (which would
    // bypass Node governance). Only an explicit node.enabled === false may fall back.
    paperclipUnreachable = true;
    render(<App />);
    const composer = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: '@company', selectionStart: 8, selectionEnd: 8 } });
    fireEvent.click(await screen.findByRole('option', { name: /新建公司/ }));

    // Fail-closed message (NOT the "queued kernel create" fallback message), and the
    // @company:create overlay is NOT attached to the composer (no fallback chip).
    await screen.findByText(/Failed to create|创建公司.*失败|not ready|尚未就绪/);
    expect(screen.queryByText(/queued kernel create|已转内核创建/)).toBeNull();
    expect(composer.value).not.toContain('@company:create');
  });

  it('fails closed (NO Python fallback) when Node-native create is unavailable, even pure-Python', async () => {
    // Even when Node is EXPLICITLY not enabled (pure-Python) and the native create endpoint
    // is unreachable, the chat composer does NOT fall back to the Python kernel create path:
    // attaching the @company:create overlay would route the next send to the deprecated
    // Python orchestrator delivery (Python _has_company_overlay classifies it as delivery),
    // which this surface no longer uses. It fails closed with an "unavailable" message.
    nodeRuntimeDisabled = true;
    paperclipUnreachable = true;
    render(<App />);
    const composer = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) => requestPath(input) === '/api/runtime/status'),
      ).toBe(true),
    );
    fireEvent.change(composer, { target: { value: '@company', selectionStart: 8, selectionEnd: 8 } });
    fireEvent.click(await screen.findByRole('option', { name: /新建公司/ }));

    // Fail-closed message, and NO @company:create overlay queued for Python (no fallback).
    await screen.findByText(/can't create company|暂不能创建公司/);
    expect(screen.queryByText(/queued kernel create|已转内核创建/)).toBeNull();
    expect(composer.value).not.toContain('@company:create');
  });

  it('fails closed (no chat turn) when a legacy Python company is @-selected for a chat turn', async () => {
    render(<App />);
    const composer = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;
    // Surface the legacy company (company_* id) and select it as an @company context ref.
    fireEvent.change(composer, { target: { value: '@legacy', selectionStart: 7, selectionEnd: 7 } });
    fireEvent.click(await screen.findByRole('option', { name: /Legacy Co/ }));
    // Type a message and submit (Enter sends; Shift+Enter would newline).
    fireEvent.change(composer, { target: { value: 'do some work', selectionStart: 12, selectionEnd: 12 } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    // A legacy company has no Node home — the turn MUST NOT be sent to Node (where it would
    // silently run in the default company). No /api/chat/stream call is made.
    const fetchMock = vi.mocked(fetch);
    await screen.findByText(/can't be used in chat yet|暂不能在 chat 中使用/);
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/api/chat/stream')).toBe(false);
  });

  it('still shows the Python company list for the composer @ menu when Paperclip is unreachable', async () => {
    paperclipUnreachable = true;
    render(<App />);
    const composer = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: '@', selectionStart: 1, selectionEnd: 1 } });

    const fetchMock = vi.mocked(fetch);
    // Paperclip 500s ⇒ the union degrades gracefully and still includes the Python
    // companies via /api/team/companies (never blanks the @-menu).
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/api/team/companies')).toBe(true),
    );
  });

  it('falls back to the Python message roll-up for the sidebar badge when Paperclip is unreachable', async () => {
    paperclipUnreachable = true;
    render(<App />);

    const fetchMock = vi.mocked(fetch);
    // The sidebar badge poll prefers Paperclip; when it 500s it falls back to
    // /api/team/messages rather than blanking the count.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/api/team/messages')).toBe(true),
    );
  });

  it('guards an in-progress composer draft when re-editing a chat turn', async () => {
    additionalChatSessions = [
      {
        session_id: 'session_reedit_guard',
        title: 'Re-edit guard session',
        created_at: 1780673200,
        updated_at: 1780673300,
        messages: [{ role: 'user', content: 'Original question', created_at: 1780673200 }],
        metadata: {},
      },
    ];

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open chat session Re-edit guard session' }));
    const userTurn = (await waitFor(() => {
      const el = document.querySelector('.chat-turn.user');
      expect(el).toBeTruthy();
      return el;
    })) as HTMLElement;

    const composer = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'half-written draft' } });
    expect(composer.value).toBe('half-written draft');

    // Decline the overwrite → the draft is preserved, the turn text is NOT loaded.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(within(userTurn).getByRole('button', { name: 'Edit' }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(composer.value).toBe('half-written draft');

    // Accept the overwrite → the turn text replaces the draft.
    confirmSpy.mockReturnValue(true);
    fireEvent.click(within(userTurn).getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(composer.value).toBe('Original question'));
  });

  it('renders the live metering row (token usage + elapsed + completed-ago) the instant a turn ends', async () => {
    // Regression: a just-completed LIVE turn must show the hover meta row WITHOUT
    // waiting for a session reload. The chat.completed event now carries the
    // server-authoritative usage + elapsed_ms, and the turn stamps createdAt from
    // the client clock — so token usage, 用时, and "completed just now" are all
    // present immediately. (The CSS only gates the row's opacity to hover; the
    // element is in the DOM regardless, so the test can assert its content.)
    chatStreamFramesOverride = [
      ['chat.started', { intent: 'chat', session_id: 'session_meter', backend: 'claude' }],
      ['message.delta', { text: 'Metered reply.' }],
      ['message.completed', { text: 'Metered reply.' }],
      [
        'chat.completed',
        {
          intent: 'chat',
          session_id: 'session_meter',
          backend: 'claude',
          status: 'completed',
          response: 'Metered reply.',
          usage: { input_tokens: 4391, output_tokens: 439, cache_read_input_tokens: 35710 },
          elapsed_ms: 12300,
        },
      ],
    ];

    render(<App />);
    const input = await screen.findByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'meter me' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));

    expect(await screen.findByText('Metered reply.')).toBeInTheDocument();
    const meter = await screen.findByTestId('chat-turn-metrics');
    // Always-visible top line: elapsed (server value) + compact token TOTAL.
    expect(meter.textContent).toContain('took 12s');
    expect(meter.textContent).toContain('40.5K tokens');
    // Full per-field token breakdown + "completed X ago" live on the hover title,
    // keeping the resting line clean (痛点6).
    const meterTitle = meter.getAttribute('title') ?? '';
    expect(meterTitle).toContain('input 4.4K');
    expect(meterTitle).toContain('cache read 35.7K');
    expect(meterTitle).toContain('completed just now');
  });

  it('replaces the visible assistant label with the themed loading mark while a chat turn is working', async () => {
    let releaseStream!: () => void;
    const streamCanFinish = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const baseFetch = global.fetch;
    const startedBytes = new TextEncoder().encode(
      `event: chat.started\ndata: ${JSON.stringify({ intent: 'chat', session_id: 'session_loading_mark', backend: 'codex' })}\n\n`,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestPath(input) !== '/api/chat/stream') return baseFetch(input, init);
        latestChatTurnRequest = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        let readIndex = 0;
        return {
          ok: true,
          status: 200,
          headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
          body: {
            getReader: () => ({
              read: async () => {
                if (readIndex === 0) {
                  readIndex += 1;
                  return { done: false, value: startedBytes };
                }
                await streamCanFinish;
                return { done: true, value: undefined };
              },
              releaseLock: () => {},
              cancel: async () => {},
            }),
          },
        } as unknown as Response;
      }),
    );

    try {
      render(<App />);
      const input = await screen.findByLabelText('Direct chat prompt');
      fireEvent.change(input, { target: { value: 'show the loading mark' } });
      fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));

      await waitFor(() => expect(document.querySelector('.chat-turn.assistant .chat-turn-loading-mark')).toBeTruthy());
      const meta = document.querySelector('.chat-turn.assistant .chat-turn-meta') as HTMLElement;
      const loadingMark = meta.querySelector('.chat-turn-loading-mark') as HTMLElement;
      expect(meta.querySelector('strong:not(.sr-only)')).toBeNull();
      expect(meta.querySelector('strong.sr-only')?.textContent).toBe('ClawHunt');
      expect(loadingMark.querySelector('.superclaw-loading-mark-animated source')?.getAttribute('srcset')).toBe('/superclaw-pincer-loader.webp');
      expect(loadingMark.querySelector('.superclaw-loading-mark-animated img')?.getAttribute('src')).toBe('/superclaw-pincer-loader.png');
      expect(loadingMark.querySelector('.superclaw-loading-mark-static')?.getAttribute('src')).toBe('/superclaw-pincer-loader-first-frame.png');
    } finally {
      releaseStream();
    }
  });

  it('does NOT show a metering row for a FAILED turn (no "completed X ago")', async () => {
    // A failed turn carries no metering. The kernel stamps created_at on every
    // message (incl. failures), so without a status gate a failed turn would show
    // "completed just now". Assert the meter row is absent for status=failed.
    chatStreamFramesOverride = [
      ['chat.started', { intent: 'chat', session_id: 'session_fail_meter', backend: 'claude' }],
      [
        'chat.completed',
        {
          intent: 'chat',
          session_id: 'session_fail_meter',
          backend: 'claude',
          status: 'failed',
          response: null,
          failure_reason: 'claude native chat failed (exit 1): auth',
          // even if the server were to leak metering on a failure, the UI must not show it
          elapsed_ms: 9999,
          usage: { input_tokens: 123 },
        },
      ],
    ];

    render(<App />);
    const input = await screen.findByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'cause a failure' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));

    expect(await screen.findByText(/claude native chat failed/)).toBeInTheDocument();
    expect(screen.queryByTestId('chat-turn-metrics')).toBeNull();
  });

  it('does NOT show a metering row for a RELOADED failed turn (persisted status=failed)', async () => {
    // Reload path: backendChatTurns carries the persisted message.status back onto
    // the turn, and the kernel stamps created_at on the failed message too — so the
    // status gate (not createdAt) is what keeps a reopened failed conversation from
    // showing "completed X ago". (Codex R2 noted this path lacked its own test.)
    additionalChatSessions = [
      {
        session_id: 'session_failed_reload',
        title: 'Failed reload session',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [
          { role: 'user', content: 'do something', created_at: 1780669000 },
          { role: 'assistant', content: 'claude native chat failed (exit 1): auth', status: 'failed', created_at: 1780669100 },
        ],
        metadata: {},
      },
    ];

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat session Failed reload session' }));
    expect(await screen.findByText(/claude native chat failed/)).toBeInTheDocument();
    expect(screen.queryByTestId('chat-turn-metrics')).toBeNull();
  });

  it('does NOT bleed a completed reply across two reused session turns', async () => {
    // Both sessions' assistant reply render at the SAME React key (assistant-1), so
    // the StreamingAssistantMarkdown instance is REUSED on switch. A completed turn
    // must paint the authoritative `content` prop, never a throttled `shown` left
    // over from the previous session (which only re-syncs on a `streaming` change).
    additionalChatSessions = [
      {
        session_id: 'session_bleed_a',
        title: 'Bleed session A',
        created_at: 1780669000,
        updated_at: 1780669100,
        messages: [
          { role: 'user', content: 'ask A', created_at: 1780669000 },
          { role: 'assistant', content: 'Alpha reply from session A', status: 'completed', created_at: 1780669050 },
        ],
        metadata: {},
      },
      {
        session_id: 'session_bleed_b',
        title: 'Bleed session B',
        created_at: 1780669200,
        updated_at: 1780669300,
        messages: [
          { role: 'user', content: 'ask B', created_at: 1780669200 },
          { role: 'assistant', content: 'Bravo reply from session B', status: 'completed', created_at: 1780669250 },
        ],
        metadata: {},
      },
    ];

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat session Bleed session A' }));
    expect(await screen.findByText('Alpha reply from session A')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat session Bleed session B' }));
    expect(await screen.findByText('Bravo reply from session B')).toBeInTheDocument();
    expect(screen.queryByText('Alpha reply from session A')).toBeNull();
  });

  it('StreamingAssistantMarkdown paints new content immediately on a non-incremental switch', () => {
    // The component is reused (same React key) when switching INTO a different
    // still-streaming session. The throttled `shown` is stale from the previous
    // session; since the new content is NOT a prefix of it, render must fall to the
    // live `content` immediately rather than flashing the prior session's reply.
    const { rerender } = render(<StreamingAssistantMarkdown content="Alpha from A" streaming desktopInvoke={null} />);
    expect(screen.getByText('Alpha from A')).toBeInTheDocument();
    rerender(<StreamingAssistantMarkdown content="Bravo from B" streaming desktopInvoke={null} />);
    expect(screen.getByText('Bravo from B')).toBeInTheDocument();
    expect(screen.queryByText('Alpha from A')).toBeNull();
  });

  it('shows a box-free note for an interrupted assistant turn (no silent vanish)', async () => {
    // pending/interrupted carry meaning but no metering — they must keep a quiet
    // status note, not disappear entirely (which would hide real backend activity).
    additionalChatSessions = [
      {
        session_id: 'session_interrupted',
        title: 'Interrupted session',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [
          { role: 'user', content: 'long task', created_at: 1780669000 },
          { role: 'assistant', content: 'partial output…', status: 'interrupted', created_at: 1780669100 },
        ],
        metadata: {},
      },
    ];

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat session Interrupted session' }));
    expect(await screen.findByText('partial output…')).toBeInTheDocument();
    const note = await screen.findByTestId('chat-status-note');
    expect(note.textContent).toContain('interrupted');
  });

  it('preserves a turn context ref through the optimistic session cache for re-edit', async () => {
    // Land the turn on a fresh session id the seed does NOT contain, so the
    // optimistic cache (which now carries context_refs) survives the
    // loadChatSessions merge instead of being overwritten by a refs-less seed
    // entry — this isolates the rememberBackendChatSession → backendChatTurns path.
    chatStreamFramesOverride = [
      ['chat.started', { intent: 'chat', session_id: 'session_cache_rt', backend: 'codex' }],
      ['message.delta', { text: 'Cached answer.' }],
      ['message.completed', { text: 'Cached answer.' }],
      [
        'chat.completed',
        { intent: 'chat', session_id: 'session_cache_rt', backend: 'codex', status: 'completed', response: 'Cached answer.' },
      ],
    ];

    render(<App />);

    // Stage a context ref via an @-mention, then send a message carrying it.
    const input = await screen.findByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: '@sess' } });
    const listbox = await screen.findByRole('listbox', { name: 'Context mentions' });
    fireEvent.click(within(listbox).getByText('聊天 ID: session_demo'));
    await waitFor(() => expect(input).toHaveValue(''));
    fireEvent.change(input, { target: { value: 'Remember my ref' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));

    expect(await screen.findByText('Cached answer.')).toBeInTheDocument();

    // Reopen the session FROM CACHE: New Session drops the in-memory transcript,
    // so the reopened turns must come back through backendChatTurns(cached session).
    fireEvent.click(await screen.findByRole('button', { name: 'New Session' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat session Remember my ref' }));

    const userTurn = (await waitFor(() => {
      const el = document.querySelector('.chat-turn.user');
      expect(el).toBeTruthy();
      return el;
    })) as HTMLElement;
    expect(within(userTurn).getByText('Remember my ref')).toBeInTheDocument();

    // Re-edit restores the context chip that survived the optimistic cache roundtrip.
    fireEvent.click(within(userTurn).getByRole('button', { name: 'Edit' }));
    await waitFor(() =>
      expect(document.querySelector('.composer-context-chip[title="@session:session_demo"]')).toBeTruthy(),
    );
  });

  it('ArrowUp recalls a prompt submitted in THIS chat; ArrowDown restores the draft', async () => {
    // Fresh session id NOT in the seed → the optimistic transcript (carrying the
    // user turn) survives the post-completion loadChatSessions merge, so history
    // recall has something to walk.
    chatStreamFramesOverride = [
      ['chat.started', { intent: 'chat', session_id: 'session_hist', backend: 'codex' }],
      ['message.completed', { text: 'Answer one.' }],
      ['chat.completed', { intent: 'chat', session_id: 'session_hist', backend: 'codex', status: 'completed', response: 'Answer one.' }],
    ];

    render(<App />);
    const input = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'first message' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));
    expect(await screen.findByText('Answer one.')).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveValue(''));

    // Empty composer, caret at the very start → ArrowUp recalls the last prompt.
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    await waitFor(() => expect(input).toHaveValue('first message'));

    // ArrowDown past the newest entry → restore the (empty) draft we stashed.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('recalling a ref-less prompt does NOT leak the current draft staged context ref', async () => {
    // Regression guard for the review finding: history recall used to replace only
    // the text, leaving the live draft's @-ref/attachments to ride along on send.
    chatStreamFramesOverride = [
      ['chat.started', { intent: 'chat', session_id: 'session_leak', backend: 'codex' }],
      ['message.completed', { text: 'Plain answer.' }],
      ['chat.completed', { intent: 'chat', session_id: 'session_leak', backend: 'codex', status: 'completed', response: 'Plain answer.' }],
    ];

    render(<App />);
    const input = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;

    // 1) Send a prompt that carries NO context ref.
    fireEvent.change(input, { target: { value: 'alpha' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));
    expect(await screen.findByText('Plain answer.')).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveValue(''));

    // 2) Start a NEW draft that stages an @-mention context ref.
    fireEvent.change(input, { target: { value: '@sess' } });
    const listbox = await screen.findByRole('listbox', { name: 'Context mentions' });
    fireEvent.click(within(listbox).getByText('聊天 ID: session_demo'));
    await waitFor(() => expect(input).toHaveValue(''));
    fireEvent.change(input, { target: { value: 'beta draft' } });
    await waitFor(() => expect(document.querySelector('.composer-context-chip')).toBeTruthy());

    // 3) Recall the ref-less 'alpha' from the very start of the draft.
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    await waitFor(() => expect(input).toHaveValue('alpha'));
    // The staged ref chip is gone — recall reproduces alpha's OWN (empty) payload.
    expect(document.querySelector('.composer-context-chip')).toBeNull();

    // 4) Send the recalled prompt → no leaked context ref.
    latestChatTurnRequest = null;
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));
    await waitFor(() => expect(latestChatTurnRequest).toBeTruthy());
    expect(latestChatTurnRequest?.message).toBe('alpha');
    expect((latestChatTurnRequest?.context_refs as unknown[]) ?? []).toEqual([]);
  });

  it('an IME candidate-commit Enter does not send; a deliberate Enter afterward does', async () => {
    chatStreamFramesOverride = [
      ['chat.started', { intent: 'chat', session_id: 'session_ime', backend: 'codex' }],
      ['message.completed', { text: 'Sent.' }],
      ['chat.completed', { intent: 'chat', session_id: 'session_ime', backend: 'codex', status: 'completed', response: 'Sent.' }],
    ];

    render(<App />);
    const input = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '你好' } });

    // Chrome/Firefox: the committing Enter keydown itself reports isComposing=true.
    const chromeCommit = createEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent(input, chromeCommit);
    expect(chromeCommit.defaultPrevented).toBe(false);
    expect(latestChatTurnRequest).toBeNull();

    // Safari/WKWebView: compositionend fires FIRST, then the committing Enter keydown
    // reports isComposing=false — only the just-ended window guards this one.
    fireEvent.compositionEnd(input);
    const safariCommit = createEvent.keyDown(input, { key: 'Enter' });
    fireEvent(input, safariCommit);
    expect(safariCommit.defaultPrevented).toBe(false);
    expect(latestChatTurnRequest).toBeNull();
    expect(input).toHaveValue('你好');

    // Once the post-commit macrotask drains the guard flag, a real Enter sends.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(latestChatTurnRequest).toBeTruthy());
    expect(latestChatTurnRequest?.message).toBe('你好');
  });

  it('ArrowUp recalls history from a single-line draft end (caret need not be at offset 0)', async () => {
    chatStreamFramesOverride = [
      ['chat.started', { intent: 'chat', session_id: 'session_end', backend: 'codex' }],
      ['message.completed', { text: 'Answered.' }],
      ['chat.completed', { intent: 'chat', session_id: 'session_end', backend: 'codex', status: 'completed', response: 'Answered.' }],
    ];

    render(<App />);
    const input = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'first message' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));
    expect(await screen.findByText('Answered.')).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveValue(''));

    // A NEW single-line draft, caret at its END (offset 3, NOT 0) → first visual row,
    // so ArrowUp still recalls (regression guard for the too-strict selectionStart===0).
    fireEvent.change(input, { target: { value: 'wip' } });
    input.setSelectionRange(3, 3);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    await waitFor(() => expect(input).toHaveValue('first message'));

    // ArrowDown past the newest entry restores the stashed 'wip' draft.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(input).toHaveValue('wip'));
  });

  it('keeps same-text prompts with different context refs as DISTINCT history entries', async () => {
    chatStreamFramesOverride = [
      ['chat.started', { intent: 'chat', session_id: 'session_dup', backend: 'codex' }],
      ['message.completed', { text: 'Ack.' }],
      ['chat.completed', { intent: 'chat', session_id: 'session_dup', backend: 'codex', status: 'completed', response: 'Ack.' }],
    ];

    render(<App />);
    const input = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;

    // Send 'dup' WITH a context ref.
    fireEvent.change(input, { target: { value: '@sess' } });
    const listbox = await screen.findByRole('listbox', { name: 'Context mentions' });
    fireEvent.click(within(listbox).getByText('聊天 ID: session_demo'));
    await waitFor(() => expect(input).toHaveValue(''));
    fireEvent.change(input, { target: { value: 'dup' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));
    await waitFor(() => expect(document.querySelectorAll('.chat-turn.user').length).toBe(1));
    await waitFor(() => expect(input).toHaveValue(''));

    // Send 'dup' again WITHOUT a ref.
    fireEvent.change(input, { target: { value: 'dup' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));
    await waitFor(() => expect(document.querySelectorAll('.chat-turn.user').length).toBe(2));
    await waitFor(() => expect(input).toHaveValue(''));

    // ArrowUp → newest 'dup' (no ref) → no chip. Same content, but NOT collapsed:
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    await waitFor(() => expect(input).toHaveValue('dup'));
    expect(document.querySelector('.composer-context-chip')).toBeNull();

    // ArrowUp again → the OLDER 'dup' (with ref) → its chip reappears.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    await waitFor(() => expect(document.querySelector('.composer-context-chip')).toBeTruthy());
    expect(input).toHaveValue('dup');
  });

  it('a programmatic re-edit exits history browse so ArrowDown cannot clobber it', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      chatStreamFramesOverride = [
        ['chat.started', { intent: 'chat', session_id: 'session_heal', backend: 'codex' }],
        ['message.completed', { text: 'Done.' }],
        ['chat.completed', { intent: 'chat', session_id: 'session_heal', backend: 'codex', status: 'completed', response: 'Done.' }],
      ];

      render(<App />);
      const input = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: 'original prompt' } });
      fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));
      await waitFor(() => expect(document.querySelector('.chat-turn.user')).toBeTruthy());
      await waitFor(() => expect(input).toHaveValue(''));

      // Enter history, then re-edit the turn (a programmatic rewrite to the SAME text,
      // which the value-diverge self-heal alone could not catch — proving the explicit
      // browse-exit in the writer).
      input.setSelectionRange(0, 0);
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      await waitFor(() => expect(input).toHaveValue('original prompt'));

      const userTurn = document.querySelector('.chat-turn.user') as HTMLElement;
      fireEvent.click(within(userTurn).getByRole('button', { name: 'Edit' }));
      await waitFor(() => expect(input).toHaveValue('original prompt'));

      // ArrowDown must NOT restore the old empty draft — re-edit left browse mode.
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(input).toHaveValue('original prompt');
    } finally {
      confirmSpy.mockRestore();
    }
  });


  it('does not copy local-only chat ids from the sidebar context menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    });
    localStorage.setItem(
      'superclaw_local_chat_sessions',
      JSON.stringify([
        {
          session_id: 'chat_local_only',
          title: 'Local draft session',
          status: '1 message',
          updated_at: 1780671400,
          turns: [{ role: 'user', content: 'local only' }],
        },
      ]),
    );

    render(<App />);

    const sessionButton = await screen.findByRole('button', { name: 'Open chat session Local draft session' });
    const contextMenuEvent = createEvent.contextMenu(sessionButton, { button: 2, clientX: 120, clientY: 180 });
    fireEvent(sessionButton, contextMenuEvent);

    expect(contextMenuEvent.defaultPrevented).toBe(true);
    expect(screen.queryByRole('menu', { name: 'Conversation actions' })).not.toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('creates a project from the Projects header + (folder default, no trust attestation)', async () => {
    // The "New project" + lives in the Projects section header, which renders
    // only with an inventory present (production always has the built-in Chat).
    workspacesInventory = [
      {
        workspace_id: 'workspace_chat',
        name: 'Chat',
        kind: 'managed',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '',
        builtin_chat: true,
        session_count: 0,
      },
    ];
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const nameInput = await screen.findByPlaceholderText('e.g. Research notes');
    fireEvent.change(nameInput, { target: { value: 'Research notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      const calls = vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input, init]) => requestPath(input) === '/api/workspaces' && (init?.method ?? 'GET').toUpperCase() === 'POST',
        );
      expect(calls.length).toBe(1);
      // folder-only scratch sends no repo and no trust attestation (§4.4)
      expect(JSON.parse(String(calls[0][1]?.body))).toMatchObject({
        name: 'Research notes',
        attach_repo: null,
        trust_confirmed: false,
      });
    });
    expect(await screen.findByText('Project created')).toBeInTheDocument();
  });

  it('shows a name-collision 422 INSIDE the create-project dialog (not the chat bar)', async () => {
    // Regression: a duplicate project name (the kernel 422s because
    // ~/SuperClaw/<name> already exists) must surface its message inside the
    // dialog so the user can rename in place — previously it leaked to the global
    // chat-bar message and the modal closed/looked like nothing happened.
    workspaceCreateConflict = true;
    workspacesInventory = [
      {
        workspace_id: 'workspace_chat',
        name: 'Chat',
        kind: 'managed',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '',
        builtin_chat: true,
        session_count: 0,
      },
    ];
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const nameInput = await screen.findByPlaceholderText('e.g. Research notes');
    fireEvent.change(nameInput, { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    // The bare kernel detail renders inside the dialog as an alert...
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("a directory named '你好' already exists");
    expect(alert).toHaveTextContent('rename the project');
    // ...the dialog stays open (name field still mounted) so the user can retry...
    expect(screen.getByPlaceholderText('e.g. Research notes')).toBeInTheDocument();
    // ...and it never leaked the noisy URL/status into the message.
    expect(alert).not.toHaveTextContent('/api/workspaces');
    expect(alert).not.toHaveTextContent('422');

    // Editing the name clears the stale error (renaming is the fix).
    fireEvent.change(nameInput, { target: { value: '你好-2' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the collision error when switching to "attach existing directory"', async () => {
    // The kernel's collision message offers "attach existing directory" as a fix
    // path. Switching to that mode must clear the stale error — otherwise it
    // ghosts on the attach form, which is exactly where the user went to fix it.
    workspaceCreateConflict = true;
    workspacesInventory = [
      {
        workspace_id: 'workspace_chat',
        name: 'Chat',
        kind: 'managed',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '',
        builtin_chat: true,
        session_count: 0,
      },
    ];
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    fireEvent.change(await screen.findByPlaceholderText('e.g. Research notes'), { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');

    fireEvent.click(screen.getByRole('button', { name: 'Attach a code repository instead' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('locks the name field while a create is in flight (no stale-error race)', async () => {
    // Regression: the name input must be disabled during the request. Otherwise a
    // user could submit "你好", rename to "世界" mid-flight, and the in-flight 422
    // for the OLD name would write a now-wrong "你好 already exists" error.
    workspaceCreateConflict = true;
    workspacesInventory = [
      {
        workspace_id: 'workspace_chat',
        name: 'Chat',
        kind: 'managed',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '',
        builtin_chat: true,
        session_count: 0,
      },
    ];
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const nameInput = await screen.findByPlaceholderText('e.g. Research notes');
    fireEvent.change(nameInput, { target: { value: '你好' } });

    let release!: () => void;
    deferWorkspaceCreate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    // In flight: the field is locked, so the user cannot change the name and the
    // response can't strand a stale error against a since-edited form.
    await waitFor(() => expect(nameInput).toBeDisabled());
    release();
    await waitFor(() => expect(nameInput).not.toBeDisabled());
    // The error still lands for the actually-submitted name.
    expect(await screen.findByRole('alert')).toHaveTextContent("'你好' already exists");
  });

  it('pins the just-created project so the first turn lands in it (not Chat)', async () => {
    // Regression: creating a project must drop the user into a fresh chat pinned
    // to it. Before the fix, createPersonalWorkspace left pinnedWorkspaceId=null,
    // so the first turn shipped workspace_id=undefined, the kernel resolved the
    // default Chat workspace, and the conversation was grouped under "Chat
    // (no project)" instead of the new project.
    workspacesInventory = [
      {
        workspace_id: 'workspace_chat',
        name: 'Chat',
        kind: 'managed',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '',
        builtin_chat: true,
        session_count: 0,
      },
    ];
    chatStreamFramesOverride = [
      ['chat.started', { intent: 'chat', session_id: 'session_new', backend: 'codex' }],
      ['message.delta', { text: 'In the new project.' }],
      ['message.completed', { text: 'In the new project.' }],
      ['chat.completed', { intent: 'chat', session_id: 'session_new', backend: 'codex', status: 'completed', response: 'In the new project.' }],
    ];

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    fireEvent.change(await screen.findByPlaceholderText('e.g. Research notes'), { target: { value: 'Research notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('Project created')).toBeInTheDocument();

    // The composer is now a fresh draft pinned to the just-created project (the
    // POST mock returns workspace_id='workspace_new'), so the first turn must
    // carry that workspace_id + repo_path:null — kernel parity with
    // `superclaw chat --workspace <id>`, filing the conversation in the project.
    const input = await screen.findByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'first message' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(latestChatTurnRequest).toBeTruthy());
    expect(latestChatTurnRequest).toMatchObject({
      message: 'first message',
      workspace_id: 'workspace_new',
      repo_path: null,
    });
  });

  it('pins the new project BEFORE the post-create refresh resolves (no unpinned-send race)', async () => {
    // Codex review caught this: the pin must land before the awaited
    // loadChatSessions(), or a slow refresh leaves an interactive-but-unpinned
    // composer window where the first turn ships workspace_id=undefined (the
    // original bug). Hold the post-create chat/sessions refresh open and send a
    // turn while it is still pending — the turn must already carry the pin.
    workspacesInventory = [
      {
        workspace_id: 'workspace_chat',
        name: 'Chat',
        kind: 'managed',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '',
        builtin_chat: true,
        session_count: 0,
      },
    ];
    chatStreamFramesOverride = [
      ['chat.started', { intent: 'chat', session_id: 'session_new', backend: 'codex' }],
      ['message.delta', { text: 'In the new project.' }],
      ['message.completed', { text: 'In the new project.' }],
      ['chat.completed', { intent: 'chat', session_id: 'session_new', backend: 'codex', status: 'completed', response: 'In the new project.' }],
    ];

    render(<App />);
    // let the initial mount load settle before we hold the next refresh open
    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    fireEvent.change(await screen.findByPlaceholderText('e.g. Research notes'), { target: { value: 'Research notes' } });

    // Hold every chat/sessions refresh from here on (the post-create one) open.
    let releaseRefresh!: () => void;
    deferChatListReload = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    // The pin runs synchronously before the awaited refresh, so the project is
    // already pinned even though the refresh GET is still hanging.
    expect(await screen.findByText('Project created')).toBeInTheDocument();

    const selectBtn = screen.getByRole('button', { name: 'Chat workspace' });
    expect(selectBtn).toHaveTextContent('Research notes');


    const input = await screen.findByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'first message' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(latestChatTurnRequest).toBeTruthy());
    expect(latestChatTurnRequest).toMatchObject({
      message: 'first message',
      workspace_id: 'workspace_new',
      repo_path: null,
    });

    // release the held refresh so the component settles cleanly
    releaseRefresh();
  });

  it('requires a trust attestation before attaching a real repository', async () => {
    workspacesInventory = [
      {
        workspace_id: 'workspace_chat',
        name: 'Chat',
        kind: 'managed',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '',
        builtin_chat: true,
        session_count: 0,
      },
    ];
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    fireEvent.change(await screen.findByPlaceholderText('e.g. Research notes'), { target: { value: 'Repo space' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach a code repository instead' }));
    fireEvent.change(await screen.findByPlaceholderText('/path/to/repo'), { target: { value: '/tmp/proj' } });

    // create stays disabled until the trust checkbox is confirmed (fail-closed)
    const createButton = screen.getByRole('button', { name: 'Create project' });
    expect(createButton).toBeDisabled();
    fireEvent.click(screen.getByLabelText('I trust this directory for agent execution'));
    expect(createButton).toBeEnabled();
    fireEvent.click(createButton);

    await waitFor(() => {
      const calls = vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input, init]) => requestPath(input) === '/api/workspaces' && (init?.method ?? 'GET').toUpperCase() === 'POST',
        );
      expect(calls.length).toBe(1);
      expect(JSON.parse(String(calls[0][1]?.body))).toMatchObject({
        name: 'Repo space',
        attach_repo: '/tmp/proj',
        trust_confirmed: true,
      });
    });
  });

  it('archives a backend session from the context menu', async () => {
    additionalChatSessions = [
      {
        session_id: 'session_arch',
        title: 'Archivable session',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [{ role: 'user', content: 'hi', created_at: 1780669000 }],
        metadata: {},
      },
    ];

    render(<App />);

    const sessionButton = await screen.findByRole('button', { name: 'Open chat session Archivable session' });
    fireEvent(sessionButton, createEvent.contextMenu(sessionButton, { button: 2, clientX: 120, clientY: 180 }));
    const menu = await screen.findByRole('menu', { name: 'Conversation actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Archive' }));

    await waitFor(() => {
      const calls = vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => requestPath(input) === '/api/chat/sessions/session_arch/archive');
      expect(calls.length).toBe(1);
      expect(JSON.parse(String(calls[0][1]?.body))).toMatchObject({ archived: true });
    });
    expect(await screen.findByText('Conversation archived')).toBeInTheDocument();
  });

  it('moves a session and requires acknowledging an execution-boundary change', async () => {
    moveBoundaryConflict = true;
    workspacesInventory = [
      {
        workspace_id: 'workspace_proj',
        name: 'superclaw',
        kind: 'repo',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '/tmp/superclaw',
        builtin_chat: false,
        session_count: 0,
      },
    ];
    additionalChatSessions = [
      {
        session_id: 'session_move',
        title: 'Movable session',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [{ role: 'user', content: 'hi', created_at: 1780669000 }],
        metadata: {},
      },
    ];

    render(<App />);

    const sessionButton = await screen.findByRole('button', { name: 'Open chat session Movable session' });
    fireEvent(sessionButton, createEvent.contextMenu(sessionButton, { button: 2, clientX: 120, clientY: 180 }));
    const menu = await screen.findByRole('menu', { name: 'Conversation actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to project…' }));

    // pick the repo workspace target → kernel returns 409 → warning surfaces
    fireEvent.click(await screen.findByRole('button', { name: 'superclaw' }));
    expect(await screen.findByText('This changes the execution boundary')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Move anyway' }));

    await waitFor(() => {
      const calls = vi
        .mocked(fetch)
        .mock.calls.filter(([input]) => requestPath(input) === '/api/chat/sessions/session_move/move');
      expect(calls.length).toBe(2);
      expect(JSON.parse(String(calls[0][1]?.body))).toMatchObject({ acknowledge_boundary_change: false });
      expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({
        workspace_id: 'workspace_proj',
        acknowledge_boundary_change: true,
      });
    });
    expect(await screen.findByText('Conversation moved')).toBeInTheDocument();
  });

  it('collapses and expands a user workspace group', async () => {
    workspacesInventory = [
      {
        workspace_id: 'workspace_proj',
        name: 'superclaw',
        kind: 'repo',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '/tmp/superclaw',
        builtin_chat: false,
        session_count: 1,
      },
    ];
    additionalChatSessions = [
      {
        session_id: 'session_grouped',
        title: 'Grouped session',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [{ role: 'user', content: 'hello', created_at: 1780669000 }],
        metadata: {},
        workspace_id: 'workspace_proj',
      },
    ];

    render(<App />);

    expect(await screen.findByRole('button', { name: 'Open chat session Grouped session' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse group: superclaw' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Open chat session Grouped session' })).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand group: superclaw' }));
    expect(await screen.findByRole('button', { name: 'Open chat session Grouped session' })).toBeInTheDocument();
  });

  it("opens a project-scoped chat from the project's + and keeps every turn pinned to that workspace", async () => {
    workspacesInventory = [
      {
        workspace_id: 'workspace_proj',
        name: 'superclaw',
        kind: 'repo',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '/tmp/superclaw',
        builtin_chat: false,
        session_count: 0,
      },
    ];
    // The created session lands bound to the project (as the kernel would file
    // it) so the follow-up exercises the authoritative source-of-truth path:
    // execution boundary derived from the session's real binding, not the pin.
    additionalChatSessions = [
      {
        session_id: 'session_proj',
        title: 'Project chat',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [{ role: 'user', content: 'hello project', created_at: 1780669000 }],
        metadata: {},
        workspace_id: 'workspace_proj',
      },
    ];
    chatStreamFramesOverride = [
      ['chat.started', { intent: 'chat', session_id: 'session_proj', backend: 'codex' }],
      ['message.delta', { text: 'Project reply.' }],
      ['message.completed', { text: 'Project reply.' }],
      ['chat.completed', { intent: 'chat', session_id: 'session_proj', backend: 'codex', status: 'completed', response: 'Project reply.' }],
    ];

    render(<App />);

    // open a brand-new chat scoped to the project via its "+"
    fireEvent.click(await screen.findByRole('button', { name: 'New chat in this project: superclaw' }));
    // the composer workspace selector reflects the pinned project (fresh draft)
    expect(await screen.findByRole('button', { name: 'Chat workspace' })).toHaveTextContent('superclaw');

    const input = screen.getByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'hello project' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // first turn (brand-new draft) → pinned via the live pin: workspace_id +
    // repo_path:null so the kernel files + executes inside the project root —
    // CLI parity with `superclaw chat --workspace <id>`.
    await waitFor(() => expect(latestChatTurnRequest).toBeTruthy());
    expect(latestChatTurnRequest).toMatchObject({
      message: 'hello project',
      workspace_id: 'workspace_proj',
      repo_path: null,
    });

    // the FOLLOW-UP turn must keep the project boundary: the kernel runs the turn
    // in request.repo_path, so a follow-up falling back to '.' would execute in
    // the server cwd (or 403). Now driven by the session's real binding (the
    // authoritative source), carrying session id + workspace_id + repo_path:null.
    expect(await screen.findByText('Project reply.')).toBeInTheDocument();
    const followUp = screen.getByLabelText('Direct chat prompt');
    fireEvent.change(followUp, { target: { value: 'second turn' } });
    fireEvent.keyDown(followUp, { key: 'Enter' });
    await waitFor(() =>
      expect(latestChatTurnRequest).toMatchObject({
        message: 'second turn',
        session_id: 'session_proj',
        workspace_id: 'workspace_proj',
        repo_path: null,
      }),
    );
  });

  it('lets a moved conversation follow its NEW project on the next turn (stale pin never drags it back)', async () => {
    // Open a new chat in project A (pin=A, never explicitly cleared), then the
    // created conversation ends up bound to project B (post-move state the
    // refetch returns). The follow-up MUST execute in B: the session's real
    // binding is authoritative over the lingering "opened in A" pin.
    workspacesInventory = [
      {
        workspace_id: 'workspace_a',
        name: 'proj-a',
        kind: 'repo',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '/tmp/a',
        builtin_chat: false,
        session_count: 0,
      },
      {
        workspace_id: 'workspace_b',
        name: 'proj-b',
        kind: 'repo',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '/tmp/b',
        builtin_chat: false,
        session_count: 0,
      },
    ];
    additionalChatSessions = [
      {
        session_id: 'session_moved',
        title: 'Moved chat',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [{ role: 'user', content: 'hi', created_at: 1780669000 }],
        metadata: {},
        workspace_id: 'workspace_b',
      },
    ];
    chatStreamFramesOverride = [
      ['chat.started', { intent: 'chat', session_id: 'session_moved', backend: 'codex' }],
      ['message.delta', { text: 'Moved reply.' }],
      ['message.completed', { text: 'Moved reply.' }],
      ['chat.completed', { intent: 'chat', session_id: 'session_moved', backend: 'codex', status: 'completed', response: 'Moved reply.' }],
    ];

    render(<App />);

    // pin A and send a first turn (pin is NOT cleared afterwards)
    fireEvent.click(await screen.findByRole('button', { name: 'New chat in this project: proj-a' }));
    const input = screen.getByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'first in A' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Moved reply.')).toBeInTheDocument();

    // follow-up: the session is now bound to B → binding wins over the stale A pin
    const followUp = screen.getByLabelText('Direct chat prompt');
    fireEvent.change(followUp, { target: { value: 'after move' } });
    fireEvent.keyDown(followUp, { key: 'Enter' });
    await waitFor(() => expect(latestChatTurnRequest?.message).toBe('after move'));
    expect(latestChatTurnRequest).toMatchObject({
      session_id: 'session_moved',
      workspace_id: 'workspace_b',
      repo_path: null,
    });
  });

  it('does not drag a session back to its create-project after it is moved to Chats (no project)', async () => {
    // The per-session create map must NEVER override a backend-confirmed binding:
    // a chat created in project A then moved to "Chats/no project" (workspace_id
    // null) must run flat on its next turn, not re-send workspace_id A.
    workspacesInventory = [
      {
        workspace_id: 'workspace_a',
        name: 'proj-a',
        kind: 'repo',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '/tmp/a',
        builtin_chat: false,
        session_count: 0,
      },
    ];
    // The confirmed record is flat (post-move state).
    additionalChatSessions = [
      {
        session_id: 'session_unbound',
        title: 'Unbound chat',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [{ role: 'user', content: 'hi', created_at: 1780669000 }],
        metadata: {},
      },
    ];
    chatStreamFramesOverride = [
      ['chat.started', { intent: 'chat', session_id: 'session_unbound', backend: 'codex' }],
      ['message.delta', { text: 'Unbound reply.' }],
      ['message.completed', { text: 'Unbound reply.' }],
      ['chat.completed', { intent: 'chat', session_id: 'session_unbound', backend: 'codex', status: 'completed', response: 'Unbound reply.' }],
    ];

    render(<App />);

    // open in A (records session→A in the create map), send a first turn
    fireEvent.click(await screen.findByRole('button', { name: 'New chat in this project: proj-a' }));
    const input = screen.getByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'first in A' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Unbound reply.')).toBeInTheDocument();

    // follow-up: the confirmed session is flat → run flat (no workspace_id),
    // NEVER re-send A. repo_path:null routes it to the managed Chat scratch (the
    // kernel ensure_chat_workspace home), never the server cwd.
    const followUp = screen.getByLabelText('Direct chat prompt');
    fireEvent.change(followUp, { target: { value: 'after unbind' } });
    fireEvent.keyDown(followUp, { key: 'Enter' });
    await waitFor(() => expect(latestChatTurnRequest?.message).toBe('after unbind'));
    expect(latestChatTurnRequest?.workspace_id).toBeUndefined();
    expect(latestChatTurnRequest).toMatchObject({ session_id: 'session_unbound', repo_path: null });
  });

  it('drops a pending project pin when another sidebar chat is opened (no hijack)', async () => {
    workspacesInventory = [
      {
        workspace_id: 'workspace_proj',
        name: 'superclaw',
        kind: 'repo',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '/tmp/superclaw',
        builtin_chat: false,
        session_count: 0,
      },
    ];
    additionalChatSessions = [
      {
        session_id: 'session_loose',
        title: 'Loose chat',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [{ role: 'user', content: 'hi', created_at: 1780669000 }],
        metadata: {},
      },
    ];

    render(<App />);

    // pin a project, then change your mind and open an unrelated flat chat
    fireEvent.click(await screen.findByRole('button', { name: 'New chat in this project: superclaw' }));
    expect(await screen.findByRole('button', { name: 'Chat workspace' })).toHaveTextContent('superclaw');
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat session Loose chat' }));
    // opening an existing chat clears the pin AND hides the new-chat selector
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Chat workspace' })).toBeNull());

    // the next turn runs flat — the stale pin must NOT route it into the project;
    // no workspace_id, and repo_path:null → managed Chat scratch (not server cwd).
    const input = screen.getByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'no project' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(latestChatTurnRequest?.message).toBe('no project'));
    expect(latestChatTurnRequest?.workspace_id).toBeUndefined();
    expect(latestChatTurnRequest).toMatchObject({ repo_path: null });
  });

  it('targets a project for a new chat via the composer workspace selector (Codex-style)', async () => {
    workspacesInventory = [
      {
        workspace_id: 'workspace_proj',
        name: 'superclaw',
        kind: 'repo',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '/tmp/superclaw',
        builtin_chat: false,
        session_count: 0,
      },
    ];

    render(<App />);

    // a brand-new chat defaults to "Chat (no project)"
    const selector = await screen.findByRole('button', { name: 'Chat workspace' });
    expect(selector).toHaveTextContent('Chat (no project)');
    // pick the project from the selector
    fireEvent.click(selector);
    fireEvent.click(await screen.findByRole('option', { name: 'superclaw' }));
    expect(selector).toHaveTextContent('superclaw');

    // the next turn files the new session into the picked project
    const input = screen.getByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'via selector' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(latestChatTurnRequest).toMatchObject({
        message: 'via selector',
        workspace_id: 'workspace_proj',
        repo_path: null,
      }),
    );
  });

  it('sends a confirmed session workspace_id even when the inventory does not project it (fail-closed, no cwd downgrade)', async () => {
    // Inventory absent → the session is shown flat (and openable), but it still
    // carries a workspace_id. Its turn must send that id (kernel fail-closes if
    // gone) rather than silently downgrade to repo_path:'.' (server cwd).
    workspacesInventory = [];
    additionalChatSessions = [
      {
        session_id: 'session_ghost',
        title: 'Ghosted',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [{ role: 'user', content: 'hi', created_at: 1780669000 }],
        metadata: {},
        workspace_id: 'workspace_ghost',
      },
    ];

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open chat session Ghosted' }));
    const input = screen.getByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'ghost turn' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(latestChatTurnRequest?.message).toBe('ghost turn'));
    expect(latestChatTurnRequest).toMatchObject({
      session_id: 'session_ghost',
      workspace_id: 'workspace_ghost',
      repo_path: null,
    });
  });

  it('keeps a moved session on its new project for the next turn even if the post-move refetch fails', async () => {
    // performMove applies the new binding LOCALLY; without that, a failed refetch
    // leaves a stale workspace_id and the next turn (which sends it) would make the
    // kernel move the session back to where it started.
    failNextListAfterMove = true;
    workspacesInventory = [
      {
        workspace_id: 'workspace_a',
        name: 'proj-a',
        kind: 'repo',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '/tmp/a',
        builtin_chat: false,
        session_count: 0,
      },
      {
        workspace_id: 'workspace_b',
        name: 'proj-b',
        kind: 'repo',
        trust_status: 'active',
        is_trusted: true,
        repo_path: '/tmp/b',
        builtin_chat: false,
        session_count: 0,
      },
    ];
    additionalChatSessions = [
      {
        session_id: 'session_mv',
        title: 'Movable',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [{ role: 'user', content: 'hi', created_at: 1780669000 }],
        metadata: {},
        workspace_id: 'workspace_a',
      },
    ];

    render(<App />);

    // open it (make it the active chat), then move A → B (refetch forced to fail)
    const sessionButton = await screen.findByRole('button', { name: 'Open chat session Movable' });
    fireEvent.click(sessionButton);
    fireEvent(sessionButton, createEvent.contextMenu(sessionButton, { button: 2, clientX: 120, clientY: 180 }));
    const menu = await screen.findByRole('menu', { name: 'Conversation actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to project…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'proj-b' }));
    expect(await screen.findByText('Conversation moved')).toBeInTheDocument();

    // local binding update survived the failed refetch → next turn targets B, not A
    const input = screen.getByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'post move' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(latestChatTurnRequest?.message).toBe('post move'));
    expect(latestChatTurnRequest).toMatchObject({
      session_id: 'session_mv',
      workspace_id: 'workspace_b',
      repo_path: null,
    });
  });

  it("disables the new-chat + for an untrusted project (a chat there would 403)", async () => {
    workspacesInventory = [
      {
        workspace_id: 'workspace_frozen',
        name: 'frozen-proj',
        kind: 'repo',
        trust_status: 'quarantined',
        is_trusted: false,
        repo_path: '/tmp/frozen',
        builtin_chat: false,
        session_count: 0,
      },
    ];

    render(<App />);

    expect(await screen.findByRole('button', { name: 'New chat in this project: frozen-proj' })).toBeDisabled();
  });

  it('hides an archived unassigned chat from the default list (merge does not re-keep it)', async () => {
    additionalChatSessions = [
      {
        session_id: 'session_arch_hide',
        title: 'Soon archived session',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [{ role: 'user', content: 'hi', created_at: 1780669000 }],
        metadata: {},
      },
    ];

    render(<App />);

    const sessionButton = await screen.findByRole('button', { name: 'Open chat session Soon archived session' });
    fireEvent(sessionButton, createEvent.contextMenu(sessionButton, { button: 2, clientX: 120, clientY: 180 }));
    const menu = await screen.findByRole('menu', { name: 'Conversation actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Archive' }));

    // archive POST flips it archived; the post-archive refetch (include_archived
    // off) excludes it, and the merge must NOT re-keep it as an optimistic draft
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Open chat session Soon archived session' })).not.toBeInTheDocument(),
    );
  });

  it('keeps an archived session hidden even when the post-archive refetch fails', async () => {
    failNextListAfterArchive = true;
    additionalChatSessions = [
      {
        session_id: 'session_arch_fail',
        title: 'Archive then offline',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [{ role: 'user', content: 'hi', created_at: 1780669000 }],
        metadata: {},
      },
    ];

    render(<App />);

    const sessionButton = await screen.findByRole('button', { name: 'Open chat session Archive then offline' });
    fireEvent(sessionButton, createEvent.contextMenu(sessionButton, { button: 2, clientX: 120, clientY: 180 }));
    const menu = await screen.findByRole('menu', { name: 'Conversation actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Archive' }));

    // POST succeeds; the refetch 500s. The optimistic LOCAL removal must still
    // hide it (and keep it hidden) — the UI never shows a session the kernel
    // has archived just because the reconcile fetch failed.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Open chat session Archive then offline' })).not.toBeInTheDocument(),
    );
    // toast confirms the archive happened despite the failed reload
    expect(await screen.findByText('Conversation archived')).toBeInTheDocument();
  });

  it('does not resurrect an archived session when a later turn event arrives for it', async () => {
    additionalChatSessions = [
      {
        session_id: 'session_resurrect',
        title: 'Archived mid-turn',
        created_at: 1780669000,
        updated_at: 1780669300,
        messages: [{ role: 'user', content: 'hi', created_at: 1780669000 }],
        metadata: {},
      },
    ];
    // a turn completion that carries the archived session's id — this drives the
    // rememberBackendChatSession() refresh path for that id
    chatStreamFramesOverride = [
      ['chat.completed', { intent: 'chat', session_id: 'session_resurrect', backend: 'codex', status: 'completed', response: 'late reply' }],
    ];

    render(<App />);

    const sessionButton = await screen.findByRole('button', { name: 'Open chat session Archived mid-turn' });
    fireEvent(sessionButton, createEvent.contextMenu(sessionButton, { button: 2, clientX: 120, clientY: 180 }));
    const menu = await screen.findByRole('menu', { name: 'Conversation actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Open chat session Archived mid-turn' })).not.toBeInTheDocument(),
    );

    // a turn now completes carrying session_resurrect → rememberBackendChatSession
    // fires for a CONFIRMED-but-removed id; the synthetic record (no workspace_id/
    // archived/activity) must NOT resurrect it.
    const input = screen.getByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'trigger turn' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('late reply')).toBeInTheDocument(); // turn handler ran
    expect(screen.queryByRole('button', { name: 'Open chat session Archived mid-turn' })).not.toBeInTheDocument();
  });

  it('refetches with include_archived when the archived view is toggled on', async () => {
    render(<App />);

    await screen.findByLabelText('Recent Sessions');
    fireEvent.click(await screen.findByRole('button', { name: 'Show archived' }));

    await waitFor(() => {
      const sawArchivedFetch = vi.mocked(fetch).mock.calls.some(([input]) => {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
        return raw.includes('/api/chat/sessions') && raw.includes('include_archived=true');
      });
      expect(sawArchivedFetch).toBe(true);
    });
  });

  it('keeps the plan panel lean: no session archive, no duplicated conversation', async () => {
    additionalChatSessions = [
      {
        session_id: 'session_full_context',
        title: 'Long persisted conversation',
        created_at: 1780673000,
        updated_at: 1780673100,
        messages: [
          { role: 'user', content: 'first user detail', created_at: 1780673000 },
          { role: 'assistant', content: 'first assistant detail', created_at: 1780673010 },
          { role: 'user', content: 'second user detail', created_at: 1780673020 },
          { role: 'assistant', content: 'second assistant detail', created_at: 1780673030 },
          { role: 'user', content: 'final user detail', created_at: 1780673040 },
        ],
        metadata: {},
      },
    ];

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open chat session Long persisted conversation' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Panel/ }));

    const planCard = await screen.findByLabelText('Task plan');
    // unlinked chat -> light empty state describing where plans appear
    expect(within(planCard).getByText('Task plans and live progress appear here while a task is running.')).toBeInTheDocument();
    // the panel never echoes the conversation or the session list
    expect(within(planCard).queryByText('first user detail')).not.toBeInTheDocument();
    expect(within(planCard).queryByText('final user detail')).not.toBeInTheDocument();
    expect(within(planCard).queryByText('Long persisted conversation')).not.toBeInTheDocument();
    expect(screen.queryByText('Session Context')).not.toBeInTheDocument();
  });





  it('shows an unread dot only until a changed sidebar session is opened', async () => {
    localStorage.setItem(
      'superclaw_sidebar_known_updates',
      JSON.stringify({ 'backend-chat:session_unread': 1780673200000 }),
    );
    additionalChatSessions = [
      {
        session_id: 'session_unread',
        title: 'Unread persisted conversation',
        created_at: 1780673000,
        updated_at: 1780673300,
        messages: [
          { role: 'user', content: 'old detail', created_at: 1780673000 },
          { role: 'assistant', content: 'new detail', status: 'completed', created_at: 1780673300 },
        ],
        metadata: {},
      },
    ];

    render(<App />);

    const unreadSessionButton = await screen.findByRole('button', {
      name: 'Open chat session Unread persisted conversation',
    });
    expect(unreadSessionButton.querySelector('.sidebar-session-dot')).toBeTruthy();
    expect(within(unreadSessionButton).queryByText(/^(now|unknown age|\d+[mhd])$/)).not.toBeInTheDocument();

    fireEvent.click(unreadSessionButton);

    await waitFor(() => {
      const openedSessionButton = screen.getByRole('button', {
        name: 'Open chat session Unread persisted conversation',
      });
      expect(openedSessionButton.querySelector('.sidebar-session-dot')).toBeNull();
      expect(within(openedSessionButton).getByText(/^(now|unknown age|\d+[mhd])$/)).toBeInTheDocument();
    });
  });

  it('keeps the current chat open when another session completes in the background', async () => {
    additionalChatSessions = [
      {
        session_id: 'session_other',
        title: 'Keep this conversation open',
        created_at: 1780673000,
        updated_at: 1780673000,
        messages: [
          { role: 'user', content: 'other user detail', created_at: 1780673000 },
          { role: 'assistant', content: 'other assistant detail', status: 'completed', created_at: 1780673010 },
        ],
        metadata: {},
      },
    ];
    const encodeFrames = (frames: Array<[string, unknown]>) =>
      new TextEncoder().encode(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    let finishBackground!: () => void;
    const backgroundFinished = new Promise<void>((resolve) => {
      finishBackground = resolve;
    });
    const baseFetch = global.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestPath(input) !== '/api/chat/stream') return baseFetch(input, init);
        latestChatTurnRequest = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        const startedChunk = encodeFrames([['chat.started', { intent: 'chat', session_id: 'session_background', backend: 'codex' }]]);
        const finishedChunk = encodeFrames([
          ['message.delta', { text: 'Final background response' }],
          ['message.completed', { text: 'Final background response' }],
          [
            'chat.completed',
            {
              intent: 'chat',
              session_id: 'session_background',
              backend: 'codex',
              status: 'completed',
              response: 'Final background response',
            },
          ],
        ]);
        let readIndex = 0;
        return {
          ok: true,
          status: 200,
          headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
          body: {
            getReader: () => ({
              read: async () => {
                if (readIndex === 0) {
                  readIndex += 1;
                  return { done: false, value: startedChunk };
                }
                if (readIndex === 1) {
                  readIndex += 1;
                  await backgroundFinished;
                  return { done: false, value: finishedChunk };
                }
                return { done: true, value: undefined };
              },
              releaseLock: () => {},
              cancel: async () => {},
            }),
          },
        } as unknown as Response;
      }),
    );

    render(<App />);

    fireEvent.change(await screen.findByLabelText('Direct chat prompt'), { target: { value: 'Background answer' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));
    expect(await screen.findByRole('button', { name: 'Open chat session Background answer' })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Open chat session Keep this conversation open' }));
    expect(await screen.findByText('other assistant detail')).toBeInTheDocument();

    finishBackground();

    await waitFor(() => {
      const backgroundButton = screen.getByRole('button', { name: 'Open chat session Background answer' });
      expect(backgroundButton.querySelector('.sidebar-session-dot')).toBeTruthy();
    });
    expect(screen.getByText('other assistant detail')).toBeInTheDocument();
    expect(screen.queryByText('Final background response')).not.toBeInTheDocument();
  });

  it('adds a chat session to the sidebar as soon as the stream starts', async () => {
    additionalChatSessions = [];
    chatStreamFramesOverride = [['chat.started', { intent: 'chat', session_id: 'session_started', backend: 'codex' }]];

    render(<App />);

    fireEvent.change(await screen.findByLabelText('Direct chat prompt'), { target: { value: 'Explain optimistic sessions' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));

    const startedSessionButton = await screen.findByRole('button', {
      name: 'Open chat session Explain optimistic sessions',
    });
    expect(within(startedSessionButton).getByText('now')).toBeInTheDocument();
    expect(startedSessionButton.querySelector('.sidebar-session-running-mark')).toBeNull();
    expect(startedSessionButton.querySelector('.sidebar-session-dot')).toBeNull();

    await waitFor(() => expect(latestChatTurnRequest).toBeTruthy());
    expect(latestChatTurnRequest?.session_id).toBeUndefined();
  });

  it('shows the failure reason in the transcript when a chat turn fails (not a silent blank)', async () => {
    // A claude 401 / any failed turn must surface WHY in the transcript — the
    // user reported a completely blank reply with no auth hint.
    chatStreamFramesOverride = [
      ['chat.started', { intent: 'chat', session_id: 'sess_fail', backend: 'claude' }],
      ['message.completed', { text: 'Failed to authenticate. API Error: 401 Invalid authentication credentials' }],
      ['chat.completed', { intent: 'chat', session_id: 'sess_fail', backend: 'claude', status: 'failed', response: null, failure_reason: 'claude native chat failed (exit 1): Failed to authenticate. API Error: 401 Invalid authentication credentials' }],
    ];
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Direct chat prompt'), { target: { value: '你是什么模型' } });
    fireEvent.keyDown(screen.getByLabelText('Direct chat prompt'), { key: 'Enter' });
    const matches = await screen.findAllByText(/Failed to authenticate/);
    expect(matches.length).toBeGreaterThan(0);
    // An auth failure also raises a prominent dismissible login banner.
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveClass('runtime-login-notice');
    expect(banner.textContent).toMatch(/Failed to authenticate/);
    // ...and it can be dismissed.
    fireEvent.click(banner.querySelector('.runtime-login-notice-dismiss') as HTMLButtonElement);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('sends a chat turn on Enter and inserts a newline on Shift+Enter', async () => {
    render(<App />);

    const input = await screen.findByLabelText('Direct chat prompt');

    // Shift+Enter must not submit (lets the textarea insert a newline instead).
    fireEvent.change(input, { target: { value: 'first line' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(latestChatTurnRequest).toBeNull();

    // A bare Enter submits the chat turn in auto mode.
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(latestChatTurnRequest).toBeTruthy());
    expect(latestChatTurnRequest?.mode).toBe('auto');
  });

  it('does not send while an IME composition is active', async () => {
    render(<App />);

    const input = await screen.findByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: '你好' } });
    // Enter committing IME candidates carries isComposing — it must not submit.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(latestChatTurnRequest).toBeNull();
  });

  it('queues a prompt sent while a turn is in flight and runs it in FIFO order', async () => {
    render(<App />);

    const input = await screen.findByLabelText('Direct chat prompt');
    // First prompt starts running; the second is submitted before it settles, so it must queue.
    fireEvent.change(input, { target: { value: 'first prompt' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'second prompt' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const messages = vi
        .mocked(fetch)
        .mock.calls.filter(([path]) => String(path).includes('/api/chat/stream'))
        .map(([, init]) => JSON.parse(String((init as RequestInit)?.body ?? '{}')).message);
      expect(messages).toContain('first prompt');
      expect(messages).toContain('second prompt');
      expect(messages.indexOf('first prompt')).toBeLessThan(messages.indexOf('second prompt'));
    });
  });

  it('runs a new chat immediately while another chat is in flight (per-session queues, no cross-chat blocking)', async () => {
    // The bug: a global queue meant ANY chat running forced a brand-new chat's
    // prompt into the queue. With per-session queues, chat B must fire its own
    // request immediately even though chat A is still streaming.
    const encodeFrames = (frames: Array<[string, unknown]>) =>
      new TextEncoder().encode(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    let finishA!: () => void;
    const aFinished = new Promise<void>((resolve) => {
      finishA = resolve;
    });
    const baseFetch = global.fetch;
    let streamCalls = 0;
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestPath(input) !== '/api/chat/stream') return baseFetch(input, init);
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        streamCalls += 1;
        if (streamCalls === 1) {
          // Chat A: announce its server session id, then stay in flight (hang)
          // until released — so its key is the real 'b:sess-a', not 'draft'.
          let idx = 0;
          return {
            ok: true,
            status: 200,
            headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
            body: {
              getReader: () => ({
                read: async () => {
                  if (idx === 0) {
                    idx += 1;
                    return { done: false, value: encodeFrames([['chat.started', { intent: 'chat', session_id: 'sess-a', backend: 'codex' }]]) };
                  }
                  if (idx === 1) {
                    idx += 1;
                    await aFinished;
                    return { done: false, value: encodeFrames([['chat.completed', { intent: 'chat', session_id: 'sess-a', backend: 'codex', status: 'completed', response: 'A done' }]]) };
                  }
                  return { done: true, value: undefined };
                },
                releaseLock: () => {},
                cancel: async () => {},
              }),
            },
          } as unknown as Response;
        }
        return sseStreamResponse([
          ['chat.started', { intent: 'chat', session_id: 'sess-b', backend: 'codex' }],
          ['message.delta', { text: 'B reply' }],
          ['message.completed', { text: 'B reply' }],
          ['chat.completed', { intent: 'chat', session_id: 'sess-b', backend: 'codex', status: 'completed', response: 'B reply' }],
        ]);
      }),
    );

    render(<App />);
    const input = await screen.findByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'chat A prompt' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // A is now in flight with its real session id (chat.started arrived).
    await screen.findByRole('button', { name: 'Open chat session chat A prompt' });

    // Open a brand-new chat while A is still streaming.
    fireEvent.click(await screen.findByRole('button', { name: 'New Session' }));
    fireEvent.change(await screen.findByLabelText('Direct chat prompt'), { target: { value: 'chat B prompt' } });
    fireEvent.keyDown(screen.getByLabelText('Direct chat prompt'), { key: 'Enter' });

    // B fired its OWN request immediately — under the old global queue it would
    // have stayed queued (streamCalls === 1) until A finished.
    await waitFor(() => {
      expect(bodies.map((b) => b.message)).toContain('chat B prompt');
    });
    expect(streamCalls).toBeGreaterThanOrEqual(2);
    // Let B fully settle (its reply renders + async tail completes) so neither
    // chat's in-flight work leaks into the next test.
    expect(await screen.findByText('B reply')).toBeInTheDocument();
    finishA();
    await waitFor(() => {
      const aButton = screen.getByRole('button', { name: 'Open chat session chat A prompt' });
      expect(aButton.querySelector('.sidebar-session-running-mark')).toBeNull();
    });
  });

  it('queues a turn from a brand-new draft into its own session, never drifting onto another', async () => {
    render(<App />);

    const input = await screen.findByLabelText('Direct chat prompt');
    // Two prompts fired in instant succession at a brand-new chat (the second
    // queues before the first has a server id). A queued turn whose origin
    // backend is empty must NOT guess a session — not the live active chat, not
    // whatever turn happens to be in flight — because every guess can route it
    // into an unrelated session (the drift class Codex flagged). It opens its
    // own fresh session instead (session_id omitted). The common case — a reply
    // arrives, THEN the user sends again — is unaffected: by then the session
    // exists and the next turn's origin backend is non-empty, so it continues.
    fireEvent.change(input, { target: { value: 'first prompt' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'second prompt' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const bodies = vi
        .mocked(fetch)
        .mock.calls.filter(([path]) => String(path).includes('/api/chat/stream'))
        .map(([, init]) => JSON.parse(String((init as RequestInit)?.body ?? '{}')));
      const second = bodies.find((body) => body.message === 'second prompt');
      expect(second).toBeTruthy();
      // Empty origin → fresh session: session_id is omitted, and it is NEVER the
      // session the first draft turn opened (that would be the drift bug).
      expect(second?.session_id).toBeUndefined();
    });
  });

  it('loads plugin control data without a token when the sidecar is open locally', async () => {
    localStorage.clear();
    localStorage.setItem('superclaw_landing_surface', 'chat');
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      if (path === '/api/pay-switch/status') {
        return new Response(JSON.stringify({ mode: 'governed_optional' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/backends') return new Response(JSON.stringify({ backends: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (path === '/api/harnesses') return new Response(JSON.stringify({ harnesses: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (path === '/api/evals') return new Response(JSON.stringify({ evals: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (path === '/api/fusion/status') {
        return new Response(JSON.stringify({ schema_version: '1', network_policy: { active_probe_default: 'governed_optional' }, profiles: {}, components: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/runtime/status') {
        return new Response(
          JSON.stringify({
            runtime_version: '0.1.0',
            backend: 'claude',
            mode: 'auto',
            service: {
              name: 'superclaw',
              version: '0.1.0',
              pid: 3131,
              bind: '127.0.0.1',
              control_token: 'unset',
              uptime_seconds: 5,
              control_token_required: false,
            },
            state: { path: '.superclaw/state.db', active_run_ids: [], recent_run_id: null },
            agents: { count: 0, ready_count: 0, status_url: '/api/agents' },
            plugins: { plugin_count: 1, status_url: '/api/plugins/status' },
            config: { path: '.superclaw/shell-config.toml', status_url: '/api/config' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/desktop/onboarding') {
        return new Response(
          JSON.stringify({
            workspace_root: '/Users/leongong/Documents/superClaw',
            quickstart_path: 'docs/desktop-beta-quickstart.md',
            status_url: '/api/desktop/onboarding',
            summary: { ready: false, ready_count: 2, total_count: 6 },
            checks: [
              { title: 'Runtime service', ready: true, detail: '0.1.0 / backend claude / mode auto', remediation: 'The local ClawHunt runtime is already serving the control-plane APIs.' },
              { title: 'Desktop toolchain', ready: true, detail: 'Packaged beta mode does not require a local source-build toolchain.', remediation: 'Use the packaged beta path unless you plan to build ClawHunt from source.' },
              { title: 'Dependency doctor', ready: false, detail: 'Needs setup: Codex, Hermes, Claude Code, OpenClaw.', remediation: 'Install Codex CLI or set SUPERCLAW_CODEX_EXECUTABLE to the local codex binary.' },
              { title: 'Beta acceptance', ready: false, detail: 'No acceptance report found yet.', remediation: 'Run `npm --prefix apps/desktop run test:beta-acceptance` and review `/tmp/desktop-beta-acceptance.json`.' },
              { title: 'ClawHunt login', ready: false, detail: 'No ClawHunt agent key is configured yet.', remediation: 'Sign in with a ClawHunt account, then create or paste an agent key before browsing or submitting market work.' },
              { title: 'Plugin trust root', ready: false, detail: 'Registry signature root is not configured yet.', remediation: 'Configure the plugin public key before relying on marketplace installs.' },
            ],
            dependency_targets: [
              { name: 'codex', label: 'Codex', installed: false, detail: 'missing', remediation: 'Install Codex CLI or set SUPERCLAW_CODEX_EXECUTABLE to the local codex binary.' },
              { name: 'hermes', label: 'Hermes', installed: false, detail: 'missing', remediation: 'Install Hermes CLI or set SUPERCLAW_HERMES_EXECUTABLE to the local hermes binary.' },
              { name: 'claude', label: 'Claude Code', installed: false, detail: 'missing', remediation: 'Install Claude Code or set SUPERCLAW_CLAUDE_EXECUTABLE to the local claude binary.' },
              { name: 'openclaw', label: 'OpenClaw', installed: false, detail: 'missing', remediation: 'Install OpenClaw or set SUPERCLAW_OPENCLAW_EXECUTABLE to the local openclaw binary.' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/desktop/toolchain') {
        return new Response(
          JSON.stringify({
            workspace_root: '/Users/leongong/Documents/superClaw',
            desktop_root: '/Users/leongong/Documents/superClaw/apps/desktop',
            source_workspace: false,
            tools: [],
            summary: { required_count: 0, ready_count: 0, source_build_ready: true },
            status_url: '/api/desktop/toolchain',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/desktop/acceptance') {
        return new Response(
          JSON.stringify({
            workspace_root: '/Users/leongong/Documents/superClaw',
            desktop_root: '/Users/leongong/Documents/superClaw/apps/desktop',
            source_workspace: false,
            report_path: '/tmp/desktop-beta-acceptance.json',
            status_url: '/api/desktop/acceptance',
            generate_command: 'npm --prefix apps/desktop run test:beta-acceptance',
            quickstart_path: 'docs/desktop-beta-quickstart.md',
            exists: false,
            summary: {
              ready: false,
              success: null,
              failed_step: null,
              generated_at: null,
              completed_steps: 0,
              total_steps: 0,
            },
            report: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/tui/acceptance') {
        return new Response(
          JSON.stringify({
            workspace_root: '/Users/leongong/Documents/superClaw',
            report_path: '/Users/leongong/Documents/superClaw/.superclaw/tui/tui-acceptance.json',
            status_url: '/api/tui/acceptance',
            generate_command: 'PYTHONPATH=packages/superclaw/src .venv/bin/python -m superclaw.cli tui-acceptance',
            exists: false,
            summary: {
              ready: false,
              success: null,
              failed_step: null,
              generated_at: null,
              completed_steps: 0,
              total_steps: 0,
            },
            report: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/runs') return new Response(JSON.stringify({ runs: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	      if (path === '/api/chat/sessions') {
	        return new Response(
	          JSON.stringify({
	            sessions: [
	              {
	                session_id: 'session_desktop',
	                title: 'What is ClawHunt?',
	                created_at: 1780669000,
	                updated_at: 1780669100,
	                messages: [
	                  { role: 'user', content: 'What is ClawHunt?', created_at: 1780669000 },
	                  { role: 'assistant', content: 'Direct answer from Codex desktop mode.', created_at: 1780669100 },
	                ],
	                metadata: {},
	              },
	            ],
	          }),
	          { status: 200, headers: { 'Content-Type': 'application/json' } },
	        );
	      }
      if (path === '/api/config') {
        return new Response(
          JSON.stringify({
            config_path: '.superclaw/shell-config.toml',
            defaults: { backend: 'claude', mode: 'auto' },
            auth: { clawhunt_agent_api_key: 'unset', control_token: 'unset', anthropic_api_key: 'unset', gemini_api_key: 'unset' },
            entries: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/agents') return new Response(JSON.stringify({ agents: [], summary: { count: 0, ready_count: 0 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (path === '/api/auth/status') {
        return new Response(
          JSON.stringify({
            clawhunt: {
              account: 'unset',
              agent_api_key: 'unset',
              base_url: 'https://clawhunt.store',
              account_user: null,
              agent_key_source: null,
              agent_key_name: null,
              account_login_url: '/api/auth/clawhunt/account/login',
              account_login_probe_url: '/api/auth/clawhunt/account/login-probe',
              account_profile_url: '/api/auth/clawhunt/account/me',
              account_agents_url: '/api/auth/clawhunt/account/agents',
              agent_key_create_url: '/api/auth/clawhunt/agent-key',
              profile_url: '/api/auth/clawhunt/me',
              login_url: '/api/auth/clawhunt/login',
              logout_url: '/api/auth/clawhunt/logout',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/auth/clawhunt/account/login-probe') {
        return new Response(JSON.stringify({ ok: true, reachable: true, login_endpoint: true, base_url: 'https://clawhunt.store', status_code: 401, detail: 'login endpoint reachable; credentials rejected as expected' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/plugins/status') {
        return new Response(
          JSON.stringify({
            cache_root: '.superclaw/plugins/cache',
            cloud_root: '.superclaw/plugins/cloud',
            developer_submission_root: '.superclaw/plugins/developer-submissions',
            clawhunt_ingestion_root: '.superclaw/plugins/clawhunt-ingestion',
            plugin_count: 1,
            plugins: [{ id: 'dev.superclaw.hello-world', version: '0.1.0', name: 'Hello World', path: '.superclaw/plugins/cache/demo' }],
            verification: {
              public_key_configured: false,
              install_url: '/api/plugins/install',
              local_install_url: '/api/plugins/install-local',
              uninstall_url: '/api/plugins/uninstall',
            },
            registry: { count: 1, status_url: '/v1/plugins', error: null },
            governance: { revocation_count: 0, policy_count: 1, revocations_url: '/v1/plugins/revocations', policy_url: '/v1/policies/runtime', revocation_error: null, policy_error: null },
            configuration: {
              status_url: '/api/plugins/{plugin_id}/configuration',
              setting_url: '/api/plugins/config/set',
              secret_url: '/api/plugins/secret/set',
              secret_delete_url: '/api/plugins/secret/delete',
            },
            diagnostics: {
              status_url: '/api/plugins/diagnostics',
              events_url: '/api/plugins/diagnostics/events',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/marketplace-catalog') {
        return new Response(JSON.stringify({ source: 'clawhunt_server', total: 0, plugins: [], error: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/plugins/workshop-catalog') {
        return new Response(JSON.stringify({ source: 'clawhunt_workshop', total: 0, plugins: [], error: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/plugins/diagnostics') {
        return new Response(
          JSON.stringify({
            ok: true,
            artifact_count: 0,
            artifact_dir: '.superclaw/artifacts/plugins',
            summary: {
              plugins: 0,
              tools: 0,
              failures: 0,
              slow_calls: 0,
              sandbox_kills: 0,
            },
            thresholds: {
              slow_call_ms: 30000,
              failure_rate_threshold: 0.5,
              failure_rate_min_invocations: 3,
              sandbox_kill_threshold: 2,
            },
            findings: [],
            status_url: '/api/plugins/diagnostics',
            events_url: '/api/plugins/diagnostics/events',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/dev.superclaw.hello-world/configuration?version=0.1.0') {
        return new Response(
          JSON.stringify({
            plugin_id: 'dev.superclaw.hello-world',
            version: '0.1.0',
            name: 'Hello World',
            runtime: { type: 'mcp_sidecar' },
            configuration: { settings: [], secrets: [] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/v1/plugins') {
        return new Response(
          JSON.stringify({ plugins: [{ plugin_id: 'dev.superclaw.hello-world', version: '0.1.0', name: 'Hello World', summary: 'Simple registry plugin.', category: 'utility', runtime: 'mcp_sidecar', platforms: ['darwin-arm64'], acceptance_level: 'L1', verified: true, pricing_model: 'free', package_digest: 'sha256:abc', compatibility: { superclaw: '>=0.1.0' }, entitlement_required: false }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/v1/plugins/revocations') return new Response(JSON.stringify({ revoked: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (path === '/v1/policies/runtime') return new Response(JSON.stringify({ policies: [{ plugin_id: 'dev.superclaw.hello-world', version: '0.1.0' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unhandled fetch path: ${path}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Capability Workshop' }));
    expect(await screen.findByRole('heading', { name: 'Capability Workshop' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Let ClawHunt work your way' })).toBeInTheDocument();
    expect(await screen.findAllByText('Hello World')).not.toHaveLength(0);
    // The source label moved to the detail sub-page — open the card to confirm the
    // server-catalog provenance loaded (proves plugin control data was fetched).
    fireEvent.click((await screen.findAllByRole('button', { name: /^View details: Hello World/ }))[0]);
    expect(await screen.findByText('Server catalog')).toBeInTheDocument();
  });

  it('restores a chat sticky runtime and inherits the last-used runtime for chats without one', async () => {
    additionalChatSessions = [
      {
        session_id: 'session_sticky',
        title: 'Sticky runtime chat',
        created_at: 1780669200,
        updated_at: 1780669300,
        messages: [{ role: 'user', content: 'first turn', created_at: 1780669200 }],
        metadata: { runtime: { backend: 'claude', model: 'claude-sonnet-4-6' } },
      },
    ];
    render(<App />);

    const backendTrigger = await screen.findByLabelText('Backend');
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat session Sticky runtime chat' }));
    await waitFor(() => {
      expect(backendTrigger).toHaveTextContent('Claude Code');
      expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('claude-sonnet-4-6');
    });

    // 规范3: a chat WITHOUT a recorded runtime INHERITS the current composer
    // selection (last-used carry-over) — switching into it must NOT snap back to
    // the configured default. The sticky chat above left claude+sonnet selected,
    // so the runtime-less chat keeps them.
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat session Backend persisted session' }));
    await waitFor(() => {
      expect(backendTrigger).toHaveTextContent('Claude Code');
      expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('claude-sonnet-4-6');
    });
  });

  it('selects the per-chat runtime from the composer and clears the model on backend switch', async () => {
    render(<App />);

    // backend pill is contract-driven (/api/agents labels), never hardcoded
    const backendTrigger = await screen.findByLabelText('Backend');
    fireEvent.click(backendTrigger);
    const claudeOption = await screen.findByRole('option', { name: 'Claude Code' });
    expect(screen.getByRole('option', { name: 'Codex CLI' })).toBeInTheDocument();
    fireEvent.click(claudeOption);

    // claude supports model selection -> the model field is offered with suggestions
    const modelInput = (await screen.findByLabelText('Model')) as HTMLInputElement;
    fireEvent.change(modelInput, { target: { value: 'claude-sonnet-4-6' } });

    const input = await screen.findByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'hello runtime' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));

    await waitFor(() => {
      expect(latestChatTurnRequest).toBeTruthy();
      expect(latestChatTurnRequest?.backend_policy).toBe('claude');
      expect(latestChatTurnRequest?.model).toBe('claude-sonnet-4-6');
    });

    // kernel rule mirrored in the UI: switching backend clears the model selection
    fireEvent.click(backendTrigger);
    fireEvent.click(await screen.findByRole('option', { name: 'Codex CLI' }));
    await waitFor(() => {
      expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('');
    });
  });

  it('surfaces the resolved default model as the placeholder without claiming a selection', async () => {
    render(<App />);

    const backendTrigger = await screen.findByLabelText('Backend');
    fireEvent.click(backendTrigger);
    fireEvent.click(await screen.findByRole('option', { name: 'Claude Code' }));

    // No per-chat model picked: the input VALUE stays '' (so the turn sends
    // model:'' = REQUEST_CLEAR / follow backend default), while the PLACEHOLDER
    // surfaces the concrete model a blank field actually runs (fixture
    // default_model 'claude-opus-4-8'). What-you-see-is-what-you-send holds.
    const modelInput = (await screen.findByLabelText('Model')) as HTMLInputElement;
    await waitFor(() => {
      expect(modelInput.value).toBe('');
      expect(modelInput.placeholder).toBe('claude-opus-4-8');
    });

    // Sentinel-default backend (codex: default_model 'configured-default') must
    // never leak the sentinel into the placeholder — it falls back to neutral copy.
    fireEvent.click(backendTrigger);
    fireEvent.click(await screen.findByRole('option', { name: 'Codex CLI' }));
    await waitFor(() => {
      const codexModel = screen.getByLabelText('Model') as HTMLInputElement;
      expect(codexModel.value).toBe('');
      expect(codexModel.placeholder).not.toContain('configured-default');
    });
  });

  it('ranks unconfigured runtimes last with a badge and routes their selection to runtime settings', async () => {
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestPath(input) === '/api/agents') {
          return new Response(
            JSON.stringify({
              // contract lists the unconfigured agent first on purpose: the
              // composer must still rank available runtimes ahead of it
              agents: [
                {
                  name: 'cursor',
                  available: false,
                  reason: 'cursor executable not found',
                  kind: 'cli',
                  configure: '/config set SUPERCLAW_CURSOR_EXECUTABLE /path/to/cursor',
                  config_env: 'SUPERCLAW_CURSOR_EXECUTABLE',
                  config_state: 'unset',
                  label: 'Cursor CLI',
                  chat_tier: 'upgradeable',
                },
                {
                  name: 'codex',
                  available: true,
                  executable: '/opt/homebrew/bin/codex',
                  version: '0.133.0',
                  kind: 'cli',
                  configure: '/config set SUPERCLAW_CODEX_EXECUTABLE /path/to/codex',
                  config_env: 'SUPERCLAW_CODEX_EXECUTABLE',
                  config_state: '/opt/homebrew/bin/codex',
                  label: 'Codex CLI',
                  chat_tier: 'native',
                },
                {
                  name: 'openclaw-gateway',
                  available: true,
                  executable: 'ws://127.0.0.1:18789',
                  version: '0.1.0',
                  kind: 'gateway',
                  configure: '/config set SUPERCLAW_OPENCLAW_GATEWAY_URL ws://127.0.0.1:18789',
                  label: 'OpenClaw gateway',
                  chat_tier: 'infra',
                },
              ],
              summary: { count: 3, ready_count: 2 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);

    const backendTrigger = await screen.findByLabelText('Backend');
    fireEvent.click(backendTrigger);

    const options = await screen.findAllByRole('option');
    expect(options[0]).toHaveTextContent('Codex CLI');
    expect(options[0]).not.toHaveTextContent('Not configured');
    expect(options[1]).toHaveTextContent('Cursor CLI');
    expect(options[1]).toHaveTextContent('Not configured');
    expect(screen.queryByRole('option', { name: 'OpenClaw gateway' })).not.toBeInTheDocument();

    // picking the unconfigured runtime routes to the Runtime tab, whose roster lists it
    fireEvent.click(options[1]);
    expect(await screen.findByRole('heading', { name: 'Agents & execution' })).toBeInTheDocument();
    const roster = await screen.findByLabelText('Runtime health');
    expect(within(roster).getByText('cursor')).toBeInTheDocument();
  });

  it('never defaults to a non-chat-capable backend even when it is the persisted default (acpx_local)', async () => {
    // Regression: acpx_local is an incomplete adapter (chat_tier:null). Even when
    // it is the persisted default backend, the composer must NOT select or list it
    // — it falls to the chat-capable claude_local. The run path rejects acpx anyway,
    // so it must never be the silent default.
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === '/api/config') {
          return new Response(
            JSON.stringify({
              entries: [{ name: 'backend', persisted: true, configured: true }],
              defaults: { backend: 'acpx_local', mode: 'auto' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/agents') {
          return new Response(
            JSON.stringify({
              agents: [
                { name: 'acpx_local', available: true, kind: 'cli', label: 'ACPX (local)', chat_tier: null },
                { name: 'claude_local', available: true, kind: 'cli', label: 'Claude (local)', chat_tier: 'native' },
              ],
              summary: { count: 2, ready_count: 2 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    const backendTrigger = await screen.findByLabelText('Backend');
    await waitFor(() => expect(backendTrigger).toHaveTextContent('Claude (local)'));
    fireEvent.click(backendTrigger);
    expect(screen.queryByRole('option', { name: /ACPX/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Claude (local)' })).toBeInTheDocument();
  });

  it('does not select acpx_local even when it is the persisted default AND the only runtime', async () => {
    // Degenerate last-resort fallback: persisted default acpx_local with NO
    // alternative runtime in the inventory. The composer must STILL not select or
    // list it (the run path rejects it) — it shows no usable default rather than
    // re-surfacing acpx via name === selectedBackend.
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === '/api/config') {
          return new Response(
            JSON.stringify({
              entries: [{ name: 'backend', persisted: true, configured: true }],
              defaults: { backend: 'acpx_local', mode: 'auto' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/agents') {
          return new Response(
            JSON.stringify({
              agents: [
                { name: 'acpx_local', available: true, kind: 'cli', label: 'ACPX (local)', chat_tier: null },
              ],
              summary: { count: 1, ready_count: 1 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    const backendTrigger = await screen.findByLabelText('Backend');
    await waitFor(() => expect(backendTrigger).not.toHaveTextContent('ACPX'));
    fireEvent.click(backendTrigger);
    expect(screen.queryByRole('option', { name: /ACPX/ })).not.toBeInTheDocument();
  });

  it('offers a relay-backed runtime (uses_relay_packages) in the composer despite infra tier', async () => {
    // clawwork is chat_tier "infra" but a real relay-backed chat runtime; it must
    // be directly pickable (parity with CLI `chat --backend clawwork`). Keyed off
    // the uses_relay_packages contract signal, not a hardcoded backend name.
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === '/api/agents') {
          return new Response(
            JSON.stringify({
              agents: [
                {
                  name: 'codex',
                  available: true,
                  executable: '/opt/homebrew/bin/codex',
                  kind: 'cli',
                  label: 'Codex CLI',
                  chat_tier: 'native',
                },
                {
                  name: 'openclaw-gateway',
                  available: true,
                  executable: 'ws://127.0.0.1:18789',
                  kind: 'gateway',
                  label: 'OpenClaw gateway',
                  chat_tier: 'infra',
                },
                {
                  name: 'clawwork',
                  available: true,
                  executable: '/path/to/clawwork',
                  kind: 'cli',
                  label: 'ClawWork (relay)',
                  chat_tier: 'infra',
                  uses_relay_packages: true,
                },
              ],
              summary: { count: 3, ready_count: 3 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/relay/packages') {
          return new Response(
            JSON.stringify({
              packages: [{ id: 'core', name: 'Core', tier: 'core', group_slug: 'superclaw-core' }],
              source: 'default',
              available: true,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    const backendTrigger = await screen.findByLabelText('Backend');
    // Auto-default lands on the interactive runtime (Codex), NEVER the relay-backed
    // clawwork — it needs explicit login + relay key, so it is pick-only.
    await waitFor(() => expect(backendTrigger).toHaveTextContent('Codex CLI'));

    fireEvent.click(backendTrigger);
    // relay-backed clawwork is pickable...
    const clawworkOption = await screen.findByRole('option', { name: 'ClawWork (relay)' });
    expect(clawworkOption).toBeInTheDocument();
    // ...while a plain infra runtime (no relay packages) stays curated out.
    expect(screen.queryByRole('option', { name: 'OpenClaw gateway' })).not.toBeInTheDocument();

    // Picking clawwork swaps the raw model picker for the 套餐 (package) selector —
    // parity is "usable", not merely "visible".
    fireEvent.click(clawworkOption);
    expect(await screen.findByLabelText('Package')).toBeInTheDocument();
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
  });

  it('never silently auto-defaults to a relay-backed runtime, even with no interactive runtime', async () => {
    // Negative path: no native/upgradeable runtime present, only a relay-backed
    // clawwork and a plain non-relay infra. Auto-default must land on the non-relay
    // one (or nothing) — clawwork needs login + a relay key, so it is pick-only.
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestPath(input) === '/api/agents') {
          return new Response(
            JSON.stringify({
              agents: [
                {
                  name: 'clawwork',
                  available: true,
                  executable: '/path/to/clawwork',
                  kind: 'cli',
                  label: 'ClawWork (relay)',
                  chat_tier: 'infra',
                  uses_relay_packages: true,
                },
                {
                  name: 'openclaw-gateway',
                  available: true,
                  executable: 'ws://127.0.0.1:18789',
                  kind: 'gateway',
                  label: 'OpenClaw gateway',
                  chat_tier: 'infra',
                },
              ],
              summary: { count: 2, ready_count: 2 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    const backendTrigger = await screen.findByLabelText('Backend');
    // default settles on the non-relay infra, never the relay-backed clawwork
    await waitFor(() => expect(backendTrigger).toHaveTextContent('OpenClaw gateway'));
    expect(backendTrigger).not.toHaveTextContent('ClawWork (relay)');
  });

  it('sends the selected 套餐 (package) as the model on a clawwork chat turn', async () => {
    // "usable, not merely visible": picking clawwork + a package must put the
    // package id into the chat-turn request `model` (with backend_policy=clawwork).
    // The fixture mirrors the real contract (supports_model_selection: true), so a
    // future drop of that flag — which would silently null the package on send
    // (model: supports_model_selection ? selectedModel : '') — fails this test.
    let sentBody: Record<string, unknown> | null = null;
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === '/api/agents') {
          return new Response(
            JSON.stringify({
              agents: [
                { name: 'codex', available: true, executable: '/bin/codex', kind: 'cli', label: 'Codex CLI', chat_tier: 'native' },
                {
                  name: 'clawwork',
                  available: true,
                  executable: '/path/to/clawwork',
                  kind: 'cli',
                  label: 'ClawWork (relay)',
                  chat_tier: 'infra',
                  uses_relay_packages: true,
                  supports_model_selection: true,
                  default_model: 'configured-default',
                },
              ],
              summary: { count: 2, ready_count: 2 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/relay/packages') {
          return new Response(
            JSON.stringify({
              packages: [{ id: 'core', name: 'Core', tier: 'Core', group_slug: 'superclaw-core' }],
              source: 'default',
              available: true,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/chat/stream') {
          sentBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          return sseStreamResponse([
            ['chat.started', { intent: 'chat', session_id: 'session_cw', backend: 'clawwork' }],
            ['message.completed', { text: 'ok' }],
            ['chat.completed', { intent: 'chat', session_id: 'session_cw', backend: 'clawwork', status: 'completed', response: 'ok' }],
          ]);
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    // pick clawwork as the runtime (switching backend clears any model selection)
    fireEvent.click(await screen.findByLabelText('Backend'));
    fireEvent.click(await screen.findByRole('option', { name: 'ClawWork (relay)' }));
    // pick the Core package from the 套餐 selector (wait for relayPackages to load)
    const packageTrigger = await screen.findByLabelText('Package');
    await waitFor(() => {
      fireEvent.click(packageTrigger);
      expect(screen.getByRole('option', { name: 'Core' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('option', { name: 'Core' }));
    // send a turn
    const input = await screen.findByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'hi clawwork' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(sentBody).toBeTruthy());
    expect(sentBody).toMatchObject({ message: 'hi clawwork', backend_policy: 'clawwork', model: 'core' });
  });

  it('sends a composite <tier>::<model> when a level-2 model is picked in a multi-model package', async () => {
    // Two-level menu (clawwork-only): picking a package tier with MORE than one model
    // reveals a level-2 Model dropdown; selecting a concrete model must submit the
    // composite "plus::<model>" in the chat-turn `model`. Exercises the on-demand
    // /api/relay/packages/{tier}/models fetch + composite encoding end-to-end.
    let sentBody: Record<string, unknown> | null = null;
    let modelsFetched = 0;
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === '/api/agents') {
          return new Response(
            JSON.stringify({
              agents: [
                { name: 'codex', available: true, executable: '/bin/codex', kind: 'cli', label: 'Codex CLI', chat_tier: 'native' },
                {
                  name: 'clawwork',
                  available: true,
                  executable: '/path/to/clawwork',
                  kind: 'cli',
                  label: 'ClawWork (relay)',
                  chat_tier: 'infra',
                  uses_relay_packages: true,
                  supports_model_selection: true,
                  default_model: 'core',
                },
              ],
              summary: { count: 2, ready_count: 2 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/relay/packages') {
          return new Response(
            JSON.stringify({
              packages: [{ id: 'plus', name: 'Plus', tier: 'plus', group_slug: 'superclaw-plus', locked: false }],
              source: 'catalog',
              available: true,
              tier_ceiling: 'max',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/relay/packages/plus/models') {
          modelsFetched += 1;
          return new Response(
            JSON.stringify({ ok: true, tier: 'plus', group_slug: 'superclaw-plus', models: ['claude-opus-4-8', 'claude-opus-4-7'] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/chat/stream') {
          sentBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          return sseStreamResponse([
            ['chat.started', { intent: 'chat', session_id: 'session_cw2', backend: 'clawwork' }],
            ['message.completed', { text: 'ok' }],
            ['chat.completed', { intent: 'chat', session_id: 'session_cw2', backend: 'clawwork', status: 'completed', response: 'ok' }],
          ]);
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    fireEvent.click(await screen.findByLabelText('Backend'));
    fireEvent.click(await screen.findByRole('option', { name: 'ClawWork (relay)' }));
    // level-1: pick the Plus package
    const packageTrigger = await screen.findByLabelText('Package');
    await waitFor(() => {
      fireEvent.click(packageTrigger);
      expect(screen.getByRole('option', { name: /Plus/ })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('option', { name: /Plus/ }));
    // level-2 Model dropdown appears once the tier's (>1) models load on demand
    const modelTrigger = await screen.findByLabelText('Model');
    expect(modelsFetched).toBeGreaterThanOrEqual(1);
    fireEvent.click(modelTrigger);
    fireEvent.click(await screen.findByRole('option', { name: 'claude-opus-4-7' }));
    // send a turn — the composite must ride the `model` field
    const input = await screen.findByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'hi plus' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(sentBody).toBeTruthy());
    expect(sentBody).toMatchObject({ message: 'hi plus', backend_policy: 'clawwork', model: 'plus::claude-opus-4-7' });
  });

  it('strips the account-scoped model from a relay composite when switching to a different account', async () => {
    // Regression (Codex re-review #3): the level-2 model is bound to the signed-in
    // account's relay key. Signing in as a DIFFERENT account (here account A -> logout ->
    // account B, the UI-reachable switch path) must drop the account-scoped concrete model
    // so account A's ``plus::<A-model>`` is never SUBMITTED under B — it degrades to the
    // bare tier ``plus`` (the account-agnostic level-1 choice). The prev-signed-in-key ref
    // (kept across the signed-out gap) is what distinguishes a real switch from a same
    // account re-login / restore.
    let sentBody: Record<string, unknown> | null = null;
    let phase: 'A' | 'out' | 'B' = 'A';
    const userFor = () => (phase === 'A' ? { id: 'acctA', email: 'a@clawhunt.test' } : phase === 'B' ? { id: 'acctB', email: 'b@clawhunt.test' } : null);
    const authPayload = () => ({
      clawhunt: {
        account: phase === 'out' ? 'unset' : 'set',
        agent_api_key: phase === 'out' ? 'unset' : 'set', // signed-in: skip auto-provision
        base_url: 'https://clawhunt.store',
        account_user: userFor(),
        account_source: phase === 'out' ? null : 'clawhunt_google_browser',
        login_source: phase === 'out' ? null : 'superclaw',
        account_login_url: '/api/auth/clawhunt/account/login',
        account_login_probe_url: '/api/auth/clawhunt/account/login-probe',
        account_profile_url: '/api/auth/clawhunt/account/me',
        account_agents_url: '/api/auth/clawhunt/account/agents',
        agent_key_create_url: '/api/auth/clawhunt/agent-key',
        browser_login_start_url: '/api/auth/clawhunt/browser/start',
        profile_url: '/api/auth/clawhunt/me',
        login_url: '/api/auth/clawhunt/login',
        logout_url: '/api/auth/clawhunt/logout',
      },
    });
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === '/api/auth/status') {
          return new Response(JSON.stringify(authPayload()), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/api/auth/clawhunt/logout') {
          // Simulate the external identity bridge completing as account B before
          // the post-action auth refresh. The UI no longer accepts account passwords.
          phase = 'B';
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/api/auth/clawhunt/account/login-probe') {
          return new Response(JSON.stringify({ ok: true, reachable: true, login_endpoint: true, base_url: 'https://clawhunt.store', status_code: 200, detail: 'ok', body_detail: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/api/auth/clawhunt/account/agents') {
          return new Response(JSON.stringify({ body: { agents: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/api/agents') {
          return new Response(
            JSON.stringify({
              agents: [
                { name: 'codex', available: true, executable: '/bin/codex', kind: 'cli', label: 'Codex CLI', chat_tier: 'native' },
                { name: 'clawwork', available: true, executable: '/path/to/clawwork', kind: 'cli', label: 'ClawWork (relay)', chat_tier: 'infra', uses_relay_packages: true, supports_model_selection: true, default_model: 'core' },
              ],
              summary: { count: 2, ready_count: 2 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/relay/packages') {
          return new Response(JSON.stringify({ packages: [{ id: 'plus', name: 'Plus', tier: 'plus', group_slug: 'superclaw-plus', locked: false }], source: 'catalog', available: true, tier_ceiling: 'max' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/api/relay/packages/plus/models') {
          return new Response(JSON.stringify({ ok: true, tier: 'plus', group_slug: 'superclaw-plus', models: ['claude-opus-4-8', 'claude-opus-4-7'] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/api/chat/stream') {
          sentBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          return sseStreamResponse([
            ['chat.started', { intent: 'chat', session_id: 'session_sw', backend: 'clawwork' }],
            ['message.completed', { text: 'ok' }],
            ['chat.completed', { intent: 'chat', session_id: 'session_sw', backend: 'clawwork', status: 'completed', response: 'ok' }],
          ]);
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    // signed in as account A; pick clawwork -> Plus -> a concrete model (composite)
    fireEvent.click(await screen.findByLabelText('Backend'));
    fireEvent.click(await screen.findByRole('option', { name: 'ClawWork (relay)' }));
    const packageTrigger = await screen.findByLabelText('Package');
    await waitFor(() => {
      fireEvent.click(packageTrigger);
      expect(screen.getByRole('option', { name: /Plus/ })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('option', { name: /Plus/ }));
    fireEvent.click(await screen.findByLabelText('Model'));
    fireEvent.click(await screen.findByRole('option', { name: 'claude-opus-4-7' }));

    // Switch accounts through the externally refreshed identity state. No password
    // is entered or POSTed by SuperClaw.
    await openSettingsWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Account' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Logout ClawHunt' }));
    await waitFor(() => expect(screen.getAllByText('b@clawhunt.test').length).toBeGreaterThan(0));
    fireEvent.click(await screen.findByRole('button', { name: 'Back to app' }));

    // signed in as B now: the account-A concrete model must have been stripped — the
    // composite submitted is the bare tier ``plus``, never ``plus::claude-opus-4-7``.
    const input = await screen.findByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: 'after switch' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(sentBody).toBeTruthy());
    expect((sentBody as Record<string, unknown>).model).toBe('plus'); // NOT 'plus::claude-opus-4-7'
  });

  it('clears a runtime probe when its config is saved (no stale green)', async () => {
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === '/api/agents') {
          return new Response(
            JSON.stringify({
              agents: [
                {
                  name: 'codex',
                  available: true,
                  executable: '/bin/codex',
                  kind: 'cli',
                  config_env: 'SUPERCLAW_CODEX_EXECUTABLE',
                  configure: '/config set SUPERCLAW_CODEX_EXECUTABLE /path/to/codex',
                  label: 'Codex CLI',
                  chat_tier: 'oneshot',
                },
              ],
              summary: { count: 1, ready_count: 1 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/agents/probe') {
          return new Response(
            JSON.stringify({
              probes: [
                { backend: 'codex', verdict: 'runtime_ready', detail: 'ok', depth: 'live', present: true, models_count: 3, latency_ms: 120 },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/config') {
          return new Response(
            JSON.stringify({
              config_path: '.superclaw/x.toml',
              defaults: { backend: 'codex', mode: 'auto' },
              auth: { clawhunt_agent_api_key: 'unset', control_token: 'set', anthropic_api_key: 'unset', gemini_api_key: 'unset' },
              entries: [
                {
                  name: 'SUPERCLAW_CODEX_EXECUTABLE',
                  category: 'runtime',
                  description: 'codex exe',
                  default: null,
                  configured: true,
                  persist_allowed: true,
                  persisted: true,
                  secret: false,
                  source: 'env',
                  value: '/bin/codex',
                  display_value: '/bin/codex',
                  ui: { type: 'text', section: 'advanced', choices: null },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/config/set') {
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    await openSettingsWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Runtime' }));
    await screen.findByRole('heading', { name: 'Agents & execution' });
    const codexRow = (await waitFor(() => {
      const row = document.querySelector('.runtime-roster-list .runtime-row');
      if (!row) throw new Error('row not yet rendered');
      return row as HTMLElement;
    }))!;
    // test → reachable (Healthy)
    fireEvent.click(within(codexRow).getByRole('button', { name: 'Test' }));
    await within(codexRow).findByText(/Healthy/);
    // saving the executable invalidates the probe → row reverts to untested, no stale green
    fireEvent.click(within(codexRow).getByRole('button', { name: 'Details' }));
    fireEvent.change(within(codexRow).getByLabelText('codex Agent executable path'), {
      target: { value: '/usr/local/bin/codex' },
    });
    fireEvent.click(within(codexRow).getByRole('button', { name: 'Save config key' }));
    await waitFor(() => expect(within(codexRow).queryByText(/Healthy/)).not.toBeInTheDocument());
    expect(within(codexRow).getByText('Ready, untested')).toBeInTheDocument();
  });

  it('clears a probe that landed Healthy while a config save was still in flight', async () => {
    // Locks the R5 closure-stale regression specifically: the probe must write its
    // result AFTER the config-save's invalidateAllProbes closure is created but
    // BEFORE the save resolves. With the old (closure-read) invalidate this leaves
    // a stale green; with the global-generation invalidate it is cleared.
    let releaseCodexProbe!: () => void;
    const codexGate = new Promise<void>((resolve) => {
      releaseCodexProbe = resolve;
    });
    let releaseConfigSet!: () => void;
    const configSetGate = new Promise<void>((resolve) => {
      releaseConfigSet = resolve;
    });
    const agentEntry = (name: string, label: string) => ({
      name,
      available: true,
      executable: `/bin/${name}`,
      kind: 'cli',
      config_env: `SUPERCLAW_${name.toUpperCase()}_EXECUTABLE`,
      configure: `/config set SUPERCLAW_${name.toUpperCase()}_EXECUTABLE /path/to/${name}`,
      label,
      chat_tier: 'oneshot',
    });
    const configEntry = (name: string) => ({
      name: `SUPERCLAW_${name.toUpperCase()}_EXECUTABLE`,
      category: 'runtime',
      description: `${name} exe`,
      default: null,
      configured: true,
      persist_allowed: true,
      persisted: true,
      secret: false,
      source: 'env',
      value: `/bin/${name}`,
      display_value: `/bin/${name}`,
      ui: { type: 'text', section: 'advanced', choices: null },
    });
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === '/api/agents') {
          return new Response(
            JSON.stringify({ agents: [agentEntry('codex', 'Codex CLI'), agentEntry('claude', 'Claude Code')], summary: { count: 2, ready_count: 2 } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/agents/probe') {
          const raw = typeof input === 'string' ? input : input.toString();
          const backend = new URL(raw, 'http://localhost').searchParams.get('backend');
          if (backend === 'codex') await codexGate; // hold the codex probe in flight
          return new Response(
            JSON.stringify({ probes: [{ backend, verdict: 'runtime_ready', detail: 'ok', depth: 'live', present: true, models_count: 2, latency_ms: 90 }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/config') {
          return new Response(
            JSON.stringify({
              config_path: '.superclaw/x.toml',
              defaults: { backend: 'codex', mode: 'auto' },
              auth: { clawhunt_agent_api_key: 'unset', control_token: 'set', anthropic_api_key: 'unset', gemini_api_key: 'unset' },
              entries: [configEntry('codex'), configEntry('claude')],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/config/set') {
          await configSetGate; // hold the save so invalidate runs AFTER the probe lands
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return baseFetch(input, init);
      }),
    );

    render(<App />);
    await openSettingsWorkspace();
    fireEvent.click(await screen.findByRole('button', { name: 'Runtime' }));
    await screen.findByRole('heading', { name: 'Agents & execution' });
    await waitFor(() => expect(document.querySelectorAll('.runtime-roster-list .runtime-row').length).toBe(2));
    const rowFor = (name: string) =>
      Array.from(document.querySelectorAll('.runtime-roster-list .runtime-row')).find((row) =>
        row.querySelector('.runtime-row-name')?.textContent?.startsWith(name),
      ) as HTMLElement;

    // 1) dispatch codex's probe — held in flight (codexGate unresolved)
    fireEvent.click(within(rowFor('codex')).getByRole('button', { name: 'Test' }));
    await within(rowFor('codex')).findByRole('button', { name: 'Testing…' });

    // 2) save claude's executable — saveRuntimeConfigValue (and its invalidate) is now
    //    dispatched with probeResults still EMPTY, then HELD on /api/config/set
    fireEvent.click(within(rowFor('claude')).getByRole('button', { name: 'Details' }));
    fireEvent.change(within(rowFor('claude')).getByLabelText('claude Agent executable path'), { target: { value: '/usr/local/bin/claude' } });
    fireEvent.click(within(rowFor('claude')).getByRole('button', { name: 'Save config key' }));

    // 3) let codex's probe land FIRST — it writes Healthy and exits in-flight, BEFORE invalidate
    releaseCodexProbe();
    await within(rowFor('codex')).findByText(/Healthy/);

    // 4) now let the save resolve → invalidateAllProbes runs. The old closure-read impl
    //    would miss this codex result (snapshot empty, not in-flight); the global
    //    generation impl clears it.
    releaseConfigSet();
    await waitFor(() => expect(within(rowFor('codex')).queryByText(/Healthy/)).not.toBeInTheDocument());
    expect(within(rowFor('codex')).getByText('Ready, untested')).toBeInTheDocument();
  });

  it('opens agent setup automatically in desktop when the default backend is unconfigured', async () => {
    const baseFetch = globalThis.fetch;
    const configWrites: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestPath(input) === '/api/config') {
          return new Response(
            JSON.stringify({
              config_path: '.superclaw/shell-config.toml',
              defaults: { backend: 'claude', mode: 'auto' },
              auth: {
                clawhunt_agent_api_key: 'unset',
                control_token: 'set',
                anthropic_api_key: 'unset',
                gemini_api_key: 'unset',
              },
              entries: [
                {
                  name: 'backend',
                  category: 'shell',
                  description: 'Default backend for new interactive turns.',
                  default: 'claude',
                  configured: false,
                  persist_allowed: true,
                  persisted: false,
                  secret: false,
                  source: 'default',
                  display_value: 'claude',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (requestPath(input) === '/api/config/set') {
          configWrites.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
          return new Response(JSON.stringify({ ok: true, defaults: { backend: 'codex', mode: 'auto' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return baseFetch(input, init);
      }),
    );
    const invokeMock = vi.fn(async (command: string) => {
      if (command === 'desktop_shell_info') {
        return {
          productName: 'ClawHunt',
          version: '0.1.0',
          releaseChannel: 'beta',
          updateMode: 'manual',
          workspaceRoot: '/Users/leongong/Documents/superClaw',
          webDevUrl: 'http://127.0.0.1:5173',
          webDistPath: '/Users/leongong/Documents/superClaw/apps/web/dist',
          cliExecutable: '/Users/leongong/Documents/superClaw/.venv/bin/superclaw',
        };
      }
      if (command === 'desktop_runtime_start') {
        return {
          ok: true,
          handle: {
            base_url: 'http://127.0.0.1:9988',
            control_token: 'desktop-secret',
            state_path: '.superclaw/state.db',
            owned: true,
            pid: 8123,
          },
          status: null,
        };
      }
      if (command === 'desktop_set_window_theme') {
        return { ok: true, theme: 'system' };
      }
      throw new Error(`Unhandled invoke command: ${command}`);
    });
    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: { core: { invoke: invokeMock } },
    });

    render(<App />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('desktop_runtime_start', { request: {} }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Agent setup required' });
    expect(within(dialog).getAllByText('codex').length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('claude').length).toBeGreaterThan(0);
    expect(dialog.querySelector('.agent-choice-card.active')).toBeNull();
    expect(within(dialog).getByLabelText('Default runtime agent')).toHaveTextContent('Choose a local runtime agent before saving.');
    expect(within(dialog).getByRole('button', { name: 'Save and recheck' })).toBeDisabled();
    expect(localStorage.getItem('superclaw_agent_onboarding_dismissed')).toBeNull();

    const codexCard = within(dialog)
      .getAllByRole('button')
      .find((button) => {
        const text = button.textContent ?? '';
        return text.includes('codex') && text.includes('/opt/homebrew/bin/codex');
      });
    expect(codexCard).toBeTruthy();
    fireEvent.click(codexCard as HTMLButtonElement);

    const saveButton = within(dialog).getByRole('button', { name: 'Save and recheck' });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(configWrites).toContainEqual({ name: 'backend', value: 'codex' });
    });
    expect(localStorage.getItem('superclaw_agent_onboarding_dismissed')).toBe('1');
  });

  it('opens agent setup in desktop when the default backend is unconfigured and discovery is empty', async () => {
    const baseFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = requestPath(input);
        if (path === '/api/config') {
          return new Response(
            JSON.stringify({
              config_path: '.superclaw/shell-config.toml',
              defaults: { backend: 'claude', mode: 'auto' },
              auth: {
                clawhunt_agent_api_key: 'unset',
                control_token: 'set',
                anthropic_api_key: 'unset',
                gemini_api_key: 'unset',
              },
              entries: [
                {
                  name: 'backend',
                  category: 'shell',
                  description: 'Default backend for new interactive turns.',
                  default: 'claude',
                  configured: false,
                  persist_allowed: true,
                  persisted: false,
                  secret: false,
                  source: 'default',
                  display_value: 'claude',
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/agents') {
          return new Response(JSON.stringify({ agents: [], summary: { count: 0, ready_count: 0 } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (path === '/api/backends') {
          return new Response(JSON.stringify({ backends: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return baseFetch(input, init);
      }),
    );
    const invokeMock = vi.fn(async (command: string) => {
      if (command === 'desktop_shell_info') {
        return {
          productName: 'ClawHunt',
          version: '0.1.0',
          releaseChannel: 'beta',
          updateMode: 'manual',
          workspaceRoot: '/Users/leongong/Documents/superClaw',
          webDevUrl: 'http://127.0.0.1:5173',
          webDistPath: '/Users/leongong/Documents/superClaw/apps/web/dist',
          cliExecutable: '/Users/leongong/Documents/superClaw/.venv/bin/superclaw',
        };
      }
      if (command === 'desktop_runtime_start') {
        return {
          ok: true,
          handle: {
            base_url: 'http://127.0.0.1:9988',
            control_token: 'desktop-secret',
            state_path: '.superclaw/state.db',
            owned: true,
            pid: 8123,
          },
          status: null,
        };
      }
      if (command === 'desktop_set_window_theme') {
        return { ok: true, theme: 'system' };
      }
      throw new Error(`Unhandled invoke command: ${command}`);
    });
    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: { core: { invoke: invokeMock } },
    });

    render(<App />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('desktop_runtime_start', { request: {} }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Agent setup required' });
    expect(
      within(dialog).getAllByText(
        'No local runtime agents were reported. Recheck discovery after installing an agent CLI, then choose the agent to configure.',
      ).length,
    ).toBeGreaterThan(0);
    expect(within(dialog).getByLabelText('Default runtime agent')).toHaveTextContent('Choose a local runtime agent before saving.');
    expect(within(dialog).getByRole('button', { name: 'Save and recheck' })).toBeDisabled();
  });

  it('retries the desktop runtime start (keeping the splash, not failing) when the shell reports one already in progress', async () => {
    // The shell's async re-entrancy guard rejects a concurrent start with
    // "already in progress" (e.g. a reload during a slow cold boot). The frontend
    // must NOT surface a failure for this — it should stay in 'starting' and retry
    // until the in-flight start finishes, then attach. Drives the bounded-retry
    // branch in ensureDesktopRuntimeSession.
    let startCalls = 0;
    const invokeMock = vi.fn(async (command: string) => {
      if (command === 'desktop_shell_info') {
        return {
          productName: 'ClawHunt',
          version: '0.1.0',
          releaseChannel: 'beta',
          updateMode: 'manual',
          workspaceRoot: '/Users/leongong/Documents/superClaw',
          webDevUrl: 'http://127.0.0.1:5173',
          webDistPath: '/Users/leongong/Documents/superClaw/apps/web/dist',
          cliExecutable: '/Users/leongong/Documents/superClaw/.venv/bin/superclaw',
        };
      }
      if (command === 'desktop_runtime_start') {
        startCalls += 1;
        if (startCalls === 1) {
          // Tauri surfaces a command Err as a rejected promise carrying the string.
          throw 'desktop runtime start already in progress';
        }
        return {
          ok: true,
          handle: {
            base_url: 'http://127.0.0.1:9988',
            control_token: 'desktop-secret',
            state_path: '.superclaw/state.db',
            owned: true,
            pid: 8123,
          },
          status: null,
        };
      }
      if (command === 'desktop_set_window_theme') {
        return { ok: true, theme: 'system' };
      }
      throw new Error(`Unhandled invoke command: ${command}`);
    });
    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: { core: { invoke: invokeMock } },
    });

    render(<App />);

    // It must retry after the first "already in progress" (≈600ms backoff) rather
    // than give up — so a second start happens and no failure copy is shown.
    await waitFor(() => expect(startCalls).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    expect(screen.queryByText(/desktop runtime failed/i)).toBeNull();
  });

  it('no longer offers the retired /delivery slash command (chat is Node-native only)', async () => {
    render(<App />);

    const input = await screen.findByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: '/' } });

    const listbox = await screen.findByRole('listbox', { name: 'Slash commands' });
    // The deprecated delivery command is gone from the composer; the chat-mode command stays.
    expect(within(listbox).queryByText('/delivery')).toBeNull();
    expect(within(listbox).getByText('/chat')).toBeInTheDocument();
  });

  it.each([
    ['/delivery ship the feature', 'leading /delivery'],
    ['please /delivery this now', 'mid-string " /delivery"'],
    ['fix it (@delivery)', '@delivery anywhere'],
  ])('fails closed for legacy-delivery free text %s (does not reach /api/chat/stream)', async (text) => {
    render(<App />);
    const input = (await screen.findByLabelText('Direct chat prompt')) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // The composer mirrors Python's exact legacy-delivery detection and refuses to send —
    // none of these may reach /api/chat/stream (Python would route them to the deprecated
    // orchestrator delivery run).
    await screen.findByText(/delivery is retired|delivery 已停用/);
    expect(vi.mocked(fetch).mock.calls.some(([input2]) => requestPath(input2) === '/api/chat/stream')).toBe(false);
  });

  it('opens broader slash actions from the composer', async () => {
    render(<App />);

    const input = await screen.findByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: '/set' } });

    const listbox = await screen.findByRole('listbox', { name: 'Slash commands' });
    fireEvent.click(within(listbox).getByText('/settings'));

    expect(await screen.findByRole('heading', { name: 'Preferences' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Settings navigation')).toBeInTheDocument();
  });

  it('submits selected composer context refs from typed mentions', async () => {
    render(<App />);

    const input = await screen.findByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: '@sess' } });

    const listbox = await screen.findByRole('listbox', { name: 'Context mentions' });
    expect(within(listbox).getByText('标题: Backend persisted session')).toBeInTheDocument();
    fireEvent.click(within(listbox).getByText('聊天 ID: session_demo'));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(await screen.findByRole('button', { name: 'Remove 聊天 ID: session_demo' })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'What did we decide?' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));

    await waitFor(() => {
      expect(latestChatTurnRequest).toBeTruthy();
      expect(latestChatTurnRequest?.context_refs).toEqual([
        expect.objectContaining({
          type: 'chat_session',
          id: 'session_demo',
          visible_token: '@session:session_demo',
        }),
      ]);
    });
  });

  it('submits selected plugin mentions as context refs', async () => {
    render(<App />);

    const input = await screen.findByLabelText('Direct chat prompt');
    fireEvent.change(input, { target: { value: '@plug' } });

    const listbox = await screen.findByRole('listbox', { name: 'Context mentions' });
    fireEvent.click(await within(listbox).findByText('@plugin:dev.superclaw.hello-world'));
    await waitFor(() => expect(input).toHaveValue(''));
    const pluginChip = await screen.findByRole('button', { name: 'Remove Hello World' });
    expect(pluginChip).toBeInTheDocument();
    expect(pluginChip.querySelector('img')).toHaveAttribute('src', '/api/plugins/dev.superclaw.hello-world/logo?version=0.1.0');

    fireEvent.change(input, { target: { value: 'Check this plugin.' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));

    await waitFor(() => {
      expect(latestChatTurnRequest?.context_refs).toEqual([
        expect.objectContaining({
          type: 'plugin',
          id: 'dev.superclaw.hello-world',
          visible_token: '@plugin:dev.superclaw.hello-world',
        }),
      ]);
    });
  });




  it('stages selected image files and submits them as chat attachments', async () => {
    render(<App />);

    const fileInput = await screen.findByLabelText('Composer file input');
    const input = await screen.findByLabelText('Direct chat prompt');
    const file = new File(['image-bytes'], 'screen.png', { type: 'image/png' });

    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByText('screen.png')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Please inspect this screenshot.' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));

    await waitFor(() => {
      const attachments = latestChatTurnRequest?.attachments as Array<Record<string, unknown>> | undefined;
      expect(attachments).toEqual([
        expect.objectContaining({
          kind: 'image',
          name: 'screen.png',
          mime: 'image/png',
          source: 'picker',
        }),
      ]);
      expect(String(attachments?.[0]?.data_url)).toMatch(/^data:image\/png;base64,/);
    });
  });

  it('submits typed macOS absolute paths as local path attachments', async () => {
    render(<App />);

    const input = await screen.findByLabelText('Direct chat prompt');
    fireEvent.change(input, {
      target: { value: 'Review /Users/leongong/Desktop/Myshell/Model/example.png before answering.' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));

    await waitFor(() => {
      expect(latestChatTurnRequest?.attachments).toEqual([
        expect.objectContaining({
          kind: 'local_path',
          path: '/Users/leongong/Desktop/Myshell/Model/example.png',
          source: 'path',
        }),
      ]);
    });
  });



  it('normalizes a new web tab address to an http(s) URL and rejects unsafe schemes', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Panel' })); // opens drawer (Plan tab)
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Web page' }));

    const input = await screen.findByLabelText('Enter a URL to preview…');

    // Unsafe scheme is rejected before any ticket is requested.
    fireEvent.change(input, { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('Enter a valid http(s) URL.')).toBeInTheDocument();
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/api/preview/tickets')).toBe(false);

    // A non-`//` scheme (mailto:) must NOT be silently rewritten into an https URL.
    fireEvent.change(input, { target: { value: 'mailto:user@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('Enter a valid http(s) URL.')).toBeInTheDocument();
    expect(screen.getByLabelText('Enter a URL to preview…')).toBeInTheDocument();

    // A bare host is normalized to https:// and reaches the sandbox preview gate.
    fireEvent.change(input, { target: { value: 'example.com/docs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    // The address bar is replaced by the preview reader, showing the canonical URL.
    expect(await screen.findByText('https://example.com/docs')).toBeInTheDocument();
    expect(screen.queryByLabelText('Enter a URL to preview…')).not.toBeInTheDocument();
  });




  it('handles denied desktop alert permission without persisting the preference', async () => {
    class MockNotificationDenied {
      static permission = 'default';
      static requestPermission = vi.fn(async () => 'denied');
      constructor() {
        throw new Error('notification should not be constructed when permission is denied');
      }
    }
    vi.stubGlobal('Notification', MockNotificationDenied as unknown as typeof Notification);

    render(<App />);

    await openSettingsWorkspace();
    fireEvent.click(await screen.findByRole('switch', { name: 'Desktop alerts' }));
    expect(await screen.findByText('Permission: denied')).toBeInTheDocument();
    expect(await screen.findByText('desktop alerts denied')).toBeInTheDocument();
    expect(localStorage.getItem('superclaw_desktop_alerts')).toBeNull();
  });

  it('does not mount Agent company requests when the desktop runtime is disconnected', async () => {
    const invokeMock = vi.fn(async (command: string) => {
      if (command === 'desktop_shell_info') {
        return {
          productName: 'ClawHunt',
          version: '0.1.0',
          releaseChannel: 'beta',
          updateMode: 'manual',
          workspaceRoot: '/Users/leongong/Documents/superClaw',
          webDevUrl: 'http://127.0.0.1:5173',
          webDistPath: '/Users/leongong/Documents/superClaw/apps/web/dist',
          cliExecutable: '/Users/leongong/Documents/superClaw/.venv/bin/superclaw',
        };
      }
      if (command === 'desktop_runtime_start') {
        throw new Error('runtime boot failed');
      }
      if (command === 'desktop_set_window_theme') {
        return { ok: true, theme: 'system' };
      }
      throw new Error(`Unhandled invoke command: ${command}`);
    });
    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: { core: { invoke: invokeMock } },
    });
    localStorage.setItem('superclaw_agent_onboarding_dismissed', '1');

    render(<App />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('desktop_runtime_start', { request: {} }));
    fireEvent.click(await screen.findByRole('button', { name: 'Team' }));

    // The company board page is now the natively-mounted Paperclip board — it
    // renders regardless of the Python desktop runtime and makes none of the
    // legacy /api/team/companies call. (Adjacent surfaces — the sidebar unread
    // badge and composer @-company picker — still read /api/team/* and are out of scope.)
    expect(await screen.findByTestId('company-board')).toBeInTheDocument();
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === '/api/team/companies')).toBe(false);
  });

  it('mounts the Paperclip board for the Agent company surface instead of the legacy /api/team/companies call', async () => {
    const invokeMock = vi.fn(async (command: string) => {
      if (command === 'desktop_shell_info') {
        return {
          productName: 'ClawHunt',
          version: '0.1.0',
          releaseChannel: 'beta',
          updateMode: 'manual',
          workspaceRoot: '/Users/leongong/Documents/superClaw',
          webDevUrl: 'http://127.0.0.1:5173',
          webDistPath: '/Users/leongong/Documents/superClaw/apps/web/dist',
          cliExecutable: '/Users/leongong/Documents/superClaw/.venv/bin/superclaw',
        };
      }
      if (command === 'desktop_runtime_start') {
        return {
          ok: true,
          handle: {
            base_url: 'http://127.0.0.1:9988',
            control_token: 'desktop-secret',
            state_path: '.superclaw/state.db',
            owned: true,
            pid: 8123,
          },
          status: null,
        };
      }
      if (command === 'desktop_set_window_theme') {
        return { ok: true, theme: 'system' };
      }
      throw new Error(`Unhandled invoke command: ${command}`);
    });
    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: { core: { invoke: invokeMock } },
    });
    localStorage.setItem('superclaw_agent_onboarding_dismissed', '1');

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Team' }));
    // The company surface mounts the Paperclip board (which talks to the Paperclip
    // Node API on its own), so the legacy desktop-routed
    // /api/team/{companies,agents,issues} calls must NOT fire.
    expect(await screen.findByTestId('company-board')).toBeInTheDocument();

    const fetchMock = vi.mocked(fetch);
    const legacyTeamCalls = fetchMock.mock.calls.filter(([input]) =>
      ['/api/team/companies', '/api/team/agents', '/api/team/issues'].includes(requestPath(input)),
    );
    expect(legacyTeamCalls).toHaveLength(0);
  });

  it('routes control-plane requests through the desktop runtime when running inside Tauri', async () => {
    localStorage.clear();
    localStorage.setItem('superclaw_control_token', 'browser-secret');
    localStorage.setItem('superclaw_landing_surface', 'chat');
    const invokeMock = vi.fn(async (command: string) => {
      if (command === 'desktop_shell_info') {
        return {
          productName: 'ClawHunt',
          version: '0.1.0',
          releaseChannel: 'beta',
          updateMode: 'manual',
          workspaceRoot: '/Users/leongong/Documents/superClaw',
          webDevUrl: 'http://127.0.0.1:5173',
          webDistPath: '/Users/leongong/Documents/superClaw/apps/web/dist',
          cliExecutable: '/Users/leongong/Documents/superClaw/.venv/bin/superclaw',
          updateGuidePath: '/Users/leongong/Documents/superClaw/docs/desktop-manual-update.md',
          workspaceUpdateCommand:
            'git pull --ff-only && .venv/bin/python -m pip install -e ".[dev,tui]" && npm install --prefix apps/web && npm install --prefix apps/desktop && npm run build --prefix apps/web && npm run tauri:build --prefix apps/desktop',
        };
      }
      if (command === 'desktop_runtime_start') {
        return {
          ok: true,
          handle: {
            base_url: 'http://127.0.0.1:9988',
            control_token: 'desktop-secret',
            state_path: '.superclaw/state.db',
            owned: true,
            pid: 8123,
          },
          status: {
            health: { ok: true },
            runtime: {
              runtime_version: '0.1.0',
              backend: 'codex',
              mode: 'auto',
              service: {
                name: 'superclaw',
                version: '0.1.0',
                pid: 5151,
                bind: '127.0.0.1',
                control_token: 'set',
                uptime_seconds: 5,
                control_token_required: true,
              },
              state: { path: '.superclaw/state.db', active_run_ids: [], recent_run_id: null },
              agents: { count: 1, ready_count: 1, status_url: '/api/agents' },
              plugins: { plugin_count: 1, status_url: '/api/plugins/status' },
              config: { path: '.superclaw/shell-config.toml', status_url: '/api/config' },
            },
          },
        };
      }
      if (command === 'desktop_set_window_theme') {
        return { ok: true, theme: 'system' };
      }
      throw new Error(`Unhandled invoke command: ${command}`);
    });
    Object.defineProperty(window, '__TAURI__', {
      configurable: true,
      value: { core: { invoke: invokeMock } },
    });
    localStorage.setItem('superclaw_agent_onboarding_dismissed', '1');

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === '/api/pay-switch/status') {
        return new Response(JSON.stringify({ mode: 'governed_optional' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/appearance') {
        // Minimal valid payload. A SUCCESS response here makes this suite a regression
        // guard against the appearance fetch effect looping: if it re-fetched on every
        // render (the old [apiReady, readJson] dep bug), this would be hit unbounded.
        return new Response(
          JSON.stringify({
            schema_version: '0.1.0',
            canvases: ['light', 'dark'],
            default_preset: 'default',
            custom_preset_id: 'custom',
            tokens: [{ id: 'accent', label: 'Accent', css_var: '--accent', group: 'accent' }],
            presets: [{ id: 'default', label: 'Default', description: '', swatch: '#4f5fd6', overrides: { light: {}, dark: {} } }],
            active_preset: 'default',
            custom: { light: {}, dark: {} },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/backends') {
        return new Response(JSON.stringify({ backends: [{ name: 'codex', available: true, version: '0.133.0' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/harnesses') {
        return new Response(
          JSON.stringify({
            harnesses: {
              codex: {
                harness_id: 'codex',
                display_name: 'Codex',
                parallel_agents: true,
                tool_allowlist_per_agent: true,
                skill_body_max_bytes: 32768,
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/evals') return new Response(JSON.stringify({ evals: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (path === '/api/fusion/status') {
        return new Response(
          JSON.stringify({
            schema_version: '1',
            capability_summary: { capability_count: 1, gated_capability_count: 0 },
            network_policy: { active_probe_default: 'governed_optional' },
            profiles: {},
            components: {},
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/runtime/status') {
        return new Response(
          JSON.stringify({
            runtime_version: '0.1.0',
            backend: 'codex',
            mode: 'auto',
            service: {
              name: 'superclaw',
              version: '0.1.0',
              pid: 6161,
              bind: '127.0.0.1',
              control_token: 'set',
              uptime_seconds: 9,
              control_token_required: true,
            },
            state: { path: '.superclaw/state.db', active_run_ids: [], recent_run_id: null },
            agents: { count: 1, ready_count: 1, status_url: '/api/agents' },
            plugins: { plugin_count: 1, status_url: '/api/plugins/status' },
            config: { path: '.superclaw/shell-config.toml', status_url: '/api/config' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/desktop/onboarding') {
        return new Response(
          JSON.stringify({
            workspace_root: '/Users/leongong/Documents/superClaw',
            quickstart_path: 'docs/desktop-beta-quickstart.md',
            status_url: '/api/desktop/onboarding',
            summary: { ready: false, ready_count: 5, total_count: 6 },
            checks: [
              { title: 'Runtime service', ready: true, detail: '0.1.0 / backend codex / mode auto', remediation: 'The local ClawHunt runtime is already serving the control-plane APIs.' },
              { title: 'Desktop toolchain', ready: true, detail: '5/5 source-build tools are ready.', remediation: 'Desktop source-build toolchain is ready.' },
              { title: 'Dependency doctor', ready: true, detail: '4/4 supported desktop agents are ready.', remediation: 'Desktop agent dependencies are already available.' },
              { title: 'Beta acceptance', ready: false, detail: 'Acceptance needs review: workbench_smoke.', remediation: 'Run `npm --prefix apps/desktop run test:beta-acceptance` and review `/Users/leongong/Documents/superClaw/.superclaw/desktop/desktop-beta-acceptance.json`.' },
              { title: 'ClawHunt login', ready: true, detail: 'Agent key is linked.', remediation: 'Sign in with a ClawHunt account, then create or paste an agent key before browsing or submitting market work.' },
              { title: 'Plugin trust root', ready: true, detail: 'Registry signature root is configured.', remediation: 'Configure the plugin public key before relying on marketplace installs.' },
            ],
            dependency_targets: [
              { name: 'codex', label: 'Codex', installed: true, detail: '/opt/homebrew/bin/codex', remediation: 'Ready for desktop use.' },
              { name: 'hermes', label: 'Hermes', installed: true, detail: '/Users/leongong/.local/bin/hermes', remediation: 'Ready for desktop use.' },
              { name: 'claude', label: 'Claude Code', installed: true, detail: '/opt/homebrew/bin/claude', remediation: 'Ready for desktop use.' },
              { name: 'openclaw', label: 'OpenClaw', installed: true, detail: '/opt/homebrew/bin/openclaw', remediation: 'Ready for desktop use.' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/desktop/toolchain') {
        return new Response(
          JSON.stringify({
            workspace_root: '/Users/leongong/Documents/superClaw',
            desktop_root: '/Users/leongong/Documents/superClaw/apps/desktop',
            source_workspace: true,
            tools: [
              { name: 'python3', label: 'Python 3', available: true, detail: 'Python 3.12.8', remediation: 'Install Python 3.11+.' },
              { name: 'node', label: 'Node.js', available: true, detail: 'v22.0.0', remediation: 'Install Node.js.' },
              { name: 'npm', label: 'npm', available: true, detail: '10.0.0', remediation: 'Install npm.' },
              { name: 'cargo', label: 'Cargo', available: true, detail: 'cargo 1.80.0', remediation: 'Install Cargo.' },
              { name: 'tauri', label: 'Tauri CLI', available: true, detail: '/Users/leongong/Documents/superClaw/apps/desktop/node_modules/.bin/tauri', remediation: 'Ready.' },
            ],
            summary: { required_count: 5, ready_count: 5, source_build_ready: true },
            status_url: '/api/desktop/toolchain',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/desktop/acceptance') {
        return new Response(
          JSON.stringify({
            workspace_root: '/Users/leongong/Documents/superClaw',
            desktop_root: '/Users/leongong/Documents/superClaw/apps/desktop',
            source_workspace: true,
            report_path: '/Users/leongong/Documents/superClaw/.superclaw/desktop/desktop-beta-acceptance.json',
            status_url: '/api/desktop/acceptance',
            generate_command: 'npm --prefix apps/desktop run test:beta-acceptance',
            quickstart_path: 'docs/desktop-beta-quickstart.md',
            exists: true,
            summary: {
              ready: true,
              success: false,
              failed_step: 'workbench_smoke',
              generated_at: '2026-06-04T12:30:00Z',
              completed_steps: 4,
              total_steps: 6,
            },
            report: {
              generated_at: '2026-06-04T12:30:00Z',
              success: false,
              failed_step: 'workbench_smoke',
              steps: [],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/runs') return new Response(JSON.stringify({ runs: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (path === '/api/chat/sessions') return new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (path === '/api/chat/stream') {
        return sseStreamResponse([
          ['chat.started', { intent: 'chat', session_id: 'session_desktop', backend: 'codex' }],
          ['message.delta', { text: 'Direct answer from Codex desktop mode.' }],
          ['message.completed', { text: 'Direct answer from Codex desktop mode.' }],
          [
            'chat.completed',
            {
              intent: 'chat',
              session_id: 'session_desktop',
              backend: 'codex',
              status: 'completed',
              response: 'Direct answer from Codex desktop mode.',
            },
          ],
        ]);
      }
      if (path === '/api/config') {
        return new Response(
          JSON.stringify({
            config_path: '.superclaw/shell-config.toml',
            defaults: { backend: 'codex', mode: 'auto' },
            auth: {
              clawhunt_agent_api_key: 'set',
              control_token: 'set',
              anthropic_api_key: 'unset',
              gemini_api_key: 'unset',
            },
            entries: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/agents') {
        return new Response(
          JSON.stringify({
            agents: [
              {
                name: 'codex',
                available: true,
                executable: '/opt/homebrew/bin/codex',
                version: '0.133.0',
                kind: 'cli',
                configure: '/config set SUPERCLAW_CODEX_EXECUTABLE /path/to/codex',
                config_env: 'SUPERCLAW_CODEX_EXECUTABLE',
                config_state: '/opt/homebrew/bin/codex',
                model_env: 'SUPERCLAW_CODEX_MODEL',
                model_state: 'configured-default',
              },
            ],
            summary: { count: 1, ready_count: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/auth/status') {
        return new Response(
          JSON.stringify({
            clawhunt: {
              account: 'unset',
              agent_api_key: 'set',
              base_url: 'https://clawhunt.store',
              account_user: null,
              agent_key_source: 'manual',
              agent_key_name: 'Manual agent key',
              account_login_url: '/api/auth/clawhunt/account/login',
              account_login_probe_url: '/api/auth/clawhunt/account/login-probe',
              account_profile_url: '/api/auth/clawhunt/account/me',
              account_agents_url: '/api/auth/clawhunt/account/agents',
              agent_key_create_url: '/api/auth/clawhunt/agent-key',
              profile_url: '/api/auth/clawhunt/me',
              login_url: '/api/auth/clawhunt/login',
              logout_url: '/api/auth/clawhunt/logout',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/auth/clawhunt/me') {
        return new Response(JSON.stringify({ ok: true, status_code: 200, body: { handle: 'desktop-agent' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/auth/clawhunt/account/login-probe') {
        return new Response(JSON.stringify({ ok: true, reachable: true, login_endpoint: true, base_url: 'https://clawhunt.store', status_code: 401, detail: 'login endpoint reachable; credentials rejected as expected' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/api/plugins/status') {
        return new Response(
          JSON.stringify({
            cache_root: '.superclaw/plugins/cache',
            cloud_root: '.superclaw/plugins/cloud',
            developer_submission_root: '.superclaw/plugins/developer-submissions',
            clawhunt_ingestion_root: '.superclaw/plugins/clawhunt-ingestion',
            plugin_count: 1,
            plugins: [{ id: 'dev.superclaw.hello-world', version: '0.1.0', name: 'Hello World', path: '.superclaw/plugins/cache/demo' }],
            verification: {
              public_key_configured: true,
              install_url: '/api/plugins/install',
              local_install_url: '/api/plugins/install-local',
              uninstall_url: '/api/plugins/uninstall',
            },
            registry: { count: 1, status_url: '/v1/plugins', error: null },
            governance: { revocation_count: 0, policy_count: 0, revocations_url: '/v1/plugins/revocations', policy_url: '/v1/policies/runtime', revocation_error: null, policy_error: null },
            configuration: {
              status_url: '/api/plugins/{plugin_id}/configuration',
              setting_url: '/api/plugins/config/set',
              secret_url: '/api/plugins/secret/set',
              secret_delete_url: '/api/plugins/secret/delete',
            },
            diagnostics: {
              status_url: '/api/plugins/diagnostics',
              events_url: '/api/plugins/diagnostics/events',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/marketplace-catalog') {
        return new Response(
          JSON.stringify({
            source: 'clawhunt_server',
            total: 1,
            plugins: [
              {
                plugin_id: 'dev.clawhunt.pay-switch-agent',
                version: '0.3.0',
                name: { en: 'Pay-Switch Agent', zh: 'Pay-Switch Agent' },
                summary: {
                  en: 'Server-listed Pay-Switch package from ClawHunt product catalog.',
                  zh: '来自 ClawHunt 产品目录的 Pay-Switch 服务端列表项。',
                },
                category: 'featured',
                category_label: { en: 'Featured', zh: '推荐' },
                icon: 'commerce',
                runtime: 'mcp_sidecar',
                pricing_model: 'private_beta',
                verified: true,
                entitlement_required: true,
                featured: true,
              },
            ],
            error: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/diagnostics') {
        return new Response(
          JSON.stringify({
            ok: true,
            artifact_count: 0,
            artifact_dir: '.superclaw/artifacts/plugins',
            summary: {
              plugins: 0,
              tools: 0,
              failures: 0,
              slow_calls: 0,
              sandbox_kills: 0,
            },
            thresholds: {
              slow_call_ms: 30000,
              failure_rate_threshold: 0.5,
              failure_rate_min_invocations: 3,
              sandbox_kill_threshold: 2,
            },
            findings: [],
            status_url: '/api/plugins/diagnostics',
            events_url: '/api/plugins/diagnostics/events',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/api/plugins/dev.superclaw.hello-world/configuration') {
        return new Response(
          JSON.stringify({
            plugin_id: 'dev.superclaw.hello-world',
            version: '0.1.0',
            name: 'Hello World',
            runtime: { type: 'mcp_sidecar' },
            configuration: { settings: [], secrets: [] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/v1/plugins') return new Response(JSON.stringify({ plugins: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (path === '/v1/plugins/revocations') return new Response(JSON.stringify({ revoked: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (path === '/v1/policies/runtime') return new Response(JSON.stringify({ policies: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unhandled fetch path: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await openSettingsWorkspace();
    // The desktop-shell diagnostic card was removed from the Runtime tab; the desktop
    // runtime still auto-connects on launch, which is what the routing assertions
    // below verify (requests flow through the desktop base URL with the desktop token).
    fireEvent.click(await screen.findByRole('button', { name: 'Diagnostics' }));
    expect(await screen.findByText('ClawHunt 0.1.0 (beta)')).toBeInTheDocument();
    expect(await screen.findByText('/Users/leongong/Documents/superClaw/docs/desktop-manual-update.md')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Copy update command' })).toBeInTheDocument();
    const desktopAccountButton = screen.getByRole('button', { name: 'Open account menu' });
    expect(within(desktopAccountButton).getByText('desktop-agent')).toBeInTheDocument();
    // Account block shows avatar + name only; link status moved to the menu.
    expect(within(desktopAccountButton).queryByText('ClawHunt linked')).not.toBeInTheDocument();
    expect(within(desktopAccountButton).queryByText('Settings')).not.toBeInTheDocument();
    expect(desktopAccountButton.querySelector('.account-block-avatar')).toBeInTheDocument();
    fireEvent.click(desktopAccountButton);
    const desktopAccountMenu = await screen.findByLabelText('Account menu');
    expect(within(desktopAccountMenu).getByText('desktop-agent')).toBeInTheDocument();
    expect(within(desktopAccountMenu).queryByRole('button', { name: 'Switch language to Chinese' })).not.toBeInTheDocument();
    expect(within(desktopAccountMenu).queryByRole('button', { name: 'Switch language to English' })).not.toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByLabelText('Account menu')).not.toBeInTheDocument());

    fireEvent.click(await screen.findByRole('button', { name: 'Back to app' }));
    fireEvent.change(await screen.findByLabelText('Direct chat prompt'), { target: { value: 'What is ClawHunt?' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Submit chat turn' }));
    expect(await screen.findByText('Direct answer from Codex desktop mode.')).toBeInTheDocument();
    // The user message lands in the transcript bubble; it no longer carries a
    // 'sent' status badge (痛点1/5 — a sent message needs no label, only failures
    // and other meaningful states get a box-free note).
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll('.chat-bubble')).some((el) =>
          el.textContent?.includes('What is ClawHunt?'),
        ),
      ).toBe(true),
    );
    expect(screen.queryByText('sent')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Build something with ClawHunt', level: 1 })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('desktop_shell_info');
      expect(invokeMock).toHaveBeenCalledWith('desktop_runtime_start', { request: {} });
      // Appearance no longer has a "follow system" mode; with no stored preference the
      // web surface seeds light/dark from the OS (light in the test env) and forwards
      // that fixed choice to the desktop window theme.
      expect(invokeMock).toHaveBeenCalledWith('desktop_set_window_theme', { request: { theme: 'light' } });
      // 同文件前序用例的组件虽经 afterEach(cleanup) 卸载，但其残留 Promise/轮询并未取消，
      // 异步回调仍会以相对路径命中本用例新 stub 的全局 fetch——对"全部调用"做绝对路径断言因此不可判定。
      // 断言收敛为：本用例的桌面会话流量存在、全部带桌面令牌，且最新一次探测必经桌面路由。
      const runtimeCalls = fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/runtime/status');
      expect(runtimeCalls.length).toBeGreaterThan(0);
      const desktopRuntimeCalls = runtimeCalls.filter(([input]) =>
        String(input).startsWith('http://127.0.0.1:9988'),
      );
      expect(desktopRuntimeCalls.length).toBeGreaterThan(0);
      for (const [, init] of desktopRuntimeCalls) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers['X-SuperClaw-Token']).toBe('desktop-secret');
      }
      expect(String(runtimeCalls[runtimeCalls.length - 1][0])).toContain(
        'http://127.0.0.1:9988/api/runtime/status',
      );
      const paySwitchCalls = fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/pay-switch/status');
      expect(paySwitchCalls.length).toBeGreaterThan(0);
      expect(
        paySwitchCalls.some(([input]) => String(input).startsWith('http://127.0.0.1:9988/api/pay-switch/status')),
      ).toBe(true);
      const directChatCalls = fetchMock.mock.calls.filter(([input]) => requestPath(input) === '/api/chat/stream');
      expect(directChatCalls.length).toBe(1);
      expect(String(directChatCalls[0][0])).toContain('http://127.0.0.1:9988/api/chat/stream');
      const headers = (directChatCalls[0][1]?.headers ?? {}) as Record<string, string>;
      expect(headers['X-SuperClaw-Token']).toBe('desktop-secret');
    });
  });

  it('a stale landing pin for a retired canvas surface lands on the canvas, not chat', async () => {
    // fleet-canvas / creative-canvas / studio were all retired by the session-canvas rebuild —
    // any pre-retirement pin must remap to the canvas, never fall through to chat.
    for (const stalePin of ['fleet-canvas', 'creative-canvas', 'studio']) {
      localStorage.setItem('superclaw_landing_surface', stalePin);
      render(<App />);
      await waitFor(() => expect(document.querySelector('.canvas-root')).not.toBeNull());
      cleanup();
    }
  });
});
