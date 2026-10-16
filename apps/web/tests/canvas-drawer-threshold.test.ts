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

/** `text` split at its top-level occurrences of `at` (not inside parentheses). */
function splitTop(text: string, at: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth -= 1;
    else if (depth === 0 && at.test(text[i])) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  return [...parts, text.slice(start)].map(part => part.trim()).filter(Boolean);
}

/** The element a compound selector matches, once per alternative of its :is() and :where() groups: an alternative holding
 *  combinators of its own (`:is(.a + .b)`) adds only its own last compound to that element; the rest are its relatives. */
function subjects(compound: string): string[] {
  const open = /:(?:is|where)\(/.exec(compound);
  if (!open) return [compound];
  let depth = 0, end = open.index + open[0].length - 1;
  for (; end < compound.length; end += 1) {
    if (compound[end] === '(') depth += 1;
    else if (compound[end] === ')' && (depth -= 1) === 0) break;
  }
  const inner = compound.slice(open.index + open[0].length, end);
  return splitTop(inner, /,/).flatMap(choice => subjects(compound.slice(0, open.index) + (splitTop(choice, /[\s>+~]/).at(-1) ?? '') + compound.slice(end + 1)));
}

/** Whether a resolved selector can match an opened node's tile: in one of its :is() or :where() alternatives, its
 *  subject (the last compound) names .canvas-tile or .awwo-node, and not a closed card, a form, a display (a preview
 *  window beside the graph, with no workbench) nor a pseudo-element. :not() and :has() only narrow it. */
function isOpenTile(selector: string): boolean {
  return subjects(splitTop(selector, /[\s>+~]/).at(-1) ?? '').some(subject => {
    const own = subject.replace(/:(?:not|has)\((?:[^()]|\([^()]*\))*\)/g, '');
    return /\.(?:canvas-tile|awwo-node)(?![\w-])/.test(own) && !/\.is-compact(?![\w-])|\.canvas-tile--form(?![\w-])|\.awwo-display(?![\w-])|::/.test(own);
  });
}

const BOX_PROPERTY = /^(padding(?:-inline(?:-start|-end)?|-left|-right)?|border(?:-inline(?:-start|-end)?|-left|-right)?(?:-width)?)\s*:\s*(.+)$/;

/** Every padding or border declaration a stylesheet sets on an opened node's tile, nested rules resolved. */
function tileBoxDeclarations(text: string): Array<{ selector: string; property: string; value: string }> {
  const found: Array<{ selector: string; property: string; value: string }> = [];
  const stack: string[][] = [];
  let buffer = '';
  const flush = () => {
    const declaration = BOX_PROPERTY.exec(buffer.trim());
    buffer = '';
    if (!declaration) return;
    for (const selector of stack.at(-1) ?? []) if (isOpenTile(selector)) found.push({ selector, property: declaration[1], value: declaration[2].trim() });
  };
  for (const char of text.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (char === '{') {
      const head = buffer.trim();
      buffer = '';
      const parent = stack.at(-1) ?? [''];
      // Media, container, support and layer blocks pass their selectors through; keyframes and the like hold none.
      if (head.startsWith('@') || parent[0] === '@') { stack.push(!head.startsWith('@') || /^@(?:media|container|supports|layer)\b/.test(head) ? parent : ['@']); continue; }
      stack.push(parent.flatMap(outer => splitTop(head, /,/).map(inner => (inner.includes('&') ? inner.replaceAll('&', outer) : `${outer} ${inner}`).trim())));
    } else if (char === '}') { flush(); stack.pop(); }
    else if (char === ';') flush();
    else buffer += char;
  }
  return found;
}

/** The left and right widths, in px, a padding or border declaration sets (one where it sets one side). A value the
 *  test cannot resolve (var(), calc(), a percentage) reads as NaN, which never equals the chrome expected. */
function inlineWidths(property: string, value: string): number[] {
  const tokens = splitTop(value.replace(/!important/, ''), /\s/);
  const length = (token: string) => (token === '0' ? 0 : /^\d+(?:\.\d+)?px$/.test(token) ? Number.parseFloat(token) : Number.NaN);
  const sides = (values: number[]) => values.length === 1 ? [values[0], values[0]] : values.length === 2 ? [values[1], values[1]]
    : values.length === 3 ? [values[1], values[1]] : [values[1], values[3]];
  if (!property.startsWith('border') || property.endsWith('-width')) {
    const values = tokens.map(length);
    if (property === 'padding' || property === 'border-width') return sides(values);
    if (property === 'padding-inline' || property === 'border-inline-width') return values.length === 1 ? [values[0], values[0]] : values;
    return values.slice(0, 1);
  }
  // A border shorthand: its width (a length, or thin/medium/thick; medium where none is given), 0 where it draws none.
  const keyword: Record<string, number> = { thin: 1, medium: 3, thick: 5 };
  const width = tokens.find(token => /^(?:\d+(?:\.\d+)?px|0)$/.test(token) || token in keyword);
  const each = width !== undefined ? (width in keyword ? keyword[width] : length(width))
    : tokens.some(token => token === 'none' || token === 'hidden') ? 0
      : tokens.some(token => /^(?:var|calc|env)\(/.test(token)) ? Number.NaN : keyword.medium;
  return property === 'border' || property === 'border-inline' ? [each, each] : [each];
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
      const widths = inlineWidths(found.property, found.value);
      const expected = found.property.startsWith('padding') ? 14 : 1;
      expect({ ...found, widths }).toEqual({ ...found, widths: widths.map(() => expected) });
    }
  });

  it('reads the selectors and widths a stylesheet could set the tile’s chrome with', () => {
    // The guard above is only as good as these readings (found in review: :where() and 1px 12px slipped through).
    expect(isOpenTile('.canvas-root :where(.canvas-tile)')).toBe(true);
    expect(isOpenTile('.canvas-root .awwo-node:is(.canvas-tile--open, .canvas-tile--focus):not(:where(.canvas-tile--form))')).toBe(true);
    expect(isOpenTile('.canvas-root .awwo-node:not(.is-compact)')).toBe(true);
    expect(isOpenTile('.canvas-root .canvas-tile:is(.is-compact)')).toBe(false);
    expect(isOpenTile('.canvas-root .awwo-node .canvas-tile-head')).toBe(false);
    expect(isOpenTile('.canvas-root .canvas-tile.awwo-node::before')).toBe(false);
    // An alternative's own combinators decide its subject (found in review).
    expect(isOpenTile('.canvas-root .awwo-node:is(.is-compact + .canvas-tile--focus)')).toBe(true);
    expect(isOpenTile('.canvas-root :is(.awwo-node .canvas-tile-head)')).toBe(false);
    expect(tileBoxDeclarations('.canvas-root { .canvas-tile.awwo-node { &.is-running { padding-inline-start: 2px } } }'))
      .toEqual([{ selector: '.canvas-root .canvas-tile.awwo-node.is-running', property: 'padding-inline-start', value: '2px' }]);
    expect(inlineWidths('padding', '12px 14px')).toEqual([14, 14]);
    expect(inlineWidths('padding', '1px 2px 3px 4px')).toEqual([2, 4]);
    expect(inlineWidths('padding-inline', '14px 20px')).toEqual([14, 20]);
    expect(inlineWidths('border-width', '1px 12px')).toEqual([12, 12]);
    expect(inlineWidths('border', '1px solid var(--line)')).toEqual([1, 1]);
    expect(inlineWidths('border', 'solid red')).toEqual([3, 3]);
    expect(inlineWidths('border', '0')).toEqual([0, 0]);
    expect(inlineWidths('border-left', 'var(--wide) solid')).toEqual([Number.NaN]);
    expect(inlineWidths('padding-inline-start', 'calc(14px + 2px)')).toEqual([Number.NaN]);
  });
});
