import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createServerAdapter, type as adapterType, label, buildModels } from "../dist/index.js";

const RUN_ID = "1c6f6f7e-8f4b-4b0a-9b8e-2f2a3d4c5e6f";
const ATTACHMENT_ID_1 = "aaaaaaaa-1111-4111-8111-111111111111";
const ATTACHMENT_ID_2 = "bbbbbbbb-2222-4222-8222-222222222222";
const RH_BASE = "https://www.runninghub.cn";
const API_KEY = "rh-key-secret-do-not-log";
const WORKFLOW_ID = "881234567890";

const originalFetch = globalThis.fetch;
const savedEnv = {};
for (const key of ["RUNNINGHUB_API_KEY", "RUNNINGHUB_WORKFLOW_ID", "RUNNINGHUB_PROMPT_NODE_ID"]) {
  savedEnv[key] = process.env[key];
}

function clearRunninghubEnv() {
  delete process.env.RUNNINGHUB_API_KEY;
  delete process.env.RUNNINGHUB_WORKFLOW_ID;
  delete process.env.RUNNINGHUB_PROMPT_NODE_ID;
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function binaryResponse(buf, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => buf.toString("utf8"),
  };
}

async function makeTempCwd() {
  return fs.mkdtemp(path.join(os.tmpdir(), "imagegen-adapter-test-"));
}

function makeCtx({ cwd, config = {}, context = {}, authToken = "tok" } = {}) {
  const logs = [];
  const metas = [];
  return {
    logs,
    metas,
    ctx: {
      runId: RUN_ID,
      agent: { id: "agent-1", companyId: "co-1", name: "imagegen", adapterType: "imagegen_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        env: { RUNNINGHUB_API_KEY: API_KEY },
        apiUrl: "http://paperclip.test",
        model: WORKFLOW_ID,
        pollIntervalMs: 1,
        ...config,
      },
      context: {
        taskId: "iss-1",
        paperclipWorkspace: { cwd },
        paperclipWake: {
          issue: { id: "iss-1", title: "生成图片任务" },
          latestCommentId: "c2",
          comments: [
            { id: "c1", body: "旧的机器人评论", author: { type: "agent", id: "agent-9" } },
            { id: "c2", body: "画一只太空猫", author: { type: "user", id: "user-1" } },
          ],
        },
        ...context,
      },
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      onMeta: async (meta) => {
        metas.push(meta);
      },
      authToken,
    },
  };
}

/**
 * RunningHub-aware mock dispatcher. `statusSequence` values are consumed one
 * per /status call (last value repeats).
 */
