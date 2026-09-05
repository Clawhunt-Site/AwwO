import type {
  InitResponse,
  ExploreResponse,
  BotDetailResponse,
  GenerateResponse,
  GenerateResultResponse,
  LibraryItem,
  LibraryResponse,
  RecommendationsResponse,
  EstimateEnergyCostResponse,
  VideoCustomization,
} from '../types';
import type { FormData } from '../types/form';
import { recordMetric } from './network-probe';
import i18n from '../i18n';

// ── Config ──

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://api.myshell.fun';
export const API_PREFIX = '/v1/telegram/miniapp/dreamy';

function getInitData(): string {
  // Only honor VITE_TELEGRAM_INIT_DATA in dev builds. Vite inlines
  // import.meta.env.VITE_* as literals at build time, so without this
  // guard any real Telegram signature in .env would leak into the prod
  // JS bundle and allow impersonation of that user.
  if (import.meta.env.DEV && import.meta.env.VITE_TELEGRAM_INIT_DATA) {
    return import.meta.env.VITE_TELEGRAM_INIT_DATA;
  }
  return window.Telegram?.WebApp?.initData || '';
}

export function hasTelegramInitData(): boolean {
  return Boolean(getInitData());
}

// ── Base request ──

export class ApiError extends Error {
  code: number;
  reason: string;

  constructor(code: number, reason: string, message: string) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

export function isNotEnoughEnergyError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return (
    err.reason === 'ERROR_REASON_USER_NOT_ENOUGH_ENERGY' ||
    (err.reason === 'ERROR_REASON_BAD_REQUEST_ERROR' && err.message === 'NO ENERGY')
  );
}

export function isSubscriptionRequiredError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return err.reason === 'ERROR_REASON_BAD_REQUEST_ERROR' && err.message === 'SUBSCRIPTION_REQUIRED';
}

export function isNeedStoreRedirect(err: unknown): boolean {
  if (isNotEnoughEnergyError(err)) return true;
  // SUBSCRIPTION_REQUIRED = non-VIP user picked a VIP video combo; in the TG
  // world "VIP" means bought an energy pack, so we route them to the store.
  if (isSubscriptionRequiredError(err)) return true;
  if (!(err instanceof ApiError)) return false;
  return (
    (err.reason === 'ERROR_REASON_BAD_REQUEST_ERROR' && err.message === 'Not Subscribed') ||
    (err.reason === 'ERROR_REASON_BAD_REQUEST_ERROR' && err.message === 'FREE_TRIAL_EXHAUSTED')
  );
}

export async function apiRequest<T>(
  endpoint: string,
  body: Record<string, unknown> = {},
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const { signal: externalSignal, timeoutMs = 30_000 } = options;
  const url = `${API_BASE_URL}${endpoint}`;
  const start = performance.now();

  // Combine external abort + timeout into a single controller so fetch sees one signal.
  // AbortSignal.any() is only Safari 17.4+, so wire it manually for older iOS WebKit.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'myshell-service-name': 'organics-api',
        'X-Telegram-Init-Data': getInitData(),
        'Accept-Language': i18n.language || 'en',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const duration = performance.now() - start;
    // Caller cancelled — propagate AbortError as-is so callers can detect it.
    if (externalSignal?.aborted) {
      recordMetric(endpoint, null, duration, 'abort');
      throw err;
    }
    // Our timeout fired — report clearly instead of Safari's cryptic "Load failed".
    if (controller.signal.aborted) {
      recordMetric(endpoint, null, duration, 'timeout', `timeout after ${timeoutMs}ms`);
      throw new Error(`Request timeout after ${timeoutMs}ms: ${endpoint}`);
    }
    recordMetric(endpoint, null, duration, 'network', (err as Error).message);
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }

  const text = await response.text();

  if (!response.ok) {
    recordMetric(endpoint, response.status, performance.now() - start, 'http', text.slice(0, 200));
    try {
      const body = JSON.parse(text);
      if (body.reason) {
        throw new ApiError(body.code, body.reason, body.message || text);
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
    }
    throw new Error(`API ${response.status}: ${text.slice(0, 200)}`);
  }

  recordMetric(endpoint, response.status, performance.now() - start, 'none');

  if (!text || text.trim() === '') return {} as T;
  try { return JSON.parse(text); }
  catch { throw new Error(`Invalid JSON from ${endpoint}: ${text.slice(0, 100)}`); }
}

