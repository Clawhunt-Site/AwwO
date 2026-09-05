import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import { createPortal, useAnchoredPosition, useOutsideClose } from './AnchoredLayer';
import type { AnchoredPlacement } from './AnchoredLayer';

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
  onClose,
  children,
}: {
  open: boolean;
  /** 触发浮层的锚点元素（通常是触发按钮） */
  anchorRef: RefObject<HTMLElement | null>;
  ariaLabel: string;
  className?: string;
  placement?: AnchoredPlacement;
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
    if (event.key === 'Escape') {
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
