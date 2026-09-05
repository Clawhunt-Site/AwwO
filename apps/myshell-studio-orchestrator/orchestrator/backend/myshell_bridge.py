"""
MyShell Art Bridge — calls bridge_worker.py as subprocess.
Passes args via temp file. Streams progress lines from worker stdout.
"""
import json, asyncio, os, sys, tempfile

WORKER_PATH = os.path.join(os.path.dirname(__file__), "bridge_worker.py")


async def generate_via_bot(bot_slug: str, prompt: str = "", gen_button: str = "",
                           image_data: str = None, progress_callback=None) -> dict:
    """Generate via art.myshell.ai bot using CDP browser automation (subprocess).

    progress_callback: async callable(pct: int) — called with progress percentage updates.
    """
    args = {
        "slug": bot_slug,
        "button": gen_button,
        "prompt": prompt or "",
        "image": image_data or ""
    }
    args_file = tempfile.mktemp(suffix=".json")
    with open(args_file, "w") as f:
        json.dump(args, f)

    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, WORKER_PATH, args_file,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=os.path.dirname(__file__)
        )

        result = None

        async def read_output():
            nonlocal result
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                text = line.decode().strip()
                if not text:
                    continue
                try:
                    data = json.loads(text)
                    if data.get("type") == "progress" and progress_callback:
                        await progress_callback(data.get("pct", 0))
                    elif "status" in data:
                        result = data
                except json.JSONDecodeError:
                    pass

        try:
            await asyncio.wait_for(read_output(), timeout=700)
        except asyncio.TimeoutError:
            try: proc.kill()
            except: pass
            return {"status": "error", "message": "Generation timed out (700s)"}

        await proc.wait()

        if result:
            return result

        stderr = (await proc.stderr.read()).decode().strip()[-200:]
        return {"status": "error", "message": f"No result from worker: {stderr}"}

    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        try: os.unlink(args_file)
        except: pass
