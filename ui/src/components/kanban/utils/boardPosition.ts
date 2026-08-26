/**
 * 看板卡片排序纯函数。
 *
 * 后端的 `BoardStore.moveCard(cardId, { columnId, toIndex })` 以**全局数组索引**
 * `toIndex` 重排（`splice` 到 `state.cards` 上，见 `src/board/storage/BoardStore.ts`）。
 * 本文件在浏览器侧复刻同一算法，供拖拽乐观更新与发送给 gateway 的 `toIndex` 使用，
 * 确保 UI 视觉顺序与服务端落盘顺序一致。
 */

import type { BoardCard } from "../types/types";

/** 取某列下的卡片（保持全局数组内的相对顺序）。 */
export function cardsByColumn(cards: BoardCard[], columnId: string): BoardCard[] {
  return cards.filter(card => card.columnId === columnId);
}

export function getCard(cards: BoardCard[], cardId: string): BoardCard | undefined {
  return cards.find(card => card.id === cardId);
}

/** clamp 到 [0, length]，复刻后端 `Math.max(0, Math.min(toIndex, length))`。 */
function clampIndex(toIndex: number, length: number): number {
  return Math.max(0, Math.min(toIndex, length));
}

/**
 * 计算移动后的全局插入索引 `toIndex`（供发送 gateway 或做乐观更新）。
 *
 * @param cards 当前卡片数组。
 * @param cardId 被拖拽的卡片 id。
 * @param overCardId 落点所在卡 id；`null`/`undefined`/`""` 表示落到列尾。
 * @returns 从数组中移除 `cardId` 后，插入位置所处的全局索引。
 */
export function dropToGlobalIndex(cards: BoardCard[], cardId: string, overCardId?: string | null): number {
  const rest = cards.filter(card => card.id !== cardId);
  if (overCardId) {
    const overIndex = rest.findIndex(card => card.id === overCardId);
    if (overIndex !== -1) return overIndex;
  }
  return rest.length;
}

/**
 * 乐观更新：把 `cardId` 移动到 `columnId` 的 `toIndex` 位置（复刻 store.moveCard）。
 *
 * @returns 新的卡片数组（不变地返回原数组结构的新副本）。
 */
export function applyMove(
  cards: BoardCard[],
  cardId: string,
  columnId: string,
  toIndex?: number,
  nowIso = new Date().toISOString(),
): BoardCard[] {
  const sourceIndex = cards.findIndex(card => card.id === cardId);
  if (sourceIndex === -1) return cards;

  const next = [...cards];
  const [moved] = next.splice(sourceIndex, 1);
  if (!moved) return cards;

  const updated: BoardCard = { ...moved, columnId, updatedAt: nowIso };
  const targetIndex = toIndex !== undefined ? clampIndex(toIndex, next.length) : next.length;
  next.splice(targetIndex, 0, updated);
  return next;
}
