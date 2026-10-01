import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TileTranscript } from '../src/canvas/TileTranscript';
import { NodeDeliverables } from '../src/canvas/NodeDeliverables';
import { GraphNodeOutput } from '../src/saas/GraphNodeOutput';
import { createSessionNode, emptyDocument } from '../src/canvas/canvasDoc';
import { parseContractOutput, type NodeContract } from '../src/canvas/nodeContracts';
import { deliveryPresentation, fileSafeDisplaySource, pendingFileDelivery } from '../src/canvas/fileDeliveryPresentation';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

const encoded = 'UEsDBAoAAAAA'.repeat(3000);
const page = '<html><head><title>Actual game</title></head><body><button>Play</button></body></html>';
const contract: NodeContract = { version: 1, inputs: [], outputs: [
  { id: 'result', type: 'markdown', required: true, label: 'Execution result', value: '' },
  { id: 'delivery_game', type: 'html', required: true, label: 'Game', value: '' },
  { id: 'delivery_project', type: 'file', required: true, label: 'Source project', value: '' },
] };
const output = JSON.stringify({ result: '# Actual checks\n\nNode check exited 0.', delivery_game: page,
  delivery_project: { name: 'workspace.zip', content: encoded, encoding: 'base64' } });
const sessionNode = () => ({ ...createSessionNode('coding', { x: 0, y: 0 }), id: 'node-a', contract,
  lastOutput: { text: output, at: 1, source: 'run' as const } });
afterEach(() => { cleanup(); clearSaaSCanvas(); localStorage.clear(); });

