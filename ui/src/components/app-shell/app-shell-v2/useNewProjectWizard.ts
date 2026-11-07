import { useCallback, useState } from "react";
import type { MutableRefObject } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { AppTab, Project } from "../../../types/app";

type UseNewProjectWizardArgs = {
  navigate: NavigateFunction;
  refreshProjectsSilently: () => Promise<void>;
  handleNewSession: (project: Project) => void;
  setActiveTab: (tab: AppTab) => void;
  userSelectedProjectRef: MutableRefObject<string | null>;
};

/**
 * Project creation wizard (local existing / new local / github clone). The
 * sidebar's Projects-section "+" opens this; row-level "+" is for new sessions.
 */
export function useNewProjectWizard({
  navigate,
  refreshProjectsSilently,
  handleNewSession,
  setActiveTab,
  userSelectedProjectRef,
}: UseNewProjectWizardArgs) {
  const [showNewProject, setShowNewProject] = useState(false);
  const handleOpenNewProject = useCallback(() => setShowNewProject(true), []);
  const handleCloseNewProject = useCallback(() => setShowNewProject(false), []);
  const handleProjectCreated = useCallback(
    (project?: Record<string, unknown>) => {
      setShowNewProject(false);
      void refreshProjectsSilently();

      // Auto-jump into the new project's empty new-conversation screen so the
      // user doesn't accidentally keep chatting under the previously selected
      // project (typically "general") after closing the wizard. The wizard
      // hands back the freshly created project from POST /create-workspace
      // (and the clone SSE complete event), which is the same `{ name,
      // displayName, fullPath, path }` shape as the sidebar list entries.
      const projectName = typeof project?.name === "string" ? project.name : "";
      if (!projectName) return;
      const newProject = project as Project;
      userSelectedProjectRef.current = projectName;
      handleNewSession(newProject);
      navigate(`/p/${encodeURIComponent(projectName)}`);
      setActiveTab("chat");
    },
    [handleNewSession, navigate, refreshProjectsSilently, setActiveTab, userSelectedProjectRef],
  );

  return { showNewProject, handleOpenNewProject, handleCloseNewProject, handleProjectCreated };
}

export type NewProjectWizard = ReturnType<typeof useNewProjectWizard>;
