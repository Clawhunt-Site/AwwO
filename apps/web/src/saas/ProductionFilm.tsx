import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDown, Copy, Download, Maximize2, Minimize2 } from 'lucide-react';
import { formatDuration, loadProductionMediaManifest, type ProductionMediaFile, type ProductionRunMedia, type ProductionRunNode, type ProductionRunRecord } from './productionRuns';
import type { ProductionCase } from './productionCatalog';
import { renderRecordMarkdown, StatusChip } from './productionMadeParts';
import './production-made.css';

/** What each kind of media node is called in the dialog (it reads in English in both interface languages). */
const KIND: Readonly<Record<ProductionRunMedia['kind'], { one: string; many: string }>> = {
  image: { one: 'Picture', many: 'pictures' }, video: { one: 'Clip', many: 'clips' }, audio: { one: 'Sound', many: 'sounds' }, model3d: { one: '3D model', many: '3D models' },
};
const counted = (count: number, kind: ProductionRunMedia['kind']) => `${count} ${count === 1 ? KIND[kind].one.toLowerCase() : KIND[kind].many}`;
const megabytes = (bytes: number) => `${Math.round(bytes / 1e6).toLocaleString('en')} MB`;
/** m:ss, from the whole seconds (59.7 s is 1:00, never 0:60). */
const clock = (seconds: number) => { const total = Math.max(0, Math.round(seconds)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`; };
type Selected = { kind: 'node'; node: ProductionRunNode } | { kind: 'media'; media: ProductionRunMedia };

/** The film's subtitles as a WebVTT blob for the <track>: the file is fetched as text and typed here, so the player gets
 * text/vtt whatever type the server answers with (a track of any other type is refused by some browsers). */
function useSubtitleTrack(file: ProductionMediaFile | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== 'function') { setUrl(undefined); return; }
    let live = true, made: string | undefined;
    fetch(file.src, { credentials: 'omit' }).then(response => (response.ok ? response.text() : Promise.reject(new Error('subtitles')))).then(text => {
      if (!live || !text.startsWith('WEBVTT')) return;
      made = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
      setUrl(made);
    }).catch(() => { /* the film plays without its subtitles */ });
    return () => { live = false; if (made) URL.revokeObjectURL(made); setUrl(undefined); };
  }, [file]);
  return url;
}

/**
 * How a film case was made, and the film (a recorded-canvas case, recordedCanvas.ts): its canvas stage by stage (the
 * pictures, keyframes, voices and score; the clips made from them; the editor agents who wrote each reel's timeline; the
 * edits that joined them), what every node was asked and delivered, and the film the last edit delivered, streamed from
 * this site. Everything shown comes from the run record and the files published beside it.
 */
export default function ProductionFilm({ item, record, onCopy, loadManifest = loadProductionMediaManifest }: {
  item: ProductionCase; record: ProductionRunRecord; onCopy?: () => void; loadManifest?: typeof loadProductionMediaManifest;
}) {
  const id = useId();
  const [manifest, setManifest] = useState<Readonly<Record<string, ProductionMediaFile>> | null | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [filmFailed, setFilmFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  // Read through a ref, so a loader passed inline (a new function each render) does not start a load each render.
  const loader = useRef(loadManifest);
  loader.current = loadManifest;
  useEffect(() => {
    let live = true;
    setManifest(undefined);
    loader.current(item.id).then(value => { if (live) setManifest(value); }, () => { if (live) setManifest(null); });
    return () => { live = false; };
  }, [item.id, attempt]);
  const media = useMemo(() => record.media ?? [], [record]);
  const deliveryNode = record.nodes.find(node => node.id === record.artifactNodeId);
  const film = deliveryNode?.film;
  const filmFile = film && manifest ? manifest[`${deliveryNode.id}/${film.name}`] : undefined;
  const subtitlesFile = film && manifest ? manifest[`${deliveryNode.id}/${film.name.replace(/\.mp4$/i, '.vtt')}`] : undefined;
  const subtitles = useSubtitleTrack(subtitlesFile);
  const stills = useMemo(() => !deliveryNode || !manifest ? [] : Object.entries(manifest)
    .filter(([key]) => key.startsWith(`${deliveryNode.id}/still-`)).sort(([a], [b]) => a.localeCompare(b)).map(([, file]) => file), [deliveryNode, manifest]);
  const poster = (file: string) => manifest?.[`${file}#poster`]?.src;

  // Stages by dependency depth, as the publisher numbered them: agents and edits, and the media nodes beside them.
  const columns = [...new Set([...record.nodes.map(node => node.column), ...media.flatMap(value => value.column ?? [])])].sort((a, b) => a - b);
  const stageLabel = (column: number) => String(columns.indexOf(column) + 1).padStart(2, '0');
  const titleOf = (target: string) => record.nodes.find(node => node.id === target)?.title ?? media.find(value => value.id === target)?.title ?? target;
  const selected: Selected = (() => {
    const node = record.nodes.find(value => value.id === (selectedId ?? deliveryNode?.id));
    if (node) return { kind: 'node', node };
    const value = media.find(entry => entry.id === selectedId);
    return value ? { kind: 'media', media: value } : { kind: 'node', node: record.nodes[0] };
  })();
  const selectedKey = selected.kind === 'node' ? selected.node.id : selected.media.id;
  const inputs = record.edges.filter(edge => edge.to === selectedKey), outputs = record.edges.filter(edge => edge.from === selectedKey);
  // Many wires arrive at an editor or an edit (every clip, take and cue): they are summed by kind, and only agents, edits
  // and a media node's own sources are listed one by one.
  const summarise = (ids: ReadonlyArray<string>) => {
    const counts = new Map<string, number>();
    for (const value of ids) { const entry = media.find(other => other.id === value); if (entry) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1); }
    return [...counts].map(([kind, count]) => counted(count, kind as ProductionRunMedia['kind'])).join(', ');
  };
  const listed = (ids: ReadonlyArray<string>) => [...new Set(selected.kind === 'media' || ids.length <= 6 ? ids : ids.filter(value => record.nodes.some(node => node.id === value)))];
  // A still plays the film from its moment; a refused play (no user gesture yet, say) leaves it paused there.
  const seek = (seconds: number) => {
    const element = video.current;
    if (!element) return;
    element.currentTime = seconds;
    const playing = element.play() as Promise<void> | undefined;
    playing?.catch(() => {});
  };
  const agents = record.nodes.filter(node => node.kind !== 'edit' && node.kind !== 'assemble').length, edits = record.nodes.filter(node => node.kind === 'edit').length;
  const nodesDone = record.completed + media.filter(value => value.status === 'done').length;
  // The moment a still shows. The render worker takes one every N seconds (the timeline's stillsEverySeconds) with
  // ffmpeg's fps=1/N, which rounds each frame to the nearest step and keeps the last of a step: still n is the frame just
  // before (n − ½) × N (measured on THE LONG CHORD's act, 2026-10-20: each still matches that frame at 43 dB, the frame
  // at (n − 1) × N at 11 to 20); the seek goes to the middle of that frame, never onto the edge before it. Without the
  // interval, the film's length shared evenly.
  const stillAt = (index: number) => !film ? 0 : film.stillsEverySeconds ? Math.max(0, (index + 0.5) * film.stillsEverySeconds - 0.5 / film.fps)
    : stills.length ? index * (film.seconds / stills.length) : 0;
  const retryFilm = () => { if (!filmFile) { setAttempt(value => value + 1); return; } setFilmFailed(false); video.current?.load(); };

  return <section className={`production-made production-film${focused ? ' is-result-focused' : ''}`} lang="en" aria-labelledby={`${id}-title`}>
    <header className="production-made-heading">
      <div><span className="production-eyebrow"><span />HOW IT WAS MADE</span>
        <h3 id={`${id}-title`}>{`${agents} ${agents === 1 ? 'agent' : 'agents'}, ${media.length} media nodes, ${edits} ${edits === 1 ? 'edit' : 'edits'}, ${columns.length} stages, ${record.runs && record.activeSeconds !== undefined
          ? `${formatDuration(record.activeSeconds, 'en')} in ${record.runs} runs` : `${formatDuration(record.seconds, 'en')} end to end`}`}</h3>
        <p className="production-made-receipt"><span className="production-label is-real">Real run</span>
          <span>{record.model}</span><span>{record.capturedOn}</span><span>{`${nodesDone}/${record.total + media.length} nodes done`}</span></p></div>
      {onCopy && <button type="button" className="production-made-reuse" onClick={onCopy}><Copy size={14} aria-hidden="true" />Copy this canvas</button>}
    </header>
    <div className="production-made-grid">
      <div className="production-made-process" hidden={focused}>
        <ol className="production-made-stages production-film-stages" aria-label="Every node, stage by stage">
          {columns.map(column => {
            const here = media.filter(value => value.column === column), nodes = record.nodes.filter(node => node.column === column).sort((a, b) => a.row - b.row);
            const kinds = [...new Set(here.map(value => value.kind))];
            return <li key={column}>
              <span className="production-made-stage">{stageLabel(column)}{here.length + nodes.length > 1 && <small>{`${here.length + nodes.length} in parallel`}</small>}</span>
              <div>
                {kinds.map(kind => <div key={kind} role="group" className="production-film-strip" aria-label={counted(here.filter(value => value.kind === kind).length, kind)}>
                  <span aria-hidden="true">{counted(here.filter(value => value.kind === kind).length, kind)}</span>
                  <ul>{here.filter(value => value.kind === kind).sort((a, b) => (a.row ?? 0) - (b.row ?? 0)).map(value => {
                    const url = value.files[0] ? poster(value.files[0]) : undefined;
                    return <li key={value.id}><button type="button" aria-pressed={selectedKey === value.id} aria-controls={`${id}-node`} onClick={() => setSelectedId(value.id)} title={value.title}>
                      {kind === 'audio' ? <i aria-hidden="true">♪</i> : url ? <img src={url} alt="" loading="lazy" decoding="async" /> : <i aria-hidden="true" />}
                      <span>{value.title}</span></button></li>;
                  })}</ul>
                </div>)}
                {nodes.length > 0 && <div className="production-film-nodes">{nodes.map(node => <button type="button" key={node.id} aria-pressed={selectedKey === node.id} aria-controls={`${id}-node`} onClick={() => setSelectedId(node.id)}>
                  <span>{node.title}</span><StatusChip status={node.status} />{node.seconds !== undefined && <small>{formatDuration(node.seconds, 'en')}</small>}
                </button>)}</div>}
              </div>
            </li>;
          })}
        </ol>
        <article className="production-made-node" id={`${id}-node`}>
          {selected.kind === 'node' ? <NodeDetail node={selected.node} /> : <MediaDetail media={selected.media} poster={selected.media.files[0] ? poster(selected.media.files[0]) : undefined} />}
          {inputs.length > 0 && <div className="production-made-links"><span>RECEIVED</span>
            {listed(inputs.map(edge => edge.from)).map(from => <button type="button" key={from} onClick={() => setSelectedId(from)}>{`${titleOf(from)} · ${inputs.find(edge => edge.from === from)?.label}`}</button>)}
            {selected.kind === 'node' && inputs.length > 6 && <em>{summarise(inputs.map(edge => edge.from))}</em>}</div>}
          {outputs.length > 0 && <div className="production-made-links"><span>HANDED TO</span>
            {listed(outputs.map(edge => edge.to)).map(to => <button type="button" key={to} onClick={() => setSelectedId(to)}>{titleOf(to)}</button>)}
            {outputs.length > 6 && selected.kind === 'node' && <em>{summarise(outputs.map(edge => edge.to))}</em>}</div>}
        </article>
      </div>
      <div className="production-made-result production-film-result">
        <header><span>{film ? `The delivered film · ${clock(film.seconds)} · ${film.width}×${film.height}` : 'Delivery'}</span>
          {film && <div><button type="button" aria-pressed={focused} onClick={() => setFocused(value => !value)}>{focused ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}Focus the film</button></div>}</header>
        {!film || deliveryNode?.status !== 'done' ? <p className="production-made-empty">This run did not deliver the film; the failed and blocked nodes are on the left.</p>
          : manifest === undefined ? <p className="production-made-empty" role="status">Loading the film…</p>
            : !filmFile || filmFailed ? <p className="production-made-empty" role="alert">The film could not be loaded.<button type="button" onClick={retryFilm}>Try again</button></p>
              : null}
        {filmFile && <video ref={video} className="production-film-player" hidden={filmFailed} controls preload="metadata" playsInline poster={stills[0]?.src} src={filmFile.src}
          onError={() => setFilmFailed(true)} aria-label={`${item.title}: the film an AwwO run delivered`}>
          {subtitles && <track kind="subtitles" srcLang="en" label="English" src={subtitles} default />}
        </video>}
        {stills.length > 0 && filmFile && !filmFailed && <div className="production-film-stills" role="group" aria-label="Stills from the film">
          {stills.map((still, index) => <button type="button" key={still.src} onClick={() => seek(stillAt(index))} aria-label={`Play from ${clock(stillAt(index))}`}>
            <img src={still.src} alt="" loading="lazy" decoding="async" /></button>)}</div>}
        {filmFile && film && <p className="production-made-hint">{`It plays as the last edit delivered it, re-encoded for the web (${megabytes(filmFile.bytes)}); its sound is the film's own track. No frame or sound of it was changed outside AwwO; where the operator's own measurements and scripts took part, "What happened" says so.`}
          {filmFile.original && <> <a className="production-film-download" href={filmFile.original.src} download={film.name}><Download size={12} aria-hidden="true" />{`Download ${film.name} as delivered (${film.width}×${film.height}, ${megabytes(filmFile.original.bytes)})`}</a></>}</p>}
      </div>
    </div>
    <footer className="production-made-notes">
      <p><b>What happened</b>{record.note}</p>
      <p><b>Checked before publishing</b>{record.verification}</p>
      <details><summary>Run receipt</summary><dl>
        <dt>Environment</dt><dd>{record.edition}</dd>
        <dt>Runtime and model</dt><dd>{record.runtime} · {record.model}</dd>
        {/* The agents' settings only: how many nodes ran at once changed over the runs, as "What happened" says. */}
        <dt>Execution settings</dt><dd>{`${record.limits.modelCallsPerNode === 1 ? '1 model call' : `up to ${record.limits.modelCallsPerNode} model calls`} per agent${record.limits.thinking ? '' : ' with thinking off'}, at most ${record.limits.maxOutputTokens} output tokens, ${record.limits.contextWindow}-token context`}</dd>
        {/* An edit runs on the render worker, not an agent runtime. */}
        <dt>Editors and edits</dt><dd>{record.source.runs && record.source.runs.length > 0
          ? record.source.runs.map(entry => `API ${entry.api.slice(0, 12)} · ${entry.nodes.every(id => record.nodes.find(node => node.id === id)?.kind === 'edit') ? 'renderer' : 'runtime'} ${entry.worker.slice(0, 12)} (${entry.nodes.map(titleOf).join(', ')})`).join('; then ')
          : `API ${record.source.api} · runtime ${record.source.worker}`}</dd>
        {record.source.media && record.source.media.length > 0 && <><dt>Media nodes</dt><dd>{record.source.media.map(entry => `API ${entry.api.slice(0, 12)} (${entry.nodes.length} ${entry.nodes.length === 1 ? 'node' : 'nodes'})`).join('; then ')}</dd></>}
        {record.runs && record.activeSeconds !== undefined && <><dt>Time</dt><dd>{`${record.runs} runs took ${formatDuration(record.activeSeconds, 'en')}, ${formatDuration(record.seconds, 'en')} from the first start to the last finish`}</dd></>}
        {record.artifactSHA256 && <><dt>Film checksum</dt><dd><code>SHA-256 {record.artifactSHA256}</code></dd></>}
      </dl></details>
    </footer>
  </section>;
}

