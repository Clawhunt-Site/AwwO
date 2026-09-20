# Personal accounts and model credentials

The account-based product uses the Go API, PostgreSQL, SaaS web client, Pi worker and OpenAI Agents JS worker. Registration creates a personal account and workspace. Existing workspace memberships and history are retained.

## User flow

1. Register with email and a password of at least 12 bytes, or sign in.
2. Select **My engines**: choose a provider, its supported execution engine, and your API key.
3. **Verify and save** reads the provider's model catalog and encrypts the key. Failed verification does not complete onboarding.
4. Select a model from the left-hand model shelf and a persona from the right-hand Bot list. Workspace/canvas membership controls remain in effect.
5. Open **Account security** to change your password or revoke individual sessions. A password change/reset signs out all sessions.

To use ClawHunt's model service, open [LLM Gate](https://api.clawhunt.site/), purchase credit there and create your own credential, then select LLM Gate in AwwO. AwwO does not purchase credit or reuse an operator's model key for personal runs.

| Provider | Supported engines | API |
| --- | --- | --- |
| LLM Gate / ClawHunt | Pi, OpenAI Agents JS | Chat Completions; GPT/Codex on Agents JS uses Responses |
| OpenAI / Codex | OpenAI Agents JS | Responses |
| Claude / Anthropic | Pi | Messages |
| Grok / xAI | Pi, OpenAI Agents JS | Chat Completions |
| Gemini / Google | Pi, OpenAI Agents JS | OpenAI-compatible Chat Completions |

The catalog is fetched with the supplied credential, not a hardcoded paid-model roster. Catalog access does **not** prove credit balance, inference permission or every model's protocol compatibility. A real run provides that evidence. Text-only execution uses a conservative 32,768-byte context envelope and 4,096-token output limit; long generated plans may need to be split. No unverified reasoning-effort options are advertised. Discovery retains up to 64 text-model IDs per connection, and an account may store eight connections. Remove and add a connection to refresh its catalog or rotate its key; select the replacement in existing nodes.

## Local startup

Install Node.js 24 LTS, Go 1.27.1+, and PostgreSQL 18 (`initdb`, `pg_ctl`, `psql`, `createdb` on PATH), then run:

```sh
npm run start:user
```

This installs missing application dependencies, builds the API, creates a dedicated loopback database, and starts the app at `http://127.0.0.1:5189`. Stop with Ctrl-C. It refuses occupied ports rather than killing another application. Configuration and local data live in `.local/awwo-saas`; back up that directory. The development administrator's generated password is in its private `.env` file; users can also register normally.

The launcher generates a stable 32-byte `AWWO_CREDENTIAL_ENCRYPTION_KEY` in standard base64 and selects `AWWO_CREDENTIAL_MODE=user`. That key is necessary to read existing saved credentials. **Do not regenerate it when restarting, upgrading or restoring the database.** Back it up separately and securely. Losing it requires users to replace their connections.

For a hosted-account Mac client, use the hosted service URL. A separate local development database contains separate accounts; it does not synchronize production data automatically.

## Hosted configuration

Use `deploy/saas/compose.yml` and its `.env.example`. Place the completed environment file outside Git and pass `--env-file /secure/path/awwo.env`. Set an HTTPS public origin and configure a TLS reverse proxy to the loopback ingress port. Provide independent random internal worker tokens and a persistent encryption key. All three services must use `AWWO_CREDENTIAL_MODE=user`. The API needs outbound HTTPS for provider verification and outbound SMTP for recovery; workers need HTTPS to the fixed provider endpoints. Do not expose workers or the database publicly.

```sh
docker compose --env-file /secure/path/awwo.env -f deploy/saas/compose.yml up -d --build
```

Fresh Compose/launcher configurations use personal credentials. For legacy installations only, explicit `AWWO_CREDENTIAL_MODE=operator` preserves operator-managed profiles. The standalone Go binary also retains that legacy default when the variable is absent. Personal mode rejects a worker that is not also in personal mode and never falls back to a global provider key.

### Password recovery

Configure `AWWO_SMTP_HOST`, `AWWO_SMTP_PORT` (587 STARTTLS or 465 TLS), `AWWO_SMTP_FROM`, and optional `AWWO_SMTP_USERNAME` / `AWWO_SMTP_PASSWORD`. Use a verified sender accepted by your mail provider. `AWWO_PUBLIC_ORIGIN` controls links; it must be your public HTTPS origin.

Reset links expire after 30 minutes, are single-use, and are stored as hashes. Requests give the same response for registered and unknown addresses, with per-address throttling and bounded asynchronous delivery. SMTP errors are logged without addresses, tokens or keys. If SMTP is absent, recovery explicitly reports unavailability. Registration does not send a verification email; this release uses email/password accounts, not email OTP or social login.

### Credential boundary

- AES-256-GCM ciphertext is bound to the account and connection ID. List APIs return metadata only; the original key cannot be retrieved through the UI.
- Model selectors are connection-specific. Another workspace member must select a connection they own before running a node. Shared canvases never grant access to someone else's key.
- Admission resolves the persisted run actor, including team child runs. The key travels only on the authenticated internal worker request and in the isolated child process; it is removed from the task request and excluded from snapshots, events and browser storage.
- Provider destinations are fixed on both the API and worker. Credential discovery refuses redirects and arbitrary base URLs. Keys are never placed in URLs.
- Removing a connection blocks subsequent admissions. An already admitted provider call may complete; revoke at the provider too if immediate revocation is required.

## Migration and rollback

Migration 017 is additive and transactional: personal connections, password-reset hashes and public session IDs. Startup applies it with the existing identified migration ledger and checks idempotence. Back up PostgreSQL and the vault key before upgrading; avoid simultaneous old/new API workers.

For application rollback, stop the new API and deploy the previous release with its prior operator configuration. Leave migration 017 tables/columns in place; old code ignores them. This preserves user data and avoids an irreversible down-migration. Restoring a database backup must use its matching vault key. This source release does not itself migrate or deploy an existing hosted service.

## Verification

```sh
npm run test:saas:backend
npm run test:user-models
npm run test:saas:pi
npm run test:saas:openai-agents
npm run test:saas:scripts
npm run test:saas --prefix apps/web
npm run typecheck:saas --prefix apps/web
npm run build:saas
```

Credential-discovery and admission tests use synthetic credentials and deterministic provider fixtures. They verify isolation and protocol flow without buying credit or claiming live model inference acceptance.
