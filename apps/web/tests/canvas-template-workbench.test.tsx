import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SessionTile } from '../src/canvas/SessionTile';
import { AGENT_TEMPLATES, createAgentTemplate } from '../src/canvas/agentTemplates';
import type { CanvasNode } from '../src/canvas/canvasDoc';
import { resetAllSessions } from '../src/canvas/sessions';

beforeEach(() => { cleanup(); resetAllSessions(); });

it('adds role-specific starters to only the active Session draft, without sending or replacing existing work', () => {
  const onSend = vi.fn();
  const role = AGENT_TEMPLATES.find(item => item.id === 'frontend')!;
  function Harness() {
    const [node, setNode] = useState<CanvasNode>(createAgentTemplate('frontend', { x: 0, y: 0 }));
    return <SessionTile node={node} scale={1} focused onSend={onSend} onUpdateNode={setNode} />;
  }
  render(<Harness />);
  expect(screen.getByText(role.emptyTitle)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: role.starterPrompts[0].label }));
  expect(screen.getByTestId('composer-input')).toHaveValue(role.starterPrompts[0].prompt);
  expect(screen.getByTestId('composer-send')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: role.starterPrompts[1].label }));
  const combined = `${role.starterPrompts[0].prompt}\n\n${role.starterPrompts[1].prompt}`;
  expect(screen.getByTestId('composer-input')).toHaveValue(combined);
  fireEvent.click(screen.getByRole('button', { name: '展开 Session 列表' }));
  fireEvent.click(screen.getByRole('button', { name: '新建 Session' }));
  expect(screen.getByTestId('composer-input')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: '打开 Session 1' }));
  expect(screen.getByTestId('composer-input')).toHaveValue(combined);
  expect(onSend).not.toHaveBeenCalled();
});

it('keeps the role after renaming and shows the actual customized form in its optional guide', () => {
  const node = createAgentTemplate('users', { x: 0, y: 0 });
  node.title = '会员中心';
  node.contract!.inputs[0].label = '本项目角色说明';
  render(<SessionTile node={node} scale={1} focused onUpdateNode={vi.fn()} />);
  expect(screen.getByTestId(`canvas-tile-${node.id}`)).toHaveAttribute('data-template', 'users');
  expect(screen.queryByRole('region', { name: '模板指引' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '模板指引' }));
  const guide = screen.getByRole('region', { name: '模板指引' });
  expect(within(guide).getByText('本项目角色说明')).toBeTruthy();
  expect(within(guide).getByText('用户系统')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '输入', exact: true }));
  expect(screen.queryByRole('region', { name: '模板指引' })).toBeNull();
  expect(screen.getByRole('region', { name: '输入表单' })).toBeTruthy();
});

it('keeps guidance and starters out of compact nodes and prevents edits while locked', () => {
  const node = createAgentTemplate('materials', { x: 0, y: 0 });
  const onUpdate = vi.fn();
  const role = AGENT_TEMPLATES.find(item => item.id === 'materials')!;
  const { rerender } = render(<SessionTile node={node} compact scale={1} focused={false} onUpdateNode={onUpdate} />);
  expect(screen.queryByRole('button', { name: '模板指引' })).toBeNull();
  expect(screen.queryByRole('button', { name: role.starterPrompts[0].label })).toBeNull();
  rerender(<SessionTile node={node} scale={1} focused interactionLocked onUpdateNode={onUpdate} />);
  expect(screen.getByRole('button', { name: role.starterPrompts[0].label })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: role.starterPrompts[0].label }));
  expect(onUpdate).not.toHaveBeenCalled();
});
