import { apiRequest, apiGet, API_PREFIX } from './api';

// ── Types (aligned with backend proto: api/telegram/miniapp/dreamy/types/v1/types.proto) ──
// ⚠️ Backend returns camelCase JSON (gRPC-gateway default), NOT the snake_case from proto.
// Only the openapi HTTP server sets UseProtoNames=true; dreamy miniapp HTTP server does not.

/** Milestone tag on rewards: "" | "d3" | "d7" */
export type CheckinMilestone = '' | 'd3' | 'd7';

export interface CheckinReward {
  energy: number;
  bonus: number;
  selfDirector: number;
  milestone: CheckinMilestone;
}

export interface CheckinStatus {
  currentStreak: number;
  cycleDay: number;
  /** Whether today is already claimed (⚠️ proto field is `today_claimed`, NOT `today_claimable`) */
  todayClaimed: boolean;
  todayReward: CheckinReward;
  tomorrowReward: CheckinReward;
  nextResetAt: string;  // ISO 8601 timestamp for next day boundary
  lastClaimAt: string;  // ISO 8601 timestamp of last claim (empty if never)
  lastCycleCompleted: boolean;
  selfDirectorRemaining: number;
}

export interface CheckinClaimResult {
  streakDay: number;
  cycleDay: number;
  energyGranted: number;
  bonusGranted: number;
  selfDirectorGranted: number;
  milestone: CheckinMilestone;
  cycleCompleted: boolean;
  isCapped: boolean;
  alreadyClaimed: boolean;
  capReason: '' | 'daily_energy_cap';
}

export interface CheckinHistoryItem {
  clientDate: string;     // YYYY-MM-DD
  streakDay: number;
  energyGranted: number;
  milestone: CheckinMilestone;
}

export interface CheckinHistory {
  items: CheckinHistoryItem[];
}

// ── Reward schedule (matches Figma / PRD) ──

export const REWARDS_SCHEDULE: CheckinReward[] = [
  { energy: 5,  bonus: 0,  selfDirector: 0, milestone: '' },   // Day 1
  { energy: 5,  bonus: 0,  selfDirector: 0, milestone: '' },   // Day 2
  { energy: 8,  bonus: 10, selfDirector: 0, milestone: 'd3' }, // Day 3 (bonus)
  { energy: 8,  bonus: 0,  selfDirector: 0, milestone: '' },   // Day 4
  { energy: 8,  bonus: 0,  selfDirector: 0, milestone: '' },   // Day 5
  { energy: 8,  bonus: 0,  selfDirector: 0, milestone: '' },   // Day 6
  { energy: 10, bonus: 0,  selfDirector: 3, milestone: 'd7' }, // Day 7 (big reward)
];

// ── Client timezone ──

function getClientTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

// ── Mock helpers ──

const USE_MOCK = import.meta.env.VITE_CHECKIN_MOCK === 'true';

function mockDelay(ms = 600): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Deterministic "random" based on today's date for consistent demo. */
function todaySeed(): number {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

let mockStreak: number | null = null;
let mockClaimed = false;

function getMockStreak(): number {
  if (mockStreak !== null) return mockStreak;
  const seed = todaySeed();
  const options = [0, 2, 5, 6];
  mockStreak = options[seed % options.length];
  return mockStreak;
}

function buildMockStatus(): CheckinStatus {
  const streak = getMockStreak();
  // When claimed: cycleDay = streak (today's claim day)
  // When not claimed: cycleDay = streak + 1 (next day to claim), capped at 7
  const cycleDay = mockClaimed
    ? Math.max(streak, 1)
    : (streak === 0 ? 1 : Math.min(streak + 1, 7));
  const todayReward = REWARDS_SCHEDULE[cycleDay - 1];
  const tomorrowIdx = Math.min(cycleDay, REWARDS_SCHEDULE.length - 1);
  const tomorrowReward = REWARDS_SCHEDULE[tomorrowIdx];
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return {
    currentStreak: streak,
    cycleDay,
    todayClaimed: mockClaimed,
    todayReward,
    tomorrowReward,
    nextResetAt: tomorrow.toISOString(),
    lastClaimAt: mockClaimed ? now.toISOString() : '',
    lastCycleCompleted: streak >= 7 && mockClaimed,
    selfDirectorRemaining: streak >= 7 ? 3 : 0,
  };
}

// ── Public API ──

export async function fetchCheckinStatus(): Promise<CheckinStatus> {
  if (USE_MOCK) {
    await mockDelay();
    return buildMockStatus();
  }
  const tz = getClientTz();
  const query = tz ? `?client_tz=${encodeURIComponent(tz)}` : '';
  return apiGet<CheckinStatus>(`${API_PREFIX}/checkin/status${query}`);
}

export async function claimCheckin(): Promise<CheckinClaimResult> {
  if (USE_MOCK) {
    await mockDelay(800);
    const before = getMockStreak();
    const cycleDay = before === 0 ? 1 : Math.min(before + 1, 7);
    const reward = REWARDS_SCHEDULE[cycleDay - 1];
    mockStreak = cycleDay;
    mockClaimed = true;
    return {
      streakDay: cycleDay,
      cycleDay,
      energyGranted: reward.energy + reward.bonus,
      bonusGranted: reward.bonus,
      selfDirectorGranted: reward.selfDirector,
      milestone: reward.milestone,
      cycleCompleted: cycleDay >= 7,
      isCapped: false,
      alreadyClaimed: false,
      capReason: '',
    };
  }
  return apiRequest<CheckinClaimResult>(`${API_PREFIX}/checkin/claim`, {
    client_tz: getClientTz(),  // ⚠️ POST body uses snake_case (Kratos JSON unmarshaler accepts both)
  });
}

export async function fetchCheckinHistory(
  limit: number = 30,
): Promise<CheckinHistory> {
  if (USE_MOCK) {
    await mockDelay();
    const items: CheckinHistoryItem[] = [];
    const today = new Date();
    const streak = getMockStreak();
    for (let i = 0; i < Math.min(limit, streak); i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const streakDay = streak - i;
      const reward = REWARDS_SCHEDULE[Math.max(0, streakDay - 1)];
      items.push({
        clientDate: dateStr,
        streakDay,
        energyGranted: reward.energy + reward.bonus,
        milestone: reward.milestone,
      });
    }
    return { items };
  }
  return apiGet<CheckinHistory>(`${API_PREFIX}/checkin/history?limit=${limit}`);
}

/** Reset mock state — for demo/testing only. */
export function resetMockCheckin(streak?: number, claimed?: boolean): void {
  mockStreak = streak ?? null;
  mockClaimed = claimed ?? false;
}
