export const API_BASE = '/api/v1';
export class SaaSApiError extends Error {
  /** `details`: the API's machine-readable details of the refusal (no user content), such as a plan's contextRoom. */
  constructor(public status: number, public code: string, message: string, public details: Readonly<Record<string, unknown>> = {}) { super(message); }
}
// Once the API reports that the signed-in session has ended, nothing but the sign-in routes is
// sent again: pollers stop reaching the server, and the page offers a new sign-in instead.
let signedIn = false;
let sessionEnded = false;
// Which session a request belongs to: it changes at every sign-in and sign-out, so a reply can end only the
// session it was sent under. The page's first /auth/me goes out signed out; when its 401 arrives after a
// sign-in that finished meanwhile, it says nothing about the new session.
let sessionGeneration = 0;
const sessionEndListeners = new Set<() => void>();
/** Marks whether the page currently holds a signed-in session; either way an earlier ended one is cleared.
 *  Call it only when the credential changes (sign-in, account link, sign-out): each call starts a new
 *  session, so replies to requests already in flight can no longer end it. */
export function trackSignedInSession(active: boolean): void {
  signedIn = active;
  sessionEnded = false;
  sessionGeneration += 1;
}
export function onSessionEnded(listener: () => void): () => void {
  sessionEndListeners.add(listener);
  return () => { sessionEndListeners.delete(listener); };
}
function endSession(sentUnder: number): void {
  if (!signedIn || sessionEnded || sentUnder !== sessionGeneration) return;
  sessionEnded = true;
  for (const listener of [...sessionEndListeners]) listener();
}
const ENDED_MESSAGE = 'Your session expired. Sign in again.';
/** Tells the API's model listings that this page honours their userChosen mark: it never picks such a model by itself
 *  (canvas/userChosenModels.ts). Without it they leave such models out, so a page of an earlier release, which would,
 *  is never shown one (backend tenant_models.go listedFor). */
export const MODEL_MARKS_HEADER = 'X-Awwo-Model-Marks';
/** Tells a canvas save which kinds of node this page understands. A page of an earlier release drops a node whose
 *  agentRef it does not know (a market Agent's) when it saves, so the API refuses a save without `market` that would drop
 *  or change a stored market node (409 canvas_reload_required; docs/awwo-agent-market.md). Every canvas PUT carries it. */
