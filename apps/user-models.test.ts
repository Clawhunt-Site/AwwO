import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { readFileSync } from "node:fs";
import { bindUserModel, cloudRelayURL, validCloudOrigin } from "./user-models.ts";
import { createOpenAIAgentsServer } from "./openai-agents-worker/server.mjs";
import { createPiServer } from "./pi-worker/server.mjs";
import { loadConfig as loadAgents } from "./openai-agents-worker/config.mjs";
import { loadConfig as loadPi } from "./pi-worker/config.mjs";

const model = "byok_" + "a".repeat(33) + "_" + "1".repeat(16);
const profile = (key = "synthetic-user-key") => ({
  id: model,
  provider: "llmgate",
  model: "test-chat-model",
  baseURL: "https://api.clawhunt.site/v1",
  apiKey: key,
  protocol: "chat_completions",
  contextWindow: 32768,
  maxTokens: 4096,
  reasoningEfforts: [],
  defaultReasoningEffort: "",
});
const request = (key = "synthetic-user-key") => ({
  runId: "test-run",
  tenantId: "tenant",
  sessionId: "session",
  prompt: "Hello",
  messages: [],
  model,
  userModel: profile(key),
});

test("personal admission has no shared-key fallback and refuses arbitrary origins or fields", () => {
  const config = {
    userCredentials: true,
    ready: true,
    models: [{ apiKey: "operator-key" }],
  };
  assert.throws(() =>
    bindUserModel(config, { ...request(), userModel: undefined }, "pi"),
  );
  for (const change of [
    { baseURL: "http://127.0.0.1" },
    { baseURL: "https://api.clawhunt.site/v1/redirect" },
    { apiKey: "key\nheader" },
    { apiKeyEnv: "HOME" },
    { provider: "__proto__" },
    { id: "other" },
  ]) {
    assert.throws(() =>
      bindUserModel(
        config,
        { ...request(), userModel: { ...profile(), ...change } },
        "pi",
      ),
    );
  }
  assert.throws(() =>
    bindUserModel({ ...config, userCredentials: false }, request(), "pi"),
  );
  const a = request("synthetic-user-A"),
    b = request("synthetic-user-B");
  const first = bindUserModel(config, a, "pi"),
    second = bindUserModel(config, b, "pi");
  assert.equal(
    (first.models[0] as { apiKey: string }).apiKey,
    "synthetic-user-A",
  );
  assert.equal(
    (second.models[0] as { apiKey: string }).apiKey,
    "synthetic-user-B",
  );
  assert.equal(config.models[0].apiKey, "operator-key");
  assert.equal(Object.hasOwn(a, "userModel"), false);
});

const capable = () => ({
  ...profile(),
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  protocol: "responses",
  structuredOutput: true as const,
});

test("structuredOutput is an optional eleventh field: literally true, only on openai-agents, passed through unchanged", () => {
  const config = {
    userCredentials: true,
    ready: true,
    models: [{ apiKey: "operator-key" }],
  };
  const bound = bindUserModel(
    config,
    { ...request(), userModel: capable() },
    "openai-agents",
  );
  assert.equal(
    (bound.models[0] as { structuredOutput?: true }).structuredOutput,
    true,
  );
  // Without the field the bound model keeps exactly the ten keys it always had, so a
  // plain run is byte-identical to one before the field existed.
  const plain = bindUserModel(config, request(), "openai-agents");
  assert.equal(Object.hasOwn(plain.models[0] as object, "structuredOutput"), false);
  assert.equal(Object.keys(plain.models[0] as object).length, 10);
  // The capability exists on no other runtime, and only the literal true counts.
  assert.throws(() =>
    bindUserModel(config, { ...request(), userModel: capable() }, "pi"),
  );
  for (const value of [false, "true", 1, null, undefined]) {
    const userModel: Record<string, unknown> = { ...capable() };
    if (value === undefined) delete userModel.structuredOutput;
    else userModel.structuredOutput = value;
    if (value === undefined) {
      assert.doesNotThrow(() =>
        bindUserModel(config, { ...request(), userModel }, "openai-agents"),
      );
      continue;
    }
    assert.throws(
      () => bindUserModel(config, { ...request(), userModel }, "openai-agents"),
      String(value),
    );
  }
  assert.equal(config.models[0].apiKey, "operator-key");
});

