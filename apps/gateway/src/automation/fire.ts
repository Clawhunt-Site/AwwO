// The fire action: on a due slot, drive the bound chat session by injecting the
// automation's prompt as a user turn via the UPSTREAM chat turn path
// (POST /api/chat/stream, which internally assigns the chat agent, appendUserTurn's the
// message into the SAME chat issue, and heartbeat.wakeup's the agent). It NEVER calls the
// routine engine, so no routine_execution issue is spawned (PR1 de-risk).
//
// session_id IS the chat issue id (server/src/routes/chat.ts:404 `issueId = sessionIdIn`),
// so the automation's sessionIssueId maps straight through.

export type FireOutcome = { ok: true } | { ok: false; status: number | null; error: string };

// Interface so the ticker can be unit-tested with a fake dispatcher (no HTTP / no upstream).
export interface ChatTurnDispatcher {
  inject(sessionIssueId: string, prompt: string): Promise<FireOutcome>;
}

export interface UpstreamChatTurnDispatcherOptions {
  // How long to wait for the upstream to accept the turn before giving up. The turn is
  // injected (comment appended + agent woken) at the START of the SSE handler, so a 200 +
  // first bytes means accepted; we do not wait for the full assistant reply.
  acceptTimeoutMs?: number;
  // Injected for tests; defaults to global fetch.
  fetchImpl?: typeof fetch;
}

export class UpstreamChatTurnDispatcher implements ChatTurnDispatcher {
  private readonly acceptTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly upstreamBaseUrl: string,
    opts: UpstreamChatTurnDispatcherOptions = {},
  ) {
    this.acceptTimeoutMs = opts.acceptTimeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async inject(sessionIssueId: string, prompt: string): Promise<FireOutcome> {
    const url = `${this.upstreamBaseUrl.replace(/\/+$/, '')}/api/chat/stream`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.acceptTimeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: prompt, session_id: sessionIssueId }),
        signal: controller.signal,
      });
      // Non-2xx means the turn was NOT injected (e.g. 400 missing message, 404 session,
      // 403 access). Surface the upstream error.
      if (!res.ok) {
        let detail = '';
        try {
          const parsed = (await res.json()) as { error?: unknown };
          detail = typeof parsed?.error === 'string' ? parsed.error : '';
        } catch {
          detail = '';
        }
        return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` };
      }
      // CRITICAL: a 200 does NOT mean the turn ran. The upstream writes the SSE head BEFORE
      // appendUserTurn/heartbeat.wakeup (server/.../chat.ts), emits `chat.started` AFTER the
      // append but BEFORE the wakeup, and — if the wakeup is SKIPPED — emits a terminal
      // `chat.completed` with `failure_reason: "wakeup_skipped"`. So `chat.started` alone
      // proves only injection, not that the agent ran. We consume the SSE and decide:
      //   - chat.started                      → injected (turn appended)
      //   - message.delta / message.completed → the run is producing output → SUCCESS
      //   - chat.completed wakeup_skipped     → the agent never ran → FAILURE
      //   - chat.completed (else, incl. deferred/queued) → SUCCESS
      //   - stream end / accept-timeout after injection → SUCCESS (deferred / slow first token;
      //     a real skip arrives fast, right after wakeup returns)
      //   - any terminal/close before injection → FAILURE
      return await this.awaitAccepted(res);
    } catch (err) {
      // The fetch itself rejected (abort before a Response, or a connection error). No
      // turn was injected, so this is a failure.
      const aborted = err instanceof Error && err.name === 'AbortError';
      return { ok: false, status: null, error: aborted ? 'accept timeout' : (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  // Read the SSE stream until a post-wakeup signal proves the run started (or was queued),
  // or a `wakeup_skipped` proves it did not. Never waits for the full assistant reply.
  private async awaitAccepted(res: Response): Promise<FireOutcome> {
    if (!res.body) return { ok: false, status: res.status, error: 'no response stream' };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let injected = false; // saw chat.started ⇒ the user turn was appended
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          // Abort (accept timeout) or network drop. If the turn was already injected, the
          // wakeup was already called (a skip would have arrived fast) — treat a slow/no
          // reply as accepted. Otherwise it is a real failure.
          if (injected) return { ok: true };
          const aborted = err instanceof Error && err.name === 'AbortError';
          return { ok: false, status: null, error: aborted ? 'accept timeout' : (err as Error).message };
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        // SSE permits CRLF line endings; normalize so frame detection on "\n\n" is robust
        // even if an intermediary rewrites newlines (the parser must not deadlock on \r\n\r\n).
        buffer = buffer.replace(/\r\n/g, '\n');
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const event = frame.split('\n').find((l) => l.startsWith('event:'))?.slice('event:'.length).trim();
          const dataRaw = frame.split('\n').find((l) => l.startsWith('data:'))?.slice('data:'.length).trim() ?? '';
          if (event === 'chat.started') {
            injected = true;
            continue;
          }
          if (event === 'message.delta' || event === 'message.completed') {
            return { ok: true }; // the run is producing output ⇒ it ran
          }
          if (event === 'chat.completed') {
            let failureReason: unknown;
            try {
              failureReason = (JSON.parse(dataRaw) as { failure_reason?: unknown }).failure_reason;
            } catch {
              failureReason = undefined;
            }
            if (failureReason === 'wakeup_skipped') {
              return { ok: false, status: res.status, error: 'wakeup skipped (agent did not run)' };
            }
            // Ran, or queued (wakeup_deferred), or completed — accepted if we got this far.
            return injected ? { ok: true } : { ok: false, status: res.status, error: dataRaw || 'not accepted' };
          }
        }
      }
      // Stream ended cleanly: accepted iff the turn was injected.
      return injected ? { ok: true } : { ok: false, status: res.status, error: 'stream ended before accept' };
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}
