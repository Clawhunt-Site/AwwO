# ClawHunt unified identity

AwwO can use ClawHunt as its identity issuer. This integration requires a compatible main-site service and explicit configuration on both services. Leaving the three identity settings empty retains standalone AwwO authentication.

## Account flow

An active, approved ClawHunt account returns to AwwO with a short-lived authorization code. A first-time user receives a workspace and the existing onboarding guide. Personal execution credentials remain a separate user configuration step.

Approval itself is invite-code redemption on the issuer. The issuer's authorize endpoint sends every signed-in account it will not sign in to its hosted page (`/awwo?from=signin`). An account without approval enters a valid code there, which grants approval and continues into AwwO through a fresh sign-in. A barred account (the issuer would refuse it, or its access was withdrawn) is told there that it cannot use AwwO. Only while that hosted page is disabled does an account return to AwwO with the `waitlisted` callback error; AwwO's own screen then links to the same page.

A workspace invitation survives that detour. Its `?invite=` token lives in AwwO's `identity_flows` for one sign-in only, and the detour's return is a fresh sign-in. So the web client keeps an invitation opened while signed out in the tab's sessionStorage for 30 minutes (`pendingInvite.ts`). It restores the invitation once, on the first plain `/` landing after a successful sign-in, and the invitation page still requires an explicit acceptance. A sign-out forgets it.

If the main-site email matches an existing AwwO account, the user must prove ownership with the original AwwO password once. The stable issuer/subject then maps to the original user ID, retaining workspaces, canvas history and encrypted connections. Matching contact information alone never merges accounts or grants access. A failed password proof consumes the attempt; the user starts a new sign-in flow.

Unified mode directs profile/password management to ClawHunt and uses invitation links for new workspace members. Direct membership grants by contact email are disabled. The issuer must explicitly approve access; registration or waitlist enrollment alone is insufficient. Existing memberships and workspace roles remain unchanged.

## New workspaces

Three optional API settings shape the workspace a first-time user receives and limit extra ones. They apply only to workspaces created after the API starts with them; existing workspaces keep their models and quotas, and `PATCH /api/v1/admin/tenants/{id}` still changes any single workspace. An invalid value stops API startup.

| Setting | When set | Unset |
| --- | --- | --- |
| `AWWO_NEW_WORKSPACE_ALLOWED_MODELS` | Comma-separated model IDs stored as the new workspace's `allowedModels`, under the admin field's rules: at most 64 IDs of up to 200 bytes, none empty or containing whitespace or control characters. Operator credential mode only: personal catalogues name models per connection, so the API refuses this setting with `AWWO_CREDENTIAL_MODE=user` | Unrestricted (NULL) |
| `AWWO_NEW_WORKSPACE_MAX_RUNS_PER_DAY` | Integer 1–100000 stored as `maxRunsPerDay` | Column default, 100 |
| `AWWO_MAX_OWNED_WORKSPACES` | `POST /api/v1/tenants` returns `403 workspace_limit` to an account that is not a platform admin and already owns at least this many workspaces | `0`, unlimited |

The defaults reach every creation path: standalone registration, a first ClawHunt sign-in and `POST /tenants`. The workspace created at registration or first sign-in is never refused by the cap. Intended production values, with operator credentials: `AWWO_NEW_WORKSPACE_ALLOWED_MODELS=qwen3.8-27b-p6`, `AWWO_NEW_WORKSPACE_MAX_RUNS_PER_DAY=50`, `AWWO_MAX_OWNED_WORKSPACES=1`.

## Configuration and protocol

The issuer must implement `/api/awwo/sso/{authorize,token,introspect,revoke,logout}`. AwwO exposes `/api/v1/auth/clawhunt/{start,callback,pending,link}`.

| AwwO setting | Issuer counterpart or requirement |
| --- | --- |
| `AWWO_CLAWHUNT_URL` | Exact `AWWO_SSO_ISSUER` origin, without a trailing slash |
| `AWWO_CLAWHUNT_CLIENT_ID` | Matching `AWWO_SSO_CLIENT_ID` |
| `AWWO_CLAWHUNT_CLIENT_SECRET` | Matching confidential `AWWO_SSO_CLIENT_SECRET`, at least 32 characters |
| `AWWO_PUBLIC_ORIGIN` | Exact callback origin: append `/api/v1/auth/clawhunt/callback`; post-logout return appends `/` |
| `AWWO_CREDENTIAL_ENCRYPTION_KEY` | Existing stable 32-byte key, encoded as base64; retain it to preserve encrypted connections |

Supply all three `AWWO_CLAWHUNT_*` values together. HTTPS is required outside explicit loopback development. The issuer also requires `AWWO_SSO_ENABLED=true`, durable private token storage and its own approved user list. Secrets belong in deployment secret storage, never in a browser build or repository.

State, a separate browser binding and S256 PKCE protect the callback. Codes and linking attempts are single-use. Backend requests use the configured origin and do not follow redirects with client credentials. Provider grants are encrypted and bound to the AwwO user and session digest. A grant may last at most 12 hours (`expires_in` up to 43200; a longer one is refused at sign-in), and the AwwO session ends with it. AwwO revalidates a session's grant with the issuer at most once a minute, on requests and on active event streams alike; an inactive answer ends the session at once. When the issuer does not answer (no connection, a timeout, a 5xx, 408 or 429), a session verified within the last five minutes keeps working and the issuer is retried at most every 15 seconds; past that window, without an earlier verification, or on any other refusal or malformed answer, requests fail closed with `503 sso_unavailable`. Concurrent requests of one session share a single check. Sponsored TypeSafe evaluations always ask the issuer and fail closed.

Main-site sign-out invalidates the AwwO session within a minute. AwwO sign-out revokes the corresponding issuer session and accepts only the configured main-site logout route or the exact AwwO root fallback. `401 unauthorized` always means the AwwO session has ended; lost workspace access answers like any other non-member. When a signed-in page receives it, the page stops sending requests other than sign-in routes and offers a new sign-in in place, keeping the page and its local drafts.

## Migration and rollback

Startup applies `018_clawhunt_identity.sql` transactionally through the migration identity/checksum mechanism. It adds identity mappings, expiring login flows and encrypted provider grant metadata on sessions. Existing user IDs, password hashes, memberships, canvas data and encrypted model connections are retained.

Enable both services as a coordinated release after testing account linking, invitation handling, revocation and navigation in the target environment. Source inclusion alone does not enable or verify a deployed issuer.

To roll back enablement, stop both sides from issuing new SSO sessions and restore the previous application/configuration together. Retain the additive identity tables and rows, encryption key and database backup. Disabling SSO does not give an SSO-only user a local password. Do not drop identity data or rotate the encryption key as a routine rollback.
