import { api, tenantPath } from './api';

/** What this server offers a workspace beyond the canvas itself (capabilities.go): off-by-default abilities report
 *  `enabled: false`, so the interface never offers something the server would refuse. */
export interface WorkspaceCapabilities {
  skills: { enabled: boolean; maxNodeSkills: number; maxNodeSkillBytes: number };
  /** Finding skills on skills.sh and importing them into the library; absent from servers older than it. */
  skillRegistry?: { enabled: boolean; source: string };
  memory: { enabled: boolean; maxRunItems: number; maxRunBytes: number; maxPerScope: number };
  webReader: { enabled: boolean; perDay: number; usedToday: number };
  render: { enabled: boolean; perDay: number; usedToday: number; limits: { maxSeconds: number; maxFps: number; maxWidth: number; maxHeight: number; maxFrames: number; maxHtmlBytes: number } };
  /** Edit nodes (edits.go), rendered on the same worker. Absent from a server older than them. */
  edit?: { enabled: boolean; perDay: number; usedToday: number; limits: { maxSeconds: number; maxFiles: number; maxTimelineBytes: number } };
  /** The Agent market (docs/awwo-agent-market.md): the platform's fee in basis points, the highest price an author may set
   *  (credits per call), and the days a period's earnings wait before they are settled. Absent from a server older than it. */
  market?: { enabled: boolean; payouts: boolean; feeBps: number; maxPrice: number; holdDays: number };
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
