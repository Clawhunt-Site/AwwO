import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  extractPromptFromContext,
  isUuid,
  mimeTypeForExtension,
  parseObject,
  resolveIssueId,
  resolvePaperclipApiBase,
  resolvePaperclipApiToken,
  sanitizeFileExtension,
  sanitizeFileStem,
} from "./helpers.js";

export const DEFAULT_RUNNINGHUB_API_BASE = "https://www.runninghub.cn";
const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_PROMPT_NODE_ID = "6";
const DEFAULT_PROMPT_FIELD = "text";
const MAX_ERROR_BODY_CHARS = 600;
const OUTPUTS_PENDING_MAX_RETRIES = 5;
const MAX_POLL_CONSECUTIVE_ERRORS = 3;

export type WorkflowSpec =
  | { kind: "workflow"; id: string; raw: string }
  | { kind: "app"; id: number; raw: string };

/**
 * The agent's `model` field carries the RunningHub id:
 * plain digits = workflowId (create endpoint); `app:<digits>` = webappId
 * (ai-app/run endpoint). Anything else (e.g. the placeholder model entry)
 * is treated as "not a selection" so the fallback chain applies.
 */
export function parseWorkflowSpec(value: unknown): WorkflowSpec | null {
  const raw =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : "";
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return { kind: "workflow", id: raw, raw };
  const appMatch = /^app:(\d+)$/i.exec(raw);
  if (appMatch) return { kind: "app", id: Number(appMatch[1]), raw: `app:${appMatch[1]}` };
  return null;
}

/** model -> config.workflowId -> RUNNINGHUB_WORKFLOW_ID env, first parseable wins. */
export function resolveWorkflowSpec(config: Record<string, unknown>): WorkflowSpec | null {
  for (const candidate of [config.model, config.workflowId, process.env.RUNNINGHUB_WORKFLOW_ID]) {
    const spec = parseWorkflowSpec(candidate);
    if (spec) return spec;
  }
  return null;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const text =
      typeof value === "string"
        ? value.trim()
        : typeof value === "number" && Number.isFinite(value)
          ? String(value)
          : "";
    if (text) return text;
  }
  return "";
}

type RhCallResult =
  | { kind: "ok"; code: number; msg: string; data: unknown }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

