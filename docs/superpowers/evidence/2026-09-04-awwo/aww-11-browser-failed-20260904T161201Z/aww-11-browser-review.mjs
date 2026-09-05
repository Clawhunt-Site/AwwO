/** Independent review harness; reads the delivered fixture without changing it.
 * Requires a permitted browser execution environment and @playwright/test.
 * AWW11_PLAYWRIGHT_MODULE can point at an existing installation.
 * This harness has only been syntax-checked in the current restricted runtime.
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.env.AWW11_REVIEW_ROOT || workspace);
const out = path.join(workspace, 'artifacts', 'aww-11-browser-evidence');
await mkdir(out, { recursive: true });
const report = { checkedAt: new Date().toISOString(), checks: [], hashes: {}, browser: null, limitation: 'Fixture checks only; no screen reader or integrated application acceptance.' };
const check = (name, passed, details) => report.checks.push({ name, passed, details });
const files = new Map();
for (const name of ['tests/responsive-accessibility.html', 'src/styles.css', 'styles.css', 'src/accessibility.js']) {
  const data = await readFile(path.join(root, name));
  files.set(`/${name}`, data);
  report.hashes[name] = createHash('sha256').update(data).digest('hex');
}
const server = createServer((request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname;
  const data = files.get(name);
  response.writeHead(data ? 200 : 404, { 'Content-Type': name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
  response.end(data || 'Not found');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/tests/responsive-accessibility.html`;
let browser;
try {
  const { chromium } = require(process.env.AWW11_PLAYWRIGHT_MODULE || '@playwright/test');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  report.browser = browser.version();
  const page = await browser.newPage();
  page.on('pageerror', error => check('Uncaught page error', false, error.message));
  const load = async () => { await page.goto(url); await page.waitForFunction(() => window.fixtureReady); };
  const geometry = () => page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await load();
    const bounds = await geometry();
    check(`Page reflow ${width}px`, bounds.scrollWidth <= bounds.viewport + 1, bounds);
    await page.screenshot({ path: path.join(out, `fixture-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await load();
  await page.addStyleTag({ content: ':root { font-size: 200% !important; }' });
  const enlarged = await geometry();
  check('320px with 200% root font stress (not browser zoom)', enlarged.scrollWidth <= enlarged.viewport + 1, enlarged);
  await page.screenshot({ path: path.join(out, 'fixture-320-root-font-200.png'), fullPage: true });
  await load();
  await page.keyboard.press('Tab');
  check('First Tab reaches skip link', await page.locator('.skip-link').evaluate(el => el === document.activeElement));
  await page.keyboard.press('Enter');
  check('Skip link transfers focus', await page.locator('#main-content').evaluate(el => el === document.activeElement));
  const focusByTab = async (selector) => {
    for (let i = 0; i < 60; i++) {
      if (await page.locator(selector).evaluate(el => el === document.activeElement)) return true;
      await page.keyboard.press('Tab');
    }
    return false;
  };
  check('Help trigger keyboard reachable', await focusByTab('[data-dialog-open]'));
  await page.keyboard.press('Enter');
  check('Help opens as modal', await page.locator('#help-dialog').evaluate(el => el.matches(':modal')));
  let contained = true;
  for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    contained &&= await page.locator('#help-dialog').evaluate(el => el.contains(document.activeElement));
  }
  check('Modal contains keyboard focus', contained);
  await page.keyboard.press('Escape');
  check('Escape closes and restores trigger', await page.locator('[data-dialog-open]').evaluate(el => !document.querySelector('#help-dialog').open && el === document.activeElement));
  await page.getByRole('button', { name: '验证表单', exact: true }).click();
  check('Invalid title focused and described', await page.locator('#title').evaluate(el => el === document.activeElement && el.getAttribute('aria-invalid') === 'true' && el.getAttribute('aria-describedby').includes('title-error') && !document.querySelector('#title-error').hidden));
  await page.getByLabel('关键词', { exact: true }).fill('知识');
  await page.getByRole('button', { name: '搜索文档', exact: true }).click();
  check('Status region updates', (await page.locator('#app-status').textContent()).includes('示例检索已完成'));
  await writeFile(path.join(out, 'fixture-aria.txt'), await page.locator('body').ariaSnapshot());
  await page.emulateMedia({ forcedColors: 'active' });
  await load();
  const current = page.locator('[aria-current="page"]');
  const outline = () => current.evaluate(el => { const s = getComputedStyle(el); return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, offset: s.outlineOffset }; });
  const before = await outline();
  const reached = await focusByTab('[aria-current="page"]');
  const after = await outline();
  check('Forced colors current-link focus outline changes', reached && JSON.stringify(before) !== JSON.stringify(after), { before, after, focusVisible: await current.evaluate(el => el.matches(':focus-visible')) });
  await page.screenshot({ path: path.join(out, 'forced-colors-current-focus.png'), fullPage: true });
  report.checkboxLayout = await page.locator('.checkbox-label').evaluate(el => ({ labelDisplay: getComputedStyle(el).display, labelWidth: el.clientWidth, checkboxWidth: el.querySelector('input').getBoundingClientRect().width }));
} catch (error) {
  report.executionError = { name: error.name, message: error.message };
  process.exitCode = 2;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');
}
if (report.checks.some(result => !result.passed)) process.exitCode ||= 1;
console.log(JSON.stringify(report, null, 2));
