#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const DEFAULT_FRONTEND_URL = 'http://127.0.0.1:5174';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_GLOBAL_TIMEOUT_MS = 180_000;
const AGE_GATE_STORAGE_KEY = 'dp_age_gate_passed';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(scriptDir, '..');
const currentFile = fileURLToPath(import.meta.url);

export const REQUIRED_STUDIO_CHECK_IDS = Object.freeze([
  'studio-title',
  'conversation-workspace-panel',
  'bot-selection-panel',
  'bot-selection-scroll-region',
  'manual-bot-id-panel',
  'manual-bot-id-input',
  'manual-bot-sequence-list',
  'manual-bot-run-selected',
  'manual-bot-run-sequence',
  'manual-bot-sequence-run',
  'studio-chat-region',
  'studio-composer',
  'preview-workspace-panel',
  'studio-layout-no-overlap',
  'studio-left-sections-readable',
  'ai-recommendation-agent',
  'ai-recommendation-run',
  'starter-presets',
  'starter-visual-recommendations',
  'starter-bot-preview-image',
  'starter-bot-preview-asset',
  'all-bot-previews',
  'all-bot-preview-card',
  'all-bot-preview-image',
  'dreamy-bot-list-only',
  'starter-preset-selection',
  'dreamy-bot-selection-state',
  'selected-dreamy-bot-preview',
  'preview-selected-dreamy-bot',
  'starter-preset-direct-generate',
  'starter-preset-prompt-ready',
  'starter-preset-result-visible',
  'preview-segment-rerun',
  'preview-append-next-segment',
  'preview-export-all-segments',
  'timeline-export-created',
  'timeline-export-output-card',
  'video-fast-status',
  'canvas-mode',
  'canvas-auto-flow-presets',
  'canvas-material-flow-ready',
  'layers-panel',
  'inspector-panel',
  'canvas-generate',
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
  'canvaspro-generation-auto-sync',
  'canvaspro-generation-task-aspect-ratio',
  'canvaspro-generation-task-auto-sync',
  'canvaspro-generation-task-cost',
  'canvaspro-generation-task-detail',
  'canvaspro-generation-task-atom',
  'canvaspro-generation-task-atom-command',
  'canvaspro-generation-task-param-summary',
  'canvaspro-generation-task-source-inputs',
  'canvaspro-generation-task-source-input-values',
  'canvaspro-generation-task-duration',
  'canvaspro-generation-task-focus',
  'canvaspro-generation-task-metadata',
  'canvaspro-generation-task-mode',
  'canvaspro-generation-task-model',
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
  'footer-evidence',
  'footer-plan-remaining',
  'footer-start-queue',
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
  'open-evidence-drawer',
  'delivery-evidence',
  'delivery-command-center',
  'page-selector',
  'agent-selector',
  'page-registry',
  'dispatch-matrix',
  'dispatch-queue',
  'audit-json',
  'no-error-boundary',
]);

export const REQUIRED_CANVASPRO_CHECK_IDS = Object.freeze([
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
  'canvaspro-generation-task-cost',
  'canvaspro-generation-task-detail',
  'canvaspro-generation-auto-sync',
  'canvaspro-generation-task-auto-sync',
  'canvaspro-generation-task-atom',
  'canvaspro-generation-task-atom-command',
  'canvaspro-generation-task-param-summary',
  'canvaspro-generation-task-source-inputs',
  'canvaspro-generation-task-source-input-values',
  'canvaspro-generation-task-duration',
  'canvaspro-generation-task-focus',
  'canvaspro-generation-task-metadata',
  'canvaspro-generation-task-mode',
  'canvaspro-generation-task-model',
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
]);