function installRhFetchMock({
  statusSequence = ["RUNNING", "SUCCESS"],
  outputs = [
    { fileUrl: "https://cdn.rh.test/out-1.png", fileType: "png", nodeId: "9" },
    { fileUrl: "https://cdn.rh.test/out-2.png", fileType: "png", nodeId: "9" },
  ],
  files = {},
  createResponse,
  outputsResponse,
} = {}) {
  const calls = [];
  let statusIndex = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const record = { url: u, init };
    if (typeof init.body === "string") {
      try {
        record.body = JSON.parse(init.body);
      } catch {
        record.body = init.body;
      }
    }
    calls.push(record);
    if (u === `${RH_BASE}/task/openapi/create` || u === `${RH_BASE}/task/openapi/ai-app/run`) {
      return jsonResponse(
        createResponse ?? { code: 0, msg: "success", data: { taskId: "task-1", taskStatus: "QUEUED" } },
      );
    }
    if (u === `${RH_BASE}/task/openapi/status`) {
      const value = statusSequence[Math.min(statusIndex, statusSequence.length - 1)];
      statusIndex += 1;
      return jsonResponse(typeof value === "object" ? value : { code: 0, msg: "", data: value });
    }
    if (u === `${RH_BASE}/task/openapi/outputs`) {
      return jsonResponse(outputsResponse ?? { code: 0, msg: "success", data: outputs });
    }
    if (u === `${RH_BASE}/task/openapi/cancel`) {
      return jsonResponse({ code: 0, msg: "success", data: null });
    }
    if (u.startsWith("https://cdn.rh.test/")) {
      const buf = files[u] ?? Buffer.from(`bytes-of-${u}`);
      return binaryResponse(buf);
    }
    if (u.endsWith("/api/companies/co-1/issues/iss-1/attachments")) {
      const uploadCount = calls.filter((c) => c.url.endsWith("/attachments")).length;
      const id = uploadCount === 1 ? ATTACHMENT_ID_1 : ATTACHMENT_ID_2;
      return jsonResponse({ id, contentPath: `/api/attachments/${id}/content` }, 201);
    }
    if (u.endsWith("/api/issues/iss-1/work-products")) {
      return jsonResponse({ id: `wp-${calls.length}` }, 201);
    }
    if (u.endsWith("/api/issues/iss-1/comments")) {
      return jsonResponse({ id: "cm-1" }, 201);
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return calls;
}

test.beforeEach(() => {
  clearRunninghubEnv();
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearRunninghubEnv();
});

test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("createServerAdapter exposes the plugin contract shape", () => {
  const adapter = createServerAdapter();
  assert.equal(adapter.type, "imagegen_local");
  assert.equal(adapterType, "imagegen_local");
  assert.equal(label, "图像生成 (RunningHub)");
  assert.equal(typeof adapter.execute, "function");
  assert.equal(typeof adapter.testEnvironment, "function");
  assert.deepEqual(adapter.models, [{ id: "workflow-id", label: "在模型栏填 RunningHub 工作流数字 ID" }]);
  assert.equal(adapter.supportsLocalAgentJwt, true);
  assert.equal(adapter.supportsInstructionsBundle, false);
  assert.equal(adapter.requiresMaterializedRuntimeSkills, false);
  assert.ok(adapter.agentConfigurationDoc.includes("RUNNINGHUB_API_KEY"));
  assert.ok(adapter.agentConfigurationDoc.includes("app:"));

  // instance default workflow becomes the one real model entry
  process.env.RUNNINGHUB_WORKFLOW_ID = "555";
  assert.deepEqual(createServerAdapter().models, [{ id: "555", label: "默认工作流 555" }]);
  assert.deepEqual(buildModels(), [{ id: "555", label: "默认工作流 555" }]);
});

test("missing RUNNINGHUB_API_KEY fails closed in execute and testEnvironment", async () => {
  const adapter = createServerAdapter();
  const cwd = await makeTempCwd();
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error("fetch must not be called without an API key");
  };

  const { ctx } = makeCtx({ cwd, config: { env: {} } });
  const result = await adapter.execute(ctx);
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
  assert.equal(result.errorMessage, "未配置 RUNNINGHUB_API_KEY：绑定 agent env secret 或设置实例环境变量");
  assert.equal(calls.length, 0);

  // neither source -> error-level check, status fail
  const neither = await adapter.testEnvironment({
    companyId: "co-1",
    adapterType: "imagegen_local",
    config: { env: {}, model: WORKFLOW_ID },
  });
  assert.equal(neither.status, "fail");
  const errorCheck = neither.checks.find((check) => check.code === "runninghub_api_key_missing");
  assert.ok(errorCheck, "expected runninghub_api_key_missing check");
  assert.equal(errorCheck.level, "error");

  // instance env only -> warn-level check, not fail
  process.env.RUNNINGHUB_API_KEY = API_KEY;
  const instanceOnly = await adapter.testEnvironment({
    companyId: "co-1",
    adapterType: "imagegen_local",
    config: { env: {}, model: WORKFLOW_ID },
  });
  assert.equal(instanceOnly.status, "warn");
  const warnCheck = instanceOnly.checks.find((check) => check.code === "runninghub_api_key_instance_only");
  assert.ok(warnCheck, "expected runninghub_api_key_instance_only check");
  assert.equal(warnCheck.level, "warn");

  // per-agent binding + workflow -> pass
  const bound = await adapter.testEnvironment({
    companyId: "co-1",
    adapterType: "imagegen_local",
    config: { env: { RUNNINGHUB_API_KEY: API_KEY }, model: WORKFLOW_ID },
  });
  assert.equal(bound.status, "pass");
});

