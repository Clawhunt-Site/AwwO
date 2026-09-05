import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Materialize the ClawWork `clawrelay` provider into an EPHEMERAL agent-config
 * dir (credential hygiene).
 *
 * ClawWork (a pi fork) resolves a custom/OpenAI-compatible endpoint only through
 * a models.json in its agent-config dir (`CLAWWORK_CODING_AGENT_DIR`, falling back
 * to ~/.clawwork/agent). Two hard requirements drive this module:
 *
 *  1. NEVER write into the workspace. Writing a persistent `models.json` into the
 *     agent's cwd would dirty git and let two concurrent runs in the same repo
 *     clobber each other (advisor BLOCK). We write to a per-run `mkdtemp` dir and
 *     point `CLAWWORK_CODING_AGENT_DIR` at it; execute.ts cleans it up.
 *
 *  2. NEVER put the real relay key on disk. ClawWork resolves a provider apiKey of
 *     the form `$ENV_VAR` from the environment at request time
 *     (core/resolve-config-value.ts, via model-registry resolveConfigValueOrThrow,
 *     which THROWS on a missing var — fail-closed). So the file carries the literal
 *     string `$SUPERCLAW_RELAY_API_KEY`; the real key only ever lives in the child
 *     process env. A SIGKILL/crash therefore leaves no plaintext key behind.
 */

export const RELAY_BASE_URL_ENV = "SUPERCLAW_RELAY_BASE_URL";
export const RELAY_API_KEY_ENV = "SUPERCLAW_RELAY_API_KEY";
export const RELAY_API_ENV = "SUPERCLAW_RELAY_API";
export const CLAWWORK_AGENT_DIR_ENV = "CLAWWORK_CODING_AGENT_DIR";

export class ClawworkRelayConfigError extends Error {}

/**
 * Validate the relay base URL fail-closed (credential hygiene: the apiKey rides to
 * this base, so an unsafe base could exfil it). Mirrors the Python
 * relay_key.validate_relay_base_url checks: reject userinfo injection, remote
 * plaintext http, and percent-encoding. Returns the normalized base.
 */
export function validateRelayBaseUrl(raw: string): string {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new ClawworkRelayConfigError(`${RELAY_BASE_URL_ENV} is empty`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ClawworkRelayConfigError(`${RELAY_BASE_URL_ENV} is not a valid URL`);
  }
  if (url.username || url.password) {
    throw new ClawworkRelayConfigError(
      `${RELAY_BASE_URL_ENV} must not contain userinfo (credential exfil surface)`,
    );
  }
  const host = url.hostname.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (url.protocol !== "https:" && !isLoopback) {
    throw new ClawworkRelayConfigError(
      `${RELAY_BASE_URL_ENV} must be https for non-loopback hosts (plaintext relay key exfil surface)`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ClawworkRelayConfigError(`${RELAY_BASE_URL_ENV} must be http(s)`);
  }
  // Percent-encoding in the host is an obfuscation/exfil surface.
  if (/%[0-9a-fA-F]{2}/.test(url.host)) {
    throw new ClawworkRelayConfigError(`${RELAY_BASE_URL_ENV} host must not be percent-encoded`);
  }
  // Normalize to origin + path without a trailing slash.
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${normalizedPath}`;
}

export interface PreparedClawrelayProvider {
  /** The ephemeral CLAWWORK_CODING_AGENT_DIR; cleaned up by the caller. */
  agentConfigDir: string;
  /** Normalized relay base URL written into the provider config. */
  baseUrl: string;
  cleanup: () => Promise<void>;
}

/**
 * Resolve relay base + key from the injected env and write the ephemeral
 * clawrelay provider config. The real key is NOT written (the file binds apiKey to
 * `$SUPERCLAW_RELAY_API_KEY`); the caller MUST pass the real key through in the
 * child env. Fails closed when base or key is missing.
 */
export async function prepareClawrelayProvider(input: {
  env: Record<string, string>;
  /** Relay group slug to enumerate as the only model (already translated). */
  modelSlug: string | null;
}): Promise<PreparedClawrelayProvider> {
  const resolve = (name: string): string =>
    (input.env[name] ?? process.env[name] ?? "").trim();

  const rawBase = resolve(RELAY_BASE_URL_ENV);
  if (!rawBase) {
    throw new ClawworkRelayConfigError(
      `${RELAY_BASE_URL_ENV} is not set; SuperClaw must inject the relay base (fail-closed)`,
    );
  }
  const baseUrl = validateRelayBaseUrl(rawBase);

  const realKey = resolve(RELAY_API_KEY_ENV);
  if (!realKey) {
    throw new ClawworkRelayConfigError(
      `${RELAY_API_KEY_ENV} is not set; SuperClaw must inject the relay key (fail-closed)`,
    );
  }

  const api = resolve(RELAY_API_ENV) || "openai-completions";

  const agentConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "superclaw-clawwork-agent-"));
  try {
    await fs.chmod(agentConfigDir, 0o700);
    const provider = {
      providers: {
        clawrelay: {
          baseUrl,
          api,
          // Env-binding, NOT the literal key: ClawWork interpolates this from the
          // child env at request time (resolve-config-value $ENV_VAR), so no
          // plaintext key is ever written to disk.
          apiKey: `$${RELAY_API_KEY_ENV}`,
          models: input.modelSlug ? [{ id: input.modelSlug }] : [],
        },
      },
    };
    const modelsPath = path.join(agentConfigDir, "models.json");
    await fs.writeFile(modelsPath, `${JSON.stringify(provider, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(modelsPath, 0o600);
  } catch (err) {
    await fs.rm(agentConfigDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  return {
    agentConfigDir,
    baseUrl,
    cleanup: async () => {
      await fs.rm(agentConfigDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
