// The 同屏 panel of 多人同屏 (docs/awwo-canvas-live-collaboration.md, The canvas page): who is here (people, Agents and
// AwwO's running Agents, each with their port, status and what they have selected), the claims, the live messages and
// a box to write one, the latest changes, and 邀请 Agent. Controlled: it shows what it is given and hands every action
// to its callbacks; it talks to no server. Closed, it renders nothing, and the state it held (a draft, a token just
// made) goes with it. It takes the keyboard's focus as it opens and gives it back as it closes, to what had it then.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Bot, X } from 'lucide-react';
import type { ModelNameSources } from '../modelNames';
import type { LiveClaim, LiveMessage, LiveParticipant } from './types';
import type { ActivityItem } from './activity';
import { AgentInvite, type AgentInviteProps } from './AgentInvite';
import { hereCount, isParticipantColor, ParticipantAvatar, participantColorStyle, participantName, participantStatus, selfFirst, type MultiplayerStatus } from './MultiplayerBar';
import { clockTime, failureDetail, kindLabel, portLabel, shownTitle, timeLeft, useMultiplayerText } from './multiplayerText';
import { useEnterToSend } from '../composerKeys';
import './multiplayer.css';

/** The longest live message the server takes. */
export const MESSAGE_MAX = 2000;
/** The panel lists at most this many of the latest changes. */
const ACTIVITY_SHOWN = 30;
/** A selection shows at most this many of its nodes by name. */
const SELECTION_SHOWN = 3;
const NO_MODEL_NAMES: ModelNameSources = {};

/** A live message as the server sends it (canvas_live.go): the wire format's fields and its author's colour. The server
 *  names a person's message by their account ('u_' + user id), an agent's by its token ('t_' + token id). */
export type PanelMessage = LiveMessage & { color?: string };

export interface MultiplayerPanelProps {
  open: boolean;
  onClose: () => void;
  participants: readonly LiveParticipant[];
  /** This page's participant id (its client id). */
  selfId: string;
  claims: readonly LiveClaim[];
  /** In any order: the panel shows the newest at the bottom. */
  messages: readonly PanelMessage[];
  /** One line per change (activity.ts), in any order: the panel shows the newest first. */
  activity: readonly ActivityItem[];
  /** A member or above: may write messages (a reader only watches). */
  canWrite: boolean;
  /** May make canvas agent tokens: the 邀请 Agent section is shown. */
  canInvite: boolean;
  /** A node's title as the canvas holds it now; undefined for a node it does not hold. */
  nodeTitle: (id: string) => string | undefined;
  /** Shows a node on the board (selects it, with the camera on it). */
  onFocusNode: (id: string) => void;
  /** Sends a message, about a node when one is given; a refusal is shown and the text kept. */
  onSend: (text: string, nodeId?: string) => Promise<void>;
  /** Lets go of this page's own claims on these nodes. */
  onRelease: (nodeIds: string[]) => Promise<void>;
  /** 邀请 Agent's list and actions. Who may revoke which token is told by this page's own participant (its account and
   *  role) unless `viewer` is given. */
  invite: AgentInviteProps;
  /** The node a new message is about unless its writer takes it off: the one node selected now. */
  messageNodeId?: string | null;
  /** The live stream's state; a stream not live is said under the header. */
  status?: MultiplayerStatus;
  /** The clock claims count down by (ms since the epoch); absent, the panel ticks its own each second. */
  now?: number;
  /** What names a running AwwO Agent's model (the workspace's models); absent, a chat model goes by its selector. */
  modelNames?: ModelNameSources;
}

/** The 同屏 panel: closed, nothing. */
export function MultiplayerPanel(props: MultiplayerPanelProps) {
  return props.open ? <PanelBody {...props} /> : null;
}

/** What gets the focus back as the panel closes: what had it as the panel opened, or, where a pressed button takes no
 *  focus (Safari), the header's people bar, which opens the panel. */
function openerOf(active: Element | null): HTMLElement | null {
  if (active instanceof HTMLElement && active !== document.body && active.isConnected) return active;
  return document.querySelector<HTMLElement>('button.awwo-multiplayer-bar');
}

