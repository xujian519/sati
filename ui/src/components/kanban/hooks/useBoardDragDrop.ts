import { useCallback, useMemo, useState } from "react";
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { BoardCard } from "../types/types";
import { dropToGlobalIndex, getCard } from "../utils/boardPosition";

export type KanbanDropTarget = { columnId: string; toIndex?: number };

type UseBoardDragDropArgs = {
  cards: BoardCard[];
  onDrop: (cardId: string, target: KanbanDropTarget) => void;
};

/**
 * 看板拖拽逻辑（dnd-kit）。
 *
 * 每张卡用 `useSortable`（data.type === "card"），每列用 `useDroppable`（data.type === "column"）。
 * 拖拽结束在此换算目标：`toIndex` 采用与后端一致的**全局数组索引**
 * （见 `utils/boardPosition.dropToGlobalIndex`），再交给 onDrop 乐观更新并落盘。
 */
export function useBoardDragDrop({ cards, onDrop }: UseBoardDragDropArgs) {
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const activeCard: BoardCard | null = useMemo(
    () => (activeCardId ? (getCard(cards, activeCardId) ?? null) : null),
    [cards, activeCardId],
  );

  const resolveDrop = useCallback(
    (over: DragEndEvent["over"], activeId: UniqueIdentifier): KanbanDropTarget | null => {
      if (!over) return null;
      const overData = (over.data.current ?? {}) as { type?: string; columnId?: string };
      const columnId = typeof overData.columnId === "string" ? overData.columnId : String(over.id);
      const overCardId = overData.type === "card" ? over.id : null;
      const toIndex =
        typeof overCardId === "string" && overCardId
          ? dropToGlobalIndex(cards, String(activeId), overCardId)
          : undefined;
      return { columnId, toIndex };
    },
    [cards],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveCardId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveCardId(null);
      const activeId = String(event.active.id);
      const target = resolveDrop(event.over, activeId);
      if (target && target.columnId) {
        onDrop(activeId, target);
      }
    },
    [onDrop, resolveDrop],
  );

  const handleDragCancel = useCallback(() => {
    setActiveCardId(null);
  }, []);

  return {
    sensors,
    activeCard,
    dndContextProps: {
      sensors,
      onDragStart: handleDragStart,
      onDragEnd: handleDragEnd,
      onDragCancel: handleDragCancel,
    },
  };
}
