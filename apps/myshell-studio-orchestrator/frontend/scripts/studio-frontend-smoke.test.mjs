import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCanvasProSmokeUrl,
  buildStudioSmokeUrl,
  createStudioSmokeInitScript,
  createSmokeSummary,
  normalizeFrontendBaseUrl,
  REQUIRED_CANVASPRO_CHECK_IDS,
  REQUIRED_STUDIO_CHECK_IDS,
  runStudioFrontendSmoke,
} from './studio-frontend-smoke.mjs';

test('buildStudioSmokeUrl opens the root Studio route from a bare dev server URL', () => {
  assert.equal(
    buildStudioSmokeUrl('http://127.0.0.1:5174'),
    'http://127.0.0.1:5174/',
  );
});

test('buildCanvasProSmokeUrl opens CanvasPro through the single Dreamy Studio route', () => {
  assert.equal(
    buildCanvasProSmokeUrl('http://127.0.0.1:5174'),
    'http://127.0.0.1:5174/dreamy?workspace=canvaspro',
  );
});

test('normalizeFrontendBaseUrl trims trailing slash and rejects missing URL', () => {
  assert.equal(normalizeFrontendBaseUrl(' http://localhost:5174/ '), 'http://localhost:5174');
  assert.throws(() => normalizeFrontendBaseUrl(''), /frontend URL is required/i);
});

test('studio smoke CLI has a global timeout guard', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('./studio-frontend-smoke.mjs', import.meta.url), 'utf8');
  assert.match(source, /global-timeout-ms/);
  assert.match(source, /STUDIO_FRONTEND_SMOKE_GLOBAL_TIMEOUT_MS/);
  assert.match(source, /global timeout/);
});

test('studio smoke can use an explicit Chromium executable path', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('./studio-frontend-smoke.mjs', import.meta.url), 'utf8');
  assert.match(source, /PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH/);
  assert.match(source, /browser-executable/);
  assert.match(source, /executablePath/);
  assert.match(source, /canvaspro-only/);
});

test('createSmokeSummary records checked UI surfaces and console errors', () => {
  const summary = createSmokeSummary({
    frontendUrl: 'http://127.0.0.1:5174',
    checkedAt: '2026-06-02T00:00:00.000Z',
    checks: [
      { id: 'title', label: 'Studio title', ok: true },
      { id: 'evidence', label: 'Evidence drawer', ok: false, message: 'not visible' },
    ],
    consoleErrors: ['boom'],
    screenshotPath: '/tmp/dreamy.png',
    workspaceScreenshotPath: '/tmp/dreamy-workspace.png',
    evidenceScreenshotPath: '/tmp/dreamy-evidence.png',
  });

  assert.equal(summary.status, 'failed');
  assert.equal(summary.screenshotPath, '/tmp/dreamy-evidence.png');
  assert.deepEqual(summary.screenshots, {
    workspace: '/tmp/dreamy-workspace.png',
    evidence: '/tmp/dreamy-evidence.png',
  });
  assert.equal(summary.summary.total, 2);
  assert.equal(summary.summary.passed, 1);
  assert.equal(summary.summary.failed, 1);
  assert.equal(summary.failures[0].id, 'evidence');
  assert.equal(summary.consoleErrors.length, 1);
});

test('createStudioSmokeInitScript bypasses the production age gate for smoke runs', () => {
  const script = createStudioSmokeInitScript();

  assert.match(script, /dp_age_gate_passed/);
  assert.match(script, /localStorage\.setItem/);
  assert.match(script, /'1'/);
});

test('createSmokeSummary fails when required dispatch queue interaction checks are missing', () => {
  const requiredDispatchChecks = [
    'dispatch-batch-planned',
    'dispatch-session-started',
    'dispatch-next-target-ready',
    'dispatch-navigation-target-selected',
    'dispatch-selected-batch-planned',
    'dispatch-selected-session-started',
    'dispatch-target-opened',
    'studio-return-dock-visible',
    'studio-return-restored',
    'dispatch-target-visited',
  ];
  for (const id of requiredDispatchChecks) {
    assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes(id), `${id} should be required`);
  }
  const summary = createSmokeSummary({
    frontendUrl: 'http://127.0.0.1:5174',
    checkedAt: '2026-06-02T00:00:00.000Z',
    checks: [{ id: 'studio-title', label: 'Studio title', ok: true }],
    requiredCheckIds: requiredDispatchChecks,
  });

  assert.equal(summary.status, 'failed');
  assert.deepEqual(
    summary.failures.map((failure) => failure.id),
    requiredDispatchChecks,
  );
});

