from __future__ import annotations

from typing import Any


VERIFIED_DREAMY_WORKSHOP_PROJECT_ID = "dreamy_verified_workshop_two_bot"
VERIFIED_DREAMY_WORKSHOP_SEGMENTS: list[dict[str, Any]] = [
    {
        "id": "verified_workshop_segment_1",
        "type": "video",
        "url": "https://d2rzqgs9j5kr8g.cloudfront.net/video/chat/embed_obj/202606030911/551da3b2c0274fab8e1cd12c554186d4.mp4",
        "posterUrl": "https://www.myshellstatic.com/video/chat/embed_obj/202606030911/551da3b2c0274fab8e1cd12c554186d4-poster.jpg",
        "prompt": "Verified Dreamy workshop result from 3D Anime Porn.",
        "botSlug": "3d-anime-porn",
        "botId": "1769085605",
        "articleId": "3d-anime-porn",
        "botName": "3D Anime Porn",
        "action": "generate",
        "status": "done",
        "taskId": "bdcc5855a80f479dafe39c3afd3ab6fa",
        "evidence": {
            "status": "done",
            "source": "dreamyporn-workshop-web",
            "accepted": True,
            "mediaUrl": "https://d2rzqgs9j5kr8g.cloudfront.net/video/chat/embed_obj/202606030911/551da3b2c0274fab8e1cd12c554186d4.mp4",
            "taskId": "bdcc5855a80f479dafe39c3afd3ab6fa",
            "message": "Real Dreamy workshop bot completed and returned playable media.",
            "checkedAt": "2026-06-03T09:11:00Z",
        },
        "createdAt": "2026-06-03T09:11:00Z",
        "updatedAt": "2026-06-03T09:11:00Z",
    },
    {
        "id": "verified_workshop_segment_2",
        "type": "video",
        "url": "https://d2rzqgs9j5kr8g.cloudfront.net/video/chat/embed_obj/202606030923/ed0e2719080742b5a5db07483f439a84.mp4",
        "posterUrl": "https://www.myshellstatic.com/video/chat/embed_obj/202606030923/ed0e2719080742b5a5db07483f439a84-poster.jpg",
        "prompt": "Verified Dreamy workshop result from 3D Futa Porn, staged as the next segment.",
        "botSlug": "3d-futa-porn",
        "botId": "1768994068",
        "articleId": "3d-futa-porn",
        "botName": "3D Futa Porn",
        "action": "extend",
        "parentSegmentId": "verified_workshop_segment_1",
        "status": "done",
        "taskId": "ed8d4bd4aab74245aadb8f8a832c3f4b",
        "evidence": {
            "status": "done",
            "source": "dreamyporn-workshop-web",
            "accepted": True,
            "mediaUrl": "https://d2rzqgs9j5kr8g.cloudfront.net/video/chat/embed_obj/202606030923/ed0e2719080742b5a5db07483f439a84.mp4",
            "taskId": "ed8d4bd4aab74245aadb8f8a832c3f4b",
            "message": "Second real Dreamy workshop bot completed and is staged as a timeline extension.",
            "checkedAt": "2026-06-03T09:23:00Z",
        },
        "createdAt": "2026-06-03T09:23:00Z",
        "updatedAt": "2026-06-03T09:23:00Z",
    },
]

VALID_MODES = {"player", "canvas"}
VALID_ACTIONS = {"generate", "extend", "restyle", "retry-agent"}
VALID_STATUSES = {"draft", "queued", "running", "done", "timeout", "auth_missing", "error", "cancelled"}
VALID_DISPATCH_TARGET_STATUSES = {"pending", "visited", "completed", "skipped", "error", "cancelled"}
READY_AUTH_STATUSES = {"ok", "ready", "client_delegated"}
STATUS_COUNT_KEYS = ("draft", "queued", "running", "done", "timeout", "auth_missing", "error", "cancelled")
TERMINAL_CANCEL_STATUSES = {"done", "cancelled"}
CANVASPRO_SOURCE_ASSET_MAX_BYTES = 24 * 1024 * 1024
CANVASPRO_SOURCE_ASSET_MEDIA_PREFIXES = ("image/", "video/", "audio/")
CORE_DELIVERY_PAGE_IDS = {
    "dreamy-miniapp",
    "myshell-art",
    "explore",
    "ai-picks",
    "bot-detail",
    "upload",
    "tag-generator",
    "library",
    "library-detail",
    "energy-store",
    "energy-history",
    "earn",
    "share-invite",
    "settings",
    "profile",
    "checkin",
}
CORE_DELIVERY_AGENT_IDS = {
    "intent-router",
    "asset-planner",
    "dreamy-miniapp-executor",
    "myshell-art-cdp-executor",
    "miniapp-page-navigator",
    "evidence-verifier",
    "timeline",
}
READY_GATE_STATUSES = {"ok", "ready", "client_delegated"}
PENDING_DELIVERY_STATUSES = {"draft", "queued", "running"}
ISSUE_DELIVERY_STATUSES = {"timeout", "auth_missing", "error"}
MANUAL_STUDIO_ACTIONS = {
    "restore-auth",
    "start-chrome-cdp",
    "provide-project-id",
    "inspect-requirement",
    "inspect-dispatch-matrix",
    "provide-route-params",
    "wait-or-refresh",
    "retry-or-inspect",
    "restore-readiness",
    "inspect-gap",
    "wait-for-adapter",
    "poll-result",
    "retry-or-cancel",
    "inspect-error",
    "verify-evidence",
}

PLACEHOLDER_POSTERS = {
    "generate": "/gallery/creative-whale.jpg",
    "extend": "/gallery/video-flower.jpg",
    "restyle": "/gallery/style-cyber-tokyo.jpg",
    "retry-agent": "/gallery/anime-cyber.jpg",
}

IGNORED_FRONTEND_ROUTE_PREFIXES = ("/__",)
IGNORED_FRONTEND_ROUTE_EXACT = {"/"}
