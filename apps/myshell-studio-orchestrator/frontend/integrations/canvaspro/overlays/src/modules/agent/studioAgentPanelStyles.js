const STUDIO_AGENT_PANEL_LAYER_STYLE_ID = 'studio-canvaspro-agent-panel-layer';

export function installStudioAgentPanelStyles() {
  if (document.getElementById(STUDIO_AGENT_PANEL_LAYER_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STUDIO_AGENT_PANEL_LAYER_STYLE_ID;
  style.textContent = `
    body.agent-sidebar-open .agent-sidebar,
    .agent-sidebar.is-open {
      z-index: var(--studio-agent-sidebar-z-index, 1000000);
    }
    .agent-sidebar-header {
      position: relative;
      overflow: visible;
    }
    body.agent-sidebar-open .agent-sidebar-header,
    body.agent-sidebar-open .agent-sidebar-header .agent-icon-btn {
      position: relative;
      z-index: 1;
    }
    body.agent-sidebar-open .agent-sidebar-header .agent-icon-btn[data-studio-agent-tooltip]:hover {
      z-index: 2;
    }
    body.agent-sidebar-open .agent-sidebar-header .agent-icon-btn[data-studio-agent-tooltip]:hover::after {
      content: attr(data-studio-agent-tooltip);
      position: absolute;
      top: calc(100% + 10px);
      left: 50%;
      z-index: var(--studio-agent-tooltip-z-index, 1000002);
      transform: translateX(-50%);
      padding: 6px 10px;
      border: 1px solid rgba(0, 0, 0, 0.12);
      border-radius: 8px;
      background: #fff;
      color: rgba(0, 0, 0, 0.92);
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28);
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      pointer-events: none;
      white-space: nowrap;
    }
    body.agent-sidebar-open .agent-sidebar-header .agent-icon-btn[data-studio-agent-tooltip]:hover::before {
      content: "";
      position: absolute;
      top: calc(100% + 4px);
      left: 50%;
      z-index: var(--studio-agent-tooltip-z-index, 1000002);
      width: 0;
      height: 0;
      transform: translateX(-50%);
      border-width: 0 6px 6px 6px;
      border-style: solid;
      border-color: transparent transparent #fff transparent;
      pointer-events: none;
    }
    body.agent-sidebar-open .agent-sidebar-header > .agent-icon-btn[data-studio-agent-tooltip]:hover::after {
      left: 0;
      transform: none;
    }
    body.agent-sidebar-open .agent-sidebar-header > .agent-icon-btn[data-studio-agent-tooltip]:hover::before {
      left: 18px;
      transform: translateX(-50%);
    }
    body.agent-sidebar-open .agent-sidebar-header .agent-header-actions .agent-icon-btn[data-studio-agent-tooltip]:hover::after {
      left: auto;
      right: 0;
      transform: none;
    }
    body.agent-sidebar-open .agent-sidebar-header .agent-header-actions .agent-icon-btn[data-studio-agent-tooltip]:hover::before {
      left: 50%;
      right: auto;
      transform: translateX(-50%);
    }
    body.agent-sidebar-open .canvas-tabs-wrap {
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}
