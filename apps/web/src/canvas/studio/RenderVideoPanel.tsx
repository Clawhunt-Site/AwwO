// 渲染为视频 — turns the page the studio is showing into an MP4 (with a GIF and a contact sheet if asked) on the
// server's render worker (renders.go, apps/render-worker). What is sent is the document the studio built and runs,
// with the page's files inlined, so the video shows what is on screen. A cloud canvas only, for members of a
// workspace whose server enables rendering; the finished files are the canvas's own media and download like any other.
import { useEffect, useRef, useState } from 'react';
import { Clapperboard, Download, Loader2, Square, X } from 'lucide-react';
import { useCanvasI18n, type CanvasTextKey } from '../i18n';
import { SaaSApiError, saasErrorMessage } from '../../saas/api';
import { currentSaaSCanvas, storedMediaUrl } from '../../saas/canvasBridge';
import { readCapabilities, type WorkspaceCapabilities } from '../../saas/capabilitiesApi';
import { cancelRender, listRenders, readRender, RENDER_PRESETS, startRender, type RenderJob, type RenderParams } from '../../saas/rendersApi';

type RenderCapability = WorkspaceCapabilities['render'];
type PresetId = typeof RENDER_PRESETS[number]['id'];
const FPS_CHOICES = [24, 30, 60] as const;
const POLL_MS = 1500;
/** Status reads that may fail in a row (a restart, a network blip) before the panel says so; it keeps reading. */
const QUIET_FAILURES = 3;
const ERROR_CODES = new Set(['render_busy', 'render_quota', 'render_unavailable', 'timeout', 'render_page_failed', 'render_output_too_large',
  'render_invalid_output', 'render_rejected', 'cancelled', 'interrupted', 'media_storage_full', 'render_failed', 'render_storage_failed', 'render_too_large', 'invalid_render']);
