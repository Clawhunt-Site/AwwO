import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import ProductionShowcase from '../src/saas/ProductionShowcase';
import { ProductionCases } from '../src/saas/ProductionCases';
import { PRODUCTION_CASES } from '../src/saas/productionCatalog';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => cleanup());

it.each(['neon-city', 'shanhai-vn'])('runs %s with the pictures and the clip its media nodes made, inlined in place of their paths', async id => {
  const item = PRODUCTION_CASES.find(value => value.id === id)!, media = PRODUCTION_WORKFLOWS[id].media!;
  render(<SaaSPreferencesProvider><ProductionShowcase item={item} /></SaaSPreferencesProvider>);
  const frame = await screen.findByTitle(`${item.title.zh}：AwwO 运行交付的成品`, undefined, { timeout: 20000 });
  const source = frame.getAttribute('srcdoc')!;
  // The homepage has no canvas files: every path the page names became its file's data: URL, and the clip is kept.
  expect(source).toContain("media-src data: blob: https:");
  expect(source).toMatch(/<video[^>]*src="data:video\/mp4;base64,/);
  expect(source).toContain('data:image/jpeg;base64,');
  for (const value of media) expect(source, value.id).not.toMatch(new RegExp(`\\b${value.id}/(image|video)-\\d+\\.`));
  expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-pointer-lock allow-downloads');
  expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  // The media nodes are shown beside the agents, not counted as agents.
  const strip = screen.getByRole('region', { name: '媒体节点在这次运行里生成的素材' });
  expect(within(strip).getAllByRole('listitem')).toHaveLength(media.length);
  for (const value of media) expect(within(strip).getByText(value.title.zh)).toBeVisible();
  expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(`${PRODUCTION_WORKFLOWS[id].nodes.length} 个 Agent`);
});


it('counts a media case’s agents without its media slot, which still shows as a stage', async () => {
  render(<SaaSPreferencesProvider><ProductionCases /></SaaSPreferencesProvider>);
  for (const [title, line] of [['霓虹之城', '2 个 Agent · 3 个阶段'], ['山海异闻录', '3 个 Agent · 3 个阶段']] as const) {
    fireEvent.click(screen.getByRole('button', { name: title }));
    const dialog = screen.getByRole('dialog', { name: title });
    expect(within(dialog).getByText(line)).toBeVisible();
    expect(within(dialog).getAllByText('媒体').length).toBeGreaterThan(0);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    cleanup();
    render(<SaaSPreferencesProvider><ProductionCases /></SaaSPreferencesProvider>);
  }
});
