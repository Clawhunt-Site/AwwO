from __future__ import annotations

from enum import StrEnum


class StudioJobStatus(StrEnum):
    DRAFT = "draft"
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    TIMEOUT = "timeout"
    AUTH_MISSING = "auth_missing"
    ERROR = "error"
    CANCELLED = "cancelled"


class StudioExecutor(StrEnum):
    CLIENT = "client"
    SERVER = "server"
    NAVIGATION = "navigation"


class DispatchTargetStatus(StrEnum):
    PENDING = "pending"
    VISITED = "visited"
    COMPLETED = "completed"
    SKIPPED = "skipped"
    ERROR = "error"
    CANCELLED = "cancelled"