test(
  "openai-agents admits a personal contract only when the userModel declares the capability",
  { timeout: 10000 },
  async (t) => {
    const config = loadAgents({
      AWWO_CREDENTIAL_MODE: "user",
      AWWO_OPENAI_AGENTS_TOKEN: "internal-test-token-".repeat(3),
    });
    const launched: Array<{ structuredOutput: unknown; contract: unknown }> = [];
    const server = createOpenAIAgentsServer(config, {
      startRun: async ({ config: runConfig, request: body, onExit, onEvent }) => {
        launched.push({
          structuredOutput: (runConfig.models[0] as { structuredOutput?: unknown })
            .structuredOutput,
          contract: (body as { outputContract?: unknown }).outputContract,
        });
        setTimeout(() => {
          onExit();
          onEvent({ type: "completed", text: '{"result":"ok"}' });
        }, 0);
        return { done: Promise.resolve(), cancel() {} };
      },
    });
    server.server.listen(0, "127.0.0.1");
    await once(server.server, "listening");
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.server.address().port}`;
    const send = (body: unknown) =>
      fetch(url + "/internal/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + config.token,
        },
        body: JSON.stringify(body),
      });
    const outputContract = {
      version: 1,
      fields: [{ id: "result", type: "text", required: true }],
    };
    // Ten fields plus a contract: refused before any launch, as for an unflagged profile.
    const refused = await send({
      ...request(),
      runtime: "openai-agents",
      userModel: { ...capable(), structuredOutput: undefined },
      outputContract,
    });
    assert.equal(refused.status, 400);
    assert.equal(
      ((await refused.json()) as { error: { code: string } }).error.code,
      "OUTPUT_CONTRACT_NOT_SUPPORTED",
    );
    assert.equal(launched.length, 0);
    // Eleven fields plus a contract: admitted, and the bound model carries the capability.
    const admitted = await send({
      ...request(),
      runId: "run-structured",
      sessionId: "session-structured",
      runtime: "openai-agents",
      userModel: capable(),
      outputContract,
    });
    assert.equal(admitted.status, 200);
    assert.match(await admitted.text(), /completed/);
    assert.deepEqual(launched, [{ structuredOutput: true, contract: outputContract }]);
    const health = await fetch(url + "/health").then((r) => r.text());
    assert.ok(!health.includes("structuredOutput"));
    assert.ok(!health.includes("synthetic-user"));
  },
);

for (const runtime of ["pi", "openai-agents"]) {
  test(
    runtime +
      " admits personal keys independently and never launches an uncredentialed run",
    { timeout: 10000 },
    async (t) => {
      const prefix = runtime === "pi" ? "AWWO_PI_" : "AWWO_OPENAI_AGENTS_";
      const config = (runtime === "pi" ? loadPi : loadAgents)({
        AWWO_CREDENTIAL_MODE: "user",
        [prefix + "TOKEN"]: "internal-test-token-".repeat(3),
      });
      assert.equal(config.ready, true);
      const launched: Array<{ key: string; hasRequestSecret: boolean }> = [];
      const server = (
        runtime === "pi" ? createPiServer : createOpenAIAgentsServer
      )(config, {
        startRun: async ({
          config: runConfig,
          request: body,
          onExit,
          onEvent,
        }) => {
          launched.push({
            key: runConfig.models[0].apiKey,
            hasRequestSecret: Object.hasOwn(body, "userModel"),
          });
          setTimeout(() => {
            onExit();
            onEvent({ type: "completed", text: "OK" });
          }, 0);
          return { done: Promise.resolve(), cancel() {} };
        },
      });
      server.server.listen(0, "127.0.0.1");
      await once(server.server, "listening");
      t.after(() => server.close());
      const url = `http://127.0.0.1:${server.server.address().port}`;
      const send = (body: unknown) =>
        fetch(url + "/internal/runs", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + config.token,
          },
          body: JSON.stringify(body),
        });
      const missing = await send({ ...request(), userModel: undefined });
      assert.equal(missing.status, 400);
      const responses = await Promise.all(
        ["synthetic-user-A", "synthetic-user-B"].map((key, i) =>
          send({
            ...request(key),
            runId: "run-" + i,
            sessionId: "session-" + i,
            runtime,
          }),
        ),
      );
      for (const res of responses) {
        assert.equal(res.status, 200);
        assert.match(await res.text(), /completed/);
      }
      assert.deepEqual(launched.map((x) => x.key).sort(), [
        "synthetic-user-A",
        "synthetic-user-B",
      ]);
      assert.ok(launched.every((x) => !x.hasRequestSecret));
      const health = await fetch(url + "/health").then((r) => r.text());
      assert.ok(!health.includes("synthetic-user"));
      assert.ok(!JSON.stringify(config).includes("synthetic-user"));
    },
  );
}

