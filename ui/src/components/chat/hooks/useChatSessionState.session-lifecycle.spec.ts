// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedMessage } from "../../../stores/useSessionStore";
import { useSessionStore } from "../../../stores/useSessionStore";
import type { Project, ProjectSession } from "../../../types/app";
import { useChatSessionState } from "./useChatSessionState";

/**
 * 会话加载 / 外部刷新 / token 用量三族的**行为**回归测试（issue #467）。
 *
 * 分工：`useChatSessionState.pagination-scroll.spec.ts` 固化分页与滚动定位；
 * `….scroll-follow-timing.spec.ts` 固化两条异步路径的时刻；本文件固化**会话生命周期**：
 *
 * - 进入会话：全量取数（URL 上不带 `limit`）+ `check-session-status` 帧 + total/hasMore 落 state；
 * - 跳过重取的两种情形（同 key 且新鲜 / stale 但有实时内容）；
 * - 复位：无会话整块复位、欢迎页提交的交班窗口内不复位、交班窗口外立即复位；
 * - read-only 会话不发状态帧；取数失败落 `sessionLoadError`；`slot.tokenUsage` 落 `tokenBudget`；
 * - 切换会话调 `resetStreamingState` 并复位分页窗口；
 * - `externalMessageUpdate` 触发 refresh（`isLoading` 时跳过；贴底且开启跟随则 200ms 后落底）；
 * - token 用量端点的成功 / `!ok` / read-only / `new-session-*` 四种口径。
 *
 * 视口是模拟的（jsdom 不做布局）：`scrollHeight` / `clientHeight` / `scrollTop` 用
 * `Object.defineProperty` 打在元素实例上。
 */

const { mockAuthenticatedFetch } = vi.hoisted(() => ({ mockAuthenticatedFetch: vi.fn() }));

vi.mock("../../../utils/api", () => ({
  authenticatedFetch: mockAuthenticatedFetch,
  readAgentStatusErrorFromResponse: vi.fn(async () => ({ message: "stubbed status error" })),
}));

const SESSION_ID = "session-a";
const SESSION_B_ID = "session-b";
const SESSION_READONLY_ID = "session-ro";
const VIEWPORT_HEIGHT = 1000;
const VIEWPORT_CLIENT_HEIGHT = 400;

const PROJECT: Project = {
  name: "proj",
  displayName: "proj",
  fullPath: "/tmp/proj",
  path: "/tmp/proj",
};

const SESSION: ProjectSession = { id: SESSION_ID };
const SESSION_B: ProjectSession = { id: SESSION_B_ID };
const SESSION_READONLY: ProjectSession = { id: SESSION_READONLY_ID, isReadOnly: true };

type PageResponse = { messages: NormalizedMessage[]; total: number; hasMore: boolean; tokenUsage?: unknown };

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
  scrollTop: () => number;
}

function createFakeViewport(height = VIEWPORT_HEIGHT, clientHeight = VIEWPORT_CLIENT_HEIGHT): FakeViewport {
  const el = document.createElement("div");
  const currentHeight = height;
  let currentTop = 0;
  Object.defineProperty(el, "scrollHeight", { get: () => currentHeight, configurable: true });
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
    scrollTop: () => currentTop,
  };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type HarnessProps = Omit<Parameters<typeof useChatSessionState>[0], "sessionStore">;

function makeProps(overrides: Partial<HarnessProps> = {}): HarnessProps {
  return {
    selectedProject: PROJECT,
    selectedSession: SESSION,
    ws: { readyState: WebSocket.OPEN } as WebSocket,
    sendMessage: vi.fn(),
    autoScrollToBottom: false,
    externalMessageUpdate: 0,
    processingSessions: undefined,
    resetStreamingState: vi.fn(),
    pendingViewSessionRef: { current: null },
    ...overrides,
  };
}

let messageUrls: string[] = [];
let tokenUsageUrls: string[] = [];
let respondToMessages: (url: string) => PageResponse = () => ({
  messages: transcript(45, SESSION_ID, 21),
  total: 65,
  hasMore: true,
});

