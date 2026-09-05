// P2 — Creative Canvas timeline UI. A pure React surface over the P1 timeline model
// (../engine/timeline). Multi-track lanes + clip blocks + pointer move/trim + split +
// undo/redo. Every mutation goes through the P1 immutable ops and is fail-closed: a
// TimelineError surfaces in a banner and the doc is left unchanged. No rendering, no I/O,
// no paid calls (those are later phases). Design: docs/creative-canvas-timeline-design.md.
import { useCallback, useMemo, useRef, useState } from 'react';

import {
  addClip,
  addTrack,
  createTimeline,
  inspectTimeline,
  moveClip,
  removeClip,
  setClipProperties,
  splitClip,
  timelineDurationSec,
  TimelineError,
  type TimelineClip,
  type TimelineDoc,
  type TrackKind,
} from '../engine/timeline';

const PX_PER_SEC = 48;
const MIN_VISIBLE_SEC = 12;
const SNAP_SEC = 0.1;
const MIN_CLIP_SEC = 0.2;

const TRACK_KINDS: ReadonlyArray<{ kind: TrackKind; label: string }> = [
  { kind: 'video', label: '视频' },
  { kind: 'audio', label: '音频' },
  { kind: 'text', label: '文字' },
  { kind: 'overlay', label: '叠加' },
];

const snap = (sec: number): number => Math.max(0, Math.round(sec / SNAP_SEC) * SNAP_SEC);

function seedDoc(): TimelineDoc {
  // A tiny non-empty starting doc so the surface is legible on first open.
  return addTrack(createTimeline({ name: '新建时间线' }), 'video', '视频 1');
}

export interface TimelinePanelProps {
  initialDoc?: TimelineDoc;
  onChange?: (doc: TimelineDoc) => void;
  className?: string;
}

interface DragState {
  clipId: string;
  mode: 'move' | 'trim-end';
  startX: number;
  origStartSec: number;
  origDurationSec: number;
  origInSec: number;
  origTrackId: string;
  // live target, recomputed each pointermove from the ORIGINAL anchor (no re-anchoring,
  // so it is immune to React event batching) and committed ONCE on pointerup.
  curStartSec: number;
  curDurationSec: number;
  curTrackId: string;
}

/** Ephemeral drag preview (horizontal position + width only) — no doc mutation until release. */
interface DragPreview {
  clipId: string;
  startSec: number;
  durationSec: number;
}

