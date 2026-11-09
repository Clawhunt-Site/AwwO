// 邀请 Agent in the 同屏 panel (docs/awwo-canvas-live-collaboration.md, Agents): make a canvas agent token, copy it once
// with the lines that connect Claude Code, Codex, Cursor or a program to this canvas, and see and revoke the canvas's
// tokens. Controlled: the list and both actions are its caller's; it talks to no server.
//
// The secret is shown only right after it is made, and only this section's own state holds it: no storage, no title or
// label carries it, and closing the section (or the panel) drops it. The list names a token by its prefix alone.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Check, ChevronDown, Copy, ExternalLink, Globe, KeyRound, UserPlus } from 'lucide-react';
import type { AgentTokenItem } from './types';
import { failureDetail, shortDate, useMultiplayerText } from './multiplayerText';
import './multiplayer.css';

export type AgentTokenScope = 'edit' | 'read';
/** The canvas's tokens as the caller has read them (GET …/agent-tokens). `error` is what went wrong reading them: the
 *  refusal itself (so its code is told in the reader's language), or words of the caller's own; null when nothing did. */
export interface AgentTokenList { items: readonly AgentTokenItem[]; loading: boolean; error: unknown }
/** A token just made: its secret, shown once, and its listing. */
export interface CreatedAgentToken { token: string; item: AgentTokenItem }
/** Who reads the list: the server lets only a token's maker, or a workspace admin or owner, revoke it. */
export interface AgentInviteViewer { userId: string; role?: string }

export interface AgentInviteProps {
  tokens: AgentTokenList;
  /** POST …/agent-tokens: resolves with the secret and its listing, or rejects with what went wrong. */
  onCreate: (name: string, days: number, scope: AgentTokenScope) => Promise<CreatedAgentToken>;
  /** DELETE …/agent-tokens/{id}. */
  onRevoke: (id: string) => Promise<void>;
  /** AwwO's MCP endpoint, absolute (https://<host>/api/v1/mcp). */
  mcpUrl: string;
  /** The API's base, absolute (https://<host>/api/v1). */
  apiBase: string;
  tenantId: string;
  canvasId: string;
  /** Called as the section opens, to read the canvas's tokens then. */
  onOpen?: () => void;
  /** Open from the start (the panel shows it closed). */
  defaultOpen?: boolean;
  /** The clock a token's expiry is read against (ms since the epoch); absent, the time of the render. */
  now?: number;
  /** Who reads the list: Revoke is offered on the tokens they may revoke. Absent, on every live token (the server decides). */
  viewer?: AgentInviteViewer;
  /** Told the 「已保存，关闭」 button while a token just made is on screen, and null once it is not: closing whatever holds
   *  this section would destroy the only copy of the secret, so a holder keeps a stray key from doing it. */
  onSecretShown?: (done: HTMLButtonElement | null) => void;
  /** The disclosure's name: 邀请 Agent in the 同屏 panel, the advanced option's name in the Share dialog. */
  label?: string;
}

/** The expiries a token can be made with, in days; 30 unless chosen. */
export const TOKEN_DAYS: readonly number[] = [1, 7, 30, 90];
export const DEFAULT_TOKEN_DAYS = 30;
export const DEFAULT_AGENT_NAME = 'Claude Code';
/** The longest name the server keeps for a token. */
export const AGENT_NAME_MAX = 60;

export interface ConnectionSnippets {
  claude: string; claudeUnattended: string; codex: string; codexEnv: string; codexUnattended: string; cursor: string; http: string;
}

/** The lines that connect an agent to this canvas with a token: Claude Code's command, Codex's config and the shell line
 *  that gives it the token, each CLI's unattended run, Cursor's .cursor/mcp.json, and an HTTP read of the canvas's
 *  changes. Both CLIs ask before a server's tools, and a headless run can answer no prompt (checked on 2026-11-07 with
 *  Claude Code 2.1.317, whose `claude -p` without the canvas's tools allowed did not use them, and Codex 0.162.1, whose
 *  `codex exec` answered "MCP tool call requires approval, but approval policy is never"). So the unattended lines allow
 *  the canvas's tools on their own command line, never in a config file: an interactive session still asks, and a config
 *  table pasted before stays as it is (a second [mcp_servers.awwo_canvas] table would break Codex's whole config.toml). */
