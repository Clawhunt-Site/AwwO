export function firstNonEmptyLine(text: string): string {
    return (
        text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean) ?? ""
    );
}

// Gemini prints INFORMATIONAL notices to stderr (the YOLO-mode banner, a
// folder-trust downgrade, credential/telemetry notes) BEFORE any real error.
// Taking the first stderr line as the failure reason therefore surfaces a
// misleading notice (e.g. "YOLO mode is enabled...") instead of the actual cause
// (e.g. "Error authenticating: IneligibleTierError ..."). These patterns are the
// known non-error notices to skip.
const GEMINI_STDERR_NOTICE_RES: RegExp[] = [
    /^YOLO mode is enabled\b/i,
    /^Approval mode overridden\b/i,
    /^Loaded cached credentials\b/i,
    /^Data collection is (disabled|enabled)\b/i,
];

/**
 * Pick the most meaningful failure line from Gemini stderr: drop the known
 * informational notices, then prefer a line that actually looks like an error,
 * falling back to the first remaining line (or "" if only notices were present).
 */
export function firstGeminiErrorLine(text: string): string {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !GEMINI_STDERR_NOTICE_RES.some((re) => re.test(line)));
    if (lines.length === 0) return "";
    const errorish = lines.find((line) => /error|failed|exception|unauthor|ineligible/i.test(line));
    return errorish ?? lines[0];
}
