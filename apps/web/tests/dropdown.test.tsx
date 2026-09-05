// Component-level coverage for the in-page dropdown framework (ui/Dropdown.tsx):
// the semantics that the app-shell integration tests don't reach — outside-close
// vs wrapping-label clicks, keyboard focus hand-off, combo blur/filter behavior,
// and the empty "clear back to unset" option that mirrors native <select>.
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
import { ComboInput, Dropdown, type DropdownOption } from '../src/ui/Dropdown';

const OPTIONS: DropdownOption[] = [
  { value: '', label: 'Select an option…' },
  { value: 'claude', label: 'Claude Code', description: 'default worker' },
  { value: 'codex', label: 'Codex CLI' },
  { value: 'frozen', label: 'Frozen backend', disabled: true },
];

function ControlledDropdown({ initial = 'claude', wrapInLabel = false }: { initial?: string; wrapInLabel?: boolean }) {
  const [value, setValue] = useState(initial);
  const dropdown = (
    <Dropdown ariaLabel="Backend" value={value} options={OPTIONS} onChange={setValue} />
  );
  return wrapInLabel ? (
    <label>
      Backend label text
      {dropdown}
    </label>
  ) : (
    dropdown
  );
}

function ControlledCombo({ suggestions }: { suggestions: DropdownOption[] }) {
  const [value, setValue] = useState('');
  return <ComboInput ariaLabel="Model" value={value} suggestions={suggestions} onChange={setValue} />;
}

describe('Dropdown', () => {
  it('opens on trigger click, selects an option, and closes', async () => {
    render(<ControlledDropdown />);
    const trigger = screen.getByRole('button', { name: 'Backend' });
    expect(trigger).toHaveTextContent('Claude Code');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(await screen.findByRole('option', { name: /Codex CLI/ }));

    expect(trigger).toHaveTextContent('Codex CLI');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  it('selecting the empty option clears back to unset', async () => {
    render(<ControlledDropdown />);
    const trigger = screen.getByRole('button', { name: 'Backend' });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: 'Select an option…' }));
    expect(trigger).toHaveTextContent('Select an option…');
  });

  it('ignores clicks on disabled options', async () => {
    render(<ControlledDropdown />);
    const trigger = screen.getByRole('button', { name: 'Backend' });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: 'Frozen backend' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(trigger).toHaveTextContent('Claude Code');
  });

  it('closes on outside pointerdown but not on wrapping-label pointerdown', async () => {
    render(<ControlledDropdown wrapInLabel />);
    const trigger = screen.getByRole('button', { name: 'Backend' });
    fireEvent.click(trigger);
    expect(await screen.findByRole('listbox')).toBeInTheDocument();

    // pointerdown on the wrapping label is treated as inside: the browser will
    // forward the click to the trigger, which owns the toggle
    fireEvent.pointerDown(screen.getByText('Backend label text'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  it('supports keyboard navigation and Escape returns focus to the trigger', async () => {
    render(<ControlledDropdown />);
    const trigger = screen.getByRole('button', { name: 'Backend' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const listbox = await screen.findByRole('listbox');

    // highlight starts on the selected option (claude); ArrowDown moves to codex
    expect(listbox).toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(trigger).toHaveTextContent('Codex CLI');

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(await screen.findByRole('listbox'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('names the portaled listbox after the trigger', async () => {
    render(<ControlledDropdown />);
    fireEvent.click(screen.getByRole('button', { name: 'Backend' }));
    expect(await screen.findByRole('listbox', { name: 'Backend' })).toBeInTheDocument();
  });
});

describe('ComboInput', () => {
  const SUGGESTIONS: DropdownOption[] = [
    { value: 'claude-fable-5', label: 'claude-fable-5' },
    { value: 'claude-opus-4-8', label: 'claude-opus-4-8' },
    { value: 'gpt-5.5', label: 'GPT 5.5' },
  ];

  it('opens on focus, filters by value and label, and fills on selection', async () => {
    render(<ControlledCombo suggestions={SUGGESTIONS} />);
    const input = screen.getByRole('combobox', { name: 'Model' });
    fireEvent.focus(input);
    expect(await screen.findAllByRole('option')).toHaveLength(3);

    // filter matches the display label, not only the value
    fireEvent.change(input, { target: { value: 'GPT' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('option', { name: /GPT 5.5/ }));
    expect(input).toHaveValue('gpt-5.5');
  });

  it('drops aria-expanded when the filter has no matches', async () => {
    render(<ControlledCombo suggestions={SUGGESTIONS} />);
    const input = screen.getByRole('combobox', { name: 'Model' });
    fireEvent.focus(input);
    expect(input).toHaveAttribute('aria-expanded', 'true');

    fireEvent.change(input, { target: { value: 'no-such-model' } });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-controls');
  });

  it('closes the menu when focus leaves the input', async () => {
    render(<ControlledCombo suggestions={SUGGESTIONS} />);
    const input = screen.getByRole('combobox', { name: 'Model' });
    fireEvent.focus(input);
    expect(await screen.findByRole('listbox')).toBeInTheDocument();

    fireEvent.blur(input);
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  it('keyboard-selects a highlighted suggestion with Enter', async () => {
    render(<ControlledCombo suggestions={SUGGESTIONS} />);
    const input = screen.getByRole('combobox', { name: 'Model' });
    fireEvent.focus(input);
    await screen.findByRole('listbox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('claude-fable-5');
  });
});