const WARNING_CODES = new Set(['gif_too_large', 'gif_fps_reduced', 'contact_too_large', 'gif_failed', 'contact_failed', 'ready_timeout', 'fonts_timeout',
  'timer_limit', 'network_blocked', 'page_errors', 'still_too_large', 'probe_frames']);
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const active = (job: RenderJob | null) => job?.status === 'queued' || job?.status === 'running';
/** SHA-256 of the page as the server hashes it (its UTF-8 bytes), to tell which page a stored render was made from. */
async function pageHash(html: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Whether this canvas can render at all: a cloud canvas, a member's role in an active workspace and a server with
 *  a render worker (a reader would only be refused). Read once per workspace. */
export function useRenderCapability(): RenderCapability | null {
  const tenant = currentSaaSCanvas()?.tenant ?? null;
  const tenantId = tenant && tenant.role !== 'reader' && tenant.status === 'active' ? tenant.id : null;
  const [value, setValue] = useState<RenderCapability | null>(null);
  useEffect(() => {
    if (!tenantId) { setValue(null); return; }
    const controller = new AbortController();
    readCapabilities(tenantId, controller.signal).then(result => setValue(result.render.enabled ? result.render : null), () => { if (!controller.signal.aborted) setValue(null); });
    return () => controller.abort();
  }, [tenantId]);
  return value;
}

interface Props {
  nodeId: string;
  pageName: string;
  capability: RenderCapability;
  /** The live document the studio built for this page, or null until the page on screen has been built. */
  documentOf: () => string | null;
  /** Changes whenever a page finishes building, so a panel opened before its page was ready looks again. */
  documentVersion?: number;
  onClose: () => void;
}

export function RenderVideoPanel({ nodeId, pageName, capability, documentOf, documentVersion = 0, onClose }: Props) {
  const { t, locale } = useCanvasI18n();
  const scope = currentSaaSCanvas();
  const [preset, setPreset] = useState<PresetId>('landscape');
  const [seconds, setSeconds] = useState(6);
  const [fps, setFps] = useState<number>(30);
  const [loop, setLoop] = useState(false);
  const [gif, setGif] = useState(false);
  const [contact, setContact] = useState(false);
  const [job, setJob] = useState<RenderJob | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [used, setUsed] = useState(capability.usedToday);
  const [failures, setFailures] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // The worker's warnings are codes, some with a count (network_blocked:3); static_page is said by renderStatic.
  const warning = (raw: string): string => {
    const [code, count = ''] = raw.split(':');
    return WARNING_CODES.has(code) ? t(`studio.renderWarning.${code}` as CanvasTextKey, { count }) : raw;
  };
  const message = (cause: unknown): string => {
    const code = cause instanceof SaaSApiError ? cause.code : typeof cause === 'string' ? cause : '';
    if (ERROR_CODES.has(code)) return t(`studio.renderError.${code}` as CanvasTextKey);
    return typeof cause === 'string' ? t('studio.renderError.render_failed') : saasErrorMessage(cause, locale);
  };
  // Today's count as the server keeps it: it gives back renders that failed through no fault of the workspace.
  const refreshUsage = () => {
    if (!scope) return;
    readCapabilities(scope.tenant.id).then(value => { if (alive.current) setUsed(value.render.usedToday); }, () => undefined);
  };

  // Today's count is read again when the panel opens: the studio read it once, and renders since then changed it.
  useEffect(() => { refreshUsage(); }, [scope?.tenant.id]);

  // The latest render made from this very page (a node's pages and earlier deliveries share its node id): one
  // still going is followed again, a finished one is shown. A render started meanwhile is never replaced.
  useEffect(() => {
    const html = documentOf();
    if (!scope || !html) return;
    const controller = new AbortController();
    Promise.all([listRenders(scope.tenant.id, scope.canvasId, nodeId, controller.signal), pageHash(html)])
      .then(([items, hash]) => { const match = items.find(item => item.htmlSha256 === hash); if (match && alive.current) setJob(current => current ?? match); }, () => undefined);
    return () => controller.abort();
  }, [scope?.tenant.id, scope?.canvasId, nodeId, documentVersion]);
  useEffect(() => {
    if (!scope || !job || !active(job)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      readRender(scope.tenant.id, scope.canvasId, job.id, controller.signal).then(value => {
        if (!alive.current) return;
        // Only the polling's own error goes away with a good read; a failed Stop says so until the next action.
        if (failures >= QUIET_FAILURES) setProblem(null);
        setFailures(0); setJob(value);
        if (!active(value)) refreshUsage();
      }, cause => {
        if (!alive.current || controller.signal.aborted) return;
        setFailures(count => count + 1);
        if (failures + 1 >= QUIET_FAILURES) setProblem(message(cause));
      });
    }, POLL_MS * Math.min(2 ** failures, 8));
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [scope?.tenant.id, scope?.canvasId, job, failures]);

  if (!scope) return null;
  const size = RENDER_PRESETS.find(item => item.id === preset) ?? RENDER_PRESETS[0];
  const limits = capability.limits;
  const frames = Math.round(seconds * fps);
  const valid = seconds >= 0.5 && seconds <= limits.maxSeconds && frames >= 1 && frames <= limits.maxFrames && fps <= limits.maxFps;
  const exhausted = used >= capability.perDay;
  const start = async () => {
    const html = documentOf();
    if (!html) { setProblem(t('studio.renderNotReady')); return; }
    const htmlBytes = bytes(html);
    if (htmlBytes > limits.maxHtmlBytes) { setProblem(t('studio.renderTooLarge', { size: `${(htmlBytes / 1048576).toFixed(1)} MB`, max: `${Math.round(limits.maxHtmlBytes / 1048576)} MB` })); return; }
    const params: RenderParams = { width: size.width, height: size.height, fps, seconds, loop, gif, contact };
    setStarting(true); setProblem(null);
    try {
      const value = await startRender(scope.tenant.id, scope.canvasId, { ...params, nodeId, html, operationId: `render-${crypto.randomUUID()}` });
      if (!alive.current) return;
      setFailures(0); setJob(value); setUsed(count => count + 1);
    } catch (cause) { if (alive.current) { setProblem(message(cause)); refreshUsage(); } }
    finally { if (alive.current) setStarting(false); }
  };
  const stop = async () => {
    if (!job) return;
    try { const value = await cancelRender(scope.tenant.id, scope.canvasId, job.id); if (alive.current) { setJob(value); refreshUsage(); } }
    catch (cause) { if (alive.current) setProblem(message(cause)); }
  };
  const outputs = job?.status === 'completed' ? job.result.outputs ?? [] : [];
  const video = outputs.find(item => item.kind === 'mp4');
  const videoUrl = video ? storedMediaUrl(video.artifactId) : null;
  const jobFrames = job ? job.result.frames ?? Math.round((job.params.seconds ?? 0) * (job.params.fps ?? 0)) : 0;
  const mode = job?.result.mode === 'contract' ? t('studio.renderModeContract') : t('studio.renderModeVirtual');

  return <section className="awwo-studio-render" aria-label={t('studio.renderTitle')}>
    <header><Clapperboard size={15} aria-hidden="true" /><h3>{t('studio.renderTitle')}</h3>
      <button type="button" className="awwo-studio-icon" aria-label={t('studio.renderClose')} title={t('studio.renderClose')} onClick={onClose}><X size={15} aria-hidden="true" /></button></header>
    <p className="awwo-studio-render-hint">{t('studio.renderHint')}</p>
    <div className="awwo-studio-render-form">
      <label>{t('studio.renderSize')}<select value={preset} disabled={active(job) || starting} onChange={event => setPreset(event.target.value as PresetId)}>
        {RENDER_PRESETS.map(item => <option key={item.id} value={item.id}>{t(`studio.renderPreset.${item.id}` as CanvasTextKey)}</option>)}</select></label>
      <label>{t('studio.renderSeconds')}<input type="number" min={0.5} max={limits.maxSeconds} step={0.5} value={seconds} disabled={active(job) || starting}
        onChange={event => setSeconds(Math.min(limits.maxSeconds, Math.max(0.5, Number(event.target.value) || 0.5)))} /></label>
      <label>{t('studio.renderFps')}<select value={fps} disabled={active(job) || starting} onChange={event => setFps(Number(event.target.value))}>
        {FPS_CHOICES.filter(value => value <= limits.maxFps).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="is-check"><input type="checkbox" checked={loop} disabled={active(job) || starting} onChange={event => setLoop(event.target.checked)} />{t('studio.renderLoop')}</label>
      <label className="is-check"><input type="checkbox" checked={gif} disabled={active(job) || starting} onChange={event => setGif(event.target.checked)} />{t('studio.renderGif')}</label>
      <label className="is-check"><input type="checkbox" checked={contact} disabled={active(job) || starting} onChange={event => setContact(event.target.checked)} />{t('studio.renderContact')}</label>
    </div>
    <p className="awwo-studio-render-usage">{t('studio.renderUsage', { used, total: capability.perDay })} · {t('studio.renderFrames', { frames, width: size.width, height: size.height })}</p>
    {!valid && <p className="awwo-studio-render-problem" role="alert">{t('studio.renderError.invalid_render')}</p>}
    <div className="awwo-studio-render-actions">
      {active(job)
        ? <button type="button" className="awwo-studio-action" onClick={() => { void stop(); }}><Square size={13} aria-hidden="true" />{t('studio.renderStop')}</button>
        : <button type="button" className="awwo-studio-action is-primary" disabled={starting || !valid || exhausted} onClick={() => { void start(); }}>
          {starting ? <Loader2 size={14} aria-hidden="true" className="awwo-studio-spin" /> : <Clapperboard size={14} aria-hidden="true" />}{t('studio.renderStart')}</button>}
    </div>
    {problem && <p className="awwo-studio-render-problem" role="alert">{problem}</p>}
    {job && <div className="awwo-studio-render-result" role="status">
      {active(job) ? <p><Loader2 size={14} aria-hidden="true" className="awwo-studio-spin" />{job.status === 'queued' ? t('studio.renderQueued') : t('studio.renderRunning', { frames: jobFrames })}</p>
        : job.status === 'completed' ? <>
          <p>{t('studio.renderDone', { frames: jobFrames, mode })}</p>
          {job.result.distinctFrames !== undefined && job.result.distinctFrames <= 1 && <p className="awwo-studio-render-problem">{t('studio.renderStatic')}</p>}
          {videoUrl && <video src={videoUrl} controls playsInline loop={job.params.loop} preload="metadata" />}
          <ul>{outputs.map(item => { const url = storedMediaUrl(item.artifactId); return url && <li key={item.artifactId}>
            <a href={url} download={`${pageName.replace(/\.[^.]+$/, '')}-${item.name}`}><Download size={13} aria-hidden="true" />{t('studio.renderDownload', { name: item.name })}</a></li>; })}</ul>
          {!!job.result.warnings?.filter(item => item !== 'static_page').length && <p className="awwo-studio-render-note">{t('studio.renderWarnings', { notes: job.result.warnings.filter(item => item !== 'static_page').map(warning).join(' ') })}</p>}
          {!!job.result.pageErrors?.length && <p className="awwo-studio-render-note">{t('studio.renderPageErrors', { errors: job.result.pageErrors.join('; ') })}</p>}
        </>
        : <p className="awwo-studio-render-problem">{job.errorCode === 'render_busy' ? t('studio.renderBusyJob')
          : t('studio.renderFailed', { reason: message(job.status === 'cancelled' ? 'cancelled' : job.errorCode ?? 'render_failed') })}</p>}
    </div>}
  </section>;
}