test("missing workflow id fails closed (placeholder model is not a selection)", async () => {
  const adapter = createServerAdapter();
  const cwd = await makeTempCwd();
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error("fetch must not be called without a workflow id");
  };

  const { ctx } = makeCtx({ cwd, config: { model: "workflow-id" } });
  const result = await adapter.execute(ctx);
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorMessage, "未指定 RunningHub 工作流：把工作流 ID 填入模型栏（纯数字），或 app:<webappId>");
  assert.equal(calls.length, 0);
});

test("happy path: create -> RUNNING -> SUCCESS -> 2 outputs downloaded, uploaded, exit 0", async () => {
  const adapter = createServerAdapter();
  const cwd = await makeTempCwd();
  const png1 = Buffer.from("fake-png-bytes-1");
  const png2 = Buffer.from("fake-png-bytes-2");
  const calls = installRhFetchMock({
    statusSequence: ["RUNNING", "SUCCESS"],
    files: {
      "https://cdn.rh.test/out-1.png": png1,
      "https://cdn.rh.test/out-2.png": png2,
    },
  });

  const { ctx, logs, metas } = makeCtx({ cwd });
  const result = await adapter.execute(ctx);

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.ok(!result.errorMessage, `expected no errorMessage, got: ${result.errorMessage}`);
  assert.equal(result.summary, "已生成 2 张图片");
  assert.equal(result.provider, "runninghub");
  assert.equal(result.model, WORKFLOW_ID);
  assert.equal(result.billingType, "api");
  assert.equal(result.resultJson.taskId, "task-1");
  assert.equal(result.resultJson.workflowId, WORKFLOW_ID);
  assert.deepEqual(result.resultJson.attachmentIds, [ATTACHMENT_ID_1, ATTACHMENT_ID_2]);
  assert.equal(result.resultJson.images.length, 2);
  assert.equal(result.resultJson.images[0].file, `imagegen/${RUN_ID}-1.png`);
  assert.equal(result.resultJson.images[0].attachmentId, ATTACHMENT_ID_1);
  assert.equal(result.resultJson.uploadErrors, undefined);

  // files written from the downloaded bytes
  assert.deepEqual(await fs.readFile(path.join(cwd, "imagegen", `${RUN_ID}-1.png`)), png1);
  assert.deepEqual(await fs.readFile(path.join(cwd, "imagegen", `${RUN_ID}-2.png`)), png2);

  // create call: apiKey + workflowId + nodeInfoList carrying the prompt
  const createCall = calls.find((c) => c.url === `${RH_BASE}/task/openapi/create`);
  assert.ok(createCall, "expected create call");
  assert.equal(createCall.init.method, "POST");
  assert.equal(createCall.init.headers.Host, "www.runninghub.cn");
  assert.equal(createCall.init.headers["content-type"], "application/json");
  assert.equal(createCall.body.apiKey, API_KEY);
  assert.equal(createCall.body.workflowId, WORKFLOW_ID);
  assert.deepEqual(createCall.body.nodeInfoList, [{ nodeId: "6", fieldName: "text", fieldValue: "画一只太空猫" }]);

  // status + outputs calls carry the apiKey in the body
  const statusCalls = calls.filter((c) => c.url === `${RH_BASE}/task/openapi/status`);
  assert.equal(statusCalls.length, 2);
  for (const call of statusCalls) {
    assert.equal(call.body.apiKey, API_KEY);
    assert.equal(call.body.taskId, "task-1");
  }
  const outputsCall = calls.find((c) => c.url === `${RH_BASE}/task/openapi/outputs`);
  assert.equal(outputsCall.body.apiKey, API_KEY);

  // no cancel on the happy path
  assert.equal(calls.filter((c) => c.url === `${RH_BASE}/task/openapi/cancel`).length, 0);

  // downloads are plain GETs (no auth header)
  const downloadCalls = calls.filter((c) => c.url.startsWith("https://cdn.rh.test/"));
  assert.equal(downloadCalls.length, 2);
  for (const call of downloadCalls) {
    assert.equal(call.init.headers?.authorization, undefined);
  }

  // uploads unchanged: bearer token + run id header + FormData
  const uploadCalls = calls.filter((c) => c.url.endsWith("/attachments"));
  assert.equal(uploadCalls.length, 2);
  for (const call of uploadCalls) {
    assert.equal(call.url, "http://paperclip.test/api/companies/co-1/issues/iss-1/attachments");
    assert.equal(call.init.headers.authorization, "Bearer tok");
    assert.equal(call.init.headers["x-paperclip-run-id"], RUN_ID);
    assert.ok(call.init.body instanceof FormData);
  }
  const workProductCalls = calls.filter((c) => c.url.endsWith("/work-products"));
  assert.equal(workProductCalls.length, 2);
  assert.equal(workProductCalls[0].body.type, "artifact");
  assert.equal(workProductCalls[0].body.provider, "paperclip");
  assert.equal(workProductCalls[0].body.metadata.attachmentId, ATTACHMENT_ID_1);
  assert.equal(workProductCalls[0].body.createdByRunId, RUN_ID);

  // final comment mentions the images and the prompt node id
  const commentCall = calls.find((c) => c.url.endsWith("/comments"));
  assert.ok(commentCall, "expected final comment");
  assert.ok(commentCall.body.body.includes("已生成 2 张图片"));
  assert.ok(commentCall.body.body.includes(`[${RUN_ID}-1.png](/api/attachments/${ATTACHMENT_ID_1}/content)`));
  assert.ok(commentCall.body.body.includes("nodeId=6"), commentCall.body.body);

  // the apiKey never appears in logs or meta
  const allLogs = logs.map((entry) => entry.chunk).join("");
  assert.ok(!allLogs.includes(API_KEY), "apiKey leaked into logs");
  assert.ok(!JSON.stringify(metas).includes(API_KEY), "apiKey leaked into onMeta");
});

