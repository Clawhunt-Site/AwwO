import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SessionTile } from '../src/canvas/SessionTile';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { type CanvasNode } from '../src/canvas/canvasDoc';
import { resetAllSessions } from '../src/canvas/sessions';

beforeEach(() => { cleanup(); resetAllSessions(); });

function Harness() {
  const [node, setNode] = useState<CanvasNode>({ ...createAgentTemplate('general', { x: 0, y: 0 }), id: 'workbench', binding: { companyId: 'c', agentId: 'a', agentName: 'Agent' } });
  return <SessionTile node={node} scale={1} focused onSend={vi.fn()} onUpdateNode={setNode} />;
}

it('keeps Session management and chat inside the node, with deliverables collapsed initially', () => {
  render(<Harness />);
  const tile = screen.getByTestId('canvas-tile-workbench');
  expect(within(tile).queryByRole('navigation', { name: 'Session 管理' })).toBeNull();
  fireEvent.click(within(tile).getByRole('button', { name: '展开 Session 列表' }));
  expect(within(tile).getByRole('navigation', { name: 'Session 管理' })).toBeTruthy();
  expect(within(tile).getByTestId('composer-input')).toBeTruthy();
  expect(within(tile).queryByRole('region', { name: '交付物' })).toBeNull();
  fireEvent.click(within(tile).getByRole('button', { name: '展开交付物' }));
  expect(within(tile).getByRole('region', { name: '交付物' })).toBeTruthy();
  expect(within(tile).getByTestId('composer-input')).toBeTruthy();
  expect(within(tile).queryByRole('tablist')).toBeNull();
});

it('creates and switches real local Sessions while retaining each unsent draft', () => {
  render(<Harness />);
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '第一段草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '展开 Session 列表' }));
  fireEvent.click(screen.getByRole('button', { name: '新建 Session' }));
  expect(screen.getByTestId('composer-input')).toHaveValue('');
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '第二段草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '打开 Session 1' }));
  expect(screen.getByTestId('composer-input')).toHaveValue('第一段草稿');
  fireEvent.click(screen.getByRole('button', { name: '打开 Session 2' }));
  expect(screen.getByTestId('composer-input')).toHaveValue('第二段草稿');
});
