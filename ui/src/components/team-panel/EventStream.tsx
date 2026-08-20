import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Radio } from "lucide-react";
import { useWebSocket } from "../../contexts/WebSocketContext";
import { useSessionWatch } from "../../hooks/useSessionWatch";

/**
 * 团队事件流（TeamEvent 滚动视图）。
 *
 * 数据链路（Task 10 接线）：
 *   gateway 按队长会话扇出 `team_event` 帧（src/agent/team/protocol/broadcast.ts
 *   toGatewayEvent）→ ui/server 桥经 eventMapping 归一为 kind:"team_event"
 *   （src/web/client/eventMapping.ts，Task 10 补映射）→ 本组件 watch 当前会话
 *   （useSessionWatch，切换面板时 ChatInterfaceV2 已卸载，须自持 watch 生命周期）
 *   并以 subscribe 累积滚动渲染。
 *
 * 已知限制：emitForSession 仅在队长会话有活跃 turn 时注入事件流（无活跃 turn
 * 时返回 false 事件丢失）——面板快照 5s 轮询（useTeamPanel）为状态兜底。
 */

/** 滚动窗口上限：防事件风暴撑爆 DOM。 */
const MAX_EVENTS = 50;

/** TeamEvent 变体的 wire 形态（浏览器侧局部收窄，不导入 src/）。 */
type TeamWireEvent = {
  type: string;
  teamId?: string;
  taskId?: string;
  memberId?: string;
  attempt?: number;
  timestamp?: string;
  /** 本地自增 React key（非后端字段）。 */
  _eventId?: number;
  [key: string]: unknown;
};

/** 事件族徽章配色（按 type 精确映射；未知按前缀分类，兜底中性灰）。 */
const EVENT_STYLE: Record<string, string> = {
  task_claimed: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-400",
  task_completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400",
  task_failed: "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-400",
  task_retried: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400",
  message_delivered: "bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-400",
};

const styleForEventType = (type: string): string => {
  const exact = EVENT_STYLE[type];
  if (exact !== undefined) return exact;
  if (type.startsWith("task_")) return "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-400";
  if (type.startsWith("member_")) return "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300";
  return "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300";
};

const describeEvent = (event: TeamWireEvent): string => {
  const parts = [event.taskId, event.memberId];
  if (typeof event.attempt === "number") parts.push(`attempt:${event.attempt}`);
  if (event.teamId !== undefined) parts.push(event.teamId);
  return parts.filter(Boolean).join(" · ");
};

const formatTime = (timestamp: string | undefined): string => {
  const parsed = timestamp !== undefined ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toLocaleTimeString();
};

export function EventStream({ sessionId }: { sessionId?: string | null }) {
  const { t } = useTranslation("teamPanel");
  const { ws, sendMessage, subscribe } = useWebSocket();
  // watch 当前会话：团队事件按队长会话扇出，无 watch 收不到（ChatInterfaceV2 卸载时自带 unwatch）
  useSessionWatch({ sessionId, ws, sendMessage });
  const [events, setEvents] = useState<TeamWireEvent[]>([]);
  const nextEventIdRef = useRef(0);

  useEffect(
    () =>
      subscribe(message => {
        if (message?.kind !== "team_event") return;
        const event = message.event;
        if (typeof event !== "object" || event === null) return;
        const record = event as TeamWireEvent;
        if (typeof record.type !== "string") return;
        // 自增 id 作 React key：截断窗口内保证稳定唯一
        const eventId = nextEventIdRef.current++;
        setEvents(previous => [...previous.slice(-(MAX_EVENTS - 1)), { ...record, _eventId: eventId }]);
      }),
    [subscribe],
  );

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <Radio className="h-4 w-4 text-neutral-400 dark:text-neutral-500" />
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t("events.title")}</h3>
        {events.length > 0 ? (
          <span className="text-xs text-neutral-500 dark:text-neutral-400">{events.length}</span>
        ) : null}
      </div>
      {events.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          {t("events.empty")}
        </div>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-y-auto pr-1">
          {events.map(event => (
            <li
              key={event._eventId}
              className="flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-950"
            >
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-medium ${styleForEventType(event.type)}`}
              >
                {event.type}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">
                {describeEvent(event)}
              </span>
              <time className="shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500">
                {formatTime(event.timestamp)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
