# AwwO accounts and languages

This document records the identity, authorization, and language boundaries of the first AwwO account workspace slice. The slice uses the existing Node workspace APIs. It does not create a second user database and it does not treat a ClawHunt login as workspace authorization.

Some API paths and environment variables below retain upstream compatibility names, such as `/paperclip-api` and `PAPERCLIP_*`. They are implementation identifiers rather than AwwO product names.

## Identity boundaries

| Identity | Source | What it proves | What it does not prove |
| --- | --- | --- | --- |
| ClawHunt account | Gateway verification of the ClawHunt session | The user has a valid external ClawHunt identity | Membership, role, or permission in an AwwO workspace |
| AwwO workspace session | The Node service's Better Auth cookie session | The user is signed in to the workspace service | Access to every company; membership and role checks still apply |
| `local_trusted` operator | The Node service's local implicit board identity | A single operator on the same trusted machine can administer the local workspace | Secure multi-user identity or a remotely authenticated user |
| Agent runtime identity | A server-issued agent key or short-lived run JWT | The agent may call the scoped runtime APIs allowed for that agent/run | Human board-operator access |

The account panel shows the ClawHunt account and the AwwO workspace session separately. A verified ClawHunt token is never forwarded to the Node service as an authorization token. If the Node service requires authentication and has no cookie session, the panel opens the existing workspace sign-in or join surface.

Selecting a workspace in the account panel only changes which company's members are being viewed and managed in that panel. It does not rewrite the canvas, change a node's `companyId`, or switch the authorization context of existing agent sessions.

## Real account API surface

The browser calls the Node service through the same-origin `/paperclip-api` proxy and always uses `credentials: "include"`. Read-only session probes turn `401` into a signed-out state; other errors remain visible to the user.

| Method and path | Use in the account panel |
| --- | --- |
| `GET /health` | Read deployment mode, exposure, and auth readiness |
| `GET /auth/get-session` | Read the Better Auth workspace session; `401` means signed out |
| `GET /cli-auth/me` | Read current instance/company access and membership roles; `401` means no workspace identity |
| `GET /companies` | List companies visible to the current workspace identity |
| `GET /auth/profile` | Read the current workspace profile |
| `PATCH /auth/profile` | Update the current user's name and optional image |
| `GET /companies/:companyId/members` | Read members and server-calculated management capabilities |
| `GET /companies/:companyId/user-directory` | Read the permitted directory fallback when full member management is unavailable |
| `GET /companies/:companyId/invites?state=active&limit=1` | Check invite access and current active invite state |
| `POST /companies/:companyId/invites` | Create a human invite for an owner, admin, operator, or viewer and return a server-issued link |
| `PATCH /companies/:companyId/members/:memberId` | Change a member's role or active/suspended status |

The current invite flow displays or copies the returned link. It does not send email, and it does not require an SMTP provider.

## Authorization rules

The UI uses `canManageMembers`, `canInviteUsers`, and related server responses to decide which controls to show or enable. These values improve the interface; they are not the security boundary. Every mutation is authorized again by the Node service.

- Company membership is scoped by company ID. Cross-company access is rejected by the service.
- Roles are `owner`, `admin`, `operator`, and `viewer`.
- Operators and viewers can see only the directory or member data their server permissions allow. They cannot create invites or change roles merely by enabling a browser control.
- The service protects the active owner. The authenticated route rejects an owner changing their own protected membership, and the service layer retains its last-active-owner invariant.
- Browser storage is never used as a source of membership, role, or instance-admin authority.
- In `local_trusted`, the panel says that the user is a single-device administrator. This mode is appropriate for loopback, single-operator use and must not be presented as multi-user authentication.

## Language behavior

AwwO currently supports English and Simplified Chinese UI copy. The preference is stored locally under the compatibility key `superclaw_locale` with a value of `en` or `zh`.

1. A valid saved preference wins.
2. With no saved preference, a browser language beginning with `zh` selects Chinese; all other values select English.
3. If browser storage is unavailable, the current visit can still switch languages and safely falls back to the browser language on reload.
4. The document language is updated to `en` or `zh-CN` for assistive technology.

