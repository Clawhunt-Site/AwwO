import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import WorkModeTutorial, { STEP_DWELL_MS, type WorkModeTutorialProps } from '../src/saas/WorkModeTutorial';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';

const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
const close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); });
const base: WorkModeTutorialProps = { open: true, locale: 'zh', onClose: () => {} };
const next = () => screen.getByRole('button', { name: /^(下一步|Next|开始使用 AwwO|Start using AwwO)$/ });
const dwell = () => act(() => { vi.advanceTimersByTime(STEP_DWELL_MS + 10); });
/** Walk to the last step, waiting out each step as a person would. */
function walk(steps = 6) { for (let i = 0; i < steps; i++) { dwell(); fireEvent.click(next()); } }

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: showModal });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: close });
  showModal.mockClear(); close.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('explains the work mode in seven steps on a native modal, starting with the heading in focus', () => {
  render(<WorkModeTutorial {...base} />);
  expect(showModal).toHaveBeenCalledTimes(1);
  const dialog = screen.getByRole('dialog', { name: 'AwwO 怎么工作' });
  expect(dialog).toHaveAttribute('open');
  expect(screen.getByRole('heading', { level: 2, name: 'AwwO 怎么工作' })).toHaveFocus();
  expect(screen.getByText('第 1 / 7 步')).toBeVisible();
  const titles = ['一句需求，先铺成一张画布', '节点：一位 Agent，一项任务', '连线：上游的真实产出就是下游的输入', '阶段：能同时做的，就一起做', '运行：按阶段推进，状态一目了然', '验收与交付，然后轮到你'];
  for (const title of titles) { dwell(); fireEvent.click(next()); expect(screen.getByRole('heading', { level: 2, name: title })).toHaveFocus(); }
  expect(screen.getByText('第 7 / 7 步')).toBeVisible();
});

it('shows its example from the real pixel-platformer canvas', () => {
  render(<WorkModeTutorial {...base} />);
  dwell(); fireEvent.click(next());
  const example = PRODUCTION_WORKFLOWS['pixel-platformer'];
  for (const node of example.nodes) expect(screen.getByText(node.title.zh)).toBeInTheDocument();
  expect(screen.getByText(/画布(与用时)?来自「像素平台跳跃」/)).toBeInTheDocument();
});

it('unlocks each step only after its scene has played, and never locks a step again', () => {
  const onClose = vi.fn();
  render(<WorkModeTutorial {...base} onClose={onClose} />);
  fireEvent.click(next());
  expect(screen.getByText('第 1 / 7 步')).toBeVisible();
  expect(next()).toHaveAttribute('aria-disabled', 'true');
  dwell();
  expect(next()).not.toHaveAttribute('aria-disabled');
  fireEvent.click(next());
  expect(screen.getByText('第 2 / 7 步')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '上一步' }));
  fireEvent.click(next());                     // the first step stays unlocked
  expect(screen.getByText('第 2 / 7 步')).toBeVisible();
  expect(onClose).not.toHaveBeenCalled();
});

it('cannot be closed or skipped when it is mandatory, by button or by Escape', () => {
  const onClose = vi.fn();
  render(<WorkModeTutorial {...base} mandatory onClose={onClose} />);
  const dialog = screen.getByRole('dialog');
  expect(screen.queryByRole('button', { name: '关闭讲解' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '跳过' })).not.toBeInTheDocument();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  const cancel = new Event('cancel', { cancelable: true }); dialog.dispatchEvent(cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByText(/看完全部 7 步就能开始使用/)).toBeVisible();
  // A browser that closes it anyway (a repeated-Escape close watcher) has it shown again.
  dialog.removeAttribute('open'); fireEvent(dialog, new Event('close'));
  expect(showModal).toHaveBeenCalledTimes(2);
  expect(onClose).not.toHaveBeenCalled();
  walk(); dwell(); fireEvent.click(next());
  expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
});

it('can be closed, skipped or escaped when optional, which does not count as completed', () => {
  const onClose = vi.fn();
  const { unmount } = render(<WorkModeTutorial {...base} onClose={onClose} />);
  fireEvent.click(screen.getByRole('button', { name: '跳过' }));
  expect(onClose).toHaveBeenLastCalledWith(false);
  unmount(); render(<WorkModeTutorial {...base} onClose={onClose} />);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(onClose).toHaveBeenLastCalledWith(false);
  cleanup(); render(<WorkModeTutorial {...base} locale="en" onClose={onClose} />);
  fireEvent.click(screen.getByRole('button', { name: 'Close the tutorial' }));
  expect(onClose).toHaveBeenLastCalledWith(false);
  expect(onClose).toHaveBeenCalledTimes(3);
});

it('ends by completing, optionally handing over to the prompt box, and never fetches or runs anything', () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const onClose = vi.fn(), onStart = vi.fn();
  render(<WorkModeTutorial {...base} onClose={onClose} onStart={onStart} />);
  walk();
  expect(screen.getByRole('button', { name: '去写第一个需求' })).toBeDisabled();
  dwell();
  fireEvent.click(screen.getByRole('button', { name: '去写第一个需求' }));
  expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
});

it('speaks to readers without inviting them to write a brief', () => {
  render(<WorkModeTutorial {...base} readOnly onStart={() => {}} />);
  walk(); dwell();
  expect(screen.getByText(/现在打开一张团队画布看看/)).toBeVisible();
  expect(screen.queryByRole('button', { name: '去写第一个需求' })).not.toBeInTheDocument();
});

it('keeps keys inside the tutorial', () => {
  const pageKey = vi.fn(); document.addEventListener('keydown', pageKey);
  render(<WorkModeTutorial {...base} />);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Delete' });
  expect(pageKey).not.toHaveBeenCalled();
  document.removeEventListener('keydown', pageKey);
});
