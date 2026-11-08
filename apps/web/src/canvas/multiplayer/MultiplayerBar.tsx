// The people bar of 多人同屏 in the canvas header (docs/awwo-canvas-live-collaboration.md, The canvas page): who is on
// the canvas, people and Agents, each in their colour; a click opens the 同屏 panel. Controlled: it shows what it is
// given and talks to no server. Also the avatar and the colour rules the panel and the board share.
import { memo, type CSSProperties } from 'react';
import { Bot } from 'lucide-react';
import type { UiLocale } from '../../locale';
import { shownChatModelName, type ModelNameSources } from '../modelNames';
import type { LiveParticipant } from './types';
import { mt, participantInitials, portLabel, useMultiplayerText } from './multiplayerText';
import './multiplayer.css';

/** A participant without a usable colour (the server always sends '#rrggbb'). */
export const NEUTRAL_COLOR = '#7c8c9c';
const DARK_LABEL = '#0b1220';
const LIGHT_LABEL = '#ffffff';
const NO_MODEL_NAMES: ModelNameSources = {};

/** Whether a value is a colour as the server sends one, '#rrggbb'. */
export function isParticipantColor(color: unknown): color is string {
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);
}

/** The colour as '#rrggbb', or the neutral one: nothing else reaches a style. */
export function safeColor(color: string | undefined): string {
  return isParticipantColor(color) ? color.toLowerCase() : NEUTRAL_COLOR;
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** The label colour on a participant's colour: dark ink or white, whichever contrasts more (WCAG's ratio). A colour
 *  in the middle, where neither reaches 4.5:1, takes black, which always does. */
export function labelColorFor(color: string | undefined): string {
  const fill = luminance(safeColor(color));
  const onDark = (fill + 0.05) / (luminance(DARK_LABEL) + 0.05);
  const onLight = 1.05 / (fill + 0.05);
  if (Math.max(onDark, onLight) < 4.5) return '#000000';
  return onDark >= onLight ? DARK_LABEL : LIGHT_LABEL;
}

/** The custom properties a participant's colour gives an element: --mp-color and the label colour on it, --mp-ink. */
export function participantColorStyle(color: string | undefined): CSSProperties {
  const fill = safeColor(color);
  return { '--mp-color': fill, '--mp-ink': labelColorFor(fill) } as CSSProperties;
}

/** A participant's name as everyone sees it, with 「（你）」 for this page's own. A running AwwO Agent is named after its
 *  node, so one on an untitled node is the AwwO Agent. */
export function participantName(locale: UiLocale, participant: { name: string; kind?: string }, self: boolean): string {
  const name = (typeof participant.name === 'string' ? participant.name.trim() : '') || mt(locale, participant.kind === 'awwo' ? 'kind.awwo' : 'someone');
  return self ? mt(locale, 'self.name', { name }) : name;
}

/** A running AwwO Agent's model as the node's model picker names it (modelNames.ts shownChatModelName): by the name the
 *  workspace's catalogue publishes for it, else by a name read from its selector, never by the selector, which can name
 *  the service AwwO reaches the model through (`bedrock.claude-opus-5-5` is Claude Opus 5.5); a media model not at all,
 *  since even a generic name says nothing a person needs in one line, and its id names the service that makes it
 *  (AWWO-LAW-018); a team connection's selector is no name. The same in either language. */
export function awwoModelName(_locale: UiLocale, model: string | undefined, sources: ModelNameSources = NO_MODEL_NAMES): string {
  return shownChatModelName(model, sources);
}

/** What a participant is doing, in one line: an Agent's own status, as it wrote it; a running AwwO Agent's run, queued or
 *  running (the server sends that word as its status), with its node's model where it has a name. */
export function participantStatus(locale: UiLocale, participant: LiveParticipant, modelNames: ModelNameSources = NO_MODEL_NAMES): string {
  if (participant.kind === 'awwo') {
    const state = mt(locale, participant.state?.status === 'queued' ? 'awwo.queued' : 'awwo.running');
    const model = awwoModelName(locale, participant.model, modelNames);
    return model ? mt(locale, 'awwo.withModel', { state, model }) : state;
  }
  const status = participant.state?.status;
  return typeof status === 'string' ? status.trim() : '';
}

