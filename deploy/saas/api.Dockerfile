FROM golang:1.27.1-bookworm AS build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
ARG AWWO_REVISION=unknown
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X awwo/backend/internal/app.buildRevision=${AWWO_REVISION}" -o /awwo-api ./cmd/api
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /awwo-api /usr/local/bin/awwo-api
# A named volume mounted here inherits this ownership, so the read-only API can write generated media.
RUN mkdir -p /var/lib/awwo/media && chown 65532:65532 /var/lib/awwo/media && chmod 0750 /var/lib/awwo/media
USER 65532:65532
EXPOSE 8087
ENTRYPOINT ["/usr/local/bin/awwo-api"]
