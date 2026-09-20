import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TeamMarketAgent, TeamMarketCatalog } from '../apps/web/src/canvas/teamMarketAgents.ts';

const ROOT = 'server/packages/teams-catalog';
export const TEAM_MARKET_ARTIFACT_PATH = 'apps/web/src/canvas/team-market-agents.json';
export const TEAM_MARKET_MANIFEST_PATH = `${ROOT}/generated/catalog.json`;
const TEAMS = [
  { path: 'catalog/bundled/company-defaults/core-exec-team', slugs: ['ceo', 'cto', 'qa'] },
  { path: 'catalog/bundled/product/product-design', slugs: ['ux-designer'] },
  { path: 'catalog/bundled/software-development/product-engineering', slugs: ['cto', 'qa', 'senior-coder'] },
  { path: 'catalog/optional/content/content-machine', slugs: ['content-lead'] },
] as const;

/** No directory scan, environment config, skill file, token file or manifest-selected path is read. */
export const TEAM_MARKET_SOURCE_PATHS: readonly string[] = [TEAM_MARKET_MANIFEST_PATH,
  ...TEAMS.flatMap(team => [`${ROOT}/${team.path}/TEAM.md`, ...team.slugs.map(slug => `${ROOT}/${team.path}/agents/${slug}/AGENTS.md`)]),
];
const allowed = new Set(TEAM_MARKET_SOURCE_PATHS);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid source catalogue structure');
  return value as RecordValue;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing source catalogue metadata');
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid source catalogue list');
  return value;
}

/** The shipped role frontmatter is a deliberately limited scalar + string-list format. */
export function parseTeamMarketRole(text: string): { name: string; role: string; title: string; slug: string; skills: string[] } {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!header) throw new Error('Role frontmatter is missing');
  const values: Record<string, string> = {};
  const skills: string[] = [];
  let list = false;
  for (const line of header[1].split(/\r?\n/)) {
    if (/^\s*$/.test(line)) continue;
    if (list && /^  - [a-z0-9][a-z0-9-]*$/.test(line)) { skills.push(line.slice(4)); continue; }
    const field = /^(name|slug|title|role|reportsTo|skills):(?: (.+))?$/.exec(line);
    if (!field || Object.hasOwn(values, field[1])) throw new Error('Unexpected or duplicate role metadata');
    const key = field[1], value = field[2] ?? '';
    if (key !== 'skills' && !value) throw new Error('Empty role metadata');
    if (key === 'skills' && value) throw new Error('Unsupported role skills format');
    values[key] = value; list = key === 'skills';
  }
  if (new Set(skills).size !== skills.length) throw new Error('Duplicate role skill');
  return { name: string(values.name), role: string(values.role), title: string(values.title), slug: string(values.slug), skills };
}

export async function buildTeamMarketCatalog(repositoryRoot: string): Promise<TeamMarketCatalog> {
  const root = await realpath(repositoryRoot);
  async function source(path: string): Promise<{ text: string; hash: string }> {
    if (!allowed.has(path)) throw new Error('Source path is not allowlisted');
    const absolute = resolve(root, path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(absolute) !== absolute || info.size > 256_000) throw new Error(`Unsafe catalogue source: ${path}`);
    const bytes = await readFile(absolute);
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), hash: sha256(bytes) };
  }
  const manifestSource = await source(TEAM_MARKET_MANIFEST_PATH);
  const manifest = record(JSON.parse(manifestSource.text));
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported source catalogue version');
  const manifestTeams = array(manifest.teams).map(record);
  if (manifestTeams.length !== TEAMS.length) throw new Error('Team inventory changed; review the source allowlist');
  const agents: TeamMarketAgent[] = [];
  for (const spec of TEAMS) {
    const candidates = manifestTeams.filter(team => team.path === spec.path);
    if (candidates.length !== 1) throw new Error('Team inventory does not match the allowlist');
    const team = candidates[0];
    const declaredSlugs = array(team.agentSlugs).map(string).sort();
    if (JSON.stringify(declaredSlugs) !== JSON.stringify([...spec.slugs].sort())) throw new Error('Role inventory changed; review the source allowlist');
    const files = array(team.files).map(record);
    async function verified(relative: string): Promise<{ text: string; hash: string }> {
      const declarations = files.filter(file => file.path === relative);
      if (declarations.length !== 1) throw new Error('Role file is missing or duplicated in the source manifest');
      const value = await source(`${ROOT}/${spec.path}/${relative}`);
      if (value.hash !== declarations[0].sha256 || Buffer.byteLength(value.text) !== declarations[0].sizeBytes) throw new Error('Source digest mismatch; rebuild and review the source catalogue first');
      return value;
    }
    const teamFile = await verified('TEAM.md');
    const requirements = array(team.requiredSkills).map(record);
    for (const slug of spec.slugs) {
      const path = `${ROOT}/${spec.path}/agents/${slug}/AGENTS.md`;
      const original = await verified(`agents/${slug}/AGENTS.md`);
      const metadata = parseTeamMarketRole(original.text);
      if (metadata.slug !== slug) throw new Error('Role slug does not match its allowlisted source');
      const requiredSkills = requirements.filter(skill => array(skill.agentSlugs).includes(slug)).map(skill => string(skill.ref)).sort();
      if (JSON.stringify(requiredSkills) !== JSON.stringify([...metadata.skills].sort())) throw new Error('Role skills disagree with the source manifest');
      agents.push({ id: `${string(team.id)}:${slug}`, name: metadata.name, role: metadata.role,
        description: metadata.title, instructions: original.text,
        source: { path, sha256: original.hash, teamId: string(team.id), teamName: string(team.name),
          teamPath: `${ROOT}/${spec.path}/TEAM.md`, teamSha256: teamFile.hash }, requiredSkills, skillsInstalled: false });
    }
  }
  if (agents.length !== 8 || new Set(agents.map(agent => agent.id)).size !== 8) throw new Error('Expected eight distinct team-market roles');
  return { schemaVersion: 1, source: { path: TEAM_MARKET_MANIFEST_PATH, sha256: manifestSource.hash,
    packageName: string(manifest.packageName), packageVersion: string(manifest.packageVersion) }, agents };
}

export function serializeTeamMarketCatalog(catalog: TeamMarketCatalog): string { return `${JSON.stringify(catalog, null, 2)}\n`; }

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const generated = serializeTeamMarketCatalog(await buildTeamMarketCatalog(root));
  const target = resolve(root, TEAM_MARKET_ARTIFACT_PATH);
  if (process.argv.slice(2).includes('--check')) {
    if (await readFile(target, 'utf8') !== generated) throw new Error('Team-market artifact is stale; run scripts/export-awwo-team-market.ts');
    process.stdout.write('Team-market catalogue verified: 8 roles.\n');
  } else {
    await writeFile(target, generated);
    process.stdout.write('Team-market catalogue generated: 8 roles.\n');
  }
}
