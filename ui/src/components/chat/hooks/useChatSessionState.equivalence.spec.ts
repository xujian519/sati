// @vitest-environment jsdom
import { writeFileSync } from "node:fs";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedMessage } from "../../../stores/useSessionStore";
import { useSessionStore } from "../../../stores/useSessionStore";
import type { Project, ProjectSession } from "../../../types/app";
import { useChatSessionState } from "./useChatSessionState";

/**
 * 返回面契约 + A/B 等价快照（issue #467）。
 *
 * 两件事：
 *
 * ① **契约**：`useChatSessionState` 的返回对象是 `ChatInterfaceV2` 直接解构的对外 API，
 *    **39 键、键序固定**（拆分前 #466 已独立复核）。拆分把内部实现挪成多个子 hook，
 *    但返回面必须逐键、逐序不变 —— 这条断言就是它的判据。
 *
 * ② **等价快照**：脚本化交互（装载 → 加载更多 → 实时消息 → 外部刷新 → 切 read-only
 *    会话 → 切回并恢复位置）在 6 个检查点把返回面（state / ref / 函数身份）拍成 JSON。
 *    设 `SATI_EQUIV_OUT=<path>` 时把快照写到该文件，供「origin/main 基线 vs 本分支」
 *    逐项 diff（同一份文件在基线的 worktree 里跑一次即可；快照内容与实现无关）。
 */

const { mockAuthenticatedFetch } = vi.hoisted(() => ({ mockAuthenticatedFetch: vi.fn() }));

vi.mock("../../../utils/api", () => ({
  authenticatedFetch: mockAuthenticatedFetch,
  readAgentStatusErrorFromResponse: vi.fn(async () => ({ message: "stubbed status error" })),
}));

const SESSION_ID = "session-eq";
const SESSION_READONLY_ID = "session-eq-ro";

const PROJECT: Project = {
  name: "proj-eq",
  displayName: "proj-eq",
  fullPath: "/tmp/proj-eq",
  path: "/tmp/proj-eq",
};

const SESSION: ProjectSession = { id: SESSION_ID };
const SESSION_READONLY: ProjectSession = { id: SESSION_READONLY_ID, isReadOnly: true };

/** `ChatInterfaceV2` 直接解构的 39 个键，顺序即契约。 */
const RETURN_SURFACE_KEYS = [
  "chatMessages",
  "activityMessages",
  "addMessage",
  "clearMessages",
  "rewindMessages",
  "isLoading",
  "setIsLoading",
  "currentSessionId",
  "setCurrentSessionId",
  "isLoadingSessionMessages",
  "sessionLoadError",
  "hasMoreMessages",
  "totalMessages",
  "canAbortSession",
  "setCanAbortSession",
  "isAborting",
  "setIsAborting",
  "isUserScrolledUp",
  "setIsUserScrolledUp",
  "tokenBudget",
  "setTokenBudget",
  "visibleMessageCount",
  "visibleMessages",
  "loadEarlierMessages",
  "loadAllMessages",
  "allMessagesLoaded",
  "isLoadingAllMessages",
  "loadAllJustFinished",
  "showLoadAllOverlay",
  "claudeStatus",
  "setClaudeStatus",
  "satiStatus",
  "setSatiStatus",
  "createDiff",
  "scrollContainerRef",
  "scrollToBottom",
  "scrollToBottomAndReset",
  "isNearBottom",
  "handleScroll",
] as const;

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

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data };
}

interface FakeViewport {
  el: HTMLDivElement;
  setScrollTop: (top: number) => void;
}

