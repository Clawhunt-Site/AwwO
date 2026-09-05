from __future__ import annotations

import base64
import json
import uuid
from datetime import UTC, datetime
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from sse_starlette.sse import EventSourceResponse

from studio_app.registry.bot_catalog import MYSHELL_BOTS, PROMPT_GALLERY, get_bots_by_type
from studio_app.registry.bot_previews import list_bot_previews, load_preview_manifest, preview_for_bot
try:
    from orchestrator import orchestrate_stream
except ImportError:  # pragma: no cover - supports package-style test imports from repo root
    from orchestrator.backend.orchestrator import orchestrate_stream
from studio_app.infrastructure.db.sqlite_store import STUDIO_STORE
from studio_app.infrastructure.runtime.health import runtime_health


router = APIRouter()
conversations: dict[str, dict] = {}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


@router.get("/api/health")
async def health():
    return await runtime_health(STUDIO_STORE.path)


@router.post("/api/chat")
async def chat(
    message: str = Form(...),
    conversation_id: Optional[str] = Form(None),
    image: Optional[UploadFile] = File(None),
):
    """Legacy chat endpoint that streams orchestration events over SSE."""

    if not conversation_id:
        conversation_id = str(uuid.uuid4())

    image_data = None
    if image:
        image_data = base64.b64encode(await image.read()).decode()

    if conversation_id not in conversations:
        conversations[conversation_id] = {
            "id": conversation_id,
            "messages": [],
            "created_at": _now_iso(),
        }

    conversations[conversation_id]["messages"].append(
        {
            "role": "user",
            "content": message,
            "has_image": image_data is not None,
            "timestamp": _now_iso(),
        }
    )

    async def event_generator():
        yield {
            "event": "meta",
            "data": json.dumps({"conversation_id": conversation_id}),
        }
        async for event in orchestrate_stream(message, conversation_id, image_data):
            event_type = event.get("type", "thinking")
            yield {
                "event": event_type,
                "data": json.dumps(event, ensure_ascii=False),
            }
        yield {
            "event": "done",
            "data": json.dumps({"status": "complete"}),
        }

    return EventSourceResponse(
        event_generator(),
        ping=15,
        ping_message_factory=lambda: "keepalive",
    )


@router.get("/api/gallery")
async def get_gallery(category: Optional[str] = None, limit: int = 12):
    items = PROMPT_GALLERY
    if category and category != "全部":
        items = [item for item in items if item["category"] == category]
    return {
        "items": items[:limit],
        "categories": list({item["category"] for item in PROMPT_GALLERY}),
    }


@router.get("/api/bots")
async def get_bots(type: Optional[str] = None):
    bots = get_bots_by_type(type) if type else MYSHELL_BOTS
    preview_manifest = list_bot_previews()
    preview_source_manifest = load_preview_manifest()
    return {
        "total": len(bots),
        "bots": [
            {
                "slug": bot["slug"],
                "name": bot["name"],
                "icon": bot["icon"],
                "type": bot["type"],
                "description": bot["desc"],
                "rating": bot["rating"],
                "gen_button": bot.get("gen_button", ""),
                "page_url": f"https://art.myshell.ai/creative/{bot['slug']}",
                "keywords": bot.get("keywords", []),
                "preview": preview_for_bot({**bot, "pageId": "myshell-art"}, preview_source_manifest),
            }
            for bot in bots
        ],
        "previews": {
            "version": preview_manifest["version"],
            "source": preview_manifest["source"],
            "generatedAt": preview_manifest["generatedAt"],
            "summary": preview_manifest["summary"],
        },
        "summary": {
            "text-to-image": len(get_bots_by_type("text-to-image")),
            "image-to-image": len(get_bots_by_type("image-to-image")),
            "image-to-video": len(get_bots_by_type("image-to-video")),
        },
    }


@router.get("/api/conversations/{conversation_id}")
async def get_conversation(conversation_id: str):
    if conversation_id not in conversations:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversations[conversation_id]
