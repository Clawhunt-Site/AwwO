// A sign-in result's card (SSOFailure: waitlisted, email_unverified, …) after the 2026-11-08 signed-in check's review:
// its two actions are one size, the sign-in card's pill, and its way back is the card's quiet link. The first action
// is `a.saas-primary.saas-sso-action`, whose a.saas-primary rule keeps the control height and the small type; the
// second, a bare `.saas-sso-action`, took the 46 px and the larger type the class asks for. Measured in Chrome on both
// builds (before 36 px / 46 px and #0000EE; after 36 px each and the accent).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/saas/design/system.css'), 'utf8');

function rule(selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

it('gives a sign-in result both actions at the control height, with no vertical padding, in the small type', () => {
  const body = rule('.saas-sso-layout .saas-card > a.saas-sso-action {');
  expect(body).toContain('min-height: var(--saas-control)');
  expect(body).toContain('padding-block: 0');
  expect(body).toContain('font-size: var(--saas-text-sm)');
  // It must outweigh a.saas-primary (0,1,1) and the bare class's own 46 px rule: three classes and a type.
  expect('.saas-sso-layout .saas-card > a.saas-sso-action'.match(/\./g)?.length).toBe(3);
});

it('draws the way back as the sign-up link is drawn, in the accent, centred', () => {
  const selector = '.saas-login .saas-card > a.saas-sso-signup, .saas-login .saas-card > a.saas-sso-back {';
  const body = rule(selector);
  expect(body).toContain('color: var(--saas-accent)');
  expect(body).toContain('align-self: center');
  expect(body).toContain('font-weight: 600');
});
