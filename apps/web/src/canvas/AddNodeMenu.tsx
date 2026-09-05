// The right-click "add node" menu (ComfyUI-style), ported from the previous canvas
// (since-deleted apps/web/src/studio/StudioAddMenu.tsx). Fixed chrome positioned at the click point — it lives
// OUTSIDE the transformed world so it renders crisp at any zoom.
//
// Escape or an outside pointerdown closes it, and BOTH listeners are removed on unmount: a menu
// that leaks a capture-phase window listener would keep swallowing presses after it is gone.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentKind } from './canvasDoc';
import { getAgentTemplates, type AgentTemplateId } from './agentTemplates';
import { AgentGlyph } from './AgentWorkspace';
import { useCanvasI18n } from './i18n';

/** What the menu can create: a user-authored form, or a session tile of one agent kind. */
export type AddNodeKind = 'form' | AgentKind | AgentTemplateId;

export interface AddNodeMenuProps {
  /** Position relative to the `.canvas-root` element (already converted by the caller). */
  at: { x: number; y: number };
  onPick: (kind: AddNodeKind) => void;
  onClose: () => void;
}

export function AddNodeMenu({ at, onPick, onClose }: AddNodeMenuProps) {
  const { locale, t } = useCanvasI18n();
  const items = getAgentTemplates(locale);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(at);

  useLayoutEffect(() => {
    const menu = ref.current;
    const parent = menu?.offsetParent;
    if (!menu || !parent) return;
    const bounds = parent.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    setPosition({
      x: Math.max(8, Math.min(at.x, bounds.width - menu.offsetWidth - 8)),
      y: Math.max(8, Math.min(at.y, bounds.height - menu.offsetHeight - 8)),
    });
  }, [at.x, at.y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);

  return (
    <div
      className="canvas-add-menu"
      style={{ left: position.x, top: position.y }}
      role="menu"
      aria-label={t('node.add')}
      data-testid="canvas-add-menu"
      ref={ref}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="canvas-add-menu-title">{t('node.addAgent')}</div>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="canvas-add-menu-item awwo-template-menu-item"
          aria-label={item.title}
          data-template={item.id}
          onClick={(e) => {
            e.stopPropagation();
            onPick(item.id);
          }}
        >
          <span className="canvas-tile-glyph"><AgentGlyph templateId={item.id} size={16} /></span>
          <span><strong>{item.title}</strong><small>{item.subtitle}</small></span>
        </button>
      ))}
    </div>
  );
}
