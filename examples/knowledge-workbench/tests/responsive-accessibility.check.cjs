/* Browser acceptance for the isolated component fixture, not the application. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const evidence = path.join(root, 'artifacts', 'responsive-browser-checks.json');
const result = { scope: 'component fixture only', checkedAt: new Date().toISOString(), checks: [], screenshots: [], hashes: {} };
for (const file of ['styles.css', 'src/styles.css', 'src/accessibility.js', 'tests/responsive-accessibility.html']) {
  result.hashes[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
}
let browser;
let server;
let phase = 'setup';
const check = (name, detail) => result.checks.push({ name, status: 'passed', detail });
(async () => {
  let playwright;
  if (process.env.PLAYWRIGHT_MODULE) playwright = require(process.env.PLAYWRIGHT_MODULE);
  else {
    try { playwright = require('@playwright/test'); }
    catch { playwright = require(path.join(process.env.APPDATA || '', 'npm/node_modules/@playwright/test')); }
  }
  // Exact allowlist keeps the temporary loopback server from exposing workspace files.
  const allowed = new Map([
    ['/tests/responsive-accessibility.html', 'text/html; charset=utf-8'],
    ['/src/styles.css', 'text/css; charset=utf-8'],
    ['/styles.css', 'text/css; charset=utf-8'],
    ['/src/accessibility.js', 'text/javascript; charset=utf-8'],
  ]);
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!allowed.has(url.pathname)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': allowed.get(url.pathname), 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(root, url.pathname.slice(1))));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  phase = 'browser-launch';
  browser = await playwright.chromium.launch({ headless: true });
  result.browser = browser.version();
  phase = 'browser-assertions';
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/tests/responsive-accessibility.html`);
  await page.waitForFunction(() => window.fixtureReady === true);
  for (const [width, height] of [[320, 740], [375, 812], [768, 1024], [1280, 800], [1920, 1080], [667, 375]]) {
    await page.setViewportSize({ width, height });
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    assert.ok(size.scroll <= size.viewport + 1, `Page overflow at ${width}: ${JSON.stringify(size)}`);
    check(`reflow-${width}x${height}`, size);
    const small = await page.locator('button:visible, input:not([type=checkbox]):visible, select:visible, .sidebar nav a:visible').evaluateAll(nodes => nodes.filter(node => {
      const rect = node.getBoundingClientRect(); return rect.width < 43.5 || rect.height < 43.5;
    }).map(node => node.outerHTML));
    assert.deepEqual(small, [], `Touch targets at ${width}`);
    check(`targets-${width}x${height}`, 'Visible primary controls at least 44 CSS px');
    if ([375, 1280].includes(width)) {
      const file = `responsive-fixture-${width}.png`;
      await page.screenshot({ path: path.join(root, 'artifacts', file), fullPage: true });
      result.screenshots.push(file);
    }
  }
  await page.setViewportSize({ width: 320, height: 740 });
  await page.addStyleTag({ content: 'body.a11y-fixture { font-size: 200%; } .a11y-fixture :is(h1,h2,h3,p,a,label,small,button,input,select,textarea,.badge) { font-size: inherit; }' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), '200% text reflow');
  check('200-percent-text-stress', '320 CSS px viewport, doubled inherited fixture text; not a real browser zoom test');
  await page.reload();
  await page.waitForFunction(() => window.fixtureReady);
  await page.keyboard.press('Tab');
  await playwright.expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Enter');
  await playwright.expect(page.locator('#main-content')).toBeFocused();
  check('skip-link', 'First Tab and Enter move focus to main');
  const opener = page.locator('[data-dialog-open]');
  await opener.focus();
  await page.keyboard.press('Enter');
  await playwright.expect(page.locator('dialog')).toBeVisible();
  for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    assert.ok(await page.evaluate(() => !!document.activeElement.closest('dialog')), `${key} leaves dialog`);
  }
  await page.keyboard.press('Escape');
  await playwright.expect(opener).toBeFocused();
  check('dialog-keyboard', 'Tab containment, Escape close, opener restoration');
  await opener.click();
  await page.locator('[data-dialog-close]').click();
  await playwright.expect(opener).toBeFocused();
  await opener.click();
  await opener.evaluate(node => node.remove());
  await page.keyboard.press('Escape');
  await playwright.expect(page.locator('#main-content')).toBeFocused();
  check('dialog-removed-opener', 'Fallback focus to main');
  await page.locator('#query').fill('项目');
  await page.locator('#category').selectOption({ label: '项目协作' });
  await page.locator('#workspace').selectOption({ label: '客户成功' });
  await playwright.expect(page.locator('#query')).toHaveValue('项目');
  await playwright.expect(page.locator('#category')).toHaveValue('项目协作');
  await page.locator('#search-form button').click();
  await playwright.expect(page.locator('#app-status')).toContainText('示例检索已完成');
  check('status-and-filter-fixture', 'Fixture retains inputs and updates existing status node; no business switch tested');
  await page.locator('#metadata-form button').click();
  await playwright.expect(page.locator('#title')).toBeFocused();
  await playwright.expect(page.locator('#title')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#title').fill('验收文档');
  await page.locator('#metadata-form button').click();
  await playwright.expect(page.locator('#title-error')).toBeHidden();
  check('form-error', 'Invalid field focus, error association and correction');
  const checkboxWidth = await page.locator('input[type=checkbox]').evaluate(node => node.getBoundingClientRect().width);
  assert.ok(checkboxWidth <= 24, 'Checkbox stretched across label');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.spinner').evaluate(node => getComputedStyle(node).animationName), 'none');
  check('reduced-motion', 'Spinner animation disabled');
  await page.emulateMedia({ forcedColors: 'active' });
  await page.locator('#query').focus();
  assert.notEqual(await page.locator('#query').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
  check('forced-colors', 'Focused control retains outline');
  assert.deepEqual(errors, [], 'Browser JavaScript errors');
  result.status = 'passed';
})().catch(error => {
  result.status = ['setup', 'browser-launch'].includes(phase) ? 'blocked' : 'failed';
  result.phase = phase;
  result.error = error.message;
  process.exitCode = result.status === 'blocked' ? 2 : 1;
}).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(evidence, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, checks: result.checks.length, evidence }));
});
