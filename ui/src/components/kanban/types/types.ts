/**
 * 项目看板（Kanban）UI 类型——与 gateway `kanban_*` 响应结构对齐。
 *
 * 底层契约见 `src/board/protocol/types.ts` 与 `src/gateway/kanban/types.ts`；
 * 本文件为浏览器侧的 TS 镜像，不应导入 src/（边界纪律：ui/ 只经 gateway 帧通信）。
 */

export type BoardPriority = "high" | "medium" | "low";

export interface BoardCardSource {
  sessionKey: string;
  turnId: string;
  at: string;
}

export interface BoardColumn {
  id: string;
  title: string;
  color: string;
}

export interface BoardCard {
  id: string;
  columnId: string;
  title: string;
  note: string;
  label: string;
  priority: BoardPriority;
  color: string;
  dueDate?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  source?: BoardCardSource;
}

export interface BoardState {
  version: number;
  columns: BoardColumn[];
  cards: BoardCard[];
  seq: number;
}

export type KanbanUpdatedKind = "card" | "column" | "board";

export interface KanbanUpdatedPayload {
  projectId: string;
  kind: KanbanUpdatedKind;
  cardId?: string;
  columnId?: string;
  at: string;
}

/** 来自 gateway kanban_* 操作的错误信封。 */
export interface KanbanError {
  code: string;
  message: string;
}

/** gateway 未配置看板时的降级响应（error: { code: "not_configured" }）。 */
export type KanbanResult<T> = T & { error?: KanbanError };