beforeEach(() => {
  messageUrls = [];
  tokenUsageUrls = [];
  respondToMessages = () => ({ messages: transcript(45, SESSION_ID, 21), total: 65, hasMore: true });
  mockAuthenticatedFetch.mockReset();
  mockAuthenticatedFetch.mockImplementation(async (url: string) => {
    if (url.includes("/token-usage")) {
      tokenUsageUrls.push(url);
      return jsonResponse({}, false, 404);
    }
    if (url.includes("/messages")) {
      messageUrls.push(url);
      return jsonResponse(respondToMessages(url));
    }
    return jsonResponse({});
  });
});

afterEach(() => {
  cleanup();
});

function renderHarness(overrides: Partial<HarnessProps> = {}) {
  const viewport = createFakeViewport();
  const props: HarnessProps = makeProps(overrides);
  const rendered = renderHook(() => {
    const sessionStore = useSessionStore();
    const state = useChatSessionState({ ...props, sessionStore });
    // 真实调用方是 MessagesPaneV2 里 `<div ref={scrollContainerRef}>` 那段容器。
    state.scrollContainerRef.current = viewport.el;
    return { sessionStore, state };
  });
  return { ...rendered, props, viewport, container: viewport.el };
}

type Harness = ReturnType<typeof renderHarness>;

/** 等到首屏消息进 state。scrollTop 由各用例显式设定，不依赖首屏自动落底的时机。 */
async function settleInitialLoad(harness: Harness, expectedMessages: number): Promise<void> {
  await waitFor(() => expect(messageUrls.length).toBeGreaterThan(0));
  await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(expectedMessages));
}

/** 用同一 id 的新对象身份重跑 effect（`selectedSession` 是 effect 依赖之一）。 */
async function rerenderWithSameSession(harness: Harness, session: ProjectSession = SESSION) {
  harness.props.selectedSession = { ...session };
  harness.rerender();
  await sleep(30);
}

