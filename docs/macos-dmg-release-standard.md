# macOS DMG Release Standard

This is the required release standard for SuperClaw macOS DMG distribution outside the Mac App Store.

The goal is not only to produce a signed file. A releasable DMG must open as a clear drag-to-install installer, pass Gatekeeper as a notarized Developer ID artifact, and preserve a reproducible release evidence trail.

## Scope

This standard applies to every public or semi-public macOS desktop release of SuperClaw distributed as a `.dmg`.

It covers:

- DMG visual layout
- app bundle and DMG signing
- Apple notarization
- staple validation
- Gatekeeper verification
- release evidence capture

It does not cover App Store distribution. App Store builds require a separate App Store Connect workflow.

## Release Gate

Do not publish a macOS DMG unless all of these are true:

- The DMG contains `SuperClaw.app`.
- The DMG contains an `Applications` symlink pointing to `/Applications`.
- Opening the DMG shows an explicit drag-to-install visual.
- The visual uses the approved curved dashed upward drag path from `SuperClaw` to `Applications`.
- The visual does not expose a white background when the Finder window is enlarged.
- The main installer viewport does not expose implementation artifacts such as `.background`.
- The DMG is signed with `Developer ID Application`, not ad-hoc signing.
- The mounted `SuperClaw.app` is signed with `Developer ID Application`, not ad-hoc signing.
- Apple notarization returns `Accepted` for the app bundle.
- The notarization ticket is stapled into the app bundle before DMG creation.
- Apple notarization returns `Accepted` for the final signed DMG.
- The notarization ticket is stapled into the final DMG.
- Gatekeeper accepts both the DMG and the mounted `SuperClaw.app`.
- The final SHA256 checksum and notarization id are recorded.

Any failure above blocks release.

## Required Installer Visual

The DMG must be a Finder drag installer, not a plain file container.

Required layout:

- Volume name: `SuperClaw`
- File name: `SuperClaw_<version>_aarch64.dmg` for Apple Silicon builds
- Primary app icon label: `SuperClaw`
- Destination icon label: `Applications`
- Header text: `Drag SuperClaw to Applications`
- Supporting text: `Install once, then launch SuperClaw from your Applications folder.`
- Drag path: curved dashed blue line arcing upward from `SuperClaw` to `Applications`
- Arrow head: follows the curve direction into `Applications`
- Footer text: `SuperClaw <version> for macOS`
- Background: dark canvas large enough that enlarged Finder windows do not reveal white space

Rejected visual patterns:

- Plain DMG with only two icons and no instruction
- Straight solid arrow
- Tiny or ambiguous drag hint
- White area revealed on window resize
- Hidden implementation folders visible in the primary viewport
- Nested cards or decorative visual clutter

## Required Local Prerequisites

The release machine must have:

- A valid Apple Developer Program membership for the release team.
- A `Developer ID Application` certificate installed in the local keychain.
- A notarization credential stored in a keychain profile.
- Tauri, Rust, Node.js, and npm available for desktop builds.
- Xcode command line tools with `codesign`, `xcrun`, `stapler`, `spctl`, and `hdiutil`.

When duplicate Developer ID certificates exist, sign with the certificate hash instead of the display name.

Example verified identity from the first 0.1.0 release pass:

```bash
2E5BAE179F46E127DE342CE8047CED2554D6FFA5
```

Do not commit Apple ID passwords, app-specific passwords, private keys, or notarization secrets.

## Build And Package Flow

Run the normal desktop build first:

```bash
npm install --prefix apps/web
npm install --prefix apps/desktop
npm run build --prefix apps/web
npm run tauri:build --prefix apps/desktop
```

Then create the release DMG using the approved layout generator. The generated DMG must land at:

```bash
apps/desktop/src-tauri/target/release/bundle/dmg/SuperClaw_<version>_aarch64.dmg
```

The layout generator must:

- Stage the signed `SuperClaw.app`.
- Add the `/Applications` symlink.
- Generate the large dark background canvas.
- Draw the curved dashed upward drag path.
- Keep the primary composition inside the default Finder viewport.
- Place hidden background resources outside the primary viewport.
- Remove failed intermediate `rw.*.dmg` files before release.

## Signing

The final app bundle and DMG must be signed with Developer ID. Ad-hoc signatures are not release signatures.

Verify the DMG signature:

```bash
codesign -dv --verbose=4 apps/desktop/src-tauri/target/release/bundle/dmg/SuperClaw_<version>_aarch64.dmg
```

The output must include:

```text
Authority=Developer ID Application: ...
TeamIdentifier=...
```

It must not be an ad-hoc signature.

## App Notarization

Notarize the signed app bundle before creating the final DMG:

```bash
ditto -c -k --keepParent \
  apps/desktop/src-tauri/target/release/bundle/macos/SuperClaw.app \
  /tmp/SuperClaw-app-notary-<version>.zip

xcrun notarytool submit \
  /tmp/SuperClaw-app-notary-<version>.zip \
  --keychain-profile superclaw-notary \
  --team-id <TEAM_ID> \
  --wait \
  --timeout 30m \
  --no-s3-acceleration \
  --output-format json
```

Staple and validate the app ticket:

