import type { AgentTemplateId } from '../../../canvas/agentTemplates';
import type { UiLocale } from '../../../locale';
import type { Localized, OfficialWorkflowCategory } from '../officialWorkflows';

export interface AdvancedWorkflowStep {
  readonly id: string;
  readonly title: Localized;
  readonly role: AgentTemplateId;
  readonly task: Localized;
  readonly output: Localized;
  readonly acceptance: ReadonlyArray<Localized>;
  readonly after: ReadonlyArray<string>;
  readonly outputType?: 'html' | 'markdown';
}
export interface AdvancedCase {
  readonly id: string;
  readonly category: OfficialWorkflowCategory;
  readonly industry: Localized;
  readonly title: Localized;
  readonly summary: Localized;
  readonly description: Localized;
  readonly pattern: Localized;
  readonly brief: Localized;
  readonly accent: string;
  readonly capabilities: ReadonlyArray<Localized>;
  readonly datasets: ReadonlyArray<Localized>;
  readonly artifacts: ReadonlyArray<Localized>;
  readonly limitations: Localized;
  /** Topological order; all dependencies use real step IDs. Final artifacts must receive review evidence. */
  readonly steps: ReadonlyArray<AdvancedWorkflowStep>;
}
export interface AdvancedDemoProps { id: string; locale: UiLocale }
export const bilingual = (zh: string, en: string): Localized => ({ zh, en });
