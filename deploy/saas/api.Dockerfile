FROM golang:1.27.1-bookworm AS build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /awwo-api ./cmd/api
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /awwo-api /usr/local/bin/awwo-api
USER 65532:65532
EXPOSE 8087
ENTRYPOINT ["/usr/local/bin/awwo-api"]
