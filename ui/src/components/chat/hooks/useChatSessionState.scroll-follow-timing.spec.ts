// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedMessage } from "../../../stores/useSessionStore";
import { useSessionStore } from "../../../stores/useSessionStore";
import type { Project, ProjectSession } from "../../../types/app";
import { useChatSessionState } from "./useChatSessionState";

/**
 * 滚动**时序**判据（issue #468）——与 `useChatSessionState.pagination-scroll.spec.ts` 分工：
 * 那份固化「分页/定位算得对不对」，这份固化「两条异步路径各自在什么时刻动手」。
 *
 * 两处都是 issue #468 登记的既有疑点，此前只在静态阅读里成立、没有可回归的判据：
 *
 * ① 首屏落底（`pendingInitialScrollRef`）过去在「容器已挂载 + loading 已落定 + 消息仍为空」
 *    时被消费且不滚动 ⇒ 该 flag 是一次性的，消息真正到达时首屏不再落底。
 *    判据：空会话里等到 loading 落定，再让首条消息落地，视口必须到底。
 * ② 已排队的 rAF 跟随帧过去无条件执行 ⇒ 帧调度与「用户上滑」在同一帧内竞态时会被拽回底部。
 *    判据：把 rAF 抓在手里，先排队一帧、再上滑，然后放帧 ⇒ 视口必须留在用户停的地方。
 *
 * 视口是**模拟**的（jsdom 不做布局）：scrollHeight / clientHeight / scrollTop 用
 * `Object.defineProperty` 打在元素实例上。两条用例都不断言布局，只断言「谁在什么时候写了 scrollTop」，
 * 因此不需要真实浏览器，也不依赖 `Page.captureScreenshot`。
 */

const { mockAuthenticatedFetch } = vi.hoisted(() => ({ mockAuthenticatedFetch: vi.fn() }));

vi.mock("../../../utils/api", () => ({
  authenticatedFetch: mockAuthenticatedFetch,
  readAgentStatusErrorFromResponse: vi.fn(async () => ({ message: "stubbed status error" })),
}));

const EMPTY_SESSION_ID = "session-468-empty";
const FOLLOW_SESSION_ID = "session-468-follow";
const VIEWPORT_HEIGHT = 1000;
const VIEWPORT_CLIENT_HEIGHT = 400;

const PROJECT: Project = {
  name: "proj-468",
  displayName: "proj-468",
  fullPath: "/tmp/proj-468",
  path: "/tmp/proj-468",
};

const EMPTY_SESSION: ProjectSession = { id: EMPTY_SESSION_ID };
const FOLLOW_SESSION: ProjectSession = { id: FOLLOW_SESSION_ID };

type PageResponse = { messages: NormalizedMessage[]; total: number; hasMore: boolean };

