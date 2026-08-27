import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../utils/api";
import { useWebSocket } from "../../../contexts/WebSocketContext";
import { applyMove, getCard } from "../utils/boardPosition";
import type { BoardCard, BoardColumn, BoardPriority, BoardState } from "../types/types";

export type KanbanMutationResult = { ok: boolean; error?: string };

/**
 * 网关载荷的边界结构校验（TD-UI-CHAT-N14）：UI 类型是 src/ 协议的手工镜像，
 * 编译期互不约束；此处在唯一入口 `refresh()` 收窄一次形状，契约漂移时以
 * 可诊断的 error 呈现，而不是 undefined 字段渗入渲染层。只查关键字段骨架，
 * 不做逐字段全量校验。
 */
function parseBoardState(value: unknown): { state?: BoardState; problem?: string } {
  if (typeof value !== "object" || value === null) return { problem: "board payload is not an object" };
  const v = value as Record<string, unknown>;
  const columns = v.columns;
  const cards = v.cards;
  if (!Array.isArray(columns) || !Array.isArray(cards)) {
    return { problem: "board payload missing columns/cards arrays" };
  }
  for (const c of columns) {
    const col = c as Partial<BoardColumn>;
    if (typeof col?.id !== "string" || typeof col?.title !== "string" || typeof col?.color !== "string") {
      return { problem: "board column entry malformed" };
    }
  }
  for (const c of cards) {
    const card = c as Partial<BoardCard>;
    if (typeof card?.id !== "string" || typeof card?.columnId !== "string" || typeof card?.title !== "string") {
      return { problem: "board card entry malformed" };
    }
  }
  return { state: value as BoardState };
}

type UseBoardStateArgs = {
  /** 项目根目录；作为 gateway 的 projectKey/projectId。为空时不加载。 */
  projectKey: string | null;
};

/** 乐观变更涉及的板切片：回滚按切片整体还原。 */
type BoardSliceKey = "cards" | "columns";

