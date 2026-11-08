// The web's motion notes are the page profile of scripts/motion-lint.mjs: both run the shared cases in
// apps/motion-lint-vectors.json, so a delivered page gets the same notes from the canvas as from the script.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactPreview } from '../src/canvas/ArtifactPreview';
import { LocaleProvider } from '../src/canvas/i18n';
import { motionNotes } from '../src/canvas/motionNotes';

afterEach(() => cleanup());

type VectorCase = { name: string; path: string; profile: 'strict' | 'page'; text: string; expect: [number, string][] };
const vectors = JSON.parse(readFileSync(resolve(process.cwd(), '../motion-lint-vectors.json'), 'utf8')) as { cases: VectorCase[] };
const pageCases = vectors.cases.filter(c => c.profile === 'page');

describe('motion notes on a delivered page', () => {
  it('has page cases to agree on', () => {
    expect(pageCases.length).toBeGreaterThanOrEqual(6);
  });

  for (const c of pageCases) {
    it(c.name, () => {
      expect(motionNotes(c.text).map(note => [note.line, note.rule])).toEqual(c.expect);
    });
  }

  it('stays quiet on a page with no motion', () => {
    expect(motionNotes('<!doctype html><html><body><h1>Hello</h1><p>Still.</p></body></html>')).toEqual([]);
  });

  const markdown = (text: string) => createElement('p', null, text);
  const drifting = '<!doctype html><html><head><style>\n.card { transition: all 300ms ease; }\n.bar { transition: width 200ms ease; }\n.a{}\n.b{}\n</style></head><body><p>Hi</p></body></html>';

  const note = () => document.querySelector('.awwo-artifact-motion');

  it('shows one note under a delivered page, naming at most three findings and counting the rest', async () => {
    render(createElement(ArtifactPreview, { source: drifting, type: 'html', title: '页面', renderMarkdown: markdown }));
    await waitFor(() => expect(note()).not.toBeNull());
    expect(note()?.textContent).toBe('动效检查（脚本读源码，免费，不评判手感）：第 2 行用了 transition: all；第 3 行的动画改了布局属性；有位移动画，但没有「减少动态效果」的处理（第 3 行起）。');
  });

  it('speaks the reader\'s language, and stays away from a page with nothing to say', async () => {
    render(createElement(LocaleProvider, { locale: 'en' }, createElement(ArtifactPreview, { source: drifting, type: 'html', title: 'Page', renderMarkdown: markdown })));
    await waitFor(() => expect(note()).not.toBeNull());
    expect(note()?.textContent).toMatch(/^Motion check \(a free script reads the source; it does not judge the feel\): transition: all on line 2; a layout property animates on line 3; things move/);
    cleanup();
    render(createElement(ArtifactPreview, { source: '<!doctype html><html><body><h1>Still</h1></body></html>', type: 'html', title: '页面', renderMarkdown: markdown }));
    await new Promise(done => setTimeout(done, 20));
    expect(note()).toBeNull();
  });

  it('reads a held market page without running it', async () => {
    render(createElement(ArtifactPreview, { source: drifting, type: 'html', title: '页面', renderMarkdown: markdown, market: true }));
    expect(screen.getByRole('button', { name: '运行页面' })).toBeTruthy();
    await waitFor(() => expect(note()?.textContent).toContain('第 2 行用了 transition: all'));
  });

  it('counts what it does not list', async () => {
    const many = `<style>${Array.from({ length: 6 }, (_, i) => `\n.x${i} { transition: all var(--d); }`).join('')}\n</style>`;
    render(createElement(ArtifactPreview, { source: many, type: 'html', title: '页面', renderMarkdown: markdown }));
    await waitFor(() => expect(note()?.textContent).toMatch(/另有 3 处。$/));
  });

  it('opens the source at a noted line, and keeps the note there', async () => {
    render(createElement(ArtifactPreview, { source: drifting, type: 'html', title: '页面', renderMarkdown: markdown }));
    const line = await screen.findByRole('button', { name: '第 3 行的动画改了布局属性' });
    expect(line.getAttribute('title')).toBe('打开源码第 3 行');
    fireEvent.click(line);
    await waitFor(() => expect(document.querySelector('.awwo-artifact-source')).not.toBeNull());
    expect(window.getSelection()?.toString()).toBe('.bar { transition: width 200ms ease; }');
    expect(note()?.textContent).toContain('第 2 行用了 transition: all');
  });

  it('reads 2 MiB hostile pages in linear time', () => {
    const shapes = [
      (n: number) => `<style>${'.a{transition:transform 200ms cubic-bezier(0.1,0.2,0.3,'.repeat(n / 56)}</style>`,
      (n: number) => `<p>${'--dur-'.repeat(n / 6)}</p>`,
      (n: number) => `<style>${'@media '.repeat(n / 7)}{}</style>`,
      (n: number) => `<style>:root{--ease-a:cubic-bezier(.2,0,0,1)}</style><style>${'.a{transition:transform var(--d) cubic-bezier(.2,0,0,1)}'.repeat(n / 56)}</style>`,
      (n: number) => `<script>${'w.renderAt = ('.repeat(n / 14)}</script>`,
      (n: number) => `<script>${'el.animate('.repeat(n / 11)}</script>`,
      (n: number) => `<script>${'w.renderAt=missing;'.repeat(n / 19)}</script>`,
      (n: number) => `<script>${Array.from({ length: n / 24 }, (_, i) => `w.renderAt=draw${i};`).join('')}</script>`,
      (n: number) => {
        const k = Math.floor(n / 64);
        const open = Array.from({ length: k }, (_, i) => `function f${i}(){`).join('');
        return `<script>${open}${'x++;'.repeat(k * 4)}${'}'.repeat(k)}${Array.from({ length: k }, (_, i) => `w.renderAt=f${i};`).join('')}</script>`;
      },
    ];
    for (const make of shapes) {
      const started = performance.now();
      motionNotes(make(2 * 1024 * 1024));
      expect(performance.now() - started).toBeLessThan(2500);
    }
  });
});