describe("会话加载 effect", () => {
  it("进入会话：全量取数（不带 limit）+ 发 check-session-status，total/hasMore 落进分页 state", async () => {
    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    expect(messageUrls[0]).toContain(`/sessions/${SESSION_ID}/messages`);
    expect(messageUrls[0]).not.toContain("limit=");
    expect(harness.props.sendMessage).toHaveBeenCalledWith({
      type: "check-session-status",
      sessionId: SESSION_ID,
      provider: "sati",
      includeActiveTurnMessages: true,
    });
    expect(harness.result.current.state.totalMessages).toBe(65);
    expect(harness.result.current.state.hasMoreMessages).toBe(true);
    expect(harness.result.current.state.sessionLoadError).toBeNull();
  });

  it("同一会话重入且数据新鲜：不重复取数", async () => {
    const harness = renderHarness();
    await settleInitialLoad(harness, 45);
    expect(messageUrls.length).toBe(1);

    await rerenderWithSameSession(harness);

    expect(messageUrls.length).toBe(1);
  });

  it("数据已 stale 但仍有实时内容：不重取（否则会剪掉在途消息）", async () => {
    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    act(() => {
      const slot = harness.result.current.sessionStore.getSessionSlot(SESSION_ID);
      if (slot) slot.fetchedAt = 0;
      harness.result.current.sessionStore.appendRealtime(SESSION_ID, {
        id: "live-1",
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        provider: "sati",
        kind: "text",
        role: "assistant",
        content: "in flight",
      } satisfies NormalizedMessage);
    });

    await rerenderWithSameSession(harness);

    expect(messageUrls.length).toBe(1);
  });

  it("无会话且无待建会话标记：整块复位（流式状态、分页、token 预算、错误）", async () => {
    const harness = renderHarness({ selectedSession: null, selectedProject: null });

    await waitFor(() => expect(harness.props.resetStreamingState).toHaveBeenCalledTimes(1));
    expect(harness.result.current.state.currentSessionId).toBeNull();
    expect(harness.result.current.state.tokenBudget).toBeNull();
    expect(harness.result.current.state.canAbortSession).toBe(false);
    expect(harness.result.current.state.isLoading).toBe(false);
    expect(harness.result.current.state.hasMoreMessages).toBe(false);
    expect(harness.result.current.state.totalMessages).toBe(0);
    expect(harness.result.current.state.sessionLoadError).toBeNull();
  });

  it("欢迎页提交的交班窗口内不复位：乐观气泡保留", async () => {
    const pendingViewSessionRef = { current: null as { sessionId: string | null; startedAt: number } | null };
    const harness = renderHarness({ selectedSession: null, selectedProject: null, pendingViewSessionRef });

    act(() => {
      harness.result.current.state.addMessage({
        id: "pending-1",
        type: "user",
        content: "hello from welcome",
        timestamp: new Date().toISOString(),
      });
    });
    expect(harness.result.current.state.chatMessages.length).toBe(1);

    act(() => {
      pendingViewSessionRef.current = { sessionId: "handoff-1", startedAt: Date.now() };
      harness.result.current.state.setCurrentSessionId("handoff-1");
    });

    await waitFor(() => expect(harness.result.current.state.currentSessionId).toBe("handoff-1"));
    expect(harness.result.current.state.chatMessages.length).toBe(1);
    expect(harness.props.resetStreamingState).toHaveBeenCalledTimes(1);
  });

  it("等待 session_created 期间（标记已分配但 sessionId 仍为 null）：project 刷新重跑 effect 也不复位", async () => {
    const pendingViewSessionRef = { current: null as { sessionId: string | null; startedAt: number } | null };
    const harness = renderHarness({ selectedSession: null, selectedProject: null, pendingViewSessionRef });

    act(() => {
      harness.result.current.state.addMessage({
        id: "pending-1",
        type: "user",
        content: "hello from welcome",
        timestamp: new Date().toISOString(),
      });
    });
    expect(harness.result.current.state.chatMessages.length).toBe(1);
    expect(harness.props.resetStreamingState).toHaveBeenCalledTimes(1);

    // projects_updated 会把 selectedProject 换成新对象 ⇒ effect 重跑；此时交班标记已分配
    // （sessionId 仍为 null，等 session_created），复位必须让位，否则乐观气泡被抹掉、
    // 界面闪回欢迎页。
    act(() => {
      pendingViewSessionRef.current = { sessionId: null, startedAt: Date.now() };
      harness.props.selectedProject = { ...PROJECT };
      harness.rerender();
    });
    await sleep(30);

    expect(harness.result.current.state.chatMessages.length).toBe(1);
    expect(harness.props.resetStreamingState).toHaveBeenCalledTimes(1);
    expect(harness.result.current.state.currentSessionId).toBeNull();
  });

  it("read-only 会话不发 check-session-status 帧", async () => {
    const harness = renderHarness({ selectedSession: SESSION_READONLY });
    await settleInitialLoad(harness, 45);

    expect(harness.props.sendMessage).not.toHaveBeenCalled();
  });

  it("取数失败：sessionLoadError 落定", async () => {
    mockAuthenticatedFetch.mockImplementation(async (url: string) => {
      if (url.includes("/token-usage")) return jsonResponse({}, false, 404);
      if (url.includes("/messages")) {
        messageUrls.push(url);
        return jsonResponse({}, false, 500);
      }
      return jsonResponse({});
    });

    const harness = renderHarness();

    await waitFor(() => expect(harness.result.current.state.sessionLoadError).toBe("stubbed status error"));
    expect(harness.result.current.state.isLoadingSessionMessages).toBe(false);
  });

  it("slot.tokenUsage 落进 tokenBudget（token 用量端点未返回时）", async () => {
    respondToMessages = () => ({
      messages: transcript(45, SESSION_ID, 21),
      total: 65,
      hasMore: true,
      tokenUsage: { totalTokens: 42 },
    });
    mockAuthenticatedFetch.mockImplementation(async (url: string) => {
      if (url.includes("/token-usage")) return new Promise(() => {});
      if (url.includes("/messages")) {
        messageUrls.push(url);
        return jsonResponse(respondToMessages(url));
      }
      return jsonResponse({});
    });

    const harness = renderHarness();

    await waitFor(() => expect(harness.result.current.state.tokenBudget).toEqual({ totalTokens: 42 }));
  });

  it("切换会话：调 resetStreamingState 并复位分页窗口", async () => {
    respondToMessages = url =>
      url.includes(SESSION_B_ID)
        ? { messages: transcript(10, SESSION_B_ID, 1), total: 10, hasMore: false }
        : { messages: transcript(150, SESSION_ID, 1), total: 150, hasMore: false };

    const harness = renderHarness();
    await settleInitialLoad(harness, 150);

    act(() => {
      harness.result.current.state.loadEarlierMessages();
      harness.result.current.state.loadEarlierMessages();
    });
    expect(harness.result.current.state.visibleMessageCount).toBe(300);

    harness.props.selectedSession = SESSION_B;
    harness.rerender();

    await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(10));
    expect(harness.result.current.state.currentSessionId).toBe(SESSION_B_ID);
    expect(harness.props.resetStreamingState).toHaveBeenCalledTimes(1);
    expect(harness.result.current.state.visibleMessageCount).toBe(100);
  });
});

