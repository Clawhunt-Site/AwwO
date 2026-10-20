import type { CanvasEdge, CanvasNode } from '../canvas/canvasDoc';

/** A recorded-canvas case's stored canvas (recordedCanvas.ts): its nodes and wires as they ran. */
export interface RecordedCanvas {
  readonly nodes: ReadonlyArray<CanvasNode>;
  readonly edges: ReadonlyArray<CanvasEdge>;
}

/** A value as canonical JSON: object keys sorted at every depth, so neither key order nor how it was written changes it. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The recorded canvas as one string: every node (by id) with every field it has, and every wire (by id), canonical.
 * Unlike productionCanvasText.ts it covers what a film depends on: a media node's model, settings and words, an edit
 * node's own timeline, node ids and places. A published record keeps the SHA-256 of it (`canvasSHA256`). Plain code
 * (no bundler features), so the publish script runs it too. */
export function recordedCanvasText(canvas: RecordedCanvas): string {
  const byId = <T extends { id: string }>(values: ReadonlyArray<T>) => [...values].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return canonical({ version: 1, nodes: byId(canvas.nodes), edges: byId(canvas.edges) });
}