/** Gives the focus back as the panel closes (by Escape, by ✕, or from its caller), to what had it as the panel opened;
 *  but only a focus the panel takes with it: one the reader put somewhere else stays there. A layout effect's cleanup
 *  runs while the panel is still in the page, so whether it holds the focus can still be told. */
function useFocusReturn(panel: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const opener = openerOf(document.activeElement);
    return () => {
      const active = document.activeElement;
      const lost = !active || active === document.body || Boolean(panel.current?.contains(active));
      if (lost && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [panel]);
}

function PanelBody({ onClose, participants, selfId, claims, messages, activity, canWrite, canInvite, nodeTitle, onFocusNode, onSend,
  onRelease, invite, messageNodeId = null, status, now, modelNames = NO_MODEL_NAMES }: MultiplayerPanelProps) {
  const { t } = useMultiplayerText();
  const headingId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // While a token just made is on screen: its 「已保存，关闭」 button (AgentInvite), the one way its secret goes.
  const secretDone = useRef<HTMLButtonElement | null>(null);
  useFocusReturn(panelRef);
  // Opened from the header's button, the panel takes the focus, so the keyboard is where the eyes are.
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, []);
  const byId = useMemo(() => new Map(participants.map(participant => [participant.id, participant])), [participants]);
  const self = byId.get(selfId);
  const viewer = invite.viewer ?? (self?.userId ? { userId: self.userId, role: self.role } : undefined);
  const onSecretShown = (done: HTMLButtonElement | null) => {
    secretDone.current = done;
    invite.onSecretShown?.(done);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // The panel's keys are its own: the board's (Delete removes the selected nodes, Escape lets them go) never see them.
    event.stopPropagation();
    // An Escape that cancels an input method's composition (typing Chinese, say) is the input method's.
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    // Closing the panel drops a token just made, the only copy of its secret: while one is on screen, Escape takes the
    // focus to its 「已保存，关闭」 instead.
    const done = secretDone.current;
    if (done?.isConnected) { event.preventDefault(); done.focus({ preventScroll: true }); return; }
    const target = event.target as HTMLElement;
    // Escape in a box holding a draft only leaves the box; the next one closes the panel.
    if (target instanceof HTMLTextAreaElement && target.value.trim()) { headingRef.current?.focus({ preventScroll: true }); return; }
    onClose();
  };
  const count = hereCount(participants, selfId);
  const live = !status || status === 'live';
  return <aside className="awwo-multiplayer-panel" ref={panelRef} role="dialog" aria-labelledby={headingId} onKeyDown={onKeyDown}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <header className="awwo-multiplayer-panel-head">
      <div className="awwo-multiplayer-panel-heading">
        <h2 id={headingId} ref={headingRef} tabIndex={-1}>{t('panel.title')}</h2>
        <span className="awwo-multiplayer-panel-count" data-status={status ?? 'live'}>
          <span className="awwo-multiplayer-dot" data-status={status ?? 'live'} aria-hidden="true" />{t('panel.count', { count })}
        </span>
      </div>
      <button type="button" className="awwo-multiplayer-close" aria-label={t('panel.close')} title={t('panel.close')} onClick={onClose}>
        <X size={16} aria-hidden="true" />
      </button>
    </header>
    {!live && <p className="awwo-multiplayer-panel-status" role="status">{t(status === 'connecting' ? 'status.connecting' : 'status.offline')}</p>}
    <div className="awwo-multiplayer-panel-body">
      <Participants participants={participants} selfId={selfId} canInvite={canInvite} live={live} nodeTitle={nodeTitle} onFocusNode={onFocusNode}
        modelNames={modelNames} />
      <Claims claims={claims} selfId={selfId} byId={byId} nodeTitle={nodeTitle} onFocusNode={onFocusNode} onRelease={onRelease} now={now} />
      <Messages messages={messages} participants={participants} self={self} canWrite={canWrite} nodeTitle={nodeTitle} onFocusNode={onFocusNode}
        onSend={onSend} messageNodeId={messageNodeId} />
      <Activity activity={activity} nodeTitle={nodeTitle} onFocusNode={onFocusNode} />
      {canInvite && <AgentInvite {...invite} viewer={viewer} onSecretShown={onSecretShown} />}
    </div>
  </aside>;
}

