import { describe, expect, it } from 'vitest';

import { skillComposerSuggestions } from '../src/composerSkills';

const SKILLS = [
  { slug: 'changelog-summarizer', name: 'Changelog Summarizer', description: 'Summarize a git diff.' },
  { slug: 'release-notes', name: 'Release Notes', description: 'Draft release notes.' },
  { slug: 'no-desc', name: 'No Desc', description: '' },
];

describe('skillComposerSuggestions', () => {
  it('inserts a @skill:<slug> text token (the kernel-parsed contract, not a context ref)', () => {
    const [first] = skillComposerSuggestions(SKILLS, '');
    expect(first.kind).toBe('skill');
    expect(first.token).toBe('@skill:changelog-summarizer');
    expect(first.label).toBe('Changelog Summarizer');
    expect(first.id).toBe('skill:changelog-summarizer');
  });

  it('filters by slug / name / description (case-insensitive)', () => {
    expect(skillComposerSuggestions(SKILLS, 'release').map((s) => s.token)).toEqual(['@skill:release-notes']);
    expect(skillComposerSuggestions(SKILLS, 'GIT DIFF').map((s) => s.token)).toEqual([
      '@skill:changelog-summarizer',
    ]);
    expect(skillComposerSuggestions(SKILLS, 'changelog-sum').map((s) => s.token)).toEqual([
      '@skill:changelog-summarizer',
    ]);
  });

  it('empty query lists all available skills (existing + just-created)', () => {
    expect(skillComposerSuggestions(SKILLS, '').map((s) => s.token)).toEqual([
      '@skill:changelog-summarizer',
      '@skill:release-notes',
      '@skill:no-desc',
    ]);
  });

  it('description blends the token; a skill without a description still shows the token', () => {
    const byToken = Object.fromEntries(skillComposerSuggestions(SKILLS, '').map((s) => [s.token, s.description]));
    expect(byToken['@skill:changelog-summarizer']).toBe('@skill:changelog-summarizer — Summarize a git diff.');
    expect(byToken['@skill:no-desc']).toBe('@skill:no-desc');
  });

  it('caps the list so a large store cannot flood the @ menu', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      slug: `s-${i}`,
      name: `Skill ${i}`,
      description: 'd',
    }));
    expect(skillComposerSuggestions(many, '').length).toBe(12);
  });

  it('no match → empty', () => {
    expect(skillComposerSuggestions(SKILLS, 'zzz-nope')).toEqual([]);
  });

  it('keeps matching as the user types the token (query becomes "skill:..." after @)', () => {
    // The composer trigger strips the leading @, so typing `@skill:rel` yields query
    // `skill:rel` — this must still match (Codex-found regression).
    expect(skillComposerSuggestions(SKILLS, 'skill:rel').map((s) => s.token)).toEqual([
      '@skill:release-notes',
    ]);
    expect(skillComposerSuggestions(SKILLS, 'skill:').map((s) => s.token)).toEqual([
      '@skill:changelog-summarizer',
      '@skill:release-notes',
      '@skill:no-desc',
    ]);
    expect(skillComposerSuggestions(SKILLS, '@skill:changelog').map((s) => s.token)).toEqual([
      '@skill:changelog-summarizer',
    ]);
  });
});
