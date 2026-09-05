"""
Art Chat Orchestrator — Intent recognition + Bot routing + Image/Video generation
Routes to real art.myshell.ai bots via CDP browser automation.
"""
import json, os, re, asyncio, base64, httpx, uuid
from typing import AsyncGenerator, Optional
from studio_app.registry.bot_catalog import (
    MYSHELL_BOTS, get_bot_info, get_bot_by_slug,
    get_bots_by_type, build_bot_list_for_prompt
)

# Directory for generated images served as static files
_base = os.path.dirname(os.path.abspath(__file__))
GENERATED_DIR = os.path.join(_base, "..", "..", "frontend", "dist", "generated")
if not os.path.exists(os.path.join(_base, "..", "..", "frontend")):
    GENERATED_DIR = os.path.join(_base, "..", "frontend", "dist", "generated")
if not os.path.exists(os.path.dirname(GENERATED_DIR)):
    GENERATED_DIR = os.path.join(_base, "frontend", "dist", "generated")
os.makedirs(GENERATED_DIR, exist_ok=True)

def _save_b64_to_file(b64_data: str) -> str:
    """Save base64 image data to a static file and return the URL path."""
    filename = f"{uuid.uuid4().hex[:12]}.png"
    filepath = os.path.join(GENERATED_DIR, filename)
    with open(filepath, "wb") as f:
        f.write(base64.b64decode(b64_data))
    return f"/generated/{filename}"

try:
    from myshell_bridge import generate_via_bot
    HAS_MYSHELL = True
except ImportError:
    HAS_MYSHELL = False

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")

INTENT_SYSTEM_PROMPT = """You are MyShell Art's AI assistant. Understand the user's creative request and route to the best Bot on the platform.

Available Bots (38 total):
{bot_list}

IMPORTANT RULES:
- If user UPLOADS an image: prefer image-to-image or image-to-video bots (they need a reference image)
- If user only types TEXT (no image): prefer text-to-image bots, OR suggest they upload an image for image-to-image/video bots
- Match keywords in user request to bot keywords
- For video requests: use image-to-video bots
- For style/filter requests: use the matching image-to-image bot
- For face/beauty analysis: use the matching analysis bot
- For dance/animation: use the matching video bot

Reply in JSON only:
{{
  "intent": "text-to-image | image-to-image | image-to-video | face-analysis | style-transfer",
  "analysis": "one-line analysis of user intent",
  "selected_bot_slug": "the bot slug (e.g. seedream-multi-chart)",
  "reason": "why this bot was chosen (brief)",
  "optimized_prompt": "optimized English prompt for the bot (detailed: subject, style, lighting, composition)",
  "needs_image": true/false,
  "suggestion": "if needs_image but user didn't upload: suggest what kind of image to upload"
}}"""


async def understand_intent(user_message: str, has_image: bool = False) -> dict:
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not configured")

    bot_list_text = build_bot_list_for_prompt()
    system_prompt = INTENT_SYSTEM_PROMPT.format(bot_list=bot_list_text)
    extra = "\n(User uploaded a reference image — prefer image-to-image or image-to-video bots)" if has_image else \
            "\n(User did NOT upload an image — if the best bot needs an image, set needs_image=true and give a suggestion)"

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"
    payload = {
        "contents": [{"role": "user", "parts": [{"text": system_prompt + extra + "\n\nUser input: " + user_message}]}],
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 1024, "thinkingConfig": {"thinkingBudget": 0}}
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
        data = resp.json()

    text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
    if text.startswith("```"):
        text = re.sub(r'^```(?:json)?\s*', '', text)
        text = re.sub(r'\s*```$', '', text)

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', text, re.DOTALL)
        if match:
            try: return json.loads(match.group())
            except: pass
        return {
            "intent": "text-to-image", "analysis": "Creative image generation",
            "selected_bot_slug": "seedream-multi-chart", "reason": "General creative generation",
            "optimized_prompt": text[:500] if text else "A creative artistic image",
            "needs_image": not has_image
        }


