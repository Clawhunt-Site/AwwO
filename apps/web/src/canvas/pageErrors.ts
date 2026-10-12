// A delivered page that fails when it runs says so. AwwO's own script, ahead of everything the page brings, hands the
// first uncaught error to the preview that shows the page; the page runs in an opaque-origin sandbox, so a message to
// the host is its only way out, and the host checks event.source before believing one. The preview passes it on here,
// with the page's lines where it happened, and the canvas decides what to do with it (pageRepair.ts).

export const PAGE_ERROR_MESSAGE = 'awwo-page-error';

/**
 * Runs first in a running preview (with PREVIEW_VIEWPORT_SCRIPT, htmlDeliverable.ts). Reports the first uncaught script
 * error or unhandled rejection, once. What is not the page's own mistake is left alone: a cross-origin "Script error."
 * with no detail, the browser's ResizeObserver loop notice, a request the preview blocks, a missing WebGL context.
 */
export const PAGE_ERROR_SCRIPT = "(()=>{let sent=0;"
  + "const noise=/^(?:Uncaught )?Script error\\.?$|ResizeObserver loop|Failed to fetch|NetworkError|Load failed|Content Security Policy|WebGL context/i;"
  + "const send=(m,l,c,s)=>{m=String(m||'').slice(0,600);if(sent||!m.trim()||noise.test(m))return;sent=1;"
  + `try{parent.postMessage({type:'${PAGE_ERROR_MESSAGE}',message:m,line:+l||0,column:+c||0,stack:String(s||'').slice(0,1500)},'*')}catch(e){}};`
  + "addEventListener('error',e=>{if(e instanceof ErrorEvent)send(e.message||(e.error&&e.error.message),e.lineno,e.colno,e.error&&e.error.stack)},true);"
  + "addEventListener('unhandledrejection',e=>{const r=e.reason;"
  + "send('Unhandled promise rejection: '+(r&&r.message?(r.name||'Error')+': '+r.message:String(r)),0,0,r&&r.stack)})})();";

/** A page that failed to run, as the preview that showed it saw it. */
export interface PageErrorReport {
  /** The page as delivered (the text the preview was given), so the canvas can find the node that published it. */
  page: string;
  /** The browser's message, e.g. "Uncaught SyntaxError: Identifier 'tokens' has already been declared". */
  message: string;
  /** The page's own code where it happened, as the preview ran it: the reported line first, then the call stack's. */
  lines: string[];
}

/** One line of the running document around a (1-based) column; a long line (a minified library) is cut around it. */
function lineAround(rows: string[], line: number, column: number): string {
  const text = rows[line - 1]?.trim() ?? '';
  if (text.length <= 240) return text;
  const start = Math.max(0, column - 1 - 120);
  return `${start ? '…' : ''}${text.slice(start, start + 240)}…`;
}

/**
 * Read a message a preview's frame posted. `document` is the exact text the frame was given (its line numbers are the
 * ones the browser reports), `page` the delivered page it was built from. Null for anything that is not a report.
 */
export function readPageErrorMessage(data: unknown, document: string, page: string): PageErrorReport | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as { type?: unknown; message?: unknown; line?: unknown; column?: unknown; stack?: unknown };
  if (value.type !== PAGE_ERROR_MESSAGE || typeof value.message !== 'string' || !value.message.trim()) return null;
  const rows = document.split('\n');
  const spots: Array<[number, number]> = [[Number(value.line) || 0, Number(value.column) || 0]];
  for (const match of String(value.stack ?? '').matchAll(/about:srcdoc:(\d+):(\d+)/g)) spots.push([Number(match[1]), Number(match[2])]);
  const lines: string[] = [];
  for (const [line, column] of spots) {
    if (line < 1 || line > rows.length) continue;
    const text = lineAround(rows, line, column);
    if (text && !lines.includes(text)) lines.push(text);
    if (lines.length === 3) break;
  }
  return { page, message: value.message.trim().slice(0, 600), lines };
}

type Listener = (report: PageErrorReport) => void;
const listeners = new Set<Listener>();

/** Hear every page that fails in a preview on this screen. Returns the unsubscribe. */
export function subscribePageErrors(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Called by a preview when its page reported an error. A page nobody published (a homepage case) changes nothing. */
export function reportPageError(report: PageErrorReport): void {
  for (const listener of [...listeners]) {
    try { listener(report); } catch { /* a listener's failure is its own */ }
  }
}