async function rhCall(input: {
  base: string;
  host: string;
  path: string;
  body: Record<string, unknown>;
  timeoutMs: number;
}): Promise<RhCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, input.timeoutMs));
  try {
    const response = await fetch(`${input.base}${input.path}`, {
      method: "POST",
      headers: {
        Host: input.host,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      let snippet = "";
      try {
        snippet = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
      } catch {
        snippet = "";
      }
      return { kind: "error", message: `RunningHub ${input.path} HTTP ${response.status}${snippet ? `: ${snippet}` : ""}` };
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = parseObject(await response.json());
    } catch {
      return { kind: "error", message: `RunningHub ${input.path} 响应不是有效 JSON` };
    }
    return {
      kind: "ok",
      code: asNumber(payload.code, -1),
      msg: asString(payload.msg),
      data: payload.data,
    };
  } catch (err) {
    if (controller.signal.aborted) return { kind: "timeout" };
    return {
      kind: "error",
      message: `RunningHub ${input.path} 请求失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));

type WrittenImage = {
  file: string;
  absolutePath: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  attachmentId?: string;
  contentPath?: string;
  workProductId?: string;
};

async function requestJson(input: {
  url: string;
  method: string;
  token: string;
  runId: string;
  body: FormData | string;
  contentType?: string;
  timeoutMs: number;
}): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, input.timeoutMs));
  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${input.token}`,
      "x-paperclip-run-id": input.runId,
    };
    if (input.contentType) headers["content-type"] = input.contentType;
    const response = await fetch(input.url, {
      method: input.method,
      headers,
      body: input.body,
      signal: controller.signal,
    });
    if (!response.ok) {
      let bodySnippet = "";
      try {
        bodySnippet = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
      } catch {
        bodySnippet = "";
      }
      return { ok: false, error: `HTTP ${response.status} ${input.method} ${input.url}${bodySnippet ? `: ${bodySnippet}` : ""}` };
    }
    try {
      return { ok: true, payload: parseObject(await response.json()) };
    } catch {
      return { ok: true, payload: {} };
    }
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, error: `请求超时: ${input.method} ${input.url}` };
    }
    return { ok: false, error: `${input.method} ${input.url} 失败: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, authToken } = ctx;

  const spec = resolveWorkflowSpec(config);
  const modelLabel = spec?.raw ?? asString(config.model).trim();
  const failure = (errorMessage: string, extra?: Partial<AdapterExecutionResult>): AdapterExecutionResult => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage,
    provider: "runninghub",
    model: modelLabel || null,
    billingType: "api",
    ...extra,
  });

  // cwd — workspace projection first (context.paperclipWorkspace.cwd, same
  // field grok_local reads), then config.cwd, then process.cwd().
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const cwd = asString(workspaceContext.cwd).trim() || asString(config.cwd).trim() || process.cwd();

  // prompt — latest USER comment from the wake payload, falling back to
  // issue title + description.
  const prompt = extractPromptFromContext(parseObject(context));
  if (!prompt) {
    return failure("没有可用的生成提示词");
  }

  // api key — per-agent secret binding wins over the instance env default.
  // Fail closed when neither source is present. The key is never logged.
  const envConfig = parseObject(config.env);
  const apiKey = asString(envConfig.RUNNINGHUB_API_KEY).trim() || (process.env.RUNNINGHUB_API_KEY ?? "").trim();
  if (!apiKey) {
    return failure("未配置 RUNNINGHUB_API_KEY：绑定 agent env secret 或设置实例环境变量");
  }

  // workflow — model field first (digits or app:<digits>), then config /
  // instance env fallbacks.
  if (!spec) {
    return failure("未指定 RunningHub 工作流：把工作流 ID 填入模型栏（纯数字），或 app:<webappId>");
  }

  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const timeoutMs = Math.max(1, timeoutSec * 1000);
  const deadline = Date.now() + timeoutMs;
  const remainingMs = () => deadline - Date.now();
  const pollIntervalMs = Math.max(1, asNumber(config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS));
  const base = (asString(config.runninghubApiBase).trim() || DEFAULT_RUNNINGHUB_API_BASE).replace(/\/+$/, "");
  const host = (() => {
    try {
      return new URL(base).host;
    } catch {
      return "www.runninghub.cn";
    }
  })();

  const promptNodeId = firstNonEmptyString(
    config.promptNodeId,
    process.env.RUNNINGHUB_PROMPT_NODE_ID,
    DEFAULT_PROMPT_NODE_ID,
  );
  const promptField = firstNonEmptyString(config.promptField, DEFAULT_PROMPT_FIELD);
  const nodeInfoList = [{ nodeId: promptNodeId, fieldName: promptField, fieldValue: prompt }];

  const createPath = spec.kind === "app" ? "/task/openapi/ai-app/run" : "/task/openapi/create";
  const workflowDescription = spec.kind === "app" ? `AI App ${spec.id}` : `工作流 ${spec.id}`;

  if (onMeta) {
    await onMeta({
      adapterType: "imagegen_local",
      command: `POST ${base}${createPath}`,
      cwd,
      commandNotes: [
        `RunningHub ${workflowDescription}，提示词注入 nodeId=${promptNodeId} / fieldName=${promptField}。`,
        `轮询任务状态直到 SUCCESS/FAILED，总超时 ${timeoutSec}s。`,
        "输出文件下载到工作区 imagegen/ 并作为 issue 附件上传。",
      ],
      prompt,
      promptMetrics: { promptChars: prompt.length },
      context,
    });
  }

  await onLog("stdout", `[imagegen] 使用 RunningHub ${workflowDescription} 创建任务…\n`);
  const createBody: Record<string, unknown> =
    spec.kind === "app"
      ? { webappId: spec.id, apiKey, nodeInfoList }
      : { apiKey, workflowId: spec.id, nodeInfoList };
  const created = await rhCall({ base, host, path: createPath, body: createBody, timeoutMs: remainingMs() });
  if (created.kind === "timeout") {
    return { ...failure(`RunningHub 创建任务超时（${timeoutSec}s）`), timedOut: true };
  }
  if (created.kind === "error") {
    return failure(created.message);
  }
  if (created.code !== 0) {
    return failure(`RunningHub 创建任务失败 code ${created.code}: ${created.msg || "(无 msg)"}`);
  }
  const taskId = asString(parseObject(created.data).taskId).trim();
  if (!taskId) {
    return failure("RunningHub 创建任务响应缺少 taskId");
  }
  const baseResultJson = { taskId, workflowId: String(spec.id), workflowKind: spec.kind };
  await onLog("stdout", `[imagegen] 任务已创建（taskId=${taskId}），开始轮询状态…\n`);

  const cancelTask = async () => {
    try {
      await rhCall({ base, host, path: "/task/openapi/cancel", body: { apiKey, taskId }, timeoutMs: 10_000 });
      await onLog("stdout", `[imagegen] 已发送取消请求（taskId=${taskId}，尽力而为）。\n`);
    } catch {
      // best-effort only
    }
  };

  // poll status every pollIntervalMs until SUCCESS/FAILED or deadline
  let pollErrors = 0;
  let lastLoggedStatus = "";
  for (;;) {
    if (remainingMs() <= 0) {
      await cancelTask();
      return {
        ...failure(`RunningHub 任务超时（${timeoutSec}s，taskId=${taskId}），已尽力取消`),
        timedOut: true,
        resultJson: { ...baseResultJson },
      };
    }
    const statusResult = await rhCall({
      base,
      host,
      path: "/task/openapi/status",
      body: { apiKey, taskId },
      timeoutMs: Math.min(Math.max(1, remainingMs()), 30_000),
    });
    if (statusResult.kind === "timeout") {
      continue; // deadline check at the top of the loop decides
    }
    if (statusResult.kind === "error" || statusResult.code !== 0) {
      pollErrors += 1;
      const message =
        statusResult.kind === "error"
          ? statusResult.message
          : `RunningHub status 返回 code ${statusResult.code}: ${statusResult.msg || "(无 msg)"}`;
      if (pollErrors > MAX_POLL_CONSECUTIVE_ERRORS) {
        return failure(message, { resultJson: { ...baseResultJson } });
      }
      await onLog("stderr", `[imagegen] 状态查询失败（第 ${pollErrors} 次）: ${message}\n`);
      await sleep(Math.min(pollIntervalMs, Math.max(1, remainingMs())));
      continue;
    }
    pollErrors = 0;
    const status = asString(statusResult.data).trim().toUpperCase();
    if (status === "SUCCESS") {
      await onLog("stdout", "[imagegen] 任务执行成功，获取输出文件…\n");
      break;
    }
    if (status === "FAILED") {
      return failure(
        `RunningHub 任务执行失败（taskId=${taskId}）${statusResult.msg ? `: ${statusResult.msg}` : ""}`,
        { resultJson: { ...baseResultJson } },
      );
    }
    if (status && status !== lastLoggedStatus) {
      lastLoggedStatus = status;
      await onLog("stdout", `[imagegen] 任务状态: ${status}…\n`);
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, remainingMs())));
  }

  // fetch outputs (804 = still running, 813 = queued -> short retry ×5;
  // 805 = FAILED -> terminal)
  let outputs: Array<{ fileUrl: string; fileType: string }> = [];
  let pendingRetries = 0;
  for (;;) {
    if (remainingMs() <= 0) {
      return {
        ...failure(`RunningHub 获取输出超时（${timeoutSec}s，taskId=${taskId}）`),
        timedOut: true,
        resultJson: { ...baseResultJson },
      };
    }
    const outputsResult = await rhCall({
      base,
      host,
      path: "/task/openapi/outputs",
      body: { apiKey, taskId },
      timeoutMs: Math.min(Math.max(1, remainingMs()), 30_000),
    });
    if (outputsResult.kind === "timeout") {
      continue;
    }
    if (outputsResult.kind === "error") {
      return failure(outputsResult.message, { resultJson: { ...baseResultJson } });
    }
    if (outputsResult.code === 0) {
      const entries = Array.isArray(outputsResult.data) ? outputsResult.data : [];
      outputs = entries
        .map((entry) => {
          const record = parseObject(entry);
          return {
            fileUrl: asString(record.fileUrl).trim(),
            fileType: asString(record.fileType).trim(),
          };
        })
        .filter((entry) => entry.fileUrl.length > 0);
      break;
    }
    if (outputsResult.code === 804 || outputsResult.code === 813) {
      pendingRetries += 1;
      if (pendingRetries > OUTPUTS_PENDING_MAX_RETRIES) {
        return failure(
          `RunningHub outputs 在 ${OUTPUTS_PENDING_MAX_RETRIES} 次重试后仍未就绪（code ${outputsResult.code}）`,
          { resultJson: { ...baseResultJson } },
        );
      }
      await sleep(Math.min(pollIntervalMs, Math.max(1, remainingMs())));
      continue;
    }
    if (outputsResult.code === 805) {
      return failure(
        `RunningHub 任务失败 code 805${outputsResult.msg ? `: ${outputsResult.msg}` : ""}（taskId=${taskId}）`,
        { resultJson: { ...baseResultJson } },
      );
    }
    return failure(
      `RunningHub outputs 返回 code ${outputsResult.code}: ${outputsResult.msg || "(无 msg)"}`,
      { resultJson: { ...baseResultJson } },
    );
  }

  if (outputs.length === 0) {
    return failure(`RunningHub 任务成功但没有输出文件（taskId=${taskId}）`, { resultJson: { ...baseResultJson } });
  }

  // download every output fileUrl (CDN urls, no auth) and write to
  // cwd/imagegen/{runId}-{n}.{fileType||png}
  const imagesDir = path.join(cwd, "imagegen");
  await fs.mkdir(imagesDir, { recursive: true });
  const stem = sanitizeFileStem(runId);
  const written: WrittenImage[] = [];
  const downloadErrors: string[] = [];
  for (let n = 0; n < outputs.length; n += 1) {
    const output = outputs[n]!;
    const remaining = remainingMs();
    if (remaining <= 0) {
      if (written.length === 0) {
        return {
          ...failure(`RunningHub 输出下载超时（${timeoutSec}s，taskId=${taskId}）`),
          timedOut: true,
          resultJson: { ...baseResultJson },
        };
      }
      downloadErrors.push(`第 ${n + 1}/${outputs.length} 个输出因超时未下载`);
      break;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, remaining));
    try {
      const response = await fetch(output.fileUrl, { signal: controller.signal });
      if (!response.ok) {
        downloadErrors.push(`下载失败（HTTP ${response.status}）: ${output.fileUrl}`);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const ext = sanitizeFileExtension(output.fileType);
      const filename = `${stem}-${written.length + 1}.${ext}`;
      const absolutePath = path.join(imagesDir, filename);
      await fs.writeFile(absolutePath, bytes);
      written.push({
        file: `imagegen/${filename}`,
        absolutePath,
        filename,
        mimeType: mimeTypeForExtension(ext),
        byteSize: bytes.length,
      });
      await onLog("stdout", `[imagegen] 已写入 ${path.join("imagegen", filename)}（${bytes.length} 字节）。\n`);
    } catch (err) {
      if (controller.signal.aborted) {
        downloadErrors.push(`下载超时: ${output.fileUrl}`);
      } else {
        downloadErrors.push(`下载失败: ${output.fileUrl}（${err instanceof Error ? err.message : String(err)}）`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  if (written.length === 0) {
    return failure(
      downloadErrors.length > 0
        ? `RunningHub 输出全部下载失败：${downloadErrors.join("；")}`
        : `RunningHub 任务成功但没有可下载的输出（taskId=${taskId}）`,
      { resultJson: { ...baseResultJson } },
    );
  }

  // upload each image as an issue attachment + artifact work product,
  // then post a final issue comment (unchanged machinery)
  const uploadErrors: string[] = [...downloadErrors];
  const attachmentIds: string[] = [];
  const apiBase = resolvePaperclipApiBase(config, envConfig);
  const token = resolvePaperclipApiToken(envConfig, authToken);
  const issueId = resolveIssueId(parseObject(context));
  const uploadTimeoutMs = 60_000;

  if (!issueId) {
    uploadErrors.push("缺少 issue id（context.taskId / issueId / wake issue.id 均为空），无法上传附件");
  } else if (!token) {
    uploadErrors.push("缺少 Paperclip API token（authToken / env PAPERCLIP_API_KEY 均为空），无法上传附件");
  } else {
    for (const image of written) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(await fs.readFile(image.absolutePath))], { type: image.mimeType }), image.filename);
      const uploadResult = await requestJson({
        url: `${apiBase}/api/companies/${agent.companyId}/issues/${issueId}/attachments`,
        method: "POST",
        token,
        runId,
        body: form,
        timeoutMs: uploadTimeoutMs,
      });
      if (!uploadResult.ok) {
        uploadErrors.push(`附件上传失败（${image.filename}）: ${uploadResult.error}`);
        await onLog("stderr", `[imagegen] 附件上传失败（${image.filename}）: ${uploadResult.error}\n`);
        continue;
      }
      const attachmentId = asString(uploadResult.payload.id).trim();
      const contentPath = asString(uploadResult.payload.contentPath).trim() ||
        (attachmentId ? `/api/attachments/${attachmentId}/content` : "");
      if (!attachmentId) {
        uploadErrors.push(`附件上传响应缺少 id（${image.filename}）`);
        continue;
      }
      image.attachmentId = attachmentId;
      image.contentPath = contentPath;
      attachmentIds.push(attachmentId);
      await onLog("stdout", `[imagegen] 已上传附件 ${image.filename}（attachmentId=${attachmentId}）。\n`);

      const workProductBody: Record<string, unknown> = {
        type: "artifact",
        provider: "paperclip",
        title: image.filename,
        status: "ready_for_review",
        metadata: { attachmentId },
      };
      if (isUuid(runId)) workProductBody.createdByRunId = runId;
      const workProductResult = await requestJson({
        url: `${apiBase}/api/issues/${issueId}/work-products`,
        method: "POST",
        token,
        runId,
        body: JSON.stringify(workProductBody),
        contentType: "application/json",
        timeoutMs: uploadTimeoutMs,
      });
      if (!workProductResult.ok) {
        uploadErrors.push(`work product 创建失败（${image.filename}）: ${workProductResult.error}`);
        await onLog("stderr", `[imagegen] work product 创建失败（${image.filename}）: ${workProductResult.error}\n`);
        continue;
      }
      const workProductId = asString(workProductResult.payload.id).trim();
      if (workProductId) image.workProductId = workProductId;
    }

    // final issue comment listing the generated images; names the prompt
    // node so a wrong-node misfire is visible/debuggable
    const commentLines: string[] = [`已生成 ${written.length} 张图片（RunningHub ${workflowDescription}，taskId=${taskId}）：`, ""];
    for (const image of written) {
      if (image.contentPath) {
        commentLines.push(`- [${image.filename}](${image.contentPath})`);
      } else {
        commentLines.push(`- ${image.file}（上传失败，仅保留在工作区）`);
      }
    }
    commentLines.push("", `提示词注入节点: nodeId=${promptNodeId} / fieldName=${promptField}`);
    if (uploadErrors.length > 0) {
      commentLines.push("", `注意：有 ${uploadErrors.length} 项下载/上传问题，详见运行日志。`);
    }
    const commentResult = await requestJson({
      url: `${apiBase}/api/issues/${issueId}/comments`,
      method: "POST",
      token,
      runId,
      body: JSON.stringify({ body: commentLines.join("\n") }),
      contentType: "application/json",
      timeoutMs: uploadTimeoutMs,
    });
    if (!commentResult.ok) {
      uploadErrors.push(`发布结果评论失败: ${commentResult.error}`);
      await onLog("stderr", `[imagegen] 发布结果评论失败: ${commentResult.error}\n`);
    }
  }

  const summary =
    uploadErrors.length > 0
      ? `已生成 ${written.length} 张图片，但有 ${uploadErrors.length} 项问题（下载/上传/评论），详见 errorMessage`
      : `已生成 ${written.length} 张图片`;

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: uploadErrors.length > 0 ? `已生成 ${written.length} 张图片，但存在问题：${uploadErrors.join("；")}` : null,
    provider: "runninghub",
    model: spec.raw,
    billingType: "api",
    summary,
    resultJson: {
      ...baseResultJson,
      images: written.map((image) => ({
        file: image.file,
        mimeType: image.mimeType,
        byteSize: image.byteSize,
        ...(image.attachmentId ? { attachmentId: image.attachmentId } : {}),
        ...(image.contentPath ? { contentPath: image.contentPath } : {}),
        ...(image.workProductId ? { workProductId: image.workProductId } : {}),
      })),
      attachmentIds,
      ...(uploadErrors.length > 0 ? { uploadErrors } : {}),
    },
  };
}
