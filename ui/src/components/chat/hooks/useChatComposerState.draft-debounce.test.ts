// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThinkingModeAvailability } from "../constants/thinkingModeAvailability";
import { useChatComposerState } from "./useChatComposerState";

/**
 * 草稿防抖保存回归测试（审查 #5）：
 * 旧实现把 flushPendingDraft 放在防抖 effect 的 cleanup 里——每次击键（input 变化）
 * 都会重跑 effect 并执行 cleanup，把上一版击键立即写盘，防抖被击穿（回到 M10 修复
 * 前每击键同步写 localStorage）。新语义：cleanup 只 clearTimeout；flush 只保留给
 * 防抖届满（timer 回调）、组件真实卸载与 beforeunload。
 *
 * 说明：spy 必须打在 window.localStorage 实例方法上（jsdom 的 localStorage 是
 * 实例自持实现，Storage.prototype 上的 spy 捕获不到）；React 19 act 与 fake timers
 * 的调度器冲突会挂起，故防抖窗口用真实 sleep 推进。
 */

type UseChatComposerStateArgs = Parameters<typeof useChatComposerState>[0];

vi.mock("../../../utils/api", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("react-dropzone", () => ({
  useDropzone: () => ({
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
    open: vi.fn(),
  }),
}));
vi.mock("./useSlashCommands", () => ({
  useSlashCommands: () => ({
    slashCommands: [],
    slashCommandsCount: 0,
    filteredCommands: [],
    frequentCommands: [],
    commandQuery: "",
    showCommandMenu: false,
    selectedCommandIndex: -1,
    resetCommandMenuState: vi.fn(),
    dismissCommandMenu: vi.fn(),
    handleCommandSelect: vi.fn(),
    handleToggleCommandMenu: vi.fn(),
    handleCommandInputChange: vi.fn(),
    handleCommandMenuKeyDown: vi.fn(),
  }),
}));
vi.mock("./useFileMentions", () => ({
  useFileMentions: () => ({
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: -1,
    renderInputWithMentions: (value: string) => value,
    selectFile: vi.fn(),
    setCursorPosition: vi.fn(),
    handleFileMentionsKeyDown: vi.fn(),
  }),
}));

const DRAFT_SAVE_DEBOUNCE_MS = 500;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function baseProps(): UseChatComposerStateArgs {
  return {
    selectedProject: { name: "p1", displayName: "P1", fullPath: "/p1" },
    selectedSession: { id: "s1" },
    currentSessionId: "s1",
    model: "sati",
    permissionMode: "default",
    cycleRunMode: vi.fn(),
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    thinkingModeAvailability: {} as ThinkingModeAvailability,
    sendMessage: vi.fn(),
    addMessage: vi.fn(),
    clearMessages: vi.fn(),
    rewindMessages: vi.fn(),
    pendingViewSessionRef: { current: null },
    scrollToBottom: vi.fn(),
    setIsLoading: vi.fn(),
    setCanAbortSession: vi.fn(),
    setIsAborting: vi.fn(),
    setClaudeStatus: vi.fn(),
    setSatiStatus: vi.fn(),
    setIsUserScrolledUp: vi.fn(),
    pendingPermissionRequests: [],
    setPendingPermissionRequests: vi.fn(),
    setPendingApprovals: vi.fn(),
  };
}

describe("useChatComposerState 草稿防抖", () => {
  let setItemSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    setItemSpy = vi.spyOn(window.localStorage, "setItem");
  });

  afterEach(() => {
    setItemSpy.mockRestore();
  });

  it("防抖窗口内连续击键不落盘，停顿后只写一次最新值", async () => {
    const { result } = renderHook(() => useChatComposerState(baseProps()));

    act(() => result.current.setInput("A"));
    act(() => result.current.setInput("AB"));
    act(() => result.current.setInput("ABC"));
    expect(setItemSpy).not.toHaveBeenCalled();

    await sleep(DRAFT_SAVE_DEBOUNCE_MS + 200);
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(setItemSpy).toHaveBeenCalledWith("draft_input_p1:s1", "ABC");
  });

  it("组件卸载时 flush 未落盘草稿（不丢稿）", () => {
    const { result, unmount } = renderHook(() => useChatComposerState(baseProps()));

    act(() => result.current.setInput("未停顿即切走"));
    expect(setItemSpy).not.toHaveBeenCalled();

    act(() => unmount());
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(setItemSpy).toHaveBeenCalledWith("draft_input_p1:s1", "未停顿即切走");
  });

  it("beforeunload（整页关闭）flush 未落盘草稿", () => {
    const { result } = renderHook(() => useChatComposerState(baseProps()));

    act(() => result.current.setInput("刷新前草稿"));
    expect(setItemSpy).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new Event("beforeunload"));
    });
    expect(setItemSpy).toHaveBeenCalledWith("draft_input_p1:s1", "刷新前草稿");
  });
});
