# AwwO

AwwO is a collaborative AI canvas: choose your models on the left, choose Bots and personas on the right, and connect agent sessions into a workflow.

## Start locally

Requires **Node.js 24 LTS**, **Go 1.27.1+** and **PostgreSQL 18** with `initdb`, `pg_ctl`, `psql` and `createdb` on PATH.

```sh
git clone https://github.com/Clawhunt-Site/AwwO.git
cd AwwO
npm run start:user
```

Open **http://127.0.0.1:5189**. The launcher installs missing dependencies and starts the web client, API, database and execution workers. Ctrl-C stops its services. Local data and private configuration are stored in `.local/awwo-saas`; existing processes are never stopped to free ports.

## Connect your account and engine

1. Register or sign in with email and password.
2. Choose a model provider and execution engine, then enter **your own API key**.
3. Verify and save the connection. Available models appear in the model shelf.
4. Select a Bot/persona, build your canvas and run it.

**Want to use ClawHunt's model service?** Purchase credit and create a personal credential in [LLM Gate](https://api.clawhunt.site/), then select LLM Gate in AwwO. AwwO does not make purchases on your behalf.

| Model service | Execution engine |
| --- | --- |
| LLM Gate / ClawHunt | Pi or OpenAI Agents JS |
| OpenAI / Codex | OpenAI Agents JS |
| Claude / Anthropic | Pi |
| Grok / xAI | Pi or OpenAI Agents JS |
| Gemini / Google | Pi or OpenAI Agents JS |

Model lists come from the provider's API. Model access and credit depend on your provider account; verifying a catalog does not verify inference or balance. Keys are encrypted on the server and scoped to the account. A shared canvas does not share the owner's key: each person running it must select their own connection.

Account settings include profile editing, password changes and session revocation. Password recovery requires configured SMTP. Workspace membership and existing canvas history remain part of the user system.

## Deploy

The application includes a production Compose package in [`deploy/saas`](deploy/saas). Copy `.env.example` to a secure location, configure an HTTPS origin, database credentials, independent worker tokens and a stable vault encryption key, then run:

```sh
docker compose --env-file /secure/path/awwo.env -f deploy/saas/compose.yml up -d --build
```

The ingress binds to loopback for your TLS reverse proxy. Database and worker ports remain private. See [personal accounts and deployment](docs/personal-accounts.md) for SMTP, credential boundaries, migrations and rollback.

The hosted Mac shell source is in [`apps/macos`](apps/macos). A shell pointed at your hosted service retains that service's accounts/workspaces. Starting an independent local database does not copy production data.

## Verify

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

The backend test wrapper uses the dedicated local PostgreSQL instance (or an explicit `AWWO_DATABASE_URL`). Direct `go test` runs from `backend` use `AWWO_TEST_DATABASE_URL`. Always use a disposable test database. Provider fixtures use synthetic keys and do not purchase credit.

The repository also contains earlier CLI/desktop components and historical documentation. The account-based product described here is `backend` + `apps/web` (SaaS build) + `apps/pi-worker` + `apps/openai-agents-worker`.

## License

See [LICENSE](LICENSE).
