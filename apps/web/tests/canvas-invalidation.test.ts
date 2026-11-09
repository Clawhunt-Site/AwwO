import { describe, expect, it } from 'vitest';
import { createFormNode, createSessionNode, emptyDocument, type CanvasDocument, type CanvasEdge, type CanvasNode, type NodeOutput, type SessionNode } from '../src/canvas/canvasDoc';
import { invalidateOutputs } from '../src/canvas/invalidateOutputs';
import type { ContractField } from '../src/canvas/nodeContracts';

function output(text: string, source: NodeOutput['source'] = 'run', at = 1): NodeOutput {
  return { text, source, at };
}

function agent(id: string): SessionNode {
  return {
    ...createSessionNode('coding', { x: 0, y: 0 }),
    id, title: id, runtime: 'runtime', model: 'model', effort: 'high', persona: 'Original task',
    binding: { agentId: id, companyId: 'company', agentName: id },
    lastOutput: output(`Old ${id}`),
    contract: { version: 1, inputs: [{ id: 'brief', label: 'Brief', type: 'text', required: true, value: 'Old input' }], outputs: [] },
  };
}

function wire(fromNode: string, toNode: string): CanvasEdge {
  return { id: `${fromNode}-${toNode}`, fromNode, toNode, fromPort: 'result', toPort: 'context', dataType: 'text' };
}

function graph(): CanvasDocument {
  return { ...emptyDocument(), nodes: [agent('a'), agent('b'), agent('c'), agent('independent')], edges: [wire('a', 'b'), wire('b', 'c')] };
}

function changeNode(doc: CanvasDocument, id: string, change: (node: CanvasNode) => CanvasNode): CanvasDocument {
  return { ...doc, nodes: doc.nodes.map((node) => node.id === id ? change(node) : node) };
}

function outputs(doc: CanvasDocument) {
  return Object.fromEntries(doc.nodes.map((node) => [node.id, node.lastOutput?.text ?? null]));
}