export function normalizeFrontendBaseUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) throw new Error('Frontend URL is required');
  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Frontend URL must be http or https: ${trimmed}`);
  }
  parsed.hash = '';
  if (parsed.pathname === '/' && !parsed.search) return parsed.origin;
  return parsed.toString().replace(/\/$/, '');
}

export function buildStudioSmokeUrl(frontendUrl) {
  const normalized = normalizeFrontendBaseUrl(frontendUrl);
  const url = new URL(normalized);
  if (!url.pathname || url.pathname === '/') url.pathname = '/';
  return url.toString();
}

export function buildCanvasProSmokeUrl(frontendUrl) {
  const normalized = normalizeFrontendBaseUrl(frontendUrl);
  const url = new URL(normalized);
  url.pathname = '/dreamy';
  url.search = 'workspace=canvaspro';
  url.hash = '';
  return url.toString();
}

export function createStudioSmokeInitScript() {
  return `
    try {
      window.localStorage.setItem('${AGE_GATE_STORAGE_KEY}', '1');
      window.localStorage.setItem('myshell-studio-canvaspro-dry-run', '1');
    } catch {}
  `;
}

export function createSmokeSummary({
  frontendUrl,
  checkedAt = new Date().toISOString(),
  checks = [],
  consoleErrors = [],
  screenshotPath = '',
  workspaceScreenshotPath = '',
  evidenceScreenshotPath = '',
  allowConsoleErrors = false,
  requiredCheckIds = [],
}) {
  const recordedCheckIds = new Set(checks.map((check) => check.id));
  const missingRequiredChecks = requiredCheckIds
    .filter((id) => !recordedCheckIds.has(id))
    .map((id) => ({
      id,
      label: `Required smoke check: ${id}`,
      ok: false,
      message: 'Required smoke check was not recorded',
    }));
  const allChecks = [...checks, ...missingRequiredChecks];
  const failures = allChecks.filter((check) => !check.ok);
  const blockingConsoleErrors = allowConsoleErrors ? [] : consoleErrors;
  const evidenceScreenshot = evidenceScreenshotPath || screenshotPath;
  const workspaceScreenshot = workspaceScreenshotPath || '';
  return {
    status: failures.length || blockingConsoleErrors.length ? 'failed' : 'ok',
    checkedAt,
    frontendUrl,
    screenshotPath: evidenceScreenshot || workspaceScreenshot || screenshotPath,
    screenshots: {
      workspace: workspaceScreenshot,
      evidence: evidenceScreenshot,
    },
    summary: {
      total: allChecks.length,
      passed: allChecks.filter((check) => check.ok).length,
      failed: failures.length,
      consoleErrors: consoleErrors.length,
    },
    checks: allChecks,
    failures,
    consoleErrors,
  };
}

function parseArgs(argv) {
  const defaultScreenshotDir = path.join(frontendRoot, '.studio-smoke');
  const defaultEvidenceScreenshot = path.join(defaultScreenshotDir, 'dreamy-evidence.png');
  const args = {
    frontendUrl: process.env.STUDIO_FRONTEND_URL || DEFAULT_FRONTEND_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    globalTimeoutMs: Number(process.env.STUDIO_FRONTEND_SMOKE_GLOBAL_TIMEOUT_MS || DEFAULT_GLOBAL_TIMEOUT_MS),
    screenshotPath: defaultEvidenceScreenshot,
    workspaceScreenshotPath: path.join(defaultScreenshotDir, 'dreamy-workspace.png'),
    evidenceScreenshotPath: defaultEvidenceScreenshot,
    reportPath: process.env.STUDIO_FRONTEND_SMOKE_REPORT || '',
    allowConsoleErrors: false,
    browserExecutablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH || '',
    canvasproOnly: true,
    headed: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--url' || arg === '--frontend-url') {
      args.frontendUrl = next;
      index += 1;
    } else if (arg === '--timeout-ms') {
      args.timeoutMs = Number(next);
      index += 1;
    } else if (arg === '--global-timeout-ms') {
      args.globalTimeoutMs = Number(next);
      index += 1;
    } else if (arg === '--screenshot') {
      args.screenshotPath = next;
      args.evidenceScreenshotPath = next;
      index += 1;
    } else if (arg === '--workspace-screenshot') {
      args.workspaceScreenshotPath = next;
      index += 1;
    } else if (arg === '--evidence-screenshot') {
      args.evidenceScreenshotPath = next;
      args.screenshotPath = next;
      index += 1;
    } else if (arg === '--report') {
      args.reportPath = next;
      index += 1;
    } else if (arg === '--no-screenshot') {
      args.screenshotPath = '';
      args.workspaceScreenshotPath = '';
      args.evidenceScreenshotPath = '';
    } else if (arg === '--allow-console-errors') {
      args.allowConsoleErrors = true;
    } else if (arg === '--browser-executable') {
      args.browserExecutablePath = next;
      index += 1;
    } else if (arg === '--canvaspro-only') {
      args.canvasproOnly = true;
    } else if (arg === '--headed') {
      args.headed = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  if (!Number.isFinite(args.globalTimeoutMs) || args.globalTimeoutMs <= 0) {
    throw new Error('--global-timeout-ms must be a positive number');
  }
  return args;
}

function usage() {
  return [
    'Usage: node scripts/studio-frontend-smoke.mjs [options]',
    '',
    'Options:',
    '  --url, --frontend-url <url>   Frontend dev/preview URL. Default: STUDIO_FRONTEND_URL or http://127.0.0.1:5174',
  '  --timeout-ms <ms>             Per-check timeout. Default: 15000',
  '  --global-timeout-ms <ms>      Whole smoke timeout. Default: 180000',
    '  --screenshot <path>           Legacy alias for --evidence-screenshot',
    '  --workspace-screenshot <path> Canvas workspace screenshot path',
    '  --evidence-screenshot <path>  Delivery Evidence drawer screenshot path',
    '  --report <path>               Write the full smoke JSON report to a file',
    '  --no-screenshot               Skip screenshot capture',
    '  --allow-console-errors        Record console errors without failing the smoke',
    '  --browser-executable <path>    Chromium/Chrome executable path. Defaults to PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
    '  --canvaspro-only              Only verify /dreamy?workspace=canvaspro (default)',
    '  --headed                      Launch a visible browser',
  ].join('\n');
}

async function checkVisible(checks, page, id, label, locator, timeoutMs) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
    checks.push({ id, label, ok: true });
  } catch (error) {
    checks.push({
      id,
      label,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function clickVisible(checks, page, id, label, locator, timeoutMs) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
    await locator.first().click({ timeout: timeoutMs });
    checks.push({ id, label, ok: true });
  } catch (error) {
    checks.push({
      id,
      label,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function checkEnabled(checks, page, id, label, locator, timeoutMs) {
  const target = locator.first();
  const started = Date.now();
  try {
    await target.waitFor({ state: 'visible', timeout: timeoutMs });
    while (Date.now() - started < timeoutMs) {
      if (await target.isEnabled().catch(() => false)) {
        checks.push({ id, label, ok: true });
        return;
      }
      await page.waitForTimeout(100);
    }
    checks.push({ id, label, ok: false, message: 'Control did not become enabled' });
  } catch (error) {
    checks.push({
      id,
      label,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function recordedCheckOk(checks, id) {
  for (let index = checks.length - 1; index >= 0; index -= 1) {
    if (checks[index].id === id) return Boolean(checks[index].ok);
  }
  return false;
}

async function clickEnabled(checks, page, id, label, locator, timeoutMs) {
  const target = locator.first();
  try {
    await checkEnabled(checks, page, id, label, target, timeoutMs);
    const recorded = checks.find((check) => check.id === id);
    if (!recorded?.ok) return;
    await target.click({ timeout: timeoutMs });
  } catch (error) {
    checks.push({
      id,
      label,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function checkStudioLayoutGeometry(checks, page, timeoutMs) {
  const locators = {
    left: page.getByTestId('conversation-workspace-panel'),
    bot: page.getByTestId('bot-selection-panel'),
    chatRegion: page.getByTestId('studio-chat-region'),
    chat: page.getByTestId('studio-chat-log'),
    composer: page.getByTestId('studio-composer'),
    preview: page.getByTestId('preview-workspace-panel'),
  };
  try {
    await Promise.all(
      Object.values(locators).map((locator) => locator.first().waitFor({ state: 'visible', timeout: timeoutMs })),
    );
    const [left, bot, chatRegion, chat, composer, preview] = await Promise.all(
      Object.values(locators).map((locator) => locator.first().boundingBox()),
    );
    const missing = { left, bot, chatRegion, chat, composer, preview };
    if (!left || !bot || !chatRegion || !chat || !composer || !preview) {
      checks.push({
        id: 'studio-layout-no-overlap',
        label: 'Studio layout sections do not overlap',
        ok: false,
        message: `Missing layout box: ${Object.entries(missing)
          .filter(([, box]) => !box)
          .map(([key]) => key)
          .join(', ')}`,
      });
      return;
    }
    const failures = [];
    if (bot.y + bot.height > chatRegion.y + 1) failures.push('bot selection overlaps chat region');
    if (chatRegion.y + chatRegion.height > composer.y + 1) failures.push('chat region overlaps composer');
    if (composer.y + composer.height > left.y + left.height + 1) failures.push('composer is clipped by left panel');
    if (left.x + left.width > preview.x + 1) failures.push('left panel overlaps preview panel');
    checks.push({
      id: 'studio-layout-no-overlap',
      label: 'Studio layout sections do not overlap',
      ok: failures.length === 0,
      message: failures.length ? failures.join('; ') : undefined,
    });

    const readableFailures = [];
    const maxBotHeight = Math.min(260, Math.max(180, left.height * 0.34));
    if (bot.height > maxBotHeight + 1) readableFailures.push(`bot selection too tall (${Math.round(bot.height)}px)`);
    if (chat.height < 180) readableFailures.push(`chat log too short (${Math.round(chat.height)}px)`);
    if (composer.height < 86) readableFailures.push(`composer clipped (${Math.round(composer.height)}px)`);
    if (preview.width < left.width) readableFailures.push('right preview is narrower than left control column');
    checks.push({
      id: 'studio-left-sections-readable',
      label: 'Left Studio sections stay readable and bounded',
      ok: readableFailures.length === 0,
      message: readableFailures.length ? readableFailures.join('; ') : undefined,
    });
  } catch (error) {
    checks.push({
      id: 'studio-layout-no-overlap',
      label: 'Studio layout sections do not overlap',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'studio-left-sections-readable',
      label: 'Left Studio sections stay readable and bounded',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function checkCanvasProManagedLayoutGeometry(checks, page, timeoutMs) {
  const label = 'CanvasPro managed layout keeps control zones separated';
  try {
    await Promise.all([
      page.getByTestId('canvaspro-context-assistant').waitFor({ state: 'visible', timeout: timeoutMs }),
      page.getByTestId('canvaspro-assistant-actions').waitFor({ state: 'visible', timeout: timeoutMs }),
      page.getByTestId('canvaspro-quick-create').waitFor({ state: 'visible', timeout: timeoutMs }),
    ]);

    const layout = await page.evaluate(() => {
      const readBox = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return {
          bottom: Math.round(rect.bottom),
          height: Math.round(rect.height),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        };
      };
      const overlaps = (a, b) => Boolean(a && b && !(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y));
      const boxes = {
        actions: readBox('[data-testid="canvaspro-assistant-actions"]'),
        quickCreate: readBox('[data-testid="canvaspro-quick-create"]'),
        rightAssistant: readBox('[data-testid="canvaspro-context-assistant"]'),
      };
      const failures = [];
      for (const [name, box] of Object.entries(boxes)) {
        if (!box) failures.push(`${name} missing`);
      }
      if (overlaps(boxes.rightAssistant, boxes.quickCreate)) failures.push('right assistant overlaps quick-create dock');
      if (overlaps(boxes.rightAssistant, boxes.actions)) failures.push('right assistant overlaps action dock');
      if (overlaps(boxes.actions, boxes.quickCreate)) failures.push('action dock overlaps quick-create dock');
      if (boxes.quickCreate && boxes.quickCreate.bottom > window.innerHeight - 4) failures.push('quick-create dock is clipped');
      if (boxes.actions && boxes.quickCreate && boxes.actions.bottom > boxes.quickCreate.y - 8) {
        failures.push('action dock is too close to quick-create dock');
      }
      return { boxes, failures, viewport: { height: window.innerHeight, width: window.innerWidth } };
    });

    const frame = page.frameLocator('[data-testid="canvaspro-iframe"]');
    await frame.locator('body').waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 8000) });
    const upstream = await frame.locator('body').evaluate(() => {
      const selectors = [
        '#v2-side-plus-holder',
        '.sidebar-floating',
        '.agent-sidebar-main',
        '.agent-greeting',
        '.agent-ref-bar',
        '.agent-model-btn',
        '#emptyHint',
        '.empty-hint',
        '.v2-file-history-content',
        '.v2-task-center-list',
        '.v2-asset-sidebar-content',
        '.v2-workflow-list',
        '.cpd-list',
      ];
      const isVisible = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          !element.hidden &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) !== 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      return selectors
        .filter((selector) => Array.from(document.querySelectorAll(selector)).some((element) => isVisible(element)))
        .map((selector) => selector);
    });

    const failures = [
      ...layout.failures,
      ...upstream.map((selector) => `upstream ${selector} still visible`),
    ];
    checks.push({
      id: 'canvaspro-managed-layout-no-overlap',
      label,
      ok: failures.length === 0,
      message: failures.length
        ? `${failures.join('; ')}; boxes=${JSON.stringify(layout.boxes)} viewport=${JSON.stringify(layout.viewport)}`
        : undefined,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-managed-layout-no-overlap',
      label,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function captureScreenshot(page, screenshotPath) {
  if (!screenshotPath) return;
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
}

async function checkCanvasProWorkspace(checks, page, frontendUrl, consoleErrors, timeoutMs) {
  const canvasProUrl = buildCanvasProSmokeUrl(frontendUrl);
  await page.goto(canvasProUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 5000) }).catch(() => undefined);

  checks.push({
    id: 'canvaspro-workspace-route',
    label: 'CanvasPro opens inside the single Studio route',
    ok: page.url().includes('/dreamy') && page.url().includes('workspace=canvaspro'),
    message: page.url().includes('/dreamy') && page.url().includes('workspace=canvaspro')
      ? undefined
      : `Unexpected CanvasPro URL: ${page.url()}`,
  });
  const studioShellVisible = await page.locator('.dreamy-studio-bar').isVisible().catch(() => false);
  checks.push({
    id: 'canvaspro-studio-shell-hidden',
    label: 'CanvasPro route hides the outer Studio header',
    ok: !studioShellVisible,
    message: studioShellVisible ? 'Outer Dreamy Studio header is still visible on CanvasPro route' : undefined,
  });
  await checkVisible(
    checks,
    page,
    'canvaspro-workspace-panel',
    'CanvasPro workspace panel',
    page.getByTestId('canvaspro-workspace-panel'),
    timeoutMs,
  );
  const iframe = page.getByTestId('canvaspro-iframe');
  await checkVisible(checks, page, 'canvaspro-iframe', 'CanvasPro iframe', iframe, timeoutMs);
  try {
    const iframeSrc = (await iframe.getAttribute('src')) || '';
    checks.push({
      id: 'canvaspro-iframe-entry',
      label: 'CanvasPro iframe uses the local Studio static mount',
      ok: /\/ai-canvaspro\/index\.html/i.test(iframeSrc),
      message: /\/ai-canvaspro\/index\.html/i.test(iframeSrc)
        ? undefined
        : `Unexpected CanvasPro iframe src: ${iframeSrc || 'empty'}`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-iframe-entry',
      label: 'CanvasPro iframe uses the local Studio static mount',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  await checkVisible(
    checks,
    page,
    'canvaspro-bridge-status',
    'CanvasPro bridge status chip',
    page.getByTestId('canvaspro-bridge-status'),
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-cli-auth-status',
    'CanvasPro MyShell CLI auth status',
    page.getByTestId('canvaspro-cli-auth-status'),
    timeoutMs,
  );

  await checkCanvasProManagedLayoutGeometry(checks, page, timeoutMs);
  await checkCanvasProQuickCreate(checks, page, timeoutMs);

  await clickVisible(
    checks,
    page,
    'creative-director-workspace-open',
    'Open the supplemental Creative Director workspace',
    page.getByTestId('creative-director-workspace-switch'),
    timeoutMs,
  );
  const creativeDirectorPanel = page.getByTestId('creative-director-workspace-panel');
  await checkVisible(
    checks,
    page,
    'creative-director-workspace-panel',
    'Creative Director workspace panel',
    creativeDirectorPanel,
    timeoutMs,
  );
  try {
    const labels = ['AI 剧本导演台', '分镜生成', '3D 导演台', 'VR360 全景', '姿势编辑器'];
    const missing = [];
    for (const label of labels) {
      if ((await creativeDirectorPanel.getByText(label, { exact: true }).count()) === 0) missing.push(label);
    }
    checks.push({
      id: 'creative-director-five-tools',
      label: 'Creative Director exposes all five supplemental tools',
      ok: missing.length === 0,
      message: missing.length ? `Missing tools: ${missing.join(', ')}` : undefined,
    });
  } catch (error) {
    checks.push({
      id: 'creative-director-five-tools',
      label: 'Creative Director exposes all five supplemental tools',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  await clickVisible(
    checks,
    page,
    'creative-director-return-canvaspro',
    'Return to CanvasPro without losing the primary workspace',
    page.getByTestId('canvaspro-workspace-switch'),
    timeoutMs,
  );
  await iframe.waitFor({ state: 'visible', timeout: timeoutMs });

  try {
    const runtimeUrl = new URL('/ai-canvaspro-api/api/v2/runtime/info', normalizeFrontendBaseUrl(frontendUrl));
    const response = await page.request.get(runtimeUrl.toString(), { timeout: timeoutMs });
    checks.push({
      id: 'canvaspro-runtime-api',
      label: 'CanvasPro runtime API is reachable through Studio backend proxy',
      ok: response.status() < 500,
      message: response.status() < 500 ? undefined : `Runtime API returned HTTP ${response.status()}`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-runtime-api',
      label: 'CanvasPro runtime API is reachable through Studio backend proxy',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  await checkCanvasProStudioSurfacePolicy(checks, page, timeoutMs);
  await checkCanvasProAuthorSignalPolicy(checks, page, timeoutMs);

  const directProxyError = consoleErrors.find((error) => /ECONNREFUSED.*127\.0\.0\.1:8777|127\.0\.0\.1:8777.*ECONNREFUSED/i.test(error));
  checks.push({
    id: 'canvaspro-no-direct-proxy-error',
    label: 'CanvasPro smoke does not hit the native 8777 API directly from Vite',
    ok: !directProxyError,
    message: directProxyError,
  });
}

async function readCanvasProGraphState(page) {
  const frame = page.frameLocator('[data-testid="canvaspro-iframe"]');
  return await frame.locator('body').evaluate(async () => {
    const moduleUrl = new URL('./src/core/stores/appStore.js', window.location.href).href;
    const { graphStore } = await import(moduleUrl);
    const state = graphStore?.getState?.() || {};
    const nodes = Array.isArray(state.nodes) ? state.nodes : Object.values(state.nodes || {});
    const edges = Array.isArray(state.edges) ? state.edges : Object.values(state.edges || {});
    return {
      edgeCount: edges.length,
      edges: edges.map((edge) => ({
        id: String(edge?.id || ''),
        refSlot: String(edge?.refSlot || ''),
        sourceId: String(edge?.sourceId || edge?.sourceNodeId || edge?.srcId || ''),
        targetId: String(edge?.targetId || edge?.targetNodeId || edge?.dstId || ''),
      })),
      nodeCount: nodes.length,
      nodes: nodes.map((node) => ({
        audioUrl: String(node?.audioUrl || ''),
        content: String(node?.content || ''),
        displayUrl: String(node?.displayUrl || ''),
        fileName: String(node?.fileName || ''),
        height: Number(node?.height) || 0,
        id: String(node?.id || ''),
        imageUrl: String(node?.imageUrl || ''),
        mimeType: String(node?.mimeType || ''),
        name: String(node?.name || ''),
        originalUrl: String(node?.originalUrl || ''),
        outputText: String(node?.outputText || ''),
        parentId: String(node?.parentId || ''),
        prompt: String(node?.prompt || ''),
        src: String(node?.src || ''),
        studioTask:
          node?.studioTask && typeof node.studioTask === 'object'
            ? {
                createdAt: String(node.studioTask.createdAt || ''),
                id: String(node.studioTask.id || ''),
                kind: String(node.studioTask.kind || ''),
                label: String(node.studioTask.label || ''),
                executor:
                  node.studioTask.executor && typeof node.studioTask.executor === 'object'
                    ? {
                        atom: String(node.studioTask.executor.atom || ''),
                        capabilityId: String(node.studioTask.executor.capabilityId || ''),
                        commandPreview: String(node.studioTask.executor.commandPreview || ''),
                        mode: String(node.studioTask.executor.mode || ''),
                        provider: String(node.studioTask.executor.provider || ''),
                      }
                    : null,
                costEstimate:
                  node.studioTask.costEstimate && typeof node.studioTask.costEstimate === 'object'
                    ? {
                        credits: Number(node.studioTask.costEstimate.credits) || 0,
                        label: String(node.studioTask.costEstimate.label || ''),
                        unit: String(node.studioTask.costEstimate.unit || ''),
                      }
                    : null,
                outputs: Array.isArray(node.studioTask.outputs)
                  ? node.studioTask.outputs.map((output, index) => ({
                      id: String(output?.id || ''),
                      index: Number(output?.index) || index + 1,
                      kind: String(output?.kind || ''),
                      label: String(output?.label || ''),
                      materializedAt: String(output?.materializedAt || ''),
                      mediaUrl: String(output?.mediaUrl || output?.url || ''),
                      nodeId: String(output?.nodeId || ''),
                      posterUrl: String(output?.posterUrl || ''),
                      status: String(output?.status || ''),
                    }))
                  : [],
                progress: Number(node.studioTask.progress) || 0,
                settings:
                  node.studioTask.settings && typeof node.studioTask.settings === 'object'
                    ? {
                        aspectRatio: String(node.studioTask.settings.aspectRatio || ''),
                        durationSeconds: Number(node.studioTask.settings.durationSeconds) || 0,
                        mode: String(node.studioTask.settings.mode || ''),
                        model: String(node.studioTask.settings.model || ''),
                        outputCount: Number(node.studioTask.settings.outputCount) || 0,
                        quality: String(node.studioTask.settings.quality || ''),
                        resolution: String(node.studioTask.settings.resolution || ''),
                      }
                    : null,
                sourceInputs: Array.isArray(node.studioTask.sourceInputs)
                  ? node.studioTask.sourceInputs.map((input, index) => ({
                      index: Number(input?.index) || index + 1,
                      inputValue: String(input?.inputValue || ''),
                      kind: String(input?.kind || ''),
                      nodeId: String(input?.nodeId || ''),
                      nodeName: String(input?.nodeName || ''),
                      refSlot: String(input?.refSlot || ''),
                      status: String(input?.status || ''),
                      value: String(input?.value || ''),
                    }))
                  : [],
                sourceNodeIds: Array.isArray(node.studioTask.sourceNodeIds)
                  ? node.studioTask.sourceNodeIds.map(String)
                  : [],
                status: String(node.studioTask.status || ''),
                submittedAt: String(node.studioTask.submittedAt || ''),
                updatedAt: String(node.studioTask.updatedAt || ''),
              }
            : null,
        studioGeneratedOutput:
          node?.studioGeneratedOutput && typeof node.studioGeneratedOutput === 'object'
            ? {
                kind: String(node.studioGeneratedOutput.kind || ''),
                materializedAt: String(node.studioGeneratedOutput.materializedAt || ''),
                outputId: String(node.studioGeneratedOutput.outputId || ''),
                outputIndex: Number(node.studioGeneratedOutput.outputIndex) || 0,
                sourceNodeId: String(node.studioGeneratedOutput.sourceNodeId || ''),
                taskId: String(node.studioGeneratedOutput.taskId || ''),
              }
            : null,
        type: String(node?.type || ''),
        videoUrl: String(node?.videoUrl || ''),
        width: Number(node?.width) || 0,
        x: Number(node?.x) || 0,
        y: Number(node?.y) || 0,
      })),
      selectedNodeIds: Array.isArray(state.selectedNodeIds) ? state.selectedNodeIds.map(String) : [],
    };
  });
}

async function waitForCanvasProCreatedAssistantNote(page, beforeIds, expected, timeoutMs) {
  const started = Date.now();
  let graphState = null;
  while (Date.now() - started < timeoutMs) {
    graphState = await readCanvasProGraphState(page).catch(() => null);
    const createdNode = graphState?.nodes?.find((node) => {
      if (!node.id || beforeIds.has(node.id)) return false;
      if (node.type !== 'source-text') return false;
      const content = `${node.name}\n${node.content}\n${node.outputText}`;
      if (expected.contentIncludes && !content.includes(expected.contentIncludes)) return false;
      return true;
    });
    if (createdNode) {
      return {
        graphState,
        node: createdNode,
        nodeCount: graphState.nodeCount,
        ok: true,
        selected: graphState.selectedNodeIds.includes(createdNode.id),
      };
    }
    await page.waitForTimeout(150);
  }
  return {
    graphState,
    node: null,
    nodeCount: graphState?.nodeCount ?? -1,
    ok: false,
    selected: false,
  };
}

async function setCanvasProSelectedNodeIds(page, nodeIds) {
  const frame = page.frameLocator('[data-testid="canvaspro-iframe"]');
  return await frame.locator('body').evaluate(async (_element, ids) => {
    const moduleUrl = new URL('./src/core/stores/appStore.js', window.location.href).href;
    const { graphStore } = await import(moduleUrl);
    if (typeof graphStore?.setSelectedNodes !== 'function') {
      throw new Error('CanvasPro graphStore.setSelectedNodes is unavailable');
    }
    graphStore.setSelectedNodes(ids.map(String));
    return (graphStore.getState?.().selectedNodeIds || []).map(String);
  }, nodeIds.map(String));
}

async function patchCanvasProGenerationTaskOutput(page, nodeId, patch) {
  const frame = page.frameLocator('[data-testid="canvaspro-iframe"]');
  return await frame.locator('body').evaluate(
    async (_element, args) => {
      const moduleUrl = new URL('./src/core/stores/appStore.js', window.location.href).href;
      const historyUrl = new URL('./src/modules/history.js', window.location.href).href;
      const { graphStore } = await import(moduleUrl);
      const { commit } = await import(historyUrl);
      const state = graphStore?.getState?.() || {};
      const nodes = Array.isArray(state.nodes) ? state.nodes : Object.values(state.nodes || {});
      const node = nodes.find((item) => String(item?.id || '') === String(args.nodeId || ''));
      if (!node?.studioTask) throw new Error('CanvasPro generation task node was not found');
      const updatedAt = new Date().toISOString();
      const outputs = Array.isArray(node.studioTask.outputs) ? node.studioTask.outputs : [];
      const patchedOutputs = outputs.map((output, index) => {
        const sameIndex = (Number(output?.index) || index + 1) === (Number(args.patch.outputIndex || args.patch.index) || 1);
        const sameId = args.patch.outputId && String(output?.id || '') === String(args.patch.outputId);
        if (!sameIndex && !sameId) return output;
        return {
          ...output,
          ...args.patch,
          index: Number(output?.index) || index + 1,
          status: args.patch.status || output?.status || 'done',
          updatedAt,
        };
      });
      const studioTask = {
        ...node.studioTask,
        outputs: patchedOutputs,
        status: args.patch.taskStatus || node.studioTask.status || 'done',
        updatedAt,
      };
      if (typeof graphStore?.updateNodeData === 'function') {
        graphStore.updateNodeData(args.nodeId, { studioTask });
      } else {
        node.studioTask = studioTask;
      }
      commit?.();
      const patched = patchedOutputs.find((output, index) => {
        const sameIndex = (Number(output?.index) || index + 1) === (Number(args.patch.outputIndex || args.patch.index) || 1);
        const sameId = args.patch.outputId && String(output?.id || '') === String(args.patch.outputId);
        return sameIndex || sameId;
      });
      return {
        nodeId: String(args.nodeId || ''),
        output: patched || null,
      };
    },
    { nodeId, patch },
  );
}

async function sendCanvasProBridgeAction(page, action, payload = {}, timeoutMs = 10_000) {
  return await page.evaluate(
    ({ action: actionName, payload: actionPayload, timeoutMs: actionTimeoutMs }) =>
      new Promise((resolve, reject) => {
        const iframe = document.querySelector('[data-testid="canvaspro-iframe"]');
        const target = iframe?.contentWindow;
        if (!target) {
          reject(new Error('CanvasPro iframe is unavailable'));
          return;
        }
        const id = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const timer = window.setTimeout(() => {
          window.removeEventListener('message', onMessage);
          reject(new Error(`CanvasPro bridge action ${actionName} timed out`));
        }, actionTimeoutMs);
        function onMessage(event) {
          const message = event.data || {};
          if (event.source !== target || message.type !== 'aicanvas-studio:response' || message.id !== id) return;
          window.clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          if (message.ok) {
            resolve(message.payload || {});
          } else {
            reject(new Error(message.error || `CanvasPro bridge action ${actionName} failed`));
          }
        }
        window.addEventListener('message', onMessage);
        target.postMessage(
          {
            type: 'aicanvas-studio:request',
            id,
            action: actionName,
            payload: actionPayload || {},
          },
          window.location.origin,
        );
      }),
    { action, payload, timeoutMs },
  );
}

async function waitForCanvasProMaterializedOutput(page, taskNodeId, outputNodeId, timeoutMs) {
  const started = Date.now();
  let graphState = null;
  while (Date.now() - started < timeoutMs) {
    graphState = await readCanvasProGraphState(page).catch(() => null);
    const taskNode = graphState?.nodes?.find((node) => node.id === taskNodeId);
    const outputNode = graphState?.nodes?.find((node) => node.id === outputNodeId);
    const linkedOutput = taskNode?.studioTask?.outputs?.find((output) => output.nodeId === outputNodeId);
    const edge = graphState?.edges?.find(
      (item) =>
        item.sourceId === taskNodeId &&
        item.targetId === outputNodeId &&
        item.refSlot === 'generatedOutput',
    );
    if (
      outputNode?.type === 'source-image' &&
      outputNode.studioGeneratedOutput?.sourceNodeId === taskNodeId &&
      linkedOutput &&
      edge
    ) {
      return {
        edge,
        graphState,
        ok: true,
        output: linkedOutput,
        outputNode,
        taskNode,
      };
    }
    await page.waitForTimeout(150);
  }
  return {
    edge: null,
    graphState,
    ok: false,
    output: null,
    outputNode: graphState?.nodes?.find((node) => node.id === outputNodeId) || null,
    taskNode: graphState?.nodes?.find((node) => node.id === taskNodeId) || null,
  };
}

async function waitForCanvasProCreatedSelectedFlow(page, beforeIds, expected, timeoutMs) {
  const started = Date.now();
  let graphState = null;
  while (Date.now() - started < timeoutMs) {
    graphState = await readCanvasProGraphState(page).catch(() => null);
    const createdNodes = graphState?.nodes?.filter((node) => node.id && !beforeIds.has(node.id)) || [];
    const groupNode = createdNodes.find((node) => node.type === 'group');
    const sourceNode = graphState?.nodes?.find(
      (node) => node.id === expected.sourceNodeId && (!groupNode || node.parentId === groupNode.id),
    );
    const videoNode = groupNode
      ? createdNodes.find(
          (node) =>
            node.type === 'ai-video' &&
            node.parentId === groupNode.id &&
            (expected.prompt == null || node.prompt === expected.prompt),
        )
      : null;
    const edge =
      sourceNode && videoNode
        ? graphState?.edges?.find(
            (item) =>
              item.sourceId === sourceNode.id &&
              item.targetId === videoNode.id &&
              item.refSlot === expected.refSlot,
          )
        : null;
    if (groupNode && sourceNode && videoNode && edge) {
      return {
        edge,
        graphState,
        groupNode,
        nodeCount: graphState.nodeCount,
        ok: true,
        selected: graphState.selectedNodeIds.includes(groupNode.id),
        sourceNode,
        videoNode,
      };
    }
    await page.waitForTimeout(150);
  }
  return {
    edge: null,
    graphState,
    groupNode: null,
    nodeCount: graphState?.nodeCount ?? -1,
    ok: false,
    selected: false,
    sourceNode: null,
    videoNode: null,
  };
}

async function waitForCanvasProCreatedFlow(page, beforeIds, expected, timeoutMs) {
  const started = Date.now();
  let graphState = null;
  while (Date.now() - started < timeoutMs) {
    graphState = await readCanvasProGraphState(page).catch(() => null);
    const createdNodes = graphState?.nodes?.filter((node) => node.id && !beforeIds.has(node.id)) || [];
    const groupNode = createdNodes.find((node) => node.type === 'group');
    const imageNode = groupNode
      ? createdNodes.find(
          (node) =>
            node.type === 'ai-image' &&
            node.parentId === groupNode.id &&
            (expected.prompt == null || node.prompt === expected.prompt),
        )
      : null;
    const videoNode = groupNode
      ? createdNodes.find(
          (node) =>
            node.type === 'ai-video' &&
            node.parentId === groupNode.id &&
            (expected.prompt == null || node.prompt === expected.prompt),
        )
      : null;
    const edge =
      imageNode && videoNode
        ? graphState?.edges?.find(
            (item) =>
              item.sourceId === imageNode.id &&
              item.targetId === videoNode.id &&
              item.refSlot === 'firstFrame',
          )
        : null;
    if (groupNode && imageNode && videoNode && edge) {
      return {
        edge,
        graphState,
        groupNode,
        imageNode,
        nodeCount: graphState.nodeCount,
        ok: true,
        selected: graphState.selectedNodeIds.includes(groupNode.id),
        videoNode,
      };
    }
    await page.waitForTimeout(150);
  }
  return {
    edge: null,
    graphState,
    groupNode: null,
    imageNode: null,
    nodeCount: graphState?.nodeCount ?? -1,
    ok: false,
    selected: false,
    videoNode: null,
  };
}

async function waitForCanvasProCreatedStoryboard(page, beforeIds, expected, timeoutMs) {
  const started = Date.now();
  let graphState = null;
  while (Date.now() - started < timeoutMs) {
    graphState = await readCanvasProGraphState(page).catch(() => null);
    const createdNodes = graphState?.nodes?.filter((node) => node.id && !beforeIds.has(node.id)) || [];
    const groupNode = createdNodes.find((node) => node.type === 'group');
    const imageNodes = groupNode
      ? createdNodes.filter(
          (node) =>
            node.type === 'ai-image' &&
            node.parentId === groupNode.id &&
            (expected.prompt == null || node.prompt.includes(expected.prompt)),
        )
      : [];
    const videoNodes = groupNode
      ? createdNodes.filter(
          (node) =>
            node.type === 'ai-video' &&
            node.parentId === groupNode.id &&
            (expected.prompt == null || node.prompt.includes(expected.prompt)),
        )
      : [];
    const imageIds = new Set(imageNodes.map((node) => node.id));
    const videoIds = new Set(videoNodes.map((node) => node.id));
    const firstFrameEdges =
      graphState?.edges?.filter(
        (edge) =>
          edge.refSlot === 'firstFrame' &&
          imageIds.has(edge.sourceId) &&
          videoIds.has(edge.targetId),
      ) || [];
    const continuityEdges =
      graphState?.edges?.filter(
        (edge) =>
          edge.refSlot === 'sourceVideo' &&
          videoIds.has(edge.sourceId) &&
          videoIds.has(edge.targetId),
      ) || [];
    if (groupNode && imageNodes.length === 3 && videoNodes.length === 3 && firstFrameEdges.length >= 3) {
      return {
        continuityEdges,
        firstFrameEdges,
        graphState,
        groupNode,
        imageNodes,
        nodeCount: graphState.nodeCount,
        ok: true,
        selected: graphState.selectedNodeIds.includes(groupNode.id),
        videoNodes,
      };
    }
    await page.waitForTimeout(150);
  }
  return {
    continuityEdges: [],
    firstFrameEdges: [],
    graphState,
    groupNode: null,
    imageNodes: [],
    nodeCount: graphState?.nodeCount ?? -1,
    ok: false,
    selected: false,
    videoNodes: [],
  };
}

async function waitForCanvasProCreatedVariants(page, beforeIds, expected, timeoutMs) {
  const started = Date.now();
  let graphState = null;
  while (Date.now() - started < timeoutMs) {
    graphState = await readCanvasProGraphState(page).catch(() => null);
    const createdNodes = graphState?.nodes?.filter((node) => node.id && !beforeIds.has(node.id)) || [];
    const groupNode = createdNodes.find((node) => node.type === 'group');
    const sourceNode = graphState?.nodes?.find(
      (node) => node.id === expected.sourceNodeId && (!groupNode || node.parentId === groupNode.id),
    );
    const variantNodes = groupNode
      ? createdNodes.filter(
          (node) =>
            node.type === expected.outputType &&
            node.parentId === groupNode.id &&
            (expected.prompt == null || node.prompt.includes(expected.prompt)),
        )
      : [];
    const variantIds = new Set(variantNodes.map((node) => node.id));
    const edges =
      graphState?.edges?.filter(
        (edge) =>
          edge.refSlot === expected.refSlot &&
          edge.sourceId === expected.sourceNodeId &&
          variantIds.has(edge.targetId),
      ) || [];
    if (groupNode && sourceNode && variantNodes.length === 3 && edges.length >= 3) {
      return {
        edges,
        graphState,
        groupNode,
        nodeCount: graphState.nodeCount,
        ok: true,
        selected: graphState.selectedNodeIds.includes(groupNode.id),
        sourceNode,
        variantNodes,
      };
    }
    await page.waitForTimeout(150);
  }
  return {
    edges: [],
    graphState,
    groupNode: null,
    nodeCount: graphState?.nodeCount ?? -1,
    ok: false,
    selected: false,
    sourceNode: null,
    variantNodes: [],
  };
}

async function waitForCanvasProOrganizedLayout(page, beforeState, timeoutMs) {
  const started = Date.now();
  const beforePositions = new Map(
    (beforeState?.nodes || []).map((node) => [node.id, { parentId: node.parentId, x: node.x, y: node.y }]),
  );
  let graphState = null;
  while (Date.now() - started < timeoutMs) {
    graphState = await readCanvasProGraphState(page).catch(() => null);
    const movedNodes =
      graphState?.nodes?.filter((node) => {
        const before = beforePositions.get(node.id);
        if (!before) return false;
        if (before.parentId !== node.parentId) return true;
        return Math.abs((before.x || 0) - (node.x || 0)) > 0.5 || Math.abs((before.y || 0) - (node.y || 0)) > 0.5;
      }) || [];
    if (movedNodes.length > 0) {
      return {
        graphState,
        movedNodes,
        ok: true,
        selected: (graphState.selectedNodeIds || []).length > 0,
      };
    }
    await page.waitForTimeout(150);
  }
  return {
    graphState,
    movedNodes: [],
    ok: false,
    selected: Boolean(graphState?.selectedNodeIds?.length),
  };
}

async function waitForCanvasProCreatedNode(page, beforeIds, expected, timeoutMs) {
  const started = Date.now();
  let graphState = null;
  while (Date.now() - started < timeoutMs) {
    graphState = await readCanvasProGraphState(page).catch(() => null);
    const createdNode = graphState?.nodes?.find((node) => {
      if (!node.id || beforeIds.has(node.id)) return false;
      if (node.type !== expected.type) return false;
      if (expected.prompt != null && node.prompt !== expected.prompt) return false;
      if (expected.fileName != null && node.fileName !== expected.fileName) return false;
      if (expected.mimeType != null && node.mimeType !== expected.mimeType) return false;
      if (
        expected.srcIncludes != null &&
        !`${node.src}\n${node.imageUrl}\n${node.videoUrl}\n${node.audioUrl}\n${node.displayUrl}\n${node.originalUrl}`.includes(
          expected.srcIncludes,
        )
      ) {
        return false;
      }
      if (expected.contentIncludes != null) {
        const content = `${node.content}\n${node.outputText}`;
        if (!content.includes(expected.contentIncludes)) return false;
      }
      return true;
    });
    if (createdNode) {
      return {
        ok: true,
        graphState,
        node: createdNode,
        nodeCount: graphState.nodeCount,
        selected: graphState.selectedNodeIds.includes(createdNode.id),
      };
    }
    await page.waitForTimeout(150);
  }
  return {
    ok: false,
    graphState,
    node: null,
    nodeCount: graphState?.nodeCount ?? -1,
    selected: false,
  };
}

async function waitForCanvasProNodePrompt(page, nodeId, expectedPrompt, timeoutMs) {
  const started = Date.now();
  let graphState = null;
  while (Date.now() - started < timeoutMs) {
    graphState = await readCanvasProGraphState(page).catch(() => null);
    const node = graphState?.nodes?.find((item) => item.id === nodeId);
    if (node?.prompt === expectedPrompt) {
      return {
        graphState,
        node,
        ok: true,
        selected: graphState.selectedNodeIds.includes(nodeId),
      };
    }
    await page.waitForTimeout(150);
  }
  const node = graphState?.nodes?.find((item) => item.id === nodeId) || null;
  return {
    graphState,
    node,
    ok: false,
    selected: Boolean(graphState?.selectedNodeIds?.includes(nodeId)),
  };
}

async function waitForCanvasProNodeTaskSettings(page, nodeId, expectedSettings, timeoutMs) {
  const started = Date.now();
  let graphState = null;
  while (Date.now() - started < timeoutMs) {
    graphState = await readCanvasProGraphState(page).catch(() => null);
    const node = graphState?.nodes?.find((item) => item.id === nodeId);
    const settings = node?.studioTask?.settings || {};
    const matches = Object.entries(expectedSettings).every(([key, value]) => settings[key] === value);
    if (node && matches) {
      return {
        graphState,
        node,
        ok: true,
        settings,
      };
    }
    await page.waitForTimeout(150);
  }
  const node = graphState?.nodes?.find((item) => item.id === nodeId) || null;
  return {
    graphState,
    node,
    ok: false,
    settings: node?.studioTask?.settings || null,
  };
}

async function waitForCanvasProNodeTaskSubmitted(page, nodeId, expectedStatuses, timeoutMs) {
  const statuses = new Set(expectedStatuses);
  const started = Date.now();
  let graphState = null;
  while (Date.now() - started < timeoutMs) {
    graphState = await readCanvasProGraphState(page).catch(() => null);
    const node = graphState?.nodes?.find((item) => item.id === nodeId);
    const task = node?.studioTask || null;
    if (task?.submittedAt && statuses.has(task.status)) {
      return {
        graphState,
        node,
        ok: true,
        task,
      };
    }
    await page.waitForTimeout(150);
  }
  const node = graphState?.nodes?.find((item) => item.id === nodeId) || null;
  return {
    graphState,
    node,
    ok: false,
    task: node?.studioTask || null,
  };
}

async function waitForCanvasProNodeTaskOutputs(page, nodeId, expectedCount, expectedStatuses, timeoutMs) {
  const statuses = new Set(expectedStatuses);
  const started = Date.now();
  let graphState = null;
  while (Date.now() - started < timeoutMs) {
    graphState = await readCanvasProGraphState(page).catch(() => null);
    const node = graphState?.nodes?.find((item) => item.id === nodeId);
    const outputs = Array.isArray(node?.studioTask?.outputs) ? node.studioTask.outputs : [];
    if (outputs.length === expectedCount && outputs.every((output) => statuses.has(output.status))) {
      return {
        graphState,
        node,
        ok: true,
        outputs,
      };
    }
    await page.waitForTimeout(150);
  }
  const node = graphState?.nodes?.find((item) => item.id === nodeId) || null;
  return {
    graphState,
    node,
    ok: false,
    outputs: Array.isArray(node?.studioTask?.outputs) ? node.studioTask.outputs : [],
  };
}

async function waitForControlEnabled(page, locator, timeoutMs) {
  const started = Date.now();
  await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
  while (Date.now() - started < timeoutMs) {
    if (await locator.first().isEnabled().catch(() => false)) return;
    await page.waitForTimeout(100);
  }
  throw new Error('Control did not become enabled');
}

async function checkCanvasProQuickCreate(checks, page, timeoutMs) {
  const quickCreate = page.getByTestId('canvaspro-quick-create');
  const promptInput = page.getByTestId('canvaspro-quick-create-prompt');
  const addMenuTrigger = page.getByTestId('canvaspro-add-menu-trigger');
  const addMenu = page.getByTestId('canvaspro-add-menu');
  const addMenuText = page.getByTestId('canvaspro-add-menu-text');
  const addMenuImage = page.getByTestId('canvaspro-add-menu-image');
  const addMenuVideo = page.getByTestId('canvaspro-add-menu-video');
  const addMenuAudio = page.getByTestId('canvaspro-add-menu-audio');
  const addMenuWorld = page.getByTestId('canvaspro-add-menu-world');
  const addMenuPlaylist = page.getByTestId('canvaspro-add-menu-playlist');
  const addMenuImageEditor = page.getByTestId('canvaspro-add-menu-image-editor');
  const addMenuUpload = page.getByTestId('canvaspro-add-menu-upload');
  const mediaUploadInput = page.getByTestId('canvaspro-media-upload-input');
  const assistantActions = page.getByTestId('canvaspro-assistant-actions');
  const assistantSummaryButton = page.getByTestId('canvaspro-assistant-summary');
  const assistantReferencesButton = page.getByTestId('canvaspro-assistant-references');
  const assistantGapsButton = page.getByTestId('canvaspro-assistant-gaps');
  const organizeLayoutButton = page.getByTestId('canvaspro-organize-layout');
  const contextAssistant = page.getByTestId('canvaspro-context-assistant');
  const cliAuthCard = page.getByTestId('canvaspro-cli-auth-card');
  const contextAssistantPrompt = page.getByTestId('canvaspro-context-assistant-prompt');
  const contextAssistantSuggestions = page.getByTestId('canvaspro-context-assistant-suggestions');
  const contextAssistantSuggestionNext = page.getByTestId('canvaspro-context-assistant-suggestion-next');
  const contextAssistantSuggestionReferences = page.getByTestId('canvaspro-context-assistant-suggestion-references');
  const contextAssistantSuggestionDirections = page.getByTestId('canvaspro-context-assistant-suggestion-directions');
  const contextAssistantMode = page.getByTestId('canvaspro-context-assistant-mode');
  const contextAssistantRunButton = page.getByTestId('canvaspro-context-assistant-run');
  const contextAssistantExecution = page.getByTestId('canvaspro-context-assistant-execution');
  const contextAssistantExecutionStep = page.getByTestId('canvaspro-context-assistant-execution-step');
  const selectedActionStrip = page.getByTestId('canvaspro-selected-action-strip');
  const selectedActionImage = page.getByTestId('canvaspro-selected-action-image');
  const selectedActionVideo = page.getByTestId('canvaspro-selected-action-video');
  const selectedActionReference = page.getByTestId('canvaspro-selected-action-reference');
  const selectedActionVariants = page.getByTestId('canvaspro-selected-action-variants');
  const selectedActionFlow = page.getByTestId('canvaspro-selected-action-flow');
  const contextAssistantImageButton = page.getByTestId('canvaspro-context-assistant-image');
  const contextAssistantVideoButton = page.getByTestId('canvaspro-context-assistant-video');
  const contextAssistantReferenceButton = page.getByTestId('canvaspro-context-assistant-reference');
  const contextAssistantVariantsButton = page.getByTestId('canvaspro-context-assistant-variants');
  const contextAssistantOrganizeButton = page.getByTestId('canvaspro-context-assistant-organize');
  const generationQueue = page.getByTestId('canvaspro-generation-queue');
  const generationAutoSync = page.getByTestId('canvaspro-generation-auto-sync');
  const generationQueueItem = page.getByTestId('canvaspro-generation-queue-item');
  const generationTaskAspectRatio = page.getByTestId('canvaspro-generation-task-aspect-ratio');
  const generationTaskAtom = page.getByTestId('canvaspro-generation-task-atom');
  const generationTaskAtomCommand = page.getByTestId('canvaspro-generation-task-atom-command');
  const generationTaskAutoSync = page.getByTestId('canvaspro-generation-task-auto-sync');
  const generationTaskCost = page.getByTestId('canvaspro-generation-task-cost');
  const generationTaskDetail = page.getByTestId('canvaspro-generation-task-detail');
  const generationTaskDuration = page.getByTestId('canvaspro-generation-task-duration');
  const generationTaskFocusButton = page.getByTestId('canvaspro-generation-task-focus');
  const generationTaskMode = page.getByTestId('canvaspro-generation-task-mode');
  const generationTaskModel = page.getByTestId('canvaspro-generation-task-model');
  const generationTaskOutputSlot = page.getByTestId('canvaspro-generation-task-output-slot');
  const generationTaskOutputSlots = page.getByTestId('canvaspro-generation-task-output-slots');
  const generationTaskOutputContinueVideo = page.getByTestId('canvaspro-generation-task-output-continue-video');
  const generationTaskOutputContinueVariants = page.getByTestId('canvaspro-generation-task-output-continue-variants');
  const generationTaskOutputContinueReference = page.getByTestId('canvaspro-generation-task-output-continue-reference');
  const generationTaskOutputRerun = page.getByTestId('canvaspro-generation-task-output-rerun');
  const generationTaskOutputRerunModel = page.getByTestId('canvaspro-generation-task-output-rerun-model');
  const generationTaskOutputCount = page.getByTestId('canvaspro-generation-task-output-count');
  const generationTaskParamSummary = page.getByTestId('canvaspro-generation-task-param-summary');
  const generationTaskPrompt = page.getByTestId('canvaspro-generation-task-prompt');
  const generationTaskQuality = page.getByTestId('canvaspro-generation-task-quality');
  const generationTaskResolution = page.getByTestId('canvaspro-generation-task-resolution');
  const generationTaskRerunButton = page.getByTestId('canvaspro-generation-task-rerun');
  const generationTaskRerunModelButton = page.getByTestId('canvaspro-generation-task-rerun-model');
  const generationTaskSaveButton = page.getByTestId('canvaspro-generation-task-save');
  const generationTaskSyncButton = page.getByTestId('canvaspro-generation-task-sync');
  const generationTaskSubmitButton = page.getByTestId('canvaspro-generation-task-submit');
  const noteButton = page.getByTestId('canvaspro-create-note');
  const referenceFromSelectionButton = page.getByTestId('canvaspro-create-reference-from-selection');
  const imageButton = page.getByTestId('canvaspro-create-image');
  const imageFromSelectionButton = page.getByTestId('canvaspro-create-image-from-selection');
  const videoButton = page.getByTestId('canvaspro-create-video');
  const videoFromSelectionButton = page.getByTestId('canvaspro-create-video-from-selection');
  const flowButton = page.getByTestId('canvaspro-create-flow');
  const storyboardButton = page.getByTestId('canvaspro-create-storyboard');
  const variantsFromSelectionButton = page.getByTestId('canvaspro-create-variants-from-selection');
  const selectedFlowButton = page.getByTestId('canvaspro-create-flow-from-selection');
  let seededImageNodeId = '';
  let materializedSourceImageNodeId = '';
  let selectedReferenceImageNodeId = '';
  let selectedVideoNodeId = '';
  let selectedFlowVideoNodeId = '';

  await checkVisible(checks, page, 'canvaspro-quick-create', 'CanvasPro quick-create dock', quickCreate, timeoutMs);
  await checkVisible(checks, page, 'canvaspro-quick-create-prompt', 'CanvasPro quick-create prompt input', promptInput, timeoutMs);
  await clickEnabled(
    checks,
    page,
    'canvaspro-add-menu-trigger',
    'CanvasPro Tapnow-style grouped add menu trigger',
    addMenuTrigger,
    timeoutMs,
  );
  await checkVisible(checks, page, 'canvaspro-add-menu', 'CanvasPro Tapnow-style grouped add menu', addMenu, timeoutMs);
  await checkVisible(checks, page, 'canvaspro-add-menu-text', 'CanvasPro add menu text node action', addMenuText, timeoutMs);
  await checkVisible(checks, page, 'canvaspro-add-menu-image', 'CanvasPro add menu image node action', addMenuImage, timeoutMs);
  await checkVisible(checks, page, 'canvaspro-add-menu-video', 'CanvasPro add menu video node action', addMenuVideo, timeoutMs);
  await checkVisible(checks, page, 'canvaspro-add-menu-audio', 'CanvasPro add menu audio draft action', addMenuAudio, timeoutMs);
  await checkVisible(checks, page, 'canvaspro-add-menu-world', 'CanvasPro add menu 3D world draft action', addMenuWorld, timeoutMs);
  await checkVisible(
    checks,
    page,
    'canvaspro-add-menu-playlist',
    'CanvasPro add menu playlist draft action',
    addMenuPlaylist,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-add-menu-image-editor',
    'CanvasPro add menu image editor draft action',
    addMenuImageEditor,
    timeoutMs,
  );
  await checkVisible(checks, page, 'canvaspro-add-menu-upload', 'CanvasPro add menu upload action', addMenuUpload, timeoutMs);
  try {
    await waitForControlEnabled(page, addMenuAudio, timeoutMs);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await addMenuAudio.click({ timeout: timeoutMs });
    const result = await waitForCanvasProCreatedNode(
      page,
      beforeIds,
      { type: 'source-text', contentIncludes: '# 音频' },
      Math.min(timeoutMs, 10_000),
    );
    checks.push({
      id: 'canvaspro-add-menu-audio-node',
      label: 'CanvasPro add menu creates an audio atomic capability draft node',
      ok: result.ok && result.selected,
      message: result.ok
        ? result.selected
          ? undefined
          : `Created audio draft node ${result.node?.id || 'unknown'} was not selected`
        : `Expected a new source-text node containing "# 音频", found ${result.nodeCount} nodes`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-add-menu-audio-node',
      label: 'CanvasPro add menu creates an audio atomic capability draft node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const fixtureName = 'canvaspro-smoke-upload.png';
    const fixturePath = path.join('/tmp', fixtureName);
    await fs.writeFile(
      fixturePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await mediaUploadInput.setInputFiles(fixturePath);
    const result = await waitForCanvasProCreatedNode(
      page,
      beforeIds,
      { type: 'source-image', fileName: fixtureName, mimeType: 'image/png', srcIncludes: 'blob:' },
      Math.min(timeoutMs, 10_000),
    );
    checks.push({
      id: 'canvaspro-add-menu-upload-node',
      label: 'CanvasPro media upload creates a source image resource node',
      ok: result.ok && result.selected,
      message: result.ok
        ? result.selected
          ? undefined
          : `Uploaded image node ${result.node?.id || 'unknown'} was not selected`
        : `Expected a new source-image node for ${fixtureName}, found ${result.nodeCount} nodes`,
    });
    await fs.unlink(fixturePath).catch(() => undefined);
  } catch (error) {
    checks.push({
      id: 'canvaspro-add-menu-upload-node',
      label: 'CanvasPro media upload creates a source image resource node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  await checkVisible(checks, page, 'canvaspro-assistant-actions', 'CanvasPro assistant action dock', assistantActions, timeoutMs);
  await checkVisible(checks, page, 'canvaspro-assistant-summary', 'CanvasPro assistant summary action', assistantSummaryButton, timeoutMs);
  await checkVisible(
    checks,
    page,
    'canvaspro-assistant-references',
    'CanvasPro assistant references action',
    assistantReferencesButton,
    timeoutMs,
  );
  await checkVisible(checks, page, 'canvaspro-assistant-gaps', 'CanvasPro assistant gaps action', assistantGapsButton, timeoutMs);
  await checkVisible(checks, page, 'canvaspro-organize-layout', 'CanvasPro organize layout action', organizeLayoutButton, timeoutMs);
  await checkVisible(checks, page, 'canvaspro-context-assistant', 'CanvasPro right-side context assistant', contextAssistant, timeoutMs);
  await checkVisible(checks, page, 'canvaspro-cli-auth-card', 'CanvasPro MyShell CLI auth card', cliAuthCard, timeoutMs);
  await checkVisible(
    checks,
    page,
    'canvaspro-context-assistant-prompt',
    'CanvasPro context assistant prompt',
    contextAssistantPrompt,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-context-assistant-suggestions',
    'CanvasPro Tapnow-style assistant suggestions',
    contextAssistantSuggestions,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-context-assistant-suggestion-next',
    'CanvasPro assistant next-step suggestion',
    contextAssistantSuggestionNext,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-context-assistant-suggestion-references',
    'CanvasPro assistant reference suggestion',
    contextAssistantSuggestionReferences,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-context-assistant-suggestion-directions',
    'CanvasPro assistant three-directions suggestion',
    contextAssistantSuggestionDirections,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-context-assistant-mode',
    'CanvasPro assistant execution mode selector',
    contextAssistantMode,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-context-assistant-run',
    'CanvasPro assistant exposes a command-to-canvas run action',
    contextAssistantRunButton,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-selected-action-strip',
    'CanvasPro selected-context follow-up action strip',
    selectedActionStrip,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-selected-action-image',
    'CanvasPro selected-context image follow-up action',
    selectedActionImage,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-selected-action-video',
    'CanvasPro selected-context video follow-up action',
    selectedActionVideo,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-selected-action-reference',
    'CanvasPro selected-context reference follow-up action',
    selectedActionReference,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-selected-action-variants',
    'CanvasPro selected-context variants follow-up action',
    selectedActionVariants,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-selected-action-flow',
    'CanvasPro selected-context flow follow-up action',
    selectedActionFlow,
    timeoutMs,
  );
  try {
    await waitForControlEnabled(page, contextAssistantSuggestionNext, timeoutMs);
    const prompt = '需要更电影感的图片到视频链路';
    await contextAssistantMode.selectOption('auto');
    await contextAssistantPrompt.fill(prompt);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await contextAssistantSuggestionNext.click({ timeout: timeoutMs });
    const result = await waitForCanvasProCreatedNode(
      page,
      beforeIds,
      { type: 'source-text', contentIncludes: '# 下一步做什么' },
      Math.min(timeoutMs, 10_000),
    );
    const content = String(result.node?.content || result.node?.outputText || '');
    checks.push({
      id: 'canvaspro-context-assistant-next-note',
      label: 'CanvasPro assistant next-step chip creates a context note with execution mode and prompt',
      ok: result.ok && content.includes('执行方式：自动执行') && content.includes(`需求：${prompt}`),
      message: result.ok
        ? content.includes('执行方式：自动执行') && content.includes(`需求：${prompt}`)
          ? undefined
          : `Expected next-step note to include execution mode and prompt, got ${content}`
        : `Expected a new source-text node containing "# 下一步做什么", found ${result.nodeCount} nodes`,
    });
    await contextAssistantMode.selectOption('manual');
  } catch (error) {
    checks.push({
      id: 'canvaspro-context-assistant-next-note',
      label: 'CanvasPro assistant next-step chip creates a context note with execution mode and prompt',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  await checkVisible(
    checks,
    page,
    'canvaspro-context-assistant-image',
    'CanvasPro context assistant image action',
    contextAssistantImageButton,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-context-assistant-video',
    'CanvasPro context assistant selected video action',
    contextAssistantVideoButton,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-context-assistant-reference',
    'CanvasPro context assistant selected reference action',
    contextAssistantReferenceButton,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-context-assistant-variants',
    'CanvasPro context assistant selected variants action',
    contextAssistantVariantsButton,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-context-assistant-organize',
    'CanvasPro context assistant organize action',
    contextAssistantOrganizeButton,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-generation-queue',
    'CanvasPro context assistant generation queue',
    generationQueue,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-generation-auto-sync',
    'CanvasPro generation queue shows automatic result sync status',
    generationAutoSync,
    timeoutMs,
  );
  await checkVisible(checks, page, 'canvaspro-create-note', 'CanvasPro quick-create text reference button', noteButton, timeoutMs);
  await checkVisible(
    checks,
    page,
    'canvaspro-create-reference-from-selection',
    'CanvasPro quick-create reference-from-selection button',
    referenceFromSelectionButton,
    timeoutMs,
  );
  await checkVisible(checks, page, 'canvaspro-create-image', 'CanvasPro quick-create image button', imageButton, timeoutMs);
  await checkVisible(
    checks,
    page,
    'canvaspro-create-image-from-selection',
    'CanvasPro quick-create image-from-selection button',
    imageFromSelectionButton,
    timeoutMs,
  );
  await checkVisible(checks, page, 'canvaspro-create-video', 'CanvasPro quick-create video button', videoButton, timeoutMs);
  await checkVisible(
    checks,
    page,
    'canvaspro-create-video-from-selection',
    'CanvasPro quick-create video-from-selection button',
    videoFromSelectionButton,
    timeoutMs,
  );
  await checkVisible(checks, page, 'canvaspro-create-flow', 'CanvasPro quick-create image-to-video flow button', flowButton, timeoutMs);
  await checkVisible(
    checks,
    page,
    'canvaspro-create-storyboard',
    'CanvasPro quick-create storyboard workflow button',
    storyboardButton,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-create-variants-from-selection',
    'CanvasPro quick-create selected variants button',
    variantsFromSelectionButton,
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-create-flow-from-selection',
    'CanvasPro quick-create flow-from-selection button',
    selectedFlowButton,
    timeoutMs,
  );
  await promptInput.fill('/');
  await checkVisible(
    checks,
    page,
    'canvaspro-slash-command-menu',
    'CanvasPro slash command menu',
    page.getByTestId('canvaspro-slash-command-menu'),
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-slash-command-video',
    'CanvasPro slash command video option',
    page.getByTestId('canvaspro-slash-command-video'),
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-slash-command-note',
    'CanvasPro slash command text note option',
    page.getByTestId('canvaspro-slash-command-note'),
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-slash-command-cite',
    'CanvasPro slash command selected reference option',
    page.getByTestId('canvaspro-slash-command-cite'),
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-slash-command-animate',
    'CanvasPro slash command animate option',
    page.getByTestId('canvaspro-slash-command-animate'),
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-slash-command-flow',
    'CanvasPro slash command flow option',
    page.getByTestId('canvaspro-slash-command-flow'),
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-slash-command-storyboard',
    'CanvasPro slash command storyboard option',
    page.getByTestId('canvaspro-slash-command-storyboard'),
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-slash-command-variants',
    'CanvasPro slash command variants option',
    page.getByTestId('canvaspro-slash-command-variants'),
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-slash-command-organize',
    'CanvasPro slash command organize option',
    page.getByTestId('canvaspro-slash-command-organize'),
    timeoutMs,
  );
  await checkVisible(
    checks,
    page,
    'canvaspro-slash-command-ref',
    'CanvasPro slash command selected reference flow option',
    page.getByTestId('canvaspro-slash-command-ref'),
    timeoutMs,
  );

  try {
    await waitForControlEnabled(page, imageButton, timeoutMs);
    const prompt = 'cinematic neon rain portrait';
    await promptInput.fill(prompt);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await imageButton.click({ timeout: timeoutMs });
    const result = await waitForCanvasProCreatedNode(
      page,
      beforeIds,
      { type: 'ai-image', prompt },
      Math.min(timeoutMs, 10_000),
    );
    if (result.ok) seededImageNodeId = result.node?.id || '';
    checks.push({
      id: 'canvaspro-quick-create-image-node',
      label: 'CanvasPro quick-create image button adds a prompted image node',
      ok: result.ok && result.selected,
      message: result.ok
        ? result.selected
          ? undefined
          : `Created image node ${result.node?.id || 'unknown'} was not selected`
        : `Expected a new ai-image node with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
    const task = result.node?.studioTask;
    const taskOk =
      result.ok &&
      Boolean(task?.id && task?.kind === 'image' && task?.status && task?.createdAt) &&
      task?.settings?.aspectRatio === '9:16' &&
      task?.settings?.model === 'doubao-seedream-5.0-lite' &&
      task?.settings?.resolution === '2K' &&
      task?.costEstimate?.credits === 5;
    checks.push({
      id: 'canvaspro-generation-task-metadata',
      label: 'CanvasPro generated media nodes carry Studio task metadata',
      ok: taskOk,
      message:
        taskOk
          ? undefined
          : result.ok && task
          ? `Expected Tapnow-style image studioTask metadata, got ${JSON.stringify(task)}`
          : `Expected a generated image node with studioTask metadata, found ${result.nodeCount} nodes`,
    });
    const preparedTaskResult = result.ok
      ? await waitForCanvasProNodeTaskSubmitted(
          page,
          result.node?.id || '',
          ['ready'],
          Math.min(timeoutMs, 10_000),
        )
      : { ok: false, task: null };
    const preparedTask = preparedTaskResult.task || {};
    const preparedExecutor = preparedTask.executor || {};
    const imageAutoPrepared =
      preparedTaskResult.ok &&
      preparedExecutor.provider === 'myshell-art-cli' &&
      preparedExecutor.atom === 'dreamy-generate' &&
      Array.isArray(preparedTask.outputs) &&
      preparedTask.outputs.length >= 1;
    checks.push({
      id: 'canvaspro-quick-create-image-autoprepare',
      label: 'CanvasPro quick-created image node is immediately prepared as a MyShell Art atom task',
      ok: imageAutoPrepared,
      message: imageAutoPrepared
        ? undefined
        : `Expected quick image to auto-prepare ready myshell-art-cli task with output slots, got ${JSON.stringify(preparedTask)}`,
    });
    try {
      await waitForControlEnabled(page, selectedActionReference, timeoutMs);
      const selectedPrompt = 'selected action strip captures palette and pose notes';
      if (seededImageNodeId) await setCanvasProSelectedNodeIds(page, [seededImageNodeId]);
      await contextAssistantPrompt.fill(selectedPrompt);
      const beforeSelectedActionState = await readCanvasProGraphState(page);
      const beforeSelectedActionIds = new Set(beforeSelectedActionState.nodes.map((node) => node.id));
      await selectedActionReference.click({ timeout: timeoutMs });
      const selectedActionResult = await waitForCanvasProCreatedNode(
        page,
        beforeSelectedActionIds,
        { type: 'source-text', contentIncludes: selectedPrompt },
        Math.min(timeoutMs, 10_000),
      );
      const selectedActionNoteId = selectedActionResult.node?.id || '';
      const selectedActionEdge = selectedActionResult.graphState?.edges?.find(
        (edge) =>
          edge.sourceId === seededImageNodeId &&
          edge.targetId === selectedActionNoteId &&
          edge.refSlot === 'reference',
      );
      checks.push({
        id: 'canvaspro-selected-action-reference-node',
        label: 'CanvasPro selected action strip creates a reference note from selected content',
        ok: Boolean(seededImageNodeId) && selectedActionResult.ok && selectedActionResult.selected,
        message: !seededImageNodeId
          ? 'Expected a seeded image node before testing the selected action strip'
          : selectedActionResult.ok
            ? selectedActionResult.selected
              ? undefined
              : `Created selected action note ${selectedActionNoteId || 'unknown'} was not selected`
            : `Expected a new source-text node containing "${selectedPrompt}", found ${selectedActionResult.nodeCount} nodes`,
      });
      checks.push({
        id: 'canvaspro-selected-action-reference-edge',
        label: 'CanvasPro selected action strip links selected content into the reference note',
        ok: Boolean(selectedActionEdge),
        message: selectedActionEdge
          ? undefined
          : `Expected reference edge ${seededImageNodeId || 'missing-source'} -> ${selectedActionNoteId || 'missing-note'}, found ${selectedActionResult.graphState?.edgeCount ?? -1} edges`,
      });
    } catch (error) {
      checks.push({
        id: 'canvaspro-selected-action-reference-node',
        label: 'CanvasPro selected action strip creates a reference note from selected content',
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
      checks.push({
        id: 'canvaspro-selected-action-reference-edge',
        label: 'CanvasPro selected action strip links selected content into the reference note',
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (result.ok) {
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-queue-item',
        'CanvasPro generation queue lists newly created media tasks',
        generationQueueItem,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-detail',
        'CanvasPro generation queue opens an editable task detail panel',
        generationTaskDetail,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-auto-sync',
        'CanvasPro generation task detail shows automatic result sync status',
        generationTaskAutoSync,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-prompt',
        'CanvasPro generation task detail exposes the prompt editor',
        generationTaskPrompt,
        timeoutMs,
      );
      const paramSummaryText = await generationTaskParamSummary.textContent({ timeout: timeoutMs }).catch(() => '');
      const paramSummaryOk =
        /即梦5\.0 Lite/.test(paramSummaryText || '') &&
        /9:16/.test(paramSummaryText || '') &&
        /2K/.test(paramSummaryText || '') &&
        /约 5 点/.test(paramSummaryText || '');
      checks.push({
        id: 'canvaspro-generation-task-param-summary',
        label: 'CanvasPro generation task detail shows a Tapnow-style parameter summary',
        ok: paramSummaryOk,
        message: paramSummaryOk
          ? undefined
          : `Expected parameter summary with 即梦5.0 Lite · 9:16 · 2K · 约 5 点, got "${paramSummaryText || ''}"`,
      });
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-atom',
        'CanvasPro generation task detail shows the bound atomic capability',
        generationTaskAtom,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-atom-command',
        'CanvasPro generation task detail shows the atomic command preview',
        generationTaskAtomCommand,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-mode',
        'CanvasPro generation task detail exposes generation mode settings',
        generationTaskMode,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-model',
        'CanvasPro generation task detail exposes model settings',
        generationTaskModel,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-quality',
        'CanvasPro generation task detail exposes quality settings',
        generationTaskQuality,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-resolution',
        'CanvasPro generation task detail exposes resolution settings',
        generationTaskResolution,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-aspect-ratio',
        'CanvasPro generation task detail exposes aspect ratio settings',
        generationTaskAspectRatio,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-cost',
        'CanvasPro generation task detail exposes estimated credits',
        generationTaskCost,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-output-count',
        'CanvasPro generation task detail exposes output count settings',
        generationTaskOutputCount,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-duration',
        'CanvasPro generation task detail exposes duration settings',
        generationTaskDuration,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-focus',
        'CanvasPro generation task detail can focus the task node',
        generationTaskFocusButton,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-save',
        'CanvasPro generation task detail can save prompt changes',
        generationTaskSaveButton,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-submit',
        'CanvasPro generation task detail can submit media generation',
        generationTaskSubmitButton,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-sync',
        'CanvasPro generation task detail can sync external generation results',
        generationTaskSyncButton,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-rerun',
        'CanvasPro generation task detail exposes parameter rerun',
        generationTaskRerunButton,
        timeoutMs,
      );
      await checkVisible(
        checks,
        page,
        'canvaspro-generation-task-rerun-model',
        'CanvasPro generation task detail exposes model-switch rerun',
        generationTaskRerunModelButton,
        timeoutMs,
      );
      try {
        const updatedPrompt = `${prompt} with soft rim light`;
        await generationTaskPrompt.fill(updatedPrompt, { timeout: timeoutMs });
        await generationTaskMode.selectOption('reference-to-image', { timeout: timeoutMs });
        await generationTaskModel.selectOption('image-pro', { timeout: timeoutMs });
        await generationTaskQuality.selectOption('high', { timeout: timeoutMs });
        await generationTaskResolution.selectOption('3K', { timeout: timeoutMs });
        await generationTaskAspectRatio.selectOption('21:9', { timeout: timeoutMs });
        await generationTaskOutputCount.fill('3', { timeout: timeoutMs });
        await generationTaskSaveButton.click({ timeout: timeoutMs });
        const promptResult = await waitForCanvasProNodePrompt(
          page,
          result.node?.id || '',
          updatedPrompt,
          Math.min(timeoutMs, 10_000),
        );
        checks.push({
          id: 'canvaspro-generation-task-prompt-update',
          label: 'CanvasPro generation task prompt edits write back to the media node',
          ok: promptResult.ok,
          message: promptResult.ok
            ? undefined
            : `Expected node ${result.node?.id || 'missing-node'} prompt "${updatedPrompt}", got "${promptResult.node?.prompt || ''}"`,
        });
        const settingsResult = await waitForCanvasProNodeTaskSettings(
          page,
          result.node?.id || '',
          {
            aspectRatio: '21:9',
            durationSeconds: 0,
            mode: 'reference-to-image',
            model: 'image-pro',
            outputCount: 3,
            quality: 'high',
            resolution: '3K',
          },
          Math.min(timeoutMs, 10_000),
        );
        checks.push({
          id: 'canvaspro-generation-task-settings-update',
          label: 'CanvasPro generation task settings edits write back to the media node',
          ok: settingsResult.ok,
          message: settingsResult.ok
            ? undefined
            : `Expected task settings mode=reference-to-image model=image-pro quality=high aspectRatio=21:9 resolution=3K outputCount=3, got ${JSON.stringify(settingsResult.settings)}`,
        });
        await waitForControlEnabled(page, generationTaskSubmitButton, Math.min(timeoutMs, 10_000));
        await generationTaskSubmitButton.click({ timeout: timeoutMs });
        const submitResult = await waitForCanvasProNodeTaskSubmitted(
          page,
          result.node?.id || '',
          ['ready', 'queued'],
          Math.min(timeoutMs, 10_000),
        );
        checks.push({
          id: 'canvaspro-generation-task-submit-update',
          label: 'CanvasPro generation task submit writes queue state back to the media node',
          ok: submitResult.ok,
          message: submitResult.ok
            ? undefined
            : `Expected submitted task status ready/queued, got ${JSON.stringify(submitResult.task)}`,
        });
        await checkVisible(
          checks,
          page,
          'canvaspro-generation-task-output-slots',
          'CanvasPro generation task detail shows pending output slots after submit',
          generationTaskOutputSlots,
          timeoutMs,
        );
        await checkVisible(
          checks,
          page,
          'canvaspro-generation-task-output-slot',
          'CanvasPro generation task detail shows individual pending output slots',
          generationTaskOutputSlot,
          timeoutMs,
        );
        await checkVisible(
          checks,
          page,
          'canvaspro-generation-task-output-continue-video',
          'CanvasPro generation output card exposes direct video continuation',
          generationTaskOutputContinueVideo,
          timeoutMs,
        );
        await checkVisible(
          checks,
          page,
          'canvaspro-generation-task-output-continue-variants',
          'CanvasPro generation output card exposes direct variants continuation',
          generationTaskOutputContinueVariants,
          timeoutMs,
        );
        await checkVisible(
          checks,
          page,
          'canvaspro-generation-task-output-continue-reference',
          'CanvasPro generation output card exposes direct reference continuation',
          generationTaskOutputContinueReference,
          timeoutMs,
        );
        await checkVisible(
          checks,
          page,
          'canvaspro-generation-task-output-rerun',
          'CanvasPro generation output card exposes parameter rerun',
          generationTaskOutputRerun,
          timeoutMs,
        );
        await checkVisible(
          checks,
          page,
          'canvaspro-generation-task-output-rerun-model',
          'CanvasPro generation output card exposes model-switch rerun',
          generationTaskOutputRerunModel,
          timeoutMs,
        );
        const outputsResult = await waitForCanvasProNodeTaskOutputs(
          page,
          result.node?.id || '',
          3,
          ['pending', 'waiting_service'],
          Math.min(timeoutMs, 10_000),
        );
        checks.push({
          id: 'canvaspro-generation-task-output-slots-update',
          label: 'CanvasPro generation task submit creates one pending output slot per requested result',
          ok: outputsResult.ok,
          message: outputsResult.ok
            ? undefined
            : `Expected 3 pending output slots, got ${JSON.stringify(outputsResult.outputs)}`,
        });
        if (outputsResult.ok) {
          const syncedMediaUrl =
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAADlH1zKAAAADUlEQVR42mP8z8BQDwAFgwJ/lvp0ZQAAAABJRU5ErkJggg==';
          const syncedPatch = await patchCanvasProGenerationTaskOutput(page, result.node?.id || '', {
            index: 2,
            mediaUrl: syncedMediaUrl,
            outputIndex: 2,
            status: 'done',
          });
          const syncResult = await sendCanvasProBridgeAction(
            page,
            'syncGenerationTask',
            {
              nodeId: result.node?.id || '',
              taskId: result.node?.studioTask?.id || '',
            },
            Math.min(timeoutMs, 10_000),
          );
          const syncedMaterializedOutput = (syncResult.materializedOutputs || []).find(
            (item) => item.outputId === syncedPatch.output?.id,
          );
          const syncedOutputNodeId = String(syncedMaterializedOutput?.outputNodeId || '');
          const syncedMaterializedResult = await waitForCanvasProMaterializedOutput(
            page,
            result.node?.id || '',
            syncedOutputNodeId,
            Math.min(timeoutMs, 10_000),
          );
          checks.push({
            id: 'canvaspro-generation-task-sync-auto-materialize',
            label: 'CanvasPro generation task sync backfills completed outputs onto the canvas',
            ok:
              Boolean(syncResult.materializedOutputs?.length) &&
              syncedMaterializedResult.ok &&
              syncedMaterializedResult.output?.id === syncedPatch.output?.id &&
              syncedMaterializedResult.outputNode?.displayUrl === syncedMediaUrl,
            message:
              Boolean(syncResult.materializedOutputs?.length) &&
              syncedMaterializedResult.ok &&
              syncedMaterializedResult.output?.id === syncedPatch.output?.id &&
              syncedMaterializedResult.outputNode?.displayUrl === syncedMediaUrl
                ? undefined
                : `Expected sync to materialize completed output ${syncedPatch.output?.id || 'missing-output'}, got ${JSON.stringify({
                    action: syncResult,
                    node: syncedMaterializedResult.outputNode,
                    output: syncedMaterializedResult.output,
                  })}`,
          });
          const materializedMediaUrl =
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
          const patched = await patchCanvasProGenerationTaskOutput(page, result.node?.id || '', {
            index: 1,
            mediaUrl: materializedMediaUrl,
            outputIndex: 1,
            status: 'done',
          });
          const materializeResult = await sendCanvasProBridgeAction(
            page,
            'materializeGenerationOutput',
            {
              nodeId: result.node?.id || '',
              outputId: patched.output?.id || '',
              outputIndex: 1,
            },
            Math.min(timeoutMs, 10_000),
          );
          const materializedResult = await waitForCanvasProMaterializedOutput(
            page,
            result.node?.id || '',
            String(materializeResult.outputNodeId || ''),
            Math.min(timeoutMs, 10_000),
          );
          if (materializedResult.ok) materializedSourceImageNodeId = materializedResult.outputNode?.id || '';
          checks.push({
            id: 'canvaspro-generation-task-output-materialize',
            label: 'CanvasPro generation task completed output can become a reusable source image node',
            ok:
              Boolean(materializeResult.created) &&
              materializedResult.ok &&
              materializedResult.outputNode?.displayUrl === materializedMediaUrl,
            message:
              Boolean(materializeResult.created) &&
              materializedResult.ok &&
              materializedResult.outputNode?.displayUrl === materializedMediaUrl
                ? undefined
                : `Expected materialized source-image node and generatedOutput edge, got ${JSON.stringify({
                    action: materializeResult,
                    node: materializedResult.outputNode,
                    output: materializedResult.output,
                    edge: materializedResult.edge,
                  })}`,
          });
          const nodeCountAfterMaterialize = materializedResult.graphState?.nodeCount || 0;
          const idempotentResult = await sendCanvasProBridgeAction(
            page,
            'materializeGenerationOutput',
            {
              nodeId: result.node?.id || '',
              outputId: patched.output?.id || '',
              outputIndex: 1,
            },
            Math.min(timeoutMs, 10_000),
          );
          const graphAfterIdempotent = await readCanvasProGraphState(page);
          checks.push({
            id: 'canvaspro-generation-task-output-materialize-idempotent',
            label: 'CanvasPro generation output materialization is idempotent',
            ok:
              idempotentResult.created === false &&
              idempotentResult.outputNodeId === materializeResult.outputNodeId &&
              graphAfterIdempotent.nodeCount === nodeCountAfterMaterialize,
            message:
              idempotentResult.created === false &&
              idempotentResult.outputNodeId === materializeResult.outputNodeId &&
              graphAfterIdempotent.nodeCount === nodeCountAfterMaterialize
                ? undefined
                : `Expected existing output node ${materializeResult.outputNodeId}, got ${JSON.stringify({
                    idempotentResult,
                    nodeCountAfterMaterialize,
                    nodeCountAfterRetry: graphAfterIdempotent.nodeCount,
                  })}`,
          });
          const continuePrompt = 'continue generated output into a tighter motion test';
          const beforeContinueState = await readCanvasProGraphState(page);
          const beforeContinueIds = new Set(beforeContinueState.nodes.map((node) => node.id));
          const continueResult = await sendCanvasProBridgeAction(
            page,
            'continueGenerationOutput',
            {
              action: 'video',
              nodeId: result.node?.id || '',
              outputId: patched.output?.id || '',
              outputIndex: 1,
              prompt: continuePrompt,
            },
            Math.min(timeoutMs, 10_000),
          );
          const continuedVideo = await waitForCanvasProCreatedNode(
            page,
            beforeContinueIds,
            { type: 'ai-video', prompt: continuePrompt },
            Math.min(timeoutMs, 10_000),
          );
          const continuedEdge = continuedVideo.graphState?.edges?.find(
            (edge) =>
              edge.sourceId === String(continueResult.outputNodeId || materializedSourceImageNodeId || '') &&
              edge.targetId === String(continuedVideo.node?.id || '') &&
              edge.refSlot === 'firstFrame',
          );
          checks.push({
            id: 'canvaspro-generation-task-output-continue-video-node',
            label: 'CanvasPro generation output can directly continue into a video node',
            ok: continuedVideo.ok && continuedVideo.selected,
            message: continuedVideo.ok
              ? continuedVideo.selected
                ? undefined
                : `Continued video node ${continuedVideo.node?.id || 'unknown'} was not selected`
              : `Expected a new ai-video node with prompt "${continuePrompt}", found ${continuedVideo.nodeCount} nodes`,
          });
          checks.push({
            id: 'canvaspro-generation-task-output-continue-video-edge',
            label: 'CanvasPro generation output continuation links the output node into the video node',
            ok: Boolean(continuedEdge),
            message: continuedEdge
              ? undefined
              : `Expected firstFrame edge ${continueResult.outputNodeId || materializedSourceImageNodeId || 'missing-output'} -> ${continuedVideo.node?.id || 'missing-video'}, found ${continuedVideo.graphState?.edgeCount ?? -1} edges`,
          });
        } else {
          for (const id of [
            'canvaspro-generation-task-output-materialize',
            'canvaspro-generation-task-output-materialize-idempotent',
            'canvaspro-generation-task-sync-auto-materialize',
            'canvaspro-generation-task-output-continue-video-node',
            'canvaspro-generation-task-output-continue-video-edge',
          ]) {
            checks.push({
              id,
              label: 'CanvasPro generation task completed output can become a reusable source node',
              ok: false,
              message: 'Output slots were not created, so materialization could not be verified',
            });
          }
        }
      } catch (error) {
        checks.push({
          id: 'canvaspro-generation-task-prompt-update',
          label: 'CanvasPro generation task prompt edits write back to the media node',
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
        checks.push({
          id: 'canvaspro-generation-task-settings-update',
          label: 'CanvasPro generation task settings edits write back to the media node',
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
        checks.push({
          id: 'canvaspro-generation-task-submit-update',
          label: 'CanvasPro generation task submit writes queue state back to the media node',
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
        for (const id of [
          'canvaspro-generation-task-output-slots',
          'canvaspro-generation-task-output-slot',
          'canvaspro-generation-task-output-slots-update',
          'canvaspro-generation-task-output-materialize',
          'canvaspro-generation-task-output-materialize-idempotent',
          'canvaspro-generation-task-sync-auto-materialize',
          'canvaspro-generation-task-output-continue-video',
          'canvaspro-generation-task-output-continue-variants',
          'canvaspro-generation-task-output-continue-reference',
          'canvaspro-generation-task-output-rerun',
          'canvaspro-generation-task-output-rerun-model',
          'canvaspro-generation-task-output-continue-video-node',
          'canvaspro-generation-task-output-continue-video-edge',
        ]) {
          checks.push({
            id,
            label: 'CanvasPro generation task submit creates pending output slots',
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else {
      checks.push({
        id: 'canvaspro-generation-queue-item',
        label: 'CanvasPro generation queue lists newly created media tasks',
        ok: false,
        message: 'Image node was not created, so no generation queue item could appear',
      });
      for (const id of [
        'canvaspro-generation-task-aspect-ratio',
        'canvaspro-generation-task-cost',
        'canvaspro-generation-task-detail',
        'canvaspro-generation-task-duration',
        'canvaspro-generation-task-param-summary',
        'canvaspro-generation-task-prompt',
        'canvaspro-generation-task-mode',
        'canvaspro-generation-task-model',
        'canvaspro-generation-task-quality',
        'canvaspro-generation-task-resolution',
        'canvaspro-generation-task-output-slots',
        'canvaspro-generation-task-output-slot',
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
        'canvaspro-generation-task-output-count',
        'canvaspro-generation-task-focus',
        'canvaspro-generation-task-rerun',
        'canvaspro-generation-task-rerun-model',
        'canvaspro-generation-task-save',
        'canvaspro-generation-task-prompt-update',
        'canvaspro-generation-task-settings-update',
        'canvaspro-generation-task-sync',
        'canvaspro-generation-task-sync-auto-materialize',
        'canvaspro-generation-task-submit',
        'canvaspro-generation-task-submit-update',
      ]) {
        checks.push({
          id,
          label: 'CanvasPro generation task detail is available for generated media',
          ok: false,
          message: 'Image node was not created, so no generation task detail could appear',
        });
      }
    }
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-image-node',
      label: 'CanvasPro quick-create image button adds a prompted image node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-generation-task-metadata',
      label: 'CanvasPro generated media nodes carry Studio task metadata',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-image-autoprepare',
      label: 'CanvasPro quick-created image node is immediately prepared as a MyShell Art atom task',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-generation-queue-item',
      label: 'CanvasPro generation queue lists newly created media tasks',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    for (const id of [
      'canvaspro-generation-task-aspect-ratio',
      'canvaspro-generation-task-cost',
      'canvaspro-generation-task-detail',
      'canvaspro-generation-task-duration',
      'canvaspro-generation-task-param-summary',
      'canvaspro-generation-task-prompt',
      'canvaspro-generation-task-mode',
      'canvaspro-generation-task-model',
      'canvaspro-generation-task-quality',
      'canvaspro-generation-task-resolution',
      'canvaspro-generation-task-output-slots',
      'canvaspro-generation-task-output-slot',
      'canvaspro-generation-task-output-slots-update',
      'canvaspro-generation-task-output-materialize',
      'canvaspro-generation-task-output-materialize-idempotent',
      'canvaspro-generation-task-sync-auto-materialize',
      'canvaspro-generation-task-output-continue-video',
      'canvaspro-generation-task-output-continue-variants',
      'canvaspro-generation-task-output-continue-reference',
      'canvaspro-generation-task-output-rerun',
      'canvaspro-generation-task-output-rerun-model',
      'canvaspro-generation-task-output-continue-video-node',
      'canvaspro-generation-task-output-continue-video-edge',
      'canvaspro-generation-task-output-count',
      'canvaspro-generation-task-focus',
      'canvaspro-generation-task-rerun',
      'canvaspro-generation-task-rerun-model',
      'canvaspro-generation-task-save',
      'canvaspro-generation-task-prompt-update',
      'canvaspro-generation-task-settings-update',
      'canvaspro-generation-task-sync',
      'canvaspro-generation-task-sync-auto-materialize',
      'canvaspro-generation-task-submit',
      'canvaspro-generation-task-submit-update',
    ]) {
      checks.push({
        id,
        label: 'CanvasPro generation task detail is available for generated media',
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    await waitForControlEnabled(page, imageFromSelectionButton, timeoutMs);
    const prompt = 'reference the selected portrait and create a cleaner hero still';
    if (seededImageNodeId) await setCanvasProSelectedNodeIds(page, [seededImageNodeId]);
    await promptInput.fill(prompt);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await imageFromSelectionButton.click({ timeout: timeoutMs });
    const result = await waitForCanvasProCreatedNode(
      page,
      beforeIds,
      { type: 'ai-image', prompt },
      Math.min(timeoutMs, 10_000),
    );
    const createdImageId = result.node?.id || '';
    if (result.ok) selectedReferenceImageNodeId = createdImageId;
    const sourceEdge = result.graphState?.edges?.find(
      (edge) => edge.sourceId === seededImageNodeId && edge.targetId === createdImageId && edge.refSlot === 'reference',
    );
    const task = result.node?.studioTask;
    checks.push({
      id: 'canvaspro-quick-create-selected-image-node',
      label: 'CanvasPro selected asset button adds a prompted reference image node',
      ok:
        Boolean(seededImageNodeId) &&
        result.ok &&
        result.selected &&
        task?.settings?.mode === 'reference-to-image',
      message: !seededImageNodeId
        ? 'Expected an image node from the previous quick-create step'
        : result.ok
          ? result.selected && task?.settings?.mode === 'reference-to-image'
            ? undefined
            : `Expected selected-source image node to be selected with reference-to-image mode, got ${JSON.stringify(task?.settings || {})}`
          : `Expected a new ai-image node from selected image with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
    checks.push({
      id: 'canvaspro-quick-create-selected-image-edge',
      label: 'CanvasPro selected asset button links the source image into the reference image node',
      ok: Boolean(sourceEdge),
      message: sourceEdge
        ? undefined
        : `Expected reference edge ${seededImageNodeId || 'missing-source'} -> ${createdImageId || 'missing-image'}, found ${result.graphState?.edgeCount ?? -1} edges`,
    });
    if (result.ok) {
      const beforeRerunState = await readCanvasProGraphState(page);
      const beforeRerunIds = new Set(beforeRerunState.nodes.map((node) => node.id));
      const rerunResult = await sendCanvasProBridgeAction(
        page,
        'rerunGenerationTask',
        {
          action: 'same',
          nodeId: createdImageId,
          prompt,
          taskId: task?.id || '',
        },
        Math.min(timeoutMs, 10_000),
      );
      const rerunNode = await waitForCanvasProCreatedNode(
        page,
        beforeRerunIds,
        { type: 'ai-image', prompt },
        Math.min(timeoutMs, 10_000),
      );
      const rerunEdge = rerunNode.graphState?.edges?.find(
        (edge) =>
          edge.sourceId === seededImageNodeId &&
          edge.targetId === String(rerunNode.node?.id || '') &&
          edge.refSlot === 'reference',
      );
      checks.push({
        id: 'canvaspro-generation-task-rerun-node',
        label: 'CanvasPro generation task can fork a same-parameter rerun node',
        ok: rerunNode.ok && rerunNode.selected && rerunResult.task?.status === 'draft',
        message:
          rerunNode.ok && rerunNode.selected && rerunResult.task?.status === 'draft'
            ? undefined
            : `Expected selected draft rerun image node, got ${JSON.stringify({ result: rerunResult, node: rerunNode.node })}`,
      });
      checks.push({
        id: 'canvaspro-generation-task-rerun-edge',
        label: 'CanvasPro generation rerun preserves selected reference input edge',
        ok: Boolean(rerunEdge),
        message: rerunEdge
          ? undefined
          : `Expected reference edge ${seededImageNodeId || 'missing-source'} -> ${rerunNode.node?.id || 'missing-rerun'}, found ${rerunNode.graphState?.edgeCount ?? -1} edges`,
      });

      const beforeModelRerunState = await readCanvasProGraphState(page);
      const beforeModelRerunIds = new Set(beforeModelRerunState.nodes.map((node) => node.id));
      const modelRerunResult = await sendCanvasProBridgeAction(
        page,
        'rerunGenerationTask',
        {
          action: 'model',
          nodeId: createdImageId,
          prompt,
          taskId: task?.id || '',
        },
        Math.min(timeoutMs, 10_000),
      );
      const modelRerunNode = await waitForCanvasProCreatedNode(
        page,
        beforeModelRerunIds,
        { type: 'ai-image', prompt },
        Math.min(timeoutMs, 10_000),
      );
      checks.push({
        id: 'canvaspro-generation-task-rerun-model-node',
        label: 'CanvasPro generation task can fork a model-switch rerun node',
        ok: modelRerunNode.ok && modelRerunNode.selected,
        message: modelRerunNode.ok
          ? modelRerunNode.selected
            ? undefined
            : `Model rerun node ${modelRerunNode.node?.id || 'unknown'} was not selected`
          : `Expected a model rerun ai-image node with prompt "${prompt}", found ${modelRerunNode.nodeCount} nodes`,
      });
      checks.push({
        id: 'canvaspro-generation-task-rerun-model-setting',
        label: 'CanvasPro model-switch rerun changes only the generation model setting',
        ok:
          modelRerunResult.previousModel === 'doubao-seedream-5.0-lite' &&
          modelRerunResult.model === 'image-pro' &&
          modelRerunNode.node?.studioTask?.settings?.model === 'image-pro' &&
          modelRerunNode.node?.studioTask?.settings?.mode === 'reference-to-image',
        message:
          modelRerunResult.previousModel === 'doubao-seedream-5.0-lite' &&
          modelRerunResult.model === 'image-pro' &&
          modelRerunNode.node?.studioTask?.settings?.model === 'image-pro' &&
          modelRerunNode.node?.studioTask?.settings?.mode === 'reference-to-image'
            ? undefined
            : `Expected model rerun to switch doubao-seedream-5.0-lite -> image-pro while preserving reference mode, got ${JSON.stringify({
                action: modelRerunResult,
                settings: modelRerunNode.node?.studioTask?.settings,
              })}`,
      });
    } else {
      for (const id of [
        'canvaspro-generation-task-rerun-node',
        'canvaspro-generation-task-rerun-edge',
        'canvaspro-generation-task-rerun-model-node',
        'canvaspro-generation-task-rerun-model-setting',
      ]) {
        checks.push({
          id,
          label: 'CanvasPro generation task rerun can be verified from a selected reference image task',
          ok: false,
          message: 'Selected image generation node was not created, so rerun could not be verified',
        });
      }
    }
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-selected-image-node',
      label: 'CanvasPro selected asset button adds a prompted reference image node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-selected-image-edge',
      label: 'CanvasPro selected asset button links the source image into the reference image node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    for (const id of [
      'canvaspro-generation-task-rerun-node',
      'canvaspro-generation-task-rerun-edge',
      'canvaspro-generation-task-rerun-model-node',
      'canvaspro-generation-task-rerun-model-setting',
    ]) {
      checks.push({
        id,
        label: 'CanvasPro generation task rerun can be verified from a selected reference image task',
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    await waitForControlEnabled(page, videoFromSelectionButton, timeoutMs);
    const prompt = 'animate from the first selected portrait into the cleaner hero still';
    await promptInput.fill(prompt);
    const firstVideoSourceId = materializedSourceImageNodeId || seededImageNodeId;
    const selectedVideoSources = [firstVideoSourceId, selectedReferenceImageNodeId].filter(Boolean);
    if (selectedVideoSources.length) await setCanvasProSelectedNodeIds(page, selectedVideoSources);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await videoFromSelectionButton.click({ timeout: timeoutMs });
    const result = await waitForCanvasProCreatedNode(
      page,
      beforeIds,
      { type: 'ai-video', prompt },
      Math.min(timeoutMs, 10_000),
    );
    const createdVideoId = result.node?.id || '';
    if (result.ok) selectedVideoNodeId = createdVideoId;
    const firstFrameEdge = result.graphState?.edges?.find(
      (edge) =>
        edge.sourceId === firstVideoSourceId &&
        edge.targetId === createdVideoId &&
        edge.refSlot === 'firstFrame',
    );
    const lastFrameEdge = result.graphState?.edges?.find(
      (edge) =>
        edge.sourceId === selectedReferenceImageNodeId &&
        edge.targetId === createdVideoId &&
        edge.refSlot === 'lastFrame',
    );
    const taskSourceIds = result.node?.studioTask?.sourceNodeIds || [];
    const taskSourcesOk =
      selectedVideoSources.length >= 2 &&
      selectedVideoSources.every((sourceId) => taskSourceIds.includes(sourceId));
    checks.push({
      id: 'canvaspro-quick-create-selected-video-node',
      label: 'CanvasPro selected asset button adds a prompted first/last-frame video node',
      ok: Boolean(firstVideoSourceId) && Boolean(selectedReferenceImageNodeId) && result.ok && result.selected && taskSourcesOk,
      message: !firstVideoSourceId
        ? 'Expected an image node from the previous quick-create step'
        : !selectedReferenceImageNodeId
          ? 'Expected a reference image node from the selected-source image step'
        : result.ok
          ? result.selected && taskSourcesOk
            ? undefined
            : `Expected first/last-frame video node ${createdVideoId || 'unknown'} to be selected and carry both source ids, got ${JSON.stringify(taskSourceIds)}`
          : `Expected a new ai-video node from selected image with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
    checks.push({
      id: 'canvaspro-quick-create-selected-video-edge',
      label: 'CanvasPro selected asset button links the first selected image into the video node',
      ok: Boolean(firstFrameEdge),
      message: firstFrameEdge
        ? undefined
        : `Expected firstFrame edge ${firstVideoSourceId || 'missing-source'} -> ${createdVideoId || 'missing-video'}, found ${result.graphState?.edgeCount ?? -1} edges`,
    });
    checks.push({
      id: 'canvaspro-quick-create-selected-video-last-frame-edge',
      label: 'CanvasPro selected asset button links the second selected image as the video last frame',
      ok: Boolean(lastFrameEdge),
      message: lastFrameEdge
        ? undefined
        : `Expected lastFrame edge ${selectedReferenceImageNodeId || 'missing-source'} -> ${createdVideoId || 'missing-video'}, found ${result.graphState?.edgeCount ?? -1} edges`,
    });
    if (result.ok && materializedSourceImageNodeId) {
      const submitResult = await sendCanvasProBridgeAction(
        page,
        'submitGenerationTask',
        {
          nodeId: createdVideoId,
          prompt,
        },
        Math.min(timeoutMs, 10_000),
      );
      const sourceInputs = Array.isArray(submitResult.task?.sourceInputs) ? submitResult.task.sourceInputs : [];
      const materializedInput = sourceInputs.find((input) => input.nodeId === materializedSourceImageNodeId);
      const sourceInputsOk =
        sourceInputs.length >= 2 &&
        materializedInput?.inputValue &&
        (/\/generated\/canvaspro-inputs\//.test(String(materializedInput.inputValue)) ||
          /^https?:\/\//i.test(String(materializedInput.inputValue))) &&
        ['ready', 'remote', 'staged'].includes(String(materializedInput.status || ''));
      checks.push({
        id: 'canvaspro-generation-task-source-inputs',
        label: 'CanvasPro selected-source video task records source input readiness',
        ok: sourceInputs.length >= 2,
        message: sourceInputs.length >= 2
          ? undefined
          : `Expected sourceInputs for selected video task, got ${JSON.stringify(sourceInputs)}`,
      });
      checks.push({
        id: 'canvaspro-generation-task-source-input-values',
        label: 'CanvasPro generation submit passes usable source media values to the backend task',
        ok: Boolean(sourceInputsOk),
        message: sourceInputsOk
          ? undefined
          : `Expected staged materialized source image input value on submit, got ${JSON.stringify(sourceInputs)}`,
      });
    } else {
      checks.push({
        id: 'canvaspro-generation-task-source-inputs',
        label: 'CanvasPro selected-source video task records source input readiness',
        ok: false,
        message: materializedSourceImageNodeId
          ? 'Selected video node was not created, so source inputs could not be verified'
          : 'Materialized source image was not available for selected-source video input verification',
      });
      checks.push({
        id: 'canvaspro-generation-task-source-input-values',
        label: 'CanvasPro generation submit passes usable source media values to the backend task',
        ok: false,
        message: materializedSourceImageNodeId
          ? 'Selected video node was not created, so inputValues could not be verified'
          : 'Materialized source image was not available for selected-source video input verification',
      });
    }
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-selected-video-node',
      label: 'CanvasPro selected asset button adds a prompted first/last-frame video node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-selected-video-edge',
      label: 'CanvasPro selected asset button links the source image into the video node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-selected-video-last-frame-edge',
      label: 'CanvasPro selected asset button links the second selected image as the video last frame',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-generation-task-source-inputs',
      label: 'CanvasPro selected-source video task records source input readiness',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-generation-task-source-input-values',
      label: 'CanvasPro generation submit passes usable source media values to the backend task',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, contextAssistantRunButton, timeoutMs);
    const prompt = 'agent turns a champagne product mood into image and video nodes';
    await contextAssistantMode.selectOption('auto');
    await contextAssistantPrompt.fill(prompt);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await contextAssistantRunButton.click({ timeout: timeoutMs });
    const result = await waitForCanvasProCreatedFlow(
      page,
      beforeIds,
      { prompt },
      Math.min(timeoutMs, 10_000),
    );
    await checkVisible(
      checks,
      page,
      'canvaspro-context-assistant-execution',
      'CanvasPro assistant shows Tapnow-style execution trace',
      contextAssistantExecution,
      timeoutMs,
    );
    await checkVisible(
      checks,
      page,
      'canvaspro-context-assistant-execution-step',
      'CanvasPro assistant execution trace lists completed command steps',
      contextAssistantExecutionStep,
      timeoutMs,
    );
    const executionText = await contextAssistantExecution.textContent({ timeout: timeoutMs }).catch(() => '');
    checks.push({
      id: 'canvaspro-context-assistant-run-submit-image',
      label: 'CanvasPro assistant execution prepares the image generation task',
      ok: executionText.includes('准备图像任务'),
      message: executionText.includes('准备图像任务')
        ? undefined
        : `Expected assistant execution trace to include image task preparation, got ${executionText}`,
    });
    checks.push({
      id: 'canvaspro-context-assistant-run-submit-video',
      label: 'CanvasPro assistant execution prepares the video generation task',
      ok: executionText.includes('准备视频任务'),
      message: executionText.includes('准备视频任务')
        ? undefined
        : `Expected assistant execution trace to include video task preparation, got ${executionText}`,
    });
    checks.push({
      id: 'canvaspro-context-assistant-run-flow-group',
      label: 'CanvasPro assistant auto mode turns one prompt into an image-to-video workflow',
      ok: result.ok && result.selected,
      message: result.ok
        ? result.selected
          ? undefined
          : `Created assistant flow group ${result.groupNode?.id || 'unknown'} was not selected`
        : `Expected an assistant-created image-to-video flow with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
    checks.push({
      id: 'canvaspro-context-assistant-run-flow-edge',
      label: 'CanvasPro assistant auto workflow links generated image into generated video',
      ok: Boolean(result.edge),
      message: result.edge
        ? undefined
        : `Expected assistant firstFrame edge ${result.imageNode?.id || 'missing-image'} -> ${result.videoNode?.id || 'missing-video'}, found ${result.graphState?.edgeCount ?? -1} edges`,
    });
    await contextAssistantMode.selectOption('manual');
  } catch (error) {
    checks.push({
      id: 'canvaspro-context-assistant-execution',
      label: 'CanvasPro assistant shows Tapnow-style execution trace',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-context-assistant-execution-step',
      label: 'CanvasPro assistant execution trace lists completed command steps',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-context-assistant-run-submit-image',
      label: 'CanvasPro assistant execution prepares the image generation task',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-context-assistant-run-submit-video',
      label: 'CanvasPro assistant execution prepares the video generation task',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-context-assistant-run-flow-group',
      label: 'CanvasPro assistant auto mode turns one prompt into an image-to-video workflow',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-context-assistant-run-flow-edge',
      label: 'CanvasPro assistant auto workflow links generated image into generated video',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, contextAssistantImageButton, timeoutMs);
    const prompt = 'assistant panel uses the selected portrait as reference for a poster still';
    if (seededImageNodeId) await setCanvasProSelectedNodeIds(page, [seededImageNodeId]);
    await contextAssistantPrompt.fill(prompt);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await contextAssistantImageButton.click({ timeout: timeoutMs });
    const result = await waitForCanvasProCreatedNode(
      page,
      beforeIds,
      { type: 'ai-image', prompt },
      Math.min(timeoutMs, 10_000),
    );
    const createdImageId = result.node?.id || '';
    const sourceEdge = result.graphState?.edges?.find(
      (edge) => edge.sourceId === seededImageNodeId && edge.targetId === createdImageId && edge.refSlot === 'reference',
    );
    const task = result.node?.studioTask;
    checks.push({
      id: 'canvaspro-context-assistant-image-node',
      label: 'CanvasPro context assistant creates a reference image from selected content',
      ok:
        Boolean(seededImageNodeId) &&
        result.ok &&
        result.selected &&
        task?.settings?.mode === 'reference-to-image',
      message: !seededImageNodeId
        ? 'Expected an image node from the previous quick-create step'
        : result.ok
          ? result.selected && task?.settings?.mode === 'reference-to-image'
            ? undefined
            : `Expected context assistant image node to be selected with reference-to-image mode, got ${JSON.stringify(task?.settings || {})}`
          : `Expected a new ai-image node from selected image with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
    checks.push({
      id: 'canvaspro-context-assistant-image-edge',
      label: 'CanvasPro context assistant links selected content into the reference image node',
      ok: Boolean(sourceEdge),
      message: sourceEdge
        ? undefined
        : `Expected reference edge ${seededImageNodeId || 'missing-source'} -> ${createdImageId || 'missing-image'}, found ${result.graphState?.edgeCount ?? -1} edges`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-context-assistant-image-node',
      label: 'CanvasPro context assistant creates a reference image from selected content',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-context-assistant-image-edge',
      label: 'CanvasPro context assistant links selected content into the reference image node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, contextAssistantVideoButton, timeoutMs);
    const prompt = 'assistant panel continues the selected portrait with a slow push in';
    if (seededImageNodeId) await setCanvasProSelectedNodeIds(page, [seededImageNodeId]);
    await contextAssistantPrompt.fill(prompt);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await contextAssistantVideoButton.click({ timeout: timeoutMs });
    const result = await waitForCanvasProCreatedNode(
      page,
      beforeIds,
      { type: 'ai-video', prompt },
      Math.min(timeoutMs, 10_000),
    );
    const createdVideoId = result.node?.id || '';
    const sourceEdge = result.graphState?.edges?.find(
      (edge) => edge.sourceId === seededImageNodeId && edge.targetId === createdVideoId,
    );
    checks.push({
      id: 'canvaspro-context-assistant-video-node',
      label: 'CanvasPro context assistant creates a prompted video from selected content',
      ok: Boolean(seededImageNodeId) && result.ok && result.selected,
      message: !seededImageNodeId
        ? 'Expected an image node from the first quick-create step'
        : result.ok
          ? result.selected
            ? undefined
            : `Created context assistant video node ${createdVideoId || 'unknown'} was not selected`
          : `Expected a context assistant ai-video node with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
    checks.push({
      id: 'canvaspro-context-assistant-video-edge',
      label: 'CanvasPro context assistant links selected content into the video node',
      ok: Boolean(sourceEdge),
      message: sourceEdge
        ? undefined
        : `Expected edge ${seededImageNodeId || 'missing-source'} -> ${createdVideoId || 'missing-video'}, found ${result.graphState?.edgeCount ?? -1} edges`,
    });
    if (selectedVideoNodeId) await setCanvasProSelectedNodeIds(page, [selectedVideoNodeId]);
  } catch (error) {
    checks.push({
      id: 'canvaspro-context-assistant-video-node',
      label: 'CanvasPro context assistant creates a prompted video from selected content',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-context-assistant-video-edge',
      label: 'CanvasPro context assistant links selected content into the video node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, videoFromSelectionButton, timeoutMs);
    const prompt = 'macro lens drift over glass petals';
    await promptInput.fill(`/animate ${prompt}`);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await promptInput.press('Enter', { timeout: timeoutMs });
    const result = await waitForCanvasProCreatedNode(
      page,
      beforeIds,
      { type: 'ai-video', prompt },
      Math.min(timeoutMs, 10_000),
    );
    const createdVideoId = result.node?.id || '';
    const sourceEdge = result.graphState?.edges?.find(
      (edge) => edge.sourceId === selectedVideoNodeId && edge.targetId === createdVideoId,
    );
    checks.push({
      id: 'canvaspro-quick-create-slash-animate-node',
      label: 'CanvasPro /animate command adds a prompted video node from selection',
      ok: Boolean(selectedVideoNodeId) && result.ok && result.selected,
      message: !selectedVideoNodeId
        ? 'Expected a selected video node from the previous quick-create step'
        : result.ok
          ? result.selected
            ? undefined
            : `Created /animate node ${createdVideoId || 'unknown'} was not selected`
          : `Expected a new ai-video node from /animate with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
    checks.push({
      id: 'canvaspro-quick-create-slash-animate-edge',
      label: 'CanvasPro /animate command links the selected source into the video node',
      ok: Boolean(sourceEdge),
      message: sourceEdge
        ? undefined
        : `Expected edge ${selectedVideoNodeId || 'missing-source'} -> ${createdVideoId || 'missing-video'}, found ${result.graphState?.edgeCount ?? -1} edges`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-slash-animate-node',
      label: 'CanvasPro /animate command adds a prompted video node from selection',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-slash-animate-edge',
      label: 'CanvasPro /animate command links the selected source into the video node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, videoButton, timeoutMs);
    const prompt = 'soft crane move across a luminous city';
    await promptInput.fill(prompt);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await videoButton.click({ timeout: timeoutMs });
    const result = await waitForCanvasProCreatedNode(
      page,
      beforeIds,
      { type: 'ai-video', prompt },
      Math.min(timeoutMs, 10_000),
    );
    checks.push({
      id: 'canvaspro-quick-create-video-node',
      label: 'CanvasPro quick-create video button adds a prompted video node',
      ok: result.ok && result.selected,
      message: result.ok
        ? result.selected
          ? undefined
          : `Created video node ${result.node?.id || 'unknown'} was not selected`
        : `Expected a new ai-video node with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
    const preparedTaskResult = result.ok
      ? await waitForCanvasProNodeTaskSubmitted(
          page,
          result.node?.id || '',
          ['ready'],
          Math.min(timeoutMs, 10_000),
        )
      : { ok: false, task: null };
    const preparedTask = preparedTaskResult.task || {};
    const preparedExecutor = preparedTask.executor || {};
    const videoAutoPrepared =
      preparedTaskResult.ok &&
      preparedExecutor.provider === 'myshell-art-cli' &&
      preparedExecutor.atom === 'dreamy-generate' &&
      preparedTask.settings?.mode === 'text-to-video' &&
      Array.isArray(preparedTask.outputs) &&
      preparedTask.outputs.length >= 1;
    checks.push({
      id: 'canvaspro-quick-create-video-autoprepare',
      label: 'CanvasPro quick-created video node is immediately prepared as a MyShell Art atom task',
      ok: videoAutoPrepared,
      message: videoAutoPrepared
        ? undefined
        : `Expected quick video to auto-prepare ready myshell-art-cli task with output slots, got ${JSON.stringify(preparedTask)}`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-video-node',
      label: 'CanvasPro quick-create video button adds a prompted video node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-video-autoprepare',
      label: 'CanvasPro quick-created video node is immediately prepared as a MyShell Art atom task',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, imageButton, timeoutMs);
    const prompt = 'slow orbital reveal over mirrored towers';
    await promptInput.fill(`/video ${prompt}`);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await promptInput.press('Enter', { timeout: timeoutMs });
    const result = await waitForCanvasProCreatedNode(
      page,
      beforeIds,
      { type: 'ai-video', prompt },
      Math.min(timeoutMs, 10_000),
    );
    checks.push({
      id: 'canvaspro-quick-create-slash-video-node',
      label: 'CanvasPro /video command adds a prompted video node',
      ok: result.ok && result.selected,
      message: result.ok
        ? result.selected
          ? undefined
          : `Created /video node ${result.node?.id || 'unknown'} was not selected`
        : `Expected a new ai-video node with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-slash-video-node',
      label: 'CanvasPro /video command adds a prompted video node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, flowButton, timeoutMs);
    const prompt = 'glass garden product reveal into a soft camera move';
    await promptInput.fill(prompt);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await flowButton.click({ timeout: timeoutMs });
    const result = await waitForCanvasProCreatedFlow(
      page,
      beforeIds,
      { prompt },
      Math.min(timeoutMs, 10_000),
    );
    checks.push({
      id: 'canvaspro-quick-create-flow-group',
      label: 'CanvasPro quick-create flow button adds a workflow group node',
      ok: result.ok && result.selected,
      message: result.ok
        ? result.selected
          ? undefined
          : `Created flow group ${result.groupNode?.id || 'unknown'} was not selected`
        : `Expected a grouped image-to-video flow with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
    checks.push({
      id: 'canvaspro-quick-create-flow-children',
      label: 'CanvasPro quick-create flow nests image and video nodes in the group',
      ok: Boolean(result.groupNode && result.imageNode && result.videoNode),
      message:
        result.groupNode && result.imageNode && result.videoNode
          ? undefined
          : `Expected group/image/video nodes, got group=${result.groupNode?.id || 'missing'} image=${result.imageNode?.id || 'missing'} video=${result.videoNode?.id || 'missing'}`,
    });
    checks.push({
      id: 'canvaspro-quick-create-flow-edge',
      label: 'CanvasPro quick-create flow links the image node into the video node',
      ok: Boolean(result.edge),
      message: result.edge
        ? undefined
        : `Expected firstFrame edge ${result.imageNode?.id || 'missing-image'} -> ${result.videoNode?.id || 'missing-video'}, found ${result.graphState?.edgeCount ?? -1} edges`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-flow-group',
      label: 'CanvasPro quick-create flow button adds a workflow group node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-flow-children',
      label: 'CanvasPro quick-create flow nests image and video nodes in the group',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-flow-edge',
      label: 'CanvasPro quick-create flow links the image node into the video node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, flowButton, timeoutMs);
    const prompt = 'editorial hero scene with practical light sweep';
    await promptInput.fill(`/flow ${prompt}`);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await promptInput.press('Enter', { timeout: timeoutMs });
    const result = await waitForCanvasProCreatedFlow(
      page,
      beforeIds,
      { prompt },
      Math.min(timeoutMs, 10_000),
    );
    checks.push({
      id: 'canvaspro-quick-create-slash-flow-group',
      label: 'CanvasPro /flow command adds a prompted workflow group',
      ok: result.ok && result.selected,
      message: result.ok
        ? result.selected
          ? undefined
          : `Created /flow group ${result.groupNode?.id || 'unknown'} was not selected`
        : `Expected a grouped /flow with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
    checks.push({
      id: 'canvaspro-quick-create-slash-flow-edge',
      label: 'CanvasPro /flow command links the image node into the video node',
      ok: Boolean(result.edge),
      message: result.edge
        ? undefined
        : `Expected firstFrame edge ${result.imageNode?.id || 'missing-image'} -> ${result.videoNode?.id || 'missing-video'}, found ${result.graphState?.edgeCount ?? -1} edges`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-slash-flow-group',
      label: 'CanvasPro /flow command adds a prompted workflow group',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-slash-flow-edge',
      label: 'CanvasPro /flow command links the image node into the video node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, storyboardButton, timeoutMs);
    const prompt = 'three beat fragrance launch sequence';
    await promptInput.fill(prompt);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await storyboardButton.click({ timeout: timeoutMs });
    const result = await waitForCanvasProCreatedStoryboard(
      page,
      beforeIds,
      { prompt },
      Math.min(timeoutMs, 10_000),
    );
    const hasShotPrompts = ['镜头 1', '镜头 2', '镜头 3'].every((shotLabel) =>
      [...result.imageNodes, ...result.videoNodes].some((node) => node.prompt.includes(shotLabel)),
    );
    checks.push({
      id: 'canvaspro-quick-create-storyboard-group',
      label: 'CanvasPro storyboard button adds a grouped multi-shot workflow',
      ok: result.ok && result.selected,
      message: result.ok
        ? result.selected
          ? undefined
          : `Created storyboard group ${result.groupNode?.id || 'unknown'} was not selected`
        : `Expected a storyboard group with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
    checks.push({
      id: 'canvaspro-quick-create-storyboard-shots',
      label: 'CanvasPro storyboard button nests three image/video shot pairs',
      ok: result.imageNodes.length === 3 && result.videoNodes.length === 3 && hasShotPrompts,
      message:
        result.imageNodes.length === 3 && result.videoNodes.length === 3 && hasShotPrompts
          ? undefined
          : `Expected three prompted image/video shot pairs, got images=${result.imageNodes.length} videos=${result.videoNodes.length}`,
    });
    checks.push({
      id: 'canvaspro-quick-create-storyboard-edges',
      label: 'CanvasPro storyboard button links shot images and video continuity',
      ok: result.firstFrameEdges.length >= 3 && result.continuityEdges.length >= 2,
      message:
        result.firstFrameEdges.length >= 3 && result.continuityEdges.length >= 2
          ? undefined
          : `Expected 3 firstFrame and 2 sourceVideo edges, got firstFrame=${result.firstFrameEdges.length} sourceVideo=${result.continuityEdges.length}`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-storyboard-group',
      label: 'CanvasPro storyboard button adds a grouped multi-shot workflow',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-storyboard-shots',
      label: 'CanvasPro storyboard button nests three image/video shot pairs',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-storyboard-edges',
      label: 'CanvasPro storyboard button links shot images and video continuity',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, storyboardButton, timeoutMs);
    const prompt = 'editorial three shot bottle story';
    await promptInput.fill(`/storyboard ${prompt}`);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await promptInput.press('Enter', { timeout: timeoutMs });
    const result = await waitForCanvasProCreatedStoryboard(
      page,
      beforeIds,
      { prompt },
      Math.min(timeoutMs, 10_000),
    );
    checks.push({
      id: 'canvaspro-quick-create-slash-storyboard-group',
      label: 'CanvasPro /storyboard command adds a grouped multi-shot workflow',
      ok: result.ok && result.selected,
      message: result.ok
        ? result.selected
          ? undefined
          : `Created /storyboard group ${result.groupNode?.id || 'unknown'} was not selected`
        : `Expected a /storyboard group with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
    checks.push({
      id: 'canvaspro-quick-create-slash-storyboard-edges',
      label: 'CanvasPro /storyboard command links shot images and video continuity',
      ok: result.firstFrameEdges.length >= 3 && result.continuityEdges.length >= 2,
      message:
        result.firstFrameEdges.length >= 3 && result.continuityEdges.length >= 2
          ? undefined
          : `Expected /storyboard 3 firstFrame and 2 sourceVideo edges, got firstFrame=${result.firstFrameEdges.length} sourceVideo=${result.continuityEdges.length}`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-slash-storyboard-group',
      label: 'CanvasPro /storyboard command adds a grouped multi-shot workflow',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-slash-storyboard-edges',
      label: 'CanvasPro /storyboard command links shot images and video continuity',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, variantsFromSelectionButton, timeoutMs);
    const prompt = 'create three polished image alternatives with the same subject';
    if (seededImageNodeId) await setCanvasProSelectedNodeIds(page, [seededImageNodeId]);
    await promptInput.fill(prompt);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await variantsFromSelectionButton.click({ timeout: timeoutMs });
    const result = await waitForCanvasProCreatedVariants(
      page,
      beforeIds,
      { outputType: 'ai-image', prompt, refSlot: 'reference', sourceNodeId: seededImageNodeId },
      Math.min(timeoutMs, 10_000),
    );
    checks.push({
      id: 'canvaspro-quick-create-selected-variants-group',
      label: 'CanvasPro selected variants button adds a comparison group',
      ok: Boolean(seededImageNodeId) && result.ok && result.selected,
      message: !seededImageNodeId
        ? 'Expected an image node from the first quick-create step'
        : result.ok
          ? result.selected
            ? undefined
            : `Created variants group ${result.groupNode?.id || 'unknown'} was not selected`
          : `Expected selected image variants with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
    checks.push({
      id: 'canvaspro-quick-create-selected-variants-source',
      label: 'CanvasPro selected variants nests the existing source node',
      ok: Boolean(result.sourceNode && result.groupNode && result.sourceNode.parentId === result.groupNode.id),
      message:
        result.sourceNode && result.groupNode && result.sourceNode.parentId === result.groupNode.id
          ? undefined
          : `Expected source ${seededImageNodeId || 'missing-source'} to be nested in the created variants group`,
    });
    checks.push({
      id: 'canvaspro-quick-create-selected-variants-nodes',
      label: 'CanvasPro selected variants creates three prompted image variants',
      ok: result.variantNodes.length === 3,
      message:
        result.variantNodes.length === 3
          ? undefined
          : `Expected 3 image variants, got ${result.variantNodes.length}`,
    });
    checks.push({
      id: 'canvaspro-quick-create-selected-variants-edges',
      label: 'CanvasPro selected variants links the source image into each variant',
      ok: result.edges.length >= 3,
      message:
        result.edges.length >= 3
          ? undefined
          : `Expected 3 reference edges from ${seededImageNodeId || 'missing-source'}, got ${result.edges.length}`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-selected-variants-group',
      label: 'CanvasPro selected variants button adds a comparison group',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-selected-variants-source',
      label: 'CanvasPro selected variants nests the existing source node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-selected-variants-nodes',
      label: 'CanvasPro selected variants creates three prompted image variants',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-selected-variants-edges',
      label: 'CanvasPro selected variants links the source image into each variant',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, variantsFromSelectionButton, timeoutMs);
    const prompt = 'make three tighter video motion alternatives';
    if (selectedVideoNodeId) await setCanvasProSelectedNodeIds(page, [selectedVideoNodeId]);
    await promptInput.fill(`/variants ${prompt}`);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await promptInput.press('Enter', { timeout: timeoutMs });
    const result = await waitForCanvasProCreatedVariants(
      page,
      beforeIds,
      { outputType: 'ai-video', prompt, refSlot: 'sourceVideo', sourceNodeId: selectedVideoNodeId },
      Math.min(timeoutMs, 10_000),
    );
    checks.push({
      id: 'canvaspro-quick-create-slash-variants-group',
      label: 'CanvasPro /variants command adds a selected-source comparison group',
      ok: Boolean(selectedVideoNodeId) && result.ok && result.selected,
      message: !selectedVideoNodeId
        ? 'Expected a selected video node from earlier quick-create steps'
        : result.ok
          ? result.selected
            ? undefined
            : `Created /variants group ${result.groupNode?.id || 'unknown'} was not selected`
          : `Expected selected video variants with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
    checks.push({
      id: 'canvaspro-quick-create-slash-variants-edges',
      label: 'CanvasPro /variants command links the selected video into each variant',
      ok: result.variantNodes.length === 3 && result.edges.length >= 3,
      message:
        result.variantNodes.length === 3 && result.edges.length >= 3
          ? undefined
          : `Expected 3 video variants and 3 sourceVideo edges, got variants=${result.variantNodes.length} edges=${result.edges.length}`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-slash-variants-group',
      label: 'CanvasPro /variants command adds a selected-source comparison group',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-slash-variants-edges',
      label: 'CanvasPro /variants command links the selected video into each variant',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, organizeLayoutButton, timeoutMs);
    const beforeState = await readCanvasProGraphState(page);
    await organizeLayoutButton.click({ timeout: timeoutMs });
    const result = await waitForCanvasProOrganizedLayout(page, beforeState, Math.min(timeoutMs, 10_000));
    checks.push({
      id: 'canvaspro-organize-layout-action',
      label: 'CanvasPro organize layout action moves canvas nodes into a cleaner layout',
      ok: result.ok && result.movedNodes.length > 0,
      message:
        result.ok && result.movedNodes.length > 0
          ? undefined
          : `Expected organize layout to move at least one node, moved ${result.movedNodes.length}`,
    });
    checks.push({
      id: 'canvaspro-organize-layout-selection',
      label: 'CanvasPro organize layout keeps a canvas selection after arranging',
      ok: result.selected,
      message: result.selected ? undefined : 'Expected organize layout to leave at least one selected node',
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-organize-layout-action',
      label: 'CanvasPro organize layout action moves canvas nodes into a cleaner layout',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-organize-layout-selection',
      label: 'CanvasPro organize layout keeps a canvas selection after arranging',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, selectedFlowButton, timeoutMs);
    const prompt = 'use the selected portrait as first frame for a calm product motion';
    if (seededImageNodeId) await setCanvasProSelectedNodeIds(page, [seededImageNodeId]);
    await promptInput.fill(prompt);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await selectedFlowButton.click({ timeout: timeoutMs });
    const result = await waitForCanvasProCreatedSelectedFlow(
      page,
      beforeIds,
      { prompt, refSlot: 'firstFrame', sourceNodeId: seededImageNodeId },
      Math.min(timeoutMs, 10_000),
    );
    if (result.ok) selectedFlowVideoNodeId = result.videoNode?.id || '';
    checks.push({
      id: 'canvaspro-quick-create-selected-flow-group',
      label: 'CanvasPro selected asset flow button adds a workflow group',
      ok: Boolean(seededImageNodeId) && result.ok && result.selected,
      message: !seededImageNodeId
        ? 'Expected an image node from the first quick-create step'
        : result.ok
          ? result.selected
            ? undefined
            : `Created selected-source flow group ${result.groupNode?.id || 'unknown'} was not selected`
          : `Expected selected-source flow with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
    checks.push({
      id: 'canvaspro-quick-create-selected-flow-source',
      label: 'CanvasPro selected asset flow nests the existing source node',
      ok: Boolean(result.sourceNode && result.groupNode && result.sourceNode.parentId === result.groupNode.id),
      message:
        result.sourceNode && result.groupNode && result.sourceNode.parentId === result.groupNode.id
          ? undefined
          : result.sourceNode && result.groupNode
          ? `Expected source ${result.sourceNode.id} parent ${result.sourceNode.parentId || 'missing'} to equal group ${result.groupNode.id}`
          : `Expected source ${seededImageNodeId || 'missing-source'} to be nested in the created group`,
    });
    checks.push({
      id: 'canvaspro-quick-create-selected-flow-edge',
      label: 'CanvasPro selected asset flow links the source image into the video node',
      ok: Boolean(result.edge),
      message: result.edge
        ? undefined
        : `Expected firstFrame edge ${seededImageNodeId || 'missing-source'} -> ${result.videoNode?.id || 'missing-video'}, found ${result.graphState?.edgeCount ?? -1} edges`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-selected-flow-group',
      label: 'CanvasPro selected asset flow button adds a workflow group',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-selected-flow-source',
      label: 'CanvasPro selected asset flow nests the existing source node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-selected-flow-edge',
      label: 'CanvasPro selected asset flow links the source image into the video node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, selectedFlowButton, timeoutMs);
    const sourceVideoId = selectedFlowVideoNodeId || selectedVideoNodeId;
    const prompt = 'continue the selected motion into a tighter hero shot';
    if (sourceVideoId) await setCanvasProSelectedNodeIds(page, [sourceVideoId]);
    await promptInput.fill(`/ref ${prompt}`);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await promptInput.press('Enter', { timeout: timeoutMs });
    const result = await waitForCanvasProCreatedSelectedFlow(
      page,
      beforeIds,
      { prompt, refSlot: 'sourceVideo', sourceNodeId: sourceVideoId },
      Math.min(timeoutMs, 10_000),
    );
    checks.push({
      id: 'canvaspro-quick-create-slash-ref-flow-group',
      label: 'CanvasPro /ref command adds a selected-source workflow group',
      ok: Boolean(sourceVideoId) && result.ok && result.selected,
      message: !sourceVideoId
        ? 'Expected a selected video source from earlier quick-create steps'
        : result.ok
          ? result.selected
            ? undefined
            : `Created /ref group ${result.groupNode?.id || 'unknown'} was not selected`
          : `Expected /ref selected-source flow with prompt "${prompt}", found ${result.nodeCount} nodes`,
    });
    checks.push({
      id: 'canvaspro-quick-create-slash-ref-flow-source',
      label: 'CanvasPro /ref command nests the selected video source node',
      ok: Boolean(result.sourceNode && result.groupNode && result.sourceNode.parentId === result.groupNode.id),
      message:
        result.sourceNode && result.groupNode && result.sourceNode.parentId === result.groupNode.id
          ? undefined
          : result.sourceNode && result.groupNode
          ? `Expected source ${result.sourceNode.id} parent ${result.sourceNode.parentId || 'missing'} to equal group ${result.groupNode.id}`
          : `Expected source ${sourceVideoId || 'missing-source'} to be nested in the created /ref group`,
    });
    checks.push({
      id: 'canvaspro-quick-create-slash-ref-flow-edge',
      label: 'CanvasPro /ref command links the selected video into the new video node',
      ok: Boolean(result.edge),
      message: result.edge
        ? undefined
        : `Expected sourceVideo edge ${sourceVideoId || 'missing-source'} -> ${result.videoNode?.id || 'missing-video'}, found ${result.graphState?.edgeCount ?? -1} edges`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-slash-ref-flow-group',
      label: 'CanvasPro /ref command adds a selected-source workflow group',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-slash-ref-flow-source',
      label: 'CanvasPro /ref command nests the selected video source node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-slash-ref-flow-edge',
      label: 'CanvasPro /ref command links the selected video into the new video node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, noteButton, timeoutMs);
    const content = 'brand reference: avoid washed out skin tones, keep product silhouette readable';
    await promptInput.fill(content);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await noteButton.click({ timeout: timeoutMs });
    const result = await waitForCanvasProCreatedNode(
      page,
      beforeIds,
      { type: 'source-text', contentIncludes: content },
      Math.min(timeoutMs, 10_000),
    );
    checks.push({
      id: 'canvaspro-quick-create-note-node',
      label: 'CanvasPro quick-create text reference button adds a canvas text node',
      ok: result.ok && result.selected,
      message: result.ok
        ? result.selected
          ? undefined
          : `Created text reference node ${result.node?.id || 'unknown'} was not selected`
        : `Expected a source-text node containing "${content}", found ${result.nodeCount} nodes`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-note-node',
      label: 'CanvasPro quick-create text reference button adds a canvas text node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, noteButton, timeoutMs);
    const content = 'shot list: close-up opener, product turntable, final wide composition';
    await promptInput.fill(`/note ${content}`);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await promptInput.press('Enter', { timeout: timeoutMs });
    const result = await waitForCanvasProCreatedNode(
      page,
      beforeIds,
      { type: 'source-text', contentIncludes: content },
      Math.min(timeoutMs, 10_000),
    );
    checks.push({
      id: 'canvaspro-quick-create-slash-note-node',
      label: 'CanvasPro /note command adds a canvas text node',
      ok: result.ok && result.selected,
      message: result.ok
        ? result.selected
          ? undefined
          : `Created /note node ${result.node?.id || 'unknown'} was not selected`
        : `Expected a /note source-text node containing "${content}", found ${result.nodeCount} nodes`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-slash-note-node',
      label: 'CanvasPro /note command adds a canvas text node',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, referenceFromSelectionButton, timeoutMs);
    const content = 'use this selected image as the reference anchor for the next pass';
    if (seededImageNodeId) await setCanvasProSelectedNodeIds(page, [seededImageNodeId]);
    await promptInput.fill(content);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await referenceFromSelectionButton.click({ timeout: timeoutMs });
    const result = await waitForCanvasProCreatedNode(
      page,
      beforeIds,
      { type: 'source-text', contentIncludes: content },
      Math.min(timeoutMs, 10_000),
    );
    const createdNoteId = result.node?.id || '';
    const referenceEdge = result.graphState?.edges?.find(
      (edge) =>
        edge.sourceId === seededImageNodeId &&
        edge.targetId === createdNoteId &&
        edge.refSlot === 'reference',
    );
    checks.push({
      id: 'canvaspro-quick-create-reference-note-node',
      label: 'CanvasPro selected reference button adds a canvas text note',
      ok: Boolean(seededImageNodeId) && result.ok && result.selected,
      message: !seededImageNodeId
        ? 'Expected an image node from the first quick-create step'
        : result.ok
          ? result.selected
            ? undefined
            : `Created selected reference note ${createdNoteId || 'unknown'} was not selected`
          : `Expected selected reference source-text node containing "${content}", found ${result.nodeCount} nodes`,
    });
    checks.push({
      id: 'canvaspro-quick-create-reference-note-edge',
      label: 'CanvasPro selected reference button links the source into the note',
      ok: Boolean(referenceEdge),
      message: referenceEdge
        ? undefined
        : `Expected reference edge ${seededImageNodeId || 'missing-source'} -> ${createdNoteId || 'missing-note'}, found ${result.graphState?.edgeCount ?? -1} edges`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-reference-note-node',
      label: 'CanvasPro selected reference button adds a canvas text note',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-reference-note-edge',
      label: 'CanvasPro selected reference button links the source into the note',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await waitForControlEnabled(page, referenceFromSelectionButton, timeoutMs);
    const content = 'cite this frame for palette, pose, and background density';
    if (seededImageNodeId) await setCanvasProSelectedNodeIds(page, [seededImageNodeId]);
    await promptInput.fill(`/cite ${content}`);
    const beforeState = await readCanvasProGraphState(page);
    const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
    await promptInput.press('Enter', { timeout: timeoutMs });
    const result = await waitForCanvasProCreatedNode(
      page,
      beforeIds,
      { type: 'source-text', contentIncludes: content },
      Math.min(timeoutMs, 10_000),
    );
    const createdNoteId = result.node?.id || '';
    const referenceEdge = result.graphState?.edges?.find(
      (edge) =>
        edge.sourceId === seededImageNodeId &&
        edge.targetId === createdNoteId &&
        edge.refSlot === 'reference',
    );
    checks.push({
      id: 'canvaspro-quick-create-slash-cite-node',
      label: 'CanvasPro /cite command adds a selected reference text note',
      ok: Boolean(seededImageNodeId) && result.ok && result.selected,
      message: !seededImageNodeId
        ? 'Expected an image node from the first quick-create step'
        : result.ok
          ? result.selected
            ? undefined
            : `Created /cite note ${createdNoteId || 'unknown'} was not selected`
          : `Expected /cite source-text node containing "${content}", found ${result.nodeCount} nodes`,
    });
    checks.push({
      id: 'canvaspro-quick-create-slash-cite-edge',
      label: 'CanvasPro /cite command links the selected source into the note',
      ok: Boolean(referenceEdge),
      message: referenceEdge
        ? undefined
        : `Expected reference edge ${seededImageNodeId || 'missing-source'} -> ${createdNoteId || 'missing-note'}, found ${result.graphState?.edgeCount ?? -1} edges`,
    });
  } catch (error) {
    checks.push({
      id: 'canvaspro-quick-create-slash-cite-node',
      label: 'CanvasPro /cite command adds a selected reference text note',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      id: 'canvaspro-quick-create-slash-cite-edge',
      label: 'CanvasPro /cite command links the selected source into the note',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const assistantNoteCases = [
    {
      button: assistantSummaryButton,
      contentIncludes: '画布总结',
      id: 'canvaspro-assistant-summary-note',
      label: 'CanvasPro assistant summary action creates a canvas text note',
    },
    {
      button: assistantReferencesButton,
      contentIncludes: '找相似参考',
      id: 'canvaspro-assistant-references-note',
      label: 'CanvasPro assistant references action creates a canvas text note',
    },
    {
      button: assistantGapsButton,
      contentIncludes: '哪里不清楚',
      id: 'canvaspro-assistant-gaps-note',
      label: 'CanvasPro assistant gaps action creates a canvas text note',
    },
  ];
  for (const assistantCase of assistantNoteCases) {
    try {
      await waitForControlEnabled(page, assistantCase.button, timeoutMs);
      const beforeState = await readCanvasProGraphState(page);
      const beforeIds = new Set(beforeState.nodes.map((node) => node.id));
      await assistantCase.button.click({ timeout: timeoutMs });
      const result = await waitForCanvasProCreatedAssistantNote(
        page,
        beforeIds,
        { contentIncludes: assistantCase.contentIncludes },
        Math.min(timeoutMs, 10_000),
      );
      checks.push({
        id: assistantCase.id,
        label: assistantCase.label,
        ok: result.ok && result.selected,
        message: result.ok
          ? result.selected
            ? undefined
            : `Created assistant note ${result.node?.id || 'unknown'} was not selected`
          : `Expected source-text note containing "${assistantCase.contentIncludes}", found ${result.nodeCount} nodes`,
      });
    } catch (error) {
      checks.push({
        id: assistantCase.id,
        label: assistantCase.label,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function checkCanvasProAuthorSignalPolicy(checks, page, timeoutMs) {
  const frame = page.frameLocator('[data-testid="canvaspro-iframe"]');
  try {
    const userAvatar = frame.locator('#userAvatar');
    await userAvatar.waitFor({ state: 'attached', timeout: Math.min(timeoutMs, 8000) });
    const userAvatarVisible = await userAvatar.isVisible().catch(() => false);
    if (userAvatarVisible) {
      await userAvatar.click({ timeout: timeoutMs });
    }

    const menuPolicy = await frame.locator('body').evaluate(() => {
      const hiddenIds = ['btnTutorial', 'btnGithubOfficial', 'btnFeatureFeedback'];
      const visibleUpstreamIds = hiddenIds.filter((id) => {
        const element = document.getElementById(id);
        if (!element) return false;
        const style = window.getComputedStyle(element);
        return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      });
      const sidebar = document.querySelector('.sidebar-floating');
      const sidebarHidden = !sidebar || window.getComputedStyle(sidebar).display === 'none' || sidebar.getClientRects().length === 0;
      return {
        authorSignals: document.documentElement.dataset.studioCanvasproAuthorSignals || '',
        sidebarHidden,
        visibleUpstreamIds,
        aboutLabel: document.getElementById('btnAbout')?.textContent?.replace(/\s+/g, ' ').trim() || '',
      };
    });

    checks.push({
      id: 'canvaspro-upstream-author-links-hidden',
      label: 'CanvasPro upstream tutorial, GitHub, and feedback links are hidden',
      ok: menuPolicy.visibleUpstreamIds.length === 0 && menuPolicy.authorSignals === 'hidden' && menuPolicy.sidebarHidden,
      message:
        menuPolicy.visibleUpstreamIds.length === 0 && menuPolicy.authorSignals === 'hidden' && menuPolicy.sidebarHidden
          ? undefined
          : `Visible upstream ids: ${menuPolicy.visibleUpstreamIds.join(', ') || 'none'}; policy=${menuPolicy.authorSignals || 'unset'}; sidebarHidden=${menuPolicy.sidebarHidden}`,
    });
    checks.push({
      id: 'canvaspro-license-disclosure-menu',
      label: 'CanvasPro About menu points to third-party license disclosure',
      ok: /第三方组件\s*\/\s*授权声明/.test(menuPolicy.aboutLabel),
      message: /第三方组件\s*\/\s*授权声明/.test(menuPolicy.aboutLabel)
        ? undefined
        : `Unexpected About label: ${menuPolicy.aboutLabel || 'empty'}`,
    });

    if (userAvatarVisible) {
      await frame.locator('#btnAbout').click({ timeout: timeoutMs });
    } else {
      await frame.locator('body').evaluate(() => {
        document.getElementById('btnAbout')?.click();
      });
    }
    const disclosurePolicy = await frame.locator('body').evaluate(() => {
      const modal = document.getElementById('studioCanvasproLicenseModal');
      const modalVisible = Boolean(
        modal &&
          !modal.hidden &&
          modal.getAttribute('aria-hidden') === 'false' &&
          window.getComputedStyle(modal).display !== 'none' &&
          modal.getClientRects().length > 0,
      );
      const disclosureText =
        modal?.querySelector('.studio-canvaspro-license-disclosure')?.textContent?.replace(/\s+/g, ' ').trim() || '';
      const title =
        modal?.querySelector('.studio-canvaspro-license-modal-title')?.textContent?.replace(/\s+/g, ' ').trim() || '';
      const authorText = document.querySelector('#aboutOverlay .about-author')?.textContent?.replace(/\s+/g, ' ').trim() || '';
      const bilibili = document.getElementById('btnBilibili');
      const bilibiliVisible = Boolean(
        bilibili &&
          !bilibili.hidden &&
          window.getComputedStyle(bilibili).display !== 'none' &&
          bilibili.getClientRects().length > 0,
      );
      return {
        modalVisible,
        title,
        disclosureText,
        authorText,
        bilibiliVisible,
      };
    });
    const dialogOk =
      disclosurePolicy.modalVisible &&
      /第三方组件\s*\/\s*授权声明/.test(disclosurePolicy.title) &&
      /AI-CanvasPro/.test(disclosurePolicy.disclosureText) &&
      /书面授权/.test(disclosurePolicy.disclosureText) &&
      !disclosurePolicy.authorText &&
      !disclosurePolicy.bilibiliVisible;
    checks.push({
      id: 'canvaspro-license-disclosure-dialog',
      label: 'CanvasPro About dialog is replaced with third-party license disclosure',
      ok: dialogOk,
      message: dialogOk
        ? undefined
        : `modalVisible=${disclosurePolicy.modalVisible}; title=${disclosurePolicy.title || 'empty'}; hasDisclosure=${Boolean(disclosurePolicy.disclosureText)}; author=${disclosurePolicy.authorText || 'hidden'}; bilibiliVisible=${disclosurePolicy.bilibiliVisible}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      id: 'canvaspro-upstream-author-links-hidden',
      label: 'CanvasPro upstream tutorial, GitHub, and feedback links are hidden',
      ok: false,
      message,
    });
    checks.push({
      id: 'canvaspro-license-disclosure-menu',
      label: 'CanvasPro About menu points to third-party license disclosure',
      ok: false,
      message,
    });
    checks.push({
      id: 'canvaspro-license-disclosure-dialog',
      label: 'CanvasPro About dialog is replaced with third-party license disclosure',
      ok: false,
      message,
    });
  }
}

async function checkCanvasProStudioSurfacePolicy(checks, page, timeoutMs) {
  const frame = page.frameLocator('[data-testid="canvaspro-iframe"]');
  try {
    await frame.locator('body').waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 8000) });
    const policy = await frame.locator('body').evaluate(async () => {
      const isVisible = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          !element.hidden &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) !== 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const managedSelectors = [
        '.canvas-controls-floating',
        '.minimap-wrapper',
        '.agent-sidebar-main',
        '.agent-greeting',
        '.agent-ref-bar',
        '.agent-model-btn',
        '#emptyHint',
        '.empty-hint',
        '#v2-canvas .node-floating-toolbar',
        '#v2-canvas .v2-img-toolbar',
        '#v2-canvas .v2-video-toolbar',
        '#v2-canvas .text-prompt-panel',
        '#v2-canvas .prompt-panel-footer',
      ];
      const visibleManagedSelectors = managedSelectors.filter((selector) =>
        Array.from(document.querySelectorAll(selector)).some((element) => isVisible(element)),
      );

      window.showToast?.('请先在设置里填写 GRSAI API Key', 'warn');
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      const visibleBlockedToasts = Array.from(
        document.querySelectorAll('#v2-toast-wrap > *, .v2-toast, [role="status"], [role="alert"]'),
      )
        .filter((element) => /GRSAI\s*API\s*Key|请先在设置里填写\s*GRSAI/i.test(element.textContent || '') && isVisible(element))
        .map((element) => element.textContent?.replace(/\s+/g, ' ').trim() || '');

      return {
        surfacePolicy: document.documentElement.dataset.studioCanvasproSurface || '',
        toastPolicy: document.documentElement.dataset.studioCanvasproToastPolicy || '',
        visibleManagedSelectors,
        visibleBlockedToasts,
      };
    });

    const surfaceOk = policy.surfacePolicy === 'managed' && policy.visibleManagedSelectors.length === 0;
    checks.push({
      id: 'canvaspro-studio-surface-policy',
      label: 'CanvasPro Studio mode hides duplicate upstream canvas and node toolbars',
      ok: surfaceOk,
      message: surfaceOk
        ? undefined
        : `surface=${policy.surfacePolicy || 'unset'}; visible=${policy.visibleManagedSelectors.join(', ') || 'none'}`,
    });

    const toastOk = policy.toastPolicy === 'enabled' && policy.visibleBlockedToasts.length === 0;
    checks.push({
      id: 'canvaspro-upstream-toast-policy',
      label: 'CanvasPro Studio mode suppresses upstream GRSAI API key toasts',
      ok: toastOk,
      message: toastOk
        ? undefined
        : `toastPolicy=${policy.toastPolicy || 'unset'}; visible=${policy.visibleBlockedToasts.join(' | ') || 'none'}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      id: 'canvaspro-studio-surface-policy',
      label: 'CanvasPro Studio mode hides duplicate upstream canvas and node toolbars',
      ok: false,
      message,
    });
    checks.push({
      id: 'canvaspro-upstream-toast-policy',
      label: 'CanvasPro Studio mode suppresses upstream GRSAI API key toasts',
      ok: false,
      message,
    });
  }
}

function resolveScreenshotPaths(options) {
  const evidenceScreenshotPath = options.evidenceScreenshotPath || options.screenshotPath || '';
  const workspaceScreenshotPath = options.workspaceScreenshotPath || '';
  return {
    workspaceScreenshotPath,
    evidenceScreenshotPath,
    screenshotPath: evidenceScreenshotPath || workspaceScreenshotPath || options.screenshotPath || '',
  };
}

export async function runStudioFrontendSmoke(options = {}) {
  const frontendUrl = options.frontendUrl || DEFAULT_FRONTEND_URL;
  const smokeUrl = buildStudioSmokeUrl(frontendUrl);
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const screenshotPaths = resolveScreenshotPaths(options);
  const checks = [];
  const consoleErrors = [];
  const canvasproOnly = options.canvasproOnly !== false;
  const summaryUrl = canvasproOnly ? buildCanvasProSmokeUrl(frontendUrl) : smokeUrl;
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(options.browserExecutablePath ? { executablePath: options.browserExecutablePath } : {}),
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.addInitScript(createStudioSmokeInitScript());
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const location = message.location();
        consoleErrors.push([message.text(), location.url].filter(Boolean).join(' @ '));
      }
    });
    page.on('pageerror', (error) => {
      consoleErrors.push(error.message);
    });

    if (canvasproOnly) {
      await checkCanvasProWorkspace(checks, page, frontendUrl, consoleErrors, timeoutMs);
      await captureScreenshot(page, screenshotPaths.workspaceScreenshotPath || screenshotPaths.evidenceScreenshotPath);
      return createSmokeSummary({
        frontendUrl: summaryUrl,
        checks,
        consoleErrors,
        screenshotPath: screenshotPaths.screenshotPath,
        workspaceScreenshotPath: screenshotPaths.workspaceScreenshotPath,
        evidenceScreenshotPath: screenshotPaths.evidenceScreenshotPath,
        allowConsoleErrors: options.allowConsoleErrors,
        requiredCheckIds: REQUIRED_CANVASPRO_CHECK_IDS,
      });
    }

    await page.goto(smokeUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 5000) }).catch(() => undefined);

    await checkVisible(checks, page, 'studio-title', 'Dreamy Studio title', page.getByText('Dreamy Studio').first(), timeoutMs);
    await checkVisible(
      checks,
      page,
      'conversation-workspace-panel',
      'Left conversation workspace panel',
      page.getByTestId('conversation-workspace-panel'),
      timeoutMs,
    );
    await checkVisible(
      checks,
      page,
      'bot-selection-panel',
      'Bot selection panel',
      page.getByTestId('bot-selection-panel'),
      timeoutMs,
    );
    await checkVisible(
      checks,
      page,
      'bot-selection-scroll-region',
      'Bot selection scroll region',
      page.getByTestId('bot-selection-scroll-region'),
      timeoutMs,
    );
    const manualBotPanel = page.getByTestId('manual-bot-id-panel');
    await checkVisible(
      checks,
      page,
      'manual-bot-id-panel',
      'Manual bot id panel',
      manualBotPanel,
      timeoutMs,
    );
    if (recordedCheckOk(checks, 'manual-bot-id-panel')) {
      await manualBotPanel.first().evaluate((element) => {
        if (element instanceof HTMLDetailsElement) {
          element.open = true;
        }
      });
    }
    const manualBotInput = page.getByTestId('manual-bot-id-input');
    await checkVisible(checks, page, 'manual-bot-id-input', 'Manual bot id input', manualBotInput, timeoutMs);
    if (recordedCheckOk(checks, 'manual-bot-id-input')) {
      await manualBotInput.fill(
        [
          'manual_image_bot|Manual Image Bot|text-to-image|manual-image',
          'manual_video_bot|Manual Video Bot|image-to-video|manual-video',
        ].join('\n'),
      );
    }
    await checkVisible(
      checks,
      page,
      'manual-bot-sequence-list',
      'Manual bot sequence list',
      page.getByTestId('manual-bot-sequence-list'),
      timeoutMs,
    );
    await checkEnabled(
      checks,
      page,
      'manual-bot-run-selected',
      'Manual selected bot run control',
      page.getByTestId('manual-bot-run-selected'),
      timeoutMs,
    );
    const manualSequenceButton = page.getByTestId('manual-bot-run-sequence');
    await checkEnabled(checks, page, 'manual-bot-run-sequence', 'Manual bot sequence run control', manualSequenceButton, timeoutMs);
    try {
      await manualSequenceButton.click({ timeout: timeoutMs });
      await page.waitForFunction(
        () => document.body.textContent?.includes('Manual Video Bot') && document.body.textContent?.includes('Manual Image Bot'),
        undefined,
        { timeout: timeoutMs },
      );
      checks.push({
        id: 'manual-bot-sequence-run',
        label: 'Manual bot sequence creates visible chained jobs',
        ok: true,
      });
    } catch (error) {
      checks.push({
        id: 'manual-bot-sequence-run',
        label: 'Manual bot sequence creates visible chained jobs',
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await checkVisible(
      checks,
      page,
      'studio-chat-region',
      'Conversation log region',
      page.getByTestId('studio-chat-region'),
      timeoutMs,
    );
    await checkVisible(checks, page, 'studio-composer', 'Studio composer', page.getByTestId('studio-composer'), timeoutMs);
    await checkVisible(
      checks,
      page,
      'preview-workspace-panel',
      'Right preview workspace panel',
      page.getByTestId('preview-workspace-panel'),
      timeoutMs,
    );
    await checkStudioLayoutGeometry(checks, page, timeoutMs);
    await checkVisible(
      checks,
      page,
      'ai-recommendation-agent',
      'AI recommendation agent',
      page.getByTestId('ai-recommendation-agent'),
      timeoutMs,
    );
    await checkEnabled(
      checks,
      page,
      'ai-recommendation-run',
      'AI recommendation can run directly',
      page.getByTestId('ai-recommendation-run'),
      timeoutMs,
    );
    await checkVisible(checks, page, 'starter-presets', 'Starter presets', page.getByTestId('starter-presets'), timeoutMs);
    await checkVisible(
      checks,
      page,
      'starter-visual-recommendations',
      'Visual bot recommendations',
      page.getByTestId('starter-visual-recommendations'),
      timeoutMs,
    );
    await checkVisible(
      checks,
      page,
      'starter-bot-preview-image',
      'Starter bot preview images',
      page.getByTestId('starter-bot-preview-image').first(),
      timeoutMs,
    );
    await checkVisible(checks, page, 'all-bot-previews', 'All connected bot previews', page.getByTestId('all-bot-previews'), timeoutMs);
    await checkVisible(
      checks,
      page,
      'all-bot-preview-card',
      'All connected bot preview cards',
      page.getByTestId('all-bot-preview-card').first(),
      timeoutMs,
    );
    await checkVisible(
      checks,
      page,
      'all-bot-preview-image',
      'All connected bot preview images',
      page.getByTestId('all-bot-preview-image').first(),
      timeoutMs,
    );
    try {
      const previewImage = page.getByTestId('starter-bot-preview-image').first();
      await previewImage.waitFor({ state: 'visible', timeout: timeoutMs });
      const previewSource = (await previewImage.getAttribute('src')) || '';
      const usesGeneratedPreview = /\/generated\/bot-previews\//i.test(previewSource);
      const usesDreamyCatalogPreview = /^https?:\/\/placehold\.co\//i.test(previewSource);
      checks.push({
        id: 'starter-bot-preview-asset',
        label: 'Starter bot preview uses generated or Dreamy catalog media asset',
        ok: usesGeneratedPreview || usesDreamyCatalogPreview,
        message: usesGeneratedPreview || usesDreamyCatalogPreview
          ? undefined
          : `Preview source is not a generated or Dreamy catalog asset: ${previewSource}`,
      });
    } catch (error) {
      checks.push({
        id: 'starter-bot-preview-asset',
        label: 'Starter bot preview uses generated or Dreamy catalog media asset',
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const botCardTexts = await page.getByTestId('all-bot-preview-card').evaluateAll((cards) =>
        cards.map((card) => (card.textContent || '').replace(/\s+/g, ' ').trim()),
      );
      const hasArtBot = botCardTexts.some((text) => /Seedream|Sora|Kling|Brat|Neon Art/i.test(text));
      checks.push({
        id: 'dreamy-bot-list-only',
        label: 'Connected bot list is scoped to Dreamy bots',
        ok: botCardTexts.length >= 3 && botCardTexts.some((text) => /Aurora Dusk/i.test(text)) && !hasArtBot,
        message: hasArtBot
          ? `Art bot leaked into Dreamy list: ${botCardTexts.join(' | ')}`
          : botCardTexts.length < 3
            ? `Expected multiple Dreamy bot cards, saw ${botCardTexts.length}`
            : undefined,
      });
    } catch (error) {
      checks.push({
        id: 'dreamy-bot-list-only',
        label: 'Connected bot list is scoped to Dreamy bots',
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await clickEnabled(
      checks,
      page,
      'starter-preset-selection',
      'Select Dreamy bot card',
      page.getByTestId('all-bot-preview-card').filter({ hasText: 'Aurora Dusk' }),
      timeoutMs,
    );
    try {
      const selectedSlug = await page.getByTestId('dreamy-studio-root').getAttribute('data-selected-bot-slug');
      checks.push({
        id: 'dreamy-bot-selection-state',
        label: 'Selected Dreamy bot slug drives Studio state',
        ok: selectedSlug === 'aurora-dusk',
        message: selectedSlug === 'aurora-dusk' ? undefined : `Selected slug was ${selectedSlug || 'empty'}`,
      });
    } catch (error) {
      checks.push({
        id: 'dreamy-bot-selection-state',
        label: 'Selected Dreamy bot slug drives Studio state',
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await checkVisible(
      checks,
      page,
      'selected-dreamy-bot-preview',
      'Selected Dreamy bot handoff preview',
      page.getByTestId('selected-dreamy-bot-preview'),
      timeoutMs,
    );
    await checkVisible(
      checks,
      page,
      'preview-selected-dreamy-bot',
      'Right preview follows selected Dreamy bot',
      page.getByTestId('preview-selected-dreamy-bot'),
      timeoutMs,
    );
    await clickEnabled(
      checks,
      page,
      'starter-preset-direct-generate',
      'Run selected starter preset',
      page.getByTestId('starter-preset-direct-generate'),
      timeoutMs,
    );
    const chatLog = page.getByTestId('studio-chat-log');
    await checkVisible(
      checks,
      page,
      'starter-preset-prompt-ready',
      'Starter preset prompt is sent',
      chatLog.getByText(/full body character scene|Animate the selected Dreamy source image|cinematic neon rain portrait/i),
      timeoutMs,
    );
    await checkVisible(
      checks,
      page,
      'starter-preset-result-visible',
      'Starter preset generation returns a Studio result',
      chatLog.getByText(/Segment is running in Dreamy|Segment is ready|client execution needs attention|Dreamy Miniapp needs Telegram auth/i),
      timeoutMs,
    );
    await checkVisible(
      checks,
      page,
      'preview-segment-rerun',
      'Single segment rerun control',
      page.getByTestId('preview-segment-rerun'),
      timeoutMs,
    );
    await checkVisible(
      checks,
      page,
      'preview-append-next-segment',
      'Append next segment control',
      page.getByTestId('preview-append-next-segment'),
      timeoutMs,
    );
    await checkVisible(
      checks,
      page,
      'preview-export-all-segments',
      'Export all segments control',
      page.getByTestId('preview-export-all-segments'),
      timeoutMs,
    );
    await clickEnabled(
      checks,
      page,
      'timeline-export-click',
      'Create backend timeline export',
      page.getByTestId('preview-export-all-segments'),
      timeoutMs,
    );
    await checkVisible(
      checks,
      page,
      'timeline-export-created',
      'Timeline export result is visible',
      chatLog.getByText(/Timeline export/i),
      timeoutMs,
    );
    await checkVisible(
      checks,
      page,
      'timeline-export-output-card',
      'Timeline export output card',
      page.getByTestId('timeline-export-output-card'),
      timeoutMs,
    );
    await checkVisible(
      checks,
      page,
      'video-fast-status',
      'Fast video handoff status',
      page.getByTestId('video-fast-status'),
      timeoutMs,
    );

    const canvasButton = page.getByRole('button', { name: /switch studio mode to canvas/i });
    if (await canvasButton.count()) {
      await canvasButton.first().click().catch(() => undefined);
    }

    await checkVisible(checks, page, 'canvas-mode', 'Canvas mode indicator', page.getByText('Canvas').first(), timeoutMs);
    await checkVisible(
      checks,
      page,
      'canvas-auto-flow-presets',
      'Canvas auto flow presets',
      page.getByTestId('canvas-auto-flow-presets'),
      timeoutMs,
    );
    await checkVisible(
      checks,
      page,
      'canvas-material-flow-ready',
      'Canvas material flow ready state',
      page.getByTestId('canvas-material-flow-ready'),
      timeoutMs,
    );
    await checkVisible(checks, page, 'layers-panel', 'Layers & Agents panel', page.getByText('Layers & Agents'), timeoutMs);
    await checkVisible(checks, page, 'inspector-panel', 'Inspector panel', page.getByText('Inspector'), timeoutMs);
    await checkVisible(checks, page, 'canvas-generate', 'Canvas generate control', page.getByRole('button', { name: /generate/i }), timeoutMs);
    await checkVisible(
      checks,
      page,
      'canvaspro-workspace-switch',
      'CanvasPro workspace switch',
      page.getByTestId('canvaspro-workspace-switch'),
      timeoutMs,
    );
    await checkVisible(checks, page, 'footer-evidence', 'Evidence footer control', page.getByRole('button', { name: /evidence/i }), timeoutMs);
    await checkVisible(checks, page, 'footer-plan-remaining', 'Plan remaining footer control', page.getByRole('button', { name: /plan remaining/i }), timeoutMs);
    await checkVisible(checks, page, 'footer-start-queue', 'Start queue footer control', page.getByRole('button', { name: /start queue/i }), timeoutMs);
    await captureScreenshot(page, screenshotPaths.workspaceScreenshotPath);

    await clickVisible(checks, page, 'open-evidence-drawer', 'Open evidence drawer', page.getByRole('button', { name: /evidence/i }), timeoutMs);
    await checkVisible(checks, page, 'delivery-evidence', 'Delivery Evidence drawer', page.getByText('Delivery Evidence'), timeoutMs);
    await checkVisible(checks, page, 'delivery-command-center', 'Delivery command center', page.getByTestId('delivery-command-center'), timeoutMs);
    await clickVisible(
      checks,
      page,
      'dispatch-navigation-target-selected',
      'Select Explore navigation target',
      page.getByLabel(/include explore in selected dispatch batch/i),
      timeoutMs,
    );
    await clickEnabled(checks, page, 'dispatch-plan-selected-click', 'Click Plan Selected', page.getByRole('button', { name: /plan selected/i }), timeoutMs);
    await checkVisible(checks, page, 'dispatch-batch-planned', 'Dispatch batch planned', page.getByText(/Batch (ready|planned)/i), timeoutMs);
    await checkEnabled(checks, page, 'dispatch-selected-batch-planned', 'Selected dispatch batch planned', page.getByRole('button', { name: /start selected/i }), timeoutMs);
    await clickEnabled(checks, page, 'dispatch-start-selected-click', 'Click Start Selected', page.getByRole('button', { name: /start selected/i }), timeoutMs);
    await checkVisible(checks, page, 'dispatch-session-started', 'Dispatch session started', page.getByText(/Queue active/i), timeoutMs);
    await checkVisible(checks, page, 'dispatch-selected-session-started', 'Selected dispatch session started', page.getByText(/Queue active/i), timeoutMs);
    await checkEnabled(checks, page, 'dispatch-next-target-ready', 'Next dispatch target is ready', page.getByRole('button', { name: /open next|run next/i }), timeoutMs);
    await clickEnabled(checks, page, 'dispatch-open-next-click', 'Click Open Next', page.getByRole('button', { name: /open next/i }), timeoutMs);
    await checkVisible(checks, page, 'dispatch-target-opened', 'Dispatch target page opened', page.getByRole('button', { name: /return to studio/i }), timeoutMs);
    await checkVisible(checks, page, 'studio-return-dock-visible', 'Studio return dock is visible', page.getByRole('button', { name: /return to studio/i }), timeoutMs);
    await clickVisible(checks, page, 'studio-return-click', 'Click Return to Studio', page.getByRole('button', { name: /return to studio/i }), timeoutMs);
    await checkVisible(checks, page, 'studio-return-restored', 'Studio restored after target navigation', page.getByText('Dreamy Studio').first(), timeoutMs);
    await clickVisible(checks, page, 'reopen-evidence-drawer', 'Reopen evidence drawer after return', page.getByRole('button', { name: /evidence/i }), timeoutMs);
    await checkVisible(checks, page, 'dispatch-target-visited', 'Dispatch target marked visited after return', page.getByText(/Focus Explore visited|1 visited/i), timeoutMs);
    await checkVisible(checks, page, 'page-selector', 'Page selector', page.getByLabel('Studio page adapter').last(), timeoutMs);
    await checkVisible(checks, page, 'agent-selector', 'Agent selector', page.getByLabel('Studio agent').last(), timeoutMs);
    await checkVisible(checks, page, 'page-registry', 'Page Registry section', page.getByText('Page Registry'), timeoutMs);
    await checkVisible(checks, page, 'dispatch-matrix', 'Dispatch Matrix section', page.getByText('Dispatch Matrix'), timeoutMs);
    await checkVisible(checks, page, 'dispatch-queue', 'Dispatch Queue section', page.getByText('Dispatch Queue'), timeoutMs);
    await checkVisible(checks, page, 'audit-json', 'Audit JSON action', page.getByRole('button', { name: /audit json/i }), timeoutMs);

    const errorBoundary = page.getByText('Something went wrong');
    checks.push({
      id: 'no-error-boundary',
      label: 'No React error boundary',
      ok: (await errorBoundary.count()) === 0,
      message: (await errorBoundary.count()) === 0 ? undefined : 'React error boundary is visible',
    });

    await captureScreenshot(page, screenshotPaths.evidenceScreenshotPath);
    await checkCanvasProWorkspace(checks, page, frontendUrl, consoleErrors, timeoutMs);
  } finally {
    await browser.close();
  }

  return createSmokeSummary({
    frontendUrl: summaryUrl,
    checks,
    consoleErrors,
    screenshotPath: screenshotPaths.screenshotPath,
    workspaceScreenshotPath: screenshotPaths.workspaceScreenshotPath,
    evidenceScreenshotPath: screenshotPaths.evidenceScreenshotPath,
    allowConsoleErrors: options.allowConsoleErrors,
    requiredCheckIds: options.canvasproOnly ? REQUIRED_CANVASPRO_CHECK_IDS : REQUIRED_STUDIO_CHECK_IDS,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  let globalTimer;
  const summary = await Promise.race([
    runStudioFrontendSmoke(args),
    new Promise((_, reject) => {
      globalTimer = setTimeout(
        () => reject(new Error(`Studio frontend smoke exceeded ${args.globalTimeoutMs}ms global timeout`)),
        args.globalTimeoutMs,
      );
    }),
  ]).finally(() => {
    if (globalTimer) clearTimeout(globalTimer);
  });
  if (args.reportPath) {
    await fs.mkdir(path.dirname(args.reportPath), { recursive: true });
    await fs.writeFile(args.reportPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.status !== 'ok') {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
