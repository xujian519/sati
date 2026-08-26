import { useCallback, useEffect, useRef, useState } from "react";
import i18n from "../../../i18n/config";
import { api } from "../../../utils/api";
import { useWebSocket } from "../../../contexts/WebSocketContext";
import { applyMove, getCard } from "../utils/boardPosition";
import type { BoardCard, BoardColumn, BoardPriority, BoardState } from "../types/types";

export type KanbanMutationResult = { ok: boolean; error?: string };

/** 未选项目时的统一错误结果（供各变更 hook 复用）。 */
function missingProjectError(): KanbanMutationResult {
  return { ok: false, error: i18n.t("kanban:errors.noProjectSelected") };
}

type UseBoardStateArgs = {
  /** 项目根目录；作为 gateway 的 projectKey/projectId。为空时不加载。 */
  projectKey: string | null;
};

export function useBoardState({ projectKey }: UseBoardStateArgs) {
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
      setBoard(result as BoardState);
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

  const guard = useCallback(async (fn: () => Promise<unknown>): Promise<KanbanMutationResult> => {
    try {
      await fn();
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return { ok: false, error: message };
    }
  }, []);

  const addCard = useCallback(
    async (fields: {
      columnId: string;
      title: string;
      note?: string;
      label?: string;
      priority?: BoardPriority;
      color?: string;
      dueDate?: string;
    }): Promise<KanbanMutationResult> => {
      const currentProjectKey = projectKeyRef.current;
      if (!currentProjectKey) return missingProjectError();
      return guard(async () => {
        const result = await api.kanban.addCard({ projectKey: currentProjectKey, ...fields });
        if (result?.error) throw new Error(result.error.message);
        if (result?.card) {
          const newCard = result.card as BoardCard;
          setBoard(prev => (prev ? { ...prev, cards: [...prev.cards, newCard] } : prev));
        } else {
          await refresh();
        }
        setError(null);
      });
    },
    [guard, refresh],
  );

  const updateCard = useCallback(
    async (
      cardId: string,
      fields: Partial<Pick<BoardCard, "title" | "note" | "label" | "priority" | "color" | "dueDate">>,
    ): Promise<KanbanMutationResult> => {
      const currentProjectKey = projectKeyRef.current;
      if (!currentProjectKey) return missingProjectError();
      return guard(async () => {
        const result = await api.kanban.updateCard({ projectKey: currentProjectKey, cardId, ...fields });
        if (result?.error) throw new Error(result.error.message);
        if (result?.card) {
          const updatedCard = result.card as BoardCard;
          setBoard(prev =>
            prev ? { ...prev, cards: prev.cards.map(card => (card.id === updatedCard.id ? updatedCard : card)) } : prev,
          );
        } else {
          await refresh();
        }
        setError(null);
      });
    },
    [guard, refresh],
  );

  const moveCard = useCallback(
    async (cardId: string, columnId: string, toIndex?: number): Promise<KanbanMutationResult> => {
      const currentProjectKey = projectKeyRef.current;
      if (!currentProjectKey) return missingProjectError();
      const previousCards = board?.cards;
      setBoard(prev => (prev ? { ...prev, cards: applyMove(prev.cards, cardId, columnId, toIndex) } : prev));
      const result = await guard(async () => {
        const serverResult = await api.kanban.moveCard({ projectKey: currentProjectKey, cardId, columnId, toIndex });
        if (serverResult?.error) throw new Error(serverResult.error.message);
        setError(null);
      });
      if (!result.ok && previousCards) {
        setBoard(prev => (prev ? { ...prev, cards: previousCards } : prev));
        await refresh();
      }
      return result;
    },
    [board, guard, refresh],
  );

  const archiveCard = useCallback(
    async (cardId: string): Promise<KanbanMutationResult> => {
      const currentProjectKey = projectKeyRef.current;
      if (!currentProjectKey) return missingProjectError();
      const previousCards = board?.cards;
      setBoard(prev =>
        prev
          ? { ...prev, cards: prev.cards.map(card => (card.id === cardId ? { ...card, archived: true } : card)) }
          : prev,
      );
      const result = await guard(async () => {
        const serverResult = await api.kanban.archiveCard({ projectKey: currentProjectKey, cardId });
        if (serverResult?.error) throw new Error(serverResult.error.message);
        setError(null);
      });
      if (!result.ok && previousCards) {
        setBoard(prev => (prev ? { ...prev, cards: previousCards } : prev));
        await refresh();
      }
      return result;
    },
    [board, guard, refresh],
  );

  const restoreCard = useCallback(
    async (cardId: string): Promise<KanbanMutationResult> => {
      const currentProjectKey = projectKeyRef.current;
      if (!currentProjectKey) return missingProjectError();
      const previousCards = board?.cards;
      setBoard(prev =>
        prev
          ? { ...prev, cards: prev.cards.map(card => (card.id === cardId ? { ...card, archived: false } : card)) }
          : prev,
      );
      const result = await guard(async () => {
        const serverResult = await api.kanban.restoreCard({ projectKey: currentProjectKey, cardId });
        if (serverResult?.error) throw new Error(serverResult.error.message);
        setError(null);
      });
      if (!result.ok && previousCards) {
        setBoard(prev => (prev ? { ...prev, cards: previousCards } : prev));
        await refresh();
      }
      return result;
    },
    [board, guard, refresh],
  );

  const purgeCard = useCallback(
    async (cardId: string): Promise<KanbanMutationResult> => {
      const currentProjectKey = projectKeyRef.current;
      if (!currentProjectKey) return missingProjectError();
      const previousCards = board?.cards;
      setBoard(prev => (prev ? { ...prev, cards: prev.cards.filter(card => card.id !== cardId) } : prev));
      const result = await guard(async () => {
        const serverResult = await api.kanban.purgeCard({ projectKey: currentProjectKey, cardId });
        if (serverResult?.error) throw new Error(serverResult.error.message);
        setError(null);
      });
      if (!result.ok && previousCards) {
        setBoard(prev => (prev ? { ...prev, cards: previousCards } : prev));
        await refresh();
      }
      return result;
    },
    [board, guard, refresh],
  );

  const duplicateCard = useCallback(
    async (cardId: string, columnId?: string, toIndex?: number): Promise<KanbanMutationResult> => {
      const currentProjectKey = projectKeyRef.current;
      if (!currentProjectKey) return missingProjectError();
      return guard(async () => {
        const result = await api.kanban.duplicateCard({ projectKey: currentProjectKey, cardId, columnId, toIndex });
        if (result?.error) throw new Error(result.error.message);
        if (result?.card) {
          const newCard = result.card as BoardCard;
          setBoard(prev => (prev ? { ...prev, cards: [...prev.cards, newCard] } : prev));
        } else {
          await refresh();
        }
        setError(null);
      });
    },
    [guard, refresh],
  );

  const bulkArchiveCards = useCallback(
    async (ids: string[]): Promise<KanbanMutationResult> => {
      const currentProjectKey = projectKeyRef.current;
      if (!currentProjectKey) return missingProjectError();
      return guard(async () => {
        const result = await api.kanban.bulkArchiveCards({ projectKey: currentProjectKey, ids });
        if (result?.error) throw new Error(result.error.message);
        await refresh();
        setError(null);
      });
    },
    [guard, refresh],
  );

  const bulkMoveCards = useCallback(
    async (ids: string[], columnId: string): Promise<KanbanMutationResult> => {
      const currentProjectKey = projectKeyRef.current;
      if (!currentProjectKey) return missingProjectError();
      return guard(async () => {
        const result = await api.kanban.bulkMoveCards({ projectKey: currentProjectKey, ids, columnId });
        if (result?.error) throw new Error(result.error.message);
        await refresh();
        setError(null);
      });
    },
    [guard, refresh],
  );

  const moveToProject = useCallback(
    async (cardId: string, toProjectKey: string): Promise<KanbanMutationResult> => {
      const currentProjectKey = projectKeyRef.current;
      if (!currentProjectKey) return missingProjectError();
      const previousCards = board?.cards;
      setBoard(prev => (prev ? { ...prev, cards: prev.cards.filter(card => card.id !== cardId) } : prev));
      const result = await guard(async () => {
        const serverResult = await api.kanban.moveToProject({ projectKey: currentProjectKey, cardId, toProjectKey });
        if (serverResult?.error) throw new Error(serverResult.error.message);
        setError(null);
      });
      if (!result.ok && previousCards) {
        setBoard(prev => (prev ? { ...prev, cards: previousCards } : prev));
        await refresh();
      }
      return result;
    },
    [board, guard, refresh],
  );

  const addColumn = useCallback(
    async (title: string, color?: string): Promise<KanbanMutationResult> => {
      const currentProjectKey = projectKeyRef.current;
      if (!currentProjectKey) return missingProjectError();
      return guard(async () => {
        const result = await api.kanban.addColumn({ projectKey: currentProjectKey, title, color });
        if (result?.error) throw new Error(result.error.message);
        if (result?.column) {
          const newColumn = result.column as BoardColumn;
          setBoard(prev => (prev ? { ...prev, columns: [...prev.columns, newColumn] } : prev));
        } else {
          await refresh();
        }
        setError(null);
      });
    },
    [guard, refresh],
  );

  const renameColumn = useCallback(
    async (columnId: string, title: string): Promise<KanbanMutationResult> => {
      const currentProjectKey = projectKeyRef.current;
      if (!currentProjectKey) return missingProjectError();
      return guard(async () => {
        const result = await api.kanban.renameColumn({ projectKey: currentProjectKey, columnId, title });
        if (result?.error) throw new Error(result.error.message);
        await refresh();
        setError(null);
      });
    },
    [guard, refresh],
  );

  const deleteColumn = useCallback(
    async (columnId: string): Promise<KanbanMutationResult> => {
      const currentProjectKey = projectKeyRef.current;
      if (!currentProjectKey) return missingProjectError();
      return guard(async () => {
        const result = await api.kanban.deleteColumn({ projectKey: currentProjectKey, columnId });
        if (result?.error) throw new Error(result.error.message);
        await refresh();
        setError(null);
      });
    },
    [guard, refresh],
  );

  const reorderColumns = useCallback(
    async (columnIds: string[]): Promise<KanbanMutationResult> => {
      const currentProjectKey = projectKeyRef.current;
      if (!currentProjectKey) return missingProjectError();
      const previousColumns = board?.columns;
      setBoard(prev => {
        if (!prev) return prev;
        const byId = new Map(prev.columns.map(column => [column.id, column]));
        const next = columnIds
          .map(id => byId.get(id))
          .filter((column): column is NonNullable<typeof column> => Boolean(column));
        return next.length === prev.columns.length ? { ...prev, columns: next } : prev;
      });
      const result = await guard(async () => {
        const serverResult = await api.kanban.reorderColumns({ projectKey: currentProjectKey, columnIds });
        if (serverResult?.error) throw new Error(serverResult.error.message);
        setError(null);
      });
      if (!result.ok && previousColumns) {
        setBoard(prev => (prev ? { ...prev, columns: previousColumns } : prev));
        await refresh();
      }
      return result;
    },
    [board, guard, refresh],
  );

  const undo = useCallback(async (): Promise<KanbanMutationResult> => {
    const currentProjectKey = projectKeyRef.current;
    if (!currentProjectKey) return missingProjectError();
    return guard(async () => {
      const result = await api.kanban.undo({ projectKey: currentProjectKey });
      if (result?.error) throw new Error(result.error.message);
      await refresh();
      setError(null);
    });
  }, [guard, refresh]);

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
