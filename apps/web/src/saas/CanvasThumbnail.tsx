type Box = { id: string; x: number; y: number; w: number; h: number };
type Link = { from: string; to: string };

const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Reads only geometry from a stored document; anything malformed simply renders as empty. */
export function canvasShape(document: unknown): { boxes: Box[]; links: Link[] } {
  const value = document && typeof document === 'object' ? document as { nodes?: unknown; edges?: unknown } : {};
  const boxes = (Array.isArray(value.nodes) ? value.nodes : []).flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const node = raw as Record<string, unknown>;
    if (typeof node.id !== 'string') return [];
    return [{ id: node.id, x: finite(node.x, 0), y: finite(node.y, 0), w: Math.max(40, finite(node.w, 340)), h: Math.max(30, finite(node.h, 260)) }];
  }).slice(0, 60);
  const ids = new Set(boxes.map(box => box.id));
  const links = (Array.isArray(value.edges) ? value.edges : []).flatMap(raw => {
    const edge = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return typeof edge.fromNode === 'string' && typeof edge.toNode === 'string' && ids.has(edge.fromNode) && ids.has(edge.toNode) ? [{ from: edge.fromNode, to: edge.toNode }] : [];
  });
  return { boxes, links };
}

/** A decorative mini-map so canvases are recognisable at a glance. */
export function CanvasThumbnail({ document }: { document: unknown }) {
  const { boxes, links } = canvasShape(document);
  if (!boxes.length) return <div className="saas-canvas-thumb is-empty" aria-hidden="true"><span /><span /><span /></div>;
  const pad = 80;
  const minX = Math.min(...boxes.map(box => box.x)) - pad, minY = Math.min(...boxes.map(box => box.y)) - pad;
  const maxX = Math.max(...boxes.map(box => box.x + box.w)) + pad, maxY = Math.max(...boxes.map(box => box.y + box.h)) + pad;
  const byId = new Map(boxes.map(box => [box.id, box]));
  return <div className="saas-canvas-thumb" aria-hidden="true">
    <svg viewBox={`${minX} ${minY} ${Math.max(1, maxX - minX)} ${Math.max(1, maxY - minY)}`} preserveAspectRatio="xMidYMid meet">
      {links.map((link, index) => {
        const a = byId.get(link.from)!, b = byId.get(link.to)!;
        const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, bend = Math.max(60, Math.abs(x2 - x1) / 2);
        return <path key={index} className="saas-canvas-thumb-edge" d={`M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`} />;
      })}
      {boxes.map(box => <g key={box.id}>
        <rect className="saas-canvas-thumb-node" x={box.x} y={box.y} width={box.w} height={box.h} rx={28} />
        <rect className="saas-canvas-thumb-line" x={box.x + 28} y={box.y + 34} width={box.w * .45} height={18} rx={9} />
        <rect className="saas-canvas-thumb-line is-faint" x={box.x + 28} y={box.y + 72} width={box.w * .7} height={14} rx={7} />
      </g>)}
    </svg>
  </div>;
}

export function relativeTime(iso: string, locale: 'zh' | 'en', now = Date.now()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const seconds = Math.round((time - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { numeric: 'auto' });
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [['second', 60], ['minute', 60], ['hour', 24], ['day', 7], ['week', 4.35], ['month', 12]];
  let value = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return unit === 'second' ? (locale === 'zh' ? '刚刚' : 'just now') : format.format(value, unit);
    value = Math.round(value / size);
  }
  return format.format(value, 'year');
}
