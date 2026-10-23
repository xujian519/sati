import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from "react";
import Fuse from "fuse.js";
import { logError } from "../../../utils/logging";
import type { Project } from "../../../types/app";
import { loadSlashCommands, readCommandHistory, saveCommandHistory } from "./slashCommandSources";
import {
  handleCommandMenuKeyDown as handleCommandMenuKeyDownImpl,
  insertCommandIntoInput as insertCommandIntoInputImpl,
} from "./slashCommandInteractions";

const COMMAND_QUERY_DEBOUNCE_MS = 150;

export interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface UseSlashCommandsOptions {
  selectedProject: Project | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  inputValueRef?: { current: string };
}

const getCommandKey = (command: SlashCommand) =>
  `${command.name}::${command.namespace || command.type || "other"}::${command.path || ""}`;

const getCommandNamespace = (command: SlashCommand) => command.namespace || command.type || "other";

const groupCommandsForDisplay = (commands: SlashCommand[], frequentCommands: SlashCommand[]): SlashCommand[] => {
  const preferredOrder =
    frequentCommands.length > 0
      ? ["pinned", "frequent", "builtin", "project", "user", "other"]
      : ["pinned", "builtin", "project", "user", "other"];
  const groups = new Map<string, SlashCommand[]>();
  const frequentCommandKeys = new Set(frequentCommands.map(getCommandKey));

  for (const command of commands) {
    if (frequentCommandKeys.has(getCommandKey(command))) {
      continue;
    }
    const namespace = getCommandNamespace(command);
    const group = groups.get(namespace) || [];
    group.push(command);
    groups.set(namespace, group);
  }

  if (frequentCommands.length > 0) {
    groups.set(
      "frequent",
      frequentCommands.map(command => ({
        ...command,
        namespace: "frequent",
      })),
    );
  }

  const extraNamespaces = [...groups.keys()].filter(namespace => !preferredOrder.includes(namespace));
  return [...preferredOrder, ...extraNamespaces].flatMap(namespace => groups.get(namespace) || []);
};

