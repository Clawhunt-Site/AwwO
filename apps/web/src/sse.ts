// Authenticated Server-Sent-Events reading over fetch + ReadableStream.
//
// EventSource cannot carry a custom header (the control token), so SSE channels
// are read via fetch instead — the token rides the request HEADER, never the
// URL query (which would leak it into logs/history). Extracted as a pure,
// testable module so the auth/frame-parse/reader-cleanup core is verified
// directly, not only through a component that mocks the whole stream.

/** Read SSE frames from a response body, invoking onEvent(eventType, data) per
 * frame. ALWAYS cancels the reader on exit (done, throw, or abort) so the lock
 * is released and the underlying stream is torn down — no leaked reader. */
export async function readSseFrames(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: any) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = { raw: data };
        }
        onEvent(event, parsed);
      }
    }
  } finally {
    // cancel() tears down the stream but does NOT release the reader's lock on a
    // real ReadableStream (stream.locked stays true) — releaseLock() does. Do
    // both, each guarded, so the stream is genuinely unlocked on every exit
    // path (done / throw / abort). No pending read remains here, so releaseLock
    // cannot throw for that reason.
    try {
      await reader.cancel();
    } catch {
      /* already closed/aborted */
    }
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/** GET an SSE endpoint with the given headers (carrying the control token) and
 * stream its frames. The token is in the HEADER, never the URL. */
export async function fetchSse(
  url: string,
  opts: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    onEvent: (event: string, data: any) => void;
  },
): Promise<void> {
  const response = await fetch(url, { headers: opts.headers, signal: opts.signal });
  if (!response.ok || !response.body) {
    throw new Error(`${url} returned ${response.status}`);
  }
  await readSseFrames(response.body, opts.onEvent);
}
