# THIRD_PARTY_NOTICES.md, AwwO's LICENSE, every license and notice file the notices name, and the licenses of the Go
# code compiled into the API, at their repository paths: noticePaths in scripts/awwo-saas-release.ts, which its test
# compares with these lines and the .dockerignore. The image keeps them in /usr/share/doc/awwo-api/.
FROM scratch AS notices
COPY LICENSE THIRD_PARTY_NOTICES.md /
COPY apps/web/src/canvas/fonts/bebas-neue.LICENSE.txt apps/web/src/canvas/fonts/cinzel.LICENSE.txt apps/web/src/canvas/fonts/exo-2.LICENSE.txt apps/web/src/canvas/fonts/instrument-serif.LICENSE.txt apps/web/src/canvas/fonts/inter.LICENSE.txt apps/web/src/canvas/fonts/jetbrains-mono.LICENSE.txt apps/web/src/canvas/fonts/manrope.LICENSE.txt apps/web/src/canvas/fonts/montserrat.LICENSE.txt apps/web/src/canvas/fonts/orbitron.LICENSE.txt apps/web/src/canvas/fonts/outfit.LICENSE.txt apps/web/src/canvas/fonts/oxanium.LICENSE.txt apps/web/src/canvas/fonts/pixelify-sans.LICENSE.txt apps/web/src/canvas/fonts/playfair-display.LICENSE.txt apps/web/src/canvas/fonts/press-start-2p.LICENSE.txt apps/web/src/canvas/fonts/rajdhani.LICENSE.txt apps/web/src/canvas/fonts/space-grotesk.LICENSE.txt apps/web/src/canvas/fonts/unbounded.LICENSE.txt /apps/web/src/canvas/fonts/
COPY apps/web/src/saas/design/fonts/LICENSE-mona-sans.txt /apps/web/src/saas/design/fonts/
COPY apps/web/src/saas/skillLicences.txt /apps/web/src/saas/
COPY examples/knowledge-workbench/data/unicode/LICENSE.txt /examples/knowledge-workbench/data/unicode/
COPY examples/knowledge-workbench/data/unicode/17.0.0/LICENSE.txt /examples/knowledge-workbench/data/unicode/17.0.0/
COPY server/LICENSE /server/
COPY server/packages/adapters/hermes/LICENSE /server/packages/adapters/hermes/
COPY third_party/adapted/ /third_party/adapted/
COPY third_party/anatomy/LICENSE /third_party/anatomy/
COPY third_party/clawwork/LICENSE third_party/clawwork/NOTICE /third_party/clawwork/
COPY third_party/go-modules/ /third_party/go-modules/
COPY third_party/open-design/LICENSE /third_party/open-design/
COPY third_party/openpencil/LICENSE /third_party/openpencil/
COPY third_party/openpencil/packages/agent-native/LICENSE /third_party/openpencil/packages/agent-native/
COPY third_party/osiris/LICENSE /third_party/osiris/
COPY third_party/wshobson-agents/LICENSE /third_party/wshobson-agents/

FROM golang:1.27.1-bookworm AS build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
ARG AWWO_REVISION=unknown
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X awwo/backend/internal/app.buildRevision=${AWWO_REVISION}" -o /awwo-api ./cmd/api
# The licenses cover what this binary links: built for linux/amd64 without cgo by the toolchain whose standard library
# they were read from, with the same modules (path, version and go.sum hash) and Go's own license. If this fails, run
# node scripts/awwo-go-licences.ts with this image's Go version and commit third_party/go-modules.
COPY --from=notices /third_party/go-modules/ /go-modules/
RUN test "$(go env GOOS)/$(go env GOARCH)" = linux/amd64 \
 && go version -m /awwo-api | awk 'NR == 1 { print "go", $2 } $1 == "dep" { print $2, $3, $4 }' | diff - /go-modules/modules.txt \
 && cmp "$(go env GOROOT)/LICENSE" /go-modules/go/LICENSE && cmp "$(go env GOROOT)/PATENTS" /go-modules/go/PATENTS
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /awwo-api /usr/local/bin/awwo-api
COPY --from=notices / /usr/share/doc/awwo-api/
# A named volume mounted here inherits this ownership, so the read-only API can write generated media.
RUN mkdir -p /var/lib/awwo/media && chown 65532:65532 /var/lib/awwo/media && chmod 0750 /var/lib/awwo/media
USER 65532:65532
EXPOSE 8087
ENTRYPOINT ["/usr/local/bin/awwo-api"]
