from __future__ import annotations

from typing import Any

from studio_app.application.policies import dispatch as dispatch_rules


class StudioDeliveryPreviewMixin:

    async def dispatch_preview(
        self,
        *,
        message: str,
        action: str,
        page_id: str,
        agent_id: str | None = None,
        project_id: str | None = None,
        source_segment_id: str | None = None,
        has_image: bool = False,
        bot_id: str | None = None,
        bot_slug: str | None = None,
        bot_name: str | None = None,
        bot_type: str | None = None,
        article_id: str | None = None,
    ) -> dict[str, Any]:
        normalized_action = self.deps.normalize_action(action)
        preferred_page = self.deps.get_page(page_id)
        prompt = dispatch_rules.dispatch_preview_prompt(message, normalized_action, preferred_page)

        project = self.deps.get_project(project_id) if project_id else None
        source_segment = self.deps.resolve_source_segment(project, source_segment_id)
        resolved_source_segment_id = source_segment.get("id") if source_segment else source_segment_id
        route = (
            self.deps.dreamy_bot_route(
                bot_id=bot_id,
                bot_slug=bot_slug,
                bot_name=bot_name,
                bot_type=bot_type,
                article_id=article_id,
                message=prompt,
            )
            if page_id == "dreamy-miniapp" and (bot_slug or bot_id)
            else None
        )
        if route is None:
            route = await self.deps.choose_route(prompt, has_image, normalized_action, source_segment)
        page = self.deps.page_for_dispatch(route["bot"], page_id, prompt)
        contract = dispatch_rules.navigation_contract(page, route, source_segment)
        navigation_path = contract.get("navigationPath", "")
        missing_route_params = dispatch_rules.missing_route_params(page, navigation_path)
        route = dispatch_rules.enrich_dispatch_route(
            route,
            page,
            action=normalized_action,
            source_segment_id=resolved_source_segment_id,
            agent_id=self.agent_id_for_dispatch(page, agent_id),
            contract=contract,
            missing_route_params=missing_route_params,
        )
        return dispatch_rules.dispatch_preview_response(
            runtime_page=self.page_with_runtime_status(page),
            route=route,
            page=page,
            contract=contract,
            navigation_path=navigation_path,
            missing_route_params=missing_route_params,
            prompt=prompt,
        )
