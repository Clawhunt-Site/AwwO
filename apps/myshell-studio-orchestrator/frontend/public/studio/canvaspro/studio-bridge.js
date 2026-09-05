import { graphStore } from './src/core/stores/appStore.js';
import { computeNodesWorldBounds, computeViewportForWorldBounds } from './src/core/math.js';
import { commit } from './src/modules/history.js';
import { getAIGenerationDefaultSizeByType, getAIGenerationNodeSize } from './src/services/fileService.js';

const BRIDGE_VERSION = '2026.06.23.01';
const DB_NAME = 'myshell-studio-ai-canvaspro';
const DB_VERSION = 1;
const PROJECT_STORE = 'projects';
const ASSET_STORE = 'assets';
const TASK_REGISTRY_STORAGE_PREFIX = 'myshell-studio-canvaspro-task-registry';
const MESSAGE_REQUEST = 'aicanvas-studio:request';
const MESSAGE_RESPONSE = 'aicanvas-studio:response';
const MESSAGE_READY = 'aicanvas-studio:ready';
const MESSAGE_AUTOSAVE = 'aicanvas-studio:autosave';
const API_BASE = location.pathname.startsWith('/ai-canvaspro/') ? '/ai-canvaspro-api' : '';
const AUTHOR_SIGNAL_POLICY_KEY = '__MYSHELL_STUDIO_CANVASPRO_AUTHOR_SIGNAL_POLICY__';
const AUTHOR_SIGNAL_POLICY_STYLE_ID = 'studio-canvaspro-author-signal-policy';
const STUDIO_SURFACE_POLICY_KEY = '__MYSHELL_STUDIO_CANVASPRO_SURFACE_POLICY__';
const STUDIO_SURFACE_POLICY_STYLE_ID = 'studio-canvaspro-surface-policy';
const STUDIO_TOAST_POLICY_KEY = '__MYSHELL_STUDIO_CANVASPRO_TOAST_POLICY__';
const STUDIO_TOAST_DEDUP_MS = 1800;
const READABLE_NODE_VIEWPORT_MIN_ZOOM = 0.72;
const READABLE_NODE_VIEWPORT_MAX_ZOOM = 0.92;
const READABLE_NODE_VIEWPORT_PADDING = 104;
const READABLE_NODE_VIEWPORT_DEBOUNCE_MS = 80;
const READABLE_NODE_FOCUS_OPTIONS = Object.freeze({
  minZoom: READABLE_NODE_VIEWPORT_MIN_ZOOM,
  maxZoom: READABLE_NODE_VIEWPORT_MAX_ZOOM,
});
const LICENSE_MODAL_ID = 'studioCanvasproLicenseModal';
const AUTHOR_SIGNAL_LABEL = '第三方组件 / 授权声明';
const HIDDEN_UPSTREAM_MENU_IDS = Object.freeze(['btnTutorial', 'btnGithubOfficial', 'btnFeatureFeedback']);
const BLOCKED_UPSTREAM_EXTERNAL_URL_PATTERNS = Object.freeze([
  /github\.com\/ashuoAI\/AI-CanvasPro/i,
  /i1etb6xynr\.feishu\.cn/i,
  /space\.bilibili\.com\/1876480181/i,
]);
const SUPPRESSED_UPSTREAM_TOAST_PATTERNS = Object.freeze([
  /GRSAI\s*API\s*Key/i,
  /请先在设置里填写\s*GRSAI\s*API\s*Key/i,
]);
const ALLOWED_ACTIONS = new Set([
  'getStatus',
  'saveSnapshot',
  'exportPackage',
  'importPackage',
  'importMediaFiles',
  'getSelectedContext',
  'getSuperClawCanvasContext',
  'getGenerationTasks',
  'focusGenerationTask',
  'updateGenerationTask',
  'submitGenerationTask',
  'syncGenerationTask',
  'materializeGenerationOutput',
  'continueGenerationOutput',
  'rerunGenerationTask',
  'restoreGenerationTaskNode',
  'removeGenerationTask',
  'createNode',
  'createFlow',
  'createStoryboard',
  'createVariants',
  'organizeCanvas',
  'createAssistantNote',
  'openShortcuts',
]);
const BRIDGE_INSTALL_KEY = '__MYSHELL_STUDIO_CANVASPRO_BRIDGE_INSTALLED__';
const bridgeAlreadyInstalled = Boolean(window[BRIDGE_INSTALL_KEY]);
window[BRIDGE_INSTALL_KEY] = true;
const OFFLINE_GENERATION_SELECTOR = [
  '.act-generate',
  '.act-image-generate',
  '.act-video-generate',
  '.act-text-generate',
  '.act-audio-generate',
  '.act-runninghub',
  '.act-dreamina',
  '[data-action*="generate" i]',
  '[data-ui-action*="generate" i]',
  '[data-command*="generate" i]',
  '[class*="generate" i]',
  '[class*="runninghub" i]',
  '[class*="dreamina" i]',
].join(',');
const ASSET_URL_KEYS = new Set([
  'audioUrl',
  'displayUrl',
  'fileUrl',
  'imageUrl',
  'localUrl',
  'originalUrl',
  'src',
  'sourceUrl',
  'thumbUrl',
  'url',
  'videoUrl',
]);
const LOCAL_PATH_KEYS = new Set([
  'displayLocalPath',
  'localPath',
  'originalLocalPath',
  'path',
  'thumbLocalPath',
]);
const QUICK_CREATE_NODE_CONFIGS = Object.freeze({
  image: {
    nodeType: 'ai-image',
    name: '生成图像',
    toast: '已新建图像节点',
  },
  video: {
    nodeType: 'ai-video',
    name: '生成视频',
    toast: '已新建视频节点',
  },
  note: {
    nodeType: 'source-text',
    name: '文本参考',
    toast: '已新建文本参考',
  },
});
const MEDIA_IMPORT_MAX_FILES = 6;
const MEDIA_IMPORT_NODE_TYPES = Object.freeze({
  audio: 'source-audio',
  image: 'source-image',
  video: 'source-video',
});
const MEDIA_IMPORT_DEFAULT_SIZES = Object.freeze({
  audio: { width: 320, height: 140 },
  image: { width: 320, height: 180 },
  video: { width: 320, height: 180 },
});
const MEDIA_IMPORT_SUPPORTED_EXTENSIONS = Object.freeze({
  audio: ['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav', 'webm'],
  image: ['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'],
  video: ['m4v', 'mov', 'mp4', 'ogv', 'webm'],
});

let dbPromise = null;
let autosaveTimer = null;
let lastAutosaveSignature = '';
let lastAutosaveMeta = null;
let apiReachable = null;
let studioTaskRegistry = null;
let studioTaskRegistryProjectId = '';
let readableViewportNodeIds = null;
let readableViewportTimer = null;
const readableViewportPendingNodeIds = new Set();

function postToStudio(message) {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(message, window.location.origin);
  }
}

function isTrustedStudioMessage(event) {
  if (event.origin !== window.location.origin) return false;
  if (window.parent && window.parent !== window && event.source !== window.parent) return false;
  return true;
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTrustedStudioRequest(event) {
  if (!isTrustedStudioMessage(event)) return false;
  const message = event.data || {};
  if (!isPlainRecord(message)) return false;
  if (message.type !== MESSAGE_REQUEST) return false;
  if (typeof message.id !== 'string' || !message.id) return false;
  if (typeof message.action !== 'string' || !ALLOWED_ACTIONS.has(message.action)) return false;
  if (message.payload != null && !isPlainRecord(message.payload)) return false;
  return true;
}

function applyRuntimeModeState() {
  document.documentElement.dataset.studioCanvasproApi =
    apiReachable === false ? 'offline' : apiReachable === true ? 'native' : 'unknown';
}

function installOfflineGenerationGuard() {
  document.addEventListener(
    'click',
    (event) => {
      if (apiReachable !== false) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const control = target.closest(OFFLINE_GENERATION_SELECTOR);
      if (!control) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.showToast?.('Native CanvasPro API is required for generation tasks.', 'warn');
    },
    true,
  );
}

function installStudioSurfacePolicyStyles() {
  if (document.getElementById(STUDIO_SURFACE_POLICY_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STUDIO_SURFACE_POLICY_STYLE_ID;
  style.textContent = `
    html[data-studio-canvaspro-surface="managed"] .canvas-controls-floating,
    html[data-studio-canvaspro-surface="managed"] .minimap-wrapper,
    html[data-studio-canvaspro-surface="managed"] #v2-side-plus-holder,
    html[data-studio-canvaspro-surface="managed"] .sidebar-floating,
    html[data-studio-canvaspro-surface="managed"] .v2-file-history-header,
    html[data-studio-canvaspro-surface="managed"] .v2-file-history-content,
    html[data-studio-canvaspro-surface="managed"] .v2-task-center-header,
    html[data-studio-canvaspro-surface="managed"] .v2-task-center-summary,
    html[data-studio-canvaspro-surface="managed"] .v2-task-center-list,
    html[data-studio-canvaspro-surface="managed"] .v2-task-center-empty,
    html[data-studio-canvaspro-surface="managed"] .v2-asset-sidebar-header,
    html[data-studio-canvaspro-surface="managed"] .v2-asset-sidebar-content,
    html[data-studio-canvaspro-surface="managed"] .v2-asset-sidebar-tabs-shell,
    html[data-studio-canvaspro-surface="managed"] #asset-sidebar-tabs,
    html[data-studio-canvaspro-surface="managed"] .v2-workflow-sidebar-header,
    html[data-studio-canvaspro-surface="managed"] .v2-workflow-search,
    html[data-studio-canvaspro-surface="managed"] .v2-workflow-list,
    html[data-studio-canvaspro-surface="managed"] .v2-workflow-empty,
    html[data-studio-canvaspro-surface="managed"] .agent-sidebar-main,
    html[data-studio-canvaspro-surface="managed"] .agent-greeting,
    html[data-studio-canvaspro-surface="managed"] .agent-ref-bar,
    html[data-studio-canvaspro-surface="managed"] .agent-ref-placeholder,
    html[data-studio-canvaspro-surface="managed"] .agent-pill-btn,
    html[data-studio-canvaspro-surface="managed"] .agent-model-btn,
    html[data-studio-canvaspro-surface="managed"] #emptyHint,
    html[data-studio-canvaspro-surface="managed"] .empty-hint,
    html[data-studio-canvaspro-surface="managed"] .empty-hint-main,
    html[data-studio-canvaspro-surface="managed"] .empty-hint-pills,
    html[data-studio-canvaspro-surface="managed"] #emptyBtnText,
    html[data-studio-canvaspro-surface="managed"] #emptyBtnImage,
    html[data-studio-canvaspro-surface="managed"] #emptyBtnVideo,
    html[data-studio-canvaspro-surface="managed"] .cpd-header,
    html[data-studio-canvaspro-surface="managed"] .cpd-list,
    html[data-studio-canvaspro-surface="managed"] .cpd-footer,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .node-floating-toolbar,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .node-bottom-toolbar-anchor,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .v2-img-toolbar,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .v2-video-toolbar,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .v2-text-toolbar,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .v2-comment-toolbar,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .group-toolbar,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .text-prompt-panel,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .prompt-panel-footer,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .prompt-actions,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .v2-annotate-toolbar,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .v2-annotate-generation-toolbar,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .v2-crop-toolbar,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .v2-expand-toolbar,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .v2-matting-toolbar,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .panorama-scene-bottom-toolbar-anchor,
    html[data-studio-canvaspro-surface="managed"] #v2-canvas .panorama-scene-bottom-toolbar-popovers {
      display: none !important;
      pointer-events: none !important;
    }
  `;
  document.head.appendChild(style);
}

function isSuppressedUpstreamToastText(value) {
  const text = String(value || '');
  return Boolean(text) && SUPPRESSED_UPSTREAM_TOAST_PATTERNS.some((pattern) => pattern.test(text));
}

function removeSuppressedUpstreamToasts(root = document) {
  const scope = root instanceof Element || root instanceof Document ? root : document;
  const candidates = [];
  if (scope instanceof Element && scope.matches?.('#v2-toast-wrap > *, .v2-toast, [role="status"], [role="alert"]')) {
    candidates.push(scope);
  }
  if (typeof scope.querySelectorAll === 'function') {
    candidates.push(...scope.querySelectorAll('#v2-toast-wrap > *, .v2-toast, [role="status"], [role="alert"]'));
  }
  for (const candidate of candidates) {
    if (!isSuppressedUpstreamToastText(candidate.textContent)) continue;
    candidate.remove();
  }
}

function installStudioToastPolicy() {
  if (window[STUDIO_TOAST_POLICY_KEY]) return;
  window[STUDIO_TOAST_POLICY_KEY] = true;
  document.documentElement.dataset.studioCanvasproToastPolicy = 'enabled';

  const lastToast = { key: '', at: 0 };
  const wrapCurrentShowToast = () => {
    const current = window.showToast;
    if (typeof current !== 'function' || current.__studioCanvasproToastPolicy) return;
    const original = current.bind(window);
    const wrappedShowToast = (message, type, ...rest) => {
      const text = String(message || '');
      if (isSuppressedUpstreamToastText(text)) {
        window.requestAnimationFrame?.(() => removeSuppressedUpstreamToasts());
        return undefined;
      }
      const key = `${type || ''}:${text}`;
      const now = Date.now();
      if (text && key === lastToast.key && now - lastToast.at < STUDIO_TOAST_DEDUP_MS) {
        return undefined;
      }
      lastToast.key = key;
      lastToast.at = now;
      return original(message, type, ...rest);
    };
    Object.defineProperty(wrappedShowToast, '__studioCanvasproToastPolicy', { value: true });
    Object.defineProperty(wrappedShowToast, '__studioCanvasproRawShowToast', { value: current });
    window.showToast = wrappedShowToast;
  };

  wrapCurrentShowToast();
  const wrapTimer = window.setInterval(wrapCurrentShowToast, 250);
  window.setTimeout(() => window.clearInterval(wrapTimer), 5000);
  removeSuppressedUpstreamToasts();

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) removeSuppressedUpstreamToasts(node);
      }
    }
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
}

function installStudioSurfacePolicy() {
  if (window[STUDIO_SURFACE_POLICY_KEY]) return;
  window[STUDIO_SURFACE_POLICY_KEY] = true;
  document.documentElement.dataset.studioCanvasproSurface = 'managed';
  installStudioSurfacePolicyStyles();
  installStudioToastPolicy();
}

function installAuthorSignalPolicyStyles() {
  if (document.getElementById(AUTHOR_SIGNAL_POLICY_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = AUTHOR_SIGNAL_POLICY_STYLE_ID;
  style.textContent = `
    #btnTutorial,
    #btnGithubOfficial,
    #btnFeatureFeedback,
    #btnBilibili {
      display: none !important;
    }
    #avatarMenu {
      min-width: 236px;
    }
    #btnAbout .studio-canvaspro-about-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #aboutOverlay {
      position: fixed !important;
      inset: 0 !important;
      align-items: center !important;
      justify-content: center !important;
      background: rgba(0, 0, 0, 0.68) !important;
      z-index: 2147483000 !important;
    }
    #aboutOverlay .about-dialog {
      width: min(420px, calc(100vw - 40px)) !important;
      padding: 28px 28px 24px !important;
      border: 1px solid rgba(255, 255, 255, 0.14) !important;
      border-radius: 16px !important;
      background: rgba(18, 18, 22, 0.98) !important;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.68) !important;
      color: rgba(255, 255, 255, 0.92) !important;
    }
    #aboutOverlay .about-logo {
      display: none !important;
    }
    #aboutOverlay .about-title {
      margin-top: 0 !important;
      color: rgba(255, 255, 255, 0.96) !important;
      font-size: 18px !important;
      line-height: 1.4 !important;
    }
    #aboutOverlay .about-version,
    #aboutOverlay .about-footer,
    #aboutOverlay .about-close {
      color: rgba(255, 255, 255, 0.68) !important;
    }
    #${LICENSE_MODAL_ID} {
      position: fixed !important;
      inset: 0 !important;
      display: none;
      align-items: center !important;
      justify-content: center !important;
      padding: 24px !important;
      background: rgba(0, 0, 0, 0.68) !important;
      z-index: 2147483001 !important;
      box-sizing: border-box !important;
    }
    #${LICENSE_MODAL_ID}[aria-hidden="false"] {
      display: flex !important;
    }
    .studio-canvaspro-license-modal-card {
      position: relative;
      width: min(440px, 100%);
      padding: 28px 28px 24px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 16px;
      background: rgba(18, 18, 22, 0.98);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.68);
      color: rgba(255, 255, 255, 0.92);
      text-align: left;
    }
    .studio-canvaspro-license-modal-title {
      margin: 0 32px 14px 0;
      color: rgba(255, 255, 255, 0.96);
      font-size: 18px;
      font-weight: 700;
      line-height: 1.4;
    }
    .studio-canvaspro-license-modal-close {
      position: absolute;
      top: 16px;
      right: 16px;
      width: 30px;
      height: 30px;
      border: 0;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.72);
      cursor: pointer;
    }
    .studio-canvaspro-license-modal-close:hover {
      background: rgba(255, 255, 255, 0.14);
      color: rgba(255, 255, 255, 0.94);
    }
    .studio-canvaspro-license-disclosure {
      margin: 14px 0 0;
      padding: 12px;
      border: 1px solid var(--stroke-default, rgba(255, 255, 255, 0.12));
      border-radius: 10px;
      background: var(--white-05, rgba(255, 255, 255, 0.05));
      color: var(--text-secondary, rgba(255, 255, 255, 0.72));
      font-size: 13px;
      line-height: 1.65;
      text-align: left;
    }
    .studio-canvaspro-license-disclosure p {
      margin: 0 0 8px;
    }
    .studio-canvaspro-license-disclosure p:last-child {
      margin-bottom: 0;
    }
    .studio-canvaspro-license-disclosure strong {
      color: var(--text-primary, rgba(255, 255, 255, 0.92));
      font-weight: 700;
    }
  `;
  document.head.appendChild(style);
}

function setElementHidden(element) {
  if (!element) return;
  if (!element.hidden) element.hidden = true;
  if (element.getAttribute('aria-hidden') !== 'true') element.setAttribute('aria-hidden', 'true');
  if (element.tabIndex !== -1) element.tabIndex = -1;
}

function isBlockedUpstreamExternalUrl(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (BLOCKED_UPSTREAM_EXTERNAL_URL_PATTERNS.some((pattern) => pattern.test(text))) return true;
  try {
    const url = new URL(text, location.href);
    return BLOCKED_UPSTREAM_EXTERNAL_URL_PATTERNS.some((pattern) => pattern.test(url.href));
  } catch {
    return false;
  }
}

function neutralizeBlockedExternalUrl(element) {
  if (!element) return;
  const url = element.getAttribute('data-external-url') || element.getAttribute('href') || '';
  if (!isBlockedUpstreamExternalUrl(url)) return;
  if (element.dataset && !element.dataset.studioBlockedExternalUrl) {
    element.dataset.studioBlockedExternalUrl = url;
  } else if (!element.getAttribute('data-studio-blocked-external-url')) {
    element.setAttribute('data-studio-blocked-external-url', url);
  }
  element.removeAttribute('data-external-url');
  if (element.tagName === 'A') element.removeAttribute('href');
}

function setButtonLabel(button, label) {
  if (!button || button.dataset.studioCanvasproLabel === label) return;
  const icon = button.querySelector('svg')?.cloneNode(true);
  button.replaceChildren();
  if (icon) button.appendChild(icon);
  const text = document.createElement('span');
  text.className = 'studio-canvaspro-about-label';
  text.textContent = label;
  button.appendChild(text);
  button.setAttribute('aria-label', label);
  button.dataset.studioCanvasproLabel = label;
}

function createDisclosureParagraph(text, strongPrefix = '') {
  const paragraph = document.createElement('p');
  if (strongPrefix) {
    const strong = document.createElement('strong');
    strong.textContent = strongPrefix;
    paragraph.appendChild(strong);
    paragraph.appendChild(document.createTextNode(text));
  } else {
    paragraph.textContent = text;
  }
  return paragraph;
}

function updateAboutDisclosure() {
  const overlay = document.getElementById('aboutOverlay');
  const dialog = overlay?.querySelector('.about-dialog');
  if (!dialog) return;

  const title = dialog.querySelector('.about-title');
  if (title && title.textContent !== AUTHOR_SIGNAL_LABEL) title.textContent = AUTHOR_SIGNAL_LABEL;

  const author = dialog.querySelector('.about-author');
  if (author?.textContent) author.textContent = '';
  setElementHidden(author);

  const upstreamLink = document.getElementById('btnBilibili');
  neutralizeBlockedExternalUrl(upstreamLink);
  setElementHidden(upstreamLink);

  const footer = dialog.querySelector('.about-footer');
  if (footer) {
    footer.textContent = 'CanvasPro is loaded as an external optional component inside MyShell Studio.';
  }

  let disclosure = document.getElementById('studioCanvasproLicenseDisclosure');
  if (!disclosure) {
    disclosure = document.createElement('div');
    disclosure.id = 'studioCanvasproLicenseDisclosure';
    disclosure.className = 'studio-canvaspro-license-disclosure';
    const version = document.getElementById('aboutVersion');
    if (version?.parentElement) {
      version.insertAdjacentElement('afterend', disclosure);
    } else {
      dialog.appendChild(disclosure);
    }
  }

  if (disclosure.dataset.studioCanvasproReady === 'true') return;
  disclosure.replaceChildren(
    createDisclosureParagraph('CanvasPro 以外部可选组件形式接入 Studio。'),
    createDisclosureParagraph(
      ' AI-CanvasPro。版权、许可证和商业授权归其权利方所有；商业、SaaS、打包分发或白标使用需先取得书面授权。',
      '上游项目：',
    ),
    createDisclosureParagraph('Studio 已隐藏上游教程、反馈和仓库跳转入口，避免用户离开当前产品环境。'),
  );
  disclosure.dataset.studioCanvasproReady = 'true';
}

function ensureStudioLicenseModal() {
  let modal = document.getElementById(LICENSE_MODAL_ID);
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = LICENSE_MODAL_ID;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-hidden', 'true');
  modal.setAttribute('aria-labelledby', 'studioCanvasproLicenseModalTitle');

  const card = document.createElement('div');
  card.className = 'studio-canvaspro-license-modal-card';

  const close = document.createElement('button');
  close.type = 'button';
  close.id = 'studioCanvasproLicenseModalClose';
  close.className = 'studio-canvaspro-license-modal-close';
  close.setAttribute('aria-label', '关闭授权声明');
  close.textContent = '×';

  const title = document.createElement('h2');
  title.id = 'studioCanvasproLicenseModalTitle';
  title.className = 'studio-canvaspro-license-modal-title';
  title.textContent = AUTHOR_SIGNAL_LABEL;

  const disclosure = document.createElement('div');
  disclosure.className = 'studio-canvaspro-license-disclosure';
  disclosure.replaceChildren(
    createDisclosureParagraph('CanvasPro 以外部可选组件形式接入 Studio。'),
    createDisclosureParagraph(
      ' AI-CanvasPro。版权、许可证和商业授权归其权利方所有；商业、SaaS、打包分发或白标使用需先取得书面授权。',
      '上游项目：',
    ),
    createDisclosureParagraph('Studio 已隐藏上游教程、反馈和仓库跳转入口，避免用户离开当前产品环境。'),
  );

  card.append(close, title, disclosure);
  modal.appendChild(card);
  document.body.appendChild(modal);
  return modal;
}

function openAboutDisclosure() {
  updateAboutDisclosure();
  const upstreamOverlay = document.getElementById('aboutOverlay');
  if (upstreamOverlay) {
    upstreamOverlay.style.display = 'none';
    upstreamOverlay.setAttribute('aria-hidden', 'true');
  }
  const modal = ensureStudioLicenseModal();
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
}

function closeStudioLicenseModal() {
  const modal = document.getElementById(LICENSE_MODAL_ID);
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
}

function closeAboutDisclosure() {
  closeStudioLicenseModal();
  const overlay = document.getElementById('aboutOverlay');
  if (!overlay) return;
  overlay.style.display = 'none';
  overlay.setAttribute('aria-hidden', 'true');
}

function applyAuthorSignalPolicy() {
  installAuthorSignalPolicyStyles();
  for (const id of HIDDEN_UPSTREAM_MENU_IDS) {
    const element = document.getElementById(id);
    neutralizeBlockedExternalUrl(element);
    setElementHidden(element);
  }
  document.querySelectorAll('[data-external-url], a[href]').forEach((element) => {
    neutralizeBlockedExternalUrl(element);
  });
  setButtonLabel(document.getElementById('btnAbout'), AUTHOR_SIGNAL_LABEL);
  updateAboutDisclosure();
  document.documentElement.dataset.studioCanvasproAuthorSignals = 'hidden';
}

function installAuthorSignalPolicy() {
  if (window[AUTHOR_SIGNAL_POLICY_KEY]) return;
  window[AUTHOR_SIGNAL_POLICY_KEY] = true;
  let policyTimer = null;

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('#btnAbout')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openAboutDisclosure();
        return;
      }
      if (
        target.closest('#studioCanvasproLicenseModalClose') ||
        target === document.getElementById(LICENSE_MODAL_ID) ||
        target.closest('#aboutClose') ||
        target === document.getElementById('aboutOverlay')
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeAboutDisclosure();
        return;
      }
      const trigger = target.closest('[data-external-url], [data-studio-blocked-external-url], a[href]');
      if (!trigger) return;
      const url =
        trigger.getAttribute('data-studio-blocked-external-url') ||
        trigger.getAttribute('data-external-url') ||
        trigger.getAttribute('href') ||
        '';
      if (!isBlockedUpstreamExternalUrl(url)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.showToast?.('请在第三方组件 / 授权声明中查看 CanvasPro 授权边界。', 'warn');
    },
    true,
  );

  const schedulePolicy = () => {
    window.clearTimeout(policyTimer);
    policyTimer = window.setTimeout(applyAuthorSignalPolicy, 50);
  };

  applyAuthorSignalPolicy();
  window.setTimeout(applyAuthorSignalPolicy, 500);
  window.setTimeout(applyAuthorSignalPolicy, 1500);
  new MutationObserver(schedulePolicy).observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function cloneJson(value) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fallback below */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        db.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(ASSET_STORE)) {
        db.createObjectStore(ASSET_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });
  return dbPromise;
}

