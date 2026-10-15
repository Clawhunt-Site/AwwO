import { useEffect, useId, useRef, useState } from 'react';
import { api, SaaSApiError, saasErrorMessage, tenantPath } from '../api';
import { runtimeDefinitions, runtimeModels, withPlanTag, type SaaSRuntimeStatus } from '../runtimeCatalog';
import type { CanvasDocument } from '../../canvas/canvasDoc';
import { mediaKindOf } from '../../canvas/mediaCatalog';
import { createOfficialDocument, type OfficialWorkflow } from './officialWorkflows';
import './official-copy-setup.css';

export type OfficialCopyModel = { runtime: string; model: string; label: string };
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
    return runtimeDefinitions(status).filter(runtime => runtime.available && runtime.configured).flatMap(runtime =>
      runtimeModels(status, runtime.id).map(model => {
        const value = { runtime: runtime.id, model: model.id, label: withPlanTag(`${runtime.name} · ${model.label || model.name || model.id}`, model) };
        const key = modelKey(value);
        if (seen.has(key)) throw invalid();
        seen.add(key);
        return value;
      }));
  } catch { throw invalid(); }
}

/** Apply only an explicit, validated choice to a freshly minted copy. The source
 * compiler and download/export path continue producing clean, unbound drafts. An image, video or 3D node keeps the
 * media model the case chose: the agent model a member picks is not one that generates pictures. */
export function createOfficialCopyDocument(item: OfficialWorkflow, model: OfficialCopyModel | null): CanvasDocument {
  const document = createOfficialDocument(item);
  if (!model) return document;
  return { ...document, nodes: document.nodes.map(node => node.kind === 'session' && !mediaKindOf(node.agentKind)
    ? { ...node, runtime: model.runtime, model: model.model, effort: '' } : node) };
}

/** A production case's recorded run, whose deliveries the copy carries (productionCopy.ts). */
export type OfficialCopyRecording = { capturedOn: string; completed: number; total: number; model: string };

/** The copy dialog is part of the case flow, which reads in English in both interface languages (owner 2026-10-14). */
type Props = {
  item: OfficialWorkflow; tenantId: string; busy: boolean;
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
      <p id={`${id}-description`}>{recording
        ? `Keep all ${item.nodes.length} nodes, dependencies and deliverable requirements, with what every agent received and delivered in the real run on ${recording.capturedOn} (${recording.completed}/${recording.total} nodes, marked “case recording”)${item.media?.length ? '; the media nodes, and the steps that use the files they made, make theirs again on the first run' : ''}. Optionally choose one execution model for every new node.`
        : `Keep all ${item.nodes.length} nodes, dependencies and deliverable requirements. Optionally choose one execution model for every new node.`}</p>
      <label className="official-copy-model" htmlFor={`${id}-model`}>Execution model
        <select id={`${id}-model`} autoFocus value={selection} disabled={locked} onChange={event => { setSelection(event.target.value); setSubmitError(null); }}>
          <option value="">Draft only · choose models later</option>
          {selection && !chosen && <option value={selection} disabled>Previous selection unavailable · choose again</option>}
          {models.map(model => <option key={modelKey(model)} value={modelKey(model)}>{model.label}</option>)}
        </select>
      </label>
      {chosen && <div className="official-copy-selection"><strong>Applies to every new node</strong><span>{chosen.label}</span></div>}
      <div className="official-copy-catalog" aria-live="polite">
        {loading ? <p role="status">Loading models for this workspace…</p>
          : catalogError ? <p role="alert">Could not load the model catalog. Refresh it, or copy an unconfigured draft.</p>
            : !models.length ? <p role="status">No model is available to this workspace. You can still copy a draft.</p> : null}
        <button type="button" className="saas-link" disabled={locked || loading} onClick={() => { setSubmitError(null); setRevision(value => value + 1); }}>Refresh model catalog</button>
      </div>
      <p className="official-copy-note">This only creates a canvas; it does not initialize nodes or run models. Check the configuration in your canvas before starting a run.
        {recording && ` The case recordings were made by ${recording.model}, not run in your workspace; running the graph replaces them with your own results.`}</p>
      {displayedError && <p className="saas-error" role="alert">{displayedError}</p>}
      <footer><button type="button" disabled={busy || checking} onClick={close}>Cancel</button><button type="submit" className="saas-primary" disabled={locked || invalidChoice}>
        {busy ? 'Creating…' : checking ? 'Checking model…' : selection ? 'Copy with model' : 'Create draft'}
      </button></footer>
    </form>
  </dialog>;
}