function createFakeViewport(height = 1000, clientHeight = 400): FakeViewport {
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
let respondToMessages: (url: string) => { messages: NormalizedMessage[]; total: number; hasMore: boolean } = () => ({
  messages: transcript(45, SESSION_ID, 21),
  total: 65,
  hasMore: true,
});

beforeEach(() => {
  messageUrls = [];
  respondToMessages = url => {
    if (url.includes(SESSION_READONLY_ID)) {
      return { messages: transcript(8, SESSION_READONLY_ID, 1), total: 8, hasMore: false };
    }
    if (url.includes("limit=")) {
      return { messages: transcript(20, SESSION_ID, 1), total: 65, hasMore: false };
    }
    return { messages: transcript(45, SESSION_ID, 21), total: 65, hasMore: true };
  };
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

function renderHarness() {
  const viewport = createFakeViewport();
  const props: HarnessProps = makeProps();
  const rendered = renderHook(() => {
    const sessionStore = useSessionStore();
    const state = useChatSessionState({ ...props, sessionStore });
    state.scrollContainerRef.current = viewport.el;
    return { sessionStore, state };
  });
  return { ...rendered, props, viewport, container: viewport.el };
}

type Harness = ReturnType<typeof renderHarness>;

const snapshots: Record<string, unknown> = {};

/** 把返回值拍成与实现无关的可比较结构：函数按身份位置标记，ref 只记「是否已挂载」。 */
function snapshotReturnSurface(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(state)) {
    const value = state[key];
    if (typeof value === "function") {
      out[key] = "fn";
    } else if (Array.isArray(value)) {
      const ids = value
        .slice(0, 3)
        .map(item => (item && typeof item === "object" && "id" in item ? String(item.id) : "?"))
        .join(",");
      out[key] = `array(${value.length})[${ids}]`;
    } else if (value && typeof value === "object") {
      if ("current" in (value as Record<string, unknown>)) {
        out[key] = `ref(${(value as { current: unknown }).current ? "set" : "null"})`;
      } else {
        out[key] = `object(${Object.keys(value as Record<string, unknown>).join("|")})`;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function capture(harness: Harness, label: string) {
  await act(async () => {
    await Promise.resolve();
  });
  snapshots[label] = snapshotReturnSurface(harness.result.current.state);
}

describe("useChatSessionState 返回面契约与等价快照", () => {
  it("返回面 39 键、键序逐项一致", async () => {
    const harness = renderHarness();
    await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(45));

    expect(Object.keys(harness.result.current.state)).toEqual([...RETURN_SURFACE_KEYS]);
  });

  it("脚本化交互各检查点的返回面快照可复现（与实现无关）", async () => {
    const harness = renderHarness();
    await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(45));
    await capture(harness, "1-装载");

    harness.viewport.setScrollTop(60);
    await act(async () => {
      harness.container.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() => expect(harness.result.current.state.hasMoreMessages).toBe(false));
    await capture(harness, "2-加载更多");

    act(() => {
      harness.result.current.state.addMessage({
        id: "live-1",
        type: "assistant",
        content: "streaming reply",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
    });
    harness.viewport.setScrollTop(100);
    await act(async () => {
      harness.container.dispatchEvent(new Event("scroll"));
    });
    await capture(harness, "3-实时消息与上滑");

    const fetchesBeforeRefresh = messageUrls.length;
    act(() => {
      harness.props.externalMessageUpdate = 1;
      harness.rerender();
    });
    await waitFor(() => expect(messageUrls.length).toBe(fetchesBeforeRefresh + 1));
    await capture(harness, "4-外部刷新");

    harness.props.selectedSession = SESSION_READONLY;
    harness.rerender();
    await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(8));
    await capture(harness, "5-read-only 会话");

    harness.props.selectedSession = { ...SESSION };
    harness.rerender();
    await waitFor(() => expect(harness.result.current.state.chatMessages.length).toBe(45));
    await capture(harness, "6-切回原会话");

    const out = process.env.SATI_EQUIV_OUT;
    if (out) {
      writeFileSync(out, `${JSON.stringify(snapshots, null, 2)}\n`, "utf8");
    }
    expect(Object.keys(snapshots)).toEqual([
      "1-装载",
      "2-加载更多",
      "3-实时消息与上滑",
      "4-外部刷新",
      "5-read-only 会话",
      "6-切回原会话",
    ]);
    for (const label of Object.keys(snapshots)) {
      expect(snapshots[label]).toBeTruthy();
    }
  });
});
