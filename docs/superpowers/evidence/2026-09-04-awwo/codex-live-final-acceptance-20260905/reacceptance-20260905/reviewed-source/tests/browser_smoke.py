"""Prepared real-browser acceptance, NOT RUN successfully in current sandbox.

Start python server.py first. Uses an existing Playwright installation.
"""
import json
import os
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'browser'
OUT.mkdir(exist_ok=True)
URL = os.environ.get('AWW_PREVIEW_URL', 'http://127.0.0.1:4173/')


def no_page_overflow(page):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL)
    expect(page.locator('#login-form')).to_be_visible()
    page.keyboard.press('Tab')
    expect(page.locator('.skip-link')).to_be_focused()
    page.keyboard.press('Enter')
    expect(page.locator('#main-content')).to_be_focused()
    page.screenshot(path=str(OUT / 'login-desktop.png'), full_page=True)
    page.get_by_role('button', name=re.compile('进入演示工作区')).click()
    page.locator('.workspace-card').first.click()
    expect(page.locator('.document-card')).to_have_count(6)
    no_page_overflow(page)
    page.screenshot(path=str(OUT / 'documents-desktop.png'), full_page=True)
    page.get_by_role('button', name='使用指南').click()
    expect(page.locator('#dialog')).to_be_visible()
    page.keyboard.press('Escape')
    expect(page.locator('#dialog')).not_to_be_visible()
    expect(page.get_by_role('button', name='使用指南')).to_be_focused()
    for width in [768, 375, 320]:
        page.set_viewport_size({'width': width, 'height': 850})
        no_page_overflow(page)
        toggle = page.locator('.mobile-nav-toggle')
        toggle.click()
        expect(toggle).to_have_attribute('aria-expanded', 'true')
        expect(page.locator('.sidebar')).to_be_visible()
        no_page_overflow(page)
        page.keyboard.press('Escape')
        expect(toggle).to_have_attribute('aria-expanded', 'false')
        expect(toggle).to_be_focused()
        expect(page.locator('.sidebar')).not_to_be_visible()
        page.screenshot(path=str(OUT / f'documents-{width}.png'), full_page=True)
    assert not errors, errors
    (OUT / 'result.json').write_text(json.dumps({
        'status': 'passed', 'viewports': [1440, 768, 375, 320],
        'checks': ['login', 'skip link', 'published documents', 'native dialog Escape and focus restoration',
                   'mobile navigation Escape and focus', 'horizontal overflow', 'page errors'],
        'does_not_prove': ['real auth', 'backend permissions', 'screen reader compliance']
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    browser.close()
