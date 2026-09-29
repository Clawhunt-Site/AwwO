import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import { createPortal, useAnchoredPosition, useOutsideClose } from './AnchoredLayer';
import type { AnchoredPlacement } from './AnchoredLayer';

/** Cycle the active layer's usable controls, including its initially focused container. */
export function containDialogTab(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return;
  event.preventDefault();
  const layer = event.currentTarget;
  const controls = Array.from(layer.querySelectorAll<HTMLElement>(
    'button, a[href], input, select, textarea, summary, [tabindex], [contenteditable="true"]',
  )).filter(element => {
    if (element.matches(':disabled, input[type="hidden"]') ||
      (element.hasAttribute('tabindex') && element.tabIndex < 0) ||
      element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
        const summary = ancestor.querySelector(':scope > summary');
        if (!summary?.contains(element)) return false;
      }
      if (ancestor === layer) break;
    }
    return true;
  }).sort((left, right) => {
    // Explicit positive tab stops precede the normal document order.
    const order = (element: HTMLElement) => element.tabIndex > 0 ? element.tabIndex : Infinity;
    return order(left) - order(right) || 0;
  });
  const current = controls.indexOf(document.activeElement as HTMLElement);
  const next = current < 0 ? (event.shiftKey ? controls.length - 1 : 0)
    : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
  (controls[next] ?? layer).focus({ preventScroll: true });
}

/**
 * 锚定信息弹窗（如右上角状态 chip 点开的详情卡）。
 *
 * 与 Dropdown 共享 AnchoredLayer 的 portal 定位/翻转/点外关闭；
 * 区别在内容物与键盘模型：Popover 装任意信息卡（role=dialog），
 * 不管理选项高亮/选中，Escape 关闭并把焦点还给锚点。
 *
 * 纯表现层组件：内容由调用方提供。
 */
export function Popover({
  open,
  anchorRef,
  ariaLabel,
  className,
  placement,
  containKeyboard = false,
  onClose,
  children,
}: {
  open: boolean;
  /** 触发浮层的锚点元素（通常是触发按钮） */
  anchorRef: RefObject<HTMLElement | null>;
  ariaLabel: string;
  className?: string;
  placement?: AnchoredPlacement;
  /** Keep focus and dialog actions inside the layer instead of reaching canvas shortcuts. */
  containKeyboard?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const style = useAnchoredPosition(open, anchorRef, layerRef, placement);
  useOutsideClose(open, [anchorRef, layerRef], onClose);

  // 打开即把焦点移入卡片：否则焦点留在锚点上，卡片内的 Escape 永远收不到
  useEffect(() => {
    if (open) layerRef.current?.focus({ preventScroll: true });
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (containKeyboard) {
      event.stopPropagation();
      containDialogTab(event);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchorRef.current?.focus?.({ preventScroll: true });
    }
  };

  return createPortal(
    <div
      ref={layerRef}
      role="dialog"
      aria-label={ariaLabel}
      tabIndex={-1}
      className={`sc-popover${className ? ` ${className}` : ''}`}
      style={style}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}
