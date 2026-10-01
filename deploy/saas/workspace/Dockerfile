# Build this operator-owned image in CI, then configure the worker with its immutable image digest.
# Image pulling happens during the controlled build/deploy step; runtime always uses --pull=never.
FROM alpine:3.22.1 AS certificates

FROM node:22.19.0-bookworm-slim
COPY --from=certificates /etc/ssl/cert.pem /etc/ssl/certs/ca-certificates.crt

RUN test -s /etc/ssl/certs/ca-certificates.crt \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y --no-install-recommends python3 python3-venv git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# No application credentials, source checkout, Docker client, daemon socket or host volume is embedded.
# Debian's node user has uid/gid 1000. The broker supplies bounded writable tmpfs mounts at runtime.
USER 1000:1000
WORKDIR /workspace
ENV HOME=/workspace PYTHONDONTWRITEBYTECODE=1
CMD ["python3", "-I", "-S", "-c", "import time; time.sleep(86400)"]
