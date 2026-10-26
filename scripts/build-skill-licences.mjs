#!/usr/bin/env node
// Builds apps/web/src/saas/skillLicences.txt, the license texts of the projects that AwwO's built-in skills adapt
// text from. The skill library links it beside each adapted skill's source line: the API sends skill text to the
// browser, and MIT and Apache-2.0 ask for the license to travel with copies of the text (THIRD_PARTY_NOTICES.md).
//
// An attribution is a list of clauses separated by ";". Each clause either credits exactly one source below (its
// `match`) or is one of the plain clauses ("modified for AwwO", "trimmed for AwwO", "author <name>"), so a skill
// that credits a source missing here fails, even beside a known one. Every source must also be credited by a
// skill, so adding or removing an adapted skill fails --check until this file is regenerated.
//
// Usage: node scripts/build-skill-licences.mjs [--check]
//   no flag   write the file
//   --check   exit 1 if the committed file differs from what this script would write

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = 'apps/web/src/saas/skillLicences.txt';
export const SKILLS_DIR = 'backend/internal/app/skills';

export const SOURCES = Object.freeze([
  { name: 'wshobson/agents', match: /^From wshobson\/agents@/, files: ['third_party/wshobson-agents/LICENSE'],
    note: 'Two of these skills are contributions their plugins declare MIT: before-you-build (bin1874) and ai-debt-detector (Adit Jain).' },
  { name: 'AIHOT (Boxpo/AIHOT, a mirror of KKKKhazix/AIHOT)', match: /\bAIHOT\b/,
    files: ['third_party/adapted/aihot/LICENSE', 'third_party/adapted/aihot/NOTICE'] },
  { name: 'video-shotcraft (Vincentwei1021/video-shotcraft)', match: /\bvideo-shotcraft\b/,
    files: ['third_party/adapted/video-shotcraft/LICENSE'] },
  { name: 'claude-mem (thedotmack/claude-mem)', match: /\bclaude-mem\b/,
    files: ['third_party/adapted/claude-mem/NOTICE', 'third_party/adapted/claude-mem/LICENSE'] },
  { name: 'Berd (block/berd)', match: /\bBerd\b/, files: ['third_party/adapted/berd/LICENSE'] },
  { name: 'Pi coding agent (earendil-works/pi)', match: /\bPi coding agent\b/, files: ['third_party/clawwork/LICENSE'] },
  { name: 'open-design (nexu-io/open-design)', match: /\bopen-design\b/, files: ['third_party/adapted/open-design/LICENSE'] },
  { name: 'refero_skill (referodesign/refero_skill)', match: /\brefero_skill\b/, files: ['third_party/adapted/refero-skill/LICENSE'],
    note: 'open-design adapted its typography, colour and anti-template rules from this project; AwwO adapts them from open-design.' },
]);

const PLAIN_CLAUSES = Object.freeze([/^modified for AwwO$/, /^trimmed for AwwO$/, /^author \S.*$/]);
const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);

/** Reads frontmatter the way the API does (skills.go parseSkillMarkdown): key before the first colon, trimmed. */
export function frontmatter(raw, file = 'skill') {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) throw new Error(`${file}: no frontmatter`);
  const end = text.indexOf('\n---', 4);
  if (end < 0) throw new Error(`${file}: the frontmatter is not closed`);
  const meta = {};
  for (const line of text.slice(4, end).split('\n')) {
    const colon = line.indexOf(':');
    if (!line.trim() || /^[ \t]/.test(line) || colon < 0) continue;
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^["']+|["']+$/g, '');
  }
  return meta;
}

/** Reads every built-in skill's name and attribution. */
export function readSkillAttributions(root = REPO_ROOT) {
  const dir = path.join(root, SKILLS_DIR);
  return fs.readdirSync(dir).filter(name => name.endsWith('.md') && name !== 'README.md').sort().map(file => ({
    name: file.slice(0, -3), attribution: frontmatter(fs.readFileSync(path.join(dir, file), 'utf8'), file).attribution ?? '',
  }));
}

/** Groups the adapted skills by source; throws for a clause that credits no known source, or a source no skill uses. */
export function skillsBySource(skills, sources = SOURCES) {
  const groups = new Map(sources.map(source => [source, []]));
  for (const skill of skills) {
    for (const clause of skill.attribution.split(';').map(part => part.trim()).filter(Boolean)) {
      if (PLAIN_CLAUSES.some(plain => plain.test(clause))) continue;
      const matched = sources.filter(source => source.match.test(clause));
      if (matched.length !== 1) {
        throw new Error(`${skill.name}: "${clause}" credits ${matched.length ? 'more than one source' : 'no source'} in scripts/build-skill-licences.mjs`);
      }
      if (!groups.get(matched[0]).includes(skill.name)) groups.get(matched[0]).push(skill.name);
    }
  }
  for (const [source, names] of groups) {
    if (!names.length) throw new Error(`${source.name}: no built-in skill credits this source any more; remove it`);
  }
  return groups;
}

function licenseText(root, file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  return text.endsWith('\n') ? text : `${text}\n`;
}

export function buildSkillLicences(root = REPO_ROOT) {
  const groups = skillsBySource(readSkillAttributions(root));
  const parts = [
    "Licenses for text in AwwO's built-in skills",
    '',
    'Some of the built-in skills adapt text from the projects below. Each skill names its source in its',
    '"Source" line in the skill library; the full license of each source follows.',
    '',
    'Generated by scripts/build-skill-licences.mjs; do not edit by hand.',
    '',
  ];
  for (const [source, names] of groups) {
    parts.push(RULE, source.name, `Skills: ${names.join(', ')}`);
    if (source.note) parts.push(source.note);
    for (const file of source.files) parts.push(THIN, licenseText(root, file).trimEnd());
    parts.push('');
  }
  return `${parts.join('\n').replace(/\n+$/, '')}\n`;
}

function main(argv) {
  const target = path.join(REPO_ROOT, OUTPUT);
  const text = buildSkillLicences();
  if (argv.includes('--check')) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (current !== text) {
      console.error(`${OUTPUT} is out of date; run node scripts/build-skill-licences.mjs`);
      return 1;
    }
    console.log(`${OUTPUT} is up to date (${text.length} characters).`);
    return 0;
  }
  fs.writeFileSync(target, text);
  console.log(`wrote ${OUTPUT} (${text.length} characters)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