async def orchestrate_stream(user_message: str, conversation_id: str = None, image_data: str = None) -> AsyncGenerator[dict, None]:
    has_image = image_data is not None

    # Step 1: Understanding intent
    yield {"type": "thinking", "step": "understanding", "icon": "🔍", "message": "Analyzing your request..."}
    await asyncio.sleep(0.3)

    try:
        intent_result = await understand_intent(user_message, has_image)
    except Exception as e:
        yield {"type": "error", "message": f"Failed to analyze request: {str(e)}"}
        return

    analysis = intent_result.get("analysis", "Analysis complete")
    yield {"type": "thinking", "step": "understood", "icon": "✅", "message": f"Understood: {analysis}"}
    await asyncio.sleep(0.3)

    # Step 2: Bot matching
    bot_slug = intent_result.get("selected_bot_slug", "seedream-multi-chart")
    bot_info = get_bot_info(bot_slug)
    reason = intent_result.get("reason", "Best match")
    needs_image = intent_result.get("needs_image", False)
    suggestion = intent_result.get("suggestion", "")

    yield {
        "type": "thinking", "step": "matching", "icon": "🤖",
        "message": f"Selected: {bot_info['name']} {bot_info['icon']} ⭐{bot_info['rating']}",
        "detail": reason,
        "bot": {"id": bot_info["id"], "name": bot_info["name"], "icon": bot_info["icon"],
                "rating": bot_info["rating"], "description": bot_info["description"],
                "type": bot_info["type"],
                "page_url": f"https://art.myshell.ai/creative/{bot_slug}"}
    }
    await asyncio.sleep(0.3)

    # Step 3: Check if image is needed but not provided
    bot_type = bot_info["type"]
    if bot_type in ("image-to-image", "image-to-video") and not has_image:
        # The bot needs an image — provide helpful guidance + generate with Gemini as preview
        yield {"type": "thinking", "step": "preparing", "icon": "💡",
               "message": f"This bot works best with an uploaded image",
               "detail": suggestion or f"Upload a photo to use {bot_info['name']}"}

        # Generate a preview with Gemini so user sees something
        yield {"type": "thinking", "step": "generating", "icon": "🎨",
               "message": "Generating AI preview (upload your photo for the real bot experience)...",
               "eta_seconds": 15}

        optimized_prompt = intent_result.get("optimized_prompt", user_message)
        try:
            image_b64 = await _generate_image_gemini(optimized_prompt)
        except Exception as e:
            yield {"type": "error", "message": f"Generation failed: {str(e)}"}
            return

        if not image_b64:
            yield {"type": "error", "message": "Generation failed. Try again."}
            return

        yield {"type": "thinking", "step": "completed", "icon": "✅", "message": "Preview generated!"}

        image_url = _save_b64_to_file(image_b64)
        yield {
            "type": "result",
            "image_url": image_url,
            "bot_used": {"id": bot_info["id"], "name": bot_info["name"],
                         "icon": bot_info["icon"], "rating": bot_info["rating"]},
            "prompt_used": optimized_prompt,
            "source": "gemini_preview",
            "message": f"✨ AI Preview — For the full {bot_info['name']} experience, upload your own photo!",
            "bot_page_url": f"https://art.myshell.ai/creative/{bot_slug}",
            "needs_image_hint": suggestion or f"Upload a photo to use {bot_info['name']} {bot_info['icon']}"
        }
        return

    # Step 4: Generate
    optimized_prompt = intent_result.get("optimized_prompt", user_message)
    yield {"type": "thinking", "step": "preparing", "icon": "⚙️",
           "message": "Preparing generation...",
           "detail": f"Prompt: {optimized_prompt[:100]}..."}
    await asyncio.sleep(0.2)

    # Try MyShell Art bot via CDP automation
    if HAS_MYSHELL and has_image and bot_type in ("image-to-image", "image-to-video"):
        yield {"type": "thinking", "step": "generating", "icon": "🎨",
               "message": f"Generating via {bot_info['name']}...",
               "detail": "This may take 1-10 minutes depending on server load",
               "eta_seconds": bot_info.get("avg_latency_s", 90)}

        # Use asyncio.Queue for progress streaming
        progress_q = asyncio.Queue()

        async def on_progress(pct):
            await progress_q.put(pct)

        async def run_bridge():
            try:
                return await generate_via_bot(
                    bot_slug=bot_slug,
                    prompt=optimized_prompt,
                    gen_button=bot_info.get("gen_button", ""),
                    image_data=image_data,
                    progress_callback=on_progress
                )
            finally:
                await progress_q.put(None)  # Signal done

        bridge_task = asyncio.create_task(run_bridge())
        last_pct = -1

        # Stream progress until bridge finishes
        while True:
            try:
                pct = await asyncio.wait_for(progress_q.get(), timeout=5)
                if pct is None:
                    break
                if pct != last_pct:
                    last_pct = pct
                    yield {"type": "thinking", "step": "generating", "icon": "🎨",
                           "message": f"Generating via {bot_info['name']}... {pct}%",
                           "progress": pct}
            except asyncio.TimeoutError:
                if bridge_task.done():
                    break

        try:
            result = await bridge_task
            if result.get("status") == "done":
                output_key = "video_url" if bot_type == "image-to-video" else "image_url"
                yield {"type": "thinking", "step": "completed", "icon": "✅",
                       "message": f"Generated via {bot_info['name']}!"}
                yield {
                    "type": "result",
                    output_key: result.get("output_url", ""),
                    "bot_used": {"id": bot_info["id"], "name": bot_info["name"],
                                 "icon": bot_info["icon"], "rating": bot_info["rating"]},
                    "prompt_used": optimized_prompt,
                    "source": "myshell_art",
                    "message": f"Generated by {bot_info['name']} {bot_info['icon']} via MyShell Art"
                }
                return
            else:
                error_msg = result.get("message", "Unknown error")
                yield {"type": "thinking", "step": "fallback", "icon": "🔄",
                       "message": f"MyShell Art: {error_msg}. Using AI generation..."}
        except Exception as e:
            import traceback
            tb = traceback.format_exc()
            yield {"type": "thinking", "step": "fallback", "icon": "🔄",
                   "message": f"MyShell Art error: {str(e)[:60]}. Using AI generation..."}
            print(f"[MYSHELL_BRIDGE_ERROR] {tb}")

    # Gemini generation (text-to-image or fallback with reference image)
    yield {"type": "thinking", "step": "generating", "icon": "🎨",
           "message": "Generating image..." + (" (with your reference image)" if has_image else ""),
           "eta_seconds": bot_info.get("avg_latency_s", 15)}

    try:
        image_b64 = await _generate_image_gemini(optimized_prompt, reference_image=image_data)
    except Exception as e:
        yield {"type": "error", "message": f"Image generation failed: {str(e)}"}
        return

    if not image_b64:
        yield {"type": "error", "message": "Generation failed. Try a different description."}
        return

    yield {"type": "thinking", "step": "completed", "icon": "✅", "message": "Generation complete!"}

    # Save base64 to file and serve as URL (avoids huge SSE payload)
    image_url = _save_b64_to_file(image_b64)

    yield {
        "type": "result", "image_url": image_url,
        "bot_used": {"id": bot_info["id"], "name": bot_info["name"],
                     "icon": bot_info["icon"], "rating": bot_info["rating"]},
        "prompt_used": optimized_prompt,
        "source": "gemini",
        "message": f"Generated by {bot_info['name']} {bot_info['icon']}"
    }


async def _generate_image_gemini(prompt: str, reference_image: str = None) -> Optional[str]:
    """Generate image using Gemini. If reference_image (base64) provided, use it as input for style transfer."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key={GEMINI_API_KEY}"

    parts = []
    if reference_image:
        # Include the reference image — Gemini will use it for style transfer / editing
        parts.append({
            "inlineData": {
                "mimeType": "image/jpeg",
                "data": reference_image
            }
        })
        parts.append({"text": f"Using this image as reference, {prompt}"})
    else:
        parts.append({"text": f"Generate this image: {prompt}"})

    payload = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"responseModalities": ["TEXT", "IMAGE"], "temperature": 0.8}
    }
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
        data = resp.json()

    for part in data.get("candidates", [{}])[0].get("content", {}).get("parts", []):
        if "inlineData" in part:
            return part["inlineData"]["data"]
    return None
