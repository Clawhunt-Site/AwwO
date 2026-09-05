from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TypeVar


T = TypeVar("T")


class InProcessStudioTaskRunner:
    """Default task runner that preserves current in-process behavior."""

    async def run(self, name: str, work: Callable[[], Awaitable[T]]) -> T:
        return await work()


STUDIO_TASK_RUNNER = InProcessStudioTaskRunner()
