import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Project, ProjectSession, ProjectsUpdatedMessage } from "../../types/app";
import type { SessionGraphNode } from "./types";
import { useSessionGraphViewport } from "./hooks/useSessionGraphViewport";
import { useSessionGraph } from "./hooks/useSessionGraph";
import { computeBounds } from "./utils/layout";
import { SessionGraphViewport } from "./view/SessionGraphViewport";
import { SessionGraphToolbar } from "./view/SessionGraphToolbar";
import { SessionGraphDetailPanel } from "./view/SessionGraphDetailPanel";

export type SessionGraphTabProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isMobile?: boolean;
  latestMessage?: { type?: string } | null;
  onNavigateToSession?: (sessionId: string) => void;
  onBackToChat?: () => void;
};

export default function SessionGraphTab({
  selectedProject,
  selectedSession,
  isMobile,
  latestMessage,
  onNavigateToSession,
  onBackToChat,
}: SessionGraphTabProps) {
  const { t } = useTranslation("sessionGraph");
  const { nodes, edges, loading, error, total, loadedCount, refetch, moveNode } = useSessionGraph(selectedProject);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const selectedNode = selectedNodeId ? (nodes.find(n => n.sessionId === selectedNodeId) ?? null) : null;

  useEffect(() => {
    if (selectedNodeId && !selectedNode) {
      setSelectedNodeId(null);
    }
  }, [selectedNodeId, selectedNode]);

  // Refresh the graph when the server broadcasts project updates for the
  // currently viewed project.
  useEffect(() => {
    if (!latestMessage || latestMessage.type !== "projects_updated" || !selectedProject) return;
    const message = latestMessage as ProjectsUpdatedMessage;
    const touched = message.projects?.some(p => p.name === selectedProject.name);
    if (touched) {
      refetch();
    }
  }, [latestMessage, selectedProject, refetch]);

  const { containerRef, viewport, setTransform, resetViewport, fitToBounds, focusNode, handlers } =
    useSessionGraphViewport();

  const handleZoomIn = useCallback(() => {
    setTransform(prev => ({ ...prev, scale: Math.min(4, prev.scale * 1.2) }));
  }, [setTransform]);

  const handleZoomOut = useCallback(() => {
    setTransform(prev => ({ ...prev, scale: Math.max(0.25, prev.scale / 1.2) }));
  }, [setTransform]);

  const handleFit = useCallback(() => {
    fitToBounds(computeBounds(nodes));
  }, [fitToBounds, nodes]);

  const handleNodeMove = useCallback(
    (sessionId: string, delta: { x: number; y: number }, done: boolean) => {
      moveNode(sessionId, delta, done);
    },
    [moveNode],
  );

  const handleNodeClick = useCallback((node: SessionGraphNode) => {
    setSelectedNodeId(node.sessionId);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  const handleBackToChat = useCallback(() => {
    onBackToChat?.();
  }, [onBackToChat]);

  const focusedSessionRef = useRef<string | null>(null);
  const currentNode = useMemo(
    () => (selectedSession?.id ? (nodes.find(n => n.sessionId === selectedSession.id) ?? null) : null),
    [selectedSession?.id, nodes],
  );

  // Reverse sync: when the current session changes in the chat, follow it on the
  // map — center the node and highlight it (once per session, not on every nodes rebuild).
  useEffect(() => {
    const targetId = selectedSession?.id ?? null;
    if (!targetId || focusedSessionRef.current === targetId || !currentNode) return;
    focusedSessionRef.current = targetId;
    setSelectedNodeId(targetId);
    focusNode(currentNode);
  }, [selectedSession?.id, currentNode, focusNode]);

  const handleLocateSession = useCallback(() => {
    if (!currentNode) return;
    focusedSessionRef.current = currentNode.sessionId;
    setSelectedNodeId(currentNode.sessionId);
    focusNode(currentNode);
  }, [currentNode, focusNode]);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-neutral-50 dark:bg-neutral-950">
      <SessionGraphToolbar
        scale={viewport.scale}
        onReset={resetViewport}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onFit={handleFit}
        onBackToChat={onBackToChat ? handleBackToChat : undefined}
        onLocateSession={currentNode ? handleLocateSession : undefined}
      />

      {!selectedProject && (
        <div className="absolute top-1/2 left-1/2 z-10 max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-neutral-200 bg-white p-6 text-center shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
          <h3 className="text-base font-medium text-neutral-900 dark:text-neutral-100">{t("empty.title")}</h3>
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">{t("empty.description")}</p>
        </div>
      )}

      {selectedProject && loading && (
        <div className="absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 text-sm text-neutral-500 dark:text-neutral-400">
          {t("loading", { defaultValue: "Loading sessions…" })}
        </div>
      )}

      {selectedProject && error && (
        <div className="absolute top-1/2 left-1/2 z-10 max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-red-200 bg-white p-6 text-center shadow-sm dark:border-red-900/40 dark:bg-neutral-900">
          <p className="text-sm text-red-600 dark:text-red-400">{t("error.loadFailed")}</p>
          <button
            type="button"
            onClick={refetch}
            className="mt-3 inline-flex items-center rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900"
          >
            {t("error.retry")}
          </button>
        </div>
      )}

      {selectedProject && !loading && !error && nodes.length === 0 && (
        <div className="absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 text-sm text-neutral-500 dark:text-neutral-400">
          {t("noSessions", { defaultValue: "No sessions in this project." })}
        </div>
      )}

      <SessionGraphViewport
        nodes={nodes}
        edges={edges}
        viewport={viewport}
        containerRef={containerRef}
        handlers={handlers}
        selectedNodeId={selectedNodeId ?? undefined}
        onNodeMove={handleNodeMove}
        onNodeClick={handleNodeClick}
      />

      {selectedNode ? (
        <SessionGraphDetailPanel
          node={selectedNode}
          projectName={selectedProject?.name}
          isMobile={isMobile}
          onClose={handleCloseDetail}
          onNavigateToSession={onNavigateToSession}
        />
      ) : null}

      <div className="pointer-events-none absolute right-4 bottom-4 z-10 text-xs text-neutral-400 dark:text-neutral-600">
        {loadedCount}/{total} sessions
      </div>
    </div>
  );
}
