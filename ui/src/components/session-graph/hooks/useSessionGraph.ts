import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project, ProjectSession } from "../../../types/app";
import { api } from "../../../utils/api";
import type { SessionGraphEdge, SessionGraphNode } from "../types";
import { buildEdges, computeGridLayout } from "../utils/layout";

const SESSION_LIST_PAGE_SIZE = 100;
const POSITIONS_STORAGE_VERSION = 1;
const POSITIONS_STORAGE_PREFIX = "sati:session-graph:positions";

export type UseSessionGraphResult = {
  nodes: SessionGraphNode[];
  edges: SessionGraphEdge[];
  loading: boolean;
  error: Error | null;
  total: number;
  loadedCount: number;
  refetch: () => void;
  moveNode: (sessionId: string, delta: { x: number; y: number }, done: boolean) => void;
};

type PersistedPosition = {
  x: number;
  y: number;
  locked?: boolean;
};

function isInternalSession(sessionId?: string): boolean {
  if (!sessionId) return false;
  return /^team[\-:]/.test(sessionId) || sessionId.startsWith("always-on-");
}

function sessionStatus(session: ProjectSession): SessionGraphNode["status"] {
  if (session.taskStatus === "failed" || session.taskStatus === "error") return "interrupted";
  if (session.taskStatus === "running" || session.taskStatus === "processing") return "processing";
  return "idle";
}

function positionsStorageKey(projectName: string): string {
  return `${POSITIONS_STORAGE_PREFIX}:v${POSITIONS_STORAGE_VERSION}:${projectName}`;
}

