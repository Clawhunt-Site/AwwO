import { readInitialLocale, type UiLocale } from '../locale';
import { SaaSApiError, freeCapacityMessages, isServiceCopy, quotaExceededMessages, runtimeUnavailableMessages, saasErrorMessage } from './api';

export function canvasLocale(): UiLocale {
  const language = document.documentElement.lang;
  return language === 'en' ? 'en' : language.startsWith('zh') ? 'zh' : readInitialLocale();
}

export const canvasText = (zh: string, en: string): string => canvasLocale() === 'zh' ? zh : en;

// A service restart cut the run off (app.go marks it 'API restarted before completion'): nothing of it is left to
// check, so the way on is to run it again.
const restartMessages: [string, string] = ['服务重启打断了这次运行，它没有做完。请重新运行。', 'A service restart interrupted this run before it finished. Run it again.'];

// Every copy says what happened in the reader's words first, then what to do about it (owner 2026-10-21: 「报错时明确用户该
// 做什么」); its first sentence alone is what happened (failureCause in canvas/surfaceMessages.ts). A hosted workspace has no
// "run state" to restore and no runtime configuration to check, so no copy asks for either. "Choose another model" names
// no node: the copy also reads under a team member's turn, whose model may be its own, and on every node of a collaboration
// that one failed turn ended (graph_collaboration.go finishCollaboration).
const runErrors: Record<string, [string, string]> = {
  runtime_unavailable: runtimeUnavailableMessages,
  // The worker still holds the session's previous run (errSessionBusy, before anything was sent).
  runtime_session_busy: ['上一次的运行还没有结束，这次没有开始。请等它结束后再运行。', 'The previous run has not finished yet, so this one did not start. Run it again once that one ends.'],
  // The worker answered with something other than its event stream (a refusal, an error status, another content type):
  // most often before it ran anything, but not always.
  runtime_rejected: ['执行服务拒绝了这次运行，或没有按预期回应，这次没有结果。请重新运行；如果一直这样，换一个模型，或联系管理员。', 'The execution service refused this run or did not answer as expected, so there is no result. Run it again; if it keeps happening, choose another model, or contact an administrator.'],
  // Retrying is safe rather than guaranteed: nothing was applied, and the cause is malformed
  // structure from the model rather than a fault in the canvas, so the same request may well
  // succeed. Nothing is adjusted automatically on retry. Saying only that the plan was
  // invalid left the reader unable to tell this from something they had to fix first.
  invalid_canvas_plan: ['规划结果无效，当前画布保持原样。可以直接重试。', 'The plan is invalid and nothing was applied to the canvas. You can retry.'],
  database_unavailable: ['服务暂时无法保存运行状态，这次运行没有完成。请稍后重新运行。', 'The service could not save the run’s state, so the run did not finish. Run it again in a moment.'],
  history_unavailable: ['暂时无法读取会话历史，请稍后重试。', 'Conversation history is unavailable. Please try again later.'],
  invalid_runtime_event: ['执行服务返回了无法识别的内容，这次运行没有完成。请重新运行；如果反复出现，请联系管理员。', 'The execution service returned something AwwO could not read, so the run did not finish. Run it again; if it keeps happening, contact an administrator.'],
  // The output outgrew what one run may write (the model's output cap, which its hidden thinking counts towards, or the
  // API's 2 MiB): the same request would outgrow it again, so the way on is less per run.
  output_limit: ['这次输出（包括模型的思考）超过了一次运行的上限，没有写完。请让助手调整画布，把要交付的内容拆给几个节点，或减少一次要写的内容，再重新运行。', 'This run’s output, the model’s thinking included, went past what one run may write, so it was cut off. Let the assistant adjust the canvas to split the delivery across several nodes, or ask for less in one run, then run it again.'],
  runtime_disconnected: ['与执行服务的连接断了。请刷新页面，看这次运行有没有完成；没有完成就重新运行。', 'The connection to the execution service dropped. Reload the page to see whether the run finished; if it did not, run it again.'],
  server_restarted: restartMessages,
  'API restarted before completion': restartMessages,
  // A graph run's node whose run was interrupted (graph_runs.go), and a live run's interrupted event, which carries no
  // code: most often a restart, but an executor that stopped (execution_interrupted) ends the same way.
  interrupted: ['这次运行被中断了（多半是服务重启），没有做完。请重新运行。', 'This run was interrupted, most often by a service restart, and did not finish. Run it again.'],
  // The run's executor stopped after the run was accepted (runs.go dispatchFor), with no restart behind it.
  execution_interrupted: ['这次运行在执行途中被中断了，没有做完。请重新运行。', 'This run was interrupted part-way and did not finish. Run it again.'],
  runtime_failed: ['模型执行失败，这次没有交出结果。请重新运行；如果再次失败，换一个模型。', 'Model execution failed, so there is no result this time. Run it again; if it fails again, choose another model.'],
  workspace_context_limit: ['项目运行上下文已满，请拆分任务或减少本次输入后重试。', 'The project execution context is full. Split the task or reduce its inputs and retry.'],
  workspace_step_limit: ['本次项目执行已达到调用步数上限。请拆分任务，或联系管理员调整执行预算后重试。', 'This project run reached its model-call limit. Split the task or contact an administrator to adjust the execution budget, then retry.'],
  workspace_admission_failed: ['项目执行权限或调用额度不可用，请检查个人模型连接和工作区额度。', 'Project execution permission or quota is unavailable. Check your model connection and workspace quota.'],
  workspace_file_invalid: ['交付文件无效，请检查实际生成的文件后重新执行。', 'The deliverable file is invalid. Check the generated file and run again.'],
  workspace_unavailable: ['项目执行沙箱暂不可用，请稍后重试。', 'The project execution sandbox is unavailable. Please try again later.'],
  workspace_busy: ['项目执行沙箱一直满员，排队等了几分钟也没轮到，这次没有执行；请稍后重试。', 'Every project execution sandbox stayed busy while this run waited in line, so it did not run. Please try again shortly.'],
  // A run that reached its time limit (the worker's own, or the API's AWWO_RUN_TIMEOUT). In production it was nearly
  // always a call that had not written a word when the limit came (from 2026-10-16 to 10-19: 20 of 22, all on Claude
  // Opus 5.5, some of their requests a dozen characters long), and 6 of the 12 nodes run again finished, in 64-255 s:
  // "make the task smaller" was the wrong advice, and 10 of the 22 were never run again. Running it again comes first; a
  // node that times out again needs another model, or its work split up (a sandbox node can spend its whole time on real
  // work), which the assistant does when asked (CanvasSurface fixRequest).
  // Short enough for one line of an opened node's failure note in a wide chat column (about 860 px): the note gives way to
  // the conversation (awwo-node.css) and scrolls past its room.
  run_timeout: ['运行超时：模型迟迟没有给出结果。先重新运行，常常就能好；再超时就换个模型，或让助手调整画布。', 'The run timed out: the model took too long to give a result. Run it again first, which often works; if it times out again, choose another model or let the assistant adjust the canvas.'],
  // A node team's own limits (teams.go; validateNodeTeam's bounds in nodeTeam.ts, the editor's labels in NodeTeamEditor.tsx).
  team_timeout: ['节点团队超过了团队设置的时间上限，没有做完。请在这个节点的团队设置里调大「节点超时（秒）」（最多 1800 秒），或减少轮数和成员，再重新运行。', 'The node team ran past its time limit before it finished. Raise “Node timeout (seconds)” in the node’s team settings (up to 1800), or use fewer rounds or members, then run it again.'],
  team_turn_budget_exhausted: ['节点团队用完了设置的「最多模型调用次数」，没有做完。请在这个节点的团队设置里调大它（最多 64 次），或减少轮数和成员，再重新运行。', 'The node team used up its “Maximum model calls” before it finished. Raise it in the node’s team settings (up to 64), or use fewer rounds or members, then run it again.'],
  review_rounds_exhausted: ['审核到「最多轮数」也没有通过，团队没有交付。请看一下审核意见，调整任务要求，或在团队设置里调大「最多轮数」（最多 8 轮），再重新运行。', 'The review did not pass within the team’s “Maximum rounds”, so nothing was delivered. Read the review’s feedback, adjust the task, or raise “Maximum rounds” in the team settings (up to 8), then run it again.'],
  invalid_review_verdict: ['审核成员没有按要求给出结论（是否通过，以及交付内容），团队没有做完。请重新运行；反复出现就给审核成员换一个模型。', 'The reviewing member did not return its verdict in the required form (whether it passes, and the deliverable), so the team did not finish. Run it again; if it keeps happening, choose another model for the reviewing member.'],
  tool_unavailable: ['团队成员选用的工具在它的执行框架里不可用，团队没有做完。请在这个节点的团队设置里取消这个工具，或给成员换一个执行框架。', 'A tool a team member uses is not available on its runtime, so the team did not finish. Clear the tool in the node’s team settings, or choose another runtime for the member.'],
  turn_persistence_failed: ['团队成员的这次发言没能完整记下来，团队没有做完。请重新运行。', 'A team member’s turn could not be recorded in full, so the team did not finish. Run it again.'],
  accounting_commit_failed: ['这次调用的用量记录没能保存，运行没有做完。请重新运行。', 'The call’s usage record could not be saved, so the run did not finish. Run it again.'],
  // Named worker failures. Each one asks for a different action than the generic
  // runtime failure: a refusal wants a reworded task, a rejected key wants the
  // connection fixed, and a rate limit or outage wants time or another model.
  model_refused: ['模型拒绝了这个请求，请调整任务内容后重试。', 'The model declined this request. Adjust the task and try again.'],
  // A hosted model's credentials are the service's, which the reader cannot check: only a model they connected
  // themselves (我的引擎, and every model of the local edition) has a key of theirs.
  provider_auth_failed: ['模型服务拒绝了这个模型的凭据，这次没有完成。请换一个模型；如果是你自己连接的模型，请在「我的引擎」里检查它的 API 密钥。', 'The model provider rejected this model’s credentials, so this did not finish. Choose another model; if it is a model you connected yourself, check its API key in My engines.'],
  provider_rate_limited: ['模型服务触发了速率限制，这次没有完成。请过几分钟重新运行，或换一个模型。', 'The model provider is rate limited, so this did not finish. Run it again in a few minutes, or choose another model.'],
  // Also a call that stayed silent for 15 minutes (the Python worker's Bedrock idle limit, since 2026-10-19).
  provider_unavailable: ['模型服务暂时不可用，这次没有完成。请稍后重新运行，或换一个模型。', 'The model provider is unavailable right now, so this did not finish. Run it again later, or choose another model.'],
  runtime_stream_ended: ['执行服务的输出中途断了，这次运行没有做完。请重新运行。', 'The execution service’s output stopped part-way, so the run did not finish. Run it again.'],
  // A streamed piece of the output could not be stored (runs.go appendDelta); what came before it is kept with the run.
  event_persistence_failed: ['运行中途没能把输出记下来，这次没有做完，已写出的部分可能留在对话里。请重新运行。', 'The run’s output could not be recorded part-way, so the run did not finish; what it had written may still show. Run it again.'],
  inconsistent_runtime_output: ['执行服务交回的结果前后不一致，没有保存。请重新运行。', 'The execution service returned an inconsistent result, which was not saved. Run it again.'],
  // A graph run's node whose delivery could not be stored (graph_runs.go): nothing was published.
  deliverable_storage_failed: ['结果没能保存下来，这次没有交付。请重新运行。', 'The result could not be saved, so nothing was delivered. Run it again.'],
  reasoning_only_output: ['模型只返回了思考过程，没有给出结果，请重试或换一个模型。', 'The model returned only its reasoning and no answer. Retry or choose another model.'],
  // The node's own output fields are the contract, so the fix is to retry or pick another
  // model — not to edit a format the workspace never wrote.
  output_contract_invalid: ['模型输出不符合要求的交付格式，请重试或换一个模型。', 'The model output did not match the required delivery format. Retry or choose another model.'],
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
  // A voice a video cannot use (M-1c): its model takes none, it is not one of up to 3 MP3 or WAV files of this canvas,
  // each 2-15 s (15 s in all) and up to 10 MB, or no picture is beside it. The video is refused rather than made without
  // its line.
  media_voice_unavailable: ['声音参考用不了，这次没有生成，也没有扣积分：只有「视频 · 多图参考」能按声音对口型；声音要是这个画布里的 MP3 或 WAV，最多 3 段，每段 2–15 秒、合计不超过 15 秒，每段不超过 10 MB，而且至少要有一张参考图。', 'The voice reference cannot be used, so nothing was generated or charged: only Video · From references lip-syncs to voices, which must be MP3 or WAV files of this canvas, at most 3, each 2 to 15 seconds (15 seconds in all) and up to 10 MB, with at least one reference picture beside them.'],
  // The generation service refused a photorealistic person (its code 1505), which Video · From references takes with
  // Real people on. The copy names the code, never the service behind it: no user-facing string names a media provider
  // (owner 2026-10-11), and canvasErrors.test.ts holds every message in this table to that.
  media_real_person_rejected: ['生成服务拒绝了写实的真人画面（服务代码 1505）。用「视频 · 多图参考」时，在节点设置里打开「真人模式」再运行；其他模型请改用不写实的人物或画面。', 'The generation service refused a photorealistic person (service code 1505). On Video · From references, turn on Real people in the node’s settings and run it again; with other models, use people or pictures that are not photorealistic.'],
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
  plan_busy: ['套餐的同时运行数已用满（包括所有者的其他工作区）。等其中一个运行结束后再试。', 'The plan’s agents at once are all running, counting the owner’s other workspaces. Try again when one finishes.'],
  plan_media_quota_exceeded: ['套餐今日的图片 / 视频生成次数已用完，UTC 次日恢复。', 'The plan’s image and video generations for today are used up; they come back after the next UTC day.'],
};