describe('execution output invalidation', () => {
  it.each([
    ['title', (node: SessionNode) => ({ ...node, title: 'New task framing' })],
    ['persona', (node: SessionNode) => ({ ...node, persona: 'New task' })],
    ['runtime', (node: SessionNode) => ({ ...node, runtime: 'other' })],
    ['model', (node: SessionNode) => ({ ...node, model: 'other' })],
    ['effort', (node: SessionNode) => ({ ...node, effort: 'low' })],
    ['kind', (node: SessionNode) => ({ ...node, agentKind: 'llm' as const })],
    ['binding', (node: SessionNode) => ({ ...node, binding: { ...node.binding!, agentId: 'other' } })],
    ['conversation', (node: SessionNode) => ({ ...node, issueId: 'other-conversation' })],
    ['contract value', (node: SessionNode) => ({ ...node, contract: { ...node.contract!, inputs: [{ ...node.contract!.inputs[0], value: 'New input' }] } })],
    ['field guidance', (node: SessionNode) => ({ ...node, contract: { ...node.contract!, inputs: [{ ...node.contract!.inputs[0], help: 'Only use confirmed records' }] } })],
    ['contract schema', (node: SessionNode) => ({ ...node, contract: { ...node.contract!, outputs: [{ id: 'new', label: 'New result', type: 'number' as const, required: true, value: '' }] } })],
  ])('clears changed %s and its downstream while preserving unrelated nodes', (_label, change) => {
    const prev = graph();
    const next = changeNode(prev, 'a', (node) => change(node as SessionNode));
    const resolved = invalidateOutputs(prev, next);
    expect(outputs(resolved)).toEqual({ a: null, b: null, c: null, independent: 'Old independent' });
    expect(prev.nodes[0].lastOutput?.text).toBe('Old a');
    expect(next.nodes[0].lastOutput?.text).toBe('Old a');
    expect(resolved.nodes[3]).toBe(next.nodes[3]);
  });

  it('clears legacy form results when a field changes', () => {
    const prev = graph();
    const form = { ...createFormNode({ x: 0, y: 0 }), id: 'a', lastOutput: output('Old form') };
    prev.nodes[0] = form;
    const next = changeNode(prev, 'a', () => ({ ...form, fields: [{ id: 'f1', label: 'Brief', value: 'New brief' }] }));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: null, c: null, independent: 'Old independent' });
  });

  it('preserves layout, preview, viewport and semantically cloned configuration changes', () => {
    const prev = graph();
    const next = changeNode(JSON.parse(JSON.stringify(prev)), 'a', (node) => ({ ...node, x: 200, y: 300, w: 500, h: 400, preview: 'Latest chat', bindAttempt: 'unknown' } as SessionNode));
    next.view = { x: 300, y: 200, scale: 1.5 };
    next.updatedAt += 1;
    const resolved = invalidateOutputs(prev, next);
    expect(resolved).toBe(next);
    expect(outputs(resolved)).toEqual({ a: 'Old a', b: 'Old b', c: 'Old c', independent: 'Old independent' });
  });

  it('preserves a newly published manual result and clears downstream even when configuration also changes', () => {
    const prev = graph();
    const fresh = output('Hand picked result', 'manual', 2);
    const next = changeNode(prev, 'a', (node) => ({ ...node, persona: 'Updated task', lastOutput: fresh } as SessionNode));
    const resolved = invalidateOutputs(prev, next);
    expect(outputs(resolved)).toEqual({ a: 'Hand picked result', b: null, c: null, independent: 'Old independent' });
    expect(resolved.nodes[0].lastOutput).toBe(fresh);
  });

  it('clears an old manual result when its task changes without republishing', () => {
    const prev = changeNode(graph(), 'a', (node) => ({ ...node, lastOutput: output('Old manual', 'manual') }));
    const next = changeNode(prev, 'a', (node) => ({ ...node, persona: 'Updated task' } as SessionNode));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: null, c: null, independent: 'Old independent' });
  });

  it.each([
    ['completed rerun', output('New run', 'run', 2)],
    ['failed rerun evidence', { ...output('Partial text', 'run', 2), partial: true }],
    ['removed result', null],
  ])('clears downstream after %s', (_label, fresh) => {
    const prev = graph();
    const next = changeNode(prev, 'a', (node) => ({ ...node, lastOutput: fresh }));
    const resolved = invalidateOutputs(prev, next);
    expect(outputs(resolved)).toEqual({ a: fresh?.text ?? null, b: null, c: null, independent: 'Old independent' });
  });

  it.each([
    ['added wire', (edges: CanvasEdge[]) => [...edges, wire('independent', 'b')]],
    ['removed wire', (edges: CanvasEdge[]) => edges.filter((edge) => edge.fromNode !== 'a')],
    ['changed source port', (edges: CanvasEdge[]) => edges.map((edge) => edge.fromNode === 'a' ? { ...edge, fromPort: 'out:other' } : edge)],
    ['changed channel', (edges: CanvasEdge[]) => edges.map((edge) => edge.fromNode === 'a' ? { ...edge, dataType: 'number' as const } : edge)],
  ])('invalidates the receiving node and downstream after an %s', (_label, change) => {
    const prev = graph();
    const next = { ...prev, edges: change(prev.edges) };
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: 'Old a', b: null, c: null, independent: 'Old independent' });
  });

  it('does not invalidate results when edge order or generated identifiers change', () => {
    const prev = graph();
    const next = { ...prev, edges: [...prev.edges].reverse().map((edge) => ({ ...edge, id: `new-${edge.id}` })) };
    expect(invalidateOutputs(prev, next)).toBe(next);
  });

  it('uses the previous graph to clear descendants of a removed node and removed wires', () => {
    const prev = graph();
    const next = { ...prev, nodes: prev.nodes.filter((node) => node.id !== 'a'), edges: [] };
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ b: null, c: null, independent: 'Old independent' });
  });

  it('terminates on cycles while preserving explicitly published manual outputs', () => {
    const prev = graph();
    prev.edges.push(wire('c', 'a'));
    const next = changeNode(prev, 'a', (node) => ({ ...node, lastOutput: output('New manual', 'manual', 2) }));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: 'New manual', b: null, c: null, independent: 'Old independent' });
  });

  it('preserves cached upstream and current output when Workflow retains a feedback cycle', () => {
    const prev = graph(); prev.edges.push({ ...wire('c', 'a'), kind: 'feedback' });
    const next = changeNode(prev, 'c', node => ({ ...node, lastOutput: output('Reviewed current result', 'run', 2) }));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: 'Old a', b: 'Old b', c: 'Reviewed current result', independent: 'Old independent' });
    expect(invalidateOutputs(prev, next)).toBe(next);
  });

  it.each(['add', 'remove', 'change'] as const)('ignores %s of an inactive Workflow feedback edge when comparing dependency counts', action => {
    const prev = graph();
    const feedback: CanvasEdge = { ...wire('c', 'a'), kind: 'feedback' };
    if (action !== 'add') prev.edges.push(feedback);
    const next = { ...prev, edges: action === 'add' ? [...prev.edges, feedback]
      : action === 'remove' ? prev.edges.filter(edge => edge.kind !== 'feedback')
        : prev.edges.map(edge => edge.kind === 'feedback' ? { ...edge, toNode: 'independent' } : edge) };
    expect(invalidateOutputs(prev, next)).toBe(next);
  });

  it.each(['publish', 'remove-feedback'] as const)('keeps review feedback invalidation strict after %s', action => {
    const prev = graph(); prev.edges.push({ ...wire('c', 'a'), kind: 'feedback' });
    prev.execution = { mode: 'review', maxRounds: 3, reviewerNodeId: 'c', verdictFieldId: 'approved' };
    const next = action === 'publish' ? changeNode(prev, 'c', node => ({ ...node, lastOutput: output('Unapproved revision', 'run', 2) }))
      : { ...prev, edges: prev.edges.filter(edge => edge.kind !== 'feedback') };
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: null, c: null, independent: 'Old independent' });
  });

  it.each(['workflow-to-review', 'review-to-workflow'] as const)('invalidates the whole graph when switching %s even with unchanged saved feedback', direction => {
    const prev = graph(); prev.edges.push({ ...wire('c', 'a'), kind: 'feedback' });
    const policy = { mode: 'review' as const, maxRounds: 3, reviewerNodeId: 'c', verdictFieldId: 'approved' };
    if (direction === 'review-to-workflow') prev.execution = policy;
    const next = { ...prev, execution: direction === 'workflow-to-review' ? policy : undefined };
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: null, c: null, independent: null });
  });
});