export const CANVAS_FEATURES_HEADER = 'X-Awwo-Canvas-Features';
export const CANVAS_FEATURES = 'market';
const CANVAS_DOCUMENT_PATH = /^\/tenants\/[^/?]+\/canvases\/[^/?]+$/;
export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  if (sessionEnded && !path.startsWith('/auth/')) throw new SaaSApiError(401, 'unauthorized', ENDED_MESSAGE);
  const sentUnder = sessionGeneration;
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  headers.set(MODEL_MARKS_HEADER, 'userChosen');
  if (init.body) headers.set('Content-Type', 'application/json');
  if ((init.method || 'GET').toUpperCase() === 'PUT' && CANVAS_DOCUMENT_PATH.test(path)) headers.set(CANVAS_FEATURES_HEADER, CANVAS_FEATURES);
  const response = await fetch(`${API_BASE}${path}`, { ...init, credentials: 'include', headers });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const details = payload?.error?.details;
    const error = new SaaSApiError(response.status, payload?.error?.code || 'request_failed',
      payload?.error?.message || (typeof payload?.error === 'string' ? payload.error : `请求失败（${response.status}）`),
      details && typeof details === 'object' && !Array.isArray(details) ? details : {});
    if (error.status === 401 && error.code === 'unauthorized') endSession(sentUnder);
    throw error;
  }
  return payload as T;
}
/** fetch for API responses read raw (event streams, downloads), under the same session-ended rule as api(). */
export async function sessionFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (sessionEnded) return new Response(JSON.stringify({ error: { code: 'unauthorized', message: ENDED_MESSAGE } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  const sentUnder = sessionGeneration;
  const response = await fetch(url, init);
  if (response.status === 401 && signedIn && !sessionEnded && sentUnder === sessionGeneration) {
    const code = await response.clone().json().then((payload: any) => payload?.error?.code, () => undefined);
    if (code === 'unauthorized') endSession(sentUnder);
  }
  return response;
}
export type Tenant = { id: string; name: string; status: string; role: string; maxConcurrentRuns: number; maxRunsPerDay: number; createdAt?: string };
export type Identity = { user: { id: string; email: string; name: string; platformRole: 'user' | 'admin' }; tenants: Tenant[]; personalCredentialsRequired?: boolean; authentication?: 'clawhunt' | 'local'; clawhuntSiteURL?: string;
  /** The deployment: the hosted site, or the local edition (edition.ts). An API that does not say is the hosted site. */
  edition?: 'hosted' | 'local';
  /** The hosted site offers AwwO 本地版 its models, with keys made in 设置 → 本机版连接 (settings/relay.tsx). */
  relay?: boolean };
export type CanvasRecord = { id: string; tenantId: string; name: string; document: unknown; version: number; createdAt: string; updatedAt: string };
/** A canvas as a list shows it. The summary view (`?view=summary`) sends its outline, its nodes' boxes and its edges for
 * the card's thumbnail, instead of its document, so a list never downloads every node's output; an API without that
 * view sends the document. Never a canvas to edit or save: read the canvas itself for that. */
export type CanvasListItem = Omit<CanvasRecord, 'document'> & { outline?: unknown; document?: unknown };
/** API Agent runtime is persisted independently of a canvas draft. Legacy records default to Pi. */
export type SaaSAgent = { id: string; tenantId: string; name: string; runtime?: 'pi' | 'openai-agents'; model: string; instructions?: string; status?: string;
  effort?: string; role?: string; title?: string; adapterType?: 'pi' | 'openai-agents'; adapterConfig?: { model?: string; effort?: string } };
export const tenantPath = (tenantId: string, suffix = '') => `/tenants/${encodeURIComponent(tenantId)}${suffix}`;

export const runtimeUnavailableMessages: [string, string] = [
  '执行引擎尚未就绪。请检查模型连接及本次运行节点的执行引擎和模型配置；若仍无法运行，请联系管理员。',
  'The execution engine is not ready. Check the model connection and the engine and model settings of nodes in this run. If it remains unavailable, contact an administrator.',
];

/** The deployment-wide daily ceiling on free default-model calls (free_capacity_exceeded) is full for today. It is
 *  the service's limit, not this workspace's, and the paid plans are outside it, so the copy says so and offers
 *  only what works: the next UTC day or a plan. */
export const freeCapacityMessages: [string, string] = [
  '今天全站免费使用默认模型的名额已满。免费调用在 UTC 次日恢复；想现在继续，可以升级到 Pro / Max 付费套餐（账号菜单 → 套餐与点数），套餐不受这个名额限制。',
  'The free default model is at its daily capacity for the whole service today. Free calls come back after the next UTC day; to keep going now, upgrade to the Pro or Max plan (account menu → Plans and credits), which this limit does not apply to.',
];

/** The workspace's own run allowance is full (quota_exceeded): today's calls are used up, or as many runs as it may
 *  have at once are going. Admission refuses it only without a plan, and the paid plans have more of both, so the copy
 *  leads with them; waiting is the free way on. */
export const quotaExceededMessages: [string, string] = [
  '工作区运行额度已满：今天的调用次数用完了，或同时运行的任务到了上限。升级 Pro / Max 付费套餐，每天的次数多得多、能同时运行更多任务，马上就能继续（账号菜单 → 套餐与点数）；不升级的话，等进行中的任务结束，或等 UTC 0 点（北京时间早上 8 点）次数重置。',
  'The workspace run quota has been reached: today’s calls are used up, or too many runs are going at once. Upgrade to the Pro or Max plan for many more calls a day and more runs at once, and continue right away (account menu → Plans and credits); otherwise wait for active runs to finish, or for the calls to reset at 00:00 UTC.',
];

/** Translate known application failures; retain unknown service details rather than invent a cause. */
export function saasErrorMessage(error: unknown, locale: 'zh' | 'en'): string {
  return serviceMessage(error, locale, serviceCodes());
}

let serviceCopies: Set<string> | undefined;
/** Whether the text is a code's copy below, in either language: what a node's own Send records of a failure only the
 *  service words (canvasErrors.ts canvasErrorMessage), which the canvas tells from the provider's own words. */
export function isServiceCopy(text: string): boolean {
  serviceCopies ??= new Set(Object.values(serviceCodes()).flat());
  return serviceCopies.has(text);
}

/** Each known application failure code's copy: [zh, en]. */
function serviceCodes(): Record<string, [string, string]> {
  const codes: Record<string, [string, string]> = {
    invalid_task_frame: ['任务要求无效或版本不受支持；输入已保留。请检查条数与长度后重试。', 'Task requirements are invalid or unsupported. Your input is preserved. Check the entry counts and lengths before retrying.'],
    invalid_run_evidence: ['证据响应无效，请重试读取。', 'Invalid evidence response. Retry reading it.'],
    invalid_run_archive: ['下载记录响应无效，请重试。', 'Invalid archive response. Retry the download.'],
    account_password_as_key: ['这里需要模型服务商的 API Key，请勿填写 AwwO 登录密码。','Enter a provider API key here, not your AwwO login password.'],
    vault_unavailable: ['个人密钥服务尚未配置，请联系管理员。','Personal credential storage is not configured. Contact the administrator.'],
    provider_verification_failed: ['密钥验证失败，请检查 API Key、服务商额度和访问地区。','Key verification failed. Check your API key, provider access and region.'],
    invalid_connection: ['请选择正确的服务商、执行引擎并填写有效密钥。','Select a provider, supported engine and valid API key.'],
    connection_limit: ['最多保存 8 个个人连接。','Up to eight personal connections are allowed.'],
    // 设置 → 本机版连接 (settings/relay.tsx).
    relay_key_limit: ['最多同时有 5 个有效的连接密钥，请先撤销一个。', 'An account holds at most five live connection keys. Revoke one first.'],
    relay_unavailable: ['线上 AwwO 暂未开放本机版连接。', 'The online AwwO does not offer AwwO Local connections right now.'],
    invalid_relay_key: ['请给密钥起一个不超过 80 个字的名称，并选择一个工作区。', 'Name the key (at most 80 characters) and choose a workspace.'],
    tenant_not_found: ['找不到这个工作区，或你在其中只能查看。', 'That workspace was not found, or you can only read it.'],
    // AwwO 本地版's AwwO 云端 connection (cloud_connections.go).
    cloud_key_rejected: ['线上 AwwO 不接受这个连接密钥，它可能已撤销或过期。请在线上 AwwO 的「设置 → 本机版连接」生成新密钥。', 'The online AwwO did not take this connection key; it may be revoked or expired. Make a new one on the online AwwO under Settings → AwwO Local connection.'],
    cloud_no_models: ['这个密钥所属的线上工作区不能使用任何云端模型。', 'This key’s online workspace may use no cloud model.'],
    cloud_unavailable: ['暂时连不上线上 AwwO，请稍后再试。', 'The online AwwO could not be reached. Try again shortly.'],
    email_unavailable: ['邮件找回服务尚未配置，请联系管理员。','Password recovery email is not configured. Contact the administrator.'],
    reset_invalid: ['重设链接已失效，请重新申请。','The reset link is invalid or expired. Request another.'],
    unauthenticated: ['请重新登录。', 'Please sign in again.'], forbidden: ['你没有执行此操作的权限。', 'You do not have permission for this action.'],
    unauthorized: ['登录已失效，请重新登录；本机草稿仍保留。', 'Your session expired. Sign in again; local drafts are preserved.'],
    invalid_credentials: ['邮箱或密码不正确。', 'The email or password is incorrect.'], invalid_input: ['输入无效，请检查后重试。', 'Check the entered values and try again.'],
    sso_expired: ['账号关联请求已过期，请重新使用 ClawHunt 账号继续。', 'The account-linking request expired. Continue with ClawHunt again.'],
    sso_link_failed: ['原 AwwO 密码验证失败；本次关联请求已用尽，请从 ClawHunt 重新开始。', 'The original AwwO password could not be verified. This linking request has been used; start again from ClawHunt.'],
    clawhunt_invite_required: ['请创建邀请链接，对方使用 ClawHunt 账号确认后加入工作区。', 'Create an invitation link so the recipient can join with their ClawHunt account.'],
    sso_unavailable: ['暂时无法确认 ClawHunt 账号，请稍后重试。', 'Could not verify your ClawHunt account right now. Try again later.'],
    invalid_cursor: ['分页已失效，请刷新列表重新开始。', 'Pagination expired. Refresh the listing.'],
    case_record_unavailable: ['无法读取这个案例的运行实录，没有创建画布。请刷新后重试。', 'Could not load this case’s run recording, so no canvas was created. Refresh and try again.'],
    invalid_pagination: ['分页参数无效，请刷新列表重新开始。', 'The pagination parameters are invalid. Refresh the listing.'],
    email_exists: ['此邮箱已注册，请登录。', 'This email is already registered. Please sign in.'],
    not_found: ['找不到此资源，或你没有访问权限。', 'This resource was not found or is not accessible.'],
    conflict: ['内容已发生变化，请重新读取后重试。', 'The content has changed. Reload it before retrying.'],
    version_conflict: ['画布版本已变化，请刷新云端版本后重试；输入仍保留。', 'The canvas version changed. Refresh the cloud version and retry; your input is preserved.'],
    resource_in_use: ['画布仍有正在执行的运行或规划，请等待结束或先停止运行。', 'The canvas has an active run or plan. Wait for it to finish or stop it first.'],
    invalid_appearance: ['配色文件或颜色无效，请检查后重试。', 'Invalid color scheme or color. Check it and try again.'],
    upload_too_large: ['文件太大：每个文件最多 64 MB。', 'The file is too large: each file can be at most 64 MB.'],
    upload_empty: ['这是一个空文件，没有上传。', 'The file is empty and was not uploaded.'],
    upload_interrupted: ['上传中断了，请重试。', 'The upload was interrupted. Try again.'],
    upload_quota_exceeded: ['这个工作区今天的上传次数用完了，明天再试。', 'This workspace has used today’s uploads. Try again tomorrow.'],
    upload_storage_full: ['这个工作区的上传空间已满，删掉不用的画布后再试。', 'This workspace’s upload space is full. Delete canvases you no longer need and try again.'],
    upload_unavailable: ['文件上传暂时不可用，请稍后再试。', 'File uploads are not available right now. Try again later.'],
    invalid_upload_name: ['文件名无效，改个名字再上传。', 'The file name is invalid. Rename the file and try again.'],
    tenant_suspended: ['工作区已暂停，请联系管理员或切换工作区。', 'This workspace is suspended. Contact an administrator or switch workspaces.'],
    session_busy: ['此会话正在运行，请稍后重试。', 'This session is running. Try again when it finishes.'],
    // What a run would send was more than its model reads at once: the request, the node's brief and inputs, what
    // upstream nodes delivered, files, selected knowledge and attached skills (a page the assistant plans has two). A
    // node's own history is trimmed to fit by itself and is never the cause, so the copy points at what the reader can
    // change.
    context_limit: ['这次要发给模型的内容超出了它一次能读的量，没有运行。可以换一个上下文更大的模型，或少带一些内容（上游节点的交付、附件、选中的资料、添加的技能）后再试。',
      'What this would send is more than the model can read at once, so it did not run. Choose a model with a larger context, or bring less into it (what upstream nodes delivered, attachments, selected knowledge, attached skills), then try again.'],
    rate_limited: ['请求过于频繁，请稍后重试。', 'Too many requests. Please try again later.'],
    quota_exceeded: quotaExceededMessages,
    free_capacity_exceeded: freeCapacityMessages,
    personal_engine_required: ['请先到「我的引擎」添加并验证你自己的 API Key。', 'Add and verify your API key in My engines before running.'],
    model_unavailable: ['所选模型不可用，请重新选择服务端提供的模型。', 'The selected model is unavailable. Choose a model offered by the server.'],
    computer_model_unsupported: ['托管执行暂不支持该模型，请选择列表中提供的模型。', 'Managed execution does not support this model. Choose one from the list.'],
    runtime_unavailable: runtimeUnavailableMessages,
    // Distinct from model_unavailable: the model exists but is not open to this
    // workspace, so the fix is an administrator grant rather than another model.
    model_not_allowed: ['此模型未向本工作区开放，请选择本工作区可用的模型或联系管理员。', 'This model is not available to this workspace. Choose one offered to it or contact an administrator.'],
    media_unavailable: ['图像与视频生成尚未配置，请联系管理员。', 'Image and video generation is not configured. Contact an administrator.'],
    media_storage_full: ['媒体存储空间不足，暂停新的图像与视频生成；请联系管理员。', 'Media storage is full, so new image and video generations are paused. Contact an administrator.'],
    media_storage_unavailable: ['暂时无法保存生成的媒体，请联系管理员。', 'Generated media cannot be stored right now. Contact an administrator.'],
    media_capacity_exceeded: ['今日平台的图像与视频生成额度已用完，请在 UTC 次日重试。', 'Today’s image and video generations for the service are used up. Try again after the next UTC day.'],
    model3d_quota_exceeded: ['本工作区今天的免费 3D 模型生成次数已用完，请在 UTC 次日重试；Pro / Max 付费套餐可以用点数继续生成（账号菜单 → 套餐与点数）。', 'This workspace has used today’s free 3D model generations. Try again after the next UTC day; the Pro and Max plans keep generating on credits (account menu → Plans and credits).'],
    model3d_capacity_exceeded: ['今天全站的免费 3D 模型生成名额已用完，请在 UTC 次日重试；Pro / Max 付费套餐不受这个名额限制。', 'Today’s free 3D model generations for the whole service are used up. Try again after the next UTC day; the Pro and Max plans are not limited by it.'],
    model3d_motion_plan_required: ['给 3D 模型绑定骨骼、加动作需要 Pro / Max 付费套餐（账号菜单 → 套餐与点数）；不加骨骼的 3D 模型仍可免费生成。', 'Rigging and animating a 3D model needs the Pro or Max plan (account menu → Plans and credits); a 3D model without a skeleton can still be made for free.'],
    media_quota_exceeded: ['本工作区今日的图像与视频生成次数已用完，请在 UTC 次日重试；需要更多次数可以看看 Pro / Max 付费套餐（账号菜单 → 套餐与点数）。', 'This workspace has used today’s image and video generations. Try again after the next UTC day; for more, see the Pro and Max plans (account menu → Plans and credits).'],
    plan_required: ['这个工作区是在付费套餐下额外创建的，套餐恢复后才能运行；其他工作区不受影响。', 'This workspace was created on a paid plan beyond the free limit and runs again once the plan is back; other workspaces are not affected.'],
    model_unpriced: ['这个模型还不能按点数计费，请换用其他模型。', 'This model cannot be billed in credits yet. Choose another model.'],
    credits_exhausted: ['本期套餐点数已用完：可以换成默认模型继续，点数在下次续费后重置；需要更多点数可以请工作区所有者在「套餐与点数」里升级。', 'This period’s plan credits are used up: switch to the default model to keep going; credits reset after the next renewal. For more, the workspace’s owner can upgrade in Plans and credits.'],
    plan_busy: ['套餐的同时运行数已用满（包括所有者的其他工作区）。等其中一个运行结束后再试。', 'The plan’s agents at once are all running, counting the owner’s other workspaces. Try again when one finishes.'],
    plan_media_quota_exceeded: ['套餐今日的图片 / 视频生成次数已用完，UTC 次日恢复。', 'The plan’s image and video generations for today are used up; they come back after the next UTC day.'],
    checkin_unavailable: ['这个工作区现在没有签到活动。', 'This workspace has no check-ins right now.'],
    checkin_taken: ['这个工作区今天已经有成员签到了，多出的次数已经加上。', 'Another member checked this workspace in today; the extra calls are already added.'],
    checkin_elsewhere: ['你今天已经在另一个工作区签到了，每人每天签一次。', 'You checked in another workspace today; it is one check-in a person a day.'],
    checkout_closed: ['付费套餐即将开放，请稍后再来。', 'Paid plans open soon. Please check back later.'],
    already_subscribed: ['你已经有付费套餐了，请在「管理订阅」里切换或取消。', 'You already have a paid plan. Switch or cancel it in Manage subscription.'],
    no_subscription: ['还没有可管理的订阅。', 'There is no subscription to manage yet.'],
    billing_unavailable: ['暂时无法连接支付服务，请稍后重试。', 'The payment service is unavailable right now. Please try again later.'],
    media_params_invalid: ['节点的生成参数不适用于所选模型，请在节点配置中修改。', 'The node’s generation settings do not fit the selected model. Change them in the node configuration.'],
    media_prompt_invalid: ['提示词为空，或长度不符合该模型要求：请在节点里写好提示词（画布运行时还会接上连到它的上游文字），字数范围见节点配置。', 'The prompt is empty or its length does not fit this model. Write the prompt in the node (a canvas run adds the text wired into it); the allowed range is in the node configuration.'],
    media_knowledge_unsupported: ['图像与视频节点不使用知识库，请取消选择知识后再运行。', 'Image and video nodes do not use knowledge. Clear the knowledge selection and run again.'],
    media_graph_unsupported: ['图像与视频节点需单独运行，不能加入整张画布的运行。', 'Image and video nodes run on their own, not as part of a canvas run.'],
    media_collaboration_unsupported: ['媒体节点不参加协作讨论，请用普通方式运行画布。', 'Media nodes do not take part in a collaboration. Run the canvas normally instead.'],
    invalid_skill: ['技能内容不符合要求：名称只用小写字母、数字和单个连字符，标题和说明各占一行，正文不超过 12 KiB，且不能含不可见的格式字符（例如部分组合表情里的连接符）。请修改后重试。', 'The skill does not meet the requirements: a name of lowercase letters, digits and single hyphens, a one-line title and description, a body of at most 12 KiB, and no invisible formatting characters (such as the joiner inside some combined emoji). Change it and try again.'],
    skill_name_conflict: ['这个工作区已经有同名技能，换一个名称再试。', 'This workspace already has a skill with that name. Choose another name.'],
    skill_limit: ['一个工作区最多保存 100 个技能，请先归档不用的技能。', 'A workspace keeps at most 100 skills. Archive one you no longer use first.'],
    skill_unavailable: ['节点挂载的某个技能已不可用（已被归档）。请在节点配置里移除它后再运行。', 'A skill attached to a node is no longer available (it was archived). Remove it in the node configuration and run again.'],
    preferences_version_conflict: ['设置刚在别的页面里改过，这里已换成最新的值，请重新选择。', 'Your settings changed in another tab. The latest values are shown; choose again.'],
    deletion_withdrawn: ['对方已经撤回了这条删除申请，列表已刷新。', 'The person who asked withdrew this request. The list is refreshed.'],
    deletion_own_request: ['不能处理你自己的删除申请，请让另一位管理员处理。', 'You cannot decide your own deletion request. Ask another administrator.'],
    deletion_account_exists: ['这个账号还在：请先人工删除账号，再标记已处理。', 'This account still exists: delete it by hand first, then mark the request handled.'],
    deletion_account_gone: ['这个账号已经删除了：请标记已处理。', 'This account is already deleted: mark the request handled.'],
    deletion_already_decided: ['这条删除申请已经处理过了，列表已刷新。', 'This deletion request has already been decided. The list is refreshed.'],
    export_busy: ['已有一份导出正在进行，或这一小时的导出次数已用完，请稍后再试。', 'An export is already running, or this hour’s exports are used up. Try again later.'],
    skill_version_conflict: ['这个技能刚被别人改过。请先复制你的修改，取消编辑，再从列表重新打开它修改；直接保存会被拒绝。', 'Someone changed this skill meanwhile. Copy your changes first, cancel, then open it again from the list and edit it; saving as it is will be refused.'],
    skill_context_limit: ['这个节点挂载的技能内容太长，一次调用放不下，请移除一个技能。', 'The skills on this node are too long to fit in one call. Remove one.'],
    skill_registry_unavailable: ['这个服务器没有开启从 skills.sh 查找技能，请联系管理员。', 'Finding skills on skills.sh is not enabled on this server. Contact an administrator.'],
    skill_registry_busy: ['skills.sh 现在请求较多，请一分钟后再试。', 'skills.sh is busy right now. Try again in a minute.'],
    skill_registry_rate_limited: ['一分钟内查找和预览的次数太多，请稍后再试。', 'Too many searches and previews in a minute. Try again shortly.'],
    skill_registry_timeout: ['skills.sh 响应超时，请稍后再试。', 'skills.sh took too long to answer. Try again later.'],
    skill_registry_upstream: ['暂时连不上 skills.sh，或它返回了无法识别的内容，请稍后再试。', 'skills.sh could not be reached or answered unexpectedly. Try again later.'],
    skill_registry_network: ['这台电脑没有连到 skills.sh：它的地址没有通过检查（解析到非公网地址，或本机 DNS 给出代理的替身地址 fake-IP），或本机代理没有连上。用了本机代理时，检查 providers.env 里的 AWWO_WEB_READER_PROXY；代理的 DNS 处于 fake-IP 模式时，需要改用返回真实地址的模式。', 'This computer did not reach skills.sh: its address did not pass the check (it resolves to an address that is not public, or this computer’s DNS gives the proxy’s stand-in fake-IP address), or the proxy on this computer did not connect. With a local proxy, check AWWO_WEB_READER_PROXY in providers.env; a proxy whose DNS is in fake-IP mode has to return real addresses instead.'],
    skill_registry_not_found: ['skills.sh 上还没有这个技能的副本，可以打开它的 GitHub 仓库查看。', 'skills.sh has no copy of this skill yet. Open its GitHub repository instead.'],
    skill_registry_too_large: ['这个技能的正文超过了工作区技能 12 KiB 的上限，无法导入。', 'This skill’s text is larger than the 12 KiB a workspace skill holds, so it cannot be imported.'],
    skill_registry_unimportable: ['这个技能的文件夹里没有 SKILL.md，没有可导入的文字。', 'This skill’s folder has no SKILL.md, so there is no text to import.'],
    skill_registry_unreadable: ['这个 SKILL.md 开头的 --- 说明块读不出来（缺失、没有闭合，或有重复的键），无法导入。', 'This SKILL.md’s opening --- block cannot be read (it is missing, not closed, or repeats a key), so it cannot be imported.'],
    skill_registry_empty: ['这个 SKILL.md 在说明块之后没有正文，无法导入。', 'This SKILL.md has no text after its opening block, so it cannot be imported.'],
    skill_registry_folder_too_large: ['这个技能在 skills.sh 上的文件夹太大（超过 4 MiB 或 500 个文件），AwwO 没有读取。', 'This skill’s folder on skills.sh is larger than AwwO reads (4 MiB in at most 500 files).'],
    skill_registry_answer_too_large: ['skills.sh 返回的内容太大，AwwO 没有读取，请换个搜索词再试。', 'skills.sh answered with more than AwwO reads. Try another search.'],
    skill_registry_hidden_text: ['这个技能的正文含有不可见的格式字符，AwwO 不导入这样的文字。', 'This skill’s text contains invisible formatting characters, which AwwO does not import.'],
    skill_registry_changed: ['这个技能或它的许可在你打开之后变了，已重新读取。请看一下下面的最新内容，确认后再导入。', 'This skill or its license changed since you opened it, so it has been read again. Check the latest version below before importing.'],
    skill_registry_license_unconfirmed: ['没能确认这个技能用的是宽松的开源许可。请先读它的许可条款，确认有权使用后再导入。', 'This skill could not be confirmed to be under a permissive open-source license. Read its license and confirm that you may use it before importing.'],
    invalid_skill_registry_request: ['请求无效：搜索词需要 2–100 个字符，技能要从搜索结果里选。', 'Invalid request: a search needs 2–100 characters, and a skill is chosen from the results.'],
    invalid_memory: ['记忆内容不符合要求：标题占一行、不超过 200 个字符，正文不超过 2 KiB，且不能含不可见的格式字符；搜索词不超过 200 个字符。更长的资料请存入知识库。', 'The memory note does not meet the requirements: a one-line title of at most 200 characters, text of at most 2 KiB and no invisible formatting characters; a search is at most 200 characters. Save longer material to the knowledge base.'],
    memory_version_conflict: ['这条记忆刚被别人改过。请先复制你的修改，取消编辑并刷新，再重新编辑它。', 'Someone changed this note meanwhile. Copy your changes first, cancel and refresh, then edit it again.'],
    memory_limit: ['这个范围最多保存 200 条记忆，请先归档或删除一些。', 'This scope keeps at most 200 notes. Archive or delete some first.'],
    memory_duplicate: ['这个范围里已经有一条内容相同的记忆在用，不需要再保留第二条。', 'A note with the same text is already in use in this scope, so a second one is not kept.'],
    invalid_render: ['视频参数无效：宽和高 64–1920 像素，帧率 1–60，时长 0.5–20 秒，总帧数不超过 1,800。', 'Invalid video settings: 64–1920 pixels wide and high, 1–60 frames per second, 0.5–20 seconds and at most 1,800 frames.'],
    render_unavailable: ['这个服务器没有开启视频渲染，请联系管理员。', 'Video rendering is not enabled on this server. Contact an administrator.'],
    render_busy: ['这个工作区已有一个视频正在渲染，等它完成后再试。', 'This workspace is already rendering a video. Try again when it finishes.'],
    render_quota: ['今天的视频渲染次数已用完（本工作区或全站），请在 UTC 次日再试。', 'Today’s video renders are used up, for this workspace or the whole service. Try again after the next UTC day.'],
    render_too_large: ['这个页面太大，无法渲染成视频：最多 6 MiB。', 'This page is too large to render as a video: at most 6 MiB.'],
    web_reader_unavailable: ['这个服务器没有开启网页读取，请联系管理员。', 'Reading from a web address is not enabled on this server. Contact an administrator.'],
    web_reader_busy: ['网页读取正忙，请稍后再试。', 'The web reader is busy. Try again in a moment.'],
    web_read_in_progress: ['这个网页还在读取中，请稍后再试。', 'This page is still being read. Try again in a moment.'],
    knowledge_request_timeout: ['知识库请求超时，请重新读取确认结果；没有自动重复提交。', 'The knowledge request timed out. Reload to check the result; nothing was sent again.'],
    knowledge_context_limit: ['选中的知识合计超过 64 KiB，一次任务带不下；请少选几份或选更短的资料。', 'The selected knowledge comes to more than 64 KiB, more than one task can carry. Select fewer or shorter items.'],
    invalid_knowledge: ['资料不符合要求（标题、内容长度或来源地址），请检查后重试。', 'The source does not meet the requirements (its title, content length or address). Check it and try again.'],
    web_read_quota: ['今天的网页读取次数已用完，请在 UTC 次日再试。', 'Today’s web reads are used up. Try again after the next UTC day.'],
    web_invalid_url: ['网址无效，请输入以 http:// 或 https:// 开头的完整网址。', 'The address is invalid. Enter a full address that starts with http:// or https://.'],
    web_blocked_scheme: ['只能读取 http:// 或 https:// 网址。', 'Only http:// and https:// addresses can be read.'],
    web_blocked_host: ['出于安全原因，不能读取本机、内网或保留地址。', 'For safety, local, private and reserved addresses cannot be read.'],
    web_blocked_address: ['出于安全原因，不能读取本机、内网或保留地址。', 'For safety, local, private and reserved addresses cannot be read.'],
    web_blocked_port: ['只能读取标准网页端口（80 和 443）上的地址。', 'Only addresses on the standard web ports (80 and 443) can be read.'],
    web_robots_disallowed: ['这个网站的 robots.txt 不允许读取该页面，已遵守其规则。', 'This site’s robots.txt does not allow reading this page, so it was left alone.'],
    web_robots_unavailable: ['暂时无法确认这个网站是否允许读取（robots.txt 读不到），请稍后再试。', 'Could not confirm whether this site allows reading (its robots.txt could not be fetched). Try again later.'],
    web_http_status: ['网站没有正常返回页面（例如 404 或 500），请检查网址。', 'The site did not return the page (for example 404 or 500). Check the address.'],
    web_too_large: ['页面太大，超过了可读取的 5 MiB。', 'The page is larger than the 5 MiB that can be read.'],
    web_unsupported_type: ['这个地址不是网页、纯文本或订阅源，无法读取。', 'This address is not a web page, plain text or a feed, so it cannot be read.'],
    web_too_many_redirects: ['页面跳转次数太多，无法读取。', 'The page redirects too many times to be read.'],
    web_timeout: ['网站响应超时（20 秒），请稍后再试。', 'The site took too long to answer (20 seconds). Try again later.'],
    web_network_error: ['无法连接这个网站，请检查网址或稍后再试。', 'The site could not be reached. Check the address or try again later.'],
    web_blocked_by_site_protection: ['网站的防护页拦下了读取（例如人机验证）。AwwO 不会绕过网站的防护，请手动复制正文导入。', 'The site’s protection page stopped the read (for example a human check). AwwO does not get around site protection; copy the text and import it by hand.'],
    web_decode_failed: ['无法识别页面的文字编码。', 'The page’s text encoding could not be read.'],
    web_empty_content: ['页面里没有读到正文。', 'No readable text was found on the page.'],
    // The Agent market (docs/awwo-agent-market.md). A paid Agent's fee comes off the workspace owner's plan credits, as a
    // model's does, so credits_exhausted (above) covers a fee the credits cannot pay.
    market_unavailable: ['Agent 市场没有开放，市场里的 Agent 现在用不了。', 'The Agent market is not open, so its Agents cannot be used right now.'],
    market_agent_not_found: ['找不到这个市场 Agent，它可能已被作者删除。请换一个 Agent。', 'This market Agent was not found; its author may have removed it. Choose another Agent.'],
    market_agent_unavailable: ['这个市场 Agent 现在用不了：它被停用了、已经下架，或这个版本不能再选用。请换一个 Agent，或在节点上选「不用 Agent」。', 'This market Agent cannot be used now: it was suspended or unlisted, or this version can no longer be chosen. Choose another Agent, or choose “No Agent” on the node.'],
    market_agent_not_usable: ['市场 Agent 只能用在文字节点上；团队节点、沙箱电脑节点和图片、视频、3D、音频节点不能用。', 'Market Agents work only on text nodes; team nodes, sandbox computer nodes and image, video, 3D and audio nodes cannot use them.'],
    market_text_to_sandbox: ['市场 Agent 写的内容不能交给沙箱电脑节点或团队节点（它们能运行命令、联网）。请断开这条连线，或把下游换成文字节点。', 'A market Agent’s text cannot go to a sandbox computer node or a team node, which can run commands and reach the network. Remove the connection, or make the next node a text node.'],
    market_agent_model_unavailable: ['这个 Agent 的作者锁定了模型，而你的工作区用不了这个模型，所以没有运行。请换一个 Agent，或在节点上选「不用 Agent」。', 'This Agent’s author locked its model, and your workspace cannot use that model, so it did not run. Choose another Agent, or choose “No Agent” on the node.'],
    market_agent_version_changed: ['这个 Agent 现在上架的是另一个版本，价格可能不同。请在节点上重新选一次这个 Agent。', 'This Agent lists another version now, which may cost differently. Choose the Agent again on the node.'],
    market_agent_role_required: ['这是付费 Agent：它的价格从工作区所有者的点数里付给作者，只有工作区的所有者和管理员能运行它。', 'This is a paid Agent: its price is paid to its author out of the workspace owner’s credits, so only the workspace’s owner or an administrator can run it.'],
    market_agent_plan_required: ['这是付费 Agent：工作区所有者有 Pro / Max 付费套餐才能使用，每次运行完成从套餐点数里扣它的价格（账号菜单 → 套餐与点数）。免费 Agent 不需要套餐。', 'This is a paid Agent: it needs the workspace owner to have the Pro or Max plan, and each completed call takes its price from the plan’s credits (account menu → Plans and credits). Free Agents need no plan.'],
    market_name_reserved: ['名称和署名不能用 AwwO、ClawHunt、阿呜的名字，署名也不能自称官方。', 'A name or author name may not use the name of AwwO, ClawHunt or 阿呜, and an author name may not claim to be official.'],
    canvas_reload_required: ['AwwO 已经更新，这个页面的版本不能再保存这张画布。没同步的修改都保留在这台设备上：重新加载页面后可以恢复或导出。', 'AwwO was updated, and this page’s version can no longer save this canvas. Your unsynced changes are kept on this device: reload the page to recover or export them.'],
    market_draft_invalid: ['Agent 的内容不符合要求，请按标出的地方修改后再保存。', 'Some of the Agent’s fields do not meet the requirements. Fix the marked ones and save again.'],
    market_skill_unavailable: ['有一个技能带不进市场 Agent：它已归档，或你已不是它所在工作区的成员。请移除它后再保存。', 'A skill cannot go into the market Agent: it was archived, or you are no longer a member of its workspace. Remove it and save again.'],
    market_skill_license: ['从 skills.sh 导入的技能，只有许可证明确宽松时才能带进市场 Agent。请移除这个技能后再保存。', 'A skill imported from skills.sh can go into a market Agent only under a clearly permissive license. Remove that skill and save again.'],
    market_hidden_text: ['内容里有看不见或会伪装的字符（例如零宽字符、软连字符、文字方向控制符、私用区字符或多余的变体选择符），市场不接受。请删掉它们后再保存。', 'The text holds invisible or disguising characters (such as zero-width characters, soft hyphens, text-direction controls, private-use characters or extra variation selectors), which the market does not accept. Remove them and save again.'],
    market_price_invalid: ['价格要是 0 到上限之间的整数点数（0 表示免费）。', 'The price must be a whole number of credits from 0 to the limit (0 is free).'],
    invalid_market_response: ['Agent 市场返回的数据不完整，请重试。', 'The Agent market returned incomplete data. Try again.'],
    market_agent_limit: ['一个账号能发布的 Agent 已经到上限，请先整理不再需要的 Agent。', 'This account has published as many Agents as it may. Tidy up Agents you no longer need first.'],
    market_review_pending: ['这个 Agent 有一个版本正在审核：先撤回它，再改草稿或提交新的版本。', 'A version of this Agent is in review: withdraw it first, then change the draft or submit a new version.'],
    market_agent_suspended: ['平台已停用这个 Agent，现在不能改动或使用它。', 'The platform suspended this Agent, so it cannot be changed or used now.'],
    market_no_draft: ['这个 Agent 现在没有草稿可以提交，请先编辑保存一份草稿。', 'This Agent has no draft to submit now. Edit and save a draft first.'],
    market_not_pending: ['这个版本已经不在审核中了，列表已刷新。', 'This version is no longer in review. The list is refreshed.'],
    market_review_changed: ['作者在你阅读之后改动了这个版本，没有做出决定。列表已刷新：请重新阅读后再决定。', 'Its author changed this version after you read it, so no decision was made. The list is refreshed: read it again before deciding.'],
    market_not_listed: ['这个 Agent 现在没有上架。', 'This Agent is not listed right now.'],
    market_not_listable: ['这个 Agent 还没有通过审核的版本，不能上架。', 'This Agent has no approved version yet, so it cannot be listed.'],
    market_rating_unavailable: ['只有市场 Agent 交出了内容（这次调用已计费）的运行才能评价。', 'Only a run in which the market Agent delivered its text (a charged call) can be rated.'],
    market_payouts_off: ['转账没有开启，账单不能批准。', 'Transfers are off, so no statement can be approved.'],
    market_statement_not_in_review: ['这张账单已经不在待审核了（可能已在别处批准），列表已刷新。', 'This statement is no longer waiting for review (it may have been approved elsewhere). The list is refreshed.'],
    market_statement_changed: ['账单的金额和你确认的不一样，没有批准。列表已刷新：请重新核对后再批准。', 'The statement is not the amount you confirmed, so it was not approved. The list is refreshed: check it again before approving.'],
    invite_used: ['此邀请已被其他账号领取。', 'This invitation was claimed by another account.'],
    invite_expired: ['邀请已过期，请索取新邀请。', 'This invitation has expired. Request a new one.'],
    invite_revoked: ['邀请已撤销，请索取新邀请。', 'This invitation was revoked. Request a new one.'],
    invite_unavailable: ['邀请已失效，请联系工作区所有者。', 'This invitation is no longer valid. Contact the workspace owner.'],
    invite_membership_removed: ['原成员身份已移除，请索取新邀请。', 'Your membership was removed. Request a new invitation.'],
  };
  return codes;
}

function serviceMessage(error: unknown, locale: 'zh' | 'en', codes: Record<string, [string, string]>): string {
  if (error instanceof SaaSApiError && codes[error.code]) return codes[error.code][locale === 'zh' ? 0 : 1];
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const missingCandidate = raw.match(/^Missing (?:completed|valid) cached input from (.+)$/s);
  if (missingCandidate && locale === 'zh') return `「${missingCandidate[1]}」还没有可用的完整产物。请先完成该节点的任务，再开始互审。`;
  const known: Record<string, [string, string]> = {
    'Pi service token is not configured': ['Pi 服务认证尚未配置。', 'Pi service authentication is not configured.'],
    'Pi service is unavailable': ['Pi 执行服务暂不可用。', 'The Pi execution service is unavailable.'],
    'Pi provider is not configured or available': ['Pi 模型服务尚未配置或不可用。', 'The Pi model provider is not configured or available.'],
    '画布已在另一页面更新。未同步草稿已独立保存在本机，重新加载后可恢复或导出，不会覆盖云端版本。': ['画布已在另一页面更新。未同步草稿已独立保存在本机，重新加载后可恢复或导出，不会覆盖云端版本。', 'This canvas changed in another page. Your unsynced draft is stored separately on this device. Reload to recover or export it without overwriting the cloud version.'],
    '草稿状态刚被另一个页面更新，请重新连接后核对。': ['草稿状态刚被另一个页面更新，请重新连接后核对。', 'Another page just changed this draft. Reconnect and check its state.'],
    '画布未同步，请先解决保存错误再运行。': ['画布未同步，请先解决保存错误再运行。', 'The canvas is not synced. Resolve the save error before running.'],
    'No model is available to this workspace': ['本工作区当前没有可用模型，请联系管理员开放模型。', 'No model is available to this workspace. Ask an administrator to grant one.'],
    'No configured runtime is available': ['当前没有可用的执行引擎。', 'No execution engine is currently available.'],
    'Runtime is not configured': runtimeUnavailableMessages,
    'Runtime status unavailable': ['暂时无法确认执行引擎状态，请重新检查。', 'Could not check the execution engine. Please check again.'],
  };
  if (known[raw]) return known[raw][locale === 'zh' ? 0 : 1];
  if (locale === 'en') {
    if (raw.startsWith('保存失败：')) return raw.replace('保存失败：', 'Save failed: ').replace('。未同步草稿保留在本机，重新加载后可恢复或导出。', '. Your unsynced draft is kept on this device. Reload to recover or export it.');
    if (raw.startsWith('本机草稿保存失败：')) return raw.replace('本机草稿保存失败：', 'Local draft save failed: ').replace('。请立即导出本地副本。', '. Export a local copy now.');
    if (raw.startsWith('无法读取本机草稿：')) return raw.replace('无法读取本机草稿：', 'Could not read local drafts: ');
    if (raw.startsWith('无法恢复草稿：')) return raw.replace('无法恢复草稿：', 'Could not restore draft: ');
  }
  return raw || (locale === 'zh' ? '请求失败，请重试。' : 'The request failed. Please try again.');
}