describe("外部消息刷新 effect", () => {
  it("externalMessageUpdate 递增触发 refreshFromServer", async () => {
    const harness = renderHarness();
    await settleInitialLoad(harness, 45);
    expect(messageUrls.length).toBe(1);

    act(() => {
      harness.props.externalMessageUpdate = 1;
      harness.rerender();
    });

    await waitFor(() => expect(messageUrls.length).toBe(2));
  });

  it("正在流式（isLoading）时跳过刷新", async () => {
    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    act(() => {
      harness.result.current.state.setIsLoading(true);
    });
    act(() => {
      harness.props.externalMessageUpdate = 1;
      harness.rerender();
    });
    await sleep(50);

    expect(messageUrls.length).toBe(1);
  });

  it("开启跟随且贴底：刷新后经沉降延时落到底", async () => {
    const harness = renderHarness({ autoScrollToBottom: true });
    await settleInitialLoad(harness, 45);
    await sleep(40);
    harness.viewport.setScrollTop(900);

    act(() => {
      harness.props.externalMessageUpdate = 1;
      harness.rerender();
    });
    await waitFor(() => expect(messageUrls.length).toBe(2));

    await waitFor(() => expect(harness.viewport.scrollTop()).toBe(VIEWPORT_HEIGHT));
  });
});

describe("token 用量 effect", () => {
  it("正常会话取 token-usage 并落 tokenBudget", async () => {
    mockAuthenticatedFetch.mockImplementation(async (url: string) => {
      if (url.includes("/token-usage")) {
        tokenUsageUrls.push(url);
        return jsonResponse({ totalTokens: 7 });
      }
      if (url.includes("/messages")) {
        messageUrls.push(url);
        return jsonResponse(respondToMessages(url));
      }
      return jsonResponse({});
    });

    const harness = renderHarness();

    await waitFor(() => expect(harness.result.current.state.tokenBudget).toEqual({ totalTokens: 7 }));
    expect(tokenUsageUrls[0]).toContain(`/projects/proj/sessions/${SESSION_ID}/token-usage?provider=sati`);
  });

  it("read-only 会话不请求 token-usage 且清空 tokenBudget", async () => {
    const harness = renderHarness({ selectedSession: SESSION_READONLY });
    await settleInitialLoad(harness, 45);

    expect(tokenUsageUrls).toEqual([]);
    expect(harness.result.current.state.tokenBudget).toBeNull();
  });

  it("new-session-* 不请求 token-usage", async () => {
    const harness = renderHarness({ selectedSession: { id: "new-session-1" } });
    await settleInitialLoad(harness, 45);

    expect(tokenUsageUrls).toEqual([]);
  });

  it("响应 !ok 时 tokenBudget 置 null", async () => {
    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    await waitFor(() => expect(tokenUsageUrls.length).toBe(1));
    expect(harness.result.current.state.tokenBudget).toBeNull();
  });
});
