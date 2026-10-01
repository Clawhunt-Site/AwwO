// RunTimeline — the execution drawer.
//
// Ported from the verified WorkflowRunTimeline (since-deleted apps/web/src/studio/WorkflowRunTimeline.tsx);
// only the node vocabulary changed (canvas nodes: 'session' with an `agentKind`, or 'form').
//
// One row per node: a kind dot, an honest state chip, a proportional gantt bar, elapsed, and the
// node's runtime·model. The invariants that make it honest:
//
//  - A BLOCKED row shows its REASON ("上游未完成" / "已停止"), not the generic word — a node that
//    never ran because of an upstream failure is a different fact from one that failed.
//  - The bar comes from REAL recorded transition timestamps (`startedAt`/`endedAt`, stamped by
//    the surface at genuine status transitions). A node with no `startedAt` draws NO bar; nothing
//    here interpolates or animates progress that did not happen.
//  - Pure props: the surface owns the clock (`now`), so this component cannot invent time either.

import type { CSSProperties } from 'react';
import type { CanvasNode } from './canvasDoc';
import type { ModelPaletteSelection } from './modelPalette';
import type { RunNodeStatus } from './runGraph';
import { useCanvasI18n, type CanvasTextKey } from './i18n';
import { recoveryDetailMessage } from './surfaceMessages';

/** A node's run status enriched with the wall-clock stamps the surface recorded. */
export interface RunView extends RunNodeStatus {
  startedAt?: number;
  endedAt?: number;
}

// Labels only. The state CLASS is templated at the call sites from the state itself, so a state
// can never be added without its styling following — the previous hand-written `cls` values
// (`st-done`, `st-failed`, …) matched nothing in the stylesheet at all, which left every chip and
// every gantt bar colourless: a failed row was indistinguishable from a completed one, in the one
// panel whose entire job is telling them apart.
const STATE_META: Record<RunNodeStatus['state'], CanvasTextKey> = {
  waiting: 'timeline.queued',
  running: 'timeline.running',
  done: 'timeline.done',
  failed: 'timeline.failed',
  blocked: 'timeline.blocked',
  // An upstream that contributed its stored output instead of executing. Deliberately its own
  // word: calling it 完成 would claim a node ran in a run it never joined.
  cached: 'timeline.cached',
  cancelled: 'timeline.cancelled',
};

// Brand kind accents. These used to read `--canvas-llm/coding/image`, which exist nowhere in the
// repo, so every row fell through to the hardcoded fallbacks — a purple/mint/orchid trio, i.e.
// exactly the generic "AI product" palette the owner rejected, painted over a bright brand canvas.
const KIND_COLOR: Record<string, string> = {
  form: 'var(--kind-form)',
  llm: 'var(--kind-llm)',
  coding: 'var(--kind-coding)',
  image: 'var(--kind-image)',
};

const DRAWER_STYLE: CSSProperties = {
  // Canvas chrome is rendered inside the positioned canvas root. Anchoring to the browser
  // viewport puts the drawer under the left model rail, where the canvas clips its title/rows.
  position: 'absolute',
  left: 16,
  right: 16,
  // The same canvas root places the view toolbar at bottom:20px. Keep its controls clickable
  // while the timeline is open instead of covering them with this higher-z-index drawer.
  bottom: 76,
  zIndex: 35,
  maxHeight: 'min(38vh, calc(100% - 96px))',
  overflow: 'auto',
};

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function RunTimeline({
  nodes,
  runs,
  runStartedAt,
  now,
  onClose,
  onOpenNode,
  modelCatalogue,
  style,
}: {
  nodes: ReadonlyArray<CanvasNode>;
  runs: Readonly<Record<string, RunView>>;
  /** When the run began (null before the first run) — the gantt origin. */
  runStartedAt: number | null;
  /** The surface's clock. Ticks only while a run is in flight. */
  now: number;
  onClose: () => void;
  /** Inspect a recorded node without retrying or changing its execution. */
  onOpenNode?: (nodeId: string) => void;
  /** A scope-checked catalogue lets cloud model selectors render as their public labels. */
  modelCatalogue?: readonly ModelPaletteSelection[];
  style?: CSSProperties;
}) {
  const { t, locale } = useCanvasI18n();
  const origin = runStartedAt ?? now;
  // A 1s floor keeps the very first frames from dividing by ~0 and drawing a full-width bar for
  // a node that has run for 4ms.
  const span = Math.max(1000, now - origin);
  return (
    <section
      className="canvas-runline"
      role="region"
      aria-label={t('timeline.label')}
      style={{ ...DRAWER_STYLE, ...style }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <header className="canvas-runline-head">
        <span className="canvas-runline-title">{t('timeline.label')}</span>
        <span className="canvas-runline-meta">{t('timeline.meta')}</span>
        <button type="button" className="canvas-runline-close" aria-label={t('timeline.close')} onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="canvas-runline-rows">
        {nodes.filter((node) => Object.hasOwn(runs, node.id)).map((node) => {
          const run = runs[node.id];
          const state = run.state;
          const meta = t(STATE_META[state]);
          const detail = recoveryDetailMessage(t, run.detail);
          // A blocked row says WHY it was blocked; every other state keeps its own label and
          // carries the detail in the tooltip.
          const label = (state === 'blocked' || state === 'cancelled') && detail ? detail : meta;
          const color = KIND_COLOR[node.kind === 'form' ? 'form' : node.agentKind] ?? 'var(--muted, #8a8a8a)';
          const started = run?.startedAt;
          const ended = run?.endedAt;
          const barLeft = started ? ((started - origin) / span) * 100 : 0;
          const barWidth = started ? (((ended ?? now) - started) / span) * 100 : 0;
          const elapsed = started != null ? fmtElapsed((ended ?? now) - started) : '—';
          const modelLabel = node.kind === 'session' && node.model
            ? modelCatalogue?.find(model => model.runtime === node.runtime && model.model === node.model)?.label
              || (/^byok_[a-zA-Z0-9_-]+$/.test(node.model)
                ? `${locale === 'zh' ? '当前目录未包含该模型' : 'Model not in current catalogue'} · ${node.model.slice(-8)}`
                : node.model)
            : '';
          const runtime =
            node.kind === 'form'
              ? t('timeline.form')
              : node.runtime
                ? `${node.runtime}${modelLabel ? ` · ${modelLabel}` : ''}`
                : t('timeline.runtimeUnset');
          return (
            <div key={node.id} className="canvas-runline-row" data-testid={`runline-${node.id}`}>
              <span className="canvas-runline-name">
                <i className="canvas-runline-dot" style={{ background: color }} />
                {onOpenNode ? <button type="button" className="canvas-runline-node" aria-label={t('timeline.openNode', { title: node.title })}
                  onClick={() => onOpenNode(node.id)}>{node.title}</button> : node.title}
              </span>
              <span
                className={`canvas-runline-state canvas-runline-state--${state}`}
                title={detail}
              >
                {label}
              </span>
              <span className="canvas-runline-bar">
                {started ? (
                  <i
                    className={`canvas-runline-fill canvas-runline-fill--${state}`}
                    style={{ left: `${barLeft}%`, width: `${Math.max(barWidth, 1.5)}%` }}
                  />
                ) : null}
              </span>
              <span className="canvas-runline-elapsed">{elapsed}</span>
              <span className="canvas-runline-runtime" title={runtime}>
                {runtime}
              </span>
              {state === 'failed' && detail && <p className="canvas-runline-error">{detail}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
