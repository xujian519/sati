import { useCallback, useEffect, useRef, useState } from "react";
import { logError } from "../../../utils/logging";
import { api } from "../../../utils/api";
import { isImeEnterEvent } from "../../../utils/ime";
import type { InlineEdit } from "./FilesV2.shared";

export type UseFileInlineEditOptions = {
  hasProject: boolean;
  projectName: string;
  refreshFiles: () => void;
  onFileRename?: (oldPath: string, newPath: string) => void;
  ensureExpanded: (path: string) => void;
};

export function useFileInlineEdit({
  hasProject,
  projectName,
  refreshFiles,
  onFileRename,
  ensureExpanded,
}: UseFileInlineEditOptions) {
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);
  const escapePressedRef = useRef(false);

  useEffect(() => {
    setInlineEdit(null);
  }, [projectName]);

  useEffect(() => {
    if (inlineEdit && inlineInputRef.current) {
      inlineInputRef.current.focus();
      if (inlineEdit.kind === "rename") {
        const dotIdx = inlineEdit.currentName.lastIndexOf(".");
        const end = dotIdx > 0 ? dotIdx : inlineEdit.currentName.length;
        inlineInputRef.current.setSelectionRange(0, end);
      } else {
        inlineInputRef.current.select();
      }
    }
  }, [inlineEdit]);

  const commitInlineEdit = useCallback(
    async (value: string) => {
      if (!hasProject || !inlineEdit) return;
      const trimmed = value.trim();
      if (!trimmed) {
        setInlineEdit(null);
        return;
      }

      try {
        if (inlineEdit.kind === "rename") {
          if (trimmed === inlineEdit.currentName) {
            setInlineEdit(null);
            return;
          }
          await api.renameFile(projectName, {
            oldPath: inlineEdit.path,
            newName: trimmed,
          });
          const slashIndex = inlineEdit.path.lastIndexOf("/");
          const parentPath = slashIndex >= 0 ? inlineEdit.path.slice(0, slashIndex + 1) : "";
          onFileRename?.(inlineEdit.path, `${parentPath}${trimmed}`);
        } else {
          const parentPath = inlineEdit.parentPath || "";
          await api.createFile(projectName, {
            path: parentPath || undefined,
            type: inlineEdit.type,
            name: trimmed,
          });
          if (parentPath) {
            ensureExpanded(parentPath);
          }
        }
        await refreshFiles();
      } catch (error) {
        logError("File operation failed:", error);
      }
      setInlineEdit(null);
    },
    [ensureExpanded, hasProject, inlineEdit, onFileRename, projectName, refreshFiles],
  );

  const handleInlineKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        if (isImeEnterEvent(event)) {
          return;
        }
        event.preventDefault();
        commitInlineEdit(event.currentTarget.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        escapePressedRef.current = true;
        setInlineEdit(null);
      }
    },
    [commitInlineEdit],
  );

  const handleInlineBlur = useCallback(
    (event: React.FocusEvent<HTMLInputElement>) => {
      if (escapePressedRef.current) {
        escapePressedRef.current = false;
        setInlineEdit(null);
        return;
      }
      commitInlineEdit(event.currentTarget.value);
    },
    [commitInlineEdit],
  );

  return {
    inlineEdit,
    setInlineEdit,
    inlineInputRef,
    handleInlineKeyDown,
    handleInlineBlur,
  };
}
