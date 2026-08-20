// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsMessage } from "../../contexts/WebSocketContext";
import { EventStream } from "./EventStream";

/**
 * 模块级稳定 mock（M5）：subscribe 引用跨渲染不变，EventStream 的
 * useEffect deps [subscribe] 稳定，effect 不会因 mock 新函数而重跑。
 * vi.hoisted 保证在 vi.mock 工厂执行前初始化。
 */
const { subscribe } = vi.hoisted(() => ({
  subscribe: vi.fn<(handler: (msg: WsMessage) => void) => () => void>(() => vi.fn()),
}));

vi.mock("../../contexts/WebSocketContext", () => ({
  useWebSocket: () => ({ ws: null, sendMessage: vi.fn(), subscribe }),
}));

/** 触发最近一次渲染注册的订阅回调（act 包裹，同步 flush state）。 */
function emitFrame(payload: unknown) {
  const handler = subscribe.mock.calls[0]?.[0];
  expect(handler).toBeTypeOf("function");
  // 运行时任意帧（含脏帧）均模拟真实 WS 输入，测试侧 cast 绕过静态类型
  act(() => handler(payload as WsMessage));
}

describe("EventStream", () => {
  beforeEach(() => {
    subscribe.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("滚动窗口仅保留最近 50 条且 _eventId 稳定唯一（无重复 key 警告）", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<EventStream sessionId="s1" />);

    for (let i = 0; i < 51; i += 1) {
      emitFrame({ kind: "team_event", event: { type: "task_claimed", taskId: `task-${i}` } });
    }

    // 仅保留窗口内 50 条
    expect(screen.getAllByText("task_claimed")).toHaveLength(50);
    // 首条为第 2 条注入（task-1），末条为 task-50；task-0 被裁剪
    expect(screen.getByText("task-1")).toBeDefined();
    expect(screen.getByText("task-50")).toBeDefined();
    expect(screen.queryByText("task-0")).toBeNull();
    // _eventId 自增稳定 → React 不报重复 key 警告
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("忽略 event 非对象 / type 非字符串的脏帧，合法帧正常渲染", () => {
    render(<EventStream sessionId="s1" />);

    emitFrame({ kind: "team_event", event: null });
    emitFrame({ kind: "team_event", event: "not-an-object" });
    emitFrame({ kind: "team_event", event: { type: 42 } });
    emitFrame({ kind: "other_kind", event: { type: "task_claimed" } });

    // 全部为脏帧 → 空态仍在
    expect(screen.getByText("events.empty")).toBeDefined();

    // 合法帧正常渲染
    emitFrame({ kind: "team_event", event: { type: "task_completed", taskId: "task-9" } });
    expect(screen.getAllByText("task_completed")).toHaveLength(1);
    expect(screen.getByText("task-9")).toBeDefined();
  });

  it("卸载时调用 subscribe 返回的取消函数", () => {
    const { unmount } = render(<EventStream sessionId="s1" />);
    const unsubscribe = subscribe.mock.results[0]?.value;
    expect(unsubscribe).toBeTypeOf("function");

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
