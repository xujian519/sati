// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import type { NormalizedMessage } from "../../../stores/useSessionStore";
import { useSessionStore } from "../../../stores/useSessionStore";
import type { Project, ProjectSession } from "../../../types/app";
import { useChatSessionState } from "./useChatSessionState";

/**
 * 「处理中」状态与状态轮询的**行为**回归测试（issue #467）。
 *
 * 固化两条 effect：① `processingSessions` 命中当前会话 ⇒ 置 `isLoading` / `canAbortSession`
 * （read-only 让位）；② 处理中且 ws 已打开 ⇒ 立刻发一帧 `check-session-status`
 * （`includeActiveTurnMessages: false`）并按 `SESSION_STATUS_POLL_INTERVAL_MS` 轮询，
 * 卸载时清掉定时器。
 *
 * 轮询用 `setInterval` spy 拿回调手动触发（不真等 5s）；视口是模拟的（jsdom 不做布局）。
 */

const { mockAuthenticatedFetch } = vi.hoisted(() => ({ mockAuthenticatedFetch: vi.fn() }));

vi.mock("../../../utils/api", () => ({
  authenticatedFetch: mockAuthenticatedFetch,
  readAgentStatusErrorFromResponse: vi.fn(async () => ({ message: "stubbed status error" })),
}));

const SESSION_ID = "session-processing";
const SESSION_READONLY_ID = "session-processing-ro";

const PROJECT: Project = {
  name: "proj",
  displayName: "proj",
  fullPath: "/tmp/proj",
  path: "/tmp/proj",
};

const SESSION: ProjectSession = { id: SESSION_ID };
const SESSION_READONLY: ProjectSession = { id: SESSION_READONLY_ID, isReadOnly: true };

function transcript(count: number, sessionId = SESSION_ID): NormalizedMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return {
      id: `msg-${n}`,
      sessionId,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + n * 1000).toISOString(),
      provider: "sati",
      kind: "text",
      role: n % 2 === 1 ? "user" : "assistant",
      content: `message ${n}`,
    } satisfies NormalizedMessage;
  });
}

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data };
}

type HarnessProps = Omit<Parameters<typeof useChatSessionState>[0], "sessionStore">;

function makeProps(overrides: Partial<HarnessProps> = {}): HarnessProps {
  return {
    selectedProject: PROJECT,
    selectedSession: SESSION,
    ws: null,
    sendMessage: vi.fn(),
    autoScrollToBottom: false,
    externalMessageUpdate: 0,
    processingSessions: undefined,
    resetStreamingState: vi.fn(),
    pendingViewSessionRef: { current: null },
    ...overrides,
  };
}

beforeEach(() => {
  mockAuthenticatedFetch.mockReset();
  mockAuthenticatedFetch.mockImplementation(async (url: string) => {
    if (url.includes("/token-usage")) return jsonResponse({});
    if (url.includes("/messages")) return jsonResponse({ messages: transcript(10), total: 10, hasMore: false });
    return jsonResponse({});
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderHarness(overrides: Partial<HarnessProps> = {}) {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { get: () => 1000, configurable: true });
  Object.defineProperty(el, "clientHeight", { get: () => 400, configurable: true });
  const props: HarnessProps = makeProps(overrides);
  const rendered = renderHook(() => {
    const sessionStore = useSessionStore();
    const state = useChatSessionState({ ...props, sessionStore });
    state.scrollContainerRef.current = el;
    return { sessionStore, state };
  });
  return { ...rendered, props };
}

type Harness = ReturnType<typeof renderHarness>;

async function settleInitialLoad(harness: Harness): Promise<void> {
  await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(10));
}

describe("处理中状态与轮询", () => {
  it("processingSessions 命中当前会话：置 isLoading 与 canAbortSession", async () => {
    const harness = renderHarness({ processingSessions: new Set([SESSION_ID]) });

    await waitFor(() => expect(harness.result.current.state.isLoading).toBe(true));
    expect(harness.result.current.state.canAbortSession).toBe(true);
  });

  it("processingSessions 不含当前会话：保持非处理中", async () => {
    const harness = renderHarness({ processingSessions: new Set(["other-session"]) });
    await settleInitialLoad(harness);

    expect(harness.result.current.state.isLoading).toBe(false);
    expect(harness.result.current.state.canAbortSession).toBe(false);
  });

  it("read-only 会话不因 processingSessions 进入处理中态", async () => {
    const harness = renderHarness({
      selectedSession: SESSION_READONLY,
      processingSessions: new Set([SESSION_READONLY_ID]),
    });
    await settleInitialLoad(harness);

    expect(harness.result.current.state.isLoading).toBe(false);
    expect(harness.result.current.state.canAbortSession).toBe(false);
  });

  it("处理中且 ws 打开：立刻发一帧并按间隔轮询，卸载时清理定时器", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const harness = renderHarness({
      ws: { readyState: WebSocket.OPEN } as WebSocket,
      processingSessions: new Set([SESSION_ID]),
    });

    await waitFor(() =>
      expect(harness.props.sendMessage).toHaveBeenCalledWith({
        type: "check-session-status",
        sessionId: SESSION_ID,
        provider: "sati",
        includeActiveTurnMessages: false,
      }),
    );

    const pollIndex = setIntervalSpy.mock.calls.findIndex(
      call => call[1] === UI_TIMEOUTS.SESSION_STATUS_POLL_INTERVAL_MS,
    );
    expect(pollIndex).toBeGreaterThanOrEqual(0);
    const handle = setIntervalSpy.mock.results[pollIndex].value;

    const callsBeforeTick = vi.mocked(harness.props.sendMessage).mock.calls.length;
    act(() => {
      (setIntervalSpy.mock.calls[pollIndex][0] as () => void)();
    });
    expect(vi.mocked(harness.props.sendMessage).mock.calls.length).toBe(callsBeforeTick + 1);

    harness.unmount();
    expect(clearIntervalSpy).toHaveBeenCalledWith(handle);
  });

  it("ws 未打开：不发轮询帧", async () => {
    const harness = renderHarness({
      ws: { readyState: WebSocket.CLOSED } as WebSocket,
      processingSessions: new Set([SESSION_ID]),
    });
    await settleInitialLoad(harness);

    expect(harness.props.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ includeActiveTurnMessages: false }),
    );
  });

  it("未在处理中：不发轮询帧", async () => {
    const harness = renderHarness({
      ws: { readyState: WebSocket.OPEN } as WebSocket,
      processingSessions: new Set(["other-session"]),
    });
    await settleInitialLoad(harness);

    expect(harness.props.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ includeActiveTurnMessages: false }),
    );
  });
});
