// The stage's overlays are laid out by the stylesheets from --awwo-stage-cover: the part of the stage's left edge an
// assistant panel floating over it covers (CanvasSurface measures it, AgentWorkspace sets it on the stage). The run notes
// in the stage's top-left corner, the selection bar at its top centre and the 成果 view sat under the panel (found
// 2026-10-16). jsdom lays nothing out, so this reads the rules: each overlay keeps its place right of the cover, the board
// that Configure lifts over the panel resets it, and the results studio wraps its header on its own width.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(process.cwd(), 'src');
const css = (file: string) => readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The content between the brace at `open` and its match. */
function block(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && (depth -= 1) === 0) return text.slice(open + 1, i);
  }
  throw new Error('unbalanced braces');
}

/** The rules at the top level of `text`, as [selector or at-rule prelude, block]. */
function rules(text: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === ';') { start = i + 1; continue; }
    if (text[i] !== '{') continue;
    const body = block(text, i);
    found.push([squash(text.slice(start, i)), body]);
    i += body.length + 1;
    start = i + 1;
  }
  return found;
}

/** A block's own declarations, property → value (its nested rules left out). */
function own(body: string): Record<string, string> {
  let flat = '', depth = 0;
  for (const ch of body) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (depth === 0) flat += ch;
  }
  const found: Record<string, string> = {};
  for (const declaration of flat.split(';')) {
    const colon = declaration.indexOf(':');
    const property = declaration.slice(0, colon).trim();
    if (colon > 0 && /^(--)?[a-z-]+$/.test(property)) found[property] = squash(declaration.slice(colon + 1));
  }
  return found;
}

/** The declarations of every rule whose selector is exactly `selector`, merged in order: at the stylesheet's top level, or
 *  inside every at-rule block whose prelude is exactly `inside`. */
function declarations(text: string, selector: string, inside?: string): Record<string, string> {
  const scopes = inside ? rules(text).filter(([prelude]) => prelude === inside).map(([, body]) => body) : [text];
  const found: Record<string, string> = {};
  let seen = false;
  for (const scope of scopes) for (const [prelude, body] of rules(scope)) {
    if (prelude !== selector) continue;
    seen = true;
    Object.assign(found, own(body));
  }
  expect(seen, `${selector}${inside ? ` in ${inside}` : ''}`).toBe(true);
  return found;
}

const COVER = 'var(--awwo-stage-cover, 0px)';

describe('the stage overlays lay themselves out right of an assistant panel floating over the stage', () => {
  it('moves the run notes right of the cover, no wider than the stage beside it', () => {
    const note = declarations(css('canvas/awwo-workspace.css'), '.awwo-handoff-note');
    expect([note.left, note['margin-left'], note['max-width']]).toEqual(['24px', COVER, `min(440px, calc(100% - 48px - ${COVER}))`]);
  });

  it('centres the selection bar on the part of the stage the panel leaves', () => {
    const sheet = css('canvas/selectionCollaboration.css');
    const bar = declarations(sheet, '.canvas-root .awwo-selection-collaboration');
    expect([bar.left, bar.transform, bar['margin-left'], bar['max-width']])
      .toEqual(['50%', 'translateX(-50%)', `calc(${COVER} / 2)`, `calc(100% - 32px - ${COVER})`]);
    expect(declarations(sheet, '.canvas-root .awwo-selection-collaboration', '@media (max-width: 600px)').width)
      .toBe(`calc(100% - 32px - ${COVER})`);
  });

  it('starts the 成果 view’s content right of the cover, its background under the panel', () => {
    // The view keeps the whole stage (the panel fades in over the view's own background, not over the board: found in
    // review), and every padding it is given keeps the cover on its left.
    const sheet = css('canvas/canvas-results.css');
    const results = declarations(sheet, '.awwo-results');
    expect([results.position, results.inset, results.padding]).toEqual(['absolute', '0', `22px 24px 32px calc(24px + ${COVER})`]);
    expect(declarations(sheet, '.awwo-results.is-studio').padding).toBe(`14px 16px 16px calc(16px + ${COVER})`);
    expect(declarations(sheet, '.awwo-results', '@media (max-width: 760px)').padding).toBe(`14px 12px 24px calc(12px + ${COVER})`);
    const paddings = [...rules(sheet), ...rules(sheet).flatMap(([, body]) => rules(body))]
      .filter(([selector]) => /^\.awwo-results(\.is-studio)?$/.test(selector)).map(([, body]) => own(body).padding).filter(Boolean);
    expect(paddings).toHaveLength(3);
    for (const padding of paddings) expect(padding).toContain(`+ ${COVER})`);
  });

  it('leaves the board’s notes and selection bar where they are while Configure lifts the board over the panel', () => {
    const sheet = css('canvas/awwo-workspace.css');
    const lifted = '.saas-canvas-shell .awwo-stage-canvas:has(.canvas-root > .canvas-inspector):not(:has(> .awwo-results))';
    expect(declarations(sheet, lifted, '@media (max-width: 900px)')['z-index']).toBe('31');
    expect(declarations(sheet, `${lifted} > .canvas-root`, '@media (max-width: 900px)')['--awwo-stage-cover']).toBe('0px');
  });

  it('wraps the results studio’s header on the studio’s own width, not the window’s', () => {
    const sheet = css('canvas/studio/studio.css');
    const narrow = '@container awwo-studio (max-width: 760px)';
    expect(declarations(sheet, '.awwo-studio').container).toBe('awwo-studio / inline-size');
    expect(declarations(sheet, '.awwo-studio-header', narrow)['flex-wrap']).toBe('wrap');
    expect([declarations(sheet, '.awwo-studio-file', narrow).order, declarations(sheet, '.awwo-studio-action span, .awwo-studio-title span', narrow).display])
      .toEqual(['3', 'none']);
    // The file tree, too, lies over the file in a narrow studio, at most 86 % of its width (owner 2026-10-16: 「把文件树也改成
    // 按工作台宽度」; DeliverableStudio starts it closed there, canvas-studio-tree.test.tsx).
    const tree = declarations(sheet, '.awwo-studio-tree', narrow);
    expect([tree.position, tree.inset, tree.width]).toEqual(['absolute', '0 auto 0 0', 'min(320px, 86%)']);
    // After the header's own rules, which it overrides at the same specificity (found in review).
    const query = sheet.indexOf(narrow);
    for (const base of ['.awwo-studio-header {', '.awwo-studio-file {', '.awwo-studio-title {', '.awwo-studio-tree {']) {
      expect(sheet.indexOf(base), base).toBeGreaterThanOrEqual(0);
      expect(sheet.indexOf(base), base).toBeLessThan(query);
    }
    // The window's own breakpoint keeps only what belongs to a narrow window: the full-screen dialog.
    const windowRules = rules(sheet).filter(([prelude]) => prelude === '@media (max-width: 760px)').flatMap(([, body]) => rules(body).map(([selector]) => selector));
    expect(windowRules).not.toContain('.awwo-studio-header');
    expect(windowRules).not.toContain('.awwo-studio-tree');
    expect(windowRules).toContain('.awwo-studio-dialog');
  });
});