// ── GET request (for endpoints that use HTTP GET + query params) ──

export async function apiGet<T>(
  endpoint: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const { signal: externalSignal, timeoutMs = 30_000 } = options;
  const url = `${API_BASE_URL}${endpoint}`;
  const start = performance.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'myshell-service-name': 'organics-api',
        'X-Telegram-Init-Data': getInitData(),
        'Accept-Language': i18n.language || 'en',
      },
      signal: controller.signal,
    });
  } catch (err) {
    const duration = performance.now() - start;
    if (externalSignal?.aborted) {
      recordMetric(endpoint, null, duration, 'abort');
      throw err;
    }
    if (controller.signal.aborted) {
      recordMetric(endpoint, null, duration, 'timeout', `timeout after ${timeoutMs}ms`);
      throw new Error(`Request timeout after ${timeoutMs}ms: ${endpoint}`);
    }
    recordMetric(endpoint, null, duration, 'network', (err as Error).message);
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }

  const text = await response.text();

  if (!response.ok) {
    recordMetric(endpoint, response.status, performance.now() - start, 'http', text.slice(0, 200));
    try {
      const body = JSON.parse(text);
      if (body.reason) {
        throw new ApiError(body.code, body.reason, body.message || text);
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
    }
    throw new Error(`API ${response.status}: ${text.slice(0, 200)}`);
  }

  recordMetric(endpoint, response.status, performance.now() - start, 'none');

  if (!text || text.trim() === '') return {} as T;
  try { return JSON.parse(text); }
  catch { throw new Error(`Invalid JSON from ${endpoint}: ${text.slice(0, 100)}`); }
}

// ── Init ──

// One-shot flag so the TG start_param invite code is only forwarded on the
// very first init of a session. Subsequent refreshes (post-apply, post-purchase)
// must NOT re-send it, otherwise the backend would register duplicate clicks.
let inviteCodeSent = false;

/** Invite code extracted from Telegram start_param, available for UI pre-fill. */
let deepLinkInviteCode: string | null = null;

/** Returns the invite code from the deep link, if any. One-shot: returns the
 *  value once, then clears it so the modal doesn't re-trigger on re-renders. */
export function consumeDeepLinkInviteCode(): string | null {
  const code = deepLinkInviteCode;
  deepLinkInviteCode = null;
  return code;
}

function readInviteCodeFromStartParam(): string | undefined {
  if (inviteCodeSent) return undefined;

  // Source 1: Telegram start_param (e.g. start=invite_DRM-XXXXXX)
  try {
    const startParam = (
      window.Telegram?.WebApp?.initDataUnsafe as { start_param?: string } | undefined
    )?.start_param;
    if (startParam && startParam.startsWith('invite_')) {
      inviteCodeSent = true;
      const code = startParam.slice('invite_'.length); // "DRM-XXXXXX"
      deepLinkInviteCode = code;
      return code;
    }
  } catch { /* ignore */ }

  // Source 2: URL query param (e.g. ?invite_code=DRM-XXXXXX)
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('invite_code');
    if (code) {
      inviteCodeSent = true;
      deepLinkInviteCode = code;
      return code;
    }
  } catch { /* ignore */ }

  return undefined;
}

export async function fetchInit(): Promise<InitResponse> {
  const inviteCode = readInviteCodeFromStartParam();
  const raw = await apiRequest<Record<string, unknown>>(
    `${API_PREFIX}/init`,
    inviteCode ? { invite_code: inviteCode } : {},
  );
  // Normalize invite_info from snake_case to camelCase
  const rawInvite = (raw.invite_info ?? raw.inviteInfo) as Record<string, unknown> | undefined;
  return {
    ...raw,
    inviteInfo: rawInvite ? {
      appliedCode: String(rawInvite.applied_code ?? rawInvite.appliedCode ?? ''),
    } : undefined,
    totalGenerationCount: Number(raw.total_generation_count ?? raw.totalGenerationCount ?? 0),
    language: (raw.language as string) || undefined,
    supported_languages: (raw.supported_languages as Record<string, string>) || undefined,
    isVip: Boolean(raw.is_vip ?? raw.isVip ?? false),
  } as InitResponse;
}

