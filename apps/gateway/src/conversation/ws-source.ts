// P3d — real WebSocket adapter for the company live-event stream (part 2c).
//
// Wraps the upstream company WS (/api/companies/:id/events/ws) as the
// CompanyEventSource the orchestrator consumes. Two hard requirements from the
// orchestrator's subscribe-before-wake contract + Codex review:
//   1. Connecting + buffering start the INSTANT openCompanyEventSource is called
//      (not lazily on first iteration) — so events between subscribe and wake are
//      captured while the core is still discovering the runId.
//   2. The buffer is BOUNDED: during runId discovery the core does not consume, so
//      an unbounded queue could grow without limit. On overflow the source closes
//      (the core then ends honestly, never fabricating a completion).
//
// Loopback-only, zero server/ import. Auth: the upstream WS accepts board access
// on loopback in local_trusted mode (our first target); authenticated deployments
// must plumb a token here (deferred, per the P3d decisions).

import type { CompanyEventSource } from './stream.js';
import type { LiveEventFrame } from './run-stream.js';

/** Minimal structural type for a WebSocket client (native global or an injected
 *  fake in tests). Only the members this adapter uses. */
export interface WebSocketLike {
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'error' | 'close', cb: () => void): void;
  close(): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

const DEFAULT_BUFFER_CAP = 2000;

/** A bounded async queue. push() past the cap marks overflow and closes — the
 *  consumer's iteration then ends (the orchestrator reports an honest non-terminal
 *  end rather than dropping events silently mid-stream). */
class BoundedEventQueue {
  private items: LiveEventFrame[] = [];
  private resolvers: Array<(r: IteratorResult<LiveEventFrame>) => void> = [];
  private closed = false;
  overflowed = false;
  /** Called once when the queue closes for ANY reason (explicit or overflow) —
   *  the source wires this to tear down the underlying socket. */
  onClose?: () => void;

  constructor(private readonly cap: number) {}

  push(ev: LiveEventFrame): void {
    if (this.closed) return;
    const waiter = this.resolvers.shift();
    if (waiter) {
      waiter({ value: ev, done: false });
      return;
    }
    if (this.items.length >= this.cap) {
      this.overflowed = true;
      this.close();
      return;
    }
    this.items.push(ev);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const r of this.resolvers) r({ value: undefined as never, done: true });
    this.resolvers = [];
    this.onClose?.();
  }

  async *iterate(): AsyncGenerator<LiveEventFrame> {
    for (;;) {
      const buffered = this.items.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<LiveEventFrame>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

/** http(s)://host:port  →  ws(s)://host:port/api/companies/:id/events/ws */
export function toCompanyEventsWsUrl(baseUrl: string, companyId: string): string {
  const origin = baseUrl.replace(/\/+$/, '').replace(/^http(s?):/i, 'ws$1:');
  return `${origin}/api/companies/${encodeURIComponent(companyId)}/events/ws`;
}

export interface WsSourceOpts {
  /** Inject a WebSocket implementation (defaults to the global). */
  webSocketFactory?: WebSocketFactory;
  /** Max buffered events before the source overflows + closes. */
  bufferCap?: number;
}

/**
 * Open a live, buffering event source for a company. Connecting + buffering begin
 * synchronously here (subscribe-before-wake). Never throws — a construction/connect
 * failure yields an immediately-closed (empty) source, and the orchestrator reports
 * an honest no_run rather than crashing.
 */
export function openCompanyEventSource(
  baseUrl: string,
  companyId: string,
  opts: WsSourceOpts = {},
): CompanyEventSource {
  const factory: WebSocketFactory =
    opts.webSocketFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
  const queue = new BoundedEventQueue(opts.bufferCap ?? DEFAULT_BUFFER_CAP);
  let ws: WebSocketLike | null = null;
  // Closing the queue for ANY reason — explicit close OR a bounded-buffer overflow
  // during discovery — tears down the socket too, so the upstream subscription is
  // always released (no leak, no frames arriving into a dead queue).
  queue.onClose = () => {
    try {
      ws?.close();
    } catch {
      /* already closing */
    }
  };
  try {
    ws = factory(toCompanyEventsWsUrl(baseUrl, companyId));
    ws.addEventListener('message', (ev: { data: unknown }) => {
      if (typeof ev.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return; // ignore non-JSON frames
      }
      if (parsed && typeof parsed === 'object') queue.push(parsed as LiveEventFrame);
    });
    ws.addEventListener('error', () => queue.close());
    ws.addEventListener('close', () => queue.close());
  } catch {
    queue.close();
  }
  return {
    [Symbol.asyncIterator]: () => queue.iterate(),
    close() {
      queue.close(); // → onClose tears down the socket
    },
  };
}