function Section({ title, className, children }: { title: string; className: string; children: ReactNode }) {
  const id = useId();
  return <section className={`awwo-multiplayer-section ${className}`} aria-labelledby={id}>
    <h3 id={id} className="awwo-multiplayer-section-title">{title}</h3>
    {children}
  </section>;
}

/** A node named by its title: a click shows it on the board. A node the canvas does not hold is named, not linked. */
function NodeChip({ id, nodeTitle, onFocusNode }: { id: string; nodeTitle: (id: string) => string | undefined; onFocusNode: (id: string) => void }) {
  const { locale, t } = useMultiplayerText();
  const title = nodeTitle(id);
  const shown = shownTitle(locale, title);
  if (title === undefined) return <span className="awwo-multiplayer-node-chip is-missing">{shown}</span>;
  return <button type="button" className="awwo-multiplayer-node-chip" title={t('node.show', { node: shown })} onClick={() => onFocusNode(id)}>{shown}</button>;
}

function AgentMark() {
  const { t } = useMultiplayerText();
  return <span className="awwo-multiplayer-inline-mark" role="img" aria-label={t('kind.agent')} title={t('kind.agent')}><Bot size={12} aria-hidden="true" /></span>;
}

/** A name in its owner's colour: coloured only when the colour is one the server gives. */
function Who({ color, agent, children }: { color: string | undefined; agent: boolean; children: ReactNode }) {
  const colored = isParticipantColor(color);
  return <span className="awwo-multiplayer-who" style={participantColorStyle(colored ? color : undefined)} data-colored={colored || undefined}>
    {agent && <AgentMark />}{children}
  </span>;
}

// ── Who is here ──────────────────────────────────────────────────────────────────────────────────────────────────

function Participants({ participants, selfId, canInvite, live, nodeTitle, onFocusNode, modelNames }: {
  participants: readonly LiveParticipant[]; selfId: string; canInvite: boolean; live: boolean;
  nodeTitle: (id: string) => string | undefined; onFocusNode: (id: string) => void; modelNames: ModelNameSources;
}) {
  const { t } = useMultiplayerText();
  const ordered = selfFirst(participants, selfId);
  const groups = [
    { kind: 'human', title: 'section.people', members: ordered.filter(participant => participant.kind === 'human') },
    { kind: 'agent', title: 'section.agents', members: ordered.filter(participant => participant.kind === 'agent') },
    { kind: 'awwo', title: 'section.awwo', members: ordered.filter(participant => participant.kind === 'awwo') },
  ] as const;
  // Said only while connected: offline, the list is the last one the stream sent.
  const alone = live && ordered.every(participant => participant.id === selfId);
  return <>
    {groups.map(group => group.members.length > 0 && <Section key={group.kind} title={t(group.title, { count: group.members.length })} className="awwo-multiplayer-people">
      <ul className="awwo-multiplayer-list">
        {group.members.map(participant => <ParticipantRow key={participant.id} participant={participant} self={participant.id === selfId}
          nodeTitle={nodeTitle} onFocusNode={onFocusNode} modelNames={modelNames} />)}
      </ul>
    </Section>)}
    {alone && <p className="awwo-multiplayer-hint">{t(canInvite ? 'participants.alone' : 'participants.aloneBare')}</p>}
  </>;
}

