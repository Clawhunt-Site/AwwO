// What a node's skills come to in its runs' system prompt. The API refuses a run whose system prompt passes its limit
// (32,768 UTF-16 units, the workers' own) as context_limit, and never leaves out a skill a member attached to make room
// (skills.go plannerSkills). A node's skills can stay under their byte limit and still take it past that line: a film
// node (代码影片) carries the film kit's guide, about 15,000 units, and with film-looks, film-sound and motion-language
// every run of it was refused (2026-11-09). So the skill picker (NodeSkillsEditor.tsx) counts what a run sends: the
// node's own text (canvasPlan.ts nodePromptUnits), each skill's units and the most a run of a node run by one agent
// adds beside them, both from the API's skill list (skill_fit.go), and refuses a skill that would take the node past
// the line. A team node's member turns are framed apart and get no count (nodePromptSize).
import type { SkillCatalog, SkillPromptKind } from '../saas/skillsApi';
import type { ContractFieldType } from './nodeContracts';

/** What the picker needs of a node: its own text's units, the kind of its outputs and whether it has task requirements. */
export interface NodePromptSize { ownUnits: number; kind: SkillPromptKind; taskFrame: boolean }

/** The kind of a node's outputs as the API's output policy tells them apart (skill_fit.go skillPromptKind). */
export function skillPromptKind(outputs: readonly { type: ContractFieldType }[] | undefined): SkillPromptKind {
  if (!outputs?.length) return 'none';
  const html = outputs.some(field => field.type === 'html');
  const file = outputs.some(field => field.type === 'file');
  return html && file ? 'htmlFile' : html ? 'html' : file ? 'file' : 'text';
}

/** The UTF-16 units a node's runs would send with these skills, and the most they may; null where the skill list has no
 *  such numbers (an older API) or the node has no skills. A skill the list lacks counts nothing: it stops the run
 *  anyway until it is taken off. */
export function skillPromptUnits(size: NodePromptSize, catalog: SkillCatalog | null, refs: readonly string[]): { used: number; max: number } | null {
  const room = catalog?.promptUnits;
  if (!room || refs.length === 0) return null;
  let used = size.ownUnits + room.notes[size.kind] + (size.taskFrame ? room.taskFrame : 0);
  for (const ref of refs) {
    const skill = catalog.items.find(item => item.ref === ref);
    used += skill ? skill.units ?? skill.bytes : 0;
  }
  return { used, max: room.max };
}
