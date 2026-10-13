import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

it('shows its example from the real pixel-platformer canvas, in the interface language', () => {
  // The case itself is English in both interface languages; the tutorial is not: in Chinese it names the same six
  // nodes in Chinese, in English by the case's own titles.
  const example = PRODUCTION_WORKFLOWS['pixel-platformer'];
  render(<WorkModeTutorial {...base} />);
  dwell(); fireEvent.click(next());
  expect(document.querySelectorAll('.wmt-node')).toHaveLength(example.nodes.length);
  for (const title of ['玩法与数值', '像素美术', '关卡地图', '音效', '可玩试玩关', '试玩验收']) expect(screen.getByText(title)).toBeInTheDocument();
  for (const node of example.nodes) expect(screen.queryByText(node.title)).toBeNull();
  expect(screen.getByText(/画布(与用时)?来自「像素平台跳跃」/)).toBeInTheDocument();
  cleanup();
  render(<WorkModeTutorial {...base} locale="en" />);
  dwell(); fireEvent.click(next());
  expect(document.querySelectorAll('.wmt-node')).toHaveLength(example.nodes.length);
  for (const node of example.nodes) expect(screen.getByText(node.title)).toBeInTheDocument();
  expect(screen.getByText(/^Canvas (and timings )?from the .*pixel platformer/)).toBeInTheDocument();
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

it('starts every step at its top, however far the last one was scrolled', () => {
  render(<WorkModeTutorial {...base} />);
  const body = screen.getByRole('dialog').querySelector('.wmt-body')!;
  let top = 0;
  Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = value; } });
  top = 240; dwell();
  expect(top).toBe(240);                       // unlocking the step leaves the reader where they are
  fireEvent.click(next());
  expect(screen.getByText('第 2 / 7 步')).toBeVisible();
  expect(top).toBe(0);
  top = 180; fireEvent.click(screen.getByRole('button', { name: '上一步' }));
  expect(top).toBe(0);
});

it('keeps keys inside the tutorial', () => {
  const pageKey = vi.fn(); document.addEventListener('keydown', pageKey);
  render(<WorkModeTutorial {...base} />);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Delete' });
  expect(pageKey).not.toHaveBeenCalled();
  document.removeEventListener('keydown', pageKey);
});

it('lays every scene on columns that cannot grow past it', () => {
  // An auto column (or a bare 1fr) grows to its widest unbreakable line: the one-line prompt once pushed the
  // prompt and the canvas over the words beside the scene. jsdom has no layout, so the rule itself is checked.
  const css = readFileSync(resolve(process.cwd(), 'src/saas/work-mode-tutorial.css'), 'utf8');
  expect(css).toMatch(/\.wmt-scene \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  for (const [, value] of css.matchAll(/grid-template-columns:\s*([^;]+);/g)) {
    const tracks = value.trim().replace(/\s*,\s*/g, ', ');
    for (const track of tracks.match(/repeat\(\d+, minmax\([^)]*\)\)|minmax\([^)]*\)|\S+/g) ?? []) {
      expect(track, tracks).toMatch(/^(minmax\(0, [\d.]+fr\)|repeat\(\d+, minmax\(0, [\d.]+fr\)\)|\d+px)$/);
    }
  }
});
