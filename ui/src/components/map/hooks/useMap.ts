import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project, ProjectSession } from "../../../types/app";
import { api, authenticatedFetch } from "../../../utils/api";
import type { MapEdge, MapThread, MapWorkspace, Position } from "../types";
import { buildThreadEdges, layoutThreads } from "../utils/layout";

const SESSION_PAGE_SIZE = 100;

export type UseMapResult = {
  workspaces: MapWorkspace[];
  threads: MapThread[];
  edges: MapEdge[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  moveThread: (threadId: string, delta: { x: number; y: number }, done: boolean) => void;
};

const POSITIONS_STORAGE_PREFIX = "sati:map:positions";

const PALETTE = ["#0ea5e9", "#8b5cf6", "#f59e0b", "#10b981", "#ef4444", "#ec4899", "#06b6d4", "#6366f1"];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function pickColor(value: string): string {
  return PALETTE[hashString(value) % PALETTE.length];
}

function isInternalSession(sessionId?: string): boolean {
  if (!sessionId) return false;
  return /^team[\-:]/.test(sessionId) || sessionId.startsWith("always-on-");
}

function positionsStorageKey(projectName: string): string {
  return `${POSITIONS_STORAGE_PREFIX}:${projectName}`;
}

function loadPersistedPositions(projectName: string): Map<string, Position> {
  try {
    const raw = localStorage.getItem(positionsStorageKey(projectName));
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const map = new Map<string, Position>();
    for (const [id, value] of Object.entries(parsed)) {
      if (
        value &&
        typeof value === "object" &&
        typeof (value as Record<string, unknown>).x === "number" &&
        typeof (value as Record<string, unknown>).y === "number"
      ) {
        const x = (value as Record<string, number>).x;
        const y = (value as Record<string, number>).y;
        if (Number.isFinite(x) && Number.isFinite(y)) {
          map.set(id, { x, y });
        }
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function savePersistedPositions(projectName: string, positions: Map<string, Position>): void {
  try {
    const record: Record<string, Position> = {};
    for (const [id, position] of positions.entries()) {
      record[id] = position;
    }
    localStorage.setItem(positionsStorageKey(projectName), JSON.stringify(record));
  } catch {
    // Storage may be unavailable or full; positions remain in-memory only.
  }
}

function normalizeWorkspaces(raw: unknown[]): MapWorkspace[] {
  return raw
    .map((item): MapWorkspace | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const id = String(record.id ?? "");
      const name = String(record.title ?? record.name ?? record.cwd ?? id);
      const cwd = String(record.cwd ?? name);
      if (!id) return null;
      return {
        id,
        name,
        cwd,
        color: typeof record.color === "string" ? record.color : pickColor(id),
        position: { x: 0, y: 0 },
      };
    })
    .filter((item): item is MapWorkspace => item !== null);
}

function sessionToSyncItem(
  session: ProjectSession,
  projectName: string,
): {
  id: string;
  title: string;
  cwd: string;
  parentId?: string;
  blank: boolean;
} {
  return {
    id: session.id,
    title: session.title || session.name || session.summary || "Untitled",
    cwd: projectName,
    ...(session.parentSessionId ? { parentId: session.parentSessionId } : {}),
    blank: false,
  };
}

function normalizeThreads(raw: unknown[], workspaces: MapWorkspace[]): MapThread[] {
  const workspaceById = new Map(workspaces.map(w => [w.id, w]));
  const workspaceByCwd = new Map(workspaces.map(w => [w.cwd, w]));

  return raw
    .map((item): MapThread | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const id = String(record.id ?? "");
      const title = String(record.title ?? "Untitled");
      const workspaceId = String(record.workspaceId ?? record.cwd ?? (record.sessionId ? undefined : ""));
      if (!id) return null;

      const workspace = workspaceById.get(workspaceId) ?? workspaceByCwd.get(workspaceId);
      const sessionId = typeof record.sessionId === "string" ? record.sessionId : id;
      const parentId = typeof record.parentId === "string" ? record.parentId : undefined;
      const status =
        typeof record.status === "string" && ["idle", "processing", "interrupted"].includes(record.status)
          ? (record.status as MapThread["status"])
          : "idle";

      return {
        id,
        title,
        workspaceId: workspace?.id ?? workspaceId,
        ...(parentId ? { parentId } : {}),
        sessionId,
        status,
        color: typeof record.color === "string" ? record.color : (workspace?.color ?? pickColor(id)),
        position: { x: 0, y: 0 },
      };
    })
    .filter((item): item is MapThread => item !== null);
}

async function fetchWorkspaces(): Promise<MapWorkspace[]> {
  const response = await authenticatedFetch("/api/map/workspaces");
  if (!response.ok) {
    throw new Error(`Failed to fetch workspaces: ${response.statusText || String(response.status)}`);
  }
  const json = (await response.json()) as unknown[] | { workspaces?: unknown[] };
  const items = Array.isArray(json) ? json : Array.isArray(json.workspaces) ? json.workspaces : [];
  return normalizeWorkspaces(items);
}

async function fetchAllSessions(projectName: string): Promise<ProjectSession[]> {
  const probe = await api.sessions(projectName, 1, 0);
  const probeJson = (await probe.json()) as {
    sessions: ProjectSession[];
    total?: number;
    hasMore?: boolean;
  };
  const total = typeof probeJson.total === "number" ? probeJson.total : probeJson.sessions.length;
  if (total <= SESSION_PAGE_SIZE) {
    const response = await api.sessions(projectName, total, 0);
    const json = (await response.json()) as { sessions: ProjectSession[]; total?: number };
    return json.sessions || [];
  }

  const pages: ProjectSession[][] = [];
  const pageCount = Math.ceil(total / SESSION_PAGE_SIZE);
  const fetches: Promise<void>[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    fetches.push(
      (async () => {
        const response = await api.sessions(projectName, SESSION_PAGE_SIZE, i * SESSION_PAGE_SIZE);
        const json = (await response.json()) as { sessions: ProjectSession[] };
        pages[i] = json.sessions || [];
      })(),
    );
  }
  await Promise.all(fetches);
  return pages.flat();
}

async function syncSessions(
  projectName: string,
  sessions: ProjectSession[],
): Promise<{ workspaces: MapWorkspace[]; threads: MapThread[] }> {
  const visibleSessions = sessions.filter(s => !isInternalSession(s.id) && s.sessionKind !== "background_task");
  const payload = visibleSessions.map(session => sessionToSyncItem(session, projectName));
  const response = await authenticatedFetch("/api/map/sessions/sync", {
    method: "POST",
    body: JSON.stringify({ sessions: payload }),
  });
  if (!response.ok) {
    throw new Error(`Failed to sync sessions: ${response.statusText || String(response.status)}`);
  }
  const json = (await response.json()) as { workspaces?: unknown[]; threads?: unknown[] };
  const normalizedWorkspaces = normalizeWorkspaces(Array.isArray(json.workspaces) ? json.workspaces : []);
  const normalizedThreads = normalizeThreads(Array.isArray(json.threads) ? json.threads : [], normalizedWorkspaces);
  return { workspaces: normalizedWorkspaces, threads: normalizedThreads };
}

export function useMap(project: Project | null): UseMapResult {
  const projectName = project?.name ?? null;
  const [workspaces, setWorkspaces] = useState<MapWorkspace[]>([]);
  const [threads, setThreads] = useState<MapThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [version, setVersion] = useState(0);
  const positionsRef = useRef<Map<string, Position>>(new Map());

  useEffect(() => {
    setThreads([]);
    if (!projectName) {
      positionsRef.current = new Map();
    } else {
      positionsRef.current = loadPersistedPositions(projectName);
    }
    setVersion(v => v + 1);
  }, [projectName]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetchedWorkspaces = await fetchWorkspaces();

      if (projectName) {
        const sessions = await fetchAllSessions(projectName);
        const synced = await syncSessions(projectName, sessions);
        setWorkspaces(synced.workspaces.length > 0 ? synced.workspaces : fetchedWorkspaces);
        setThreads(synced.threads);
      } else {
        setWorkspaces(fetchedWorkspaces);
        setThreads([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  useEffect(() => {
    void load();
  }, [load]);

  const positionedThreads = useMemo(() => {
    void version;
    // Always lay out an auto-grid, then overlay persisted (user-dragged)
    // positions so a reload/refetch never clobbers the user's manual layout.
    return layoutThreads(workspaces, threads, positionsRef.current);
  }, [threads, workspaces, version]);

  const edges = useMemo<MapEdge[]>(() => buildThreadEdges(positionedThreads), [positionedThreads]);

  const moveThread = useCallback(
    (threadId: string, delta: { x: number; y: number }, done: boolean) => {
      const current = positionsRef.current.get(threadId) ?? { x: 0, y: 0 };
      const next: Position = {
        x: current.x + delta.x,
        y: current.y + delta.y,
      };
      positionsRef.current.set(threadId, next);
      if (done && projectName) {
        savePersistedPositions(projectName, positionsRef.current);
      }
      setVersion(v => v + 1);
    },
    [projectName],
  );

  const refetch = useCallback(() => {
    void load();
  }, [load]);

  return {
    workspaces,
    threads: positionedThreads,
    edges,
    loading,
    error,
    refetch,
    moveThread,
  };
}
