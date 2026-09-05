/**
 * Single source of truth for skill-key NAMESPACE discrimination — shared across the
 * backend (`server/server`) AND the board UI (`server/ui`), both of which consume
 * `@paperclipai/shared`.
 *
 * Upstream ships bundled "engine" skills (paperclip-board / -dev / -create-agent …) under
 * the `paperclipai/paperclip/` key namespace; the adapter skill sync brings them into a
 * company's runtime skills. Several surfaces must recognise them — the import/reserved-key
 * guard, runtime-name derivation and bundled-key construction in `company-skills.ts` /
 * `company-portability.ts`; the composer `@skill` suggestion projection in
 * `routes/chat-skills.ts`; and the NewAgent skill picker in the board UI. They must NOT be
 * surfaced to the user: their key + the inserted `@skill:<key>` token leak the upstream
 * brand, and they are engine internals, not user capabilities. Keeping the prefix in ONE
 * place means a future vendor-namespace change is a single edit, not a scavenger hunt that
 * risks re-leaking the brand.
 */
export const VENDORED_ENGINE_OWNER = "paperclipai";
export const VENDORED_ENGINE_REPO = "paperclip";
/** `paperclipai/paperclip/` — the bundled-skill key namespace, derived from owner+repo so
 * a vendor change is a SINGLE edit (owner/repo) that propagates to the prefix + provenance. */
export const VENDORED_ENGINE_SKILL_KEY_PREFIX = `${VENDORED_ENGINE_OWNER}/${VENDORED_ENGINE_REPO}/`;

/** True when `key` belongs to the upstream vendored engine skill namespace. Accepts a
 * nullish key (returns false) so it is a drop-in for `key?.startsWith(...)` call sites. */
export function isVendoredEngineSkillKey(key: string | null | undefined): boolean {
  return typeof key === "string" && key.startsWith(VENDORED_ENGINE_SKILL_KEY_PREFIX);
}

/** True when an `owner`/`repo` pair (e.g. parsed from a skill's source ref) is the upstream
 * vendored engine repo — the `sourceKind === "paperclip_bundled"` discriminator. */
export function isVendoredEngineRepo(owner: string | null | undefined, repo: string | null | undefined): boolean {
  return owner === VENDORED_ENGINE_OWNER && repo === VENDORED_ENGINE_REPO;
}