test('runStudioFrontendSmoke records the delivery command center surface', () => {
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('delivery-command-center'));
  assert.match(runStudioFrontendSmoke.toString(), /delivery-command-center/);
});

test('runStudioFrontendSmoke records non-overlapping Studio workspace layout', () => {
  const layoutChecks = [
    'conversation-workspace-panel',
    'bot-selection-panel',
    'bot-selection-scroll-region',
    'manual-bot-id-panel',
    'manual-bot-id-input',
    'manual-bot-run-sequence',
    'manual-bot-sequence-run',
    'studio-chat-region',
    'studio-composer',
    'preview-workspace-panel',
    'studio-layout-no-overlap',
    'studio-left-sections-readable',
  ];
  for (const id of layoutChecks) {
    assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes(id), `${id} should be required`);
    if (id === 'studio-layout-no-overlap' || id === 'studio-left-sections-readable') {
      assert.match(runStudioFrontendSmoke.toString(), /checkStudioLayoutGeometry/);
    } else {
      assert.match(runStudioFrontendSmoke.toString(), new RegExp(id));
    }
  }
});

test('runStudioFrontendSmoke records starter presets and direct preset generation', () => {
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('starter-presets'));
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('ai-recommendation-agent'));
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('ai-recommendation-run'));
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('starter-visual-recommendations'));
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('starter-bot-preview-image'));
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('starter-bot-preview-asset'));
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('all-bot-previews'));
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('all-bot-preview-card'));
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('all-bot-preview-image'));
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('dreamy-bot-list-only'));
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('starter-preset-selection'));
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('dreamy-bot-selection-state'));
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('selected-dreamy-bot-preview'));
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('preview-selected-dreamy-bot'));
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('starter-preset-direct-generate'));
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('starter-preset-prompt-ready'));
  assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes('starter-preset-result-visible'));
  assert.match(runStudioFrontendSmoke.toString(), /starter-presets/);
  assert.match(runStudioFrontendSmoke.toString(), /ai-recommendation-agent/);
  assert.match(runStudioFrontendSmoke.toString(), /ai-recommendation-run/);
  assert.match(runStudioFrontendSmoke.toString(), /starter-visual-recommendations/);
  assert.match(runStudioFrontendSmoke.toString(), /starter-bot-preview-image/);
  assert.match(runStudioFrontendSmoke.toString(), /starter-bot-preview-asset/);
  assert.match(runStudioFrontendSmoke.toString(), /all-bot-previews/);
  assert.match(runStudioFrontendSmoke.toString(), /all-bot-preview-card/);
  assert.match(runStudioFrontendSmoke.toString(), /all-bot-preview-image/);
  assert.match(runStudioFrontendSmoke.toString(), /dreamy-bot-list-only/);
  assert.match(runStudioFrontendSmoke.toString(), /starter-preset-selection/);
  assert.match(runStudioFrontendSmoke.toString(), /dreamy-bot-selection-state/);
  assert.match(runStudioFrontendSmoke.toString(), /selected-dreamy-bot-preview/);
  assert.match(runStudioFrontendSmoke.toString(), /preview-selected-dreamy-bot/);
  assert.match(runStudioFrontendSmoke.toString(), /starter-preset-direct-generate/);
  assert.match(runStudioFrontendSmoke.toString(), /starter-preset-prompt-ready/);
  assert.match(runStudioFrontendSmoke.toString(), /starter-preset-result-visible/);
  assert.doesNotMatch(runStudioFrontendSmoke.toString(), /getByDisplayValue/);
});

test('runStudioFrontendSmoke records canvas flow and segment export controls', () => {
  const newWorkflowChecks = [
    'preview-segment-rerun',
    'preview-append-next-segment',
    'preview-export-all-segments',
    'timeline-export-created',
    'timeline-export-output-card',
    'video-fast-status',
    'canvas-auto-flow-presets',
    'canvas-material-flow-ready',
  ];
  for (const id of newWorkflowChecks) {
    assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes(id), `${id} should be required`);
    assert.match(runStudioFrontendSmoke.toString(), new RegExp(id));
  }
});

