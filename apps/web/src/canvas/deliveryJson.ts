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
  const trimmed = text.replace(/[ \t\r\n]+$/, '');
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

/** The JSON source of a node delivery: one Markdown fence removed, then any missing final closers restored. */
export function deliveryJsonSource(output: string): string {
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return closeUnterminatedJsonObject(fenced ? fenced[1] : trimmed);
}
