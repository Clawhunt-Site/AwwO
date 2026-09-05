from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

import httpx

from superclaw.environment import DEFAULT_CLAWHUNT_LOCAL_BASE_URL, clawhunt_base_url
from superclaw.protocol_adapter import ClawHuntSubmissionPayload, build_clawhunt_submission_payload
from superclaw.secrets_scan import contains_secret


@dataclass(frozen=True)
class ClawHuntSettings:
    base_url: str = DEFAULT_CLAWHUNT_LOCAL_BASE_URL
    agent_api_key: str | None = None

    @classmethod
    def from_env(cls) -> "ClawHuntSettings":
        return cls(
            base_url=clawhunt_base_url(),
            agent_api_key=os.environ.get("CLAWHUNT_AGENT_API_KEY"),
        )


class ClawHuntClient:
    def __init__(
        self,
        settings: ClawHuntSettings | None = None,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 20.0,
    ) -> None:
        self.settings = settings or ClawHuntSettings.from_env()
        # Ensure the CF Access service token is loaded (non-production only) before any
        # request is built, so direct CLI one-shots that construct a client without
        # first hitting the auth-env choke point still pass the staging Cloudflare gate.
        from superclaw.cf_access import hydrate_cf_access_environment

        hydrate_cf_access_environment(self.settings.base_url)
        self._client = httpx.Client(
            base_url=self.settings.base_url.rstrip("/"),
            transport=transport,
            timeout=timeout,
            trust_env=False,
        )

    def __repr__(self) -> str:
        return f"ClawHuntClient(base_url={self.settings.base_url!r}, agent_api_key={'set' if self.settings.agent_api_key else 'unset'})"

    @property
    def _headers(self) -> dict[str, str]:
        # CF Access service-token headers (non-production / private TEST host only) let
        # gated endpoints like /api/v1/me through the Cloudflare gate; cf_access_headers
        # returns {} for production / when no token is configured.
        from superclaw.cf_access import cf_access_headers

        headers = {"Accept": "application/json", **cf_access_headers(self.settings.base_url)}
        if self.settings.agent_api_key:
            headers["Authorization"] = f"Bearer {self.settings.agent_api_key}"
        return headers

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        response = self._client.request(method, path, headers=self._headers, **kwargs)
        return self._response_payload(response)

    def _public_request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        # Like _request but WITHOUT the agent Bearer token: ClawHunt's public,
        # web-facing surfaces (GET /api/problems*) authenticate optionally
        # (get_current_user_optional) and a stray `cph_` agent key is meaningless
        # there. We still attach the CF Access service-token headers so the call
        # clears the staging Cloudflare gate; on production they are absent.
        from superclaw.cf_access import cf_access_headers

        headers = {"Accept": "application/json", **cf_access_headers(self.settings.base_url)}
        response = self._client.request(method, path, headers=headers, **kwargs)
        return self._response_payload(response)

    def _response_payload(self, response: httpx.Response) -> dict[str, Any]:
        try:
            body: Any = response.json()
        except ValueError:
            body = response.text[:1000]
        return {"status_code": response.status_code, "ok": 200 <= response.status_code < 300, "body": body}

    def browse(
        self,
        *,
        skip: int = 0,
        limit: int = 50,
        status: str | None = None,
    ) -> dict[str, Any]:
        # Translate SuperClaw's internal pagination/filter contract into ClawHunt's
        # agent-platform wire contract. ClawHunt serves the marketplace list from
        # GET /api/v1/problems (agent_platform_api.browse_problems), which reads
        # `offset` and `status_filter` — NOT `skip`/`status`. FastAPI silently drops
        # unknown query params, so passing `skip`/`status` pinned every page to
        # offset=0 (broken pagination: scrolling re-fetched page 1) and made the
        # status filter a no-op. Keep skip/status as the SuperClaw-side names so the
        # CLI (`clawhunt browse`) and API (`/api/clawhunt/tasks`) contract is
        # unchanged, and map them to the wire names here at the single ClawHunt
        # boundary. When status is omitted, ClawHunt applies its own default
        # (open,bidding) — exactly the "available tasks" marketplace view we want.
        wire: dict[str, Any] = {"offset": skip, "limit": limit}
        if status:
            wire["status_filter"] = status
        return self._request("GET", "/api/v1/problems", params=wire)

    def browse_public(
        self,
        *,
        skip: int = 0,
        limit: int = 50,
        status: str | None = None,
    ) -> dict[str, Any]:
        # Public, unauthenticated marketplace listing — the web-facing
        # GET /api/problems/ (note the trailing slash) that ClawHunt's own site
        # uses to show the board to anonymous visitors. It needs NO agent key and
        # applies NO post-fetch visibility filtering (it paginates purely in-query),
        # so the chat dock can display the open market to everyone; a linked agent
        # key / login is only required to actually bid, claim, or deliver. Unlike
        # the agent-gated browse() it reads `skip`/`status` directly (no
        # offset/status_filter rename) and a short page genuinely means the end.
        params: dict[str, Any] = {"skip": skip, "limit": limit}
        if status:
            params["status"] = status
        return self._public_request("GET", "/api/problems/", params=params)

    def browse_marketplace(
        self,
        *,
        skip: int = 0,
        limit: int = 50,
        status: str | None = None,
        public: bool | None = None,
    ) -> dict[str, Any]:
        # Context-aware marketplace browse shared by the chat dock and the
        # `clawhunt browse` CLI. With a linked agent key we use the agent-gated,
        # personalized listing (browse(), respects routing/visibility); with NO key
        # we fall back to the public anonymous board (browse_public()) so the market
        # still shows without a login. `public` overrides the auto choice
        # (CLI --public / --agent): True forces anonymous, False forces the agent
        # listing (which then fails closed if no key is linked).
        use_public = (not self.settings.agent_api_key) if public is None else public
        if use_public:
            return self.browse_public(skip=skip, limit=limit, status=status)
        return self.browse(skip=skip, limit=limit, status=status)

    def get_problem(self, problem_id: int) -> dict[str, Any]:
        return self._request("GET", f"/api/v1/problems/{problem_id}")

    def get_problem_public(self, problem_id: int) -> dict[str, Any]:
        # Public problem detail (GET /api/problems/{id}), anonymous-readable — the
        # dock's detail panel must open without a linked agent key, mirroring the
        # public listing in browse_public().
        return self._public_request("GET", f"/api/problems/{problem_id}")

    def get_problem_marketplace(self, problem_id: int, *, public: bool | None = None) -> dict[str, Any]:
        # Context-aware problem detail, paired with browse_marketplace(). With a
        # linked agent key we use the agent-gated detail (get_problem()), which can
        # expose post-claim private fields (e.g. private-repo coordinates / secret
        # instructions); with no key we fall back to the anonymous public detail so
        # the dock opens without a login. NEVER hard-route to public when a key is
        # present, or a solver would lose the privileged detail it just claimed.
        use_public = (not self.settings.agent_api_key) if public is None else public
        return self.get_problem_public(problem_id) if use_public else self.get_problem(problem_id)

    def post_problem(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", "/api/v1/problems", json=payload)

    def bid(self, problem_id: int, amount: int | None = None, message: str = "") -> dict[str, Any]:
        return self._request("POST", f"/api/v1/problems/{problem_id}/bid", json={"amount": amount, "message": message})

    def claim(self, problem_id: int) -> dict[str, Any]:
        return self._request("POST", f"/api/v1/problems/{problem_id}/claim")

    def submit_solution(
        self,
        problem_id: int,
        solution: str | ClawHuntSubmissionPayload,
        evidence: dict[str, Any] | None = None,
        *,
        attachments: list[str] | None = None,
    ) -> dict[str, Any]:
        payload = (
            solution
            if isinstance(solution, ClawHuntSubmissionPayload)
            else build_clawhunt_submission_payload(
                solution_text=solution,
                evidence=evidence,
                attachments=attachments,
            )
        )
        return self._request("POST", f"/api/v1/problems/{problem_id}/solution", json=payload.request_json)

    def accept(self, problem_id: int) -> dict[str, Any]:
        return self._request("POST", f"/api/v1/problems/{problem_id}/accept")

    def accept_bid(self, problem_id: int, bid_id: int) -> dict[str, Any]:
        return self._request("POST", f"/api/v1/problems/{problem_id}/accept-bid", json={"bid_id": bid_id})

    def get_problem_bids(self, problem_id: int) -> dict[str, Any]:
        return self._request("GET", f"/api/v1/problems/{problem_id}/bids")

    def wallet(self) -> dict[str, Any]:
        return self._request("GET", "/api/v1/wallet")

    def capability_probe_status(self) -> dict[str, Any]:
        return self._request("GET", "/api/v1/capability-probe/status")

    def me(self) -> dict[str, Any]:
        return self._request("GET", "/api/v1/me")

    def skills(self) -> dict[str, Any]:
        return self._request("GET", "/api/v1/skills")

    def memories(self) -> dict[str, Any]:
        return self._request("GET", "/api/v1/memories")

    def subtasks(self, problem_id: int) -> dict[str, Any]:
        return self._request("GET", f"/api/v1/problems/{problem_id}/subtasks")

    def live_read_only_probe(self) -> dict[str, Any]:
        paths = {
            "clawhunt_health": "/health",
            "pay_switch_config": "/api/pay-switch/config",
            "pay_switch_proxy_health": "/api/pay-switch/health",
            "protected_api_shape": "/api/v1/problems",
        }
        from superclaw.cf_access import cf_access_headers

        # Probe requests are unauthenticated GETs, but the staging /api/* surface still
        # sits behind Cloudflare Access — without the CF header pair these would read a
        # 302 challenge page and misreport readiness. cf_access_headers self-guards
        # (only the gated staging host, never production / overrides).
        probe_headers = {"Accept": "application/json", **cf_access_headers(self.settings.base_url)}
        result: dict[str, Any] = {}
        for name, path in paths.items():
            response = self._client.get(path, headers=probe_headers)
            result[name] = self._response_payload(response)
            if name == "pay_switch_proxy_health" and response.status_code >= 500:
                retry_response = self._client.get(path, headers=probe_headers)
                result["pay_switch_proxy_retry"] = self._response_payload(retry_response)

        config_body = result.get("pay_switch_config", {}).get("body")
        direct_url = None
        if isinstance(config_body, dict):
            direct_url = config_body.get("health_url")
            if not direct_url and config_body.get("base_url"):
                direct_url = str(config_body["base_url"]).rstrip("/") + "/api/health"
        if direct_url:
            # Absolute URL, possibly a different (pay-switch) host; cf_access_headers
            # returns {} unless it is the gated staging host.
            direct_headers = {"Accept": "application/json", **cf_access_headers(str(direct_url))}
            direct_response = self._client.get(str(direct_url), headers=direct_headers)
            result["pay_switch_direct_health"] = self._response_payload(direct_response)
        else:
            result["pay_switch_direct_health"] = {"status_code": 0, "ok": False, "body": {"detail": "no direct health URL"}}
        return result

    def live_readiness_report(
        self,
        *,
        authenticated_read: bool = False,
        require_payment: bool = False,
        include_probe: bool = True,
    ) -> dict[str, Any]:
        """Build a secret-safe, non-mutating production readiness report.

        The report intentionally never calls bid, claim, submit, accept, or post
        endpoints. Optional authenticated checks are GET-only and summarize
        response shape rather than returning profile/problem payload bodies.
        """
        probe = self.live_read_only_probe()
        checks: list[dict[str, Any]] = []

        def response_status(name: str) -> int:
            value = probe.get(name, {})
            if not isinstance(value, dict):
                return 0
            return int(value.get("status_code") or 0)

        def add_check(check_id: str, passed: bool, detail: str, *, severity: str = "critical", **extra: Any) -> None:
            checks.append(
                {
                    "id": check_id,
                    "passed": bool(passed),
                    "severity": severity,
                    "detail": detail,
                    **{key: value for key, value in extra.items() if value not in (None, "", [])},
                }
            )

        health_status = response_status("clawhunt_health")
        add_check(
            "clawhunt_public_health",
            health_status == 200,
            f"/health returned {health_status}",
            status_code=health_status,
        )

        protected_status = response_status("protected_api_shape")
        add_check(
            "protected_api_fails_closed",
            protected_status == 401,
            f"unauthenticated /api/v1/problems returned {protected_status}",
            status_code=protected_status,
        )

        proxy_status = response_status("pay_switch_proxy_health")
        direct_status = response_status("pay_switch_direct_health")
        payment_severity = "critical" if require_payment else "warning"
        add_check(
            "pay_switch_proxy_health",
            200 <= proxy_status < 300,
            f"ClawHunt Pay-Switch proxy returned {proxy_status}",
            severity=payment_severity,
            status_code=proxy_status,
        )
        add_check(
            "pay_switch_direct_health",
            200 <= direct_status < 300,
            f"Pay-Switch direct health returned {direct_status}",
            severity=payment_severity,
            status_code=direct_status,
        )

        protocol_payload = build_clawhunt_submission_payload(
            solution_text="SuperClaw live-readiness sample; not submitted.",
            evidence={
                "run_id": "readiness_sample",
                "commands": [],
                "probes": [],
                "artifacts": [],
                "findings": [],
                "worker_results": [],
                "chain_verdict": "CHAIN_PARTIAL",
            },
            attachments=["superclaw-readiness:sample"],
        )
        protocol_json = json.dumps(protocol_payload.to_dict(), ensure_ascii=False, sort_keys=True, default=str)
        protocol_ok = (
            protocol_payload.adapter_name == "clawhunt.v1.solution"
            and "solution_text" in protocol_payload.request_json
            and "evidence" in protocol_payload.request_json
            and not contains_secret(protocol_json)
        )
        add_check(
            "submission_protocol_sample",
            protocol_ok,
            "local ClawHunt submission adapter produced a secret-safe request shape",
            adapter_name=protocol_payload.adapter_name,
        )

        authenticated_probe: dict[str, Any] | None = None
        if authenticated_read:
            if not self.settings.agent_api_key:
                add_check(
                    "authenticated_read_probe",
                    False,
                    "authenticated read-only probe requested but CLAWHUNT_AGENT_API_KEY is unset",
                )
            else:
                authenticated_probe = self._authenticated_read_probe()
                authenticated_ok = all(
                    200 <= int(item.get("status_code") or 0) < 300
                    for item in authenticated_probe.get("responses", {}).values()
                    if isinstance(item, dict)
                )
                add_check(
                    "authenticated_read_probe",
                    authenticated_ok,
                    "authenticated GET-only profile/capability/problem-list surfaces were summarized",
                    response_count=len(authenticated_probe.get("responses", {})),
                )

        critical_failures = [item for item in checks if item["severity"] == "critical" and not item["passed"]]
        warning_failures = [item for item in checks if item["severity"] == "warning" and not item["passed"]]
        status = "blocked" if critical_failures else "partial" if warning_failures else "ready"
        report: dict[str, Any] = {
            "status": status,
            "scope": "read_only_production_gate",
            "base_url": self.settings.base_url.rstrip("/"),
            "credentials": {
                "agent_api_key": "set" if self.settings.agent_api_key else "unset",
                "authenticated_read_requested": authenticated_read,
            },
            "requirements": {
                "payment_required": require_payment,
                "mutating_operations_attempted": False,
                "mutating_operations_blocked_by_design": [
                    "post_problem",
                    "bid",
                    "claim",
                    "submit_solution",
                    "accept",
                    "accept_bid",
                ],
            },
            "readiness": {
                "read_only_gate": health_status == 200 and protected_status == 401 and protocol_ok,
                "payment_path": 200 <= proxy_status < 300 and 200 <= direct_status < 300,
                "authenticated_read": None if not authenticated_read else not any(
                    item["id"] == "authenticated_read_probe" and not item["passed"] for item in checks
                ),
            },
            "checks": checks,
            "summary": {
                "critical_failures": len(critical_failures),
                "warning_failures": len(warning_failures),
            },
        }
        if include_probe:
            report["probe"] = probe
        if authenticated_probe is not None:
            report["authenticated_probe"] = authenticated_probe
        return report

    def _authenticated_read_probe(self) -> dict[str, Any]:
        responses = {
            "me": self._response_summary(self._client.get("/api/v1/me", headers=self._headers)),
            "capability_probe": self._response_summary(self._client.get("/api/v1/capability-probe/status", headers=self._headers)),
            "problem_list": self._response_summary(self._client.get("/api/v1/problems", headers=self._headers, params={"limit": 1})),
        }
        return {"responses": responses}

    def _response_summary(self, response: httpx.Response) -> dict[str, Any]:
        payload = self._response_payload(response)
        body = payload.get("body")
        summary: dict[str, Any] = {
            "status_code": payload["status_code"],
            "ok": payload["ok"],
        }
        if isinstance(body, dict):
            summary["body_type"] = "object"
            summary["body_keys"] = sorted(str(key) for key in body.keys())[:12]
        elif isinstance(body, list):
            summary["body_type"] = "array"
            summary["item_count"] = len(body)
        elif body is None:
            summary["body_type"] = "null"
        else:
            summary["body_type"] = type(body).__name__
        return summary


# --- shared ClawHunt browse-response parsing (single source) ------------------
# The marketplace browse list comes back under one of several wire shapes (a bare
# list, {problems|items|tasks|results|data: [...]}, or a NESTED envelope like
# {success, data: {problems: [...], has_more}}). Both the API dock
# (/api/clawhunt/tasks) and the governed marketplace handler must parse it the
# SAME way — otherwise "how many orders" disagrees across surfaces. These pure
# functions are that single source; surfaces call them, never re-hand-roll the
# shape walk (which previously under-counted: a hand-rolled walk that only checked
# for a LIST under each key returned 0 for the nested `data` envelope).


def extract_problem_payload(body: Any) -> dict[str, Any] | None:
    """Return the single problem dict from a (possibly enveloped) detail body."""
    if isinstance(body, dict):
        if any(key in body for key in ("id", "problem_id")) and any(
            key in body for key in ("title", "name", "description", "summary", "brief")
        ):
            return body
        for key in ("problem", "item", "task", "data", "result"):
            value = body.get(key)
            if isinstance(value, dict):
                nested = extract_problem_payload(value)
                if nested:
                    return nested
    return None


def extract_problem_items(body: Any) -> list[dict[str, Any]]:
    """Return the list of problem dicts from a (possibly NESTED-enveloped) browse
    body. Recurses into a dict found under a list key (e.g. ``data`` wrapping
    ``problems``) — the shape a naive list-only walk misses (returning 0)."""
    if isinstance(body, list):
        return [item for item in body if isinstance(item, dict)]
    if isinstance(body, dict):
        # `data`/`result` are the generic envelope keys (kept consistent with
        # `browse_has_more`, which digs both); the rest are list-shaped collections.
        for key in ("problems", "items", "tasks", "results", "data", "result"):
            value = body.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
            if isinstance(value, dict):
                nested = extract_problem_items(value)
                if nested:
                    return nested
        single = extract_problem_payload(body)
        if single:
            return [single]
    return []


def browse_has_more(body: Any, item_count: int, limit: int) -> bool:
    """The authoritative "more orders exist" signal: ClawHunt's upstream
    ``has_more`` (nested under the ``data``/``result`` envelope), computed from the
    PRE-visibility-filter page so it stays correct even when per-agent filtering
    shortens a page. Falls back to the imprecise full-page heuristic ONLY when the
    upstream omits it (older ClawHunt) — never overriding an explicit upstream value."""

    def dig(value: Any) -> bool | None:
        if isinstance(value, dict):
            flag = value.get("has_more")
            if isinstance(flag, bool):
                return flag
            for key in ("data", "result"):
                nested = dig(value.get(key))
                if nested is not None:
                    return nested
        return None

    upstream = dig(body)
    if upstream is not None:
        return upstream
    return item_count >= limit
