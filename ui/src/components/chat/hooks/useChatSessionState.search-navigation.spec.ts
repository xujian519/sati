// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import type { NormalizedMessage } from "../../../stores/useSessionStore";
import { useSessionStore } from "../../../stores/useSessionStore";
import type { Project, ProjectSession } from "../../../types/app";
import { useChatSessionState } from "./useChatSessionState";

/**
 * 搜索定位（历史搜索跳转与高亮）的**行为**回归测试（issue #467）。
 *
 * 三条 effect 一起固化：读取 `selectedSession.__searchTargetSnippet` 置位搜索态、清理
 * 会话切换的交班标记、以及「先拉全量 → 等渲染沉降 → 反复重试找到目标 → 滚动 + 闪烁高亮」。
 *
 * 视口是模拟的（jsdom 不做布局）：`scrollHeight` / `clientHeight` / `scrollTop` 用
 * `Object.defineProperty` 打在元素实例上；`scrollIntoView` 在 jsdom 里不存在，用例自行
 * 打一个 spy（真实浏览器里是原生方法）。
 */

const { mockAuthenticatedFetch } = vi.hoisted(() => ({ mockAuthenticatedFetch: vi.fn() }));

vi.mock("../../../utils/api", () => ({
  authenticatedFetch: mockAuthenticatedFetch,
  readAgentStatusErrorFromResponse: vi.fn(async () => ({ message: "stubbed status error" })),
}));

const SESSION_ID = "session-search";
const VIEWPORT_HEIGHT = 1000;
const VIEWPORT_CLIENT_HEIGHT = 400;

const PROJECT: Project = {
  name: "proj",
  displayName: "proj",
  fullPath: "/tmp/proj",
  path: "/tmp/proj",
};

const MATCHING_SNIPPET = "the patent claim chart mapping";
const NO_MATCH_SNIPPET = "zzz no such phrase anywhere";

type PageResponse = { messages: NormalizedMessage[]; total: number; hasMore: boolean };

