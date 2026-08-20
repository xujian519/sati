import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import {
  computeDagLayout,
  DAG_NODE_H,
  DAG_NODE_W,
  FALLBACK_TASK_FILL,
  TASK_STATUS_FILL,
  TERMINAL_TASK_STATUSES,
} from "./dag-model";
import { FeedbackBanner } from "./FeedbackBanner";
import { useActionFeedback } from "./hooks/useActionFeedback";
import type { PanelAction, PanelTask, PanelTeam, TeamWireEvent } from "./types";

type TaskDagProps = {
  team: PanelTeam;
  onAction: PanelAction;
  /** 活动事件源：任务节点活跃指示。 */
  activity: {
    events: TeamWireEvent[];
  };
};

/** 脉冲窗口：最近 N 条全局事件中出现的任务视为"活跃"。 */
const RECENT_WINDOW = 5;

/** 非终态任务：可选中转派。 */
const isReassignable = (task: PanelTask): boolean => !TERMINAL_TASK_STATUSES.has(task.status);

/**
 * 任务依赖 DAG（参照 dsh-agent-teams DependencyMap）：层列布局紧凑节点（92×30）、
 * 贝塞尔连边、hover 高亮上下游（其余节点降透明）、点击非终态节点内联转派；
 * 无依赖边时（isParallel）自动并排网格——computeDagLayout 已对无依赖任务按行
 * 排列，渲染逻辑统一，仅标题文案区分。
 */
