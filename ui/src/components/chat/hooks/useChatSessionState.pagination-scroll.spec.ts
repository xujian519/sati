// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedMessage } from "../../../stores/useSessionStore";
import { useSessionStore } from "../../../stores/useSessionStore";
import type { Project, ProjectSession } from "../../../types/app";
import { useChatSessionState } from "./useChatSessionState";

/**
 * 分页 + 滚动定位的**行为**回归测试（#159 TD-UI-CHAT-N02）。
 *
 * 背景：`useChatSessionState` 原有覆盖只到模块级纯函数（`isScrollNearBottom` /
 * `resolveConversationScrollTop` / `didLoadedSessionChange` …），hook 自身的
 * 「加载更多 / hasMore 翻转 / 底部跟随 / 加载时保持位置 / 切换会话复位」全是盲区。
 * 这份文件按**拆分前的黑盒**写成：只经 `useChatSessionState` 的返回面断言，
 * 不引用任何内部 hook / ref 名。它是「拆分未改语义」的判据——拆分后必须零改动全绿。
 *
 * 分页契约取值：`MESSAGES_PER_PAGE = 20`、`INITIAL_VISIBLE_MESSAGES = 100`，
 * 改这两个常量会让本文件立刻变红（有意为之）。
 * `CHAT_RELOAD_SCROLL_SETTLE_MS = 200`：首屏那次「滚到底」是 200ms 后的 setTimeout，
 * 凡断言 scrollTop 的用例都先等它落地，再从确定的起点开始。
 *
 * 视口是**模拟**的：jsdom 不做布局，故 scrollHeight / clientHeight / scrollTop 用
 * `Object.defineProperty` 打在元素实例上；「消息入 DOM 导致高度增长」由用例在
 * fetch 返回时（= 量取 previousScrollHeight 之后、commit 之前）显式抬高度模拟。
 */

const { mockAuthenticatedFetch } = vi.hoisted(() => ({ mockAuthenticatedFetch: vi.fn() }));

vi.mock("../../../utils/api", () => ({
  authenticatedFetch: mockAuthenticatedFetch,
  readAgentStatusErrorFromResponse: vi.fn(async () => ({ message: "stubbed status error" })),
}));

const SESSION_ID = "session-a";
const SESSION_B_ID = "session-b";
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

type PageResponse = { messages: NormalizedMessage[]; total: number; hasMore: boolean };

function transcript(count: number, startIndex = 1, sessionId = SESSION_ID): NormalizedMessage[] {
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
  setHeight: (height: number) => void;
  setScrollTop: (top: number) => void;
  scrollTop: () => number;
}

function createFakeViewport(height = VIEWPORT_HEIGHT, clientHeight = VIEWPORT_CLIENT_HEIGHT): FakeViewport {
  const el = document.createElement("div");
  let currentHeight = height;
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
    setHeight: next => {
      currentHeight = next;
    },
    setScrollTop: top => {
      currentTop = top;
    },
    scrollTop: () => currentTop,
  };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type HookArgs = Parameters<typeof useChatSessionState>[0];
type HarnessProps = Omit<HookArgs, "sessionStore">;

/** 默认第一页：最新 45 条（全量 65 条），服务端仍报 hasMore。 */
function defaultPage(): PageResponse {
  return { messages: transcript(45, 21), total: 65, hasMore: true };
}

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
let respondToMessages: (url: string) => PageResponse = defaultPage;

