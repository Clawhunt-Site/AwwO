from __future__ import annotations

from typing import Any

from studio_app.application.policies import dispatch as dispatch_rules


class StudioDeliveryOverviewMixin:

    def agent_id_for_page(self, page: dict[str, Any]) -> str:
        if page.get("executor") == "navigation":
            return "miniapp-page-navigator"
        return "myshell-art-cdp-executor" if page["id"] == "myshell-art" else "dreamy-miniapp-executor"

    def agent_id_for_dispatch(self, page: dict[str, Any], preferred_agent_id: str | None = None) -> str:
        agents_by_id = {agent["id"]: agent for agent in self.deps.list_agents()}
        if preferred_agent_id and preferred_agent_id in agents_by_id:
            return preferred_agent_id
        return self.agent_id_for_page(page)

    def page_with_runtime_status(self, page: dict[str, Any]) -> dict[str, Any]:
        auth_status = self.deps.adapter_auth_status(page["id"])
        auth_state = str(auth_status.get("status") or "unknown")
        dispatch_ready = auth_state in self.deps.ready_auth_statuses
        dispatch_status = "ready" if dispatch_ready else auth_state
        executor = "server" if page["id"] == "dreamy-miniapp" and auth_state == "ready" else page.get("executor", "")
        dispatch_mode = "execute-server" if executor == "server" else page.get("dispatchMode", "")
        return {
            **page,
            "executor": executor,
            "dispatchMode": dispatch_mode,
            "authStatus": auth_status,
            "dispatchReady": dispatch_ready,
            "dispatchStatus": dispatch_status,
            "dispatchMessage": auth_status.get("message") or page.get("dispatchMode") or "",
        }

    def status_counts(self, jobs: list[dict[str, Any]]) -> dict[str, int]:
        return dispatch_rules.status_counts(jobs, status_keys=self.deps.status_count_keys)

    def page_agent_ids(
        self,
        page: dict[str, Any],
        page_jobs: list[dict[str, Any]],
        agents: list[dict[str, Any]],
    ) -> list[str]:
        return dispatch_rules.page_agent_ids(page, page_jobs, agents)

    def studio_overview(self, limit: int = 50) -> dict[str, Any]:
        pages = self.deps.list_pages()
        agents = self.deps.list_agents()
        jobs = self.deps.store.list_jobs(limit=500)
        latest_jobs = [self.deps.job_with_evidence(job) for job in jobs[: max(1, min(limit, 100))]]
        total_counts = self.status_counts(jobs)

        page_summaries: list[dict[str, Any]] = []
        for page in pages:
            page_jobs = [job for job in jobs if job.get("pageId") == page["id"] or job.get("api") == page["id"]]
            page_summaries.append(
                {
                    **self.page_with_runtime_status(page),
                    "agentIds": self.page_agent_ids(page, page_jobs, agents),
                    "jobCounts": self.status_counts(page_jobs),
                    "latestJob": self.deps.job_with_evidence(page_jobs[0]) if page_jobs else None,
                }
            )

        agent_summaries: list[dict[str, Any]] = []
        for agent in agents:
            agent_jobs = [job for job in jobs if job.get("agentId") == agent["id"]]
            agent_summaries.append(
                {
                    **agent,
                    "jobCounts": self.status_counts(agent_jobs),
                    "latestJob": self.deps.job_with_evidence(agent_jobs[0]) if agent_jobs else None,
                }
            )

        return {
            "checkedAt": self.deps.now_iso(),
            "totals": dispatch_rules.overview_totals(
                pages=pages,
                agents=agents,
                jobs=jobs,
                total_counts=total_counts,
            ),
            "pages": page_summaries,
            "agents": agent_summaries,
            "latestJobs": latest_jobs,
        }