test('runStudioFrontendSmoke records CanvasPro single-entry smoke checks', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('./studio-frontend-smoke.mjs', import.meta.url), 'utf8');
  const canvasProChecks = [
    'canvaspro-workspace-switch',
    'creative-director-workspace-open',
    'creative-director-workspace-panel',
    'creative-director-five-tools',
    'creative-director-return-canvaspro',
    'canvaspro-workspace-route',
    'canvaspro-studio-shell-hidden',
    'canvaspro-workspace-panel',
    'canvaspro-iframe',
    'canvaspro-iframe-entry',
    'canvaspro-bridge-status',
    'canvaspro-cli-auth-status',
    'canvaspro-managed-layout-no-overlap',
    'canvaspro-quick-create',
    'canvaspro-quick-create-prompt',
    'canvaspro-add-menu-trigger',
    'canvaspro-add-menu',
    'canvaspro-add-menu-text',
    'canvaspro-add-menu-image',
    'canvaspro-add-menu-video',
    'canvaspro-add-menu-audio',
    'canvaspro-add-menu-world',
    'canvaspro-add-menu-playlist',
    'canvaspro-add-menu-image-editor',
    'canvaspro-add-menu-upload',
    'canvaspro-add-menu-audio-node',
    'canvaspro-add-menu-upload-node',
    'canvaspro-assistant-actions',
    'canvaspro-assistant-summary',
    'canvaspro-assistant-references',
    'canvaspro-assistant-gaps',
    'canvaspro-organize-layout',
    'canvaspro-context-assistant',
    'canvaspro-cli-auth-card',
    'canvaspro-context-assistant-prompt',
    'canvaspro-context-assistant-suggestions',
    'canvaspro-context-assistant-suggestion-next',
    'canvaspro-context-assistant-suggestion-references',
    'canvaspro-context-assistant-suggestion-directions',
    'canvaspro-context-assistant-mode',
    'canvaspro-context-assistant-run',
    'canvaspro-context-assistant-execution',
    'canvaspro-context-assistant-execution-step',
    'canvaspro-context-assistant-run-flow-group',
    'canvaspro-context-assistant-run-flow-edge',
    'canvaspro-context-assistant-run-submit-image',
    'canvaspro-context-assistant-run-submit-video',
    'canvaspro-context-assistant-next-note',
    'canvaspro-selected-action-strip',
    'canvaspro-selected-action-image',
    'canvaspro-selected-action-video',
    'canvaspro-selected-action-reference',
    'canvaspro-selected-action-variants',
    'canvaspro-selected-action-flow',
    'canvaspro-selected-action-reference-node',
    'canvaspro-selected-action-reference-edge',
    'canvaspro-context-assistant-image',
    'canvaspro-context-assistant-video',
    'canvaspro-context-assistant-reference',
    'canvaspro-context-assistant-variants',
    'canvaspro-context-assistant-organize',
    'canvaspro-generation-queue',
    'canvaspro-generation-queue-item',
    'canvaspro-generation-task-aspect-ratio',
    'canvaspro-generation-task-atom',
    'canvaspro-generation-task-atom-command',
    'canvaspro-generation-task-cost',
    'canvaspro-generation-task-detail',
    'canvaspro-generation-task-duration',
    'canvaspro-generation-task-focus',
    'canvaspro-generation-task-metadata',
    'canvaspro-generation-task-mode',
    'canvaspro-generation-task-model',
    'canvaspro-generation-task-param-summary',
    'canvaspro-generation-task-source-inputs',
    'canvaspro-generation-task-source-input-values',
    'canvaspro-generation-task-output-slot',
    'canvaspro-generation-task-output-slots',
    'canvaspro-generation-task-output-slots-update',
    'canvaspro-generation-task-output-materialize',
    'canvaspro-generation-task-output-materialize-idempotent',
    'canvaspro-generation-task-output-continue-video',
    'canvaspro-generation-task-output-continue-variants',
    'canvaspro-generation-task-output-continue-reference',
    'canvaspro-generation-task-output-rerun',
    'canvaspro-generation-task-output-rerun-model',
    'canvaspro-generation-task-output-continue-video-node',
    'canvaspro-generation-task-output-continue-video-edge',
    'canvaspro-generation-task-rerun',
    'canvaspro-generation-task-rerun-node',
    'canvaspro-generation-task-rerun-edge',
    'canvaspro-generation-task-rerun-model',
    'canvaspro-generation-task-rerun-model-node',
    'canvaspro-generation-task-rerun-model-setting',
    'canvaspro-generation-task-output-count',
    'canvaspro-generation-task-prompt',
    'canvaspro-generation-task-prompt-update',
    'canvaspro-generation-task-quality',
    'canvaspro-generation-task-resolution',
    'canvaspro-generation-task-save',
    'canvaspro-generation-task-settings-update',
    'canvaspro-generation-auto-sync',
    'canvaspro-generation-task-auto-sync',
    'canvaspro-generation-task-sync',
    'canvaspro-generation-task-sync-auto-materialize',
    'canvaspro-generation-task-submit',
    'canvaspro-generation-task-submit-update',
    'canvaspro-slash-command-menu',
    'canvaspro-slash-command-video',
    'canvaspro-slash-command-note',
    'canvaspro-slash-command-cite',
    'canvaspro-slash-command-animate',
    'canvaspro-slash-command-flow',
    'canvaspro-slash-command-storyboard',
    'canvaspro-slash-command-variants',
    'canvaspro-slash-command-organize',
    'canvaspro-slash-command-ref',
    'canvaspro-create-note',
    'canvaspro-create-reference-from-selection',
    'canvaspro-create-image',
    'canvaspro-create-image-from-selection',
    'canvaspro-create-video',
    'canvaspro-create-video-from-selection',
    'canvaspro-create-flow',
    'canvaspro-create-storyboard',
    'canvaspro-create-variants-from-selection',
    'canvaspro-create-flow-from-selection',
    'canvaspro-quick-create-image-node',
    'canvaspro-quick-create-image-autoprepare',
    'canvaspro-quick-create-selected-image-node',
    'canvaspro-quick-create-selected-image-edge',
    'canvaspro-quick-create-note-node',
    'canvaspro-quick-create-slash-note-node',
    'canvaspro-quick-create-reference-note-node',
    'canvaspro-quick-create-reference-note-edge',
    'canvaspro-quick-create-slash-cite-node',
    'canvaspro-quick-create-slash-cite-edge',
    'canvaspro-quick-create-selected-video-node',
    'canvaspro-quick-create-selected-video-edge',
    'canvaspro-quick-create-selected-video-last-frame-edge',
    'canvaspro-quick-create-slash-animate-node',
    'canvaspro-quick-create-slash-animate-edge',
    'canvaspro-context-assistant-image-node',
    'canvaspro-context-assistant-image-edge',
    'canvaspro-context-assistant-video-node',
    'canvaspro-context-assistant-video-edge',
    'canvaspro-quick-create-video-node',
    'canvaspro-quick-create-video-autoprepare',
    'canvaspro-quick-create-slash-video-node',
    'canvaspro-quick-create-flow-group',
    'canvaspro-quick-create-flow-children',
    'canvaspro-quick-create-flow-edge',
    'canvaspro-quick-create-slash-flow-group',
    'canvaspro-quick-create-slash-flow-edge',
    'canvaspro-quick-create-storyboard-group',
    'canvaspro-quick-create-storyboard-shots',
    'canvaspro-quick-create-storyboard-edges',
    'canvaspro-quick-create-slash-storyboard-group',
    'canvaspro-quick-create-slash-storyboard-edges',
    'canvaspro-quick-create-selected-variants-group',
    'canvaspro-quick-create-selected-variants-source',
    'canvaspro-quick-create-selected-variants-nodes',
    'canvaspro-quick-create-selected-variants-edges',
    'canvaspro-quick-create-slash-variants-group',
    'canvaspro-quick-create-slash-variants-edges',
    'canvaspro-organize-layout-action',
    'canvaspro-organize-layout-selection',
    'canvaspro-quick-create-selected-flow-group',
    'canvaspro-quick-create-selected-flow-source',
    'canvaspro-quick-create-selected-flow-edge',
    'canvaspro-quick-create-slash-ref-flow-group',
    'canvaspro-quick-create-slash-ref-flow-source',
    'canvaspro-quick-create-slash-ref-flow-edge',
    'canvaspro-assistant-summary-note',
    'canvaspro-assistant-references-note',
    'canvaspro-assistant-gaps-note',
    'canvaspro-runtime-api',
    'canvaspro-studio-surface-policy',
    'canvaspro-upstream-toast-policy',
    'canvaspro-upstream-author-links-hidden',
    'canvaspro-license-disclosure-menu',
    'canvaspro-license-disclosure-dialog',
    'canvaspro-no-direct-proxy-error',
  ];
  for (const id of canvasProChecks) {
    assert.ok(REQUIRED_STUDIO_CHECK_IDS.includes(id), `${id} should be required`);
    if (id !== 'canvaspro-workspace-switch') {
      assert.ok(REQUIRED_CANVASPRO_CHECK_IDS.includes(id), `${id} should be required in CanvasPro-only smoke`);
    }
    assert.match(source, new RegExp(id));
  }
  assert.match(runStudioFrontendSmoke.toString(), /checkCanvasProWorkspace/);
  assert.match(runStudioFrontendSmoke.toString(), /REQUIRED_CANVASPRO_CHECK_IDS/);
});