// ── Language ──

export async function setUserLanguage(language: string): Promise<string> {
  const res = await apiRequest<{ success: boolean; language: string }>(
    `${API_PREFIX}/language/set`,
    { language },
  );
  return res.language;
}

// ── Energy (cached via init) ──

let energyCache: { value: number; ts: number } | null = null;
const ENERGY_CACHE_TTL = 30_000;

export async function fetchEnergy(): Promise<number> {
  if (energyCache && Date.now() - energyCache.ts < ENERGY_CACHE_TTL) {
    return energyCache.value;
  }
  const init = await fetchInit();
  energyCache = { value: init.energy.balance, ts: Date.now() };
  return init.energy.balance;
}

export function invalidateEnergyCache() {
  energyCache = null;
}

export async function fetchEnergyPacks(): Promise<{ stars: number; energy: number }[]> {
  const init = await fetchInit();
  return init.energyPacks || [];
}

// ── Recommendations ──

export async function fetchRecommendations(): Promise<RecommendationsResponse> {
  return apiRequest<RecommendationsResponse>(`${API_PREFIX}/recommendations`, {});
}

// ── Explore ──

export async function fetchExplore(
  floorUrl?: string,
  page?: number,
  pageSize?: number,
): Promise<ExploreResponse> {
  return apiRequest<ExploreResponse>(`${API_PREFIX}/explore`, {
    ...(floorUrl ? { floor_url: floorUrl } : {}),
    ...(page != null ? { page } : {}),
    ...(pageSize != null ? { page_size: pageSize } : {}),
  });
}

// ── Footer ──

export async function fetchFooter(): Promise<{ footers: { title: string; imageUrl: string; gotoLink: string }[] }> {
  return apiRequest(`${API_PREFIX}/footer`, {});
}

// ── Bot Detail ──

export async function fetchBotDetail(slugId: string): Promise<BotDetailResponse> {
  return apiRequest<BotDetailResponse>(`${API_PREFIX}/get-by-slug`, { slug_id: slugId });
}

// ── Generate ──

export async function generate(
  botId: string,
  inputImg: string[],
  articleId?: string,
  shellJson?: string,
  buttonId?: string,
  customization?: VideoCustomization,
): Promise<GenerateResponse> {
  return apiRequest<GenerateResponse>(`${API_PREFIX}/generate`, {
    bot_id: botId,
    input_img: inputImg,
    ...(articleId ? { article_id: articleId } : {}),
    ...(shellJson ? { shell_json: shellJson } : {}),
    ...(buttonId ? { button_id: buttonId } : {}),
    ...(customization ? { customize: customization } : {}),
  });
}

export async function estimateEnergyCost(
  slugId: string,
  customization: VideoCustomization,
): Promise<EstimateEnergyCostResponse> {
  return apiRequest<EstimateEnergyCostResponse>(`${API_PREFIX}/estimate_energy_cost`, {
    slug_id: slugId,
    customization,
  });
}

export async function fetchGenerateResult(outputJobId: string): Promise<GenerateResultResponse> {
  return apiRequest<GenerateResultResponse>(`${API_PREFIX}/generate/result`, {
    output_job_id: outputJobId,
  });
}

// ── Task ──

export async function fetchTaskRunning(): Promise<{ running: boolean }> {
  return apiRequest(`${API_PREFIX}/task/running`, {});
}

export async function fetchTaskDetail(taskId: string): Promise<unknown> {
  return apiRequest<unknown>(`${API_PREFIX}/task/detail`, { task_id: taskId });
}

export async function retryTask(taskId: string): Promise<void> {
  await apiRequest(`${API_PREFIX}/task/retry`, { task_id: taskId });
}

export async function deleteTask(taskId: string): Promise<void> {
  await apiRequest(`${API_PREFIX}/task/delete`, { task_id: taskId });
}

export async function cancelTask(taskId: string): Promise<void> {
  await apiRequest(`${API_PREFIX}/task/cancel`, { task_id: taskId });
}

export async function likeTask(taskId: string, status: number): Promise<{ status: number }> {
  return apiRequest(`${API_PREFIX}/task/like`, { task_id: taskId, status });
}

