import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GameDemo, InteractionDemo, SceneDemo } from '../src/saas/examples/CreativeDemos';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('recalculates a real seat and billing quote, and invalidates the saved plan after a change', () => {
  render(<InteractionDemo locale="en" />);
  expect(screen.getByLabelText('Monthly total')).toHaveTextContent('¥276');
  expect(screen.getByLabelText('Invoice total')).toHaveTextContent('¥3,312');
  fireEvent.click(screen.getByRole('button', { name: 'Monthly', exact: true }));
  expect(screen.getByLabelText('Monthly total')).toHaveTextContent('¥345');
  expect(screen.getByLabelText('Invoice total')).toHaveTextContent('¥345');
  fireEvent.change(screen.getByRole('slider', { name: 'Team size' }), { target: { value: '12' } });
  fireEvent.click(screen.getByRole('button', { name: /^Scale/ }));
  expect(screen.getByLabelText('Monthly total')).toHaveTextContent('¥1,548');
  fireEvent.click(screen.getByRole('button', { name: /^Yearly/ }));
  expect(screen.getByLabelText('Monthly total')).toHaveTextContent('¥1,238.4');
  expect(screen.getByLabelText('Invoice total')).toHaveTextContent('¥14,860.8');
  fireEvent.click(screen.getByRole('button', { name: 'Build my plan' }));
  expect(screen.getByRole('status', { name: 'Plan status' })).toHaveTextContent('Local plan ready: Scale · 12 seats · ¥14,860.8 / year');
  fireEvent.click(screen.getByRole('button', { name: /^Starter/ }));
  expect(screen.getByRole('status', { name: 'Plan status' })).toHaveTextContent('no order is placed');
});

const moveWithButtons = (route: string) => {
  const names: Record<string, string> = { U: 'Move up', R: 'Move right', D: 'Move down', L: 'Move left' };
  for (const direction of route) fireEvent.click(screen.getByRole('button', { name: names[direction] }));
};

it('only handles movement keys when the game area is focused and ignores walls', () => {
  render(<GameDemo locale="en" />);
  const arena = screen.getByRole('group', { name: /^Game area/ });
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  fireEvent.keyDown(arena, { key: 'ArrowRight' });
  expect(screen.getByLabelText('Move count')).toHaveTextContent('00');
  arena.focus();
  fireEvent.keyDown(arena, { key: 'ArrowUp' });
  expect(screen.getByRole('status', { name: 'Game status' })).toHaveTextContent('Path blocked');
  expect(screen.getByLabelText('Energy left')).toHaveTextContent('22');
  fireEvent.keyDown(arena, { key: 'ArrowRight', ctrlKey: true });
  expect(screen.getByLabelText('Move count')).toHaveTextContent('00');
  fireEvent.keyDown(arena, { key: 'd' });
  expect(screen.getByLabelText('Move count')).toHaveTextContent('01');
  expect(screen.getByRole('img')).toHaveAccessibleName(/row 1, column 2/);
  screen.getByRole('button', { name: /Restart/ }).focus();
  fireEvent.keyDown(arena, { key: 'ArrowRight' });
  expect(screen.getByLabelText('Move count')).toHaveTextContent('01');
});

it('grants energy only once per pickup, and resets all game state', () => {
  render(<GameDemo locale="en" />);
  moveWithButtons('DDR');
  expect(screen.getByLabelText('Energy left')).toHaveTextContent('26');
  expect(screen.getByLabelText('Collected nodes')).toHaveTextContent('1 / 3');
  moveWithButtons('RL');
  expect(screen.getByLabelText('Energy left')).toHaveTextContent('24');
  expect(screen.getByLabelText('Collected nodes')).toHaveTextContent('1 / 3');
  fireEvent.click(screen.getByRole('button', { name: /Restart/ }));
  expect(screen.getByLabelText('Energy left')).toHaveTextContent('22');
  expect(screen.getByLabelText('Collected nodes')).toHaveTextContent('0 / 3');
  expect(screen.getByLabelText('Move count')).toHaveTextContent('00');
  expect(screen.getByRole('group', { name: /^Game area/ })).toHaveFocus();
});

it('requires all three nodes to win and freezes movement after the exit is reached', () => {
  render(<GameDemo locale="en" />);
  moveWithButtons('DDRRDDLLDDRRURRUDDRR');
  expect(screen.getByLabelText('Collected nodes')).toHaveTextContent('3 / 3');
  expect(screen.getByLabelText('Move count')).toHaveTextContent('20');
  expect(screen.getByLabelText('Energy left')).toHaveTextContent('23');
  expect(screen.getByRole('status', { name: 'Game status' })).toHaveTextContent('Signal connected');
  expect(screen.getByRole('button', { name: 'Move left' })).toBeDisabled();
  const arena = screen.getByRole('group', { name: /^Game area/ });
  arena.focus(); fireEvent.keyDown(arena, { key: 'ArrowLeft' });
  expect(screen.getByLabelText('Move count')).toHaveTextContent('20');
});

