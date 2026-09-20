// @vitest-environment node
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createMarketplaceRoleNode, getTeamMarketAgents, teamMarketRuntimeNotice } from '../src/canvas/teamMarketAgents';
import { sanitizeDocument, emptyDocument } from '../src/canvas/canvasDoc';
import { buildTeamMarketCatalog, parseTeamMarketRole, serializeTeamMarketCatalog, TEAM_MARKET_ARTIFACT_PATH, TEAM_MARKET_MANIFEST_PATH, TEAM_MARKET_SOURCE_PATHS } from '../../../scripts/export-awwo-team-market';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'awwo-team-market-test-'));
  fixtures.push(directory);
  for (const path of TEAM_MARKET_SOURCE_PATHS) {
    await mkdir(dirname(resolve(directory, path)), { recursive: true });
    await cp(resolve(root, path), resolve(directory, path));
  }
  return directory;
}

describe('repository team market role export', () => {
  it('exports all eight distinct roles from the current manifest with exact source text and digests', async () => {
    const generated = await buildTeamMarketCatalog(root);
    expect(generated.agents).toHaveLength(8);
    expect(new Set(generated.agents.map(agent => agent.id)).size).toBe(8);
    expect(new Set(generated.agents.map(agent => agent.source.teamId)).size).toBe(4);
    expect(generated.agents.filter(agent => agent.name === 'CTO')).toHaveLength(2);
    expect(generated.agents.filter(agent => agent.name === 'QA')).toHaveLength(2);
    expect(serializeTeamMarketCatalog(generated)).toBe(await readFile(resolve(root, TEAM_MARKET_ARTIFACT_PATH), 'utf8'));
    for (const agent of generated.agents) {
      const original = await readFile(resolve(root, agent.source.path));
      expect(agent.instructions).toBe(original.toString('utf8'));
      expect(agent.source.sha256).toBe(createHash('sha256').update(original).digest('hex'));
      expect(agent.requiredSkills.length).toBeGreaterThan(0);
      expect(agent.skillsInstalled).toBe(false);
    }
  });

  it('reads only the explicit manifest and role/team Markdown allowlist; private or skill files never enter the artifact', async () => {
    expect(TEAM_MARKET_SOURCE_PATHS).toHaveLength(13);
    expect(TEAM_MARKET_SOURCE_PATHS.filter(path => path.endsWith('/AGENTS.md'))).toHaveLength(8);
    expect(TEAM_MARKET_SOURCE_PATHS.filter(path => path.endsWith('/TEAM.md'))).toHaveLength(4);
    expect(TEAM_MARKET_SOURCE_PATHS.every(path => path === TEAM_MARKET_MANIFEST_PATH || /\/(?:TEAM|AGENTS)\.md$/.test(path))).toBe(true);
    const directory = await fixture();
    const manifestPath = resolve(directory, TEAM_MARKET_MANIFEST_PATH);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.apiKey = 'private-sentinel-must-not-project';
    manifest.teams[0].files.push({ path: '../../../../../.env', kind: 'agent', sha256: 'not-read', sizeBytes: 1 });
    manifest.teams[0].secretValues = { token: 'private-sentinel-must-not-project' };
    // These non-allowlisted paths deliberately do not exist. A manifest-directed reader fails here.
    await writeFile(manifestPath, JSON.stringify(manifest));
    const output = await buildTeamMarketCatalog(directory);
    expect(output.agents).toHaveLength(8);
    expect(JSON.stringify(output)).not.toContain('private-sentinel');
    expect(JSON.stringify(output)).not.toContain('secretValues');
    expect(JSON.stringify(output)).not.toContain('apiKey');
  });

  it('rejects modified source bytes instead of silently publishing unreviewed role text', async () => {
    const directory = await fixture();
    const path = resolve(directory, getTeamMarketAgents()[0].source.path);
    await writeFile(path, `${await readFile(path, 'utf8')}\nUnexpected source change\n`);
    await expect(buildTeamMarketCatalog(directory)).rejects.toThrow('Source digest mismatch');
  });

  it('rejects symlinked role sources, even when they contain valid role text', async () => {
    const directory = await fixture();
    const path = resolve(directory, getTeamMarketAgents()[0].source.path);
    const renamed = resolve(directory, 'role-copy.md');
    await cp(path, renamed); await rm(path); await symlink(renamed, path);
    await expect(buildTeamMarketCatalog(directory)).rejects.toThrow('Unsafe catalogue source');
  });

  it('requires review when inventory changes and rejects unexpected frontmatter fields', async () => {
    const directory = await fixture();
    const path = resolve(directory, TEAM_MARKET_MANIFEST_PATH);
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.teams[0].agentSlugs.push('unreviewed-role');
    await writeFile(path, JSON.stringify(manifest));
    await expect(buildTeamMarketCatalog(directory)).rejects.toThrow('Role inventory changed');
    expect(() => parseTeamMarketRole(getTeamMarketAgents()[0].instructions.replace('name: CEO', 'name: CEO\napiKey: private-placeholder'))).toThrow('Unexpected or duplicate');
  });
});

describe('AwwO role draft creation', () => {
  it.each(['zh', 'en'] as const)('preserves each original role behind an explicit capability boundary in %s', locale => {
    const roles = getTeamMarketAgents();
    const ids = new Set<string>();
    for (const role of roles) {
      const node = createMarketplaceRoleNode(role, { x: 12, y: 34 }, locale);
      ids.add(node.id);
      expect(node.binding).toBeNull(); expect(node.issueId).toBeNull();
      expect(node.agentRef).toBeUndefined(); expect(node.team).toBeUndefined();
      expect(node.runtime).toBe(''); expect(node.model).toBe('');
      expect(node.persona).toContain('You are running a role in the current AwwO canvas');
      expect(node.persona).toContain('does not install its skills');
      expect(node.persona).toContain('without inventing execution evidence');
      expect(node.persona).toContain(role.instructions);
      expect(node.persona).toContain(role.source.path);
      expect(node.persona).toContain(role.source.sha256);
      expect(Buffer.byteLength(node.persona)).toBeLessThanOrEqual(32_000);
      const reloaded = sanitizeDocument({ ...emptyDocument(), nodes: [node] }).nodes[0];
      expect(reloaded).toMatchObject({ persona: node.persona, binding: null, issueId: null });
    }
    expect(ids.size).toBe(8);
    expect(teamMarketRuntimeNotice(locale)).toContain(locale === 'zh' ? '未安装' : 'not installed');
  });

  it('uses the canonical role instead of caller-injected instructions and refuses unknown role ids', () => {
    const role = getTeamMarketAgents()[0];
    expect(createMarketplaceRoleNode({ ...role, instructions: 'untrusted-override' }, { x: 0, y: 0 }).persona).not.toContain('untrusted-override');
    expect(() => createMarketplaceRoleNode({ ...role, id: 'unknown' }, { x: 0, y: 0 })).toThrow('Unknown team market role');
  });
});