beforeEach(() => {
  messageUrls = [];
  respondToMessages = defaultPage;
  mockAuthenticatedFetch.mockReset();
  mockAuthenticatedFetch.mockImplementation(async (url: string) => {
    if (url.includes("/token-usage")) return jsonResponse({});
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

function renderHarness(overrides: Partial<HarnessProps> = {}, viewport = createFakeViewport()) {
  const props: HarnessProps = { ...makeProps(), ...overrides };
  const rendered = renderHook(() => {
    const sessionStore = useSessionStore();
    const state = useChatSessionState({ ...props, sessionStore });
    // 主 hook 把 ref 交给消费方挂到滚动容器上（真实调用方是 <div ref={scrollContainerRef}>）。
    // 这里在 render 阶段挂上：与 JSX ref 一样「先于 effect 生效」，否则滚动监听那条
    // `[handleScroll]` effect 会在容器为 null 时提前 return（它的依赖只在 handleScroll
    // 换身份时才重跑，而 handleScroll 的依赖里含 hasMoreMessages）。
    state.scrollContainerRef.current = viewport.el;
    return { sessionStore, state };
  });
  return { ...rendered, props, viewport, container: viewport.el };
}

type Harness = ReturnType<typeof renderHarness>;

/**
 * 等到首屏 loading 落定：消息进 state（服务端 total/hasMore 落进分页状态）。
 * scrollTop 一律由各用例显式设定，不依赖任何「首屏自动滚到底」的时机
 * （那条路径是 200ms 的 setTimeout，且其触发条件取决于滚动容器何时挂载，
 *  本文件不去固化它——只固化分页/定位本身）。
 */
async function settleInitialLoad(harness: Harness, expectedMessages: number): Promise<void> {
  await waitFor(() => expect(messageUrls.length).toBeGreaterThan(0));
  await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(expectedMessages));
}

async function dispatchScroll(container: HTMLElement) {
  await act(async () => {
    container.dispatchEvent(new Event("scroll"));
  });
}

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

describe("useChatSessionState — 分页与滚动定位（黑盒回归）", () => {
  it("首屏加载把服务端 total / hasMore 落进分页 state，可见条数维持 INITIAL_VISIBLE_MESSAGES", async () => {
    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    expect(harness.result.current.state.hasMoreMessages).toBe(true);
    expect(harness.result.current.state.totalMessages).toBe(65);
    expect(harness.result.current.state.visibleMessageCount).toBe(100);
    expect(harness.result.current.state.visibleMessages.length).toBe(45);
    expect(harness.result.current.state.allMessagesLoaded).toBe(false);
  });

  it("滚到顶部触发加载更多：请求 MESSAGES_PER_PAGE 条并翻转 hasMore / 累加可见条数", async () => {
    const older = { messages: transcript(20, 1), total: 65, hasMore: false };
    respondToMessages = url => (url.includes("limit=") ? older : defaultPage());

    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    harness.viewport.setScrollTop(60);
    await dispatchScroll(harness.container);

    await waitFor(() => expect(harness.result.current.state.hasMoreMessages).toBe(false));
    expect(messageUrls.some(url => url.includes("limit=20") && url.includes("offset=45"))).toBe(true);
    expect(harness.result.current.state.totalMessages).toBe(65);
    expect(harness.result.current.state.visibleMessageCount).toBe(120);
    await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(65));
  });

  it("加载更多时保持阅读位置：新增高度原样补偿回 scrollTop（视野锚定不动）", async () => {
    const older = { messages: transcript(20, 1), total: 65, hasMore: false };

    const harness = renderHarness();
    respondToMessages = url => {
      if (url.includes("limit=")) {
        // 模拟 20 条更早的消息进 DOM：量取 previousScrollHeight 之后、commit 之前抬高度。
        harness.viewport.setHeight(1600);
        return older;
      }
      return defaultPage();
    };
    await settleInitialLoad(harness, 45);

    harness.viewport.setScrollTop(60);
    await dispatchScroll(harness.container);

    await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(65));
    // 起始 60 + 新增高度 (1600 - 1000) = 660 —— 用户盯着的那些行没有位移。
    await waitFor(() => expect(harness.viewport.scrollTop()).toBe(660));
  });

  it("远离顶部滚动不触发加载更多，只把 isUserScrolledUp 置起", async () => {
    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    harness.viewport.setScrollTop(500);
    await dispatchScroll(harness.container);

    await waitFor(() => expect(harness.result.current.state.isUserScrolledUp).toBe(true));
    expect(messageUrls.filter(url => url.includes("limit=")).length).toBe(0);
  });

  it("顶部加载锁：同一次停留只加载一页，必须离开 20px 才解锁", async () => {
    const page = { messages: transcript(20, 1), total: 65, hasMore: true };
    respondToMessages = url => (url.includes("limit=") ? page : defaultPage());

    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    const loadCount = () => messageUrls.filter(url => url.includes("limit=")).length;

    harness.viewport.setScrollTop(60);
    await dispatchScroll(harness.container);
    await waitFor(() => expect(loadCount()).toBe(1));

    // 仍贴着顶部（<= 20px）：锁生效，不再发第二次请求。
    harness.viewport.setScrollTop(10);
    await dispatchScroll(harness.container);
    expect(loadCount()).toBe(1);

    // 离开 20px：解锁但不加载。
    harness.viewport.setScrollTop(50);
    await dispatchScroll(harness.container);
    expect(loadCount()).toBe(1);

    // 回到顶部：这一次才允许加载第二页。
    harness.viewport.setScrollTop(10);
    await dispatchScroll(harness.container);
    await waitFor(() => expect(loadCount()).toBe(2));
  });

  it("接近底部时自动跟随：autoScrollToBottom 且未上滑，新消息落地后贴住底部", async () => {
    const harness = renderHarness({ autoScrollToBottom: true });
    await settleInitialLoad(harness, 45);

    expect(harness.result.current.state.isUserScrolledUp).toBe(false);

    // 先让「会话消息到达」那一轮可能排队的 rAF 跟随跑完，再把 scrollTop 归零：
    // 这样后面断言到的 1000 只可能由**新消息**触发的跟随产生。
    await sleep(40);
    harness.viewport.setScrollTop(0);
    expect(harness.viewport.scrollTop()).toBe(0);

    await addLiveMessage(harness, "live-1");

    await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(46));
    await waitFor(() => expect(harness.viewport.scrollTop()).toBe(VIEWPORT_HEIGHT));
  });

  it("用户上滑后不再跟随：新消息落地不改变 scrollTop", async () => {
    const harness = renderHarness({ autoScrollToBottom: true });
    await settleInitialLoad(harness, 45);

    // 先排空「消息到达」那一轮已排队的 rAF 跟随帧，再模拟用户上滑——否则下面测到的是
    // 那条旧帧而不是新消息的行为。（已排队的帧如今会因上滑被撤销，见 #468；这里的 sleep
    // 只是让基线干净，不再是绕开旧语义。）
    await sleep(40);
    harness.viewport.setScrollTop(100);
    await dispatchScroll(harness.container);
    await waitFor(() => expect(harness.result.current.state.isUserScrolledUp).toBe(true));

    await addLiveMessage(harness, "live-2");

    await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(46));
    await sleep(50);
    expect(harness.viewport.scrollTop()).toBe(100);
  });

  it("scrollToBottom() 把容器直接推到底部", async () => {
    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    harness.viewport.setScrollTop(10);
    act(() => {
      harness.result.current.state.scrollToBottom();
    });

    expect(harness.viewport.scrollTop()).toBe(VIEWPORT_HEIGHT);
  });

  it("底部判定阈值 96px：距底 95px 算到底，96px 算已上滑", async () => {
    respondToMessages = () => ({ messages: transcript(45, 21), total: 45, hasMore: false });

    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    harness.viewport.setScrollTop(0);
    await dispatchScroll(harness.container);
    await waitFor(() => expect(harness.result.current.state.isUserScrolledUp).toBe(true));
    expect(harness.result.current.state.isNearBottom()).toBe(false);

    // 1000 - 505 - 400 = 95 < 96 → 仍算「在底部」。
    harness.viewport.setScrollTop(505);
    await dispatchScroll(harness.container);
    await waitFor(() => expect(harness.result.current.state.isUserScrolledUp).toBe(false));
    expect(harness.result.current.state.isNearBottom()).toBe(true);

    // 1000 - 504 - 400 = 96 → 不再算底部。
    harness.viewport.setScrollTop(504);
    await dispatchScroll(harness.container);
    await waitFor(() => expect(harness.result.current.state.isUserScrolledUp).toBe(true));
    expect(harness.result.current.state.isNearBottom()).toBe(false);
  });

  it("切换会话复位分页窗口与上滑态", async () => {
    respondToMessages = () => ({ messages: transcript(45, 21), total: 45, hasMore: false });

    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    act(() => {
      harness.result.current.state.loadEarlierMessages();
      harness.result.current.state.loadEarlierMessages();
    });
    expect(harness.result.current.state.visibleMessageCount).toBe(300);

    harness.props.selectedSession = SESSION_B;
    harness.rerender();
    act(() => {
      harness.result.current.state.scrollContainerRef.current = harness.viewport.el;
    });

    await waitFor(() => expect(harness.result.current.state.visibleMessageCount).toBe(100));
    expect(harness.result.current.state.isUserScrolledUp).toBe(false);
  });

  it("切回旧会话恢复保存的上滑态", async () => {
    respondToMessages = () => ({ messages: transcript(45, 21), total: 45, hasMore: false });

    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    // 在会话 A 上滑到距底 500px：写入 A 的位置快照。
    harness.viewport.setScrollTop(100);
    await dispatchScroll(harness.container);
    await waitFor(() => expect(harness.result.current.state.isUserScrolledUp).toBe(true));

    harness.props.selectedSession = SESSION_B;
    harness.rerender();
    act(() => {
      harness.result.current.state.scrollContainerRef.current = harness.viewport.el;
    });
    await waitFor(() => expect(harness.result.current.state.isUserScrolledUp).toBe(false));

    harness.props.selectedSession = SESSION;
    harness.rerender();
    act(() => {
      harness.result.current.state.scrollContainerRef.current = harness.viewport.el;
    });

    await waitFor(() => expect(harness.result.current.state.isUserScrolledUp).toBe(true));
  });

  it("loadAllMessages 拉全量：allMessagesLoaded / visibleMessageCount=Infinity / hasMore 收起", async () => {
    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    expect(harness.result.current.state.hasMoreMessages).toBe(true);

    await act(async () => {
      await harness.result.current.state.loadAllMessages();
    });

    expect(harness.result.current.state.allMessagesLoaded).toBe(true);
    expect(harness.result.current.state.visibleMessageCount).toBe(Infinity);
    expect(harness.result.current.state.hasMoreMessages).toBe(false);
    expect(harness.result.current.state.totalMessages).toBe(65);
  });

  it("scrollToBottomAndReset 退出全量态：可见条数回到 INITIAL_VISIBLE_MESSAGES 并滚到底", async () => {
    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    await act(async () => {
      await harness.result.current.state.loadAllMessages();
    });
    expect(harness.result.current.state.allMessagesLoaded).toBe(true);

    harness.viewport.setScrollTop(0);
    act(() => {
      harness.result.current.state.scrollToBottomAndReset();
    });

    expect(harness.result.current.state.visibleMessageCount).toBe(100);
    expect(harness.result.current.state.allMessagesLoaded).toBe(false);
    expect(harness.viewport.scrollTop()).toBe(VIEWPORT_HEIGHT);
  });

  it("全量加载后顶部不再发分页请求", async () => {
    const harness = renderHarness();
    await settleInitialLoad(harness, 45);

    await act(async () => {
      await harness.result.current.state.loadAllMessages();
    });
    const before = messageUrls.filter(url => url.includes("limit=")).length;

    harness.viewport.setScrollTop(0);
    await dispatchScroll(harness.container);

    expect(messageUrls.filter(url => url.includes("limit=")).length).toBe(before);
  });

  it("可见条数只保留最后 N 条，loadEarlierMessages 每次放开 100 条", async () => {
    respondToMessages = () => ({ messages: transcript(150, 1), total: 150, hasMore: false });

    const harness = renderHarness();
    await settleInitialLoad(harness, 150);

    expect(harness.result.current.state.visibleMessageCount).toBe(100);
    expect(harness.result.current.state.visibleMessages.length).toBe(100);
    expect(harness.result.current.state.visibleMessages[0].id).toBe("msg-51");

    act(() => {
      harness.result.current.state.loadEarlierMessages();
    });

    expect(harness.result.current.state.visibleMessages.length).toBe(150);
    expect(harness.result.current.state.visibleMessages[0].id).toBe("msg-1");
  });
});

