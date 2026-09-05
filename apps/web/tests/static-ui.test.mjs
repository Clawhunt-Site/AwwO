import { readFileSync } from 'node:fs';

// The settings surface is extracted into its own module (settings-redesign
// PR-2); UI-string presence is asserted against the combined shell source.
const source =
  readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8') +
  readFileSync(new URL('../src/settings/SettingsSurface.tsx', import.meta.url), 'utf8') +
  readFileSync(new URL('../src/settings/RuntimeConfigFields.tsx', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const desktopSource = readFileSync(new URL('../src/desktop.ts', import.meta.url), 'utf8');
const desktopRustSource = readFileSync(new URL('../../desktop/src-tauri/src/lib.rs', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const appDesignDoc = readFileSync(new URL('../../../docs/codex-like-agentos-app.md', import.meta.url), 'utf8');
for (const text of [
  'Direct Chat',
  'Worker Timeline',
  'downloadEvalReport',
  'eval-report-download-button',
  "fetch(`/api/evals/${evalReport.eval_id}/report${format === 'pdf' ? '.pdf' : ''}`, { headers: authHeaders() })",
  'URL.createObjectURL',
  'Protocol export',
  'Build something with ClawHunt',
  'New Session',
  'Recent Sessions',
  'No recent sessions',
  'Language',
  'Switch language to Chinese',
  'Switch language to English',
  'Collapse sidebar',
  'Expand sidebar',
  'Resize sidebar',
  'window-sidebar-toggle',
  'sidebar-footer-actions',
  'sidebar-collapsed',
  'superclaw_sidebar_width',
  'Back to main menu',
  'Back to app',
  'Settings navigation',
  'Current page',
  'Preferences',
  'Account',
  'Appearance',
  'Theme preference',
  'Use light appearance',
  'Use dark appearance',
  'Diagnostics',
  'Runtime',
  'settings-sidebar',
  'settings-fullscreen-page',
  'settings-nav-group',
  'workspace-page',
  'workspace-back-button',
  'APP_COPY',
  '设置与本地 Agent',
  '外观',
  '主题偏好',
  '使用深色外观',
  '能力工坊',
  '为本地 Agent 选择可信能力',
  '桌面主页概览',
  '高级插件运维',
  '注册表搜索',
  '本地验证安装',
  'composer-command-button',
  'agent-status-dot',
  'stopActiveTurn',
  'chat-queue',
  'submitDirectChat',
  'pumpChatQueue',
  'Evaluation lane',
  'Runtime Console',
  'goal-pane-actions',
  'ClawHunt App Shell',
  'Command palette',
  '/api/pay-switch/status',
  '/api/evals',
  "downloadEvalReport('pdf')",
  '/api/config',
  '/api/runtime/status',
  '/api/harnesses',
  'Plugins',
  'URL.revokeObjectURL(objectUrl)',
  'Capability Workshop',
  'Choose trusted capabilities for local agents',
  'plugin-marketplace-shell',
  'Advanced plugin operations',
  'Refresh plugins',
  'Search plugins',
  'Capability summary',
  'Capability package detail',
  'Install readiness',
  'Entitlement readiness',
  'Update readiness',
  'Local verified install',
  'Verify and install local package',
  'Sync entitlements',
  'Governance detail',
  'Plugin runtime diagnostics',
  'Download diagnostics JSON',
  'Runtime policy viewer',
  'Download policy JSON',
  'Revocation sync viewer',
  'Download revocation JSON',
  'Developer upload',
  'Developer review',
  'Create submission',
  'Upload package',
  'Refresh review',
  'Plugin configuration',
  'Secret and config manager',
  'Download config status JSON',
  'Manage config',
  'Install',
  'Update selected',
  'Open config',
  'Uninstall local',
  'Uninstall plugin',
  'Save setting',
  'Save secret',
  'Clear secret',
  'ClawHunt login',
  'Manual update path',
  'No auto-updater yet. Update the desktop beta manually before broad distribution.',
  'docs/desktop-manual-update.md',
  'Settings and local agents',
  'Appearance settings',
  'Appearance settings description',
  'Desktop home overview',
  'Agent readiness',
  'Acceptance',
  'Configure path',
  'Open Capability Workshop',
  'Review agent doctor',
  'Review desktop acceptance',
  'Review TUI acceptance',
  'Agent doctor',
  'Login ClawHunt',
  'Sign in ClawHunt account',
  'Create ClawHunt agent key',
  'ClawHunt login server',
  'Probe login server',
  'Manual agent key',
  'Logout ClawHunt',
  'Save config key',
  'Rotate token',
  'Save backend default',
  'Desktop onboarding',
  'Refresh onboarding',
  'Download onboarding JSON',
  'Desktop source toolchain',
  'Desktop beta acceptance',
  'TUI acceptance',
  'Runtime dependency doctor',
  'Download acceptance JSON',
  'Download TUI acceptance JSON',
  'Supported desktop agents: Codex, Hermes, Claude Code, OpenClaw.',
  'Desktop alerts',
  'Send test alert',
  'Crash and log export',
  'Generate incident export',
  'Download incident bundle',
  'Missing evidence or protocol export stays nullable so you can still export runtime-only diagnostics after a bad run.',
  '/api/agents',
  '/api/plugins/status',
  '/api/plugins/diagnostics',
  '/api/plugins/diagnostics/events',
  '/api/plugins/install',
  '/api/plugins/install-local',
  '/api/plugins/uninstall',
  '/v1/entitlements/sync',
  '/api/plugins/config/set',
  '/api/plugins/secret/set',
  '/api/plugins/secret/delete',
  '/v1/developer/plugins',
  '/v1/plugins',
  '/v1/plugins/revocations',
  '/v1/policies/runtime',
  '/api/auth/status',
  '/api/auth/clawhunt/login',
  '/api/auth/clawhunt/account/login',
  '/api/auth/clawhunt/account/login-probe',
  '/api/auth/clawhunt/account/agents',
  '/api/auth/clawhunt/agent-key',
  '/api/auth/clawhunt/logout',
  '/api/auth/clawhunt/me',
  'async_execution',
  'harness_policy',
  'mini-order-ledger',
  // Composer @-mention company affordance: create a company or pick one to manage.
  '/api/team/companies',
  'composerTeamCompanies',
  '@company:create',
  '@company:${company.company_profile_id}',
  'name_hint',
  "type: 'company'",
  "type: 'company_create'",
]) {
  if (!source.includes(text)) {
    throw new Error(`Missing UI surface: ${text}`);
  }
}

for (const text of [
  'justify-self: center',
  'align-items: center',
  'width: min(100%, 900px)',
]) {
  if (!styles.includes(text)) {
    throw new Error(`Missing responsive chat layout rule: ${text}`);
  }
}

for (const text of [
  'App Internationalization Requirement',
  'Every future desktop/web app change must be i18n-ready before it is considered complete.',
  'The current supported locales are English (`en`) and Chinese (`zh`).',
  'PR review rejects new visible static copy without `en` and `zh` translations.',
]) {
  if (!appDesignDoc.includes(text)) {
    throw new Error(`Missing app i18n requirement in codex-like design doc: ${text}`);
  }
}
for (const text of ['app-titlebar']) {
  if (source.includes(text) || styles.includes(text)) {
    throw new Error(`Native desktop titlebar should not use custom overlay shell: ${text}`);
  }
}

// Appearance "follow system" mode was removed: the first-paint boot script in
// index.html must only honor a stored light/dark value (seeding from the OS once
// otherwise) and must never treat 'system' as a stored preference again.
if (/stored\s*===\s*'system'/.test(indexHtml)) {
  throw new Error("index.html theme boot script must not handle a 'system' preference anymore.");
}
if (!indexHtml.includes("stored === 'light' || stored === 'dark'")) {
  throw new Error('index.html theme boot script must resolve a stored light/dark preference.');
}
// The React theme code must likewise be free of a 'system' preference value. Match only
// theme-specific shapes (not the unrelated chat-turn `role === 'system'`).
if (
  source.includes("'system', 'light', 'dark'") ||
  /(?:themePreference|preference)\s*[!=]==\s*'system'/.test(source) ||
  source.includes("switchThemeToSystem") ||
  source.includes("themeSystem")
) {
  throw new Error("App theme code must not reference a 'system' appearance preference anymore.");
}

// Developer capability-upload surface: the kind/level options and the per-kind
// "what to include" guidance must come from the kernel contract (single source of
// truth), and the panel frames the package as a LOCAL path (this is a local
// developer console, not a hosted upload).
for (const text of [
  "'/api/contracts/capability-upload'",
  'capability-upload-form',
  'capability-contents-list',
  'selectedUploadKind',
  "t('Package path on this machine')",
]) {
  if (!source.includes(text)) {
    throw new Error(`Capability upload surface must be contract-driven and local: missing ${text}`);
  }
}
for (const text of ['capability-contents-list', 'capability-field-grid']) {
  if (!styles.includes(text)) {
    throw new Error(`Missing capability upload style rule: ${text}`);
  }
}
// Signing is a separate post-review step the upload endpoint rejects (HTTP 400);
// the upload surface must never collect a signing key again.
for (const text of ['signingPrivateKey', 'Developer signing key', 'optional signing key']) {
  if (source.includes(text)) {
    throw new Error(`Upload surface must not collect a signing key (rejected by API): ${text}`);
  }
}
if (!source.includes('className="macos-window-drag-region"') || !source.includes('data-tauri-drag-region=""')) {
  throw new Error('Overlay desktop chrome must expose the minimal macOS drag region.');
}
if (!styles.includes('grid-template-columns: minmax(0, 1fr) var(--sidebar-footer-toggle-size)')) {
  throw new Error('Sidebar footer must keep the collapse toggle square while Settings fills remaining width.');
}
if (!styles.includes('.sidebar-collapsed .sidebar-footer-actions')) {
  throw new Error('Collapsed sidebar footer must keep compact stacked controls.');
}
if (!styles.includes('.sidebar-collapsed .window-sidebar-toggle') || !styles.includes('order: -1')) {
  throw new Error('Collapsed sidebar must show the expand control above Settings.');
}
if (!styles.includes('.goal-pane-actions') || !styles.includes('right: var(--chat-edge-gutter)')) {
  throw new Error('Context control must use a dedicated upper-right goal-pane action area.');
}
if (
  !source.includes('onPointerDown={handleMacosWindowDragPointerDown}') ||
  !source.includes('onPointerMove={handleMacosWindowDragPointerMove}') ||
  !source.includes('startDesktopWindowDrag()') ||
  !source.includes('toggleDesktopWindowMaximize()') ||
  !source.includes('target?.closest(MACOS_DRAG_BLOCKING_SELECTOR)')
) {
  throw new Error('Overlay desktop chrome must support manual dragging and double-click maximize without capturing interactive controls.');
}
if (
  !desktopSource.includes("invoke('desktop_start_window_drag')") ||
  !desktopSource.includes("invoke('desktop_toggle_window_maximize')") ||
  !desktopRustSource.includes('pub fn desktop_start_window_drag(window: tauri::Window)') ||
  !desktopRustSource.includes('pub fn desktop_toggle_window_maximize(window: tauri::Window)')
) {
  throw new Error('Desktop window chrome must call explicit Tauri drag and maximize commands.');
}
if (
  !desktopRustSource.includes('.start_dragging()') ||
  !desktopRustSource.includes('.is_maximized()') ||
  !desktopRustSource.includes('.maximize()') ||
  !desktopRustSource.includes('.unmaximize()') ||
  !desktopRustSource.includes('commands::desktop_start_window_drag') ||
  !desktopRustSource.includes('commands::desktop_toggle_window_maximize')
) {
  throw new Error('Desktop window chrome commands must use native Tauri drag and maximize APIs.');
}
if (!styles.includes('--macos-traffic-light-space') || !styles.includes('left: var(--macos-traffic-light-space)')) {
  throw new Error('Overlay desktop chrome must reserve traffic-light-safe drag space.');
}
if (
  // the plugin configuration dialog renders through the unified DialogShell
  // 'full' variant (settings-redesign PR-6b); the legacy .plugin-config-modal
  // shell class is retired while its body classes remain
  !styles.includes('.dialog-shell-panel--full') ||
  !styles.includes('width: min(1680px, 100%)') ||
  !styles.includes('height: 100%') ||
  !styles.includes('max-height: clamp(420px, 62vh, 760px)')
) {
  throw new Error('Plugin configuration must use a page-scale workspace panel with a large readable preview area.');
}
if (styles.includes('width: min(1040px, calc(100vw - 48px))') || styles.includes('max-height: min(820px, calc(100vh - 48px))')) {
  throw new Error('Plugin configuration should not regress to the old fixed-size modal bounds.');
}
for (const text of [
  '.plugin-config-modal-grid {\n  display: flex;',
  'flex-wrap: wrap;',
  'min-height: max-content;',
  'height: max-content;',
  '.plugin-config-modal-grid input',
  '.plugin-setting-actions',
  '.plugin-setting-dynamic',
  '.control-card-head-pills',
]) {
  if (!styles.includes(text)) {
    throw new Error(`Plugin configuration cards must grow and wrap controls without overlap: ${text}`);
  }
}
if (styles.includes('.plugin-config-modal-grid {\n  grid-template-columns: repeat(2, minmax(360px, 1fr));')) {
  throw new Error('Plugin configuration modal must not use the old fixed two-column grid that can overlap async card content.');
}
if (
  !styles.includes('--plugin-showcase-bg') ||
  !styles.includes(":root[data-theme='dark']") ||
  !styles.includes('--plugin-icon-tile-bg: linear-gradient(135deg, #16203c, #0f1530)') ||
  !styles.includes('background: var(--plugin-showcase-bg)') ||
  !styles.includes('background: var(--plugin-icon-tile-bg)') ||
  !styles.includes('background: var(--composer-message-bg)')
) {
  throw new Error('Capability Workshop and status messages must use theme-aware dark-mode surface tokens.');
}
for (const text of ['<strong>ClawHunt</strong>', 'sidebar-brand-copy', 'sidebar-brand', 'brand-mark', 'sidebar-collapse-button']) {
  if (source.includes(text) || styles.includes(text)) {
    throw new Error(`Sidebar brand block should be removed from the rail header: ${text}`);
  }
}

// Skill-sync surface (Plugins workspace → Skills tab) must be wired to the
// governed core endpoints and render runtime targets from the API contract.
for (const text of [
  '/api/plugins/skills/contract',
  '/api/plugins/skills/projections',
  '/api/plugins/skills/sync',
  '/api/plugins/skills/unsync',
  '/v1/skills',
  'loadNativeSkills',
  'loadSkillProjections',
  'syncSkills',
  'unsyncSkillsForPlugin',
  'native-skill-store',
  'skill-sync-panel',
  'skill-projection-list',
  "t('Native skill store title')",
  "t('Skill projections title')",
]) {
  if (!source.includes(text)) {
    throw new Error(`Skill-sync surface wiring missing from App.tsx: ${text}`);
  }
}
if (!source.includes('skillSyncContract.targets')) {
  throw new Error('Skill-sync panel must render runtime targets from the API contract, not a hardcoded list.');
}
for (const text of ['.native-skill-store', '.native-skill-grid', '.skill-label-badge', '.skill-sync-panel', '.skill-projection-list', '.skill-projection-empty']) {
  if (!styles.includes(text)) {
    throw new Error(`Skill-sync styles missing: ${text}`);
  }
}

// Capability Workshop trust badge. The text source pill (official / developer /
// local) was replaced by an X-style scalloped VERIFIED badge: official => green,
// developer => blue, everything else (local / untrusted / revoked / absent) =>
// NO badge. The trust→tone DECISION still lives in the kernel-derived classifier
// pluginCatalogSourceBadge (plugin/company) and nativeSkillVerifiedBadge (skill);
// this only swapped how that verdict is rendered. It must stay fail-closed (no
// badge for revoked/untrusted/unknown trust) and never fabricate an "official"
// verdict on the trust-absent fallback path.
for (const text of [
  "'Plugin catalog source official': 'Official'",
  "'Plugin catalog source developer': 'Developer'",
  "'Plugin catalog source local': 'Local'",
  "'Plugin catalog source official': '官方'",
  "'Plugin catalog source developer': '开发者'",
  "'Plugin catalog source local': '本地'",
  'function pluginCatalogSourceBadge(',
  'if (item.revoked) return null;',
  "if (trust === 'untrusted') return null;",
  'if (trust) return null;',
  // Rendering layer: the scalloped badge component + its trust→tone projectors.
  'function VerifiedBadge(',
  'function workshopVerifiedBadge(',
  'function nativeSkillVerifiedBadge(',
  'tone={model.verifiedTone}',
]) {
  if (!source.includes(text)) {
    throw new Error(`Capability Workshop verified badge wiring missing from App.tsx: ${text}`);
  }
}
// The trust-absent fallback must never assign the official tone.
{
  const helperStart = source.indexOf('function pluginCatalogSourceBadge(');
  const helperEnd = source.indexOf('\n  }', helperStart);
  const helperBody = source.slice(helperStart, helperEnd);
  const fallbackStart = helperBody.indexOf("if (trust) return null;");
  const fallbackBody = helperBody.slice(fallbackStart);
  if (fallbackBody.includes('officialBadge')) {
    throw new Error('Source badge trust-absent fallback must never claim official (fail-closed).');
  }
}
// The plugin/company badge projector only lights official/developer and fails
// closed (no badge) for the local tone and anything else.
{
  const start = source.indexOf('function workshopVerifiedBadge(');
  const end = source.indexOf('\n  }', start);
  const body = source.slice(start, end);
  if (
    !body.includes("if (badge.tone === 'official')") ||
    !body.includes("if (badge.tone === 'developer')") ||
    !body.trimEnd().endsWith('return null;')
  ) {
    throw new Error('workshopVerifiedBadge must light only official/developer and fail closed otherwise.');
  }
}
// The skill badge projector must fail closed: it lights ONLY off the kernel-derived
// `trust` verdict, NEVER off a skill-store `label`. A self-signed / developer-supplied
// skill can carry an 'official'/'reviewed' label without root-official trust, so
// deriving the green/blue badge from `labels.includes(...)` would forge a verification
// mark. (Labels still render as plain-text chips on the detail page — info preserved,
// trust claim not.)
{
  const start = source.indexOf('function nativeSkillVerifiedBadge(');
  const end = source.indexOf('\n  }', start);
  const body = source.slice(start, end);
  if (!body.includes("if (skill.labels.includes('revoked')) return null;")) {
    throw new Error('nativeSkillVerifiedBadge must fail closed on a revoked skill.');
  }
  if (body.includes("labels.includes('official')") || body.includes("labels.includes('reviewed')")) {
    throw new Error('Skill verified badge must NOT be lit from a skill-store label — only the kernel trust verdict.');
  }
  if (!/trust === 'official'/.test(body) || !/trust === 'developer'/.test(body)) {
    throw new Error('Skill verified badge tone must derive from the kernel trust verdict.');
  }
}
// The verified badge uses a fixed brand-semantic fill (constant across themes)
// with a white inner check, so it reads on either fill in light AND dark mode.
for (const text of ['.verified-badge', '.verified-badge.official', '.verified-badge.developer', '.verified-badge .vb-check']) {
  if (!styles.includes(text)) {
    throw new Error(`Verified badge styles missing: ${text}`);
  }
}
