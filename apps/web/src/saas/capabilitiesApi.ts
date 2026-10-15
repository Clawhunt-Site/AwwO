import { api, tenantPath } from './api';

/** What this server offers a workspace beyond the canvas itself (capabilities.go): off-by-default abilities report
 *  `enabled: false`, so the interface never offers something the server would refuse. */
export interface WorkspaceCapabilities {
  skills: { enabled: boolean; maxNodeSkills: number; maxNodeSkillBytes: number };
  memory: { enabled: boolean; maxRunItems: number; maxRunBytes: number; maxPerScope: number };
  webReader: { enabled: boolean; perDay: number; usedToday: number };
  render: { enabled: boolean; perDay: number; usedToday: number; limits: { maxSeconds: number; maxFps: number; maxWidth: number; maxHeight: number; maxFrames: number; maxHtmlBytes: number } };
}

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const enabled = (x: unknown) => object(x) && typeof x.enabled === 'boolean';

export async function readCapabilities(tenantId: string, signal?: AbortSignal): Promise<WorkspaceCapabilities> {
  const value = await api<unknown>(tenantPath(tenantId, '/capabilities'), { signal });
  if (!object(value) || !enabled(value.skills) || !enabled(value.memory) || !enabled(value.webReader) || !enabled(value.render)) {
    throw new Error('Invalid capabilities response');
  }
  return value as unknown as WorkspaceCapabilities;
}
