from __future__ import annotations

from typing import Any

from studio_app.api.route_mounting import mount_studio_routes
from studio_app.composition.container import build_studio_route_mount_deps


def register_studio_routes(app: Any) -> None:
    mount_studio_routes(app, build_studio_route_mount_deps())