/** The reader's-language copy for a known run failure code, or undefined for anything else (free text,
 * an unknown provider detail), which callers show verbatim. */
export function runErrorText(code: string, locale: UiLocale): string | undefined {
  return Object.hasOwn(runErrors, code) ? runErrors[code][locale === 'zh' ? 0 : 1] : undefined;
}

/** Every run failure code above that has a copy. */
export const runErrorCodes = (): string[] => Object.keys(runErrors);

const runCopies = new Set(Object.values(runErrors).flat());
/** Whether the text is a failure's copy, a run's (above) or the service's (api.ts), in either language: what a node's own
 *  Send records (canvasErrorMessage). */
export const isRunFailureCopy = (text: string): boolean => runCopies.has(text) || isServiceCopy(text);

/** The service's copy of a code (api.ts), or undefined when it has none. */
function serviceText(code: string, locale: UiLocale): string | undefined {
  const text = saasErrorMessage(new SaaSApiError(0, code, code), locale);
  return text !== code ? text : undefined;
}

/** A failure's copy as a node records it, in the reader's language: a run's (above), else the service's (api.ts); undefined
 * for anything else (free text, the provider's own words), which callers show verbatim. A cloud graph run's node records
 * its run's code, or its admission's for a generation or an edit (graph_runs.go, graph_media.go, edits.go). */