// ── Telemetry (fire-and-forget) ──

// Report that the user downloaded a generated work. Backend flips
// porn_task.downloaded_at = now() so the next-day cron can pick this user
// for the invite push. Silent on failure — do not block the download UX.
export async function reportTaskDownload(taskId: string): Promise<void> {
  if (!taskId) return;
  try {
    await apiRequest(`${API_PREFIX}/task/download`, { task_id: taskId });
  } catch (err) {
    console.error('reportTaskDownload failed', err);
  }
}

// Module-level guard so we only report once per session.
// A browser refresh resets this, which is fine — backend allows
// open_count++ on repeat calls.
let inviteOpenedReported = false;

// Report that the user opened the app from the invite push notification.
// Backend stamps ai_invite_push_task.opened_at and stops any active
// AI-Pick push sequence for this user.
export async function reportInviteOpened(): Promise<void> {
  if (inviteOpenedReported) return;
  inviteOpenedReported = true;
  try {
    await apiRequest(`${API_PREFIX}/invite/opened`, {});
  } catch (err) {
    console.error('reportInviteOpened failed', err);
  }
}

// Module-level guard for AI Pick opened reporting.
let pickOpenedReported = false;

// Report that the user opened the app from the AI Pick push notification.
// Backend stamps ai_pick_push_task.opened_at (by task_id when provided,
// otherwise falls back to the latest sent task for this user), stops the
// active AI Pick sequence, and writes an `ai_pick_opened` event to
// shellchannel_tgdreamy_events for funnel analysis.
//
// Launch URL carries `?source=ai_pick&task_id=<id>` — see organics
// sendPush (internal/domain/service/ai_pick_push/service.go).
export async function reportPickOpened(taskId?: number): Promise<void> {
  if (pickOpenedReported) return;
  pickOpenedReported = true;
  try {
    await apiRequest(`${API_PREFIX}/pick/opened`, { task_id: taskId ?? 0 });
  } catch (err) {
    console.error('reportPickOpened failed', err);
  }
}

// ── Share ──

export async function reportShare(taskId: string): Promise<{ share_token: string; share_link: string; prepared_message_id?: string }> {
  return apiRequest(`${API_PREFIX}/share/create`, { task_id: taskId });
}

export async function reportShareOpened(taskId: string, inviterUserId: string): Promise<void> {
  try {
    await apiRequest(`${API_PREFIX}/share/opened`, { task_id: taskId, inviter_user_id: inviterUserId });
  } catch (err) {
    console.error('reportShareOpened failed (backend may not exist yet)', err);
  }
}

// ── Library (all results including in-progress) ──

export interface LibraryGenerateResult {
  status: string;       // "running" | "queued" | "done" | "error"
  result: {
    outputImg: string;
    inputImg: string[];
    width: string;
    height: string;
    errMsg: string;
    outputPreview: string;
    outputPoster: string;
  };
  botId: string;
  slugId: string;
  taskId: string;
  startTime: string;
  floorUrl: string;
  botName: string;
  imageUrl: string;
  botType: string;      // "video" | "image"
  likeStatus: string;
  estimateTaskDuration: string;
  isAiPick?: boolean;
}

export async function fetchLibraryAll(signal?: AbortSignal): Promise<{ generateResults: LibraryGenerateResult[] }> {
  return apiRequest(`${API_PREFIX}/library`, {}, { signal });
}

// ── Library (paginated, completed only) ──

interface LibraryItemResponse {
  id: number;
  taskId: string;
  mediaUrl: string;
  thumbnailUrl: string;
  mediaType: string;
  characterName: string;
  likeStatus: number;
  durationSeconds: number;
  width: number;
  height: number;
  createdAt: string;
}

interface LibraryApiResponse {
  items: LibraryItemResponse[];
  hasMore: boolean;
  lastId: number;
}