it('keeps the exit locked when reached before collecting the energy nodes', () => {
  render(<GameDemo locale="en" />);
  moveWithButtons('RRDDRRDRRDDD');
  expect(screen.getByRole('img')).toHaveAccessibleName(/row 7, column 7/);
  expect(screen.getByLabelText('Collected nodes')).toHaveTextContent('0 / 3');
  expect(screen.getByRole('status', { name: 'Game status' })).toHaveTextContent('Exit locked');
  expect(screen.getByRole('button', { name: 'Move left' })).toBeEnabled();
});

it('loses when energy runs out and can start a new game', () => {
  render(<GameDemo locale="en" />);
  moveWithButtons('RL'.repeat(11));
  expect(screen.getByRole('status', { name: 'Game status' })).toHaveTextContent('Out of energy');
  expect(screen.getByLabelText('Energy left')).toHaveTextContent('00');
  expect(screen.getByRole('button', { name: 'Move down' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: /Restart/ }));
  expect(screen.getByRole('button', { name: 'Move down' })).toBeEnabled();
  expect(screen.getByLabelText('Move count')).toHaveTextContent('00');
});

it('updates projected geometry, camera and material independently', () => {
  const { container } = render(<SceneDemo locale="en" />);
  const front = () => container.querySelector('[data-face="body-4"] > polygon')!;
  const perspective = front().getAttribute('points');
  fireEvent.click(screen.getByRole('button', { name: 'Front', exact: true }));
  const frontal = front().getAttribute('points');
  expect(frontal).not.toEqual(perspective);
  const oldFill = front().getAttribute('fill');
  fireEvent.click(screen.getByRole('button', { name: 'Moss', exact: true }));
  expect(front().getAttribute('fill')).not.toEqual(oldFill);
  expect(front().getAttribute('points')).toEqual(frontal);
  fireEvent.change(screen.getByRole('slider', { name: /ZOOM/ }), { target: { value: '125' } });
  expect(front().getAttribute('points')).not.toEqual(frontal);
  const zoomed = front().getAttribute('points');
  const scene = screen.getByRole('img');
  scene.focus(); fireEvent.keyDown(scene, { key: 'ArrowLeft' });
  expect(front().getAttribute('points')).not.toEqual(zoomed);
  expect(container.querySelectorAll('[data-face]')).not.toHaveLength(0);
});

it('animates only on request, cancels its frame on unmount and removes its preference listener', () => {
  const frames: FrameRequestCallback[] = [];
  const request = vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  const cancel = vi.fn(); const removeEventListener = vi.fn();
  vi.stubGlobal('requestAnimationFrame', request); vi.stubGlobal('cancelAnimationFrame', cancel);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener })));
  const { container, unmount } = render(<SceneDemo locale="en" />);
  expect(request).not.toHaveBeenCalled();
  const before = container.querySelector('[data-face="body-4"] > polygon')!.getAttribute('points');
  fireEvent.click(screen.getByRole('button', { name: /Auto rotate/ }));
  expect(request).toHaveBeenCalledTimes(1);
  act(() => { frames[0](100); });
  act(() => { frames[1](132); });
  expect(container.querySelector('[data-face="body-4"] > polygon')!.getAttribute('points')).not.toEqual(before);
  expect(screen.getByRole('button', { name: /Pause rotation/ })).toHaveAttribute('aria-pressed', 'true');
  unmount();
  expect(cancel).toHaveBeenCalledWith(3);
  expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
});

it('orbits on a primary drag and stops dragging after pointer cancellation', () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  const { container } = render(<SceneDemo locale="en" />);
  const scene = screen.getByRole('img');
  const capture = vi.fn();
  Object.defineProperty(scene, 'setPointerCapture', { value: capture, configurable: true });
  const points = () => container.querySelector('[data-face="body-4"] > polygon')?.getAttribute('points');
  const before = points();
  fireEvent.pointerDown(scene, { button: 0, clientX: 200, clientY: 180 });
  fireEvent.pointerMove(scene, { clientX: 220, clientY: 185 });
  expect(points()).not.toEqual(before);
  expect(capture).toHaveBeenCalled();
  const moved = points();
  fireEvent.pointerCancel(scene);
  fireEvent.pointerMove(scene, { clientX: 250, clientY: 190 });
  expect(points()).toEqual(moved);
});

it('respects reduced motion while preserving manual 3D controls and Chinese copy', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  render(<SceneDemo locale="zh" />);
  expect(screen.getByRole('button', { name: /已遵循减少动态效果设置/ })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '岩灰' }));
  expect(screen.getByRole('button', { name: '岩灰' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: '俯视' }));
  expect(screen.getByRole('slider', { name: /缩放/ })).toHaveValue('100');
});