it('invalidates old publications when output structure guidance changes', () => {
  const prev = graph();
  const target = prev.nodes[0] as SessionNode;
  target.contract!.outputs = [{ id: 'result', label: 'Result', type: 'markdown', required: true, value: '', placeholder: 'Summary' }];
  const next = changeNode(prev, 'a', node => ({ ...node, contract: { ...target.contract!, outputs: [{ ...target.contract!.outputs[0], placeholder: 'Summary plus verification evidence' }] } }));
  expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: null, c: null, independent: 'Old independent' });
});

// Staleness follows results (多人同屏, 2026-11-07: a person picked a model for a node that had never run, and the result an
// agent had handed in below it was emptied). A change makes stale only what was made from a result it takes back or
// replaces: a node with no result made nothing anyone used, so a change of it, or one that reaches it, stops there.
describe('staleness follows results', () => {
  const handIn = (text: string) => output(text, 'manual', 5);
  /** a never ran; b holds a result an agent handed in; c ran on b's. */
  function handedIn(): CanvasDocument {
    let doc = changeNode(graph(), 'a', node => ({ ...node, lastOutput: null }));
    doc = changeNode(doc, 'b', node => ({ ...node, lastOutput: handIn('Levels by the agent') }));
    return doc;
  }

  it.each([
    ['model', (node: SessionNode) => ({ ...node, runtime: 'claude', model: 'claude-opus-5-5', effort: 'high' })],
    ['task', (node: SessionNode) => ({ ...node, persona: 'Write the rules and the feel' })],
    ['title', (node: SessionNode) => ({ ...node, title: 'Rules and feel' })],
    ['deliverable form', (node: SessionNode) => ({ ...node, contract: { ...node.contract!, outputs: [{ id: 'delivery_game', label: 'Game', type: 'html' as const, required: true, value: '' }] } })],
    ['kind', (node: SessionNode) => ({ ...node, agentKind: 'llm' as const })],
  ])('keeps everything below a node with no result when its %s changes', (_label, change) => {
    const prev = handedIn();
    const next = changeNode(prev, 'a', node => change(node as SessionNode));
    const resolved = invalidateOutputs(prev, next);
    expect(resolved).toBe(next);
    expect(outputs(resolved)).toEqual({ a: null, b: 'Levels by the agent', c: 'Old c', independent: 'Old independent' });
  });

  it('takes back what was made from a result an edit takes back, and stops at a node with no result', () => {
    // a ran; b has no result; c holds a hand-in: a's task changes, so a's result goes and b had nothing of it to pass on.
    let prev = changeNode(graph(), 'b', node => ({ ...node, lastOutput: null }));
    prev = changeNode(prev, 'c', node => ({ ...node, lastOutput: handIn('Review by the agent') }));
    const next = changeNode(prev, 'a', node => ({ ...node, persona: 'New task' } as SessionNode));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: null, c: 'Review by the agent', independent: 'Old independent' });
  });

  it('gives no reader a failed run’s evidence, so taking it back takes back nothing below', () => {
    const prev = changeNode(handedIn(), 'a', node => ({ ...node, lastOutput: { ...output('Half a page', 'run', 2), partial: true } }));
    const next = changeNode(prev, 'a', node => ({ ...node, model: 'retry-model' } as SessionNode));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: 'Levels by the agent', c: 'Old c', independent: 'Old independent' });
  });

  it('still takes back what was made from a form when one of its fields changes: its fields are its result', () => {
    const prev = graph();
    prev.nodes[0] = { ...createFormNode({ x: 0, y: 0 }), id: 'a', title: 'Brief', fields: [{ id: 'f1', label: 'Brief', value: 'A puzzle game' }] };
    const next = changeNode(prev, 'a', node => ({ ...node, fields: [{ id: 'f1', label: 'Brief', value: 'A racing game' }] } as CanvasNode));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: null, c: null, independent: 'Old independent' });
  });

  // A wire changes what its node is given even before its source has a result: it takes the place of an input's own value,
  // a picture not made yet leaves a note, and a run lays the source's first result over the canvas without reaching the
  // nodes it feeds (runRecoveryDocument.ts), so a result kept here would stay stale.
  it.each([
    ['added', (doc: CanvasDocument) => ({ ...doc, edges: [...doc.edges, wire('a', 'c')] }), { b: 'Levels by the agent', c: null }],
    ['removed', (doc: CanvasDocument) => ({ ...doc, edges: doc.edges.filter(edge => edge.fromNode !== 'a') }), { b: null, c: null }],
    ['moved to another port', (doc: CanvasDocument) => ({ ...doc, edges: doc.edges.map(edge => edge.fromNode === 'a' ? { ...edge, fromPort: 'out:delivery_game' } : edge) }), { b: null, c: null }],
  ])('takes back a receiver’s result when a wire from a node with no result is %s', (_label, change, left) => {
    const prev = handedIn();
    expect(outputs(invalidateOutputs(prev, change(prev)))).toEqual({ a: null, ...left, independent: 'Old independent' });
  });

  it('takes back a result when a picture not made yet is wired into its input, which then reads a note in place of its own value', () => {
    const prev = graph();
    prev.nodes.push({ ...createSessionNode('image', { x: 0, y: 0 }), id: 'logo', title: 'Logo' });
    const next = { ...prev, edges: [...prev.edges, { ...wire('logo', 'c'), toPort: 'in:brief', dataType: 'image' as const }] };
    expect(outputs(invalidateOutputs(prev, next))).toMatchObject({ a: 'Old a', b: 'Old b', c: null, independent: 'Old independent' });
  });

  it('takes nothing back below a failed first run: its evidence gives no reader anything', () => {
    const prev = handedIn();
    const next = changeNode(prev, 'a', node => ({ ...node, lastOutput: { ...output('Half an answer', 'run', 9), partial: true } }));
    expect(invalidateOutputs(prev, next)).toBe(next);
  });

  describe('a media node with no result', () => {
    // It gives a text input it feeds a note that it made no file, which names it (mediaMissingText), and a run goes on.
    function picture(): CanvasDocument {
      const prev = graph();
      prev.nodes.push({ ...createSessionNode('image', { x: 0, y: 0 }), id: 'logo', title: 'Product logo' });
      prev.edges.push({ ...wire('logo', 'c'), toPort: 'in:brief', dataType: 'image' });
      return prev;
    }

    it('takes back what read its note when its title, which the note names, changes', () => {
      const prev = picture();
      const next = changeNode(prev, 'logo', node => ({ ...node, title: 'Hero photograph' }));
      expect(outputs(invalidateOutputs(prev, next))).toMatchObject({ a: 'Old a', b: 'Old b', c: null, independent: 'Old independent' });
    });

    it('keeps what read its note when its model changes, which the note does not say', () => {
      const prev = picture();
      const next = changeNode(prev, 'logo', node => ({ ...node, model: 'another-image-model' } as SessionNode));
      expect(invalidateOutputs(prev, next)).toBe(next);
    });
  });

  it.each([
    ['with its wires', (doc: CanvasDocument) => doc.edges.filter(edge => edge.fromNode !== 'a')],
    ['with its wires left behind', (doc: CanvasDocument) => doc.edges],
  ])('takes back its readers’ results when a node with no result is deleted %s: what they are given changes', (_label, edges) => {
    const prev = handedIn();
    const next = { ...prev, nodes: prev.nodes.filter(node => node.id !== 'a'), edges: edges(prev) };
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ b: null, c: null, independent: 'Old independent' });
  });

  describe('a session taking its first deliverable form, its wires carried onto the form’s ports', () => {
    /** brief → build (a text session) → review; the review holds a hand-in. */
    function carried(build: Partial<SessionNode>, form = true): [CanvasDocument, CanvasDocument] {
      const plain = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'build', title: 'Build', ...build } as SessionNode;
      const brief = { ...createFormNode({ x: 0, y: 0 }), id: 'brief', title: 'Brief' };
      const review = { ...agent('review'), lastOutput: handIn('Checklist by the agent') };
      const prev: CanvasDocument = { ...emptyDocument(), nodes: [brief, plain, review],
        edges: [{ ...wire('brief', 'build'), fromPort: 'data' }, wire('build', 'review')] };
      const game = { version: 1 as const, inputs: [{ id: 'context', label: 'Brief', type: 'text' as const, required: false, value: '' }],
        outputs: [{ id: 'delivery_game', label: 'Game', type: 'html' as const, required: true, value: '' }] };
      const next: CanvasDocument = { ...prev, nodes: prev.nodes.map(node => node.id === 'build' ? { ...plain, contract: game } : node),
        edges: form ? [{ ...wire('brief', 'build'), fromPort: 'data', toPort: 'in:context' }, { ...wire('build', 'review'), fromPort: 'out:delivery_game' }]
          : [{ ...wire('brief', 'build'), fromPort: 'data', toPort: 'in:context' }] };
      return [prev, next];
    }

    it('takes nothing back from the nodes it feeds while it has no result: they could not have run on it', () => {
      const [prev, next] = carried({});
      expect(invalidateOutputs(prev, next)).toBe(next);
    });

    it('still takes back what they made from its result, which its new form makes stale', () => {
      const [prev, next] = carried({ lastOutput: output('A plain answer', 'run', 2) });
      expect(outputs(invalidateOutputs(prev, next))).toEqual({ brief: null, build: null, review: null });
    });

    it('takes back what they made when it is a media node, whose wires are not carried', () => {
      const [prev, next] = carried({ agentKind: 'image' }, false);
      expect(outputs(invalidateOutputs(prev, next))).toEqual({ brief: null, build: null, review: null });
    });

    it('takes back a reader’s result when a wire of it goes to another reader in the same change', () => {
      const [prev, next] = carried({});
      next.edges = [next.edges[0], { ...wire('build', 'review'), toNode: 'other', fromPort: 'out:delivery_game' }];
      expect(outputs(invalidateOutputs(prev, next)).review).toBeNull();
    });

    describe('holding a hand-in', () => {
      const page = '<!doctype html><html><head><title>Lockstep</title></head><body><canvas></canvas></body></html>';

      it('keeps one the form fits, and what its readers made from it, which they now read whole through the form', () => {
        const [prev, next] = carried({ lastOutput: handIn(page) });
        expect(invalidateOutputs(prev, next)).toBe(next);
      });

      it('takes back one the form does not fit, and what its readers made from it', () => {
        const [prev, next] = carried({ lastOutput: handIn('Level notes, not a page') });
        expect(outputs(invalidateOutputs(prev, next))).toEqual({ brief: null, build: null, review: null });
      });

      it('keeps one the form fits but takes back what its readers made when they now read only part of it', () => {
        const fenced = '```html\n' + page + '\n```';
        const [prev, next] = carried({ lastOutput: handIn(fenced) });
        expect(outputs(invalidateOutputs(prev, next))).toEqual({ brief: null, build: fenced, review: null });
      });

      it('takes it back when the form brings an input of its own, or anything else the node is asked changes with it', () => {
        const [prev, next] = carried({ lastOutput: handIn(page) });
        const asked = changeNode(next, 'build', node => {
          const build = node as SessionNode;
          return { ...build, contract: { ...build.contract!, inputs: [...build.contract!.inputs, { id: 'audience', label: 'Audience', type: 'text' as const, required: false, value: 'Teachers' }] } };
        });
        expect(outputs(invalidateOutputs(prev, asked))).toEqual({ brief: null, build: null, review: null });
        const retitled = changeNode(next, 'build', node => ({ ...node, title: 'Build the game' }));
        expect(outputs(invalidateOutputs(prev, retitled))).toEqual({ brief: null, build: null, review: null });
      });

      it('takes back a run’s result the form fits: the run was not asked for it', () => {
        const [prev, next] = carried({ lastOutput: output(page, 'run', 2) });
        expect(outputs(invalidateOutputs(prev, next))).toEqual({ brief: null, build: null, review: null });
      });

      it('takes it back when its first form brings an input of its own, even an empty one: a run’s prompt names it', () => {
        const [prev, next] = carried({ lastOutput: handIn(page) });
        const asked = changeNode(next, 'build', node => {
          const build = node as SessionNode;
          return { ...build, contract: { ...build.contract!, inputs: [...build.contract!.inputs, { id: 'rules', label: 'Exclude violent themes', type: 'text' as const, required: false, value: '' }] } };
        });
        expect(outputs(invalidateOutputs(prev, asked))).toEqual({ brief: null, build: null, review: null });
      });

      it('takes it back when an input carried from its wires is named otherwise, or fed by another node', () => {
        const [prev, next] = carried({ lastOutput: handIn(page) });
        const renamed = changeNode(next, 'build', node => {
          const build = node as SessionNode;
          return { ...build, contract: { ...build.contract!, inputs: [{ ...build.contract!.inputs[0], label: 'Brief, without violence' }] } };
        });
        expect(outputs(invalidateOutputs(prev, renamed)).build).toBeNull();
        const other = { ...createFormNode({ x: 0, y: 0 }), id: 'other', title: 'Brief' };
        const elsewhere = { ...next, nodes: [...next.nodes, other], edges: [{ ...next.edges[0], fromNode: 'other' }, next.edges[1]] };
        expect(outputs(invalidateOutputs({ ...prev, nodes: [...prev.nodes, other] }, elsewhere)).build).toBeNull();
      });

      it('keeps a hand-in the form fits while taking back what its readers made, where it could be a JSON object', () => {
        // A raw line break inside a string: this page reads the whole text, the server repairs the object and gives its
        // readers `body` alone.
        const broken = '{"body":"Level 1\nLevel 2"}';
        const [prev, next] = carried({ lastOutput: handIn(broken) });
        const body = changeNode(next, 'build', node => {
          const build = node as SessionNode;
          return { ...build, contract: { ...build.contract!, outputs: [{ id: 'body', label: 'Body', type: 'markdown' as const, required: true, value: '' }] } };
        });
        body.edges = [body.edges[0], { ...body.edges[1], fromPort: 'out:body' }];
        expect(outputs(invalidateOutputs(prev, body))).toEqual({ brief: null, build: broken, review: null });
      });

      it('takes back a hand-in the server would read otherwise: a page in a fence named JSON, which it leaves on', () => {
        const fenced = '```JSON\n' + JSON.stringify({ delivery_game: page }) + '\n```';
        const [prev, next] = carried({ lastOutput: handIn(fenced) });
        expect(outputs(invalidateOutputs(prev, next))).toEqual({ brief: null, build: null, review: null });
      });
    });
  });

  it.each([
    ['model', (node: SessionNode) => ({ ...node, runtime: 'claude', model: 'claude-opus-5-5' })],
    ['effort', (node: SessionNode) => ({ ...node, effort: 'low' })],
    ['bound Agent', (node: SessionNode) => ({ ...node, binding: { ...node.binding!, agentId: 'agent-other' } })],
    ['conversation', (node: SessionNode) => ({ ...node, issueId: 'conversation-other' })],
  ])('keeps a hand-in, and what was made from it, when its own node’s %s changes', (_label, change) => {
    const prev = handedIn();
    const next = changeNode(prev, 'b', node => change(node as SessionNode));
    const resolved = invalidateOutputs(prev, next);
    expect(resolved).toBe(next);
    expect(outputs(resolved)).toEqual({ a: null, b: 'Levels by the agent', c: 'Old c', independent: 'Old independent' });
  });

  it.each([
    ['title', (node: SessionNode) => ({ ...node, title: 'Other levels' })],
    ['task', (node: SessionNode) => ({ ...node, persona: 'Other levels' })],
    ['kind', (node: SessionNode) => ({ ...node, agentKind: 'image' as const })],
    ['inputs', (node: SessionNode) => ({ ...node, contract: { ...node.contract!, inputs: [{ ...node.contract!.inputs[0], value: 'Other input' }] } })],
    ['task frame', (node: SessionNode) => ({ ...node, taskFrame: { version: 1 as const, source: 'manual' as const, constraints: ['Eight levels'], acceptanceCriteria: [] } })],
  ])('takes back a hand-in, and what was made from it, when what its node is asked changes: %s', (_label, change) => {
    const prev = handedIn();
    const next = changeNode(prev, 'b', node => change(node as SessionNode));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: null, c: null, independent: 'Old independent' });
  });

  describe('a hand-in through a change of its node’s deliverable form', () => {
    const summary: ContractField = { id: 'summary', label: 'Summary', type: 'markdown', required: true, value: '' };
    const notes = (required: boolean): ContractField => ({ id: 'notes', label: 'Notes', type: 'markdown', required, value: '' });
    const handedInForm = (result: NodeOutput) => changeNode(handedIn(), 'b', node => ({ ...node, lastOutput: result,
      contract: { ...(node as SessionNode).contract!, outputs: [summary] } } as SessionNode));
    const withOutputs = (doc: CanvasDocument, fields: ContractField[]) =>
      changeNode(doc, 'b', node => ({ ...node, contract: { ...(node as SessionNode).contract!, outputs: fields } } as SessionNode));
    const levels = '{"summary":"Eight levels"}';

    it('stays through an output it may leave out; its readers are reached, as the fields they read from changed', () => {
      const prev = handedInForm(handIn(levels));
      expect(outputs(invalidateOutputs(prev, withOutputs(prev, [summary, notes(false)])))).toEqual({ a: null, b: levels, c: null, independent: 'Old independent' });
    });

    it('stays through a new label on the output it fills, and so does what its readers made', () => {
      const prev = handedInForm(handIn(levels));
      const next = withOutputs(prev, [{ ...summary, label: 'Level summary' }]);
      expect(invalidateOutputs(prev, next)).toBe(next);
    });

    it('goes, with what its readers made, through an output it lacks and must hold', () => {
      const prev = handedInForm(handIn(levels));
      expect(outputs(invalidateOutputs(prev, withOutputs(prev, [summary, notes(true)])))).toEqual({ a: null, b: null, c: null, independent: 'Old independent' });
    });

    it('goes, with what its readers made, when an input of the form changes with it', () => {
      const prev = handedInForm(handIn(levels));
      const next = changeNode(withOutputs(prev, [summary, notes(false)]), 'b', node => {
        const b = node as SessionNode;
        return { ...b, contract: { ...b.contract!, inputs: [{ ...b.contract!.inputs[0], value: 'Other input' }] } };
      });
      expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: null, c: null, independent: 'Old independent' });
    });

    it('takes back a run’s result through an output it may leave out: the run was not asked for it', () => {
      const prev = handedInForm(output(levels, 'run', 5));
      expect(outputs(invalidateOutputs(prev, withOutputs(prev, [summary, notes(false)])))).toEqual({ a: null, b: null, c: null, independent: 'Old independent' });
    });
  });

  it('still takes back a hand-in kept for its model when, in the same change, a result it stood on is replaced', () => {
    const prev = changeNode(handedIn(), 'a', node => ({ ...node, lastOutput: output('Old rules', 'run', 1) }));
    let next = changeNode(prev, 'b', node => ({ ...node, model: 'claude-opus-5-5' } as SessionNode));
    next = changeNode(next, 'a', node => ({ ...node, lastOutput: output('New rules', 'run', 9) }));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: 'New rules', b: null, c: null, independent: 'Old independent' });
  });

  it('still takes back a hand-in kept for its model when, later in the same change, a result it stood on goes', () => {
    // The hand-in's node comes first in the document, so it is looked at for its model before its upstream's result goes.
    let prev = changeNode(handedIn(), 'a', node => ({ ...node, lastOutput: output('Old rules', 'run', 1) }));
    prev = { ...prev, nodes: [prev.nodes[1], prev.nodes[0], ...prev.nodes.slice(2)] };
    let next = changeNode(prev, 'b', node => ({ ...node, model: 'claude-opus-5-5' } as SessionNode));
    next = changeNode(next, 'a', node => ({ ...node, persona: 'Other rules' } as SessionNode));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: null, c: null, independent: 'Old independent' });
  });

  it('takes back its readers’ results when a node with a result is deleted, even with its wires left behind', () => {
    const prev = graph();
    const next = { ...prev, nodes: prev.nodes.filter(node => node.id !== 'a') };
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ b: null, c: null, independent: 'Old independent' });
  });

  it.each([
    ['task', (doc: CanvasDocument) => changeNode(doc, 'b', node => ({ ...node, persona: 'Other task' } as SessionNode))],
    ['wires', (doc: CanvasDocument) => ({ ...doc, edges: [...doc.edges, wire('independent', 'b')] })],
  ])('keeps a case recording through an edit of its %s, and what was made from it', (_label, change) => {
    const prev = changeNode(graph(), 'b', node => ({ ...node, lastOutput: output('Recorded b', 'case', 1) }));
    expect(outputs(invalidateOutputs(prev, change(prev)))).toEqual({ a: 'Old a', b: 'Recorded b', c: 'Old c', independent: 'Old independent' });
  });

  it.each([
    ['renamed: their prompts quote it by name', (node: SessionNode) => ({ ...node, title: 'Renamed rules' })],
    ['given other fields: their wires read those out of it', (node: SessionNode) => ({ ...node, contract: { ...node.contract!,
      outputs: [{ id: 'result', label: 'Result', type: 'html' as const, required: true, value: '' }] } })],
  ])('keeps a case recording but takes back what read it when its node is %s', (_label, change) => {
    const prev = changeNode(graph(), 'a', node => ({ ...node, lastOutput: output('Recorded rules', 'case', 1) }));
    const next = changeNode(prev, 'a', node => change(node as SessionNode));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: 'Recorded rules', b: null, c: null, independent: 'Old independent' });
  });

  it('keeps a case recording but takes back what read it when a field it lacks becomes required: such a result is refused upstream', () => {
    const fields = (noteRequired: boolean) => [{ id: 'body', label: 'Body', type: 'markdown' as const, required: true, value: '' },
      { id: 'note', label: 'Note', type: 'markdown' as const, required: noteRequired, value: '' }];
    const recorded = '{"body":"recorded body"}';
    const prev = changeNode(graph(), 'a', node => ({ ...node, lastOutput: output(recorded, 'case', 1),
      contract: { ...(node as SessionNode).contract!, outputs: fields(false) } } as SessionNode));
    const next = changeNode(prev, 'a', node => ({ ...node, contract: { ...(node as SessionNode).contract!, outputs: fields(true) } } as SessionNode));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: recorded, b: null, c: null, independent: 'Old independent' });
  });

  it('keeps a case recording but takes back what read it when it no longer fits its one output: such a result is refused upstream', () => {
    const body = (type: 'markdown' | 'html'): ContractField[] => [{ id: 'body', label: 'Body', type, required: true, value: '' }];
    const prev = changeNode(graph(), 'a', node => ({ ...node, lastOutput: output('Recorded notes', 'case', 1),
      contract: { ...(node as SessionNode).contract!, outputs: body('markdown') } } as SessionNode));
    const next = changeNode(prev, 'a', node => ({ ...node, contract: { ...(node as SessionNode).contract!, outputs: body('html') } } as SessionNode));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: 'Recorded notes', b: null, c: null, independent: 'Old independent' });
  });

  it('keeps a hand-in but takes back what read it when its node takes a market Agent, whose text is framed as a third party’s', () => {
    const prev = handedIn();
    const next = changeNode(prev, 'b', node => ({ ...node, agentRef: { source: 'market' as const, agentId: 'market-agent', version: 1 } } as SessionNode));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: null, b: 'Levels by the agent', c: null, independent: 'Old independent' });
  });

  it('keeps what was made from a case recording when that recording’s own node is set up again', () => {
    const prev = changeNode(graph(), 'a', node => ({ ...node, lastOutput: output('Recorded rules', 'case', 1) }));
    const next = changeNode(prev, 'a', node => ({ ...node, model: 'claude-opus-5-5' } as SessionNode));
    expect(invalidateOutputs(prev, next)).toBe(next);
  });

  it.each([
    ['a hand-in', handIn('Review by the agent')],
    ['a case recording', output('Recorded review', 'case', 1)],
  ])('lets a replaced result reach %s below a node with no result, which will be made from it again', (_label, below) => {
    let prev = changeNode(graph(), 'b', node => ({ ...node, lastOutput: null }));
    prev = changeNode(prev, 'c', node => ({ ...node, lastOutput: below }));
    const next = changeNode(prev, 'a', node => ({ ...node, lastOutput: output('New a', 'run', 9) }));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: 'New a', b: null, c: null, independent: 'Old independent' });
  });

  it('clears the recordings made from a replaced result, through the recordings in between', () => {
    let prev = graph();
    for (const id of ['a', 'b', 'c']) prev = changeNode(prev, id, node => ({ ...node, lastOutput: output(`Recorded ${id}`, 'case', 1) }));
    const next = changeNode(prev, 'a', node => ({ ...node, lastOutput: output('New a', 'run', 9) }));
    expect(outputs(invalidateOutputs(prev, next))).toEqual({ a: 'New a', b: null, c: null, independent: 'Old independent' });
  });
});
