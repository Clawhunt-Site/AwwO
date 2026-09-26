# First-run guide

The hosted SaaS UI presents a visual guide on the first visit to each of three scenes: workspace, personal engine settings, and canvas. The native macOS hosted client uses this same UI. Native dialog behavior keeps the background inert, traps keyboard focus, supports Escape, and restores focus after closing. The user can skip and replay using **Getting started / 使用引导**.

The guide explains personal provider credentials, a first canvas, models on the left, Bots on the right, task input, and explicit execution. Reader instructions match the read-only layout and never suggest editing or running. Workspace-managed model deployments do not tell users to add personal keys. No step creates a canvas, saves a key, purchases credits, or runs inference automatically.

Presentation progress is saved per account and scene on the current browser/device in `awwo.onboarding.v1:<encoded-user-id>:<scene>`. Only `dismissed` or `completed` is stored. It does not sync across devices. Pages with an invitation, account security, suspended/inaccessible workspaces, or administration do not auto-open the guide. A scene waits for its actual content and for an existing modal or draft-recovery prompt to close.

## Main-site navigation

Set `VITE_CLAWHUNT_SITE_URL` at **build time** to enable the main-site header link and final workspace guide step. Empty or invalid configuration hides both. Only HTTPS URLs without credentials, query parameters, or fragments are accepted. Links carry no account information and use `noopener noreferrer`.

| Environment | Configuration |
| --- | --- |
| Development | Empty, or an explicit development HTTPS site |
| Staging | Empty until a separate staging main-site URL is provisioned |
| Production | Verified main-site URL: `https://clawhunt.store` |

For Docker Compose, set this name in the deployment environment; `web.build.args` passes it to Vite. For a direct web-only release build, export the same value to the build command and record it in the release manifest. Changing the API's environment without rebuilding the web assets does not change the link.

The matching ClawHunt `/awwo` entry is configured by that project's `AWWO_WORKSPACE_URL`. These are ordinary navigation links, not SSO. Existing ClawHunt login, Cloudflare Access, and AwwO account sessions remain separate. No token is forwarded and no same-email accounts are merged. The Mac app opens main-site destinations in the system browser.

## Acceptance

Verify desktop and 320/390px layouts, light/dark themes, Tab/Shift+Tab/Escape, explicit action focus, delayed content, skip/replay, separate accounts/scenes, reader mode and workspace-managed providers. Confirm a completed guide stays dismissed after returning from engine settings. Run the SaaS test suite, typecheck and production build.

Local browser acceptance uses isolated API fixtures and does not prove a paid model call or production account provisioning. Production readback should open the actual hosted app and inspect the guide and links without changing account credentials or triggering inference.
