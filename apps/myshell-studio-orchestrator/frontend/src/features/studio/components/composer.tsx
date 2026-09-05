import { Clapperboard, ImagePlus, Link2, Send, X } from 'lucide-react';
import type { StudioMode, StudioSegment } from '../api';
import type { StudioStarterPreset } from '../model/dreamyWorkspace';

export function Composer({
  mode,
  prompt,
  canSubmitWithoutPrompt,
  previewUrl,
  selectedFileName,
  selectedStarterPreset,
  selectedSegment,
  submitting,
  onModeChange,
  onPromptChange,
  onSubmit,
  onPickFile,
  onClearFile,
  onStop,
}: {
  mode: StudioMode;
  prompt: string;
  canSubmitWithoutPrompt?: boolean;
  previewUrl: string;
  selectedFileName?: string;
  selectedStarterPreset?: StudioStarterPreset | null;
  selectedSegment?: StudioSegment | null;
  submitting: boolean;
  onModeChange: (mode: StudioMode) => void;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  onPickFile: () => void;
  onClearFile: () => void;
  onStop: () => void;
}) {
  return (
    <div data-testid="studio-composer" className="dreamy-studio-composer">
      <div className="dreamy-studio-composer-box">
        <textarea
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          rows={3}
          className="dreamy-studio-field"
          placeholder="Describe the next shot you want to create..."
        />
        <div className="dreamy-studio-composer-row">
          <button
            type="button"
            onClick={onPickFile}
            className="dreamy-studio-ghost-pill"
          >
            <ImagePlus size={14} />
            Image
          </button>
          <button
            type="button"
            onClick={onPickFile}
            className="dreamy-studio-ghost-pill"
          >
            <Clapperboard size={14} />
            Video
          </button>
          <button
            type="button"
            onClick={onPickFile}
            className="dreamy-studio-ghost-pill"
          >
            <Link2 size={14} />
            Reference
          </button>
          {previewUrl && (
            <div className="flex min-w-0 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] p-1 pr-2">
              <img src={previewUrl} alt="" className="h-7 w-7 rounded-md-v2 object-contain" />
              <span className="max-w-[120px] truncate text-[11px] text-Cr-text-subtler-v2">{selectedFileName}</span>
              <button type="button" onClick={onClearFile} aria-label="Remove image">
                <X size={14} />
              </button>
            </div>
          )}
          <span className="dreamy-studio-spacer" />
          {submitting ? (
            <button
              type="button"
              onClick={onStop}
              className="dreamy-studio-ghost-pill"
            >
              <X size={14} />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={onSubmit}
              disabled={!prompt.trim() && !canSubmitWithoutPrompt}
              className="dreamy-studio-send disabled:opacity-40"
              aria-label="Run Dreamy prompt"
            >
              <Send size={18} fill="currentColor" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
