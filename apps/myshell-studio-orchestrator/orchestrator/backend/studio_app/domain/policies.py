from __future__ import annotations

from typing import Any


def evidence_is_accepted(evidence: dict[str, Any]) -> bool:
    return bool(evidence.get("accepted") and (evidence.get("mediaUrl") or evidence.get("navigationPath")))


def job_can_be_marked_done(job: dict[str, Any], evidence: dict[str, Any]) -> bool:
    if job.get("executor") == "navigation":
        return bool(evidence.get("navigationPath"))
    return evidence_is_accepted(evidence)
