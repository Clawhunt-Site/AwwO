import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildSkillLicences, frontmatter, OUTPUT, readSkillAttributions, REPO_ROOT, SOURCES, skillsBySource } from './build-skill-licences.mjs';

test('the committed skill licence file is what the builder writes', () => {
  assert.equal(fs.readFileSync(path.join(REPO_ROOT, OUTPUT), 'utf8'), buildSkillLicences());
});

test('every adapted built-in skill is covered by a source, and every source by a skill', () => {
  const skills = readSkillAttributions();
  const groups = skillsBySource(skills);
  const covered = new Set([...groups.values()].flat());
  for (const skill of skills) assert.equal(covered.has(skill.name), skill.attribution !== '', skill.name);
  assert.deepEqual(groups.get(SOURCES.find(source => source.name.startsWith('claude-mem'))), ['critic']);
  assert.deepEqual(groups.get(SOURCES.find(source => source.name.startsWith('Berd'))), ['critic']);
});

test('an attribution that credits an unknown source, even beside a known one, or a source no skill credits, is refused', () => {
  const known = readSkillAttributions();
  const critic = known.find(skill => skill.name === 'critic');
  assert.throws(() => skillsBySource([{ name: 'odd', attribution: 'Adapted from somewhere else (MIT)' }]), /odd: "Adapted from somewhere else \(MIT\)" credits no source/);
  const mixed = known.map(skill => skill === critic
    ? { ...skill, attribution: skill.attribution.replace('; modified for AwwO', '; fetch rules adapted from Agent-Reach (MIT, Copyright (c) 2025 Agent Eyes); modified for AwwO') }
    : skill);
  assert.notEqual(mixed.find(skill => skill.name === 'critic').attribution, critic.attribution);
  assert.throws(() => skillsBySource(mixed), /critic: "fetch rules adapted from Agent-Reach .*" credits no source/);
  assert.throws(() => skillsBySource([{ name: 'critic', attribution: 'Adapted from Berd (Apache-2.0); modified for AwwO' }]), /no built-in skill credits this source/);
  assert.doesNotThrow(() => skillsBySource(known));
});

test('frontmatter is read the way the API reads it', () => {
  const meta = frontmatter('\uFEFF---\r\nname: x\r\nattribution : "From wshobson/agents@7257c27 (MIT)"\r\n  attribution: indented\r\n---\r\nBody\r\n');
  assert.equal(meta.name, 'x');
  assert.equal(meta.attribution, 'From wshobson/agents@7257c27 (MIT)');
  assert.throws(() => frontmatter('name: x\n'), /no frontmatter/);
  assert.throws(() => frontmatter('---\nname: x\n'), /not closed/);
});

test('the licence file carries each source license verbatim', () => {
  const text = buildSkillLicences();
  for (const source of SOURCES) {
    for (const file of source.files) {
      const license = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').replace(/\r\n?/g, '\n').trimEnd();
      assert.ok(text.includes(license), `${file} is missing`);
    }
  }
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n') && !text.includes('\r'));
});
