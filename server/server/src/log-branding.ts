/**
 * Single source for the backend's operational log branding.
 *
 * Historically the vendored upstream hardcoded "[paperclip]" (and variants
 * like "[paperclip truncated …]") at every call site; the de-branding pass
 * covered UI display copy but left these run-log strings, which then leaked
 * into chat transcripts on plain-text runtimes. All operational log lines
 * (console.* and run-log chunks) must derive their brand from here so it
 * lives in exactly one place.
 */
export const LOG_BRAND = "superclaw";

/** Standard prefix for operational log lines, e.g. `[superclaw] …`. */
export const LOG_PREFIX = `[${LOG_BRAND}]`;
