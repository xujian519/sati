import { createPortal } from "react-dom";
import type { JSX } from "react";
import ProjectCreationWizard from "../../project-creation-wizard";
import Settings from "../../settings/Settings";
import { normalizeProjectForSettings, type SettingsProject } from "../../../lib/projectSettings";
import { StylePanelHost } from "../../patent/StylePanel";
import DeleteProjectDialog from "./DeleteProjectDialog";
import DeleteSessionDialog from "./DeleteSessionDialog";
import type { AppShellState } from "./useAppShellState";
import type { AppShellChrome } from "./useAppShellChrome";
import type { NewProjectWizard } from "./useNewProjectWizard";
import type { DeleteProjectState, DeleteSessionState } from "./useDeleteDialogs";

type TypedSettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects: SettingsProject[];
  initialTab: string;
};

const SettingsComponent: (props: TypedSettingsProps) => JSX.Element = Settings;

type AppShellOverlaysProps = {
  projectState: AppShellState["projectState"];
  websocket: AppShellState["websocket"];
  chrome: AppShellChrome;
  wizard: NewProjectWizard;
  deleteProject: DeleteProjectState;
  deleteSession: DeleteSessionState;
};

/** 全局浮层：设置、项目创建向导、删除确认对话框、文书排版调参面板。 */
export default function AppShellOverlays({
  projectState,
  websocket,
  chrome,
  wizard,
  deleteProject,
  deleteSession,
}: AppShellOverlaysProps) {
  const { showSettings, settingsInitialTab, projects, selectedProject, selectedSession } =
    projectState.sidebarSharedProps;

  return (
    <>
      {showSettings
        ? createPortal(
            <SettingsComponent
              isOpen={showSettings}
              onClose={chrome.onCloseSettings}
              projects={projects.map(normalizeProjectForSettings)}
              initialTab={settingsInitialTab || "appearance"}
            />,
            document.body,
          )
        : null}

      {wizard.showNewProject
        ? createPortal(
            <ProjectCreationWizard
              onClose={wizard.handleCloseNewProject}
              onProjectCreated={wizard.handleProjectCreated}
            />,
            document.body,
          )
        : null}

      {deleteProject.deleteTarget
        ? createPortal(
            <DeleteProjectDialog
              project={deleteProject.deleteTarget}
              isDeleting={deleteProject.isDeletingProject}
              error={deleteProject.deleteError}
              onCancel={deleteProject.cancelDeleteProject}
              onConfirm={deleteProject.confirmDeleteProject}
            />,
            document.body,
          )
        : null}

      {deleteSession.deleteSessionTarget
        ? createPortal(
            <DeleteSessionDialog
              target={deleteSession.deleteSessionTarget}
              isDeleting={deleteSession.isDeletingSession}
              error={deleteSession.deleteSessionError}
              onCancel={deleteSession.cancelDeleteSession}
              onConfirm={deleteSession.confirmDeleteSession}
            />,
            document.body,
          )
        : null}

      {/* 文书排版调参面板（document_style_panel 工具 → tool_call_finished payload 打开） */}
      <StylePanelHost
        sendMessage={websocket.sendMessage}
        subscribe={websocket.subscribe}
        projectName={selectedProject?.name ?? ""}
        projectPath={selectedProject?.fullPath || selectedProject?.path || ""}
        sessionId={selectedSession?.id ?? null}
        provider="sati"
      />
    </>
  );
}
