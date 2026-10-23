import type { Dispatch, RefObject, SetStateAction } from "react";
import { isImeEnterEvent } from "../../../utils/ime";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import type { SlashCommand } from "./useSlashCommands";

/**
 * 斜杠菜单的交互实现（插入命令 + 键盘导航）。
 *
 * 从 `useSlashCommands` 的两个 `useCallback` 整体搬出（#646 B2.4），函数体逐字未改；
 * 所有状态经 deps 传入，模块内不调用 hook。
 */

type InsertCommandIntoInputDeps = {
  input: string;
  slashPosition: number;
  setInput: Dispatch<SetStateAction<string>>;
  externalInputValueRef?: { current: string };
  resetCommandMenuState: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

// Insert the picked command name into the textarea and leave the caret right
// after `<command> `. We DO NOT auto-submit — the user reviews/edits args
// and presses Enter themselves, mirroring how the TUI behaves and avoiding
// surprise sends from slash suggestions that still need arguments.
//
// The replacement spans from the active `/` to the next whitespace so a
// partial query like `hello /skill_inst` becomes `hello /skill_install ` and
// any trailing text after the query is preserved.
export const insertCommandIntoInput = (
  command: SlashCommand,
  {
    input,
    slashPosition,
    setInput,
    externalInputValueRef,
    resetCommandMenuState,
    textareaRef,
  }: InsertCommandIntoInputDeps,
) => {
  // Fall back to slash-prepend when no active slashPosition exists (e.g.
  // mouse click without prior typing). Keep existing input intact.
  const slashStart = slashPosition >= 0 ? slashPosition : input.length;
  const textBeforeSlash = input.slice(0, slashStart);
  const textAfterSlash = input.slice(slashStart);
  const spaceIndex = textAfterSlash.indexOf(" ");
  const textAfterQuery = spaceIndex !== -1 ? textAfterSlash.slice(spaceIndex) : "";
  const head = `${textBeforeSlash}${command.name} `;
  const newInput = `${head}${textAfterQuery}`;

  setInput(newInput);
  if (externalInputValueRef) {
    externalInputValueRef.current = newInput;
  }
  resetCommandMenuState();

  // Defer focus + caret placement until after React commits the new input
  // value; otherwise selectionStart points into stale text.
  const caret = head.length;
  setTimeout(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    try {
      ta.setSelectionRange(caret, caret);
    } catch {
      // Ignore: setSelectionRange throws on unfocused/hidden inputs in some browsers.
    }
  }, UI_TIMEOUTS.NEXT_TASK_MS);
};

type CommandMenuKeyDownDeps = {
  showCommandMenu: boolean;
  displayedCommands: SlashCommand[];
  resetCommandMenuState: () => void;
  dismissCommandMenu: () => void;
  selectCommandFromKeyboard: (command: SlashCommand) => void;
  selectedCommandIndex: number;
  setSelectedCommandIndex: Dispatch<SetStateAction<number>>;
};

/** 只依赖键盘事件的最小字段，便于直测；React 事件结构上兼容。 */
export type CommandMenuKeyEvent = {
  key: string;
  preventDefault: () => void;
  isComposing?: boolean;
  keyCode?: number;
  which?: number;
  nativeEvent?: {
    keyCode?: number;
    which?: number;
    isComposing?: boolean;
  };
};

export const handleCommandMenuKeyDown = (
  event: CommandMenuKeyEvent,
  {
    showCommandMenu,
    displayedCommands,
    resetCommandMenuState,
    dismissCommandMenu,
    selectCommandFromKeyboard,
    selectedCommandIndex,
    setSelectedCommandIndex,
  }: CommandMenuKeyDownDeps,
): boolean => {
  if (!showCommandMenu) {
    return false;
  }

  if (!displayedCommands.length) {
    if (event.key === "Escape") {
      event.preventDefault();
      resetCommandMenuState();
      return true;
    }
    return false;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    setSelectedCommandIndex(previousIndex => (previousIndex < displayedCommands.length - 1 ? previousIndex + 1 : 0));
    return true;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    setSelectedCommandIndex(previousIndex => (previousIndex > 0 ? previousIndex - 1 : displayedCommands.length - 1));
    return true;
  }

  if (event.key === "Tab" || event.key === "Enter") {
    if (isImeEnterEvent(event)) {
      return false;
    }
    event.preventDefault();
    if (selectedCommandIndex >= 0) {
      selectCommandFromKeyboard(displayedCommands[selectedCommandIndex]);
    } else if (displayedCommands.length > 0) {
      selectCommandFromKeyboard(displayedCommands[0]);
    }
    return true;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    dismissCommandMenu();
    return true;
  }

  return false;
};