async function idbPut(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error || new Error(`Failed to write ${storeName}`));
  });
}

async function idbGet(storeName, id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error(`Failed to read ${storeName}`));
  });
}

function getProjectName() {
  return (
    document.getElementById('projectNameText')?.textContent?.trim() ||
    document.getElementById('projectNameEl')?.textContent?.trim() ||
    'AI Canvas'
  );
}

function getProjectId() {
  return String(window.currentProjectId || 'default_v2_project').trim() || 'default_v2_project';
}

function getTaskRegistryStorageKey() {
  return `${TASK_REGISTRY_STORAGE_PREFIX}:${getProjectId()}`;
}

function getTaskRegistryStorage() {
  try {
    return window.sessionStorage || window.localStorage || null;
  } catch {
    return null;
  }
}

function loadStudioTaskRegistry() {
  const projectId = getProjectId();
  if (studioTaskRegistry instanceof Map && studioTaskRegistryProjectId === projectId) return studioTaskRegistry;
  studioTaskRegistry = new Map();
  studioTaskRegistryProjectId = projectId;
  const storage = getTaskRegistryStorage();
  if (!storage) return studioTaskRegistry;
  try {
    const raw = storage.getItem(getTaskRegistryStorageKey());
    const parsed = raw ? JSON.parse(raw) : null;
    const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : Array.isArray(parsed) ? parsed : [];
    for (const task of tasks) {
      if (!isPlainRecord(task)) continue;
      const taskId = String(task.id || '').trim();
      if (!taskId) continue;
      studioTaskRegistry.set(taskId, task);
    }
  } catch {
    studioTaskRegistry.clear();
  }
  return studioTaskRegistry;
}

function persistStudioTaskRegistry() {
  const registry = loadStudioTaskRegistry();
  const storage = getTaskRegistryStorage();
  if (!storage) return;
  try {
    storage.setItem(
      getTaskRegistryStorageKey(),
      JSON.stringify({
        projectId: getProjectId(),
        projectName: getProjectName(),
        updatedAt: new Date().toISOString(),
        tasks: Array.from(registry.values()).slice(0, 48),
      }),
    );
  } catch {
    /* Task snapshots are a convenience layer; the canvas graph remains the source of truth. */
  }
}

function resetStudioTaskRegistry() {
  studioTaskRegistry = new Map();
  studioTaskRegistryProjectId = getProjectId();
  const storage = getTaskRegistryStorage();
  if (!storage) return;
  try {
    storage.removeItem(getTaskRegistryStorageKey());
  } catch {
    /* ignore unavailable browser storage */
  }
}

function getCanvasData({ sanitizeForPersistence = true } = {}) {
  const tabManager = window.CanvasTabManager;
  if (tabManager?.getMultiDataSnapshot) {
    return cloneJson(tabManager.getMultiDataSnapshot({ sanitizeForPersistence }));
  }
  if (graphStore?.serialize) {
    const state = graphStore.serialize();
    return {
      activeCanvasId: 'canvas_1',
      canvases: [
        {
          id: 'canvas_1',
          name: 'Default canvas',
          nodes: Array.isArray(state?.nodes) ? state.nodes : Object.values(state?.nodes || {}),
          edges: Array.isArray(state?.edges) ? state.edges : Object.values(state?.edges || {}),
          viewport: state?.viewport || { x: 0, y: 0, zoom: 1.1 },
          assets: Array.isArray(state?.assets) ? state.assets : [],
        },
      ],
    };
  }
  const state = graphStore?.getState?.() || {};
  return {
    activeCanvasId: 'canvas_1',
    canvases: [
      {
        id: 'canvas_1',
        name: 'Default canvas',
        nodes: Array.isArray(state.nodes) ? state.nodes : Object.values(state.nodes || {}),
        edges: Array.isArray(state.edges) ? state.edges : Object.values(state.edges || {}),
        viewport: state.viewport || { x: 0, y: 0, zoom: 1.1 },
        assets: Array.isArray(state.assets) ? state.assets : [],
      },
    ],
  };
}

function getSnapshotEnvelope() {
  const data = getCanvasData({ sanitizeForPersistence: true });
  const canvases = Array.isArray(data?.canvases) ? data.canvases : [];
  const nodeCount = canvases.reduce((total, canvas) => {
    const nodes = Array.isArray(canvas?.nodes) ? canvas.nodes : Object.values(canvas?.nodes || {});
    return total + nodes.length;
  }, 0);
  const edgeCount = canvases.reduce((total, canvas) => {
    const edges = Array.isArray(canvas?.edges) ? canvas.edges : Object.values(canvas?.edges || {});
    return total + edges.length;
  }, 0);
  return {
    bridgeVersion: BRIDGE_VERSION,
    exportedAt: new Date().toISOString(),
    project: {
      id: getProjectId(),
      name: getProjectName(),
    },
    stats: {
      canvasCount: canvases.length,
      nodeCount,
      edgeCount,
    },
    data,
  };
}

function createBridgeNodeId(nodeType) {
  return `studio-${nodeType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createBridgeEdgeId(sourceId, targetId) {
  return `studio-edge-${sourceId}-${targetId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getCanvasViewport() {
  const state = graphStore?.getState?.() || {};
  const viewport = state.viewport || {};
  return {
    x: Number(viewport.x) || 0,
    y: Number(viewport.y) || 0,
    zoom: Number(viewport.zoom) || 1,
  };
}

function getViewportCenterWorld() {
  const viewport = getCanvasViewport();
  const zoom = Math.max(viewport.zoom || 1, 0.01);
  return {
    x: ((window.innerWidth || 1280) / 2 - viewport.x) / zoom,
    y: ((window.innerHeight || 720) / 2 - viewport.y) / zoom,
  };
}

function getCanvasViewportRect() {
  const visualViewport = window.visualViewport;
  const width = Number(visualViewport?.width) || Number(window.innerWidth) || 1280;
  const height = Number(visualViewport?.height) || Number(window.innerHeight) || 720;
  return {
    left: Number(visualViewport?.offsetLeft) || 0,
    top: Number(visualViewport?.offsetTop) || 0,
    width,
    height,
  };
}

function getGraphNodeIdSet(state = graphStore?.getState?.() || {}) {
  return new Set(
    getGraphNodes(state)
      .map((node) => String(node?.id || '').trim())
      .filter(Boolean),
  );
}

function updateCanvasViewport(viewport) {
  if (!viewport || typeof graphStore?.updateViewport !== 'function') return false;
  const x = Number(viewport.x);
  const y = Number(viewport.y);
  const zoom = Number(viewport.zoom);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom) || zoom <= 0) return false;
  graphStore.updateViewport(x, y, zoom);
  graphStore.markViewportPersist?.();
  graphStore.requestRender?.();
  return true;
}

function ensureReadableNodeViewport(nodeIds, reason = 'node-created') {
  const viewport = getCanvasViewport();
  if (viewport.zoom >= READABLE_NODE_VIEWPORT_MIN_ZOOM) return false;

  const state = graphStore?.getState?.() || {};
  const focusNodes = [...new Set(Array.isArray(nodeIds) ? nodeIds : [])]
    .map((nodeId) => getGraphNodeById(nodeId, state))
    .filter(Boolean);
  if (focusNodes.length === 0) return false;

  const bounds = computeNodesWorldBounds(focusNodes);
  const target = computeViewportForWorldBounds(bounds, getCanvasViewportRect(), {
    padding: READABLE_NODE_VIEWPORT_PADDING,
    minZoom: READABLE_NODE_VIEWPORT_MIN_ZOOM,
    maxZoom: READABLE_NODE_VIEWPORT_MAX_ZOOM,
  });
  if (!target) return false;

  const didUpdate = updateCanvasViewport(target);
  if (didUpdate) scheduleAutosave(`readable-viewport-${reason}`);
  return didUpdate;
}

function scheduleReadableNodeViewport(nodeIds, reason = 'node-created') {
  for (const nodeId of Array.isArray(nodeIds) ? nodeIds : []) {
    const id = String(nodeId || '').trim();
    if (id) readableViewportPendingNodeIds.add(id);
  }
  if (readableViewportPendingNodeIds.size === 0) return;
  window.clearTimeout(readableViewportTimer);
  readableViewportTimer = window.setTimeout(() => {
    const pendingNodeIds = Array.from(readableViewportPendingNodeIds);
    readableViewportPendingNodeIds.clear();
    ensureReadableNodeViewport(pendingNodeIds, reason);
  }, READABLE_NODE_VIEWPORT_DEBOUNCE_MS);
}

function syncReadableNodeViewportPolicy(state = graphStore?.getState?.() || {}) {
  const nextNodeIds = getGraphNodeIdSet(state);
  if (!readableViewportNodeIds) {
    readableViewportNodeIds = nextNodeIds;
    const selectedNodeIds = Array.isArray(state.selectedNodeIds) ? state.selectedNodeIds.map(String) : [];
    const allNodeIds = Array.from(nextNodeIds);
    const initialFocusNodeIds = selectedNodeIds.length > 0 ? selectedNodeIds : allNodeIds.length <= 6 ? allNodeIds : [];
    if (initialFocusNodeIds.length > 0) scheduleReadableNodeViewport(initialFocusNodeIds, 'initial-canvas');
    return;
  }

  const createdNodeIds = Array.from(nextNodeIds).filter((nodeId) => !readableViewportNodeIds.has(nodeId));
  readableViewportNodeIds = nextNodeIds;
  if (createdNodeIds.length > 0) scheduleReadableNodeViewport(createdNodeIds, 'node-created');
}

function getQuickCreateNodeSize(nodeType) {
  if (nodeType === 'source-text') return { width: 420, height: 260 };
  try {
    const fallback = getAIGenerationDefaultSizeByType(nodeType);
    const normalized = getAIGenerationNodeSize(fallback.width, fallback.height);
    return {
      width: Number(normalized?.width || fallback?.width) || 420,
      height: Number(normalized?.height || fallback?.height) || 520,
    };
  } catch {
    return { width: 420, height: 520 };
  }
}

function getFileExtension(file) {
  const match = String(file?.name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return match ? match[1] : '';
}

function getImportMediaKind(file) {
  const mime = String(file?.type || '').toLowerCase();
  const ext = getFileExtension(file);
  if (mime.startsWith('image/') || MEDIA_IMPORT_SUPPORTED_EXTENSIONS.image.includes(ext)) return 'image';
  if (mime.startsWith('video/') || MEDIA_IMPORT_SUPPORTED_EXTENSIONS.video.includes(ext)) return 'video';
  if (mime.startsWith('audio/') || MEDIA_IMPORT_SUPPORTED_EXTENSIONS.audio.includes(ext)) return 'audio';
  return '';
}

function getImportedMediaDisplayName(file) {
  const rawName = String(file?.name || '').trim();
  const baseName = rawName.replace(/\.[^/.]+$/, '').trim();
  return compactText(baseName || rawName || '上传素材', '上传素材');
}

function constrainImportedMediaSize(kind, width, height) {
  const fallback = MEDIA_IMPORT_DEFAULT_SIZES[kind] || MEDIA_IMPORT_DEFAULT_SIZES.image;
  const naturalWidth = Math.max(0, Number(width) || 0);
  const naturalHeight = Math.max(0, Number(height) || 0);
  if (naturalWidth <= 0 || naturalHeight <= 0) return fallback;
  const shortSide = kind === 'video' ? 220 : 240;
  const scale = shortSide / Math.min(naturalWidth, naturalHeight);
  return {
    width: Math.max(160, Math.round(naturalWidth * scale)),
    height: Math.max(120, Math.round(naturalHeight * scale)),
  };
}

function waitForImageMetadata(url) {
  return new Promise((resolve) => {
    const image = new Image();
    const done = () => {
      window.clearTimeout(timer);
      resolve({
        height: Number(image.naturalHeight) || 0,
        width: Number(image.naturalWidth) || 0,
      });
    };
    const timer = window.setTimeout(() => resolve({ width: 0, height: 0 }), 2500);
    image.onload = done;
    image.onerror = () => {
      window.clearTimeout(timer);
      resolve({ width: 0, height: 0 });
    };
    image.src = url;
  });
}

function waitForVideoMetadata(url) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeAttribute('src');
      video.load?.();
    };
    const done = () => {
      cleanup();
      resolve({
        duration: Number(video.duration) || 0,
        height: Number(video.videoHeight) || 0,
        width: Number(video.videoWidth) || 0,
      });
    };
    const timer = window.setTimeout(() => {
      cleanup();
      resolve({ width: 0, height: 0, duration: 0 });
    }, 2500);
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = done;
    video.onerror = () => {
      cleanup();
      resolve({ width: 0, height: 0, duration: 0 });
    };
    video.src = url;
  });
}

async function getImportedMediaMetadata(kind, url) {
  if (kind === 'image') return await waitForImageMetadata(url);
  if (kind === 'video') return await waitForVideoMetadata(url);
  return { width: 0, height: 0, duration: 0 };
}

function buildImportedMediaNode(file, kind, url, index, origin) {
  const metadata = origin?.metadata || {};
  const size = constrainImportedMediaSize(kind, metadata.width, metadata.height);
  const nodeType = MEDIA_IMPORT_NODE_TYPES[kind];
  const id = createBridgeNodeId(nodeType);
  const x = origin.x + index * (MEDIA_IMPORT_DEFAULT_SIZES.image.width + 56);
  const y = origin.y;
  const common = {
    id,
    type: nodeType,
    x,
    y,
    width: size.width,
    height: size.height,
    name: getImportedMediaDisplayName(file),
    fileName: String(file?.name || ''),
    mimeType: String(file?.type || ''),
    size: Number(file?.size) || 0,
    src: url,
    localPath: '',
    needsAutoResize: false,
    studioUploadedAsset: {
      fileName: String(file?.name || ''),
      importedAt: new Date().toISOString(),
      kind,
      mimeType: String(file?.type || ''),
      size: Number(file?.size) || 0,
    },
  };
  if (kind === 'image') {
    return {
      ...common,
      displayUrl: url,
      imageHeight: Number(metadata.height) || 0,
      imageUrl: url,
      imageWidth: Number(metadata.width) || 0,
      naturalHeight: Number(metadata.height) || 0,
      naturalWidth: Number(metadata.width) || 0,
      originalUrl: url,
    };
  }
  if (kind === 'video') {
    return {
      ...common,
      duration: Number(metadata.duration) || 0,
      posterUrl: '',
      videoDuration: Number(metadata.duration) || 0,
      videoHeight: Number(metadata.height) || 0,
      videoUrl: url,
      videoWidth: Number(metadata.width) || 0,
    };
  }
  return {
    ...common,
    audioUrl: url,
    fixedSize: true,
  };
}

async function importMediaFiles(payload = {}) {
  if (typeof graphStore?.addNode !== 'function') throw new Error('Canvas runtime is not ready');
  const rawFiles = Array.isArray(payload.files) ? payload.files : payload.file ? [payload.file] : [];
  const files = rawFiles.filter((file) => file && typeof file === 'object');
  if (!files.length) throw new Error('No media files selected');

  const accepted = [];
  const skipped = [];
  for (const file of files) {
    const kind = getImportMediaKind(file);
    if (!kind) {
      skipped.push(String(file?.name || 'unknown'));
      continue;
    }
    if (accepted.length < MEDIA_IMPORT_MAX_FILES) {
      accepted.push({ file, kind });
    } else {
      skipped.push(String(file?.name || 'unknown'));
    }
  }
  if (!accepted.length) {
    throw new Error('请选择图片、视频或音频文件');
  }

  const center = getViewportCenterWorld();
  const origin = {
    x: center.x - ((accepted.length - 1) * (MEDIA_IMPORT_DEFAULT_SIZES.image.width + 56)) / 2 - MEDIA_IMPORT_DEFAULT_SIZES.image.width / 2,
    y: center.y - MEDIA_IMPORT_DEFAULT_SIZES.image.height / 2,
  };
  const createdNodes = [];

  for (let index = 0; index < accepted.length; index += 1) {
    const { file, kind } = accepted[index];
    const url = URL.createObjectURL(file);
    const metadata = await getImportedMediaMetadata(kind, url);
    const node = buildImportedMediaNode(file, kind, url, index, { ...origin, metadata });
    createdNodes.push(node);
    void idbPut(ASSET_STORE, {
      id: `${getProjectId()}:upload:${node.id}`,
      blob: file,
      fileName: node.fileName,
      kind,
      mime: node.mimeType || 'application/octet-stream',
      savedAt: new Date().toISOString(),
      size: node.size,
      source: url,
    }).catch(() => {});
  }

  if (typeof graphStore?.batch === 'function') {
    graphStore.batch(() => {
      createdNodes.forEach((node) => graphStore.addNode(node));
      graphStore.setSelectedNodes?.(createdNodes.map((node) => node.id));
    });
  } else {
    createdNodes.forEach((node) => graphStore.addNode(node));
    graphStore.setSelectedNodes?.(createdNodes.map((node) => node.id));
  }
  commit();
  if (typeof window.v2FocusOnNodes === 'function') {
    window.v2FocusOnNodes(createdNodes.map((node) => node.id), 80, 420, READABLE_NODE_FOCUS_OPTIONS);
  } else {
    focusBridgeNode(createdNodes[0]?.id);
  }
  scheduleAutosave('import-media-files');
  const kindLabels = createdNodes.map((node) => (getNodeMediaKind(node) === 'video' ? '视频' : getNodeMediaKind(node) === 'image' ? '图片' : '音频'));
  window.showToast?.(`已上传 ${createdNodes.length} 个素材`, 'success');

  return {
    imported: createdNodes.length,
    kindLabels,
    nodeIds: createdNodes.map((node) => node.id),
    nodes: createdNodes.map((node) => ({
      fileName: node.fileName,
      id: node.id,
      kind: getNodeMediaKind(node) || 'audio',
      nodeType: node.type,
    })),
    selected: (graphStore.getState?.().selectedNodeIds || []).map(String),
    skipped,
    stats: getSnapshotEnvelope().stats,
  };
}

