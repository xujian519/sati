import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../utils/api";
import type { HookTrustEntry, HookTrustSnapshot, HookTrustStatus, HookTrustVerdict } from "../types/types";

const STATUSES = new Set<HookTrustStatus>(["trusted", "pending", "stale", "revoked", "blocked"]);

/**
 * 网关载荷的形状收窄（与 kanban `parseBoardState` 同一纪律）：UI 类型是协议的手工镜像，
 * 契约漂移时以可诊断的 error 呈现，而不是让 undefined 字段渗进渲染层。只查关键骨架。
 */
function parseHookTrustSnapshot(value: unknown): { snapshot?: HookTrustSnapshot; problem?: string } {
  if (typeof value !== "object" || value === null) return { problem: "payload is not an object" };
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.entries)) return { problem: "payload missing entries array" };
  const entries: HookTrustEntry[] = [];
  for (const raw of record.entries) {
    const entry = raw as Partial<HookTrustEntry>;
    if (typeof entry?.pluginId !== "string" || typeof entry.status !== "string" || !STATUSES.has(entry.status)) {
      return { problem: "entry malformed" };
    }
    entries.push({
      pluginId: entry.pluginId,
      pluginName: typeof entry.pluginName === "string" ? entry.pluginName : entry.pluginId,
      pluginRoot: typeof entry.pluginRoot === "string" ? entry.pluginRoot : "",
      status: entry.status,
      detail: typeof entry.detail === "string" ? entry.detail : undefined,
      digest: typeof entry.digest === "string" ? entry.digest : undefined,
      hooks: Array.isArray(entry.hooks)
        ? entry.hooks.flatMap(hook =>
            typeof hook?.summary === "string"
              ? [
                  {
                    event: typeof hook.event === "string" ? hook.event : "",
                    matcher: typeof hook.matcher === "string" ? hook.matcher : undefined,
                    kind: typeof hook.kind === "string" ? hook.kind : "",
                    summary: hook.summary,
                    condition: typeof hook.condition === "string" ? hook.condition : undefined,
                  },
                ]
              : [],
          )
        : [],
    });
  }
  return {
    snapshot: {
      workspaceIdentityKey: typeof record.workspaceIdentityKey === "string" ? record.workspaceIdentityKey : "",
      entries,
    },
  };
}

export type UseHookTrustResult = {
  /** 需要用户处理的条目（`trusted` 之外）——已评审的直接不展示。 */
  pendingEntries: HookTrustEntry[];
  loading: boolean;
  error: string | null;
  /** 正在提交决定的插件 id（对应按钮进入 disabled 态）。 */
  busyPluginId: string | null;
  refresh: () => Promise<void>;
  decide: (pluginId: string, verdict: HookTrustVerdict) => Promise<void>;
};

/**
 * 项目级 hook 信任取数：项目变化时重新拉取；未评审的条目由调用方决定怎么呈现。
 *
 * 只在 `projectKey` 存在时请求（与看板同口径：项目根即 gateway 的 projectKey）。
 */
export function useHookTrust({ projectKey }: { projectKey: string | null }): UseHookTrustResult {
  const [snapshot, setSnapshot] = useState<HookTrustSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);

  const projectKeyRef = useRef<string | null>(null);
  projectKeyRef.current = projectKey;

  const refresh = useCallback(async (): Promise<void> => {
    const current = projectKeyRef.current;
    if (!current) {
      setSnapshot(null);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const payload = await api.hookTrust.list(current);
      // 慢响应可能属于上一个项目：丢弃过期结果（否则会展示别的项目的声明）。
      if (projectKeyRef.current !== current) return;
      const parsed = parseHookTrustSnapshot(payload);
      if (!parsed.snapshot) {
        setError(parsed.problem ?? "malformed payload");
        setSnapshot(null);
        return;
      }
      setSnapshot(parsed.snapshot);
      setError(null);
    } catch (err) {
      if (projectKeyRef.current !== current) return;
      setError(err instanceof Error ? err.message : String(err));
      setSnapshot(null);
    } finally {
      if (projectKeyRef.current === current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [projectKey, refresh]);

  const decide = useCallback(
    async (pluginId: string, verdict: HookTrustVerdict): Promise<void> => {
      const current = projectKeyRef.current;
      if (!current) return;
      setBusyPluginId(pluginId);
      try {
        await api.hookTrust.decide(current, pluginId, verdict);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyPluginId(null);
      }
    },
    [refresh],
  );

  return {
    pendingEntries: (snapshot?.entries ?? []).filter(entry => entry.status !== "trusted"),
    loading,
    error,
    busyPluginId,
    refresh,
    decide,
  };
}
