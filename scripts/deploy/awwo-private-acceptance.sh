#!/usr/bin/env bash
# First installation only. No application code, existing state or units are overwritten.
set -Eeuo pipefail
umask 077

fail() { printf 'AwwO install: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: sudo bash awwo-private-acceptance.sh [options]
  --repo PATH             Verified, extracted v0.3.0 source (default /srv/awwo/releases/v0.3.0)
  --state PATH            NEW persistent directory (default /srv/awwo/data)
  --user NAME             Existing non-root runtime account (default awwo)
  --node-bin PATH         Node 24 executable (default /usr/local/bin/node)
  --codex-bin PATH        Codex executable (default /usr/local/bin/codex)
  --node-port NUMBER      Control plane (default 3100)
  --gateway-port NUMBER   Gateway (default 8796)
  --web-port NUMBER       Built Web preview (default 5188)
  --postgres-port NUMBER  Native PostgreSQL (default 54329)
  --service-prefix NAME   Unit prefix, awwo-* (default awwo-acceptance)
  --check-inputs          Validate arguments only; no filesystem writes or root required
Every listener is fixed to loopback. APP_ENV and VITE_APP_ENV are staging.
This is an SSH-gated single-operator acceptance installation, not public hosting.
HELP
}

repo=/srv/awwo/releases/v0.3.0
state=/srv/awwo/data
runtime_user=awwo
node_bin=/usr/local/bin/node
codex_bin=/usr/local/bin/codex
node_port=3100 gateway_port=8796 web_port=5188 postgres_port=54329
service_prefix=awwo-acceptance
check_inputs=false
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --check-inputs) check_inputs=true; shift ;;
    --repo|--state|--user|--node-bin|--codex-bin|--node-port|--gateway-port|--web-port|--postgres-port|--service-prefix)
      (($# >= 2)) || fail "Missing value for $1"
      case "$1" in
        --repo) repo=$2 ;; --state) state=$2 ;; --user) runtime_user=$2 ;;
        --node-bin) node_bin=$2 ;; --codex-bin) codex_bin=$2 ;;
        --node-port) node_port=$2 ;; --gateway-port) gateway_port=$2 ;;
        --web-port) web_port=$2 ;; --postgres-port) postgres_port=$2 ;;
        --service-prefix) service_prefix=$2 ;;
      esac
      shift 2 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

