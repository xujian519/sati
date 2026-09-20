import { useEffect } from "react";
import { logError } from "../../../utils/logging";
import { authenticatedFetch } from "../../../utils/api";
import type { Project, ProjectSession } from "../../../types/app";

/**
 * 会话的 token 用量 —— 从 `useChatSessionState` 拆出的独立 hook（issue #467）。
 *
 * 一条 effect：进入真实会话（非 read-only、非 `new-session-*`）时取一次
 * `/token-usage` 落 `tokenBudget`；`!ok` 或异常一律置 null（面板不显示陈旧数字）。
 *
 * 台账把「token 统计」判为**不成族**（外置只搬得走约 30 行，收益与 review 成本不成比例）；
 * 它这里外置不是因为自成一体，而是因为它在拆分前的 effect 顺序里夹在搜索定位与锚定之间
 * （M6），单列一个调用点才能保持 17 条 effect 的展开顺序索引一一对应。
 */

export interface UseChatTokenUsageArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  sessionIsReadOnly: boolean;
  setTokenBudget: (value: Record<string, unknown> | null) => void;
}

export function useChatTokenUsage({
  selectedProject,
  selectedSession,
  sessionIsReadOnly,
  setTokenBudget,
}: UseChatTokenUsageArgs) {
  useEffect(() => {
    if (!selectedProject || !selectedSession?.id || selectedSession.id.startsWith("new-session-")) {
      setTokenBudget(null);
      return;
    }
    if (sessionIsReadOnly) {
      setTokenBudget(null);
      return;
    }

    const fetchInitialTokenUsage = async () => {
      try {
        const url = `/api/projects/${selectedProject.name}/sessions/${encodeURIComponent(selectedSession.id)}/token-usage?provider=sati`;
        const response = await authenticatedFetch(url);
        if (response.ok) {
          setTokenBudget(await response.json());
        } else {
          setTokenBudget(null);
        }
      } catch (error) {
        logError("Failed to fetch initial token usage:", error);
      }
    };
    fetchInitialTokenUsage();
    // 依赖取 selectedSession?.id 而非对象本身：会话列表刷新会换新对象身份，
    // 按对象比较会多发请求（与拆分前的触发时机保持一致，#467 纯搬迁）。
  }, [sessionIsReadOnly, selectedProject, selectedSession?.id, setTokenBudget]);
}
