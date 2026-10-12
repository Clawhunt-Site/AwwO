import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import ProductionShowcase from '../src/saas/ProductionShowcase';
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
