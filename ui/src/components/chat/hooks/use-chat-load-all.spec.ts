// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import { useSessionStore } from "../../../stores/useSessionStore";
import type { Project, ProjectSession } from "../../../types/app";
import { useChatLoadAll, type UseChatLoadAllArgs } from "./use-chat-load-all";

/**
 * `useChatLoadAll` 的**丢弃路径记账**用例（issue #476）。
 *
 * 集成面（`useChatSessionState.load-all.spec.ts`）断言的是「旧会话结果不落到新会话视图上」；
 * 但判据的另一半——「请求前自己置位的标记，丢弃时必须复归」——在集成面上**观察不到**：
 * 会话切换时 `resetPagination` 会把它们一并复位，所以少了回滚的实现在集成用例上照样是绿的。
 * 这里直接在 hook 自己的接缝上盯住 `allMessagesLoadedRef`（它是返回面的一部分，分页侧
 * 读它决定「已全量就不再分页」）与遮罩的收起，并直接改实时身份 ref 模拟「会话被切走」。
 */

const { mockAuthenticatedFetch } = vi.hoisted(() => ({ mockAuthenticatedFetch: vi.fn() }));

vi.mock("../../../utils/api", () => ({
  authenticatedFetch: mockAuthenticatedFetch,
  readAgentStatusErrorFromResponse: vi.fn(async () => ({ message: "stubbed status error" })),
}));

const PROJECT: Project = { name: "proj", displayName: "proj", fullPath: "/tmp/proj", path: "/tmp/proj" };
const SESSION: ProjectSession = { id: "session-load-all-unit" };

type HarnessProps = Omit<UseChatLoadAllArgs, "sessionStore">;

interface Harness {
  props: HarnessProps;
  /** 实时会话身份（生产里由 `useChatSessionIdentity` 持有，两条取数路径共用）。 */
  liveSessionIdRef: MutableRefObject<string | null>;
  /** 落定那次「全量」取数。 */
  resolveFetch: () => void;
  result: { current: ReturnType<typeof useChatLoadAll> };
}

function renderLoadAll(liveSessionId: string | null): Harness {
  let resolveFetch: (() => void) | null = null;
  mockAuthenticatedFetch.mockImplementation(
    async () =>
      new Promise(resolve => {
        resolveFetch = () => resolve({ ok: true, status: 200, json: async () => ({ messages: [], total: 65 }) });
      }),
  );
  const liveSessionIdRef: MutableRefObject<string | null> = { current: liveSessionId };

  const props: HarnessProps = {
    scrollToBottom: vi.fn(),
    scrollContainerRef: { current: null },
    pendingScrollRestoreRef: { current: null },
    isLoadingMoreRef: { current: false },
    messagesOffsetRef: { current: 0 },
    setHasMoreMessages: vi.fn(),
    setTotalMessages: vi.fn(),
    setVisibleMessageCount: vi.fn(),
    buildFetchParams: () => ({ provider: "sati", projectName: "proj", projectPath: "/tmp/proj" }),
    selectedSession: SESSION,
    selectedProject: PROJECT,
    liveSessionIdRef,
  };

  const rendered = renderHook(() => useChatLoadAll({ ...props, sessionStore: useSessionStore() }));

  return {
    props,
    liveSessionIdRef,
    result: rendered.result,
    resolveFetch: () => {
      if (!resolveFetch) throw new Error("取数尚未发起");
      resolveFetch();
    },
  };
}

afterEach(() => {
  cleanup();
  mockAuthenticatedFetch.mockReset();
});

describe("useChatLoadAll 的在途丢弃", () => {
  it("会话在途被切走：结果丢弃，且请求前置位的标记一并复归", async () => {
    const harness = renderLoadAll(SESSION.id);

    let loadAll: Promise<void> = Promise.resolve();
    act(() => {
      loadAll = harness.result.current.loadAllMessages();
    });

    // 请求置位的三件套：全量标记、共用取数锁、遮罩。
    expect(harness.result.current.allMessagesLoadedRef.current).toBe(true);
    expect(harness.props.isLoadingMoreRef.current).toBe(true);
    expect(harness.result.current.showLoadAllOverlay).toBe(true);

    // 会话被切走（等价于身份 hook 下一次渲染镜像出新身份）——不需要重渲染，判据读的就是这个 ref。
    harness.liveSessionIdRef.current = null;
    act(() => {
      harness.resolveFetch();
    });
    await act(async () => {
      await loadAll;
    });

    // 丢弃：窗口状态一个都不许写。
    expect(harness.result.current.allMessagesLoaded).toBe(false);
    expect(harness.props.setTotalMessages).not.toHaveBeenCalled();
    expect(harness.props.setVisibleMessageCount).not.toHaveBeenCalled();
    expect(harness.props.setHasMoreMessages).not.toHaveBeenCalled();
    expect(harness.props.messagesOffsetRef.current).toBe(0);
    // 自己置位的标记必须收回（这半是集成面观察不到的那半）。
    expect(harness.result.current.allMessagesLoadedRef.current).toBe(false);
    expect(harness.result.current.showLoadAllOverlay).toBe(false);
    expect(harness.props.isLoadingMoreRef.current).toBe(false);
    expect(harness.result.current.isLoadingAllMessages).toBe(false);
  });

  it("会话没被切走：结果照常应用（同一判据不误丢）", async () => {
    const harness = renderLoadAll(SESSION.id);

    let loadAll: Promise<void> = Promise.resolve();
    act(() => {
      loadAll = harness.result.current.loadAllMessages();
    });
    act(() => {
      harness.resolveFetch();
    });
    await act(async () => {
      await loadAll;
    });

    expect(harness.result.current.allMessagesLoaded).toBe(true);
    expect(harness.result.current.allMessagesLoadedRef.current).toBe(true);
    expect(harness.props.setTotalMessages).toHaveBeenCalledWith(65);
    expect(harness.props.setVisibleMessageCount).toHaveBeenCalledWith(Infinity);
    expect(harness.props.setHasMoreMessages).toHaveBeenCalledWith(false);
  });
});
