// The pages an Agent invited to the canvas hands in (多人同屏): a node's result it wrote over MCP. The server keeps such a
// result as handed in by that Agent (canvas_change_write.go: source "manual", by {kind: "agent", name}), and it reaches
// a viewer's browser as the Agent wrote it, never through AwwO's engine. So it is held as a market Agent's page is
// (marketPages.ts; the owner's choice, 2026-11-08): it shows still, its scripts not run, until its reader chooses to run
// it, for that delivery and where it is shown, and running it loads pictures and media by URL only from the CDNs
// (studio/liveDocument.ts MARKET_PAGE_CSP). A run, or a person's own publication, replaces the result and the hold with
// it.
//
// Not held: a run's result made from words an Agent wrote, once a person runs it. A session's run reads a hand-in as its
// input (as it reads a person's), and an assemble node copies its inputs and its template into its page as they are: a
// hand-in wired into one, or a template, form fields or a persona an Agent wrote, come out as an ordinary run's result.
// The canvas records no writer of a template, a form's fields or a persona, so holding only the wired hand-in would
// leave the same page one template away; closing these takes the server marking such nodes
// (docs/awwo-canvas-live-collaboration.md, "An agent's page").
import { sanitizeOutputAuthor } from './canvasDoc';

/** The name of the Agent that handed a result in ('' where it has none), or undefined for any other result. Reads a
 *  result as a page holds it or as a run's admitted canvas does (the server's own record). */
export function handedInBy(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const { source, by } = output as { source?: unknown; by?: unknown };
  return source === 'manual' ? sanitizeOutputAuthor(by)?.name : undefined;
}

/** Every control character, and the invisible ones that would change or hide what a sentence around a name shows:
 *  direction marks, embeddings, overrides and isolates, zero-width spaces and joiners, line and paragraph separators, tags. */
const UNSHOWN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

/** An Agent's name as a sentence shows it ('' where nothing of it can be shown). */
export function agentDisplayName(name: string): string {
  return name.replace(UNSHOWN, '').trim();
}
