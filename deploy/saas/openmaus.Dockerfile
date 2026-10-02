FROM docker:29.1.2-cli AS docker-cli

FROM node:26.3.0-bookworm-slim AS core
COPY --from=docker-cli /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY apps/openmaus-worker/setup.ts apps/openmaus-worker/setup.ts
COPY third_party/openmaus-core/ third_party/openmaus-core/
RUN node apps/openmaus-worker/setup.ts

FROM node:26.3.0-bookworm-slim
COPY --from=core /etc/ssl/certs/ /etc/ssl/certs/
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/bin/docker
COPY apps/openmaus-worker/*.ts apps/openmaus-worker/
COPY apps/openmaus-worker/package.json apps/openmaus-worker/package.json
COPY apps/openai-agents-worker/workspace-sandbox.ts apps/openai-agents-worker/workspace-sandbox.ts
COPY --from=core /app/apps/openmaus-worker/.runtime/core/dist-server/ apps/openmaus-worker/.runtime/core/dist-server/
ENV AWWO_OPENMAUS_DATA_DIR=/tmp/awwo-openmaus AWWO_OPENMAUS_DOCKER=/usr/bin/docker
USER node
EXPOSE 8099
CMD ["node", "apps/openmaus-worker/server.ts"]
