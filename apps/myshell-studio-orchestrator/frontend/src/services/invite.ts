// Invite code service — real backend calls.
//
// Backend spec: docs/invitecode-backend.md
// Endpoints (all POST, proto-JSON responses):
//   /v1/telegram/miniapp/dreamy/earn          — get my invite code, link & stats
//   /v1/telegram/miniapp/dreamy/invite/apply  — redeem someone else's code

import { apiRequest, API_PREFIX } from './api';

// ── Types ─────────────────────────────────────────────────────────────────

/** POST /earn response. */
export interface EarnData {
  inviteCode: string;              // e.g. "DRM-7X9K2F"
  inviteLink: string;              // e.g. "https://t.me/DreamyAI_bot?start=invite_DRM-7X9K2F"
  friendsInvited: number;
  energyEarnedFromInvite: number;
}

/** POST /invite/apply success response (HTTP 200).
 *  On failure the backend throws HTTP 400 with ApiError. */
export interface ApplyInviteResult {
  success: boolean;
  message: string;
  energyRewarded: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

const str = (raw: Raw, camel: string, snake: string): string =>
  (raw[camel] as string | undefined) ?? (raw[snake] as string | undefined) ?? '';

const num = (raw: Raw, camel: string, snake: string): number =>
  Number(raw[camel] ?? raw[snake] ?? 0);

// ── API calls ─────────────────────────────────────────────────────────────

export async function fetchEarn(): Promise<EarnData> {
  const raw = await apiRequest<Raw>(`${API_PREFIX}/earn`, {});
  return {
    inviteCode: str(raw, 'inviteCode', 'invite_code'),
    inviteLink: str(raw, 'inviteLink', 'invite_link'),
    friendsInvited: num(raw, 'friendsInvited', 'friends_invited'),
    energyEarnedFromInvite: num(raw, 'energyEarnedFromInvite', 'energy_earned_from_invite'),
  };
}

export async function applyInviteCode(code: string): Promise<ApplyInviteResult> {
  const raw = await apiRequest<Raw>(`${API_PREFIX}/invite/apply`, { code });
  return {
    success: Boolean(raw.success),
    message: str(raw, 'message', 'message'),
    energyRewarded: num(raw, 'energyRewarded', 'energy_rewarded'),
  };
}
