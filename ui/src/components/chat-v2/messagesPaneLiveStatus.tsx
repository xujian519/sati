import { useEffect, useMemo, useRef, useState } from "react";
import { UI_TIMEOUTS } from "../../constants/timeouts";
import type { ChatMessage, ClaudeWorkStatus, SatiWorkStatus } from "../chat/types/types";
import { ProcessRunHeader, type ProcessTraceStep } from "./ProcessTrace";
import { formatProcessDuration } from "./processTraceUtils";

// eslint-disable-next-line react-refresh/only-export-components -- 本模块同时导出实时状态组件与纯函数，见文件头说明
export function getLatestActivity(activities: ChatMessage[]): ChatMessage | null {
  const byId = new Map<string, ChatMessage>();
  for (const activity of activities) {
    const key = activity.activityId || activity.id || `${activity.runId}-${activity.timestamp}`;
    byId.set(key, activity);
  }
  const latest = Array.from(byId.values());
  return [...latest].reverse().find(activity => activity.state === "running") || null;
}

// eslint-disable-next-line react-refresh/only-export-components -- 同上
export function activityToLiveStep(activity: ChatMessage): ProcessTraceStep {
  return {
    id: activity.activityId || activity.id,
    title: activity.title || activity.content || activity.toolName || "",
    detail: activity.detail || "",
    state: activity.state || "running",
    severity: activity.severity,
    phase: activity.phase,
    toolName: activity.toolName,
  };
}

// eslint-disable-next-line react-refresh/only-export-components -- 同上
export function getLiveStatusStep(
  activities: ChatMessage[],
  workingStatus: ClaudeWorkStatus | SatiWorkStatus | null | undefined,
  hasAssistantContent: boolean,
  hasPendingToolUse: boolean,
  t: (key: string, options?: Record<string, unknown>) => string,
): ProcessTraceStep {
  const latestActivity = getLatestActivity(activities);
  if (latestActivity) {
    return activityToLiveStep(latestActivity);
  }

  const retryProgress = (workingStatus as SatiWorkStatus | null | undefined)?.retryProgress;
  if (retryProgress) {
    const parts: string[] = [];
    if (retryProgress.reason) parts.push(retryProgress.reason);
    if (retryProgress.provider) parts.push(retryProgress.provider);
    if (retryProgress.model) parts.push(retryProgress.model);
    const delayStr = retryProgress.delayMs ? ` (${Math.round(retryProgress.delayMs / 1000)}s)` : "";
    return {
      id: "live-retry",
      title: t("working.retrying", {
        defaultValue: "Reconnecting {{attempt}}/{{max}}{{delay}}",
        attempt: retryProgress.attempt,
        max: retryProgress.maxAttempts,
        delay: delayStr,
      }),
      detail: parts.join(" · "),
      phase: "retry",
      state: "running",
      severity: "warning",
    };
  }

  if (workingStatus?.compactProgress) {
    const progress = workingStatus.compactProgress;
    // 失败/中断的压缩不是「正在压缩」：给出对应标题与 severity，否则用户看到的是
    // 一个永远转圈的「Compacting context...」（上游 #570 移植）。
    let title = t("working.compacting", { defaultValue: "Compacting context..." });
    let severity: "error" | undefined;
    if (progress.state === "cancelled") {
      title = t("working.compactCancelled", { defaultValue: "Context compaction stopped" });
      severity = "error";
    } else if (progress.state === "failed") {
      title = t("working.compactFailed", { defaultValue: "Context compaction failed" });
      severity = "error";
    }
    return {
      id: "live-compact",
      title,
      detail: progress.label || progress.stage || "",
      phase: "compact",
      state: progress.state || "running",
      ...(severity ? { severity } : {}),
    };
  }

  const rawStatus = String(workingStatus?.text || "").toLowerCase();
  if (rawStatus.includes("model_request_started")) {
    if (hasPendingToolUse) {
      return {
        id: "live-tool-exec",
        title: t("working.executingTool", { defaultValue: "Running tool..." }),
        phase: "tool",
        state: "running",
      };
    }
    return {
      id: "live-model-call",
      title: t("working.callingModel", { defaultValue: "Calling model..." }),
      phase: "generation",
      state: "running",
    };
  }
  if (rawStatus.includes("permission")) {
    return {
      id: "live-permission",
      title: t("working.waitingForPermission", { defaultValue: "Waiting for permission" }),
      phase: "permission",
      state: "running",
      severity: "warning",
    };
  }
  if (rawStatus.includes("compact")) {
    return {
      id: "live-compact",
      title: t("working.compacting", { defaultValue: "Compacting context..." }),
      phase: "compact",
      state: "running",
    };
  }

  return hasAssistantContent
    ? {
        id: "live-generation",
        title: t("working.generating", { defaultValue: "Generating response" }),
        phase: "generation",
        state: "running",
      }
    : {
        id: "live-thinking",
        title: t("working.thinking", { defaultValue: "Connecting..." }),
        phase: "thinking",
        state: "running",
      };
}

// eslint-disable-next-line react-refresh/only-export-components -- 同上
export function getLiveProcessStartedAtMs(activities: ChatMessage[], fallbackStartedAtMs: number): number {
  if (activities.length === 0) return fallbackStartedAtMs;

  // `activityMessages` accumulates across turns in the session store, so the
  // raw list can include activities from previous runs. Scope the start time
  // to the current run by anchoring on the most recently received activity's
  // `runId` and picking the earliest start within that run.
  const latestActivity = activities[activities.length - 1];
  const latestRunId = latestActivity?.runId;
  const currentRunActivities = latestRunId ? activities.filter(activity => activity.runId === latestRunId) : activities;

  let earliestMs = Number.POSITIVE_INFINITY;
  for (const activity of currentRunActivities) {
    const value = activity.startedAt || activity.timestamp;
    const parsed = value ? Date.parse(String(value)) : NaN;
    if (Number.isFinite(parsed) && parsed < earliestMs) {
      earliestMs = parsed;
    }
  }
  return Number.isFinite(earliestMs) ? earliestMs : fallbackStartedAtMs;
}

export function LiveProcessHeader({
  activities,
  startedAtMs,
  t,
}: {
  activities: ChatMessage[];
  startedAtMs: number | null;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const fallbackStartedAtRef = useRef(Date.now());
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), UI_TIMEOUTS.LIVE_ELAPSED_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const elapsedMs = useMemo(() => {
    const effectiveStartedAtMs = startedAtMs ?? getLiveProcessStartedAtMs(activities, fallbackStartedAtRef.current);
    return Math.max(0, nowMs - effectiveStartedAtMs);
  }, [activities, nowMs, startedAtMs]);
  const duration = formatProcessDuration(elapsedMs);
  const label = t("process.summary.processed", {
    duration,
    defaultValue: `Processed ${duration}`,
  });

  return <ProcessRunHeader label={label} />;
}

export function CompletedProcessHeader({
  durationMs,
  t,
}: {
  durationMs: number;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const duration = formatProcessDuration(durationMs);
  const label = t("process.summary.processed", {
    duration,
    defaultValue: `Processed ${duration}`,
  });

  return <ProcessRunHeader label={label} />;
}
