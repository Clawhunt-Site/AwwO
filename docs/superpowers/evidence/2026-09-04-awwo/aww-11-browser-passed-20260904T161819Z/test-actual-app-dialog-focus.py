"""Read-only browser regression of the actual demo app's help dialog.

Starts a fresh Chrome context against an existing local preview. Writes evidence
only beside this script. It never edits the Agent workspace or calls runtime APIs.
"""
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

URL = "http://127.0.0.1:4173/"
AGENT_WORKSPACE = Path("C:/tmp/awwo-codex-live-20260904/a784236e-c48a-468d-b14f-8392297e0452")
REPLAY_OLD_HELPER = "--replay-recorded-old-helper" in sys.argv
MODE = "recorded-old-helper-replay" if REPLAY_OLD_HELPER else "current-app"
STAMP = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
OUT = Path(__file__).resolve().parent / "evidence" / f"actual-app-dialog-focus-{MODE}-{STAMP}"
OUT.mkdir(parents=True, exist_ok=False)
SOURCE_PATHS = ["src/app.js", "src/accessibility.js", "index.html"]
BASELINE = Path(__file__).resolve().parents[2] / "docs/superpowers/evidence/2026-09-04-awwo/aww-11-browser-failed-20260904T161201Z/source/src/accessibility.js"
baseline_bytes = BASELINE.read_bytes() if REPLAY_OLD_HELPER else None
if baseline_bytes is not None and hashlib.sha256(baseline_bytes).hexdigest() != "e882b45bbeb3e21843fdb6ad319c31e9514885a5ac2b5113d42399d5f298777d":
    raise RuntimeError("Recorded old helper does not match the frozen failing browser evidence")


def source_hashes():
    return {
        relative: hashlib.sha256((AGENT_WORKSPACE / relative).read_bytes()).hexdigest()
        for relative in SOURCE_PATHS
    }


SNAPSHOT = """() => {
  const dialog = document.querySelector('#dialog');
  const active = document.activeElement;
  const info = el => el ? {
    tag: el.tagName, id: el.id || null, role: el.getAttribute('role'),
    text: ['BODY', 'HTML'].includes(el.tagName) ? null : el.textContent.trim().slice(0, 120),
    tabIndex: el.tabIndex,
  } : null;
  return {
    hasFocus: document.hasFocus(), activeElement: info(active),
    activeIsBody: active === document.body,
    activeInsideDialog: Boolean(dialog?.contains(active)),
    dialogOpen: Boolean(dialog?.open), dialogIsModal: Boolean(dialog?.matches(':modal')),
    focusableDescendants: [...(dialog?.querySelectorAll('a[href], button, input, select, textarea, [tabindex]') || [])]
      .filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length)
      .map(info),
  };
}"""

report = {
    "startedAt": datetime.now(timezone.utc).isoformat(),
    "url": URL,
    "mode": MODE,
    "scope": "Actual application help dialog in a fresh in-memory demo session; keyboard focus only.",
    "doesNotProve": ["real identity service", "backend authorization", "screen reader compliance"],
    "sourceHashesBefore": source_hashes(),
    "cases": [],
    "pageErrors": [],
}
if REPLAY_OLD_HELPER:
    report["assetOverride"] = {
        "url": URL + "src/accessibility.js", "path": str(BASELINE),
        "sha256": hashlib.sha256(baseline_bytes).hexdigest(),
        "method": "Browser-local response replay of exact frozen old helper. All other assets come from the current actual app; no server or Agent file was changed. This is a reconstructed baseline, not a pre-fix live capture.",
    }
