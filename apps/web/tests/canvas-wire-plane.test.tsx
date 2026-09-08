import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WirePlane } from '../src/canvas/WirePlane';
import { createSessionNode, type CanvasEdge } from '../src/canvas/canvasDoc';
import { LocaleProvider } from '../src/canvas/i18n';
import { portAnchorWorld } from '../src/canvas/ports';
import { wirePath } from '../src/canvas/wireState';

afterEach(cleanup);

const source = { ...createSessionNode('coding', { x: 800, y: 180 }), id: 'review', title: 'Review' };
const target = { ...createSessionNode('coding', { x: 80, y: 80 }), id: 'build', title: 'Build' };
const nodes = [source, target];
const edge: CanvasEdge = { id: 'review-build', fromNode: 'review', fromPort: 'result', toNode: 'build', toPort: 'context', dataType: 'text' };

describe('directional canvas wires', () => {
  it('points at the real receiving input even for a right-to-left connection', () => {
    const { container } = render(<LocaleProvider locale="en"><WirePlane nodes={nodes} edges={[edge]} scale={0.5} /></LocaleProvider>);
    const path = screen.getByTestId('canvas-wire-review-build');
    expect(path).toHaveAttribute('d', wirePath(portAnchorWorld(source, 'result')!, portAnchorWorld(target, 'context')!));
    const marker = container.querySelector('marker')!;
    expect(path).toHaveAttribute('marker-end', `url(#${marker.id})`);
    expect(path).not.toHaveAttribute('marker-start');
    expect(marker).toHaveAttribute('orient', 'auto');
    expect(marker).toHaveAttribute('markerWidth', '24');
    expect(path).toHaveAttribute('vector-effect', 'non-scaling-stroke');
    expect(screen.getByRole('img', { name: /Review → Build/ })).toHaveAttribute('data-wire-state', 'idle');
    expect(screen.queryByTestId('canvas-wire-flow-review-build')).toBeNull();
  });

  it('renders flow only for real transfers and stops it when execution ends', () => {
    const props = { nodes, edges: [edge], runs: { review: { state: 'done' as const }, build: { state: 'running' as const } } };
    const { rerender } = render(<WirePlane {...props} running />);
    expect(screen.getByTestId('canvas-wire-flow-review-build')).toBeInTheDocument();
    rerender(<WirePlane {...props} running={false} />);
    expect(screen.queryByTestId('canvas-wire-flow-review-build')).toBeNull();
  });

  it('distinguishes feedback geometry and waits for the next round before flowing', () => {
    const feedback: CanvasEdge = { ...edge, kind: 'feedback' };
    const props = { nodes, edges: [feedback], running: true, runs: { build: { state: 'running' as const } } };
    const { rerender } = render(<WirePlane {...props} round={1} />);
    expect(screen.getByTestId('canvas-wire-review-build')).toHaveAttribute('d', wirePath(portAnchorWorld(source, 'result')!, portAnchorWorld(target, 'context')!, true, 80));
    expect(screen.queryByTestId('canvas-wire-flow-review-build')).toBeNull();
    expect(screen.getByRole('img')).toHaveAttribute('data-wire-kind', 'feedback');
    rerender(<WirePlane {...props} round={2} />);
    expect(screen.getByTestId('canvas-wire-flow-review-build')).toBeInTheDocument();
  });

  it('selects with click or keyboard while retaining deliberate double-click disconnect', () => {
    const onSelectEdge = vi.fn();
    const onDisconnect = vi.fn();
    const background = vi.fn();
    render(<div onPointerDown={background}><WirePlane nodes={nodes} edges={[edge]} onSelectEdge={onSelectEdge} onDisconnect={onDisconnect} selectedEdgeId={edge.id} /></div>);
    const hit = screen.getByTestId('canvas-wire-hit-review-build');
    fireEvent.pointerDown(hit);
    expect(background).not.toHaveBeenCalled();
    fireEvent.click(hit);
    expect(onSelectEdge).toHaveBeenLastCalledWith(edge.id);
    expect(onDisconnect).not.toHaveBeenCalled();
    fireEvent.doubleClick(hit);
    expect(onDisconnect).toHaveBeenLastCalledWith(edge);
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(onSelectEdge).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(button, { key: 'Delete' });
    expect(onDisconnect).toHaveBeenCalledTimes(2);
  });

  it('keeps selection available without leaking delete or double-click gestures while disconnect is locked', () => {
    const onSelectEdge = vi.fn();
    const backgroundDelete = vi.fn();
    const backgroundDoubleClick = vi.fn();
    render(<div onKeyDown={backgroundDelete} onDoubleClick={backgroundDoubleClick}><WirePlane nodes={nodes} edges={[edge]} onSelectEdge={onSelectEdge} /></div>);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Delete' });
    fireEvent.doubleClick(screen.getByTestId('canvas-wire-hit-review-build'));
    expect(backgroundDelete).not.toHaveBeenCalled();
    expect(backgroundDoubleClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('canvas-wire-hit-review-build'));
    expect(onSelectEdge).toHaveBeenLastCalledWith(edge.id);
  });

  it('does not draw edges with missing endpoint ports', () => {
    render(<WirePlane nodes={nodes} edges={[{ ...edge, toPort: 'missing' }]} />);
    expect(screen.queryByTestId('canvas-wire-review-build')).toBeNull();
  });

  it('uses independent marker ids when multiple canvases render together', () => {
    const { container } = render(<><WirePlane nodes={nodes} edges={[edge]} /><WirePlane nodes={nodes} edges={[edge]} /></>);
    const ids = [...container.querySelectorAll('marker')].map(marker => marker.id);
    expect(new Set(ids).size).toBe(2);
  });
});