export function useBoardState({ projectKey }: UseBoardStateArgs) {
  const { t } = useTranslation("kanban");
  const { subscribe, sendMessage } = useWebSocket();
  const [board, setBoard] = useState<BoardState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectKeyRef = useRef<string | null>(null);
  projectKeyRef.current = projectKey;

  const refresh = useCallback(async (): Promise<void> => {
    const currentProjectKey = projectKeyRef.current;
    if (!currentProjectKey) return;
    try {
      // includeArchived: true 让回收站视图可用；默认 View 过滤 archived 卡片。
      const result = await api.kanban.get({ projectKey: currentProjectKey, includeArchived: true });
      if (result?.error) {
        setError(result.error.message);
        return;
      }
      const parsed = parseBoardState(result);
      if (!parsed.state) {
        setError(`Kanban board payload rejected: ${parsed.problem ?? "unknown"}`);
        return;
      }
      setBoard(parsed.state);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 项目切换或首次挂载：加载板 + 订阅该项目的 kanban_updated 实时事件。
  useEffect(() => {
    const currentProjectKey = projectKey;
    if (!currentProjectKey) {
      setBoard(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    setBoard(null);
    void refresh().finally(() => {
      if (!cancelled) setLoading(false);
    });

    sendMessage({ type: "kanban-watch", projectId: currentProjectKey });

    return () => {
      cancelled = true;
      sendMessage({ type: "kanban-unwatch", projectId: currentProjectKey });
    };
    // 仅在 projectKey 或 refresh 引用变化时重建；sendMessage 用稳定引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey, refresh]);

  // 订阅 kanban_updated：目标项目的事件触发重建（agent 写卡后 UI 实时变）。
  // 断线重连（websocket-reconnected）时重新订阅当前项目并重拉一次板，避免实时推送中断。
  useEffect(() => {
    const unsubscribe = subscribe(message => {
      if (message?.type === "websocket-reconnected") {
        const current = projectKeyRef.current;
        if (current) {
          sendMessage({ type: "kanban-watch", projectId: current });
          void refresh();
        }
        return;
      }
      if (message?.type !== "kanban_updated") return;
      const payload = message.payload as { projectId?: string } | undefined;
      if (!payload || payload.projectId !== projectKeyRef.current) return;
      void refresh();
    });
    return unsubscribe;
  }, [subscribe, refresh, sendMessage]);

  /**
   * 全部看板变更的统一执行体（TD-UI-CHAT-N14 折叠）：
   * - 项目守卫（未选项目时返回统一错误结果）；
   * - 通过 guard 捕获 API 异常 → 写入 error 态并返回失败结果；
   * - 成功路径统一清错；
   * - 提供 `optimistic` 时先乐观改对应切片，失败则整片回滚并 refresh 兜底，
     回滚不再依赖各调用点自行记得快照（结构性保证）。
   */
  const mutate = useCallback(
    async (
      options: {
        slice?: BoardSliceKey;
        optimistic?: (prev: BoardState) => BoardState;
      },
      run: (projectKey: string) => Promise<void>,
    ): Promise<KanbanMutationResult> => {
      const currentProjectKey = projectKeyRef.current;
      if (!currentProjectKey) return { ok: false, error: t("errors.noProjectSelected") };
      const { slice, optimistic } = options;
      const previousSlice = slice && board ? board[slice] : undefined;
      if (slice && optimistic) setBoard(prev => (prev ? optimistic(prev) : prev));
      const result = await (async (): Promise<KanbanMutationResult> => {
        try {
          await run(currentProjectKey);
          return { ok: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          return { ok: false, error: message };
        }
      })();
      if (!result.ok) {
        if (slice && previousSlice !== undefined) {
          setBoard(prev => (prev ? { ...prev, [slice]: previousSlice } : prev));
          await refresh();
        }
        return result;
      }
      setError(null);
      return result;
    },
    [board, t, refresh],
  );

  const addCard = useCallback(
    async (fields: {
      columnId: string;
      title: string;
      note?: string;
      label?: string;
      priority?: BoardPriority;
      color?: string;
      dueDate?: string;
    }): Promise<KanbanMutationResult> =>
      mutate({}, async projectKey => {
        const result = await api.kanban.addCard({ projectKey, ...fields });
        if (result?.error) throw new Error(result.error.message);
        if (result?.card) {
          const newCard = result.card as BoardCard;
          setBoard(prev => (prev ? { ...prev, cards: [...prev.cards, newCard] } : prev));
        } else {
          await refresh();
        }
      }),
    [mutate, refresh],
  );

  const updateCard = useCallback(
    async (
      cardId: string,
      fields: Partial<Pick<BoardCard, "title" | "note" | "label" | "priority" | "color" | "dueDate">>,
    ): Promise<KanbanMutationResult> =>
      mutate({}, async projectKey => {
        const result = await api.kanban.updateCard({ projectKey, cardId, ...fields });
        if (result?.error) throw new Error(result.error.message);
        if (result?.card) {
          const updatedCard = result.card as BoardCard;
          setBoard(prev =>
            prev ? { ...prev, cards: prev.cards.map(card => (card.id === updatedCard.id ? updatedCard : card)) } : prev,
          );
        } else {
          await refresh();
        }
      }),
    [mutate, refresh],
  );

  const moveCard = useCallback(
    async (cardId: string, columnId: string, toIndex?: number): Promise<KanbanMutationResult> =>
      mutate(
        { slice: "cards", optimistic: prev => ({ ...prev, cards: applyMove(prev.cards, cardId, columnId, toIndex) }) },
        async projectKey => {
          const serverResult = await api.kanban.moveCard({ projectKey, cardId, columnId, toIndex });
          if (serverResult?.error) throw new Error(serverResult.error.message);
        },
      ),
    [mutate],
  );

  const archiveCard = useCallback(
    async (cardId: string): Promise<KanbanMutationResult> =>
      mutate(
        {
          slice: "cards",
          optimistic: prev => ({
            ...prev,
            cards: prev.cards.map(card => (card.id === cardId ? { ...card, archived: true } : card)),
          }),
        },
        async projectKey => {
          const serverResult = await api.kanban.archiveCard({ projectKey, cardId });
          if (serverResult?.error) throw new Error(serverResult.error.message);
        },
      ),
    [mutate],
  );

  const restoreCard = useCallback(
    async (cardId: string): Promise<KanbanMutationResult> =>
      mutate(
        {
          slice: "cards",
          optimistic: prev => ({
            ...prev,
            cards: prev.cards.map(card => (card.id === cardId ? { ...card, archived: false } : card)),
          }),
        },
        async projectKey => {
          const serverResult = await api.kanban.restoreCard({ projectKey, cardId });
          if (serverResult?.error) throw new Error(serverResult.error.message);
        },
      ),
    [mutate],
  );

  const purgeCard = useCallback(
    async (cardId: string): Promise<KanbanMutationResult> =>
      mutate(
        {
          slice: "cards",
          optimistic: prev => ({ ...prev, cards: prev.cards.filter(card => card.id !== cardId) }),
        },
        async projectKey => {
          const serverResult = await api.kanban.purgeCard({ projectKey, cardId });
          if (serverResult?.error) throw new Error(serverResult.error.message);
        },
      ),
    [mutate],
  );

  const duplicateCard = useCallback(
    async (cardId: string, columnId?: string, toIndex?: number): Promise<KanbanMutationResult> =>
      mutate({}, async projectKey => {
        const result = await api.kanban.duplicateCard({ projectKey, cardId, columnId, toIndex });
        if (result?.error) throw new Error(result.error.message);
        if (result?.card) {
          const newCard = result.card as BoardCard;
          setBoard(prev => (prev ? { ...prev, cards: [...prev.cards, newCard] } : prev));
        } else {
          await refresh();
        }
      }),
    [mutate, refresh],
  );

  const bulkArchiveCards = useCallback(
    async (ids: string[]): Promise<KanbanMutationResult> =>
      mutate({}, async projectKey => {
        const result = await api.kanban.bulkArchiveCards({ projectKey, ids });
        if (result?.error) throw new Error(result.error.message);
        await refresh();
      }),
    [mutate, refresh],
  );

  const bulkMoveCards = useCallback(
    async (ids: string[], columnId: string): Promise<KanbanMutationResult> =>
      mutate({}, async projectKey => {
        const result = await api.kanban.bulkMoveCards({ projectKey, ids, columnId });
        if (result?.error) throw new Error(result.error.message);
        await refresh();
      }),
    [mutate, refresh],
  );

  const moveToProject = useCallback(
    async (cardId: string, toProjectKey: string): Promise<KanbanMutationResult> =>
      mutate(
        {
          slice: "cards",
          optimistic: prev => ({ ...prev, cards: prev.cards.filter(card => card.id !== cardId) }),
        },
        async projectKey => {
          const serverResult = await api.kanban.moveToProject({ projectKey, cardId, toProjectKey });
          if (serverResult?.error) throw new Error(serverResult.error.message);
        },
      ),
    [mutate],
  );

  const addColumn = useCallback(
    async (title: string, color?: string): Promise<KanbanMutationResult> =>
      mutate({}, async projectKey => {
        const result = await api.kanban.addColumn({ projectKey, title, color });
        if (result?.error) throw new Error(result.error.message);
        if (result?.column) {
          const newColumn = result.column as BoardColumn;
          setBoard(prev => (prev ? { ...prev, columns: [...prev.columns, newColumn] } : prev));
        } else {
          await refresh();
        }
      }),
    [mutate, refresh],
  );

  const renameColumn = useCallback(
    async (columnId: string, title: string): Promise<KanbanMutationResult> =>
      mutate({}, async projectKey => {
        const result = await api.kanban.renameColumn({ projectKey, columnId, title });
        if (result?.error) throw new Error(result.error.message);
        await refresh();
      }),
    [mutate, refresh],
  );

  const deleteColumn = useCallback(
    async (columnId: string): Promise<KanbanMutationResult> =>
      mutate({}, async projectKey => {
        const result = await api.kanban.deleteColumn({ projectKey, columnId });
        if (result?.error) throw new Error(result.error.message);
        await refresh();
      }),
    [mutate, refresh],
  );

  const reorderColumns = useCallback(
    async (columnIds: string[]): Promise<KanbanMutationResult> =>
      mutate(
        {
          slice: "columns",
          optimistic: prev => {
            const byId = new Map(prev.columns.map(column => [column.id, column]));
            const next = columnIds
              .map(id => byId.get(id))
              .filter((column): column is NonNullable<typeof column> => Boolean(column));
            return next.length === prev.columns.length ? { ...prev, columns: next } : prev;
          },
        },
        async projectKey => {
          const serverResult = await api.kanban.reorderColumns({ projectKey, columnIds });
          if (serverResult?.error) throw new Error(serverResult.error.message);
        },
      ),
    [mutate],
  );

  const undo = useCallback(
    async (): Promise<KanbanMutationResult> =>
      mutate({}, async projectKey => {
        const result = await api.kanban.undo({ projectKey });
        if (result?.error) throw new Error(result.error.message);
        await refresh();
      }),
    [mutate, refresh],
  );

  return {
    board,
    loading,
    error,
    refresh,
    addCard,
    updateCard,
    moveCard,
    archiveCard,
    restoreCard,
    purgeCard,
    duplicateCard,
    bulkArchiveCards,
    bulkMoveCards,
    moveToProject,
    addColumn,
    renameColumn,
    deleteColumn,
    reorderColumns,
    undo,
    getCard: (cardId: string) => (board ? getCard(board.cards, cardId) : undefined),
  };
}
