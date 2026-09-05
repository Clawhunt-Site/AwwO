import hashlib
import json
from pathlib import Path
import re
import struct
from datetime import datetime, timezone

OUT = Path(__file__).resolve().parent
FRONT = Path('C:/tmp/awwo-codex-live-20260904/a784236e-c48a-468d-b14f-8392297e0452')
def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

before = read(OUT / 'source-before.json')
source_checks = []
for item in before:
    path = Path(item['path'])
    current = sha(path)
    assert current == item['sha256'], f'Source changed during retest: {path}'
    snapshot = OUT / 'reviewed-source' / item['relative']
    snapshot.parent.mkdir(parents=True, exist_ok=True)
    snapshot.write_bytes(path.read_bytes())
    source_checks.append({**item, 'after_sha256': current, 'unchanged': True,
                          'snapshot': snapshot.relative_to(OUT).as_posix()})

repair = read(FRONT / 'artifacts/aww-15-final-verification.json')
repair_matches = {}
for relative, digest in repair['source_hashes'].items():
    actual = sha(FRONT / relative)
    repair_matches[relative] = {'recorded': digest, 'current': actual, 'matches': digest == actual}
    assert actual == digest, f'AWW-15 source differs: {relative}'

fixture = read(FRONT / 'artifacts/aww-11-browser-evidence/results.json')
app = read(FRONT / 'artifacts/browser/result.json')
browser_readback = read(FRONT / 'artifacts/aww-11-modal-focus/final-evidence-readback.json')
assert len(fixture['checks']) == 14 and all(check['passed'] for check in fixture['checks'])
assert not fixture.get('executionError')
assert app['status'] == 'passed' and app['viewports'] == [1440, 768, 375, 320]
browser_matches = {}
for relative, digest in fixture['hashes'].items():
    actual = sha(FRONT / relative)
    browser_matches[relative] = {'recorded': digest, 'current': actual, 'matches': digest == actual}
    assert actual == digest
expected_harnesses = {
    'artifacts/aww-11-browser-review.mjs': '3103ca71da5c2fe844c53d521ee1b98086eb0ea4ee6d5133eab15c199667087d',
    'tests/browser_smoke.py': '0b543223000de15a3126e08d9471c1aaee9b793f21c4774b1aa2cf32900971bd',
}
for relative, digest in expected_harnesses.items():
    assert sha(FRONT / relative) == digest
    browser_matches[relative] = {'recorded': digest, 'current': digest, 'matches': True}

screenshots = []
for item in browser_readback['screenshots']:
    path = FRONT / item['path']
    data = path.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    width, height = struct.unpack('>II', data[16:24])
    digest = hashlib.sha256(data).hexdigest()
    assert digest == item['sha256'] and width == item['width'] and height == item['height']
    copy = OUT / 'host-browser' / item['path'].removeprefix('artifacts/')
    copy.parent.mkdir(parents=True, exist_ok=True)
    copy.write_bytes(data)
    screenshots.append({**item, 'matches': True, 'local_copy': copy.relative_to(OUT).as_posix()})
for relative in ['artifacts/aww-11-browser-evidence/results.json', 'artifacts/browser/result.json',
                 'artifacts/aww-11-modal-focus/final-review.md', 'artifacts/aww-11-modal-focus/final-evidence-readback.json',
                 'artifacts/aww-15-delivery.md', 'artifacts/aww-15-final-verification.json']:
    copy = OUT / 'upstream-evidence' / relative.removeprefix('artifacts/')
    copy.parent.mkdir(parents=True, exist_ok=True)
    copy.write_bytes((FRONT / relative).read_bytes())

tests = {}
for name, expected in [('model-regression.tap', 31), ('ui-dom.tap', 4), ('modal-focus.tap', 8)]:
    tap = (OUT / name).read_text(encoding='utf-8-sig')
    passed = int(re.search(r'^# pass (\d+)$', tap, re.M)[1])
    failed = int(re.search(r'^# fail (\d+)$', tap, re.M)[1])
    skipped = int(re.search(r'^# skipped (\d+)$', tap, re.M)[1])
    assert passed == expected and failed == 0 and skipped == 0
    tests[name] = {'passed': passed, 'failed': failed, 'skipped': skipped}
repro = read(OUT / 'repro-status.json')
assert repro['status'] == 'passed'
old_sources = read(OUT.parent / 'source-manifest.json')
contract_matches = []
for item in old_sources:
    if item.get('label') or item['path'].endswith('backend-contract-v1.md'):
        actual = sha(Path(item['path']))
        assert actual == item['sha256']
        contract_matches.append({'path': item['path'], 'sha256': actual, 'unchanged': True})
comment = read(OUT / 'host-provenance-comment.json')
assert comment['id'] == '731d2ca9-825d-44fe-8a18-9b243253df0c' and comment['authorUserId'] == 'local-board'
result = {
    'issue': 'AWW-12', 'run_id': 'cb0e4332-1797-4bb1-8545-18ced4772991',
    'readback_at': datetime.now(timezone.utc).isoformat(), 'status': 'passed',
    'source_checks': source_checks, 'repair_source_matches': repair_matches,
    'contract_source_matches': contract_matches, 'tests_independently_run': tests,
    'original_defect_probes': repro,
    'browser_evidence': {'mode': 'host execution evidence readback; no sandbox browser rerun',
        'host_comment': comment['id'], 'executed_at': fixture['checkedAt'], 'browser': fixture['browser'],
        'fixture_passed': 14, 'fixture_total': 14, 'application': app,
        'source_matches': browser_matches, 'screenshots': screenshots,
        'application_provenance_limit': 'Application result lacks embedded full source manifest; execution provenance comes from local-board comment, matching original smoke script, current AWW-15 app/api/demo hashes and matching shared accessibility/CSS files.'},
    'limits': ['No real account, deployed service or external integration acceptance',
               'Browser smoke covers entry/list/navigation/focus/reflow, not full business workflow',
               'Business workflow executed in JSDOM and in-memory model', 'No full WCAG or screen reader compliance claim'],
}
(OUT / 'verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'status': result['status'], 'tests': tests, 'browser_fixture': '14/14',
                  'screenshot_hashes_matched': len(screenshots), 'repair_sources_matched': len(repair_matches),
                  'sources_unchanged_during_retest': len(source_checks)}, ensure_ascii=False, indent=2))
