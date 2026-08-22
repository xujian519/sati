import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../utils/api";
import { messagesToTurns, type NormalizedMessage, type SessionTurn } from "../utils/projection";

export type UseSessionTurnsArgs = {
  sessionId: string | null | undefined;
  projectName?: string;
};

export type UseSessionTurnsResult = {
  turns: SessionTurn[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
};

const MAX_CACHED_SESSIONS = 8;

function normalizeMessage(message: Record<string, unknown>): NormalizedMessage {
  return {
    entryId: typeof message.entryId === "string" ? message.entryId : undefined,
    kind: typeof message.kind === "string" ? message.kind : undefined,
    role: typeof message.role === "string" ? message.role : undefined,
    content: typeof message.content === "string" ? message.content : undefined,
    text: typeof message.text === "string" ? message.text : undefined,
    toolId: typeof message.toolId === "string" ? message.toolId : undefined,
    toolName: typeof message.toolName === "string" ? message.toolName : undefined,
    timestamp:
      typeof message.timestamp === "string"
        ? message.timestamp
        : typeof message.createdAt === "string"
          ? message.createdAt
          : undefined,
    ...message,
  };
}

export function useSessionTurns({ sessionId, projectName }: UseSessionTurnsArgs): UseSessionTurnsResult {
  const cacheRef = useRef<Map<string, SessionTurn[]>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [version, setVersion] = useState(0);

  const cacheKey = useMemo(() => {
    return projectName && sessionId ? `${sessionId}:${projectName}` : sessionId;
  }, [sessionId, projectName]);

  const load = useCallback(async () => {
    if (!cacheKey) {
      setLoading(false);
      setError(null);
      return;
    }
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setLoading(false);
      setError(null);
      setVersion(v => v + 1);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await api.unifiedSessionMessages(sessionId, "sati", {
        projectName,
      });
      if (!response.ok) {
        throw new Error(`Failed to load turns: ${response.status} ${response.statusText}`);
      }
      const json = (await response.json()) as { messages?: Record<string, unknown>[] };
      const normalized = (json.messages || []).map(normalizeMessage);
      const turns = messagesToTurns(normalized);
      cacheRef.current.set(cacheKey, turns);
      if (cacheRef.current.size > MAX_CACHED_SESSIONS) {
        const first = cacheRef.current.keys().next().value;
        if (first) {
          cacheRef.current.delete(first);
        }
      }
      setVersion(v => v + 1);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [cacheKey, projectName, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const turns = useMemo<SessionTurn[]>(() => {
    void version;
    if (!cacheKey) return [];
    return cacheRef.current.get(cacheKey) ?? [];
  }, [cacheKey, version]);

  const refetch = useCallback(() => {
    if (cacheKey) {
      cacheRef.current.delete(cacheKey);
    }
    void load();
  }, [load, cacheKey]);

  return { turns, loading, error, refetch };
}