Language switching applies to AwwO interface labels, descriptions, validation messages, and system guidance. It must not translate, rewrite, or mutate user-authored titles, prompts, messages, form values, agent output, deliverables, filenames, logs, or persisted business data.

## Validation evidence

The account component test and type check passed in the development environment:

```powershell
Push-Location apps/web
$env:NODE_ENV = 'development'
npx vitest run tests/account-workspace.test.tsx
npx tsc -p tsconfig.json --noEmit
Pop-Location
```

The component suite passed 8 of 8 tests. It covers cookie credentials, profile writes, `local_trusted` labeling, separation of ClawHunt and workspace identity, unauthorized directory fallback, invite-link creation, server-backed member updates, and both supported languages.

On 2026-09-05, an independent authenticated/private Node instance and fresh embedded PostgreSQL database were exercised through real HTTP requests. The local evidence record reported `status: passed`, `checkCount: 14`, and `externalEmailTriggered: false`. The 14 checks were:

1. Authenticated/private health and first-admin-pending state.
2. Anonymous session rejection with `401`.
3. Owner signup, logout, session invalidation, and login with a real cookie session.
4. First signed-in owner claiming instance-administrator status.
5. Profile update and authenticated readback.
6. Company creation with owner membership.
7. Rejection of the sole owner's attempt to change their own protected membership, with unchanged readback.
8. Creation of a real human operator invite.
9. Second-user signup, explicit login, and invite acceptance.
10. Active operator membership after acceptance.
11. Operator directory access with member-management and invite mutations rejected by `403`.
12. Owner-authorized role change from operator to viewer, followed by viewer permission enforcement.
13. Final owner/viewer role readback.
14. Logout invalidating both authenticated sessions, followed by `401` session probes.

The run used synthetic `.invalid` email addresses, generated process-only test secrets, a loopback-only API, a dedicated database, disabled heartbeat, and no external email integration. Its raw local result is stored under `.local/release/account-authenticated-3102-20260905T0905/result.json`; its SHA-256 is `8e47189020dc7ebc67b1ea6e87ec22faa3352fd6342250c23033d1f05bac3d38`. `.local` is intentionally ignored and is not a deployment input. The API and database listeners were stopped after the run.

To repeat the authenticated acceptance without touching an existing installation:

1. Allocate unused loopback ports and a new temporary AwwO data directory.
2. Configure `authenticated` plus `private`, disable UI serving and heartbeat, and use a new embedded database directory.
3. Generate fresh auth, agent-JWT, and local secret-store keys in the test process. Do not print or persist their values in logs.
4. Start the Node service and wait for `GET /api/health` to report healthy.
5. Run the 14 API steps above with two independent cookie jars and synthetic `.invalid` users. Assert the response status and a readback after every mutation.
6. Stop the process and verify that both the API and database ports are released.

Do not run this acceptance against staging or production because it creates users, a company, memberships, and an invite.

## Deployment configuration

The tracked root `.env.example` now contains commented Node account profiles for development, staging, and production. They are reference blocks: deployment tooling must copy exactly one profile into the target environment and replace every reserved host and secret placeholder. Root `.env.*.example` variants do not currently exist and are ignored by the repository's existing `.env.*` rule, so the three profiles remain together in the tracked root example.

| Environment | Node mode | URL and bind | Account policy | Entry point |
| --- | --- | --- | --- | --- |
| Development | `local_trusted` / `private` by default | Loopback only | No Better Auth login; the launcher generates the local Agent JWT secret | `npm run dev` |
| Authenticated development | `authenticated` / `private` | Loopback, automatic auth base URL | Signup enabled for local two-user testing; unique local session and Agent JWT secrets | Existing Node deployment entry |
| Staging | `authenticated` / `public` | Explicit protected staging origin, loopback behind the staging edge | Signup enabled so the full new-user invite flow can be tested; unique staging secrets | Existing Node or container deployment entry |
| Production | `authenticated` / `public` | Explicit production origin, loopback behind the production edge | Signup remains enabled while a brand-new invitee must create an account; it may be disabled only after a trusted provisioning path exists | Existing Node or container deployment entry |

