import { and, eq, sql } from "drizzle-orm";
import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";

/**
 * Sidebar pin storage for the chat coexistence surface.
 *
 * The frontend pins both workspaces (= projects) and chat sessions (= issues)
 * into a "Pinned" zone ordered by pinned_at, but Paperclip has no native pin
 * column for either, and the two stores that COULD have held it don't fit:
 * `instance_settings.general` is a strict whitelist (an extra key is dropped on
 * every write) and the native sidebar-preference tables only store ordering
 * arrays (no session scope, no timestamp). Rather than ALTER a vendored table or
 * inject a migration into the upstream drizzle sequence (which would collide with
 * upstream numbering on the next re-vendor), this is a coexistence-owned table:
 * defined here, created idempotently on first use, and never part of the vendored
 * schema/migrations. It survives re-vendor with the rest of the chat-compat layer
 * and leaves the vendored db package pristine.
 */
export const chatSidebarPins = pgTable(
  "chat_sidebar_pins",
  {
    companyId: uuid("company_id").notNull(),
    kind: text("kind").notNull(),
    targetId: text("target_id").notNull(),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.companyId, table.kind, table.targetId] }) }),
);

export type ChatPinKind = "workspace" | "session";

// Memoized per Db instance (tests spin up fresh databases, so a plain boolean
// would wrongly skip the CREATE on a second database). The value is the in-flight
// (or settled) creation promise, registered SYNCHRONOUSLY before the DDL is
// awaited, so concurrent first calls on cold start coalesce onto a single
// CREATE rather than racing two `CREATE TABLE IF NOT EXISTS` statements (Postgres
// can throw 42P07 on a concurrent catalog insert even with IF NOT EXISTS). A
// failed creation drops the cached promise so a later call can retry.
const ensuring = new WeakMap<object, Promise<void>>();

function ensureChatPinsTable(db: Db): Promise<void> {
  let pending = ensuring.get(db);
  if (!pending) {
    pending = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS chat_sidebar_pins (
          company_id uuid NOT NULL,
          kind text NOT NULL,
          target_id text NOT NULL,
          pinned_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (company_id, kind, target_id)
        )
      `);
    })().catch((err) => {
      ensuring.delete(db);
      throw err;
    });
    ensuring.set(db, pending);
  }
  return pending;
}

/** pinned_at (epoch seconds) keyed by target id, for one company + kind. */
export async function readChatPins(
  db: Db,
  companyId: string,
  kind: ChatPinKind,
): Promise<Map<string, number>> {
  await ensureChatPinsTable(db);
  const rows = await db
    .select({ targetId: chatSidebarPins.targetId, pinnedAt: chatSidebarPins.pinnedAt })
    .from(chatSidebarPins)
    .where(and(eq(chatSidebarPins.companyId, companyId), eq(chatSidebarPins.kind, kind)));
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.targetId, Math.floor(row.pinnedAt.getTime() / 1000));
  }
  return map;
}

/**
 * Pin or unpin a target. Pinning is idempotent (re-pinning keeps the original
 * pinned_at, so the pinned-zone order is stable); unpinning removes the row.
 */
export async function setChatPin(
  db: Db,
  companyId: string,
  kind: ChatPinKind,
  targetId: string,
  pinned: boolean,
): Promise<void> {
  await ensureChatPinsTable(db);
  if (pinned) {
    await db
      .insert(chatSidebarPins)
      .values({ companyId, kind, targetId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(chatSidebarPins)
      .where(
        and(
          eq(chatSidebarPins.companyId, companyId),
          eq(chatSidebarPins.kind, kind),
          eq(chatSidebarPins.targetId, targetId),
        ),
      );
  }
}