test("create code!==0 -> exit 1 with msg surfaced", async () => {
  const adapter = createServerAdapter();
  const cwd = await makeTempCwd();
  installRhFetchMock({ createResponse: { code: 433, msg: "APIKEY_INVALID", data: null } });

  const { ctx, logs } = makeCtx({ cwd });
  const result = await adapter.execute(ctx);
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
  assert.ok(result.errorMessage.includes("433"), result.errorMessage);
  assert.ok(result.errorMessage.includes("APIKEY_INVALID"), result.errorMessage);
  const allLogs = logs.map((entry) => entry.chunk).join("");
  assert.ok(!allLogs.includes(API_KEY));
});

test("status FAILED -> exit 1 with taskId in the message", async () => {
  const adapter = createServerAdapter();
  const cwd = await makeTempCwd();
  installRhFetchMock({ statusSequence: [{ code: 0, msg: "workflow error", data: "FAILED" }] });

  const { ctx } = makeCtx({ cwd });
  const result = await adapter.execute(ctx);
  assert.equal(result.exitCode, 1);
  assert.ok(result.errorMessage.includes("task-1"), result.errorMessage);
  assert.ok(result.errorMessage.includes("workflow error"), result.errorMessage);
  assert.equal(result.resultJson.taskId, "task-1");
});

test("outputs code 805 -> terminal failure with msg", async () => {
  const adapter = createServerAdapter();
  const cwd = await makeTempCwd();
  installRhFetchMock({
    statusSequence: ["SUCCESS"],
    outputsResponse: { code: 805, msg: "TASK_FAILED", data: null },
  });

  const { ctx } = makeCtx({ cwd });
  const result = await adapter.execute(ctx);
  assert.equal(result.exitCode, 1);
  assert.ok(result.errorMessage.includes("805"), result.errorMessage);
  assert.ok(result.errorMessage.includes("TASK_FAILED"), result.errorMessage);
});