```bash
xcrun stapler staple -v apps/desktop/src-tauri/target/release/bundle/macos/SuperClaw.app
xcrun stapler validate -v apps/desktop/src-tauri/target/release/bundle/macos/SuperClaw.app
syspolicy_check distribution apps/desktop/src-tauri/target/release/bundle/macos/SuperClaw.app
```

Required output:

```text
The staple and validate action worked!
The validate action worked!
App passed all pre-distribution checks and is ready for distribution.
```

Only after this gate passes may the app be staged into the DMG.

## DMG Notarization

Submit the final signed DMG to Apple notarization:

```bash
xcrun notarytool submit \
  apps/desktop/src-tauri/target/release/bundle/dmg/SuperClaw_<version>_aarch64.dmg \
  --keychain-profile superclaw-notary \
  --team-id <TEAM_ID> \
  --wait \
  --timeout 30m \
  --no-s3-acceleration \
  --output-format json
```

The only acceptable status is:

```json
{"status":"Accepted"}
```

If notarization is `Invalid`, fetch and inspect the notarization log. Do not staple or publish a rejected artifact.

## Staple

Staple the notarization ticket into the DMG:

```bash
xcrun stapler staple -v apps/desktop/src-tauri/target/release/bundle/dmg/SuperClaw_<version>_aarch64.dmg
xcrun stapler validate -v apps/desktop/src-tauri/target/release/bundle/dmg/SuperClaw_<version>_aarch64.dmg
```

The output must include:

```text
The staple and validate action worked!
The validate action worked!
```

## Gatekeeper Verification

Verify the DMG:

```bash
spctl -a -t open --context context:primary-signature -v \
  apps/desktop/src-tauri/target/release/bundle/dmg/SuperClaw_<version>_aarch64.dmg
```

Required output:

```text
accepted
source=Notarized Developer ID
```

Mount the DMG and verify the app:

```bash
hdiutil attach apps/desktop/src-tauri/target/release/bundle/dmg/SuperClaw_<version>_aarch64.dmg -readonly -noverify -noautoopen
spctl -a -vvv -t exec /Volumes/SuperClaw/SuperClaw.app
```

Required output:

```text
accepted
source=Notarized Developer ID
origin=Developer ID Application: ...
```

## Visual Verification

Open the mounted volume in Finder:

```bash
open /Volumes/SuperClaw
```

Verify both sizes:

- Default Finder window: installer looks focused and clear.
- Enlarged Finder window: no white background is exposed.

The enlarged-window check should use a size close to:

```text
1725 x 980
```

The accepted visual must show the curved dashed upward path and readable install instruction. A plain icon-only DMG is not acceptable.

## Release Evidence

Every shipped DMG must record:

- Release version
- DMG path
- Signing identity
- Team ID
- App notarization id
- DMG notarization id
- App staple validation result
- DMG staple validation result
- DMG Gatekeeper result
- Mounted app Gatekeeper result
- SHA256 checksum
- Visual verification result

Example evidence from the verified `0.1.0` release package:

```text
Version: 0.1.0
Path: apps/desktop/src-tauri/target/release/bundle/dmg/SuperClaw_0.1.0_aarch64.dmg
Signing identity: Developer ID Application: gong liang (865A37WV28)
Team ID: 865A37WV28
App notarization id: 6b8e2fc7-56ce-4799-b846-f9e468078e36
DMG notarization id: b46bb627-d9c3-419c-bb26-f2ee58fd088d
App staple validation: The validate action worked!
DMG staple validation: The validate action worked!
DMG signature: Developer ID Application, Notarization Ticket=stapled
Mounted app distribution check: App passed all pre-distribution checks and is ready for distribution.
Mounted app signature: Developer ID Application, Notarization Ticket=stapled
SHA256: a970a7e432c6f8f1199345d7ceb0fcf89a3e96757e8d098ff5d8d5fb456b90c4
Visual: curved dashed upward drag path, no white exposed background on enlarged Finder window
Local note: spctl returned `Too many open files` on this release machine, so syspolicy_check was used for the app distribution gate.
```

## Non-Negotiable Failure Cases

Stop the release if any of these occur:

- Finder opens to a plain two-icon window with no drag instruction.
- The arrow is straight and solid instead of curved dashed upward.
- Finder resize exposes white canvas.
- `.background` or other implementation files are visible in the primary installer viewport.
- `codesign` reports ad-hoc signing.
- `notarytool` does not return `Accepted`.
- `stapler validate` fails.
- `syspolicy_check distribution` fails for the app bundle.
- `spctl` does not report `source=Notarized Developer ID`.
- The SHA256 checksum is not captured after the final staple.

## Future Automation Requirement

Any future packaging script or CI job for macOS DMG release must implement this document as its acceptance contract.

Automation must fail the release when:

- the DMG lacks the approved installer layout,
- the visual background is not large enough for the enlarged-window check,
- signing uses an ambiguous or ad-hoc identity,
- app or DMG notarization is missing or not accepted,
- app or DMG staple validation is missing,
- Gatekeeper checks are missing,
- release evidence is not emitted.

Until the release generator is fully automated, the manual process must still follow this document exactly.
