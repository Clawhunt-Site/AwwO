from __future__ import annotations

import json

from superclaw.clawhunt import ClawHuntClient, ClawHuntSettings


def main() -> int:
    client = ClawHuntClient(ClawHuntSettings.from_env())
    report = client.live_readiness_report()
    print(json.dumps(report, indent=2, ensure_ascii=False))

    return 0 if report.get("readiness", {}).get("read_only_gate") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
