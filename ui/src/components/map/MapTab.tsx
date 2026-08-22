import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Project, ProjectSession } from "../../types/app";
import type { MapThread } from "./types";
import { useMap } from "./hooks/useMap";
import { useMapViewport } from "./hooks/useMapViewport";
import { computeMapBounds } from "./utils/layout";
import { MapCanvas } from "./view/MapCanvas";
import { MapToolbar } from "./view/MapToolbar";

export type MapTabProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  _isMobile?: boolean;
  latestMessage?: { type?: string } | null;
  onNavigateToSession?: (sessionId: string) => void;
  onBackToChat?: () => void;
};

export default function MapTab({
  selectedProject,
  selectedSession,
  _isMobile,
  latestMessage,
  onNavigateToSession,
  onBackToChat,
}: MapTabProps) {
  const { t } = useTranslation("map");
  const { workspaces, threads, edges, loading, error, refetch, moveThread } = useMap(selectedProject);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const selectedThread = selectedThreadId ? (threads.find(t => t.id === selectedThreadId) ?? null) : null;

  useEffect(() => {
    if (selectedThreadId && !selectedThread) {
      setSelectedThreadId(null);
    }
  }, [selectedThreadId, selectedThread]);

  useEffect(() => {
    if (!latestMessage || latestMessage.type !== "projects_updated" || !selectedProject) return;
    refetch();
  }, [latestMessage, selectedProject, refetch]);

  const { containerRef, viewport, setTransform, resetViewport, fitToBounds, focusThread, handlers } = useMapViewport();

  const handleZoomIn = useCallback(() => {
    setTransform(prev => ({ ...prev, scale: Math.min(4, prev.scale * 1.2) }));
  }, [setTransform]);

  const handleZoomOut = useCallback(() => {
    setTransform(prev => ({ ...prev, scale: Math.max(0.25, prev.scale / 1.2) }));
  }, [setTransform]);

  const handleFit = useCallback(() => {
    fitToBounds(computeMapBounds(threads, workspaces));
  }, [fitToBounds, threads, workspaces]);

  const handleThreadMove = useCallback(
    (threadId: string, delta: { x: number; y: number }, done: boolean) => {
      moveThread(threadId, delta, done);
    },
    [moveThread],
  );

  const handleThreadClick = useCallback(
    (thread: MapThread) => {
      setSelectedThreadId(thread.id);
      if (thread.sessionId && onNavigateToSession) {
        onNavigateToSession(thread.sessionId);
      }
    },
    [onNavigateToSession],
  );

  const handleBackToChat = useCallback(() => {
    onBackToChat?.();
  }, [onBackToChat]);

  const focusedSessionRef = useRef<string | null>(null);
  const currentThread = useMemo(
    () => (selectedSession?.id ? (threads.find(t => t.sessionId === selectedSession.id) ?? null) : null),
    [selectedSession?.id, threads],
  );

  useEffect(() => {
    const targetId = selectedSession?.id ?? null;
    if (!targetId || focusedSessionRef.current === targetId || !currentThread) return;
    focusedSessionRef.current = targetId;
    setSelectedThreadId(currentThread.id);
    focusThread(currentThread);
  }, [selectedSession?.id, currentThread, focusThread]);

  const handleLocateSession = useCallback(() => {
    if (!currentThread) return;
    focusedSessionRef.current = currentThread.sessionId ?? currentThread.id;
    setSelectedThreadId(currentThread.id);
    focusThread(currentThread);
  }, [currentThread, focusThread]);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-neutral-50 dark:bg-neutral-950">
      <MapToolbar
        scale={viewport.scale}
        onReset={resetViewport}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onFit={handleFit}
        onBackToChat={onBackToChat ? handleBackToChat : undefined}
        onLocateSession={currentThread ? handleLocateSession : undefined}
      />

      {!selectedProject && (
        <div className="absolute top-1/2 left-1/2 z-10 max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-neutral-200 bg-white p-6 text-center shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
          <h3 className="text-base font-medium text-neutral-900 dark:text-neutral-100">{t("empty.title")}</h3>
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">{t("empty.description")}</p>
        </div>
      )}

      {selectedProject && loading && (
        <div className="absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 text-sm text-neutral-500 dark:text-neutral-400">
          {t("loading")}
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

      {selectedProject && !loading && !error && workspaces.length === 0 && (
        <div className="absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 text-sm text-neutral-500 dark:text-neutral-400">
          {t("noWorkspaces")}
        </div>
      )}

      {selectedProject && !loading && !error && workspaces.length > 0 && threads.length === 0 && (
        <div className="absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 text-sm text-neutral-500 dark:text-neutral-400">
          {t("empty.noThreads")}
        </div>
      )}

      <MapCanvas
        workspaces={workspaces}
        threads={threads}
        edges={edges}
        viewport={viewport}
        containerRef={containerRef}
        handlers={handlers}
        selectedThreadId={selectedThreadId ?? undefined}
        onThreadMove={handleThreadMove}
        onThreadClick={handleThreadClick}
      />
    </div>
  );
}
