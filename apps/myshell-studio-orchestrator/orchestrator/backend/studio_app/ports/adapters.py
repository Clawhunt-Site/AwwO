from __future__ import annotations

from typing import Any, Protocol


class StudioAdapter(Protocol):
    id: str

    async def auth_status(self) -> dict[str, Any]:
        ...

    async def run(self, request: dict[str, Any]) -> dict[str, Any]:
        ...

    async def poll(self, job: dict[str, Any]) -> dict[str, Any]:
        ...

    async def cancel(self, job: dict[str, Any]) -> dict[str, Any]:
        ...
