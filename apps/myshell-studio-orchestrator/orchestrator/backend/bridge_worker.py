"""Bridge worker — runs MyShell bot generation as standalone process.
Called as subprocess to avoid async event loop conflicts with FastAPI.

Detection: monitors progress percentage (5%...99%...done).
When progress disappears and Cancel button is gone = generation complete.
Then extract result image with embed_obj in URL.
"""
import json, asyncio, base64, time, tempfile, os, sys, urllib.parse
import websockets, httpx

DEFAULT_CDP_URL = "http://127.0.0.1:9222"

def _cdp_url():
    return (os.environ.get("MYSHELL_CDP_URL") or DEFAULT_CDP_URL).rstrip("/")


def _page_blocker_state(current_url, body_text):
    url = str(current_url or "")
    text = str(body_text or "")
    lower_text = text.lower()
    if "cf-captcha" in url or "connection is secure" in lower_text or "challenge-platform" in text:
        return {
            "status": "captcha_required",
            "message": "Cloudflare captcha challenge blocked the MyShell Art target page; use a verified browser session or complete the challenge before running target bots.",
            "currentUrl": url,
        }
    return {"status": "ok", "message": "", "currentUrl": url}


def _select_cdp_page(pages):
    page_targets = [page for page in pages if page.get("type") == "page" and page.get("webSocketDebuggerUrl")]
    if not page_targets:
        return pages[0] if pages else None
    return next((page for page in page_targets if "art.myshell.ai" in page.get("url", "")), page_targets[0])

