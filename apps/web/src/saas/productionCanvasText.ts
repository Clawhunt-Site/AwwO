type CanvasNode = { readonly id?: unknown; readonly kind?: unknown; readonly title?: unknown; readonly persona?: unknown; readonly contract?: unknown };
type CanvasEdge = { readonly fromNode?: unknown; readonly fromPort?: unknown; readonly toNode?: unknown; readonly toPort?: unknown; readonly dataType?: unknown };

/** The canvas a case run ran, as one canonical string: every node's kind, title, persona and output
 * contract, flattened to path/value pairs sorted by path, plus every wire as (from node, port, to node,
 * port, data type) with nodes by position — node IDs are generated afresh for each copy. Neither key
 * order nor absent optional fields can change it. A published record keeps the SHA-256 of this string
 * from the frozen run (`canvasSHA256`), and the tests recompute it from the canvas a member copies today. */
export function canonicalCanvasText(document: { readonly nodes: ReadonlyArray<CanvasNode>; readonly edges?: ReadonlyArray<CanvasEdge> }): string {
  const pairs: [string, unknown][] = [];
  const walk = (value: unknown, path: string): void => {
    if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
    else if (value !== undefined) pairs.push([path, value]);
  };
  document.nodes.forEach((node, index) => walk({ kind: node.kind, title: node.title, persona: node.persona, contract: node.contract }, String(index)));
  const position = new Map(document.nodes.map((node, index) => [node.id, index]));
  const wires = (document.edges ?? []).map(edge => JSON.stringify([position.get(edge.fromNode) ?? null, edge.fromPort ?? null, position.get(edge.toNode) ?? null, edge.toPort ?? null, edge.dataType ?? null])).sort();
  const byPath = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);
  return JSON.stringify({ nodes: pairs.sort(byPath), wires });
}
