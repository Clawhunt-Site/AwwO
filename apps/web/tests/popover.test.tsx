import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { Popover } from '../src/ui/Popover';
import type { AnchoredPlacement } from '../src/ui/AnchoredLayer';

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: originalInnerWidth,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: originalInnerHeight,
  });
  vi.restoreAllMocks();
});

function Harness({
  onClose,
  placement,
}: {
  onClose?: () => void;
  placement?: AnchoredPlacement;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={anchorRef} type="button" onClick={() => setOpen((current) => !current)}>
        anchor
      </button>
      <button type="button">outside</button>
      <Popover
        open={open}
        anchorRef={anchorRef}
        ariaLabel="Details card"
        placement={placement}
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
      >
        <p>card body</p>
      </Popover>
    </>
  );
}

describe('Popover', () => {
  it('renders a dialog at the anchor and stays hidden until opened', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog', { name: 'Details card' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'anchor' }));
    const dialog = screen.getByRole('dialog', { name: 'Details card' });
    expect(dialog).toHaveTextContent('card body');
  });

  it('moves focus into the card on open, closes on Escape, and returns focus to the anchor', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const anchor = screen.getByRole('button', { name: 'anchor' });
    fireEvent.click(anchor);
    const dialog = screen.getByRole('dialog', { name: 'Details card' });
    // 焦点进入卡片本体——这是 Escape 真实可达的前提
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Details card' })).not.toBeInTheDocument();
    expect(anchor).toHaveFocus();
  });

  it('closes when pointing down outside, but not inside', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'anchor' }));
    fireEvent.pointerDown(screen.getByText('card body'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('can prefer opening above the anchor without changing default placement', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 480,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 400,
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(220);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 20,
      y: 140,
      top: 140,
      right: 140,
      bottom: 160,
      left: 20,
      width: 120,
      height: 20,
      toJSON: () => ({}),
    });

    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'anchor' }));
    expect(screen.getByRole('dialog', { name: 'Details card' })).toHaveStyle({
      top: '166px',
    });

    unmount();
    render(<Harness placement="top" />);
    fireEvent.click(screen.getByRole('button', { name: 'anchor' }));
    expect(screen.getByRole('dialog', { name: 'Details card' })).toHaveStyle({
      top: '34px',
    });
  });
});
