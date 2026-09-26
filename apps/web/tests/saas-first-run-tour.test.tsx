import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FirstRunTour, type FirstRunTourProps } from '../src/saas/FirstRunTour';

const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
const close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); });
const base: FirstRunTourProps = { open: true, scene: 'workspace', locale: 'zh', onClose: () => {} };
const next = () => fireEvent.click(screen.getByRole('button', { name: /^(下一步|Next)$/ }));
const rectangle = (left: number, top: number, width: number, height: number): DOMRect => ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON() {} });

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: showModal });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: close });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  showModal.mockClear(); close.mockClear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('FirstRunTour', () => {
  it('uses a native modal and restores focus after dismissal', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger); trigger.focus();
    const onClose = vi.fn();
    const { rerender } = render(<FirstRunTour {...base} onClose={onClose} />);
    expect(showModal).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole('dialog', { name: '欢迎来到 AwwO' });
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByRole('heading', { name: '欢迎来到 AwwO' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
    expect(close).toHaveBeenCalledTimes(1);
    rerender(<FirstRunTour {...base} open={false} onClose={onClose} />);
    expect(trigger).toHaveFocus(); trigger.remove();
  });

  it('does not compete with background drawer keyboard handlers', () => {
    const drawerKey = vi.fn(); document.addEventListener('keydown', drawerKey);
    const { unmount } = render(<FirstRunTour {...base} />);
    fireEvent.keyDown(screen.getByRole('button', { name: '下一步' }), { key: 'Tab' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    expect(drawerKey).not.toHaveBeenCalled();
    expect(screen.getByText('第 1 / 3 步')).toBeInTheDocument();
    unmount(); document.removeEventListener('keydown', drawerKey);
  });

  it('shows no UI when closed and restarts when opened again', () => {
    const { rerender } = render(<FirstRunTour {...base} open={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<FirstRunTour {...base} />); next();
    expect(screen.getByRole('heading', { name: '先准备执行引擎' })).toBeInTheDocument();
    rerender(<FirstRunTour {...base} open={false} />);
    rerender(<FirstRunTour {...base} />);
    expect(screen.getByRole('heading', { name: '欢迎来到 AwwO' })).toBeInTheDocument();
  });

  it('walks through the workspace with no creation or network side effects', () => {
    const onClose = vi.fn(); const onAction = vi.fn(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    render(<FirstRunTour {...base} onClose={onClose} onAction={onAction} />);
    next(); next();
    expect(screen.getByRole('heading', { name: '给任务建一张画布' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '上一步' }));
    expect(screen.getByRole('heading', { name: '先准备执行引擎' })).toBeInTheDocument();
    next();
    expect(screen.getByText('第 3 / 3 步')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '给任务建一张画布' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '打开 ClawHunt 主站' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
    expect(onAction).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { scene: 'workspace' as const, steps: 1, label: '去连接引擎', action: 'engines' },
    { scene: 'workspace' as const, steps: 2, label: '去创建画布', action: 'create-canvas' },
    { scene: 'engines' as const, steps: 1, label: '去填写 API Key', action: 'provider-key' },
  ])('closes before the explicit $action navigation action', ({ scene, steps, label, action }) => {
    const calls: string[] = [];
    render(<FirstRunTour {...base} scene={scene} onClose={done => calls.push(`close:${done}`)} onAction={value => calls.push(value)} />);
    for (let i = 0; i < steps; i++) next();
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(calls).toEqual(['close:false', action]);
  });

  it('uses read-only instructions without create or connect actions', () => {
    const onAction = vi.fn();
    const { rerender } = render(<FirstRunTour {...base} readOnly onAction={onAction} />);
    expect(screen.queryByText('左侧')).toBeNull();
    expect(screen.queryByText('右侧')).toBeNull();
    next();
    expect(screen.getByRole('heading', { name: '了解执行权限' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '去连接引擎' })).toBeNull();
    next();
    expect(screen.getByRole('heading', { name: '打开团队画布' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '去创建画布' })).toBeNull();
    rerender(<FirstRunTour {...base} scene="canvas" readOnly onAction={onAction} />);
    expect(screen.getByRole('heading', { name: '查看节点的模型信息' })).toBeInTheDocument();
    expect(screen.queryByText(/我的引擎/)).toBeNull();
    next();
    expect(screen.getByRole('heading', { name: '定位画布中的 Bot' })).toBeInTheDocument();
    expect(screen.getByText('打开画布导航，选择一个 Bot 来定位并查看它的内容。')).toBeInTheDocument();
    expect(screen.queryByText(/右侧/)).toBeNull();
    next(); next();
    expect(screen.getByRole('heading', { name: '查看运行与产物' })).toBeInTheDocument();
    expect(screen.getByText('只读权限允许浏览和导出，不会发起模型调用。')).toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('does not direct workspace-managed users to a missing personal-engine page', () => {
    const { rerender } = render(<FirstRunTour {...base} personalEngines={false} onAction={vi.fn()} />);
    expect(screen.getByText('先建立画布，再选择工作区提供的模型，让 Bot 围绕同一个任务协作。')).toBeInTheDocument();
    next();
    expect(screen.getByRole('heading', { name: '使用工作区的执行引擎' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '去连接引擎' })).toBeNull();
    rerender(<FirstRunTour {...base} scene="canvas" personalEngines={false} />);
    expect(screen.getByText('模型由工作区提供；未就绪时请联系工作区管理员。')).toBeInTheDocument();
    expect(screen.queryByText(/我的引擎/)).toBeNull();
  });

  it('handles native cancel without relying on window key handlers', () => {
    const onClose = vi.fn(); render(<FirstRunTour {...base} onClose={onClose} />);
    const event = new Event('cancel', { cancelable: true });
    fireEvent(screen.getByRole('dialog'), event);
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('teaches credential validation without reading or changing secrets', () => {
    const form = document.createElement('form'); form.dataset.onboarding = 'engine-setup';
    const secret = document.createElement('input'); secret.type = 'password'; secret.value = 'private-fixture-key'; form.append(secret);
    const submitted = vi.fn(); form.addEventListener('submit', submitted); document.body.append(form);
    const onClose = vi.fn();
    render(<FirstRunTour {...base} scene="engines" locale="en" onClose={onClose} />);
    expect(screen.getByRole('heading', { name: 'Choose a model provider' })).toBeInTheDocument();
    next(); expect(screen.getByText('Use a model credential here, not your AwwO password.')).toBeInTheDocument();
    next(); fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(secret.value).toBe('private-fixture-key');
    expect(screen.queryByText('private-fixture-key')).toBeNull();
    expect(submitted).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true); form.remove();
  });

  it('renders a safe configured main-site link without inventing an entry point', () => {
    const onClose = vi.fn();
    const { rerender } = render(<FirstRunTour {...base} onClose={onClose} mainSiteURL="https://main.example.test/products" />);
    next(); next(); next();
    const link = screen.getByRole('link', { name: '打开 ClawHunt 主站' });
    expect(link).toHaveAttribute('href', 'https://main.example.test/products');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    rerender(<FirstRunTour {...base} onClose={onClose} mainSiteURL="javascript:alert(1)" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('heading', { name: '与 ClawHunt 主站相连' })).toBeNull();
    expect(screen.getByText('第 3 / 3 步')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '上一步' }));
    expect(screen.getByRole('heading', { name: '先准备执行引擎' })).toBeInTheDocument();
    next();
    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each([undefined, '', 'javascript:alert(1)', 'http://main.example.test', 'https://user:password@main.example.test', 'https://main.example.test/?token=private', 'https://main.example.test/#return'])('omits the main-site step for an absent or unsafe URL: %s', mainSiteURL => {
    render(<FirstRunTour {...base} mainSiteURL={mainSiteURL} />);
    expect(screen.getByText('第 1 / 3 步')).toBeInTheDocument();
    next(); next();
    expect(screen.getByText('第 3 / 3 步')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '知道了' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '与 ClawHunt 主站相连' })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('uses a centered fallback when the target is absent instead of highlighting stale coordinates', () => {
    render(<FirstRunTour {...base} scene="canvas" />);
    expect(document.querySelector('.first-run-tour-card')).toHaveAttribute('data-spotlight', 'missing');
    expect(document.querySelector('.first-run-tour-highlight')).toBeNull();
    expect(screen.getByRole('heading', { name: '模型在左侧' })).toBeInTheDocument();
  });

  it('clips desktop highlights to the viewport and recalculates after scrolling', async () => {
    const element = document.createElement('aside'); element.dataset.onboarding = 'models'; document.body.append(element);
    const rect = vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rectangle(-20, 25, 220, 850));
    render(<FirstRunTour {...base} scene="canvas" />);
    const highlight = document.querySelector('.first-run-tour-highlight');
    expect(highlight).toHaveAttribute('x', '8'); expect(highlight).toHaveAttribute('y', '19');
    expect(highlight).toHaveAttribute('height', '773');
    rect.mockReturnValue(rectangle(-500, 25, 220, 850));
    act(() => window.dispatchEvent(new Event('scroll')));
    await waitFor(() => expect(document.querySelector('.first-run-tour-highlight')).toBeNull());
    element.remove();
  });

  it('highlights narrow-screen drawer buttons without opening drawers or clicking controls', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
    const rail = document.createElement('aside'); rail.dataset.onboarding = 'models'; document.body.append(rail);
    const opener = document.createElement('button'); opener.dataset.onboarding = 'models-toggle'; document.body.append(opener);
    const click = vi.fn(); opener.addEventListener('click', click);
    vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue(rectangle(0, 60, 270, 600));
    vi.spyOn(opener, 'getBoundingClientRect').mockReturnValue(rectangle(14, 18, 40, 40));
    render(<FirstRunTour {...base} scene="canvas" />);
    const highlight = document.querySelector('.first-run-tour-highlight');
    expect(highlight).toHaveAttribute('x', '8'); expect(highlight).toHaveAttribute('width', '52');
    const tourCard = document.querySelector<HTMLElement>('.first-run-tour-card')!;
    expect(tourCard.style.width).toBe('296px'); expect(tourCard.style.left).toBe('12px');
    expect(click).not.toHaveBeenCalled(); rail.remove(); opener.remove();
  });

  it('does not advance when clicked outside the card and allows an explicit skip', () => {
    const onClose = vi.fn(); render(<FirstRunTour {...base} onClose={onClose} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('第 1 / 3 步')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '暂时跳过' }));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
  });
});