function loadPersistedPositions(projectName: string): Map<string, PersistedPosition> {
  try {
    const raw = localStorage.getItem(positionsStorageKey(projectName));
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, PersistedPosition>;
    const map = new Map<string, PersistedPosition>();
    for (const [sessionId, position] of Object.entries(parsed)) {
      if (
        typeof position?.x === "number" &&
        typeof position?.y === "number" &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y)
      ) {
        map.set(sessionId, {
          x: position.x,
          y: position.y,
          locked: position.locked === true,
        });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function savePersistedPositions(projectName: string, positions: Map<string, PersistedPosition>): void {
  try {
    const record: Record<string, PersistedPosition> = {};
    for (const [sessionId, position] of positions.entries()) {
      record[sessionId] = position;
    }
    localStorage.setItem(positionsStorageKey(projectName), JSON.stringify(record));
  } catch {
    // Storage may be unavailable or full; positions remain in-memory only.
  }
}

function makeForkPreview(session: ProjectSession): SessionGraphNode["forkPreview"] {
  if (!session.parentSessionId || !session.forkedFromTurnId) return undefined;
  const snippet = session.firstPrompt || session.title || "";
  return {
    turnId: session.forkedFromTurnId,
    questionSnippet: snippet.slice(0, 80),
  };
}

function toGraphNode(session: ProjectSession, _index: number): SessionGraphNode {
  return {
    sessionId: session.id,
    title: session.title || session.name || "Untitled",
    parentSessionId: session.parentSessionId,
    forkedFromTurnId: session.forkedFromTurnId,
    forkPreview: makeForkPreview(session),
    lastActivity: session.lastActivity ? new Date(session.lastActivity).getTime() : undefined,
    createdAt: session.createdAt,
    isReadOnly: session.isReadOnly === true || session.sessionKind === "background_task",
    status: sessionStatus(session),
    color: session.parentSessionId ? "#8b5cf6" : "#0ea5e9",
    position: { x: 0, y: 0 },
    positionLocked: false,
  };
}

async function fetchAllSessions(projectName: string): Promise<{ sessions: ProjectSession[]; total: number }> {
  const probe = await api.sessions(projectName, 1, 0);
  const probeJson = (await probe.json()) as {
    sessions: ProjectSession[];
    total?: number;
    hasMore?: boolean;
  };
  const total = typeof probeJson.total === "number" ? probeJson.total : probeJson.sessions.length;

  if (total <= SESSION_LIST_PAGE_SIZE) {
    const response = await api.sessions(projectName, total, 0);
    const json = (await response.json()) as { sessions: ProjectSession[]; total?: number };
    return { sessions: json.sessions || [], total: json.total ?? total };
  }

  const pages: ProjectSession[][] = [];
  const pageCount = Math.ceil(total / SESSION_LIST_PAGE_SIZE);
  const fetches: Promise<void>[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    fetches.push(
      (async () => {
        const response = await api.sessions(projectName, SESSION_LIST_PAGE_SIZE, i * SESSION_LIST_PAGE_SIZE);
        const json = (await response.json()) as { sessions: ProjectSession[] };
        pages[i] = json.sessions || [];
      })(),
    );
  }
  await Promise.all(fetches);
  return { sessions: pages.flat(), total };
}

export function useSessionGraph(project: Project | null): UseSessionGraphResult {
  const projectName = project?.name ?? null;
  const [sessions, setSessions] = useState<ProjectSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [total, setTotal] = useState(0);
  const layoutAppliedRef = useRef(false);
  const positionsRef = useRef<Map<string, PersistedPosition>>(new Map());
  const [positionsVersion, setPositionsVersion] = useState(0);

  useEffect(() => {
    if (!projectName) {
      positionsRef.current = new Map();
      layoutAppliedRef.current = false;
      setPositionsVersion(v => v + 1);
      return;
    }
    positionsRef.current = loadPersistedPositions(projectName);
    layoutAppliedRef.current = false;
    setPositionsVersion(v => v + 1);
  }, [projectName]);

  const load = useCallback(async () => {
    if (!projectName) {
      setSessions([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAllSessions(projectName);
      setSessions(result.sessions);
      setTotal(result.total);
      layoutAppliedRef.current = false;
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  useEffect(() => {
    void load();
  }, [load]);

  const moveNode = useCallback(
    (sessionId: string, delta: { x: number; y: number }, done: boolean) => {
      if (!projectName) return;
      const current = positionsRef.current.get(sessionId) ?? { x: 0, y: 0, locked: false };
      const next: PersistedPosition = {
        x: current.x + delta.x,
        y: current.y + delta.y,
        locked: done || current.locked === true,
      };
      positionsRef.current.set(sessionId, next);
      if (done) {
        savePersistedPositions(projectName, positionsRef.current);
      }
      setPositionsVersion(v => v + 1);
    },
    [projectName],
  );

  const nodes = useMemo<SessionGraphNode[]>(() => {
    void positionsVersion;
    const filtered = sessions.filter(s => !isInternalSession(s.id) && s.sessionKind !== "background_task");
    const baseNodes = filtered.map(toGraphNode);

    // Restore persisted positions before layout so user-locked nodes stay put.
    baseNodes.forEach(node => {
      const persisted = positionsRef.current.get(node.sessionId);
      if (persisted) {
        node.position = { x: persisted.x, y: persisted.y };
        node.positionLocked = persisted.locked === true;
      }
    });

    if (!layoutAppliedRef.current) {
      computeGridLayout(baseNodes);
      layoutAppliedRef.current = true;
      baseNodes.forEach(node => {
        positionsRef.current.set(node.sessionId, {
          x: node.position.x,
          y: node.position.y,
          locked: node.positionLocked === true,
        });
      });
      if (projectName) {
        savePersistedPositions(projectName, positionsRef.current);
      }
    }

    return baseNodes;
  }, [sessions, positionsVersion, projectName]);

  const edges = useMemo<SessionGraphEdge[]>(() => buildEdges(nodes), [nodes]);

  const refetch = useCallback(() => {
    void load();
  }, [load]);

  return {
    nodes,
    edges,
    loading,
    error,
    total,
    loadedCount: sessions.length,
    refetch,
    moveNode,
  };
}
