// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInterfaceProps, ChatMessage } from "../chat/types/types";
import ChatInterfaceV2 from "./ChatInterfaceV2";

const h = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  sessionArgs: {} as Record<string, unknown>,
  composer: {} as Record<string, unknown>,
  composerArgs: {} as Record<string, unknown>,
  provider: {} as Record<string, unknown>,
  realtimeArgs: {} as Record<string, unknown>,
  messagesPane: {} as Record<string, unknown>,
  composerV2: {} as Record<string, unknown>,
  store: {} as Record<string, unknown>,
  toast: vi.fn(),
  abortSession: vi.fn(),
  beginEditLastTurn: vi.fn(),
  regenerateLastTurn: vi.fn(),
  refreshFromServer: vi.fn(),
  forkSession: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock("../../contexts/TasksSettingsContext", () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }),
}));

vi.mock("../../contexts/ToastContext", () => ({
  useToast: () => ({ addToast: h.toast }),
}));

vi.mock("../../utils/api", () => ({
  api: { forkSession: (...args: unknown[]) => h.forkSession(...args) },
}));

vi.mock("../../stores/useSessionStore", () => ({
  useSessionStore: () => h.store,
}));

vi.mock("../../hooks/useSessionWatch", () => ({
  useSessionWatch: vi.fn(),
}));

vi.mock("../chat/hooks/useChatProviderState", () => ({
  useChatProviderState: () => h.provider,
}));

vi.mock("../chat/hooks/useChatSessionState", () => ({
  useChatSessionState: (args: Record<string, unknown>) => {
    h.sessionArgs = args;
    return h.session;
  },
}));

vi.mock("../chat/hooks/useChatComposerState", () => ({
  useChatComposerState: (args: Record<string, unknown>) => {
    h.composerArgs = args;
    return h.composer;
  },
}));

vi.mock("../chat/hooks/useChatRealtimeHandlers", () => ({
  useChatRealtimeHandlers: (args: Record<string, unknown>) => {
    h.realtimeArgs = args;
  },
}));

vi.mock("./MessagesPaneV2", () => ({
  default: (props: Record<string, unknown>) => {
    h.messagesPane = props;
    return React.createElement("div", { "data-testid": "messages-pane" });
  },
}));

vi.mock("./ComposerV2", () => ({
  default: (props: Record<string, unknown>) => {
    h.composerV2 = props;
    return React.createElement(
      "div",
      { "data-testid": "composer" },
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "composer-submit",
          onClick: () => (props.onSubmit as (value: string) => void)("hello"),
        },
        "submit",
      ),
      React.createElement(
        "button",
        { type: "button", "data-testid": "composer-stop", onClick: props.onAbortSession as () => void },
        "stop",
      ),
    );
  },
}));

