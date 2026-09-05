import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';

import {
  QUICK_CREATE_COMMANDS,
} from '../model/canvasProWorkspace';
import type { QuickCreateCommand } from '../model/canvasProWorkspace';

interface CanvasProQuickCommandsOptions {
  quickPromptInputRef: RefObject<HTMLInputElement>;
}

export function useCanvasProQuickCommands({ quickPromptInputRef }: CanvasProQuickCommandsOptions) {
  const [quickPrompt, setQuickPrompt] = useState('');
  const [quickCommandIndex, setQuickCommandIndex] = useState(0);
  const [quickCommandOpen, setQuickCommandOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  const quickCommandQuery = useMemo(() => {
    const trimmed = quickPrompt.trimStart();
    if (!trimmed.startsWith('/')) return '';
    return trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase() || '';
  }, [quickPrompt]);

  const visibleQuickCommands = useMemo(() => {
    if (!quickPrompt.trimStart().startsWith('/')) return QUICK_CREATE_COMMANDS;
    const query = quickCommandQuery;
    if (!query) return QUICK_CREATE_COMMANDS;
    return QUICK_CREATE_COMMANDS.filter((command) =>
      command.aliases.some((alias) => alias.toLowerCase().startsWith(query)),
    );
  }, [quickCommandQuery, quickPrompt]);

  useEffect(() => {
    setQuickCommandIndex(0);
  }, [quickCommandQuery]);

  useEffect(() => {
    if (visibleQuickCommands.length === 0) {
      setQuickCommandIndex(0);
      return;
    }
    setQuickCommandIndex((index) => Math.min(index, visibleQuickCommands.length - 1));
  }, [visibleQuickCommands.length]);

  const insertQuickCommand = useCallback((command: QuickCreateCommand) => {
    setQuickPrompt(`/${command.command} `);
    setAddMenuOpen(false);
    setQuickCommandOpen(false);
    window.requestAnimationFrame(() => {
      quickPromptInputRef.current?.focus();
    });
  }, [quickPromptInputRef]);

  return {
    addMenuOpen,
    insertQuickCommand,
    quickCommandIndex,
    quickCommandOpen,
    quickCommandQuery,
    quickPrompt,
    setAddMenuOpen,
    setQuickCommandIndex,
    setQuickCommandOpen,
    setQuickPrompt,
    visibleQuickCommands,
  };
}
