import { canvasFetch } from '../saas/canvasBridge';
// InspectorPanel — the per-node configuration dock for the session canvas.
//
// Ported from the verified WorkflowConfigPanel (since-deleted apps/web/src/studio/WorkflowConfigPanel.tsx),
// with the node vocabulary moved to the canvas document (a node IS an agent session, so what
// was an 'agent' node is a 'session' node and `agentType` is `agentKind`). Every honesty
// behavior is carried over unchanged — they are the reason this panel exists:
//
//  - The runtime/model/effort controls are CONTRACT-DRIVEN (RuntimePicker, 铁律6). Nothing here
//    hardcodes a model or an effort level, and nothing back-fills a default into the node.
//  - No host inventory reader → runtime selection is HIDDEN, fail-closed. A FAILED /api/agents
//    fetch is said out loud ("清单加载失败"), never rendered as an empty dropdown — an empty
//    dropdown reads as "this product has zero runtimes", which is a lie about a network failure.
//  - Binding is TRI-STATE (created / rejected / unknown, via canvasHire). An 'unknown' outcome is
//    persisted on the NODE as `bindAttempt`, so the warning and the retry-labelled button survive
//    a panel close and a full reload — otherwise the tile reads 未绑定 and invites a duplicate hire.
//  - Every input is frozen while a bind is in flight: the request carries the values on screen,
//    and the closure snapshot cannot drift from what the operator sees.
//  - The persona sync to the bound agent's AGENTS.md is a SEPARATE step with its OWN reported
//    outcome — the hire is real either way, and a failed sync is never folded into "已绑定".
//
// Form nodes get the field editor (label + value rows); the run engine serializes those fields
// into the downstream session's message, so they are real data, not decoration.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { RuntimePicker, type RuntimeValue } from '../RuntimePicker';
import { NodeTeamEditor } from './NodeTeamEditor';
import { validateNodeTeam } from './nodeTeam';
import { useCanvasI18n, type CanvasTranslate } from './i18n';
import { hireAgentIntoCompany, isAllowedBase, normalizeBase } from '../canvasHire';
import {
  type AgentKind,
  type CanvasNode,
  type FormField,
  type FormNode,
  type SessionNode,
} from './canvasDoc';

type ReadJson = (path: string, init?: RequestInit & { headers?: Record<string, string> }) => Promise<any>;

export interface InspectorPanelProps {
  node: CanvasNode;
  /** LIVE companies a bind can target ({id,name}). Empty → binding disabled with an honest hint. */
  liveCompanies: ReadonlyArray<{ id: string; name: string }>;
  /** Paperclip front-door base (canvasHire's same-origin/loopback guard applies). */
  apiBase: string;
  /** Host inventory reader for RuntimePicker. Absent → runtime selection hidden (fail-closed). */
  readJson?: ReadJson;
  /** The canvas is executing a graph snapshot. Configuration mutations must wait. */
  readOnly?: boolean;
  /** Permission locks can explain themselves without claiming a graph is running. */
  readOnlyMessage?: string;
  /** Persist the edited node into the canvas document. */
  onSave: (next: CanvasNode) => void;
  /** A binding landed — the surface can re-project the live world so the new agent appears. */
  onBound?: (node: SessionNode) => void;
  /**
   * Take the user to where companies are created. Binding needs a LIVE company, and the canvas
   * does not create one — so with an empty world the panel would otherwise dead-end on "go make a
   * company" with no way to go. Absent → the hint still explains, it just cannot navigate.
   */
  onCreateCompany?: () => void;
  /** Protect host Escape/navigation/removal while a real binding result is not yet saved. */
  onCloseLockChange?: (locked: boolean) => void;
  onClose: () => void;
  /** Host override for the dock's placement (defaults to a full-height right dock). */
  style?: CSSProperties;
}

const AGENT_KINDS: ReadonlyArray<AgentKind> = ['llm', 'coding', 'image'];

