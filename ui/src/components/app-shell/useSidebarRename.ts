import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Project, ProjectSession } from "../../types/app";
import { isImeEnterEvent } from "../../utils/ime";
import {
  projectDisplayName,
  sessionDisplayTitle,
  setProjectCustomName,
  setSessionCustomTitle,
} from "../../lib/customNames";

/** 侧栏就地重命名：项目/会话共用一份 draft 与同一个输入框句柄。 */
export function useSidebarRename() {
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if ((renamingProject || renamingSession) && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingProject, renamingSession]);

  const beginRenameProject = useCallback((project: Project) => {
    setRenamingSession(null);
    setRenamingProject(project.name);
    setRenameDraft(projectDisplayName(project));
  }, []);

  const beginRenameSession = useCallback((session: ProjectSession) => {
    setRenamingProject(null);
    setRenamingSession(session.id);
    setRenameDraft(sessionDisplayTitle(session));
  }, []);

  const commitProjectRename = useCallback(() => {
    if (!renamingProject) return;
    setProjectCustomName(renamingProject, renameDraft);
    setRenamingProject(null);
    setRenameDraft("");
  }, [renamingProject, renameDraft]);

  const commitSessionRename = useCallback(() => {
    if (!renamingSession) return;
    setSessionCustomTitle(renamingSession, renameDraft);
    setRenamingSession(null);
    setRenameDraft("");
  }, [renamingSession, renameDraft]);

  const cancelRename = useCallback(() => {
    setRenamingProject(null);
    setRenamingSession(null);
    setRenameDraft("");
  }, []);

  const handleRenameKey = useCallback(
    (event: KeyboardEvent<HTMLInputElement>, kind: "project" | "session") => {
      if (event.key === "Enter") {
        if (isImeEnterEvent(event)) {
          return;
        }
        event.preventDefault();
        if (kind === "project") commitProjectRename();
        else commitSessionRename();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelRename();
      }
    },
    [cancelRename, commitProjectRename, commitSessionRename],
  );

  return {
    renamingProject,
    renamingSession,
    renameDraft,
    setRenameDraft,
    renameInputRef,
    beginRenameProject,
    beginRenameSession,
    commitProjectRename,
    commitSessionRename,
    handleRenameKey,
  };
}