/** "name · port · status line", for a tooltip. */
export function participantTitle(locale: UiLocale, participant: LiveParticipant, self: boolean, modelNames: ModelNameSources = NO_MODEL_NAMES): string {
  const name = participantName(locale, participant, self);
  const port = portLabel(locale, participant.port);
  const status = participantStatus(locale, participant, modelNames);
  return status ? mt(locale, 'avatar.titleStatus', { name, port, status }) : mt(locale, 'avatar.title', { name, port });
}

/** A participant's circle: their initials on their colour, an Agent mark for an Agent (a token's or AwwO's own). */
export const ParticipantAvatar = memo(function ParticipantAvatar({ participant, self = false, title, size = 'md' }: {
  participant: LiveParticipant; self?: boolean; title?: string; size?: 'sm' | 'md';
}) {
  return <span className={`awwo-multiplayer-avatar awwo-multiplayer-avatar--${size}`} data-participant={participant.id} data-kind={participant.kind}
    data-self={self || undefined} title={title} style={participantColorStyle(participant.color)}>
    <span className="awwo-multiplayer-initials" aria-hidden="true">{participantInitials(participant.name)}</span>
    {participant.kind !== 'human' && <span className="awwo-multiplayer-agent-mark" aria-hidden="true"><Bot size={size === 'sm' ? 8 : 10} strokeWidth={2.4} /></span>}
  </span>;
});

/** At most this many avatars; the rest is a "+N". */
export const BAR_AVATARS = 5;

/** This page's own presence first, then everyone else as given. */
export function selfFirst(participants: readonly LiveParticipant[], selfId: string): LiveParticipant[] {
  const self = participants.filter(participant => participant.id === selfId).slice(0, 1);
  return [...self, ...participants.filter(participant => participant.id !== selfId)];
}

export type MultiplayerStatus = 'live' | 'connecting' | 'offline';

export interface MultiplayerBarProps {
  participants: readonly LiveParticipant[];
  /** This page's participant id (its client id). */
  selfId: string;
  /** The live stream: open, opening, or closed. */
  status: MultiplayerStatus;
  onOpen: () => void;
  /** The 同屏 panel is open now (the button's aria-expanded). */
  open?: boolean;
  /** What names a running AwwO Agent's model: the workspace's models (absent, a chat model goes by a name read from its
   *  selector). */
  modelNames?: ModelNameSources;
}

/** How many are on the canvas: a page with its stream open is one of them even before the server lists it. */
export function hereCount(participants: readonly LiveParticipant[], selfId: string): number {
  return participants.some(participant => participant.id === selfId) ? participants.length : participants.length + 1;
}

/** The canvas header's avatar stack, which opens the 同屏 panel. */
export const MultiplayerBar = memo(function MultiplayerBar({ participants, selfId, status, onOpen, open, modelNames = NO_MODEL_NAMES }: MultiplayerBarProps) {
  const { locale, t } = useMultiplayerText();
  const ordered = selfFirst(participants, selfId);
  const shown = ordered.slice(0, BAR_AVATARS);
  const more = ordered.length - shown.length;
  const label = status === 'live' ? t('bar.live', { count: hereCount(participants, selfId) }) : t(status === 'connecting' ? 'bar.connecting' : 'bar.offline');
  // The button shows a dot and avatars only: its name (同屏 · N 人在线) is its tooltip too, so a person the treg advice
  // sends to 「同屏」 can confirm it on hover.
  return <button type="button" className="awwo-multiplayer-bar" data-status={status} aria-label={label} title={label} aria-haspopup="dialog"
    aria-expanded={open === undefined ? undefined : open} onClick={onOpen}>
    <span className="awwo-multiplayer-dot" data-status={status} aria-hidden="true"
      title={t(status === 'live' ? 'status.live' : status === 'connecting' ? 'status.connecting' : 'status.offline')} />
    <span className="awwo-multiplayer-stack">
      {shown.map(participant => <ParticipantAvatar key={participant.id} participant={participant} self={participant.id === selfId}
        title={participantTitle(locale, participant, participant.id === selfId, modelNames)} />)}
      {more > 0 && <span className="awwo-multiplayer-more" title={t('bar.more', { count: more })}>{t('more.count', { count: more })}</span>}
    </span>
  </button>;
});
