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
import { hireAgentIntoCompany, isAllowedBase, normalizeBase } from '../canvasHire';
import {
  AGENT_KIND_META,
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

type BindState =
  | { phase: 'idle' }
  | { phase: 'binding' }
  | { phase: 'done'; text: string; tone: 'ok' | 'warn' | 'err' };

/** A request already reached the server; keep its real outcome until the graph unlocks. */
type HeldBinding = {
  node: SessionNode;
  outcome: 'created' | 'unknown';
  status?: string;
  detail?: string;
  /** Undefined means not attempted; a defined note records an already-completed write. */
  personaNote?: string;
};

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
  onSave,
  onBound,
  onCreateCompany,
  onCloseLockChange,
  onClose,
  style,
}: InspectorPanelProps) {
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const closeLockCallbackRef = useRef(onCloseLockChange);
  closeLockCallbackRef.current = onCloseLockChange;
  // Local draft — committed on 保存 (or as part of 绑定, which saves first so a mid-bind close
  // never loses the operator's edits).
  const [draft, setDraft] = useState<CanvasNode>(node);
  // Keyed on the node IDENTITY, not the whole node: after a bind we setDraft(bound) AND
  // onSave(bound), so the parent re-renders with the same id — resetting here would be a no-op
  // at best and a clobber of a fresher draft at worst.
  useEffect(() => setDraft(node), [node.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Runtime inventory (names only) for the picker's runtime dropdown, host-fed. A failed fetch
  // must be DISTINGUISHABLE from "no runtimes exist" — an empty dropdown with no explanation
  // reads as a product with zero runtimes rather than as a kernel that is down.
  const [runtimes, setRuntimes] = useState<string[]>([]);
  const [runtimesError, setRuntimesError] = useState(false);
  useEffect(() => {
    if (!readJson) return;
    let stale = false;
    setRuntimesError(false);
    void readJson('/api/agents')
      .then((d) => {
        if (stale) return;
        const list = Array.isArray(d?.agents) ? d.agents : [];
        setRuntimes(list.map((a: { name?: unknown }) => String(a?.name ?? '')).filter(Boolean));
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
    setBind({
      phase: 'done', tone: 'warn',
      text: `${result.outcome === 'created' ? `真实 Agent 已创建（${result.status}）` : `绑定结果未知：${result.detail}`}。绑定结果已保留在本面板，请在图运行结束后保存。${result.personaNote ?? (result.node.persona.trim() && result.outcome === 'created' ? '人设尚未写入。' : '')}`,
    });
  };

  const completeBinding = async (result: HeldBinding) => {
    if (readOnlyRef.current) { holdBinding(result); return; }
    onSave(result.node);
    if (result.outcome === 'unknown') {
      heldBindingRef.current = null; setHeldBinding(null); bindingRef.current = false;
      setBind({ phase: 'done', tone: 'warn', text: `绑定结果未知（可能已创建，请刷新画布确认）：${result.detail}` });
      return;
    }
    let personaNote = result.personaNote;
    if (personaNote === undefined) {
      if (readOnlyRef.current) { holdBinding(result); return; }
      if (result.node.persona.trim()) {
        const ok = await syncPersona(apiBase, result.node.binding!.agentId, result.node.persona);
        personaNote = ok ? ' · 人设已写入 AGENTS.md' : ' · ⚠ 人设写入失败（配置仍保存在本地，可稍后重试）';
      } else personaNote = '';
    }
    // A persona request already sent cannot be rolled back. Keep its observed result and
    // withhold callbacks; resuming this held result must not issue the same write again.
    if (readOnlyRef.current) { holdBinding({ ...result, personaNote }); return; }
    heldBindingRef.current = null; setHeldBinding(null); bindingRef.current = false;
    setBind({ phase: 'done', tone: personaNote.includes('⚠') ? 'warn' : 'ok', text: `已绑定真实 Agent（${result.status}）${personaNote}` });
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
      name: sessionDraft.title || `${AGENT_KIND_META[sessionDraft.agentKind].label} Agent`,
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
        text: `绑定被拒绝：${outcome.detail}`,
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
      aria-label={`节点配置 — ${node.title}`}
      style={{ ...DOCK_STYLE, ...style }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <header className="canvas-inspector-head">
        <div className="canvas-inspector-title">节点配置 — {node.title}</div>
        <button type="button" className="canvas-inspector-close" aria-label="关闭配置" disabled={closeLocked}
          title={closeLocked ? '等待绑定完成并保存结果后即可关闭' : undefined} onClick={close}>
          ✕
        </button>
      </header>

      <div className="canvas-inspector-body">
        {readOnly ? <div className="canvas-inspector-hint" role="status">图运行中，配置只读。运行结束后可继续编辑。</div> : null}
        <label className="canvas-inspector-label" htmlFor="cv-cfg-title">
          名称
        </label>
        <input
          id="cv-cfg-title"
          className="canvas-inspector-input"
          aria-label="名称"
          value={draft.title}
          disabled={busy}
          onChange={(e) => editDraft({ ...draft, title: e.target.value })}
        />

        {sessionDraft ? (
          <>
            <div className="canvas-inspector-label">AGENT 类型</div>
            <div className="canvas-inspector-seg" role="radiogroup" aria-label="Agent 类型">
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
                  {AGENT_KIND_META[kind].label}
                </button>
              ))}
            </div>

            <div className="canvas-inspector-label">运行时 / 模型 / 思考强度</div>
            {readJson ? (
              <div className="canvas-inspector-runtime">
                <RuntimePicker
                  runtimes={runtimes}
                  value={{ backend: sessionDraft.runtime, model: sessionDraft.model, effort: sessionDraft.effort }}
                  onChange={(v: RuntimeValue) =>
                    editDraft({ ...sessionDraft, runtime: v.backend, model: v.model, effort: v.effort })
                  }
                  readJson={readJson}
                  disabled={busy}
                />
                {runtimesError ? (
                  <div className="canvas-inspector-outcome canvas-inspector-outcome--err">
                    运行时清单加载失败 — 请确认内核在运行，重开面板重试。
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="canvas-inspector-hint">运行时清单不可用（宿主未提供契约读取）。</div>
            )}

            <label className="canvas-inspector-label" htmlFor="cv-cfg-persona">
              人设 / 系统提示词
            </label>
            <textarea
              id="cv-cfg-persona"
              className="canvas-inspector-persona"
              aria-label="人设 / 系统提示词"
              rows={5}
              placeholder="这个 Agent 是谁、偏好什么、必须遵守什么…（绑定时写入其 AGENTS.md）"
              value={sessionDraft.persona}
              disabled={busy}
              onChange={(e) => editDraft({ ...sessionDraft, persona: e.target.value })}
            />

            <div className="canvas-inspector-label">绑定真实 Agent</div>
            {sessionDraft.bindAttempt === 'unknown' && !sessionDraft.binding ? (
              <div className="canvas-inspector-outcome canvas-inspector-outcome--warn">
                上次绑定结果未知：真实 Agent 可能已创建。先刷新画布 / 查看公司成员确认，再决定是否重试 —
                盲目重试可能雇出重复 Agent。
              </div>
            ) : null}
            {sessionDraft.binding ? (
              <div className="canvas-inspector-hint">
                已绑定：{sessionDraft.binding.agentName}（{boundCompany?.name ?? sessionDraft.binding.companyId}）
              </div>
            ) : liveCompanies.length === 0 ? (
              <div className="canvas-inspector-hint">
                没有可用的 LIVE 公司 — 先创建公司，才能绑定真实 Agent。
                {onCreateCompany ? (
                  <>
                    {' '}
                    <button type="button" className="canvas-inspector-link" onClick={() => { if (!mutationLocked()) onCreateCompany(); }} disabled={busy}>
                      去创建公司
                    </button>
                  </>
                ) : null}
              </div>
            ) : (
              <>
                <select
                  className="canvas-inspector-input"
                  aria-label="绑定到公司"
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
                  disabled={busy || !sessionDraft.runtime.trim()}
                  title={!sessionDraft.runtime.trim() ? '先选择运行时' : undefined}
                  onClick={() => void bindAgent()}
                >
                  {isBinding
                    ? '绑定中…'
                    : sessionDraft.bindAttempt === 'unknown'
                      ? '重试绑定（已确认未重复）'
                      : '绑定并创建真实 Agent'}
                </button>
              </>
            )}
            {bind.phase === 'done' ? (
              <div className={`canvas-inspector-outcome canvas-inspector-outcome--${bind.tone}`}>{bind.text}</div>
            ) : null}
            {heldBinding ? <button type="button" className="canvas-inspector-bind" disabled={readOnly || isBinding} onClick={resumeBinding}>
              保存绑定结果
            </button> : null}
          </>
        ) : formDraft ? (
          <>
            <div className="canvas-inspector-label">表单字段</div>
            {formDraft.fields.map((field, index) => (
              <div key={field.id} className="canvas-inspector-field-row">
                <input
                  className="canvas-inspector-input canvas-inspector-field-label"
                  aria-label={`字段 ${index + 1} 名称`}
                  placeholder="字段名"
                  value={field.label}
                  disabled={busy}
                  onChange={(e) => editDraft(patchField(formDraft, field.id, { label: e.target.value }))}
                />
                <input
                  className="canvas-inspector-input canvas-inspector-field-value"
                  aria-label={`字段 ${index + 1} 值`}
                  placeholder="值"
                  value={field.value}
                  disabled={busy}
                  onChange={(e) => editDraft(patchField(formDraft, field.id, { value: e.target.value }))}
                />
                <button
                  type="button"
                  className="canvas-inspector-field-remove"
                  aria-label={`删除字段 ${field.label || index + 1}`}
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
              ＋ 添加字段
            </button>
          </>
        ) : null}
      </div>

      <footer className="canvas-inspector-foot">
        <button type="button" className="canvas-inspector-save" disabled={busy} onClick={save}>
          保存
        </button>
        <button type="button" className="canvas-inspector-cancel" disabled={closeLocked} onClick={close}>
          取消
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
    const res = await fetch(`${base}/agents/${encodeURIComponent(agentId)}/instructions-bundle/file`, {
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