/** Agent kind → the hire path's coarse mission-role bucket (canvasHire maps it to AGENT_ROLES). */
const KIND_TO_MISSION_ROLE: Record<AgentKind, string> = {
  llm: 'plan',
  coding: 'implement',
  image: 'review',
};

type PersonaResult = 'synced' | 'failed' | 'not-written' | 'none';
type BindState =
  | { phase: 'idle' }
  | { phase: 'binding' }
  | { phase: 'done'; kind: 'held'; tone: 'warn'; outcome: 'created' | 'unknown'; status?: string; detail?: string; persona: PersonaResult }
  | { phase: 'done'; kind: 'unknown'; tone: 'warn'; detail?: string }
  | { phase: 'done'; kind: 'rejected'; tone: 'err'; detail?: string }
  | { phase: 'done'; kind: 'bound'; tone: 'ok' | 'warn'; status?: string; persona: PersonaResult };

/** A request already reached the server; keep its real outcome until the graph unlocks. */
type HeldBinding = {
  node: SessionNode;
  outcome: 'created' | 'unknown';
  status?: string;
  detail?: string;
  /** Undefined means not attempted; a defined note records an already-completed write. */
  personaResult?: PersonaResult;
};

function personaResultText(result: PersonaResult, t: CanvasTranslate): string {
  if (result === 'synced') return t('inspector.personaSynced');
  if (result === 'failed') return t('inspector.personaFailed');
  if (result === 'not-written') return t('inspector.personaNotWritten');
  return '';
}

function bindingText(state: Extract<BindState, { phase: 'done' }>, t: CanvasTranslate): string {
  if (state.kind === 'unknown') return t('inspector.unknownCompleted', { detail: state.detail ?? '' });
  if (state.kind === 'rejected') return t('inspector.bindRejected', { detail: state.detail ?? '' });
  if (state.kind === 'bound') return t('inspector.boundSuccess', {
    status: state.status ?? '', persona: personaResultText(state.persona, t),
  });
  const result = state.outcome === 'created'
    ? t('inspector.createdHeld', { status: state.status ?? '' })
    : t('inspector.unknownHeld', { detail: state.detail ?? '' });
  const persona = personaResultText(state.persona, t);
  return `${result} ${t('inspector.heldSuffix')}${persona ? ` ${persona}` : ''}`;
}

const DOCK_STYLE: CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  width: 340,
  zIndex: 40,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

let fieldSeq = 0;
function mintFieldId(): string {
  fieldSeq += 1;
  return `f-${Date.now().toString(36)}-${fieldSeq.toString(36)}`;
}

