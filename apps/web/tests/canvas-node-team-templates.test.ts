import { describe, expect, it } from 'vitest';
import { createNodeTeam, nodeTeamTurnEstimate, validateNodeTeam, type NodeTeam } from '../src/canvas/nodeTeam';
import { NODE_TEAM_MAX_CALLS, NODE_TEAM_TEMPLATE_IDS, buildNodeTeam, createNodeTeamFromTemplate, isNodeTeamTemplateId, nodeTeamFittingRounds, nodeTeamTemplate, nodeTeamTemplates, nodeTeamTimeoutFor } from '../src/canvas/nodeTeamTemplates';

const locales = ['zh', 'en'] as const;
const every = nodeTeamTemplates().flatMap(template => locales.map(locale => [template.id, locale] as const));

describe('node team templates', () => {
  it('offers exactly the closed id set, each once, with the same members in both languages', () => {
    expect(nodeTeamTemplates().map(template => template.id)).toEqual([...NODE_TEAM_TEMPLATE_IDS]);
    for (const template of nodeTeamTemplates()) {
      expect(template.zh.members).toHaveLength(template.en.members.length);
      for (const locale of locales) {
        expect(template[locale].title.trim()).not.toBe('');
        expect(template[locale].summary.trim()).not.toBe('');
        expect(new Set(template[locale].members.map(member => member.name)).size).toBe(template[locale].members.length);
      }
    }
    expect(isNodeTeamTemplateId('draft-review')).toBe(true);
    expect(isNodeTeamTemplateId('constructor')).toBe(false);
    expect(nodeTeamTemplate('missing')).toBeUndefined();
  });

  it.each(every)('%s (%s) builds a valid team that inherits the node model and chooses no runtime or tool', (id, locale) => {
    const team = createNodeTeamFromTemplate(nodeTeamTemplate(id)!, { runtime: 'pi' }, locale);
    expect(validateNodeTeam(team, undefined, locale)).toEqual([]);
    expect(new Set(team.members.map(member => member.id)).size).toBe(team.members.length);
    for (const member of team.members) {
      expect(member).toMatchObject({ runtime: '', model: '', context: 'shared', tools: [] });
      expect(member).not.toHaveProperty('effort');
      expect(member.instructions.split('\n')).toHaveLength(3);
      expect(member.instructions).toMatch(locale === 'zh' ? /^负责：.+\n不负责：.+\n完成标准：.+$/ : /^Does: .+\nDoes not: .+\nDone when: .+$/);
    }
    // The planned calls fit, so the editor never warns that the limit stops the team early.
    expect(team.maxTurns).toBeGreaterThanOrEqual(nodeTeamTurnEstimate(team));
    expect(team.timeoutSeconds).toBe(Math.min(1800, Math.max(300, 180 * nodeTeamTurnEstimate(team))));
  });

  it('runs where its node runs, so its members inherit the node’s model there, as the default team does', () => {
    const template = nodeTeamTemplate('draft-review')!;
    expect(createNodeTeamFromTemplate(template, { runtime: 'pi' }, 'en').runtime).toBe('pi');
    expect(createNodeTeamFromTemplate(template, { runtime: 'openai-agents' }, 'en').runtime).toBe('openai-agents');
    // A node without a runtime runs where the API resolves it (runtime_workers.go defaultRuntime), and so does its team.
    expect(createNodeTeamFromTemplate(template, { runtime: '' }, 'en').runtime).toBe('openai-agents');
    expect(createNodeTeamFromTemplate(template, { runtime: 'sandbox' }, 'en').runtime).toBe('openai-agents');
    for (const runtime of ['', 'pi', 'openai-agents']) {
      expect(createNodeTeamFromTemplate(template, { runtime }, 'en').runtime).toBe(createNodeTeam({ title: '', persona: '', model: '', runtime }).runtime);
    }
    // A replaced team goes where its node runs too, unless a member it keeps is set up its own way (sub-agent review
    // 2026-10-25: a team left on Pi by the old default gave every new member Pi's default model, not the node's).
    const before = createNodeTeamFromTemplate(template, { runtime: 'pi' }, 'en');
    expect(createNodeTeamFromTemplate(nodeTeamTemplate('research-panel')!, { runtime: '' }, 'en', before).runtime).toBe('openai-agents');
    const own = { ...before, members: [{ ...before.members[0], model: 'pi-model' }, before.members[1]] };
    expect(createNodeTeamFromTemplate(template, { runtime: '' }, 'en', own).runtime).toBe('pi');
  });

  it('gives every planned call its time one after another, as members also queue for the workspace’s free slots', () => {
    const members = (count: number) => Array.from({ length: count }, () => ({}));
    expect(nodeTeamTimeoutFor({ mode: 'sequential', maxRounds: 1, members: members(1) })).toBe(300);
    // A parallel panel of four on a workspace that runs one call at a time still finishes inside its deadline.
    expect(nodeTeamTimeoutFor({ mode: 'parallel', maxRounds: 1, members: members(4) })).toBe(720);
    expect(nodeTeamTimeoutFor({ mode: 'debate', maxRounds: 2, members: members(3) })).toBe(1260);
    expect(nodeTeamTimeoutFor({ mode: 'debate', maxRounds: 8, members: members(8) })).toBe(1800);
  });

  it('cuts a debate’s or a review’s rounds to what the call limit lets it finish', () => {
    expect(nodeTeamFittingRounds('debate', 8, 8)).toBe(7);
    expect(8 * nodeTeamFittingRounds('debate', 8, 8) + 1).toBeLessThanOrEqual(NODE_TEAM_MAX_CALLS);
    expect(nodeTeamFittingRounds('review', 8, 8)).toBe(8);
    expect(nodeTeamFittingRounds('debate', 3, 2)).toBe(2);
    expect(nodeTeamFittingRounds('parallel', 8, 8)).toBe(8);
    const debate = buildNodeTeam({ mode: 'debate', maxRounds: 8, members: Array.from({ length: 8 }, (_, index) => ({ name: `M${index}`, role: 'r', instructions: '' })) }, { runtime: 'pi' });
    expect(debate).toMatchObject({ maxRounds: 7, maxTurns: 57 });
    expect(nodeTeamTurnEstimate(debate)).toBeLessThanOrEqual(debate.maxTurns);
    expect(validateNodeTeam(debate)).toEqual([]);
  });
});