export function TimelinePanel({ initialDoc, onChange, className }: TimelinePanelProps) {
  const [history, setHistory] = useState<TimelineDoc[]>(() => [initialDoc ?? seedDoc()]);
  const [cursor, setCursor] = useState(0);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DragPreview | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const doc = history[cursor]!;
  const view = useMemo(() => inspectTimeline(doc), [doc]);
  const durationSec = timelineDurationSec(doc);
  const totalSec = Math.max(durationSec, MIN_VISIBLE_SEC);
  const laneWidth = totalSec * PX_PER_SEC;
  const selectedClip = selectedClipId ? doc.clips.find((c) => c.id === selectedClipId) ?? null : null;

  /** Apply a P1 op, fail-closed: on TimelineError show the code and keep the doc unchanged. */
  const commit = useCallback(
    (fn: (d: TimelineDoc) => TimelineDoc): boolean => {
      try {
        const next = fn(history[cursor]!);
        setHistory((h) => [...h.slice(0, cursor + 1), next]);
        setCursor((c) => c + 1);
        setError(null);
        onChange?.(next);
        return true;
      } catch (e) {
        setError(e instanceof TimelineError ? `${e.code}: ${e.message}` : String(e));
        return false;
      }
    },
    [history, cursor, onChange],
  );

  const undo = useCallback(() => {
    if (cursor > 0) {
      setCursor(cursor - 1);
      setError(null);
      onChange?.(history[cursor - 1]!);
    }
  }, [cursor, history, onChange]);

  const redo = useCallback(() => {
    if (cursor < history.length - 1) {
      setCursor(cursor + 1);
      setError(null);
      onChange?.(history[cursor + 1]!);
    }
  }, [cursor, history, onChange]);

  const onAddTrack = (kind: TrackKind) => commit((d) => addTrack(d, kind));

  const onAddClip = (trackId: string) =>
    commit((d) =>
      addClip(d, {
        trackId,
        sourceRef: 'asset:placeholder',
        startSec: snap(playheadSec),
        durationSec: 3,
        label: '片段',
      }),
    );

  const onSplit = () => {
    if (selectedClipId) commit((d) => splitClip(d, selectedClipId, snap(playheadSec)));
  };

  const onRemove = () => {
    if (!selectedClipId) return;
    const id = selectedClipId;
    if (commit((d) => removeClip(d, id))) setSelectedClipId(null);
  };

  // ---- pointer drag: move (horizontal + cross-lane) / trim the out edge --------------- //
  // Ephemeral during drag (setPreview), committed ONCE on pointerup (commit). This avoids
  // per-frame history entries and any stale-closure hazard under React event batching.
  const beginDrag = (e: React.PointerEvent, clip: TimelineClip, mode: DragState['mode']) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setSelectedClipId(clip.id);
    dragRef.current = {
      clipId: clip.id,
      mode,
      startX: e.clientX,
      origStartSec: clip.startSec,
      origDurationSec: clip.durationSec,
      origInSec: clip.inSec,
      origTrackId: clip.trackId,
      curStartSec: clip.startSec,
      curDurationSec: clip.durationSec,
      curTrackId: clip.trackId,
    };
    setPreview({ clipId: clip.id, startSec: clip.startSec, durationSec: clip.durationSec });
  };

  const onLanePointerMove = (e: React.PointerEvent, trackId: string) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaSec = (e.clientX - drag.startX) / PX_PER_SEC; // from the ORIGINAL anchor
    if (drag.mode === 'move') {
      const nextStart = snap(Math.max(0, drag.origStartSec + deltaSec));
      drag.curStartSec = nextStart;
      const lanes = Array.from(document.querySelectorAll<HTMLElement>('[data-timeline-track-id]'));
      const laneAtPointer = lanes.find((lane) => {
        const bounds = lane.getBoundingClientRect();
        return e.clientY >= bounds.top && e.clientY <= bounds.bottom;
      });
      drag.curTrackId = laneAtPointer?.dataset.timelineTrackId ?? trackId;
      setPreview({ clipId: drag.clipId, startSec: nextStart, durationSec: drag.origDurationSec });
    } else {
      const nextDur = Math.max(MIN_CLIP_SEC, snap(drag.origDurationSec + deltaSec));
      drag.curDurationSec = nextDur;
      setPreview({ clipId: drag.clipId, startSec: drag.origStartSec, durationSec: nextDur });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
    setPreview(null);
    if (drag.mode === 'move') {
      if (drag.curStartSec !== drag.origStartSec || drag.curTrackId !== drag.origTrackId) {
        commit((d) => moveClip(d, drag.clipId, { startSec: drag.curStartSec, trackId: drag.curTrackId }));
      }
    } else if (drag.curDurationSec !== drag.origDurationSec) {
      commit((d) => setClipProperties(d, drag.clipId, {
        durationSec: drag.curDurationSec,
        outSec: drag.origInSec + drag.curDurationSec,
      }));
    }
  };

  const cancelDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
    setPreview(null);
  };

  const onRulerClick = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPlayheadSec(snap(Math.max(0, (e.clientX - rect.left) / PX_PER_SEC)));
  };

  return (
    <div className={`cc-timeline${className ? ` ${className}` : ''}`} data-testid="cc-timeline">
      <div className="cc-timeline__toolbar">
        <span className="cc-timeline__title">时间线</span>
        {TRACK_KINDS.map((t) => (
          <button
            key={t.kind}
            type="button"
            className="cc-button cc-button--quiet"
            onClick={() => onAddTrack(t.kind)}
          >
            + {t.label}轨
          </button>
        ))}
        <span className="cc-timeline__spacer" />
        <button type="button" className="cc-button cc-button--quiet" onClick={undo} disabled={cursor === 0}>
          撤销
        </button>
        <button
          type="button"
          className="cc-button cc-button--quiet"
          onClick={redo}
          disabled={cursor >= history.length - 1}
        >
          重做
        </button>
        <span className="cc-timeline__meta" data-testid="cc-timeline-meta">
          {view.summary.trackCount} 轨 · {view.summary.clipCount} 片段 · {durationSec.toFixed(1)}s
        </span>
      </div>

      {error ? (
        <div className="cc-warning cc-timeline__error" role="alert" data-testid="cc-timeline-error">
          {error}
        </div>
      ) : null}

      <div className="cc-timeline__body">
        <div className="cc-timeline__ruler" style={{ width: laneWidth }} onClick={onRulerClick}>
          {Array.from({ length: Math.ceil(totalSec) + 1 }, (_, s) => (
            <span key={s} className="cc-timeline__tick" style={{ left: s * PX_PER_SEC }}>
              {s}
            </span>
          ))}
          <span
            className="cc-timeline__playhead"
            data-testid="cc-timeline-playhead"
            style={{ left: playheadSec * PX_PER_SEC }}
          />
        </div>

        {view.tracks.length === 0 ? (
          <p className="cc-timeline__empty">还没有轨道 —— 用上面的按钮加一条。</p>
        ) : null}

        {view.tracks.map((track) => (
          <div key={track.id} className="cc-timeline__track" data-testid={`cc-track-${track.kind}`}>
            <div className="cc-timeline__track-head">
              <strong>{track.name}</strong>
              <button
                type="button"
                className="cc-button cc-button--quiet cc-timeline__addclip"
                onClick={() => onAddClip(track.id)}
                aria-label={`向 ${track.name} 加片段`}
              >
                + 片段
              </button>
            </div>
            <div
              className="cc-timeline__lane"
              data-timeline-track-id={track.id}
              style={{ width: laneWidth }}
              onPointerMove={(e) => onLanePointerMove(e, track.id)}
              onPointerUp={endDrag}
              onPointerCancel={cancelDrag}
            >
              {track.clips.map((clip) => {
                const p = preview && preview.clipId === clip.id ? preview : null;
                const left = (p ? p.startSec : clip.startSec) * PX_PER_SEC;
                const width = (p ? p.durationSec : clip.durationSec) * PX_PER_SEC;
                return (
                  <div
                    key={clip.id}
                    className={`cc-timeline__clip${clip.id === selectedClipId ? ' is-selected' : ''}`}
                    data-testid="cc-clip"
                    data-clip-id={clip.id}
                    style={{ left, width }}
                    onPointerDown={(e) => beginDrag(e, clip, 'move')}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedClipId(clip.id);
                    }}
                  >
                    <span className="cc-timeline__clip-label">{clip.label ?? clip.sourceRef}</span>
                    <span
                      className="cc-timeline__clip-trim"
                      data-testid="cc-clip-trim"
                      aria-label="裁剪片段末端"
                      onPointerDown={(e) => beginDrag(e, clip, 'trim-end')}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {selectedClip ? (
        <ClipInspector
          key={selectedClip.id}
          clip={selectedClip}
          onPatch={(patch) => commit((d) => setClipProperties(d, selectedClip.id, patch))}
          onSplit={onSplit}
          onRemove={onRemove}
        />
      ) : null}
    </div>
  );
}

interface ClipInspectorProps {
  clip: TimelineClip;
  onPatch: (patch: { startSec?: number; durationSec?: number }) => void;
  onSplit: () => void;
  onRemove: () => void;
}

/** Deterministic numeric editing for the selected clip (also the test-friendly edit path).
 *  Fail-closed: an empty/non-finite input is ignored (never pushes NaN into the model). */
function ClipInspector({ clip, onPatch, onSplit, onRemove }: ClipInspectorProps) {
  const patchStart = (raw: string) => {
    const n = Number(raw);
    if (Number.isFinite(n)) onPatch({ startSec: snap(n) });
  };
  const patchDuration = (raw: string) => {
    const n = Number(raw);
    if (Number.isFinite(n)) onPatch({ durationSec: Math.max(MIN_CLIP_SEC, snap(n)) });
  };
  return (
    <div className="cc-timeline__inspector" data-testid="cc-clip-inspector">
      <span className="cc-timeline__inspector-title">选中片段 · {clip.label ?? clip.sourceRef}</span>
      <label className="cc-field">
        起点(s)
        <input
          type="number"
          min={0}
          step={SNAP_SEC}
          value={clip.startSec}
          aria-label="片段起点秒"
          onChange={(e) => patchStart(e.target.value)}
        />
      </label>
      <label className="cc-field">
        时长(s)
        <input
          type="number"
          min={MIN_CLIP_SEC}
          step={SNAP_SEC}
          value={clip.durationSec}
          aria-label="片段时长秒"
          onChange={(e) => patchDuration(e.target.value)}
        />
      </label>
      <button type="button" className="cc-button cc-button--quiet" onClick={onSplit}>
        在播放头分割
      </button>
      <button type="button" className="cc-button cc-button--danger" onClick={onRemove}>
        删除
      </button>
    </div>
  );
}