browser = None
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome", headless=True)
        report["browser"] = browser.version
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        if REPLAY_OLD_HELPER:
            page.route(URL + "src/accessibility.js", lambda route: route.fulfill(status=200, content_type="text/javascript", body=baseline_bytes))
        page.on("pageerror", lambda error: report["pageErrors"].append(str(error)))
        served_app = []
        served_helper = []
        page.on("response", lambda response: served_app.append(response) if response.url == URL + "src/app.js" else None)
        page.on("response", lambda response: served_helper.append(response) if response.url == URL + "src/accessibility.js" else None)
        page.goto(URL, wait_until="networkidle")
        expect(page.locator("#login-form")).to_be_visible()
        page.get_by_role("button", name=re.compile("进入演示工作区")).click()
        page.locator(".workspace-card").first.click()
        expect(page.locator(".document-card")).to_have_count(6)
        report["servedAppJsSha256"] = hashlib.sha256(served_app[0].body()).hexdigest() if served_app else None
        report["servedAccessibilitySha256"] = hashlib.sha256(served_helper[0].body()).hexdigest() if served_helper else None
        page.evaluate("""() => {
          window.__dialogFocusAuditEvents = [];
          for (const kind of ['focusin', 'focusout', 'keydown', 'keyup']) {
            document.addEventListener(kind, event => {
              if (window.__dialogFocusAuditEvents.length >= 100) return;
              window.__dialogFocusAuditEvents.push({type: kind, key: event.key || null,
                shiftKey: Boolean(event.shiftKey), targetTag: event.target?.tagName,
                targetId: event.target?.id || null, hasFocus: document.hasFocus(),
                activeTag: document.activeElement?.tagName, activeId: document.activeElement?.id || null});
            }, true);
          }
          for (const kind of ['blur', 'focus']) window.addEventListener(kind, () => {
            window.__dialogFocusAuditEvents.push({type: 'window.' + kind,
              hasFocus: document.hasFocus(), activeTag: document.activeElement?.tagName});
          });
        }""")
        for label, keys in [("forward_boundary", ["Tab", "Tab", "Tab"]),
                            ("reverse_boundary", ["Shift+Tab", "Shift+Tab", "Shift+Tab"])]:
            page.get_by_role("button", name="使用指南", exact=True).click()
            expect(page.locator("#dialog")).to_be_visible()
            steps = [{"action": "open_help", **page.evaluate(SNAPSHOT)}]
            for index, key in enumerate(keys):
                page.keyboard.press(key)
                steps.append({"action": key, **page.evaluate(SNAPSHOT)})
                if not steps[-1]["activeInsideDialog"]:
                    page.screenshot(path=str(OUT / f"{label}-step-{index + 1}.png"), full_page=True)
            page.keyboard.press("Escape")
            expect(page.locator("#dialog")).not_to_be_visible()
            restored = page.get_by_role("button", name="使用指南", exact=True).evaluate("el => el === document.activeElement")
            result = {
                "name": label, "steps": steps, "escapeRestoresTrigger": restored,
                "passed": all(step["activeInsideDialog"] and step["hasFocus"] and step["dialogIsModal"] for step in steps) and restored,
            }
            report["cases"].append(result)
        report["focusEvents"] = page.evaluate("window.__dialogFocusAuditEvents")
        browser.close()
        browser = None
    report["sourceHashesAfter"] = source_hashes()
    report["servedAppMatchesOriginalSource"] = report["servedAppJsSha256"] == report["sourceHashesBefore"]["src/app.js"]
    report["appSourceUnchangedDuringTest"] = report["sourceHashesBefore"]["src/app.js"] == report["sourceHashesAfter"]["src/app.js"]
    report["allWatchedSourcesUnchangedDuringTest"] = report["sourceHashesBefore"] == report["sourceHashesAfter"]
    report["servedHelperMatchesExpected"] = report["servedAccessibilitySha256"] == (report["assetOverride"]["sha256"] if REPLAY_OLD_HELPER else report["sourceHashesBefore"]["src/accessibility.js"])
    report["passed"] = bool(report["cases"]) and all(case["passed"] for case in report["cases"]) and not report["pageErrors"]
    report["status"] = "passed" if report["passed"] else "failed"
except Exception as error:
    report["status"] = "execution_error"
    report["error"] = {"type": type(error).__name__, "message": str(error)}
finally:
    report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    (OUT / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "evidence": str(OUT / "results.json"), "status": report["status"],
        "mode": MODE, "servedHelperMatchesExpected": report.get("servedHelperMatchesExpected"),
        "browser": report.get("browser"), "servedAppMatchesOriginalSource": report.get("servedAppMatchesOriginalSource"),
        "appSourceUnchangedDuringTest": report.get("appSourceUnchangedDuringTest"),
        "cases": [{"name": case["name"], "passed": case["passed"], "escapeRestoresTrigger": case["escapeRestoresTrigger"],
                   "steps": [{"action": step["action"], "activeElement": step["activeElement"], "hasFocus": step["hasFocus"],
                              "activeInsideDialog": step["activeInsideDialog"], "dialogIsModal": step["dialogIsModal"]} for step in case["steps"]]}
                  for case in report["cases"]],
        "error": report.get("error"),
    }, ensure_ascii=True))
sys.exit(0 if report["status"] == "passed" else 1 if report["status"] == "failed" else 2)
