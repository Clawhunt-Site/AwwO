import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export const UPSTREAM_REVISION = '104fd17b8f7767e71ba3cf40f27f9c6279b507bd';
export const PATCH_VERSION = 1;
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '.runtime', 'core');
const run = (command: string, args: string[], cwd = root) => execFileSync(command, args, {
  cwd, stdio: 'inherit', env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
});
function replace(path: string, from: string, to: string) {
  const file = join(root, path), source = readFileSync(file, 'utf8');
  if (source.split(from).length !== 2) throw new Error(`Pinned source patch did not match ${path}`);
  writeFileSync(file, source.replace(from, to));
}
export function setup() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('OpenMaus core requires Node 24 or newer');
  mkdirSync(dirname(root), { recursive: true });
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  if (process.env.AWWO_OPENMAUS_SOURCE) {
    const source = process.env.AWWO_OPENMAUS_SOURCE;
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    if (revision !== UPSTREAM_REVISION || execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim()) throw new Error('Local upstream must be the clean pinned checkout');
    cpSync(source, root, { recursive: true, filter: path => !path.includes('/node_modules') && !path.includes('/dist-server') });
  } else {
    mkdirSync(root, { recursive: true });
    run('git', ['init']);
    run('git', ['remote', 'add', 'origin', 'https://github.com/milind-soni/OpenMausBot.git']);
    run('git', ['fetch', '--depth=1', 'origin', UPSTREAM_REVISION]);
    run('git', ['checkout', '--detach', 'FETCH_HEAD']);
  }
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (revision !== UPSTREAM_REVISION) throw new Error('Unexpected upstream revision');
  rmSync(join(root, 'enterprise'), { recursive: true, force: true });
  replace('server/drivers/openai-compat.ts', 'computerUse: true,', 'computerUse: false,');
  replace('server/drivers/openai-chat.ts',
    'tools = await mountChatTools(options.tools === false ? undefined : turn.integrations, abort.signal, options.computerUse);',
    'tools = await mountChatTools(options.tools === false ? undefined : { custom: turn.integrations?.custom?.awwo_workspace ? { awwo_workspace: turn.integrations.custom.awwo_workspace } : {} }, abort.signal, false);');
  replace('server/drivers/openai-chat.ts', 'agentsMcp: options.tools !== false, composioMcp: options.tools !== false,', 'agentsMcp: false, composioMcp: false,');
  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'pnpm@10.33.0', 'install', '--frozen-lockfile', '--ignore-scripts', '--filter', 'openmausbot']);
  run(process.execPath, ['scripts/bundle-server.mjs']);
  if (existsSync(join(root, 'dist-server', 'enterprise'))) throw new Error('Enterprise code must not be bundled');
  writeFileSync(join(root, 'dist-server', 'NOTICE'), readFileSync(join(root, 'NOTICE'), 'utf8') + '\n' + readFileSync(join(here, '../../third_party/openmaus-core/NOTICE'), 'utf8'));
  cpSync(join(root, 'third_party'), join(root, 'dist-server', 'third_party'), { recursive: true });
  cpSync(join(root, 'LICENSE'), join(root, 'dist-server', 'LICENSE'));
  writeFileSync(join(root, 'dist-server', 'awwo-build.json'), JSON.stringify({ upstreamRevision: UPSTREAM_REVISION, patchVersion: PATCH_VERSION }));
  console.log('AwwO managed OpenMaus core is ready.');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) setup();
