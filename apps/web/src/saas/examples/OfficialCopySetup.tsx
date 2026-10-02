import { useEffect, useId, useRef, useState } from 'react';
import { api, SaaSApiError, saasErrorMessage, tenantPath } from '../api';
import { runtimeDefinitions, runtimeModels, type SaaSRuntimeStatus } from '../runtimeCatalog';
import type { CanvasDocument } from '../../canvas/canvasDoc';
import type { UiLocale } from '../../locale';
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
        const value = { runtime: runtime.id, model: model.id, label: `${runtime.name} · ${model.label || model.name || model.id}` };
        const key = modelKey(value);
        if (seen.has(key)) throw invalid();
        seen.add(key);
        return value;
      }));
  } catch { throw invalid(); }
}

/** Apply only an explicit, validated choice to a freshly minted copy. The source
 * compiler and download/export path continue producing clean, unbound drafts. */
export function createOfficialCopyDocument(item: OfficialWorkflow, locale: UiLocale, model: OfficialCopyModel | null): CanvasDocument {
  const document = createOfficialDocument(item, locale);
  if (!model) return document;
  return { ...document, nodes: document.nodes.map(node => node.kind === 'session'
    ? { ...node, runtime: model.runtime, model: model.model, effort: '' } : node) };
}

type Props = {
  item: OfficialWorkflow; tenantId: string; locale: UiLocale; busy: boolean;
  readOnly?: boolean; error?: string; onClose: () => void;
  onConfirm: (model: OfficialCopyModel | null) => Promise<void>;
};

export function OfficialCopySetup({ item, tenantId, locale, busy, readOnly = false, error, onClose, onConfirm }: Props) {
  const t = (zh: string, en: string) => locale === 'zh' ? zh : en;
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
    if (readOnly) { setLoading(false); return () => controller.abort(); }
    void readOfficialCopyModels(tenantId, controller.signal).then(values => {
      if (!controller.signal.aborted) { setModels(values); setLoading(false); }
    }).catch(() => { if (!controller.signal.aborted) { setCatalogError(true); setLoading(false); } });
    return () => controller.abort();
  }, [tenantId, readOnly, revision]);
  const chosen = models.find(model => modelKey(model) === selection);
  const locked = busy || checking || readOnly;
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
    ? t('模型目录返回异常，请刷新后重新选择。', 'The model catalog is invalid. Refresh it and choose again.')
    : submitError ? saasErrorMessage(submitError, locale) : error;
  return <dialog ref={dialog} className="official-copy-setup" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={event => { event.preventDefault(); void confirm(); }}>
      <header><span>{t('官方工作流', 'OFFICIAL WORKFLOW')}</span><h2 id={`${id}-title`}>{t('复制案例到我的画布', 'Copy example to my canvases')}</h2><p>{item.title[locale]}</p></header>
      <p id={`${id}-description`}>{t(`保留 ${item.nodes.length} 个节点、依赖和交付要求。可为所有新节点选择同一个执行模型。`, `Keep all ${item.nodes.length} nodes, dependencies and deliverable requirements. Optionally choose one execution model for every new node.`)}</p>
      <label className="official-copy-model" htmlFor={`${id}-model`}>{t('执行模型', 'Execution model')}
        <select id={`${id}-model`} autoFocus value={selection} disabled={locked} onChange={event => { setSelection(event.target.value); setSubmitError(null); }}>
          <option value="">{t('仅复制草稿 · 稍后配置模型', 'Draft only · choose models later')}</option>
          {selection && !chosen && <option value={selection} disabled>{t('原选择暂不可用 · 请重新选择', 'Previous selection unavailable · choose again')}</option>}
          {models.map(model => <option key={modelKey(model)} value={modelKey(model)}>{model.label}</option>)}
        </select>
      </label>
      {chosen && <div className="official-copy-selection"><strong>{t('应用于所有新节点', 'Applies to every new node')}</strong><span>{chosen.label}</span></div>}
      <div className="official-copy-catalog" aria-live="polite">
        {loading ? <p role="status">{t('正在读取当前工作区模型…', 'Loading models for this workspace…')}</p>
          : catalogError ? <p role="alert">{t('暂时无法读取模型目录。可刷新重试，或仅复制未配置的草稿。', 'Could not load the model catalog. Refresh it, or copy an unconfigured draft.')}</p>
            : !models.length && !readOnly ? <p role="status">{t('当前工作区没有可选模型，仍可复制草稿。', 'No model is available to this workspace. You can still copy a draft.')}</p> : null}
        <button type="button" className="saas-link" disabled={locked || loading} onClick={() => { setSubmitError(null); setRevision(value => value + 1); }}>{t('刷新模型目录', 'Refresh model catalog')}</button>
      </div>
      <p className="official-copy-note">{t('此次只创建画布，不初始化、不运行模型。进入画布后检查配置，再开始运行。', 'This only creates a canvas; it does not initialize nodes or run models. Check the configuration in your canvas before starting a run.')}</p>
      {readOnly && <p role="alert">{t('复制画布需要工作区编辑权限。', 'Editing access is required to copy a canvas.')}</p>}
      {displayedError && <p className="saas-error" role="alert">{displayedError}</p>}
      <footer><button type="button" disabled={busy || checking} onClick={close}>{t('取消', 'Cancel')}</button><button type="submit" className="saas-primary" disabled={locked || invalidChoice}>
        {busy ? t('正在创建…', 'Creating…') : checking ? t('正在核对模型…', 'Checking model…') : selection ? t('带模型复制', 'Copy with model') : t('创建草稿', 'Create draft')}
      </button></footer>
    </form>
  </dialog>;
}
