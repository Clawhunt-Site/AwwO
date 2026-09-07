# Third Party Notices

SuperClaw fusion imports upstream source trees as isolated product surfaces. The
imports keep their original README, lockfiles, and license files under
`third_party/`; this repository does not relicense them.

## Imported Sources

| Component | Repository | Commit | License | Local path |
| --- | --- | --- | --- | --- |
| OSIRIS | simplifaisoul/osiris | 21c3dde7d4e48154aa3918829f86965f4e646e67 | MIT | third_party/osiris |
| Open Design | nexu-io/open-design | 324e9fd909d005f5d1d86982d3f15d39d747bc34 | Apache-2.0 | third_party/open-design |
| OpenPencil | ZSeven-W/openpencil | e8ed1985b94ba954c22441a68539ef3cd3be8e6f | MIT | third_party/openpencil |
| OpenPencil agent-native submodule | ZSeven-W/agent | e1f90cab9658e6c215b48bccfc3489412c8788a5 | MIT | third_party/openpencil/packages/agent-native |

## AwwO migration additions

- `server/` derives from `paperclipai/paperclip` and includes pre-existing host-specific modifications. Its imported Git tree is `729b741740efba9dae8807db58db7b730a8a0b93`, from SuperClaw source commit `c8db2818be40511bbb42ad5435028105a738e61c`. This records the actual source snapshot, not a claim of equality to an unmodified upstream release. Preserve `server/LICENSE` and component-specific licenses, including `server/packages/adapters/hermes/LICENSE`.
- `third_party/clawwork/` includes the vendored source and its existing attribution. Preserve its `NOTICE` and license files, including its attribution to Pi v0.79.10.
- `examples/knowledge-workbench/data/unicode/` contains Unicode data used by the generated example; preserve the accompanying Unicode licenses and source hashes.
- AwwO's own code has not been assigned a new open-source license by this migration. Third-party licenses apply to their respective components only.

## AwwO SaaS runtime dependencies

The independent `apps/pi-worker` service uses `@earendil-works/pi-coding-agent`
and `@earendil-works/pi-ai`, both pinned to `0.85.1` in its manifest and lockfile.
Their package metadata declares MIT; preserve the installed packages' license
files when distributing a runtime image. Source reference:
`earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`.
This runtime dependency is distinct from the older Pi code attributed under
`third_party/clawwork/`; it does not change that attribution or AwwO's own license.

## Existing fusion boundary

The first fusion release keeps each upstream runtime isolated. SuperClaw exposes
their capabilities through local fusion orchestration, plugin manifests, MCP
projection, permission policy, human-gate checks, and evidence artifacts.

Active OSIRIS RECON capabilities such as port scanning, vulnerability scanning,
and sweep-style probes are human-gate protected by default. Passive public-data
lookups and design/canvas export actions can be recorded as normal fusion
artifacts.
