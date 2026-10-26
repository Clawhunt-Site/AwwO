import { useEffect, useId, useRef, useState } from 'react';
import { api, SaaSApiError, saasErrorMessage, tenantPath } from '../api';
import { runtimeDefinitions, runtimeModels, withPlanTag, type SaaSRuntimeStatus } from '../runtimeCatalog';
import type { CanvasDocument } from '../../canvas/canvasDoc';
import { mediaKindOf } from '../../canvas/mediaCatalog';
import { createOfficialDocument, type OfficialWorkflow } from './officialWorkflows';
import { automaticEntries, SANDBOX_RUNTIME } from '../../canvas/nodeRuntime';
import './official-copy-setup.css';

/** `sandbox`: the sandbox computer offers the model too, so the agents of a canvas that works there take it with them. */
export type OfficialCopyModel = { runtime: string; model: string; label: string; sandbox?: true };
const modelKey = (value: OfficialCopyModel) => JSON.stringify([value.runtime, value.model]);

/** The homepage has no active canvas bridge. Read this tenant directly and reuse
 * the same server runtime/model contract as the canvas; never discover a legacy workspace. */
export async function readOfficialCopyModels(tenantId: string, signal?: AbortSignal): Promise<OfficialCopyModel[]> {
  const status = await api<SaaSRuntimeStatus>(tenantPath(tenantId, '/runtime'), {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  });
  const invalid = () => new SaaSApiError(502, 'invalid_copy_catalog', 'Invalid runtime model catalog.');
  // New copies must have explicit runtime ownership. A malformed or old unscoped
  // catalog cannot silently turn into a default-engine selection.
  if (!status || !Array.isArray(status.runtimes) || !Array.isArray(status.models)
    || status.runtimes.some(runtime => !runtime || typeof runtime.id !== 'string' || typeof runtime.available !== 'boolean'
      || typeof runtime.configured !== 'boolean' || !Array.isArray(runtime.tools))
    || status.models.some(model => !model || typeof model.id !== 'string' || !model.id.trim() || model.id.length > 200 || typeof model.runtime !== 'string')) throw invalid();
  const seen = new Set<string>();
  try {
    const offered = runtimeDefinitions(status).filter(runtime => runtime.available && runtime.configured).flatMap(runtime =>
      runtimeModels(status, runtime.id).map(model => {
        const value = { runtime: runtime.id, model: model.id, label: withPlanTag(model.label || model.name || model.id, model) };
        const key = modelKey(value);
        if (seen.has(key)) throw invalid();
        seen.add(key);
        return value;
      }));
    // Each model once, on the runtime AwwO runs it on (nodeRuntime.ts): a member picks a model, never a runtime. A model
    // the sandbox computer offers too says so, for the agents that stay there (a flagship's).
    const sandbox = new Set(offered.filter(value => value.runtime === SANDBOX_RUNTIME).map(value => value.model));
    return automaticEntries(offered.map(value => ({ ...value, available: true }))).map(({ available: _available, ...value }) =>
      sandbox.has(value.model) ? { ...value, sandbox: true as const } : value);
  } catch { throw invalid(); }
}

/** Apply only an explicit, validated choice to a freshly minted copy. The source
 * compiler and download/export path continue producing clean, unbound drafts. An image, video or 3D node keeps the
 * media model the case chose: the agent model a member picks is not one that generates pictures. An agent that works in
 * its own sandbox computer (a flagship's: its task runs commands, checks and publishes files there) stays in it, and takes
 * the chosen model when the sandbox offers it, else the sandbox's own default model. */
export function createOfficialCopyDocument(item: OfficialWorkflow, model: OfficialCopyModel | null): CanvasDocument {
  const document = createOfficialDocument(item);
  if (!model) return document;
  return { ...document, nodes: document.nodes.map(node => {
    if (node.kind !== 'session' || mediaKindOf(node.agentKind)) return node;
    if (node.runtime === SANDBOX_RUNTIME) return { ...node, model: model.sandbox ? model.model : node.model, effort: '' };
    return { ...node, runtime: model.runtime, model: model.model, effort: '' };
  }) };
}

