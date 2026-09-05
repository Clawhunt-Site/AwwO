import type {
  CompanyPortabilityFileEntry,
  CompanyPortabilityImport,
  CompanyPortabilityImportResult,
} from "@paperclipai/shared";

import { HttpError } from "../errors.js";
import type { WorkshopInstaller, WorkshopInstallResult } from "./workshop-import.js";

/**
 * Super-company installer (capability workshop S5) — the `installers.company` the S2c
 * importer calls once a workshop company artifact has passed receipt + transport-digest
 * verification and been unpacked.
 *
 * A company is NOT a file in a store — importing it MATERIALIZES agents/skills/projects
 * into the database. So this reuses Paperclip's OWN native `importBundle` (no parallel
 * implementation): the verified bundle is fed as INLINE files into a NEW company.
 *
 * MVP governance (the design's hard constraints):
 *   - kind assertion: only a `kind=company` receipt may reach this installer.
 *   - NEW company only: `target.mode="new_company"`. The result MUST be freshly created.
 *   - INLINE bytes (never a `github` source — no force-push TOCTOU / non-deterministic clone).
 *   - reverse red-line: a non-company package is rejected by importBundle's own company-
 *     manifest validation (no separate, false-positive-prone file-name heuristic).
 *   - skill collisions: `importBundle` runs in its default `board_full` mode, which uses a
 *     `replace` skill strategy — but the target is a FRESH, EMPTY company, so there is
 *     nothing to replace (replace ≡ create here); existing-company mutation is impossible.
 *
 * FAILURE SEMANTICS — identical to native `importBundle` (零偏差, no parallel cleanup):
 * `importBundle` validates the bundle (preview) BEFORE creating the company, so a bad
 * bundle fails with an HttpError 4xx and creates NOTHING. A rare mid-materialize failure
 * AFTER company creation leaves the company behind EXACTLY as the native
 * `POST /api/companies/import` does (its catch cleans only secrets, never the company) —
 * surfaced as an error, recoverable. This wrapper therefore does NOT attempt a global
 * before/after company-id diff to "compensate": that diff is unsafe (a concurrent native
 * company creation via `/api/companies` or `/api/companies/import` would be wrongly seen
 * as this import's residue and DELETED — data loss) and would also diverge from native
 * semantics. It only classifies a 4xx as a client error (→ route 400).
 *
 * The official badge needs no digest gate: each import yields a FRESH companyId
 * (new_company never reuses an id), so a provenance row keyed by companyId cannot drift.
 */

export class SuperCompanyInstallError extends Error {}

export interface SuperCompanyInstallerDeps {
  /** Walk the unpacked bundle into inline files (text→string, binary→base64). */
  readonly buildInlineFiles: (unpackedDir: string) => Promise<Record<string, CompanyPortabilityFileEntry>>;
  /** Paperclip's native company import (reused verbatim — no parallel implementation). */
  readonly importBundle: (
    input: CompanyPortabilityImport,
    actorUserId: string | null,
  ) => Promise<CompanyPortabilityImportResult>;
  /** Delete a company (precise rollback of a KNOWN id) — cascades agents/skills/projects. */
  readonly removeCompany: (companyId: string) => Promise<void>;
  /**
   * The board principal the imported company is OWNED by. Explicit (not null → the
   * native `?? "board"` surprise): the loopback workshop import attributes the company
   * to the local board user.
   */
  readonly ownerUserId: string;
}

export function createSuperCompanyInstaller(deps: SuperCompanyInstallerDeps): WorkshopInstaller {
  return async (ctx): Promise<WorkshopInstallResult> => {
    if (ctx.receipt.kind !== "company") {
      throw new SuperCompanyInstallError(`super company installer received a non-company receipt: ${ctx.receipt.kind}`);
    }

    const files = await deps.buildInlineFiles(ctx.unpackedDir);
    if (Object.keys(files).length === 0) {
      throw new SuperCompanyInstallError("company bundle is empty");
    }

    let result: CompanyPortabilityImportResult;
    try {
      result = await deps.importBundle(
        {
          source: { type: "inline", files },
          target: { mode: "new_company" },
          collisionStrategy: "rename",
        },
        deps.ownerUserId,
      );
    } catch (importErr) {
      // Match native importBundle semantics (零偏差): a bad bundle fails validation BEFORE
      // any company is created (HttpError 4xx) → classify as a client error (route 400). A
      // rare mid-materialize failure leaves the company behind EXACTLY as native does — we
      // do NOT global-diff to delete it (that would risk deleting a concurrently-created
      // company). Surface the error; the orphan is recoverable like any native failed import.
      if (importErr instanceof HttpError && importErr.status >= 400 && importErr.status < 500) {
        throw new SuperCompanyInstallError(`company import rejected: ${importErr.message}`);
      }
      throw importErr; // server-side failure (DB/storage) → route 500
    }

    // new_company MUST create. Anything else is unexpected — roll back the PRECISE id and
    // fail closed (surfacing a cleanup failure, never swallowing this tripwire).
    if (result.company.action !== "created") {
      const tripwire = new SuperCompanyInstallError(
        `expected a newly created company but import action was ${JSON.stringify(result.company.action)}`,
      );
      try {
        await deps.removeCompany(result.company.id);
      } catch (cleanupErr) {
        throw new AggregateError(
          [tripwire, cleanupErr],
          `company import tripwire AND rollback failed (manual cleanup of ${result.company.id} required)`,
        );
      }
      throw tripwire;
    }

    const companyId = result.company.id;
    return {
      nativeId: companyId,
      // No verificationDigest: a company is materialized into the DB (no recomputable store
      // dir), and its companyId is fresh per import → the official badge keyed by companyId
      // cannot drift. The rollback (the importer calls it on a post-success provenance-write
      // failure) deletes the PRECISE known id — no global diff, safe under concurrency.
      rollback: async () => {
        await deps.removeCompany(companyId);
      },
    };
  };
}