function resetMocks() {
  h.session = {
    chatMessages: [] as ChatMessage[],
    activityMessages: [],
    addMessage: vi.fn(),
    clearMessages: vi.fn(),
    rewindMessages: vi.fn(),
    isLoading: false,
    setIsLoading: vi.fn(),
    currentSessionId: "sess-1",
    setCurrentSessionId: vi.fn(),
    isLoadingSessionMessages: false,
    sessionLoadError: null,
    hasMoreMessages: false,
    totalMessages: 0,
    canAbortSession: false,
    setCanAbortSession: vi.fn(),
    isAborting: false,
    setIsAborting: vi.fn(),
    setIsUserScrolledUp: vi.fn(),
    tokenBudget: null,
    setTokenBudget: vi.fn(),
    visibleMessageCount: 0,
    visibleMessages: [],
    loadEarlierMessages: vi.fn(),
    loadAllMessages: vi.fn(),
    allMessagesLoaded: false,
    claudeStatus: null,
    satiStatus: null,
    setClaudeStatus: vi.fn(),
    setSatiStatus: vi.fn(),
    createDiff: vi.fn(),
    scrollContainerRef: { current: null },
    scrollToBottom: vi.fn(),
    handleScroll: vi.fn(),
  };
  h.composer = {
    input: "hello",
    setInput: vi.fn(),
    textareaRef: { current: null },
    inputHighlightRef: { current: null },
    isTextareaExpanded: false,
    thinkingMode: "default",
    setThinkingMode: vi.fn(),
    slashCommandsCount: 0,
    filteredCommands: [],
    frequentCommands: [],
    commandQuery: "",
    showCommandMenu: false,
    selectedCommandIndex: 0,
    resetCommandMenuState: vi.fn(),
    dismissCommandMenu: vi.fn(),
    handleCommandSelect: vi.fn(),
    handleToggleCommandMenu: vi.fn(),
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: 0,
    renderInputWithMentions: (value: string) => value,
    selectFile: vi.fn(),
    attachedImages: [],
    setAttachedImages: vi.fn(),
    documentReferences: [],
    removeDocumentReference: vi.fn(),
    uploadingImages: new Map(),
    imageErrors: new Map(),
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
    openImagePicker: vi.fn(),
    handleSubmit: vi.fn(),
    handleInputChange: vi.fn(),
    insertAtCursor: vi.fn(),
    handleKeyDown: vi.fn(),
    handlePaste: vi.fn(),
    handleTextareaClick: vi.fn(),
    handleTextareaInput: vi.fn(),
    syncInputOverlayScroll: vi.fn(),
    handleAbortSession: h.abortSession,
    handlePermissionDecision: vi.fn(),
    handleGrantToolPermission: vi.fn(),
    handleGrantSessionToolPermission: vi.fn(),
    handleApprovalDecision: vi.fn(),
    handleInputFocusChange: vi.fn(),
    isBusySendQueued: false,
    isBusySendConfirmed: false,
    cancelBusySendQueue: vi.fn(),
    steerBusySendQueue: vi.fn(),
    canSteerBusySend: false,
    beginEditLastTurn: h.beginEditLastTurn,
    regenerateLastTurn: h.regenerateLastTurn,
  };
  h.provider = {
    model: "model-1",
    permissionMode: "default",
    setPermissionMode: vi.fn(),
    thinkingModelContext: {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: vi.fn(),
    pendingApprovals: [],
    setPendingApprovals: vi.fn(),
  };
  h.store = { refreshFromServer: h.refreshFromServer };
  h.toast.mockReset();
  h.abortSession.mockReset();
  h.beginEditLastTurn.mockReset();
  h.regenerateLastTurn.mockReset();
  h.refreshFromServer.mockReset().mockResolvedValue(undefined);
  h.forkSession.mockReset();
  h.sendMessage.mockReset();
  localStorage.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
}

function makeProps(overrides: Partial<ChatInterfaceProps> = {}): ChatInterfaceProps {
  return {
    selectedProject: { name: "proj", displayName: "Proj", fullPath: "/tmp/proj" },
    selectedSession: { id: "sess-1" },
    ws: null,
    sendMessage: h.sendMessage,
    subscribe: vi.fn(),
    latestMessage: null,
    ...overrides,
  };
}

function makeUserMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { type: "user", content: "hello", timestamp: 0, entryId: "entry-1", ...overrides };
}

beforeEach(() => {
  resetMocks();
});

