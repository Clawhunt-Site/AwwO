# AwwO SaaS deployment — awwo.clawhunt.store

Recorded on 2026-09-12 from an executed and verified deployment of `e05d2af`, and re-verified on
2026-09-14 by deploying `24fcb43` over `edb7f3a` (18 commits, including three unshipped migrations).
This documents the deployment that actually exists; `docs/deploy-aws.md` describes a **different**
application (`canvas.clawhunt.store`) and does not apply here.

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
2. Extract the release, then match what the live releases actually carry — `root:root`, dirs `755`,
   files `644`, `awwo-api` `755` — and verify `sha256sum -c SHA256SUMS`. The release directory being
   world-readable is not a leak: its parent `/srv/awwo/releases` is `drwxr-x---  awwo awwo`, which is
   what restricts access. An earlier revision of this page prescribed `root:awwo` with `0750`/`0640`;
   that is not what any deployed release has, so following it would have made the new release the
   odd one out.
3. The web bundle is built to `apps/web/dist-saas` and copied to the release's `html/` verbatim. Its
   entry document is `saas.html`, not `index.html` — nginx names it in `index` and `try_files`, so
   renaming it would 404 every route.
4. Point `ExecStart=` **and** `Description=` in `awwo-saas-api.service` at the new release —
   `sed -i 's|saas-<old>|saas-<new>|g'` catches `ExecStart` but not a `Description` that names the sha
   without the `saas-` prefix, which is how a stale description survives a correct deploy. Then
   `systemctl daemon-reload`, `systemctl restart awwo-saas-api`. Migrations are embedded and applied
   by `Migrate()` before the API listens, so a listening API means they succeeded.
5. Point `root` in `nginx-web.conf` at the new `html/`, `nginx -t`, then
   `systemctl restart awwo-saas-web`. `nginx-preview.conf` is a separate preview vhost that tracks its
   own release and was on `saas-f3be5f7` at the time of writing; do not move it as a side effect of
   deploying the main site.

### Read the release the unit points at; never hardcode the one you expect

On 2026-09-14 a second session deployed `d10ae41` to this host while a deploy of `df43e77` was being
prepared. A `sed s|saas-<expected-old>|saas-<new>|` found nothing to replace, so the unit kept
pointing at the other session's release and the restart was a no-op that only bounced the API for a
second. Take the current release out of the unit and the nginx config at run time and substitute from
that, so a deploy either moves the tip forward from wherever it actually is or fails loudly. Also
record it: it is the rollback target, and it is not necessarily the release you last shipped.

Releases are retained, so rolling back is `sed` from the new release back to the recorded one,
`daemon-reload`, and restart. Confirm afterwards with `systemctl show -p ExecStart --value`.

### Two ways a generated deploy script silently breaks

Both of these cost a failed run on 2026-09-14 and neither is obvious from the error:

- `set -e` plus a readiness loop. `R=$(curl ... )` inside `for i in $(seq ...)` aborts the whole
  script the first time the API is not yet up — which is exactly when the loop exists — so the
  rollback branch never runs. Either drop `set -e` for that stretch or end the command with `|| true`.
- Control bytes from the generator. If the command text is produced by another language, a
  backslash-digit can become a control byte and a backslash-zero can become NUL. A NUL anywhere in
  the script makes the whole thing fail with `Exec format error: exit status 126` and no output at
  all, which reads like a permissions problem. Write the commands without backslashes — `grep -o`
  plus `cut` needs none where `sed` with a backreference does — and assert the generated text
  contains no byte below 0x20 before sending it.

### Before switching, size the migrations rather than assuming they are cheap

`Migrate()` runs every pending migration inside **one transaction** before the API listens, so a slow
one is downtime and a locking one is an outage. Measure first: on 2026-09-14 the whole cluster was
65 MB with no table file above 1 MB, so migrations 013–015 — which include two full-table `UPDATE`s
and two non-concurrent `CREATE INDEX`es on `model_invocations` — applied in under two seconds. That
was checked, not assumed; on a large table the same migrations would need a different plan.

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

### An unauthenticated request to the public URL proves nothing

Cloudflare Access answers an unauthenticated request with `302` **at the edge**, before the tunnel
is consulted. So a `302` from `https://awwo.clawhunt.store/` says only that Access is configured —
a tunnel that cannot reach the origin at all still returns `302` to a request without a session
cookie, while every real user gets `502`. A deploy verified only by "origin is 200 locally" plus
"public URL redirects" is therefore **not** verified end to end; that combination missed a
multi-hour 502 outage on 2026-09-12.

