import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowRight, ChevronLeft, ChevronRight, GitBranch, Maximize2, Minimize2, Pause, Play, RotateCcw } from 'lucide-react';
import { useSaaSPreferences } from '../preferences';
import type { OfficialWorkflow } from './officialWorkflows';
import './official-showcase.css';
import type { OfficialGeneratedRecord, OfficialRunNodeStatus } from './generatedRecords';

/** An explainer over the real template DAG, never a fabricated execution record. */
export function OfficialShowcase({ item, children, onOpenWorkflow, visible = true, record }: {
  item: OfficialWorkflow; children: ReactNode; onOpenWorkflow?: () => void; visible?: boolean; record?: OfficialGeneratedRecord;
}) {
  return <Showcase key={item.id} item={item} onOpenWorkflow={onOpenWorkflow} visible={visible} record={record}>{children}</Showcase>;
}

function Showcase({ item, children, onOpenWorkflow, visible = true, record }: {
  item: OfficialWorkflow; children: ReactNode; onOpenWorkflow?: () => void; visible?: boolean; record?: OfficialGeneratedRecord;
}) {
  const { locale, t } = useSaaSPreferences();
  const id = useId();
  const stages = useMemo(() => [...new Set(item.nodes.map(node => node.column))].sort((a, b) => a - b)
    .map(column => item.nodes.filter(node => node.column === column)), [item]);
  const [active, setActive] = useState(record?.artifactNodeId || item.nodes[0].id);
  const [playing, setPlaying] = useState(false);
  const [focused, setFocused] = useState(false);
  const [revision, setRevision] = useState(0);
  const process = useRef<HTMLDivElement>(null);
  const node = item.nodes.find(value => value.id === active) || item.nodes[0];
  const stage = stages.findIndex(group => group.some(value => value.id === node.id));
  const parents = item.edges.filter(edge => edge.to === node.id);
  const next = item.edges.filter(edge => edge.from === node.id);
  const statusLabel = (status: OfficialRunNodeStatus) => ({ done: t('完成', 'Done'), failed: t('失败', 'Failed'), blocked: t('阻断', 'Blocked'), canceled: t('已停止', 'Stopped'), cached: t('沿用结果', 'Reused') })[status];
  const resultViewport = useRef<HTMLDivElement>(null);
  const select = (nodeId: string) => { setPlaying(false); setActive(nodeId); };

  useEffect(() => {
    if (!playing || !visible) return;
    const timer = window.setTimeout(() => {
      if (stage >= stages.length - 1) setPlaying(false);
      else setActive(stages[stage + 1][0].id);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [playing, stage, stages, visible]);
  useEffect(() => { if (!visible) setPlaying(false); }, [visible]);
  useEffect(() => {
    // Scroll only the process rail, never steal focus or scroll the result/page.
    const rail = process.current;
    const selected = rail?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (rail && selected) {
      const top = selected.getBoundingClientRect().top - rail.getBoundingClientRect().top + rail.scrollTop;
      if (top < rail.scrollTop || top + selected.offsetHeight > rail.scrollTop + rail.clientHeight)
        rail.scrollTop = Math.max(0, top - 60);
    }
  }, [active]);

  return <div className={`official-showcase${focused ? ' is-result-focused' : ''}`}>
    <section className="showcase-process" aria-label={t('编排过程', 'Orchestration process')} hidden={focused}>
      <header className="showcase-pane-heading"><div><span>01 / ORCHESTRATION</span><h4>{t('它是怎样做出来的', 'How it comes together')}</h4></div><GitBranch size={19} /></header>
      <div className="showcase-process-meta"><span>{item.nodes.length} {t('节点', 'nodes')}<i />{item.edges.length} {t('依赖', 'handoffs')}</span><b>{record ? t(`运行快照 · ${record.completed}/${record.total} 完成`, `Run snapshot · ${record.completed}/${record.total} done`) : t('编排导览 · 非执行记录', 'Workflow tour · not a run record')}</b></div>
      {record && <div className="showcase-run-receipt"><span>{record.model} · {record.capturedOn}{record.reused ? t(` · ${record.reused} 个上游沿用`, ` · ${record.reused} reused inputs`) : ''}</span><p>{record.note[locale]}</p></div>}
      <div className="showcase-tour-controls">
        <button type="button" className="showcase-play" onClick={() => { if (stage === stages.length - 1 && !playing) setActive(stages[0][0].id); setPlaying(!playing); }}>{playing ? <Pause size={13} /> : <Play size={13} />}{playing ? t('暂停讲解', 'Pause tour') : t('播放编排讲解', 'Play workflow tour')}</button>
        <div><button type="button" aria-label={t('上一阶段', 'Previous stage')} disabled={stage === 0} onClick={() => select(stages[stage - 1][0].id)}><ChevronLeft size={14} /></button><output aria-live="off">{stage + 1}/{stages.length}</output><button type="button" aria-label={t('下一阶段', 'Next stage')} disabled={stage === stages.length - 1} onClick={() => select(stages[stage + 1][0].id)}><ChevronRight size={14} /></button></div>
      </div>
      <div className="showcase-stage-rail" ref={process} tabIndex={0} aria-label={t('按依赖阶段查看节点', 'Browse nodes by dependency stage')}>
        {stages.map((group, index) => <div key={group[0].column} className={`showcase-stage${index === stage ? ' is-current' : ''}`}>
          <div className="showcase-stage-number"><span>{String(index + 1).padStart(2, '0')}</span>{index !== stages.length - 1 && <i />}</div>
          <div className="showcase-stage-nodes">{group.length > 1 && <small>{t(`${group.length} 路并行`, `${group.length} parallel branches`)}</small>}{group.map(value => <button type="button" key={value.id} aria-label={t(`查看节点：${value.title.zh}`, `View node: ${value.title.en}`)} aria-pressed={value.id === active} aria-controls={`${id}-contract`} onClick={() => select(value.id)}><span><i className={value.outputType === 'html' ? 'is-artifact' : ''} />{value.title[locale]}</span><small>{value.output[locale]}</small>{record?.nodes[value.id] && <em className={`showcase-node-status is-${record.nodes[value.id]}`}>{statusLabel(record.nodes[value.id])}</em>}{value.id === active && <ArrowRight size={13} />}</button>)}</div>
        </div>)}
      </div>
      <div className="showcase-contract" id={`${id}-contract`}>
        <span className="showcase-small-label">{t('当前节点交付', 'NODE HANDOFF')}{record?.nodes[node.id] && ` · ${statusLabel(record.nodes[node.id])}`}</span><h4>{node.title[locale]}</h4>
        <p className="showcase-output"><ArrowDown size={14} />{node.output[locale]}</p>
        {parents.length > 0 && <div className="showcase-handoffs"><span>{t('接收上游', 'INPUTS')}</span>{parents.map(edge => <button type="button" key={edge.from} onClick={() => select(edge.from)} title={edge.label[locale]}>{item.nodes.find(value => value.id === edge.from)!.title[locale]}</button>)}</div>}
        {next.length > 0 && <div className="showcase-handoffs"><span>{t('交给下游', 'OUTPUT TO')}</span>{next.map(edge => <button type="button" key={edge.to} onClick={() => select(edge.to)}>{item.nodes.find(value => value.id === edge.to)!.title[locale]}</button>)}</div>}
        <details key={node.id}><summary>{t('完整任务与验收', 'Task and acceptance')}</summary><p>{node.task[locale]}</p><ul>{node.acceptance.map((value, index) => <li key={index}>{value[locale]}</li>)}</ul></details>
        {onOpenWorkflow && <button type="button" className="showcase-graph-link" onClick={onOpenWorkflow}><GitBranch size={13} />{t('展开完整连线画布', 'Explore the full canvas')}<ArrowRight size={13} /></button>}
      </div>
    </section>
    <section className="showcase-result" aria-label={t('交互成果', 'Interactive result')}>
      <header className="showcase-pane-heading"><div><span>02 / INTERACTIVE RESULT</span><h4>{t('现在，亲手试一试', 'Now make it your own')}</h4></div><div className="showcase-result-actions"><button type="button" title={t('重置成果', 'Reset result')} aria-label={t('重置成果', 'Reset result')} onClick={() => { setRevision(value => value + 1); if (resultViewport.current) resultViewport.current.scrollTop = 0; }}><RotateCcw size={15} /></button><button type="button" aria-pressed={focused} onClick={() => { setFocused(!focused); setPlaying(false); }}>{focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}{focused ? t('恢复左右对照', 'Restore split view') : t('专注成果', 'Focus on result')}</button></div></header>
      <div className="showcase-result-origin"><span><i />{record ? (record.originalSHA256 ? t('模型生成 · 验收修订', 'Model-generated · QA revision') : t('模型生成成果', 'Model-generated result')) : t('可交互参考实现', 'Interactive reference')}</span><span>{t('改变参数，观察结果', 'Change inputs. See what happens.')}</span></div>
      <div className="showcase-result-viewport" ref={resultViewport}><Fragment key={revision}>{children}</Fragment></div>
      <footer>{record ? <>{record.verification[locale]} <details><summary>{t('产物来源与校验', 'Provenance and checksum')}</summary><p>{record.note[locale]}</p><code>SHA-256 {record.sourceSHA256}</code>{record.originalSHA256 && <p><code>{t('模型原文', 'Original model output')} SHA-256 {record.originalSHA256}</code></p>}</details></> : t('成果在浏览器内运行。左侧讲解展示工作流设计；复制画布并运行模型后，可生成自己的版本。', 'The result runs in your browser. The tour explains its workflow design; copy the canvas and run models to generate your version.')}</footer>
    </section>
  </div>;
}
