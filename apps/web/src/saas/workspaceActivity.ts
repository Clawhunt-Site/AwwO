export const workspaceTools = ['workspace_list', 'workspace_read', 'workspace_write', 'workspace_exec', 'workspace_publish', 'workspace_archive'] as const;
export type WorkspaceTool = typeof workspaceTools[number];
export interface WorkspaceActivity { items: { step: number; tool: WorkspaceTool }[]; truncated: boolean }
export interface RunExecutionMetadata {
  executionKind?: 'workspace' | 'team' | 'text';
  workspaceActivity?: WorkspaceActivity;
}

/** Project only bounded operation-start facts. Never expose tool arguments or raw event data. */
export function readRunExecutionMetadata(value: unknown): RunExecutionMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.executionKind !== undefined && !['workspace', 'team', 'text'].includes(String(item.executionKind))) return null;
  const executionKind = item.executionKind as RunExecutionMetadata['executionKind'];
  if (item.workspaceActivity === undefined) return { executionKind };
  if (executionKind !== 'workspace' || !item.workspaceActivity || typeof item.workspaceActivity !== 'object' || Array.isArray(item.workspaceActivity)) return null;
  const activity = item.workspaceActivity as Record<string, unknown>;
  if (!Array.isArray(activity.items) || activity.items.length > 64 || typeof activity.truncated !== 'boolean') return null;
  const items: WorkspaceActivity['items'] = [];
  let previousStep = 0;
  for (const raw of activity.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const event = raw as Record<string, unknown>;
    if (!Number.isInteger(event.step) || Number(event.step) < 1 || Number(event.step) > 16 || Number(event.step) < previousStep
      || typeof event.tool !== 'string' || !workspaceTools.includes(event.tool as WorkspaceTool)) return null;
    previousStep = Number(event.step);
    items.push({ step: previousStep, tool: event.tool as WorkspaceTool });
  }
  return { executionKind, workspaceActivity: { items, truncated: activity.truncated } };
}

export function workspaceToolLabel(tool: WorkspaceTool, locale: 'zh' | 'en'): string {
  const labels: Record<WorkspaceTool, [string, string]> = {
    workspace_list: ['查看项目文件', 'Inspect project files'],
    workspace_read: ['读取文件', 'Read a file'],
    workspace_write: ['写入文件', 'Write a file'],
    workspace_exec: ['执行终端操作', 'Run a terminal command'],
    workspace_publish: ['发布交付', 'Publish a deliverable'],
    workspace_archive: ['打包项目', 'Package the project'],
  };
  return labels[tool][locale === 'zh' ? 0 : 1];
}
