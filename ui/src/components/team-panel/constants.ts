import type { TeamWireEvent } from "./types";

/** 面板快照轮询间隔（ms）。10s：面板数据低动态（任务/成员状态），对齐 CronV2/AlwaysOn 15s 量级。 */
export const TEAM_PANEL_POLL_MS = 10_000;

/** Docked 态面板宽度（px）。 */
export const TEAM_PANEL_DEFAULT_WIDTH = 380;

/** Overlay 态面板最大宽度（px）。 */
export const TEAM_PANEL_OVERLAY_MAX_WIDTH = 420;

/** 收起态自动展开的挂载稳定窗口（ms）：防首屏加载期事件闪动展开。 */
export const TEAM_PANEL_SETTLE_MS = 4_000;

/** 折叠态持久化键（裸键，与 MainContent 的 sati:* 惯例一致）。 */
export const TEAM_PANEL_COLLAPSED_KEY = "sati:team-panel-collapsed";

/** 事件族徽章配色（按 type 精确映射；未知事件兜底中性灰）。 */
export const EVENT_STYLE: Record<string, string> = {
  task_claimed: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-400",
  task_completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400",
  task_failed: "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-400",
  task_retried: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400",
  message_delivered: "bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-400",
};

export const FALLBACK_EVENT_STYLE = "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300";

/** 事件行描述：taskId · memberId · attempt:N · teamId（空格 join，缺省段跳过）。 */
export const describeEvent = (event: TeamWireEvent): string => {
  const parts = [event.taskId, event.memberId];
  if (typeof event.attempt === "number") parts.push(`attempt:${event.attempt}`);
  if (event.teamId !== undefined) parts.push(event.teamId);
  return parts.filter(Boolean).join(" · ");
};

/** 最近活动窗口：DAG 节点与成员行脉冲共用的"最近 N 条本团队事件"切片。 */
const RECENT_EVENTS_WINDOW = 5;

/** 取本团队最近 RECENT_EVENTS_WINDOW 条事件（task-dag / member-tree 共用，单点维护）。 */
export function recentEventsOf(events: TeamWireEvent[], teamId: string): TeamWireEvent[] {
  return events.filter(event => event.teamId === teamId).slice(-RECENT_EVENTS_WINDOW);
}

/** 表单 select 共享样式（member-tree 添加成员 / task-dag 转派目标共用）。 */
export const SELECT_CLASS =
  "h-8 min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 text-xs text-neutral-700 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-hidden dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300";

/**
 * 团队角色可选清单（12 岗）——以 `skills/patent-teams/` 目录实际角色为准：
 * case-manager / researcher / drafter / technical-expert / adversarial-reviewer /
 * applicant-counsel / formal-examiner / invalidity-petitioner / patentee-defender /
 * adjudicator / defendant-counsel / tech-investigator。
 */
export const TEAM_ROLE_OPTIONS = [
  "case-manager",
  "researcher",
  "drafter",
  "technical-expert",
  "adversarial-reviewer",
  "applicant-counsel",
  "formal-examiner",
  "invalidity-petitioner",
  "patentee-defender",
  "adjudicator",
  "defendant-counsel",
  "tech-investigator",
] as const;
