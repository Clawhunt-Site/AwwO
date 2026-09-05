import { useEffect, useRef } from 'react';
import { Clapperboard, Loader2, Maximize2, RefreshCcw, Wand2 } from 'lucide-react';
import type { StudioAction, StudioProgressEvent, StudioSegment } from '../api';
import type { ChatItem } from '../model/dreamyWorkspace';
import { Pill } from './studioStatus';

export function ThinkingSteps({ steps = [] }: { steps?: StudioProgressEvent[] }) {
  if (!steps.length) return null;
  return (
    <div className="mt-3 space-y-2">
      {steps.map((step, index) => (
        <div key={`${step.step}_${index}`} className="rounded-lg-v2 border border-Cr-border-default-v2 bg-Cr-beta-white-3-v2 p-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] font-semibold uppercase text-Cr-text-subtler-v2">{step.step}</div>
            {typeof step.progress === 'number' && (
              <div className="text-[11px] font-semibold text-dreamy-brand-hot-v2">{step.progress}%</div>
            )}
          </div>
          <div className="mt-1 text-xs leading-5 text-Cr-text-subtle-v2">{step.message}</div>
          {typeof step.progress === 'number' && (
            <div className="mt-2 h-1 overflow-hidden rounded-full-v2 bg-Cr-beta-white-8-v2">
              <div className="h-full rounded-full-v2 bg-dreamy-brand-hot-v2" style={{ width: `${step.progress}%` }} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ChatMessage({
  item,
  onAction,
  selectedSegment,
  submitting,
}: {
  item: ChatItem;
  selectedSegment?: StudioSegment | null;
  submitting: boolean;
  onAction: (action: StudioAction, prompt?: string, source?: StudioSegment | null) => void;
}) {
  const isUser = item.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[92%] rounded-xl-v2 px-3 py-3 ${
          isUser
            ? 'bg-dreamy-brand-hot-v2 text-white'
            : 'border border-Cr-border-default-v2 bg-Cr-Bg-surface-default-v2 text-Cr-text-default-v2'
        }`}
      >
        {!isUser && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Pill tone={item.pending ? 'hot' : item.error ? 'danger' : 'default'}>
              {item.pending ? 'Routing' : item.error ? 'Needs review' : 'Dreamy Studio'}
            </Pill>
            {item.route && <Pill>{item.route.bot.name}</Pill>}
          </div>
        )}
        <div className="text-sm leading-5">{item.content}</div>
        {item.route && (
          <div className="mt-2 rounded-lg-v2 bg-Cr-beta-white-3-v2 p-2 text-xs leading-5 text-Cr-text-subtler-v2">
            <div className="font-semibold text-Cr-text-subtle-v2">{item.route.analysis}</div>
            {item.route.page && (
              <div className="text-Cr-text-subtle-v2">
                {item.route.page.name}
                {item.route.navigationPath ? ` · ${item.route.navigationPath}` : ''}
              </div>
            )}
            <div>{item.route.reason}</div>
          </div>
        )}
        <ThinkingSteps steps={item.steps} />
        {item.pending && (
          <div className="mt-3 inline-flex items-center gap-2 text-xs text-Cr-text-subtler-v2">
            <Loader2 size={13} className="animate-spin" />
            Working on the next segment
          </div>
        )}
        {item.error && (
          <div className="mt-3 rounded-lg-v2 border border-Cr-border-critical-v2 bg-Cr-Bg-critical-default-v2 p-2 text-xs leading-5 text-Cr-text-critical-bolder-v2">
            {item.error}
          </div>
        )}
        {!isUser && item.segmentId && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={() => onAction('extend', 'Extend this into the next shot', selectedSegment)}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg-v2 bg-Cr-beta-white-8-v2 px-2 text-xs font-semibold text-Cr-text-default-v2 disabled:opacity-40"
            >
              <Clapperboard size={14} />
              Extend
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => onAction('restyle', 'Restyle this segment with stronger cinematic lighting', selectedSegment)}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg-v2 bg-Cr-beta-white-8-v2 px-2 text-xs font-semibold text-Cr-text-default-v2 disabled:opacity-40"
            >
              <Wand2 size={14} />
              Restyle
            </button>
            <button
              type="button"
              disabled={!selectedSegment}
              onClick={() => selectedSegment && onAction('generate', `Use segment ${selectedSegment.id} as the next source`, selectedSegment)}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg-v2 bg-Cr-beta-white-5-v2 px-2 text-xs font-semibold text-Cr-text-subtle-v2 disabled:opacity-40"
            >
              <Maximize2 size={14} />
              Use source
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => onAction('retry-agent', 'Try another agent for this result', selectedSegment)}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg-v2 bg-Cr-beta-white-5-v2 px-2 text-xs font-semibold text-Cr-text-subtle-v2 disabled:opacity-40"
            >
              <RefreshCcw size={14} />
              Agent
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatThreadPanel({
  messages,
  selectedSegment,
  submitting,
  onAction,
}: {
  messages: ChatItem[];
  selectedSegment?: StudioSegment | null;
  submitting: boolean;
  onAction: (action: StudioAction, prompt?: string, source?: StudioSegment | null) => void;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, submitting]);

  return (
    <div
      data-testid="studio-chat-log"
      className="min-h-0 flex-1 overflow-y-auto bg-Cr-Bg-soft-v2 p-3 [-webkit-overflow-scrolling:touch]"
      aria-label="Dreamy chat conversation"
    >
      <div className="grid min-h-full content-end gap-3">
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            item={message}
            selectedSegment={selectedSegment}
            submitting={submitting}
            onAction={onAction}
          />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
