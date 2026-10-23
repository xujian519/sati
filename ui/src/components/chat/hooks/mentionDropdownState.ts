import type { Dispatch, SetStateAction } from "react";
import type { MentionableFile } from "./useFileMentions";

/**
 * 「@ 文件提及」下拉的派生状态：从光标前的文本解析查询词并过滤文件列表。
 *
 * 从 `useFileMentions.tsx` 搬出（#646 B2.5），**被搬代码逐字未改**：
 * 状态仍由 hook 持有，本函数只负责计算与写回，保 effect 的相对顺序不变。
 */

type MentionDropdownSync = {
  input: string;
  cursorPosition: number;
  fileList: MentionableFile[];
  setShowFileDropdown: Dispatch<SetStateAction<boolean>>;
  setAtSymbolPosition: Dispatch<SetStateAction<number>>;
  setSelectedFileIndex: Dispatch<SetStateAction<number>>;
  setFilteredFiles: Dispatch<SetStateAction<MentionableFile[]>>;
};

export function syncMentionDropdown({
  input,
  cursorPosition,
  fileList,
  setShowFileDropdown,
  setAtSymbolPosition,
  setSelectedFileIndex,
  setFilteredFiles,
}: MentionDropdownSync): void {
  const textBeforeCursor = input.slice(0, cursorPosition);
  const lastAtIndex = textBeforeCursor.lastIndexOf("@");

  if (lastAtIndex === -1) {
    setShowFileDropdown(false);
    setAtSymbolPosition(-1);
    return;
  }

  const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
  if (textAfterAt.includes(" ")) {
    setShowFileDropdown(false);
    setAtSymbolPosition(-1);
    return;
  }

  setAtSymbolPosition(lastAtIndex);
  setShowFileDropdown(true);
  setSelectedFileIndex(-1);

  const matchingFiles = fileList
    .filter(
      file =>
        file.name.toLowerCase().includes(textAfterAt.toLowerCase()) ||
        file.path.toLowerCase().includes(textAfterAt.toLowerCase()),
    )
    .slice(0, 10);

  setFilteredFiles(matchingFiles);
}
