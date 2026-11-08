/** A delivery object nests a file object or a list a few levels deep at most, so needing more
 * closers than this means the text is not the defect repaired below. */
const MAX_RESTORED_CLOSERS = 8;

/**
 * Restores the one defect models make on long deliveries: a JSON object that is complete except
 * for its final closing brackets. Mirrors closeUnterminatedJSONObject on the server, so the canvas
 * and the server accept exactly the same text. Anything else is returned unchanged and still fails:
 * text that ends inside a string, after a separator, key, number or literal (whose last characters
 * may be the missing part), that closes early, or that would need more than a few closers.
 */
export function closeUnterminatedJsonObject(text: string): string {
  if (!text.startsWith('{')) return text;
  const open: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') open.push('}');
    else if (c === '[') open.push(']');
    else if (c === '}' || c === ']') {
      // A balanced object (valid or not) is never this defect; neither is a mismatched closer.
      if (open.pop() !== c || !open.length) return text;
    }
  }
  if (inString || !open.length || open.length > MAX_RESTORED_CLOSERS) return text;
  // Trailing spaces, tabs and line breaks dropped from the end, as the server's strings.TrimRight(text, " \t\r\n"): the
  // regex /[ \t\r\n]+$/ this replaces tried every whitespace run in the text, quadratic in a long one (review, 2026-11-08).
  let cut = text.length;
  while (cut > 0 && ' \t\r\n'.includes(text[cut - 1])) cut -= 1;
  const trimmed = text.slice(0, cut);
  const last = trimmed[trimmed.length - 1];
  if (last !== '"' && last !== '}' && last !== ']') return text;
  const restored = trimmed + open.reverse().join('');
  try {
    JSON.parse(restored);
    return restored;
  } catch {
    return text;
  }
}

/**
 * The JSON source of a node delivery: one Markdown fence removed, then any missing final closers restored. The fence is
 * read by position: an opening and a closing fence at the two ends of the trimmed text, a "json" (in any case) after the
 * opening one dropped, the rest trimmed. That is what `^```(?:json)?\s*([\s\S]*?)\s*```$` read, which backtracked
 * quadratically on a run of blank lines after an opening fence that never closes (2,000 of them took 0.8 s, found by a
 * review on 2026-11-08); this runs on every delivery, card summary and page repair reply.
 */
export function deliveryJsonSource(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length < 6 || !trimmed.startsWith('```') || !trimmed.endsWith('```')) return closeUnterminatedJsonObject(trimmed);
  const inner = trimmed.slice(3, -3);
  return closeUnterminatedJsonObject((/^json/i.test(inner) ? inner.slice(4) : inner).trim());
}
