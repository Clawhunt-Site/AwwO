// The width at which an opened node holds its delivery drawer beside its conversation is decided twice: in script
// (DRAWER_BESIDE_MIN_WIDTH, on the tile's outer width, deciding whether the drawer opens by itself) and in the
// stylesheet (the workbench's container query, on its content width, deciding where the drawer goes). They drifted
// apart by the tile's padding and border (2026-10-16: a 750 px frame opened its delivery by itself over the
// conversation), so this reads the stylesheets and keeps them in step with the constant.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DRAWER_BESIDE_MIN_WIDTH } from '../src/canvas/nodePresentation';

const SRC = resolve(process.cwd(), 'src');
const css = (file: string) => readFileSync(join(SRC, file), 'utf8');

/** A selector list split at its top-level commas (not those inside `:is(...)`). */
function splitList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '(') depth += 1;
    else if (list[i] === ')') depth -= 1;
    else if (list[i] === ',' && depth === 0) { parts.push(list.slice(start, i).trim()); start = i + 1; }
  }
  return [...parts, list.slice(start).trim()].filter(Boolean);
}

/** Whether a resolved selector's subject is an opened node's tile: its last compound names .canvas-tile or .awwo-node,
 *  and neither a closed card, a form, a display (a preview window beside the graph, with no workbench) nor a
 *  pseudo-element. */
function isOpenTile(selector: string): boolean {
  let depth = 0, start = 0;
  for (let i = 0; i < selector.length; i += 1) {
    if (selector[i] === '(') depth += 1;
    else if (selector[i] === ')') depth -= 1;
    else if (depth === 0 && /[\s>+~]/.test(selector[i])) start = i + 1;
  }
  const subject = selector.slice(start);
  const own = subject.replace(/:(?:not|is|where|has)\([^)]*\)/g, '');
  return /\.(?:canvas-tile|awwo-node)(?![\w-])/.test(own) && !/\.is-compact(?![\w-])|\.canvas-tile--form(?![\w-])|\.awwo-display(?![\w-])|::/.test(own);
}

/** Every padding or border declaration a stylesheet sets on an opened node's tile, nested rules resolved. */
function tileBoxDeclarations(text: string): Array<{ selector: string; property: string; value: string }> {
  const found: Array<{ selector: string; property: string; value: string }> = [];
  const stack: string[][] = [];
  let buffer = '';
  const flush = () => {
    const declaration = /^(padding(?:-inline|-left|-right)?|border(?:-width|-inline|-inline-width|-left|-right|-left-width|-right-width)?)\s*:\s*(.+)$/.exec(buffer.trim());
    buffer = '';
    if (!declaration) return;
    for (const selector of stack.at(-1) ?? []) if (isOpenTile(selector)) found.push({ selector, property: declaration[1], value: declaration[2].trim() });
  };
  for (const char of text.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (char === '{') {
      const head = buffer.trim();
      buffer = '';
      const parent = stack.at(-1) ?? [''];
      // Media, container and support queries pass their selectors through; keyframes and the like hold none.
      if (head.startsWith('@') || parent[0] === '@') { stack.push(!head.startsWith('@') || /^@(?:media|container|supports|layer)\b/.test(head) ? parent : ['@']); continue; }
      stack.push(parent.flatMap(outer => splitList(head).map(inner => (inner.includes('&') ? inner.replaceAll('&', outer) : `${outer} ${inner}`).trim())));
    } else if (char === '}') { flush(); stack.pop(); }
    else if (char === ';') flush();
    else buffer += char;
  }
  return found;
}

/** The inline (left and right) widths a padding or border declaration gives, in px. */
function inlineWidths(property: string, value: string): number[] {
  const px = (token: string) => (token === '0' || token === 'none' ? 0 : Number.parseFloat(token));
  if (property.startsWith('border')) {
    const width = value.split(/\s+/).find(token => /^(?:\d+(?:\.\d+)?px|0|none)$/.test(token));
    return width === undefined ? [] : [px(width)];
  }
  const tokens = value.split(/\s+/);
  if (property !== 'padding') return tokens.map(px);
  return [px(tokens[{ 1: 0, 2: 1, 3: 1, 4: 1 }[tokens.length] ?? 1]), px(tokens[{ 1: 0, 2: 1, 3: 1, 4: 3 }[tokens.length] ?? 1])];
}

describe('the delivery drawer beside the conversation', () => {
  it('opens by itself only where the stylesheet lays it beside the conversation', () => {
    const breakpoint = Number(/@container awwo-workbench \(max-width: (\d+)px\)/.exec(css('canvas/awwo-node.css'))?.[1]);
    const tile = /\.canvas-root \.canvas-tile \{([^}]*)\}/.exec(css('canvas/canvas.css'))?.[1] ?? '';
    const padding = Number(/padding: \d+px (\d+)px;/.exec(tile)?.[1]);
    const border = Number(/border: (\d+)px solid/.exec(tile)?.[1]);
    expect(breakpoint).toBe(739);
    expect([padding, border]).toEqual([14, 1]);
    // The narrowest workbench the stylesheet lays the drawer beside, plus the tile's chrome on both sides.
    expect(DRAWER_BESIDE_MIN_WIDTH).toBe(breakpoint + 1 + 2 * (padding + border));
  });

  it('keeps that chrome wherever a stylesheet sets an opened tile’s padding or border, in either look', () => {
    const sheets = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.css'));
    const declarations = sheets.flatMap(file => tileBoxDeclarations(css(file)).map(found => ({ file: file.replaceAll('\\', '/'), ...found })));
    // The base rule and the hosted look's own border are among them.
    expect(declarations).toContainEqual(expect.objectContaining({ file: 'canvas/canvas.css', selector: '.canvas-root .canvas-tile', property: 'padding' }));
    expect(declarations).toContainEqual(expect.objectContaining({ file: 'saas/design/canvas.css', property: 'border' }));
    for (const found of declarations) {
      const expected = found.property.startsWith('padding') ? 14 : 1;
      expect({ ...found, widths: inlineWidths(found.property, found.value) }).toEqual({ ...found, widths: inlineWidths(found.property, found.value).map(() => expected) });
    }
  });
});
