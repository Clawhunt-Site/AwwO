// The canvas bar's memory and skill-library tools (developer mode, after the knowledge map): each opens its
// workbench over the canvas. Both read and write the server (memory.go, skills.go); a run already admitted keeps
// what it froze, so nothing here changes work in progress.
import { useState } from 'react';
import { Brain, Sparkles } from 'lucide-react';
import { WorkbenchOverlay } from './CanvasKnowledgeDock';
import { MemoryWorkbench } from './MemoryWorkbench';
import { SkillLibrary } from './SkillLibrary';
import { useSaaSPreferences } from './preferences';

interface Props { tenantId: string; canvasId: string; readOnly?: boolean }

export function CanvasLibraryTools({ tenantId, canvasId, readOnly = false }: Props) {
  const { t } = useSaaSPreferences();
  const [open, setOpen] = useState<'memory' | 'skills' | null>(null);
  // While the skill library imports from skills.sh, Escape leaves it open: the import finishes and says so.
  const [skillsBusy, setSkillsBusy] = useState(false);
  const close = () => setOpen(null);
  const memoryName = t('记忆', 'Memory');
  const skillsName = t('技能库', 'Skills');
  return <>
    <button type="button" className="awwo-knowledge-tool" aria-label={memoryName} title={t('记忆：运行时作为背景资料交给节点的笔记', 'Memory: notes runs give nodes as background data')} onClick={() => setOpen('memory')}>
      <Brain size={15} aria-hidden="true" /><span>{memoryName}</span></button>
    <button type="button" className="awwo-knowledge-tool" aria-label={skillsName} title={t('技能库：节点可以挂载的方法指引', 'Skills: method guidance nodes can carry')} onClick={() => setOpen('skills')}>
      <Sparkles size={15} aria-hidden="true" /><span>{skillsName}</span></button>
    {open === 'memory' && <WorkbenchOverlay label={t('记忆工作台', 'Memory workbench')} onClose={close}>
      <MemoryWorkbench key={`${tenantId}/${canvasId}`} tenantId={tenantId} canvasId={canvasId} readOnly={readOnly} onClose={close} />
    </WorkbenchOverlay>}
    {open === 'skills' && <WorkbenchOverlay label={t('技能库', 'Skill library')} onClose={close} busy={skillsBusy}>
      <SkillLibrary key={tenantId} tenantId={tenantId} readOnly={readOnly} onClose={close} onBusyChange={setSkillsBusy} />
    </WorkbenchOverlay>}
  </>;
}
