import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';

// 锚定浮层家族（Dropdown/Popover）统一从这里取 portal 入口，
// 让缺少 @types/react-dom 的环境性 TS7016 只计一处
export { createPortal } from 'react-dom';

/**
 * 锚定浮层共享层：portal 浮层的定位（fixed + 视口内自动上/下翻转 + 跟随
 * 滚动/缩放/尺寸变化重算）与"点外关闭"。
 *
 * Dropdown（菜单语义）与 Popover（信息卡语义）共同消费这两个 hook——
 * 它们只差内容物与键盘模型，定位与关闭行为必须保持一致。
 */

export const LAYER_GAP = 6;
export const VIEWPORT_PADDING = 8;

export type AnchoredPlacement = 'auto' | 'top' | 'bottom';

export function useAnchoredPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  layerRef: RefObject<HTMLElement | null>,
  placement: AnchoredPlacement = 'auto',
) {
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });

  const update = useCallback(() => {
    const anchor = anchorRef.current;
    const layer = layerRef.current;
    if (!anchor || !layer) return;
    const rect = anchor.getBoundingClientRect();
    const layerWidth = layer.offsetWidth;
    const layerHeight = layer.offsetHeight;
    const spaceAbove = rect.top - VIEWPORT_PADDING - LAYER_GAP;
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING - LAYER_GAP;
    const fitsAbove = spaceAbove >= layerHeight;
    const fitsBelow = spaceBelow >= layerHeight;
    const openUp =
      placement === 'top'
        ? fitsAbove || (!fitsBelow && spaceAbove > spaceBelow)
        : placement === 'bottom'
          ? !fitsBelow && (fitsAbove || spaceAbove > spaceBelow)
          : spaceBelow < layerHeight && rect.top > spaceBelow;
    const top = openUp
      ? Math.max(VIEWPORT_PADDING, rect.top - layerHeight - LAYER_GAP)
      : rect.bottom + LAYER_GAP;
    const left = Math.max(
      VIEWPORT_PADDING,
      Math.min(rect.left, window.innerWidth - layerWidth - VIEWPORT_PADDING),
    );
    setStyle({ top, left, minWidth: rect.width, visibility: 'visible' });
  }, [anchorRef, layerRef, placement]);

  useLayoutEffect(() => {
    if (open) update();
    else setStyle({ visibility: 'hidden' });
  }, [open, update]);

  // 浮层内容或锚点尺寸变化时重算翻转位置
  useEffect(() => {
    if (!open || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => update());
    if (layerRef.current) observer.observe(layerRef.current);
    if (anchorRef.current) observer.observe(anchorRef.current);
    return () => observer.disconnect();
  }, [open, update, anchorRef, layerRef]);

  // scroll 用捕获阶段才能跟住任意祖先容器的滚动；rAF 节流避免高频重排
  const frameRef = useRef<number | null>(null);
  const scheduleUpdate = useCallback(() => {
    if (frameRef.current != null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      update();
    });
  }, [update]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('scroll', scheduleUpdate, true);
    return () => {
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate, true);
      if (frameRef.current != null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [open, scheduleUpdate]);

  return style;
}

export function useOutsideClose(
  open: boolean,
  refs: Array<RefObject<HTMLElement | null>>,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const inside = refs.some((ref) => {
        const el = ref.current;
        if (!el) return false;
        if (el.contains(target)) return true;
        // 触发器可能被 <label> 包裹：label 文本的点击会被浏览器转发回触发器，
        // 必须视作内部点击，否则 pointerdown 先关浮层、转发的 click 又把它打开
        const label = el.closest('label');
        return !!label && label.contains(target);
      });
      if (!inside) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
    // refs 是稳定的 ref 对象数组，依赖 open/close 即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, close]);
}
