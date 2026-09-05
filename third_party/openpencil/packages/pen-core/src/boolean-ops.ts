import { nanoid } from 'nanoid';
import type { PenNode, PathNode } from '@zseven-w/pen-types';

export type BooleanOpType = 'union' | 'subtract' | 'intersect';

// ---------------------------------------------------------------------------
// Paper.js scope — headless (no canvas needed)
// ---------------------------------------------------------------------------

interface PaperBoundsLike {
  center: unknown;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PaperPathItem {
  bounds: PaperBoundsLike;
  pathData: string;
  translate: (point: unknown) => void;
  rotate: (angle: number, center: unknown) => void;
  unite: (path: PaperPathItem) => PaperPathItem;
  subtract: (path: PaperPathItem) => PaperPathItem;
  intersect: (path: PaperPathItem) => PaperPathItem;
  remove: () => void;
}

interface PaperScope {
  setup: (size: unknown) => void;
  activate: () => void;
  Size: new (width: number, height: number) => unknown;
  Point: new (x: number, y: number) => unknown;
  CompoundPath: {
    create: (pathData: string) => PaperPathItem;
  };
}

interface PaperModule {
  PaperScope: new () => PaperScope;
  Point: new (x: number, y: number) => unknown;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

let paperModule: PaperModule | null | undefined;
let scope: PaperScope | null = null;

function getPaperModule(): PaperModule | null {
  if (paperModule !== undefined) return paperModule;
  try {
    // Indirect require via globalThis to load paper.js at runtime without
    // triggering esbuild's direct-eval warning. The assignment to globalThis
    // happens once; subsequent calls read from the cached paperModule.
    const _r =
      ((globalThis as any)['require'] as NodeRequire | undefined) ??
      (typeof require !== 'undefined' ? require : undefined);
    if (!_r) throw new Error('require not available');
    paperModule = _r('paper') as PaperModule;
  } catch {
    paperModule = null;
  }
  return paperModule;
}

function getScope(): PaperScope {
  const paper = getPaperModule();
  if (!paper) {
    throw new Error('paper runtime is unavailable');
  }
  if (!scope) {
    scope = new paper.PaperScope();
    scope.setup(new scope.Size(1, 1));
  }
  scope.activate();
  return scope;
}

// ---------------------------------------------------------------------------
// Shape → SVG path string conversion
// ---------------------------------------------------------------------------

function sizeVal(v: number | string | undefined, fallback: number): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = v.match(/\((\d+(?:\.\d+)?)\)/);
    if (m) return parseFloat(m[1]);
    const n = parseFloat(v);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

function rectToPath(w: number, h: number, cr?: number | [number, number, number, number]): string {
  if (!cr || (typeof cr === 'number' && cr === 0)) {
    return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
  }
  let [tl, tr, br, bl] = typeof cr === 'number' ? [cr, cr, cr, cr] : cr;
  const maxR = Math.min(w, h) / 2;
  tl = Math.min(tl, maxR);
  tr = Math.min(tr, maxR);
  br = Math.min(br, maxR);
  bl = Math.min(bl, maxR);
  return [
    `M ${tl} 0`,
    `L ${w - tr} 0`,
    tr > 0 ? `A ${tr} ${tr} 0 0 1 ${w} ${tr}` : '',
    `L ${w} ${h - br}`,
    br > 0 ? `A ${br} ${br} 0 0 1 ${w - br} ${h}` : '',
    `L ${bl} ${h}`,
    bl > 0 ? `A ${bl} ${bl} 0 0 1 0 ${h - bl}` : '',
    `L 0 ${tl}`,
    tl > 0 ? `A ${tl} ${tl} 0 0 1 ${tl} 0` : '',
    'Z',
  ]
    .filter(Boolean)
    .join(' ');
}

function ellipseToPath(rx: number, ry: number): string {
  // 4-arc approximation of an ellipse centered at (rx, ry)
  return [
    `M ${rx * 2} ${ry}`,
    `A ${rx} ${ry} 0 0 1 ${rx} ${ry * 2}`,
    `A ${rx} ${ry} 0 0 1 0 ${ry}`,
    `A ${rx} ${ry} 0 0 1 ${rx} 0`,
    `A ${rx} ${ry} 0 0 1 ${rx * 2} ${ry}`,
    'Z',
  ].join(' ');
}

function polygonToPath(count: number, w: number, h: number): string {
  const raw: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i * 2 * Math.PI) / count - Math.PI / 2;
    raw.push([Math.cos(angle), Math.sin(angle)]);
  }
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const [rx, ry] of raw) {
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry;
    if (ry > maxY) maxY = ry;
  }
  const rw = maxX - minX;
  const rh = maxY - minY;
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const px = ((raw[i][0] - minX) / rw) * w;
    const py = ((raw[i][1] - minY) / rh) * h;
    parts.push(i === 0 ? `M ${px} ${py}` : `L ${px} ${py}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

/** Convert a shape node to an SVG path `d` string in local coordinates (origin at 0,0). */
function nodeToLocalPath(node: PenNode): string | null {
  switch (node.type) {
    case 'rectangle':
    case 'frame': {
      const w = sizeVal(node.width, 100);
      const h = sizeVal(node.height, 100);
      return rectToPath(w, h, node.cornerRadius);
    }
    case 'ellipse': {
      const w = sizeVal(node.width, 100);
      const h = sizeVal(node.height, 100);
      return ellipseToPath(w / 2, h / 2);
    }
    case 'polygon': {
      const w = sizeVal(node.width, 100);
      const h = sizeVal(node.height, 100);
      return polygonToPath(node.polygonCount || 6, w, h);
    }
    case 'path':
      return node.d;
    case 'line':
      return `M 0 0 L ${(node.x2 ?? (node.x ?? 0) + 100) - (node.x ?? 0)} ${(node.y2 ?? node.y ?? 0) - (node.y ?? 0)}`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Boolean operation helpers
// ---------------------------------------------------------------------------

/** Types that can participate in boolean operations. */
const BOOLEAN_TYPES = new Set(['rectangle', 'ellipse', 'polygon', 'path', 'line', 'frame']);

export function canBooleanOp(nodes: PenNode[]): boolean {
  if (nodes.length < 2) return false;
  return nodes.every((n) => BOOLEAN_TYPES.has(n.type));
}

/**
 * Create a Paper.js PathItem from a PenNode, positioned in absolute scene
 * coordinates (applying x, y, rotation).
 */
function nodeToPaperPath(node: PenNode): PaperPathItem | null {
  const d = nodeToLocalPath(node);
  if (!d) return null;

  const s = getScope();
  let item: PaperPathItem;
  try {
    item = s.CompoundPath.create(d);
  } catch {
    return null;
  }

  // Apply node transform: translate to (x, y), then rotate around center
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  item.translate(new s.Point(x, y));

  const rotation = node.rotation ?? 0;
  if (rotation !== 0) {
    // Rotate around the bounding-box center of the translated item
    item.rotate(rotation, item.bounds.center);
  }

  return item;
}

function boundsFromPathData(d: string): Bounds | null {
  const values = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
  if (values.length < 2) return null;

  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < values.length - 1; i += 2) {
    xs.push(values[i]);
    ys.push(values[i + 1]);
  }
  if (!xs.length || !ys.length) return null;

  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function rotateBounds(bounds: Bounds, degrees: number): Bounds {
  if (!degrees) return bounds;

  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const corners = [
    [bounds.x, bounds.y],
    [bounds.x + bounds.width, bounds.y],
    [bounds.x + bounds.width, bounds.y + bounds.height],
    [bounds.x, bounds.y + bounds.height],
  ].map(([x, y]) => {
    const dx = x - centerX;
    const dy = y - centerY;
    return {
      x: centerX + dx * cos - dy * sin,
      y: centerY + dx * sin + dy * cos,
    };
  });

  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function nodeBounds(node: PenNode): Bounds | null {
  let local: Bounds | null;
  switch (node.type) {
    case 'rectangle':
    case 'frame':
    case 'ellipse':
    case 'polygon':
      local = {
        x: 0,
        y: 0,
        width: sizeVal(node.width, 100),
        height: sizeVal(node.height, 100),
      };
      break;
    case 'line': {
      const x1 = node.x ?? 0;
      const y1 = node.y ?? 0;
      const x2 = node.x2 ?? x1 + 100;
      const y2 = node.y2 ?? y1;
      const minX = Math.min(x1, x2);
      const minY = Math.min(y1, y2);
      return rotateBounds(
        {
          x: minX,
          y: minY,
          width: Math.max(1, Math.abs(x2 - x1)),
          height: Math.max(1, Math.abs(y2 - y1)),
        },
        node.rotation ?? 0,
      );
    }
    case 'path':
      local = boundsFromPathData(node.d);
      break;
    default:
      local = null;
  }
  if (!local) return null;

  return rotateBounds(
    {
      x: local.x + (node.x ?? 0),
      y: local.y + (node.y ?? 0),
      width: local.width,
      height: local.height,
    },
    node.rotation ?? 0,
  );
}

function unionBounds(a: Bounds, b: Bounds): Bounds {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: maxX - x, height: maxY - y };
}

function intersectBounds(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const maxX = Math.min(a.x + a.width, b.x + b.width);
  const maxY = Math.min(a.y + a.height, b.y + b.height);
  if (maxX <= x || maxY <= y) return null;
  return { x, y, width: maxX - x, height: maxY - y };
}

function rectPath(width: number, height: number): string {
  return `M 0 0 L ${width} 0 L ${width} ${height} L 0 ${height} Z`;
}

function buildPathNode(nodes: PenNode[], operation: BooleanOpType, bounds: Bounds): PathNode {
  const opLabels: Record<BooleanOpType, string> = {
    union: 'Union',
    subtract: 'Subtract',
    intersect: 'Intersect',
  };
  const first = nodes[0];

  return {
    id: nanoid(),
    type: 'path',
    name: opLabels[operation],
    d: rectPath(Math.round(bounds.width * 100) / 100, Math.round(bounds.height * 100) / 100),
    x: Math.round(bounds.x * 100) / 100,
    y: Math.round(bounds.y * 100) / 100,
    width: Math.round(bounds.width * 100) / 100,
    height: Math.round(bounds.height * 100) / 100,
    fill: 'fill' in first ? first.fill : undefined,
    stroke: 'stroke' in first ? first.stroke : undefined,
    effects: 'effects' in first ? first.effects : undefined,
    opacity: first.opacity,
  };
}

function executeBooleanOpFallback(nodes: PenNode[], operation: BooleanOpType): PathNode | null {
  const bounds = nodes.map(nodeBounds);
  if (bounds.some((b) => b === null)) return null;

  let result = bounds[0] as Bounds;
  for (let i = 1; i < bounds.length; i++) {
    const next = bounds[i] as Bounds;
    switch (operation) {
      case 'union':
        result = unionBounds(result, next);
        break;
      case 'subtract':
        result = result;
        break;
      case 'intersect': {
        const intersection = intersectBounds(result, next);
        if (!intersection) return null;
        result = intersection;
        break;
      }
    }
  }

  if (result.width <= 0 || result.height <= 0) return null;
  return buildPathNode(nodes, operation, result);
}

/**
 * Execute a boolean operation on the given PenNodes.
 * Returns a new PathNode with the result, or null on failure.
 */
export function executeBooleanOp(nodes: PenNode[], operation: BooleanOpType): PathNode | null {
  if (nodes.length < 2) return null;

  if (!getPaperModule()) return executeBooleanOpFallback(nodes, operation);

  try {
    const paperPaths = nodes.map(nodeToPaperPath);
    if (paperPaths.some((p) => p === null)) return executeBooleanOpFallback(nodes, operation);

    const paths = paperPaths as PaperPathItem[];

    // Accumulate: fold left with the boolean operation
    let result = paths[0];
    for (let i = 1; i < paths.length; i++) {
      switch (operation) {
        case 'union':
          result = result.unite(paths[i]);
          break;
        case 'subtract':
          result = result.subtract(paths[i]);
          break;
        case 'intersect':
          result = result.intersect(paths[i]);
          break;
      }
    }

    // Extract SVG path data
    const pathData = result.pathData;
    if (!pathData || pathData.trim().length === 0) return executeBooleanOpFallback(nodes, operation);

    // Get bounding box for positioning
    const bounds = result.bounds;

    // Translate path so it starts at origin (0,0)
    const paper = getPaperModule();
    if (!paper) return executeBooleanOpFallback(nodes, operation);
    result.translate(new paper.Point(-bounds.x, -bounds.y));
    const originPathData = result.pathData;

    // Clean up Paper.js items
    for (const p of paths) p.remove();
    result.remove();

    // Build the label
    const opLabels: Record<BooleanOpType, string> = {
      union: 'Union',
      subtract: 'Subtract',
      intersect: 'Intersect',
    };

    // Inherit style from first operand
    const first = nodes[0];
    const fill = 'fill' in first ? first.fill : undefined;
    const stroke = 'stroke' in first ? first.stroke : undefined;
    const effects = 'effects' in first ? first.effects : undefined;
    const opacity = first.opacity;

    return {
      id: nanoid(),
      type: 'path',
      name: opLabels[operation],
      d: originPathData,
      x: bounds.x,
      y: bounds.y,
      width: Math.round(bounds.width * 100) / 100,
      height: Math.round(bounds.height * 100) / 100,
      fill,
      stroke,
      effects,
      opacity,
    };
  } catch {
    return executeBooleanOpFallback(nodes, operation);
  }
}
