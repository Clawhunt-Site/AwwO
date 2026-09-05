from __future__ import annotations

from typing import Any

from .actions import StudioDeliveryActionMixin
from .coverage import StudioDeliveryCoverageMixin
from .dependencies import StudioDeliveryDeps
from .errors import StudioDeliveryError
from .handoff import StudioDeliveryHandoffMixin
from .overview import StudioDeliveryOverviewMixin
from .preview import StudioDeliveryPreviewMixin
from .sessions import StudioDeliverySessionMixin


class StudioDeliveryUseCases(
    StudioDeliveryOverviewMixin,
    StudioDeliveryCoverageMixin,
    StudioDeliverySessionMixin,
    StudioDeliveryHandoffMixin,
    StudioDeliveryActionMixin,
    StudioDeliveryPreviewMixin,
):
    def __init__(self, deps: StudioDeliveryDeps) -> None:
        self.deps = deps

    def _store_path(self) -> Any:
        return self.deps.store.path


__all__ = ["StudioDeliveryDeps", "StudioDeliveryError", "StudioDeliveryUseCases"]
