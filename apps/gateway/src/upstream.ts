/**
 * Client for the vendored upstream server (layer L3).
 *
 * The upstream is treated as an opaque, loopback-only black-box dependency: we
 * talk to it over HTTP and never import its source. This keeps the vendored
 * tree pristine (principle 1) and robust across vendor syncs.
 */

export interface UpstreamHealth {
  /** True when the upstream answered with a 2xx on its health route. */
  readonly reachable: boolean;
  /** HTTP status code, or null when the request never completed. */
  readonly status: number | null;
  /** Optional human-readable detail (error message / non-2xx note). */
  readonly detail?: string;
}

export interface UpstreamClient {
  /** Probe the upstream's health route. */
  health(): Promise<UpstreamHealth>;
}

export class UpstreamClientError extends Error {}

export class HttpUpstreamClient implements UpstreamClient {
  private readonly healthUrl: URL;

  constructor(
    baseUrl: string,
    healthPath: string,
    private readonly timeoutMs: number,
  ) {
    const base = new URL(baseUrl);
    const healthUrl = new URL(healthPath, baseUrl);
    // Defense in depth: even if a caller hands us an absolute or
    // protocol-relative path, the resolved probe must stay on the (loopback)
    // upstream origin. Never let the health path redirect the probe off-box.
    if (healthUrl.protocol !== base.protocol || healthUrl.host !== base.host) {
      throw new UpstreamClientError(
        `upstream health path must stay on ${base.origin}; refusing ${JSON.stringify(healthPath)} -> ${healthUrl.origin}`,
      );
    }
    this.healthUrl = healthUrl;
  }

  async health(): Promise<UpstreamHealth> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.healthUrl, {
        method: "GET",
        signal: controller.signal,
        redirect: "manual",
      });
      return {
        reachable: res.ok,
        status: res.status,
        ...(res.ok ? {} : { detail: `upstream ${this.healthUrl.pathname} returned ${res.status}` }),
      };
    } catch (err) {
      return {
        reachable: false,
        status: null,
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
