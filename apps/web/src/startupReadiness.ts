// The browser canvas needs the Node control plane and its conversation gateway.
// Runtime/provider configuration is independent of service readiness: a fresh
// installation with no companies or agents can still open and edit its canvas.
export async function probeCanvasReadiness(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const results = await Promise.allSettled([
    fetcher('/paperclip-api/health', { signal, credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => response.ok && (await response.json())?.status === 'ok'),
    fetcher('/gateway-api/health', { signal, credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return false;
        const health = await response.json();
        return health?.ok === true && health?.upstream?.reachable === true;
      }),
  ]);
  return results.every((result) => result.status === 'fulfilled' && result.value === true);
}