/** A production case's recorded run, whose deliveries the copy carries (productionCopy.ts). */
export type OfficialCopyRecording = { capturedOn: string; completed: number; total: number; model: string };
/** A recorded-canvas case (a film, recordedCanvas.ts): its canvas is stored beside its record, so the dialog knows it by
 * its title and how many nodes, and how many of them generate media, its copy holds; `sandboxed` when its agents work in
 * sandbox computers (a film written as code). */
export type RecordedCopyItem = { readonly id: string; readonly title: string; readonly recorded: { readonly nodes: number; readonly media: number; readonly sandboxed?: boolean } };

/** The copy dialog is part of the case flow, which reads in English in both interface languages (owner 2026-10-14). */
type Props = {
  item: OfficialWorkflow | RecordedCopyItem; tenantId: string; busy: boolean;
  error?: string; recording?: OfficialCopyRecording; onClose: () => void;
  onConfirm: (model: OfficialCopyModel | null) => Promise<void>;
};

export function OfficialCopySetup({ item, tenantId, busy, error, recording, onClose, onConfirm }: Props) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null);
  const [models, setModels] = useState<OfficialCopyModel[]>([]);
  const [selection, setSelection] = useState('');
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [catalogError, setCatalogError] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const submitting = useRef(false), lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { controller.abort(); dialog.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setCatalogError(false); setModels([]);
    void readOfficialCopyModels(tenantId, controller.signal).then(values => {
      if (!controller.signal.aborted) { setModels(values); setLoading(false); }
    }).catch(() => { if (!controller.signal.aborted) { setCatalogError(true); setLoading(false); } });
    return () => controller.abort();
  }, [tenantId, revision]);
  const chosen = models.find(model => modelKey(model) === selection);
  const recorded = 'recorded' in item ? item.recorded : null;
  const workflow = 'recorded' in item ? null : item;
  const sandboxed = workflow?.nodes.some(node => node.sandbox) === true || recorded?.sandboxed === true;
  const locked = busy || checking;
  const invalidChoice = selection !== '' && (!chosen || loading || catalogError);
  const close = () => { if (!busy && !checking && !submitting.current) onClose(); };
  const confirm = async () => {
    if (locked || submitting.current || invalidChoice || lifetime.current?.signal.aborted) return;
    submitting.current = true; setChecking(true); setSubmitError(null);
    try {
      let fresh: OfficialCopyModel | null = null;
      if (selection) {
        const current = await readOfficialCopyModels(tenantId, lifetime.current?.signal);
        if (lifetime.current?.signal.aborted) return;
        setModels(current);
        fresh = current.find(model => modelKey(model) === selection) || null;
        if (!fresh) throw new SaaSApiError(409, 'model_unavailable', 'The selected model is unavailable.');
      }
      if (!lifetime.current?.signal.aborted) await onConfirm(fresh);
    } catch (cause) { if (!lifetime.current?.signal.aborted) setSubmitError(cause); }
    finally { submitting.current = false; if (!lifetime.current?.signal.aborted) setChecking(false); }
  };
  const displayedError = submitError instanceof SaaSApiError && submitError.code === 'invalid_copy_catalog'
    ? 'The model catalog is invalid. Refresh it and choose again.'
    : submitError ? saasErrorMessage(submitError, 'en') : error;
  return <dialog ref={dialog} className="official-copy-setup" lang="en" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={event => { event.preventDefault(); void confirm(); }}>
      <header><span>PRODUCTION CASE</span><h2 id={`${id}-title`}>Copy example to my canvases</h2><p>{item.title}</p></header>
      <p id={`${id}-description`}>{recorded && !recorded.media
        // A film written as code: its picture and sound come from the page its agents write, not from media nodes.
        ? `Keep all ${recorded.nodes} nodes and their wires with the texts and settings the real run${recording ? ` on ${recording.capturedOn}` : ''} used: every agent’s task, the assembly’s template and the edit. Nothing is pre-filled: its first run writes every module, the page and the timeline again, and the edit renders the film and its sound from that page. Optionally choose one execution model for its agents.`
        : recorded
        ? `Keep all ${recorded.nodes} nodes and their wires with the texts and settings the real run${recording ? ` on ${recording.capturedOn}` : ''} used: every picture, clip, voice and score cue with its words, the editors’ briefs and the edits. Nothing is pre-filled: the film’s deliveries are files, which a copy does not carry, so its first run makes all ${recorded.media} pictures, clips and sounds again before any editor runs, and that takes a paid plan’s media allowance. New clips speak their lines at other moments and run to other lengths: the sync sheets in the editors’ briefs and the edits’ own timelines were measured on the case run’s clips and films, so measure and edit them again before cutting. Optionally choose one execution model for the editor agents.`
        : workflow && recording
        ? `Keep all ${workflow.nodes.length} nodes, dependencies and deliverable requirements, with what every agent received and delivered in the real run on ${recording.capturedOn} (${recording.completed}/${recording.total} nodes, marked “case recording”)${workflow.media?.length ? '; the media nodes, and the steps that use the files they made, make theirs again on the first run' : ''}${workflow.nodes.some(node => node.assemble?.file || node.assemble?.fileOnly) ? '; the assembly makes its file again on the first run, with no model' : ''}${workflow.nodes.some(node => node.handoff) ? '; the turns that hand their project on as a file run again on the first run, and so make the team session again' : ''}. Optionally choose one execution model for every new node.`
        : `Keep all ${workflow?.nodes.length ?? 0} nodes, dependencies and deliverable requirements. Optionally choose one execution model for every new node.`}</p>
      <label className="official-copy-model" htmlFor={`${id}-model`}>Execution model
        <select id={`${id}-model`} autoFocus value={selection} disabled={locked} onChange={event => { setSelection(event.target.value); setSubmitError(null); }}>
          <option value="">Draft only · choose models later</option>
          {selection && !chosen && <option value={selection} disabled>Previous selection unavailable · choose again</option>}
          {models.map(model => <option key={modelKey(model)} value={modelKey(model)}>{model.label}</option>)}
        </select>
      </label>
      {chosen && <div className="official-copy-selection"><strong>{recorded ? recorded.media ? 'Applies to the editor agents' : 'Applies to its agents' : 'Applies to every new node'}</strong><span>{chosen.label}</span>
        {sandboxed && <small>{chosen.sandbox
          ? 'Its agents keep working in their sandbox computers, on this model.'
          : 'This model does not run in a sandbox computer, so its agents keep working there on the sandbox’s own model.'}</small>}</div>}
      <div className="official-copy-catalog" aria-live="polite">
        {loading ? <p role="status">Loading models for this workspace…</p>
          : catalogError ? <p role="alert">Could not load the model catalog. Refresh it, or copy an unconfigured draft.</p>
            : !models.length ? <p role="status">No model is available to this workspace. You can still copy a draft.</p> : null}
        <button type="button" className="saas-link" disabled={locked || loading} onClick={() => { setSubmitError(null); setRevision(value => value + 1); }}>Refresh model catalog</button>
      </div>
      <p className="official-copy-note">This only creates a canvas; it does not initialize nodes or run models. Check the configuration in your canvas before starting a run.
        {recording && !recorded && ` The case recordings were made by ${recording.model}, not run in your workspace; running the graph replaces them with your own results.`}</p>
      {displayedError && <p className="saas-error" role="alert">{displayedError}</p>}
      <footer><button type="button" disabled={busy || checking} onClick={close}>Cancel</button><button type="submit" className="saas-primary" disabled={locked || invalidChoice}>
        {busy ? 'Creating…' : checking ? 'Checking model…' : selection ? 'Copy with model' : 'Create draft'}
      </button></footer>
    </form>
  </dialog>;
}
