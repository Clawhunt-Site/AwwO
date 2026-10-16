# Build this operator-owned image in CI, then configure the worker with its immutable image digest.
# Image pulling happens during the controlled build/deploy step; runtime always uses --pull=never.
# The build context is this directory: docker build -t awwo-workspace:<tag> deploy/saas/workspace
FROM alpine:3.22.1 AS certificates

FROM node:22.19.0-bookworm-slim
COPY --from=certificates /etc/ssl/cert.pem /etc/ssl/certs/ca-certificates.crt

# chromium-headless-shell is Debian's Chromium (bookworm-security, the same version as the chromium package) built
# for automation, without GTK, D-Bus or systemd. chromium-common depends on the desktop helpers x11-utils and
# xdg-utils, which bring Mesa and LLVM (about 215 MB) that a headless browser never loads, so a local placeholder
# package provides those two names. procps: rea needs a procps ps on PATH. Fonts: DejaVu (Latin, Greek, Cyrillic,
# 3 MB) and WenQuanYi Micro Hei (Chinese, Japanese, Korean, 5 MB) instead of fonts-noto-cjk (91 MB); fontconfig
# builds the font cache now, so no run writes one.
RUN test -s /etc/ssl/certs/ca-certificates.crt \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && mkdir -p /tmp/placeholder/DEBIAN \
    && printf '%s\n' 'Package: awwo-headless-placeholders' 'Version: 1' 'Architecture: all' \
       'Maintainer: AwwO operators <ops@awwo.invalid>' 'Provides: x11-utils, xdg-utils' \
       'Description: stands in for desktop helpers the headless workspace browser does not use' > /tmp/placeholder/DEBIAN/control \
    && dpkg-deb --root-owner-group --build /tmp/placeholder /tmp/placeholder.deb \
    && dpkg -i /tmp/placeholder.deb \
    && rm -r /tmp/placeholder /tmp/placeholder.deb \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y --no-install-recommends python3 python3-venv git ca-certificates \
       procps chromium-headless-shell fontconfig fonts-dejavu-core fonts-wqy-microhei \
    && rm -rf /var/lib/apt/lists/*

# rea-agents and playwright-core at the exact versions and integrity hashes in tools/package-lock.json. No install
# script runs: the only one in the tree is frida's (an optional rea dependency for live instrumentation), which would
# download a prebuilt binary that static analysis does not use. Playwright drives the system Chromium and never
# downloads a browser.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY tools/package.json tools/package-lock.json /opt/awwo/tools/
RUN npm ci --prefix /opt/awwo/tools --omit=dev --ignore-scripts --no-audit --no-fund --cache /tmp/npm-cache \
    && rm -r /tmp/npm-cache
COPY tools/awwo-check-page.mjs /opt/awwo/tools/
# Sandbox commands run with PATH=/usr/local/bin:/usr/bin:/bin, so both commands are linked into /usr/local/bin.
# The last line only proves the wiring (links, module resolution, the browser binary); it writes nothing.
RUN chmod 0755 /opt/awwo/tools/awwo-check-page.mjs \
    && ln -s /opt/awwo/tools/awwo-check-page.mjs /usr/local/bin/awwo-check-page \
    && ln -s /opt/awwo/tools/node_modules/.bin/rea /usr/local/bin/rea \
    && rea --version && awwo-check-page --help > /dev/null && /usr/lib/chromium/chromium-headless-shell --version

# No application credentials, source checkout, Docker client, daemon socket or host volume is embedded.
# Debian's node user has uid/gid 1000. The broker supplies bounded writable tmpfs mounts at runtime.
USER 1000:1000
WORKDIR /workspace
ENV HOME=/workspace PYTHONDONTWRITEBYTECODE=1
CMD ["python3", "-I", "-S", "-c", "import time; time.sleep(86400)"]