function ParticipantRow({ participant, self, nodeTitle, onFocusNode, modelNames }: {
  participant: LiveParticipant; self: boolean; nodeTitle: (id: string) => string | undefined; onFocusNode: (id: string) => void;
  modelNames: ModelNameSources;
}) {
  const { locale, t } = useMultiplayerText();
  const status = participantStatus(locale, participant, modelNames);
  const focus = participant.state?.focus ?? null;
  // What they have selected, by the nodes this canvas holds; their focus is said on its own line.
  const selected = (participant.state?.selection ?? []).filter(id => id !== focus && nodeTitle(id) !== undefined);
  const showFocus = !self && focus !== null && nodeTitle(focus) !== undefined;
  const showSelection = !self && selected.length > 0;
  return <li className="awwo-multiplayer-person" data-participant={participant.id} data-self={self || undefined}>
    <ParticipantAvatar participant={participant} self={self} />
    <div className="awwo-multiplayer-person-main">
      <div className="awwo-multiplayer-person-head">
        <span className="awwo-multiplayer-person-name">{participantName(locale, participant, self)}</span>
        <span className="awwo-multiplayer-port" data-port={participant.port} title={kindLabel(locale, participant.kind)}>{portLabel(locale, participant.port)}</span>
        {participant.role === 'reader' && <span className="awwo-multiplayer-reader">{t('role.reader')}</span>}
      </div>
      {status && <p className="awwo-multiplayer-person-status">{status}</p>}
      {showFocus && <p className="awwo-multiplayer-person-nodes">
        <span>{t(participant.kind === 'human' ? 'participant.viewing' : 'participant.working')}</span>
        <NodeChip id={focus} nodeTitle={nodeTitle} onFocusNode={onFocusNode} />
      </p>}
      {showSelection && <p className="awwo-multiplayer-person-nodes">
        <span>{t('participant.selected')}</span>
        {selected.slice(0, SELECTION_SHOWN).map(id => <NodeChip key={id} id={id} nodeTitle={nodeTitle} onFocusNode={onFocusNode} />)}
        {selected.length > SELECTION_SHOWN && <span className="awwo-multiplayer-more-nodes">{t('more.count', { count: selected.length - SELECTION_SHOWN })}</span>}
      </p>}
    </div>
  </li>;
}

// ── Claims ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The given clock, or one ticking each second while something counts down. */
function useClock(ticking: boolean, given: number | undefined): number {
  const [own, setOwn] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking || given !== undefined) return undefined;
    setOwn(Date.now());
    const timer = window.setInterval(() => setOwn(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking, given]);
  return given ?? own;
}

/** Whether a claim still holds at a moment; one whose end does not parse holds until the server says otherwise. */
function holdsAt(claim: LiveClaim, clock: number): boolean {
  const ends = Date.parse(claim.expiresAt);
  return Number.isNaN(ends) || ends > clock;
}

function Claims({ claims, selfId, byId, nodeTitle, onFocusNode, onRelease, now }: {
  claims: readonly LiveClaim[]; selfId: string; byId: ReadonlyMap<string, LiveParticipant>; nodeTitle: (id: string) => string | undefined;
  onFocusNode: (id: string) => void; onRelease: (nodeIds: string[]) => Promise<void>; now: number | undefined;
}) {
  const { locale, t } = useMultiplayerText();
  const clock = useClock(claims.length > 0, now);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState('');
  // The server lists the claims that hold, but tells nobody when one runs out (an agent's write holds a node a minute):
  // one past its end goes from the list here. This page's own first, then by the time each has left.
  const ordered = useMemo(() => claims.filter(claim => holdsAt(claim, clock))
    .sort((a, b) => Number(b.participantId === selfId) - Number(a.participantId === selfId)
      || (Date.parse(a.expiresAt) || 0) - (Date.parse(b.expiresAt) || 0)), [claims, clock, selfId]);
  const mine = ordered.filter(claim => claim.participantId === selfId).map(claim => claim.nodeId);
  const release = async (nodeIds: string[]) => {
    setError('');
    setPending(was => new Set([...was, ...nodeIds]));
    try { await onRelease(nodeIds); }
    catch (failure) { setError(t('claim.releaseFailed', { detail: failureDetail(locale, failure) })); }
    finally { setPending(was => new Set([...was].filter(id => !nodeIds.includes(id)))); }
  };
  return <Section title={t('section.claims', { count: ordered.length })} className="awwo-multiplayer-claims">
    {ordered.length ? <ul className="awwo-multiplayer-list">
      {ordered.map(claim => {
        const holder = byId.get(claim.participantId);
        const own = claim.participantId === selfId;
        const node = shownTitle(locale, nodeTitle(claim.nodeId));
        return <li key={`${claim.nodeId}:${claim.participantId}`} className="awwo-multiplayer-claim-row" data-node={claim.nodeId} data-own={own || undefined}>
          <div className="awwo-multiplayer-claim-head">
            <NodeChip id={claim.nodeId} nodeTitle={nodeTitle} onFocusNode={onFocusNode} />
            <span className="awwo-multiplayer-claim-left">{timeLeft(locale, Date.parse(claim.expiresAt) - clock)}</span>
          </div>
          <div className="awwo-multiplayer-claim-holder">
            <Who color={holder?.color} agent={claim.holderKind === 'agent'}>{participantName(locale, holder ?? claim, own)}</Who>
            {own && <button type="button" className="awwo-multiplayer-small-button" aria-label={t('claim.releaseLabel', { node })}
              disabled={pending.has(claim.nodeId)} onClick={() => { void release([claim.nodeId]); }}>
              {t(pending.has(claim.nodeId) ? 'claim.releasing' : 'claim.release')}
            </button>}
          </div>
          {claim.note && <p className="awwo-multiplayer-claim-note">{claim.note}</p>}
        </li>;
      })}
    </ul> : <p className="awwo-multiplayer-hint">{t('claims.empty')}</p>}
    {mine.length > 1 && <button type="button" className="awwo-multiplayer-small-button" disabled={mine.every(id => pending.has(id))}
      onClick={() => { void release(mine); }}>{t('claim.releaseAll')}</button>}
    {error && <p className="awwo-multiplayer-error" role="alert">{error}</p>}
  </Section>;
}

