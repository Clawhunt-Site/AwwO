# The sandbox workspaces' one way to the web (backend/cmd/egress-proxy). Run it on a network with a route out and
# give it the host directory the workers mount into workspaces: docker run --restart unless-stopped \
#   --env AWWO_EGRESS_SECRET --env AWWO_EGRESS_SOCKET=/run/awwo-egress/egress.sock --env AWWO_EGRESS_DENY=<host IPs> \
#   --mount type=bind,source=/var/lib/awwo/egress,target=/run/awwo-egress awwo-egress:<tag>
FROM golang:1.27.1-bookworm AS build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /awwo-egress ./cmd/egress-proxy
FROM debian:bookworm-slim
COPY --from=build /awwo-egress /usr/local/bin/awwo-egress
# The mounted socket directory must be writable by this user (install -d -o 65532 -g 65532 -m 0755 on the host).
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/awwo-egress"]
