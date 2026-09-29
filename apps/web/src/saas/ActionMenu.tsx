import { useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Popover } from '../ui/Popover';

/** Secondary actions share the existing keyboard and anchored-layer behavior. */
export function ActionMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); anchor.current?.focus({ preventScroll: true }); };
  return <>
    <button ref={anchor} type="button" className="saas-action-menu-trigger" aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}><MoreHorizontal size={20} aria-hidden="true" /></button>
    <Popover containKeyboard open={open} anchorRef={anchor} ariaLabel={label} className="saas-action-menu" onClose={() => setOpen(false)}>{children(close)}</Popover>
  </>;
}
