/**
 * 任务依赖 DAG 投影（纯函数，零 React import）。
 *
 * 参照 dsh-agent-teams 的 activity-model：输入任务列表（dependencies 为任务 ID
 * 列表），输出分层列布局（列 = 依赖深度）、边集合与并行判定。组件端仅用几何
 * 坐标渲染 SVG——投影与渲染解耦，可独立单测。
 */

import type { PanelTask } from "./types";

/** 紧凑节点几何（与 dsh 92×30 节点对齐）。 */
export const DAG_NODE_W = 92;
export const DAG_NODE_H = 30;
export const DAG_COL_GAP = 24;
export const DAG_ROW_GAP = 14;

export type DagNode = {
  task: PanelTask;
  /** 依赖深度（列索引）。 */
  depth: number;
  /** 层内行索引。 */
  row: number;
  x: number;
  y: number;
};

export type DagEdge = {
  from: string;
  to: string;
};

export type DagLayout = {
  nodes: DagNode[];
  edges: DagEdge[];
  /** 无依赖边时 true：组件端切换为层内并排网格。 */
  isParallel: boolean;
  width: number;
  height: number;
};

/**
 * 任务状态填充色（供 DAG 节点与队长分段进度条共用，单点维护）。
 * 与 TaskBoard 徽章的 TASK_STATUS_STYLE 语义一致，此处为色块/描边用色。
 */
export const TASK_STATUS_FILL: Record<string, string> = {
  pending: "#a3a3a3", // neutral-400
  claimed: "#60a5fa", // blue-400
  in_progress: "#fbbf24", // amber-400
  completed: "#34d399", // emerald-400
  failed: "#f87171", // red-400
  cancelled: "#737373", // neutral-500
};

export const FALLBACK_TASK_FILL = "#a3a3a3";

/** 终态任务（与后端 TERMINAL_TASK_STATUSES 一致）：不可转派。 */
export const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * 计算 DAG 布局。
 * - 邻接：忽略悬空依赖（指向不存在任务 ID）与自依赖（后端脏数据防御）
 * - 深度：记忆化 DFS，visiting 集防环（环上节点按 depth 0 兜底，不挂死）
 * - 行：层内按 taskId 字典序（确定性输出，测试可断言）
 * - isParallel：无有效依赖边时 true（组件端切换并排网格）
 */
export function computeDagLayout(tasks: PanelTask[]): DagLayout {
  if (tasks.length === 0) {
    return { nodes: [], edges: [], isParallel: true, width: 0, height: 0 };
  }

  const byId = new Map(tasks.map(task => [task.taskId, task] as const));
  const validDep = (task: PanelTask, depId: string): boolean => depId !== task.taskId && byId.has(depId);

  // 有效边（去重，双端一致方向：from = 依赖方 = 被依赖任务）
  const edgeKey = (from: string, to: string) => `${from}|${to}`;
  const edges = new Map<string, DagEdge>();
  for (const task of tasks) {
    for (const depId of task.dependencies) {
      if (!validDep(task, depId)) continue;
      edges.set(edgeKey(depId, task.taskId), { from: depId, to: task.taskId });
    }
  }
  const edgeList = [...edges.values()];

  // 依赖深度：记忆化 DFS，visiting 集防环（环成员 depth 归 0 兜底，输出仍确定性）
  const depthOf = new Map<string, number>();
  const visiting = new Set<string>();
  const cycleMembers = new Set<string>();
  const computeDepth = (taskId: string): number => {
    const cached = depthOf.get(taskId);
    if (cached !== undefined) return cached;
    const task = byId.get(taskId);
    if (task === undefined) return 0;
    if (visiting.has(taskId)) {
      // 环冲突：当前调用链（visiting）即环成员，后续统一归 0
      for (const member of visiting) cycleMembers.add(member);
      return 0;
    }
    visiting.add(taskId);
    let depth = 0;
    for (const depId of task.dependencies) {
      if (!validDep(task, depId)) continue;
      depth = Math.max(depth, computeDepth(depId) + 1);
    }
    visiting.delete(taskId);
    depthOf.set(taskId, depth);
    return depth;
  };
  const depths = new Map(
    tasks.map(task => {
      const depth = computeDepth(task.taskId);
      return [task.taskId, cycleMembers.has(task.taskId) ? 0 : depth] as const;
    }),
  );

  // 分层：行 = 层内 taskId 字典序
  const byDepth = new Map<number, string[]>();
  for (const [taskId, depth] of depths) {
    const bucket = byDepth.get(depth) ?? [];
    bucket.push(taskId);
    byDepth.set(depth, bucket);
  }
  for (const bucket of byDepth.values()) bucket.sort();

  const columnCount = byDepth.size;
  const rowCount = Math.max(0, ...[...byDepth.values()].map(bucket => bucket.length));
  const nodes: DagNode[] = [];
  for (const [depth, bucket] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    bucket.forEach((taskId, row) => {
      nodes.push({
        task: byId.get(taskId)!,
        depth,
        row,
        x: depth * (DAG_NODE_W + DAG_COL_GAP),
        y: row * (DAG_NODE_H + DAG_ROW_GAP),
      });
    });
  }

  return {
    nodes,
    edges: edgeList,
    isParallel: edgeList.length === 0,
    width: columnCount * DAG_NODE_W + Math.max(0, columnCount - 1) * DAG_COL_GAP,
    height: rowCount * DAG_NODE_H + Math.max(0, rowCount - 1) * DAG_ROW_GAP,
  };
}
