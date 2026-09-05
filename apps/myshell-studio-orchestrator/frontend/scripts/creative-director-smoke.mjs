import assert from 'node:assert/strict';

import { chromium } from 'playwright';

const baseUrl = String(process.env.STUDIO_FRONTEND_URL || 'http://127.0.0.1:5174').replace(/\/$/, '');
const screenshotPath = String(process.env.CREATIVE_DIRECTOR_SMOKE_SCREENSHOT || '').trim();
const chromiumExecutable = String(process.env.STUDIO_FRONTEND_CHROMIUM_EXECUTABLE_PATH || '').trim();
const browser = await chromium.launch({
  headless: true,
  ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(10_000);
const pageErrors = [];

page.on('pageerror', (error) => pageErrors.push(error.message));
await page.addInitScript(() => {
  window.localStorage.setItem('dp_age_gate_passed', '1');
  window.localStorage.removeItem('superclaw.creative-canvas.document.v1');
});

try {
  console.log('1/8 open CanvasPro workspace');
  await page.goto(`${baseUrl}/dreamy?workspace=canvaspro`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('canvaspro-workspace-panel').waitFor({ state: 'visible' });
  const iframe = page.getByTestId('canvaspro-iframe');
  await iframe.waitFor({ state: 'visible' });
  const canvasProSrc = await iframe.getAttribute('src');

  console.log('2/8 switch to Creative Director and add five nodes');
  await page.getByTestId('creative-director-workspace-switch').click();
  await page.getByTestId('creative-director-workspace-panel').waitFor({ state: 'visible' });
  assert.match(page.url(), /[?&]workspace=creative-director(?:&|$)/);

  const toolrail = page.locator('.creative-toolrail');
  await toolrail.waitFor({ state: 'visible' });
  for (const [label, nodeClass] of [
    ['AI 剧本导演台', 'script-director'],
    ['分镜生成', 'storyboard'],
    ['3D 导演台', 'director-3d'],
    ['VR360 全景', 'vr360'],
    ['姿势编辑器', 'pose'],
  ]) {
    const nodes = page.locator(`.creative-node--${nodeClass}`);
    const before = await nodes.count();
    const tool = toolrail.getByRole('button').filter({ hasText: label });
    assert.equal(await tool.count(), 1, `${label} should have exactly one toolbar button`);
    await tool.click();
    await assertEventually(
      async () => (await nodes.count()) === before + 1,
      `${label} did not add a node; before=${before}; after=${await nodes.count()}; pageErrors=${pageErrors.join(' | ')}`,
    );
  }

  console.log('3/8 verify script director');
  await page.locator('.script-director-open').first().click();
  const scriptDialog = page.getByRole('dialog', { name: 'AI 剧本导演台' });
  await scriptDialog.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.creative-app-shell').getAttribute('inert'), '');
  await scriptDialog.getByLabel('剧本正文').fill('女导演走进废弃车站，发现录音机仍在播放；灯光熄灭后，她看见远处有人招手。');
  await scriptDialog.locator('.script-input-panel').getByRole('button', { name: /智能拆分/ }).click();
  await scriptDialog.getByRole('status').waitFor({ state: 'visible' });
  const scriptPrompt = await scriptDialog.locator('.seedance-prompt-textarea').first().inputValue();
  assert.match(scriptPrompt, /音效：/);
  await scriptDialog.getByRole('button', { name: '退出导演台' }).click();
  assert.equal(await page.locator('.creative-app-shell').getAttribute('inert'), null);

  console.log('4/8 verify 3D director');
  await page.locator('.director-3d-open').first().click();
  const directorDialog = page.getByRole('dialog', { name: /3D 导演台/ });
  await directorDialog.waitFor({ state: 'visible' });
  await directorDialog.getByRole('button', { name: /接 AI 视频/ }).click();
  const directorPrompt = await directorDialog.locator('.director-video-prompt-panel textarea').inputValue();
  assert.match(directorPrompt, /音效：/);
  await directorDialog.getByRole('button', { name: '退出' }).click();

  console.log('5/8 verify VR360 references');
  const vrNode = page.locator('.creative-node--vr360').first();
  await vrNode.getByRole('button', { name: '12 宫格参考' }).click();
  await vrNode.getByLabel('12 个视角参考').waitFor({ state: 'visible' });

  console.log('6/8 verify storyboard generation');
  const storyboardNode = page.locator('.creative-node--storyboard').first();
  await storyboardNode.locator('.cc-field textarea').fill('雨夜车站，人物发现隐藏的录音。');
  await storyboardNode.getByRole('button', { name: '生成镜头卡' }).click();
  assert.equal(await storyboardNode.locator('.story-frame').count(), 4);

  console.log('7/8 verify pose editor save');
  await page.locator('.creative-node--pose').first().getByRole('button', { name: '进入动作编辑' }).click();
  const poseDialog = page.getByRole('dialog', { name: '姿势编辑器' });
  await poseDialog.waitFor({ state: 'visible' });
  await poseDialog.getByLabel('锁人物姿态').check();
  await poseDialog.getByRole('button', { name: '保存骨架图' }).click();
  await poseDialog.waitFor({ state: 'detached' });

  console.log('8/8 return to CanvasPro');
  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });

  await page.getByTestId('canvaspro-workspace-switch').click();
  await iframe.waitFor({ state: 'visible' });
  assert.equal(await iframe.getAttribute('src'), canvasProSrc);
  assert.match(page.url(), /[?&]workspace=canvaspro(?:&|$)/);
  assert.deepEqual(pageErrors, []);

  console.log(JSON.stringify({
    status: 'ok',
    checks: [
      'CanvasPro primary workspace preserved',
      'five Creative Director node types add successfully',
      'script director creates Seedance prompts with sound cues',
      '3D director creates Seedance prompts with sound cues',
      'VR360 references, storyboard generation, and pose save work',
    ],
  }, null, 2));
} finally {
  await browser.close();
}

async function assertEventually(check, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}