export function useSlashCommands({
  selectedProject,
  input,
  setInput,
  textareaRef,
  inputValueRef: externalInputValueRef,
}: UseSlashCommandsOptions) {
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [filteredCommands, setFilteredCommands] = useState<SlashCommand[]>([]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(-1);
  const [slashPosition, setSlashPosition] = useState(-1);

  const commandQueryTimerRef = useRef<number | null>(null);

  const clearCommandQueryTimer = useCallback(() => {
    if (commandQueryTimerRef.current !== null) {
      window.clearTimeout(commandQueryTimerRef.current);
      commandQueryTimerRef.current = null;
    }
  }, []);

  const resetCommandMenuState = useCallback(() => {
    setShowCommandMenu(false);
    setSlashPosition(-1);
    setCommandQuery("");
    setSelectedCommandIndex(-1);
    clearCommandQueryTimer();
  }, [clearCommandQueryTimer]);

  const dismissCommandMenu = useCallback(() => {
    if (showCommandMenu && slashPosition >= 0) {
      setInput(prev => {
        const before = prev.slice(0, slashPosition);
        const after = prev.slice(slashPosition);
        const spaceIdx = after.indexOf(" ");
        const tail = spaceIdx !== -1 ? after.slice(spaceIdx) : "";
        const next = (before + tail).replace(/^\s+$/, "");
        return next;
      });
    }
    resetCommandMenuState();
  }, [showCommandMenu, slashPosition, setInput, resetCommandMenuState]);

  useEffect(() => {
    if (!selectedProject) {
      setSlashCommands([]);
      setFilteredCommands([]);
      return;
    }

    loadSlashCommands(selectedProject)
      .then(setSlashCommands)
      .catch(error => {
        logError("Error fetching slash commands:", error);
        setSlashCommands([]);
      });
  }, [selectedProject]);

  useEffect(() => {
    if (!showCommandMenu) {
      setSelectedCommandIndex(-1);
    }
  }, [showCommandMenu]);

  const fuse = useMemo(() => {
    if (!slashCommands.length) {
      return null;
    }

    return new Fuse(slashCommands, {
      keys: [
        { name: "name", weight: 2 },
        { name: "description", weight: 1 },
      ],
      threshold: 0.4,
      includeScore: true,
      minMatchCharLength: 1,
    });
  }, [slashCommands]);

  useEffect(() => {
    if (!commandQuery) {
      setFilteredCommands(slashCommands);
      return;
    }

    if (!fuse) {
      setFilteredCommands([]);
      return;
    }

    const results = fuse.search(commandQuery);
    setFilteredCommands(results.map(result => result.item));
  }, [commandQuery, slashCommands, fuse]);

  const frequentCommands = useMemo(() => {
    if (!selectedProject || slashCommands.length === 0) {
      return [];
    }

    const parsedHistory = readCommandHistory(selectedProject.name);

    return slashCommands
      .map(command => ({
        ...command,
        usageCount: parsedHistory[command.name] || 0,
      }))
      .filter(command => command.usageCount > 0)
      .sort((commandA, commandB) => commandB.usageCount - commandA.usageCount)
      .slice(0, 5);
  }, [selectedProject, slashCommands]);

  const displayedCommands = useMemo(() => {
    return groupCommandsForDisplay(filteredCommands, commandQuery ? [] : frequentCommands);
  }, [commandQuery, filteredCommands, frequentCommands]);

  useEffect(() => {
    if (!showCommandMenu) {
      return;
    }

    setSelectedCommandIndex(previousIndex => {
      if (displayedCommands.length === 0) {
        return -1;
      }
      if (previousIndex >= displayedCommands.length) {
        return displayedCommands.length - 1;
      }
      return previousIndex;
    });
  }, [displayedCommands.length, showCommandMenu]);

  const trackCommandUsage = useCallback(
    (command: SlashCommand) => {
      if (!selectedProject) {
        return;
      }

      const parsedHistory = readCommandHistory(selectedProject.name);
      parsedHistory[command.name] = (parsedHistory[command.name] || 0) + 1;
      saveCommandHistory(selectedProject.name, parsedHistory);
    },
    [selectedProject],
  );

  const insertCommandIntoInput = useCallback(
    (command: SlashCommand) =>
      insertCommandIntoInputImpl(command, {
        input,
        slashPosition,
        setInput,
        externalInputValueRef,
        resetCommandMenuState,
        textareaRef,
      }),
    [externalInputValueRef, input, slashPosition, setInput, resetCommandMenuState, textareaRef],
  );

  const selectCommandFromKeyboard = useCallback(
    (command: SlashCommand) => {
      trackCommandUsage(command);
      insertCommandIntoInput(command);
    },
    [trackCommandUsage, insertCommandIntoInput],
  );

  const handleCommandSelect = useCallback(
    (command: SlashCommand | null, index: number, isHover: boolean) => {
      if (!command || !selectedProject) {
        return;
      }

      if (isHover) {
        setSelectedCommandIndex(index);
        return;
      }

      trackCommandUsage(command);
      insertCommandIntoInput(command);
    },
    [selectedProject, trackCommandUsage, insertCommandIntoInput],
  );

  const handleToggleCommandMenu = useCallback(() => {
    const isOpening = !showCommandMenu;
    setShowCommandMenu(isOpening);
    setCommandQuery("");
    setSelectedCommandIndex(-1);

    if (isOpening) {
      setFilteredCommands(slashCommands);
    }

    textareaRef.current?.focus();
  }, [showCommandMenu, slashCommands, textareaRef]);

  const handleCommandInputChange = useCallback(
    (value?: string, cursorPos?: number) => {
      if (value === undefined || cursorPos === undefined) {
        resetCommandMenuState();
        return;
      }

      const textBeforeCursor = value.slice(0, cursorPos);
      const slashMatch = textBeforeCursor.match(/(^|\s)(\/)(\S*)$/);

      if (!slashMatch) {
        resetCommandMenuState();
        return;
      }

      const slashIdx = textBeforeCursor.lastIndexOf("/");
      const query = slashMatch[3] || "";

      setSlashPosition(slashIdx);
      setShowCommandMenu(true);
      setSelectedCommandIndex(query ? -1 : 0);

      clearCommandQueryTimer();
      commandQueryTimerRef.current = window.setTimeout(() => {
        setCommandQuery(query);
      }, COMMAND_QUERY_DEBOUNCE_MS);
    },
    [resetCommandMenuState, clearCommandQueryTimer],
  );

  const handleCommandMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean =>
      handleCommandMenuKeyDownImpl(event, {
        showCommandMenu,
        displayedCommands,
        resetCommandMenuState,
        dismissCommandMenu,
        selectCommandFromKeyboard,
        selectedCommandIndex,
        setSelectedCommandIndex,
      }),
    [
      showCommandMenu,
      displayedCommands,
      resetCommandMenuState,
      dismissCommandMenu,
      selectCommandFromKeyboard,
      selectedCommandIndex,
      setSelectedCommandIndex,
    ],
  );

  useEffect(
    () => () => {
      clearCommandQueryTimer();
    },
    [clearCommandQueryTimer],
  );

  return {
    slashCommands,
    slashCommandsCount: slashCommands.length,
    filteredCommands: displayedCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    dismissCommandMenu,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  };
}