export async function fetchLibrary(lastId: number = 0, pageSize: number = 20): Promise<LibraryResponse> {
  const response = await apiRequest<LibraryApiResponse>(
    `${API_PREFIX}/library/list`,
    { lastId, pageSize },
  );
  return {
    items: (response.items || []).map((item): LibraryItem => ({
      id: item.id,
      taskId: item.taskId,
      mediaUrl: item.mediaUrl,
      thumbnailUrl: item.thumbnailUrl,
      mediaType: item.mediaType,
      characterName: item.characterName,
      likeStatus: item.likeStatus || 0,
      durationSeconds: item.durationSeconds,
      width: item.width,
      height: item.height,
      createdAt: item.createdAt,
    })),
    has_more: response.hasMore,
    last_id: response.lastId,
  };
}

export async function libraryFeedback(taskId: string, status: number): Promise<{ status: number }> {
  return apiRequest(`${API_PREFIX}/library/feedback`, { taskId, status });
}

export async function libraryDelete(taskId: string): Promise<void> {
  await apiRequest(`${API_PREFIX}/library/delete`, { taskId });
}

// ── Energy History ──

interface EnergyHistoryApiResponse {
  records: {
    detail: string;
    date: string;
    energyChange: number;
    type: string;
    imageUrl: string;
    balanceAfter: number;
    price: string;
  }[];
  total: number;
  page: number;
  pageSize: number;
}

export async function fetchEnergyHistory(
  filter: string = 'all',
  page: number = 1,
  pageSize: number = 20,
): Promise<EnergyHistoryApiResponse> {
  const raw = await apiRequest<Record<string, unknown>>(
    `${API_PREFIX}/energy/history`,
    { filter, page, pageSize },
  );
  // Normalize snake_case → camelCase for each record
  const rawRecords = (raw.records ?? []) as Record<string, unknown>[];
  return {
    records: rawRecords.map(r => ({
      detail: String(r.detail ?? ''),
      date: String(r.date ?? ''),
      energyChange: Number(r.energyChange ?? r.energy_change ?? 0),
      type: String(r.type ?? ''),
      imageUrl: String(r.imageUrl ?? r.image_url ?? ''),
      balanceAfter: Number(r.balanceAfter ?? r.balance_after ?? 0),
      price: String(r.price ?? ''),
    })),
    total: Number(raw.total ?? 0),
    page: Number(raw.page ?? 1),
    pageSize: Number(raw.pageSize ?? raw.page_size ?? 20),
  };
}

// ── Upload (image to S3) ──

const CONTENT_TYPE_MAP: Record<string, number> = {
  'image/png': 3,
  'image/jpeg': 4,
  'image/webp': 12,
};

export async function uploadImage(file: File): Promise<string> {
  const contentType = CONTENT_TYPE_MAP[file.type] ?? 4;

  // Response may use camelCase or snake_case depending on backend
  const raw = await apiRequest<Record<string, string>>(`${API_PREFIX}/get_upload_presign_url`, {
    file_info: {
      scenario: 19,
      content_type: contentType,
      file_name: file.name,
      content_length: String(file.size),
    },
  });

  const uploadUrl = raw.uploadUrl || raw.upload_url;
  const objectAccessUrl = raw.objectAccessUrl || raw.object_access_url;
  const presignContentType = raw.contentType || raw.content_type || file.type;
  const expiresAt = raw.expiresAt || raw.expires_at || '';

  if (!uploadUrl) throw new Error('Presign failed: no uploadUrl in response');

  await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': presignContentType,
      ...(expiresAt ? { 'Expires': expiresAt } : {}),
    },
    body: file,
  });

  if (!objectAccessUrl) throw new Error('Presign failed: no objectAccessUrl in response');
  return objectAccessUrl;
}

// ── Form config (for Upload page) ──

export async function fetchForm(slugId: string): Promise<FormData | null> {
  try {
    const resp = await apiRequest<{ formData: string }>(
      '/v1/shellchannel/telegram/miniapp/get_form_by_app_id',
      { app_id: 9, init_data: getInitData(), slug_id: slugId },
    );
    return JSON.parse(resp.formData) as FormData;
  } catch {
    return null;
  }
}

// ── Invoice (TG Stars) ──

export async function createInvoice(energyPackId: string): Promise<string> {
  const response = await apiRequest<{ invoiceLink: string }>(
    '/v1/telegram/miniapp/dreamy/create_invoice',
    { init_data: getInitData(), energy_pack_id: energyPackId },
  );
  return response.invoiceLink;
}