// ── Messages ─────────────────────────────────────────────────────────────────────────────────────────────────────

const time = (iso: string) => { const at = Date.parse(iso); return Number.isNaN(at) ? 0 : at; };

/** Who wrote a message, among those here, by the name the server gives its author: a person by their account ('u_' +
 *  user id: any page of theirs), an agent by its token ('t_' + token id, its participant id). */
function messageAuthors(participants: readonly LiveParticipant[]): ReadonlyMap<string, LiveParticipant> {
  const authors = new Map<string, LiveParticipant>();
  for (const participant of participants) {
    const key = participant.kind === 'human' ? (participant.userId ? `u_${participant.userId}` : '') : participant.id;
    if (key && !authors.has(key)) authors.set(key, participant);
  }
  return authors;
}

function Messages({ messages, participants, self, canWrite, nodeTitle, onFocusNode, onSend, messageNodeId }: {
  messages: readonly PanelMessage[]; participants: readonly LiveParticipant[]; self: LiveParticipant | undefined; canWrite: boolean;
  nodeTitle: (id: string) => string | undefined; onFocusNode: (id: string) => void;
  onSend: (text: string, nodeId?: string) => Promise<void>; messageNodeId: string | null;
}) {
  const { locale, t } = useMultiplayerText();
  // The oldest first, so the newest is at the bottom, by the box.
  const ordered = useMemo(() => [...messages].sort((a, b) => time(a.createdAt) - time(b.createdAt) || a.id.localeCompare(b.id)), [messages]);
  const authors = useMemo(() => messageAuthors(participants), [participants]);
  // This person's own messages, from this page or another of theirs.
  const ownAuthor = self?.userId ? `u_${self.userId}` : null;
  const logRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // A new message scrolls into view, unless the reader has scrolled up to read older ones.
  const newest = ordered.length ? ordered[ordered.length - 1].id : '';
  useLayoutEffect(() => {
    const log = logRef.current;
    if (log && atBottom.current) log.scrollTop = log.scrollHeight;
  }, [newest]);
  return <Section title={t('section.messages')} className="awwo-multiplayer-messages">
    {ordered.length ? <div className="awwo-multiplayer-message-log" ref={logRef} role="log" aria-label={t('section.messages')} tabIndex={0}
      onScroll={event => { const log = event.currentTarget; atBottom.current = log.scrollHeight - log.scrollTop - log.clientHeight < 24; }}>
      <ol className="awwo-multiplayer-message-list">
        {ordered.map(message => {
          const author = authors.get(message.participantId);
          const own = ownAuthor !== null && message.participantId === ownAuthor;
          // Their colour while they are here; the server sends the same one with every message, so it shows after they left.
          const authorColor = author?.color;
          return <li key={message.id} className="awwo-multiplayer-message" data-own={own || undefined}>
            <div className="awwo-multiplayer-message-head">
              <Who color={isParticipantColor(authorColor) ? authorColor : message.color} agent={message.authorKind === 'agent'}>
                {participantName(locale, author ?? message, own)}
              </Who>
              {message.nodeId && <NodeChip id={message.nodeId} nodeTitle={nodeTitle} onFocusNode={onFocusNode} />}
              <time className="awwo-multiplayer-time" dateTime={message.createdAt}>{clockTime(locale, message.createdAt)}</time>
            </div>
            <p className="awwo-multiplayer-message-text">{message.text}</p>
          </li>;
        })}
      </ol>
    </div> : <p className="awwo-multiplayer-hint">{t('messages.empty')}</p>}
    {canWrite ? <Composer nodeTitle={nodeTitle} onSend={onSend} messageNodeId={messageNodeId} />
      : <p className="awwo-multiplayer-hint">{t('messages.readOnly')}</p>}
  </Section>;
}