# Paths are deliberately conservative: no shell/systemd expansion, whitespace,
# relative components, trailing slash, symlink traversal or broad system roots.
safe_path() {
  [[ $1 =~ ^/([A-Za-z0-9_][A-Za-z0-9_.-]*/)*[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || fail "Unsafe absolute path: $1"
  case "$1" in /|/srv|/home|/opt|/var|/etc|/usr|/root|/tmp|/run|/bin|/sbin) fail "Path is too broad: $1" ;; esac
}
for value in "$repo" "$state" "$node_bin" "$codex_bin"; do safe_path "$value"; done
[[ $repo != "$state" && $repo != "$state/"* && $state != "$repo/"* ]] || fail 'Source and state must be separate directories.'
[[ $runtime_user =~ ^[a-z_][a-z0-9_-]{0,30}$ && $runtime_user != root ]] || fail 'Runtime account must be a safe non-root username.'
[[ $service_prefix =~ ^awwo-[a-z0-9][a-z0-9-]{0,40}$ ]] || fail 'Unit prefix must start with awwo- and use lowercase letters, digits or hyphens.'
ports=("$node_port" "$gateway_port" "$web_port" "$postgres_port")
for value in "${ports[@]}"; do
  [[ $value =~ ^[1-9][0-9]{3,4}$ ]] && ((value >= 1024 && value <= 65535)) || fail 'Ports must be decimal integers between 1024 and 65535.'
done
for ((i=0; i<${#ports[@]}; i++)); do
  for ((j=i+1; j<${#ports[@]}; j++)); do [[ ${ports[i]} != "${ports[j]}" ]] || fail 'All four ports must be distinct.'; done
done
for value in "${APP_ENV:-staging}" "${VITE_APP_ENV:-staging}"; do
  [[ $value == staging ]] || fail 'This installer only supports APP_ENV=VITE_APP_ENV=staging.'
done
if $check_inputs; then printf 'AwwO deployment arguments valid. No installation performed.\n'; exit 0; fi

((EUID == 0)) || fail 'Run the installer with sudo; the services themselves must run as the non-root account.'
[[ $(uname -s) == Linux ]] || fail 'This installer requires Linux with systemd.'
for command in runuser getent realpath systemctl ss install curl; do command -v "$command" >/dev/null || fail "Missing prerequisite: $command"; done
[[ -d /run/systemd/system ]] || fail 'systemd must be running.'
[[ $(id -u "$runtime_user") -gt 0 ]] || fail 'Runtime account must exist and must not have UID 0.'
runtime_home=$(getent passwd "$runtime_user" | cut -d: -f6)
runtime_group=$(id -gn "$runtime_user")
safe_path "$runtime_home"
for value in "$repo" "$state" "$runtime_home"; do
  [[ $(realpath -m -- "$value") == "$value" ]] || fail "Symlink or non-canonical path is not accepted: $value"
done
[[ -d $repo && -d $runtime_home && -d $(dirname "$state") ]] || fail 'Source, account home and state parent must already exist.'
[[ ! -e $state && ! -L $state ]] || fail "State already exists; preserve it and use a separately reviewed upgrade procedure: $state"
[[ -x $node_bin && -x $codex_bin ]] || fail 'Install Node and Codex at the configured executable paths first.'
[[ $("$node_bin" -p 'process.versions.node.split(".")[0]') == 24 ]] || fail 'This acceptance installer is verified for Node 24.'
[[ $(tr -d '\r\n' < "$repo/VERSION") == 0.3.0 ]] || fail 'Expected the verified AwwO v0.3.0 release.'
for file in scripts/awwo-dev.mjs scripts/awwo-setup.mjs apps/web/vite.config.mjs server/server/src/index.ts; do
  [[ -f $repo/$file ]] || fail "Incomplete source archive: $file"
done
for part in node gateway web; do
  unit="$service_prefix-$part.service"
  [[ ! -e /etc/systemd/system/$unit && ! -L /etc/systemd/system/$unit ]] || fail "Existing unit must not be replaced: $unit"
  [[ $(systemctl show "$unit" --property=LoadState --value) == not-found ]] || fail "Unit already registered: $unit"
done
# Clear inherited credentials/provider settings for installation and every service.
clean_path="$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin"
run_as() {
  runuser -u "$runtime_user" -- env -i HOME="$runtime_home" USER="$runtime_user" LOGNAME="$runtime_user" \
    SHELL=/bin/bash PATH="$clean_path" LANG=C.UTF-8 APP_ENV=staging VITE_APP_ENV=staging \
    SUPERCLAW_GATEWAY_SIDECAR=off VITE_CLAWHUNT_BASE_URL=http://127.0.0.1:9 CLAWHUNT_BASE_URL=http://127.0.0.1:9 "$@"
}
run_as test -w "$repo" || fail 'The runtime account must own the extracted release so dependency installation can run without root.'
[[ $(run_as pnpm -C "$repo/server" --version) == 9.15.4 ]] || fail 'Install pnpm 9.15.4 first.'
run_as "$node_bin" --input-type=module - "${ports[@]}" <<'JS'
import { createServer } from 'node:net';
for (const raw of process.argv.slice(2)) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`Port ${raw} is occupied; no process was stopped.`)));
    probe.listen({ host: '127.0.0.1', port: Number(raw), exclusive: true }, () => probe.close(resolve));
  });
}
JS

# mkdir, unlike install -d, refuses an existing directory even during a race.
mkdir --mode=0700 -- "$state"
chown "$runtime_user:$runtime_group" "$state"
run_as "$node_bin" --input-type=module - "$state" "$runtime_home" "$node_port" "$gateway_port" "$web_port" "$postgres_port" "$codex_bin" <<'JS'
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const [state, home, nodePort, gatewayPort, webPort, pgPort, codex] = process.argv.slice(2);
const instance = `${state}/runtime/instances/default`;
for (const dir of [instance, `${state}/gateway`, `${state}/logs`, `${state}/storage`, `${state}/workspaces`, `${state}/secrets`]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const write = (file, value) => writeFileSync(file, value, { flag: 'wx', mode: 0o600 });
write(`${state}/secrets/master.key`, randomBytes(32).toString('base64') + '\n');
const env = {
  APP_ENV: 'staging', VITE_APP_ENV: 'staging', NODE_ENV: 'production',
  PAPERCLIP_HOME: `${state}/runtime`, PAPERCLIP_CONFIG: `${instance}/config.json`, PAPERCLIP_INSTANCE_ID: 'default',
  PAPERCLIP_IN_WORKTREE: 'false', PAPERCLIP_DEPLOYMENT_MODE: 'local_trusted', PAPERCLIP_DEPLOYMENT_EXPOSURE: 'private', PAPERCLIP_BIND: 'loopback',
  PAPERCLIP_AGENT_JWT_SECRET: randomBytes(32).toString('hex'),
  PAPERCLIP_SECRETS_PROVIDER: 'local_encrypted', PAPERCLIP_SECRETS_MASTER_KEY_FILE: `${state}/secrets/master.key`,
  PAPERCLIP_LOG_DIR: `${state}/logs`, PAPERCLIP_STORAGE_PROVIDER: 'local_disk', PAPERCLIP_STORAGE_LOCAL_DIR: `${state}/storage`,
  PAPERCLIP_MIGRATION_AUTO_APPLY: 'true', PAPERCLIP_MIGRATION_PROMPT: 'never',
  PAPERCLIP_DB_BACKUP_ENABLED: 'false', HEARTBEAT_SCHEDULER_ENABLED: 'false',
  PAPERCLIP_TELEMETRY_DISABLED: '1', PAPERCLIP_OPEN_ON_LISTEN: 'false', SERVE_UI: 'false',
  SUPERCLAW_DESKTOP_PGLITE: '0', SUPERCLAW_HOME: `${state}/gateway`,
  HOST: '127.0.0.1', PORT: nodePort, SUPERCLAW_GATEWAY_HOST: '127.0.0.1', SUPERCLAW_GATEWAY_PORT: gatewayPort,
  SUPERCLAW_GATEWAY_UPSTREAM_URL: `http://127.0.0.1:${nodePort}`,
  SUPERCLAW_GATEWAY_CLAWHUNT_BASE_URL: '', SUPERCLAW_GATEWAY_CROSS_COMPANY_AUTONOMY: 'off',
  VITE_NODE_API_TARGET: `http://127.0.0.1:${nodePort}`, VITE_GATEWAY_API_TARGET: `http://127.0.0.1:${gatewayPort}`,
  VITE_SUPERCLAW_WEB_HOST: '127.0.0.1', VITE_SUPERCLAW_WEB_PORT: webPort, SUPERCLAW_GATEWAY_SIDECAR: 'off',
  CLAWHUNT_BASE_URL: 'http://127.0.0.1:9', VITE_CLAWHUNT_BASE_URL: 'http://127.0.0.1:9',
  SUPERCLAW_CANVAS_PLANNER_PROVIDER: 'codex', SUPERCLAW_CANVAS_PLANNER_CLI_PATH: codex,
  CODEX_HOME: `${home}/.codex`,
};
write(`${state}/.env`, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
write(`${instance}/config.json`, JSON.stringify({
  $meta: { version: 1, updatedAt: new Date().toISOString(), source: 'configure' },
  database: { mode: 'embedded-postgres', embeddedPostgresDataDir: `${state}/postgres`, embeddedPostgresPort: Number(pgPort), backup: { enabled: false, dir: `${state}/backups` } },
  logging: { mode: 'file', logDir: `${state}/logs` },
  server: { deploymentMode: 'local_trusted', exposure: 'private', bind: 'loopback', host: '127.0.0.1', port: Number(nodePort), serveUi: false },
  telemetry: { enabled: false },
  storage: { provider: 'local_disk', localDisk: { baseDir: `${state}/storage` } },
  secrets: { provider: 'local_encrypted', localEncrypted: { keyFilePath: `${state}/secrets/master.key` } },
}, null, 2) + '\n');
JS

printf 'Installing locked dependencies as %s (runtime secrets are not passed to package scripts).\n' "$runtime_user"
(cd "$repo"; run_as npm run setup; run_as npm run build:web)
run_as "$node_bin" --input-type=module - "$repo" "$state" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [repo, state] = process.argv.slice(2);
const index = `${repo}/apps/web/dist/index.html`;
const html = readFileSync(index, 'utf8');
if (!/<title>[\s\S]*?<\/title>/i.test(html)) throw new Error('Built Web index has no title for the staging marker.');
writeFileSync(index, html.replace(/<title>([\s\S]*?)<\/title>/i, '<title>[STAGING] $1</title>'));
writeFileSync(`${repo}/apps/web/dist/robots.txt`, 'User-agent: *\nDisallow: /\n');
// Only build artifacts and private deployment config change; source stays intact.
writeFileSync(`${state}/preview.config.mjs`, `import base from '${repo}/apps/web/vite.config.mjs';\nexport default { ...base, preview: { ...base.preview, headers: { ...base.preview?.headers, 'X-Robots-Tag': 'noindex, nofollow' } } };\n`, { flag: 'wx', mode: 0o600 });
JS

write_unit() {
  local part=$1 directory=$2 command=$3 after=${4:-network.target}
  # noclobber creates the root-owned destination exclusively; it cannot replace a unit.
  (
    set -o noclobber
    cat > "/etc/systemd/system/$service_prefix-$part.service" <<UNIT
[Unit]
Description=AwwO private acceptance $part (v0.3.0)
After=$after

[Service]
Type=simple
User=$runtime_user
Group=$runtime_group
WorkingDirectory=$directory
Environment=HOME=$runtime_home
Environment=USER=$runtime_user
Environment=LOGNAME=$runtime_user
Environment=PATH=$clean_path
Environment=LANG=C.UTF-8
EnvironmentFile=$state/.env
ExecStart=$command
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
KillMode=mixed
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
  )
  chmod 0644 "/etc/systemd/system/$service_prefix-$part.service"
}
write_unit node "$state" "$node_bin --import $repo/server/server/node_modules/tsx/dist/loader.mjs $repo/scripts/awwo-dev.mjs --control-plane"
write_unit gateway "$state" "$node_bin $repo/apps/gateway/dist/index.js" "$service_prefix-node.service"
write_unit web "$repo/apps/web" "$node_bin $repo/apps/web/node_modules/vite/bin/vite.js preview --configLoader runner --config $state/preview.config.mjs --host 127.0.0.1 --port $web_port --strictPort" "$service_prefix-node.service $service_prefix-gateway.service"
systemctl daemon-reload

health() {
  run_as "$node_bin" --input-type=module - "$repo" "$1" "$2" <<'JS'
const [repo, url, kind] = process.argv.slice(2);
const { waitForHealth } = await import(`${repo}/scripts/awwo-dev.mjs`);
await waitForHealth(url, { gateway: kind === 'gateway', html: kind === 'web', timeoutMs: 180000 });
JS
}
for part in node gateway web; do
  systemctl enable --now "$service_prefix-$part.service"
  case "$part" in
    node) health "http://127.0.0.1:$node_port/api/health" node ;;
    gateway) health "http://127.0.0.1:$gateway_port/health" gateway ;;
    web) health "http://127.0.0.1:$web_port/" web ;;
  esac
done
# Verify the requested database port was used, not an upstream port fallback.
ss -H -ltn | awk -v p=":$postgres_port" '$4 ~ (p "$") { found=1 } END { exit !found }' || fail 'PostgreSQL did not bind the requested port.'
# For every deployment port reject wildcard, external IPv4 and external IPv6 binds.
for value in "${ports[@]}"; do
  while read -r address; do
    case "$address" in "127.0.0.1:$value"|"[::1]:$value"|"::1:$value") ;; *) fail "Non-loopback listener detected at $address" ;; esac
  done < <(ss -H -ltn | awk -v p=":$value" '$4 ~ (p "$") { print $4 }')
done
printf 'AwwO v0.3.0 private acceptance services are ready. Web: http://127.0.0.1:%s/ (SSH tunnel required).\n' "$web_port"
printf 'State: %s. Codex login and a real Agent run remain separate acceptance steps.\n' "$state"