function transcript(count: number, startIndex = 1): NormalizedMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const n = startIndex + index;
    return {
      id: `msg-${n}`,
      sessionId: SESSION_ID,
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

function makeProps(selectedSession: ProjectSession): HarnessProps {
  return {
    selectedProject: PROJECT,
    selectedSession,
    ws: null,
    sendMessage: vi.fn(),
    autoScrollToBottom: false,
    externalMessageUpdate: 0,
    processingSessions: undefined,
    resetStreamingState: vi.fn(),
    pendingViewSessionRef: { current: null },
  };
}

/** 搜索命中判定要扫的 DOM 节点：真实 `MessageRowV2` 会带上这两个选择器之一。 */
function appendChatMessageElement(container: HTMLElement, text: string, timestamp?: string) {
  const el = document.createElement("div");
  el.className = "chat-message";
  if (timestamp) el.setAttribute("data-message-timestamp", timestamp);
  el.textContent = text;
  const scrollIntoView = vi.fn();
  el.scrollIntoView = scrollIntoView;
  container.appendChild(el);
  return { el, scrollIntoView };
}

let messageUrls: string[] = [];
let respondToMessages: () => PageResponse = () => ({ messages: transcript(45, 21), total: 65, hasMore: true });

beforeEach(() => {
  messageUrls = [];
  respondToMessages = () => ({ messages: transcript(45, 21), total: 65, hasMore: true });
  mockAuthenticatedFetch.mockReset();
  mockAuthenticatedFetch.mockImplementation(async (url: string) => {
    if (url.includes("/token-usage")) return jsonResponse({});
    if (url.includes("/messages")) {
      messageUrls.push(url);
      return jsonResponse(respondToMessages());
    }
    return jsonResponse({});
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderHarness(selectedSession: ProjectSession, overrides: Partial<HarnessProps> = {}) {
  const viewport = createFakeViewport();
  const props: HarnessProps = { ...makeProps(selectedSession), ...overrides };
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

/** 搜索定位的等待链：全量取数沉降 300ms（若触发）+ 首次延迟 150ms + 逐次重试 200ms。 */
async function waitForSearchSettle(ms = 700) {
  await sleep(ms);
}

describe("搜索定位", () => {
  it("snippet 命中：滚到目标元素、加高亮闪烁、到时移除高亮", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const harness = renderHarness({
      id: SESSION_ID,
      __searchTargetSnippet: MATCHING_SNIPPET,
    });
    const target = appendChatMessageElement(harness.container, `Answer: ${MATCHING_SNIPPET.toUpperCase()} — done`);
    await settleInitialLoad(harness, 45);

    await waitFor(() => expect(target.scrollIntoView).toHaveBeenCalled());
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(target.el.classList.contains("search-highlight-flash")).toBe(true);

    // 高亮退场是 SEARCH_HIGHLIGHT_FLASH_MS 后的 setTimeout；这里直接取出那个回调执行，
    // 不真等 4s（jsdom 里 setTimeout 已被 spy，回调与原实现一致）。
    const flashCall = setTimeoutSpy.mock.calls.find(call => call[1] === UI_TIMEOUTS.SEARCH_HIGHLIGHT_FLASH_MS);
    expect(flashCall).toBeDefined();
    act(() => {
      (flashCall?.[0] as () => void)();
    });
    expect(target.el.classList.contains("search-highlight-flash")).toBe(false);
    setTimeoutSpy.mockRestore();
  });

  it("snippet 不命中时退回时间戳兜底：滚到时间最近的一条", async () => {
    const harness = renderHarness({
      id: SESSION_ID,
      __searchTargetSnippet: NO_MATCH_SNIPPET,
      __searchTargetTimestamp: "2026-01-01T00:00:10.000Z",
    });
    const far = appendChatMessageElement(harness.container, "far message", "2026-01-01T00:00:00.000Z");
    const near = appendChatMessageElement(harness.container, "near message", "2026-01-01T00:00:09.000Z");
    await settleInitialLoad(harness, 45);

    await waitFor(() => expect(near.scrollIntoView).toHaveBeenCalled());
    expect(far.scrollIntoView).not.toHaveBeenCalled();
  });

  it("未全量加载时先拉全量再定位（并放开可见条数）", async () => {
    const harness = renderHarness({
      id: SESSION_ID,
      __searchTargetSnippet: MATCHING_SNIPPET,
    });
    const target = appendChatMessageElement(harness.container, MATCHING_SNIPPET);
    await settleInitialLoad(harness, 45);
    // 首屏取数之后、全量沉降（300ms）+ 首延迟（150ms）之前：还没动手定位。
    expect(target.scrollIntoView).not.toHaveBeenCalled();

    // 全量取数（同样不带 limit）+ 放开可见条数 + 收起 hasMore，然后才定位。
    await waitFor(() => expect(messageUrls.length).toBe(2));
    expect(messageUrls[1]).not.toContain("limit=");
    await waitFor(() => expect(harness.result.current.state.visibleMessageCount).toBe(Infinity));
    expect(harness.result.current.state.hasMoreMessages).toBe(false);

    await waitFor(() => expect(target.scrollIntoView).toHaveBeenCalled());
  });

  it("目标迟到（消息陆续渲染）：按重试间隔重试后仍能定位", async () => {
    const harness = renderHarness({
      id: SESSION_ID,
      __searchTargetSnippet: MATCHING_SNIPPET,
    });
    await settleInitialLoad(harness, 45);

    // 等首轮扫描（全量沉降 300ms + 首延迟 150ms）跑过且没找到，再补上目标元素 ——
    // 只有这样，定位成功才是「重试起作用」，而不是首轮就撞上了。
    await sleep(900);
    const late = appendChatMessageElement(harness.container, MATCHING_SNIPPET);
    expect(late.scrollIntoView).not.toHaveBeenCalled();

    await waitFor(() => expect(late.scrollIntoView).toHaveBeenCalled(), { timeout: 2000 });
  });

  it("始终找不到目标：重试次数有界，不会一直扫 DOM", async () => {
    const harness = renderHarness({
      id: SESSION_ID,
      __searchTargetSnippet: NO_MATCH_SNIPPET,
    });
    const nativeQuerySelectorAll = harness.container.querySelectorAll.bind(harness.container);
    const querySpy = vi.fn((selector: string) => nativeQuerySelectorAll(selector));
    harness.container.querySelectorAll = querySpy;
    await settleInitialLoad(harness, 45);

    await sleep(3600);
    const settledCalls = querySpy.mock.calls.length;
    expect(settledCalls).toBeGreaterThan(0);

    await sleep(600);
    expect(querySpy.mock.calls.length).toBe(settledCalls);
  }, 15000);

  it("搜索进行中不抢滚动：首屏落底让位给搜索定位", async () => {
    const harness = renderHarness({
      id: SESSION_ID,
      __searchTargetSnippet: NO_MATCH_SNIPPET,
    });
    await settleInitialLoad(harness, 45);

    await waitForSearchSettle();
    expect(harness.viewport.scrollTop()).toBe(0);
  });
});
