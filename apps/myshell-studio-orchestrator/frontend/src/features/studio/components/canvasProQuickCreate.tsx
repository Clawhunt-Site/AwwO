import type { Dispatch, Ref, SetStateAction } from 'react';
import {
  FileText,
  Image as ImageIcon,
  Link2,
  Plus,
  Sparkles,
  Video,
  Workflow,
} from 'lucide-react';

import {
  CANVASPRO_ADD_MENU_GROUPS,
  getAddMenuIcon,
  type AddMenuItem,
  type CreateFlowOptions,
  type CreateNodeOptions,
  type QuickCreateCommand,
  type QuickCreateKind,
} from '../model/canvasProWorkspace';

interface CanvasProQuickCreateProps {
  addMenuOpen: boolean;
  bridgeReady: boolean;
  busyAction: string;
  createCanvasFlow: (promptOverride?: string, options?: CreateFlowOptions) => void;
  createCanvasNode: (kind: QuickCreateKind, promptOverride?: string, options?: CreateNodeOptions) => void;
  createCanvasStoryboard: (promptOverride?: string) => void;
  createCanvasVariants: (promptOverride?: string) => void;
  creatingFlow: boolean;
  creatingImage: boolean;
  creatingImageFromSelection: boolean;
  creatingNote: boolean;
  creatingNoteFromSelection: boolean;
  creatingSelectedFlow: boolean;
  creatingStoryboard: boolean;
  creatingVariants: boolean;
  creatingVideo: boolean;
  creatingVideoFromSelection: boolean;
  insertQuickCommand: (command: QuickCreateCommand) => void;
  quickCommandIndex: number;
  quickCommandOpen: boolean;
  quickPrompt: string;
  quickPromptInputRef: Ref<HTMLInputElement>;
  runAddMenuItem: (item: AddMenuItem) => void;
  setAddMenuOpen: Dispatch<SetStateAction<boolean>>;
  setQuickCommandIndex: Dispatch<SetStateAction<number>>;
  setQuickCommandOpen: Dispatch<SetStateAction<boolean>>;
  setQuickPrompt: Dispatch<SetStateAction<string>>;
  submitQuickPrompt: (defaultKind: QuickCreateKind) => void;
  visibleQuickCommands: QuickCreateCommand[];
}

function quickCommandIcon(command: QuickCreateCommand) {
  if (command.action === 'flow') return command.source === 'selected' ? Link2 : Workflow;
  if (command.action === 'storyboard') return Workflow;
  if (command.action === 'variants') return Sparkles;
  if (command.action === 'organize') return Workflow;
  if (command.source === 'selected') return Link2;
  if (command.kind === 'note') return FileText;
  if (command.kind === 'image') return ImageIcon;
  return Video;
}

