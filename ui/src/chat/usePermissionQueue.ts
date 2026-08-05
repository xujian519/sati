/**
 * P2b-1：权限 / elicitation 前端状态机。
 *
 * 状态机为纯 reducer（`permissionQueueReducer`，可单测），`usePermissionQueue`
 * 是轻量 hook 包装：决策动作经注入的 sender 发出协议帧——
 *   - 直连模式（P2b-3）：sender 走 gateway 协议（permission_decide / elicitation_respond）
 *   - 现网模式：sender 走 ui/server ws 帧（permission-response / elicitation-response）
 *
 * 状态流转：
 *   pending ──decide/respond──▶ decided ──sender ok──▶ sent ──▶ done
 *      │  ▲                       │ sender 失败
 *      │  └──────────── retryStale/重试 ────┘
 *      ├──cancel──▶ done
 *      └──markAllStale──▶ stale（断线）──retryStale──▶ pending
 */

import { useCallback, useReducer } from "react";

export type PermissionKind = "permission" | "elicitation";

export type PermissionEntryStatus = "pending" | "decided" | "sent" | "stale" | "done";

export type PermissionEntry = {
  requestId: string;
  sessionId: string;
  toolName: string;
  kind: PermissionKind;
  input: unknown;
  status: PermissionEntryStatus;
  context?: Record<string, unknown>;
  /** 发送失败原因（status 回 pending 时保留，供 UI 展示重试） */
  error?: string;
};

export type PermissionQueueAction =
  | { type: "enqueue"; entry: PermissionEntry }
  | { type: "markDecided"; requestId: string }
  | { type: "markSent"; requestId: string }
  | { type: "markDone"; requestId: string }
  | { type: "cancel"; requestId: string }
  | { type: "markAllStale" }
  | { type: "retryStale" }
  | { type: "markError"; requestId: string; message: string };

export function permissionQueueReducer(entries: PermissionEntry[], action: PermissionQueueAction): PermissionEntry[] {
  switch (action.type) {
    case "enqueue":
      if (entries.some(entry => entry.requestId === action.entry.requestId)) return entries;
      return [...entries, { ...action.entry, status: "pending" }];

    case "markDecided":
      return entries.map(entry =>
        entry.requestId === action.requestId ? { ...entry, status: "decided" as const, error: undefined } : entry,
      );

    case "markSent":
      return entries.map(entry =>
        entry.requestId === action.requestId ? { ...entry, status: "sent" as const } : entry,
      );

    case "markDone":
      return entries.map(entry =>
        entry.requestId === action.requestId ? { ...entry, status: "done" as const } : entry,
      );

    case "cancel":
      return entries.map(entry =>
        entry.requestId === action.requestId ? { ...entry, status: "done" as const } : entry,
      );

    case "markAllStale":
      return entries.map(entry =>
        entry.status === "pending" || entry.status === "decided" ? { ...entry, status: "stale" as const } : entry,
      );

    case "retryStale":
      return entries.map(entry => (entry.status === "stale" ? { ...entry, status: "pending" as const } : entry));

    case "markError":
      return entries.map(entry =>
        entry.requestId === action.requestId ? { ...entry, status: "pending" as const, error: action.message } : entry,
      );

    default:
      return entries;
  }
}

export type PermissionSenders = {
  decide: (input: {
    sessionKey: string;
    requestId: string;
    decision: "allow" | "deny";
    remember?: boolean;
    reason?: string;
  }) => Promise<unknown>;
  respondElicitation: (input: { sessionKey: string; requestId: string; answer: unknown }) => Promise<unknown>;
};

export function usePermissionQueue(senders: PermissionSenders) {
  const [entries, dispatch] = useReducer(permissionQueueReducer, []);

  const enqueue = useCallback((entry: Omit<PermissionEntry, "status">) => {
    dispatch({ type: "enqueue", entry: { ...entry, status: "pending" } });
  }, []);

  const decide = useCallback(
    async (requestId: string, decision: "allow" | "deny", opts?: { remember?: boolean; reason?: string }) => {
      const entry = entries.find(item => item.requestId === requestId);
      if (!entry || entry.kind !== "permission") return;
      dispatch({ type: "markDecided", requestId });
      try {
        await senders.decide({
          sessionKey: entry.sessionId,
          requestId,
          decision,
          remember: opts?.remember,
          reason: opts?.reason,
        });
        dispatch({ type: "markSent", requestId });
      } catch (error) {
        dispatch({ type: "markError", requestId, message: error instanceof Error ? error.message : String(error) });
        return;
      }
      dispatch({ type: "markDone", requestId });
    },
    [entries, senders],
  );

  const respondElicitation = useCallback(
    async (requestId: string, answer: unknown) => {
      const entry = entries.find(item => item.requestId === requestId);
      if (!entry || entry.kind !== "elicitation") return;
      dispatch({ type: "markDecided", requestId });
      try {
        await senders.respondElicitation({ sessionKey: entry.sessionId, requestId, answer });
        dispatch({ type: "markSent", requestId });
      } catch (error) {
        dispatch({ type: "markError", requestId, message: error instanceof Error ? error.message : String(error) });
        return;
      }
      dispatch({ type: "markDone", requestId });
    },
    [entries, senders],
  );

  const cancel = useCallback((requestId: string) => {
    dispatch({ type: "cancel", requestId });
  }, []);

  const markAllStale = useCallback(() => {
    dispatch({ type: "markAllStale" });
  }, []);

  const retryStale = useCallback(() => {
    dispatch({ type: "retryStale" });
  }, []);

  const pending = entries.filter(entry => entry.status === "pending");
  const decided = entries.filter(entry => entry.status === "decided");

  return {
    entries,
    pending,
    decided,
    enqueue,
    decide,
    respondElicitation,
    cancel,
    markAllStale,
    retryStale,
  };
}