/**
 * 在途取数跨会话丢弃（issue #476）。
 *
 * 判据必须读**实时**会话身份：`loadOlderMessages` 是 useCallback，依赖变化只让后续调用拿到新闭包，
 * 在途那次仍读调用时刻的 `selectedSession.id`；没有判据时这一页会照常写进新会话的分页状态
 * （实测 total 65 / hasMore true / 可见条数 120），并顺手在新会话上排一次滚动补偿。
 */
describe("useChatSessionState — 在途取数跨会话丢弃（#476）", () => {
  it("加载更早的一页在途时切换会话：结果被丢弃，新会话分页状态不被污染", async () => {
    let resolveOlder: (() => void) | null = null;
    mockAuthenticatedFetch.mockImplementation(async (url: string) => {
      if (url.includes("/token-usage")) return jsonResponse({});
      if (url.includes("/messages")) {
        if (url.includes(SESSION_B_ID)) {
          return jsonResponse({ messages: transcript(10, 1, SESSION_B_ID), total: 10, hasMore: false });
        }
        // 与 beforeEach 的默认 mock 一样记录取数 URL（`settleInitialLoad` 靠它等首屏）。
        messageUrls.push(url);
        if (url.includes("limit=")) {
          // 更早的一页：由用例显式落定，好在「在途」这一刻切走会话。
          return new Promise(resolve => {
            resolveOlder = () => resolve(jsonResponse({ messages: transcript(20, 1), total: 65, hasMore: true }));
          });
        }
        return jsonResponse(defaultPage());
      }
      return jsonResponse({});
    });

    const harness = renderHarness();
    await settleInitialLoad(harness, 45);
    expect(harness.result.current.state.hasMoreMessages).toBe(true);

    harness.viewport.setScrollTop(60);
    await dispatchScroll(harness.container);
    await waitFor(() => expect(resolveOlder).not.toBe(null));

    // 会话被切走：分页复位到初始值，随后 B 的加载落定。
    act(() => {
      harness.props.selectedSession = SESSION_B;
      harness.rerender();
    });
    await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(10));
    expect(harness.result.current.state.totalMessages).toBe(10);
    expect(harness.result.current.state.hasMoreMessages).toBe(false);

    // 旧会话那一页这时才返回：判据命中实时身份，整体丢弃。
    act(() => {
      resolveOlder?.();
    });
    await act(async () => {
      await Promise.resolve();
    });
    await sleep(20);

    expect(harness.result.current.state.totalMessages).toBe(10);
    expect(harness.result.current.state.hasMoreMessages).toBe(false);
    expect(harness.result.current.state.visibleMessageCount).toBe(100);
    // 旧会话那一页写的是自己的 store slot，不碰新会话的消息。
    expect(harness.result.current.state.chatMessages.length).toBe(10);
  });
});