async def generate(bot_slug, gen_button, image_b64, prompt=""):
    cdp_url = _cdp_url()
    pages = (await httpx.AsyncClient().get(f"{cdp_url}/json")).json()
    if not pages:
        return {
            "status": "error",
            "message": f"Chrome CDP returned no inspectable pages at {cdp_url}; start or refresh Chrome.",
        }
    tab = _select_cdp_page(pages)
    if not tab:
        return {
            "status": "error",
            "message": f"Chrome CDP returned no inspectable pages at {cdp_url}; start or refresh Chrome.",
        }
    ws_url = tab["webSocketDebuggerUrl"]

    async with websockets.connect(ws_url, max_size=50*1024*1024) as ws:
        mid = [0]
        async def cdp(method, params=None):
            mid[0] += 1
            m = {"id": mid[0], "method": method}
            if params: m["params"] = params
            await ws.send(json.dumps(m))
            while True:
                r = json.loads(await ws.recv())
                if r.get("id") == mid[0]: return r

        async def ev(expr):
            r = await cdp("Runtime.evaluate", {"expression": expr, "returnByValue": True})
            return r.get("result",{}).get("result",{}).get("value","")

        # Clear state
        await cdp("Page.navigate", {"url": "about:blank"})
        await asyncio.sleep(1)

        # Navigate to bot
        await cdp("Page.navigate", {"url": f"https://art.myshell.ai/creative/{bot_slug}"})
        await asyncio.sleep(8)

        blocker = _page_blocker_state(
            await ev("location.href"),
            await ev("document.body.innerText.slice(0, 1000)"),
        )
        if blocker["status"] != "ok":
            return blocker

        # Record existing embed_obj images BEFORE generation
        before_imgs_json = await ev("""
            JSON.stringify(
                Array.from(document.querySelectorAll('img'))
                    .map(i => i.src)
                    .filter(s => s.includes('embed_obj'))
            )
        """)
        before_embed = set(json.loads(before_imgs_json)) if before_imgs_json else set()

        # Upload image
        if image_b64:
            img_bytes = base64.b64decode(image_b64)
            tmp = tempfile.mktemp(suffix=".jpg")
            with open(tmp, "wb") as f: f.write(img_bytes)

            doc = await cdp("DOM.getDocument")
            root = doc["result"]["root"]["nodeId"]
            fi = await cdp("DOM.querySelector", {"nodeId": root, "selector": 'input[type="file"]'})
            node_id = fi.get("result",{}).get("nodeId", 0)
            if node_id:
                await cdp("DOM.setFileInputFiles", {"nodeId": node_id, "files": [tmp]})
            await asyncio.sleep(2)
            try: os.unlink(tmp)
            except: pass

        if prompt:
            prompt_value = json.dumps(prompt)
            filled_prompt = await ev(f"""
                (() => {{
                    const value = {prompt_value};
                    const candidates = Array.from(
                        document.querySelectorAll('textarea,[contenteditable="true"],input[type="text"],input:not([type])')
                    ).filter(el => !el.disabled && !el.readOnly);
                    const input = candidates.find(el => el.offsetParent !== null) || candidates[0];
                    if (!input) return 'missing';
                    input.focus();
                    if (input.isContentEditable) {{
                        input.textContent = value;
                        input.dispatchEvent(new InputEvent('input', {{ bubbles: true, inputType: 'insertText', data: value }}));
                    }} else {{
                        input.value = value;
                        input.dispatchEvent(new Event('input', {{ bubbles: true }}));
                        input.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    }}
                    return 'filled';
                }})()
            """)
            if filled_prompt == "missing":
                blocker = _page_blocker_state(
                    await ev("location.href"),
                    await ev("document.body.innerText.slice(0, 1000)"),
                )
                if blocker["status"] != "ok":
                    return blocker
                return {"status": "error", "message": "Prompt input not found or unavailable"}

        # Click I Agree (appears after upload)
        await ev("(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='I Agree');if(b)b.click()})()")
        await asyncio.sleep(2)

        button_label = json.dumps(gen_button or "")
        click = await ev(f"""
            (()=>{{
                const wanted={button_label}.trim();
                const btns=Array.from(document.querySelectorAll('button'));
                const btn=wanted ? btns.find(b=>b.textContent.includes(wanted)&&!b.disabled) : null;
                if(btn){{btn.click();return 'ok'}}
                const fb=btns.find(b=>/generate|create|start/i.test(b.textContent)&&!b.disabled);
                if(fb){{fb.click();return 'fb'}}
                return 'no'
            }})()
        """)
        if click == 'no':
            return {"status": "error", "message": "Generate button not found or disabled"}

        # Wait for generation: monitor progress % → completion
        # Typical flow: 0% → 5% → ... → 99% → done (progress disappears)
        seen_progress = False
        for i in range(220):  # 220 * 3s = 660s max (~11 min)
            await asyncio.sleep(3)

            state = await ev("""
                (() => {
                    const text = document.body.innerText;
                    const pctMatch = text.match(/(\\d+)%/);
                    const hasCancel = !!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Cancel');
                    const ready = text.includes('Your image is ready');
                    return JSON.stringify({
                        pct: pctMatch ? parseInt(pctMatch[1]) : null,
                        cancel: hasCancel,
                        ready: ready
                    });
                })()
            """)
            data = json.loads(state)
            pct = data.get("pct")

            if pct is not None:
                seen_progress = True
                # Output progress to stdout for parent process to stream
                sys.stdout.write(json.dumps({"type": "progress", "pct": pct}) + "\n")
                sys.stdout.flush()

            # Generation complete: progress was seen, now gone, no Cancel button
            if (seen_progress and pct is None and not data["cancel"]) or data["ready"]:
                await asyncio.sleep(2)  # Brief wait for DOM to fully update

                # Extract NEW result images (not in before_embed set)
                result = await ev("""
                    JSON.stringify(
                        Array.from(document.querySelectorAll('img'))
                            .filter(i => i.src.includes('embed_obj'))
                            .map(i => i.src)
                    )
                """)
                after_imgs = set(json.loads(result)) if result else set()
                new_imgs = after_imgs - before_embed

                if new_imgs:
                    url = list(new_imgs)[0]
                    # Extract original URL from CDN wrapper
                    if '/cdn-cgi/image/' in url:
                        parts = url.split('/image/chat/')
                        if len(parts) > 1:
                            url = f"https://www.myshellstatic.com/image/chat/{parts[1]}"
                    return {"status": "done", "output_url": url}

                return {"status": "error", "message": "Generation completed but no fresh result image found"}

        return {"status": "error", "message": "Generation timed out (660s)"}

if __name__ == "__main__":
    # Accept args as JSON file path or inline JSON
    arg = sys.argv[1]
    if os.path.isfile(arg):
        with open(arg) as f:
            args = json.loads(f.read())
    else:
        args = json.loads(arg)

    result = asyncio.run(generate(args["slug"], args["button"], args.get("image", ""), args.get("prompt", "")))
    print(json.dumps(result))
