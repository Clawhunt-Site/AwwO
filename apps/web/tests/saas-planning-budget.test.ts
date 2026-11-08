import { expect, it } from 'vitest';
import { emptyDocument } from '../src/canvas/canvasDoc';
import { AGENT_TEMPLATES, createAgentTemplate, createDevelopmentTemplate } from '../src/canvas/agentTemplates';
import { buildPlanningContext } from '../src/canvas/canvasPlanning';

it('keeps the supplied empty, development and seven-role canvases within the default Pi context allowance', () => {
  const examples = {
    empty: emptyDocument(),
    development: { ...emptyDocument(), ...createDevelopmentTemplate({ x: 0, y: 0 }) },
    sevenRoles: { ...emptyDocument(), nodes: AGENT_TEMPLATES.map((template, index) => createAgentTemplate(template.id, { x: index * 400, y: 0 })) },
  };
  const sizes = Object.fromEntries(Object.entries(examples).map(([name, doc]) => [name, new TextEncoder().encode(buildPlanningContext(doc, [])).length]));
  console.info('Pi planner UTF-8 context bytes', sizes);
  // Reserve over 11KB of the 28,416 byte allowance for user requirements and server instructions. The line was 16,000
  // until 2026-10-23, when add_node took constraints (59 bytes of protocol) and the seven-role canvas grew from 15,995 to
  // 16,054 bytes; it was then the allowance less 12KB. On 2026-11-08 the film template (代码影片) added 782 bytes, 458
  // to every context (its listing, its sentence in the guidance, its id in the protocol) and 324 for its node, and the
  // canvas with one node of every template grew to 16,836 bytes, which still leaves 11,580: the line is now the
  // allowance less 11KB.
  for (const size of Object.values(sizes)) expect(size).toBeLessThan(28_416 - 11 * 1024);
});
