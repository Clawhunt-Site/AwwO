#!/bin/sh
# Downloads the three upstream files the Blender workstation image is built from into <dir> and checks each against the
# hash its publisher gives (the Dockerfile checks them again): Blender 5.2.3 LTS for Linux x64 (blender.org), and the
# Blender Lab MCP server bundle and add-on, release v1.0.3 (projects.blender.org/lab/blender_mcp). They stay out of this
# repository; pass <dir> to docker build as the build context "sources" (README.md).
# Usage: deploy/saas/blender/fetch-sources.sh <dir>   (honours HTTPS_PROXY)
set -eu
dir=${1:?usage: fetch-sources.sh <dir>}
mkdir -p "$dir"
cd "$dir"
fetch() { # <url> <file> <sha256>
  if [ ! -f "$2" ] || ! printf '%s  %s\n' "$3" "$2" | sha256sum -c - >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2.part" "$1"
    mv "$2.part" "$2"
  fi
  printf '%s  %s\n' "$3" "$2" | sha256sum -c -
}
fetch https://download.blender.org/release/Blender5.2/blender-5.2.3-linux-x64.tar.xz blender-5.2.3-linux-x64.tar.xz \
  78486c018b4443efe5e75ab54c290ed8c15abafd249b862c2c9ce2530a918eec
fetch https://projects.blender.org/lab/blender_mcp/releases/download/v1.0.3/blender-1.0.3.mcpb blender-1.0.3.mcpb \
  d6fe04dd17767f7c7fb452142f1f0e6787db575db49f3976a166142683b5b97e
fetch https://projects.blender.org/lab/blender_mcp/releases/download/v1.0.3/mcp-1.0.3.zip mcp-1.0.3.zip \
  a7a9da816192502e5a0a202a396444e266b47d8fc4f74ad4698048bd43040707