/** An editor agent or an edit node: what it was asked, how it worked and what it delivered. */
function NodeDetail({ node }: { node: ProductionRunNode }) {
  const film = node.film;
  return <>
    <header><h4>{node.title}</h4><span>{film ? 'Edit · joins clips and sounds, no model' : 'Agent'}</span><StatusChip status={node.status} /></header>
    {film && <p className="production-made-work">{`${clock(film.seconds)} · ${film.frames.toLocaleString('en')} frames at ${film.fps} fps · ${film.width}×${film.height} · ${megabytes(film.bytes)}${film.loudness ? ` · ${film.loudness.integratedLUFS} LUFS, true peak ${film.loudness.truePeakDb} dB` : ''}`}</p>}
    {film && <p className="production-made-handoff"><ArrowDown size={13} aria-hidden="true" />{'from' in film.timeline
      ? 'Its timeline is the answer of the agent wired into it, as delivered.'
      : 'Its timeline was written on the node by the operator’s script once both reels existed (their lengths and subtitles), and is shown below.'}</p>}
    {film && film.warnings.length > 0 && <p className="production-made-work">{`The edit's warnings: ${film.warnings.join(', ')}`}</p>}
    {node.tokens?.output !== undefined && <p className="production-made-work">{`${node.calls ? `${node.calls} model calls · ` : ''}${node.tokens.output.toLocaleString('en')} output tokens`}</p>}
    {node.brief && <details className="production-made-source"><summary>{`Its brief, as it ran (${node.brief.length.toLocaleString('en')} characters)`}</summary><pre><code>{node.brief}</code></pre></details>}
    {film && 'own' in film.timeline && <details className="production-made-source"><summary>Its own timeline</summary><pre><code>{film.timeline.own}</code></pre></details>}
    <div className="production-made-output"><span>{film ? 'What this edit delivered' : 'What this agent actually delivered'}</span>
      {node.status !== 'done' ? node.detail ? <p className="production-made-detail">{node.detail}</p> : null
        : film ? <p className="production-made-file">{`${film.name}: ${megabytes(film.bytes)}, SHA-256 ${film.sha256.slice(0, 16)}…`}</p>
          : <div className="production-made-markdown">{renderRecordMarkdown(node.output || '')}</div>}</div>
  </>;
}

/** A picture, clip or sound node: the words it generated from, as it ran, and what it made. */
function MediaDetail({ media, poster }: { media: ProductionRunMedia; poster?: string }) {
  return <>
    <header><h4>{media.title}</h4><span>{KIND[media.kind].one}</span><StatusChip status={media.status} />{media.seconds !== undefined && <span>{`made in ${formatDuration(media.seconds, 'en')}`}</span>}</header>
    {poster && media.kind !== 'audio' && <img className="production-film-poster" src={poster} alt="" />}
    {media.words && <div className="production-made-output"><span>The words it generated from</span><p className="production-film-words">{media.words}</p></div>}
    {media.status !== 'done' && media.detail && <p className="production-made-detail">{media.detail}</p>}
  </>;
}