export function connectionSnippets({ token, mcpUrl, apiBase, tenantId, canvasId }: {
  token: string; mcpUrl: string; apiBase: string; tenantId: string; canvasId: string;
}): ConnectionSnippets {
  const changes = `${apiBase.replace(/\/+$/, '')}/tenants/${encodeURIComponent(tenantId)}/canvases/${encodeURIComponent(canvasId)}/changes?after=0`;
  return {
    claude: `claude mcp add --transport http awwo-canvas ${mcpUrl} --header "Authorization: Bearer ${token}"`,
    // The task before --allowedTools: it takes a list, which would swallow a task put after it.
    claudeUnattended: 'claude -p "<task>" --allowedTools mcp__awwo-canvas',
    // A TOML basic string takes JSON's escapes.
    codex: `[mcp_servers.awwo_canvas]\nurl = ${JSON.stringify(mcpUrl)}\nbearer_token_env_var = "AWWO_CANVAS_TOKEN"`,
    codexEnv: `export AWWO_CANVAS_TOKEN="${token}"`,
    // A canvas task needs no Git repository, and outside one (or a trusted folder) codex exec refuses to start without it.
    codexUnattended: `codex exec --skip-git-repo-check -c 'mcp_servers.awwo_canvas.default_tools_approval_mode="approve"' "<task>"`,
    cursor: JSON.stringify({ mcpServers: { 'awwo-canvas': { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    http: `curl -H "Authorization: Bearer ${token}" "${changes}"`,
  };
}

/** treg (treg.to): the hosted MCP server of Superdesign's third-party catalog of paid tools (web search and page reads,
 *  keywords and backlinks, social trends, company and market data). AwwO only links to the hosted service and shows
 *  lines that carry no credential: it runs none of treg's software (treg's licence keeps hosting it for others to
 *  Superdesign) and never handles a treg sign-in. */
export const TREG_MCP_URL = 'https://treg.to/mcp/';
export const TREG_SITE_URL = 'https://treg.to/';

export interface TregSnippets { claude: string; codex: string; cursor: string }

/** The lines that give the Agent connected here treg's tools too. Checked on 2026-11-07 with Claude Code 2.1.317
 *  (`claude mcp add` keeps the server as "Needs authentication" until /mcp signs in) and Codex 0.162.1 (`codex mcp add
 *  --url` writes [mcp_servers.treg] and starts treg's OAuth sign-in at once; treg refuses an account that is in no
 *  team). None names a key: treg's own sign-in asks the person, in their browser, which of their teams pays. */
export function tregSnippets(): TregSnippets {
  return {
    claude: `claude mcp add --transport http treg ${TREG_MCP_URL}`,
    codex: `codex mcp add treg --url ${TREG_MCP_URL}`,
    // The entry to add inside the file's mcpServers, beside awwo-canvas: a whole file pasted over the canvas's would drop
    // its connection, whose token is shown once.
    cursor: `"treg": { "url": "${TREG_MCP_URL}" }`,
  };
}

/** Whether a reader may revoke a token, as the server judges it (canvas_agent_tokens.go): its maker, or an admin. */
export function mayRevokeToken(item: AgentTokenItem, viewer: AgentInviteViewer | undefined): boolean {
  if (!viewer) return true;
  return item.createdBy?.id === viewer.userId || viewer.role === 'admin' || viewer.role === 'owner';
}

/** Copies text to the clipboard; where the clipboard API is missing or refuses, the shown text is selected and copied
 *  by the browser's own command (and stays selected for the reader's own copy). */
async function copyText(value: string, shown: HTMLElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* select the shown text below */ }
  if (!shown) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(shown);
  selection.removeAllRanges();
  selection.addRange(range);
  try { return typeof document.execCommand === 'function' && document.execCommand('copy'); } catch { return false; }
}

/** The 邀请 Agent section: a disclosure, closed unless asked; closing it forgets a token just made. */
export function AgentInvite(props: AgentInviteProps) {
  const { t } = useMultiplayerText();
  const [open, setOpen] = useState(Boolean(props.defaultOpen));
  const bodyId = useId();
  const onOpen = useRef(props.onOpen);
  useLayoutEffect(() => { onOpen.current = props.onOpen; });
  useEffect(() => { if (open) onOpen.current?.(); }, [open]);
  return <section className="awwo-multiplayer-section awwo-multiplayer-invite" data-open={open || undefined}>
    <h3 className="awwo-multiplayer-section-title">
      <button type="button" className="awwo-multiplayer-disclosure" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen(was => !was)}>
        <UserPlus size={15} aria-hidden="true" /><span>{props.label ?? t('invite.toggle')}</span><ChevronDown size={14} aria-hidden="true" className="awwo-multiplayer-chevron" />
      </button>
    </h3>
    {open && <InviteBody id={bodyId} {...props} />}
  </section>;
}

function InviteBody({ id, tokens, onCreate, onRevoke, mcpUrl, apiBase, tenantId, canvasId, now, viewer, onSecretShown }: AgentInviteProps & { id: string }) {
  const { t } = useMultiplayerText();
  const [created, setCreated] = useState<CreatedAgentToken | null>(null);
  // Tokens made here, listed until the caller's list has them (their listings only: never a secret). Once the caller's
  // list has had one, it alone tells: a token it later drops stays dropped.
  const [madeHere, setMadeHere] = useState<readonly AgentTokenItem[]>([]);
  const listedIds = useMemo(() => new Set(tokens.items.map(item => item.id)), [tokens.items]);
  useEffect(() => {
    if (madeHere.some(item => listedIds.has(item.id))) setMadeHere(list => list.filter(item => !listedIds.has(item.id)));
  }, [listedIds, madeHere]);
  const focus = useSecretFocus(created, onSecretShown);
  const made = (token: CreatedAgentToken) => {
    focus.followSecret();
    setCreated(token);
    setMadeHere(list => [token.item, ...list.filter(item => item.id !== token.item.id)]);
  };
  const done = () => {
    focus.backToForm();
    setCreated(null);
  };
  const listed = [...madeHere.filter(item => !listedIds.has(item.id)), ...tokens.items];
  return <div id={id} className="awwo-multiplayer-invite-body">
    <p className="awwo-multiplayer-hint">{t('invite.intro')}</p>
    {created ? <TokenSecret created={created} lines={connectionSnippets({ token: created.token, mcpUrl, apiBase, tenantId, canvasId })}
      secretRef={focus.secretRef} doneRef={focus.doneRef} onDone={done} />
      : <TokenForm id={id} onCreate={onCreate} onMade={made} formRef={focus.formRef} createRef={focus.createRef} />}
    <TokenList tokens={{ ...tokens, items: listed }} onRevoke={onRevoke} now={now} viewer={viewer} />
    <TregConnect />
  </div>;
}

/** 加上 treg: a disclosure of its own, closed unless asked. Its lines name no secret, so it is open to every reader of
 *  this section, a token made or not. */
function TregConnect() {
  const { t } = useMultiplayerText();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const lines = tregSnippets();
  return <section className="awwo-multiplayer-treg" data-open={open || undefined}>
    <h4 className="awwo-multiplayer-treg-title">
      <button type="button" className="awwo-multiplayer-disclosure" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen(was => !was)}>
        <Globe size={15} aria-hidden="true" /><span>{t('treg.toggle')}</span><ChevronDown size={14} aria-hidden="true" className="awwo-multiplayer-chevron" />
      </button>
    </h4>
    {open && <div id={bodyId} className="awwo-multiplayer-treg-body">
      <p className="awwo-multiplayer-hint">{t('treg.intro')}</p>
      <p className="awwo-multiplayer-hint">{t('treg.billing')}</p>
      <p className="awwo-multiplayer-label">{t('treg.stepsLabel')}</p>
      <ol className="awwo-multiplayer-steps"><li>{t('treg.step1')}</li><li>{t('treg.step2')}</li><li>{t('treg.step3')}</li></ol>
      <CopyBlock label={t('treg.forClaude')} value={lines.claude} />
      <CopyBlock label={t('treg.forCodex')} value={lines.codex} />
      <CopyBlock label={t('treg.forCursor')} value={lines.cursor} />
      <CopyBlock label={t('treg.forTask')} value={t('treg.task')} />
      <p className="awwo-multiplayer-hint">{t('treg.caution')}</p>
      <a className="awwo-multiplayer-link" href={TREG_SITE_URL} target="_blank" rel="noopener noreferrer" aria-label={t('treg.siteLabel')}>
        {t('treg.site')}<ExternalLink size={12} aria-hidden="true" />
      </a>
    </div>}
  </section>;
}

/** Where the keyboard goes as a token's secret comes and goes (the form it replaces goes with the focus in it), and
 *  the holder told of the secret's 「已保存，关闭」 while it is on screen. */
function useSecretFocus(created: CreatedAgentToken | null, onSecretShown: AgentInviteProps['onSecretShown']) {
  const formRef = useRef<HTMLFormElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const secretRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const focusTo = useRef<'secret' | 'form' | null>(null);
  useLayoutEffect(() => {
    const to = focusTo.current;
    focusTo.current = null;
    if (to === 'secret') secretRef.current?.focus({ preventScroll: true });
    else if (to === 'form') createRef.current?.focus({ preventScroll: true });
  }, [created]);
  // The holder hears of the secret as it comes on screen (a layout effect: before any key can reach it), and as it goes.
  const report = useRef(onSecretShown);
  useLayoutEffect(() => { report.current = onSecretShown; });
  useLayoutEffect(() => {
    if (!created) return undefined;
    report.current?.(doneRef.current);
    return () => report.current?.(null);
  }, [created]);
  return {
    formRef, createRef, secretRef, doneRef,
    /** A secret is coming: the keyboard goes to it, unless its reader has moved on from the form meanwhile. */
    followSecret() {
      const active = document.activeElement;
      if (!active || active === document.body || formRef.current?.contains(active)) focusTo.current = 'secret';
    },
    /** The secret is let go: the keyboard goes to the form's button. */
    backToForm() { focusTo.current = 'form'; },
  };
}

/** A token just made, shown this once: its secret and the lines that connect each agent with it. */
function TokenSecret({ created, lines, secretRef, doneRef, onDone }: {
  created: CreatedAgentToken; lines: ConnectionSnippets; secretRef: RefObject<HTMLDivElement | null>; doneRef: RefObject<HTMLButtonElement | null>;
  onDone: () => void;
}) {
  const { t } = useMultiplayerText();
  const title = t('invite.secretTitle', { name: created.item.name });
  return <div className="awwo-multiplayer-secret" ref={secretRef} tabIndex={-1} role="group" aria-label={title}>
    <p className="awwo-multiplayer-secret-title"><KeyRound size={15} aria-hidden="true" />{title}</p>
    <p className="awwo-multiplayer-secret-warning">{t('invite.secretOnce')}</p>
    <CopyBlock label={t('invite.tokenLabel')} value={created.token} />
    <CopyBlock label={t('invite.forClaude')} value={lines.claude} />
    <CopyBlock label={t('invite.forCodex')} value={lines.codex} />
    <CopyBlock label={t('invite.forCodexEnv')} value={lines.codexEnv} />
    <CopyBlock label={t('invite.forClaudeUnattended')} value={lines.claudeUnattended} />
    <CopyBlock label={t('invite.forCodexUnattended')} value={lines.codexUnattended} />
    <p className="awwo-multiplayer-hint">{t(created.item.scope === 'read' ? 'invite.unattendedHintRead' : 'invite.unattendedHint')}</p>
    <CopyBlock label={t('invite.forCursor')} value={lines.cursor} />
    <CopyBlock label={t('invite.forHttp')} value={lines.http} />
    <button type="button" ref={doneRef} className="awwo-multiplayer-primary" onClick={onDone}>{t('invite.done')}</button>
  </div>;
}

/** The form a token is made with: the agent's name, the token's expiry and its access. A refusal is said under it. */
function TokenForm({ id, onCreate, onMade, formRef, createRef }: {
  id: string; onCreate: AgentInviteProps['onCreate']; onMade: (made: CreatedAgentToken) => void;
  formRef: RefObject<HTMLFormElement | null>; createRef: RefObject<HTMLButtonElement | null>;
}) {
  const { locale, t } = useMultiplayerText();
  const [name, setName] = useState(DEFAULT_AGENT_NAME);
  const [days, setDays] = useState(DEFAULT_TOKEN_DAYS);
  const [scope, setScope] = useState<AgentTokenScope>('edit');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const nameId = useId();
  const daysId = useId();
  const hintId = useId();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError('');
    try {
      const made = await onCreate(trimmed, days, scope);
      if (!made || typeof made.token !== 'string' || !made.token || !made.item) throw new Error('');
      onMade({ token: made.token, item: made.item });
    } catch (failure) {
      setError(t('invite.failed', { detail: failureDetail(locale, failure) }));
    } finally {
      setCreating(false);
    }
  };
  return <form className="awwo-multiplayer-invite-form" ref={formRef} onSubmit={submit}>
    <label className="awwo-multiplayer-label" htmlFor={nameId}>{t('invite.name')}</label>
    <input id={nameId} className="awwo-multiplayer-field" value={name} maxLength={AGENT_NAME_MAX} required aria-describedby={hintId}
      onChange={event => setName(event.target.value)} />
    <p id={hintId} className="awwo-multiplayer-hint">{t('invite.nameHint')}</p>
    <label className="awwo-multiplayer-label" htmlFor={daysId}>{t('invite.days')}</label>
    <select id={daysId} className="awwo-multiplayer-field" value={days} onChange={event => setDays(Number(event.target.value))}>
      {TOKEN_DAYS.map(count => <option key={count} value={count}>{count === 1 ? t('invite.daysOne') : t('invite.daysMany', { days: count })}</option>)}
    </select>
    <ScopeChoice name={`${id}-scope`} scope={scope} onChange={setScope} />
    <button type="submit" ref={createRef} className="awwo-multiplayer-primary" disabled={creating || !name.trim()}>{t(creating ? 'invite.creating' : 'invite.create')}</button>
    {error && <p className="awwo-multiplayer-error" role="alert">{error}</p>}
  </form>;
}