Until either a Cloudflare Access **Bypass** policy exists for one harmless path (`/api/v1/health` is
the natural choice) or an Access **service token** is issued, the only way to exercise the whole path
is a browser session that already passed Access — which is what verified the 2026-09-14 deploys, via
this host's own nginx access log showing an authenticated session fetching the new bundle.

Two corrections, both established by checking rather than by reading this page:

- SSM `/awwo/cf-access-token` is **not** an Access service token, so it cannot be sent as
  `CF-Access-Client-Id` / `CF-Access-Client-Secret`. It is a Cloudflare **API** token (verified active
  via `GET /client/v4/user/tokens/verify`) scoped to the zones `clawhunt.store` and `arxchibo.ccwu.cc`
  and able to read the account's Access applications. The account has **zero** Access service tokens.
- The PlatformEngineer SSO role can read that parameter perfectly well (it carries
  `PowerUserAccess`, which includes `ssm:*`). An earlier conclusion that it could list but not read
  was wrong: Git Bash on Windows rewrites a leading-slash argument into a Windows path, so
  `--name /awwo/cf-access-token` reached the API as `C:/Program Files/Git/awwo/...` and genuinely did
  not exist. Prefix such commands with `MSYS_NO_PATHCONV=1`. The plural `get-parameters` call is what
  exposes this: a denied read appears in `InvalidParameters`, and so does a mangled name.

The AwwO Access application is `AwwO Team Workspace` (`280318d5-ad96-4769-9c67-19bcfce46077`) on
`awwo.clawhunt.store`. A path-scoped application is already the pattern in this account — there is one
for `staging.clawhunt.store/v1/capabilities/submissions` — so scoping a policy to `/api/v1/health`
means creating a second application whose hostname carries that path, since a policy applies to an
application rather than to a path.

What *can* be checked from the host is whether requests are arriving at all:

```bash
curl -s http://127.0.0.1:20241/ready        # {"status":200,"readyConnections":4,...}
tail -5 /srv/awwo/saas-staging/run/nginx-web/access.log   # are real requests reaching the origin?
```

An access log whose newest entries are all your own probes, while users report `502`, means the
requests are not reaching the origin — look at the tunnel, not the application.

## Known failure mode: the connector silently loses its edge connections

On 2026-09-10 this tunnel's QUIC paths failed (`timeout: no recent network activity`); connections
0–2 died and never re-registered, Cloudflare stopped routing to the connector, and the site served
`502` for hours with every application service healthy. It went unnoticed because
`cloudflared_tunnel_ha_connections` still reported `4` — **that Prometheus gauge is not a reliable
liveness signal**. `GET /ready` reports the real registration count and is what to trust.

Mitigations now in place:

- cloudflared is kept current (the 2026.8.3 build exhibited this; upgraded to 2026.9.1). It runs
  with `--no-autoupdate`, so upgrades are manual: `dpkg -i` the release `.deb` from GitHub, keeping
  a copy of the previous binary in `/srv/awwo/saas-staging/backups/` for rollback.
- `awwo-tunnel-watchdog.timer` runs `/usr/local/bin/awwo-tunnel-watchdog.sh` every two minutes. It
  restarts the tunnel only when the origin is healthy **and** `/ready` is unreachable or reports too
  few connections, with a 10-minute cooldown so it cannot flap. It deliberately never touches the
  web or API units: if the origin is down, the tunnel is not the fault. Set `EDGE_URL` (and
  optionally `ACCESS_HEADER_FILE`) in the unit to upgrade it to a true end-to-end check once an
  Access bypass or service token is available.

Verify the watchdog itself by fault injection, not by reading it:
`systemctl stop cloudflared-awwo && /usr/local/bin/awwo-tunnel-watchdog.sh` should log the restart
and report `readyConnections=4` afterwards.

## Roll back

Point `ExecStart=` and the nginx `root` back at the previous release directory, `daemon-reload`,
restart `awwo-saas-api` and `awwo-saas-web`. Additive migrations (a new table) leave the previous
binary working against the newer schema, so a schema rollback is not required; restore the EBS
snapshot only if data itself is wrong.
