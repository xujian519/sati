// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import type { NormalizedMessage } from "../../../stores/useSessionStore";
import { useSessionStore } from "../../../stores/useSessionStore";
import type { Project, ProjectSession } from "../../../types/app";
import { useChatSessionState } from "./useChatSessionState";

/**
 * 「加载全部消息」状态机的**行为**回归测试（issue #467）。
 *
 * 已有 `useChatSessionState.pagination-scroll.spec.ts` 固化了成功路径（可见条数放开、
 * `allMessagesLoaded`、「全量后顶部不再分页」）。这里补三处它在拆分中必须守住的部分：
 *
 * ① 请求在途时遮罩置位、返回 `hasMore=false` 后立即收起；
 * ② 取数抛错时回滚（`allMessagesLoadedRef` 复位 ⇒ 顶部仍能分页）；
 * ③ 请求期间切换会话 ⇒ 结果被丢弃，不污染新会话；
 * ④ 完成后的 `loadAllJustFinished` 经 `LOAD_ALL_FINISHED_STATE_RESET_MS` 复位。
 *
 * 视口是模拟的（jsdom 不做布局）：`scrollHeight` / `clientHeight` / `scrollTop` 用
 * `Object.defineProperty` 打在元素实例上。
 */

const { mockAuthenticatedFetch } = vi.hoisted(() => ({ mockAuthenticatedFetch: vi.fn() }));

vi.mock("../../../utils/api", () => ({
  authenticatedFetch: mockAuthenticatedFetch,
  readAgentStatusErrorFromResponse: vi.fn(async () => ({ message: "stubbed status error" })),
}));

const SESSION_ID = "session-loadall";
const SESSION_B_ID = "session-loadall-b";
const VIEWPORT_HEIGHT = 2000;
const VIEWPORT_CLIENT_HEIGHT = 400;

const PROJECT: Project = {
  name: "proj",
  displayName: "proj",
  fullPath: "/tmp/proj",
  path: "/tmp/proj",
};

const SESSION: ProjectSession = { id: SESSION_ID };
const SESSION_B: ProjectSession = { id: SESSION_B_ID };

type PageResponse = { messages: NormalizedMessage[]; total: number; hasMore: boolean };

function transcript(count: number, sessionId = SESSION_ID, startIndex = 1): NormalizedMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const n = startIndex + index;
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

function jsonResponse(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data };
}

interface FakeViewport {
  el: HTMLDivElement;
  setScrollTop: (top: number) => void;
}

function createFakeViewport(height = VIEWPORT_HEIGHT, clientHeight = VIEWPORT_CLIENT_HEIGHT): FakeViewport {
  const el = document.createElement("div");
  let currentTop = 0;
  Object.defineProperty(el, "scrollHeight", { get: () => height, configurable: true });
  Object.defineProperty(el, "clientHeight", { get: () => clientHeight, configurable: true });
  Object.defineProperty(el, "scrollTop", {
    get: () => currentTop,
    set: (value: number) => {
      currentTop = value;
    },
    configurable: true,
  });
  return {
    el,
    setScrollTop: top => {
      currentTop = top;
    },
  };
}

type HarnessProps = Omit<Parameters<typeof useChatSessionState>[0], "sessionStore">;

function makeProps(): HarnessProps {
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
  };
}

let messageUrls: string[] = [];
let resolvePendingFetch: (() => void) | null = null;
let pendingFetchResponse: PageResponse = { messages: transcript(65, SESSION_ID, 1), total: 65, hasMore: false };

beforeEach(() => {
  messageUrls = [];
  resolvePendingFetch = null;
  pendingFetchResponse = { messages: transcript(65, SESSION_ID, 1), total: 65, hasMore: false };
  mockAuthenticatedFetch.mockReset();
  mockAuthenticatedFetch.mockImplementation(async (url: string) => {
    if (url.includes("/token-usage")) return jsonResponse({});
    if (url.includes("/messages")) {
      if (url.includes(SESSION_B_ID)) {
        return jsonResponse({ messages: transcript(10, SESSION_B_ID, 1), total: 10, hasMore: false });
      }
      messageUrls.push(url);
      if (messageUrls.length === 1) {
        return jsonResponse({ messages: transcript(45, SESSION_ID, 21), total: 65, hasMore: true });
      }
      // 第二次取数（全量）：由用例显式落定，便于观察「在途」这一段。
      return new Promise(resolve => {
        resolvePendingFetch = () => resolve(jsonResponse(pendingFetchResponse));
      });
    }
    return jsonResponse({});
  });
});

afterEach(() => {
  cleanup();
});

function renderHarness(overrides: Partial<HarnessProps> = {}) {
  const viewport = createFakeViewport();
  const props: HarnessProps = { ...makeProps(), ...overrides };
  const rendered = renderHook(() => {
    const sessionStore = useSessionStore();
    const state = useChatSessionState({ ...props, sessionStore });
    state.scrollContainerRef.current = viewport.el;
    return { sessionStore, state };
  });
  return { ...rendered, props, viewport, container: viewport.el };
}