function Composer({ nodeTitle, onSend, messageNodeId }: {
  nodeTitle: (id: string) => string | undefined; onSend: (text: string, nodeId?: string) => Promise<void>; messageNodeId: string | null;
}) {
  const { locale, t } = useMultiplayerText();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  // The node its writer took off this message; another selected node attaches again.
  const [detached, setDetached] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const aboutTitle = messageNodeId ? nodeTitle(messageNodeId) : undefined;
  const about = messageNodeId && aboutTitle !== undefined && detached !== messageNodeId ? messageNodeId : null;
  const send = async () => {
    const body = text.trim();
    if (!body || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError('');
    try {
      await (about ? onSend(body, about) : onSend(body));
      setText('');
      setDetached(null);
    } catch (failure) {
      setError(t('messages.failed', { detail: failureDetail(locale, failure) }));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const keys = useEnterToSend(() => { void send(); });
  const submit = (event: FormEvent) => { event.preventDefault(); void send(); };
  const node = about ? shownTitle(locale, aboutTitle) : '';
  return <form className="awwo-multiplayer-composer" onSubmit={submit}>
    {about && <span className="awwo-multiplayer-about">
      <span>{t('messages.about', { node })}</span>
      <button type="button" aria-label={t('messages.detach', { node })} title={t('messages.detach', { node })} onClick={() => setDetached(about)}>
        <X size={12} aria-hidden="true" />
      </button>
    </span>}
    <textarea className="awwo-multiplayer-input" aria-label={t('messages.box')} placeholder={t('messages.placeholder')} rows={2}
      maxLength={MESSAGE_MAX} value={text} onChange={event => setText(event.target.value)} {...keys} />
    <div className="awwo-multiplayer-composer-foot">
      {text.length > MESSAGE_MAX * 0.9 && <span className="awwo-multiplayer-count">{t('messages.count', { count: text.length, max: MESSAGE_MAX })}</span>}
      <button type="submit" className="awwo-multiplayer-primary" disabled={sending || !text.trim()}>{t(sending ? 'messages.sending' : 'messages.send')}</button>
    </div>
    {error && <p className="awwo-multiplayer-error" role="alert">{error}</p>}
  </form>;
}

// ── Recent changes ───────────────────────────────────────────────────────────────────────────────────────────────

function Activity({ activity, nodeTitle, onFocusNode }: {
  activity: readonly ActivityItem[]; nodeTitle: (id: string) => string | undefined; onFocusNode: (id: string) => void;
}) {
  const { locale, t } = useMultiplayerText();
  const shown = useMemo(() => [...activity].sort((a, b) => b.version - a.version).slice(0, ACTIVITY_SHOWN), [activity]);
  return <Section title={t('section.activity')} className="awwo-multiplayer-activity">
    {shown.length ? <ol className="awwo-multiplayer-activity-list">
      {shown.map(item => {
        // The line shows the first of its nodes the canvas still holds.
        const target = item.nodeIds.find(id => nodeTitle(id) !== undefined);
        return <li key={item.version} className="awwo-multiplayer-activity-item" style={participantColorStyle(item.color)} data-colored={item.color ? true : undefined}>
          {target !== undefined
            ? <button type="button" className="awwo-multiplayer-activity-line" title={t('node.show', { node: shownTitle(locale, nodeTitle(target)) })}
              onClick={() => onFocusNode(target)}>{item.text}</button>
            : <span className="awwo-multiplayer-activity-line">{item.text}</span>}
          <time className="awwo-multiplayer-time" dateTime={item.at}>{clockTime(locale, item.at)}</time>
        </li>;
      })}
    </ol> : <p className="awwo-multiplayer-hint">{t('activity.empty')}</p>}
  </Section>;
}
