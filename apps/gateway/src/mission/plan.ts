import type { MissionPlanResult, MissionTopology } from './types.js';
import { planMission } from './planner.js';
import { matchTracks } from './matcher.js';
import { proposeCompany } from './proposal.js';
import type { UpstreamCompanyReader } from './upstream-reader.js';

// Compose the full read-only mission result: plan the prompt into tracks, read
// the real companies' capabilities from the upstream, and match each track to a
// company. Pure orchestration — creates nothing. This is what the endpoint and
// the canvas consume.
export async function planMissionResult(
  prompt: string,
  topology: MissionTopology,
  reader: UpstreamCompanyReader,
): Promise<MissionPlanResult> {
  const plan = planMission(prompt, topology);
  const { capabilities, unreadableCompanies } = await reader.readCompanyCapabilities();
  const match = matchTracks(plan, capabilities);
  // Roles no existing company can staff → propose founding a new company to
  // cover them (P2, read-only proposal; nothing is created here). Only propose
  // when coverage is PROVEN — i.e. no roster was unreadable. If a company's
  // roster failed to read, that company might actually cover the "unmatched"
  // role, so proposing a new one (and asserting "无现役公司承接") would be a
  // false claim. Fail-closed: no proposal on unproven coverage.
  const proposal =
    unreadableCompanies.length === 0 ? (proposeCompany(match.unmatchedRoles) ?? undefined) : undefined;
  return {
    prompt,
    plan,
    matches: match.matches,
    companies: match.companies,
    unmatchedRoles: match.unmatchedRoles,
    unreadableCompanies,
    // An unreadable roster means coverage is UNPROVEN — never claim full match.
    fullyMatched: match.fullyMatched && unreadableCompanies.length === 0,
    ...(proposal ? { proposal } : {}),
  };
}
