import { api, tenantPath } from './api';
import type { AssistantRouteDecision, AssistantRouteRequest } from '../canvas/assistantRouting';

// The server bounds its own model call at 8 s; this leaves room for the request around it.
const ROUTE_TIMEOUT_MS = 12000;

/** Asks the server how to handle one assistant message. Anything but a route the caller offered is an error,
 *  which the caller turns into its own default. */
export async function routeAssistantMessage(tenantId: string, canvasId: string, request: AssistantRouteRequest, signal: AbortSignal): Promise<AssistantRouteDecision> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, ROUTE_TIMEOUT_MS);
  try {
    const value = await api<unknown>(tenantPath(tenantId, `/canvases/${encodeURIComponent(canvasId)}/assistant/route`),
      { method: 'POST', body: JSON.stringify(request), signal: controller.signal });
    const { route, redirect } = value && typeof value === 'object' ? value as { route?: unknown; redirect?: unknown } : {};
    if ((route === 'plan' || route === 'execute') && request.routes.includes(route)) return { route, ...(redirect === true ? { redirect: true } : {}) };
    throw new Error('The assistant router returned no usable route');
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