function transcript(count: number, sessionId: string, startIndex = 1): NormalizedMessage[] {
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

let messageUrls: string[] = [];
let respondToMessages: (sessionId: string) => PageResponse = () => ({ messages: [], total: 0, hasMore: false });

beforeEach(() => {
  messageUrls = [];
  respondToMessages = () => ({ messages: [], total: 0, hasMore: false });
  mockAuthenticatedFetch.mockReset();
  mockAuthenticatedFetch.mockImplementation(async (url: string) => {
    if (url.includes("/token-usage")) return jsonResponse({});
    if (url.includes("/messages")) {
      messageUrls.push(url);
      const sessionId = url.includes(FOLLOW_SESSION_ID) ? FOLLOW_SESSION_ID : EMPTY_SESSION_ID;
      return jsonResponse(respondToMessages(sessionId));
    }
    return jsonResponse({});
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderHarness(selectedSession: ProjectSession, overrides: Partial<HarnessProps> = {}) {
  const viewport = createFakeViewport();
  const props: HarnessProps = { ...makeProps(selectedSession), ...overrides };
  const rendered = renderHook(() => {
    const sessionStore = useSessionStore();
    const state = useChatSessionState({ ...props, sessionStore });
    // 真实调用方是 MessagesPaneV2 里 `<div ref={scrollContainerRef}>` 那段容器——它在消息为空时
    // **就已挂载**（占位符渲染在容器内部），这正是 ① 的时序前提。
    state.scrollContainerRef.current = viewport.el;
    return { sessionStore, state };
  });
  return { ...rendered, props, viewport, container: viewport.el };
}

type Harness = ReturnType<typeof renderHarness>;

async function addLiveMessage(harness: Harness, id: string) {
  act(() => {
    harness.result.current.state.addMessage({
      id,
      type: "assistant",
      content: "streaming reply",
      timestamp: new Date().toISOString(),
    });
  });
}

async function dispatchScroll(container: HTMLElement) {
  await act(async () => {
    container.dispatchEvent(new Event("scroll"));
  });
}

describe("useChatSessionState — 首屏落底与跟随帧时序（issue #468）", () => {
  it("① 消息为空时不消费首屏落底：空会话等 loading 落定后，首条消息仍会滚到底", async () => {
    const harness = renderHarness(EMPTY_SESSION);

    // 等到「容器已挂载 + loading 已落定 + 消息为空」这一状态稳定下来。
    // 修复前，首屏落底的 flag 就是在这一刻被消费掉的（且没有滚任何东西）。
    await waitFor(() => expect(messageUrls.length).toBeGreaterThan(0));
    await sleep(50);
    expect(harness.result.current.state.isLoadingSessionMessages).toBe(false);
    expect(harness.result.current.state.chatMessages.length).toBe(0);
    expect(harness.viewport.scrollTop()).toBe(0);

    await addLiveMessage(harness, "first-message");
    await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(1));

    // 首屏落底落在 CHAT_RELOAD_SCROLL_SETTLE_MS 之后；消息到达后它必须仍然有效。
    await waitFor(() => expect(harness.viewport.scrollTop()).toBe(VIEWPORT_HEIGHT));
  });

  it("② 已排队的跟随帧在用户上滑后不再把视口拽回底部", async () => {
    respondToMessages = sessionId =>
      sessionId === FOLLOW_SESSION_ID
        ? { messages: transcript(45, FOLLOW_SESSION_ID, 21), total: 65, hasMore: true }
        : { messages: [], total: 0, hasMore: false };

    const harness = renderHarness(FOLLOW_SESSION, { autoScrollToBottom: true });
    await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(45));
    // 先让「首屏消息到达」那一轮的真实 rAF 跟随跑完，避免它混进下面的推进。
    await sleep(40);

    // 只接管 rAF（setTimeout 仍是真实的，waitFor 照常工作）。这一条必须接管 rAF：
    // store 的「按帧合并通知」与「跟随底部」的帧调度共用同一个 rAF，于是可以把帧精确地
    // 停在「已调度、尚未执行」——也就是与用户上滑发生竞态的那个窗口。
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });

    harness.viewport.setScrollTop(0);
    await addLiveMessage(harness, "live-queued");
    // 推进一帧：store 的合并通知落地 ⇒ 消息进 chatMessages，锚定 effect 随即排下「跟随」帧。
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(harness.result.current.state.chatMessages.length).toBe(46);

    // 同一帧内用户上滑：这条已排队的跟随应当被撤销。
    harness.viewport.setScrollTop(100);
    await dispatchScroll(harness.container);
    await waitFor(() => expect(harness.result.current.state.isUserScrolledUp).toBe(true));

    // 放帧：视口必须留在用户停的地方。
    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(harness.viewport.scrollTop()).toBe(100);
  });

  it("③ 首屏落底的延时落底不覆盖用户随后的上滑", async () => {
    const harness = renderHarness(EMPTY_SESSION);

    // 消息还没到（容器已挂载、loading 已落定）：此刻用户先上滑。
    await waitFor(() => expect(messageUrls.length).toBeGreaterThan(0));
    await sleep(50);
    expect(harness.result.current.state.chatMessages.length).toBe(0);

    await dispatchScroll(harness.container);
    await waitFor(() => expect(harness.result.current.state.isUserScrolledUp).toBe(true));

    // 首条消息落下 ⇒ 首屏落底的延时回调排队（CHAT_RELOAD_SCROLL_SETTLE_MS）。
    await addLiveMessage(harness, "first-message");
    await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(1));

    // 越过延时：用户已经在上面了，这次落底必须不生效。
    await sleep(300);
    expect(harness.viewport.scrollTop()).toBe(0);
  });
});
