import { useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { useCanvasI18n } from './i18n';
import { getTeamMarketAgents, teamMarketRuntimeNotice, type TeamMarketAgent } from './teamMarketAgents';

export function TeamMarketAgentPicker({ onSelect, disabled, compact = false }: { onSelect: (agent: TeamMarketAgent) => void; disabled: boolean; compact?: boolean }) {
  const { locale } = useCanvasI18n();
  const text = (zh: string, en: string) => locale === 'zh' ? zh : en;
  const agents = getTeamMarketAgents();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const visible = agents.filter(agent => `${agent.name} ${agent.role} ${agent.description} ${agent.source.teamName} ${agent.requiredSkills.join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selectedAgent = visible.find(agent => agent.id === selected);
  return <div className={`awwo-workspace-agent-picker${compact ? ' is-compact' : ''}`}>
    {compact ? <p className="awwo-bot-hint">{text('选择角色，用工作区模型执行。', 'Choose a role to run with workspace models.')}</p> : <p>{teamMarketRuntimeNotice(locale)}</p>}
    <div className="awwo-catalog-tools"><label className="awwo-search"><Search size={15} /><input type="search" aria-label={text('搜索团队市场角色', 'Search team market roles')} placeholder={text('搜索名称、团队或技能…', 'Search name, team or skill…')} value={query} onChange={event => { setQuery(event.target.value); setSelected(null); }} /></label></div>
    <div className="awwo-catalog-list" aria-label={text('团队市场角色目录', 'Team market role catalogue')}>
      {visible.map(agent => <button key={agent.id} type="button" aria-pressed={selected === agent.id} aria-label={text(`选择 ${agent.name} · ${agent.source.teamName}`, `Select ${agent.name} · ${agent.source.teamName}`)} onClick={() => setSelected(agent.id)}><strong>{agent.name}</strong><span>{agent.source.teamName} · {agent.role}</span><small>{agent.description}</small></button>)}
    </div>
    {!visible.length && <p role="status">{text('没有匹配的团队市场角色。', 'No matching team market roles.')}</p>}
    {selectedAgent && <section className="awwo-market-preview" aria-label={text('所选市场角色详情', 'Selected market role details')}>
      <h3>{selectedAgent.name}</h3><p>{selectedAgent.source.teamName}</p>
      {compact && <p>{teamMarketRuntimeNotice(locale)}</p>}
      <p>{text('原角色所需技能（此处不会安装）：', 'Original role skills (not installed here): ')}{selectedAgent.requiredSkills.join(', ') || text('无', 'None')}</p>
      <details><summary>{text('查看原始角色说明', 'View original role instructions')}</summary><pre>{selectedAgent.instructions}</pre></details>
    </section>}
    <footer className="awwo-template-library-footer"><span>{text(`共 ${agents.length} 个角色 · 添加后使用工作区模型`, `${agents.length} roles · Uses workspace models after adding`)}</span><button className="awwo-primary" type="button" disabled={disabled || !selectedAgent} onClick={() => { if (!disabled && selectedAgent) onSelect(selectedAgent); }}><Plus size={16} />{text('添加所选角色', 'Add selected role')}</button></footer>
  </div>;
}