export function CanvasProQuickCreate({
  addMenuOpen,
  bridgeReady,
  busyAction,
  createCanvasFlow,
  createCanvasNode,
  createCanvasStoryboard,
  createCanvasVariants,
  creatingFlow,
  creatingImage,
  creatingImageFromSelection,
  creatingNote,
  creatingNoteFromSelection,
  creatingSelectedFlow,
  creatingStoryboard,
  creatingVariants,
  creatingVideo,
  creatingVideoFromSelection,
  insertQuickCommand,
  quickCommandIndex,
  quickCommandOpen,
  quickPrompt,
  quickPromptInputRef,
  runAddMenuItem,
  setAddMenuOpen,
  setQuickCommandIndex,
  setQuickCommandOpen,
  setQuickPrompt,
  submitQuickPrompt,
  visibleQuickCommands,
}: CanvasProQuickCreateProps) {
  const disabled = !bridgeReady || Boolean(busyAction);

  return (
    <div
      data-testid="canvaspro-quick-create"
      className="pointer-events-none absolute bottom-4 left-1/2 z-[130] flex w-[min(860px,calc(100vw-48px))] -translate-x-1/2 items-center gap-2 rounded-full-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/92 p-1.5 shadow-[0_14px_38px_rgba(0,0,0,0.34)] backdrop-blur-xl"
    >
      {quickCommandOpen && visibleQuickCommands.length ? (
        <div
          data-testid="canvaspro-slash-command-menu"
          role="listbox"
          className="pointer-events-auto absolute bottom-[58px] left-0 w-[min(360px,calc(100vw-24px))] overflow-hidden rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/96 p-1 shadow-[0_16px_44px_rgba(0,0,0,0.36)] backdrop-blur-xl"
        >
          {visibleQuickCommands.map((command, index) => {
            const Icon = quickCommandIcon(command);
            return (
              <button
                key={command.command}
                data-testid={`canvaspro-slash-command-${command.command}`}
                type="button"
                role="option"
                aria-selected={index === quickCommandIndex}
                title={command.description}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertQuickCommand(command)}
                className={`flex h-11 w-full items-center gap-3 rounded-md-v2 px-3 text-left ${
                  index === quickCommandIndex
                    ? 'bg-Cr-Bg-soft-v2 text-Cr-text-default-v2'
                    : 'text-Cr-text-subtler-v2 active:bg-Cr-beta-white-8-v2'
                }`}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full-v2 border border-Cr-border-default-v2 bg-Cr-Bg-soft-v2">
                  <Icon size={15} />
                </span>
                <span className="min-w-0 flex-1 text-sm font-semibold">{command.label}</span>
                <span className="shrink-0 text-xs font-semibold text-Cr-text-disabled-v2">
                  /{command.command}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {addMenuOpen ? (
        <div
          data-testid="canvaspro-add-menu"
          role="menu"
          className="pointer-events-auto absolute bottom-[58px] left-0 w-[min(392px,calc(100vw-24px))] overflow-hidden rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2/96 p-1 shadow-[0_16px_44px_rgba(0,0,0,0.36)] backdrop-blur-xl"
        >
          {CANVASPRO_ADD_MENU_GROUPS.map((group) => (
            <div key={group.id} data-testid={`canvaspro-add-menu-section-${group.id}`} className="py-1">
              <div className="px-2 pb-1 text-[10px] font-bold uppercase tracking-[0.08em] text-Cr-text-disabled-v2">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = getAddMenuIcon(item.id);
                  return (
                    <button
                      key={item.id}
                      data-testid={`canvaspro-add-menu-${item.id}`}
                      type="button"
                      role="menuitem"
                      onClick={() => runAddMenuItem(item)}
                      disabled={disabled}
                      className="flex h-12 w-full items-center gap-3 rounded-md-v2 px-2.5 text-left text-Cr-text-subtler-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2"
                      title={item.description}
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full-v2 border border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 text-Cr-text-default-v2">
                        <Icon size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-Cr-text-default-v2">
                          {item.label}
                        </span>
                        <span className="block truncate text-xs font-semibold text-Cr-text-disabled-v2">
                          {item.description}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <button
        data-testid="canvaspro-add-menu-trigger"
        type="button"
        onClick={() => {
          setQuickCommandOpen(false);
          setAddMenuOpen((open) => !open);
        }}
        disabled={disabled}
        className={`pointer-events-auto inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full-v2 bg-Cr-Bg-soft-v2 text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2 ${
          addMenuOpen ? 'ring-2 ring-Cr-border-default-v2' : ''
        }`}
        aria-label="Open CanvasPro add node menu"
        aria-expanded={addMenuOpen}
        aria-haspopup="menu"
        title="添加节点"
      >
        <Plus size={17} />
      </button>
      <label className="pointer-events-auto flex min-w-0 flex-1 items-center gap-2 rounded-full-v2 border border-Cr-border-default-v2 bg-Cr-Bg-soft-v2 px-3">
        <Sparkles size={16} className="shrink-0 text-Cr-text-subtler-v2" />
        <input
          ref={quickPromptInputRef}
          data-testid="canvaspro-quick-create-prompt"
          value={quickPrompt}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setQuickPrompt(value);
            const commandInput = value.trimStart().startsWith('/');
            setQuickCommandOpen(commandInput);
            if (commandInput) setAddMenuOpen(false);
          }}
          onFocus={() => {
            if (quickPrompt.trimStart().startsWith('/')) setQuickCommandOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && addMenuOpen) {
              event.preventDefault();
              setAddMenuOpen(false);
              return;
            }
            if (event.key === 'Escape' && quickCommandOpen) {
              event.preventDefault();
              setQuickCommandOpen(false);
              return;
            }
            if (quickCommandOpen && visibleQuickCommands.length > 0 && event.key === 'ArrowDown') {
              event.preventDefault();
              setQuickCommandIndex((index) => (index + 1) % visibleQuickCommands.length);
              return;
            }
            if (quickCommandOpen && visibleQuickCommands.length > 0 && event.key === 'ArrowUp') {
              event.preventDefault();
              setQuickCommandIndex(
                (index) => (index - 1 + visibleQuickCommands.length) % visibleQuickCommands.length,
              );
              return;
            }
            if (quickCommandOpen && visibleQuickCommands.length > 0 && event.key === 'Tab') {
              event.preventDefault();
              insertQuickCommand(visibleQuickCommands[quickCommandIndex] || visibleQuickCommands[0]);
              return;
            }
            if (event.key === 'Enter' && bridgeReady && !busyAction) {
              event.preventDefault();
              submitQuickPrompt(event.shiftKey ? 'video' : 'image');
            }
          }}
          placeholder="描述想生成的画面"
          className="h-9 min-w-0 flex-1 bg-transparent text-sm font-medium text-Cr-text-default-v2 outline-none placeholder:text-Cr-text-disabled-v2"
          aria-label="CanvasPro creation prompt"
        />
      </label>
      <button
        data-testid="canvaspro-create-note"
        type="button"
        onClick={() => createCanvasNode('note')}
        disabled={disabled}
        className={`pointer-events-auto hidden h-10 w-10 shrink-0 items-center justify-center rounded-full-v2 bg-Cr-Bg-soft-v2 text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2 ${
          creatingNote ? 'ring-2 ring-Cr-border-default-v2' : ''
        }`}
        aria-label="Create CanvasPro text reference node"
        aria-busy={creatingNote || undefined}
        title="添加画布文本参考"
      >
        <FileText size={16} />
      </button>
      <button
        data-testid="canvaspro-create-reference-from-selection"
        type="button"
        onClick={() => createCanvasNode('note', quickPrompt, { source: 'selected' })}
        disabled={disabled}
        className={`pointer-events-auto hidden h-10 w-10 shrink-0 items-center justify-center rounded-full-v2 bg-Cr-Bg-soft-v2 text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2 ${
          creatingNoteFromSelection ? 'ring-2 ring-Cr-border-default-v2' : ''
        }`}
        aria-label="Create CanvasPro text reference from selected content"
        aria-busy={creatingNoteFromSelection || undefined}
        title="引用选中画布内容"
      >
        <Link2 size={16} />
      </button>
      <button
        data-testid="canvaspro-create-image"
        type="button"
        onClick={() => createCanvasNode('image')}
        disabled={disabled}
        className={`pointer-events-auto inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full-v2 bg-Cr-Bg-inverse-v2 text-Cr-text-inverse-v2 disabled:opacity-45 active:opacity-80 ${
          creatingImage ? 'ring-2 ring-Cr-border-default-v2' : ''
        }`}
        aria-label="Create CanvasPro image node"
        aria-busy={creatingImage || undefined}
        title="新建图像节点"
      >
        <ImageIcon size={16} />
      </button>
      <button
        data-testid="canvaspro-create-image-from-selection"
        type="button"
        onClick={() => createCanvasNode('image', quickPrompt, { source: 'selected' })}
        disabled={disabled}
        className={`pointer-events-auto hidden h-10 w-10 shrink-0 items-center justify-center rounded-full-v2 bg-Cr-Bg-soft-v2 text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2 ${
          creatingImageFromSelection ? 'ring-2 ring-Cr-border-default-v2' : ''
        }`}
        aria-label="Create CanvasPro image node from selected asset"
        aria-busy={creatingImageFromSelection || undefined}
        title="从选中素材参考生图"
      >
        <Link2 size={16} />
      </button>
      <button
        data-testid="canvaspro-create-video"
        type="button"
        onClick={() => createCanvasNode('video')}
        disabled={disabled}
        className={`pointer-events-auto inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full-v2 bg-Cr-Bg-soft-v2 text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2 ${
          creatingVideo ? 'ring-2 ring-Cr-border-default-v2' : ''
        }`}
        aria-label="Create CanvasPro video node"
        aria-busy={creatingVideo || undefined}
        title="新建视频节点"
      >
        <Video size={16} />
      </button>
      <button
        data-testid="canvaspro-create-video-from-selection"
        type="button"
        onClick={() => createCanvasNode('video', quickPrompt, { source: 'selected' })}
        disabled={disabled}
        className={`pointer-events-auto hidden h-10 w-10 shrink-0 items-center justify-center rounded-full-v2 bg-Cr-Bg-soft-v2 text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2 ${
          creatingVideoFromSelection ? 'ring-2 ring-Cr-border-default-v2' : ''
        }`}
        aria-label="Create CanvasPro video node from selected asset"
        aria-busy={creatingVideoFromSelection || undefined}
        title="从选中素材新建视频节点"
      >
        <Link2 size={16} />
      </button>
      <button
        data-testid="canvaspro-create-flow"
        type="button"
        onClick={() => createCanvasFlow()}
        disabled={disabled}
        className={`pointer-events-auto inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full-v2 bg-Cr-Bg-soft-v2 text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2 ${
          creatingFlow ? 'ring-2 ring-Cr-border-default-v2' : ''
        }`}
        aria-label="Create CanvasPro image-to-video workflow"
        aria-busy={creatingFlow || undefined}
        title="新建图片到视频创作流"
      >
        <Workflow size={16} />
      </button>
      <button
        data-testid="canvaspro-create-storyboard"
        type="button"
        onClick={() => createCanvasStoryboard()}
        disabled={disabled}
        className={`pointer-events-auto hidden h-10 w-10 shrink-0 items-center justify-center rounded-full-v2 bg-Cr-Bg-soft-v2 text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2 ${
          creatingStoryboard ? 'ring-2 ring-Cr-border-default-v2' : ''
        }`}
        aria-label="Create CanvasPro storyboard workflow"
        aria-busy={creatingStoryboard || undefined}
        title="新建多镜头分镜创作流"
      >
        <Workflow size={16} />
      </button>
      <button
        data-testid="canvaspro-create-variants-from-selection"
        type="button"
        onClick={() => createCanvasVariants()}
        disabled={disabled}
        className={`pointer-events-auto hidden h-10 w-10 shrink-0 items-center justify-center rounded-full-v2 bg-Cr-Bg-soft-v2 text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2 ${
          creatingVariants ? 'ring-2 ring-Cr-border-default-v2' : ''
        }`}
        aria-label="Create CanvasPro variants from selected asset"
        aria-busy={creatingVariants || undefined}
        title="从选中素材生成版本变体"
      >
        <Sparkles size={16} />
      </button>
      <button
        data-testid="canvaspro-create-flow-from-selection"
        type="button"
        onClick={() => createCanvasFlow(quickPrompt, { source: 'selected' })}
        disabled={disabled}
        className={`pointer-events-auto hidden h-10 w-10 shrink-0 items-center justify-center rounded-full-v2 bg-Cr-Bg-soft-v2 text-Cr-text-default-v2 disabled:opacity-45 active:bg-Cr-beta-white-8-v2 ${
          creatingSelectedFlow ? 'ring-2 ring-Cr-border-default-v2' : ''
        }`}
        aria-label="Create CanvasPro workflow from selected asset"
        aria-busy={creatingSelectedFlow || undefined}
        title="从选中素材新建创作流"
      >
        <Link2 size={16} />
      </button>
    </div>
  );
}