describe('replacing a node team', () => {
  const previous = (): NodeTeam => {
    const team = createNodeTeam({ title: 'Research', persona: '', model: '', runtime: 'openai-agents' }, 'en');
    return { ...team, maxTurns: 20, timeoutSeconds: 900, members: [
      { ...team.members[0], name: 'Writer', model: 'own-model', effort: 'high', context: 'task', tools: ['calculator'] },
      { ...team.members[1], name: 'Old reviewer', model: 'other-model' },
    ] };
  };

  it('keeps a same-name member’s id and own settings, takes its new brief and drops the others', () => {
    const before = previous();
    const team = createNodeTeamFromTemplate(nodeTeamTemplate('draft-review')!, { runtime: 'pi' }, 'en', before);
    const writer = team.members.find(member => member.name === 'Writer')!;
    expect(writer).toMatchObject({ id: before.members[0].id, model: 'own-model', effort: 'high', context: 'task', tools: ['calculator'],
      role: nodeTeamTemplate('draft-review')!.en.members[0].role, instructions: nodeTeamTemplate('draft-review')!.en.members[0].instructions });
    expect(writer.tools).not.toBe(before.members[0].tools);
    expect(team.members.map(member => member.name)).toEqual(['Writer', 'Reviewer']);
    expect(team.members[1].id).not.toBe(before.members[1].id);
    expect(team.members[1]).toMatchObject({ model: '', runtime: '' });
  });

  it('keeps the team limits, raising one only where the new team needs more, and its runtime only for a member it keeps', () => {
    const before = previous();
    const fresh = buildNodeTeam({ mode: 'review', maxRounds: 2, members: [{ name: 'A', role: 'r', instructions: '' }, { name: 'B', role: 'r', instructions: '' }] }, { runtime: 'pi' }, before);
    expect(fresh).toMatchObject({ runtime: 'pi', maxTurns: 20, timeoutSeconds: 900 });
    // The kept Writer has a model and a tool of OpenAI Agents', so the team stays there.
    const kept = buildNodeTeam({ mode: 'review', maxRounds: 2, members: [{ name: 'Writer', role: 'r', instructions: '' }, { name: 'B', role: 'r', instructions: '' }] }, { runtime: 'pi' }, before);
    expect(kept).toMatchObject({ runtime: 'openai-agents', maxTurns: 20, timeoutSeconds: 900 });
    expect(validateNodeTeam(kept)).toEqual([]);
    const raised = buildNodeTeam({ mode: 'debate', maxRounds: 8, members: Array.from({ length: 8 }, (_, index) => ({ name: `M${index}`, role: 'r', instructions: '' })) }, { runtime: 'pi' }, before);
    expect(raised).toMatchObject({ maxRounds: 7, maxTurns: 57, timeoutSeconds: 1800 });
    expect(validateNodeTeam(raised)).toEqual([]);
  });

  // Sub-agent review 2026-10-25: a team made in one language lost its members' settings when the template was applied
  // in the other, its names no longer matching.
  it('keeps a member’s settings when the template is applied in the other language, under the new name', () => {
    for (const template of nodeTeamTemplates()) expect(template.zh.members.length).toBe(template.en.members.length);
    const template = nodeTeamTemplate('draft-review')!;
    const zh = createNodeTeamFromTemplate(template, { runtime: 'openai-agents' }, 'zh');
    const own = { ...zh, members: [{ ...zh.members[0], model: 'own-model' }, zh.members[1]] };
    const en = createNodeTeamFromTemplate(template, { runtime: 'openai-agents' }, 'en', own);
    expect(en.members.map(member => [member.id, member.name, member.model])).toEqual([[zh.members[0].id, 'Writer', 'own-model'], [zh.members[1].id, 'Reviewer', '']]);
    // A plan's own members match by their names alone.
    const written = buildNodeTeam({ mode: 'sequential', maxRounds: 2, members: [{ name: 'Writer', role: 'r', instructions: '' }] }, { runtime: 'openai-agents' }, own);
    expect(written.members[0].id).not.toBe(zh.members[0].id);
  });

  it('matches a member by its trimmed name, as a plan writes it back', () => {
    const before = previous();
    const spaced = { ...before, members: [{ ...before.members[0], name: ' Writer ' }, before.members[1]] };
    const team = buildNodeTeam({ mode: 'sequential', maxRounds: 2, members: [{ name: 'Writer', role: 'r', instructions: '' }] }, { runtime: 'pi' }, spaced);
    expect(team.members[0]).toMatchObject({ id: before.members[0].id, model: 'own-model', effort: 'high', context: 'task', tools: ['calculator'] });
  });

  it('lets one previous member answer for one new member only', () => {
    const before = previous();
    const twice = { ...before, members: [before.members[0], { ...before.members[1], name: 'Writer', model: 'second-writer' }] };
    const team = buildNodeTeam({ mode: 'sequential', maxRounds: 2, members: [{ name: 'Writer', role: 'r', instructions: '' }] }, { runtime: 'pi' }, twice);
    expect(team.members).toHaveLength(1);
    expect(team.members[0]).toMatchObject({ id: before.members[0].id, model: 'own-model' });
  });
});