test("poll deadline -> best-effort cancel + timedOut", async () => {
  const adapter = createServerAdapter();
  const cwd = await makeTempCwd();
  const calls = installRhFetchMock({ statusSequence: ["RUNNING"] });

  const { ctx } = makeCtx({ cwd, config: { timeoutSec: 0.05 } });
  const result = await adapter.execute(ctx);
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, true);
  assert.ok(result.errorMessage.includes("超时"), result.errorMessage);
  const cancelCall = calls.find((c) => c.url === `${RH_BASE}/task/openapi/cancel`);
  assert.ok(cancelCall, "expected best-effort cancel call");
  assert.equal(cancelCall.body.taskId, "task-1");
  assert.equal(cancelCall.body.apiKey, API_KEY);
});

test("model 'app:123' routes to ai-app/run with numeric webappId", async () => {
  const adapter = createServerAdapter();
  const cwd = await makeTempCwd();
  const calls = installRhFetchMock({
    statusSequence: ["SUCCESS"],
    outputs: [{ fileUrl: "https://cdn.rh.test/app-out.png", fileType: "png" }],
  });

  const { ctx } = makeCtx({ cwd, config: { model: "app:123" } });
  const result = await adapter.execute(ctx);
  assert.equal(result.exitCode, 0);
  assert.equal(result.model, "app:123");
  assert.equal(result.resultJson.workflowId, "123");
  assert.equal(result.resultJson.workflowKind, "app");

  const runCall = calls.find((c) => c.url === `${RH_BASE}/task/openapi/ai-app/run`);
  assert.ok(runCall, "expected ai-app/run call");
  assert.strictEqual(runCall.body.webappId, 123);
  assert.equal(runCall.body.workflowId, undefined);
  assert.equal(runCall.body.apiKey, API_KEY);
  assert.equal(calls.filter((c) => c.url === `${RH_BASE}/task/openapi/create`).length, 0);
});

test("empty prompt -> exit 1 without calling any API", async () => {
  const adapter = createServerAdapter();
  const cwd = await makeTempCwd();
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error("must not be called");
  };

  const { ctx } = makeCtx({
    cwd,
    context: {
      taskId: "iss-1",
      paperclipWorkspace: { cwd },
      paperclipWake: {
        issue: { id: "iss-1" },
        comments: [{ id: "c1", body: "只有 agent 评论", author: { type: "agent", id: "agent-9" } }],
      },
    },
  });
  const result = await adapter.execute(ctx);
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorMessage, "没有可用的生成提示词");
  assert.equal(calls.length, 0);
});

test("upload failure is reported honestly: exit 0 + errorMessage + uploadErrors", async () => {
  const adapter = createServerAdapter();
  const cwd = await makeTempCwd();
  const png1 = Buffer.from("solo-image");
  const baseCalls = installRhFetchMock({
    statusSequence: ["SUCCESS"],
    outputs: [{ fileUrl: "https://cdn.rh.test/solo.png", fileType: "png" }],
    files: { "https://cdn.rh.test/solo.png": png1 },
  });
  const dispatch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/attachments")) {
      baseCalls.push({ url: String(url), init });
      return jsonResponse({ error: "storage unavailable" }, 500);
    }
    return dispatch(url, init);
  };

  const { ctx } = makeCtx({ cwd });
  const result = await adapter.execute(ctx);

  assert.equal(result.exitCode, 0, "generation succeeded, so exitCode stays 0");
  assert.ok(result.errorMessage.includes("上传失败"), result.errorMessage);
  assert.deepEqual(result.resultJson.attachmentIds, []);
  assert.equal(result.resultJson.uploadErrors.length, 1);
  assert.ok(result.summary.includes("1 项问题"), result.summary);
  await fs.access(path.join(cwd, "imagegen", `${RUN_ID}-1.png`));
  const commentCall = baseCalls.find((c) => c.url.endsWith("/comments"));
  assert.ok(commentCall, "comment should still be posted");
  assert.ok(commentCall.body.body.includes("上传失败"), commentCall.body.body);
});
