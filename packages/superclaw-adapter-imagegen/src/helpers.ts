/**
 * Local copies of the tiny normalization helpers used by built-in adapters.
 *
 * Why not import them from `@paperclipai/adapter-utils/server-utils`?
 * The in-repo adapter-utils package ships TypeScript source only
 * (`exports: { ".": "./src/index.ts", "./*": "./src/*.ts" }`, no dist).
 * A compiled external plugin is loaded by the server via a plain dynamic
 * `import()` of `dist/index.js` (see server/server/src/adapters/plugin-loader.ts),
 * and plain Node cannot execute `.ts` files resolved out of node_modules.
 * Type-only imports are erased at build time, so this package imports ONLY
 * types from adapter-utils and mirrors the trivial value helpers here
 * (signatures match server-utils.ts).
 */

export function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Latest USER comment from the wake payload, falling back to issue
 * title + description. Mirrors the raw payload shape normalized by
 * adapter-utils server-utils.ts (`normalizePaperclipWakeComment`):
 * comments carry `{ body, author: { type, id } }`.
 */
export function extractPromptFromContext(context: Record<string, unknown>): string {
  const wake = parseObject(context.paperclipWake);
  const comments = Array.isArray(wake.comments) ? wake.comments : [];
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = parseObject(comments[i]);
    const author = parseObject(comment.author);
    const authorType = (trimmedString(author.type) || trimmedString(comment.authorType)).toLowerCase();
    const body = trimmedString(comment.body);
    if (authorType === "user" && body) return body;
  }
  const issue = parseObject(wake.issue);
  const title = trimmedString(issue.title) || trimmedString(context.taskTitle) || trimmedString(context.issueTitle);
  const description =
    trimmedString(issue.description) ||
    trimmedString(context.taskDescription) ||
    trimmedString(context.issueDescription);
  return [title, description].filter(Boolean).join("\n\n").trim();
}

/**
 * Issue id resolution mirrors grok_local execute.ts (wakeTaskId chain):
 * context.taskId -> context.issueId -> wake payload issue.id.
 */
export function resolveIssueId(context: Record<string, unknown>): string | null {
  const direct = trimmedString(context.taskId) || trimmedString(context.issueId);
  if (direct) return direct;
  const wakeIssue = parseObject(parseObject(context.paperclipWake).issue);
  return trimmedString(wakeIssue.id) || null;
}

/**
 * Paperclip API base resolution. Precedence:
 * config.apiUrl -> config.env SUPERCLAW_API_URL/PAPERCLIP_API_URL ->
 * then the same chain `buildPaperclipEnv` uses (adapter-utils
 * server-utils.ts:1200-1222): PAPERCLIP_RUNTIME_API_URL ->
 * SUPERCLAW_API_URL || PAPERCLIP_API_URL -> http://{host}:{port}.
 */
export function resolvePaperclipApiBase(
  config: Record<string, unknown>,
  envConfig: Record<string, unknown>,
): string {
  const resolveHostForUrl = (rawHost: string): string => {
    const host = rawHost.trim();
    if (!host || host === "0.0.0.0" || host === "::") return "localhost";
    if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
    return host;
  };
  const fromConfig = trimmedString(config.apiUrl);
  const fromEnvConfig = trimmedString(envConfig.SUPERCLAW_API_URL) || trimmedString(envConfig.PAPERCLIP_API_URL);
  const fromRuntime = trimmedString(process.env.PAPERCLIP_RUNTIME_API_URL);
  const fromProcess = trimmedString(process.env.SUPERCLAW_API_URL) || trimmedString(process.env.PAPERCLIP_API_URL);
  const host = resolveHostForUrl(process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost");
  const port = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  const base = fromConfig || fromEnvConfig || fromRuntime || fromProcess || `http://${host}:${port}`;
  return base.replace(/\/+$/, "");
}

/** API token: explicit env binding wins over the run-scoped local agent JWT (mirrors grok_local). */
export function resolvePaperclipApiToken(
  envConfig: Record<string, unknown>,
  authToken: string | undefined,
): string {
  return (
    trimmedString(envConfig.PAPERCLIP_API_KEY) ||
    trimmedString(envConfig.SUPERCLAW_API_KEY) ||
    (authToken ?? "").trim()
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function sanitizeFileStem(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned || "run";
}

/** RunningHub outputs carry a bare fileType like "png" — sanitize it into a safe extension. */
export function sanitizeFileExtension(value: string, fallback = "png"): string {
  const cleaned = value.trim().toLowerCase().replace(/^\./, "");
  return /^[a-z0-9]{1,8}$/.test(cleaned) ? cleaned : fallback;
}

export function mimeTypeForExtension(ext: string): string {
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    default:
      return "image/png";
  }
}