function getGraphNodes(state = graphStore?.getState?.() || {}) {
  if (Array.isArray(state.nodes)) return state.nodes.filter(Boolean);
  return Object.values(state.nodes || {}).filter(Boolean);
}

function getGraphEdges(state = graphStore?.getState?.() || {}) {
  if (Array.isArray(state.edges)) return state.edges.filter(Boolean);
  return Object.values(state.edges || {}).filter(Boolean);
}

function getGraphNodeById(nodeId, state = graphStore?.getState?.() || {}) {
  const id = String(nodeId || '');
  if (!id) return null;
  return getGraphNodes(state).find((node) => String(node?.id || '') === id) || null;
}

function getGenerationTaskNode(payload = {}) {
  const state = graphStore?.getState?.() || {};
  const nodeId = String(payload.nodeId || '').trim();
  if (nodeId) {
    const node = getGraphNodeById(nodeId, state);
    if (node) return node;
  }
  const taskId = String(payload.taskId || payload.id || '').trim();
  if (!taskId) return null;
  return getGraphNodes(state).find((node) => String(node?.studioTask?.id || '') === taskId) || null;
}

function getGenerationTaskId(value = {}) {
  return String(value?.taskId || value?.id || value?.studioTask?.id || '').trim();
}

function buildGenerationTaskSnapshotFromNode(node) {
  if (!isPlainRecord(node?.studioTask)) return null;
  const mediaKind = node.studioTask.kind || getNodeMediaKind(node);
  const sourceNodeIds = Array.isArray(node.studioTask.sourceNodeIds) ? node.studioTask.sourceNodeIds : [];
  return {
    ...node.studioTask,
    missingNode: false,
    nodeDeletedAt: '',
    nodeId: String(node?.id || ''),
    nodeName: String(node?.name || ''),
    nodeType: String(node?.type || ''),
    prompt: String(node?.prompt || node?.studioTask?.prompt || ''),
    settings: normalizeStudioTaskSettings(
      mediaKind,
      node?.studioTask?.settings || {
        aspectRatio: node?.studioAspectRatio,
        durationSeconds: node?.durationSeconds,
        mode: node?.studioMode,
        model: node?.studioModel,
        outputCount: node?.outputCount,
        quality: node?.studioQuality,
        resolution: node?.studioResolution,
      },
      sourceNodeIds,
    ),
  };
}

function upsertGenerationTaskSnapshot(task, options = {}) {
  if (!isPlainRecord(task)) return null;
  const taskId = getGenerationTaskId(task);
  if (!taskId) return null;
  const registry = loadStudioTaskRegistry();
  const existing = registry.get(taskId) || {};
  const now = new Date().toISOString();
  const sourceNodeIds = Array.isArray(task.sourceNodeIds)
    ? task.sourceNodeIds
    : Array.isArray(existing.sourceNodeIds)
      ? existing.sourceNodeIds
      : [];
  const kind = String(task.kind || existing.kind || 'generation');
  const missingNode = Boolean(options.missingNode ?? task.missingNode ?? false);
  const snapshot = {
    ...existing,
    ...task,
    id: taskId,
    kind,
    missingNode,
    nodeDeletedAt: missingNode ? String(task.nodeDeletedAt || existing.nodeDeletedAt || now) : '',
    nodeId: String(task.nodeId ?? existing.nodeId ?? ''),
    nodeName: String(task.nodeName ?? existing.nodeName ?? ''),
    nodeType: String(task.nodeType ?? existing.nodeType ?? ''),
    prompt: String(task.prompt ?? existing.prompt ?? ''),
    settings: normalizeStudioTaskSettings(kind, task.settings || existing.settings || {}, sourceNodeIds),
    sourceNodeIds: sourceNodeIds.map(String).filter(Boolean),
    updatedAt: String(task.updatedAt || existing.updatedAt || now),
  };
  registry.set(taskId, snapshot);
  persistStudioTaskRegistry();
  return snapshot;
}

function getRegisteredGenerationTask(payload = {}) {
  const taskId = getGenerationTaskId(payload);
  if (!taskId) return null;
  return loadStudioTaskRegistry().get(taskId) || null;
}

function removeRegisteredGenerationTask(taskId) {
  const id = String(taskId || '').trim();
  if (!id) return false;
  const registry = loadStudioTaskRegistry();
  const removed = registry.delete(id);
  if (removed) persistStudioTaskRegistry();
  return removed;
}

function getNodeMediaKind(node) {
  const type = String(node?.type || '').trim().toLowerCase();
  if (!type) return '';
  if (type.includes('video')) return 'video';
  if (type.includes('image') || type.includes('photo')) return 'image';
  return '';
}

function getEdgeSourceId(edge) {
  return String(edge?.sourceId || edge?.sourceNodeId || edge?.srcId || '');
}

function getEdgeTargetId(edge) {
  return String(edge?.targetId || edge?.targetNodeId || edge?.dstId || '');
}

function getIncomingBridgeEdges(nodeId) {
  const targetId = String(nodeId || '');
  const slotOrder = new Map([
    ['reference', 0],
    ['firstFrame', 0],
    ['lastFrame', 1],
    ['sourceVideo', 2],
  ]);
  return getGraphEdges()
    .filter((edge) => getEdgeTargetId(edge) === targetId && getEdgeSourceId(edge))
    .sort((a, b) => {
      const aSlot = slotOrder.get(String(a?.refSlot || '')) ?? 10;
      const bSlot = slotOrder.get(String(b?.refSlot || '')) ?? 10;
      return aSlot - bSlot;
    });
}

function dedupeNonEmpty(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function normalizeGenerationInputValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  if (/^data:/i.test(text)) return text;
  if (/^file:/i.test(text)) return text;
  if (/^[a-z]:\\/i.test(text) || text.startsWith('/Users/') || text.startsWith('~/')) return text;
  if (text.startsWith('/')) {
    try {
      return new URL(text, location.origin).href;
    } catch {
      return text;
    }
  }
  return '';
}

function getNodeAssetValue(node, kind = '') {
  if (!node) return '';
  const mediaKind = kind || getNodeMediaKind(node);
  const keys = mediaKind === 'video'
    ? ['videoUrl', 'src', 'originalUrl', 'displayUrl', 'fileUrl', 'sourceUrl', 'url', 'localPath', 'originalLocalPath']
    : ['displayUrl', 'imageUrl', 'originalUrl', 'src', 'fileUrl', 'sourceUrl', 'url', 'localPath', 'originalLocalPath'];
  for (const key of keys) {
    const value = String(node?.[key] || '').trim();
    if (value) return value;
  }
  const refs = collectAssetRefs(node);
  const firstFetchable = refs.find((ref) => ref.fetchable && !String(ref.source || '').startsWith('blob:'));
  if (firstFetchable?.source) return firstFetchable.source;
  return refs[0]?.source || '';
}

async function readNodeSourceAssetBlob(sourceNode, rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return null;
  if (/^data:/i.test(value)) {
    const { bytes, mime } = dataUrlToBytes(value);
    return new Blob([bytes], { type: mime });
  }
  if (/^blob:/i.test(value)) {
    try {
      const response = await fetch(value);
      if (response.ok) return await response.blob();
    } catch {
      /* fallback to IndexedDB below */
    }
    const asset = await idbGet(ASSET_STORE, `${getProjectId()}:upload:${sourceNode?.id || ''}`).catch(() => null);
    if (asset?.blob instanceof Blob) return asset.blob;
  }
  return null;
}

function getStagedSourcePatch(sourceNode, kind, mediaUrl, rawValue, result) {
  const localMediaUrl = String(result.localUrl || result.mediaUrl || '');
  const remoteMediaUrl = String(result.remoteMediaUrl || '');
  const preferredUrl = String(result.preferredUrl || remoteMediaUrl || localMediaUrl || mediaUrl);
  const common = {
    localUrl: String(rawValue || ''),
    src: preferredUrl,
    studioStagedAsset: {
      fileName: String(result.fileName || sourceNode?.fileName || ''),
      localMediaUrl,
      mediaUrl: preferredUrl,
      mimeType: String(result.mimeType || sourceNode?.mimeType || ''),
      preferredUrl,
      remoteMediaUrl,
      remoteStatus: String(result.remoteUpload?.status || ''),
      size: Number(result.size) || Number(sourceNode?.size) || 0,
      stagedAt: String(result.storedAt || new Date().toISOString()),
    },
  };
  if (kind === 'video') {
    return {
      ...common,
      videoUrl: preferredUrl,
    };
  }
  if (kind === 'image') {
    return {
      ...common,
      displayUrl: preferredUrl,
      imageUrl: preferredUrl,
      originalUrl: preferredUrl,
    };
  }
  return {
    ...common,
    audioUrl: preferredUrl,
  };
}

