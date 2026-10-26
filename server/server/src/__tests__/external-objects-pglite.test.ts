import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { openPgliteDb, companies, issues, externalObjectMentions, type Db } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { externalObjectService } from "../services/external-objects.js";

describe("external object gates on the desktop database", () => {
  let root: string;
  let handle: Awaited<ReturnType<typeof openPgliteDb>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "awwo-gate-"));
    handle = await openPgliteDb(path.join(root, "db"));
  }, 30000);
  afterAll(async () => {
    await handle?.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  it("reads the disabled flag on the current connection without blocking later queries", async () => {
    const db = handle.db as unknown as Db;
    const service = externalObjectService(db, {
      github: false,
      enabled: async (connection: Db) => {
        expect(connection).toBeDefined();
        await connection.execute(sql`select 1`);
        return false;
      },
    });
    await service.syncIssue("not-needed");
    await service.syncComment("not-needed");
    await service.syncDocument("not-needed");
    await db.transaction(async tx => { await service.syncComment("not-needed", tx); });
    await expect(db.execute(sql`select 1`)).resolves.toBeDefined();
  }, 5000);
  it("keeps settings and plugin discovery on the comment transaction", async () => {
    const db = handle.db as unknown as Db;
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "AwwO acceptance", issuePrefix: "AUTH" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic link test", status: "todo" });
    const service = externalObjectService(db, {
      github: false,
      pluginWorkerManager: { call: async () => { throw new Error("No plugins are installed"); } } as unknown as PluginWorkerManager,
      enabled: async connection => { await connection.execute(sql`select 1`); return true; },
    });
    await db.transaction(async tx => {
      const comment = await issueService(db).addComment(issueId, "Reference https://example.invalid/synthetic", {}, undefined, tx);
      await service.syncComment(comment.id, tx);
    });
    expect(await db.select().from(externalObjectMentions)).toHaveLength(1);
  }, 5000);
});