describe('file delivery reading projection', () => {
  it('preserves valid report/game fields and exposes metadata without accepting raw file bytes for execution', () => {
    const presentation = deliveryPresentation(contract, output);
    expect(presentation.errors).toEqual([]);
    expect(presentation.values.result).toContain('Actual checks');
    expect(presentation.values.delivery_game).toBe(page);
    expect(presentation.values.delivery_project).toBeUndefined();
    expect(presentation.pendingFiles.get('delivery_project')).toEqual({ name: 'workspace.zip', byteLength: encoded.length / 4 * 3 });
    expect(presentation.displaySource).not.toContain(encoded.slice(0, 100));
    expect(parseContractOutput(contract, output).errors).toHaveLength(1);
    expect(JSON.parse(output).delivery_project.content).toBe(encoded);
  });

  it('does not let an unverified omission marker satisfy a required file or claim content was received', () => {
    const source = JSON.stringify({ ...JSON.parse(output), delivery_project: { name: 'workspace.zip', byteLength: 27000,
      contentOmitted: true, storedReference: 'unavailable', url: '/api/admin/not-a-download' } });
    const projection = deliveryPresentation(contract, source);
    expect(projection.errors).toHaveLength(1);
    expect(projection.pendingFiles.size).toBe(0);
    expect(projection.values.delivery_project).toBeUndefined();
    expect(projection.displaySource).not.toContain('/api/admin/');
    expect(JSON.parse(projection.displaySource).delivery_project.verified).toBe(false);
    expect(parseContractOutput(contract, source).errors).toHaveLength(1);
    render(<TileTranscript turns={[{ id: 1, role: 'agent', text: source,
      presentation: { outputState: 'final', outputContract: contract } }]} history="loaded" streaming={false} limit={Infinity} />);
    expect(screen.getByRole('status')).toHaveTextContent('结果格式需要修复');
    expect(screen.queryByText(/文件内容已返回/)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('keeps a marker-only required file invalid in node deliverables as well as the transcript', () => {
    const marker = { name: 'x.zip', contentOmitted: true, storedReference: 'unavailable' };
    const source = JSON.stringify({ ...JSON.parse(output), delivery_project: marker });
    expect(pendingFileDelivery(marker)).toBeUndefined();
    const node = sessionNode();
    node.lastOutput.text = source;
    const { container } = render(<NodeDeliverables node={node} readOnly />);
    expect(screen.getByText('输出未通过表单校验')).toHaveAttribute('role', 'alert');
    expect(container.textContent).toContain('"verified":false');
    expect(container.textContent).not.toContain('文件内容已返回');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('keeps the server invalidContent marker as a delivery error instead of a pending valid file', () => {
    const source = JSON.stringify({ ...JSON.parse(output), delivery_project: { name: 'workspace.zip',
      contentOmitted: true, storedReference: 'unavailable', invalidContent: true } });
    const projection = deliveryPresentation(contract, source);
    expect(projection.errors).toHaveLength(1);
    expect(projection.pendingFiles.size).toBe(0);
    render(<TileTranscript turns={[{ id: 1, role: 'agent', text: source,
      presentation: { outputState: 'final', outputContract: contract } }]} history="loaded" streaming={false} limit={Infinity} />);
    expect(screen.getByRole('status')).toHaveTextContent('结果格式需要修复');
    expect(screen.queryByText(/文件内容已返回/)).toBeNull();
  });

  it('hides bytes in final, failed, unknown and truncated transport envelopes without mutating ordinary source', () => {
    expect(fileSafeDisplaySource(output)).not.toContain(encoded.slice(0, 100));
    expect(fileSafeDisplaySource(`\`\`\`json\n${output}\n\`\`\``)).not.toContain(encoded.slice(0, 100));
    expect(fileSafeDisplaySource(`{"delivery_project":{"name":"workspace.zip","content":"${encoded}`)).not.toContain(encoded.slice(0, 100));
    expect(fileSafeDisplaySource(page)).toBe(page);
    expect(fileSafeDisplaySource('exact prose and source')).toBe('exact prose and source');
  });

  it.each([
    ['truncated before the filename', `{"delivery_project":{"content":"${encoded}`],
    ['content preceding filename and encoding', `{"delivery_project":{"content":"${encoded}","name":"x.zip","encoding":"base64"}}`],
    ['prose before an envelope', `Here is file: {"delivery_project":{"name":"x.zip","content":"${encoded}","encoding":"base64"}}`],
    ['escaped quotes before long content', `Here is file: {"content":"a\\\"b${encoded}`],
  ])('hides attachment bytes in both source and the actual transcript for %s', (_case, source) => {
    expect(fileSafeDisplaySource(source)).not.toContain(encoded.slice(0, 100));
    const { container, rerender } = render(<TileTranscript turns={[{ id: 1, role: 'agent', text: source }]}
      history="loaded" streaming={false} limit={Infinity} />);
    expect(container.textContent).not.toContain(encoded.slice(0, 100));
    rerender(<TileTranscript turns={[{ id: 1, role: 'agent', text: source,
      presentation: { outputState: 'final', outputContract: contract } }]}
      history="loaded" streaming={false} limit={Infinity} />);
    expect(container.textContent).not.toContain(encoded.slice(0, 100));
  });

  it.each([
    { name: 'x.zip', content: '%%%bad', encoding: 'base64' },
    { name: 'x.zip', content: encoded, encoding: 'hex' },
    { name: 'x.zip', content: 'Zh==', encoding: 'base64' },
    { name: 'x.zip', content: 'Zm9=', encoding: 'base64' },
    { name: '../x.zip', content: encoded, encoding: 'base64' },
  ])('does not call invalid file transports valid deliveries: case %#', invalidFile => {
    const source = JSON.stringify({ ...JSON.parse(output), delivery_project: invalidFile });
    expect(pendingFileDelivery(invalidFile)).toBeUndefined();
    const projection = deliveryPresentation(contract, source);
    expect(projection.errors).toHaveLength(1);
    expect(projection.pendingFiles.size).toBe(0);
    const { container } = render(<TileTranscript turns={[{ id: 1, role: 'agent', text: source,
      presentation: { outputState: 'final', outputContract: contract } }]} history="loaded" streaming={false} limit={Infinity} />);
    expect(screen.getByRole('status')).toHaveTextContent('结果格式需要修复');
    expect(screen.queryByText(/文件内容已返回/)).toBeNull();
    expect(container.textContent).not.toContain(invalidFile.content);
  });

  it('renders the real mixed result readably in a thread while missing refs never become fake downloads', () => {
    const { container, rerender } = render(<TileTranscript turns={[{ id: 1, role: 'agent', text: output,
      presentation: { outputState: 'final', outputContract: contract } }]} history="loaded" streaming={false} limit={Infinity} />);
    expect(screen.getByRole('heading', { name: 'Actual checks' })).toBeTruthy();
    expect(screen.getByText(/workspace.zip/, { selector: 'span' })).toBeTruthy();
    expect(screen.queryByText(/结果格式需要修复/)).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('下载引用尚不可用');
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).not.toContain(encoded.slice(0, 100));
    rerender(<TileTranscript turns={[{ id: 1, role: 'agent', text: output, tone: 'error' }]} history="loaded" streaming={false} limit={Infinity} />);
    expect(container.textContent).not.toContain(encoded.slice(0, 100));
  });

  it('uses an authenticated saved artifact link once the same file field contains a persisted reference', () => {
    configureSaaSCanvas({ tenant: { id: 'tenant-a', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 }, canvasId: 'canvas-a' });
    const reference = `awwo-file:a${'b'.repeat(32)}`;
    const stored = JSON.stringify({ ...JSON.parse(output), delivery_project: reference });
    render(<TileTranscript turns={[{ id: 1, role: 'agent', text: stored, presentation: { outputState: 'final', outputContract: contract } }]} history="loaded" streaming={false} limit={Infinity} />);
    expect(screen.getByRole('link', { name: '下载文件' })).toHaveAttribute('href', `/api/v1/tenants/tenant-a/artifacts/${reference.slice('awwo-file:'.length)}`);
    expect(screen.queryByText(/下载引用尚不可用/)).toBeNull();
  });

  it('keeps report and game preview usable in deliverables without printing the project archive', () => {
    const { container } = render(<NodeDeliverables node={sessionNode()} readOnly />);
    expect(screen.getByRole('heading', { name: 'Actual checks' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Game', exact: true }));
    expect(screen.getByTitle('Game · HTML 预览')).toHaveAttribute('srcdoc', expect.stringContaining('Play'));
    fireEvent.click(screen.getByRole('button', { name: 'Source project', exact: true }));
    expect(screen.getByRole('status')).toHaveTextContent('下载引用尚不可用');
    expect(container.textContent).not.toContain(encoded.slice(0, 100));
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('redacts old graph history including the expandable raw response', () => {
    const { container } = render(<SaaSPreferencesProvider><GraphNodeOutput graph={{ id: 'graph', operationId: 'operation', canvasId: 'canvas-a',
      documentVersion: 1, createdAt: '2026-10-01', status: 'completed', scope: ['node-a'], nodes: [], document: { ...emptyDocument(), nodes: [sessionNode()] } }}
      node={{ nodeId: 'node-a', state: 'done', output }} /></SaaSPreferencesProvider>);
    expect(screen.getByRole('heading', { name: 'Actual checks' })).toBeTruthy();
    expect(container.textContent).not.toContain(encoded.slice(0, 100));
    expect(screen.queryByText(/历史交付格式校验/)).toBeNull();
  });
});