describe("ChatInterfaceV2 wiring", () => {
  it("renders the messages pane and composer with the resolved chat state", () => {
    render(<ChatInterfaceV2 {...makeProps()} />);

    expect(screen.getByTestId("messages-pane")).toBeTruthy();
    expect(h.messagesPane.provider).toBe("sati");
    expect(h.messagesPane.isAssistantWorking).toBe(false);
    expect(h.messagesPane.runMode).toBe("agent");
    expect(h.messagesPane.planModeActive).toBe(false);
    expect(h.composerV2.input).toBe("hello");
    expect(h.composerV2.planModeAvailable).toBe(true);
    expect(h.composerV2.chromeless).toBe(false);
  });

  it("cycles run mode agent -> plan -> ask -> agent", () => {
    render(<ChatInterfaceV2 {...makeProps()} />);

    act(() => (h.composerArgs.cycleRunMode as () => void)());
    expect(h.composerV2.runMode).toBe("plan");
    expect(h.messagesPane.planModeActive).toBe(true);

    act(() => (h.composerArgs.cycleRunMode as () => void)());
    expect(h.composerV2.runMode).toBe("ask");
    expect(h.messagesPane.planModeActive).toBe(false);

    act(() => (h.composerArgs.cycleRunMode as () => void)());
    expect(h.composerV2.runMode).toBe("agent");
  });

  it("persists the selected permission mode globally and per session", () => {
    render(<ChatInterfaceV2 {...makeProps()} />);

    act(() => (h.composerV2.onPermissionModeChange as (mode: string) => void)("acceptEdits"));

    expect(h.provider.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
    expect(localStorage.getItem("permissionMode-default")).toBe("acceptEdits");
    expect(localStorage.getItem("permissionMode-sess-1")).toBe("acceptEdits");
  });

  it("uses the plan permission mode while run mode is plan", () => {
    render(<ChatInterfaceV2 {...makeProps()} />);

    act(() => (h.composerArgs.cycleRunMode as () => void)());

    expect(h.messagesPane.planModeActive).toBe(true);
    expect(h.composerArgs.permissionMode).toBe("plan");
    expect(h.composerArgs.basePermissionMode).toBe("default");
  });

  it("renders a read-only transcript without composer actions", () => {
    render(<ChatInterfaceV2 {...makeProps({ selectedSession: { id: "sess-ro", isReadOnly: true } })} />);

    expect(screen.getByText("This transcript is read-only.")).toBeTruthy();
    expect(screen.queryByTestId("composer")).toBeNull();
    expect(h.messagesPane.onFork).toBeUndefined();
    expect(h.messagesPane.onEditLastUserMessage).toBeUndefined();
    expect(h.messagesPane.onRegenerateLastTurn).toBeUndefined();
  });
});

describe("ChatInterfaceV2 abort handling", () => {
  it("aborts once on Escape while a turn is running and ignores repeats", () => {
    const props = makeProps();
    h.session.isLoading = true;
    h.session.canAbortSession = true;
    render(<ChatInterfaceV2 {...props} />);

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(h.abortSession).toHaveBeenCalledTimes(1);
  });

  it("does not abort on Escape when no turn is running", () => {
    render(<ChatInterfaceV2 {...makeProps()} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(h.abortSession).not.toHaveBeenCalled();
  });

  it("does not abort on Escape while a modal overlay is open", () => {
    h.session.isLoading = true;
    h.session.canAbortSession = true;
    render(<ChatInterfaceV2 {...makeProps()} />);
    const overlay = document.createElement("div");
    overlay.setAttribute("data-modal-overlay", "");
    document.body.appendChild(overlay);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(h.abortSession).not.toHaveBeenCalled();
    overlay.remove();
  });

  it("marks abort as pending and suppresses duplicate stop clicks", () => {
    h.session.isLoading = true;
    h.session.canAbortSession = true;
    render(<ChatInterfaceV2 {...makeProps()} />);

    fireEvent.click(screen.getByTestId("composer-stop"));
    fireEvent.click(screen.getByTestId("composer-stop"));

    expect(h.abortSession).toHaveBeenCalledTimes(1);
  });
});

describe("ChatInterfaceV2 fork / edit / regenerate", () => {
  it("forks from an entry and prefills the new session draft", async () => {
    const onNavigateToSession = vi.fn();
    const refreshProjects = vi.fn().mockResolvedValue(undefined);
    window.refreshProjects = refreshProjects;
    h.forkSession.mockResolvedValue({
      ok: true,
      json: async () => ({ newSessionId: "sess-2", prefillText: "carried draft", runMode: "plan" }),
    });
    render(<ChatInterfaceV2 {...makeProps({ onNavigateToSession })} />);

    await act(async () => {
      await (h.messagesPane.onFork as (message: ChatMessage, preview: number) => Promise<void>)(
        makeUserMessage({ content: "original" }),
        0,
      );
    });

    expect(h.forkSession).toHaveBeenCalledWith("sess-1", {
      projectPath: "/tmp/proj",
      fromEntryId: "entry-1",
    });
    expect(refreshProjects).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("draft_input_proj:sess-2")).toBe("carried draft");
    expect(onNavigateToSession).toHaveBeenCalledWith("sess-2");
    expect(h.composer.setInput).toHaveBeenCalledWith("carried draft");
    expect(h.composerV2.runMode).toBe("plan");
    expect(h.toast).toHaveBeenCalledWith("success", "Fork created — edit the prompt and send when ready.");
    delete window.refreshProjects;
  });

  it("rejects a fork target without an entry id", async () => {
    render(<ChatInterfaceV2 {...makeProps()} />);

    await act(async () => {
      await (h.messagesPane.onFork as (message: ChatMessage, preview: number) => Promise<void>)(
        makeUserMessage({ entryId: undefined }),
        0,
      );
    });

    expect(h.forkSession).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith("error", "Cannot fork this message.");
  });

  it("surfaces the server fork error", async () => {
    h.forkSession.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "session busy" }),
    });
    render(<ChatInterfaceV2 {...makeProps()} />);

    await act(async () => {
      await (h.messagesPane.onFork as (message: ChatMessage, preview: number) => Promise<void>)(makeUserMessage(), 0);
    });

    expect(h.toast).toHaveBeenCalledWith("error", "session busy");
  });

  it("starts editing the last user message", () => {
    render(<ChatInterfaceV2 {...makeProps()} />);

    (h.messagesPane.onEditLastUserMessage as (message: ChatMessage) => void)(
      makeUserMessage({ content: "edit me", entryId: "entry-2" }),
    );

    expect(h.beginEditLastTurn).toHaveBeenCalledWith("sess-1", "edit me");
  });

  it("regenerates from the latest non-empty user message", () => {
    h.session.chatMessages = [
      makeUserMessage({ content: "first" }),
      { type: "assistant", content: "answer", timestamp: 0 } as ChatMessage,
      makeUserMessage({ content: "latest question" }),
    ];
    render(<ChatInterfaceV2 {...makeProps()} />);

    (h.messagesPane.onRegenerateLastTurn as (message: ChatMessage) => void)(makeUserMessage({ entryId: "entry-3" }));

    expect(h.regenerateLastTurn).toHaveBeenCalledWith("sess-1", "latest question");
  });
});

