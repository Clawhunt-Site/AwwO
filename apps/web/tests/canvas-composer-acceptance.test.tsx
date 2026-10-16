import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TileComposer } from '../src/canvas/TileComposer';

afterEach(cleanup);
it('retains the draft until the host confirms durable acceptance', () => {
  let accepted: (() => void) | undefined;
  const send = vi.fn((_message: string, callback?: () => void) => { accepted = callback; });
  render(<TileComposer deferClear streaming={false} onSend={send} />);
  const input = screen.getByTestId('composer-input');
  fireEvent.change(input, { target: { value: 'Keep this request if the host refuses.' } });
  fireEvent.click(screen.getByTestId('composer-send'));
  expect(input).toHaveValue('Keep this request if the host refuses.');
  expect(send).toHaveBeenCalledOnce();
  act(() => accepted?.());
  expect(input).toHaveValue('');
});
it('keeps the standing notice against personal or sensitive information in 用户须知, and as the input’s description', () => {
  render(<TileComposer streaming={false} onSend={vi.fn()} notice="在当前 Session 继续对话。" />);
  // Nothing is printed around the box any more; the full notice still describes the input for a screen reader.
  expect(screen.queryByText(/AI can be wrong · Don’t share sensitive data|AI 内容仅供参考 · 勿输入敏感信息/)).toBeNull();
  expect(screen.queryByText('在当前 Session 继续对话。')).toBeNull();
  expect(screen.getByTestId('composer-input')).toHaveAccessibleDescription(/Don’t enter personal or sensitive data|请勿输入身份证号/);
  const button = screen.getByRole('button', { name: /用户须知|Good to know/ });
  expect(button).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(button);
  expect(button).toHaveAttribute('aria-expanded', 'true');
  const notes = screen.getByRole('region', { name: /用户须知|Good to know/ });
  expect(notes).toHaveTextContent('在当前 Session 继续对话。');
  expect(notes).toHaveTextContent(/Don’t enter personal or sensitive data|请勿输入身份证号/);
  // A click elsewhere closes it.
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('region', { name: /用户须知|Good to know/ })).toBeNull();
});
it('closes 用户须知 when its button is no longer laid out (the assistant’s panel stepping aside for an open node)', () => {
  // The list lives in a layer of its own on the page, so it outlived a panel hidden under it (found in review).
  const observed: Array<() => void> = [];
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observed.push(callback); } observe() {} unobserve() {} disconnect() {} });
  try {
    render(<TileComposer streaming={false} onSend={vi.fn()} />);
    const button = screen.getByRole('button', { name: /用户须知|Good to know/ });
    fireEvent.click(button);
    const laidOut = vi.spyOn(button, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    act(() => observed.forEach(callback => callback()));
    expect(screen.getByRole('region', { name: /用户须知|Good to know/ })).toBeTruthy();
    laidOut.mockReturnValue([] as unknown as DOMRectList);
    act(() => observed.forEach(callback => callback()));
    expect(screen.queryByRole('region', { name: /用户须知|Good to know/ })).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
it('leaves the notice out of a composer that is blocked, as for a view-only reader', () => {
  render(<TileComposer blocked streaming={false} onSend={vi.fn()} />);
  expect(screen.queryByText(/Don’t enter personal or sensitive data|请勿输入身份证号/)).toBeNull();
  expect(screen.queryByRole('button', { name: /用户须知|Good to know/ })).toBeNull();
});
