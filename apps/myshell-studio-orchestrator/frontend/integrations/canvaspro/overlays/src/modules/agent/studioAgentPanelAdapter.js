import { initAgentPanel as initNativeAgentPanel } from './agentPanel.js';
import { installStudioAgentPanelStyles } from './studioAgentPanelStyles.js';

const STUDIO_COLLAPSE_BEHAVIOR = 'close';
const STUDIO_AGENT_PANEL_EVENT = 'aicanvas-studio:agent-panel';
const AGENT_HEADER_ICON_BUTTON_SELECTOR = '.agent-sidebar-header .agent-icon-btn';

function isEmbeddedInStudio() {
  return globalThis.window?.parent && globalThis.window.parent !== globalThis.window;
}

function getPanelState(panelApi) {
  const panel = panelApi?.panel;
  if (!(panel instanceof Element)) return { open: false, collapsed: false };
  return {
    collapsed: panel.classList.contains('agent-sidebar-collapsed'),
    open: panel.classList.contains('is-open'),
  };
}

function notifyPanelState(panelApi) {
  const payload = {
    ...getPanelState(panelApi),
    type: STUDIO_AGENT_PANEL_EVENT,
  };
  globalThis.window?.dispatchEvent?.(new CustomEvent(STUDIO_AGENT_PANEL_EVENT, { detail: payload }));
  if (isEmbeddedInStudio()) {
    globalThis.window.parent.postMessage(payload, globalThis.window.location.origin);
  }
}

function observePanelState(panelApi) {
  const panel = panelApi?.panel;
  if (!(panel instanceof Element) || panelApi.__studioCanvasProAgentObserver === true) return;
  const observer = new MutationObserver(() => notifyPanelState(panelApi));
  observer.observe(panel, { attributeFilter: ['class'], attributes: true });
  Object.defineProperty(panelApi, '__studioCanvasProAgentObserver', { value: true });
  Object.defineProperty(panelApi, '__studioCanvasProAgentMutationObserver', { value: observer });
}

function findCollapseButton(panel) {
  return panel?.querySelector?.('.agent-collapse-btn') || null;
}

function replaceCollapseButtonWithClose(panelApi) {
  const panel = panelApi?.panel;
  const nativeClose = panelApi?.close;
  if (!(panel instanceof Element) || typeof nativeClose !== 'function') return;

  const currentButton = findCollapseButton(panel);
  if (!(currentButton instanceof HTMLElement)) return;
  if (currentButton.dataset.studioCollapseBehavior === STUDIO_COLLAPSE_BEHAVIOR) return;

  const button = currentButton.cloneNode(true);
  if (!(button instanceof HTMLElement)) return;
  button.dataset.studioCollapseBehavior = STUDIO_COLLAPSE_BEHAVIOR;
  button.setAttribute('aria-expanded', 'true');

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    nativeClose();
    notifyPanelState(panelApi);
  });

  currentButton.replaceWith(button);
}

function readHeaderButtonTooltip(button) {
  return (
    button.getAttribute('data-tooltip') ||
    button.getAttribute('data-native-title') ||
    button.getAttribute('aria-label') ||
    button.getAttribute('title') ||
    ''
  ).trim();
}

function useStudioHeaderButtonTooltip(button) {
  const label = readHeaderButtonTooltip(button);
  if (!label) return;
  button.setAttribute('data-studio-agent-tooltip', label);
  if (!button.getAttribute('aria-label')) {
    button.setAttribute('aria-label', label);
  }
  button.removeAttribute('data-tooltip');
  button.removeAttribute('data-tooltip-source');
  button.removeAttribute('data-native-title');
  button.removeAttribute('title');
}

function normalizeAgentHeaderTooltips(panel) {
  panel.querySelectorAll(AGENT_HEADER_ICON_BUTTON_SELECTOR).forEach((button) => {
    if (button instanceof HTMLElement) useStudioHeaderButtonTooltip(button);
  });
}

function installStudioAgentPanelBehavior(panelApi) {
  const panel = panelApi?.panel;
  if (!(panel instanceof Element)) return;
  replaceCollapseButtonWithClose(panelApi);
  normalizeAgentHeaderTooltips(panel);
}

function adaptAgentPanelApi(panelApi) {
  if (!panelApi || panelApi.__studioCanvasProAgentAdapter === true) return panelApi;

  observePanelState(panelApi);
  installStudioAgentPanelBehavior(panelApi);

  const nativeOpen = panelApi.open;
  if (typeof nativeOpen === 'function') {
    panelApi.open = (...args) => {
      const result = nativeOpen(...args);
      installStudioAgentPanelBehavior(panelApi);
      notifyPanelState(panelApi);
      return result;
    };
  }

  const nativeToggle = panelApi.toggle;
  if (typeof nativeToggle === 'function') {
    panelApi.toggle = (...args) => {
      const result = nativeToggle(...args);
      installStudioAgentPanelBehavior(panelApi);
      notifyPanelState(panelApi);
      return result;
    };
  }

  const nativeClose = panelApi.close;
  if (typeof nativeClose === 'function') {
    panelApi.close = (...args) => {
      const result = nativeClose(...args);
      notifyPanelState(panelApi);
      return result;
    };
    panelApi.collapse = (...args) => panelApi.close(...args);
  }

  Object.defineProperty(panelApi, '__studioCanvasProAgentAdapter', { value: true });
  notifyPanelState(panelApi);
  return panelApi;
}

export function initAgentPanel(options = {}) {
  installStudioAgentPanelStyles();
  return adaptAgentPanelApi(initNativeAgentPanel(options));
}
