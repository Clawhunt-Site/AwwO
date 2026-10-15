import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionNode, type CanvasNode, type SessionNode } from '../src/canvas/canvasDoc';
import { DeliverableStudio } from '../src/canvas/studio/DeliverableStudio';

// Every image node calls its first picture image-1.jpg; the bytes say which node made them.
vi.mock('../src/canvas/studio/studioData', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/canvas/studio/studioData')>();
  return {
    ...actual,
    fetchEntryBytes: vi.fn(async (entry: { nodeId: string; label: string }) =>
      ({ name: entry.label, bytes: new TextEncoder().encode(`picture of ${entry.nodeId}`), contentType: 'image/jpeg' })),
  };
});

const at = Date.now();
const picture = (id: string, artifactId: string): SessionNode => ({
  ...createSessionNode('image', { x: 0, y: 0 }), id, title: id, contract: { version: 1, inputs: [], outputs: [] },
  lastOutput: { text: JSON.stringify({ type: 'awwo.media', version: 1, kind: 'image', model: 'm',
    items: [{ artifactId, name: 'image-1.jpg', contentType: 'image/jpeg', size: 20 }] }), at, source: 'run' },
});
// The page a canvas run's developer wrote: each chapter names its picture as <node id>/image-1.jpg.
const html = '<!doctype html><html><head><title>NEON CITY</title></head><body><img alt="market" src="cv-market/image-1.jpg">'
  + '<img alt="dawn" src="cv-dawn/image-1.jpg"><img alt="rooftop" src="cv-rooftop/image-1.jpg"></body></html>';
const page: SessionNode = {
  ...createSessionNode('llm', { x: 0, y: 0 }), id: 'page', title: 'Brand page',
  contract: { version: 1, inputs: [], outputs: [{ id: 'delivery', label: 'Interface delivery', type: 'html', required: true, value: '' }] },
  lastOutput: { text: JSON.stringify({ delivery: html }), at, source: 'run' },
};
const nodes: CanvasNode[] = [picture('cv-rooftop', 'aRooftop000001'), picture('cv-market', 'aMarket0000001'), picture('cv-dawn', 'aDawn000000001'), page];

const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
beforeEach(() => { Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:picture'), revokeObjectURL: vi.fn() }); });
afterEach(() => { cleanup(); Object.assign(URL, { createObjectURL: original.create, revokeObjectURL: original.revoke }); });

describe('the 成果 studio shows the pictures a page names', () => {
  it('gives each chapter its own image node’s image-1.jpg, not the first one on the canvas', async () => {
    const { container } = render(<DeliverableStudio nodes={nodes} edges={[]} title="Results" variant="embedded" focusNodeId="page" />);
    const sources = async () => {
      const frame = container.querySelector('iframe');
      const document = new DOMParser().parseFromString(frame?.getAttribute('srcdoc') ?? '', 'text/html');
      return Object.fromEntries(Array.from(document.querySelectorAll('img')).map(img => [img.alt, img.getAttribute('src') ?? '']));
    };
    const data = (nodeId: string) => `data:image/jpeg;base64,${btoa(`picture of ${nodeId}`)}`;
    await waitFor(async () => expect(await sources()).toEqual({ market: data('cv-market'), dawn: data('cv-dawn'), rooftop: data('cv-rooftop') }));
  });
});