async function stageCanvasProSourceAsset(sourceNode, kind, rawValue) {
  const existing = String(
    sourceNode?.studioStagedAsset?.preferredUrl ||
      sourceNode?.studioStagedAsset?.remoteMediaUrl ||
      sourceNode?.studioStagedAsset?.mediaUrl ||
      '',
  ).trim();
  if (existing) return { mediaUrl: existing, reused: true };
  const blob = await readNodeSourceAssetBlob(sourceNode, rawValue);
  if (!blob) return null;

  const formData = new FormData();
  const extension = kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'png';
  const fileName = String(sourceNode?.fileName || sourceNode?.name || `canvaspro-source.${extension}`).trim();
  formData.append('file', blob, fileName);
  formData.append('upload_remote', 'true');
  const response = await fetch('/api/studio/canvaspro/source-assets', {
    method: 'POST',
    body: formData,
    credentials: 'same-origin',
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if (!response.ok) {
    const message = isPlainRecord(result) ? String(result.detail || result.message || '') : '';
    throw new Error(message || `CanvasPro source asset upload returned ${response.status}`);
  }
  const mediaUrl = String(result.preferredUrl || result.remoteMediaUrl || result.mediaUrl || result.url || '').trim();
  if (!mediaUrl) throw new Error('CanvasPro source asset upload did not return a media URL');
  if (sourceNode?.id) {
    updateBridgeNodeData(sourceNode.id, getStagedSourcePatch(sourceNode, kind, mediaUrl, rawValue, result));
  }
  const remoteReady = Boolean(result.remoteMediaUrl || result.remoteUpload?.ready);
  return { mediaUrl, remoteReady, result, reused: false };
}

async function buildGenerationSourceInputs(taskNode, task = {}, options = {}) {
  const taskNodeId = String(taskNode?.id || '');
  const explicitSourceIds = Array.isArray(task?.sourceNodeIds) ? task.sourceNodeIds : [];
  const incomingEdges = getIncomingBridgeEdges(taskNodeId);
  const edgeSourceIds = incomingEdges.map(getEdgeSourceId);
  const sourceIds = dedupeNonEmpty([...explicitSourceIds, ...edgeSourceIds]);
  const nodesById = new Map(getGraphNodes().map((node) => [String(node?.id || ''), node]));
  const stageBrowserAssets = options.stageBrowserAssets === true;
  const inputs = [];
  for (let index = 0; index < sourceIds.length; index += 1) {
    const sourceId = sourceIds[index];
    const sourceNode = nodesById.get(sourceId) || null;
    const mediaKind = getNodeMediaKind(sourceNode);
    const rawValue = getNodeAssetValue(sourceNode, mediaKind);
    let inputValue = normalizeGenerationInputValue(rawValue);
    const edge = incomingEdges.find((item) => getEdgeSourceId(item) === sourceId);
    const browserOnly = /^blob:/i.test(rawValue);
    let status = inputValue ? 'ready' : browserOnly ? 'browser_only' : rawValue ? 'unsupported' : 'missing';
    if (stageBrowserAssets && sourceNode && (/^(blob|data):/i.test(rawValue) || browserOnly)) {
      const staged = await stageCanvasProSourceAsset(sourceNode, mediaKind, rawValue);
      if (staged?.mediaUrl) {
        inputValue = normalizeGenerationInputValue(staged.mediaUrl);
        status = staged.remoteReady ? 'remote' : staged.reused ? 'ready' : 'staged';
      }
    }
    inputs.push({
      index: index + 1,
      inputValue,
      kind: mediaKind || 'unknown',
      nodeId: sourceId,
      nodeName: compactText(sourceNode?.name || sourceNode?.fileName || sourceNode?.prompt || sourceId, sourceId),
      refSlot: String(edge?.refSlot || ''),
      status,
      value: rawValue,
    });
  }
  return inputs;
}

function getSelectedSourceNode() {
  return getSelectedSourceNodes({ max: 1 })[0] || null;
}

function getSelectedSourceNodes(options = {}) {
  const state = graphStore?.getState?.() || {};
  const selectedIds = Array.isArray(state.selectedNodeIds) ? state.selectedNodeIds.map(String) : [];
  if (selectedIds.length === 0) return [];
  const max = Math.max(1, Math.min(Number(options.max) || 1, 6));
  const allowedKinds = new Set(Array.isArray(options.mediaKinds) ? options.mediaKinds : ['image', 'video']);
  const nodesById = new Map(getGraphNodes(state).map((node) => [String(node?.id || ''), node]));
  const selectedNodes = [];
  for (const selectedId of selectedIds) {
    const node = nodesById.get(selectedId);
    const mediaKind = getNodeMediaKind(node);
    if (node && allowedKinds.has(mediaKind)) selectedNodes.push(node);
    if (selectedNodes.length >= max) break;
  }
  return selectedNodes;
}

function getSelectedVideoSourceNodes() {
  const selectedSources = getSelectedSourceNodes({ max: 6 });
  const firstVideo = selectedSources.find((node) => getNodeMediaKind(node) === 'video');
  if (firstVideo) return [firstVideo];
  return selectedSources.filter((node) => getNodeMediaKind(node) === 'image').slice(0, 2);
}

function getSelectedReferenceNodes() {
  const state = graphStore?.getState?.() || {};
  const selectedIds = Array.isArray(state.selectedNodeIds) ? state.selectedNodeIds.map(String) : [];
  if (selectedIds.length === 0) return [];
  const nodesById = new Map(getGraphNodes(state).map((node) => [String(node?.id || ''), node]));
  return selectedIds
    .map((selectedId) => nodesById.get(selectedId))
    .filter((node) => node && String(node.type || '') !== 'group')
    .slice(0, 6);
}

function getQuickCreatePosition(node, width, height) {
  if (!node) {
    const center = getViewportCenterWorld();
    return {
      x: center.x - width / 2,
      y: center.y - height / 2,
    };
  }
  const sourceX = Number(node.x) || 0;
  const sourceY = Number(node.y) || 0;
  const sourceWidth = Number(node.width) || 420;
  return {
    x: sourceX + sourceWidth + 96,
    y: sourceY,
  };
}

function getNodeRect(node, fallback = {}) {
  const width = Number(node?.width) || Number(fallback.width) || 420;
  const height = Number(node?.height) || Number(fallback.height) || 520;
  return {
    x: Number(node?.x) || 0,
    y: Number(node?.y) || 0,
    width,
    height,
    right: (Number(node?.x) || 0) + width,
    bottom: (Number(node?.y) || 0) + height,
  };
}

function parseAspectRatio(value) {
  const match = String(value || '').match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return 16 / 9;
  const width = Number(match[1]) || 16;
  const height = Number(match[2]) || 9;
  return width > 0 && height > 0 ? width / height : 16 / 9;
}

function getGenerationOutputNodeSize(kind, task = {}, output = {}) {
  const width = Number(output.width || output.imageWidth || output.videoWidth) || 0;
  const height = Number(output.height || output.imageHeight || output.videoHeight) || 0;
  if (width > 0 && height > 0) {
    return constrainImportedMediaSize(kind, width, height);
  }
  const settings = isPlainRecord(task.settings) ? task.settings : {};
  const ratio = parseAspectRatio(settings.aspectRatio);
  if (kind === 'image' && ratio < 1) {
    const nodeWidth = 220;
    return {
      width: nodeWidth,
      height: Math.max(220, Math.round(nodeWidth / Math.max(ratio, 0.1))),
    };
  }
  const nodeHeight = kind === 'video' ? 180 : 220;
  return {
    width: Math.max(220, Math.round(nodeHeight * ratio)),
    height: nodeHeight,
  };
}

function getOutputMediaUrl(output) {
  return String(output?.mediaUrl || output?.url || '').trim();
}

function getGenerationOutputKind(task, taskNode, output) {
  const outputKind = String(output?.kind || '').trim().toLowerCase();
  if (outputKind === 'video' || outputKind === 'image') return outputKind;
  const taskKind = String(task?.kind || '').trim().toLowerCase();
  if (taskKind === 'video' || taskKind === 'image') return taskKind;
  return getNodeMediaKind(taskNode) === 'video' ? 'video' : 'image';
}

function findGenerationOutput(task, payload = {}) {
  const outputs = Array.isArray(task?.outputs) ? task.outputs.filter(isPlainRecord) : [];
  if (!outputs.length) return null;
  const outputId = String(payload.outputId || '').trim();
  if (outputId) {
    const byId = outputs.find((output) => String(output.id || '') === outputId);
    if (byId) return byId;
  }
  const outputIndex = Number(payload.outputIndex || payload.index) || 0;
  if (outputIndex > 0) {
    const byIndex = outputs.find((output, index) => (Number(output.index) || index + 1) === outputIndex);
    if (byIndex) return byIndex;
  }
  return outputs.find((output) => getOutputMediaUrl(output)) || outputs[0] || null;
}

function findMaterializedOutputNode(taskNode, output, state = graphStore?.getState?.() || {}) {
  const outputNodeId = String(output?.nodeId || output?.assetNodeId || '').trim();
  if (outputNodeId) {
    const node = getGraphNodeById(outputNodeId, state);
    if (node) return node;
  }
  const taskId = String(taskNode?.studioTask?.id || '');
  const sourceNodeId = String(taskNode?.id || '');
  const outputId = String(output?.id || '');
  if (!outputId) return null;
  return getGraphNodes(state).find((node) => {
    const generated = isPlainRecord(node?.studioGeneratedOutput) ? node.studioGeneratedOutput : {};
    return (
      String(generated.outputId || '') === outputId &&
      (!taskId || String(generated.taskId || '') === taskId) &&
      (!sourceNodeId || String(generated.sourceNodeId || '') === sourceNodeId)
    );
  }) || null;
}

function hasBridgeEdge(sourceId, targetId, refSlot = '') {
  const source = String(sourceId || '');
  const target = String(targetId || '');
  const slot = String(refSlot || '');
  return getGraphEdges().some((edge) => {
    const edgeSource = String(edge?.sourceId || edge?.sourceNodeId || edge?.srcId || '');
    const edgeTarget = String(edge?.targetId || edge?.targetNodeId || edge?.dstId || '');
    const edgeSlot = String(edge?.refSlot || '');
    return edgeSource === source && edgeTarget === target && (!slot || edgeSlot === slot);
  });
}

function buildGenerationOutputNode(taskNode, task, output, kind, mediaUrl) {
  const outputIndex = Number(output.index) || 1;
  const nodeType = kind === 'video' ? 'source-video' : 'source-image';
  const id = createBridgeNodeId(nodeType);
  const taskRect = getNodeRect(taskNode, getQuickCreateNodeSize(kind === 'video' ? 'ai-video' : 'ai-image'));
  const size = getGenerationOutputNodeSize(kind, task, output);
  const x = taskRect.right + 96;
  const y = taskRect.y + (outputIndex - 1) * (size.height + 40);
  const createdAt = new Date().toISOString();
  const common = {
    id,
    type: nodeType,
    parentId: String(taskNode?.parentId || ''),
    x,
    y,
    width: size.width,
    height: size.height,
    name: `${kind === 'video' ? '视频' : '图像'}结果 ${outputIndex}`,
    fileName: `generation-output-${outputIndex}.${kind === 'video' ? 'mp4' : 'png'}`,
    mimeType: kind === 'video' ? 'video/mp4' : 'image/png',
    src: mediaUrl,
    needsAutoResize: false,
    studioGeneratedOutput: {
      kind,
      materializedAt: createdAt,
      outputId: String(output.id || ''),
      outputIndex,
      sourceNodeId: String(taskNode?.id || ''),
      taskId: String(task?.id || ''),
    },
  };
  if (kind === 'video') {
    return {
      ...common,
      duration: Number(output.duration || task?.settings?.durationSeconds) || 0,
      posterUrl: String(output.posterUrl || ''),
      videoDuration: Number(output.duration || task?.settings?.durationSeconds) || 0,
      videoHeight: Number(output.height || output.videoHeight) || 0,
      videoUrl: mediaUrl,
      videoWidth: Number(output.width || output.videoWidth) || 0,
    };
  }
  return {
    ...common,
    displayUrl: mediaUrl,
    imageHeight: Number(output.height || output.imageHeight) || 0,
    imageUrl: mediaUrl,
    imageWidth: Number(output.width || output.imageWidth) || 0,
    naturalHeight: Number(output.height || output.imageHeight) || 0,
    naturalWidth: Number(output.width || output.imageWidth) || 0,
    originalUrl: mediaUrl,
  };
}

function patchGenerationOutputNodeId(taskNode, output, outputNodeId) {
  const task = isPlainRecord(taskNode?.studioTask) ? taskNode.studioTask : {};
  const outputId = String(output?.id || '');
  const outputIndex = Number(output?.index) || 0;
  const updatedAt = new Date().toISOString();
  const outputs = (Array.isArray(task.outputs) ? task.outputs : []).map((item, index) => {
    if (!isPlainRecord(item)) return item;
    const sameId = outputId && String(item.id || '') === outputId;
    const sameIndex = !outputId && outputIndex > 0 && (Number(item.index) || index + 1) === outputIndex;
    if (!sameId && !sameIndex) return item;
    return {
      ...item,
      materializedAt: String(item.materializedAt || updatedAt),
      nodeId: outputNodeId,
      updatedAt,
    };
  });
  const studioTask = {
    ...task,
    outputs,
    updatedAt,
  };
  updateBridgeNodeData(taskNode.id, { studioTask });
  upsertGenerationTaskSnapshot(
    {
      ...studioTask,
      nodeId: String(taskNode.id || ''),
      nodeName: String(taskNode.name || ''),
      nodeType: String(taskNode.type || ''),
      prompt: String(taskNode.prompt || studioTask.prompt || ''),
    },
    { missingNode: false },
  );
  return studioTask;
}

function updateBridgeNodeData(nodeId, patch) {
  const id = String(nodeId || '');
  if (!id) throw new Error('Canvas runtime cannot update an empty node id');
  if (typeof graphStore?.updateNodeData === 'function') {
    graphStore.updateNodeData(id, patch);
    return true;
  }
  const state = graphStore?.getState?.() || {};
  if (Array.isArray(state.nodes)) {
    const index = state.nodes.findIndex((node) => String(node?.id || '') === id);
    if (index >= 0) {
      state.nodes[index] = { ...state.nodes[index], ...patch };
      return true;
    }
  } else if (state.nodes?.[id]) {
    state.nodes[id] = { ...state.nodes[id], ...patch };
    return true;
  }
  throw new Error('Canvas runtime cannot update existing nodes');
}

function focusBridgeNode(nodeId) {
  if (!nodeId) return;
  try {
    if (typeof window.v2FocusOnNode === 'function') {
      window.v2FocusOnNode(nodeId, 80, 420, READABLE_NODE_FOCUS_OPTIONS);
      return;
    }
    if (typeof window.v2FocusOnNodes === 'function') {
      window.v2FocusOnNodes([nodeId], 80, 420, READABLE_NODE_FOCUS_OPTIONS);
    }
  } catch {
    /* focusing is only a convenience */
  }
}

function compactText(value, fallback = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > 64 ? `${text.slice(0, 61)}...` : text;
}

function getDefaultStudioTaskResolution(kind) {
  return kind === 'video' ? '1080P' : '2K';
}

function getDefaultStudioTaskAspectRatio(kind) {
  return kind === 'video' ? '16:9' : '9:16';
}

function getDefaultStudioTaskMode(kind, sourceNodeIds = []) {
  if (kind === 'video') return sourceNodeIds.length > 0 ? 'image-to-video' : 'text-to-video';
  return sourceNodeIds.length > 0 ? 'reference-to-image' : 'text-to-image';
}

function getDefaultStudioTaskModel(kind) {
  return kind === 'video' ? 'wan-2.2' : 'doubao-seedream-5.0-lite';
}

const STUDIO_TASK_MODEL_VALUES = Object.freeze({
  image: ['doubao-seedream-5.0-lite', 'image-pro', 'image-fast', 'auto'],
  video: ['wan-2.2', 'video-pro', 'video-fast', 'auto'],
});

function getStudioTaskModelValues(kind) {
  return STUDIO_TASK_MODEL_VALUES[kind === 'video' ? 'video' : 'image'];
}

function getNextStudioTaskModel(kind, currentModel) {
  const mediaKind = kind === 'video' ? 'video' : 'image';
  const values = getStudioTaskModelValues(mediaKind);
  const current = values.includes(String(currentModel || ''))
    ? String(currentModel)
    : getDefaultStudioTaskModel(mediaKind);
  const currentIndex = values.indexOf(current);
  return values[(currentIndex + 1) % values.length] || getDefaultStudioTaskModel(mediaKind);
}

function resolveRerunStudioTaskModel(kind, currentModel, payload = {}) {
  const mediaKind = kind === 'video' ? 'video' : 'image';
  const values = getStudioTaskModelValues(mediaKind);
  const requested = String(payload.model || '').trim();
  if (requested && values.includes(requested)) return requested;
  const action = String(payload.action || payload.mode || payload.strategy || 'same').trim().toLowerCase();
  if (['model', 'next-model', 'change-model', 'switch-model'].includes(action)) {
    return getNextStudioTaskModel(mediaKind, currentModel);
  }
  return values.includes(String(currentModel || '')) ? String(currentModel) : getDefaultStudioTaskModel(mediaKind);
}

function getStudioTaskAspectRatioLabel(value) {
  return value && value !== 'auto' ? String(value) : '自适应';
}

function normalizeStudioTaskResolution(kind, value) {
  const mediaKind = kind === 'video' ? 'video' : 'image';
  const normalized = String(value || '').trim().toUpperCase();
  const allowed = mediaKind === 'video'
    ? new Set(['720P', '1080P'])
    : new Set(['2K', '3K']);
  return allowed.has(normalized) ? normalized : getDefaultStudioTaskResolution(mediaKind);
}

function estimateStudioTaskCost(kind, settings = {}) {
  const mediaKind = kind === 'video' ? 'video' : 'image';
  const outputCount = Math.max(1, Math.min(Number(settings.outputCount) || 1, 4));
  const resolution = normalizeStudioTaskResolution(mediaKind, settings.resolution);
  if (mediaKind === 'video') {
    const durationSeconds = Math.max(2, Math.min(Number(settings.durationSeconds) || 5, 12));
    const durationBlocks = Math.max(1, Math.ceil(durationSeconds / 5));
    const perBlock = resolution === '1080P' ? 50 : 35;
    const credits = perBlock * durationBlocks * outputCount;
    return { credits, label: `约 ${credits} 点`, unit: 'credits' };
  }
  const perOutput = resolution === '3K' ? 8 : 5;
  const credits = perOutput * outputCount;
  return { credits, label: `约 ${credits} 点`, unit: 'credits' };
}

function normalizeStudioTaskSettings(kind, value = {}, sourceNodeIds = []) {
  const mediaKind = kind === 'video' ? 'video' : 'image';
  const settings = isPlainRecord(value) ? value : {};
  const allowedAspectRatios = new Set(['auto', '1:1', '9:16', '16:9', '4:3', '3:4', '3:2', '2:3', '21:9']);
  const aspectRatio = allowedAspectRatios.has(String(settings.aspectRatio || ''))
    ? String(settings.aspectRatio)
    : getDefaultStudioTaskAspectRatio(mediaKind);
  const allowedModes = mediaKind === 'video'
    ? new Set(['text-to-video', 'image-to-video'])
    : new Set(['text-to-image', 'reference-to-image']);
  const defaultMode = getDefaultStudioTaskMode(mediaKind, sourceNodeIds);
  const mode = allowedModes.has(String(settings.mode || '')) ? String(settings.mode) : defaultMode;
  const allowedModels = new Set(getStudioTaskModelValues(mediaKind));
  const model = allowedModels.has(String(settings.model || ''))
    ? String(settings.model)
    : getDefaultStudioTaskModel(mediaKind);
  const allowedQuality = new Set(['fast', 'balanced', 'high']);
  const quality = allowedQuality.has(String(settings.quality || '')) ? String(settings.quality) : 'balanced';
  const outputCount = Math.max(1, Math.min(Number(settings.outputCount) || 1, 4));
  const durationSeconds = mediaKind === 'video'
    ? Math.max(2, Math.min(Number(settings.durationSeconds) || 5, 12))
    : 0;
  const resolution = normalizeStudioTaskResolution(mediaKind, settings.resolution);
  return {
    aspectRatio,
    durationSeconds,
    mode,
    model,
    outputCount,
    quality,
    resolution,
  };
}

function getStudioTaskNodePatch(studioTask) {
  const mediaKind = studioTask?.kind === 'video' ? 'video' : 'image';
  const settings = normalizeStudioTaskSettings(
    mediaKind,
    isPlainRecord(studioTask?.settings) ? studioTask.settings : {},
    Array.isArray(studioTask?.sourceNodeIds) ? studioTask.sourceNodeIds : [],
  );
  return {
    aspectRatio: getStudioTaskAspectRatioLabel(settings.aspectRatio),
    durationSeconds: settings.durationSeconds,
    outputCount: settings.outputCount,
    studioAspectRatio: settings.aspectRatio,
    studioMode: settings.mode,
    studioModel: settings.model,
    studioQuality: settings.quality,
    studioResolution: settings.resolution,
  };
}

function normalizeStudioTaskOutputs(kind, settings = {}, existingOutputs = [], submittedAt = '', online = false) {
  const mediaKind = kind === 'video' ? 'video' : 'image';
  const normalizedSettings = normalizeStudioTaskSettings(mediaKind, settings);
  const count = Math.max(1, Math.min(Number(normalizedSettings.outputCount) || 1, 4));
  const existingByIndex = new Map(
    (Array.isArray(existingOutputs) ? existingOutputs : [])
      .filter(isPlainRecord)
      .map((output, index) => [Number(output.index) || index + 1, output]),
  );
  return Array.from({ length: count }, (_, index) => {
    const outputIndex = index + 1;
    const existing = existingByIndex.get(outputIndex) || {};
    const mediaUrl = String(existing.mediaUrl || existing.url || '');
    const status = mediaUrl
      ? 'done'
      : ['pending', 'running', 'done', 'error', 'waiting_service'].includes(String(existing.status || ''))
      ? String(existing.status)
      : online
      ? 'pending'
      : 'waiting_service';
    return {
      id: String(existing.id || `studio-output-${Date.now()}-${outputIndex}-${Math.random().toString(36).slice(2, 6)}`),
      index: outputIndex,
      kind: mediaKind,
      label: mediaUrl ? '已生成' : online ? '等待结果' : '待连接服务',
      mediaUrl,
      posterUrl: String(existing.posterUrl || ''),
      status,
      createdAt: String(existing.createdAt || submittedAt || new Date().toISOString()),
      updatedAt: String(existing.updatedAt || submittedAt || new Date().toISOString()),
    };
  });
}

function mergeStudioTaskOutputs(existingOutputs = [], incomingOutputs = []) {
  const existingByIndex = new Map(
    (Array.isArray(existingOutputs) ? existingOutputs : [])
      .filter(isPlainRecord)
      .map((output, index) => [Number(output.index) || index + 1, output]),
  );
  return (Array.isArray(incomingOutputs) ? incomingOutputs : []).filter(isPlainRecord).map((output, index) => {
    const outputIndex = Number(output.index) || index + 1;
    const existing = existingByIndex.get(outputIndex) || {};
    return {
      ...existing,
      ...output,
      id: String(output.id || existing.id || `studio-output-${Date.now()}-${outputIndex}-${Math.random().toString(36).slice(2, 6)}`),
      index: outputIndex,
      materializedAt: String(output.materializedAt || existing.materializedAt || ''),
      nodeId: String(output.nodeId || existing.nodeId || ''),
    };
  });
}

async function submitStudioGenerationTask(payload = {}) {
  const response = await fetch('/api/studio/canvaspro/generation-tasks', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    credentials: 'same-origin',
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if (!response.ok) {
    const message = isPlainRecord(result)
      ? String(result.message || result.detail || '')
      : '';
    throw new Error(message || `CanvasPro generation task API returned ${response.status}`);
  }
  return isPlainRecord(result) ? result : {};
}

async function syncStudioGenerationTask(payload = {}) {
  const response = await fetch('/api/studio/canvaspro/generation-tasks/sync', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    credentials: 'same-origin',
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if (!response.ok) {
    const message = isPlainRecord(result)
      ? String(result.message || result.detail || '')
      : '';
    throw new Error(message || `CanvasPro generation sync API returned ${response.status}`);
  }
  return isPlainRecord(result) ? result : {};
}

function createStudioTask(kind, prompt, sourceNodeIds = []) {
  const createdAt = new Date().toISOString();
  const online = apiReachable !== false;
  const taskKind = String(kind || 'generation');
  const settings = normalizeStudioTaskSettings(taskKind, {}, sourceNodeIds);
  const executor = {
    provider: 'myshell-art-cli',
    capabilityId: 'myshell-art-cli.dreamy-generate',
    atom: 'dreamy-generate',
    mode: 'draft',
  };
  return {
    id: `studio-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: taskKind,
    status: online ? 'queued' : 'draft',
    label: online ? '等待生成' : '离线草稿',
    progress: online ? 5 : 0,
    prompt: compactText(prompt, ''),
    costEstimate: estimateStudioTaskCost(taskKind, settings),
    executor,
    settings,
    sourceNodeIds: sourceNodeIds.map(String).filter(Boolean),
    createdAt,
    updatedAt: createdAt,
  };
}

function shouldExecuteStudioGeneration(payload = {}) {
  if (payload.execute !== true) return false;
  try {
    return window.localStorage?.getItem('myshell-studio-canvaspro-dry-run') !== '1';
  } catch {
    return true;
  }
}

function getGenerationTasks(payload = {}) {
  const limit = Math.max(1, Math.min(Number(payload.limit) || 8, 24));
  const state = graphStore?.getState?.() || {};
  const graphNodes = getGraphNodes(state);
  const nodeIdSet = new Set(graphNodes.map((node) => String(node?.id || '')).filter(Boolean));
  const nodeTasks = graphNodes
    .map(buildGenerationTaskSnapshotFromNode)
    .filter(Boolean)
    .map((task) => upsertGenerationTaskSnapshot(task, { missingNode: false }) || task);
  const nodeTaskIds = new Set(nodeTasks.map((task) => getGenerationTaskId(task)).filter(Boolean));
  const now = new Date().toISOString();
  const registry = loadStudioTaskRegistry();
  let registryChanged = false;
  const detachedTasks = [];
  for (const [taskId, task] of registry.entries()) {
    if (nodeTaskIds.has(taskId)) continue;
    const nodeId = String(task.nodeId || '');
    const hasNode = Boolean(nodeId && nodeIdSet.has(nodeId));
    const missingNode = !hasNode;
    const nextTask = {
      ...task,
      missingNode,
      nodeDeletedAt: missingNode ? String(task.nodeDeletedAt || now) : '',
    };
    if (task.missingNode !== nextTask.missingNode || task.nodeDeletedAt !== nextTask.nodeDeletedAt) {
      registry.set(taskId, nextTask);
      registryChanged = true;
    }
    detachedTasks.push(nextTask);
  }
  if (registryChanged) persistStudioTaskRegistry();
  const tasks = [...nodeTasks, ...detachedTasks]
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, limit);
  return {
    apiReachable,
    stats: getSnapshotEnvelope().stats,
    tasks,
  };
}

function focusGenerationTask(payload = {}) {
  const node = getGenerationTaskNode(payload);
  if (!node) {
    const task = getRegisteredGenerationTask(payload);
    if (!task) throw new Error('生成任务不存在或已从队列移除');
    const missingTask = upsertGenerationTaskSnapshot(
      {
        ...task,
        missingNode: true,
      },
      { missingNode: true },
    );
    return {
      apiReachable,
      message: '关联节点已删除，可恢复到画布',
      missingNode: true,
      selected: false,
      stats: getSnapshotEnvelope().stats,
      task: missingTask || task,
    };
  }
  const nodeId = String(node.id || '');
  const task = buildGenerationTaskSnapshotFromNode(node);
  if (task) upsertGenerationTaskSnapshot(task, { missingNode: false });
  graphStore?.setSelectedNodes?.([nodeId]);
  focusBridgeNode(nodeId);
  return {
    apiReachable,
    nodeId,
    selected: (graphStore.getState?.().selectedNodeIds || []).map(String).includes(nodeId),
    stats: getSnapshotEnvelope().stats,
    task: task || undefined,
  };
}

async function updateGenerationTask(payload = {}) {
  const node = getGenerationTaskNode(payload);
  if (!node) throw new Error('Generation task node was not found');
  const nodeId = String(node.id || '');
  const mediaKind = getNodeMediaKind(node);
  if (!mediaKind) throw new Error('Only image and video generation nodes can be updated');

  const prompt = String(payload.prompt ?? node.prompt ?? '').trim();
  const existingTask = isPlainRecord(node.studioTask)
    ? node.studioTask
    : createStudioTask(mediaKind, prompt, []);
  const sourceInputs = await buildGenerationSourceInputs(node, existingTask, { stageBrowserAssets: false });
  const sourceNodeIds = dedupeNonEmpty([
    ...(Array.isArray(existingTask.sourceNodeIds) ? existingTask.sourceNodeIds : []),
    ...sourceInputs.map((source) => source.nodeId),
  ]);
  const updatedAt = new Date().toISOString();
  const studioTask = {
    ...existingTask,
    kind: String(existingTask.kind || mediaKind),
    prompt: compactText(prompt, ''),
    settings: normalizeStudioTaskSettings(mediaKind, {
      ...(isPlainRecord(existingTask.settings) ? existingTask.settings : {}),
      ...(isPlainRecord(payload.settings) ? payload.settings : {}),
    }, sourceNodeIds),
    sourceInputs,
    sourceNodeIds,
    updatedAt,
  };
  studioTask.costEstimate = estimateStudioTaskCost(mediaKind, studioTask.settings);

  updateBridgeNodeData(nodeId, {
    aspectRatio: getStudioTaskAspectRatioLabel(studioTask.settings.aspectRatio),
    durationSeconds: studioTask.settings.durationSeconds,
    outputCount: studioTask.settings.outputCount,
    prompt,
    studioAspectRatio: studioTask.settings.aspectRatio,
    studioMode: studioTask.settings.mode,
    studioModel: studioTask.settings.model,
    studioQuality: studioTask.settings.quality,
    studioResolution: studioTask.settings.resolution,
    studioTask,
  });
  const taskSnapshot = upsertGenerationTaskSnapshot(
    {
      ...studioTask,
      nodeId,
      nodeName: String(node.name || ''),
      nodeType: String(node.type || ''),
      prompt,
    },
    { missingNode: false },
  );
  graphStore?.setSelectedNodes?.([nodeId]);
  commit();
  focusBridgeNode(nodeId);
  scheduleAutosave('update-generation-task');
  window.showToast?.('已更新生成任务', 'success');

  return {
    apiReachable,
    nodeId,
    prompt,
    selected: (graphStore.getState?.().selectedNodeIds || []).map(String).includes(nodeId),
    stats: getSnapshotEnvelope().stats,
    task: {
      ...(taskSnapshot || studioTask),
      nodeId,
      nodeName: String(node.name || ''),
      nodeType: String(node.type || ''),
      prompt,
    },
  };
}

async function submitGenerationTask(payload = {}) {
  const node = getGenerationTaskNode(payload);
  if (!node) throw new Error('Generation task node was not found');
  const nodeId = String(node.id || '');
  const mediaKind = getNodeMediaKind(node);
  if (!mediaKind) throw new Error('Only image and video generation nodes can be submitted');

  const prompt = String(payload.prompt ?? node.prompt ?? '').trim();
  const existingTask = isPlainRecord(node.studioTask)
    ? node.studioTask
    : createStudioTask(mediaKind, prompt, []);
  const settings = normalizeStudioTaskSettings(mediaKind, {
    ...(isPlainRecord(existingTask.settings) ? existingTask.settings : {}),
    ...(isPlainRecord(payload.settings) ? payload.settings : {}),
  }, existingTask.sourceNodeIds || []);
  const sourceInputs = await buildGenerationSourceInputs(node, existingTask, { stageBrowserAssets: true });
  const sourceNodeIds = dedupeNonEmpty([
    ...(Array.isArray(existingTask.sourceNodeIds) ? existingTask.sourceNodeIds : []),
    ...sourceInputs.map((source) => source.nodeId),
  ]);
  const inputValues = sourceInputs.map((source) => source.inputValue).filter(Boolean);
  const execute = shouldExecuteStudioGeneration(payload);
  const executor = {
    provider: 'myshell-art-cli',
    capabilityId: 'myshell-art-cli.dreamy-generate',
    atom: 'dreamy-generate',
    ...(isPlainRecord(existingTask.executor) ? existingTask.executor : {}),
    ...(isPlainRecord(payload.executor) ? payload.executor : {}),
  };
  const updatedAt = new Date().toISOString();
  const online = apiReachable !== false;
  let backendTask = null;
  let backendMessage = '';
  try {
    const backendResult = await submitStudioGenerationTask({
      kind: mediaKind,
      nodeId,
      prompt,
      settings,
      sourceInputs,
      sourceNodeIds,
      inputValues,
      execute,
      taskId: existingTask.id,
      executor,
    });
    backendTask = isPlainRecord(backendResult.task) ? backendResult.task : null;
    backendMessage = String(backendResult.message || '');
  } catch (error) {
    backendMessage = error?.message || String(error);
  }
  const backendSettings = normalizeStudioTaskSettings(
    mediaKind,
    isPlainRecord(backendTask?.settings) ? backendTask.settings : settings,
    sourceNodeIds,
  );
  const outputs = Array.isArray(backendTask?.outputs) && backendTask.outputs.length
    ? backendTask.outputs
    : normalizeStudioTaskOutputs(mediaKind, backendSettings, existingTask.outputs || [], updatedAt, online);
  const backendStatus = String(backendTask?.status || '');
  const taskStatus = backendStatus || (online ? 'queued' : 'ready');
  const studioTask = {
    ...existingTask,
    ...(backendTask || {}),
    backendMessage,
    costEstimate: isPlainRecord(backendTask?.costEstimate)
      ? backendTask.costEstimate
      : estimateStudioTaskCost(mediaKind, backendSettings),
    executor: isPlainRecord(backendTask?.executor) ? backendTask.executor : executor,
    kind: String(existingTask.kind || mediaKind),
    label: String(backendTask?.label || (online ? '已加入队列' : '待连接服务')),
    outputs,
    progress: Number(backendTask?.progress) || (online ? Math.max(Number(existingTask.progress) || 0, 10) : 0),
    prompt: compactText(prompt || existingTask.prompt || '', ''),
    settings: backendSettings,
    sourceInputs,
    sourceNodeIds,
    status: taskStatus,
    submittedAt: String(backendTask?.submittedAt || updatedAt),
    updatedAt: String(backendTask?.updatedAt || updatedAt),
  };

  updateBridgeNodeData(nodeId, {
    aspectRatio: getStudioTaskAspectRatioLabel(backendSettings.aspectRatio),
    durationSeconds: backendSettings.durationSeconds,
    outputCount: backendSettings.outputCount,
    prompt,
    studioAspectRatio: backendSettings.aspectRatio,
    studioMode: backendSettings.mode,
    studioModel: backendSettings.model,
    studioQuality: backendSettings.quality,
    studioResolution: backendSettings.resolution,
    studioTask,
  });
  const materializedOutputs = [];
  for (const output of outputs) {
    if (!getOutputMediaUrl(output)) continue;
    try {
      materializedOutputs.push(
        materializeGenerationOutput(
          { nodeId, outputId: output.id, outputIndex: output.index },
          { select: false, toast: false },
        ),
      );
    } catch {
      /* output materialization is best-effort; the task output still remains available */
    }
  }
  const latestNode = getGraphNodeById(nodeId) || node;
  const latestStudioTask = isPlainRecord(latestNode?.studioTask) ? latestNode.studioTask : studioTask;
  const taskSnapshot = upsertGenerationTaskSnapshot(
    {
      ...latestStudioTask,
      nodeId,
      nodeName: String(latestNode.name || node.name || ''),
      nodeType: String(latestNode.type || node.type || ''),
      prompt,
    },
    { missingNode: false },
  );
  if (payload.focus !== false) graphStore?.setSelectedNodes?.([nodeId]);
  commit();
  if (payload.focus !== false) focusBridgeNode(nodeId);
  scheduleAutosave('submit-generation-task');
  const submitToast =
    studioTask.status === 'done'
      ? 'CLI 已返回结果'
      : studioTask.status === 'running'
        ? '已通过 CLI 提交生成'
        : studioTask.status === 'auth_missing'
          ? 'CLI 凭证未就绪'
          : studioTask.status === 'ready'
            ? '已保存，等待 CLI 配置'
            : online
              ? '已加入生成队列'
              : '已保存，等待本地服务';
  if (payload.toast !== false) {
    window.showToast?.(
      `${submitToast}${materializedOutputs.length ? `，${materializedOutputs.length} 个结果已落画布` : ''}`,
      studioTask.status === 'ready' ? 'warn' : online ? 'success' : 'warn',
    );
  }

  return {
    apiReachable,
    nodeId,
    prompt,
    selected: (graphStore.getState?.().selectedNodeIds || []).map(String).includes(nodeId),
    stats: getSnapshotEnvelope().stats,
    task: {
      ...(taskSnapshot || latestStudioTask),
      nodeId,
      nodeName: String(latestNode.name || node.name || ''),
      nodeType: String(latestNode.type || node.type || ''),
      prompt,
    },
  };
}

async function syncGenerationTask(payload = {}) {
  const node = getGenerationTaskNode(payload);
  if (!node) throw new Error('Generation task node was not found');
  const nodeId = String(node.id || '');
  const mediaKind = getNodeMediaKind(node);
  if (!mediaKind) throw new Error('Only image and video generation nodes can be synced');

  const existingTask = isPlainRecord(node.studioTask)
    ? node.studioTask
    : createStudioTask(mediaKind, node.prompt || '', []);
  const settings = normalizeStudioTaskSettings(
    mediaKind,
    {
      ...(isPlainRecord(existingTask.settings) ? existingTask.settings : {}),
      ...(isPlainRecord(payload.settings) ? payload.settings : {}),
    },
    existingTask.sourceNodeIds || [],
  );
  const syncResult = await syncStudioGenerationTask({
    externalTaskId: payload.externalTaskId || existingTask.externalTaskId,
    kind: mediaKind,
    nodeId,
    prompt: String(payload.prompt ?? node.prompt ?? existingTask.prompt ?? '').trim(),
    settings,
    task: existingTask,
    taskId: existingTask.id,
  });
  const backendTask = isPlainRecord(syncResult.task) ? syncResult.task : {};
  const syncedSettings = normalizeStudioTaskSettings(
    mediaKind,
    isPlainRecord(backendTask.settings) ? backendTask.settings : settings,
    backendTask.sourceNodeIds || existingTask.sourceNodeIds || [],
  );
  const outputs = mergeStudioTaskOutputs(existingTask.outputs || [], backendTask.outputs || []);
  const studioTask = {
    ...existingTask,
    ...backendTask,
    backendMessage: String(syncResult.message || backendTask.backendMessage || existingTask.backendMessage || ''),
    costEstimate: isPlainRecord(backendTask.costEstimate)
      ? backendTask.costEstimate
      : estimateStudioTaskCost(mediaKind, syncedSettings),
    kind: mediaKind,
    outputs,
    settings: syncedSettings,
    sourceInputs: Array.isArray(backendTask.sourceInputs) ? backendTask.sourceInputs : existingTask.sourceInputs || [],
    sourceNodeIds: Array.isArray(backendTask.sourceNodeIds) ? backendTask.sourceNodeIds : existingTask.sourceNodeIds || [],
    status: String(backendTask.status || syncResult.status || existingTask.status || 'ready'),
    updatedAt: String(backendTask.updatedAt || new Date().toISOString()),
  };
  const prompt = String(backendTask.prompt || payload.prompt || node.prompt || existingTask.prompt || '').trim();
  updateBridgeNodeData(nodeId, {
    aspectRatio: getStudioTaskAspectRatioLabel(studioTask.settings.aspectRatio),
    durationSeconds: studioTask.settings.durationSeconds,
    outputCount: studioTask.settings.outputCount,
    prompt,
    studioAspectRatio: studioTask.settings.aspectRatio,
    studioMode: studioTask.settings.mode,
    studioModel: studioTask.settings.model,
    studioQuality: studioTask.settings.quality,
    studioResolution: studioTask.settings.resolution,
    studioTask,
  });
  const taskSnapshot = upsertGenerationTaskSnapshot(
    {
      ...studioTask,
      nodeId,
      nodeName: String(node.name || ''),
      nodeType: String(node.type || ''),
      prompt,
    },
    { missingNode: false },
  );

  const materializedOutputs = [];
  if (payload.materialize !== false) {
    for (const output of outputs) {
      if (!getOutputMediaUrl(output)) continue;
      try {
        materializedOutputs.push(
          materializeGenerationOutput(
            { nodeId, outputId: output.id, outputIndex: output.index },
            { select: false, toast: false },
          ),
        );
      } catch {
        /* task sync should not fail just because a result node could not be created */
      }
    }
  }
  if (payload.focus !== false) graphStore?.setSelectedNodes?.([nodeId]);
  commit();
  if (payload.focus !== false) focusBridgeNode(nodeId);
  scheduleAutosave('sync-generation-task');
  if (payload.toast !== false) {
    window.showToast?.(
      materializedOutputs.length
        ? `已同步生成任务，${materializedOutputs.length} 个结果已落画布`
        : '已同步生成任务',
      studioTask.status === 'error' || studioTask.status === 'auth_missing' ? 'warn' : 'success',
    );
  }

  return {
    apiReachable,
    materializedOutputs,
    nodeId,
    prompt,
    selected: (graphStore.getState?.().selectedNodeIds || []).map(String).includes(nodeId),
    stats: getSnapshotEnvelope().stats,
    syncedAt: String(syncResult.syncedAt || studioTask.updatedAt || ''),
    task: {
      ...(taskSnapshot || studioTask),
      nodeId,
      nodeName: String(node.name || ''),
      nodeType: String(node.type || ''),
      prompt,
    },
  };
}

function materializeGenerationOutput(payload = {}, options = {}) {
  if (typeof graphStore?.addNode !== 'function') throw new Error('Canvas runtime is not ready');
  if (typeof graphStore?.addEdge !== 'function') throw new Error('Canvas runtime cannot connect generated outputs');

  const taskNode = getGenerationTaskNode(payload);
  if (!taskNode) throw new Error('Generation task node was not found');
  const nodeId = String(taskNode.id || '');
  const task = isPlainRecord(taskNode.studioTask) ? taskNode.studioTask : {};
  const output = findGenerationOutput(task, payload);
  if (!output) throw new Error('Generation task output was not found');

  const mediaUrl = getOutputMediaUrl(output);
  if (!mediaUrl) throw new Error('生成结果还没有媒体 URL，暂时不能落到画布');

  const outputKind = getGenerationOutputKind(task, taskNode, output);
  const state = graphStore?.getState?.() || {};
  let outputNode = findMaterializedOutputNode(taskNode, output, state);
  let created = false;
  let edgeId = '';
  const refSlot = 'generatedOutput';

  if (!outputNode) {
    outputNode = buildGenerationOutputNode(taskNode, task, output, outputKind, mediaUrl);
    created = true;
  }
  if (!hasBridgeEdge(nodeId, outputNode.id, refSlot)) {
    edgeId = createBridgeEdgeId(nodeId, outputNode.id);
  }

  const selectResult = options.select !== false;
  const run = () => {
    if (created) graphStore.addNode(outputNode);
    if (edgeId) {
      graphStore.addEdge({
        id: edgeId,
        sourceId: nodeId,
        targetId: outputNode.id,
        refSlot,
      });
    }
    patchGenerationOutputNodeId(taskNode, output, outputNode.id);
    if (selectResult) graphStore.setSelectedNodes?.([outputNode.id]);
  };
  if (typeof graphStore?.batch === 'function') {
    graphStore.batch(run);
  } else {
    run();
  }

  commit();
  if (selectResult) focusBridgeNode(outputNode.id);
  scheduleAutosave(created ? 'materialize-generation-output' : 'focus-generation-output');
  if (options.toast !== false) {
    window.showToast?.(created ? '已将生成结果落到画布' : '已定位生成结果', 'success');
  }

  return {
    apiReachable,
    created,
    edgeId,
    nodeId,
    outputId: String(output.id || ''),
    outputIndex: Number(output.index) || 1,
    outputKind,
    outputNodeId: outputNode.id,
    selected: (graphStore.getState?.().selectedNodeIds || []).map(String).includes(outputNode.id),
    stats: getSnapshotEnvelope().stats,
  };
}

async function continueGenerationOutput(payload = {}) {
  const taskNode = getGenerationTaskNode(payload);
  if (!taskNode) throw new Error('Generation task node was not found');
  const task = isPlainRecord(taskNode.studioTask) ? taskNode.studioTask : {};
  const prompt = String(payload.prompt ?? task.prompt ?? taskNode.prompt ?? '').trim();
  const action = String(payload.action || payload.continuation || 'video').trim().toLowerCase();
  if (!['video', 'variants', 'reference'].includes(action)) {
    throw new Error('Unsupported CanvasPro generation output continuation action');
  }

  const materialized = materializeGenerationOutput(payload, { select: true, toast: false });
  const continuation =
    action === 'variants'
      ? createVariants({ prompt, source: 'selected' })
      : await createNode({
          kind: action === 'reference' ? 'note' : 'video',
          prompt,
          source: 'selected',
        });
  const label =
    action === 'variants'
      ? '已从生成结果创建三版变体'
      : action === 'reference'
        ? '已从生成结果创建引用说明'
        : '已从生成结果接续视频';
  window.showToast?.(label, 'success');

  return {
    action,
    apiReachable,
    continuation,
    materialized,
    outputNodeId: materialized.outputNodeId,
    stats: getSnapshotEnvelope().stats,
  };
}

function getRerunGenerationTaskPosition(taskNode, nodeType) {
  const size = getQuickCreateNodeSize(nodeType);
  const sourceRect = getNodeRect(taskNode, size);
  const existingForks = getGraphNodes().filter((node) => {
    const rerunOf = isPlainRecord(node?.studioTask?.rerunOf) ? node.studioTask.rerunOf : {};
    return String(rerunOf.sourceNodeId || '') === String(taskNode?.id || '');
  }).length;
  return {
    x: sourceRect.x,
    y: sourceRect.bottom + 80 + existingForks * (size.height + 48),
  };
}

function getRerunGenerationSourceEdges(sourceNodeIds, incomingEdges, targetId, targetKind) {
  const nodesById = new Map(getGraphNodes().map((node) => [String(node?.id || ''), node]));
  let imageVideoRefIndex = 0;
  return sourceNodeIds
    .map((sourceId) => {
      const sourceNode = nodesById.get(String(sourceId || ''));
      if (!sourceNode) return null;
      const existingEdge = incomingEdges.find((edge) => getEdgeSourceId(edge) === String(sourceId));
      const sourceMediaKind = getNodeMediaKind(sourceNode);
      let refSlot = String(existingEdge?.refSlot || '');
      if (!refSlot) {
        if (targetKind === 'video') {
          refSlot = sourceMediaKind === 'video' ? 'sourceVideo' : imageVideoRefIndex === 0 ? 'firstFrame' : 'lastFrame';
          if (sourceMediaKind !== 'video') imageVideoRefIndex += 1;
        } else {
          refSlot = 'reference';
        }
      }
      return {
        id: createBridgeEdgeId(sourceId, targetId),
        sourceId,
        targetId,
        refSlot,
      };
    })
    .filter(Boolean);
}

function rerunGenerationTask(payload = {}) {
  if (typeof graphStore?.addNode !== 'function') throw new Error('Canvas runtime is not ready');
  if (typeof graphStore?.addEdge !== 'function') throw new Error('Canvas runtime cannot connect rerun inputs');

  const taskNode = getGenerationTaskNode(payload);
  if (!taskNode) throw new Error('Generation task node was not found');
  const sourceNodeId = String(taskNode.id || '');
  const mediaKind = getNodeMediaKind(taskNode);
  if (!mediaKind) throw new Error('Only image and video generation nodes can be rerun');

  const existingTask = isPlainRecord(taskNode.studioTask)
    ? taskNode.studioTask
    : createStudioTask(mediaKind, taskNode.prompt || '', []);
  const incomingEdges = getIncomingBridgeEdges(sourceNodeId);
  const sourceNodeIds = dedupeNonEmpty([
    ...(Array.isArray(existingTask.sourceNodeIds) ? existingTask.sourceNodeIds : []),
    ...incomingEdges.map(getEdgeSourceId),
  ]);
  const prompt = String(payload.prompt ?? taskNode.prompt ?? existingTask.prompt ?? '').trim();
  const baseSettings = normalizeStudioTaskSettings(
    mediaKind,
    {
      ...(isPlainRecord(existingTask.settings) ? existingTask.settings : {}),
      ...(isPlainRecord(payload.settings) ? payload.settings : {}),
    },
    sourceNodeIds,
  );
  const nextModel = resolveRerunStudioTaskModel(mediaKind, baseSettings.model, payload);
  const settings = normalizeStudioTaskSettings(mediaKind, { ...baseSettings, model: nextModel }, sourceNodeIds);
  const action = String(payload.action || payload.mode || 'same').trim().toLowerCase();
  const switchedModel = nextModel !== baseSettings.model;
  const nodeType = mediaKind === 'video' ? 'ai-video' : 'ai-image';
  const { width, height } = getQuickCreateNodeSize(nodeType);
  const position = getRerunGenerationTaskPosition(taskNode, nodeType);
  const id = createBridgeNodeId(nodeType);
  const createdAt = new Date().toISOString();
  const output = findGenerationOutput(existingTask, payload);
  const baseTask = createStudioTask(mediaKind, prompt, sourceNodeIds);
  const studioTask = {
    ...baseTask,
    executor: {
      ...(isPlainRecord(baseTask.executor) ? baseTask.executor : {}),
      ...(isPlainRecord(existingTask.executor) ? existingTask.executor : {}),
      mode: 'draft',
    },
    kind: mediaKind,
    label: switchedModel ? '换模型草稿' : '重跑草稿',
    outputs: [],
    progress: 0,
    prompt: compactText(prompt, ''),
    rerunOf: {
      action: switchedModel ? 'model' : action || 'same',
      outputId: String(output?.id || payload.outputId || ''),
      outputIndex: Number(output?.index || payload.outputIndex || 0) || 0,
      previousModel: String(baseSettings.model || ''),
      sourceNodeId,
      sourceTaskId: String(existingTask.id || ''),
    },
    settings,
    sourceNodeIds,
    status: 'draft',
    updatedAt: createdAt,
  };
  studioTask.costEstimate = estimateStudioTaskCost(mediaKind, studioTask.settings);

  const node = {
    id,
    type: nodeType,
    parentId: String(taskNode?.parentId || ''),
    x: position.x,
    y: position.y,
    width,
    height,
    name: switchedModel
      ? `${mediaKind === 'video' ? '视频' : '图像'}换模型`
      : `${mediaKind === 'video' ? '视频' : '图像'}重跑`,
    prompt,
    needsAutoResize: true,
    ...getStudioTaskNodePatch(studioTask),
    studioTask,
  };
  const edges = getRerunGenerationSourceEdges(sourceNodeIds, incomingEdges, id, mediaKind);

  if (typeof graphStore?.batch === 'function') {
    graphStore.batch(() => {
      graphStore.addNode(node);
      edges.forEach((edge) => graphStore.addEdge(edge));
      graphStore.setSelectedNodes?.([id]);
    });
  } else {
    graphStore.addNode(node);
    edges.forEach((edge) => graphStore.addEdge(edge));
    graphStore.setSelectedNodes?.([id]);
  }
  commit();
  focusBridgeNode(id);
  const taskSnapshot = upsertGenerationTaskSnapshot(
    {
      ...studioTask,
      nodeId: id,
      nodeName: node.name,
      nodeType,
      prompt,
    },
    { missingNode: false },
  );
  scheduleAutosave(switchedModel ? 'rerun-generation-task-with-model' : 'rerun-generation-task');
  window.showToast?.(switchedModel ? '已创建换模型重跑任务' : '已复用参数创建重跑任务', 'success');

  return {
    action: switchedModel ? 'model' : action || 'same',
    apiReachable,
    edgeIds: edges.map((edge) => edge.id),
    model: settings.model,
    nodeId: id,
    nodeType,
    previousModel: String(baseSettings.model || ''),
    prompt,
    selected: (graphStore.getState?.().selectedNodeIds || []).map(String).includes(id),
    sourceNodeId,
    stats: getSnapshotEnvelope().stats,
    task: {
      ...(taskSnapshot || studioTask),
      nodeId: id,
      nodeName: node.name,
      nodeType,
      prompt,
    },
  };
}

function getRestoredGenerationTaskPosition(width, height) {
  const center = getViewportCenterWorld();
  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
  };
}

function restoreGenerationTaskNode(payload = {}) {
  if (typeof graphStore?.addNode !== 'function') throw new Error('Canvas runtime is not ready');

  const existingNode = getGenerationTaskNode(payload);
  if (existingNode) {
    const nodeId = String(existingNode.id || '');
    const task = buildGenerationTaskSnapshotFromNode(existingNode);
    const taskSnapshot = task ? upsertGenerationTaskSnapshot(task, { missingNode: false }) : task;
    graphStore?.setSelectedNodes?.([nodeId]);
    focusBridgeNode(nodeId);
    return {
      apiReachable,
      edgeIds: [],
      nodeId,
      restored: false,
      selected: (graphStore.getState?.().selectedNodeIds || []).map(String).includes(nodeId),
      stats: getSnapshotEnvelope().stats,
      task: taskSnapshot || task || undefined,
    };
  }

  const task = getRegisteredGenerationTask(payload);
  if (!task) throw new Error('生成任务快照不存在，无法恢复到画布');

  const mediaKind = task.kind === 'video' ? 'video' : 'image';
  const nodeType = mediaKind === 'video' ? 'ai-video' : 'ai-image';
  const { width, height } = getQuickCreateNodeSize(nodeType);
  const position = getRestoredGenerationTaskPosition(width, height);
  const nodeId = createBridgeNodeId(nodeType);
  const now = new Date().toISOString();
  const sourceNodeIds = (Array.isArray(task.sourceNodeIds) ? task.sourceNodeIds : [])
    .map(String)
    .filter((sourceNodeId) => sourceNodeId && getGraphNodeById(sourceNodeId));
  const settings = normalizeStudioTaskSettings(mediaKind, task.settings || {}, sourceNodeIds);
  const studioTask = {
    ...task,
    kind: mediaKind,
    missingNode: false,
    nodeDeletedAt: '',
    nodeId,
    nodeType,
    prompt: compactText(task.prompt || '', ''),
    settings,
    sourceNodeIds,
    updatedAt: now,
  };
  studioTask.costEstimate = estimateStudioTaskCost(mediaKind, settings);
  const node = {
    id: nodeId,
    type: nodeType,
    x: position.x,
    y: position.y,
    width,
    height,
    name: task.nodeName || (mediaKind === 'video' ? '恢复视频任务' : '恢复图像任务'),
    prompt: studioTask.prompt,
    needsAutoResize: true,
    ...getStudioTaskNodePatch(studioTask),
    studioTask,
  };
  const edges = sourceNodeIds.map((sourceNodeId) => ({
    id: createBridgeEdgeId(sourceNodeId, nodeId),
    sourceId: sourceNodeId,
    targetId: nodeId,
    refSlot: mediaKind === 'video' ? 'firstFrame' : 'reference',
  }));

  if (edges.length && typeof graphStore?.batch === 'function') {
    graphStore.batch(() => {
      graphStore.addNode(node);
      edges.forEach((edge) => graphStore.addEdge(edge));
      graphStore.setSelectedNodes?.([nodeId]);
    });
  } else {
    graphStore.addNode(node);
    edges.forEach((edge) => graphStore.addEdge?.(edge));
    graphStore.setSelectedNodes?.([nodeId]);
  }
  commit();
  focusBridgeNode(nodeId);
  const taskSnapshot = upsertGenerationTaskSnapshot(
    {
      ...studioTask,
      nodeId,
      nodeName: node.name,
      nodeType,
    },
    { missingNode: false },
  );
  scheduleAutosave('restore-generation-task-node');
  window.showToast?.('已恢复任务节点到画布', 'success');

  return {
    apiReachable,
    edgeIds: edges.map((edge) => edge.id),
    nodeId,
    nodeType,
    restored: true,
    selected: (graphStore.getState?.().selectedNodeIds || []).map(String).includes(nodeId),
    stats: getSnapshotEnvelope().stats,
    task: taskSnapshot || {
      ...studioTask,
      nodeId,
      nodeName: node.name,
      nodeType,
    },
  };
}

function removeGenerationTask(payload = {}) {
  const taskId = getGenerationTaskId(payload);
  if (!taskId) throw new Error('缺少要移除的生成任务');
  const node = getGenerationTaskNode(payload);
  let removed = removeRegisteredGenerationTask(taskId);
  if (node && String(node?.studioTask?.id || '') === taskId) {
    updateBridgeNodeData(node.id, { studioTask: undefined });
    removed = true;
    commit();
    scheduleAutosave('remove-generation-task');
  }
  if (!removed) throw new Error('生成任务不存在或已被移除');
  window.showToast?.('已移除队列任务', 'success');
  return {
    apiReachable,
    removed: true,
    taskId,
    stats: getSnapshotEnvelope().stats,
  };
}

function getActiveCanvasGraph() {
  const snapshot = getSnapshotEnvelope();
  const activeCanvas =
    snapshot.data?.canvases?.find((canvas) => canvas.id === snapshot.data.activeCanvasId) ||
    snapshot.data?.canvases?.[0] ||
    null;
  const nodes = Array.isArray(activeCanvas?.nodes)
    ? activeCanvas.nodes.filter(Boolean)
    : Object.values(activeCanvas?.nodes || {}).filter(Boolean);
  const edges = Array.isArray(activeCanvas?.edges)
    ? activeCanvas.edges.filter(Boolean)
    : Object.values(activeCanvas?.edges || {}).filter(Boolean);
  return { activeCanvas, edges, nodes, snapshot };
}

function getAssistantFacts() {
  const { activeCanvas, edges, nodes, snapshot } = getActiveCanvasGraph();
  const state = graphStore?.getState?.() || {};
  const selectedIds = Array.isArray(state.selectedNodeIds) ? state.selectedNodeIds.map(String) : [];
  const selectedIdSet = new Set(selectedIds);
  const selectedNodes = selectedIds.length
    ? nodes.filter((node) => selectedIdSet.has(String(node?.id || '')))
    : [];
  const incomingTargetIds = new Set(edges.map((edge) => String(edge?.targetId || edge?.targetNodeId || edge?.dstId || '')));
  const outgoingSourceIds = new Set(edges.map((edge) => String(edge?.sourceId || edge?.sourceNodeId || edge?.srcId || '')));
  const counts = nodes.reduce(
    (result, node) => {
      const type = String(node?.type || '').toLowerCase();
      if (type === 'group') result.groups += 1;
      else if (type.includes('video')) result.videos += 1;
      else if (type.includes('image') || type.includes('photo')) result.images += 1;
      else if (type.includes('text')) result.texts += 1;
      else result.other += 1;
      return result;
    },
    { groups: 0, images: 0, other: 0, texts: 0, videos: 0 },
  );
  const mediaNodes = nodes.filter((node) => getNodeMediaKind(node));
  const disconnectedNodes = nodes.filter((node) => {
    const id = String(node?.id || '');
    return id && node?.type !== 'group' && !incomingTargetIds.has(id) && !outgoingSourceIds.has(id);
  });
  const promptlessGenerationNodes = nodes.filter((node) => {
    const type = String(node?.type || '');
    if (type !== 'ai-image' && type !== 'ai-video' && type !== 'ai-text') return false;
    return !String(node?.prompt || node?.content || node?.outputText || '').trim();
  });
  const sourceLessVideos = nodes.filter((node) => {
    const id = String(node?.id || '');
    return getNodeMediaKind(node) === 'video' && id && !incomingTargetIds.has(id);
  });
  return {
    activeCanvasId: activeCanvas?.id || '',
    counts,
    disconnectedNodes,
    edges,
    mediaNodes,
    nodes,
    project: snapshot.project,
    promptlessGenerationNodes,
    selectedNodes,
    sourceLessVideos,
    stats: snapshot.stats,
  };
}

function formatAssistantNode(node) {
  const type = String(node?.type || 'node');
  const name = compactText(node?.name || node?.prompt || node?.content || node?.outputText || node?.id, node?.id || type);
  return `${name} (${type})`;
}

function buildAssistantNoteContent(kind, payload = {}) {
  const facts = getAssistantFacts();
  const { counts, disconnectedNodes, edges, mediaNodes, nodes, promptlessGenerationNodes, selectedNodes, sourceLessVideos } = facts;
  const focusNodes = selectedNodes.length ? selectedNodes : mediaNodes.slice(0, 4);
  const focusText = focusNodes.length ? focusNodes.map(formatAssistantNode).join('、') : '暂无明确素材节点';
  const nodeSummary = `节点 ${nodes.length} 个：图像 ${counts.images} / 视频 ${counts.videos} / 文本 ${counts.texts} / 分组 ${counts.groups} / 其他 ${counts.other}，连线 ${edges.length} 条。`;
  const requestText = compactText(payload.prompt || payload.request || '', '');
  const executionMode = String(payload.executionMode || 'manual').toLowerCase() === 'auto' ? '自动执行' : '手动确认';
  const contextLines = [
    nodeSummary,
    `当前关注：${focusText}`,
    `执行方式：${executionMode}`,
    ...(requestText ? [`需求：${requestText}`] : []),
  ];

  if (kind === 'next') {
    const steps = [];
    if (nodes.length === 0) steps.push('先新建一个图片节点，明确主视觉、主体、风格和比例。');
    if (counts.images === 0) steps.push('补一个参考图或上传素材，让后续视频节点有稳定首帧。');
    if (counts.videos === 0 && counts.images > 0) steps.push('选中关键图片后创建视频节点，补镜头运动、时长和节奏。');
    if (edges.length === 0 && nodes.length > 1) steps.push('把参考素材连到生成节点，形成清楚的输入输出链路。');
    if (promptlessGenerationNodes.length) steps.push('给没有描述的生成节点补 prompt，避免任务进入队列后不可控。');
    if (disconnectedNodes.length > 2) steps.push('整理孤立节点，把素材、图片生成、视频生成收成一条创作流。');
    if (!steps.length) steps.push('基础链路已经完整，可以做三版方向对比，再挑一个方向继续细化。');
    return [
      '# 下一步做什么',
      ...contextLines,
      '',
      '建议动作：',
      ...steps.slice(0, 5).map((step, index) => `${index + 1}. ${step}`),
      '',
      '快捷入口：用 /image 新建图片、/animate 接续视频、/flow 生成图片到视频创作流。',
    ].join('\n');
  }

  if (kind === 'references') {
    return [
      '# 找相似参考',
      ...contextLines,
      '',
      '建议参考方向：',
      '1. 找同构图参考：主体比例、背景层次、画面留白保持一致。',
      '2. 找同光线参考：主光方向、材质反光、阴影硬度优先匹配。',
      '3. 找同运动参考：如果已有视频节点，优先参考镜头速度、推拉/环绕方式。',
      '',
      '下一步：选中关键素材后用 /ref 生成参考创作流，或补充更具体的风格词。',
    ].join('\n');
  }

  if (kind === 'directions') {
    return [
      '# 三个创意方向',
      ...contextLines,
      '',
      '方向 A：主视觉定稿',
      '把当前关键素材统一成一张高完成度海报图，优先解决主体、光线、色彩和构图。',
      '',
      '方向 B：动态叙事',
      '围绕最强图像节点接一段视频，补镜头运动、节奏、首尾帧和转场提示。',
      '',
      '方向 C：版本对比',
      '从选中素材拆出三版风格变体，用相同主体测试不同场景、材质或情绪。',
      '',
      '下一步：选一个方向生成对应节点，或用 /variants 直接做三版对比。',
    ].join('\n');
  }

  if (kind === 'gaps') {
    const gaps = [];
    if (nodes.length === 0) gaps.push('画布还没有节点，先建立图像或视频种子。');
    if (counts.images === 0) gaps.push('缺少图像素材，视频首帧和视觉风格不够稳定。');
    if (counts.videos === 0) gaps.push('缺少视频输出节点，还没有形成可预览的动态结果。');
    if (edges.length === 0 && nodes.length > 1) gaps.push('节点之间还没有连线，素材关系和生成链路不清楚。');
    if (sourceLessVideos.length) gaps.push(`${sourceLessVideos.length} 个视频节点没有输入素材，可连接图像首帧或上一段视频。`);
    if (promptlessGenerationNodes.length) gaps.push(`${promptlessGenerationNodes.length} 个生成节点缺少描述，后续结果不可控。`);
    if (disconnectedNodes.length > 2) gaps.push(`${disconnectedNodes.length} 个节点处于孤立状态，可以整理成分组或工作流。`);
    if (!gaps.length) gaps.push('基础链路已经清楚，下一步可以补参考图、镜头节奏或版本对比。');
    return ['# 哪里不清楚', ...contextLines, '', ...gaps.map((gap, index) => `${index + 1}. ${gap}`)].join('\n');
  }

  return [
    '# 画布总结',
    ...contextLines,
    '',
    '结构判断：',
    counts.groups > 0 ? `- 已有 ${counts.groups} 个分组，适合继续按创作流整理。` : '- 还没有分组，可以把素材和输出整理成创作流。',
    edges.length > 0 ? `- 已有 ${edges.length} 条连线，画布具备生成链路。` : '- 还没有连线，建议先建立素材到生成节点的关系。',
    selectedNodes.length > 0 ? `- 当前选中 ${selectedNodes.length} 个节点，助手结果基于选中上下文生成。` : '- 当前没有选中节点，助手结果基于全画布生成。',
    '',
    '下一步：补一个参考流、整理孤立素材，或把关键图像接到视频节点上。',
  ].join('\n');
}

function getAssistantNotePosition(width, height) {
  const facts = getAssistantFacts();
  const targets = facts.selectedNodes.length ? facts.selectedNodes : [];
  if (targets.length) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    for (const node of targets) {
      const rect = getNodeRect(node, { width: 360, height: 240 });
      left = Math.min(left, rect.x);
      top = Math.min(top, rect.y);
      right = Math.max(right, rect.right);
    }
    if (Number.isFinite(left) && Number.isFinite(top) && Number.isFinite(right)) {
      return { x: right + 96, y: top };
    }
  }
  const center = getViewportCenterWorld();
  return { x: center.x - width / 2, y: center.y - height / 2 };
}

function createAssistantNote(payload = {}) {
  if (typeof graphStore?.addNode !== 'function') throw new Error('Canvas runtime is not ready');
  const kind = String(payload.kind || 'summary').trim().toLowerCase();
  if (!['summary', 'references', 'gaps', 'next', 'directions'].includes(kind)) {
    throw new Error('Unsupported CanvasPro assistant action');
  }

  const width = 460;
  const height = 320;
  const position = getAssistantNotePosition(width, height);
  const content = buildAssistantNoteContent(kind, payload);
  const id = createBridgeNodeId('source-text');
  const name =
    kind === 'references'
      ? '找相似参考'
      : kind === 'gaps'
        ? '哪里不清楚'
        : kind === 'next'
          ? '下一步做什么'
          : kind === 'directions'
            ? '三个方向'
            : '画布总结';
  const node = {
    id,
    type: 'source-text',
    x: position.x,
    y: position.y,
    width,
    height,
    name,
    content,
    outputText: content,
    needsAutoResize: false,
  };

  graphStore.addNode(node);
  graphStore.setSelectedNodes?.([id]);
  commit();
  focusBridgeNode(id);
  scheduleAutosave(`assistant-${kind}`);
  window.showToast?.(`已生成${name}`, 'success');

  return {
    action: kind,
    apiReachable,
    contentSeeded: Boolean(content),
    noteId: id,
    selected: (graphStore.getState?.().selectedNodeIds || []).includes(id),
    stats: getSnapshotEnvelope().stats,
  };
}

async function createNode(payload = {}) {
  const kind = String(payload.kind || '').trim().toLowerCase();
  const config = QUICK_CREATE_NODE_CONFIGS[kind];
  if (!config) throw new Error('Unsupported CanvasPro quick-create node kind');
  if (typeof graphStore?.addNode !== 'function') throw new Error('Canvas runtime is not ready');

  const sourceMode = String(payload.source || '').trim().toLowerCase();
  if (sourceMode && sourceMode !== 'selected') throw new Error('Unsupported CanvasPro quick-create source mode');
  if (sourceMode === 'selected' && kind !== 'image' && kind !== 'video' && kind !== 'note') {
    throw new Error('Selected-source quick create currently supports image, video, and reference nodes');
  }
  if (sourceMode === 'selected' && typeof graphStore?.addEdge !== 'function') {
    throw new Error('Canvas runtime cannot connect selected assets');
  }

  const prompt = String(payload.prompt || '').trim();
  const { width, height } = getQuickCreateNodeSize(config.nodeType);
  const sourceNodes =
    sourceMode === 'selected'
      ? kind === 'note'
        ? getSelectedReferenceNodes()
        : kind === 'video'
          ? getSelectedVideoSourceNodes()
          : getSelectedSourceNodes({ max: kind === 'image' ? 4 : 1 })
      : [];
  const sourceNode = sourceNodes[0] || null;
  if (sourceMode === 'selected' && !sourceNode) {
    throw new Error(kind === 'note' ? '请选择要引用的画布内容' : '请选择一个图像或视频素材');
  }
  const position = getQuickCreatePosition(sourceNode, width, height);
  const id = createBridgeNodeId(config.nodeType);
  const node = {
    id,
    type: config.nodeType,
    x: position.x,
    y: position.y,
    width,
    height,
    name: config.name,
  };
  if (kind === 'note') {
    const referenceLines = sourceNodes.length
      ? ['# 引用参考', `引用来源：${sourceNodes.map(formatAssistantNode).join('、')}`, '']
      : [];
    const content = [...referenceLines, prompt || '添加文字、参考链接、需求备注或分镜说明。'].join('\n');
    Object.assign(node, {
      content,
      name: sourceNodes.length ? '引用参考' : config.name,
      outputText: content,
      needsAutoResize: false,
    });
  } else {
    const studioTask = createStudioTask(kind, prompt, sourceNodes.map((source) => source.id));
    Object.assign(node, {
      prompt,
      needsAutoResize: true,
      ...getStudioTaskNodePatch(studioTask),
      studioTask,
    });
  }
  const sourceMediaKind = getNodeMediaKind(sourceNode);
  let imageVideoRefIndex = 0;
  const edges = sourceNodes.map((node) => {
    const mediaKind = getNodeMediaKind(node);
    let refSlot = 'reference';
    if (kind === 'video') {
      if (mediaKind === 'video') {
        refSlot = 'sourceVideo';
      } else {
        refSlot = imageVideoRefIndex === 0 ? 'firstFrame' : 'lastFrame';
        imageVideoRefIndex += 1;
      }
    }
    return {
      id: createBridgeEdgeId(node.id, id),
      sourceId: node.id,
      targetId: id,
      refSlot,
    };
  });
  const edge = edges[0] || null;

  if (edges.length > 0 && typeof graphStore?.batch === 'function') {
    graphStore.batch(() => {
      graphStore.addNode(node);
      edges.forEach((item) => graphStore.addEdge(item));
      graphStore.setSelectedNodes?.([id]);
    });
  } else {
    graphStore.addNode(node);
    edges.forEach((item) => graphStore.addEdge(item));
    graphStore.setSelectedNodes?.([id]);
  }
  commit();
  focusBridgeNode(id);
  scheduleAutosave(edge ? `quick-create-${kind}-from-selected` : `quick-create-${kind}`);

  let preparedTask = null;
  let prepareMessage = '';
  if (kind !== 'note' && payload.prepare !== false) {
    try {
      const prepared = await submitGenerationTask({
        focus: false,
        nodeId: id,
        prompt,
        toast: false,
      });
      preparedTask = isPlainRecord(prepared?.task) ? prepared.task : null;
      prepareMessage = String(prepared?.task?.backendMessage || '');
    } catch (error) {
      prepareMessage = error?.message || String(error);
    }
  }

  const preparedLabel = preparedTask ? '，已准备生成' : prepareMessage ? '，生成准备待重试' : '';
  window.showToast?.(edge ? `${config.toast}，已连接选中素材${preparedLabel}` : `${config.toast}${preparedLabel}`, preparedTask ? 'success' : 'success');

  return {
    apiReachable,
    autoPrepared: Boolean(preparedTask),
    edgeId: edge?.id || '',
    edgeIds: edges.map((item) => item.id),
    nodeId: id,
    nodeType: config.nodeType,
    prepareMessage,
    contentSeeded: kind === 'note' ? Boolean(prompt) : false,
    promptSeeded: Boolean(prompt),
    selected: (graphStore.getState?.().selectedNodeIds || []).includes(id),
    sourceMediaKind,
    sourceNodeId: sourceNode?.id || '',
    sourceNodeIds: sourceNodes.map((node) => node.id),
    stats: getSnapshotEnvelope().stats,
    task: preparedTask,
  };
}

function createFlow(payload = {}) {
  if (typeof graphStore?.addNode !== 'function') throw new Error('Canvas runtime is not ready');
  if (typeof graphStore?.addEdge !== 'function') throw new Error('Canvas runtime cannot connect workflow nodes');

  const mode = String(payload.mode || payload.kind || 'image-video').trim().toLowerCase();
  if (mode !== 'image-video') throw new Error('Unsupported CanvasPro quick-create flow kind');

  const prompt = String(payload.prompt || '').trim();
  const sourceMode = String(payload.source || '').trim().toLowerCase();
  if (sourceMode && sourceMode !== 'selected') {
    throw new Error('Unsupported CanvasPro quick-create flow source mode');
  }
  if (sourceMode === 'selected') {
    const sourceNode = getSelectedSourceNode();
    if (!sourceNode) throw new Error('请选择一个图像或视频素材');

    const sourceMediaKind = getNodeMediaKind(sourceNode);
    const videoSize = getQuickCreateNodeSize('ai-video');
    const sourceRect = getNodeRect(sourceNode, { width: 420, height: 520 });
    const gap = 96;
    const paddingX = 48;
    const paddingTop = 72;
    const paddingBottom = 48;
    const videoX = sourceRect.right + gap;
    const videoY = sourceRect.y;
    const videoRect = {
      x: videoX,
      y: videoY,
      width: videoSize.width,
      height: videoSize.height,
      right: videoX + videoSize.width,
      bottom: videoY + videoSize.height,
    };
    const contentLeft = Math.min(sourceRect.x, videoRect.x);
    const contentTop = Math.min(sourceRect.y, videoRect.y);
    const contentRight = Math.max(sourceRect.right, videoRect.right);
    const contentBottom = Math.max(sourceRect.bottom, videoRect.bottom);
    const groupId = createBridgeNodeId('group');
    const videoId = createBridgeNodeId('ai-video');
    const groupNode = {
      id: groupId,
      type: 'group',
      x: contentLeft - paddingX,
      y: contentTop - paddingTop,
      width: contentRight - contentLeft + paddingX * 2,
      height: contentBottom - contentTop + paddingTop + paddingBottom,
      name: '选中素材创作流',
      color: 'var(--group-cyan)',
    };
    const videoTask = createStudioTask('video', prompt, [sourceNode.id]);
    const videoNode = {
      id: videoId,
      type: 'ai-video',
      parentId: groupId,
      x: videoRect.x,
      y: videoRect.y,
      width: videoRect.width,
      height: videoRect.height,
      name: '生成视频',
      prompt,
      needsAutoResize: true,
      ...getStudioTaskNodePatch(videoTask),
      studioTask: videoTask,
    };
    const edge = {
      id: createBridgeEdgeId(sourceNode.id, videoId),
      sourceId: sourceNode.id,
      targetId: videoId,
      refSlot: sourceMediaKind === 'video' ? 'sourceVideo' : 'firstFrame',
    };

    if (typeof graphStore?.batch === 'function') {
      graphStore.batch(() => {
        graphStore.addNode(groupNode);
        updateBridgeNodeData(sourceNode.id, { parentId: groupId });
        graphStore.addNode(videoNode);
        graphStore.addEdge(edge);
        graphStore.setSelectedNodes?.([groupId]);
      });
    } else {
      graphStore.addNode(groupNode);
      updateBridgeNodeData(sourceNode.id, { parentId: groupId });
      graphStore.addNode(videoNode);
      graphStore.addEdge(edge);
      graphStore.setSelectedNodes?.([groupId]);
    }
    commit();
    focusBridgeNode(groupId);
    scheduleAutosave('quick-create-selected-image-video-flow');
    window.showToast?.('已从选中素材新建创作流', 'success');

    return {
      apiReachable,
      edgeId: edge.id,
      groupId,
      imageNodeId: sourceMediaKind === 'image' ? sourceNode.id : '',
      promptSeeded: Boolean(prompt),
      selected: (graphStore.getState?.().selectedNodeIds || []).includes(groupId),
      sourceMediaKind,
      sourceNodeId: sourceNode.id,
      sourceReparented: true,
      stats: getSnapshotEnvelope().stats,
      videoNodeId: videoId,
    };
  }

  const imageSize = getQuickCreateNodeSize('ai-image');
  const videoSize = getQuickCreateNodeSize('ai-video');
  const gap = 96;
  const paddingX = 48;
  const paddingTop = 72;
  const paddingBottom = 48;
  const groupWidth = paddingX * 2 + imageSize.width + gap + videoSize.width;
  const groupHeight = paddingTop + Math.max(imageSize.height, videoSize.height) + paddingBottom;
  const center = getViewportCenterWorld();
  const groupId = createBridgeNodeId('group');
  const imageId = createBridgeNodeId('ai-image');
  const videoId = createBridgeNodeId('ai-video');
  const groupX = center.x - groupWidth / 2;
  const groupY = center.y - groupHeight / 2;
  const childY = groupY + paddingTop;
  const imageX = groupX + paddingX;
  const videoX = imageX + imageSize.width + gap;
  const groupNode = {
    id: groupId,
    type: 'group',
    x: groupX,
    y: groupY,
    width: groupWidth,
    height: groupHeight,
    name: '图片到视频创作流',
    color: 'var(--group-cyan)',
  };
  const imageTask = createStudioTask('image', prompt);
  const videoTask = createStudioTask('video', prompt, [imageId]);
  const imageNode = {
    id: imageId,
    type: 'ai-image',
    parentId: groupId,
    x: imageX,
    y: childY,
    width: imageSize.width,
    height: imageSize.height,
    name: '生成图像',
    prompt,
    needsAutoResize: true,
    ...getStudioTaskNodePatch(imageTask),
    studioTask: imageTask,
  };
  const videoNode = {
    id: videoId,
    type: 'ai-video',
    parentId: groupId,
    x: videoX,
    y: childY,
    width: videoSize.width,
    height: videoSize.height,
    name: '生成视频',
    prompt,
    needsAutoResize: true,
    ...getStudioTaskNodePatch(videoTask),
    studioTask: videoTask,
  };
  const edge = {
    id: createBridgeEdgeId(imageId, videoId),
    sourceId: imageId,
    targetId: videoId,
    refSlot: 'firstFrame',
  };

  if (typeof graphStore?.batch === 'function') {
    graphStore.batch(() => {
      graphStore.addNode(groupNode);
      graphStore.addNode(imageNode);
      graphStore.addNode(videoNode);
      graphStore.addEdge(edge);
      graphStore.setSelectedNodes?.([groupId]);
    });
  } else {
    graphStore.addNode(groupNode);
    graphStore.addNode(imageNode);
    graphStore.addNode(videoNode);
    graphStore.addEdge(edge);
    graphStore.setSelectedNodes?.([groupId]);
  }
  commit();
  focusBridgeNode(groupId);
  scheduleAutosave('quick-create-image-video-flow');
  window.showToast?.('已新建图片到视频创作流', 'success');

  return {
    apiReachable,
    edgeId: edge.id,
    groupId,
    imageNodeId: imageId,
    promptSeeded: Boolean(prompt),
    selected: (graphStore.getState?.().selectedNodeIds || []).includes(groupId),
    stats: getSnapshotEnvelope().stats,
    videoNodeId: videoId,
  };
}

function buildStoryboardPrompt(basePrompt, shot) {
  const prefix = basePrompt ? `${basePrompt}\n` : '';
  return `${prefix}${shot.label}: ${shot.hint}`;
}

function createStoryboard(payload = {}) {
  if (typeof graphStore?.addNode !== 'function') throw new Error('Canvas runtime is not ready');
  if (typeof graphStore?.addEdge !== 'function') throw new Error('Canvas runtime cannot connect storyboard nodes');

  const prompt = String(payload.prompt || '').trim();
  const shots = [
    { label: '镜头 1 开场', hint: '建立主体、环境和视觉风格，画面信息清晰。' },
    { label: '镜头 2 动作', hint: '延续上一镜头的主体和光线，增加运动或交互。' },
    { label: '镜头 3 收束', hint: '给出最终构图或情绪落点，便于产出成片。' },
  ];
  const imageSize = getQuickCreateNodeSize('ai-image');
  const videoSize = getQuickCreateNodeSize('ai-video');
  const columnGap = 96;
  const rowGap = 72;
  const paddingX = 48;
  const paddingTop = 72;
  const paddingBottom = 48;
  const rowHeight = Math.max(imageSize.height, videoSize.height);
  const groupWidth = paddingX * 2 + imageSize.width + columnGap + videoSize.width;
  const groupHeight = paddingTop + shots.length * rowHeight + (shots.length - 1) * rowGap + paddingBottom;
  const center = getViewportCenterWorld();
  const groupId = createBridgeNodeId('group');
  const groupX = center.x - groupWidth / 2;
  const groupY = center.y - groupHeight / 2;
  const imageX = groupX + paddingX;
  const videoX = imageX + imageSize.width + columnGap;
  const groupNode = {
    id: groupId,
    type: 'group',
    x: groupX,
    y: groupY,
    width: groupWidth,
    height: groupHeight,
    name: '多镜头分镜创作流',
    color: 'var(--group-purple)',
  };
  const imageNodes = [];
  const videoNodes = [];
  const edges = [];

  for (let index = 0; index < shots.length; index += 1) {
    const shot = shots[index];
    const y = groupY + paddingTop + index * (rowHeight + rowGap);
    const shotPrompt = buildStoryboardPrompt(prompt, shot);
    const previousVideo = videoNodes[index - 1];
    const imageId = createBridgeNodeId('ai-image');
    const videoId = createBridgeNodeId('ai-video');
    const imageTask = createStudioTask('image', shotPrompt, previousVideo ? [previousVideo.id] : []);
    const videoTask = createStudioTask('video', shotPrompt, [imageId, previousVideo?.id].filter(Boolean));
    imageNodes.push({
      id: imageId,
      type: 'ai-image',
      parentId: groupId,
      x: imageX,
      y,
      width: imageSize.width,
      height: imageSize.height,
      name: `${shot.label} 图像`,
      prompt: shotPrompt,
      needsAutoResize: true,
      ...getStudioTaskNodePatch(imageTask),
      studioTask: imageTask,
    });
    videoNodes.push({
      id: videoId,
      type: 'ai-video',
      parentId: groupId,
      x: videoX,
      y,
      width: videoSize.width,
      height: videoSize.height,
      name: `${shot.label} 视频`,
      prompt: shotPrompt,
      needsAutoResize: true,
      ...getStudioTaskNodePatch(videoTask),
      studioTask: videoTask,
    });
    edges.push({
      id: createBridgeEdgeId(imageId, videoId),
      sourceId: imageId,
      targetId: videoId,
      refSlot: 'firstFrame',
    });
    if (previousVideo) {
      edges.push({
        id: createBridgeEdgeId(previousVideo.id, videoId),
        sourceId: previousVideo.id,
        targetId: videoId,
        refSlot: 'sourceVideo',
      });
    }
  }

  if (typeof graphStore?.batch === 'function') {
    graphStore.batch(() => {
      graphStore.addNode(groupNode);
      imageNodes.forEach((node) => graphStore.addNode(node));
      videoNodes.forEach((node) => graphStore.addNode(node));
      edges.forEach((edge) => graphStore.addEdge(edge));
      graphStore.setSelectedNodes?.([groupId]);
    });
  } else {
    graphStore.addNode(groupNode);
    imageNodes.forEach((node) => graphStore.addNode(node));
    videoNodes.forEach((node) => graphStore.addNode(node));
    edges.forEach((edge) => graphStore.addEdge(edge));
    graphStore.setSelectedNodes?.([groupId]);
  }
  commit();
  focusBridgeNode(groupId);
  scheduleAutosave('quick-create-storyboard');
  window.showToast?.('已新建多镜头分镜创作流', 'success');

  return {
    apiReachable,
    edgeIds: edges.map((edge) => edge.id),
    groupId,
    imageNodeIds: imageNodes.map((node) => node.id),
    promptSeeded: Boolean(prompt),
    selected: (graphStore.getState?.().selectedNodeIds || []).includes(groupId),
    stats: getSnapshotEnvelope().stats,
    videoNodeIds: videoNodes.map((node) => node.id),
  };
}

function buildVariantPrompt(basePrompt, variation) {
  const prefix = basePrompt ? `${basePrompt}\n` : '';
  return `${prefix}${variation.label}: ${variation.hint}`;
}

function createVariants(payload = {}) {
  if (typeof graphStore?.addNode !== 'function') throw new Error('Canvas runtime is not ready');
  if (typeof graphStore?.addEdge !== 'function') throw new Error('Canvas runtime cannot connect variant nodes');

  const sourceMode = String(payload.source || 'selected').trim().toLowerCase();
  if (sourceMode !== 'selected') throw new Error('CanvasPro variants currently require a selected source asset');
  const sourceNode = getSelectedSourceNode();
  if (!sourceNode) throw new Error('请选择一个图像或视频素材');

  const sourceMediaKind = getNodeMediaKind(sourceNode);
  const outputNodeType = sourceMediaKind === 'video' ? 'ai-video' : 'ai-image';
  const refSlot = sourceMediaKind === 'video' ? 'sourceVideo' : 'reference';
  const prompt = String(payload.prompt || '').trim();
  const sourcePrompt = compactText(
    sourceNode?.prompt || sourceNode?.name || sourceNode?.content || sourceNode?.outputText || '',
    sourceMediaKind === 'video' ? '保持选中视频主体和节奏' : '保持选中图像主体和构图',
  );
  const basePrompt = prompt || sourcePrompt;
  const variations = [
    { label: '变体 1 稳定版', hint: '保留主体、构图和关键识别点，只做轻微风格优化。' },
    { label: '变体 2 探索版', hint: '保持同一创意方向，尝试更鲜明的光影、材质或镜头语言。' },
    { label: '变体 3 成片版', hint: '面向最终交付优化商业质感、节奏和画面可读性。' },
  ];
  const outputSize = getQuickCreateNodeSize(outputNodeType);
  const sourceRect = getNodeRect(sourceNode, { width: 420, height: 520 });
  const columnGap = 96;
  const rowGap = 56;
  const paddingX = 48;
  const paddingTop = 72;
  const paddingBottom = 48;
  const variantsHeight = variations.length * outputSize.height + (variations.length - 1) * rowGap;
  const contentLeft = sourceRect.x;
  const contentTop = sourceRect.y;
  const contentRight = sourceRect.right + columnGap + outputSize.width;
  const contentBottom = Math.max(sourceRect.bottom, sourceRect.y + variantsHeight);
  const groupId = createBridgeNodeId('group');
  const groupNode = {
    id: groupId,
    type: 'group',
    x: contentLeft - paddingX,
    y: contentTop - paddingTop,
    width: contentRight - contentLeft + paddingX * 2,
    height: contentBottom - contentTop + paddingTop + paddingBottom,
    name: sourceMediaKind === 'video' ? '视频版本对比' : '图像版本对比',
    color: 'var(--group-purple)',
  };
  const variantX = sourceRect.right + columnGap;
  const outputNodes = variations.map((variation, index) => {
    const id = createBridgeNodeId(outputNodeType);
    const outputPrompt = buildVariantPrompt(basePrompt, variation);
    const studioTask = createStudioTask(sourceMediaKind === 'video' ? 'video' : 'image', outputPrompt, [sourceNode.id]);
    return {
      id,
      type: outputNodeType,
      parentId: groupId,
      x: variantX,
      y: sourceRect.y + index * (outputSize.height + rowGap),
      width: outputSize.width,
      height: outputSize.height,
      name: `${variation.label}${sourceMediaKind === 'video' ? '视频' : '图像'}`,
      prompt: outputPrompt,
      needsAutoResize: true,
      ...getStudioTaskNodePatch(studioTask),
      studioTask,
    };
  });
  const edges = outputNodes.map((node) => ({
    id: createBridgeEdgeId(sourceNode.id, node.id),
    sourceId: sourceNode.id,
    targetId: node.id,
    refSlot,
  }));

  if (typeof graphStore?.batch === 'function') {
    graphStore.batch(() => {
      graphStore.addNode(groupNode);
      updateBridgeNodeData(sourceNode.id, { parentId: groupId });
      outputNodes.forEach((node) => graphStore.addNode(node));
      edges.forEach((edge) => graphStore.addEdge(edge));
      graphStore.setSelectedNodes?.([groupId]);
    });
  } else {
    graphStore.addNode(groupNode);
    updateBridgeNodeData(sourceNode.id, { parentId: groupId });
    outputNodes.forEach((node) => graphStore.addNode(node));
    edges.forEach((edge) => graphStore.addEdge(edge));
    graphStore.setSelectedNodes?.([groupId]);
  }
  commit();
  focusBridgeNode(groupId);
  scheduleAutosave('quick-create-selected-variants');
  window.showToast?.('已从选中素材生成版本变体', 'success');

  return {
    apiReachable,
    edgeIds: edges.map((edge) => edge.id),
    groupId,
    outputNodeIds: outputNodes.map((node) => node.id),
    outputNodeType,
    promptSeeded: Boolean(prompt),
    selected: (graphStore.getState?.().selectedNodeIds || []).includes(groupId),
    sourceMediaKind,
    sourceNodeId: sourceNode.id,
    sourceReparented: true,
    stats: getSnapshotEnvelope().stats,
  };
}

function getLayoutUnitRect(nodes) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const node of nodes) {
    const rect = getNodeRect(node, { width: 420, height: 360 });
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) {
    return { x: 0, y: 0, width: 420, height: 360, right: 420, bottom: 360 };
  }
  return { x: left, y: top, width: right - left, height: bottom - top, right, bottom };
}

function getOrganizeUnits() {
  const nodes = getGraphNodes();
  const nodeById = new Map(nodes.map((node) => [String(node?.id || ''), node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    const parentId = String(node?.parentId || '');
    if (!parentId) continue;
    const list = childrenByParent.get(parentId) || [];
    list.push(node);
    childrenByParent.set(parentId, list);
  }
  const units = [];
  for (const node of nodes) {
    const id = String(node?.id || '');
    if (!id) continue;
    if (String(node.type || '') === 'group') {
      const children = childrenByParent.get(id) || [];
      const unitNodes = [node, ...children.filter(Boolean)];
      units.push({
        id,
        node,
        nodes: unitNodes,
        rect: getLayoutUnitRect(unitNodes),
        type: 'group',
      });
      continue;
    }
    const parentId = String(node?.parentId || '');
    if (!parentId || !nodeById.has(parentId)) {
      units.push({
        id,
        node,
        nodes: [node],
        rect: getLayoutUnitRect([node]),
        type: String(node.type || 'node'),
      });
    }
  }
  return units.sort((a, b) => {
    const ay = Math.round((a.rect.y || 0) / 120);
    const by = Math.round((b.rect.y || 0) / 120);
    if (ay !== by) return ay - by;
    return (a.rect.x || 0) - (b.rect.x || 0);
  });
}

function getUnitBounds(units) {
  if (!units.length) {
    const center = getViewportCenterWorld();
    return { x: center.x, y: center.y, width: 0, height: 0 };
  }
  const rect = getLayoutUnitRect(units.flatMap((unit) => unit.nodes));
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function organizeCanvas() {
  if (typeof graphStore?.addNode !== 'function') throw new Error('Canvas runtime is not ready');
  const units = getOrganizeUnits();
  if (!units.length) throw new Error('画布还没有可整理的内容');

  const gapX = 120;
  const gapY = 96;
  const columnCount = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(units.length))));
  const columnWidths = Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.max(
      360,
      ...units
        .filter((_, index) => index % columnCount === columnIndex)
        .map((unit) => unit.rect.width || Number(unit.node?.width) || 360),
    ),
  );
  const rowCount = Math.ceil(units.length / columnCount);
  const rowHeights = Array.from({ length: rowCount }, (_, rowIndex) =>
    Math.max(
      260,
      ...units
        .filter((_, index) => Math.floor(index / columnCount) === rowIndex)
        .map((unit) => unit.rect.height || Number(unit.node?.height) || 260),
    ),
  );
  const bounds = getUnitBounds(units);
  const startX = bounds.x;
  const startY = bounds.y;
  const selectedIds = Array.isArray(graphStore.getState?.().selectedNodeIds)
    ? graphStore.getState().selectedNodeIds.map(String)
    : [];
  let arrangedNodeCount = 0;

  const moveUnit = (unit, targetX, targetY) => {
    const dx = targetX - unit.rect.x;
    const dy = targetY - unit.rect.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    for (const node of unit.nodes) {
      updateBridgeNodeData(node.id, {
        x: Math.round((Number(node.x) || 0) + dx),
        y: Math.round((Number(node.y) || 0) + dy),
      });
      arrangedNodeCount += 1;
    }
  };

  if (typeof graphStore?.batch === 'function') {
    graphStore.batch(() => {
      units.forEach((unit, index) => {
        const column = index % columnCount;
        const row = Math.floor(index / columnCount);
        const targetX = startX + columnWidths.slice(0, column).reduce((sum, width) => sum + width + gapX, 0);
        const targetY = startY + rowHeights.slice(0, row).reduce((sum, height) => sum + height + gapY, 0);
        moveUnit(unit, targetX, targetY);
      });
      graphStore.setSelectedNodes?.(selectedIds.length ? selectedIds : units.slice(0, 6).map((unit) => unit.id));
    });
  } else {
    units.forEach((unit, index) => {
      const column = index % columnCount;
      const row = Math.floor(index / columnCount);
      const targetX = startX + columnWidths.slice(0, column).reduce((sum, width) => sum + width + gapX, 0);
      const targetY = startY + rowHeights.slice(0, row).reduce((sum, height) => sum + height + gapY, 0);
      moveUnit(unit, targetX, targetY);
    });
    graphStore.setSelectedNodes?.(selectedIds.length ? selectedIds : units.slice(0, 6).map((unit) => unit.id));
  }

  commit();
  const focusIds = selectedIds.length ? selectedIds : units.slice(0, 3).map((unit) => unit.id);
  try {
    if (typeof window.v2FocusOnNodes === 'function') window.v2FocusOnNodes(focusIds, 120, 480, READABLE_NODE_FOCUS_OPTIONS);
    else focusBridgeNode(focusIds[0]);
  } catch {
    focusBridgeNode(focusIds[0]);
  }
  scheduleAutosave('organize-canvas-layout');
  window.showToast?.('已整理画布布局', 'success');

  const currentSelectedIds = Array.isArray(graphStore.getState?.().selectedNodeIds)
    ? graphStore.getState().selectedNodeIds.map(String)
    : [];
  return {
    apiReachable,
    arrangedGroupCount: units.filter((unit) => unit.type === 'group').length,
    arrangedNodeCount,
    selected: currentSelectedIds.length > 0,
    stats: getSnapshotEnvelope().stats,
    unitCount: units.length,
  };
}

function buildAutosaveSignature(snapshot) {
  return JSON.stringify({
    project: snapshot.project,
    stats: snapshot.stats,
    data: snapshot.data,
  });
}

async function saveBrowserSnapshot(reason = 'manual') {
  const snapshot = getSnapshotEnvelope();
  const signature = buildAutosaveSignature(snapshot);
  const savedAt = new Date().toISOString();
  await idbPut(PROJECT_STORE, {
    id: snapshot.project.id,
    name: snapshot.project.name,
    savedAt,
    reason,
    snapshot,
  });
  lastAutosaveSignature = signature;
  lastAutosaveMeta = {
    savedAt,
    reason,
    projectId: snapshot.project.id,
    projectName: snapshot.project.name,
    stats: snapshot.stats,
    apiReachable,
  };
  postToStudio({ type: MESSAGE_AUTOSAVE, payload: lastAutosaveMeta });
  return lastAutosaveMeta;
}

function scheduleAutosave(reason = 'change') {
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(async () => {
    try {
      const snapshot = getSnapshotEnvelope();
      const signature = buildAutosaveSignature(snapshot);
      if (signature === lastAutosaveSignature) return;
      await saveBrowserSnapshot(reason);
    } catch (error) {
      console.warn('[studio-bridge] autosave failed', error);
    }
  }, 900);
}

async function checkApiReachable() {
  if (!API_BASE) {
    apiReachable = null;
    return apiReachable;
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${API_BASE}/api/v2/runtime/info`, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    let payload = null;
    try {
      payload = await response.clone().json();
    } catch {
      /* non-json runtime payloads are treated as native server responses */
    }
    apiReachable =
      response.ok &&
      payload?.available !== false &&
      payload?.mode !== 'studio-compat';
  } catch {
    apiReachable = false;
  } finally {
    clearTimeout(timer);
    applyRuntimeModeState();
  }
  return apiReachable;
}

function safeFilename(value, fallback = 'ai-canvas') {
  const text = String(value || '').trim() || fallback;
  return text
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function extFromMime(mime) {
  const value = String(mime || '').toLowerCase();
  if (value.includes('jpeg')) return 'jpg';
  if (value.includes('png')) return 'png';
  if (value.includes('webp')) return 'webp';
  if (value.includes('gif')) return 'gif';
  if (value.includes('mp4')) return 'mp4';
  if (value.includes('webm')) return 'webm';
  if (value.includes('mpeg')) return 'mp3';
  if (value.includes('wav')) return 'wav';
  if (value.includes('ogg')) return 'ogg';
  if (value.includes('json')) return 'json';
  if (value.includes('text')) return 'txt';
  return 'bin';
}

function extFromUrl(url, mime) {
  try {
    const pathname = new URL(url, location.href).pathname;
    const match = pathname.match(/\.([a-z0-9]{1,8})$/i);
    if (match) return match[1].toLowerCase();
  } catch {
    /* use mime fallback */
  }
  return extFromMime(mime);
}

function isLikelyFetchableAsset(value) {
  const url = String(value || '').trim();
  if (!url) return false;
  if (/^(data|blob):/i.test(url)) return true;
  if (/^https?:\/\//i.test(url)) return true;
  if (url.startsWith('/')) return true;
  return false;
}

function isLocalPathOnly(value) {
  const text = String(value || '').trim();
  return (
    !!text &&
    !isLikelyFetchableAsset(text) &&
    (/^[a-z]:\\/i.test(text) || text.startsWith('file:') || text.startsWith('~/') || text.startsWith('/Users/'))
  );
}

function collectAssetRefs(value, path = '$', refs = []) {
  if (value == null) return refs;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectAssetRefs(item, `${path}[${index}]`, refs));
    return refs;
  }
  if (typeof value !== 'object') return refs;
  for (const [key, raw] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (typeof raw === 'string') {
      if ((ASSET_URL_KEYS.has(key) || LOCAL_PATH_KEYS.has(key)) && raw.trim()) {
        refs.push({
          field: key,
          jsonPath: childPath,
          source: raw.trim(),
          fetchable: isLikelyFetchableAsset(raw),
          localPathOnly: LOCAL_PATH_KEYS.has(key) && isLocalPathOnly(raw),
        });
      }
      continue;
    }
    collectAssetRefs(raw, childPath, refs);
  }
  return refs;
}

function dataUrlToBytes(url) {
  const match = String(url).match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
  if (!match) throw new Error('Invalid data URL');
  const mime = match[1] || 'application/octet-stream';
  const isBase64 = !!match[2];
  const body = match[3] || '';
  const binary = isBase64 ? atob(body) : decodeURIComponent(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return { bytes, mime };
}

async function fetchAssetBytes(source) {
  if (/^data:/i.test(source)) return dataUrlToBytes(source);
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(source, {
      signal: controller.signal,
      cache: 'force-cache',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mime: blob.type || response.headers.get('content-type') || 'application/octet-stream',
    };
  } finally {
    clearTimeout(timer);
  }
}

function makeCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC32_TABLE = makeCrc32Table();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function uint32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function concatBytes(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function textBytes(value) {
  return new TextEncoder().encode(String(value));
}

async function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosDate, dosTime } = dosDateTime();
  for (const file of files) {
    const nameBytes = textBytes(file.path);
    const data = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(await file.bytes.arrayBuffer());
    const crc = crc32(data);
    const common = [
      ...uint16(20),
      ...uint16(0x0800),
      ...uint16(0),
      ...uint16(dosTime),
      ...uint16(dosDate),
      ...uint32(crc),
      ...uint32(data.length),
      ...uint32(data.length),
      ...uint16(nameBytes.length),
      ...uint16(0),
    ];
    const localHeader = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...common]);
    localParts.push(localHeader, nameBytes, data);
    const centralHeader = new Uint8Array([
      0x50,
      0x4b,
      0x01,
      0x02,
      ...uint16(20),
      ...common,
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint32(0),
      ...uint32(offset),
    ]);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + data.length;
  }
  const centralDirectory = concatBytes(centralParts);
  const localDirectory = concatBytes(localParts);
  const end = new Uint8Array([
    0x50,
    0x4b,
    0x05,
    0x06,
    ...uint16(0),
    ...uint16(0),
    ...uint16(files.length),
    ...uint16(files.length),
    ...uint32(centralDirectory.length),
    ...uint32(localDirectory.length),
    ...uint16(0),
  ]);
  return concatBytes([localDirectory, centralDirectory, end]);
}

function downloadBytes(bytes, filename, mime = 'application/octet-stream') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

async function exportPackage() {
  const snapshot = getSnapshotEnvelope();
  const refs = collectAssetRefs(snapshot.data);
  const files = [
    {
      path: 'manifest.json',
      bytes: textBytes(
        JSON.stringify(
          {
            kind: 'myshell-studio-ai-canvaspro-package',
            version: 1,
            bridgeVersion: BRIDGE_VERSION,
            exportedAt: snapshot.exportedAt,
            project: snapshot.project,
            stats: snapshot.stats,
          },
          null,
          2,
        ),
      ),
    },
    {
      path: 'projects.json',
      bytes: textBytes(JSON.stringify(snapshot.data, null, 2)),
    },
  ];
  const manifestAssets = [];
  const skippedAssets = [];
  let assetIndex = 0;

  for (const ref of refs) {
    if (!ref.fetchable) {
      skippedAssets.push({ ...ref, reason: ref.localPathOnly ? 'local-path-only' : 'not-fetchable' });
      continue;
    }
    try {
      const { bytes, mime } = await fetchAssetBytes(ref.source);
      const ext = extFromUrl(ref.source, mime);
      const path = `assets/${String(assetIndex + 1).padStart(3, '0')}-${safeFilename(ref.field)}.${ext}`;
      assetIndex += 1;
      files.push({ path, bytes });
      const asset = {
        id: `${snapshot.project.id}:${assetIndex}`,
        packagePath: path,
        mime,
        size: bytes.length,
        ...ref,
      };
      manifestAssets.push(asset);
      void idbPut(ASSET_STORE, {
        id: asset.id,
        savedAt: new Date().toISOString(),
        source: ref.source,
        mime,
        size: bytes.length,
        blob: new Blob([bytes], { type: mime }),
      }).catch(() => {});
    } catch (error) {
      skippedAssets.push({ ...ref, reason: error?.message || 'fetch-failed' });
    }
  }

  files.push({
    path: 'assets-manifest.json',
    bytes: textBytes(
      JSON.stringify(
        {
          assets: manifestAssets,
          skippedAssets,
        },
        null,
        2,
      ),
    ),
  });
  files.push({
    path: 'README.txt',
    bytes: textBytes(
      [
        'MyShell Studio AI CanvasPro package',
        '',
        'projects.json contains the CanvasPro project data.',
        'assets-manifest.json maps collected asset files back to JSON paths.',
        'Some local-only absolute paths may be listed as skipped assets because browsers cannot read them directly.',
      ].join('\n'),
    ),
  });

  const zipBytes = await createZip(files);
  const filename = `${safeFilename(snapshot.project.name)}-${new Date().toISOString().slice(0, 10)}.canvaspro.zip`;
  downloadBytes(zipBytes, filename, 'application/zip');
  return {
    filename,
    assets: manifestAssets.length,
    skippedAssets: skippedAssets.length,
    stats: snapshot.stats,
  };
}

function readUint16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

async function readZipEntries(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let eocd = -1;
  for (let index = bytes.length - 22; index >= 0; index -= 1) {
    if (readUint32(bytes, index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error('Invalid ZIP package');
  const count = readUint16(bytes, eocd + 10);
  let cursor = readUint32(bytes, eocd + 16);
  const entries = new Map();
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index += 1) {
    if (readUint32(bytes, cursor) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
    const method = readUint16(bytes, cursor + 10);
    const compressedSize = readUint32(bytes, cursor + 20);
    const fileNameLength = readUint16(bytes, cursor + 28);
    const extraLength = readUint16(bytes, cursor + 30);
    const commentLength = readUint16(bytes, cursor + 32);
    const localOffset = readUint32(bytes, cursor + 42);
    const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + fileNameLength));
    if (method !== 0) throw new Error(`Unsupported ZIP compression for ${name}`);
    const localNameLength = readUint16(bytes, localOffset + 26);
    const localExtraLength = readUint16(bytes, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, bytes.slice(dataOffset, dataOffset + compressedSize));
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

async function isZipFile(file) {
  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04;
}

async function parseProjectFile(file) {
  const lowerName = String(file?.name || '').toLowerCase();
  if (lowerName.endsWith('.zip') || (await isZipFile(file))) {
    const entries = await readZipEntries(file);
    const projectBytes = entries.get('projects.json') || entries.get('project.json');
    if (!projectBytes) throw new Error('Package is missing projects.json');
    const data = JSON.parse(new TextDecoder().decode(projectBytes));
    const manifestBytes = entries.get('manifest.json');
    const manifest = manifestBytes ? JSON.parse(new TextDecoder().decode(manifestBytes)) : null;
    return { data, manifest };
  }
  const text = await file.text();
  return { data: JSON.parse(text), manifest: null };
}

async function importPackage(file) {
  if (!file) throw new Error('No file selected');
  const { data, manifest } = await parseProjectFile(file);
  const normalized = Array.isArray(data?.canvases)
    ? data
    : {
        activeCanvasId: 'canvas_1',
        canvases: [
          {
            id: 'canvas_1',
            name: manifest?.project?.name || file.name.replace(/\.(canvaspro\.zip|zip|json)$/i, ''),
            nodes: Array.isArray(data?.nodes) ? data.nodes : Object.values(data?.nodes || {}),
            edges: Array.isArray(data?.edges) ? data.edges : Object.values(data?.edges || {}),
            viewport: data?.viewport || { x: 0, y: 0, zoom: 1.1 },
          },
        ],
      };
  const manager = window.CanvasTabManager;
  if (manager?.init) {
    manager.init(normalized, { markClean: false });
  } else if (graphStore?.hydrateTrustedSnapshot) {
    graphStore.hydrateTrustedSnapshot(normalized.canvases?.[0] || normalized);
  } else if (graphStore?.loadState) {
    graphStore.loadState(normalized.canvases?.[0] || normalized);
  } else {
    throw new Error('Canvas runtime is not ready');
  }
  const projectName = manifest?.project?.name || file.name.replace(/\.(canvaspro\.zip|zip|json)$/i, '');
  const projectNameEl = document.getElementById('projectNameText');
  if (projectNameEl && projectName) projectNameEl.textContent = projectName;
  resetStudioTaskRegistry();
  window.showToast?.('Studio project package imported', 'success');
  await saveBrowserSnapshot('import');
  return {
    projectName,
    stats: getSnapshotEnvelope().stats,
  };
}

function getSelectedContext() {
  const snapshot = getSnapshotEnvelope();
  const activeCanvas =
    snapshot.data?.canvases?.find((canvas) => canvas.id === snapshot.data.activeCanvasId) ||
    snapshot.data?.canvases?.[0] ||
    null;
  const state = graphStore?.getState?.() || {};
  const selectedIds = Array.isArray(state.selectedNodeIds) ? state.selectedNodeIds : [];
  const nodes = Array.isArray(activeCanvas?.nodes) ? activeCanvas.nodes : Object.values(activeCanvas?.nodes || {});
  const selectedNodes = selectedIds.length
    ? nodes.filter((node) => selectedIds.includes(node?.id))
    : [];
  const selectedIdSet = new Set(selectedNodes.map((node) => node?.id).filter(Boolean));
  const edges = Array.isArray(activeCanvas?.edges) ? activeCanvas.edges : Object.values(activeCanvas?.edges || {});
  return {
    project: snapshot.project,
    activeCanvasId: activeCanvas?.id || '',
    nodes: selectedNodes,
    edges: edges.filter((edge) => selectedIdSet.has(edge?.sourceId || edge?.srcId) && selectedIdSet.has(edge?.targetId)),
  };
}

function getSuperClawNodeKind(node) {
  const type = String(node?.type || '').trim().toLowerCase();
  if (!type) return 'node';
  if (type === 'group') return 'group';
  if (type.includes('video')) return 'video';
  if (type.includes('image') || type.includes('photo')) return 'image';
  if (type.includes('audio') || type.includes('music')) return 'audio';
  if (type.includes('text') || type.includes('note')) return 'text';
  return type;
}

function getSuperClawNodeTitle(node) {
  return compactText(
    node?.title ||
      node?.name ||
      node?.label ||
      node?.studioTask?.label ||
      node?.prompt ||
      node?.content ||
      node?.outputText ||
      node?.id,
    String(node?.id || 'node'),
  );
}

function getSuperClawNodePrompt(node) {
  return String(node?.prompt || node?.studioTask?.prompt || node?.content || '').trim();
}

function getSuperClawNodeOutputText(node) {
  return String(
    node?.outputText ||
      node?.content ||
      node?.studioGeneratedOutput?.prompt ||
      node?.studioGeneratedOutput?.description ||
      '',
  ).trim();
}

function toOptionalNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function toSuperClawCanvasNode(node, activeCanvasId = '') {
  const id = String(node?.id || '').trim();
  if (!id) return null;
  const kind = getSuperClawNodeKind(node);
  const mediaUrl = getNodeAssetValue(node, kind);
  const studioTask = isPlainRecord(node?.studioTask) ? node.studioTask : {};
  const outputText = getSuperClawNodeOutputText(node);
  return {
    id,
    kind,
    title: getSuperClawNodeTitle(node),
    subtitle: compactText(node?.subtitle || node?.description || node?.type || kind, kind),
    status: String(studioTask.status || node?.status || node?.state || '').trim(),
    action: String(studioTask.action || studioTask.mode || node?.action || '').trim(),
    prompt: getSuperClawNodePrompt(node),
    outputText,
    sourceType: String(node?.type || kind),
    fileName: String(node?.fileName || node?.studioStagedAsset?.fileName || ''),
    mediaUrl,
    boardId: activeCanvasId,
    x: toOptionalNumber(node?.x),
    y: toOptionalNumber(node?.y),
    width: toOptionalNumber(node?.width),
    height: toOptionalNumber(node?.height),
  };
}

function toSuperClawCanvasConnection(edge, index = 0) {
  const from = getEdgeSourceId(edge);
  const to = getEdgeTargetId(edge);
  if (!from || !to) return null;
  const id = String(edge?.id || `canvaspro-edge-${from}-${to}-${index}`);
  return {
    id,
    from,
    to,
    label: String(edge?.label || edge?.refSlot || edge?.sourceHandle || edge?.targetHandle || '').trim(),
  };
}

function toSuperClawViewport(viewport = {}) {
  const zoom = Number(viewport.zoom) || 1;
  return {
    zoom,
    pan: {
      x: Number(viewport.x) || 0,
      y: Number(viewport.y) || 0,
    },
  };
}

function getSuperClawCanvasContext() {
  const snapshot = getSnapshotEnvelope();
  const activeCanvas =
    snapshot.data?.canvases?.find((canvas) => canvas.id === snapshot.data.activeCanvasId) ||
    snapshot.data?.canvases?.[0] ||
    null;
  const activeCanvasId = String(activeCanvas?.id || snapshot.data?.activeCanvasId || '');
  const rawNodes = Array.isArray(activeCanvas?.nodes)
    ? activeCanvas.nodes.filter(Boolean)
    : Object.values(activeCanvas?.nodes || {}).filter(Boolean);
  const rawEdges = Array.isArray(activeCanvas?.edges)
    ? activeCanvas.edges.filter(Boolean)
    : Object.values(activeCanvas?.edges || {}).filter(Boolean);
  const nodes = rawNodes
    .map((node) => toSuperClawCanvasNode(node, activeCanvasId))
    .filter(Boolean);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const connections = rawEdges
    .map((edge, index) => toSuperClawCanvasConnection(edge, index))
    .filter((edge) => edge && nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const state = graphStore?.getState?.() || {};
  const selectedIds = Array.isArray(state.selectedNodeIds)
    ? state.selectedNodeIds.map(String).filter((id) => nodeIds.has(id))
    : [];
  const selectedNode = nodes.find((node) => node.id === selectedIds[0]) || null;
  const viewport = toSuperClawViewport(activeCanvas?.viewport || getCanvasViewport());
  return {
    project: snapshot.project,
    projectId: snapshot.project?.id || getProjectId(),
    activeCanvasId,
    activeCanvasName: String(activeCanvas?.name || 'Default canvas'),
    selectedNode,
    selectedNodeId: selectedNode?.id || '',
    selectedNodeIds: selectedIds,
    viewport,
    nodes,
    connections,
    stats: {
      ...snapshot.stats,
      edgeCount: connections.length,
      nodeCount: nodes.length,
    },
  };
}

function openShortcutsSettings() {
  document.getElementById('btnOpenSettings')?.click?.();
  const shortcutsNav = document.querySelector('[data-pane="shortcuts"]');
  shortcutsNav?.click?.();
  return {
    opened: Boolean(shortcutsNav || document.getElementById('pane-shortcuts')),
  };
}

async function handleAction(action, payload = {}) {
  switch (action) {
    case 'getStatus':
      return {
        ready: true,
        bridgeVersion: BRIDGE_VERSION,
        apiReachable,
        lastAutosave: lastAutosaveMeta,
        stats: getSnapshotEnvelope().stats,
      };
    case 'saveSnapshot':
      return await saveBrowserSnapshot(payload.reason || 'manual');
    case 'exportPackage':
      return await exportPackage();
    case 'importPackage':
      return await importPackage(payload.file);
    case 'importMediaFiles':
      return await importMediaFiles(payload);
    case 'getSelectedContext':
      return getSelectedContext();
    case 'getSuperClawCanvasContext':
      return getSuperClawCanvasContext();
    case 'getGenerationTasks':
      return getGenerationTasks(payload);
    case 'focusGenerationTask':
      return focusGenerationTask(payload);
    case 'updateGenerationTask':
      return await updateGenerationTask(payload);
    case 'submitGenerationTask':
      return await submitGenerationTask(payload);
    case 'syncGenerationTask':
      return await syncGenerationTask(payload);
    case 'materializeGenerationOutput':
      return materializeGenerationOutput(payload);
    case 'continueGenerationOutput':
      return await continueGenerationOutput(payload);
    case 'rerunGenerationTask':
      return rerunGenerationTask(payload);
    case 'restoreGenerationTaskNode':
      return restoreGenerationTaskNode(payload);
    case 'removeGenerationTask':
      return removeGenerationTask(payload);
    case 'createNode':
      return await createNode(payload);
    case 'createFlow':
      return createFlow(payload);
    case 'createStoryboard':
      return createStoryboard(payload);
    case 'createVariants':
      return createVariants(payload);
    case 'organizeCanvas':
      return organizeCanvas(payload);
    case 'createAssistantNote':
      return createAssistantNote(payload);
    case 'openShortcuts':
      return openShortcutsSettings();
    default:
      throw new Error(`Unknown Studio bridge action: ${action}`);
  }
}

window.addEventListener('message', async (event) => {
  if (bridgeAlreadyInstalled || !isTrustedStudioRequest(event)) return;
  const message = event.data || {};
  const id = message.id;
  try {
    const payload = await handleAction(message.action, message.payload || {});
    event.source?.postMessage({ type: MESSAGE_RESPONSE, id, ok: true, payload }, event.origin);
  } catch (error) {
    event.source?.postMessage(
      {
        type: MESSAGE_RESPONSE,
        id,
        ok: false,
        error: error?.message || String(error),
      },
      event.origin,
    );
  }
});

function installAutosaveHooks() {
  graphStore?.subscribe?.((state) => {
    scheduleAutosave('graph-change');
    syncReadableNodeViewportPolicy(state);
  });
  window.addEventListener('aicanvas:dirty-state-changed', () => scheduleAutosave('dirty-state'));
  window.addEventListener('pagehide', () => {
    void saveBrowserSnapshot('pagehide').catch(() => {});
  });
  window.setTimeout(() => {
    scheduleAutosave('boot');
    syncReadableNodeViewportPolicy(graphStore?.getState?.() || {});
  }, 1600);
}

async function boot() {
  if (bridgeAlreadyInstalled) return;
  installStudioSurfacePolicy();
  installOfflineGenerationGuard();
  installAuthorSignalPolicy();
  installAutosaveHooks();
  await checkApiReachable();
  window.setInterval(checkApiReachable, 15000);
  postToStudio(
    {
      type: MESSAGE_READY,
      payload: {
        ready: true,
        bridgeVersion: BRIDGE_VERSION,
        apiReachable,
        stats: getSnapshotEnvelope().stats,
      },
    },
  );
}

void boot().catch((error) => {
  console.warn('[studio-bridge] boot failed', error);
  postToStudio(
    {
      type: MESSAGE_READY,
      payload: {
        ready: false,
        bridgeVersion: BRIDGE_VERSION,
        error: error?.message || String(error),
      },
    },
  );
});
