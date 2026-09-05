from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Protocol, TypeVar


T = TypeVar("T")


class StudioTaskRunner(Protocol):
    """Execution boundary for work that can later move to a dedicated worker."""

    async def run(self, name: str, work: Callable[[], Awaitable[T]]) -> T:
        """Run a named asynchronous unit of Studio work."""
        ...
