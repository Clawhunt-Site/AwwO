#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$ROOT_DIR/frontend/public/ai-canvaspro"
BRIDGE_SRC="$ROOT_DIR/frontend/public/studio/canvaspro/studio-bridge.js"
OVERLAY_DIR="${AI_CANVASPRO_OVERLAY_DIR:-$ROOT_DIR/frontend/integrations/canvaspro/overlays}"
OPTIONAL="0"
FORCE="0"
CLEAN="0"

for arg in "$@"; do
  case "$arg" in
    --optional)
      OPTIONAL="1"
      ;;
    --force)
      FORCE="1"
      ;;
    --clean)
      CLEAN="1"
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: bash scripts/prepare-canvaspro-static.sh [--optional] [--force] [--clean]

Creates the ignored frontend/public/ai-canvaspro local mount from an external
AI CanvasPro checkout. The third-party source stays outside git.

Environment:
  AI_CANVASPRO_STATIC_DIR   External static app directory with index.html
  AI_CANVASPRO_SERVER_DIR   Existing AI-CanvasPro checkout fallback
  AI_CANVASPRO_OVERLAY_DIR  Optional overlay tree merged over the static app
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

find_canvaspro_static_dir() {
  local candidate
  local base
  if [ -n "${AI_CANVASPRO_STATIC_DIR:-}" ]; then
    if [ -f "$AI_CANVASPRO_STATIC_DIR/index.html" ]; then
      printf "%s\n" "$AI_CANVASPRO_STATIC_DIR"
      return 0
    fi
    echo "AI_CANVASPRO_STATIC_DIR is set, but index.html was not found: $AI_CANVASPRO_STATIC_DIR" >&2
  fi

  if [ -n "${AI_CANVASPRO_SERVER_DIR:-}" ]; then
    for candidate in \
      "$AI_CANVASPRO_SERVER_DIR" \
      "$AI_CANVASPRO_SERVER_DIR/dist" \
      "$AI_CANVASPRO_SERVER_DIR/build" \
      "$AI_CANVASPRO_SERVER_DIR/out" \
      "$AI_CANVASPRO_SERVER_DIR/frontend/dist" \
      "$AI_CANVASPRO_SERVER_DIR/apps/web/dist" \
      "$AI_CANVASPRO_SERVER_DIR/renderer/dist"; do
      if [ -f "$candidate/index.html" ]; then
        printf "%s\n" "$candidate"
        return 0
      fi
    done
  fi

  for base in \
    "$ROOT_DIR/.external/AI-CanvasPro" \
    "$ROOT_DIR/.external/AI-CanvasPro-static" \
    "$ROOT_DIR/.external/ai-canvaspro" \
    "$ROOT_DIR/../AI-CanvasPro" \
    "$ROOT_DIR/../AI-CanvasPro-main" \
    "$ROOT_DIR/../ai-canvaspro"; do
    for candidate in \
      "$base" \
      "$base/dist" \
      "$base/build" \
      "$base/out" \
      "$base/frontend/dist" \
      "$base/apps/web/dist" \
      "$base/renderer/dist"; do
      if [ -f "$candidate/index.html" ]; then
        printf "%s\n" "$candidate"
        return 0
      fi
    done
  done

  return 1
}

reset_target_dir() {
  if [ -L "$TARGET_DIR" ]; then
    rm "$TARGET_DIR"
  elif [ -e "$TARGET_DIR" ]; then
    if [ "$FORCE" != "1" ] && [ ! -f "$TARGET_DIR/.studio-generated" ]; then
      echo "Refusing to replace non-generated directory: $TARGET_DIR" >&2
      echo "Move it away or rerun with --force if it is safe to regenerate." >&2
      exit 1
    fi
    rm -rf "$TARGET_DIR"
  fi
  mkdir -p "$TARGET_DIR"
  touch "$TARGET_DIR/.studio-generated"
}

clean_target_dir() {
  if [ -L "$TARGET_DIR" ]; then
    rm "$TARGET_DIR"
  elif [ -e "$TARGET_DIR" ]; then
    if [ ! -f "$TARGET_DIR/.studio-generated" ]; then
      echo "Refusing to remove non-generated directory: $TARGET_DIR" >&2
      exit 1
    fi
    rm -rf "$TARGET_DIR"
  fi
}

write_placeholder() {
  reset_target_dir
  cat > "$TARGET_DIR/index.html" <<'HTML'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI CanvasPro unavailable</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d12; color: #f7f7fb; }
      main { width: min(520px, calc(100vw - 32px)); border: 1px solid rgba(255,255,255,.14); border-radius: 12px; padding: 24px; background: rgba(255,255,255,.05); }
      h1 { margin: 0 0 10px; font-size: 20px; }
      p { margin: 0; color: rgba(247,247,251,.72); line-height: 1.6; }
      code { color: #ff7aa8; }
    </style>
  </head>
  <body data-canvaspro-placeholder="1">
    <main>
      <h1>AI CanvasPro is not installed locally</h1>
      <p>Run <code>bash scripts/setup-canvaspro.sh</code> from the repository root, then restart Studio. The CanvasPro source stays in <code>.external/</code> and is not committed.</p>
    </main>
  </body>
</html>
HTML
  cat > "$TARGET_DIR/README.local.txt" <<'TEXT'
This directory is generated locally by scripts/prepare-canvaspro-static.sh.
It is intentionally ignored by git. Do not commit AI CanvasPro source here.
TEXT
}

should_skip_merged_item() {
  case "$1" in
    .|..|.git|.github|node_modules|__pycache__|.DS_Store)
      return 0
      ;;
  esac
  return 1
}