type Harness = ReturnType<typeof renderHarness>;

async function settleInitialLoad(harness: Harness, expectedMessages: number): Promise<void> {
  await waitFor(() => expect(messageUrls.length).toBeGreaterThan(0));
  await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(expectedMessages));
}

describe("加载全部消息", () => {
  it("在途时遮罩置位；返回 hasMore=false 后立即收起且放开可见条数", async () => {
    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    let loadAll: Promise<void> = Promise.resolve();
    act(() => {
      loadAll = harness.result.current.state.loadAllMessages();
    });

    await waitFor(() => expect(harness.result.current.state.showLoadAllOverlay).toBe(true));
    expect(harness.result.current.state.isLoadingAllMessages).toBe(true);

    act(() => {
      resolvePendingFetch?.();
    });
    await act(async () => {
      await loadAll;
    });

    expect(harness.result.current.state.showLoadAllOverlay).toBe(false);
    expect(harness.result.current.state.hasMoreMessages).toBe(false);
    expect(harness.result.current.state.visibleMessageCount).toBe(Infinity);
    expect(harness.result.current.state.allMessagesLoaded).toBe(true);
    expect(harness.result.current.state.isLoadingAllMessages).toBe(false);
  });

  it("取数抛错：回滚全量标记（顶部仍能分页）且收起遮罩", async () => {
    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    const sessionStore = harness.result.current.sessionStore;
    const originalFetchFromServer = sessionStore.fetchFromServer;
    sessionStore.fetchFromServer = vi.fn(async () => {
      throw new Error("boom");
    });

    await act(async () => {
      await harness.result.current.state.loadAllMessages();
    });

    expect(harness.result.current.state.allMessagesLoaded).toBe(false);
    expect(harness.result.current.state.showLoadAllOverlay).toBe(false);
    expect(harness.result.current.state.isLoadingAllMessages).toBe(false);
    expect(harness.result.current.state.visibleMessageCount).toBe(100);

    // 回滚的证据：滚到顶部仍然会触发分页请求（若 allMessagesLoadedRef 没复位就不会发）。
    sessionStore.fetchFromServer = originalFetchFromServer;
    const pagedBefore = messageUrls.filter(url => url.includes("limit=")).length;
    harness.viewport.setScrollTop(0);
    await act(async () => {
      harness.container.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() => expect(messageUrls.filter(url => url.includes("limit=")).length).toBeGreaterThan(pagedBefore));
  });

  /**
   * ⚠️ 这里固化的是**既有语义**（既有缺陷，非搬迁引入，见 issue #468 的处置先例）：
   * `loadAllMessages` 里的 `if (currentSessionId !== requestSessionId) return` 读的是**调用那一刻**
   * 闭包里的 `currentSessionId`（useCallback 的依赖变化只会让后续调用拿到新闭包），所以「请求在途时
   * 切换会话」这条丢弃判据**不会生效**：结果仍会写进切换后的会话视图（visibleMessageCount=Infinity、
   * allMessagesLoaded=true、totalMessages 取旧会话值）。本波只做搬迁，不改语义，故按实测固化；
   * 修它要单独决策（另立 issue）。
   */
  it("请求期间切换会话：既有语义下结果**不会**被丢弃（丢弃判据读的是陈旧闭包）", async () => {
    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    let loadAll: Promise<void> = Promise.resolve();
    act(() => {
      loadAll = harness.result.current.state.loadAllMessages();
    });
    await waitFor(() => expect(harness.result.current.state.showLoadAllOverlay).toBe(true));

    harness.props.selectedSession = SESSION_B;
    harness.rerender();
    await waitFor(() => expect(harness.result.current.state.currentSessionId).toBe(SESSION_B_ID));

    act(() => {
      resolvePendingFetch?.();
    });
    await act(async () => {
      await loadAll;
    });

    // 实测（既有行为）：全量结果照常落到新会话视图上。
    expect(harness.result.current.state.allMessagesLoaded).toBe(true);
    expect(harness.result.current.state.visibleMessageCount).toBe(Infinity);
    expect(harness.result.current.state.totalMessages).toBe(pendingFetchResponse.total);
  });

  it("完成后 loadAllJustFinished 经重置延时复位", async () => {
    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    let loadAll: Promise<void> = Promise.resolve();
    act(() => {
      loadAll = harness.result.current.state.loadAllMessages();
    });
    await waitFor(() => expect(harness.result.current.state.showLoadAllOverlay).toBe(true));
    act(() => {
      resolvePendingFetch?.();
    });
    await act(async () => {
      await loadAll;
    });

    expect(harness.result.current.state.loadAllJustFinished).toBe(true);
    await waitFor(() => expect(harness.result.current.state.loadAllJustFinished).toBe(false), {
      timeout: UI_TIMEOUTS.LOAD_ALL_FINISHED_STATE_RESET_MS + 1500,
    });
  });
});
