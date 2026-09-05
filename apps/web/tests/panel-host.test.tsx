import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { FileText, Globe, ListTodo } from 'lucide-react';
import { ConversationTabHost } from '../src/ui/PanelHost';
import type { ConversationTab, NewTabOption, TabKind, TabMeta } from '../src/ui/PanelHost';

afterEach(cleanup);

const LABELS = {
  region: 'Panel',
  close: 'Close panel',
  newTab: 'New tab',
  newTabMenu: 'New tab',
  closeTab: 'Close tab',
};

const NEW_TAB_OPTIONS: NewTabOption[] = [
  { kind: 'web', label: 'Web page', icon: Globe },
  { kind: 'plan', label: 'Plan', icon: ListTodo },
];

function tabMeta(tab: ConversationTab): TabMeta {
  switch (tab.kind) {
    case 'web':
      return { icon: Globe, title: tab.url || 'New tab' };
    case 'file':
      return { icon: FileText, title: tab.path || 'New tab' };
    case 'plan':
      return { icon: ListTodo, title: 'Plan' };
  }
}

function Harness({
  initialTabs,
  initialActive,
  onNewTab,
  resizeHandle,
}: {
  initialTabs: ConversationTab[];
  initialActive: string | null;
  onNewTab?: (kind: TabKind) => void;
  resizeHandle?: ReactNode;
}) {
  const [tabs, setTabs] = useState<ConversationTab[]>(initialTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(initialActive);
  return (
    <ConversationTabHost
      tabs={tabs}
      activeTabId={activeTabId}
      id="conversation-panel"
      tabMeta={tabMeta}
      renderContent={(tab) => <p>{`content:${tab.kind}:${tab.id}`}</p>}
      emptyState={<p>no tabs open</p>}
      newTabOptions={NEW_TAB_OPTIONS}
      labels={LABELS}
      resizeHandle={resizeHandle}
      onSelectTab={(id) => setActiveTabId(id)}
      onCloseTab={(id) =>
        setTabs((prev) => {
          const index = prev.findIndex((tab) => tab.id === id);
          const next = prev.filter((tab) => tab.id !== id);
          setActiveTabId((current) =>
            current !== id ? current : next.length === 0 ? null : (next[index] ?? next[index - 1] ?? next[0]).id,
          );
          return next;
        })
      }
      onNewTab={(kind) => onNewTab?.(kind)}
      onClose={() => {}}
    />
  );
}

describe('ConversationTabHost', () => {
  it('renders the active tab content and switches tabs on click', () => {
    render(
      <Harness
        initialTabs={[
          { id: 'a', kind: 'plan' },
          { id: 'b', kind: 'web', url: 'example.com' },
        ]}
        initialActive="a"
      />,
    );
    expect(screen.getByText('content:plan:a')).toBeInTheDocument();
    // switch to the web tab
    fireEvent.click(screen.getByRole('tab', { name: /example\.com/ }));
    expect(screen.getByText('content:web:b')).toBeInTheDocument();
    expect(screen.queryByText('content:plan:a')).not.toBeInTheDocument();
  });

  it('marks exactly the active tab as selected', () => {
    render(
      <Harness
        initialTabs={[
          { id: 'a', kind: 'plan' },
          { id: 'b', kind: 'web', url: 'neighbour.example' },
        ]}
        initialActive="b"
      />,
    );
    expect(screen.getByRole('tab', { name: /neighbour\.example/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Plan' })).toHaveAttribute('aria-selected', 'false');
  });

  it('closes a tab and falls the active selection onto a neighbour', () => {
    render(
      <Harness
        initialTabs={[
          { id: 'a', kind: 'plan' },
          { id: 'b', kind: 'web', url: 'neighbour.example' },
        ]}
        initialActive="a"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close tab: Plan' }));
    // 'a' is gone; the neighbour 'b' is now shown
    expect(screen.queryByRole('tab', { name: 'Plan' })).not.toBeInTheDocument();
    expect(screen.getByText('content:web:b')).toBeInTheDocument();
  });

  it('shows the empty state when the last tab is closed', () => {
    render(<Harness initialTabs={[{ id: 'a', kind: 'plan' }]} initialActive="a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close tab: Plan' }));
    expect(screen.getByText('no tabs open')).toBeInTheDocument();
  });

  it('renders an optional resize handle when provided', () => {
    render(
      <Harness
        initialTabs={[{ id: 'a', kind: 'plan' }]}
        initialActive="a"
        resizeHandle={<div role="separator" aria-label="Resize panel" />}
      />,
    );
    expect(screen.getByRole('separator', { name: 'Resize panel' })).toBeInTheDocument();
  });

  it('omits the resize handle when none is provided', () => {
    render(<Harness initialTabs={[{ id: 'a', kind: 'plan' }]} initialActive="a" />);
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('opens the new-tab menu and reports the chosen kind', () => {
    const onNewTab = vi.fn();
    render(<Harness initialTabs={[{ id: 'a', kind: 'plan' }]} initialActive="a" onNewTab={onNewTab} />);
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Web page' }));
    expect(onNewTab).toHaveBeenCalledWith('web');
  });
});
