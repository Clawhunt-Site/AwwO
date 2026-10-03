# First-run guide

On the first visit to the workspace, canvas or engine-settings page, the hosted SaaS UI opens the **work-mode tutorial** (`WorkModeTutorial.tsx`). It is a seven-step explainer of how AwwO works, described in [production cases and the work-mode tutorial](../../../docs/production-cases.md). Accounts registered from 2026-10-03 must finish it during their first 14 days: it has no close or skip control, Escape does nothing, and it returns until finished. Every other account sees it once and can skip it. Replay it from **More options → How AwwO works / AwwO 工作模式**.

The step-by-step page tour below opens only on request, from **Getting started / 使用引导**. The native macOS hosted client uses the same UI. Native dialog behavior keeps the background inert, traps keyboard focus, supports Escape, and restores focus after closing.

The guide explains personal provider credentials, a first canvas, models on the left, Bots on the right, task input, and explicit execution. Reader instructions match the read-only layout and never suggest editing or running. Workspace-managed model deployments do not tell users to add personal keys. No step creates a canvas, saves a key, purchases credits, or runs inference automatically.

Tutorial progress is saved per account on the current browser/device in `awwo.workmode.v1:<encoded-user-id>`. Only `dismissed` or `completed` is stored, and `completed` written by any tab wins. Progress does not sync across devices. Where browser storage is unavailable, nothing can be remembered: a new account is still made to finish the tutorial, which then returns on every page load, while anyone else is not shown it by itself; the menu still opens it. If the tutorial's chunk cannot load, a new account sees a notice that reloads the page instead of the workspace, and anyone else carries on without it. Pages with an invitation, account security, suspended/inaccessible workspaces, or administration do not auto-open it. It waits for the page's actual content and for an existing modal or draft-recovery prompt to close. The page tour stores nothing.

## Main-site navigation

Set `VITE_CLAWHUNT_SITE_URL` at **build time** to enable the main-site header link and final workspace guide step. Empty or invalid configuration hides both. Deployed builds accept only HTTPS. An explicit Vite development run also accepts HTTP on the literal loopback hosts `127.0.0.1`, `localhost`, and `[::1]`; other HTTP hosts are rejected. Credentials, query parameters, and fragments are always rejected. Links carry no account information and use `noopener noreferrer`.

| Environment | Configuration |
| --- | --- |
| Development | Empty, a development HTTPS site, or `http://127.0.0.1:8795` when the isolated ClawHunt main site is running locally |
| Staging | Empty until a separate staging main-site URL is provisioned |
| Production | Verified main-site URL: `https://clawhunt.store` |

For Docker Compose, set this name in the deployment environment; `web.build.args` passes it to Vite. For a direct web-only release build, export the same value to the build command and record it in the release manifest. Changing the API's environment without rebuilding the web assets does not change the link.

For a fully local navigation check, run the isolated main site at `http://127.0.0.1:8795` and start AwwO's Vite development server at `http://127.0.0.1:5193` with `VITE_CLAWHUNT_SITE_URL=http://127.0.0.1:8795`. The main-site header link and final guide step should both open that local origin. A production-mode build still rejects this HTTP setting, even if a development mode name is supplied.

The matching ClawHunt `/awwo` entry is configured by that project's `AWWO_WORKSPACE_URL`. These links provide navigation without forwarding tokens or merging same-email accounts. Unified authentication is configured separately using the [ClawHunt identity protocol](../../../docs/clawhunt-identity.md). Without that configuration, account sessions remain separate. The Mac app opens ordinary main-site destinations in the system browser; the exact authentication/account routes used for unified login remain inside its WebKit window.

## Acceptance

Verify desktop and 320/390px layouts, light/dark themes, Tab/Shift+Tab/Escape, explicit action focus, delayed content, skip/replay, separate accounts/scenes, reader mode and workspace-managed providers. Confirm a completed guide stays dismissed after returning from engine settings. Run the SaaS test suite, typecheck and production build.

Local browser acceptance uses isolated API fixtures and does not prove a paid model call or production account provisioning. Production readback should open the actual hosted app and inspect the guide and links without changing account credentials or triggering inference.
