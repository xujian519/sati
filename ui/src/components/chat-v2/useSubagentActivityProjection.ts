import { useMemo, useRef } from "react";
import type { ChatMessage } from "../chat/types/types";
import type { SessionStore } from "../../stores/useSessionStore";
import { isSubagentActivity } from "./messagesPaneHelpers";

type UseSubagentActivityProjectionOptions = {
  activityMessages: ChatMessage[];
  openSubagentId: string | null;
  sessionId: string | null;
  sessionStore: SessionStore | undefined;
};

export function useSubagentActivityProjection({
  activityMessages,
  openSubagentId,
  sessionId,
  sessionStore,
}: UseSubagentActivityProjectionOptions) {
  const liveActivities = useMemo(() => activityMessages.filter(message => message.isAgentActivity), [activityMessages]);
  const subagentActivities = useMemo(() => liveActivities.filter(isSubagentActivity), [liveActivities]);
  const nonSubagentLiveActivities = useMemo(
    () => liveActivities.filter(activity => !isSubagentActivity(activity)),
    [liveActivities],
  );
  const subagentActivityById = useMemo(() => {
    const byId = new Map<string, ChatMessage>();
    for (const activity of subagentActivities) {
      const rawId = activity.activityId || activity.runId || "";
      const subagentId = rawId.startsWith("subagent:") ? rawId.slice("subagent:".length) : "";
      if (subagentId) {
        byId.set(subagentId, activity);
      }
    }
    return byId;
  }, [subagentActivities]);
  const subagentThinkingByIdRef = useRef(new Map<string, string>());
  const subagentThinkingById = (() => {
    if (!sessionId || !sessionStore) {
      if (subagentThinkingByIdRef.current.size === 0) return subagentThinkingByIdRef.current;
      subagentThinkingByIdRef.current = new Map();
      return subagentThinkingByIdRef.current;
    }
    const prev = subagentThinkingByIdRef.current;
    let changed = false;
    const next = new Map<string, string>();
    for (const [subagentId, activity] of subagentActivityById) {
      const state = String(activity.state || "");
      if (["completed", "failed", "cancelled"].includes(state)) continue;
      const msgs = sessionStore.getSubagentDetailMessages?.(sessionId, subagentId) ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.id.startsWith("__subagent_thinking_") && m.content?.trim()) {
          next.set(subagentId, m.content);
          if (prev.get(subagentId) !== m.content) changed = true;
          break;
        }
      }
    }
    if (!changed && prev.size === next.size) return prev;
    subagentThinkingByIdRef.current = next;
    return next;
  })();
  const openSubagentActivity = openSubagentId ? subagentActivityById.get(openSubagentId) : undefined;
  const isOpenSubagentRunning = Boolean(
    openSubagentActivity && !["completed", "failed", "cancelled"].includes(String(openSubagentActivity.state || "")),
  );

  return {
    subagentActivities,
    nonSubagentLiveActivities,
    subagentActivityById,
    subagentThinkingById,
    openSubagentActivity,
    isOpenSubagentRunning,
  };
}
