import { Fragment, useState } from 'react';
import {
  Bot,
  ChevronDown,
  Clapperboard,
  Clock3,
  Download,
  ExternalLink,
  Film,
  GitBranch,
  Loader2,
  Maximize2,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  RotateCcw,
  Sparkles,
  Trash2,
  Volume2,
  X,
  Zap,
} from 'lucide-react';
import presetCinematicGif from '../../../assets/dreamy-preset-cinematic.gif';
import type { StudioAction, StudioJob, StudioProject, StudioSegment } from '../api';
import {
  downloadJsonPayload,
  EMPTY_GRAPH,
  fallbackVisualForDreamyBot,
  getSegmentMedia,
  getTimelineDisplaySegments,
  resolveStudioDisplayAssetUrl,
  statusPillTone,
  statusTone,
  verifiedWorkshopBotMatches,
} from '../model/dreamyWorkspace';
import type { ChatItem, StudioStarterPreset } from '../model/dreamyWorkspace';
import { Pill } from './studioStatus';

export function DreamyPreviewTimelinePanels({
  project,
  selectedSegment,
  selectedStarterPreset,
  onSelectSegment,
  onAction,
  onRunPreset,
  onExportAllSegments,
  timelineExporting,
  submitting,
}: {
  project: StudioProject | null;
  selectedSegment?: StudioSegment | null;
  selectedStarterPreset?: StudioStarterPreset | null;
  onSelectSegment: (segmentId: string) => void;
  onAction: (action: StudioAction, prompt?: string, source?: StudioSegment | null) => void;
  onRunPreset?: (preset: StudioStarterPreset, prompt?: string) => void;
  onExportAllSegments: () => void;
  timelineExporting: boolean;
  submitting: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  const segments = getTimelineDisplaySegments(project?.segments || []);
  const media = getSegmentMedia(selectedSegment);
  const selectedStarterVisual = resolveStudioDisplayAssetUrl(selectedStarterPreset?.visualUrl);
  const selectedSegmentFallback = fallbackVisualForDreamyBot(selectedSegment?.botSlug, selectedSegment?.botName);
  const starterMatchesSelectedSegment = Boolean(
    selectedStarterPreset && selectedSegment && verifiedWorkshopBotMatches(selectedSegment, selectedStarterPreset),
  );
  const showStarterPreview = Boolean(selectedStarterPreset && (!selectedSegment || !starterMatchesSelectedSegment));
  const stageMedia = showStarterPreview ? selectedStarterVisual : media;
  const stageFallback = showStarterPreview ? selectedStarterVisual || presetCinematicGif : selectedSegmentFallback;
  const selectedIndex = selectedSegment ? segments.findIndex((segment) => segment.id === selectedSegment.id) : -1;
  const selectedNumber = selectedIndex >= 0 ? selectedIndex + 1 : Math.max(segments.length, 1);
  const totalSeconds = Math.max(segments.length * 5, 5);
  const latestTimelineExport = project?.timelineExports?.[0] || null;
  const latestTimelineMediaUrl = resolveStudioDisplayAssetUrl(latestTimelineExport?.mediaUrl);
  const markerPositions = segments.length
    ? segments.map((_, index) => `${((index + 0.5) / segments.length) * 100}%`)
    : ['8%', '34%', '60%', '84%'];
  const timelineLabels = Array.from({ length: Math.max(segments.length, 2) + 1 }, (_, index) =>
    `00:${String(index * 5).padStart(2, '0')}`,
  );
  const runAddSegment = () => {
    if (selectedStarterPreset) {
      onRunPreset?.(selectedStarterPreset, `Append the next five second segment with ${selectedStarterPreset.title}.`);
      return;
    }
    if (selectedSegment) onAction('extend', 'Extend this into the next shot.', selectedSegment);
  };

  return (
    <>
      <section data-testid="preview-workspace-panel" className="dreamy-studio-preview" aria-label="Preview">
        <div className="dreamy-studio-preview-stage">
          <div data-testid="preview-main-stage" className="dreamy-studio-player">
            <div
              className="dreamy-studio-player-media"
              style={{
                backgroundImage: stageMedia ? undefined : `url(${stageFallback})`,
                backgroundPosition: 'center',
                backgroundRepeat: 'no-repeat',
                backgroundSize: 'cover',
              }}
            >
              {stageMedia ? (
                <img
                  src={stageMedia}
                  alt={`${selectedStarterPreset?.title || selectedSegment?.botName || 'Dreamy'} preview`}
                  onError={(event) => {
                    event.currentTarget.onerror = null;
                    event.currentTarget.src = stageFallback;
                  }}
                />
              ) : null}
            </div>
            <span className="dreamy-studio-scene-tag">
              <span className="dreamy-studio-live-dot" />
              {`Preview · Segment ${String(selectedNumber).padStart(2, '0')}`}
            </span>
            <span className="dreamy-studio-scene-cap">1920x1080 · 24fps</span>

            <div className="dreamy-studio-marker-track">
              <div className="dreamy-studio-marker-line" />
              {markerPositions.map((left, index) => (
                <span key={`${left}-${index}`} className="dreamy-studio-marker" style={{ left }} />
              ))}
            </div>

            <div className="dreamy-studio-controls">
              <button
                type="button"
                className="dreamy-studio-play"
                onClick={() => setPlaying((value) => !value)}
                aria-label={playing ? 'Pause preview' : 'Play preview'}
              >
                {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
              </button>
              <span className="dreamy-studio-time">
                00:03.21 <span>{`/ 00:${String(Math.min(totalSeconds, 5)).padStart(2, '0')}.00`}</span>
              </span>
              <div className="dreamy-studio-scrub" aria-hidden="true">
                <div className="dreamy-studio-scrub-fill" />
                <div className="dreamy-studio-scrub-knob" />
              </div>
              <button type="button" className="dreamy-studio-control-icon" aria-label="Volume">
                <Volume2 size={20} />
              </button>
              <button type="button" className="dreamy-studio-fit">
                Fit
                <ChevronDown size={13} />
              </button>
              <button type="button" className="dreamy-studio-control-icon" aria-label="Fullscreen">
                <Maximize2 size={18} />
              </button>
            </div>
          </div>
        </div>
      </section>

      <section data-testid="timeline-workbench" className="dreamy-studio-timeline" aria-label="Timeline">
        <div className="dreamy-studio-timeline-head">
          <span className="dreamy-studio-timeline-title">Timeline</span>
          <span className="dreamy-studio-total">{`Total 00:${String(totalSeconds).padStart(2, '0')}.00 · ${segments.length} segments`}</span>
          <span className="dreamy-studio-spacer" />
          <div className="dreamy-studio-tool">
            <button type="button" className="dreamy-studio-tool-button" aria-label="Undo">
              <RotateCcw size={17} />
            </button>
            <button type="button" className="dreamy-studio-tool-button" aria-label="Redo">
              <RefreshCcw size={17} />
            </button>
          </div>
          <div className="dreamy-studio-zoom">
            <button type="button" aria-label="Zoom out">-</button>
            <span className="dreamy-studio-zoom-bar" />
            <button type="button" aria-label="Zoom in">+</button>
          </div>
          <button
            type="button"
            data-testid="preview-append-next-segment"
            disabled={submitting || (!selectedSegment && !selectedStarterPreset)}
            onClick={runAddSegment}
            className="dreamy-studio-add disabled:opacity-50"
          >
            <Plus size={14} />
            Add segment
          </button>
        </div>

        <div className="dreamy-studio-timeline-body">
          <div className="dreamy-studio-ruler">
            {timelineLabels.map((label) => <span key={label}>{label}</span>)}
          </div>
          <div className="dreamy-studio-tracks">
            {segments.map((segment, index) => {
              const segmentMedia = getSegmentMedia(segment);
              const segmentFallback = fallbackVisualForDreamyBot(segment.botSlug, segment.botName);
              return (
                <Fragment key={segment.id}>
                  {index > 0 && (
                    <span className="dreamy-studio-gap">
                      <button type="button" aria-label="Insert segment" onClick={runAddSegment}>
                        <Plus size={12} />
                      </button>
                    </span>
                  )}
                  <button
                    type="button"
                    data-testid="timeline-segment-card"
                    onClick={() => onSelectSegment(segment.id)}
                    className={`dreamy-studio-clip ${segment.id === selectedSegment?.id ? 'is-sel' : ''}`}
                    style={{
                      backgroundImage: segmentMedia ? undefined : `url(${segmentFallback})`,
                      backgroundPosition: 'center',
                      backgroundSize: 'cover',
                    }}
                  >
                    {segmentMedia ? (
                      <img
                        src={segmentMedia}
                        alt=""
                        onError={(event) => {
                          event.currentTarget.style.display = 'none';
                        }}
                      />
                    ) : null}
                    <span className="dreamy-studio-clip-no">{index + 1}</span>
                    <span className="dreamy-studio-clip-len">5.0s</span>
                  </button>
                </Fragment>
              );
            })}
            {!segments.length && (
              <div className="flex h-[86px] flex-1 items-center justify-center rounded-lg border border-dashed border-white/15 text-xs text-Cr-text-subtler-v2">
                Start now to create segment 1
              </div>
            )}
          </div>
          <div className="dreamy-studio-hint">Drag to reorder · click a segment to edit or preview</div>
        </div>

        <div className="dreamy-studio-dock">
          <div className="dreamy-studio-cost">
            <span className="dreamy-studio-cost-label">Preview render</span>
            <span className="dreamy-studio-cost-value energy">
              <Zap size={16} fill="currentColor" />
              48
              <span className="dreamy-studio-unit">/ preview</span>
            </span>
          </div>
          <span className="dreamy-studio-cost-div" />
          <div className="dreamy-studio-cost">
            <span className="dreamy-studio-cost-label">Spent this project</span>
            <span className="dreamy-studio-cost-value">
              <Zap size={16} fill="currentColor" className="text-Cr-text-subtler-v2" />
              {Math.max(segments.length * 78, 156)}
              <span className="dreamy-studio-unit">energy</span>
            </span>
          </div>
          <span className="dreamy-studio-spacer" />
          <span className="dreamy-studio-cost-note">
            <Zap size={14} fill="currentColor" className="text-yellow-300" />
            Final render at 1080p · est. 240 energy
          </span>
          <button
            type="button"
            data-testid="preview-export-all-segments"
            disabled={!segments.length || timelineExporting}
            onClick={onExportAllSegments}
            className="dreamy-studio-start"
          >
            {timelineExporting ? 'Rendering' : 'Start now'}
            <span className="dreamy-studio-cost-chip">
              {timelineExporting ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} fill="currentColor" />}
              240
            </span>
          </button>
        </div>

        {latestTimelineExport && (
          <div data-testid="timeline-export-output-card" className="dreamy-studio-export-output">
            <Pill tone={latestTimelineExport.status === 'ready' ? 'success' : statusPillTone(latestTimelineExport.status)}>
              {latestTimelineExport.status}
            </Pill>
            <span>{latestTimelineExport.evidence?.message || `Composed ${latestTimelineExport.summary.videoSegments} video segments.`}</span>
            {latestTimelineMediaUrl && (
              <a href={latestTimelineMediaUrl} target="_blank" rel="noreferrer">
                Open composed video
              </a>
            )}
          </div>
        )}
      </section>
    </>
  );
}

export function PromptRoutingPanel({
  prompt,
  messages,
  selectedStarterPreset,
  selectedSegment,
  submitting,
}: {
  prompt: string;
  messages: ChatItem[];
  selectedStarterPreset?: StudioStarterPreset | null;
  selectedSegment?: StudioSegment | null;
  submitting: boolean;
}) {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  const latestAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant');
  const acceptedPrompt = prompt.trim() || latestUserMessage?.content || selectedStarterPreset?.prompt || '';
  const targetBotName = selectedStarterPreset?.title || selectedSegment?.botName || 'Choose a bot';
  const targetBotId = selectedStarterPreset?.botId || selectedSegment?.botId || selectedStarterPreset?.botSlug || selectedSegment?.botSlug || '';
  const nextAction = selectedSegment ? 'Add next segment' : 'Generate first segment';

  return (
    <div
      data-testid="studio-chat-log"
      className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-3 [-webkit-overflow-scrolling:touch]"
    >
      <div className="rounded-xl-v2 border border-dreamy-brand-hot-v2/35 bg-dreamy-brand-hot-v2/10 p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-Cr-text-default-v2">Prompt to bot</div>
            <div className="mt-0.5 truncate text-[11px] text-Cr-text-subtler-v2">
              {submitting ? 'Calling Dreamy now' : 'One prompt, one selected bot, one timeline result'}
            </div>
          </div>
          <Pill tone={submitting ? 'hot' : acceptedPrompt ? 'success' : 'default'}>
            {submitting ? 'Running' : acceptedPrompt ? 'Prompt accepted' : 'Waiting'}
          </Pill>
        </div>

        <div className="grid gap-2 text-xs">
          <div className="rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2 p-2.5">
            <div className="mb-1 text-[10px] font-semibold uppercase text-Cr-text-subtlest-v2">Input prompt</div>
            <div className="line-clamp-3 min-h-5 leading-5 text-Cr-text-default-v2">
              {acceptedPrompt || 'Type the next shot in the box below.'}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2 p-2.5">
              <div className="mb-1 text-[10px] font-semibold uppercase text-Cr-text-subtlest-v2">Bot to call</div>
              <div className="truncate font-semibold text-Cr-text-default-v2">{targetBotName}</div>
              {targetBotId && <div className="mt-0.5 truncate text-[11px] text-Cr-text-subtler-v2">{targetBotId}</div>}
            </div>
            <div className="rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2 p-2.5">
              <div className="mb-1 text-[10px] font-semibold uppercase text-Cr-text-subtlest-v2">Next action</div>
              <div className="truncate font-semibold text-Cr-text-default-v2">{nextAction}</div>
              <div className="mt-0.5 truncate text-[11px] text-Cr-text-subtler-v2">
                {selectedSegment ? `Source: ${selectedSegment.botName}` : 'Starts the timeline'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {latestAssistantMessage && (
        <div className="rounded-xl-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2 p-3 text-xs leading-5 text-Cr-text-subtle-v2">
          <div className="mb-1 text-[10px] font-semibold uppercase text-Cr-text-subtlest-v2">Latest result</div>
          <div className="line-clamp-3">{latestAssistantMessage.content}</div>
        </div>
      )}

      <div className="sr-only">
        {messages.map((message) => (
          <span key={message.id}>{message.content}</span>
        ))}
      </div>
    </div>
  );
}

export function SegmentCard({
  segment,
  active,
  onSelect,
  onDelete,
}: {
  segment: StudioSegment;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const media = getSegmentMedia(segment);
  return (
    <div
      className={`group relative h-[86px] w-[116px] shrink-0 overflow-hidden rounded-lg-v2 border text-left transition-colors ${
        active ? 'border-dreamy-brand-hot-v2' : 'border-Cr-border-default-v2'
      } bg-Cr-Bg-surface-default-v2`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="block h-full w-full text-left"
        aria-label={`Select ${segment.botName} segment`}
      >
        {media ? (
          <img src={media} alt="" className="h-full w-full object-contain opacity-80" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-Cr-Bg-surface-subtle-v2">
            <Film size={18} className="text-Cr-text-subtler-v2" />
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2">
          <div className="truncate text-[11px] font-semibold text-white">{segment.botName}</div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] capitalize text-white/70">{segment.action}</span>
            <span className={`text-[10px] font-semibold ${segment.status === 'error' ? 'text-red-300' : 'text-white/70'}`}>
              {segment.status}
            </span>
          </div>
        </div>
        <span className="absolute left-2 top-2 rounded bg-black/50 px-1.5 py-0.5 text-[10px] font-semibold text-white/85">
          {segment.type}
        </span>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        className="absolute right-1.5 top-1.5 hidden h-6 w-6 items-center justify-center rounded-md-v2 bg-black/60 text-white group-hover:flex"
        aria-label="Delete segment"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

export function PreviewPanel({
  project,
  selectedSegment,
  selectedStarterPreset,
  selectedJob,
  agentsOpen,
  onToggleAgents,
  onSelectSegment,
  onDeleteSegment,
  onCancelJob,
  onRetryJob,
  onAction,
  onRunPreset,
  onExportAllSegments,
  timelineExporting,
  submitting,
}: {
  project: StudioProject | null;
  selectedSegment?: StudioSegment | null;
  selectedStarterPreset?: StudioStarterPreset | null;
  selectedJob?: StudioJob | null;
  agentsOpen: boolean;
  onToggleAgents: () => void;
  onSelectSegment: (segmentId: string) => void;
  onDeleteSegment: (segmentId: string) => void;
  onCancelJob: (jobId: string) => void;
  onRetryJob: (jobId: string) => void;
  onAction: (action: StudioAction, prompt?: string, source?: StudioSegment | null) => void;
  onRunPreset?: (preset: StudioStarterPreset) => void;
  onExportAllSegments: () => void;
  timelineExporting: boolean;
  submitting: boolean;
}) {
  const media = getSegmentMedia(selectedSegment);
  const selectedSegmentFallback = fallbackVisualForDreamyBot(selectedSegment?.botSlug, selectedSegment?.botName);
  const selectedStarterVisual = resolveStudioDisplayAssetUrl(selectedStarterPreset?.visualUrl);
  const starterMatchesSelectedSegment = Boolean(
    selectedStarterPreset && selectedSegment && verifiedWorkshopBotMatches(selectedSegment, selectedStarterPreset),
  );
  const showStarterPreview = Boolean(selectedStarterPreset && (!selectedSegment || !starterMatchesSelectedSegment));
  const stageMedia = showStarterPreview ? selectedStarterVisual : media;
  const stageFallback = showStarterPreview ? selectedStarterVisual || presetCinematicGif : selectedSegmentFallback;
  const graph = project?.agentGraph?.length ? project.agentGraph : EMPTY_GRAPH;
  const runningAgents = graph.filter((node) => node.status === 'running' || node.status === 'queued').length;
  const segments = getTimelineDisplaySegments(project?.segments || []);
  const selectedSegmentIndex = selectedSegment
    ? segments.findIndex((segment) => segment.id === selectedSegment.id)
    : -1;
  const evidence = selectedSegment?.evidence || selectedJob?.evidence;
  const authStatus = selectedSegment?.authStatus || selectedJob?.authStatus;
  const activeJobId = selectedSegment?.jobId || selectedJob?.jobId;
  const latestTimelineExport = project?.timelineExports?.[0] || null;
  const latestTimelineMediaUrl = resolveStudioDisplayAssetUrl(latestTimelineExport?.mediaUrl);

  return (
    <section
      data-testid="preview-workspace-panel"
      className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-Cr-border-default-v2 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg-v2 bg-Cr-beta-white-8-v2">
            <Film size={16} className="text-dreamy-brand-hot-v2" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Preview</div>
            <div className="truncate text-[11px] text-Cr-text-subtler-v2">
              {selectedStarterPreset
                ? `Selected bot: ${selectedStarterPreset.title}`
                : segments.length
                  ? `${segments.length} segments`
                  : 'No segments'}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onToggleAgents}
          className="inline-flex h-8 items-center gap-2 rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 px-2 text-xs font-semibold text-Cr-text-subtle-v2"
        >
          <GitBranch size={14} />
          Agents
          {runningAgents > 0 && <span className="h-1.5 w-1.5 rounded-full bg-dreamy-brand-hot-v2" />}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <div
          data-testid="preview-main-stage"
          className="relative flex h-[clamp(260px,38dvh,420px)] shrink-0 items-center justify-center overflow-hidden rounded-lg-v2 border border-Cr-border-default-v2 bg-[#07080d]"
          style={{
            backgroundImage: stageMedia ? undefined : `url(${stageFallback})`,
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            backgroundSize: 'contain',
          }}
        >
          {!showStarterPreview && selectedSegment?.type === 'video' && selectedSegment.url ? (
            <img
              src={media || selectedSegmentFallback}
              alt={`${selectedSegment.botName || 'Selected'} segment preview`}
              onError={(event) => {
                event.currentTarget.onerror = null;
                event.currentTarget.src = selectedSegmentFallback;
              }}
              className="h-full w-full object-contain"
            />
          ) : !showStarterPreview && media ? (
            <img src={media} alt="Selected segment" className="h-full w-full object-contain" />
          ) : selectedStarterPreset ? (
            <div
              data-testid="preview-selected-dreamy-bot"
              className="relative h-full w-full bg-black/20"
            >
              {selectedStarterVisual ? (
                <img src={selectedStarterVisual} alt="" className="h-full w-full object-contain opacity-90" />
              ) : (
                <div className="grid h-full place-items-center text-Cr-text-subtler-v2">
                  <Bot size={32} />
                </div>
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/5 to-transparent" />
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 text-Cr-text-subtler-v2">
              <div className="flex h-14 w-14 items-center justify-center rounded-xl-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2">
                <Sparkles size={24} />
              </div>
              <div className="text-sm font-semibold">Ready for a first segment</div>
            </div>
          )}

          <div className="absolute left-3 top-3 flex flex-wrap gap-2">
            {showStarterPreview && selectedStarterPreset ? (
              <>
                <Pill tone={selectedStarterPreset.previewAccepted ? 'success' : 'hot'}>{selectedStarterPreset.previewLabel}</Pill>
                <Pill>{selectedStarterPreset.title}</Pill>
              </>
            ) : selectedSegment ? (
              <>
                <Pill tone={statusPillTone(selectedSegment.status)}>{selectedSegment.status}</Pill>
                <Pill>{selectedSegment.botName}</Pill>
              </>
            ) : selectedStarterPreset ? (
              <>
                <Pill tone="hot">{selectedStarterPreset.workflow}</Pill>
                <Pill>{selectedStarterPreset.title}</Pill>
              </>
            ) : null}
          </div>

          <div className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-lg-v2 border border-white/10 bg-black/70 px-3 py-2 backdrop-blur">
            <button type="button" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md-v2 bg-white text-black">
              <Play size={14} />
            </button>
            <div className="hidden h-5 w-px bg-white/15 sm:block" />
            <span className="shrink-0 text-xs font-semibold text-white/80">
              {segments.length ? `00:00 / 00:${String(segments.length * 5).padStart(2, '0')}` : '00:00 / 00:05'}
            </span>
            <div className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full-v2 bg-white/20">
              <div className="h-full w-1/3 rounded-full-v2 bg-dreamy-brand-hot-v2" />
            </div>
            <span className="hidden shrink-0 text-xs font-semibold text-white/60 sm:inline">Fit</span>
            <Maximize2 size={15} className="hidden shrink-0 text-white/65 sm:block" />
          </div>
        </div>

        <div
          data-testid="timeline-workbench"
          className="min-h-0 flex-1 overflow-y-auto rounded-xl-v2 border border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 p-3 [-webkit-overflow-scrolling:touch]"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">Timeline</div>
              <div className="mt-0.5 text-[11px] text-Cr-text-subtler-v2">
                {segments.length ? `Total 00:${String(segments.length * 5).padStart(2, '0')} · ${segments.length} segments` : 'No segments yet'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="preview-segment-rerun"
                disabled={!selectedSegment || submitting}
                onClick={() => {
                  if (selectedStarterPreset) {
                    onRunPreset?.(selectedStarterPreset);
                  } else {
                    onAction('retry-agent', 'Rerun this selected segment with stronger continuity and keep it in the timeline.', selectedSegment);
                  }
                }}
                className="inline-flex h-9 items-center gap-1.5 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 px-3 text-xs font-semibold text-Cr-text-default-v2 disabled:text-Cr-text-subtlest-v2"
              >
                <RefreshCcw size={14} />
                Rerun
              </button>
              <button
                type="button"
                data-testid="preview-append-next-segment"
                disabled={submitting || (!selectedSegment && !selectedStarterPreset)}
                onClick={() => {
                  if (selectedStarterPreset) {
                    onRunPreset?.(selectedStarterPreset);
                  } else if (selectedSegment) {
                    onAction('extend', 'Extend this into the next shot', selectedSegment);
                  }
                }}
                className="inline-flex h-9 items-center gap-1.5 rounded-md-v2 bg-dreamy-brand-hot-v2 px-3 text-xs font-semibold text-white disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
              >
                <Clapperboard size={14} />
                {selectedSegment ? 'Add segment' : 'Start now'}
              </button>
              <button
                type="button"
                data-testid="preview-export-all-segments"
                disabled={!segments.length || timelineExporting}
                onClick={onExportAllSegments}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 px-3 text-xs font-semibold text-Cr-text-default-v2 disabled:text-Cr-text-subtlest-v2"
              >
                {timelineExporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                Export
              </button>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-3 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
            {segments.map((segment, index) => {
              const segmentMedia = getSegmentMedia(segment);
              const segmentFallback = fallbackVisualForDreamyBot(segment.botSlug, segment.botName);
              return (
                <button
                  key={segment.id}
                  type="button"
                  data-testid="timeline-segment-card"
                  onClick={() => onSelectSegment(segment.id)}
                  className={`relative h-[96px] w-[168px] shrink-0 overflow-hidden rounded-lg-v2 border text-left ${
                    segment.id === selectedSegment?.id
                      ? 'border-dreamy-brand-hot-v2 shadow-[0_0_0_1px_rgba(244,45,118,0.45)]'
                      : 'border-Cr-border-default-v2'
                  } bg-Cr-Bg-surface-default-v2`}
                  style={{
                    backgroundImage: segmentMedia ? undefined : `url(${segmentFallback})`,
                    backgroundPosition: 'center',
                    backgroundSize: 'cover',
                  }}
                >
                  {segmentMedia ? (
                    <img
                      src={segmentMedia}
                      alt=""
                      onError={(event) => {
                        event.currentTarget.style.display = 'none';
                      }}
                      className="h-full w-full object-cover opacity-90"
                    />
                  ) : (
                    <div className="grid h-full w-full place-items-center bg-Cr-Bg-surface-subtle-v2 text-Cr-text-subtler-v2">
                      <Film size={20} />
                    </div>
                  )}
                  <span className="absolute left-2 top-2 rounded bg-black/65 px-2 py-1 text-xs font-semibold text-white">{index + 1}</span>
                  <span className="absolute bottom-2 right-2 rounded bg-black/65 px-2 py-1 text-[11px] font-semibold text-white">5.0s</span>
                  <span className={`absolute bottom-2 left-2 rounded px-2 py-1 text-[10px] font-semibold ${
                    segment.status === 'done'
                      ? 'bg-Cr-text-success-default-v2/85 text-white'
                      : 'bg-dreamy-brand-hot-v2/85 text-white'
                  }`}>
                    {segment.status}
                  </span>
                </button>
              );
            })}
            {!segments.length && (
              <div className="flex h-[104px] min-w-[220px] items-center justify-center rounded-lg-v2 border border-dashed border-Cr-border-default-v2 text-xs text-Cr-text-subtler-v2">
                Start now to create segment 1
              </div>
            )}
          </div>

          <div className="mt-3 flex min-w-0 items-center gap-2 rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 px-3 py-2 text-xs text-Cr-text-subtle-v2">
            <Clock3 size={14} className="shrink-0 text-dreamy-brand-hot-v2" />
            <span data-testid="video-fast-status" className="min-w-0 flex-1 truncate">
              {submitting
                ? 'Generating the next clip...'
                : segments.length
                  ? `Timeline cost: ${segments.length} short clip${segments.length === 1 ? '' : 's'} / ${segments.length * 5}s total.`
                  : 'Timeline cost appears after the first clip.'}
            </span>
            {selectedStarterPreset && (
              <span data-testid="selected-dreamy-bot-preview" className="hidden min-w-0 items-center gap-2 sm:inline-flex">
                <span data-testid="preview-selected-dreamy-bot" className="truncate font-semibold text-Cr-text-default-v2">
                  {selectedStarterPreset.title}
                </span>
              </span>
            )}
          </div>

          {latestTimelineExport && (
            <div
              data-testid="timeline-export-output-card"
              className="mt-3 grid gap-2 rounded-lg-v2 border border-dreamy-brand-hot-v2/35 bg-dreamy-brand-hot-v2/10 p-3 text-xs text-Cr-text-subtle-v2 sm:grid-cols-[minmax(0,1fr)_auto]"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-Cr-text-default-v2">Long video output</span>
                  <Pill tone={latestTimelineExport.status === 'ready' ? 'success' : statusPillTone(latestTimelineExport.status)}>
                    {latestTimelineExport.status}
                  </Pill>
                  <Pill>{`${latestTimelineExport.summary.videoSegments} video clips`}</Pill>
                </div>
                <div className="mt-1 truncate text-Cr-text-subtler-v2">
                  {latestTimelineExport.evidence?.message || `${latestTimelineExport.summary.totalSegments} timeline segments packaged.`}
                </div>
                {latestTimelineMediaUrl && (
                  <a
                    href={latestTimelineMediaUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex max-w-full items-center gap-1.5 truncate font-semibold text-dreamy-brand-hot-v2"
                  >
                    <ExternalLink size={13} />
                    <span className="truncate">Open composed video</span>
                  </a>
                )}
              </div>
              <button
                type="button"
                onClick={() => downloadJsonPayload(latestTimelineExport, `dreamy-timeline-export-${latestTimelineExport.exportId}.json`)}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md-v2 bg-Cr-beta-white-8-v2 px-3 font-semibold text-Cr-text-default-v2 active:bg-Cr-beta-white-12-v2"
              >
                <Download size={13} />
                Manifest
              </button>
            </div>
          )}
        </div>
      </div>

      {agentsOpen && (
        <div className="absolute bottom-3 right-3 top-14 z-20 w-[min(360px,calc(100%-24px))] rounded-xl-v2 border border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 p-3 shadow-2xl">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <PanelRightOpen size={16} />
              Agents
            </div>
            <button type="button" onClick={onToggleAgents} className="flex h-8 w-8 items-center justify-center rounded-lg-v2 bg-Cr-Bg-surface-subtle-v2">
              <X size={14} />
            </button>
          </div>
          <div className="space-y-2">
            {graph.map((node, index) => (
              <div key={node.id} className="rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md-v2 bg-Cr-beta-white-8-v2 text-[11px] font-semibold">
                      {index + 1}
                    </span>
                    <span className="truncate text-xs font-semibold">{node.label}</span>
                  </div>
                  <span className={`text-[11px] font-semibold ${statusTone(node.status)}`}>{node.status}</span>
                </div>
                {node.detail && <div className="mt-2 text-xs leading-5 text-Cr-text-subtler-v2">{node.detail}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
