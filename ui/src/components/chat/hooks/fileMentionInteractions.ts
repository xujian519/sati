import type { Dispatch, RefObject, SetStateAction } from "react";
import { isImeEnterEvent } from "../../../utils/ime";
import { hasWorkspaceFileMention } from "../../../utils/workspaceFileMention";
import type { MentionableFile } from "./useFileMentions";

/**
 * 「@ 文件提及」的键位处理：整词删除提及、上下选词、Tab/Enter 选中、Esc 关闭。
 *
 * 从 `useFileMentions.tsx` 搬出（#646 B2.5），**被搬代码逐字未改**；
 * 状态仍由 hook 持有，本函数按显式 deps 读写，不引入 hook。
 */

/** 键位处理只读这些字段；用最小事件形状避免测试为造 React 合成事件而做双重断言。 */
export type FileMentionKeyEvent = {
  key: string;
  preventDefault: () => void;
  isComposing?: boolean;
  keyCode?: number;
  which?: number;
  nativeEvent?: { keyCode?: number; which?: number; isComposing?: boolean };
};

type FileMentionKeyDownDeps = {
  cursorPosition: number;
  filteredFiles: MentionableFile[];
  focusMention: (position: number) => void;
  input: string;
  selectFile: (file: MentionableFile) => void;
  selectedFileIndex: number;
  setCursorPosition: (position: number) => void;
  setFileMentions: Dispatch<SetStateAction<string[]>>;
  setInput: Dispatch<SetStateAction<string>>;
  setSelectedFileIndex: Dispatch<SetStateAction<number>>;
  setShowFileDropdown: Dispatch<SetStateAction<boolean>>;
  showFileDropdown: boolean;
  sortedFileMentions: string[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export function handleFileMentionsKeyDown(
  event: FileMentionKeyEvent,
  {
    cursorPosition,
    filteredFiles,
    focusMention,
    input,
    selectFile,
    selectedFileIndex,
    setCursorPosition,
    setFileMentions,
    setInput,
    setSelectedFileIndex,
    setShowFileDropdown,
    showFileDropdown,
    sortedFileMentions,
    textareaRef,
  }: FileMentionKeyDownDeps,
): boolean {
  if ((event.key === "Backspace" || event.key === "Delete") && sortedFileMentions.length > 0) {
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? cursorPosition;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    if (selectionStart === selectionEnd) {
      const mentionRanges = sortedFileMentions.flatMap(mention => {
        const ranges: Array<{ mention: string; start: number; end: number }> = [];
        let searchFrom = 0;
        while (searchFrom <= input.length - mention.length) {
          const start = input.indexOf(mention, searchFrom);
          if (start === -1) break;
          const end = start + mention.length;
          const hasLeadingBoundary = start === 0 || /\s/.test(input[start - 1]);
          const hasTrailingBoundary = end === input.length || /\s/.test(input[end]);
          if (hasLeadingBoundary && hasTrailingBoundary) ranges.push({ mention, start, end });
          searchFrom = Math.max(end, start + 1);
        }
        return ranges;
      });
      const range = mentionRanges.find(({ start, end }) =>
        event.key === "Backspace"
          ? selectionStart === end || (selectionStart === end + 1 && /\s/.test(input[end] || ""))
          : selectionStart === start || (selectionStart + 1 === start && /\s/.test(input[selectionStart] || "")),
      );

      if (range) {
        event.preventDefault();
        let removeStart = range.start;
        let removeEnd = range.end;
        if (/\s/.test(input[removeEnd] || "")) {
          removeEnd += 1;
        } else if (removeStart > 0 && /\s/.test(input[removeStart - 1] || "")) {
          removeStart -= 1;
        }
        const nextInput = `${input.slice(0, removeStart)}${input.slice(removeEnd)}`;
        setInput(nextInput);
        setCursorPosition(removeStart);
        setFileMentions(mentions =>
          mentions.filter(mention => mention !== range.mention || hasWorkspaceFileMention(nextInput, mention)),
        );
        focusMention(removeStart);
        setShowFileDropdown(false);
        return true;
      }
    }
  }

  if (!showFileDropdown || filteredFiles.length === 0) {
    return false;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    setSelectedFileIndex(previousIndex => (previousIndex < filteredFiles.length - 1 ? previousIndex + 1 : 0));
    return true;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    setSelectedFileIndex(previousIndex => (previousIndex > 0 ? previousIndex - 1 : filteredFiles.length - 1));
    return true;
  }

  if (event.key === "Tab" || event.key === "Enter") {
    if (isImeEnterEvent(event)) {
      return false;
    }
    event.preventDefault();
    if (selectedFileIndex >= 0) {
      selectFile(filteredFiles[selectedFileIndex]);
    } else if (filteredFiles.length > 0) {
      selectFile(filteredFiles[0]);
    }
    return true;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    setShowFileDropdown(false);
    return true;
  }

  return false;
}
