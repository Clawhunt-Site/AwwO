// Display hygiene for conversational skill creation (A5).
//
// On a create-intent chat turn the runtime streams a raw
// <superclaw_skill_proposal> block (the backend harvests + registers it and the
// chat.completed event carries a sanitized confirmation that replaces the bubble
// text). While the turn is still streaming, the raw block would otherwise show
// in the live message.delta text — fold it to a friendly placeholder so the user
// never sees the raw tags. Handles the in-progress case (open tag, no close yet).

export const SKILL_PROPOSAL_OPEN = '<superclaw_skill_proposal>'
export const SKILL_PROPOSAL_CLOSE = '</superclaw_skill_proposal>'

const PLACEHOLDER = '⏳ Creating ClawHunt skill…'

/**
 * Replace every (possibly still-streaming) skill-proposal block with a
 * placeholder for live display. Returns the text unchanged when no proposal
 * block is present. Apply this at EVERY site that renders accumulated assistant
 * text into a bubble (delta, completed, display-event re-render, stop, fallback)
 * — not just the streaming-delta path — so a raw block never leaks via another
 * render path. Idempotent and safe to call on already-folded text.
 */
export function foldSkillProposalForDisplay(text: string): string {
  if (!text || text.indexOf(SKILL_PROPOSAL_OPEN) === -1) return text
  let out = text
  // Fold each block in turn (a well-behaved turn has one, but never leave a
  // second raw block exposed if the model emits more).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const openIdx = out.indexOf(SKILL_PROPOSAL_OPEN)
    if (openIdx === -1) break
    const before = out.slice(0, openIdx)
    const closeIdx = out.indexOf(SKILL_PROPOSAL_CLOSE, openIdx)
    // No close tag yet (still streaming) → drop everything from the open tag on
    // and stop; otherwise drop the whole block and keep scanning the remainder.
    if (closeIdx === -1) {
      out = `${before}\n\n${PLACEHOLDER}`
      break
    }
    const after = out.slice(closeIdx + SKILL_PROPOSAL_CLOSE.length)
    out = `${before}\n\n${PLACEHOLDER}${after}`
  }
  return out.trim()
}