describe("ChatInterfaceV2 reconnect", () => {
  it("refreshes an idle session and asks for its status after reconnect", async () => {
    render(<ChatInterfaceV2 {...makeProps()} />);

    await act(async () => {
      await (h.realtimeArgs.onWebSocketReconnect as () => Promise<void>)();
    });

    expect(h.refreshFromServer).toHaveBeenCalledWith("sess-1", {
      provider: "sati",
      projectName: "proj",
      projectPath: "/tmp/proj",
    });
    expect(h.sendMessage).toHaveBeenCalledWith({
      type: "check-session-status",
      sessionId: "sess-1",
      provider: "sati",
      includeActiveTurnMessages: true,
    });
  });

  it("skips the full refresh while the session is processing but still asks for status", async () => {
    h.session.isLoading = true;
    render(<ChatInterfaceV2 {...makeProps({ processingSessions: new Set(["sess-1"]) })} />);

    await act(async () => {
      await (h.realtimeArgs.onWebSocketReconnect as () => Promise<void>)();
    });

    expect(h.refreshFromServer).not.toHaveBeenCalled();
    expect(h.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "check-session-status", sessionId: "sess-1" }),
    );
  });
});

describe("ChatInterfaceV2 welcome mode", () => {
  it("leaves welcome mode on the first submit", () => {
    const onExitWelcome = vi.fn();
    render(<ChatInterfaceV2 {...makeProps({ forceWelcome: true, onExitWelcome })} />);

    expect(screen.getByText("What's on the plan today?")).toBeTruthy();
    expect(h.composerV2.chromeless).toBe(true);

    fireEvent.click(screen.getByTestId("composer-submit"));

    expect(onExitWelcome).toHaveBeenCalledTimes(1);
    expect(h.composer.handleSubmit).toHaveBeenCalledWith("hello");
  });

  it("renders the compact workspace empty state", () => {
    render(<ChatInterfaceV2 {...makeProps({ forceWelcome: true, compact: true })} />);

    expect(screen.getByText("Ask Sati about this project")).toBeTruthy();
    expect(h.composerV2.chromeless).toBe(false);
  });
});
