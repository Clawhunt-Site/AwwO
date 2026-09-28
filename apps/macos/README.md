# AwwO for Mac

Source version **0.9.0, build 7** is the Apple Silicon desktop client for the hosted
AwwO service. It requires macOS 14 or later and an internet connection. The
Swift/AppKit/WebKit shell uses the hosted account, workspaces and history;
the website and server deploy separately. No local database, Node runtime,
worker, model runtime or provider API key is bundled.

The latest published download remains **0.8.1, build 6** until a separate native
release is built and verified. The 0.9.0 source adds the exact ClawHunt identity
handoff routes; a Git push does not update installed binaries.

The bundle identifier remains `store.clawhunt.awwo.local` and the app remains
`AwwO Local.app` with the display name **AwwO**. Existing WebKit session data
is preserved; server-side session validity still controls whether login is
required. Do not delete the old app's data to update its icon.

## Build

Use Apple Silicon macOS, Xcode Command Line Tools and Node **24.1.0 or later**.
The build uses Node's native TypeScript support. Node 24.1.0 is the verified
minimum; the old `24.21.0` requirement was unnecessarily restrictive. Dependency
versions are unchanged. Run from the repository root:

```sh
npm ci --prefix apps/macos --ignore-scripts
npm run typecheck --prefix apps/macos
npm test --prefix apps/macos
APP_ENV=production VITE_APP_ENV=production \
  AWWO_MAC_CLOUD_URL=https://awwo.clawhunt.store \
  node apps/macos/build.ts
```

The production origin must be explicitly approved and supplied as an HTTPS
origin with no credentials, port, path, query or fragment. The build runs
navigation-policy, WebKit-loading, process-shutdown and window-lifecycle
self-checks before packaging. It creates a new output directory under
`.local/macos-production/` and writes its paths and SHA256 to `latest.json`.
It creates an `.app` and a ZIP; a release DMG is packaged separately from the
verified `.app`. A candidate built before a commit records modified inputs
in `Contents/Resources/metadata.json`; rebuild from the final clean commit
for release so the recorded revision identifies the shipped source.

## Package a release

After committing the release and rebuilding from that clean commit, run on
macOS with the same production configuration:

```sh
APP_ENV=production VITE_APP_ENV=production \
  AWWO_MAC_CLOUD_URL=https://awwo.clawhunt.store \
  node apps/macos/package-release.ts
```

The script reads `latest.json`, requires its revision and app metadata to match
`HEAD`, rejects builds with modified inputs, and runs `verify-bundle.ts`.
It refuses to overwrite `.local/releases/macos-0.9.0-build7-<sha7>/`.
The output contains stable release names for the DMG, ZIP, `INSTALL.txt`,
`SHA256SUMS`, a Fold brand kit ZIP (MIT license, SVG/PNG, vector source and
ICNS), and `release.json` with verification evidence. The DMG includes the app,
an Applications shortcut and installation instructions. Packaging verifies the
disk image, mounts it read-only, checks the mounted bundle and shortcut, then
detaches it; failure paths also attempt to detach. It does not install the app,
upload artifacts or change Git refs. A failed attempt may retain incomplete
artifacts without a completion manifest; inspect that directory before retrying.

## Fold icon

The canonical artwork is `assets/brand/awwo-fold/`. Its exact
`png/mark-blue-1024.png` is copied to the app as `AwwOFoldMark.png`.
`AwwOLocal --write-icon /absolute/output.png` reads this bundled image and
composes a light rounded macOS tile. It does not recreate or reinterpret the
two Fold paths, their transform, or their blue palette. No network or image
generation service is used. Missing or incorrectly sized source artwork
fails the build instead of falling back to the old mark.

The build generates all standard 16–1024px icon representations and packages
them as `AwwOFold.icns`. Metadata records SHA256 values for the canonical raster,
canonical vector source, generated ICNS and Swift source. Inspect the rendered
icon at small sizes and in Finder/Dock before distributing it.

## Verify and install

Use the built app path from `latest.json`, or the installed app path:

```sh
APP_ENV=production VITE_APP_ENV=production \
  AWWO_MAC_CLOUD_URL=https://awwo.clawhunt.store \
  AWWO_MAC_APP="$HOME/Applications/AwwO Local.app" \
  node apps/macos/verify-bundle.ts
```

Verification checks the version/build, bundle identity, configured origin,
source and icon hashes, expected resources, absence of local runtimes and
strict code-signature integrity. Quit the old app and preserve a backup before
replacing `AwwO Local.app` in the existing Applications directory. Confirm the
Fold icon, launch, account/workspace continuity, navigation/refresh and
close/reopen behavior in the installed copy. Do not infer server deployment
or authenticated UI acceptance from successful compilation alone.

## Signing

This build uses **ad-hoc signing**. It is **not signed with Apple Developer ID
and is not notarized**. Signature-integrity verification does not mean Gatekeeper
acceptance; macOS may block its first launch. Follow the device's security
policy. This build and installer do not modify system security settings.
