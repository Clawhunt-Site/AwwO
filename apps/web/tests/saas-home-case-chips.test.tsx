// 制作案例's kind chips (ProductionCases `filters`): All and each kind with its count, in English as the cases are, one
// pressed at a time; a case opened from elsewhere shows every case again, so its card is there to come back to.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ProductionCases } from '../src/saas/ProductionCases';
import { PRODUCTION_CASES, PRODUCTION_KIND_LABELS, type ProductionKind } from '../src/saas/productionCatalog';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { openCase } from '../src/saas/caseLink';

const CHINESE = /\p{Script=Han}/u;
const cards = () => screen.queryAllByRole('listitem').filter(item => item.classList.contains('production-card'));
const count = (kind: ProductionKind) => PRODUCTION_CASES.filter(item => item.kind === kind).length;
const kinds = (Object.keys(PRODUCTION_KIND_LABELS) as ProductionKind[]).filter(kind => count(kind) > 0);

beforeAll(async () => { await import('../src/saas/ProductionShowcase'); }, 300_000);
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); window.history.replaceState({}, '', '/'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('offers All and every kind the catalog has, each with its count, in English', () => {
  render(<SaaSPreferencesProvider><ProductionCases filters /></SaaSPreferencesProvider>);
  const group = within(screen.getByRole('group', { name: 'Case kinds' }));
  const chips = group.getAllByRole('button');
  expect(chips.map(chip => chip.textContent)).toEqual([`All ${PRODUCTION_CASES.length}`, ...kinds.map(kind => `${PRODUCTION_KIND_LABELS[kind]} ${count(kind)}`)]);
  for (const chip of chips) expect(chip.textContent).not.toMatch(CHINESE);
  expect(group.getByRole('button', { name: `All ${PRODUCTION_CASES.length}` })).toHaveAttribute('aria-pressed', 'true');
  expect(cards()).toHaveLength(PRODUCTION_CASES.length);
  // The chips sit in the cases' English section, before its grid.
  expect(screen.getByRole('group', { name: 'Case kinds' }).closest('section')).toHaveAttribute('lang', 'en');
});

it('shows only the kind pressed, then all again', () => {
  render(<SaaSPreferencesProvider><ProductionCases filters /></SaaSPreferencesProvider>);
  const group = within(screen.getByRole('group', { name: 'Case kinds' }));
  const film = group.getByRole('button', { name: `Film ${count('film')}` });
  fireEvent.click(film);
  expect(film).toHaveAttribute('aria-pressed', 'true');
  expect(group.getByRole('button', { name: `All ${PRODUCTION_CASES.length}` })).toHaveAttribute('aria-pressed', 'false');
  expect(cards()).toHaveLength(count('film'));
  for (const card of cards()) expect(within(card).getByText('Film')).toBeVisible();
  fireEvent.click(group.getByRole('button', { name: `Digital twin ${count('twin')}` }));
  expect(cards()).toHaveLength(count('twin'));
  fireEvent.click(group.getByRole('button', { name: `All ${PRODUCTION_CASES.length}` }));
  expect(cards()).toHaveLength(PRODUCTION_CASES.length);
});

it('shows every case again for a case opened from elsewhere, and comes back to its card', async () => {
  render(<SaaSPreferencesProvider><ProductionCases filters /></SaaSPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: `Game ${count('game')}` }));
  expect(screen.queryByRole('button', { name: 'Summer sparkling-drink ad' })).toBeNull();
  act(() => { openCase('summer-ad'); });
  const dialog = await screen.findByRole('dialog', { name: 'Summer sparkling-drink ad' });
  expect(screen.getByRole('button', { name: `All ${PRODUCTION_CASES.length}` })).toHaveAttribute('aria-pressed', 'true');
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('button', { name: 'Summer sparkling-drink ad' })).toHaveFocus();
});

it('adds no chips where it is not asked for: the landing page and the compact row', () => {
  render(<SaaSPreferencesProvider><ProductionCases /></SaaSPreferencesProvider>);
  expect(screen.queryByRole('group', { name: 'Case kinds' })).toBeNull();
  cleanup();
  render(<SaaSPreferencesProvider><ProductionCases compact /></SaaSPreferencesProvider>);
  expect(screen.queryByRole('group', { name: 'Case kinds' })).toBeNull();
});