link_overlay_tree() {
  local source_dir="$1"
  local overlay_dir="$2"
  local target_dir="$3"
  local item
  local base
  local overlay_item

  mkdir -p "$target_dir"

  if [ -n "$source_dir" ] && [ -d "$source_dir" ]; then
    for item in "$source_dir"/* "$source_dir"/.[!.]* "$source_dir"/..?*; do
      [ -e "$item" ] || continue
      base="$(basename "$item")"
      if should_skip_merged_item "$base"; then
        continue
      fi
      overlay_item="$overlay_dir/$base"
      if [ -e "$overlay_item" ]; then
        link_static_item "$item" "$overlay_item" "$target_dir/$base"
      else
        ln -s "$item" "$target_dir/$base"
      fi
    done
  fi

  if [ -d "$overlay_dir" ]; then
    for item in "$overlay_dir"/* "$overlay_dir"/.[!.]* "$overlay_dir"/..?*; do
      [ -e "$item" ] || continue
      base="$(basename "$item")"
      if should_skip_merged_item "$base" || [ -e "$target_dir/$base" ]; then
        continue
      fi
      link_static_item "" "$item" "$target_dir/$base"
    done
  fi
}

link_static_item() {
  local source_item="$1"
  local overlay_item="$2"
  local target_item="$3"

  if [ -n "$overlay_item" ] && [ -e "$overlay_item" ]; then
    if [ -d "$overlay_item" ]; then
      link_overlay_tree "$source_item" "$overlay_item" "$target_item"
    else
      ln -s "$overlay_item" "$target_item"
    fi
    return 0
  fi

  ln -s "$source_item" "$target_item"
}

link_static_app() {
  local source_dir="$1"
  local item
  local base
  local overlay_item
  reset_target_dir

  for item in "$source_dir"/* "$source_dir"/.[!.]* "$source_dir"/..?*; do
    [ -e "$item" ] || continue
    base="$(basename "$item")"
    case "$base" in
      .|..|.git|.github|.venv|venv|node_modules|__pycache__|.DS_Store)
        continue
        ;;
      .editorconfig|.gitattributes|.gitignore|AM|playwright.config.js|electron-builder.*)
        continue
        ;;
      backend|electron|native|build|docs)
        continue
        ;;
      server.py|requirements.txt|requirements-dev.txt|pyproject.toml|poetry.lock|Pipfile|Pipfile.lock)
        continue
        ;;
      package.json|package-lock.json|pnpm-lock.yaml|yarn.lock)
        continue
        ;;
      studio-bridge.js|STUDIO_INTEGRATION.md)
        continue
        ;;
      *.py|*.pyc|*.pyo|*.log|*.pid|*.tsbuildinfo|*.test.js|*.test.mjs)
        continue
        ;;
    esac
    overlay_item=""
    if [ -d "$OVERLAY_DIR" ]; then
      overlay_item="$OVERLAY_DIR/$base"
    fi
    link_static_item "$item" "$overlay_item" "$TARGET_DIR/$base"
  done

  if [ -d "$OVERLAY_DIR" ]; then
    for item in "$OVERLAY_DIR"/* "$OVERLAY_DIR"/.[!.]* "$OVERLAY_DIR"/..?*; do
      [ -e "$item" ] || continue
      base="$(basename "$item")"
      if should_skip_merged_item "$base" || [ -e "$TARGET_DIR/$base" ]; then
        continue
      fi
      link_static_item "" "$item" "$TARGET_DIR/$base"
    done
  fi

  if [ -f "$BRIDGE_SRC" ]; then
    ln -s "$BRIDGE_SRC" "$TARGET_DIR/studio-bridge.js"
  fi

  cat > "$TARGET_DIR/README.local.txt" <<TEXT
This directory is generated locally by scripts/prepare-canvaspro-static.sh.
Static source: $source_dir
The third-party AI CanvasPro source is intentionally kept outside git.
Overlay source: ${OVERLAY_DIR:-none}
TEXT
}

if [ "$CLEAN" = "1" ]; then
  clean_target_dir
  exit 0
fi

STATIC_DIR="$(find_canvaspro_static_dir || true)"
if [ -z "$STATIC_DIR" ]; then
  if [ "$OPTIONAL" = "1" ]; then
    echo "AI CanvasPro static app not found; writing local placeholder."
    write_placeholder
    exit 0
  fi
  echo "AI CanvasPro static app not found." >&2
  echo "Run: bash scripts/setup-canvaspro.sh" >&2
  exit 1
fi

if [ "$(cd "$STATIC_DIR" && pwd)" = "$(cd "$(dirname "$TARGET_DIR")" && pwd)/$(basename "$TARGET_DIR")" ]; then
  echo "Static source cannot be the generated target directory: $STATIC_DIR" >&2
  exit 1
fi

link_static_app "$STATIC_DIR"
echo "AI CanvasPro static mount prepared from: $STATIC_DIR"
if [ -d "$OVERLAY_DIR" ]; then
  echo "AI CanvasPro Studio overlay applied from: $OVERLAY_DIR"
fi
