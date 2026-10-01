import { useEffect, useState } from 'react';
import { api, SaaSApiError, saasErrorMessage, tenantPath } from './api';
import type { TeamRunRecord, TeamTurn } from './graphRuns';
import { useSaaSPreferences } from './preferences';
import { runErrorText } from './canvasErrors';
import { RunEvidence } from './RunEvidence';
import { readRunExecutionMetadata, workspaceToolLabel, type WorkspaceActivity } from './workspaceActivity';
import './team-run-details.css';

export interface TeamRunDetailsProps {
  tenantId: string;
  runId: string;
  defaultOpen?: boolean;
  /** A live transcript status change asks the open observer to refresh immediately. */
  runStatus?: string;
}

const statuses: Record<string, [string, string]> = {
  queued: ['排队中', 'Queued'], running: ['运行中', 'Running'], completed: ['完成', 'Completed'],
  failed: ['失败', 'Failed'], cancelled: ['已停止', 'Cancelled'], interrupted: ['已中断', 'Interrupted'],
};
const isActive = (status: string) => status === 'queued' || status === 'running';

function validTurns(value: unknown): value is { items: TeamTurn[] } {
  if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)) return false;
  const ids = new Set<string>();
  return value.items.every(turn => {
    if (!turn || typeof turn !== 'object' || typeof turn.id !== 'string' || ids.has(turn.id)) return false;
    ids.add(turn.id);
    return ['memberId', 'memberName', 'role', 'status', 'output'].every(key => typeof turn[key] === 'string')
      && Number.isInteger(turn.round) && turn.round > 0
      && (turn.ordinal == null || (Number.isInteger(turn.ordinal) && turn.ordinal > 0))
      && ['model', 'runtime', 'createdAt', 'updatedAt', 'prompt', 'systemPrompt', 'error'].every(key => turn[key] == null || typeof turn[key] === 'string')
      && (turn.config == null || (typeof turn.config === 'object' && (turn.config.instructions == null || typeof turn.config.instructions === 'string')))
      && (turn.messages == null || (Array.isArray(turn.messages) && turn.messages.every((item: { role?: unknown; content?: unknown } | null) => item && typeof item.role === 'string' && typeof item.content === 'string')))
      && (turn.context == null || (turn.context.version === 1 && ['task', 'shared'].includes(turn.context.mode)
        && ['work', 'aggregate', 'review', 'revise'].includes(turn.context.purpose)
        && ['historyMessages', 'historyAvailable', 'upstreamAvailable'].every(key => Number.isInteger(turn.context[key]) && turn.context[key] >= 0)
        && typeof turn.context.historyTruncated === 'boolean' && typeof turn.context.upstreamTruncated === 'boolean'
        && Array.isArray(turn.context.upstreamMembers) && turn.context.upstreamMembers.every((item: { memberId?: unknown; memberName?: unknown; round?: unknown; ordinal?: unknown } | null) => item
          && typeof item.memberId === 'string' && typeof item.memberName === 'string' && Number.isInteger(item.round) && Number.isInteger(item.ordinal))));
  });
}

/** Durable read-only observation. Identity changes remount before any previous data can render. */
export function TeamRunDetails(props: TeamRunDetailsProps) {
  return <TeamRunDetailsView key={JSON.stringify([props.tenantId, props.runId])} {...props} />;
}

