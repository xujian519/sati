// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectSession } from "../../../types/app";
import type { SessionStore } from "../../../stores/useSessionStore";
import { useChatRealtimeHandlers } from "./useChatRealtimeHandlers";

const mocks = {
  subscribe: vi.fn(),
  listener: null as ((message: unknown) => void) | null,
  sendMessage: vi.fn(),
};

vi.mock("../../../contexts/WebSocketContext", () => ({
  useWebSocket: () => ({ subscribe: mocks.subscribe }),
}));

function createSessionStore() {
  return {
    cancelRunningActivities: vi.fn(),
    getSessionSlot: vi.fn(() => undefined),
    setActiveSession: vi.fn(),
    setActivities: vi.fn(),
    updateStreaming: vi.fn(),
    updateStreamingThinking: vi.fn(),
    finalizeStreaming: vi.fn(),
    finalizeStreamingThinking: vi.fn(),
    refreshFromServer: vi.fn(() => Promise.resolve()),
  } as unknown as SessionStore;
}

function setup() {
  const callbacks = {
    setCurrentSessionId: vi.fn(),
    setIsLoading: vi.fn(),
    setCanAbortSession: vi.fn(),
    setIsAborting: vi.fn(),
    setClaudeStatus: vi.fn(),
    setSatiStatus: vi.fn(),
    setTokenBudget: vi.fn(),
    setPendingPermissionRequests: vi.fn(),
    setPendingApprovals: vi.fn(),
    onSessionInactive: vi.fn(),
    onSessionProcessing: vi.fn(),
    onSessionNotProcessing: vi.fn(),
    onReplaceTemporarySession: vi.fn(),
    onNavigateToSession: vi.fn(),
    onWebSocketReconnect: vi.fn(),
  };
  const sessionStore = createSessionStore();
  const utils = renderHook(() =>
    useChatRealtimeHandlers({
      provider: "sati",
      selectedProject: { name: "project", fullPath: "/tmp/project" } as unknown as Project,
      selectedSession: { id: "sess-1" } as unknown as ProjectSession,
      currentSessionId: "sess-1",
      pendingViewSessionRef: { current: { sessionId: null, startedAt: 0 } },
      sessionStore,
      sendMessage: mocks.sendMessage,
      ...callbacks,
    }),
  );
  return { ...callbacks, sessionStore, utils };
}

beforeEach(() => {
  vi.useRealTimers();
  mocks.listener = null;
  mocks.sendMessage.mockReset();
  mocks.subscribe.mockReset();
  mocks.subscribe.mockImplementation(listener => {
    mocks.listener = listener;
    return () => {};
  });
});

describe("session-status unknown handling", () => {
  it("keeps active UI state and retries while session activity is unknown", () => {
    // Fake only the timer APIs the retry logic uses: the shared afterEach
    // drains the immediate queue with setImmediate, which must stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { onSessionInactive, onSessionNotProcessing, setIsLoading } = setup();

    act(() => {
      mocks.listener?.({ type: "session-status", sessionId: "sess-1", isProcessing: null });
    });

    expect(onSessionInactive).not.toHaveBeenCalled();
    expect(onSessionNotProcessing).not.toHaveBeenCalled();
    expect(setIsLoading).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1200);
    });

    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: "check-session-status",
      sessionId: "sess-1",
      provider: "sati",
      includeActiveTurnMessages: true,
    });
  });

  it("stops retrying after an authoritative inactive response", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { onSessionInactive } = setup();

    act(() => {
      mocks.listener?.({ type: "session-status", sessionId: "sess-1", isProcessing: null });
    });
    act(() => {
      mocks.listener?.({ type: "session-status", sessionId: "sess-1", isProcessing: false });
    });

    expect(onSessionInactive).toHaveBeenCalledWith("sess-1");

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("reports processing for an active response", () => {
    const { onSessionProcessing, setIsLoading } = setup();

    act(() => {
      mocks.listener?.({ type: "session-status", sessionId: "sess-1", isProcessing: true });
    });

    expect(onSessionProcessing).toHaveBeenCalledWith("sess-1");
    expect(setIsLoading).toHaveBeenCalledWith(true);
  });
});

describe("绝对投影帧推进流式行（协议 1.9）", () => {
  const ROW_ID = "__streaming_sess-1_run-1";

  function projectFrame(content: string) {
    return {
      kind: "text",
      role: "assistant",
      sessionId: "sess-1",
      runId: "run-1",
      id: "active-turn:sess-1:run-1:text:1",
      content,
      isFinal: true,
      activeTurnProjection: true,
    };
  }

  function withLiveRow(content: string) {
    return { realtimeMessages: [{ id: ROW_ID, content, kind: "stream_delta", role: "assistant" }] };
  }

  it("没有流式行时用投影全文建行", () => {
    const { sessionStore } = setup();
    (sessionStore.getSessionSlot as ReturnType<typeof vi.fn>).mockReturnValue({ realtimeMessages: [] });

    act(() => {
      mocks.listener?.(projectFrame("开头也在的全文"));
    });

    expect(sessionStore.updateStreaming).toHaveBeenCalledWith("sess-1", "开头也在的全文", "sati", "run-1");
  });

  it("行内只有被截断后的尾段时，推进成全文（不是追加）", () => {
    const { sessionStore } = setup();
    (sessionStore.getSessionSlot as ReturnType<typeof vi.fn>).mockReturnValue(withLiveRow("尾段"));

    act(() => {
      mocks.listener?.(projectFrame("开头也在的全文尾段"));
    });

    expect(sessionStore.updateStreaming).toHaveBeenCalledWith("sess-1", "开头也在的全文尾段", "sati", "run-1");
  });

  it("同一投影重复轮询不改变行内容（幂等）", () => {
    const { sessionStore } = setup();
    (sessionStore.getSessionSlot as ReturnType<typeof vi.fn>).mockReturnValue(withLiveRow("全文"));

    act(() => {
      mocks.listener?.(projectFrame("全文"));
    });

    expect(sessionStore.updateStreaming).toHaveBeenCalledTimes(1);
    expect(sessionStore.updateStreaming).toHaveBeenCalledWith("sess-1", "全文", "sati", "run-1");
  });

  it("行内容比投影新（本帧之后又到了 delta）时丢弃本帧", () => {
    const { sessionStore } = setup();
    (sessionStore.getSessionSlot as ReturnType<typeof vi.fn>).mockReturnValue(withLiveRow("全文再加新字"));

    act(() => {
      mocks.listener?.(projectFrame("全文"));
    });

    expect(sessionStore.updateStreaming).not.toHaveBeenCalled();
  });

  it("空投影帧被忽略", () => {
    const { sessionStore } = setup();

    act(() => {
      mocks.listener?.(projectFrame(""));
    });

    expect(sessionStore.updateStreaming).not.toHaveBeenCalled();
  });
});
