# The Blender workstation image (the "blender" runtime: apps/openai-agents-worker/workspace-sandbox.ts with
# AWWO_OPENAI_AGENTS_WORKSPACE_BLENDER=on): the workspace image, plus Blender 5.2.3 LTS, the Blender Lab MCP server and
# add-on 1.0.3 (both GPL-3.0-or-later, unmodified) and awwo_param. None of the three upstream files is kept in this
# repository: fetch-sources.sh downloads them, this file checks each against the hash its publisher gives, and they come
# in as the build context "sources" (README.md):
#   deploy/saas/blender/fetch-sources.sh <dir>
#   docker build --build-context sources=<dir> --build-arg BASE=awwo-workspace:<tag> -t awwo-blender:<tag> deploy/saas/blender
ARG BASE=awwo-workspace:20261028
FROM ${BASE}
USER 0:0

# What Blender's Linux build loads from the system even in --background (X11 client libraries and the GL loaders; it
# brings every other library in its own lib/). The NVIDIA driver's libraries come from the host at run time (--gpus).
RUN apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y --no-install-recommends \
       libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libsm6 libice6 libgl1 libegl1 libglvnd0 xz-utils unzip \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.lock /tmp/requirements.lock
# The three files are mounted for this step only, so the 385 MB tarball is in no layer. The hashes are blender.org's
# (download.blender.org/release/Blender5.2/blender-5.2.3.sha256) and those of the v1.0.3 release files at
# projects.blender.org/lab/blender_mcp/releases.
RUN --mount=type=bind,from=sources,target=/tmp/src cd /tmp/src \
    && printf '%s\n' \
       '78486c018b4443efe5e75ab54c290ed8c15abafd249b862c2c9ce2530a918eec  blender-5.2.3-linux-x64.tar.xz' \
       'd6fe04dd17767f7c7fb452142f1f0e6787db575db49f3976a166142683b5b97e  blender-1.0.3.mcpb' \
       'a7a9da816192502e5a0a202a396444e266b47d8fc4f74ad4698048bd43040707  mcp-1.0.3.zip' | sha256sum -c - \
    && mkdir -p /opt/blender && tar -xJf blender-5.2.3-linux-x64.tar.xz -C /opt/blender --strip-components=1 --no-same-owner \
    && python3 -m venv /opt/blmcp \
    && /opt/blmcp/bin/pip install --no-cache-dir --no-deps --require-hashes --only-binary=:all: -r /tmp/requirements.lock \
    && unzip -q blender-1.0.3.mcpb 'blmcp/*' -d /tmp/mcpb \
    && cp -r /tmp/mcpb/blmcp "$(/opt/blmcp/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')/blmcp" \
    && mkdir -p /opt/awwo/blender/user \
    && BLENDER_USER_RESOURCES=/opt/awwo/blender/user /opt/blender/blender --background --factory-startup --online-mode \
       --command extension install-file --repo user_default /tmp/src/mcp-1.0.3.zip \
    && rm -rf /tmp/mcpb /tmp/requirements.lock

# awwo_param goes where Blender's own Python finds it (its bundled site-packages), after its tests pass on that Python
# and its numpy; the tests stay out of the image. The supervisor, the startup script and the empty scene a run starts
# from are AwwO's.
COPY awwo_param /tmp/awwo_param
COPY supervisor.py startup.py mcp_call.py check.py /opt/awwo/blender/
RUN site="$(/opt/blender/blender --background --factory-startup --python-expr 'import sysconfig; print("SITE=" + sysconfig.get_paths()["purelib"])' | sed -n 's/^SITE=//p')" \
    && test -d "$site" \
    && HOME=/tmp /opt/blender/5.2/python/bin/python3.13 -B -m unittest discover -s /tmp/awwo_param/tests -t /tmp \
    && cp -r /tmp/awwo_param "$site/awwo_param" && rm -r "$site/awwo_param/tests" /tmp/awwo_param \
    && /opt/blender/blender --background --factory-startup --python-expr \
       'import bpy; bpy.ops.wm.read_factory_settings(use_empty=True); bpy.ops.wm.save_as_mainfile(filepath="/opt/awwo/blender/empty.blend")' \
    && chmod -R a+rX,go-w /opt/blender /opt/blmcp /opt/awwo/blender \
    && ln -s /opt/blender/blender /usr/local/bin/blender

ENV BLENDER_USER_RESOURCES=/opt/awwo/blender/user BLENDER_MCP_HOST=127.0.0.1 BLENDER_MCP_PORT=9876 BLENDER_PATH=/opt/blender/blender
# Proves the wiring without a GPU: the add-on loads and answers, the MCP server lists its tools, awwo_param imports.
RUN HOME=/tmp python3 -I -S /opt/awwo/blender/check.py && { rm -rf /tmp/* /tmp/.[!.]* 2>/dev/null || true; }

USER 1000:1000
WORKDIR /workspace
ENV HOME=/workspace PYTHONDONTWRITEBYTECODE=1
CMD ["python3", "-I", "-S", "/opt/awwo/blender/supervisor.py"]
