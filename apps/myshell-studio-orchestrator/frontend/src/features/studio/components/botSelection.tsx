import { useCallback, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  Clapperboard,
  ExternalLink,
  GitBranch,
  Layers3,
  MousePointer2,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import type { StudioSegment } from '../api';
import {
  fallbackVisualForDreamyBot,
  getStarterPresetAction,
  getStarterPresetRunLabel,
  resolveStudioDisplayAssetUrl,
} from '../model/dreamyWorkspace';
import type { ManualBotEntry, StudioStarterPreset } from '../model/dreamyWorkspace';
import { Pill } from './studioStatus';

export function RecommendationAgentPanel({
  preset,
  submitting,
  onRunPreset,
}: {
  preset?: StudioStarterPreset;
  submitting: boolean;
  onRunPreset?: (preset: StudioStarterPreset) => void;
}) {
  if (!preset) return null;

  return (
    <div
      data-testid="ai-recommendation-agent"
      className="grid gap-2 rounded-lg-v2 border border-dreamy-brand-hot-v2/35 bg-dreamy-brand-hot-v2/10 p-2 sm:grid-cols-[96px_minmax(0,1fr)_auto]"
    >
      <div className="relative h-[70px] overflow-hidden rounded-md-v2 border border-white/10 bg-black/30">
        <img src={preset.visualUrl} alt="" className="h-full w-full object-contain" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
        <div className="absolute -left-6 top-0 h-full w-12 rotate-12 animate-pulse bg-white/20 blur-sm" />
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-Cr-text-default-v2">{preset.title}</span>
          <Pill tone="hot">{preset.workflow}</Pill>
          <Pill>{`${preset.estimatedWaitSeconds}s target`}</Pill>
          <Pill tone={preset.previewAccepted ? 'success' : 'hot'}>{preset.previewLabel}</Pill>
        </div>
        <div className="mt-1 line-clamp-2 text-xs leading-5 text-Cr-text-subtle-v2">{preset.recommendation}</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {preset.steps.map((step) => (
            <span key={step} className="rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 py-1 text-[10px] font-semibold text-Cr-text-subtler-v2">
              {step}
            </span>
          ))}
        </div>
      </div>
      <button
        type="button"
        data-testid="ai-recommendation-run"
        disabled={submitting}
        onClick={() => onRunPreset?.(preset)}
        className="inline-flex h-9 items-center justify-center gap-2 rounded-md-v2 bg-dreamy-brand-hot-v2 px-3 text-xs font-semibold text-white disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2 sm:self-center"
      >
        <Sparkles size={14} />
        Run AI pick
      </button>
    </div>
  );
}

export function BotPresetCard({
  preset,
  selected,
  submitting,
  onSelect,
  variant = 'main',
}: {
  preset: StudioStarterPreset;
  selected: boolean;
  submitting: boolean;
  onSelect: (preset: StudioStarterPreset) => void;
  variant?: 'main' | 'modal';
}) {
  const isModal = variant === 'modal';
  return (
    <div data-testid={isModal ? 'all-bot-picker-card' : 'all-bot-preview-card'}>
      <button
        type="button"
        data-testid={isModal ? `all-bot-picker-${preset.id}` : `starter-preset-${preset.id}`}
        aria-label={`Select ${preset.title} preset`}
        aria-pressed={selected}
        disabled={submitting}
        onClick={() => onSelect(preset)}
        className={`group grid w-full overflow-hidden rounded-xl-v2 border text-left transition-colors active:bg-Cr-beta-white-8-v2 disabled:opacity-50 ${
          isModal
            ? 'h-[132px] grid-cols-[minmax(150px,40%)_minmax(0,1fr)]'
            : 'h-[118px] grid-cols-[minmax(168px,34%)_minmax(0,1fr)]'
        } ${
          selected
            ? 'border-dreamy-brand-hot-v2 bg-dreamy-brand-hot-v2/10 shadow-[0_0_0_1px_rgba(244,45,118,0.35)]'
            : 'border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2'
        }`}
      >
        <span
          data-testid={isModal ? 'all-bot-picker-preview-asset' : 'starter-bot-preview-asset'}
          className="relative block h-full overflow-hidden border-r border-Cr-border-default-v2 bg-black/25"
          style={{
            backgroundImage: preset.visualUrl === preset.fallbackVisualUrl ? `url(${preset.fallbackVisualUrl})` : undefined,
            backgroundPosition: 'center',
            backgroundSize: 'cover',
          }}
        >
          <span data-testid={isModal ? 'all-bot-picker-preview-image' : 'all-bot-preview-image'} className="block h-full w-full">
            <img
              data-testid={isModal ? 'all-bot-picker-image' : 'starter-bot-preview-image'}
              src={preset.visualUrl}
              alt={`${preset.title} preview`}
              onError={(event) => {
                event.currentTarget.style.display = 'none';
              }}
              className="h-full w-full object-contain transition-transform duration-500 group-hover:scale-[1.03] group-active:scale-105"
            />
          </span>
          <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/10" />
          <span
            data-testid={preset.previewAccepted ? 'starter-bot-preview-real' : 'starter-bot-preview-fallback'}
            className="absolute bottom-2 left-2 rounded bg-black/65 px-2 py-1 text-[10px] font-semibold uppercase text-white"
          >
            {preset.previewLabel}
          </span>
          <span className="absolute bottom-0 left-0 h-0.5 w-2/3 rounded-r bg-dreamy-brand-hot-v2" />
        </span>
        <span className="grid min-w-0 content-between gap-1.5 p-3">
          <span className="min-w-0">
            <span className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-semibold text-Cr-text-default-v2">{preset.title}</span>
              {selected ? (
                <CheckCircle2 size={15} className="shrink-0 text-Cr-text-success-default-v2" />
              ) : (
                <MousePointer2 size={15} className="shrink-0 text-dreamy-brand-hot-v2" />
              )}
            </span>
            <span className={`${isModal ? 'line-clamp-2' : 'line-clamp-1'} mt-1 text-xs leading-5 text-Cr-text-subtle-v2`}>
              {preset.recommendation}
            </span>
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Pill tone="hot">{preset.workflow}</Pill>
            <Pill>{preset.botId || preset.botSlug}</Pill>
          </span>
          <span
            data-testid="starter-bot-preview-state"
            className="truncate text-[10px] font-semibold uppercase text-Cr-text-subtlest-v2"
          >
            {preset.previewAccepted ? `${preset.previewSource}` : `${preset.previewStatus}`}
          </span>
        </span>
      </button>
    </div>
  );
}

export function BotSelectionPanel({
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
}: {
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
  onRunPreset?: (preset: StudioStarterPreset) => void;
}) {
  const activeStarterPresetId = selectedStarterPreset?.id || selectedStarterPresetId;
  const [allBotPickerOpen, setAllBotPickerOpen] = useState(false);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const selectableBotCount = allBotPresets.length || starterPresets.length;
  const starterPresetKeys = new Set(starterPresets.flatMap((preset) => [preset.id, preset.botSlug].filter(Boolean)));
  const visibleCatalogPresets = allBotPresets
    .filter((preset) => !starterPresetKeys.has(preset.id) && !starterPresetKeys.has(preset.botSlug))
    .slice(0, 24);
  const selectPreset = useCallback((preset: StudioStarterPreset) => {
    onSelectPreset(preset);
    setSelectorOpen(false);
  }, [onSelectPreset]);

  return (
    <section
      data-testid="bot-selection-panel"
      className="shrink-0 overflow-hidden border-b border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 px-3 py-3"
      aria-label="Dreamy bot selection"
    >
      <div className="flex shrink-0 items-center justify-between gap-2">
        <button
          type="button"
          data-testid="agent-selector-toggle"
          aria-expanded={selectorOpen}
          onClick={() => setSelectorOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2 px-2.5 py-2 text-left active:bg-Cr-beta-white-8-v2"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md-v2 bg-Cr-beta-white-8-v2">
            {selectedStarterPreset?.visualUrl ? (
              <img src={selectedStarterPreset.visualUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <Bot size={15} className="text-dreamy-brand-hot-v2" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold text-Cr-text-default-v2">
              {selectedStarterPreset?.title || 'Choose Dreamy agent'}
            </span>
            <span className="block truncate text-[11px] text-Cr-text-subtler-v2">
              {selectedStarterPreset?.botSlug || `${selectableBotCount} agents available`}
            </span>
          </span>
          <ChevronDown
            size={15}
            className={`shrink-0 text-Cr-text-subtler-v2 transition-transform ${selectorOpen ? 'rotate-180' : ''}`}
          />
        </button>
        <div data-testid="dreamy-bot-selection-state" className="flex min-w-0 shrink-0 items-center gap-1.5">
          <button
            type="button"
            data-testid="all-bots-modal-open"
            onClick={() => setAllBotPickerOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md-v2 border border-dreamy-brand-hot-v2/55 bg-dreamy-brand-hot-v2/10 px-2.5 text-[11px] font-semibold text-dreamy-brand-hot-v2 active:bg-dreamy-brand-hot-v2/20"
            aria-haspopup="dialog"
            aria-expanded={allBotPickerOpen}
          >
            <Bot size={13} />
            All bots
          </button>
          <span className="hidden sm:inline-flex">
            <Pill tone="hot">{`${selectableBotCount} options`}</Pill>
          </span>
          {selectedStarterPreset && <Pill>{selectedStarterPreset.botSlug}</Pill>}
          {selectedStarterPreset && (
            <>
              <span data-testid="starter-preset-selection" className="sr-only">
                {selectedStarterPreset.title}
              </span>
              <span data-testid="selected-dreamy-bot-preview" className="sr-only">
                Prompt will call this bot and append the result to the timeline.
              </span>
              <button
                type="button"
                data-testid="starter-preset-direct-generate"
                disabled={submitting}
                onClick={() => onRunPreset?.(selectedStarterPreset)}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md-v2 bg-dreamy-brand-hot-v2 px-2.5 text-[11px] font-semibold text-white disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
              >
                <Clapperboard size={12} />
                Run
              </button>
              <span data-testid="starter-preset-result-visible" className="sr-only">
                Selected bot result visible
              </span>
            </>
          )}
        </div>
      </div>

      <div
        data-testid="bot-selection-scroll-region"
        className={`mt-3 space-y-2 overflow-y-auto overscroll-contain pr-1 transition-[max-height,opacity] duration-200 [-webkit-overflow-scrolling:touch] ${
          selectorOpen ? 'max-h-[min(48dvh,520px)] opacity-100' : 'max-h-0 opacity-0'
        }`}
        aria-hidden={!selectorOpen}
      >
        {!!starterPresets.length && (
          <div data-testid="starter-presets" className="grid gap-2">
            <div className="flex items-center justify-between gap-2 text-[11px] font-semibold uppercase text-Cr-text-subtlest-v2">
              <span className="inline-flex min-w-0 items-center gap-2">
                <Sparkles size={13} className="text-dreamy-brand-hot-v2" />
                <span className="truncate">Verified workshop bots</span>
              </span>
              <Pill>{`${starterPresets.length} verified`}</Pill>
            </div>
            <div data-testid="all-bot-previews" className="grid gap-2">
              <div
                data-testid="starter-visual-recommendations"
                className="grid gap-2"
              >
                {starterPresets.map((preset) => (
                  <BotPresetCard
                    key={preset.id}
                    preset={preset}
                    selected={activeStarterPresetId === preset.id}
                    submitting={submitting}
                    onSelect={selectPreset}
                  />
                ))}
              </div>
            </div>
            <div data-testid="dreamy-bot-list-only" className="sr-only">Dreamy-only bot list</div>
          </div>
        )}

        {!!visibleCatalogPresets.length && (
          <div data-testid="dreamy-catalog-presets" className="grid gap-2">
            <div className="flex items-center justify-between gap-2 text-[11px] font-semibold uppercase text-Cr-text-subtlest-v2">
              <span className="inline-flex min-w-0 items-center gap-2">
                <Layers3 size={13} className="text-dreamy-brand-hot-v2" />
                <span className="truncate">Dreamy catalog bots</span>
              </span>
              <button
                type="button"
                onClick={() => setAllBotPickerOpen(true)}
                className="inline-flex h-7 items-center gap-1.5 rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-subtle-v2 px-2 text-[11px] font-semibold text-Cr-text-subtle-v2 active:bg-Cr-beta-white-8-v2"
              >
                <ExternalLink size={12} />
                {`${selectableBotCount} total`}
              </button>
            </div>
            <div className="grid gap-2">
              {visibleCatalogPresets.map((preset) => (
                <BotPresetCard
                  key={`catalog-${preset.id}`}
                  preset={preset}
                  selected={activeStarterPresetId === preset.id}
                  submitting={submitting}
                  onSelect={selectPreset}
                />
              ))}
            </div>
          </div>
        )}

        <details data-testid="manual-bot-id-panel" className="group rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2 p-2">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 marker:hidden">
            <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold uppercase text-Cr-text-subtlest-v2">
              <SlidersHorizontal size={13} className="shrink-0 text-Cr-text-subtler-v2" />
              <span className="truncate">Advanced manual bot ids</span>
            </div>
            <Pill tone={manualBotEntries.length ? 'hot' : 'default'}>{`${manualBotEntries.length} queued`}</Pill>
          </summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_116px]">
            <textarea
              data-testid="manual-bot-id-input"
              value={manualBotIdsText}
              disabled={submitting}
              onChange={(event) => onManualBotIdsChange(event.target.value)}
              rows={2}
              className="min-h-10 resize-none rounded-md-v2 border border-Cr-border-default-v2 bg-Cr-beta-white-5-v2 px-2 py-1.5 text-xs leading-5 text-Cr-text-default-v2 outline-none placeholder:text-Cr-text-subtlest-v2 disabled:opacity-50"
              placeholder="botId or botId|name|type|slug|articleId"
            />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-1">
              <button
                type="button"
                data-testid="manual-bot-run-selected"
                disabled={submitting || !manualBotEntries.length}
                onClick={() => {
                  const selected = manualBotEntries.find((entry) => entry.id === selectedManualBotEntryId) || manualBotEntries[0];
                  if (selected) onRunManualBot(selected);
                }}
                className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md-v2 bg-Cr-beta-white-8-v2 px-2 text-[11px] font-semibold text-Cr-text-default-v2 disabled:opacity-40"
              >
                <Clapperboard size={12} className="shrink-0" />
                Selected
              </button>
              <button
                type="button"
                data-testid="manual-bot-run-sequence"
                disabled={submitting || manualBotEntries.length < 2}
                onClick={onRunManualBotSequence}
                className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md-v2 bg-dreamy-brand-hot-v2 px-2 text-[11px] font-semibold text-white disabled:bg-Cr-Bg-surface-subtle-v2 disabled:text-Cr-text-subtlest-v2"
              >
                <GitBranch size={12} className="shrink-0" />
                Sequence
              </button>
            </div>
          </div>
          {!!manualBotEntries.length && (
            <div data-testid="manual-bot-sequence-list" className="mt-2 flex gap-1.5 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
              {manualBotEntries.map((entry, index) => (
                <button
                  key={entry.id}
                  type="button"
                  disabled={submitting}
                  aria-pressed={selectedManualBotEntryId === entry.id}
                  onClick={() => onSelectManualBot(entry)}
                  className={`min-w-[118px] rounded-md-v2 border px-2 py-1.5 text-left disabled:opacity-50 ${
                    selectedManualBotEntryId === entry.id
                      ? 'border-dreamy-brand-hot-v2 bg-dreamy-brand-hot-v2/10'
                      : 'border-Cr-border-default-v2 bg-Cr-beta-white-5-v2'
                  }`}
                >
                  <span className="block truncate text-[11px] font-semibold text-Cr-text-default-v2">{entry.botName}</span>
                  <span className="block truncate text-[10px] text-Cr-text-subtlest-v2">{`${index + 1}. ${entry.botId || entry.botSlug}`}</span>
                </button>
              ))}
            </div>
          )}
        </details>
      </div>

      {allBotPickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="All selectable Dreamy bots"
        >
          <button
            type="button"
            className="absolute inset-0"
            aria-label="Close all bot picker"
            onClick={() => setAllBotPickerOpen(false)}
          />
          <section className="relative z-10 flex h-[min(760px,86dvh)] w-full max-w-[1120px] flex-col overflow-hidden rounded-xl-v2 border border-white/10 bg-[#0f1016] shadow-2xl">
            <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-Cr-text-default-v2">
                  <Bot size={15} className="text-dreamy-brand-hot-v2" />
                  All selectable bots
                </div>
                <div className="truncate text-[11px] text-Cr-text-subtler-v2">
                  Pick any available Dreamy bot; it becomes the active bot for the prompt and timeline.
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Pill tone="hot">{`${selectableBotCount} bots`}</Pill>
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
                {(allBotPresets.length ? allBotPresets : starterPresets).map((preset) => (
                  <BotPresetCard
                    key={`modal-${preset.id}`}
                    preset={preset}
                    selected={activeStarterPresetId === preset.id}
                    submitting={submitting}
                    variant="modal"
                    onSelect={(nextPreset) => {
                      selectPreset(nextPreset);
                      setAllBotPickerOpen(false);
                    }}
                  />
                ))}
              </div>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
