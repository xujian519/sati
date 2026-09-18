// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatRunMode, SatiWorkStatus } from "../chat/types/types";
import MessagesPaneV2 from "./MessagesPaneV2";
import { buildPrefixOffsets, getVirtualMessageWindow } from "./messageVirtualization";
import { ContextStatusPopover, getContextStatus } from "./ComposerV2";

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    return window.setTimeout(() => callback(performance.now()), 0);
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

function makeMessage(index: number): ChatMessage {
  return {
    id: `m-${index}`,
    type: index % 2 === 0 ? "user" : "assistant",
    content: `Message ${index}`,
    timestamp: `2026-05-13T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
  };
}

function createPaneElement({
  messages,
  activityMessages = [],
  isAssistantWorking = false,
  runMode = "agent",
  planModeActive = false,
  workingStatus = null,
  hasMoreMessages = false,
  allMessagesLoaded = true,
  totalMessages = messages.length,
}: {
  messages: ChatMessage[];
  activityMessages?: ChatMessage[];
  isAssistantWorking?: boolean;
  runMode?: ChatRunMode;
  planModeActive?: boolean;
  workingStatus?: SatiWorkStatus | null;
  hasMoreMessages?: boolean;
  allMessagesLoaded?: boolean;
  totalMessages?: number;
}) {
  const scrollContainerRef = React.createRef<HTMLDivElement>();

  return (
    <MessagesPaneV2
      scrollContainerRef={scrollContainerRef}
      onWheel={() => {}}
      onTouchMove={() => {}}
      isLoadingSessionMessages={false}
      chatMessages={messages}
      activityMessages={activityMessages}
      visibleMessages={messages}
      visibleMessageCount={messages.length}
      hasMoreMessages={hasMoreMessages}
      totalMessages={totalMessages}
      loadEarlierMessages={() => {}}
      loadAllMessages={() => {}}
      allMessagesLoaded={allMessagesLoaded}
      provider="sati"
      selectedProject={null}
      selectedSession={null}
      createDiff={() => []}
      setInput={() => {}}
      isAssistantWorking={isAssistantWorking}
      runMode={runMode}
      planModeActive={planModeActive}
      workingStatus={workingStatus}
    />
  );
}

function renderPane(options: {
  messages: ChatMessage[];
  activityMessages?: ChatMessage[];
  isAssistantWorking?: boolean;
  runMode?: ChatRunMode;
  planModeActive?: boolean;
  workingStatus?: SatiWorkStatus | null;
  hasMoreMessages?: boolean;
  allMessagesLoaded?: boolean;
  totalMessages?: number;
}) {
  return render(createPaneElement(options));
}

describe("getContextStatus", () => {
  it("keeps the visible count and percentage on the same display-token basis", () => {
    const status = getContextStatus({
      displayUsed: 11_928,
      budgetUsed: 12_080,
      total: 12_000,
      effectiveTotal: 12_000,
      state: "blocking",
    });

    expect(status.used).toBe(11_928);
    expect(status.percentLabel).toBe("99%");
    // The padded request budget still controls the policy severity.
    expect(status.state).toBe("blocking");
    expect(status.tone).toBe("red");
  });

  it("百分比与「x / y」同分母，提示里不再出现两个比例", () => {
    const status = getContextStatus({
      displayUsed: 38_161,
      total: 131_072,
      effectiveTotal: 98_304,
      reservedOutputTokens: 32_768,
      state: "ok",
    });

    // 38,161 / 131,072 ≈ 29%：分母与下面展示的 "38.2k … out of 131k" 是同一个。
    expect(status.displayTotal).toBe(131_072);
    expect(status.totalLabel).toBe("131k");
    expect(status.used).toBe(38_161);
    expect(status.percent).toBe(29);
    expect(status.percentLabel).toBe("29%");
    expect(status.tone).toBe("normal");
  });

  it("已用超过可用预算时也不再并排「100%+」与不足 100% 的比值", () => {
    const status = getContextStatus({
      displayUsed: 100_000,
      total: 131_072,
      effectiveTotal: 98_304,
      reservedOutputTokens: 32_768,
    });

    expect(status.percentLabel).toBe("76%");
    expect(status.totalLabel).toBe("131k");
    // 策略口径（已用 100k > 可用预算 98.3k）只体现为告警色，不产出与标签矛盾的数字。
    expect(status.tone).toBe("red");
  });

  it("falls back to the effective budget for display when the raw total is absent", () => {
    const status = getContextStatus({ displayUsed: 1_000, effectiveTotal: 4_000 });

    expect(status.displayTotal).toBe(4_000);
    expect(status.totalLabel).toBe("4.0k");
    expect(status.percentLabel).toBe("25%");
  });

  it("把已用拆成固定开销与对话用量（#450 第 5 条）", () => {
    const status = getContextStatus({
      displayUsed: 35_000,
      total: 131_072,
      effectiveTotal: 98_304,
      fixedOverheadTokens: 24_000,
      state: "ok",
    });

    expect(status.fixedOverhead).toEqual({ tokens: 24_000, label: "24.0k", percent: 18 });
    // 对话用量 = 已用 − 固定开销：两行数字恒等于合计，不出现第三个数。
    expect(status.conversation).toEqual({ tokens: 11_000, label: "11.0k", percent: 8 });
  });

  it("固定开销缺失（压缩重建 / 旧帧）时不编造拆分行", () => {
    expect(getContextStatus({ displayUsed: 35_000, total: 131_072 }).fixedOverhead).toBeUndefined();
    expect(getContextStatus({ displayUsed: 35_000, total: 131_072 }).conversation).toBeUndefined();
    // 0 与负数同样视为未拆分（无 system prompt / 无工具的请求）。
    expect(
      getContextStatus({ displayUsed: 35_000, total: 131_072, fixedOverheadTokens: 0 }).fixedOverhead,
    ).toBeUndefined();
  });

  it("固定开销超过已用时夹到已用，对话用量归零而不是负数", () => {
    const status = getContextStatus({
      displayUsed: 10_000,
      total: 131_072,
      fixedOverheadTokens: 30_000,
    });

    expect(status.fixedOverhead?.tokens).toBe(10_000);
    expect(status.conversation?.tokens).toBe(0);
  });
});

describe("ContextStatusPopover", () => {
  /** 最小 i18n 桩：按 defaultValue 插值，足以断言渲染文本与键解析。 */
  const t = ((key: string, options?: Record<string, unknown>) => {
    const template = String(options?.defaultValue ?? key);
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ""));
  }) as unknown as Parameters<typeof ContextStatusPopover>[0]["t"];

  it("固定开销在场时渲染两行拆分，数值与百分比按窗口口径", () => {
    render(
      <ContextStatusPopover
        status={getContextStatus({
          displayUsed: 35_000,
          total: 131_072,
          fixedOverheadTokens: 24_000,
          state: "ok",
        })}
        title="Context window"
        t={t}
      />,
    );

    expect(screen.getByText("Prompt & tools (fixed)")).toBeTruthy();
    expect(screen.getByText("24.0k (18%)")).toBeTruthy();
    expect(screen.getByText("Conversation")).toBeTruthy();
    expect(screen.getByText("11.0k (8%)")).toBeTruthy();
  });

  it("固定开销缺席时只显示合计，不渲染拆分行", () => {
    render(
      <ContextStatusPopover
        status={getContextStatus({ displayUsed: 35_000, total: 131_072 })}
        title="Context window"
        t={t}
      />,
    );

    expect(screen.queryByText("Prompt & tools (fixed)")).toBeNull();
    expect(screen.getByText("35,000 tokens used out of 131,072.")).toBeTruthy();
  });

  it("尚无 token 用量时只显示未知提示", () => {
    render(<ContextStatusPopover status={getContextStatus(null)} title="Context window" t={t} />);

    expect(screen.getByText("--")).toBeTruthy();
    expect(screen.getByText(/No token budget has been reported yet/)).toBeTruthy();
    expect(screen.queryByText("Conversation")).toBeNull();
  });
});

describe("MessagesPaneV2 render behavior", () => {
  it("renders only the viewport window for large conversations", () => {
    const messages = Array.from({ length: 220 }, (_, index) => makeMessage(index));

    renderPane({ messages });

    const container = screen.getByText("Message 0").closest("[data-total-message-count]");
    expect(container?.getAttribute("data-virtualized-messages")).toBe("true");
    expect(container?.getAttribute("data-total-message-count")).toBe("220");
    expect(Number(container?.getAttribute("data-rendered-message-count"))).toBeLessThan(220);
  });

  it("还有更早消息且未全量加载时渲染分页提示行（#159 N02）", () => {
    // 背景：该行原先的条件是 `hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded`，
    // 而 isLoadingMoreMessages 是 `useState(false)` 且无 setter（恒 false）、已随 #159 N02 删除。
    // 这条用例钉住等价化简后的存活条件：只要 hasMoreMessages 为真且未全量加载，该行必须还在。
    const messages = Array.from({ length: 3 }, (_, index) => makeMessage(index));

    renderPane({ messages, hasMoreMessages: true, allMessagesLoaded: false, totalMessages: 10 });

    expect(screen.getByText(/Showing 3 of 10/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Load earlier messages/i })).toBeTruthy();
  });

  it("已全量加载时不渲染「还有更早消息」提示行（负控制）", () => {
    const messages = Array.from({ length: 3 }, (_, index) => makeMessage(index));

    renderPane({ messages, hasMoreMessages: true, allMessagesLoaded: true, totalMessages: 10 });

    expect(screen.queryByText(/Showing 3 of 10/)).toBeNull();
  });

  it("user / thinking / interactive 三类消息的分流：前两类走 v2 原生，第三类走 legacy 渲染器（#159 N04）", () => {
    // 背景：`MessageComponent` 只在 `MessageRowV2` 的 `delegate` 分支挂载，而 `shouldDelegate`
    // 对「type ∈ {user, assistant, error} 且不带 isToolUse/isInteractivePrompt/isTaskNotification」
    // 一律返回 false。生产端（`useChatMessages` 的 case "text"/"thinking"、composer 的三处乐观消息）
    // 决定的正是：user 与 thinking 消息永远落在这个"不委托"集合里，interactive prompt 则带标志。
    // 于是 `MessageComponent` 里的 user 气泡与 thinking 分支够不着（#159 N04 删除，不是拆分）。
    // 这条用例钉住分流结果：被删两支的独有标记不出现，且 user 消息的附件/图片仍照常渲染。
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: "u-1",
        type: "user",
        content: "用户消息正文",
        timestamp: now,
        images: [{ data: "data:image/png;base64,AAA", name: "a.png" }],
        attachments: [{ name: "doc.pdf", mimeType: "application/pdf" }],
      } as ChatMessage,
      { id: "t-1", type: "assistant", content: "思考正文", timestamp: now, isThinking: true } as ChatMessage,
      {
        id: "p-1",
        type: "assistant",
        content: "选一个?\n❯ 1. 是\n  2. 否",
        timestamp: now,
        isInteractivePrompt: true,
      } as ChatMessage,
    ];

    const { container } = renderPane({ messages });

    // user：正文 / 附件 / 图片都由 v2 原生路径渲染（这正是删掉死分支后仍然成立的行为）。
    expect(screen.getByText("用户消息正文")).toBeTruthy();
    expect(container.textContent).toContain("doc.pdf");
    expect(container.querySelectorAll("img")).toHaveLength(1);
    // 被删的 user 气泡独有class（`rounded-2xl rounded-br-md bg-brand-600`）不再出现。
    expect(container.querySelector(".rounded-br-md")).toBeNull();

    // thinking：它被 processGrouping 折进（默认折叠的）进程行，压根不在可见行里 —— 这也正是
    // MessageComponent 的思考分支够不着的原因。`thinking.emoji` 不能当判据：存活的 assistant
    // 分支里还有一处 reasoning 手风琴用同一个 key。
    expect(screen.queryByText("思考正文")).toBeNull();

    // interactive prompt：存活的那一支（已拆成 `InteractivePromptBlock`）仍渲染。
    expect(container.textContent).toContain("interactive.title");
    expect(container.textContent).toContain("是");
  });

  it("子代理容器消息只走 SubagentCard，不再流经 legacy 子代理渲染器（#159 N05）", () => {
    // 背景：`chat/tools/components/SubagentContainer.tsx` 是 chat-v2 之前的子代理渲染器，
    // 与 `SubagentCard` 重复。三道门保证容器消息到不了它：MessageRowV2 的容器早退、
    // `shouldDelegate` 里 `isSubagentContainer → false`、SubagentDetailMessageFlow 主动清标志。
    // 删掉它之后（#442），这条用例钉住存活实现，并断言被删实现的独有文案不出现。
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      { id: "u-1", type: "user", content: "查一下仓库", timestamp: now },
      {
        id: "sub-1",
        type: "assistant",
        content: "",
        timestamp: now,
        isToolUse: true,
        toolName: "Task",
        toolId: "sub-1",
        toolInput: JSON.stringify({ subagent_type: "explore", description: "扫描仓库结构" }),
        isSubagentContainer: true,
        subagentId: "agent-1",
        subagentState: { childTools: [], currentToolIndex: -1, isComplete: true },
      },
    ];

    renderPane({ messages });

    expect(screen.getByText("扫描仓库结构")).toBeTruthy();
    expect(screen.getByText("explore")).toBeTruthy();
    // 本文件不初始化 "chat" 命名空间，`t()` 原样返回 key —— 恰好钉住「完成态走 card 的
    // completed 分支」这一步（状态的文案本身由 locales 覆盖）。
    expect(screen.getByText("subagent.status.completed")).toBeTruthy();
    for (const containerOnlyText of ["View tool history", "Running subagent", "Currently:"]) {
      expect(screen.queryByText(containerOnlyText, { exact: false })).toBeNull();
    }
  });

  it("renders live processing time above the active assistant turn with activity status", () => {
    const messages = [
      {
        id: "u-1",
        type: "user",
        content: "继续优化",
        timestamp: new Date().toISOString(),
      },
      {
        id: "a-1",
        type: "assistant",
        content: "I will inspect the current UI.",
        timestamp: new Date().toISOString(),
      },
    ];
    const activityMessages: ChatMessage[] = [
      {
        id: "activity-1",
        type: "system",
        content: "Searching files",
        timestamp: new Date().toISOString(),
        isAgentActivity: true,
        activityId: "activity-1",
        phase: "rag",
        state: "running",
        title: "Searching files",
        detail: "MessagesPaneV2.tsx",
        startedAt: new Date(Date.now() - 2000).toISOString(),
      },
    ];

    renderPane({ messages, activityMessages, isAssistantWorking: true });

    const statuses = screen.getAllByRole("status");
    const headerStatus = statuses[0];
    const liveStatus = statuses[1];
    const userText = screen.getByText("继续优化");
    const assistantText = screen.getByText("I will inspect the current UI.");
    expect(statuses).toHaveLength(2);
    expect(headerStatus.textContent).toContain("Processed");
    expect(headerStatus.querySelector("button")).toBeNull();
    expect(userText.closest(".chat-message")?.className).toContain("pb-2");
    expect(liveStatus.textContent).toContain("Searching files");
    expect(liveStatus.querySelector("button")).toBeNull();
    expect(Boolean(headerStatus.compareDocumentPosition(assistantText) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("keeps the processed duration visible after the active turn completes", () => {
    const now = "2026-05-18T08:00:00.000Z";
    const messages: ChatMessage[] = [
      {
        id: "u-1",
        type: "user",
        content: "继续优化",
        timestamp: now,
      },
      {
        id: "a-1",
        type: "assistant",
        content: "I finished the changes.",
        timestamp: "2026-05-18T08:01:20.000Z",
      },
      {
        id: "summary-1",
        type: "system",
        content: "Process summary",
        timestamp: "2026-05-18T08:01:20.000Z",
        isAgentActivitySummary: true,
        durationMs: 80000,
        state: "completed",
      },
    ];

    renderPane({ messages });

    const headerStatus = screen.getByText("Processed 1m 20s").closest('[role="status"]');
    const userText = screen.getByText("继续优化");
    const assistantText = screen.getByText("I finished the changes.");

    expect(headerStatus).not.toBeNull();
    expect(headerStatus?.querySelector("button")).toBeNull();
    expect(Boolean(userText.compareDocumentPosition(headerStatus as Element) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
    expect(
      Boolean((headerStatus as Element).compareDocumentPosition(assistantText) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  it("keeps live tool calls collapsed but lets the running status expand their details", () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: "u-1",
        type: "user",
        content: "检查文件",
        timestamp: now,
      },
      {
        id: "a-1",
        type: "assistant",
        content: "I will inspect the current file.",
        timestamp: now,
      },
      {
        id: "tool-read-1",
        type: "assistant",
        content: "",
        timestamp: now,
        isToolUse: true,
        toolName: "Read",
        toolId: "tool-read-1",
        toolInput: '{"file_path":"src/HiddenTool.tsx"}',
      },
    ];
    const activityMessages: ChatMessage[] = [
      {
        id: "activity-1",
        type: "system",
        content: "Reading file",
        timestamp: now,
        isAgentActivity: true,
        activityId: "activity-1",
        phase: "tool",
        state: "running",
        title: "Reading file",
        startedAt: now,
      },
    ];

    renderPane({ messages, activityMessages, isAssistantWorking: true });

    expect(screen.queryByText("HiddenTool.tsx")).toBeNull();

    const liveStatus = screen.getByText("Reading file").closest('[role="status"]');
    expect(liveStatus).not.toBeNull();
    if (!liveStatus) throw new Error("Expected live status container");
    const expandButton = liveStatus.querySelector("button");
    expect(expandButton).not.toBeNull();
    expect(expandButton?.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(expandButton as HTMLButtonElement);

    expect(expandButton?.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("HiddenTool.tsx")).toBeTruthy();
  });

  it("renders expanded plan-mode bash denials as neutral collapsed tool details", () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: "u-1",
        type: "user",
        content: "列一下文件",
        timestamp: now,
      },
      {
        id: "a-1",
        type: "assistant",
        content: "I will inspect the current directory.",
        timestamp: now,
      },
      {
        id: "tool-bash-1",
        type: "assistant",
        content: "",
        timestamp: now,
        isToolUse: true,
        toolName: "bash",
        toolId: "tool-bash-1",
        toolInput: '{"command":"find . -maxdepth 1 -type f","description":"List files"}',
        toolResult: {
          content: "Plan mode denies side-effecting tool bash.",
          isError: true,
          errorCode: "permission_denied",
        },
      },
      {
        id: "a-2",
        type: "assistant",
        content: "I will use a read-only approach instead.",
        timestamp: now,
      },
    ];

    const { container } = renderPane({ messages, isAssistantWorking: true, runMode: "plan" });

    const summary = screen.getByText(/Ran 1 command.*1 error/);
    const button = summary.closest("button");
    expect(button).not.toBeNull();
    fireEvent.click(button as HTMLButtonElement);

    expect(screen.getByText(/find \. -maxdepth 1 -type f/)).toBeTruthy();
    expect(screen.queryByText("Parameters")).toBeNull();
    expect(container.querySelector(".border-l-red-500")).toBeNull();
    expect(screen.queryByRole("button", { name: /permissions\.grant|Grant Bash for this chat/ })).toBeNull();

    const errorSummary = screen.getByText("Tool error").closest("summary");
    expect(errorSummary).not.toBeNull();
    const details = errorSummary?.closest("details") as HTMLDetailsElement | null;
    expect(details?.open).toBe(false);
  });

  it("preserves an expanded live process row while streamed tool groups grow", () => {
    const now = new Date().toISOString();
    const baseMessages: ChatMessage[] = [
      {
        id: "u-1",
        type: "user",
        content: "检查文件",
        timestamp: now,
      },
      {
        id: "a-1",
        type: "assistant",
        content: "I will inspect the current file.",
        timestamp: now,
      },
      {
        id: "tool-read-1",
        type: "assistant",
        content: "",
        timestamp: now,
        isToolUse: true,
        toolName: "Read",
        toolId: "tool-read-1",
        toolInput: '{"file_path":"src/ReadHidden.tsx"}',
      },
    ];
    const { rerender } = renderPane({ messages: baseMessages, isAssistantWorking: true });

    const liveStatus = screen.getByText("Reading ReadHidden.tsx").closest('[role="status"]');
    expect(liveStatus).not.toBeNull();
    if (!liveStatus) throw new Error("Expected live status container");
    const expandButton = liveStatus.querySelector("button");
    expect(expandButton).not.toBeNull();
    fireEvent.click(expandButton as HTMLButtonElement);
    expect(expandButton?.getAttribute("aria-expanded")).toBe("true");

    const nextMessages: ChatMessage[] = [
      ...baseMessages,
      {
        id: "tool-grep-1",
        type: "assistant",
        content: "",
        timestamp: now,
        isToolUse: true,
        toolName: "Grep",
        toolId: "tool-grep-1",
        toolInput: '{"pattern":"Footer"}',
      },
    ];
    rerender(createPaneElement({ messages: nextMessages, isAssistantWorking: true }));

    const updatedStatus = screen.getByText("Searching Footer").closest('[role="status"]');
    expect(updatedStatus).not.toBeNull();
    const updatedButton = updatedStatus?.querySelector("button");
    expect(updatedButton?.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("ReadHidden.tsx")).toBeTruthy();
  });

  it("preserves process row expansion when a live turn completes", () => {
    const now = new Date().toISOString();
    const baseMessages: ChatMessage[] = [
      {
        id: "u-1",
        type: "user",
        content: "检查文件",
        timestamp: now,
      },
      {
        id: "a-1",
        type: "assistant",
        content: "I will inspect first.",
        timestamp: now,
      },
      {
        id: "tool-read-1",
        type: "assistant",
        content: "",
        timestamp: now,
        isToolUse: true,
        toolName: "Read",
        toolId: "tool-read-1",
        toolInput: '{"file_path":"src/ReadHidden.tsx"}',
      },
    ];
    const { rerender } = renderPane({ messages: baseMessages, isAssistantWorking: true });

    const liveStatus = screen.getByText("Reading ReadHidden.tsx").closest('[role="status"]');
    expect(liveStatus).not.toBeNull();
    if (!liveStatus) throw new Error("Expected live status container");
    const expandButton = liveStatus.querySelector("button");
    expect(expandButton).not.toBeNull();
    fireEvent.click(expandButton as HTMLButtonElement);
    expect(expandButton?.getAttribute("aria-expanded")).toBe("true");

    const completedMessages: ChatMessage[] = [
      {
        ...baseMessages[0],
      },
      {
        ...baseMessages[1],
      },
      {
        ...baseMessages[2],
        toolResult: { content: "ok", isError: false },
      },
      {
        id: "a-2",
        type: "assistant",
        content: "Done.",
        timestamp: now,
      },
    ];
    rerender(createPaneElement({ messages: completedMessages }));

    const summary = screen.getByText("Explored 1 file");
    const completedButton = summary.closest("button");
    expect(completedButton?.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("ReadHidden.tsx")).toBeTruthy();
  });

  it("does not search hidden completed process detail content", async () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: "u-1",
        type: "user",
        content: "检查文件",
        timestamp: now,
      },
      {
        id: "tool-read-1",
        type: "assistant",
        content: "",
        timestamp: now,
        isToolUse: true,
        toolName: "Read",
        toolId: "tool-read-1",
        toolInput: '{"file_path":"src/SearchHiddenNeedle.tsx"}',
        toolResult: { content: "ok", isError: false },
      },
      {
        id: "a-1",
        type: "assistant",
        content: "Done.",
        timestamp: now,
      },
    ];

    renderPane({ messages });

    const summary = screen.getByText("Explored 1 file");
    const processButton = summary.closest("button");
    expect(processButton?.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("SearchHiddenNeedle.tsx")).toBeNull();

    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    const search = screen.getByRole("search");
    const input = search.querySelector('input[type="search"]') as HTMLInputElement | null;
    if (!input) throw new Error("Expected chat search input");
    fireEvent.change(input, { target: { value: "SearchHiddenNeedle.tsx" } });

    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Previous match" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Next match" }) as HTMLButtonElement).disabled).toBe(true);
    });
    expect(processButton?.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("mark.chat-history-search-highlight-active")).toBeNull();
  });

  it("moves between mounted search results without resetting the conversation scroll position", async () => {
    const messages: ChatMessage[] = [
      {
        id: "u-search-1",
        type: "user",
        content: "First visible needle",
        timestamp: new Date().toISOString(),
      },
      {
        id: "a-search-2",
        type: "assistant",
        content: "Second visible needle",
        timestamp: new Date().toISOString(),
      },
    ];

    renderPane({ messages });

    const messageList = screen.getByText("First visible needle").closest("[data-total-message-count]");
    const scrollContainer = messageList?.parentElement as HTMLElement | null;
    if (!scrollContainer) throw new Error("Expected conversation scroll container");

    let currentScrollTop = 240;
    const setScrollTop = vi.fn((value: number) => {
      currentScrollTop = value;
    });
    const scrollTo = vi.fn();
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get: () => currentScrollTop,
      set: setScrollTop,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 400,
    });
    scrollContainer.scrollTo = scrollTo;

    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    const searchInput = screen.getByRole("search").querySelector('input[type="search"]');
    if (!(searchInput instanceof HTMLInputElement)) throw new Error("Expected chat search input");
    fireEvent.change(searchInput, { target: { value: "needle" } });

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalled();
      expect(document.querySelectorAll("mark.chat-history-search-highlight")).toHaveLength(2);
      expect(document.querySelectorAll("mark.chat-history-search-highlight-active")).toHaveLength(1);
    });
    expect(
      document
        .querySelector("mark.chat-history-search-highlight-active")
        ?.closest("[data-message-key]")
        ?.getAttribute("data-message-key"),
    ).toContain("u-search-1");
    scrollTo.mockClear();
    setScrollTop.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));

    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({
          behavior: "smooth",
        }),
      ),
    );
    expect(document.querySelectorAll("mark.chat-history-search-highlight")).toHaveLength(2);
    expect(
      document
        .querySelector("mark.chat-history-search-highlight-active")
        ?.closest("[data-message-key]")
        ?.getAttribute("data-message-key"),
    ).toContain("a-search-2");
    expect(setScrollTop).not.toHaveBeenCalled();
  });

  it("keeps separated live process rows at the positions where they happened", () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: "u-1",
        type: "user",
        content: "继续检查",
        timestamp: now,
      },
      {
        id: "a-1",
        type: "assistant",
        content: "I will inspect files first.",
        timestamp: now,
      },
      {
        id: "tool-read-1",
        type: "assistant",
        content: "",
        timestamp: now,
        isToolUse: true,
        toolName: "Read",
        toolId: "tool-read-1",
        toolInput: '{"file_path":"src/FirstHidden.tsx"}',
        toolResult: { content: "ok", isError: false },
      },
      {
        id: "a-2",
        type: "assistant",
        content: "Now I will verify the build.",
        timestamp: now,
      },
      {
        id: "tool-bash-1",
        type: "assistant",
        content: "",
        timestamp: now,
        isToolUse: true,
        toolName: "Bash",
        toolId: "tool-bash-1",
        toolInput: '{"command":"npm run build"}',
      },
    ];

    renderPane({ messages, isAssistantWorking: true });

    const firstAssistant = screen.getByText("I will inspect files first.");
    const firstStatus = screen.getByText("Explored 1 file");
    const secondAssistant = screen.getByText("Now I will verify the build.");
    const runningStatus = screen.getByText("Running npm run build");

    expect(Boolean(firstAssistant.compareDocumentPosition(firstStatus) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(firstStatus.compareDocumentPosition(secondAssistant) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(secondAssistant.compareDocumentPosition(runningStatus) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );

    expect(screen.queryByText("FirstHidden.tsx")).toBeNull();
    const firstStatusContainer = firstStatus.closest('[role="status"]');
    expect(firstStatusContainer).not.toBeNull();
    if (!firstStatusContainer) throw new Error("Expected first inline status container");
    expect(firstStatusContainer.parentElement?.className).toContain("mt-2");
    expect(firstStatusContainer.parentElement?.className).toContain("gap-2");
    const expandButton = firstStatusContainer.querySelector("button");
    expect(expandButton).not.toBeNull();

    fireEvent.click(expandButton as HTMLButtonElement);

    expect(screen.getByText("FirstHidden.tsx")).toBeTruthy();
    expect(firstAssistant.closest(".chat-message")?.className).toContain("pb-2");
  });

  it("keeps completed process rows in their original positions after the turn finishes", () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: "u-1",
        type: "user",
        content: "继续优化",
        timestamp: now,
      },
      {
        id: "a-1",
        type: "assistant",
        content: "I will inspect first.",
        timestamp: now,
      },
      {
        id: "tool-read-1",
        type: "assistant",
        content: "",
        timestamp: now,
        isToolUse: true,
        toolName: "Read",
        toolId: "tool-read-1",
        toolInput: '{"file_path":"src/FirstHidden.tsx"}',
        toolResult: { content: "ok", isError: false },
      },
      {
        id: "a-2",
        type: "assistant",
        content: "Now I will run checks.",
        timestamp: now,
      },
      {
        id: "tool-bash-1",
        type: "assistant",
        content: "",
        timestamp: now,
        isToolUse: true,
        toolName: "Bash",
        toolId: "tool-bash-1",
        toolInput: '{"command":"npm test"}',
        toolResult: { content: "ok", isError: false },
      },
      {
        id: "a-3",
        type: "assistant",
        content: "All done.",
        timestamp: now,
      },
    ];

    renderPane({ messages });

    const firstAssistant = screen.getByText("I will inspect first.");
    const readSummary = screen.getByText("Explored 1 file");
    const secondAssistant = screen.getByText("Now I will run checks.");
    const commandSummary = screen.getByText("Ran 1 command");
    const finalAssistant = screen.getByText("All done.");

    expect(Boolean(firstAssistant.compareDocumentPosition(readSummary) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(readSummary.compareDocumentPosition(secondAssistant) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(secondAssistant.compareDocumentPosition(commandSummary) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
    expect(Boolean(commandSummary.compareDocumentPosition(finalAssistant) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
  });

  it("shows generating status after a closed live tool group while the assistant continues", () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: "u-1",
        type: "user",
        content: "继续优化",
        timestamp: now,
      },
      {
        id: "a-1",
        type: "assistant",
        content: "I inspected the file.",
        timestamp: now,
      },
      {
        id: "tool-read-1",
        type: "assistant",
        content: "",
        timestamp: now,
        isToolUse: true,
        toolName: "Read",
        toolId: "tool-read-1",
        toolInput: '{"file_path":"src/ClosedTool.tsx"}',
        toolResult: { content: "ok", isError: false },
      },
      {
        id: "a-2",
        type: "assistant",
        content: "Now I am writing the response.",
        timestamp: now,
      },
    ];
    const activityMessages: ChatMessage[] = [
      {
        id: "activity-1",
        type: "system",
        content: "Reading file",
        timestamp: now,
        isAgentActivity: true,
        activityId: "activity-1",
        phase: "tool",
        state: "completed",
        title: "Reading file",
      },
    ];

    renderPane({ messages, activityMessages, isAssistantWorking: true });

    expect(screen.getByText("Explored 1 file")).toBeTruthy();
    expect(screen.getByText("Generating response")).toBeTruthy();
    expect(screen.queryByText("Reading file")).toBeNull();
  });

  it("folds ordinary failed tools into a compact process row with error count", () => {
    const now = new Date().toISOString();
    const failedResult = {
      content: "<tool_use_error>InputValidationError: missing file_path</tool_use_error>",
      isError: true,
      errorCode: "tool_execution_failed",
    };
    const messages: ChatMessage[] = [
      {
        id: "u-1",
        type: "user",
        content: "修一下页面",
        timestamp: now,
      },
      {
        id: "tool-edit-1",
        type: "assistant",
        content: "",
        timestamp: now,
        isToolUse: true,
        toolName: "write_file",
        toolId: "tool-edit-1",
        toolInput: '{"file_path":"src/FailedTool.tsx","content":"export const failed = true;"}',
        toolResult: failedResult,
      },
      {
        id: "tool-grep-1",
        type: "assistant",
        content: "",
        timestamp: now,
        isToolUse: true,
        toolName: "Grep",
        toolId: "tool-grep-1",
        toolInput: '{"pattern":"Footer"}',
        toolResult: failedResult,
      },
      {
        id: "a-1",
        type: "assistant",
        content: "I will retry with corrected inputs.",
        timestamp: now,
      },
    ];

    const { container } = renderPane({ messages });

    expect(screen.queryByText("Tool error")).toBeNull();
    expect(screen.queryByText("FailedTool.tsx")).toBeNull();

    const summary = screen.getByText(/Edited 1 file.*Searched 1 time.*2 errors/);
    const button = summary.closest("button");
    expect(button).not.toBeNull();
    expect(button?.className).toContain("inline-flex");
    expect(button?.className).toContain("items-center");
    expect(button?.className).toContain("text-[14px]");
    expect(button?.className).toContain("leading-relaxed");
    expect(button?.closest(".process-trace")?.className).not.toContain("my-");

    fireEvent.click(button as HTMLButtonElement);

    expect(screen.getByText("FailedTool.tsx")).toBeTruthy();
    expect(screen.getAllByText("Tool error").length).toBeGreaterThan(0);
    expect(container.querySelector(".border-l-red-500")).toBeNull();
  });

  it("shows a waiting status below an in-progress web_fetch in plan mode", () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: "u-1",
        type: "user",
        content: "搜索一下",
        timestamp: now,
      },
      {
        id: "a-1",
        type: "assistant",
        content: "我去查一下文档。",
        timestamp: now,
      },
      {
        id: "tool-fetch-1",
        type: "assistant",
        content: "",
        timestamp: now,
        isToolUse: true,
        toolName: "web_fetch",
        toolId: "tool-fetch-1",
        toolInput: '{"url":"https://example.com"}',
      },
    ];

    renderPane({ messages, isAssistantWorking: true, runMode: "plan", planModeActive: true });

    expect(screen.getByText("Fetching web content...")).toBeTruthy();
  });

  it("does not show the web_fetch waiting status in agent mode", () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: "u-1",
        type: "user",
        content: "搜索一下",
        timestamp: now,
      },
      {
        id: "a-1",
        type: "assistant",
        content: "我去查一下文档。",
        timestamp: now,
      },
      {
        id: "tool-fetch-1",
        type: "assistant",
        content: "",
        timestamp: now,
        isToolUse: true,
        toolName: "web_fetch",
        toolId: "tool-fetch-1",
        toolInput: '{"url":"https://example.com"}',
      },
    ];

    renderPane({ messages, isAssistantWorking: true, runMode: "agent" });

    expect(screen.queryByText("Fetching web content...")).toBeNull();
  });

  it("does not render a completed compact boundary as a plan-mode process row", () => {
    const now = new Date().toISOString();
    const messages: ChatMessage[] = [
      {
        id: "u-1",
        type: "user",
        content: "先规划一下",
        timestamp: now,
      },
      {
        id: "compact-1",
        type: "system",
        content: "Context compacted",
        timestamp: now,
        isCompactBoundary: true,
      },
      {
        id: "a-1",
        type: "assistant",
        content: "I will make a plan first.",
        timestamp: now,
      },
    ];

    renderPane({ messages, isAssistantWorking: true, runMode: "plan", planModeActive: true });

    expect(screen.getByText("I will make a plan first.")).toBeTruthy();
    expect(screen.queryByText("Compacted context")).toBeNull();
  });

  it("uses compact message spacing instead of the old large row gap", () => {
    const messages = [
      {
        id: "u-1",
        type: "user",
        content: "调整一下",
        timestamp: new Date().toISOString(),
      },
      {
        id: "a-1",
        type: "assistant",
        content: "First assistant line.",
        timestamp: new Date().toISOString(),
      },
      {
        id: "a-2",
        type: "assistant",
        content: "Second assistant line.",
        timestamp: new Date().toISOString(),
      },
    ];

    renderPane({ messages });

    expect(screen.getByText("First assistant line.").closest(".chat-message")?.className).toContain("pb-4");
    expect(screen.getByText("First assistant line.").closest(".chat-message")?.className).not.toContain("pb-8");
  });
});

describe("buildPrefixOffsets（P3-5 前缀和缓存）", () => {
  it("空数组 → [0]", () => {
    expect(buildPrefixOffsets([])).toEqual([0]);
  });

  it("常规高度 → 递增前缀和", () => {
    expect(buildPrefixOffsets([100, 200, 50])).toEqual([0, 100, 300, 350]);
  });

  it("非正高度按下限 1 计入", () => {
    expect(buildPrefixOffsets([0, -5, 120])).toEqual([0, 1, 2, 122]);
  });

  it("getVirtualMessageWindow 显式 prefixOffsets 与默认计算一致", () => {
    const heights = [100, 200, 50, 300];
    const prefixOffsets = buildPrefixOffsets(heights);
    const withDefault = getVirtualMessageWindow(heights, 0, 400);
    const withCached = getVirtualMessageWindow(heights, 0, 400, 12, prefixOffsets);
    expect(withCached).toEqual(withDefault);
    expect(withCached.totalHeight).toBe(650);
  });
});

describe("压缩实时步骤的终态", () => {
  const workingStatusFor = (state: "running" | "failed" | "cancelled"): SatiWorkStatus => ({
    text: "compacting",
    tokens: 0,
    can_interrupt: true,
    compactProgress: { level: 3, stage: "compacting", label: "Compacting", state },
  });

  it("运行中显示「正在压缩」", async () => {
    renderPane({ messages: [makeMessage(0)], isAssistantWorking: true, workingStatus: workingStatusFor("running") });
    await waitFor(() => expect(screen.getByText("Compacting context...")).toBeTruthy());
  });

  it("失败不再显示成「正在压缩」", async () => {
    renderPane({ messages: [makeMessage(0)], isAssistantWorking: true, workingStatus: workingStatusFor("failed") });
    await waitFor(() => expect(screen.getByText("Context compaction failed")).toBeTruthy());
    expect(screen.queryByText("Compacting context...")).toBeNull();
  });

  it("中断显示为已停止（与摘要失败区分）", async () => {
    renderPane({ messages: [makeMessage(0)], isAssistantWorking: true, workingStatus: workingStatusFor("cancelled") });
    await waitFor(() => expect(screen.getByText("Context compaction stopped")).toBeTruthy());
  });
});
