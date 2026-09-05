// Pure derivation for the composer `@` menu's native-skill suggestions.
//
// A picked skill inserts a plain `@skill:<slug>` TEXT token — the kernel parses
// @skill from the message into an explicit overlay (no context_ref channel), so the
// Web picker is pure surface discovery over the SAME contract the CLI uses. Kept in
// its own module so the filtering/token rules are unit-tested without loading App.tsx.

export type ComposerSkill = { slug: string; name: string; description: string };

export type SkillSuggestion = {
  id: string;
  kind: 'skill';
  token: string;
  label: string;
  description: string;
};

// Cap so a large skill store cannot flood the `@` menu (mirrors the context-ref cap).
const MAX_SKILL_SUGGESTIONS = 12;

export function skillComposerSuggestions(skills: ComposerSkill[], query: string): SkillSuggestion[] {
  // The composer trigger strips the leading `@`, so as the user types `@skill:rel`
  // the query is `skill:rel`. Include the full `@skill:<slug>` token in the haystack
  // (and tolerate a leading `@`) so typing the token keeps matching instead of going
  // empty.
  const needle = query.trim().toLowerCase().replace(/^@/, '');
  return skills
    .filter((s) =>
      `@skill:${s.slug} skill ${s.slug} ${s.name} ${s.description}`.toLowerCase().includes(needle),
    )
    .slice(0, MAX_SKILL_SUGGESTIONS)
    .map((s) => ({
      id: `skill:${s.slug}`,
      kind: 'skill' as const,
      token: `@skill:${s.slug}`,
      label: s.name,
      description: s.description ? `@skill:${s.slug} — ${s.description}` : `@skill:${s.slug}`,
    }));
}
