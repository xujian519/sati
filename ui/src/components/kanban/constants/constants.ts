/**
 * 项目看板（Kanban）UI 常量。
 *
 * 默认列颜色与优先级/标签选项与后端 `src/board/storage/BoardStore.ts` 对齐
 * （后端缺失时自动重建默认三列），本处仅用于 UI 渲染兜底与新卡默认值。
 */

import type { BoardPriority } from "../types/types";

export const BOARD_FILE_NAME = "kanban-board.json";

export const DEFAULT_COLUMN_COLOR = "#64748b";
export const DEFAULT_CARD_COLOR = "#0ea5e9";

/** 备份/新建卡时的默认列（与后端默认列同款；实际以 gateway 返回的 columns 为准）。 */
export const DEFAULT_COLUMNS: Array<{ title: string; color: string }> = [
  { title: "待办", color: "#64748b" },
  { title: "进行中", color: "#f59e0b" },
  { title: "已完成", color: "#10b981" },
];

export const PRIORITY_ORDER: BoardPriority[] = ["high", "medium", "low"];

export const PRIORITY_META: Record<BoardPriority, { labelKey: string; colorClass: string; dotClass: string }> = {
  high: { labelKey: "kanban:priority.high", colorClass: "text-red-600 dark:text-red-400", dotClass: "bg-red-500" },
  medium: {
    labelKey: "kanban:priority.medium",
    colorClass: "text-amber-600 dark:text-amber-400",
    dotClass: "bg-amber-500",
  },
  low: {
    labelKey: "kanban:priority.low",
    colorClass: "text-emerald-600 dark:text-emerald-400",
    dotClass: "bg-emerald-500",
  },
};

/** 预置标签（功能/缺陷/文档/优化）。 */
export const LABEL_OPTIONS: Array<{ labelKey: string; value: string }> = [
  { labelKey: "kanban:label.feature", value: "feature" },
  { labelKey: "kanban:label.bug", value: "bug" },
  { labelKey: "kanban:label.docs", value: "docs" },
  { labelKey: "kanban:label.optimization", value: "optimization" },
];

export const LABEL_META: Record<string, { className: string }> = {
  feature: {
    className: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  },
  bug: {
    className: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  },
  docs: {
    className: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  },
  optimization: {
    className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
};

/** 卡片/列自定义颜色的候选色板。 */
export const COLOR_SWATCHES: string[] = [
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#64748b",
  "#f97316",
];
