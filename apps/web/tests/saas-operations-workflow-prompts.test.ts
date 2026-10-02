import { describe, expect, it } from 'vitest';
import { createOfficialDocument } from '../src/saas/examples/officialWorkflows';
import { industryWorkflow } from '../src/saas/examples/advanced/industryWorkflow';
import { OPERATIONS_CASES } from '../src/saas/examples/advanced/operationsCatalog';

describe.each(OPERATIONS_CASES)('$id implementation handoffs', item => {
  it.each(['zh', 'en'] as const)('%s copies executable view instructions and a shared browser API into the real canvas', locale => {
    const workflow = industryWorkflow(item);
    const document = createOfficialDocument(workflow, locale);
    const node = (id: string) => document.nodes[workflow.nodes.findIndex(step => step.id === id)];
    const engine = node('engine');
    const views = node('views');
    expect(views.persona).not.toBe(node('ux').persona);
    for (const api of ['createInitialState()', 'transition(state, action)', 'derive(state)']) expect(engine.persona).toContain(api);
    for (const api of ['mountViews(root, api)', 'getState()', 'getViewModel()', 'dispatch(action)', 'reset()', 'render()', 'destroy()']) expect(views.persona).toContain(api);
    expect(views.persona).toContain('DOM');
    expect(views.persona).toContain('CSS');
    expect(views.persona).toContain('JavaScript');
    expect(views.persona).toContain('400');
    expect(views.persona).toContain('200');
    expect(engine.contract?.outputs[0].type).toBe('markdown');
    expect(views.contract?.outputs[0].type).toBe('markdown');
    expect(views.contract?.inputs.find(field => field.id === 'brief')?.value).toContain('mountViews(root, api)');
    expect(views.contract?.outputs[0].help).toContain('mountViews');
  });

  it.each(['zh', 'en'] as const)('%s keeps HTML-only delivery and makes missing-source integration explicit', locale => {
    const workflow = industryWorkflow(item);
    const document = createOfficialDocument(workflow, locale);
    const node = (id: string) => document.nodes[workflow.nodes.findIndex(step => step.id === id)];
    const build = node('build');
    expect(build.persona).toContain('TypeScript');
    expect(build.persona).toContain('JavaScript');
    expect(build.persona).toContain(locale === 'zh' ? '补齐' : 'Implement missing');
    expect(build.persona).toContain(locale === 'zh' ? '待执行' : 'not executed');
    for (const id of ['build', 'repair', 'deliver']) {
      expect(node(id).contract?.outputs[0].type).toBe('html');
      expect(node(id).persona).toContain(locale === 'zh' ? 'HTML 注释' : 'HTML comments');
    }
    expect(workflow.nodes).toHaveLength(12);
    expect(workflow.edges.filter(edge => edge.to === 'build').map(edge => edge.from)).toEqual(['engine', 'views']);
    expect(node('engine').persona).toContain(item.steps.find(step => step.id === 'model')!.task[locale]);
    expect(node('build').contract?.inputs[0].value).toContain(item.brief[locale]);
  });
});
