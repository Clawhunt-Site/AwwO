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
  market?: { enabled: boolean; payouts: boolean; feeBps: number; maxPrice: number; holdDays: number;
    /** What a call to one of AwwO's official Agents costs (credits) once officialPriceFrom has come (at once without it);
     *  0 or absent: official Agents take no Agent fee. Absent from a server older than it. */
    officialPrice?: number;
    /** When officialPrice starts (RFC 3339). Absent: it applies already. */
    officialPriceFrom?: string };
  /** 多人同屏 (docs/awwo-canvas-live-collaboration.md): changes, the live stream and canvas agent tokens. Absent from a
   *  server older than it, whose canvases the page then saves whole. `people`: the canvas offers sharing it with people
   *  (the Share dialog; AWWO_PEOPLE_SHARING), absent from a server older than that. */
  multiplayer?: { enabled: boolean; maxChangeOps: number; people?: boolean };
}

/** Whether this server takes canvas changes and streams them (多人同屏): false for any answer that does not say so. */
export async function readMultiplayer(tenantId: string, signal?: AbortSignal): Promise<boolean> {
  // Asked again twice on a failure: the answer is kept for the whole opening (a page that settles on whole-document
  // saves next to pages saving changes meets version conflicts).
  for (let attempt = 0; ; attempt += 1) {
    try {
      const value = await api<unknown>(tenantPath(tenantId, '/capabilities'), { signal });
      return object(value) && object(value.multiplayer) && value.multiplayer.enabled === true;
    } catch {
      if (attempt >= 2 || signal?.aborted) return false;
      await new Promise(resolve => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
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