export function TaskDag({ team, onAction, activity }: TaskDagProps) {
  const { t } = useTranslation("teamPanel");
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [reassignFor, setReassignFor] = useState("");
  const { busy, feedback, runAction } = useActionFeedback();

  const layout = useMemo(() => computeDagLayout(team.tasks), [team.tasks]);

  // 节点坐标索引：边渲染取 DagNode 几何（byId 仅 PanelTask，无 x/y）
  const nodeByTaskId = useMemo(
    () => new Map(layout.nodes.map(node => [node.task.taskId, node] as const)),
    [layout.nodes],
  );

  // hover 上下游集合：从边集合构建邻接，双向 BFS
  const { dependents, dependsOn, byId } = useMemo(() => {
    const byId = new Map(team.tasks.map(task => [task.taskId, task] as const));
    const dependents = new Map<string, Set<string>>(); // 被谁依赖
    const dependsOn = new Map<string, Set<string>>(); // 依赖谁
    for (const edge of layout.edges) {
      const depSet = dependsOn.get(edge.to) ?? new Set<string>();
      depSet.add(edge.from);
      dependsOn.set(edge.to, depSet);
      const dependerSet = dependents.get(edge.from) ?? new Set<string>();
      dependerSet.add(edge.to);
      dependents.set(edge.from, dependerSet);
    }
    return { dependents, dependsOn, byId };
  }, [team.tasks, layout.edges]);

  // hover 上下游集合：hover 时其余节点降透明
  const relatedSet = useMemo(() => {
    if (hoveredTaskId === null) return null;
    const reach = (edges: Map<string, Set<string>>, start: string): Set<string> => {
      const seen = new Set<string>([start]);
      const queue = [start];
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const next of edges.get(current) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      return seen;
    };
    const ancestors = reach(dependsOn, hoveredTaskId);
    const descendants = reach(dependents, hoveredTaskId);
    return new Set([...ancestors, ...descendants]);
  }, [hoveredTaskId, dependsOn, dependents]);

  // 最近活动任务：驱动节点脉冲（按团队过滤——事件带 teamId，避免他队事件误归属）
  const recentTaskIds = useMemo(() => {
    const recent = activity.events.filter(event => event.teamId === team.id).slice(-RECENT_WINDOW);
    return new Set(recent.map(event => event.taskId).filter((id): id is string => id !== undefined));
  }, [activity.events, team.id]);

  const selectedTask = selectedTaskId !== null ? byId.get(selectedTaskId) : undefined;
  const idleMembers = team.members.filter(member => !member.retired && member.status === "idle");

  const handleReassign = async () => {
    if (selectedTask === undefined || reassignFor === "") return;
    await runAction(
      () => onAction("team_reassign_task", { teamId: team.id, taskId: selectedTask.taskId, memberId: reassignFor }),
      () => {
        setSelectedTaskId(null);
        setReassignFor("");
      },
    );
  };

  if (team.tasks.length === 0) {
    return (
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t("tasks.title")}</h3>
        <div className="rounded-md border border-dashed border-neutral-300 p-4 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          {t("tasks.empty")}
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {layout.isParallel ? t("tasks.parallelTitle") : t("tasks.title")}
        </h3>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{team.tasks.length}</span>
      </div>

      <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-950">
        <svg
          width={layout.width}
          height={layout.height}
          role="img"
          aria-label={t("tasks.title")}
          className="block"
          data-testid="task-dag"
        >
          {/* 边：源右中点 → 目标左中点，三次贝塞尔 */}
          {layout.edges.map(edge => {
            const from = nodeByTaskId.get(edge.from);
            const to = nodeByTaskId.get(edge.to);
            if (from === undefined || to === undefined) return null;
            const x1 = from.x + DAG_NODE_W;
            const y1 = from.y + DAG_NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + DAG_NODE_H / 2;
            const midX = (x1 + x2) / 2;
            const dim = relatedSet !== null && !relatedSet.has(edge.from);
            return (
              <path
                key={`${edge.from}->${edge.to}`}
                d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke={dim ? "#d4d4d4" : "#a3a3a3"}
                strokeWidth={1}
                strokeDasharray={dim ? "2 2" : undefined}
              />
            );
          })}

          {layout.nodes.map(node => {
            const fill = TASK_STATUS_FILL[node.task.status] ?? FALLBACK_TASK_FILL;
            const dim = relatedSet !== null && !relatedSet.has(node.task.taskId);
            const recent = recentTaskIds.has(node.task.taskId);
            const selected = node.task.taskId === selectedTaskId;
            return (
              <foreignObject
                key={node.task.taskId}
                x={node.x}
                y={node.y}
                width={DAG_NODE_W}
                height={DAG_NODE_H}
                className={dim ? "opacity-40" : ""}
              >
                <button
                  type="button"
                  data-task-id={node.task.taskId}
                  onClick={() => {
                    if (isReassignable(node.task)) {
                      setSelectedTaskId(prev => (prev === node.task.taskId ? null : node.task.taskId));
                      setReassignFor("");
                    }
                  }}
                  onMouseEnter={() => setHoveredTaskId(node.task.taskId)}
                  onMouseLeave={() => setHoveredTaskId(null)}
                  className={`flex h-full w-full flex-col justify-center gap-0.5 rounded-md border bg-white px-1.5 py-1 text-left dark:bg-neutral-950 ${
                    selected
                      ? "border-brand-400 ring-1 ring-brand-400"
                      : recent
                        ? "animate-pulse border-neutral-300 dark:border-neutral-700"
                        : "border-neutral-200 dark:border-neutral-800"
                  } ${isReassignable(node.task) ? "cursor-pointer hover:border-neutral-300 dark:hover:border-neutral-600" : "cursor-default"}`}
                >
                  <span className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: fill }} />
                    <span className="truncate font-mono text-[9px] text-neutral-500 dark:text-neutral-400">
                      {node.task.taskId}
                    </span>
                  </span>
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="truncate text-[10px] leading-tight text-neutral-800 dark:text-neutral-200">
                      {node.task.subject}
                    </span>
                    {node.task.attempt > 1 ? (
                      <span
                        className="shrink-0 rounded-sm bg-amber-100 px-1 font-mono text-[8px] font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-400"
                        title={t("tasks.attempt", { count: node.task.attempt })}
                      >
                        ×{node.task.attempt}
                      </span>
                    ) : null}
                  </span>
                </button>
              </foreignObject>
            );
          })}
        </svg>

        {/* 内联转派条：点击非终态节点后出现 */}
        {selectedTask !== undefined ? (
          <div className="mt-2 flex items-center gap-2 border-t border-neutral-100 pt-2 dark:border-neutral-800">
            <span className="min-w-0 flex-1 truncate text-xs text-neutral-700 dark:text-neutral-300">
              {selectedTask.subject}
            </span>
            <select
              value={reassignFor}
              onChange={event => setReassignFor(event.target.value)}
              aria-label={`${t("tasks.reassign")} ${selectedTask.taskId}`}
              className="h-8 min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 text-xs text-neutral-700 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-hidden dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300"
            >
              <option value="" disabled>
                {t("tasks.reassignPlaceholder")}
              </option>
              {idleMembers.map(member => (
                <option key={member.memberId} value={member.memberId}>
                  {t("tasks.optionFormat", { memberId: member.memberId, roleSlug: member.roleSlug })}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || reassignFor === ""}
              onClick={() => void handleReassign()}
            >
              {t("tasks.reassign")}
            </Button>
          </div>
        ) : null}
      </div>

      <FeedbackBanner feedback={feedback} />
    </section>
  );
}
