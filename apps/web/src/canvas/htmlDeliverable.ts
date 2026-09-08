/** Strip only a complete HTML fence; preserve every byte of the document inside it. */
export function htmlDocumentSource(value: string): string {
  const fenced = value.trim().match(/^```html[\t ]*\r?\n([\s\S]*?)\r?\n```$/i);
  return fenced ? fenced[1] : value;
}

/**
 * Require an explicit HTML document, not a path, prose, fragment, or an example in a comment.
 * This is a document-shape gate, not a browser conformance validator. No DOM is constructed:
 * untrusted script, image, and iframe content must not execute or load during validation.
 */
export function isCompleteHtmlDocument(value: string): boolean {
  const source = htmlDocumentSource(value).trim().replace(/^\uFEFF/, '');
  if (!source || source.includes('\u0000')) return false;
  let remaining = source;
  type Phase = 'before' | 'html' | 'head' | 'after-head' | 'body' | 'after-body' | 'done';
  let phase: Phase = 'before';
  let doctype = false;
  while (remaining) {
    const textEnd = remaining.indexOf('<');
    const text = textEnd < 0 ? remaining : remaining.slice(0, textEnd);
    if (text.trim() && phase !== 'head' && phase !== 'body') return false;
    if (textEnd < 0) return phase === 'done';
    remaining = remaining.slice(textEnd);
    const comment = remaining.match(/^<!--[\s\S]*?-->/);
    if (comment) { remaining = remaining.slice(comment[0].length); continue; }
    const declaration = remaining.match(/^<!doctype\s+html\s*>/i);
    if (declaration) {
      if (phase !== 'before' || doctype) return false;
      doctype = true;
      remaining = remaining.slice(declaration[0].length);
      continue;
    }
    // Quoted attributes may contain angle brackets. They are never interpreted as structure.
    const tag = remaining.match(/^<(\/?)([a-z][a-z0-9:-]*)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/i);
    if (!tag) return false;
    const [whole, closing, rawName] = tag;
    const name = rawName.toLowerCase();
    remaining = remaining.slice(whole.length);
    if (name === 'html' || name === 'head' || name === 'body') {
      if (/\/\s*>$/.test(whole)) return false;
      const transition: string = `${phase}:${closing ? '/' : ''}${name}`;
      const next: Record<string, Phase> = {
        'before:html': 'html', 'html:head': 'head', 'head:/head': 'after-head',
        'after-head:body': 'body', 'body:/body': 'after-body', 'after-body:/html': 'done',
      };
      if (!Object.hasOwn(next, transition)) return false;
      phase = next[transition];
      continue;
    }
    if (phase !== 'head' && phase !== 'body') return false;
    if (!closing && /^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)$/.test(name)) {
      // These elements can contain tag-like strings that must not satisfy the document gate.
      const end = remaining.match(new RegExp(`</${name}\\s*>`, 'i'));
      if (!end || end.index === undefined) return false;
      remaining = remaining.slice(end.index + end[0].length);
    }
  }
  return phase === 'done';
}

/** Export the verified response content. A saved file reference is never read by this helper. */
export function downloadTextDeliverable(value: string, name: string, type: 'html' | 'markdown'): void {
  const extension = type === 'html' ? 'html' : 'md';
  const basename = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/\.(?:html?|md)$/i, '')
    .trim().replace(/[. ]+$/, '').slice(0, 120) || 'deliverable';
  const source = type === 'html' ? htmlDocumentSource(value) : value;
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  const url = URL.createObjectURL(new Blob([source], { type: type === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = `${basename}.${extension}`;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => revokeObjectURL(url), 1000);
  }
}
