import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useCanvasKeys } from '../src/canvas/useCanvasKeys';
import { ActionMenu } from '../src/saas/ActionMenu';
import { useRef } from 'react';
import { Popover } from '../src/ui/Popover';
afterEach(cleanup);

it('reveals secondary actions on demand and restores the trigger on Escape', () => {
  render(<ActionMenu label="More options">{() => <button>Settings</button>}</ActionMenu>);
  const trigger = screen.getByRole('button', { name: 'More options' });
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'More options' });
  expect(dialog).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger).toHaveFocus();
});

it('closes the action layer before the selected action opens its own dialog', () => {
  const action = vi.fn();
  render(<ActionMenu label="Canvas options">{close => <button onClick={() => { close(); action(); }}>Rename</button>}</ActionMenu>);
  fireEvent.click(screen.getByRole('button', { name: 'Canvas options' }));
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  expect(action).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
});


it('keeps menu keystrokes from deleting or undoing the selected canvas nodes', () => {
  const mutate = vi.fn();
  function Canvas() {
    useCanvasKeys({ onDeleteSelection: mutate, onUndo: mutate, onPalette: mutate, onEscape: mutate });
    return <ActionMenu label="More options">{() => <button>Settings</button>}</ActionMenu>;
  }
  render(<Canvas />);
  fireEvent.click(screen.getByRole('button', { name: 'More options' }));
  const panel = screen.getByRole('dialog');
  for (const key of ['Delete', 'Backspace']) fireEvent.keyDown(panel, { key });
  for (const key of ['z', 'p']) fireEvent.keyDown(panel, { key, ctrlKey: true });
  fireEvent.keyDown(panel, { key: 'Escape' });
  expect(mutate).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('cycles actual focus through usable actions in both Tab directions without reaching the canvas', () => {
  const mutate = vi.fn();
  function Canvas() {
    useCanvasKeys({ onDeleteSelection: mutate, onUndo: mutate, onPalette: mutate, onEscape: mutate });
    return <><button>Canvas action</button><ActionMenu label="More options">{() => <>
      <button>First action</button><button disabled>Disabled action</button>
      <div hidden><button>Hidden action</button></div>
      <div style={{ display: 'none' }}><button>Invisible action</button></div>
      <button tabIndex={-1}>Programmatic only</button>
      <details><summary>More detail</summary><button>Collapsed action</button></details>
      <a href="#account">Last action</a>
    </>}</ActionMenu></>;
  }
  render(<Canvas />);
  const trigger = screen.getByRole('button', { name: 'More options' });
  fireEvent.click(trigger);
  const panel = screen.getByRole('dialog');
  const first = screen.getByRole('button', { name: 'First action' });
  const last = screen.getByRole('link', { name: 'Last action' });
  expect(panel).toHaveFocus();
  const tabTo = (target: HTMLElement, shiftKey = false) => {
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey });
    expect(target).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Delete' });
    expect(mutate).not.toHaveBeenCalled();
  };
  tabTo(first);
  tabTo(screen.getByText('More detail'));
  tabTo(last);
  tabTo(first);
  tabTo(last, true);
  tabTo(screen.getByText('More detail'), true);
  tabTo(first, true);
  panel.focus();
  tabTo(last, true);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger).toHaveFocus();
  expect(mutate).not.toHaveBeenCalled();
});

it('keeps focus on an action layer with no usable controls', () => {
  render(<><button>Outside</button><ActionMenu label="Unavailable actions">{() => <>
    <button disabled>Disabled</button><span tabIndex={-1}>Information</span>
  </>}</ActionMenu></>);
  const trigger = screen.getByRole('button', { name: 'Unavailable actions' });
  fireEvent.click(trigger);
  const panel = screen.getByRole('dialog');
  for (const shiftKey of [false, true]) {
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey });
    expect(panel).toHaveFocus();
  }
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(trigger).toHaveFocus();
});

it('leaves Tab behavior unchanged for popovers that do not opt into keyboard containment', () => {
  function NormalPopover() {
    const anchor = useRef<HTMLButtonElement>(null);
    return <><button ref={anchor}>Anchor</button><Popover open anchorRef={anchor} ariaLabel="Normal popover" onClose={() => {}}>
      <button>Normal action</button>
    </Popover></>;
  }
  render(<NormalPopover />);
  const panel = screen.getByRole('dialog');
  expect(panel).toHaveFocus();
  // jsdom has no browser-default tab traversal; verify this opt-out does not cancel it.
  expect(fireEvent.keyDown(document.activeElement!, { key: 'Tab' })).toBe(true);
});