// 「AwwO 线上」 (docs/awwo-cloud-relay.md): a relayed model is bound only to the relay the runtime links to.
const relayProfile = () => ({
  ...profile("awwo_lk_" + "x".repeat(43)),
  provider: "awwo",
  model: "bedrock.claude-opus-5-5",
  baseURL: "https://awwo.clawhunt.store/api/v1/relay/v1",
  contextWindow: 200000,
  maxTokens: 64000,
  input: ["text", "image"],
  proseBytesPerToken: 2.15,
});
function withCloudOrigin<T>(origin: string | undefined, run: () => T): T {
  const saved = process.env.AWWO_CLOUD_ORIGIN;
  if (origin === undefined) delete process.env.AWWO_CLOUD_ORIGIN;
  else process.env.AWWO_CLOUD_ORIGIN = origin;
  try { return run(); } finally {
    if (saved === undefined) delete process.env.AWWO_CLOUD_ORIGIN;
    else process.env.AWWO_CLOUD_ORIGIN = saved;
  }
}
const personalConfig = { userCredentials: true, ready: true, models: [] as unknown[] };

test("a relayed model keeps its own limits and input, at the runtime's own relay alone", () => {
  for (const runtime of ["pi", "openai-agents"]) {
    const bound = withCloudOrigin("https://awwo.clawhunt.store", () =>
      bindUserModel(personalConfig, { ...request(), userModel: relayProfile() }, runtime));
    assert.deepEqual(bound.models, [{ ...relayProfile(), provider: "openai" }]);
  }
  for (const origin of [undefined, "", "http://awwo.clawhunt.store", "https://awwo.clawhunt.store/x", "https://evil.example"]) {
    assert.throws(() => withCloudOrigin(origin, () =>
      bindUserModel(personalConfig, { ...request(), userModel: relayProfile() }, "pi")), /Invalid personal model configuration/, String(origin));
  }
  assert.equal(withCloudOrigin("http://127.0.0.1:18087", () =>
    bindUserModel(personalConfig, { ...request(), userModel: { ...relayProfile(), baseURL: "http://127.0.0.1:18087/api/v1/relay/v1" } }, "pi")).ready, true);
});

test("a relayed model's limits stay within the hosted catalog's bounds, and other providers take no relay fields", () => {
  const bind = (userModel: Record<string, unknown>, runtime = "pi") => withCloudOrigin("https://awwo.clawhunt.store", () =>
    bindUserModel(personalConfig, { ...request(), userModel }, runtime));
  for (const change of [{ contextWindow: 2_000_001 }, { maxTokens: 65_537 }, { maxTokens: 199_900 }, { input: ["image"] },
    { input: ["text", "audio"] }, { proseBytesPerToken: 9 }, { protocol: "responses" }, { structuredOutput: true }]) {
    assert.throws(() => bind({ ...relayProfile(), ...change }, "openai-agents"), /Invalid personal model configuration/, JSON.stringify(change));
  }
  assert.throws(() => bind({ ...profile(), input: ["text", "image"] }), /Invalid personal model configuration/);
  assert.throws(() => bind({ ...profile(), contextWindow: 200000 }), /Invalid personal model configuration/);
  assert.throws(() => bind({ ...relayProfile(), baseURL: "https://api.clawhunt.site/v1" }), /Invalid personal model configuration/);
  assert.deepEqual(bind(profile()).models, [{ ...profile(), provider: "openai" }], "a Gate key binds as it did");
});

test("the hosted site's origin is read as every reader of AWWO_CLOUD_ORIGIN reads it", () => {
  const vectors = JSON.parse(readFileSync(new URL("./cloud-origin-vectors.json", import.meta.url), "utf8")) as { cases: Array<{ origin: string; valid: boolean }> };
  assert.ok(vectors.cases.length >= 20);
  for (const item of vectors.cases) {
    assert.equal(validCloudOrigin(item.origin), item.valid, JSON.stringify(item.origin));
    assert.equal(cloudRelayURL({ AWWO_CLOUD_ORIGIN: item.origin }), item.valid ? `${item.origin}/api/v1/relay/v1` : "", JSON.stringify(item.origin));
  }
  assert.equal(cloudRelayURL({}), "");
});
