# Web lockfile repair for clean server installation

## Failure and cause

The first clean Ubuntu 24 installation of the published `v0.3.0` source failed
at `npm ci --prefix apps/web` with Node 24.20.0 / npm 11.19.0:

```text
npm error code EUSAGE
npm error Missing: @emnapi/core@1.11.3 from lock file
npm error Missing: @emnapi/runtime@1.11.3 from lock file
```

The same failure reproduces on Windows with Node 22.16.0 / npm 11.19.0 using
only copies of the tracked `package.json` and `package-lock.json` and
`npm ci --dry-run --ignore-scripts`. It is therefore not evidence of a Linux
native binary failure. npm 11.6.2 accepts the incomplete lockfile; npm 11.19.0
detects missing entries in the optional WASM dependency graph before installation.

The lock already contains `@napi-rs/wasm-runtime@1.1.5`, whose required peer
ranges include `@emnapi/core` and `@emnapi/runtime` at `^1.7.1`. Its root-level
peer resolutions were missing. The existing `1.10.0` entries nested below the
Rolldown WASM package do not provide those root peers. The Tailwind WASM package
also declares bundled copies of both packages that were absent from the lock.

## Bounded repair

Run npm 11.19.0 `install --package-lock-only --ignore-scripts --no-audit --no-fund`
against an isolated copy of the two manifests. Extract only the four missing
package entries from that reconstruction:

| Lock location | Version | Metadata |
| --- | --- | --- |
| `node_modules/@emnapi/core` | 1.11.3 | Optional peer, registry integrity recorded |
| `node_modules/@emnapi/runtime` | 1.11.3 | Optional peer, registry integrity recorded |
| `node_modules/@tailwindcss/oxide-wasm32-wasi/node_modules/@emnapi/core` | 1.10.0 | Existing upstream bundle content |
| `node_modules/@tailwindcss/oxide-wasm32-wasi/node_modules/@emnapi/runtime` | 1.10.0 | Existing upstream bundle content |

The resulting lock change is 44 added lines. No prior package entry, direct
dependency, version, URL, integrity hash, or dependency range changes. Existing
Vite, Rolldown, OXC, Tailwind, and React resolutions remain pinned. The generator's
unrelated `peer` metadata changes are excluded. No application code or vendored
server file is changed, and the published `v0.3.0` tag remains immutable.

## Verification on 2026-09-06

All checks below use the isolated manifest copy, with no existing `node_modules`:

- Original lock: npm 11.19.0 `ci --dry-run --ignore-scripts` fails with the exact
  two missing-package errors above.
- Repaired lock: npm 11.19.0 `ci --dry-run --ignore-scripts --no-audit --no-fund`
  passes on the Windows host.
- Repaired lock: the same command with `--os=linux --cpu=x64 --libc=glibc` passes.
- Repaired lock: npm 11.6.2 accepts the same lock with those dry-run settings.
- Parsed comparison confirms every pre-existing package entry is unchanged.
- `git diff --check -- apps/web/package-lock.json` passes.

These dry runs prove dependency-graph consistency, not installed native binary
execution. The server acceptance report records the subsequent real Linux
installation and build results separately.
