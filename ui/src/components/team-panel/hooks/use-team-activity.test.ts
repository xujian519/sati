// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsMessage } from "../../../contexts/WebSocketContext";
import { useTeamActivity } from "./use-team-activity";

/** 模块级稳定 mock（M5）：subscribe 引用跨渲染不变，effect deps 稳定不重跑。 */
const { subscribe } = vi.hoisted(() => ({
  subscribe: vi.fn<(handler: (msg: WsMessage) => void) => () => void>(() => vi.fn()),
}));

vi.mock("../../../contexts/WebSocketContext", () => ({
  useWebSocket: () => ({ ws: null, sendMessage: vi.fn(), subscribe }),
}));

/** 触发最近一次渲染注册的订阅回调（act 包裹，同步 flush state）。 */
function emitFrame(payload: unknown) {
  const handler = subscribe.mock.calls[0]?.[0];
  expect(handler).toBeTypeOf("function");
  act(() => handler(payload as WsMessage));
}

describe("useTeamActivity", () => {
  beforeEach(() => {
    subscribe.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("滚动窗口仅保留最近 50 条且 _eventId 稳定唯一", () => {
    const { result } = renderHook(() => useTeamActivity());

    for (let i = 0; i < 51; i += 1) {
      emitFrame({ kind: "team_event", event: { type: "task_claimed", taskId: `task-${i}` } });
    }

    expect(result.current.events).toHaveLength(50);
    expect(result.current.events[0].taskId).toBe("task-1"); // task-0 被裁剪
    expect(result.current.events[49].taskId).toBe("task-50");
    expect(new Set(result.current.events.map(event => event._eventId)).size).toBe(50);
  });

  it("忽略 event 非对象 / type 非字符串的脏帧，合法帧正常累积", () => {
    const { result } = renderHook(() => useTeamActivity());

    emitFrame({ kind: "team_event", event: null });
    emitFrame({ kind: "team_event", event: "not-an-object" });
    emitFrame({ kind: "team_event", event: { type: 42 } });
    emitFrame({ kind: "other_kind", event: { type: "task_claimed" } });

    expect(result.current.events).toHaveLength(0);

    emitFrame({ kind: "team_event", event: { type: "task_completed", taskId: "task-9", memberId: "m1" } });
    expect(result.current.events).toHaveLength(1);
  });

  it("卸载时调用 subscribe 返回的取消函数", () => {
    const { unmount } = renderHook(() => useTeamActivity());
    const unsubscribe = subscribe.mock.results[0]?.value;
    expect(unsubscribe).toBeTypeOf("function");

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("latestEvent 指向最新一条；事件保留 taskId/memberId/attempt 字段（消费端自 events 派生索引）", () => {
    const { result } = renderHook(() => useTeamActivity());

    emitFrame({ kind: "team_event", event: { type: "task_claimed", taskId: "t1", memberId: "m1" } });
    emitFrame({ kind: "team_event", event: { type: "task_completed", taskId: "t2", memberId: "m1" } });
    emitFrame({ kind: "team_event", event: { type: "task_retried", taskId: "t1", memberId: "m2", attempt: 2 } });

    expect(result.current.latestEvent?.type).toBe("task_retried");
    expect(result.current.events.map(event => event.taskId)).toEqual(["t1", "t2", "t1"]);
    expect(result.current.events[2].attempt).toBe(2);
  });
});
