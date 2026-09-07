# AwwO SaaS web

The SaaS entry imports the existing `CanvasSurface`, `AgentWorkspace`, node inspector, session tiles, graph engine and delivery components. It does not import the legacy desktop shell or require `server/ui` dependencies.

```sh
npm ci
npm run dev:saas
npm run typecheck:saas
npm run test:saas
npm run build:saas
```

Development listens on `127.0.0.1:5189`. Set `VITE_AWWO_WEB_HOST`, `VITE_AWWO_WEB_PORT`, and `AWWO_API_TARGET` as needed; the API target defaults to `http://127.0.0.1:8087`. Only `/api/v1` is proxied. The build is `dist-saas/saas.html`; configure the production web server to serve that HTML for `/`, `/admin`, and client navigation, and proxy `/api/v1` without buffering event streams.

## State ownership

Go owns identities, tenant membership, agents, canvases, sessions, messages, runs and audit records. Authentication uses an HttpOnly server session cookie. The web client never persists authentication tokens.

The cloud canvas loads before the editor mounts. Saves carry the server `version`; a conflict stops further writes. Every edit also creates a durable draft containing its document, base version, dirty marker and unique revision. Draft keys include user, tenant, canvas and editor identity so multiple tabs retain separate unsaved copies. Reload checks these drafts before overwriting the canvas cache; offline drafts remain exportable even if the cloud is unreachable. Restoring a draft requires an explicit action and a matching cloud version. Conflicting drafts can be exported or retained while viewing the cloud; discarding requires a separate explicit confirmation. A successful save removes only its acknowledged revision and preserves edits created while the request was in flight. A clean baseline distinguishes previously synced caches from unsaved work. Pre-draft scoped caches are preserved conservatively when their sync status is unknown.

Starting a run waits for pending canvas saves. Browser document, planner, run recovery and lock keys are namespaced by user, tenant and canvas. Tenant/canvas switches use document navigation to clear module-level transcript state and detach old observers. Browser cache is an offline/recovery aid; the cloud record remains authoritative. Legacy unscoped local canvas data is not imported automatically into an authenticated tenant.

`src/saas/canvasBridge.ts` is the explicit protocol adapter for existing canvas clients. It maps Pi agent binding, durable operation IDs, sessions, run recovery, SSE and cancellation to `/api/v1/tenants/:tenantId`. It does not replace global `fetch` or grant tenant access. Server authorization applies to every request, including admin requests.

## Current boundaries

- `/admin` exposes tenant status controls and user/run/audit lists, backed by server admin checks. Bootstrap administrators can open it without tenant membership and can log out from either surface. Suspended workspaces retain tenant switching and logout.
- Owners and tenant administrators can open the members panel, add existing registered users by email, change allowed roles, and remove members. The UI reflects owner/admin protections; the server enforces authorization. No invitation emails are sent. Readers receive a cloud-backed view of nodes, dependencies and session history, with JSON export and no editing or execution controls. Billing is not included.
- The left canvas planning assistant submits an audited Pi planning run with the existing canvas protocol, template catalog and graph context. It applies output only after strict JSON/protocol/graph validation. Missing credentials, interrupted streams, invalid output and stale canvas versions are displayed without changing the graph. Templates and input/output ports also remain manually editable.
- Planner context excludes execution identities, transcripts and generated artifacts, along with duplicated default personas and field help text. Custom personas, actual user inputs and contract identifiers remain included. Large manually authored inputs/history can still exceed the configured Pi context budget; that returns a visible failure and leaves the graph unchanged.
- Graph dependency scheduling currently runs in the existing browser `runGraph`. Each submitted node run continues on the server if its browser disconnects; a refresh recovers submitted run state. Dispatching remaining graph nodes while every browser is closed needs a server graph scheduler.
- The current admin API returns bounded lists. No full-history pagination or audit export is claimed.
- Production verification must use deployed TLS, session configuration, tenant authorization checks and an available Pi model. A successful static build does not establish production readiness.