function TeamRunDetailsView({ tenantId, runId, defaultOpen = false, runStatus }: TeamRunDetailsProps) {
  const { locale, t } = useSaaSPreferences();
  const [open, setOpen] = useState(defaultOpen);
  const [manuallyOpened, setManuallyOpened] = useState(false);
  const [observedTurns, setObservedTurns] = useState(false);
  const [record, setRecord] = useState<TeamRunRecord | null>(null);
  const [turns, setTurns] = useState<TeamTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [runReadFailed, setRunReadFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const status = (value: string) => statuses[value]?.[locale === 'zh' ? 0 : 1] || value;

  useEffect(() => {
    if (!open || !tenantId || !runId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      setLoading(true);
      let receivedRun = false;
      try {
        const path = tenantPath(tenantId, `/runs/${encodeURIComponent(runId)}`);
        const next = await api<TeamRunRecord>(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const execution = readRunExecutionMetadata(next);
        if (!next || next.id !== runId || next.tenantId !== tenantId || !Object.hasOwn(statuses, next.status) || !execution) {
          throw new Error(locale === 'zh' ? '运行记录响应无效。' : 'Invalid run record response.');
        }
        receivedRun = true;
        setRecord({ ...next, ...execution }); setRunReadFailed(false);
        if (execution.executionKind === 'workspace' || execution.executionKind === 'text') {
          setTurns([]); setObservedTurns(true); setError(null);
          if (isActive(next.status)) timer = setTimeout(() => void poll(), 2000);
          return;
        }
        // Read turns after status: a terminal run already committed its final member output.
        const result = await api<unknown>(`${path}/turns`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!validTurns(result)) throw new Error(locale === 'zh' ? '成员记录响应无效。' : 'Invalid member turn response.');
        setTurns(result.items); setObservedTurns(true); setError(null);
        if (isActive(next.status)) timer = setTimeout(() => void poll(), 2000);
      } catch (error) {
        if (!controller.signal.aborted) {
          if (error instanceof SaaSApiError && [401, 403, 404].includes(error.status)) { setRecord(null); setTurns([]); }
          setRunReadFailed(!receivedRun); setError(error);
        }
      } finally { if (!controller.signal.aborted) setLoading(false); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [tenantId, runId, open, refresh, runStatus, locale]);

  // A successful single-Agent call has no member process to automatically disclose.
  // Keep its status/history available on demand, and never hide errors or real team turns.
  const expanded = open && !(!manuallyOpened && observedTurns && record?.status === 'completed' && !turns.length && error === null);
  const project = record?.executionKind === 'workspace';
  const activity = record?.workspaceActivity;
  const latestOperation = activity?.items.at(-1);
  return <section className="saas-team-run-details" aria-label={t('运行过程', 'Run process')}>
    <button type="button" className="saas-team-run-toggle" aria-expanded={expanded} onClick={() => { setManuallyOpened(!expanded); setOpen(!expanded); }}>
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <strong>{project ? t('项目执行', 'Project execution') : turns.length || record?.executionKind === 'team' ? t('团队协作过程', 'Team collaboration') : t('运行过程', 'Run process')}</strong>
      {record && <span>{runReadFailed ? t('上次确认：', 'Last confirmed: ') : ''}{status(record.status)}{turns.length ? ` · ${turns.length} ${t('次成员调用', 'member calls')}` : ''}{error !== null ? t(' · 读取已暂停', ' · Reading paused') : ''}</span>}
    </button>
    {expanded && <div className="saas-team-run-content">
      {loading && !record && error === null && <p role="status">{t('正在读取运行记录…', 'Loading run records…')}</p>}
      {error !== null && <p className="saas-team-error" role="alert">{saasErrorMessage(error, locale)} <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>{t('重试读取记录', 'Retry reading records')}</button></p>}
      {record && <p className="saas-team-run-status" role="status">{runReadFailed ? t('上次确认的运行状态：', 'Last confirmed run status: ') : t('运行状态：', 'Run status: ')}{status(record.status)}{error !== null
        ? t(' · 读取已暂停，请重试恢复', ' · Reading paused; retry to resume')
        : isActive(record.status) ? t(' · 自动更新中', ' · Updating automatically') : ''}</p>}
      {record?.error && <p className="saas-team-error" role="alert">{runErrorText(record.error, locale) ?? record.error}</p>}
      {error !== null && turns.length > 0 && <p>{t('成员记录未能刷新，下方为上次成功读取的旧记录。', 'Member records could not be refreshed. The records below are from the last successful read.')}</p>}
      {project && latestOperation && <p className="saas-workspace-latest">{runReadFailed ? t('上次记录：', 'Last observed: ') : t('最近开始：', 'Last started: ')}<strong>{workspaceToolLabel(latestOperation.tool, locale)}</strong><span> · {t('第', 'Step ')}{latestOperation.step}{t('步', '')}</span></p>}
      {project && activity && activity.items.length > 0 && <WorkspaceOperationHistory activity={activity} />}
      {record && !turns.length && !latestOperation && error === null && !loading && <p>{isActive(record.status)
        ? project ? t('正在执行，等待首条项目操作记录。', 'Execution is active; waiting for the first project operation.')
          : record.executionKind === 'team' ? t('等待首条成员协作记录。', 'Waiting for the first member record.') : t('正在执行，等待输出。', 'Execution is active; waiting for output.')
        : t('本次运行没有额外操作记录。', 'This run has no additional operation records.')}</p>}
      {record && <RunEvidence tenantId={tenantId} runId={runId} runStatus={record.status} />}
      {turns.map(turn => <MemberTurn key={turn.id} turn={turn} />)}
    </div>}
  </section>;
}

function WorkspaceOperationHistory({ activity }: { activity: WorkspaceActivity }) {
  const { locale, t } = useSaaSPreferences();
  return <details className="saas-workspace-operations">
    <summary>{t('操作记录', 'Operation history')} · {activity.items.length}</summary>
    <p>{t('记录表示操作已开始，不代表成功；请结合交付物和检查结果核对。', 'These records show operations starting, not success. Check the deliverables and actual check results.')}</p>
    {activity.truncated && <p>{t('仅展示最近 64 条操作。', 'Only the latest 64 operations are shown.')}</p>}
    <ol>{activity.items.map((operation, index) => <li key={`${index}:${operation.step}:${operation.tool}`}>
      <span>{t('第', 'Step ')}{operation.step}{t('步', '')}</span><span>{t('开始：', 'Started: ')}{workspaceToolLabel(operation.tool, locale)}</span>
    </li>)}</ol>
  </details>;
}

function MemberTurn({ turn }: { turn: TeamTurn }) {
  const { locale, t } = useSaaSPreferences();
  const unavailable = t('此记录未保存，无法提供。', 'Unavailable: this was not saved in this record.');
  const text = (value?: string | null) => value == null ? unavailable : value || t('（空）', '(Empty)');
  const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') : unavailable;
  const context = turn.context;
  const purpose = context && ({ work: t('任务执行', 'Work'), aggregate: t('最终汇总', 'Aggregation'), review: t('审核', 'Review'), revise: t('返工', 'Revision') }[context.purpose]);
  return <article className="saas-team-turn">
    <header><strong>{turn.ordinal == null ? t('编号未记录', 'Number unavailable') : `${t('调用', 'Call')} #${turn.ordinal}`} · {turn.memberName}</strong>
      <span>{turn.role} · {t('第', 'Round ')}{turn.round}{t('轮', '')} · {statuses[turn.status]?.[locale === 'zh' ? 0 : 1] || turn.status}</span></header>
    <p className="saas-team-turn-meta">{t('模型：', 'Model: ')}{turn.model || unavailable} · {t('框架：', 'Runtime: ')}{turn.runtime || unavailable}</p>
    <p className="saas-team-turn-meta">{t('记录时间：', 'Created: ')}<time dateTime={turn.createdAt}>{time(turn.createdAt)}</time> · {t('更新时间：', 'Updated: ')}<time dateTime={turn.updatedAt}>{time(turn.updatedAt)}</time></p>
    <div className="saas-team-output"><strong>{t('成员输出', 'Member output')}</strong>{turn.output ? <pre>{turn.output}</pre> : <p>{isActive(turn.status) ? t('尚未收到成员输出。', 'No member output received yet.') : t('此记录没有输出。', 'This record has no output.')}</p>}</div>
    {turn.error && <p className="saas-team-error" role="alert">{runErrorText(turn.error, locale) ?? turn.error}</p>}
    <details className="saas-team-input-audit"><summary>{t('查看实际输入、指令与上下文来源', 'Inspect actual input, instructions and context sources')}</summary>
      <dl>
        <dt>{t('实际任务输入', 'Actual task input')}</dt><dd><pre>{text(turn.prompt)}</pre></dd>
        <dt>{t('本成员专属指令', 'Member instructions')}</dt><dd><pre>{text(turn.config?.instructions)}</pre></dd>
        <dt>{t('实际系统指令（包含节点与成员指令）', 'Actual system prompt (node and member instructions)')}</dt><dd><pre>{text(turn.systemPrompt)}</pre></dd>
        <dt>{t('本次上下文范围', 'Context used for this call')}</dt><dd>{context ? <>
          <p>{context.mode === 'shared' ? t('共享当前会话历史与本轮前序成果', 'Share current session history and earlier results in this run') : t('仅当前任务；汇总、审核和返工仍接收必要操作数', 'Task only; aggregation, review and revision still receive required results')} · {purpose}</p>
          <p>{t('会话历史消息：', 'Session history messages: ')}{context.historyMessages}/{context.historyAvailable}{context.historyTruncated ? t('（已截取）', ' (truncated)') : ''}</p>
          <p>{t('前序成员来源：', 'Earlier member sources: ')}{context.upstreamMembers.length}/{context.upstreamAvailable}{context.upstreamTruncated ? t('（已截取）', ' (truncated)') : ''}</p>
          {context.upstreamMembers.length ? <ul>{context.upstreamMembers.map((member, index) => <li key={`${member.ordinal}-${index}`}>{member.memberName} · {t('第', 'Round ')}{member.round}{t('轮', '')} · {t('调用', 'Call')} #{member.ordinal}</li>)}</ul> : <p>{t('未提供前序成员成果。', 'No earlier member results were supplied.')}</p>}
        </> : unavailable}</dd>
        <dt>{t('实际会话历史', 'Actual session history')}</dt><dd>{turn.messages == null ? unavailable : turn.messages.length ? <ol>{turn.messages.map((message, index) => <li key={index}><strong>{message.role}</strong><pre>{message.content}</pre></li>)}</ol> : t('未提供会话历史。', 'No session history was supplied.')}</dd>
      </dl>
    </details>
  </article>;
}