/** A token's access, edit or read only, with what each lets the agent do. */
function ScopeChoice({ name, scope, onChange }: { name: string; scope: AgentTokenScope; onChange: (scope: AgentTokenScope) => void }) {
  const { t } = useMultiplayerText();
  return <>
    <fieldset className="awwo-multiplayer-scope">
      <legend className="awwo-multiplayer-label">{t('invite.scope')}</legend>
      <div className="awwo-multiplayer-scope-options">
        {(['edit', 'read'] as const).map(value => <label key={value} className="awwo-multiplayer-scope-option" data-checked={scope === value || undefined}>
          <input type="radio" name={name} value={value} checked={scope === value} onChange={() => onChange(value)} />
          <span>{t(value === 'edit' ? 'invite.scopeEdit' : 'invite.scopeRead')}</span>
        </label>)}
      </div>
    </fieldset>
    <p className="awwo-multiplayer-hint">{t(scope === 'edit' ? 'invite.scopeEditHint' : 'invite.scopeReadHint')}</p>
  </>;
}

/** One line to copy, as it is, with its copy button (the Share dialog's links too). */
export function CopyBlock({ label, value }: { label: string; value: string }) {
  const { t } = useMultiplayerText();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const shown = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (state !== 'copied') return undefined;
    const timer = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = async () => setState(await copyText(value, shown.current) ? 'copied' : 'failed');
  return <div className="awwo-multiplayer-copy">
    <div className="awwo-multiplayer-copy-head">
      <span className="awwo-multiplayer-copy-label">{label}</span>
      <button type="button" className="awwo-multiplayer-small-button" aria-label={t('invite.copyLabel', { what: label })} onClick={() => { void copy(); }}>
        {state === 'copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        <span aria-hidden="true">{t(state === 'copied' ? 'invite.copied' : 'invite.copy')}</span>
      </button>
      <span className="awwo-multiplayer-sr" aria-live="polite">{state === 'copied' ? t('invite.copied') : ''}</span>
    </div>
    <pre className="awwo-multiplayer-code" ref={shown} tabIndex={0}><code>{value}</code></pre>
    {state === 'failed' && <p className="awwo-multiplayer-error" role="alert">{t('invite.copyFailed')}</p>}
  </div>;
}

function TokenList({ tokens, onRevoke, now, viewer }: {
  tokens: AgentTokenList; onRevoke: (id: string) => Promise<void>; now: number | undefined; viewer: AgentInviteViewer | undefined;
}) {
  const { locale, t } = useMultiplayerText();
  const { items, loading, error } = tokens;
  const failed = error !== null && error !== undefined && error !== '';
  const clock = now ?? Date.now();
  return <div className="awwo-multiplayer-tokens">
    <h4 className="awwo-multiplayer-label">{t('invite.list')}</h4>
    {loading && !items.length && <p className="awwo-multiplayer-hint" role="status">{t('invite.loading')}</p>}
    {failed && <p className="awwo-multiplayer-error" role="alert">{t('invite.loadFailed', { detail: failureDetail(locale, error) })}</p>}
    {!loading && !failed && !items.length && <p className="awwo-multiplayer-hint">{t('invite.listEmpty')}</p>}
    {items.length > 0 && <ul className="awwo-multiplayer-list">
      {items.map(item => <TokenRow key={item.id} item={item} onRevoke={onRevoke} now={clock} mayRevoke={mayRevokeToken(item, viewer)} />)}
    </ul>}
  </div>;
}

function TokenRow({ item, onRevoke, now, mayRevoke }: { item: AgentTokenItem; onRevoke: (id: string) => Promise<void>; now: number; mayRevoke: boolean }) {
  const { locale, t } = useMultiplayerText();
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState('');
  const revokeButton = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const cancel = () => {
    setConfirming(false);
    revokeButton.current?.focus({ preventScroll: true });
  };
  const expiresAt = Date.parse(item.expiresAt);
  const expired = !item.revokedAt && !Number.isNaN(expiresAt) && expiresAt <= now;
  const state = item.revokedAt ? 'revoked' : expired ? 'expired' : 'live';
  const revocable = state === 'live' && mayRevoke;
  const meta = [
    item.createdBy?.name ? t('invite.madeBy', { name: item.createdBy.name }) : '',
    item.revokedAt ? t('invite.revoked', { date: shortDate(locale, item.revokedAt) })
      : t(expired ? 'invite.expired' : 'invite.expires', { date: shortDate(locale, item.expiresAt) }),
    item.lastUsedAt ? t('invite.lastUsed', { date: shortDate(locale, item.lastUsedAt) }) : t('invite.neverUsed'),
  ].filter(Boolean);
  const revoke = async () => {
    setRevoking(true);
    setError('');
    try {
      await onRevoke(item.id);
      setConfirming(false);
      // The confirmation goes away with the focus in it: the keyboard stays on this token.
      rowRef.current?.focus({ preventScroll: true });
    } catch (failure) {
      setError(t('invite.revokeFailed', { detail: failureDetail(locale, failure) }));
    } finally {
      setRevoking(false);
    }
  };
  return <li className="awwo-multiplayer-token" ref={rowRef} tabIndex={-1} data-token={item.id} data-state={state}>
    <div className="awwo-multiplayer-token-head">
      <strong className="awwo-multiplayer-token-name">{item.name}</strong>
      <span className="awwo-multiplayer-port">{t(item.scope === 'read' ? 'invite.scopeRead' : 'invite.scopeEdit')}</span>
      {revocable && <button type="button" ref={revokeButton} className="awwo-multiplayer-small-button is-danger" aria-label={t('invite.revokeLabel', { name: item.name })}
        aria-expanded={confirming} disabled={revoking} onClick={() => setConfirming(was => !was)}>{t('invite.revoke')}</button>}
    </div>
    <code className="awwo-multiplayer-token-prefix">{item.prefix}</code>
    <p className="awwo-multiplayer-token-meta">{meta.join(' · ')}</p>
    {confirming && revocable && <div className="awwo-multiplayer-confirm" role="group" aria-label={t('invite.revokeLabel', { name: item.name })}>
      <p>{t('invite.revokeConfirm', { name: item.name })}</p>
      <div className="awwo-multiplayer-confirm-actions">
        <button type="button" className="awwo-multiplayer-small-button is-danger" disabled={revoking} onClick={() => { void revoke(); }}>
          {t(revoking ? 'invite.revoking' : 'invite.revoke')}
        </button>
        <button type="button" className="awwo-multiplayer-small-button" disabled={revoking} autoFocus onClick={cancel}>{t('invite.cancel')}</button>
      </div>
    </div>}
    {error && <p className="awwo-multiplayer-error" role="alert">{error}</p>}
  </li>;
}
