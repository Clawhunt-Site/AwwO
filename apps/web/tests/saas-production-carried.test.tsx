import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PRODUCTION_RUN_SUMMARY, type ProductionRunRecord } from '../src/saas/productionRuns';
import { agentCount, HAND_OVER, PRODUCTION_CASES } from '../src/saas/productionCatalog';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import ProductionShowcase from '../src/saas/ProductionShowcase';

// A carried case: a canvas laid out on the live site to carry a piece made before it (a game, a film). Its agents read
// and checked the piece's files and handed them on unchanged; its page node put the page together. It has no workflow
// here and no stored canvas, and its record holds what the agents delivered as text
// (scripts/showcase/publish-carried-run.mjs).
const RECORDS = import.meta.glob<ProductionRunRecord>('../src/saas/production-runs/*.ts', { eager: true, import: 'default' });
const CANVASES = Object.keys(import.meta.glob('../src/saas/production-canvases/*.ts')).map(file => file.replace(/^.*\/|\.ts$/g, ''));
const MEDIA = Object.keys(import.meta.glob('../src/saas/production-runs/*.media.json')).map(file => file.replace(/^.*\/|\.media\.json$/g, ''));
const SHOWCASE = path.resolve(__dirname, '../showcase');
const CARRIED = PRODUCTION_CASES.filter(item => item.carried);
const record = (id: string) => RECORDS[`../src/saas/production-runs/${id}.ts`];

afterEach(cleanup);

it('marks a case carried on its card exactly when its record says its canvas was', () => {
  expect(CARRIED.length).toBeGreaterThan(0);
  expect(Object.values(RECORDS).filter(value => value.canvas === 'carried').map(value => value.caseId).sort()).toEqual(CARRIED.map(item => item.id).sort());
  for (const item of CARRIED) {
    // No workflow to copy, no stored canvas, no published files: only what its agents delivered as text.
    expect(PRODUCTION_WORKFLOWS[item.id], item.id).toBeUndefined();
    expect(CANVASES, item.id).not.toContain(item.id);
    expect(MEDIA, item.id).not.toContain(item.id);
    expect(item.recording, item.id).toBe(true);
    expect(item.excerpt, item.id).toBeUndefined();
  }
});

it('shows on a carried case’s card the team its run had, stage by stage, ending in the hand-over', () => {
  for (const item of CARRIED) {
    const run = record(item.id);
    const columns = [...new Set(run.nodes.map(node => node.column))].sort((a, b) => a - b);
    expect(item.stages.map(stage => stage.length), item.id).toEqual(columns.map(column => run.nodes.filter(node => node.column === column).length));
    expect(agentCount(item), item.id).toBe(run.nodes.length);
    expect(item.stages.at(-1), item.id).toEqual([HAND_OVER]);
    expect(run.nodes.filter(node => node.column === columns.at(-1)).map(node => node.title), item.id).toEqual([HAND_OVER]);
  }
});

it('records a carried run whole: every agent done, on Claude Fable 5.2, its page delivered by its page node', () => {
  for (const item of CARRIED) {
    const run = record(item.id);
    expect(run.completed, item.id).toBe(run.total);
    expect(run.nodes.every(node => node.status === 'done' && node.kind === undefined && node.files === undefined), item.id).toBe(true);
    expect(run.media, item.id).toBeUndefined();
    expect(run.model, item.id).toBe('Claude Fable 5.2');
    expect(run.runtime, item.id).toBe('openai-agents + blender');
    expect(run.limits, item.id).toMatchObject({ contextWindow: 200000, maxOutputTokens: 64000, modelCallsPerNode: 64, thinking: true });
    expect(run.limits.concurrency, item.id).toBeLessThanOrEqual(run.nodes.length);
    // The agents that handled files worked in the workstation; the two that only wrote, in none.
    expect(run.nodes.filter(node => !node.blender).map(node => node.title).sort(), item.id).toEqual(['Direction', HAND_OVER]);
    expect(run.source.runs?.map(entry => entry.nodes.length), item.id).toEqual([2, run.nodes.length - 2]);
    // Every agent's brief is in the record, since no workflow here holds it.
    for (const node of run.nodes) expect(node.brief?.trim(), `${item.id}/${node.id}`).toBeTruthy();
    const page = run.nodes.find(node => node.id === run.artifactNodeId)!;
    expect([page.outputType, page.column], item.id).toEqual(['html', run.nodes.at(-1)!.column - 1]);
    expect(page.report?.trim(), item.id).toBeTruthy();
    // The page names the piece's script by its canvas path: it is the page as delivered, which runs only in its canvas.
    expect(page.output, item.id).toMatch(new RegExp(`<script[^>]* src="${page.id}/[A-Za-z0-9_.-]+\\.js"></script>`));
    expect(PRODUCTION_RUN_SUMMARY[item.id]?.delivered, item.id).toBe(true);
  }
});

it('has a carried case’s cover on disk, small enough to ship: a recording of the piece running in the canvas’s preview', () => {
  for (const item of CARRIED) for (const extension of ['mp4', 'jpg']) {
    const file = path.join(SHOWCASE, `${item.footage}.${extension}`);
    expect(existsSync(file), file).toBe(true);
    expect(statSync(file).size, file).toBeLessThan(10 * 1024 * 1024);
  }
  // The MP4 starts with its index, so it plays before it has all arrived.
  for (const item of CARRIED) expect(readFileSync(path.join(SHOWCASE, `${item.footage}.mp4`)).subarray(0, 4096).includes(Buffer.from('moov')), item.id).toBe(true);
});

it('shows a carried case’s result as the recording it is, never as a page without its files, and offers no copy', async () => {
  const item = CARRIED[0];
  const { container } = render(<ProductionShowcase item={item} onReuse={() => { throw new Error('a carried canvas is not copied'); }} />);
  await waitFor(() => expect(screen.getByText(/agents, \d+ stages/)).toBeTruthy());
  expect(screen.getByText('The delivered result · recorded in the canvas’s preview')).toBeTruthy();
  const video = container.querySelector('video.production-made-frame')!;
  expect(video.getAttribute('src')).toBe(`/showcase/${item.footage}.mp4`);
  expect(video.getAttribute('poster')).toBe(`/showcase/${item.footage}.jpg`);
  // No sandboxed page: the delivered page would load files that are not published with the record.
  expect(container.querySelector('iframe')).toBeNull();
  expect(screen.getByText(/A recording, not the page itself/)).toBeTruthy();
  expect(screen.queryByText(/runs as delivered, without manual edits/)).toBeNull();
  expect(screen.queryByRole('button', { name: /Copy this canvas/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reload the result' })).toBeNull();
  // The run's own facts: both runtimes in the receipt, each with the agents that ran on it.
  expect(container.textContent).toContain('Claude Fable 5.2');
  expect(container.textContent).toContain(record(item.id).note);
});
