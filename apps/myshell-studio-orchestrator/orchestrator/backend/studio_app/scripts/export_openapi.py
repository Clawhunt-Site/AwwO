from __future__ import annotations

import json
import sys
from pathlib import Path


def _ensure_backend_on_path() -> None:
    backend_root = Path(__file__).resolve().parents[2]
    backend_root_text = str(backend_root)
    if backend_root_text not in sys.path:
        sys.path.insert(0, backend_root_text)


def main() -> int:
    _ensure_backend_on_path()

    from app.factory import create_app

    schema = create_app().openapi()
    payload = json.dumps(schema, ensure_ascii=False, indent=2, sort_keys=True)
    if len(sys.argv) > 1:
        output_path = Path(sys.argv[1])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(payload + "\n", encoding="utf-8")
    else:
        sys.stdout.write(payload)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
