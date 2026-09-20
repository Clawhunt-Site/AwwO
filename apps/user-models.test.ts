import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { bindUserModel } from "./user-models.ts";
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
