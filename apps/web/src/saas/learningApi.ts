import { api, SaaSApiError, tenantPath } from './api';

/** A workspace's learning settings (learning.go): Help improve AwwO, which only its owner turns on, and memory
 *  suggestions from runs, which an admin turns on. Each is shown only where this AwwO offers it. */
export interface LearningSetting { offered: boolean; on: boolean; since: string | null }
export interface LearningSettings { consent: LearningSetting; memorySuggestions: LearningSetting; elsewhere: boolean }

const setting = (x: unknown): x is LearningSetting => !!x && typeof x === 'object' && typeof (x as LearningSetting).offered === 'boolean'
  && typeof (x as LearningSetting).on === 'boolean' && ((x as LearningSetting).since === null || typeof (x as LearningSetting).since === 'string');
function checked(value: unknown): LearningSettings {
  const x = value as Partial<LearningSettings> | null;
  if (!x || !setting(x.consent) || !setting(x.memorySuggestions)) throw new SaaSApiError(502, 'invalid_learning_response', 'Learning settings returned incomplete data. Try again.');
  // An API before `elsewhere` says nothing of other workspaces.
  return { consent: x.consent, memorySuggestions: x.memorySuggestions, elsewhere: x.elsewhere === true };
}

export async function readLearningSettings(tenantId: string, signal?: AbortSignal): Promise<LearningSettings> {
  return checked(await api<unknown>(tenantPath(tenantId, '/learning'), { signal }));
}
export async function updateLearningSettings(tenantId: string, change: { consent?: boolean; memorySuggestions?: boolean }, signal?: AbortSignal): Promise<LearningSettings> {
  return checked(await api<unknown>(tenantPath(tenantId, '/learning'), { method: 'PUT', body: JSON.stringify(change), signal }));
}
