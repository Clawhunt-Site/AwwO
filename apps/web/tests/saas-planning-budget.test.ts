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
  // Reserve over 12KB of the 28,416 byte allowance for user requirements and server instructions.
  for (const size of Object.values(sizes)) expect(size).toBeLessThan(16_000);
});
