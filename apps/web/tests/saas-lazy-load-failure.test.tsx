import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProductionCases } from '../src/saas/ProductionCases';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

// A tab opened before a deploy asks for chunks that are gone; that must not take the page down.
vi.mock('../src/saas/ProductionShowcase', () => { throw new Error('chunk gone'); });
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState(null, '', '/?tenant=team'); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); history.replaceState(null, '', '/'); });

it('keeps the cases when a case view cannot load, and offers a reload', async () => {
  render(<SaaSPreferencesProvider><ProductionCases /></SaaSPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: '团队知识库 SaaS' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法读取运行记录。');
  expect(screen.getByRole('button', { name: '刷新页面' })).toBeVisible();
  expect(screen.getByRole('dialog', { name: '团队知识库 SaaS' })).toBeVisible();
  expect(screen.getByRole('heading', { level: 2, name: '一句话需求，交给一支 Agent 团队。' })).toBeVisible();
});

