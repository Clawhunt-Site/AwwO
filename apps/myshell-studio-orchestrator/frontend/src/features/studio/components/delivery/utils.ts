import { getStudioRootEndpoint } from '../../api';
import type {
  StudioActionResolveResult,
  StudioDispatchSessionRetryResult,
  StudioDispatchSessionTargetRunResult,
  StudioHandoffAction,
  StudioHandoffArtifact,
} from '../../api';

export function artifactHref(artifact: StudioHandoffArtifact): string {
  if (artifact.uiUrl) {
    if (/^https?:\/\//i.test(artifact.uiUrl)) return artifact.uiUrl;
    return artifact.uiUrl.startsWith('/') ? artifact.uiUrl : `/${artifact.uiUrl}`;
  }
  return getStudioRootEndpoint(artifact.url || artifact.endpoint);
}

export function actionUiHref(action: StudioHandoffAction): string {
  const appHref = action.uiUrl || action.next?.uiUrl || '';
  if (appHref) {
    if (/^https?:\/\//i.test(appHref)) return appHref;
    return appHref.startsWith('/') ? appHref : `/${appHref}`;
  }
  const apiHref = action.url || action.next?.url || action.retryUrl || action.next?.retryUrl || action.cancelUrl || action.next?.cancelUrl || '';
  if (!apiHref) return '';
  if (/^https?:\/\//i.test(apiHref)) return apiHref;
  return getStudioRootEndpoint(apiHref);
}

export function absoluteAppHref(href: string): string {
  if (!href || /^https?:\/\//i.test(href) || typeof window === 'undefined') return href;
  return new URL(href, window.location.origin).toString();
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text || typeof document === 'undefined') return false;

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    textarea.remove();
  }

  if (copied) return true;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function readDispatchSessionRestoreParams(): { sessionId?: string; targetId?: string } {
  if (typeof window === 'undefined') return {};
  try {
    const params = new URLSearchParams(window.location.search);
    return {
      sessionId: params.get('dispatch_session_id') || params.get('session_id') || undefined,
      targetId: params.get('target_id') || params.get('dispatch_target_id') || undefined,
    };
  } catch {
    return {};
  }
}

export function isDispatchTargetRunResult(
  result: StudioActionResolveResult['result'],
): result is StudioDispatchSessionTargetRunResult {
  return Boolean(result && typeof result === 'object' && 'session' in result && 'target' in result);
}

export function isDispatchSessionRetryResult(
  result: StudioActionResolveResult['result'],
): result is StudioDispatchSessionRetryResult {
  return Boolean(result && typeof result === 'object' && 'session' in result && !('target' in result));
}
