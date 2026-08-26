/**
 * 项目看板（Kanban）数据契约。
 *
 * - 每项目一个 `{projectRoot}/kanban-board.json`。
 * - 列 id 形如 `c<N>`，卡片 id 形如 `k<N>`，seq 按项目独立递增。
 * - 跨项目移动时，目标项目会重新生成卡片 id，避免 id 冲突。
 */

export type BoardPriority = "high" | "medium" | "low";

export interface BoardCardSource {
  /** 源会话 key（如 `session-a`）。 */
  sessionKey: string;
  /** 源 turn id。 */
  turnId: string;
  /** 产生时间（ISO 8601）。 */
  at: string;
}

export interface BoardColumn {
  /** 列 id，形如 `c<N>`。 */
  id: string;
  /** 列标题。 */
  title: string;
  /** 列头颜色，#rrggbb。 */
  color: string;
}

export interface BoardCard {
  /** 卡片 id，形如 `k<N>`。 */
  id: string;
  /** 归属列 id。 */
  columnId: string;
  /** 标题。 */
  title: string;
  /** 备注。 */
  note: string;
  /** 标签（功能 / 缺陷 / 文档 / 优化，或自定义）。 */
  label: string;
  /** 优先级。 */
  priority: BoardPriority;
  /** 卡片自定义颜色，#rrggbb。 */
  color: string;
  /** 截止日期（YYYY-MM-DD），可选。 */
  dueDate?: string;
  /** 软删标记；true 表示在回收站。 */
  archived: boolean;
  /** 创建时间（ISO 8601）。 */
  createdAt: string;
  /** 更新时间（ISO 8601）。 */
  updatedAt: string;
  /** 溯源信息；用户手工建卡可为空。 */
  source?: BoardCardSource;
}

export interface BoardState {
  /** schema 版本，迁移/默认重建依据。 */
  version: number;
  /** 列列表；顺序即列顺序。 */
  columns: BoardColumn[];
  /** 卡片列表；顺序即同列内展示顺序。 */
  cards: BoardCard[];
  /**
   * 下一个可用序号。列/卡 id 分别用 `c${seq}` / `k${seq}` 生成，
   * 每创建一次列或卡片就自增 1。seq 按项目独立维护。
   */
  seq: number;
}

/** 更新卡片时允许的字段子集。 */
export type BoardCardUpdate = Partial<
  Pick<BoardCard, "title" | "note" | "label" | "priority" | "color" | "dueDate" | "archived">
>;

/** 移动卡片时传入的目标位置。 */
export interface BoardMoveTarget {
  columnId: string;
  /** 在目标列 cards 数组中的插入位置；省略则追加到列尾。 */
  toIndex?: number;
}

/** agent 写入时的溯源信息。 */
export interface BoardActor {
  /** 会话 key。 */
  sessionKey: string;
  /** turn id。 */
  turnId: string;
}

/** 看板变更事件推送的载荷。 */
export type KanbanUpdatedKind = "card" | "column" | "board";

export interface KanbanUpdatedPayload {
  /** 项目标识（网关/工具负责把 projectRoot 映射为稳定 id）。 */
  projectId: string;
  /** 变更类型。 */
  kind: KanbanUpdatedKind;
  /** 涉及卡片 id。 */
  cardId?: string;
  /** 涉及列 id。 */
  columnId?: string;
  /** 变更时间（ISO 8601）。 */
  at: string;
}

/** BoardRuntime 构造选项。 */
export interface BoardRuntimeOptions {
  /** 项目标识，用于 `kanban_updated` 事件 payload。 */
  projectId: string;
  /** 项目根目录；BoardRuntime 内部创建 BoardStore。 */
  projectRoot: string;
  /** 变更后发射事件；未提供则不推送。 */
  emit?: (projectId: string, payload: KanbanUpdatedPayload) => void | Promise<void>;
  /** 当前时间工厂，便于测试。 */
  now?: () => Date;
  /** undo 栈最大深度，默认 50。 */
  maxUndoSteps?: number;
}
