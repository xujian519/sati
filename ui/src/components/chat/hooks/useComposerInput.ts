import {
  useCallback,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  Dispatch,
  SetStateAction,
} from "react";
import { isImeEnterEvent } from "../../../utils/ime";
import type { ContentReference } from "../../../types/contentReference";
import { shouldCycleRunModeOnKeyDown } from "./useChatComposerState";
import type { ComposerSubmitHandler } from "./composerSubmit";
import type { useFileMentions } from "./useFileMentions";
import type { useSlashCommands } from "./useSlashCommands";

/**
 * 输入层：textarea 上的交互——受控输入的读写、光标插入、键位路由、滚动同步、展开/聚焦态。
 *
 * 从 `useChatComposerState.ts` 搬出（#159 N01 缝 3），**被搬代码逐字未改**。
 *
 * 与缝 1/缝 2 不同，这里**不把输入 state 搬进来**：`input`/`setInput`/`inputValueRef`/
 * `applyInputValue` 是斜杠命令层与文件提及层的入参，必须在它们之前就绪；而本层的
 * `handleKeyDown` 反过来要用那两个 hook 的返回值。若把 state 也搬进来就得再造两个后绑定
 * ref——得不偿失。故本 hook 只承载**逻辑**，状态仍由父级持有并作为入参传入。
 *
 * 两条 autosize effect 也**留在父级**：effect 的**相对顺序**是有语义的，搬动它们无法用
 * token 比对证明等价；它们需要的 `setIsTextareaExpanded` 由本 hook 返回。
 */

type ComposerInputOptions = {
  input: string;
  inputValueRef: RefObject<string>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  inputHighlightRef: RefObject<HTMLDivElement | null>;
  /** 输入框展开态 setter（state 留在父级：两条 autosize effect 在 hook 调用**之前**）。 */
  setIsTextareaExpanded: Dispatch<SetStateAction<boolean>>;
  /** 统一写输入框的入口（state + `inputValueRef` 成对同步）。 */
  applyInputValue: (value: string) => void;
  /** 输入变化时同步"忙碌队列快照"（本层只用 `input` 字段）。 */
  syncQueuedBusySendSnapshot: (updates: { input?: string }) => void;
  cancelBusySendQueue: () => void;
  setDocumentReferences: Dispatch<SetStateAction<ContentReference[]>>;
  onInputFocusChange?: (focused: boolean) => void;
  cycleRunMode: () => void;
  handleSubmit: ComposerSubmitHandler;
  sendByCtrlEnter?: boolean;
  /** 斜杠命令菜单的状态与键位处理（来自 `useSlashCommands`）。 */
  commandMenu: Pick<
    ReturnType<typeof useSlashCommands>,
    "showCommandMenu" | "resetCommandMenuState" | "handleCommandInputChange" | "handleCommandMenuKeyDown"
  >;
  /** 文件提及下拉的状态、光标位置与键位处理（来自 `useFileMentions`）。 */
  fileMentions: Pick<
    ReturnType<typeof useFileMentions>,
    "showFileDropdown" | "setCursorPosition" | "handleFileMentionsKeyDown"
  >;
};

type ComposerInputApi = {
  isInputFocused: boolean;
  handleInputFocusChange: (focused: boolean) => void;
  syncInputOverlayScroll: (target: HTMLTextAreaElement) => void;
  handleInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  insertAtCursor: (char: string) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  handleTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  handleTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  handleClearInput: () => void;
};

export function useComposerInput({
  input,
  inputValueRef,
  textareaRef,
  inputHighlightRef,
  setIsTextareaExpanded,
  applyInputValue,
  syncQueuedBusySendSnapshot,
  cancelBusySendQueue,
  setDocumentReferences,
  onInputFocusChange,
  cycleRunMode,
  handleSubmit,
  sendByCtrlEnter,
  commandMenu: { showCommandMenu, resetCommandMenuState, handleCommandInputChange, handleCommandMenuKeyDown },
  fileMentions: { showFileDropdown, setCursorPosition, handleFileMentionsKeyDown },
}: ComposerInputOptions): ComposerInputApi {
  const [isInputFocused, setIsInputFocused] = useState(false);

  const syncInputOverlayScroll = useCallback(
    (target: HTMLTextAreaElement) => {
      if (!inputHighlightRef.current || !target) {
        return;
      }
      inputHighlightRef.current.scrollTop = target.scrollTop;
      inputHighlightRef.current.scrollLeft = target.scrollLeft;
      // `inputHighlightRef` 是本 hook 的入参（ref 对象，身份稳定）。
    },
    [inputHighlightRef],
  );

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      applyInputValue(newValue);
      syncQueuedBusySendSnapshot({ input: newValue });
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = "auto";
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [
      applyInputValue,
      handleCommandInputChange,
      resetCommandMenuState,
      setCursorPosition,
      setIsTextareaExpanded,
      syncQueuedBusySendSnapshot,
    ],
  );

  const insertAtCursor = useCallback(
    (char: string) => {
      const textarea = textareaRef.current;
      const current = inputValueRef.current ?? input;
      const selectionStart = textarea?.selectionStart ?? current.length;
      const selectionEnd = textarea?.selectionEnd ?? selectionStart;
      const nextValue = `${current.slice(0, selectionStart)}${char}${current.slice(selectionEnd)}`;
      const nextCursor = selectionStart + char.length;

      applyInputValue(nextValue);
      syncQueuedBusySendSnapshot({ input: nextValue });
      setCursorPosition(nextCursor);

      if (char === "/") {
        handleCommandInputChange(nextValue, nextCursor);
      }

      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        if (!node.matches(":focus")) {
          node.focus();
        }
        try {
          node.setSelectionRange(nextCursor, nextCursor);
        } catch {
          // ignore: textarea may have been unmounted between frames
        }
      });
    },
    [
      applyInputValue,
      handleCommandInputChange,
      input,
      inputValueRef,
      setCursorPosition,
      syncQueuedBusySendSnapshot,
      textareaRef,
    ],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (isImeEnterEvent(event)) {
        return;
      }

      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (shouldCycleRunModeOnKeyDown(event, { showFileDropdown, showCommandMenu })) {
        event.preventDefault();
        cycleRunMode();
        return;
      }

      if (event.key === "Enter") {
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cycleRunMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      target.style.height = "auto";
      target.style.height = `${target.scrollHeight}px`;
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);

      const lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      setIsTextareaExpanded(target.scrollHeight > lineHeight * 2);
    },
    [setCursorPosition, setIsTextareaExpanded, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    applyInputValue("");
    setDocumentReferences([]);
    cancelBusySendQueue();
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
    // 下列 ref / setter 现在是本 hook 的入参（不再是局部 useRef/useState），exhaustive-deps 要求列入；身份都稳定。
  }, [
    applyInputValue,
    cancelBusySendQueue,
    resetCommandMenuState,
    setDocumentReferences,
    setIsTextareaExpanded,
    textareaRef,
  ]);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
      onInputFocusChange?.(focused);
    },
    [onInputFocusChange],
  );
  return {
    isInputFocused,
    handleInputFocusChange,
    syncInputOverlayScroll,
    handleInputChange,
    insertAtCursor,
    handleKeyDown,
    handleTextareaClick,
    handleTextareaInput,
    handleClearInput,
  };
}
