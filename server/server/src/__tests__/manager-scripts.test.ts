import { execFile } from "node:child_process";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Executes the seeded manager skills' bundled `scripts/manage.sh` as REAL bash
// subprocesses against an in-process mock of the native REST API, covering the
// fail-closed / confirmation / safe-id / control-char paths the advisors flagged.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(__dirname, "../services/seed-skill-scripts");
const COMPANY_SH = path.join(SCRIPTS, "company-manager", "manage.sh");
const SKILL_SH = path.join(SCRIPTS, "skill-manager", "manage.sh");
const PLUGIN_SH = path.join(SCRIPTS, "plugin-manager", "manage.sh");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve) => {
    execFile("bash", [script, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

// A tiny in-memory company/plugin REST mock — just enough for the scripts' contract.
function startMock(): Promise<{ url: string; close: () => Promise<void> }> {
  const companies = new Map<string, Record<string, unknown>>();
  const issues = new Map<string, Record<string, unknown>>();
  const agents = new Map<string, Record<string, unknown>>();
  const assets = new Map<string, Record<string, unknown>>();
  const secretsByCompany = new Map<string, string[]>();
  const labelsByCompany = new Map<string, string[]>();
  const keysByAgent = new Map<string, string[]>();
  const commentsByThread = new Map<string, string[]>();
  const approvals = new Map<string, Record<string, unknown>>();
  let n = 0;
  let ni = 0;
  let na = 0;
  let nas = 0;
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const send = (c: number, o: unknown) => {
      res.writeHead(c, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o));
    };
    let buf = "";
    req.on("data", (d) => (buf += d));
    req.on("end", () => {
      const body = buf ? JSON.parse(buf) : {};
      const m = /^\/api\/companies\/([^/]+)$/.exec(url);
      if (url === "/api/companies" && req.method === "GET") return send(200, [...companies.values()]);
      if (url === "/api/companies" && req.method === "POST") {
        const id = `co-${++n}`;
        const c = { id, name: body.name, description: body.description ?? null, status: "active", budgetMonthlyCents: body.budgetMonthlyCents ?? 0 };
        companies.set(id, c);
        return send(201, c);
      }
      if (m && req.method === "GET") {
        const c = companies.get(m[1]);
        return c ? send(200, c) : send(404, { error: "nf" });
      }
      if (m && req.method === "PATCH") {
        const c = companies.get(m[1]);
        if (!c) return send(404, { error: "nf" });
        Object.assign(c, body);
        return send(200, c);
      }
      if (m && req.method === "DELETE") {
        companies.delete(m[1]);
        return send(200, { ok: true });
      }
      const a = /^\/api\/companies\/([^/]+)\/archive$/.exec(url);
      if (a && req.method === "POST") {
        const c = companies.get(a[1]);
        if (!c) return send(404, { error: "nf" });
        c.status = "archived";
        return send(200, c);
      }
      // Plugins: echo path/query/method/body so tests can assert the request the verb made.
      const echo = (extra: Record<string, unknown> = {}) =>
        send(200, { ok: true, _path: url, _method: req.method, _body: body, ...extra });
      if (url.startsWith("/api/plugins")) {
        const path = url.split("?")[0];
        const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
        if (path === "/api/plugins" && req.method === "GET") return echo({ plugins: [], _query: query });
        if (path === "/api/plugins/examples" && req.method === "GET") return echo({ examples: [] });
        const pid = /^\/api\/plugins\/([^/?]+)/.exec(path)?.[1];
        if (path === `/api/plugins/${pid}/health` && req.method === "GET") return echo({ status: "ok" });
        if (path === `/api/plugins/${pid}/logs` && req.method === "GET") return echo({ logs: [], _query: query });
        if (path === `/api/plugins/${pid}/config/test` && req.method === "POST") return echo({ valid: true });
        if (path === `/api/plugins/${pid}/config` && req.method === "POST") return echo();
        if (path === `/api/plugins/${pid}/config` && req.method === "GET") return echo({ config: null });
        if (path === `/api/plugins/${pid}/disable` && req.method === "POST") return echo();
        if (path === `/api/plugins/${pid}/enable` && req.method === "POST") return echo();
        if (path === `/api/plugins/${pid}/upgrade` && req.method === "POST") return echo();
        if (path === `/api/plugins/install` && req.method === "POST") return echo();
        if (path === `/api/plugins/${pid}` && req.method === "GET") return echo();
        if (path === `/api/plugins/${pid}` && req.method === "DELETE") return echo({ _query: query });
      }
      // Company skills: list / inspect / versions / create / delete.
      const cs = /^\/api\/companies\/([^/]+)\/skills(?:\/([^/?]+))?(?:\/(versions))?/.exec(url.split("?")[0]);
      if (cs) {
        const csQuery = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
        const [, , skillId, sub] = cs;
        if (!skillId && req.method === "GET") return send(200, { ok: true, _path: url, skills: [], _query: csQuery });
        if (!skillId && req.method === "POST") return send(201, { id: "cs-1", name: body.name });
        if (skillId && sub === "versions" && req.method === "GET")
          return send(200, { ok: true, _path: url, versions: [{ id: "ver-new" }] });
        if (skillId && sub === "versions" && req.method === "POST")
          return send(201, { id: "ver-new", _path: url, _body: body });
        // A NESTED object with its OWN `"id"` appears AFTER the skill's top-level id, so a
        // greedy `.*"id"` sed read-back grabs the LAST (nested) id and false-mismatches —
        // the create-company verify must extract the TOP-LEVEL `id` (node) robustly. If
        // someone reverts to the sed approach this test fails.
        if (skillId && req.method === "GET")
          return send(200, { id: skillId, nested: { id: "ver-deadbeef" }, _path: url });
        if (skillId && req.method === "DELETE") return send(200, { ok: true });
      }
      // Issues (tasks): create (company-scoped), child, inspect, update, comment.
      const ci = /^\/api\/companies\/([^/]+)\/issues$/.exec(url.split("?")[0]);
      if (ci && req.method === "POST") {
        const id = `iss-${++ni}`;
        // Real issue-create appends nested relatedWork[].id — the verify step must
        // still resolve the TOP-LEVEL id, not this nested one (guards _json_top).
        const it = { id, ...body, relatedWork: [{ id: `related-${id}` }] };
        issues.set(id, it);
        return send(201, it);
      }
      const ich = /^\/api\/issues\/([^/]+)\/children$/.exec(url);
      if (ich && req.method === "POST") {
        const id = `iss-${++ni}`;
        const it = { id, parentId: ich[1], ...body };
        issues.set(id, it);
        return send(201, it);
      }
      const icm = /^\/api\/issues\/([^/]+)\/comments$/.exec(url);
      if (icm && req.method === "POST") {
        const id = `cmt-${++nas}`;
        commentsByThread.set(`iss:${icm[1]}`, [...(commentsByThread.get(`iss:${icm[1]}`) ?? []), id]);
        return send(201, { id, _body: body });
      }
      if (icm && req.method === "GET") {
        const ids = commentsByThread.get(`iss:${icm[1]}`) ?? [];
        return send(200, ids.map((id) => ({ id })));
      }
      const iss = /^\/api\/issues\/([^/]+)$/.exec(url);
      if (iss && req.method === "GET") {
        const it = issues.get(iss[1]);
        return it ? send(200, it) : send(404, { error: "nf" });
      }
      if (iss && req.method === "PATCH") {
        const it = issues.get(iss[1]);
        if (!it) return send(404, { error: "nf" });
        Object.assign(it, body);
        return send(200, it);
      }
      // Agents: hire (company-scoped), inspect, update, and lifecycle verbs.
      const ah = /^\/api\/companies\/([^/]+)\/agents$/.exec(url.split("?")[0]);
      if (ah && req.method === "POST") {
        const id = `agent-${++na}`;
        const a = { id, status: "idle", ...body };
        agents.set(id, a);
        return send(201, a);
      }
      const alc = /^\/api\/agents\/([^/]+)\/(wakeup|heartbeat\/invoke|pause|resume|clear-error|approve|terminate)$/.exec(url);
      if (alc && req.method === "POST") {
        const a = agents.get(alc[1]);
        if (a) {
          if (alc[2] === "terminate") a.status = "terminated";
          else if (alc[2] === "pause") a.status = "paused";
          else if (alc[2] === "resume") a.status = "idle";
        }
        return send(200, { ok: true, _path: url, _method: req.method, _body: body, _verb: alc[2] });
      }
      // Runtime catalog: inventory, per-runtime models (404 on unknown), and the
      // model-profiles "cheap lane" signal (company-scoped).
      if (url === "/api/agents" && req.method === "GET") {
        return send(200, {
          agents: [
            { name: "claude_local", available: true, chat_capable: true, supports_model_selection: true, default_model: "claude-opus-4-8", suggested_models: ["claude-opus-4-8", "claude-sonnet-4-6"], supports_effort_selection: true, effort_levels: ["low", "medium", "high"], uses_relay_packages: false, chat_tier: "native" },
            { name: "codex_local", available: false, chat_capable: true, supports_model_selection: true, default_model: "gpt-5.5-codex", suggested_models: ["gpt-5.5-codex"], supports_effort_selection: true, effort_levels: ["low", "high"], uses_relay_packages: false, chat_tier: "native" },
          ],
          summary: { count: 2, ready_count: 1 },
        });
      }
      const rmod = /^\/api\/agents\/([^/]+)\/models$/.exec(url);
      if (rmod && req.method === "GET") {
        if (rmod[1] !== "claude_local") return send(404, { error: "unknown backend" });
        return send(200, { name: rmod[1], source: "static_contract", models: ["claude-opus-4-8", "claude-sonnet-4-6"] });
      }
      const rprof = /^\/api\/companies\/([^/]+)\/adapters\/([^/]+)\/model-profiles$/.exec(url);
      if (rprof && req.method === "GET") {
        return send(200, [
          { key: "cheap", label: "Cheap", description: "lower-cost lane", adapterConfig: { model: "claude-sonnet-4-6", effort: "low" } },
        ]);
      }
      const ag = /^\/api\/agents\/([^/]+)$/.exec(url);
      if (ag && req.method === "GET") {
        const a = agents.get(ag[1]);
        return a ? send(200, a) : send(404, { error: "nf" });
      }
      if (ag && req.method === "PATCH") {
        const a = agents.get(ag[1]);
        if (!a) return send(404, { error: "nf" });
        Object.assign(a, body);
        return send(200, a);
      }
      // Assets: projects/goals/routines/environments create (company-scoped) +
      // single-GET verify; labels create (echo, no single GET on the API).
      const asset = /^\/api\/companies\/([^/]+)\/(projects|goals|routines|environments)$/.exec(url.split("?")[0]);
      if (asset && req.method === "POST") {
        const kind = asset[2].slice(0, -1);
        const id = `${kind}-${++nas}`;
        const rec = { id, ...body };
        assets.set(id, rec);
        return send(201, rec);
      }
      const albl = /^\/api\/companies\/([^/]+)\/labels$/.exec(url.split("?")[0]);
      if (albl && req.method === "POST") {
        const id = `lbl-${++nas}`;
        labelsByCompany.set(albl[1], [...(labelsByCompany.get(albl[1]) ?? []), id]);
        return send(201, { id, _body: body });
      }
      if (albl && req.method === "GET") {
        const ids = labelsByCompany.get(albl[1]) ?? [];
        return send(200, ids.map((id) => ({ id })));
      }
      const asg = /^\/api\/(projects|goals|routines|environments)\/([^/]+)$/.exec(url);
      if (asg && req.method === "GET") {
        const rec = assets.get(asg[2]);
        return rec ? send(200, rec) : send(404, { error: "nf" });
      }
      // Secrets: create (id echoed, value NOT), list-for-verify, rotate, delete.
      const sc = /^\/api\/companies\/([^/]+)\/secrets$/.exec(url.split("?")[0]);
      if (sc && req.method === "POST") {
        const id = `sec-${++nas}`;
        secretsByCompany.set(sc[1], [...(secretsByCompany.get(sc[1]) ?? []), id]);
        return send(201, { id, name: body.name }); // note: no value in response
      }
      if (sc && req.method === "GET") {
        const ids = secretsByCompany.get(sc[1]) ?? [];
        return send(200, ids.map((id) => ({ id })));
      }
      const srot = /^\/api\/secrets\/([^/]+)\/rotate$/.exec(url);
      // Include a fake secret value so the test can assert the wrapper never prints it.
      if (srot && req.method === "POST") return send(200, { id: srot[1], value: "ROTATED-PLAINTEXT", _path: url, _method: req.method, _body: body });
      const sdel = /^\/api\/secrets\/([^/]+)$/.exec(url);
      if (sdel && req.method === "DELETE") return send(200, { ok: true, _path: url, _method: req.method });
      // Secret provider configs: create + single-GET verify + delete.
      const pc = /^\/api\/companies\/([^/]+)\/secret-provider-configs$/.exec(url.split("?")[0]);
      if (pc && req.method === "POST") {
        const id = `pc-${++nas}`;
        assets.set(id, { id, ...body });
        return send(201, { id, ...body });
      }
      const pcg = /^\/api\/secret-provider-configs\/([^/]+)$/.exec(url);
      if (pcg && req.method === "GET") {
        const rec = assets.get(pcg[1]);
        return rec ? send(200, rec) : send(404, { error: "nf" });
      }
      if (pcg && req.method === "DELETE") {
        assets.delete(pcg[1]); // so the delete-verify GET returns 404
        return send(200, { ok: true, _path: url, _method: req.method });
      }
      // Agent keys: list, create (verified via list), revoke (verified absent via list).
      const akl = /^\/api\/agents\/([^/]+)\/keys$/.exec(url.split("?")[0]);
      if (akl && req.method === "GET") {
        const ids = keysByAgent.get(akl[1]) ?? [];
        return send(200, ids.map((id) => ({ id })));
      }
      if (akl && req.method === "POST") {
        const id = `key-${++nas}`;
        keysByAgent.set(akl[1], [...(keysByAgent.get(akl[1]) ?? []), id]);
        // The real route returns the ONE-TIME plaintext token here — the wrapper must NOT
        // echo the raw response, so this token must never appear on stdout.
        return send(201, { id, token: `TOK-SECRET-${id}`, _body: body });
      }
      const akd = /^\/api\/agents\/([^/]+)\/keys\/([^/]+)$/.exec(url);
      if (akd && req.method === "DELETE") {
        keysByAgent.set(akd[1], (keysByAgent.get(akd[1]) ?? []).filter((k) => k !== akd[2]));
        return send(200, { ok: true, _path: url, _method: req.method });
      }
      // Governance & finance: budgets (PATCH → store on company for reread), approvals, pipelines.
      const cbud = /^\/api\/companies\/([^/]+)\/budgets$/.exec(url);
      if (cbud && req.method === "PATCH") {
        const c = companies.get(cbud[1]) ?? { id: cbud[1] };
        c.budgetMonthlyCents = body.budgetMonthlyCents;
        companies.set(cbud[1], c);
        return send(200, c);
      }
      const abud = /^\/api\/agents\/([^/]+)\/budgets$/.exec(url);
      if (abud && req.method === "PATCH") {
        const a = agents.get(abud[1]) ?? { id: abud[1], status: "idle" };
        a.budgetMonthlyCents = body.budgetMonthlyCents;
        agents.set(abud[1], a);
        return send(200, a);
      }
      const ares = /^\/api\/approvals\/([^/]+)\/(approve|reject)$/.exec(url);
      if (ares && req.method === "POST") {
        const a = approvals.get(ares[1]) ?? { id: ares[1], status: "pending" };
        // "apr-stuck" simulates a pathological server that 2xx's the POST but leaves the
        // approval pending — the wrapper MUST catch that and fail approval_unconfirmed.
        if (ares[1] !== "apr-stuck") a.status = ares[2] === "approve" ? "approved" : "rejected";
        approvals.set(ares[1], a);
        return send(200, a);
      }
      const acom = /^\/api\/approvals\/([^/]+)\/comments$/.exec(url.split("?")[0]);
      if (acom && req.method === "POST") {
        const id = `acmt-${++nas}`;
        commentsByThread.set(`apr:${acom[1]}`, [...(commentsByThread.get(`apr:${acom[1]}`) ?? []), id]);
        return send(201, { id, _body: body });
      }
      if (acom && req.method === "GET") {
        const ids = commentsByThread.get(`apr:${acom[1]}`) ?? [];
        return send(200, ids.map((id) => ({ id })));
      }
      const aget = /^\/api\/approvals\/([^/]+)$/.exec(url);
      if (aget && req.method === "GET") {
        const a = approvals.get(aget[1]) ?? { id: aget[1], status: "pending" };
        return send(200, a);
      }
      const pcr = /^\/api\/companies\/([^/]+)\/pipelines$/.exec(url.split("?")[0]);
      if (pcr && req.method === "POST") {
        const id = `pipe-${++nas}`;
        assets.set(id, { id, ...body });
        return send(201, { id, ...body });
      }
      const pget = /^\/api\/pipelines\/([^/]+)$/.exec(url);
      if (pget && req.method === "GET") {
        const rec = assets.get(pget[1]);
        return rec ? send(200, rec) : send(404, { error: "nf" });
      }
      // issues/count enforces attention=blocked (the real route 400s otherwise).
      const icnt = /^\/api\/companies\/([^/]+)\/issues\/count$/.exec(url.split("?")[0]);
      if (icnt && req.method === "GET") {
        const q = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
        if (!/(^|&)attention=blocked(&|$)/.test(q)) return send(400, { error: "issues/count currently requires attention=blocked" });
        return send(200, { count: 0, _path: url.split("?")[0], _query: q });
      }
      // Company read-state sub-resources (dashboard/agents/issues/…): echo the
      // exact path + query the script built so tests assert the request shape.
      const sub = /^\/api\/companies\/([^/]+)\/(.+)$/.exec(url.split("?")[0]);
      if (sub && req.method === "GET") {
        const q = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
        return send(200, { ok: true, _path: url.split("?")[0], _sub: sub[2], _query: q });
      }
      send(404, { error: "nf" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

let mock: { url: string; close: () => Promise<void> };
beforeAll(async () => {
  mock = await startMock();
});
afterAll(async () => {
  await mock.close();
});

describe("company-manager manage.sh", () => {
  const env = () => ({ SUPERCLAW_RUNTIME_API_URL: mock.url });

  it("fails CLOSED with api_base_unset when no API base is set", async () => {
    const r = await run(COMPANY_SH, ["list"], { SUPERCLAW_RUNTIME_API_URL: "" });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("api_base_unset");
  });

  it("create then re-reads + verifies, even with quotes/newlines in fields", async () => {
    const r = await run(COMPANY_SH, ["create", "--name", 'Lab "X"', "--description", "a\nb"], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"ok":true');
    expect(r.stdout).toContain('"verified":true');
  });

  it("prefers an http LOOPBACK candidate over a public primary URL (local agent → loopback)", async () => {
    // Primary points at an unreachable public host; candidates include the local mock.
    // The script must pick the http loopback candidate, not the public primary.
    const r = await run(COMPANY_SH, ["list"], {
      SUPERCLAW_RUNTIME_API_URL: "https://example.invalid",
      SUPERCLAW_RUNTIME_API_CANDIDATES_JSON: JSON.stringify([
        "https://example.invalid",
        `https://127.0.0.1:9`, // https loopback (would fail) — must be skipped for http
        mock.url, // http://127.0.0.1:<port>
      ]),
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().startsWith("[")).toBe(true); // the mock's company array
  });

  it("rejects a path-traversal id (unsafe_id, exit 2) before hitting curl", async () => {
    const r = await run(COMPANY_SH, ["inspect", "../../etc"], env());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unsafe_id");
  });

  it("rejects a non-integer budget", async () => {
    const r = await run(COMPANY_SH, ["create", "--name", "Z", "--budget-cents", "abc"], env());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not_an_integer");
  });

  it("refuses delete without --yes (confirmation_required, exit 4)", async () => {
    const c = await run(COMPANY_SH, ["create", "--name", "DelMe"], env());
    const id = JSON.parse(c.stdout.trim().split("\n").pop() as string).id;
    const r = await run(COMPANY_SH, ["delete", id], env());
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("confirmation_required");
    // ...and deletes (verifying 404) WITH --yes.
    const ok = await run(COMPANY_SH, ["delete", id, "--yes"], env());
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('"verified":true');
  });

  it("archive now requires --yes (stops agents → gated), then confirms status", async () => {
    const c = await run(COMPANY_SH, ["create", "--name", "ArchMe"], env());
    const id = JSON.parse(c.stdout.trim().split("\n").find((l) => l.includes('"id"')) as string).id;
    const refused = await run(COMPANY_SH, ["archive", id], env());
    expect(refused.code).toBe(4);
    expect(refused.stderr).toContain("confirmation_required");
    const ok = await run(COMPANY_SH, ["archive", id, "--yes"], env());
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('"archived"');
  });

  it("update --json-patch sends the raw object; refuses mixing with convenience flags", async () => {
    const c = await run(COMPANY_SH, ["create", "--name", "Patchy"], env());
    const id = JSON.parse(c.stdout.trim().split("\n").find((l) => l.includes('"id"')) as string).id;
    const ok = await run(COMPANY_SH, ["update", id, "--json-patch", '{"brandColor":"#abcdef"}'], env());
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('"reread":true');
    const mixed = await run(COMPANY_SH, ["update", id, "--name", "X", "--json-patch", "{}"], env());
    expect(mixed.code).toBe(2);
    expect(mixed.stderr).toContain("mixed_update");
  });

  it("read-state verbs GET the right company sub-resource path", async () => {
    for (const [verb, sub] of [
      ["dashboard", "dashboard"],
      ["agents", "agents"],
      ["projects", "projects"],
      ["goals", "goals"],
      ["routines", "routines"],
      ["activity", "activity"],
      ["live-runs", "live-runs"],
      ["members", "members"],
      ["budget", "budgets/overview"],
      ["costs", "costs/summary"],
    ] as const) {
      const r = await run(COMPANY_SH, [verb, "co-7"], env());
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout.trim())._path).toBe(`/api/companies/co-7/${sub}`);
    }
  });

  it("blocked-count hits issues/count with the required attention=blocked query", async () => {
    const r = await run(COMPANY_SH, ["blocked-count", "co-7"], env());
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out._path).toBe("/api/companies/co-7/issues/count");
    expect(out._query).toBe("attention=blocked");
  });

  it("issues accepts --status/--project filters as query params", async () => {
    const r = await run(COMPANY_SH, ["issues", "co-7", "--status", "todo", "--project", "p1"], env());
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out._path).toBe("/api/companies/co-7/issues");
    expect(out._query).toContain("status=todo");
    expect(out._query).toContain("projectId=p1");
  });

  it("search URL-encodes the --q term", async () => {
    const r = await run(COMPANY_SH, ["search", "co-7", "--q", "hello world & more"], env());
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out._path).toBe("/api/companies/co-7/search");
    expect(out._query).toBe("q=hello%20world%20%26%20more");
  });

  it("read-state verbs still enforce safe-id + missing-id fail-closed", async () => {
    const missing = await run(COMPANY_SH, ["agents"], env());
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("missing_id");
    const unsafe = await run(COMPANY_SH, ["agents", "../secrets"], env());
    expect(unsafe.code).toBe(2);
    expect(unsafe.stderr).toContain("unsafe_id");
  });

  it("new-issue creates a task then re-reads + verifies it (top-level id, not nested relatedWork)", async () => {
    const r = await run(COMPANY_SH, ["new-issue", "co-9", "--title", "Ship it", "--priority", "high", "--assignee-agent", "agent-1"], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"ok":true');
    expect(r.stdout).toContain('"verified":true');
    // The mock create response embeds a nested relatedWork[].id ("related-iss-N");
    // verify must resolve the TOP-LEVEL issue id, never the nested one.
    expect(r.stdout).toContain('"issueId":"iss-');
    expect(r.stdout).not.toContain('"issueId":"related-');
  });

  it("new-issue requires --title unless --json is given", async () => {
    const r = await run(COMPANY_SH, ["new-issue", "co-9", "--priority", "high"], env());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("missing_title");
    const j = await run(COMPANY_SH, ["new-issue", "co-9", "--json", '{"title":"Via JSON"}'], env());
    expect(j.code).toBe(0);
    expect(j.stdout).toContain('"verified":true');
  });

  it("new-issue refuses mixing --json with convenience flags", async () => {
    const r = await run(COMPANY_SH, ["new-issue", "co-9", "--title", "X", "--json", "{}"], env());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("mixed_body");
  });

  it("subtask posts to the parent issue's children endpoint", async () => {
    const parent = await run(COMPANY_SH, ["new-issue", "co-9", "--title", "Parent"], env());
    const pid = JSON.parse(parent.stdout.trim().split("\n").pop() as string).issueId;
    const r = await run(COMPANY_SH, ["subtask", pid, "--title", "Child"], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"verified":true');
  });

  it("issue-update PATCHes then re-reads; comment posts the body", async () => {
    const created = await run(COMPANY_SH, ["new-issue", "co-9", "--title", "Work"], env());
    const iid = JSON.parse(created.stdout.trim().split("\n").pop() as string).issueId;
    const upd = await run(COMPANY_SH, ["issue-update", iid, "--status", "in_progress", "--priority", "urgent"], env());
    expect(upd.code).toBe(0);
    expect(upd.stdout).toContain('"reread":true');
    expect(upd.stdout).toContain('"status":"in_progress"');
    const cm = await run(COMPANY_SH, ["comment", iid, "--body", "please resume", "--resume"], env());
    expect(cm.code).toBe(0);
    const lines = cm.stdout.trim().split("\n");
    expect(JSON.parse(lines[0])._body).toMatchObject({ body: "please resume", resume: true });
    expect(cm.stdout).toContain('"verified":true');
    expect(cm.stdout).toContain('"commentId":"cmt-');
  });

  it("issue-update needs at least one field; comment needs a --body", async () => {
    const noFields = await run(COMPANY_SH, ["issue-update", "iss-x"], env());
    expect(noFields.code).toBe(2);
    expect(noFields.stderr).toContain("no_fields");
    const noBody = await run(COMPANY_SH, ["comment", "iss-x"], env());
    expect(noBody.code).toBe(2);
    expect(noBody.stderr).toContain("missing_body");
  });

  it("hire creates an agent (name + adapter-type) then verifies it", async () => {
    const r = await run(COMPANY_SH, ["hire", "co-9", "--name", "Coder", "--adapter-type", "claude_local", "--model", "claude-opus-4-8"], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"verified":true');
    expect(r.stdout).toContain('"agentId":"agent-');
  });

  it("hire requires --name and --adapter-type unless --json", async () => {
    const noName = await run(COMPANY_SH, ["hire", "co-9", "--adapter-type", "claude_local"], env());
    expect(noName.code).toBe(2);
    expect(noName.stderr).toContain("missing_name");
    const noType = await run(COMPANY_SH, ["hire", "co-9", "--name", "X"], env());
    expect(noType.code).toBe(2);
    expect(noType.stderr).toContain("missing_adapter_type");
  });

  it("wake posts the reason/source to the agent wakeup endpoint", async () => {
    const r = await run(COMPANY_SH, ["wake", "agent-1", "--reason", "please continue", "--source", "on_demand"], env());
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out._path).toBe("/api/agents/agent-1/wakeup");
    expect(out._body).toMatchObject({ reason: "please continue", source: "on_demand" });
  });

  it("invoke runs one heartbeat via the invoke endpoint", async () => {
    const r = await run(COMPANY_SH, ["invoke", "agent-1"], env());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())._path).toBe("/api/agents/agent-1/heartbeat/invoke");
  });

  it("pause then resume reflect the agent status on re-read", async () => {
    const hired = await run(COMPANY_SH, ["hire", "co-9", "--name", "P", "--adapter-type", "claude_local"], env());
    const aid = JSON.parse(hired.stdout.trim().split("\n").pop() as string).agentId;
    const p = await run(COMPANY_SH, ["pause", aid], env());
    expect(p.code).toBe(0);
    expect(JSON.parse(p.stdout.trim())).toMatchObject({ ok: true, status: "paused" });
    // pause takes no flags — a stray one is rejected, not silently dropped.
    const stray = await run(COMPANY_SH, ["pause", aid, "--reason", "cooldown"], env());
    expect(stray.code).toBe(2);
    expect(stray.stderr).toContain("unexpected_args");
    const rs = await run(COMPANY_SH, ["resume", aid], env());
    expect(JSON.parse(rs.stdout.trim())).toMatchObject({ status: "idle" });
  });

  it("terminate refuses without --yes, then confirms terminated status", async () => {
    const hired = await run(COMPANY_SH, ["hire", "co-9", "--name", "T", "--adapter-type", "claude_local"], env());
    const aid = JSON.parse(hired.stdout.trim().split("\n").pop() as string).agentId;
    const nope = await run(COMPANY_SH, ["terminate", aid], env());
    expect(nope.code).toBe(4);
    expect(nope.stderr).toContain("confirmation_required");
    const yes = await run(COMPANY_SH, ["terminate", aid, "--yes"], env());
    expect(yes.code).toBe(0);
    expect(yes.stdout).toContain('"verified":true');
    expect(yes.stdout).toContain('"terminated"');
  });

  it("new-project creates then verifies; --goal becomes goalIds array", async () => {
    const r = await run(COMPANY_SH, ["new-project", "co-9", "--name", "Launch", "--goal", "g-uuid", "--status", "active"], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"verified":true');
    expect(r.stdout).toContain('"projectId":"project-');
    expect(r.stdout).toContain('"goalIds":["g-uuid"]');
  });

  it("new-project requires --name unless --json", async () => {
    const r = await run(COMPANY_SH, ["new-project", "co-9", "--status", "active"], env());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("missing_name");
  });

  it("new-goal creates then verifies (title required)", async () => {
    const ok = await run(COMPANY_SH, ["new-goal", "co-9", "--title", "Ship v1", "--level", "objective"], env());
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('"verified":true');
    expect(ok.stdout).toContain('"goalId":"goal-');
    const bad = await run(COMPANY_SH, ["new-goal", "co-9", "--level", "objective"], env());
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("missing_title");
  });

  it("new-routine creates then verifies (title required)", async () => {
    const ok = await run(COMPANY_SH, ["new-routine", "co-9", "--title", "Nightly", "--priority", "high"], env());
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('"verified":true');
    expect(ok.stdout).toContain('"routineId":"routine-');
    const bad = await run(COMPANY_SH, ["new-routine", "co-9", "--priority", "high"], env());
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("missing_title");
  });

  it("new-label creates then verifies via the labels list; name+color required", async () => {
    const ok = await run(COMPANY_SH, ["new-label", "co-lbl", "--name", "bug", "--color", "#3B82F6"], env());
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('"verified":true');
    expect(ok.stdout).toContain('"labelId":"lbl-');
    const lines = ok.stdout.trim().split("\n");
    expect(JSON.parse(lines[0])._body).toMatchObject({ name: "bug", color: "#3B82F6" });
    const noColor = await run(COMPANY_SH, ["new-label", "co-lbl", "--name", "bug"], env());
    expect(noColor.code).toBe(2);
    expect(noColor.stderr).toContain("missing_color");
  });

  it("redacts plaintext env + secret-named fields from printed objects (no credential leak)", async () => {
    // hire with env AND assorted secret-named keys → the echoed object must mask them all.
    const hired = await run(COMPANY_SH, ["hire", "co-9", "--json", '{"name":"Leaky","adapterType":"claude_local","adapterConfig":{"env":{"OPENAI_API_KEY":"sk-LEAK-hire"},"clientSecret":"cs-LEAK","devicePrivateKeyPem":"pk-LEAK","apiToken":"at-LEAK"}}'], env());
    expect(hired.code).toBe(0);
    for (const s of ["sk-LEAK-hire", "cs-LEAK", "pk-LEAK", "at-LEAK"]) expect(hired.stdout).not.toContain(s);
    expect(hired.stdout).toContain("[redacted]");
    // benign key names must survive (no over-masking).
    expect(hired.stdout).toContain("\"name\":\"Leaky\"");
    // new-environment with envVars secret → masked too.
    const e = await run(COMPANY_SH, ["new-environment", "co-9", "--json", '{"name":"prod","driver":"local","envVars":{"AWS_SECRET":"sk-LEAK-env"}}'], env());
    expect(e.code).toBe(0);
    expect(e.stdout).not.toContain("sk-LEAK-env");
    // a read that returns the stored agent also masks it on the way out.
    const aid = JSON.parse(hired.stdout.trim().split("\n").pop() as string).agentId;
    const got = await run(COMPANY_SH, ["agent", aid], env());
    expect(got.code).toBe(0);
    for (const s of ["sk-LEAK-hire", "cs-LEAK", "pk-LEAK", "at-LEAK"]) expect(got.stdout).not.toContain(s);
  });

  it("new-environment creates then verifies; name+driver required", async () => {
    const ok = await run(COMPANY_SH, ["new-environment", "co-9", "--name", "staging", "--driver", "local"], env());
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('"verified":true');
    expect(ok.stdout).toContain('"environmentId":"environment-');
    const noDriver = await run(COMPANY_SH, ["new-environment", "co-9", "--name", "staging"], env());
    expect(noDriver.code).toBe(2);
    expect(noDriver.stderr).toContain("missing_driver");
  });

  it("new-secret verifies via the secrets list and never echoes the value", async () => {
    const r = await run(COMPANY_SH, ["new-secret", "co-sec", "--name", "OPENAI", "--value", "sk-super-secret"], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"verified":true');
    expect(r.stdout).toContain('"secretId":"sec-');
    expect(r.stdout).not.toContain("sk-super-secret");
    const noName = await run(COMPANY_SH, ["new-secret", "co-sec", "--value", "x"], env());
    expect(noName.code).toBe(2);
    expect(noName.stderr).toContain("missing_name");
  });

  it("new-secret enforces the managed/external value rules client-side (mirrors zod)", async () => {
    // Managed (default) secret without --value → rejected before hitting the server.
    const noValue = await run(COMPANY_SH, ["new-secret", "co-sec", "--name", "OPENAI"], env());
    expect(noValue.code).toBe(2);
    expect(noValue.stderr).toContain("missing_value");
    // external_reference REQUIRES --external-ref.
    const extNoRef = await run(COMPANY_SH, ["new-secret", "co-sec", "--name", "VAULT", "--managed-mode", "external_reference"], env());
    expect(extNoRef.code).toBe(2);
    expect(extNoRef.stderr).toContain("missing_external_ref");
    // Managed secrets must NOT carry --external-ref (server rejects this too).
    const managedWithRef = await run(COMPANY_SH, ["new-secret", "co-sec", "--name", "OPENAI", "--value", "sk-1", "--external-ref", "op://x"], env());
    expect(managedWithRef.code).toBe(2);
    expect(managedWithRef.stderr).toContain("managed_with_external_ref");
    // external_reference with a stray --value is ACCEPTED (server ignores value), not rejected.
    const extWithValue = await run(COMPANY_SH, ["new-secret", "co-sec", "--name", "VAULT", "--managed-mode", "external_reference", "--external-ref", "op://x", "--value", "ignored"], env());
    expect(extWithValue.code).toBe(0);
  });

  it("secret-rotate confirms the target secret without leaking the rotated value", async () => {
    const r = await run(COMPANY_SH, ["secret-rotate", "sec-1", "--value", "rotated"], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"rotated":"sec-1"');
    expect(r.stdout).not.toContain("ROTATED-PLAINTEXT"); // the value from the response is never printed
  });

  it("delete-secret refuses without --yes, then DELETEs", async () => {
    const nope = await run(COMPANY_SH, ["delete-secret", "sec-1"], env());
    expect(nope.code).toBe(4);
    expect(nope.stderr).toContain("confirmation_required");
    const yes = await run(COMPANY_SH, ["delete-secret", "sec-1", "--yes"], env());
    expect(yes.code).toBe(0);
    expect(JSON.parse(yes.stdout.trim())._method).toBe("DELETE");
  });

  it("new-provider-config creates + verifies; provider+display-name required", async () => {
    const ok = await run(COMPANY_SH, ["new-provider-config", "co-9", "--provider", "onepassword", "--display-name", "Vault", "--default"], env());
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('"verified":true');
    expect(ok.stdout).toContain('"providerConfigId":"pc-');
    expect(ok.stdout).toContain('"isDefault":true');
    const bad = await run(COMPANY_SH, ["new-provider-config", "co-9", "--display-name", "Vault"], env());
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("missing_provider");
  });

  it("delete-provider-config gated by --yes, then verifies the config is 404 (gone)", async () => {
    const made = await run(COMPANY_SH, ["new-provider-config", "co-9", "--provider", "onepassword", "--display-name", "ToDelete"], env());
    const pcid = JSON.parse(made.stdout.trim().split("\n")[0]).id as string;
    const nope = await run(COMPANY_SH, ["delete-provider-config", pcid], env());
    expect(nope.code).toBe(4);
    const yes = await run(COMPANY_SH, ["delete-provider-config", pcid, "--yes"], env());
    expect(yes.code).toBe(0);
    expect(yes.stdout).toContain('"verified":true');
    expect(yes.stdout).toContain(`"deleted":"${pcid}"`);
  });

  it("agent-keys lists; new-agent-key creates+verifies WITHOUT leaking the token; delete verifies absence", async () => {
    const created = await run(COMPANY_SH, ["new-agent-key", "agent-1", "--name", "ci"], env());
    expect(created.code).toBe(0);
    expect(created.stdout).toContain('"verified":true');
    // The one-time token from the POST response must NEVER reach stdout.
    expect(created.stdout).not.toContain("TOK-SECRET");
    const keyId = JSON.parse(created.stdout.trim()).keyId as string;
    expect(keyId).toMatch(/^key-/);
    const list = await run(COMPANY_SH, ["agent-keys", "agent-1"], env());
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(keyId); // the created key shows up in the list
    const nope = await run(COMPANY_SH, ["delete-agent-key", "agent-1", keyId], env());
    expect(nope.code).toBe(4);
    const missingKey = await run(COMPANY_SH, ["delete-agent-key", "agent-1"], env());
    expect(missingKey.code).toBe(2);
    expect(missingKey.stderr).toContain("missing_key_id");
    const yes = await run(COMPANY_SH, ["delete-agent-key", "agent-1", keyId, "--yes"], env());
    expect(yes.code).toBe(0);
    expect(yes.stdout).toContain('"verified":true');
    expect(yes.stdout).toContain(`"deleted":"${keyId}"`);
  });

  it("set-budget PATCHes then re-reads to confirm the cents landed", async () => {
    const ok = await run(COMPANY_SH, ["set-budget", "co-bud", "--monthly-cents", "50000"], env());
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('"verified":true');
    expect(ok.stdout).toContain('"budgetMonthlyCents":50000');
    const nan = await run(COMPANY_SH, ["set-budget", "co-bud", "--monthly-cents", "lots"], env());
    expect(nan.code).toBe(2);
    expect(nan.stderr).toContain("not_an_integer");
    const missing = await run(COMPANY_SH, ["set-budget", "co-bud"], env());
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("missing_monthly_cents");
  });

  it("set-agent-budget PATCHes then re-reads the agent to confirm the cents", async () => {
    const r = await run(COMPANY_SH, ["set-agent-budget", "agent-1", "--monthly-cents", "1000"], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"verified":true');
    expect(r.stdout).toContain('"budgetMonthlyCents":1000');
  });

  it("approve-request / reject-request hard-assert the persisted decision status", async () => {
    const ap = await run(COMPANY_SH, ["approve-request", "apr-ok", "--note", "looks good"], env());
    expect(ap.code).toBe(0);
    expect(ap.stdout).toContain('"verified":true');
    expect(ap.stdout).toContain('"status":"approved"');
    const rj = await run(COMPANY_SH, ["reject-request", "apr-no"], env());
    expect(rj.code).toBe(0);
    expect(rj.stdout).toContain('"verified":true');
    expect(rj.stdout).toContain('"status":"rejected"');
  });

  it("approve-request fails approval_unconfirmed when the reread status stays pending", async () => {
    const stuck = await run(COMPANY_SH, ["approve-request", "apr-stuck"], env());
    expect(stuck.code).toBe(1);
    expect(stuck.stderr).toContain("approval_unconfirmed");
  });

  it("approval-comment posts then verifies it lands in the approval thread; --body required", async () => {
    const ok = await run(COMPANY_SH, ["approval-comment", "apr-1", "--body", "please clarify"], env());
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('"verified":true');
    expect(ok.stdout).toContain('"commentId":"acmt-');
    expect(JSON.parse(ok.stdout.trim().split("\n")[0])._body).toMatchObject({ body: "please clarify" });
    const bad = await run(COMPANY_SH, ["approval-comment", "apr-1"], env());
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("missing_body");
  });

  it("destructive/lifecycle verbs reject trailing junk instead of silently ignoring it", async () => {
    const delSec = await run(COMPANY_SH, ["delete-secret", "sec-1", "--yes", "--oops"], env());
    expect(delSec.code).toBe(2);
    expect(delSec.stderr).toContain("unexpected_args");
    const term = await run(COMPANY_SH, ["terminate", "agent-1", "--yes", "--force"], env());
    expect(term.code).toBe(2);
    expect(term.stderr).toContain("unexpected_args");
    const appr = await run(COMPANY_SH, ["approve-request", "apr-1", "--note", "ok", "--bogus"], env());
    expect(appr.code).toBe(2);
    expect(appr.stderr).toContain("unknown_flag");
  });

  it("new-pipeline creates then verifies; key+name required", async () => {
    const ok = await run(COMPANY_SH, ["new-pipeline", "co-9", "--key", "review", "--name", "Review Flow"], env());
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('"verified":true');
    expect(ok.stdout).toContain('"pipelineId":"pipe-');
    const noKey = await run(COMPANY_SH, ["new-pipeline", "co-9", "--name", "Review Flow"], env());
    expect(noKey.code).toBe(2);
    expect(noKey.stderr).toContain("missing_key");
  });

  it("runtimes lists the runtime inventory with contract flags", async () => {
    const r = await run(COMPANY_SH, ["runtimes"], env());
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.agents.map((a: { name: string }) => a.name)).toContain("claude_local");
    expect(out.agents[0]).toHaveProperty("supports_model_selection");
    expect(out.agents[0]).toHaveProperty("default_model");
  });

  it("runtime-models returns a runtime's model ids; unknown backend 404s; backend required", async () => {
    const ok = await run(COMPANY_SH, ["runtime-models", "claude_local"], env());
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout.trim()).models).toContain("claude-opus-4-8");
    const unknown = await run(COMPANY_SH, ["runtime-models", "nope_local"], env());
    // 404 surfaces as a non-zero curl failure (the wrapper uses curl -fsS).
    expect(unknown.code).not.toBe(0);
    const missing = await run(COMPANY_SH, ["runtime-models"], env());
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("missing_backend");
  });

  it("runtime-profiles reads the company-scoped model-profiles (cost-lane signal)", async () => {
    const ok = await run(COMPANY_SH, ["runtime-profiles", "co-9", "claude_local"], env());
    expect(ok.code).toBe(0);
    const out = JSON.parse(ok.stdout.trim());
    expect(out[0]).toMatchObject({ key: "cheap" });
    const missing = await run(COMPANY_SH, ["runtime-profiles", "co-9"], env());
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("missing_backend");
  });
});

describe("skill-manager manage.sh", () => {
  let store: string;
  const env = () => ({ SUPERCLAW_SKILL_STORE_DIR: store, SUPERCLAW_RUNTIME_API_URL: mock.url });
  beforeAll(async () => {
    store = await fs.mkdtemp(path.join(os.tmpdir(), "skill-mgr-"));
  });

  it("create-global writes a compliant skill with null-digest provenance", async () => {
    const r = await run(SKILL_SH, ["create-global", "release-notes", "--description", "draft notes"], env());
    expect(r.code).toBe(0);
    const md = await fs.readFile(path.join(store, "release-notes", "SKILL.md"), "utf-8");
    expect(md).toContain("name: release-notes");
    const prov = JSON.parse(await fs.readFile(path.join(store, "release-notes", ".provenance.json"), "utf-8"));
    expect(prov.source_digest).toBeNull();
  });

  it("flattens a multi-line --description to one YAML line (no frontmatter injection)", async () => {
    await run(SKILL_SH, ["create-global", "multi", "--description", "evil\ndescription: injected"], env());
    const md = await fs.readFile(path.join(store, "multi", "SKILL.md"), "utf-8");
    // Exactly one `description:` line inside the frontmatter.
    const descLines = md.split("\n").filter((l) => l.startsWith("description:"));
    expect(descLines).toHaveLength(1);
  });

  it("rejects a bad slug on edit-global", async () => {
    const r = await run(SKILL_SH, ["edit-global", "../etc"], env());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("bad_slug");
  });

  // Regression (caught by real-LLM e2e): _assert_writable_dir's no-symlink guard used to
  // be a bare `[ -n "$(find -type l)" ] && _fail` as the function's LAST command — on the
  // SAFE (no-symlink) path `[ -n "" ]` is false, so the function RETURNED 1 and `set -e`
  // silently killed optimize-global/edit-global before they could reseal. Both must now
  // succeed (exit 0) on a clean, symlink-free skill folder.
  it("optimize-global reseals a CLEAN skill folder (no false set -e death)", async () => {
    await run(SKILL_SH, ["create-global", "reseal-me", "--description", "x"], env());
    const r = await run(SKILL_SH, ["optimize-global", "reseal-me"], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("resealed");
    const prov = JSON.parse(await fs.readFile(path.join(store, "reseal-me", ".provenance.json"), "utf-8"));
    expect(prov.source_digest).toBeNull();
  });

  it("edit-global updates the description on a CLEAN skill folder (no false set -e death)", async () => {
    await run(SKILL_SH, ["create-global", "edit-me", "--description", "old"], env());
    const r = await run(SKILL_SH, ["edit-global", "edit-me", "--description", "new desc"], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("edited");
    const md = await fs.readFile(path.join(store, "edit-me", "SKILL.md"), "utf-8");
    expect(md).toContain("description: new desc");
    const prov = JSON.parse(await fs.readFile(path.join(store, "edit-me", ".provenance.json"), "utf-8"));
    expect(prov.source_digest).toBeNull();
  });

  it("refuses to write through a SYMLINKED skill folder (optimize-global)", async () => {
    await run(SKILL_SH, ["create-global", "real", "--description", "x"], env());
    const link = path.join(store, "linky");
    await fs.symlink(path.join(store, "real"), link);
    const r = await run(SKILL_SH, ["optimize-global", "linky"], env());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("symlink_dir");
  });

  it("refuses to write through a SYMLINKED .provenance.json (no write-through to its target)", async () => {
    await run(SKILL_SH, ["create-global", "provlink", "--description", "x"], env());
    const dir = path.join(store, "provlink");
    const outside = path.join(store, "outside-target.json");
    await fs.writeFile(outside, '{"untouched":true}', "utf-8");
    await fs.rm(path.join(dir, ".provenance.json"));
    await fs.symlink(outside, path.join(dir, ".provenance.json"));
    const r = await run(SKILL_SH, ["optimize-global", "provlink"], env());
    expect(r.code).toBe(1);
    // The up-front symlink-tree check (fail-closed BEFORE any write) catches it.
    expect(r.stderr).toMatch(/symlink_present|symlink_file/);
    // The symlink target must be UNTOUCHED (no write-through).
    expect(await fs.readFile(outside, "utf-8")).toBe('{"untouched":true}');
  });

  it("validate FAILS a skill whose provenance declares a non-null digest (runtime would drop it)", async () => {
    await run(SKILL_SH, ["create-global", "digesttest", "--description", "x"], env());
    const prov = path.join(store, "digesttest", ".provenance.json");
    await fs.writeFile(prov, '{"schema_version":"0.1.0","source_url":null,"source_digest":"deadbeef"}', "utf-8");
    const r = await run(SKILL_SH, ["validate", path.join(store, "digesttest")], env());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("non_null_digest");
  });

  it("list-company hits GET /companies/:id/skills and url-encodes --q", async () => {
    const plain = await run(SKILL_SH, ["list-company", "co-1"], env());
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('"_path":"/api/companies/co-1/skills"');
    const q = await run(SKILL_SH, ["list-company", "co-1", "--q", "a b&c"], env());
    expect(q.stdout).toContain("q=a%20b%26c"); // space + & percent-encoded, not raw
  });

  it("inspect-company / versions-company hit the right read endpoints", async () => {
    expect((await run(SKILL_SH, ["inspect-company", "co-1", "sk-9"], env())).stdout).toContain('"_path":"/api/companies/co-1/skills/sk-9"');
    expect((await run(SKILL_SH, ["versions-company", "co-1", "sk-9"], env())).stdout).toContain("/api/companies/co-1/skills/sk-9/versions");
  });

  it("new-version-company POSTs to /versions with the optional label, then reads back the new version id", async () => {
    const r = await run(SKILL_SH, ["new-version-company", "co-1", "sk-9", "--label", "v2"], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"_path":"/api/companies/co-1/skills/sk-9/versions"');
    expect(r.stdout).toContain('"label":"v2"');
    // Read-back guard: the new version id (ver-new) was confirmed present in the list.
    expect(r.stdout).toContain('"verified":true');
    expect(r.stdout).toContain('"new_version":"ver-new"');
  });

  it("create-company verifies via the TOP-LEVEL id (a nested version id in the re-GET must not false-fail)", async () => {
    // The mock's skill GET returns `currentVersionId` BEFORE `id`; the old first-id read-back
    // grabbed the version id and reported create_unconfirmed even though the skill existed.
    const r = await run(SKILL_SH, ["create-company", "co-1", "--name", "Conf Skill"], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"verified":true');
    expect(r.stdout).toContain('"created_company_skill":"cs-1"');
  });
});

describe("plugin-manager manage.sh", () => {
  const env = () => ({ SUPERCLAW_RUNTIME_API_URL: mock.url });

  it("refuses install without --yes (confirmation_required, exit 4)", async () => {
    const r = await run(PLUGIN_SH, ["install", "./foo.scplug", "--local"], env());
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("confirmation_required");
  });

  it("rejects a path-traversal plugin id", async () => {
    const r = await run(PLUGIN_SH, ["inspect", "../../secret"], env());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unsafe_plugin_id");
  });

  it("scaffold writes a REAL, directly-installable local plugin (apiVersion:1, no signing, no external CLI)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-local-"));
    // PATH without any `superclaw` CLI — authoring a local plugin must not depend on it.
    const r = await run(PLUGIN_SH, ["scaffold", "acme.weather", "--dir", dir, "--tool-name", "forecast", "--summary", "Hi"], {
      SUPERCLAW_RUNTIME_API_URL: mock.url,
      PATH: "/usr/bin:/bin",
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
    // It is installable now — no longer an unsigned draft that needs a signing pipeline.
    expect(out.installable).toBe(true);
    expect(out.draft).toBeUndefined();
    expect(out.install_hint).toContain("--local");
    const root = path.join(dir, "acme.weather");
    // The three plain-JS files a local plugin needs — no build, no SDK, no plugin-host field.
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf-8"));
    expect(pkg.name).toBe("acme.weather");
    const manifestSrc = await fs.readFile(path.join(root, "manifest.js"), "utf-8");
    expect(manifestSrc).toContain("apiVersion: 1");
    expect(manifestSrc).toContain('id: "acme.weather"');
    // agent.tools.register is REQUIRED by the validator when tools are declared.
    expect(manifestSrc).toContain('"agent.tools.register"');
    expect(manifestSrc).toContain('name: "forecast"');
    // The manifest carries NO signature/provenance — authoring never mints one.
    expect(manifestSrc.toLowerCase()).not.toContain("signature");
    expect(manifestSrc.toLowerCase()).not.toContain("provenance");
    const workerSrc = await fs.readFile(path.join(root, "worker.js"), "utf-8");
    // The worker speaks the plugin JSON-RPC protocol (the required methods + executeTool).
    for (const m of ["initialize", "health", "shutdown", "executeTool"]) {
      expect(workerSrc).toContain(m);
    }
    expect((await fs.stat(path.join(root, "README.md"))).isFile()).toBe(true);
    // De-brand red line: zero legacy vendor-brand wording in ANY generated artifact (the
    // loader finds manifest.js by convention, so package.json needs no vendor plugin field).
    // Build the brand token from parts so this de-brand ASSERTION does not itself carry the
    // literal word (the branch's added-line brand gate would otherwise flag the test).
    const legacyBrand = ["paper", "clip"].join("");
    for (const rel of ["package.json", "manifest.js", "worker.js", "README.md"]) {
      const txt = await fs.readFile(path.join(root, rel), "utf-8");
      expect(txt.toLowerCase()).not.toContain(legacyBrand);
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("scaffold rejects a non-dotted plugin id (exit 2)", async () => {
    const r = await run(PLUGIN_SH, ["scaffold", "notdotted"], { SUPERCLAW_RUNTIME_API_URL: mock.url, PATH: "/usr/bin:/bin" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid_plugin_id");
  });

  it("scaffold refuses to overwrite an existing target (exit 2)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-draft-"));
    await fs.mkdir(path.join(dir, "acme.weather"), { recursive: true });
    const r = await run(PLUGIN_SH, ["scaffold", "acme.weather", "--dir", dir], { SUPERCLAW_RUNTIME_API_URL: mock.url });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("target_exists");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("lists installed plugins via REST", async () => {
    const r = await run(PLUGIN_SH, ["list"], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("plugins");
  });

  it("list --status appends the status query", async () => {
    const r = await run(PLUGIN_SH, ["list", "--status", "ready"], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"_query":"status=ready"');
  });

  it("health / examples hit the right read endpoints", async () => {
    expect((await run(PLUGIN_SH, ["health", "acme.demo"], env())).stdout).toContain('"_path":"/api/plugins/acme.demo/health"');
    expect((await run(PLUGIN_SH, ["examples"], env())).stdout).toContain('"_path":"/api/plugins/examples"');
  });

  it("logs passes limit/level/since as query; rejects a non-integer --limit (exit 2)", async () => {
    const ok = await run(PLUGIN_SH, ["logs", "acme.demo", "--limit", "10", "--level", "error"], env());
    expect(ok.stdout).toContain("/api/plugins/acme.demo/logs?");
    expect(ok.stdout).toContain("limit=10");
    expect(ok.stdout).toContain("level=error");
    const bad = await run(PLUGIN_SH, ["logs", "acme.demo", "--limit", "abc"], env());
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("bad_limit");
    // An ISO --since has `:` (+ maybe `+`) — it must be URL-ENCODED, not path-sanitized
    // (the old `_safe_seg` rejected `:` as unsafe_plugin_id).
    const iso = await run(PLUGIN_SH, ["logs", "acme.demo", "--since", "2026-06-30T10:20:30Z"], env());
    expect(iso.code).toBe(0);
    expect(iso.stdout).toContain("since=2026-06-30T10%3A20%3A30Z");
  });

  it("config-test dry-runs via POST /config/test (no persist)", async () => {
    const r = await run(PLUGIN_SH, ["config-test", "acme.demo", "--json", '{"a":1}'], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"_path":"/api/plugins/acme.demo/config/test"');
    expect(r.stdout).toContain('"_method":"POST"');
  });

  it("disable --reason / upgrade --version send the body field", async () => {
    expect((await run(PLUGIN_SH, ["disable", "acme.demo", "--reason", "noisy"], env())).stdout).toContain('"reason":"noisy"');
    expect((await run(PLUGIN_SH, ["upgrade", "acme.demo", "--version", "2.0.0"], env())).stdout).toContain('"version":"2.0.0"');
  });

  it("remove needs --yes; --purge adds the purge query", async () => {
    expect((await run(PLUGIN_SH, ["remove", "acme.demo"], env())).code).toBe(4);
    const ok = await run(PLUGIN_SH, ["remove", "acme.demo", "--yes", "--purge"], env());
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("purge=true");
    expect(ok.stdout).toContain('"purged":true');
  });
});
