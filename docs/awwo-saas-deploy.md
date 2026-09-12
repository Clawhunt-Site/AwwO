# AwwO SaaS deployment — awwo.clawhunt.store

Recorded on 2026-09-12 from an executed and verified deployment of `e05d2af`. This documents the
deployment that actually exists; `docs/deploy-aws.md` describes a **different** application
(`canvas.clawhunt.store`) and does not apply here.

## Where it runs

| Fact | Value |
| --- | --- |
| Host | EC2 `awwo-acceptance`, `i-0eda5599cbd603c8b` |
| Account / region | `563688183799` / `us-east-2`, CLI profile `clawhunt` |
| Exposure | `cloudflared-awwo.service` tunnel → Cloudflare Access application on `awwo.clawhunt.store` |
| Access to the host | AWS SSM (`aws ssm send-command`). There is no Docker and no AWS CLI on the box. |

`deploy/saas/compose.yml` is **not** the live path. Services run natively under systemd as
`awwo-saas:awwo`:

| Unit | Role | Listener |
| --- | --- | --- |
| `awwo-saas-web` | nginx serving the built bundle, proxying `/api` | `127.0.0.1:5188` |
| `awwo-saas-api` | Go API | `127.0.0.1:8087` |
| `awwo-saas-pi` | Pi worker (text-only runtime) | `127.0.0.1:8097` |
| `awwo-saas-database` | PostgreSQL for the SaaS | `127.0.0.1:54329` |

Releases are immutable directories `/srv/awwo/releases/saas-<short-sha>/` containing `awwo-api`,
`html/`, `SOURCE_SHA`, `SHA256SUMS`. Mutable state and configuration stay in
`/srv/awwo/saas-staging/{config,postgres,logs,run,backups,evidence}` and are never part of a release.

The `STAGING · 测试环境` badge is injected by `sub_filter` in
`/srv/awwo/saas-staging/config/nginx-web.conf`. It is not in the repository — do not look for it in
the bundle, and remove it there when this host stops being a staging host.

## Build

The API must be built with its source commit injected, or `/api/v1/health` reports
`revision: "unknown"`:

```bash
SHA=$(git rev-parse HEAD)                      # clean tree only; HEAD is what ships
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -ldflags "-s -w -X awwo/backend/internal/app.buildRevision=$SHA" \
  -o /tmp/awwo-rel/awwo-api ./cmd/api          # from backend/
npm run build:saas --prefix apps/web           # → apps/web/dist-saas → release html/
```

Package `awwo-api`, `html/`, `SOURCE_SHA` and `SHA256SUMS` into one tarball, upload it to
`s3://clawhunt-data-563688183799/deploy/awwo-saas/`, and fetch it on the host with a presigned URL
(the host has `curl`, not the AWS CLI).

## Switch

1. **Back up first.** `aws ec2 create-snapshot --volume-id <root volume>` for a rollback point, and
   copy `awwo-saas-api.service` plus `nginx-web.conf` into `/srv/awwo/saas-staging/backups/`. The
   host's PostgreSQL build ships only `initdb`/`pg_ctl`/`postgres`, so there is **no `pg_dump`** —
   the EBS snapshot is the database backup.
2. Extract the release, `chown -R root:awwo`, dirs `0750`, files `0640`, `awwo-api` `0750`, then
   verify `sha256sum -c SHA256SUMS`.
3. Point `ExecStart=` (and `Description=`) in `awwo-saas-api.service` at the new release,
   `systemctl daemon-reload`, `systemctl restart awwo-saas-api`. Migrations are embedded and applied
   by `Migrate()` before the API listens, so a listening API means they succeeded.
4. Point `root` in `nginx-web.conf` (and `nginx-preview.conf`) at the new `html/`, `nginx -t`, then
   `systemctl restart awwo-saas-web`.

Leave `awwo-saas-pi` and `awwo-saas-database` alone unless the Pi worker or the PostgreSQL runtime
actually changed; they may legitimately reference an older release directory.

## Verify — the deployment must be checkable, not assumed

A unit `Description=`, a release directory name and a deploy log can all be stale. Check what is
actually serving:

```bash
curl -s https://awwo.clawhunt.store/api/v1/health     # in a browser session that passed Access
# {"environment":"staging","revision":"<the deployed commit>","status":"ok"}
```

`revision` is the commit the running binary was built from, so it cannot disagree with reality. On
the host, confirm the rest:

```bash
tr '\0' ' ' < /proc/$(systemctl show -p MainPID --value awwo-saas-api)/cmdline   # running binary path
grep -n 'root /srv' /srv/awwo/saas-staging/config/nginx-web.conf                # served bundle
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8087/api/v1/tenants/t/artifacts/a  # 401 = route present
```

401 (not 404) on an authenticated route proves it is registered and that authorization is enforced.

Do **not** run the account/graph acceptance flows against this host: they create users, workspaces
and invites that cannot be removed through the API.

## Roll back

Point `ExecStart=` and the nginx `root` back at the previous release directory, `daemon-reload`,
restart `awwo-saas-api` and `awwo-saas-web`. Additive migrations (a new table) leave the previous
binary working against the newer schema, so a schema rollback is not required; restore the EBS
snapshot only if data itself is wrong.
