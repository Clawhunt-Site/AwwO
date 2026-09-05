"""Dependency-free structural and selected-token checks; no layout claims."""
from collections import Counter
from datetime import datetime, timezone
from hashlib import sha256
from html.parser import HTMLParser
from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[1]


class Markup(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.nodes = []
        self.stack = []

    def handle_starttag(self, tag, attrs):
        node = {"tag": tag, "attrs": dict(attrs), "parents": self.stack.copy()}
        self.nodes.append(node)
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in self.stack:
            self.stack = self.stack[:len(self.stack) - 1 - self.stack[::-1].index(tag)]


def luminance(color):
    channels = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in channels]
    return sum(c * weight for c, weight in zip(linear, (.2126, .7152, .0722)))


def contrast(fg, bg):
    high, low = sorted((luminance(fg), luminance(bg)), reverse=True)
    return (high + .05) / (low + .05)


def main():
    fixture = ROOT / "tests/responsive-accessibility.html"
    markup = Markup()
    markup.feed(fixture.read_text(encoding="utf-8"))
    checks = []

    def check(name, passed, details):
        checks.append({"name": name, "status": "passed" if passed else "failed", "details": details})

    ids = Counter(n["attrs"]["id"] for n in markup.nodes if "id" in n["attrs"])
    check("unique-ids", all(count == 1 for count in ids.values()), dict(ids))
    missing_refs = []
    for node in markup.nodes:
        for attr in ("for", "aria-labelledby", "aria-describedby", "aria-controls"):
            missing_refs += [ref for ref in node["attrs"].get(attr, "").split() if ref not in ids]
        href = node["attrs"].get("href", "")
        if href.startswith("#") and href[1:] not in ids:
            missing_refs.append(href)
    check("id-references", not missing_refs, missing_refs)
    labels = {n["attrs"].get("for") for n in markup.nodes if n["tag"] == "label"}
    controls = [n for n in markup.nodes if n["tag"] in {"input", "select", "textarea"}]
    unlabeled = [n for n in controls if n["attrs"].get("id") not in labels and "label" not in n["parents"] and not n["attrs"].get("aria-label")]
    check("control-labels", not unlabeled, {"controls": len(controls), "unlabeled": unlabeled})
    positive = [n for n in markup.nodes if int(n["attrs"].get("tabindex", "0")) > 0]
    check("no-positive-tabindex", not positive, positive)
    html = next(n for n in markup.nodes if n["tag"] == "html")
    check("page-language", html["attrs"].get("lang") == "zh-CN", html["attrs"])
    viewport = next(n for n in markup.nodes if n["tag"] == "meta" and n["attrs"].get("name") == "viewport")
    check("zoom-not-disabled", "user-scalable=no" not in viewport["attrs"]["content"] and "maximum-scale" not in viewport["attrs"]["content"], viewport["attrs"])
    assets = ["styles.css", "src/styles.css", "src/accessibility.js", "tests/responsive-accessibility.html", "tests/responsive-accessibility.check.cjs"]
    check("required-assets-exist", all((ROOT / f).is_file() for f in assets), assets)
    root_css = (ROOT / "styles.css").read_text(encoding="utf-8")
    patch_css = (ROOT / "src/styles.css").read_text(encoding="utf-8")
    # Read only default token declarations, before preference-specific overrides.
    declarations = root_css.split("@media")[0] + patch_css.split("@media")[0]
    tokens = dict(re.findall(r"(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})", declarations))
    pairs = [
        ("body", tokens["--ink"], tokens["--canvas"], 4.5),
        ("muted-on-white", tokens["--muted"], "#ffffff", 4.5),
        ("muted-on-canvas", tokens["--muted"], tokens["--canvas"], 4.5),
        ("workspace-label", tokens["--muted"], tokens["--surface-soft"], 4.5),
        ("primary-button", "#ffffff", tokens["--green"], 4.5),
        ("danger-text", tokens["--danger"], tokens["--danger-light"], 4.5),
        ("warning-text", tokens["--warning"], tokens["--warning-light"], 4.5),
        ("control-border", tokens["--line-strong"], "#ffffff", 3),
    ]
    for name, fg, bg, minimum in pairs:
        ratio = contrast(fg, bg)
        check("token-contrast-" + name, ratio >= minimum, {"fg": fg, "bg": bg, "ratio": round(ratio, 3), "minimum": minimum})
    output = {
        "scope": "Static fixture structure and selected default token pairs only; CSS cascade and browser rendering are not evaluated.",
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "status": "passed" if all(c["status"] == "passed" for c in checks) else "failed",
        "checks": checks,
        "hashes": {f: sha256((ROOT / f).read_bytes()).hexdigest() for f in assets},
        "browser": {"status": "blocked", "evidence": ["Python Playwright initialization: PermissionError [WinError 5]", "Node Playwright Chromium launch: spawn EPERM"], "screenshots": [], "screenReaderTested": False},
    }
    dest = ROOT / "artifacts/responsive-static-checks.json"
    dest.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": output["status"], "checks": len(checks), "evidence": str(dest)}, ensure_ascii=False))
    return 0 if output["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