`npm run dev` is deliberately development-only. Its launcher reads `.local/awwo/.env`, then forces `APP_ENV=development`, `VITE_APP_ENV=development`, `local_trusted`, private exposure, and loopback binding. It cannot be turned into a staging or production launcher through environment overrides. Staging and production use `pnpm -C server paperclipai run` or the existing container deployment described in `server/doc/DOCKER.md`.

The environment variables map to the service's validated JSON configuration as follows:

| Environment variable | JSON configuration or runtime use |
| --- | --- |
| `PAPERCLIP_DEPLOYMENT_MODE` | `server.deploymentMode`: `local_trusted` or `authenticated` |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `server.exposure`: `private` or `public` |
| `PAPERCLIP_BIND` | `server.bind`: `loopback`, `lan`, `tailnet`, or `custom` |
| `PAPERCLIP_BIND_HOST` | `server.customBindHost`, required when bind is `custom` |
| `PAPERCLIP_ALLOWED_HOSTNAMES` | Comma-separated form of `server.allowedHostnames` |
| `PAPERCLIP_AUTH_BASE_URL_MODE` | `auth.baseUrlMode`: `auto` or `explicit` |
| `PAPERCLIP_PUBLIC_URL` | Primary public URL; supplies `auth.publicBaseUrl` and derives the canonical hostname |
| `PAPERCLIP_AUTH_PUBLIC_BASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_BASE_URL` | Supported compatibility fallbacks for `auth.publicBaseUrl` |
| `PAPERCLIP_AUTH_DISABLE_SIGN_UP` | `auth.disableSignUp`; only the exact string `true` disables signup |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Additional comma-separated browser origins used by the Better Auth runtime |
| `BETTER_AUTH_SECRET` | Better Auth session secret; process environment only |
| `PAPERCLIP_AGENT_JWT_SECRET` | Agent-token signing secret and an existing fallback when the session secret is absent; process environment only |

Authenticated public mode is rejected unless the auth base URL mode is explicit and a public URL is present. The root examples therefore use `PAPERCLIP_AUTH_BASE_URL_MODE=explicit` for staging and production. They also keep `PAPERCLIP_BIND=loopback`, assuming TLS termination and proxying occur at the environment's existing edge.

Each authenticated environment must use a unique high-entropy `BETTER_AUTH_SECRET`. The examples also require a different `PAPERCLIP_AGENT_JWT_SECRET` so human sessions and agent tokens do not share signing material. Development, staging, and production values must never be reused across environments or committed to Git.

Only approved browser origins belong in `BETTER_AUTH_TRUSTED_ORIGINS`, and only expected proxy/private hostnames belong in `PAPERCLIP_ALLOWED_HOSTNAMES`. Production must not use wildcard origins. Staging and production must also use separate databases and secret-store master keys or key files. When the local encrypted secret provider is used, back up its key together with the matching database.

### Configuration audit result

| Surface | Result |
| --- | --- |
| Root `.env.example` | Now provides development, authenticated-development, staging, and production account profiles with non-secret placeholders |
| `server/.env.example` | Still contains a fixed development-only `BETTER_AUTH_SECRET`; it must never be copied to staging or production |
| `server/docs/deploy/environment-variables.md` | Documents bind, deployment mode, exposure, database, and secret-store settings, but its main table still omits the public URL, trusted-origin, allowed-hostname, signup-policy, and auth-secret variables |
| `server/doc/DOCKER.md` | Documents generated auth secrets, public URL derivation, trusted origins, and allowed hostnames |
| `server/docker/.env.aws.example` | Declares authenticated/public mode, public URL, and an optional signup lock; secret values are expected from deployment infrastructure |
| `apps/gateway/.env.example` | Correctly contains no workspace password or Better Auth secret; the gateway must not translate ClawHunt identity into Node authority |

No new mail-provider secret is required for the current copy-link invite flow. No ClawHunt SSO exchange, issuer/JWKS trust, callback, or audience configuration exists in this slice. Those variables must not be invented in deployment files. A later SSO bridge needs a server-side trust design and separate staging/production credentials before a ClawHunt identity can become an AwwO workspace session.
