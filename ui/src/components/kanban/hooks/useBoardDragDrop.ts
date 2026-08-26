import { useCallback, useMemo, useState } from "react";
import {
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { BoardCard, BoardColumn } from "../types/types";
import { dropToGlobalIndex, getCard } from "../utils/boardPosition";

export type KanbanDropTarget = { columnId: string; toIndex?: number };

type UseBoardDragDropArgs = {
  cards: BoardCard[];
  columns: BoardColumn[];
  onDrop: (cardId: string, target: KanbanDropTarget) => void;
  onReorderColumns: (columnIds: string[]) => void;
};

/**
 * 看板拖拽逻辑（dnd-kit），同时支持卡片与列的拖拽。
 *
 * - 卡片用 `useSortable`（data.type === "card"），列用 `useSortable`（data.type === "column"，
 *   作为卡片落点 + 列拖拽重排）。两者在同一个顶层 `DndContext` 下、不同层级的
 *   SortableContext 内，靠 `data.type` 在 `onDragEnd` 路由。
 * - 卡片 `toIndex` 采用与后端一致的**全局数组索引**（`dropToGlobalIndex`）。
 * - 列重排：把 active 列移到 over 列的位置，产出新列顺序交给 `onReorderColumns`。
 */
export function useBoardDragDrop({ cards, columns, onDrop, onReorderColumns }: UseBoardDragDropArgs) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const activeCard: BoardCard | null = useMemo(
    () => (activeId ? (getCard(cards, activeId) ?? null) : null),
    [cards, activeId],
  );

  const resolveCardDrop = useCallback(
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

  const computeColumnOrder = useCallback(
    (activeColumnId: string, overColumnId?: string | null): string[] | null => {
      if (!overColumnId || activeColumnId === overColumnId) return null;
      const ids = columns.map(column => column.id);
      const from = ids.indexOf(activeColumnId);
      const to = ids.indexOf(overColumnId);
      if (from === -1 || to === -1 || from === to) return null;
      const next = [...ids];
      next.splice(from, 1);
      next.splice(to, 0, activeColumnId);
      return next;
    },
    [columns],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      const activeIdStr = String(event.active.id);
      const activeData = (event.active.data.current ?? {}) as { type?: string };
      if (activeData.type === "column") {
        const order = computeColumnOrder(activeIdStr, event.over ? String(event.over.id) : null);
        if (order) onReorderColumns(order);
        return;
      }
      const target = resolveCardDrop(event.over, activeIdStr);
      if (target && target.columnId) onDrop(activeIdStr, target);
    },
    [computeColumnOrder, onDrop, onReorderColumns, resolveCardDrop],
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
  }, []);

  return {
    sensors,
    activeCard,
    dndContextProps: {
      sensors,
      collisionDetection: closestCorners,
      onDragStart: handleDragStart,
      onDragEnd: handleDragEnd,
      onDragCancel: handleDragCancel,
    },
  };
}
