import { useMemo, useState } from 'react';
import { Bot, CheckCircle2, Clapperboard, GitBranch, Play, Plus, RefreshCcw, Sparkles, X, Zap } from 'lucide-react';
import type { StudioAction, StudioProject, StudioSegment } from '../api';
import {
  fallbackVisualForDreamyBot,
  getSegmentMedia,
  getTimelineDisplaySegments,
  resolveStudioDisplayAssetUrl,
  verifiedWorkshopBotMatches,
} from '../model/dreamyWorkspace';
import type { ChatItem, ManualBotEntry, StudioStarterPreset } from '../model/dreamyWorkspace';
import { Pill } from './studioStatus';
import { BotPresetCard } from './botSelection';

export function DreamyOrchestratorThread({
  project,
  messages,
  starterPresets,
  allBotPresets,
  selectedStarterPresetId,
  selectedStarterPreset,
  selectedSegment,
  manualBotIdsText,
  manualBotEntries,
  selectedManualBotEntryId,
  submitting,
  onSelectPreset,
  onManualBotIdsChange,
  onSelectManualBot,
  onRunManualBot,
  onRunManualBotSequence,
  onRunPreset,
  onAction,
}: {
  project: StudioProject | null;
  messages: ChatItem[];
  starterPresets: StudioStarterPreset[];
  allBotPresets: StudioStarterPreset[];
  selectedStarterPresetId?: string;
  selectedStarterPreset?: StudioStarterPreset | null;
  selectedSegment?: StudioSegment | null;
  manualBotIdsText: string;
  manualBotEntries: ManualBotEntry[];
  selectedManualBotEntryId?: string;
  submitting: boolean;
  onSelectPreset: (preset: StudioStarterPreset) => void;
  onManualBotIdsChange: (value: string) => void;
  onSelectManualBot: (entry: ManualBotEntry) => void;
  onRunManualBot: (entry: ManualBotEntry) => void;
  onRunManualBotSequence: () => void;
  onRunPreset?: (preset: StudioStarterPreset, prompt?: string) => void;
  onAction: (action: StudioAction, prompt?: string, source?: StudioSegment | null) => void;
}) {
  const [allBotPickerOpen, setAllBotPickerOpen] = useState(false);
  const activeStarterPresetId = selectedStarterPreset?.id || selectedStarterPresetId;
  const selectableBotCount = allBotPresets.length || starterPresets.length;
  const choicePresets = useMemo(() => {
    const seen = new Set<string>();
    const ordered = [selectedStarterPreset, ...starterPresets, ...allBotPresets].filter(Boolean) as StudioStarterPreset[];
    return ordered.filter((preset) => {
      const key = preset.botSlug || preset.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 4);
  }, [allBotPresets, selectedStarterPreset, starterPresets]);
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  const latestAssistantError = [...messages].reverse().find((message) => message.error);
  const displayPrompt =
    latestUserMessage?.content ||
    selectedStarterPreset?.prompt ||
    'Generate a 5s rooftop suite at night - neon skyline through the window, slow push-in, cinematic.';
  const segments = getTimelineDisplaySegments(project?.segments || []);
  const selectedSegmentIndex = selectedSegment ? segments.findIndex((segment) => segment.id === selectedSegment.id) : -1;
  const segmentMedia = getSegmentMedia(selectedSegment);
  const selectedSegmentNumber = selectedSegmentIndex >= 0 ? selectedSegmentIndex + 1 : Math.max(segments.length, 1);
  const selectedBotName = selectedStarterPreset?.title || selectedSegment?.botName || choicePresets[0]?.title || 'Dreamy bot';
  const allPresets = allBotPresets.length ? allBotPresets : starterPresets;

  return (
    <div data-testid="studio-chat-log" className="dreamy-studio-thread" aria-label="Dreamy orchestrator conversation">
      <div className="dreamy-studio-msg">
        <div className="dreamy-studio-msg-avatar dreamy-studio-msg-avatar-user">D</div>
        <div className="min-w-0">
          <div className="dreamy-studio-who">
            <span className="dreamy-studio-name">You</span>
            <span className="dreamy-studio-time">10:41 AM</span>
          </div>
          <div className="dreamy-studio-bubble">{displayPrompt}</div>
        </div>
      </div>

      <div className="dreamy-studio-msg">
        <div className="dreamy-studio-msg-avatar dreamy-studio-msg-avatar-bot">
          <Bot size={15} />
        </div>
        <div className="min-w-0">
          <div className="dreamy-studio-who">
            <span className="dreamy-studio-name">Orchestrator</span>
            <span className="dreamy-studio-time">10:41 AM</span>
          </div>
          <div className="dreamy-studio-body-text">
            I found <b className="text-white">{choicePresets.length || selectableBotCount} scenes</b> that match your prompt.
            Pick the one you want to bring to life.
          </div>
          <div className="dreamy-studio-choice-head">
            <span className="dreamy-studio-eyebrow">Choose a scene</span>
            <span className="dreamy-studio-faint">{`${choicePresets.length} options`}</span>
          </div>
          <div data-testid="all-bot-previews" className="dreamy-studio-choice-list">
            {choicePresets.map((preset, index) => {
              const selected = activeStarterPresetId === preset.id;
              const cost = preset.workflow.toLowerCase().includes('video') ? (index === 2 ? 56 : 48) : 44;
              const visual = resolveStudioDisplayAssetUrl(preset.visualUrl) || preset.fallbackVisualUrl || fallbackVisualForDreamyBot(preset.botSlug, preset.title);
              return (
                <button
                  key={preset.id}
                  type="button"
                  data-testid="dreamy-scene-choice"
                  aria-pressed={selected}
                  onClick={() => onSelectPreset(preset)}
                  className={`dreamy-studio-choice ${selected ? 'is-on' : ''}`}
                >
                  <span className="dreamy-studio-choice-thumb">
                    {visual ? <img src={visual} alt="" /> : null}
                  </span>
                  <span className="min-w-0">
                    <span className="dreamy-studio-choice-title">{preset.title}</span>
                    <span className="dreamy-studio-choice-desc">
                      {preset.workflow} · {preset.previewAccepted ? 'ready media' : preset.previewLabel} · 5s
                    </span>
                  </span>
                  <span className="dreamy-studio-pickside">
                    <span className="dreamy-studio-cost-mini">
                      <Zap size={11} fill="currentColor" />
                      {cost}
                    </span>
                    <span className="dreamy-studio-radio">
                      <CheckCircle2 size={11} />
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="dreamy-studio-choice-foot">
            <button type="button" className="dreamy-studio-ghost-pill" onClick={() => setAllBotPickerOpen(true)}>
              <RefreshCcw size={13} />
              Show other scenes
            </button>
            <span className="dreamy-studio-faint">Tap a scene to preview · switch anytime</span>
          </div>
        </div>
      </div>

      <div className="dreamy-studio-msg">
        <div className="dreamy-studio-msg-avatar dreamy-studio-msg-avatar-bot">
          <Sparkles size={15} />
        </div>
        <div className="min-w-0">
          <div className="dreamy-studio-who">
            <span className="dreamy-studio-name">Orchestrator</span>
            <span className="dreamy-studio-time">10:41 AM</span>
          </div>
          <div className="dreamy-studio-body-text">
            Segment <b className="text-white">{String(selectedSegmentNumber).padStart(2, '0')}</b> is ready. Added to the timeline.
          </div>
          <div className="dreamy-studio-segment-card">
            <div className="dreamy-studio-segment-thumb">
              {segmentMedia ? <img src={segmentMedia} alt="" /> : null}
              <button type="button" className="dreamy-studio-segment-play" aria-label="Preview segment">
                <Play size={16} fill="currentColor" />
              </button>
              <span className="dreamy-studio-duration">00:05</span>
            </div>
            <div className="dreamy-studio-segment-meta">
              <div className="dreamy-studio-eyebrow">Inputs used</div>
              <div className="dreamy-studio-seg-pills">
                <span className="dreamy-studio-seg-pill"><span className="dreamy-studio-faint">Source</span><b>{selectedSegment?.botSlug || selectedStarterPreset?.botSlug || 'keyframe_02'}</b></span>
                <span className="dreamy-studio-seg-pill"><span className="dreamy-studio-faint">Prompt</span><b>{selectedBotName}</b></span>
                <span className="dreamy-studio-seg-pill"><span className="dreamy-studio-faint">Style</span><b>Cinematic</b></span>
                <span className="dreamy-studio-seg-pill"><span className="dreamy-studio-faint">Motion</span><b>Slow</b></span>
              </div>
            </div>
            <div className="dreamy-studio-seg-actions">
              <button
                type="button"
                data-testid="orchestrator-extend-segment"
                disabled={submitting || (!selectedSegment && !selectedStarterPreset)}
                onClick={() => {
                  if (selectedStarterPreset) onRunPreset?.(selectedStarterPreset, `Extend ${selectedBotName} as the next five second shot.`);
                  else onAction('extend', 'Extend this into the next shot.', selectedSegment);
                }}
                className="dreamy-studio-seg-action dreamy-studio-seg-action-primary disabled:opacity-50"
              >
                <Plus size={13} />
                Extend
              </button>
              <button
                type="button"
                disabled={!selectedSegment || submitting}
                onClick={() => onAction('extend', 'Use this segment as the source for the next shot.', selectedSegment)}
                className="dreamy-studio-seg-action disabled:opacity-50"
              >
                Use as next source
              </button>
              <span className="dreamy-studio-spacer" />
              <button type="button" className="dreamy-studio-seg-action !w-8 !px-0" aria-label="More segment actions">
                ...
              </button>
            </div>
          </div>
          {latestAssistantError?.error && (
            <div className="mt-3 rounded-lg border border-red-400/35 bg-red-500/10 p-2 text-xs leading-5 text-red-100">
              {latestAssistantError.error}
            </div>
          )}
        </div>
      </div>

      <div className="sr-only">
        {messages.map((message) => (
          <span key={message.id}>{message.content}</span>
        ))}
      </div>

      {allBotPickerOpen && (
        <div className="dreamy-studio-dialog-backdrop" role="dialog" aria-modal="true" aria-label="All selectable Dreamy bots">
          <button
            type="button"
            className="absolute inset-0"
            aria-label="Close all bot picker"
            onClick={() => setAllBotPickerOpen(false)}
          />
          <section className="dreamy-studio-dialog">
            <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-Cr-text-default-v2">
                  <Bot size={15} className="text-dreamy-brand-hot-v2" />
                  All selectable bots
                </div>
                <div className="truncate text-[11px] text-Cr-text-subtler-v2">
                  Select one bot for the prompt. The canvas preview follows the active choice.
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Pill tone="hot">{`${allPresets.length} bots`}</Pill>
                <button
                  type="button"
                  onClick={() => setAllBotPickerOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-md-v2 border border-white/10 bg-white/[0.04] text-Cr-text-subtler-v2 active:bg-white/[0.08]"
                  aria-label="Close all bot picker"
                >
                  <X size={15} />
                </button>
              </div>
            </div>
            <div data-testid="all-bots-modal-list" className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {allPresets.map((preset) => (
                  <BotPresetCard
                    key={`modal-${preset.id}`}
                    preset={preset}
                    selected={activeStarterPresetId === preset.id}
                    submitting={submitting}
                    variant="modal"
                    onSelect={(nextPreset) => {
                      onSelectPreset(nextPreset);
                      setAllBotPickerOpen(false);
                    }}
                  />
                ))}
              </div>
              <details data-testid="manual-bot-id-panel" className="mt-4 rounded-lg-v2 border border-white/10 bg-white/[0.03] p-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 marker:hidden">
                  <span className="text-xs font-semibold uppercase text-Cr-text-subtler-v2">Manual Bot IDs</span>
                  <Pill tone={manualBotEntries.length ? 'hot' : 'default'}>{`${manualBotEntries.length} queued`}</Pill>
                </summary>
                <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px]">
                  <textarea
                    data-testid="manual-bot-id-input"
                    value={manualBotIdsText}
                    disabled={submitting}
                    onChange={(event) => onManualBotIdsChange(event.target.value)}
                    rows={3}
                    className="min-h-20 resize-none rounded-md-v2 border border-white/10 bg-black/35 px-3 py-2 text-xs leading-5 text-Cr-text-default-v2 outline-none placeholder:text-Cr-text-subtlest-v2 disabled:opacity-50"
                    placeholder="botId or botId|name|type|slug|articleId"
                  />
                  <div className="grid gap-2">
                    <button
                      type="button"
                      data-testid="manual-bot-run-selected"
                      disabled={submitting || !manualBotEntries.length}
                      onClick={() => {
                        const selected = manualBotEntries.find((entry) => entry.id === selectedManualBotEntryId) || manualBotEntries[0];
                        if (selected) onRunManualBot(selected);
                      }}
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md-v2 bg-white/[0.08] px-3 text-xs font-semibold text-Cr-text-default-v2 disabled:opacity-40"
                    >
                      <Clapperboard size={13} />
                      Run selected
                    </button>
                    <button
                      type="button"
                      data-testid="manual-bot-run-sequence"
                      disabled={submitting || manualBotEntries.length < 2}
                      onClick={onRunManualBotSequence}
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md-v2 bg-dreamy-brand-hot-v2 px-3 text-xs font-semibold text-white disabled:bg-white/[0.08] disabled:text-Cr-text-subtlest-v2"
                    >
                      <GitBranch size={13} />
                      Run sequence
                    </button>
                  </div>
                </div>
                {!!manualBotEntries.length && (
                  <div data-testid="manual-bot-sequence-list" className="mt-3 flex gap-2 overflow-x-auto pb-1">
                    {manualBotEntries.map((entry, index) => (
                      <button
                        key={entry.id}
                        type="button"
                        disabled={submitting}
                        aria-pressed={selectedManualBotEntryId === entry.id}
                        onClick={() => onSelectManualBot(entry)}
                        className={`min-w-[144px] rounded-md-v2 border px-2 py-2 text-left disabled:opacity-50 ${
                          selectedManualBotEntryId === entry.id
                            ? 'border-dreamy-brand-hot-v2 bg-dreamy-brand-hot-v2/10'
                            : 'border-white/10 bg-white/[0.04]'
                        }`}
                      >
                        <span className="block truncate text-xs font-semibold text-Cr-text-default-v2">{entry.botName}</span>
                        <span className="block truncate text-[10px] text-Cr-text-subtlest-v2">{`${index + 1}. ${entry.botId || entry.botSlug}`}</span>
                      </button>
                    ))}
                  </div>
                )}
              </details>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
