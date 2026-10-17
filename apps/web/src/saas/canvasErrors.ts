import { readInitialLocale, type UiLocale } from '../locale';
import { SaaSApiError, freeCapacityMessages, quotaExceededMessages, runtimeUnavailableMessages, saasErrorMessage } from './api';

export function canvasLocale(): UiLocale {
  const language = document.documentElement.lang;
  return language === 'en' ? 'en' : language.startsWith('zh') ? 'zh' : readInitialLocale();
}

export const canvasText = (zh: string, en: string): string => canvasLocale() === 'zh' ? zh : en;

const runErrors: Record<string, [string, string]> = {
  runtime_unavailable: runtimeUnavailableMessages,
  runtime_session_busy: ['执行服务中的会话仍在运行，请稍后重试。', 'The runtime session is still busy. Please try again later.'],
  runtime_rejected: ['执行服务未接受此请求，请检查运行配置。', 'The runtime did not accept this request. Check the runtime configuration.'],
  // Retrying is safe rather than guaranteed: nothing was applied, and the cause is malformed
  // structure from the model rather than a fault in the canvas, so the same request may well
  // succeed. Nothing is adjusted automatically on retry. Saying only that the plan was
  // invalid left the reader unable to tell this from something they had to fix first.
  invalid_canvas_plan: ['规划结果无效，当前画布保持原样，可直接重试。', 'The plan is invalid and nothing was applied to the canvas. You can retry.'],
  database_unavailable: ['暂时无法保存运行状态，请恢复运行状态后再试。', 'The run state could not be saved. Restore its state before retrying.'],
  history_unavailable: ['暂时无法读取会话历史，请稍后重试。', 'Conversation history is unavailable. Please try again later.'],
  invalid_runtime_event: ['执行服务返回了无效事件，请恢复运行状态。', 'The runtime returned an invalid event. Restore the run state.'],
  output_limit: ['运行输出超过限制，请缩小任务范围。', 'The run output exceeds the limit. Reduce the task scope.'],
  runtime_disconnected: ['执行服务连接中断，请恢复运行状态。', 'The runtime connection was interrupted. Restore the run state.'],
  server_restarted: ['服务重启中断了运行，请核对历史后重试。', 'A service restart interrupted the run. Check its history before retrying.'],
  'API restarted before completion': ['服务重启中断了运行，请核对历史后重试。', 'A service restart interrupted the run. Check its history before retrying.'],
  runtime_failed: ['模型执行失败，请检查运行配置后重试。', 'Model execution failed. Check the runtime configuration and try again.'],
  workspace_context_limit: ['项目运行上下文已满，请拆分任务或减少本次输入后重试。', 'The project execution context is full. Split the task or reduce its inputs and retry.'],
  workspace_step_limit: ['本次项目执行已达到调用步数上限。请拆分任务，或联系管理员调整执行预算后重试。', 'This project run reached its model-call limit. Split the task or contact an administrator to adjust the execution budget, then retry.'],
  workspace_admission_failed: ['项目执行权限或调用额度不可用，请检查个人模型连接和工作区额度。', 'Project execution permission or quota is unavailable. Check your model connection and workspace quota.'],
  workspace_file_invalid: ['交付文件无效，请检查实际生成的文件后重新执行。', 'The deliverable file is invalid. Check the generated file and run again.'],
  workspace_unavailable: ['项目执行沙箱暂不可用，请稍后重试。', 'The project execution sandbox is unavailable. Please try again later.'],
  workspace_busy: ['项目执行沙箱一直满员，排队等了几分钟也没轮到，这次没有执行；请稍后重试。', 'Every project execution sandbox stayed busy while this run waited in line, so it did not run. Please try again shortly.'],
  run_timeout: ['运行超时，请缩小任务范围后重试。', 'The run timed out. Reduce the task scope and try again.'],
  // Named worker failures. Each one asks for a different action than the generic
  // runtime failure: a refusal wants a reworded task, a rejected key wants the
  // connection fixed, and a rate limit or outage only wants time.
  model_refused: ['模型拒绝了这个请求，请调整任务内容后重试。', 'The model declined this request. Adjust the task and try again.'],
  provider_auth_failed: ['模型服务拒绝了所配置的凭据，请检查该模型连接的 API 密钥。', 'The model provider rejected the configured credentials. Check the API key of this model connection.'],
  provider_rate_limited: ['模型服务触发了速率限制，请稍后重试。', 'The model provider is rate limited. Please try again later.'],
  provider_unavailable: ['模型服务暂时不可用，请稍后重试。', 'The model provider is unavailable. Please try again later.'],
  runtime_stream_ended: ['执行流提前结束，请恢复运行状态后核对输出。', 'The execution stream ended early. Restore the run state and check its output.'],
  event_persistence_failed: ['运行事件保存失败，请恢复运行状态后核对。', 'Run events could not be saved. Restore the run state and check it.'],
  inconsistent_runtime_output: ['执行输出校验失败，请恢复运行状态后核对。', 'The runtime output failed validation. Restore the run state and check it.'],
  reasoning_only_output: ['模型只返回了思考过程，没有给出结果，请重试或换一个模型。', 'The model returned only its reasoning and no answer. Retry or choose another model.'],
  // The node's own output fields are the contract, so the fix is to retry or pick another
  // model — not to edit a format the workspace never wrote.
  output_contract_invalid: ['模型输出不符合该节点的交付格式，请重试或换一个模型。', 'The model output did not match this node’s delivery format. Retry or choose another model.'],
  // Image and video generation (RunningHub). The provider's own message is never shown: it can
  // echo the prompt or account details, so each failure maps to what the reader can do about it.
  media_unavailable: ['图像、视频与 3D 生成尚未配置，请联系管理员。', 'Image, video and 3D generation is not configured. Contact an administrator.'],
  media_provider_unauthorized: ['媒体生成服务拒绝了平台密钥，请联系管理员。', 'The media generation service rejected the platform key. Contact an administrator.'],
  media_provider_balance: ['媒体生成服务余额不足，请联系管理员充值。', 'The media generation account is out of balance. Contact an administrator to top it up.'],
  media_provider_busy: ['媒体生成服务繁忙，请稍后重试。', 'The media generation service is busy. Please try again later.'],
  media_provider_unavailable: ['媒体生成服务暂时不可用，请稍后重试。', 'The media generation service is unavailable. Please try again later.'],
  media_content_rejected: ['内容未通过生成服务的审核，请修改描述后重试。', 'The content did not pass the generation service’s review. Change the description and try again.'],
  media_params_invalid: ['生成参数不被该模型接受，请检查节点配置。', 'The model did not accept these settings. Check the node configuration.'],
  media_request_invalid: ['生成请求无效，请检查节点配置。', 'The generation request is invalid. Check the node configuration.'],
  media_timeout: ['生成超时，请稍后重试或换一个模型。', 'The generation timed out. Try again later or choose another model.'],
  media_task_missing: ['生成任务已不存在，请重新运行。', 'The generation task no longer exists. Run the node again.'],
  media_failed: ['生成失败，请调整描述或换一个模型后重试。', 'The generation failed. Adjust the description or choose another model, then try again.'],
  // A 3D model was made, but rigging or animating it failed: nothing is delivered, and only what succeeded is charged.
  media_motion_failed: ['模型已生成，但绑定骨骼或生成动作失败，这次没有交付文件；已成功的步骤照常计费，失败的步骤不计费。请重试，或换一种骨骼或动作。', 'The model was made, but rigging or animating it failed, so nothing was delivered. The steps that succeeded are charged as usual and the failed one is not. Try again, or choose another skeleton or animation set.'],
  media_no_output: ['生成服务没有返回结果，请重试。', 'The generation service returned no result. Please try again.'],
  media_result_invalid: ['生成结果不是有效的图像、视频或 3D 模型，已拒绝保存。', 'The result was not a valid image, video or 3D model and was not saved.'],
  media_result_refused: ['生成结果来自未允许的地址，已拒绝下载。', 'The result came from an address that is not allowed and was not downloaded.'],
  media_result_unavailable: ['暂时无法下载生成结果，请重试。', 'The result could not be downloaded. Please try again.'],
  media_result_too_large: ['生成结果超过文件大小上限，未保存。', 'The result exceeds the file size limit and was not saved.'],
  media_storage_failed: ['生成结果保存失败，请重试。', 'The result could not be saved. Please try again.'],
  media_storage_full: ['媒体存储空间不足，生成结果未保存；请联系管理员。', 'Media storage is full, so the result was not saved. Contact an administrator.'],
  media_reference_unavailable: ['参考图读取或上传失败，这次没有生成，也没有扣积分；请重新附上图片再试。', 'The reference picture could not be read or uploaded, so nothing was generated or charged. Attach the picture again and retry.'],
  image_input_unavailable: ['附带的图片读取失败，这次没有调用模型，也没有扣积分；请重新附上图片再发送。', 'An attached picture could not be read, so the model was not called and nothing was charged. Attach the picture again and resend.'],
  // A generation priced above the operator's per-generation ceiling stops before anything is made.
  media_credit_ceiling: ['这次生成需要的点数超过了单次上限，没有生成也没有扣点数；请缩短时长或降低分辨率后重试。', 'This generation would cost more than the per-generation limit, so nothing was generated or charged. Shorten the clip or lower the resolution, then try again.'],
  // A route-limited workspace's free allowance for a premium route is a few calls a day or none at all
  // (0). A paid plan is what lifts it, so the copy offers that first (the run details add an upgrade
  // button); the free way forward is the default model on the node AND on any team member that chose
  // its own model, since a member's own model is not replaced by the node's.
  premium_quota_exceeded: ['这个工作区今天的高级模型（Claude、GPT、Bedrock）免费次数已经用完，或它的免费额度不含这个模型。升级 Pro / Max 付费套餐，就能用点数继续使用这些模型（账号菜单 → 套餐与点数）；不升级的话，把节点和单独指定了模型的团队成员都换成默认模型，也能免费继续。', 'This workspace’s free premium-model calls (Claude, GPT, Bedrock) are used up for today, or its free allowance does not include this model. Upgrade to the Pro and Max plans to keep using these models on credits (account menu → Plans and credits); to continue for free, switch the node, and any team member that chose its own model, to the default model.'],
  premium_capacity_exceeded: ['今天全站的高级模型免费名额已用完。Pro / Max 付费套餐不受这个名额限制，升级后马上就能继续（账号菜单 → 套餐与点数）；也可以把节点和单独指定了模型的团队成员都换成默认模型继续，免费名额 UTC 次日重置。', 'Today’s free premium-model calls for the whole service are used up. The Pro and Max plans are not limited by it, so upgrading lets you continue now (account menu → Plans and credits); or switch the node, and any team member that chose its own model, to the default model. Free calls reset after the next UTC day.'],
  // The default model's own deployment-wide daily ceiling: there is no free model to switch to, so only the next
  // UTC day or a plan.
  free_capacity_exceeded: freeCapacityMessages,
  // The workspace's own allowance (today's calls, or runs at once) without a plan. Run details showed the bare code;
  // a node read the API's copy. Both now read this one, which offers the plans first.
  quota_exceeded: quotaExceededMessages,
  // A paid plan's credits for the period are used up; the default model spends none.
  plan_required: ['这个工作区是在付费套餐下额外创建的，套餐恢复后才能运行；其他工作区不受影响。', 'This workspace was created on a paid plan beyond the free limit and runs again once the plan is back; other workspaces are not affected.'],
  model_unpriced: ['这个模型还不能按点数计费，请把节点换成其他模型。', 'This model cannot be billed in credits yet. Switch the node to another model.'],
  credits_exhausted: ['本期套餐点数已用完。可以把节点换成默认模型继续，点数在下次续费后重置；需要更多点数可以请工作区所有者在「套餐与点数」里升级。', 'This period’s plan credits are used up. Switch the node to the default model to keep going; credits reset after the next renewal. For more, the workspace’s owner can upgrade in Plans and credits.'],
  plan_busy: ['套餐的同时运行数已用满（包括所有者的其他工作区），等其中一个运行结束后再试。', 'The plan’s agents at once are all running, counting the owner’s other workspaces; try again when one finishes.'],
  plan_media_quota_exceeded: ['套餐今日的图片 / 视频生成次数已用完，UTC 次日恢复。', 'The plan’s image and video generations for today are used up; they come back after the next UTC day.'],
};

/** The reader's-language copy for a known run failure code, or undefined for anything else (free text,
 * an unknown provider detail), which callers show verbatim. */
export function runErrorText(code: string, locale: UiLocale): string | undefined {
  return Object.hasOwn(runErrors, code) ? runErrors[code][locale === 'zh' ? 0 : 1] : undefined;
}

/** Keep a stable code alongside localized text; unknown provider details remain intact. */
export function canvasErrorMessage(error: unknown, code?: string): string {
  const locale = canvasLocale();
  const key = code || (error instanceof SaaSApiError ? error.code : typeof error === 'string' ? error : '');
  if (runErrors[key]) return runErrors[key][locale === 'zh' ? 0 : 1];
  return saasErrorMessage(key ? new SaaSApiError(error instanceof SaaSApiError ? error.status : 500, key, error instanceof Error ? error.message : typeof error === 'string' ? error : '') : error, locale);
}
