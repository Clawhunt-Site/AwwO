# Folder provenance

- Created: 2026-10-15.
- Creator: Claude (Opus 5.5), oss-intake session, for the owner's request to add video capabilities to AwwO.
- Purpose: isolate motion rendering (HTML animation page → MP4, GIF, contact sheet, stills in a fresh headless
  Chromium + ffmpeg) from the Go SaaS backend, which calls it as `AWWO_RENDER_URL` (`backend/internal/app/renders.go`).
- Scope: internal authenticated HTTP service, render pipeline, virtual clock, network allowlist, configuration,
  tests and operating documentation. No frontend, Go, deployment or Git work.
