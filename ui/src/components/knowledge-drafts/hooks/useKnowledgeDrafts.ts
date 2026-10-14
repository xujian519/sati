import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../utils/api";
import type { KnowledgeDraft } from "../types/types";

/** 轮询间隔：agent 随时可能提交新草稿（WS2 草稿闸门默认开）。 */
const POLL_INTERVAL_MS = 30_000;

/**
 * 载荷形状收窄（与 useHookTrust 同一纪律）：契约漂移时以可诊断的 error
 * 呈现，而不是让 undefined 字段渗进渲染层。
 */
function parseDrafts(value: unknown): { drafts?: KnowledgeDraft[]; problem?: string } {
  if (typeof value !== "object" || value === null) return { problem: "payload is not an object" };
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.drafts)) return { problem: "payload missing drafts array" };
  const drafts: KnowledgeDraft[] = [];
  for (const raw of record.drafts) {
    const draft = raw as Partial<KnowledgeDraft>;
    if (typeof draft?.id !== "string" || typeof draft.title !== "string" || typeof draft.content !== "string") {
      return { problem: "draft malformed" };
    }
    drafts.push({
      id: draft.id,
      sessionId: typeof draft.sessionId === "string" ? draft.sessionId : "",
      title: draft.title,
      content: draft.content,
      project: typeof draft.project === "string" ? draft.project : undefined,
      status: draft.status === "confirmed" || draft.status === "rejected" ? draft.status : "pending",
      createdAt: typeof draft.createdAt === "string" ? draft.createdAt : "",
      updatedAt: typeof draft.updatedAt === "string" ? draft.updatedAt : "",
    });
  }
  return { drafts };
}

export type UseKnowledgeDraftsResult = {
  /** pending 草稿（已确认/已拒绝不展示）。 */
  pendingDrafts: KnowledgeDraft[];
  loading: boolean;
  error: string | null;
  /** 正在提交决定的草稿 id（按钮 disabled 态）。 */
  busyDraftId: string | null;
  refresh: () => Promise<void>;
  confirm: (id: string) => Promise<void>;
  reject: (id: string) => Promise<void>;
};

/**
 * 知识草稿取数：首次拉取 + 周期轮询（POLL_INTERVAL_MS）；决定后即时刷新。
 * 应用级（不挂 projectKey）：草稿按会话归属，跨项目可见待确认沉淀。
 */
export function useKnowledgeDrafts(): UseKnowledgeDraftsResult {
  const [drafts, setDrafts] = useState<KnowledgeDraft[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyDraftId, setBusyDraftId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const payload = await api.knowledgeDrafts.list();
      if (!mountedRef.current) return;
      const parsed = parseDrafts(payload);
      if (!parsed.drafts) {
        setError(parsed.problem ?? "malformed payload");
        setDrafts(null);
        return;
      }
      setDrafts(parsed.drafts);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setDrafts(null);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const decide = useCallback(
    async (id: string, action: "confirm" | "reject"): Promise<void> => {
      setBusyDraftId(id);
      try {
        if (action === "confirm") {
          await api.knowledgeDrafts.confirm(id);
        } else {
          await api.knowledgeDrafts.reject(id);
        }
        await refresh();
      } catch (err) {
        if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mountedRef.current) setBusyDraftId(null);
      }
    },
    [refresh],
  );

  return {
    pendingDrafts: (drafts ?? []).filter(draft => draft.status === "pending"),
    loading,
    error,
    busyDraftId,
    refresh,
    confirm: id => decide(id, "confirm"),
    reject: id => decide(id, "reject"),
  };
}