export function InspectorPanel({
  node,
  liveCompanies,
  apiBase,
  readJson,
  readOnly = false,
  readOnlyMessage,
  onSave,
  onBound,
  onCreateCompany,
  onCloseLockChange,
  onClose,
  style,
}: InspectorPanelProps) {
  const { locale, t } = useCanvasI18n();
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const closeLockCallbackRef = useRef(onCloseLockChange);
  closeLockCallbackRef.current = onCloseLockChange;
  // Local draft — committed on 保存 (or as part of 绑定, which saves first so a mid-bind close
  // never loses the operator's edits).
  const [draft, setDraft] = useState<CanvasNode>(node);
  const [teamCatalogValid, setTeamCatalogValid] = useState(!('team' in node && node.team));
  // Keyed on the node IDENTITY, not the whole node: after a bind we setDraft(bound) AND
  // onSave(bound), so the parent re-renders with the same id — resetting here would be a no-op
  // at best and a clobber of a fresher draft at worst.
  useEffect(() => setDraft(node), [node.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Runtime inventory (names only) for the picker's runtime dropdown, host-fed. A failed fetch
  // must be DISTINGUISHABLE from "no runtimes exist" — an empty dropdown with no explanation
  // reads as a product with zero runtimes rather than as a kernel that is down.
  const [runtimes, setRuntimes] = useState<string[]>([]);
  const [teamsAvailable, setTeamsAvailable] = useState(false);
  const [runtimesError, setRuntimesError] = useState(false);
  useEffect(() => {
    if (!readJson) return;
    let stale = false;
    setRuntimesError(false);
    setTeamsAvailable(false);
    void readJson('/api/agents')
      .then((d) => {
        if (stale) return;
        const list = Array.isArray(d?.agents) ? d.agents : [];
        setRuntimes(list.map((a: { name?: unknown }) => String(a?.name ?? '')).filter(Boolean));
        setTeamsAvailable(list.some((agent: { name?: unknown; supports_node_teams?: unknown }) => agent.name === 'pi' && agent.supports_node_teams === true));
      })
      .catch(() => {
        if (!stale) setRuntimesError(true);
      });
    return () => {
      stale = true;
    };
  }, [readJson]);

  const [bindCompanyId, setBindCompanyId] = useState('');
  const [bind, setBind] = useState<BindState>({ phase: 'idle' });
  const [heldBinding, setHeldBinding] = useState<HeldBinding | null>(null);
  const heldBindingRef = useRef<HeldBinding | null>(null);
  const bindingRef = useRef(false);
  // A company choice belongs to the node it was made for. Carrying it to the next node would let
  // a hire land in a company the operator picked while looking at something else.
  useEffect(() => {
    setBindCompanyId('');
    setBind({ phase: 'idle' });
    setHeldBinding(null);
    heldBindingRef.current = null;
    bindingRef.current = false;
  }, [node.id]);
  const sessionDraft = draft.kind === 'session' ? draft : null;
  const formDraft = draft.kind === 'form' ? draft : null;
  const boundCompany = useMemo(
    () => (sessionDraft?.binding ? liveCompanies.find((c) => c.id === sessionDraft.binding?.companyId) : undefined),
    [sessionDraft?.binding, liveCompanies],
  );

  // While a bind is in flight every input is frozen: partly UX honesty (the request carries the
  // values shown), partly correctness — bindAgent's closure snapshot must not drift from what the
  // operator sees (typing during the await would otherwise be clobbered on resolve).
  const isBinding = bind.phase === 'binding';
  const busy = isBinding || readOnly || Boolean(heldBinding);
  const closeLocked = isBinding || Boolean(heldBinding);
  useEffect(() => {
    closeLockCallbackRef.current?.(closeLocked);
  }, [closeLocked, onCloseLockChange]);
  // Separate unmount cleanup from lock updates: moving binding -> held must never emit
  // a transient false that could allow the host to discard a real server response.
  useEffect(() => () => closeLockCallbackRef.current?.(false), []);
  const mutationLocked = () => readOnlyRef.current || bindingRef.current || Boolean(heldBindingRef.current);
  const editDraft = (next: CanvasNode) => {
    if (!mutationLocked()) setDraft(next);
  };

  const save = () => {
    if (mutationLocked()) return;
    if (sessionDraft?.team && (!teamCatalogValid || validateNodeTeam(sessionDraft.team).length)) return;
    onSave(draft);
    onClose();
  };
  const close = () => {
    // A held response lives in this panel until it can be persisted. Closing now would lose
    // the identity of an agent the server already created and invite a duplicate hire.
    if (bindingRef.current || heldBindingRef.current) return;
    onClose();
  };

  const holdBinding = (result: HeldBinding) => {
    heldBindingRef.current = result;
    setHeldBinding(result);
    setDraft(result.node);
    bindingRef.current = false;
    setBind({ phase: 'done', kind: 'held', tone: 'warn', outcome: result.outcome, status: result.status,
      detail: result.detail, persona: result.personaResult ?? (result.node.persona.trim() && result.outcome === 'created' ? 'not-written' : 'none') });
  };

  const completeBinding = async (result: HeldBinding) => {
    if (readOnlyRef.current) { holdBinding(result); return; }
    onSave(result.node);
    if (result.outcome === 'unknown') {
      heldBindingRef.current = null; setHeldBinding(null); bindingRef.current = false;
      setBind({ phase: 'done', kind: 'unknown', tone: 'warn', detail: result.detail });
      return;
    }
    let personaResult = result.personaResult;
    if (personaResult === undefined) {
      if (readOnlyRef.current) { holdBinding(result); return; }
      if (result.node.persona.trim()) {
        const ok = await syncPersona(apiBase, result.node.binding!.agentId, result.node.persona);
        personaResult = ok ? 'synced' : 'failed';
      } else personaResult = 'none';
    }
    // A persona request already sent cannot be rolled back. Keep its observed result and
    // withhold callbacks; resuming this held result must not issue the same write again.
    if (readOnlyRef.current) { holdBinding({ ...result, personaResult }); return; }
    heldBindingRef.current = null; setHeldBinding(null); bindingRef.current = false;
    setBind({ phase: 'done', kind: 'bound', tone: personaResult === 'failed' ? 'warn' : 'ok', status: result.status, persona: personaResult });
    onBound?.(result.node);
  };

  const resumeBinding = () => {
    const result = heldBindingRef.current;
    if (!result || readOnlyRef.current || bindingRef.current) return;
    bindingRef.current = true;
    closeLockCallbackRef.current?.(true);
    setBind({ phase: 'binding' });
    void completeBinding(result);
  };

  const bindAgent = async () => {
    if (!sessionDraft || mutationLocked()) return;
    if (sessionDraft.team && (!teamCatalogValid || validateNodeTeam(sessionDraft.team).length)) return;
    // Only ever POST to a company that is actually in the live list: a selection left over from a
    // company that has since disappeared must fall back to a real one, never be sent as-is.
    const companyId = liveCompanies.some((c) => c.id === bindCompanyId)
      ? bindCompanyId
      : liveCompanies[0]?.id || '';
    if (!companyId) return;
    bindingRef.current = true;
    // Report synchronously, before onSave/POST: host Escape and navigation guards cannot
    // wait until React flushes the effect from the next render.
    closeLockCallbackRef.current?.(true);
    setBind({ phase: 'binding' });
    // Persist the config FIRST so a mid-bind close never loses the operator's edits.
    onSave(sessionDraft);
    const outcome = await hireAgentIntoCompany(apiBase, companyId, {
      name: sessionDraft.title || t(sessionDraft.agentKind === 'coding' ? 'node.coding' : sessionDraft.agentKind === 'image' ? 'node.image' : 'node.llm'),
      missionRole: KIND_TO_MISSION_ROLE[sessionDraft.agentKind],
      adapterType: sessionDraft.runtime,
      model: sessionDraft.model,
      effort: sessionDraft.effort,
    });
    if (outcome.outcome !== 'created') {
      if (outcome.outcome === 'unknown') {
        // A LOST response may still have hired a real agent. Persist the attempt on the NODE
        // (not just this panel instance's state) so the warning survives panel closes and
        // reloads — otherwise the tile reads 未绑定 and invites a duplicate hire.
        const marked: SessionNode = { ...sessionDraft, bindAttempt: 'unknown' };
        setDraft(marked);
        await completeBinding({ node: marked, outcome: 'unknown', detail: outcome.detail });
        return;
      }
      bindingRef.current = false;
      setBind({
        phase: 'done',
        tone: 'err',
        kind: 'rejected', detail: outcome.detail,
      });
      return;
    }
    const bound: SessionNode = {
      ...sessionDraft,
      binding: { companyId, agentId: outcome.agentId, agentName: sessionDraft.title || 'agent' },
      bindAttempt: null,
    };
    setDraft(bound);
    await completeBinding({ node: bound, outcome: 'created', status: outcome.status });
  };

  return (
    <aside
      className="canvas-inspector"
      role="dialog"
      aria-label={t('inspector.dialog', { title: node.title })}
      style={{ ...DOCK_STYLE, ...style }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <header className="canvas-inspector-head">
        <div className="canvas-inspector-title">{t('inspector.dialog', { title: node.title })}</div>
        <button type="button" className="canvas-inspector-close" aria-label={t('inspector.close')} disabled={closeLocked}
          title={closeLocked ? t('inspector.closeLocked') : undefined} onClick={close}>
          ✕
        </button>
      </header>

      <div className="canvas-inspector-body">
        {readOnly ? <div className="canvas-inspector-hint" role="status">{readOnlyMessage || t('inspector.readOnly')}</div> : null}
        <label className="canvas-inspector-label" htmlFor="cv-cfg-title">
          {t('inspector.name')}
        </label>
        <input
          id="cv-cfg-title"
          className="canvas-inspector-input"
          aria-label={t('inspector.name')}
          value={draft.title}
          disabled={busy}
          onChange={(e) => editDraft({ ...draft, title: e.target.value })}
        />

        {sessionDraft ? (
          <>
            <div className="canvas-inspector-label">{t('inspector.agentType')}</div>
            <div className="canvas-inspector-seg" role="radiogroup" aria-label={t('inspector.agentType')}>
              {AGENT_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={sessionDraft.agentKind === kind}
                  className={`canvas-inspector-seg-item${sessionDraft.agentKind === kind ? ' is-on' : ''}`}
                  disabled={busy}
                  onClick={() => editDraft({ ...sessionDraft, agentKind: kind })}
                >
                  {t(kind === 'coding' ? 'node.coding' : kind === 'image' ? 'node.image' : 'node.llm')}
                </button>
              ))}
            </div>

            <div className="canvas-inspector-label">{t('inspector.runtime')}</div>
            {readJson ? (
              <div className="canvas-inspector-runtime">
                <RuntimePicker
                  runtimes={runtimes}
                  value={{ backend: sessionDraft.runtime, model: sessionDraft.model, effort: sessionDraft.effort }}
                  onChange={(v: RuntimeValue) =>
                    editDraft({ ...sessionDraft, runtime: v.backend, model: v.model, effort: v.effort })
                  }
                  readJson={readJson}
                  lang={locale}
                  disabled={busy}
                />
                {runtimesError ? (
                  <div className="canvas-inspector-outcome canvas-inspector-outcome--err">
                    {t('inspector.runtimeLoadFailed')}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="canvas-inspector-hint">{t('inspector.runtimeUnavailable')}</div>
            )}

            <label className="canvas-inspector-label" htmlFor="cv-cfg-persona">
              {t('inspector.persona')}
            </label>
            <textarea
              id="cv-cfg-persona"
              className="canvas-inspector-persona"
              aria-label={t('inspector.persona')}
              rows={5}
              placeholder={t('inspector.personaPlaceholder')}
              value={sessionDraft.persona}
              disabled={busy}
              onChange={(e) => editDraft({ ...sessionDraft, persona: e.target.value })}
            />

            <NodeTeamEditor node={sessionDraft} available={Boolean(readJson) && teamsAvailable} readJson={readJson}
              disabled={busy} onValidityChange={setTeamCatalogValid}
              onChange={team => editDraft({ ...sessionDraft, team })} />
            <div className="canvas-inspector-label">{t('inspector.bindReal')}</div>
            {sessionDraft.bindAttempt === 'unknown' && !sessionDraft.binding ? (
              <div className="canvas-inspector-outcome canvas-inspector-outcome--warn">
                {t('inspector.unknownWarning')}
              </div>
            ) : null}
            {sessionDraft.binding ? (
              <div className="canvas-inspector-hint">
                {t('inspector.bound', { agent: sessionDraft.binding.agentName, company: boundCompany?.name ?? sessionDraft.binding.companyId })}
              </div>
            ) : liveCompanies.length === 0 ? (
              <div className="canvas-inspector-hint">
                {t('inspector.noCompanies')}
                {onCreateCompany ? (
                  <>
                    {' '}
                    <button type="button" className="canvas-inspector-link" onClick={() => { if (!mutationLocked()) onCreateCompany(); }} disabled={busy}>
                      {t('inspector.createCompany')}
                    </button>
                  </>
                ) : null}
              </div>
            ) : (
              <>
                <select
                  className="canvas-inspector-input"
                  aria-label={t('inspector.bindCompany')}
                  value={bindCompanyId || liveCompanies[0]?.id || ''}
                  disabled={busy}
                  onChange={(e) => { if (!mutationLocked()) setBindCompanyId(e.target.value); }}
                >
                  {liveCompanies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="canvas-inspector-bind"
                  disabled={busy || !sessionDraft.runtime.trim() || Boolean(sessionDraft.team && !teamCatalogValid)}
                  title={!sessionDraft.runtime.trim() ? t('inspector.chooseRuntime') : undefined}
                  onClick={() => void bindAgent()}
                >
                  {isBinding
                    ? t('inspector.binding')
                    : sessionDraft.bindAttempt === 'unknown'
                      ? t('inspector.retryBind')
                      : t('inspector.bindCreate')}
                </button>
              </>
            )}
            {bind.phase === 'done' ? (
              <div className={`canvas-inspector-outcome canvas-inspector-outcome--${bind.tone}`}>{bindingText(bind, t)}</div>
            ) : null}
            {heldBinding ? <button type="button" className="canvas-inspector-bind" disabled={readOnly || isBinding} onClick={resumeBinding}>
              {t('inspector.saveBinding')}
            </button> : null}
          </>
        ) : formDraft ? (
          <>
            <div className="canvas-inspector-label">{t('inspector.formFields')}</div>
            {formDraft.fields.map((field, index) => (
              <div key={field.id} className="canvas-inspector-field-row">
                <input
                  className="canvas-inspector-input canvas-inspector-field-label"
                  aria-label={t('inspector.fieldName', { count: index + 1 })}
                  placeholder={t('inspector.fieldNamePlaceholder')}
                  value={field.label}
                  disabled={busy}
                  onChange={(e) => editDraft(patchField(formDraft, field.id, { label: e.target.value }))}
                />
                <input
                  className="canvas-inspector-input canvas-inspector-field-value"
                  aria-label={t('inspector.fieldValue', { count: index + 1 })}
                  placeholder={t('inspector.valuePlaceholder')}
                  value={field.value}
                  disabled={busy}
                  onChange={(e) => editDraft(patchField(formDraft, field.id, { value: e.target.value }))}
                />
                <button
                  type="button"
                  className="canvas-inspector-field-remove"
                  aria-label={t('inspector.removeField', { name: field.label || index + 1 })}
                  disabled={busy}
                  onClick={() => editDraft({ ...formDraft, fields: formDraft.fields.filter((f) => f.id !== field.id) })}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              className="canvas-inspector-add-field"
              disabled={busy}
              onClick={() =>
                editDraft({ ...formDraft, fields: [...formDraft.fields, { id: mintFieldId(), label: '', value: '' }] })
              }
            >
              ＋ {t('inspector.addField')}
            </button>
          </>
        ) : null}
      </div>

      <footer className="canvas-inspector-foot">
        <button type="button" className="canvas-inspector-save" disabled={busy || Boolean(sessionDraft?.team && !teamCatalogValid)} onClick={save}>
          {t('common.save')}
        </button>
        <button type="button" className="canvas-inspector-cancel" disabled={closeLocked} onClick={close}>
          {t('common.cancel')}
        </button>
      </footer>
    </aside>
  );
}

function patchField(node: FormNode, fieldId: string, patch: Partial<FormField>): FormNode {
  return { ...node, fields: node.fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f)) };
}

/**
 * Write the persona into the bound agent's instructions bundle (its AGENTS.md entry file).
 * Best-effort with an honest boolean — the caller reports failure to the operator rather than
 * folding it into the bind result. Same same-origin/loopback base guard as every other
 * credentialed mutation (canvasHire's isAllowedBase): never PUT credentials to an arbitrary host.
 */
async function syncPersona(apiBase: string, agentId: string, persona: string): Promise<boolean> {
  try {
    const base = normalizeBase(apiBase);
    if (!isAllowedBase(base)) return false;
    const res = await canvasFetch(`${base}/agents/${encodeURIComponent(agentId)}/instructions-bundle/file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ path: 'AGENTS.md', content: persona }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
