import { useCallback, useEffect, useState } from "react";
import { authenticatedFetch } from "../../../utils/api";
import { TEAM_PANEL_POLL_MS } from "../constants";
import type { PanelActionResult, TeamPanelSnapshot } from "../types";

// api.js 无类型声明；按实际签名收窄（suppressServerErrorToast 为 500 时抑制 toast 的选项）。
const fetchWithAuth = authenticatedFetch as (
  url: string,
  options?: RequestInit & { suppressServerErrorToast?: boolean },
) => Promise<Response>;

/** 拉取面板快照（POST /api/teams/panel；sessionKey 留空 = 全部团队）。 */
async function fetchSnapshot(): Promise<TeamPanelSnapshot> {
  const response = await fetchWithAuth("/api/teams/panel", {
    method: "POST",
    suppressServerErrorToast: true, // 轮询 5s/tick，500 时不 toast 轰炸
    body: JSON.stringify({ sessionKey: undefined }),
  });
  if (!response.ok) {
    throw new Error(`团队面板快照获取失败: HTTP ${response.status}`);
  }
  return (await response.json()) as TeamPanelSnapshot;
}

/** 调用面板操作（POST /api/teams/action，直调既有 team_* 工具）。 */
async function callTool(tool: string, input: Record<string, unknown>): Promise<PanelActionResult> {
  const response = await fetchWithAuth("/api/teams/action", {
    method: "POST",
    suppressServerErrorToast: true,
    body: JSON.stringify({ tool, input }),
  });
  if (!response.ok) {
    // ui/server 无自定义 error handler：500 时 next(error) 落 Express 默认 handler 返回 HTML，
    // 若不拦截此处 response.json() 会抛未包装的解析错误
    throw new Error(`团队面板操作失败: HTTP ${response.status}`);
  }
  return (await response.json()) as PanelActionResult;
}

/**
 * 团队活动面板数据层：快照轮询 + 操作调用。
 * 事件流由 useSessionWatch 既有链路订阅，见 Task 9 接线。
 */
export function useTeamPanel() {
  const [snapshot, setSnapshot] = useState<TeamPanelSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    setLoading(true);
    try {
      const next = await fetchSnapshot();
      setSnapshot(next);
      setError(null);
    } catch (err) {
      // silent 刷新（操作成功后的即时刷新）失败不覆盖 error 语义，避免误导
      if (!opts?.silent) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), TEAM_PANEL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const callAction = useCallback(
    async (tool: string, input: Record<string, unknown>) => {
      const result = await callTool(tool, input);
      if (result.ok) {
        // 成功时立即刷新，不等下一轮询
        void refresh({ silent: true });
      }
      return result;
    },
    [refresh],
  );

  return { snapshot, loading, error, refresh, callAction };
}