export function runFailureText(detail: string, locale: UiLocale): string | undefined {
  // The service's fallback for an empty message is a sentence of its own, not a copy of this detail.
  if (!detail) return undefined;
  return runErrorText(detail, locale) ?? serviceText(detail, locale);
}

/** Keep a stable code alongside localized text; unknown provider details remain intact. */
export function canvasErrorMessage(error: unknown, code?: string): string {
  const locale = canvasLocale();
  const key = code || (error instanceof SaaSApiError ? error.code : typeof error === 'string' ? error : '');
  if (runErrors[key]) return runErrors[key][locale === 'zh' ? 0 : 1];
  return saasErrorMessage(key ? new SaaSApiError(error instanceof SaaSApiError ? error.status : 500, key, error instanceof Error ? error.message : typeof error === 'string' ? error : '') : error, locale);
}

// A planning run that failed, said as the canvas assistant's: a node's copy sends the reader to the node's model and to
// running the node again, which a plan has neither of. Nothing of a failed plan reaches the canvas, and the way on is to
// send the request again; one too large for a plan (its time, its output) is sent in parts.
const planRetry: [string, string] = ['画布助手这次没能完成规划，画布保持原样。请再发送一次；如果反复失败，请稍后再试。', 'The canvas assistant could not finish this plan, and the canvas has not changed. Send it again; if it keeps failing, try again later.'];
const planRestart: [string, string] = ['服务重启打断了这次规划，画布保持原样。请再发送一次。', 'A service restart interrupted this plan, and the canvas has not changed. Send it again.'];
const planInterrupted: [string, string] = ['这次规划被中断了，画布保持原样。请再发送一次。', 'This plan was interrupted, and the canvas has not changed. Send it again.'];
const planErrors: Record<string, [string, string]> = {
  // A plan stopped by a cancel this page did not make (another page's): its event carries no code.
  cancelled: ['这次规划已停止，画布保持原样。还需要的话请再发送一次。', 'This plan was stopped, and the canvas has not changed. Send it again if you still want it.'],
  run_timeout: ['画布助手这次规划超时了，画布保持原样。请再发送一次；如果还是超时，把要求分成几步，一次说一部分。', 'The canvas assistant ran out of time while planning, and the canvas has not changed. Send it again; if it times out again, split the request into steps and send one at a time.'],
  output_limit: ['这次的规划太长，超过了画布助手一次能写的上限，画布保持原样。请把要求分成几步，一次说一部分。', 'The plan was longer than the canvas assistant can write in one go, and the canvas has not changed. Split the request into steps and send one at a time.'],
  runtime_session_busy: ['画布助手上一次的规划还没有结束，这次没有开始。请等它结束后再发送。', 'The canvas assistant’s previous plan has not finished, so this one did not start. Send it again once that one ends.'],
  provider_rate_limited: ['画布助手的模型服务触发了速率限制，这次规划没有完成，画布保持原样。请过几分钟再发送。', 'The canvas assistant’s model provider is rate limited, so this plan did not finish and the canvas has not changed. Send it again in a few minutes.'],
  // The service chooses the canvas assistant's model, not the reader: there is no model to change. Its key is the
  // reader's only where they connected that model themselves (the local edition plans on the reader's own key).
  provider_auth_failed: ['画布助手的模型服务拒绝了凭据，这次规划没有完成，画布保持原样。如果画布助手用的是你自己连接的模型，请在「我的引擎」里检查它的 API 密钥；否则请稍后再发送，一直这样就联系管理员。', 'The canvas assistant’s model provider rejected its credentials, so this plan did not finish and the canvas has not changed. If the assistant uses a model you connected yourself, check its API key in My engines; otherwise send it again later, and contact an administrator if it keeps happening.'],
  model_refused: ['画布助手的模型拒绝了这个请求，画布保持原样。请换个说法，再发送一次。', 'The canvas assistant’s model declined this request, and the canvas has not changed. Put it another way and send it again.'],
  server_restarted: planRestart,
  'API restarted before completion': planRestart,
  interrupted: planInterrupted,
  execution_interrupted: planInterrupted,
  runtime_failed: planRetry,
  provider_unavailable: planRetry,
  runtime_rejected: planRetry,
  runtime_stream_ended: planRetry,
  invalid_runtime_event: planRetry,
  event_persistence_failed: planRetry,
  inconsistent_runtime_output: planRetry,
  database_unavailable: planRetry,
  accounting_commit_failed: planRetry,
};

/** A planning run's failure in the reader's language: the assistant's own copy for the failures above, else the same
 * words a run's failure has (canvasErrorMessage). */
export function planErrorMessage(error: unknown, code?: string): string {
  const key = code || (error instanceof SaaSApiError ? error.code : typeof error === 'string' ? error : '');
  return Object.hasOwn(planErrors, key) ? planErrors[key][canvasLocale() === 'zh' ? 0 : 1] : canvasErrorMessage(error, code);
}
