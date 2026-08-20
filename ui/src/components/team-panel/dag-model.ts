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
 * 色块/描边用色语义与已删除的 TaskBoard 徽章样式一致。
 */
export const TASK_STATUS_FILL: Record<string, string> = {
  pending: "#a3a3a3", // neutral-400
  claimed: "#60a5fa", // blue-400
  in_progress: "#fbbf24", // amber-400
  completed: "#34d399", // emerald-400
  failed: "#f87171", // red-400
  cancelled: "#737373", // neutral-500
};

/** 终态任务（与后端 TERMINAL_TASK_STATUSES 一致）：不可转派。 */ export const TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * 计算 DAG 布局。
 * - 邻接：忽略悬空依赖（指向不存在任务 ID）与自依赖（后端脏数据防御）
 * - 环：两遍法——第一遍纯环检测（栈闭合点精确识别环成员，只入 cycleMembers），
 *   第二遍深度计算时环成员短路归 0、其余记忆化（第一遍已保证无可达环，缓存
 *   不会因环冲突中毒）；消除旧实现的顺序依赖：环检测把调用链上非环祖先误入
 *   cycleMembers，导致同一张图因 tasks 顺序不同而产出不同深度
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

  // 第一遍：环检测（栈记录当前调用路径；闭合点时栈中从该点到栈顶即环成员）。
  const cycleMembers = new Set<string>();
  {
    const visited = new Set<string>();
    const stack: string[] = [];
    const findCycle = (taskId: string): void => {
      const closedIdx = stack.indexOf(taskId);
      if (closedIdx !== -1) {
        for (let i = closedIdx; i < stack.length; i++) cycleMembers.add(stack[i]);
        return;
      }
      if (visited.has(taskId)) return;
      const task = byId.get(taskId)!; // 入口与递归依赖均已过 validDep，必然命中
      visited.add(taskId);
      stack.push(taskId);
      for (const depId of task.dependencies) {
        if (!validDep(task, depId)) continue;
        findCycle(depId);
      }
      stack.pop();
    };
    for (const task of tasks) findCycle(task.taskId);
  }

  // 第二遍：依赖深度（环成员短路 0；其余记忆化 DFS——无可达环，缓存安全）
  const depthOf = new Map<string, number>();
  const computeDepth = (taskId: string): number => {
    if (cycleMembers.has(taskId)) return 0;
    const cached = depthOf.get(taskId);
    if (cached !== undefined) return cached;
    const task = byId.get(taskId)!; // 与 findCycle 同理，必然命中
    let depth = 0;
    for (const depId of task.dependencies) {
      if (!validDep(task, depId)) continue;
      depth = Math.max(depth, computeDepth(depId) + 1);
    }
    depthOf.set(taskId, depth);
    return depth;
  };
  const depths = new Map(tasks.map(task => [task.taskId, computeDepth(task.taskId)] as const));

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
