import { Fragment, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Search } from 'lucide-react';
import { useCanvasI18n } from './i18n';
import { getAllTeamMarketAgents, isTeamMarketLibraryLoaded, loadTeamMarketLibrary, teamMarketRuntimeNotice, type TeamMarketAgent } from './teamMarketAgents';

interface LibraryTeam { id: string; label: string; total: number; roles: TeamMarketAgent[] }

/** Library roles grouped by team, in catalogue order; `roles` holds only the ones matching the search. */
function libraryTeams(all: readonly TeamMarketAgent[], visible: readonly TeamMarketAgent[], label: (agent: TeamMarketAgent) => string): LibraryTeam[] {
  const teams = new Map<string, LibraryTeam>();
  for (const agent of all) {
    if (!agent.source.upstream) continue;
    const team = teams.get(agent.source.teamId) ?? { id: agent.source.teamId, label: label(agent), total: 0, roles: [] };
    team.total += 1;
    teams.set(team.id, team);
  }
  for (const agent of visible) if (agent.source.upstream) teams.get(agent.source.teamId)?.roles.push(agent);
  return [...teams.values()].filter(team => team.roles.length);
}

function toggled(open: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(open);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function TeamMarketAgentPicker({ onSelect, disabled, compact = false }: { onSelect: (agent: TeamMarketAgent) => void; disabled: boolean; compact?: boolean }) {
  const { locale } = useCanvasI18n();
  const text = (zh: string, en: string) => locale === 'zh' ? zh : en;
  const [agents, setAgents] = useState(getAllTeamMarketAgents);
  const [library, setLibrary] = useState<'loading' | 'ready' | 'failed'>(() => isTeamMarketLibraryLoaded() ? 'ready' : 'loading');
  const [attempt, setAttempt] = useState(0);
  const [openTeams, setOpenTeams] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadTeamMarketLibrary().then(() => {
      if (!live) return;
      setAgents(getAllTeamMarketAgents());
      setLibrary('ready');
    }, () => { if (live) setLibrary('failed'); });
    return () => { live = false; };
  }, [attempt]);
  const team = (agent: TeamMarketAgent) => locale === 'zh' && agent.source.teamNameZh ? agent.source.teamNameZh : agent.source.teamName;
  const blurb = (agent: TeamMarketAgent) => locale === 'zh' && agent.descriptionZh ? agent.descriptionZh : agent.description;
  const needle = query.trim().toLocaleLowerCase();
  const visible = agents.filter(agent => [agent.name, agent.role, agent.description, agent.descriptionZh ?? '', agent.source.teamName, agent.source.teamNameZh ?? '', ...agent.requiredSkills]
    .join(' ').toLocaleLowerCase().includes(needle));
  const teams = libraryTeams(agents, visible, team);
  const libraryTotal = agents.filter(agent => agent.source.upstream).length;
  const selectedAgent = visible.find(agent => agent.id === selected);
  const card = (agent: TeamMarketAgent) => <button key={agent.id} type="button" aria-pressed={selected === agent.id} aria-label={text(`选择 ${agent.name} · ${team(agent)}`, `Select ${agent.name} · ${team(agent)}`)} onClick={() => setSelected(agent.id)}>
    <strong>{agent.name}</strong><span>{team(agent)} · {agent.role}</span><small>{blurb(agent)}</small>
    {agent.source.attribution && <em className="awwo-market-license">{agent.source.attribution}</em>}
  </button>;
  return <div className={`awwo-workspace-agent-picker${compact ? ' is-compact' : ''}`}>
    {compact ? <p className="awwo-bot-hint">{text('选择角色，用工作区模型执行。', 'Choose a role to run with workspace models.')}</p> : <p>{teamMarketRuntimeNotice(locale)}</p>}
    <div className="awwo-catalog-tools"><label className="awwo-search"><Search size={15} /><input type="search" aria-label={text('搜索团队市场角色', 'Search team market roles')} placeholder={text('搜索名称、团队或技能…', 'Search name, team or skill…')} value={query} onChange={event => { setQuery(event.target.value); setSelected(null); }} /></label></div>
    <div className="awwo-catalog-list" aria-label={text('团队市场角色目录', 'Team market role catalogue')}>
      {visible.filter(agent => !agent.source.upstream).map(card)}
      {teams.length > 0 && <p className="awwo-market-library-heading">{text(`wshobson/agents 角色库 · ${libraryTotal} 个角色`, `wshobson/agents library · ${libraryTotal} roles`)}</p>}
      {teams.map(entry => {
        const open = Boolean(needle) || openTeams.has(entry.id);
        const count = needle ? text(`${entry.roles.length} 个匹配`, `${entry.roles.length} matching`) : text(`${entry.total} 个角色`, `${entry.total} roles`);
        return <Fragment key={entry.id}>
          <h4 className="awwo-market-group">{needle
            ? <span className="awwo-market-group-label">{entry.label}<span>{count}</span></span>
            : <button type="button" aria-expanded={open} aria-label={`${entry.label} · ${count}`} onClick={() => setOpenTeams(current => toggled(current, entry.id))}>
              {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}{entry.label}<span>{count}</span>
            </button>}</h4>
          {open && entry.roles.map(card)}
        </Fragment>;
      })}
    </div>
    {library === 'loading' && <p role="status">{text('正在加载 wshobson/agents 角色库…', 'Loading the wshobson/agents role library…')}</p>}
    {library === 'failed' && <p className="awwo-catalog-error" role="alert">{text('wshobson/agents 角色库未能加载。', 'The wshobson/agents role library could not be loaded.')} <button type="button" onClick={() => { setLibrary('loading'); setAttempt(value => value + 1); }}>{text('重试', 'Retry')}</button></p>}
    {!visible.length && library !== 'loading' && <p role="status">{text('没有匹配的团队市场角色。', 'No matching team market roles.')}</p>}
    {selectedAgent && <section className="awwo-market-preview" aria-label={text('所选市场角色详情', 'Selected market role details')}>
      <h3>{selectedAgent.name}</h3><p>{team(selectedAgent)}</p>
      {selectedAgent.descriptionZh && <p>{blurb(selectedAgent)}</p>}
      {compact && <p>{teamMarketRuntimeNotice(locale)}</p>}
      <p>{text('原角色所需技能（此处不会安装）：', 'Original role skills (not installed here): ')}{selectedAgent.requiredSkills.join(', ') || text('无', 'None')}</p>
      {selectedAgent.source.attribution && <p className="awwo-market-license">{selectedAgent.source.attribution}</p>}
      <details><summary>{text('查看原始角色说明', 'View original role instructions')}</summary><pre>{selectedAgent.instructions}</pre></details>
    </section>}
    <footer className="awwo-template-library-footer"><span>{text(`共 ${agents.length} 个角色 · 添加后使用工作区模型`, `${agents.length} roles · Uses workspace models after adding`)}</span><button className="awwo-primary" type="button" disabled={disabled || !selectedAgent} onClick={() => { if (!disabled && selectedAgent) onSelect(selectedAgent); }}><Plus size={16} />{text('添加所选角色', 'Add selected role')}</button></footer>
  </div>;
}
