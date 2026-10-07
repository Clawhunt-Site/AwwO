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
it('shows the standing notice against personal or sensitive information under the input', () => {
  render(<TileComposer streaming={false} onSend={vi.fn()} />);
  expect(screen.getByText(/Don’t enter personal or sensitive data|请勿输入身份证号/)).toBeVisible();
  expect(screen.getByTestId('composer-input')).toHaveAccessibleDescription(/Don’t enter personal or sensitive data|请勿输入身份证号/);
});
it('leaves the notice out of a composer that is blocked, as for a view-only reader', () => {
  render(<TileComposer blocked streaming={false} onSend={vi.fn()} />);
  expect(screen.queryByText(/Don’t enter personal or sensitive data|请勿输入身份证号/)).toBeNull();
});
