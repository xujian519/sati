// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectSession } from "../../../types/app";
import type { ChatMessage } from "../types/types";
import type { ThinkingModeAvailability } from "../constants/thinkingModeAvailability";
import type { ContentReference } from "../../../types/contentReference";
import { authenticatedFetch } from "../../../utils/api";
import { useSessionSubmit } from "./useSessionSubmit";

vi.mock("../../../utils/api", () => ({ authenticatedFetch: vi.fn() }));

const mockedFetch = vi.mocked(authenticatedFetch);

type SessionSubmitProps = Parameters<typeof useSessionSubmit>[0];

const PROJECT = { name: "proj", displayName: "Proj", path: "/tmp/proj", fullPath: "/tmp/proj" } as Project;
const SESSION = { id: "sess-1" } as ProjectSession;

function createProps(overrides: Partial<SessionSubmitProps> = {}): SessionSubmitProps {
  const inputValueRef = { current: "" };
  return {
    selectedProject: PROJECT,
    selectedSession: SESSION,
    currentSessionId: "sess-1",
    isLoading: false,
    canAbortSession: false,
    thinkingMode: "default",
    pendingNewSessionThinkingModeRef: { current: null },
    activeDraftStorageKeyRef: { current: null },
    runMode: undefined,
    permissionMode: "default",
    basePermissionMode: undefined,
    model: "test-model",
    thinkingModeAvailability: {} as ThinkingModeAvailability,
    sendMessage: vi.fn(),
    addMessage: vi.fn(),
    setIsLoading: vi.fn(),
    setCanAbortSession: vi.fn(),
    setIsAborting: vi.fn(),
    setClaudeStatus: vi.fn(),
    setIsUserScrolledUp: vi.fn(),
    onSessionActive: vi.fn(),
    onSessionProcessing: vi.fn(),
    onSessionActivityBump: vi.fn(),
    pendingViewSessionRef: { current: null },
    referenceOnlyPrompt: "Please answer based on the document selection I quoted.",
    scrollToBottom: vi.fn(),
    executeCommand: vi.fn(async () => {}),
    skipSlashDetectionOnceRef: { current: false },
    commandMenu: { slashCommands: [], resetCommandMenuState: vi.fn() },
    setIsTextareaExpanded: vi.fn(),
    input: "",
    inputValueRef,
    attachedImages: [],
    documentReferences: [],
    resetAttachmentState: vi.fn(),
    applyInputValue: vi.fn((value: string) => {
      inputValueRef.current = value;
    }),
    resolveConcreteSessionId: vi.fn(() => "sess-1"),
    cancelBusySendQueue: vi.fn(),
    editLastTurnTargetRef: { current: null },
    textareaRef: { current: null },
    queuedBusySendRef: { current: false },
    queuedBusySendConfirmedRef: { current: false },
    queuedBusySendSnapshotRef: { current: null },
    isBusySendQueued: false,
    setIsBusySendQueued: vi.fn(),
    setIsBusySendConfirmed: vi.fn(),
    handleSubmitRef: { current: null },
    ...overrides,
  };
}

function submitEvent() {
  return { preventDefault: vi.fn() };
}

function sentMessage(props: SessionSubmitProps) {
  return vi.mocked(props.sendMessage).mock.calls[0]?.[0] as
    | {
        type?: string;
        command?: string;
        text?: string;
        sessionId?: string;
        options?: { sessionId?: string; resume?: boolean; model?: string; images?: unknown[] };
      }
    | undefined;
}

function userMessages(props: SessionSubmitProps) {
  return vi
    .mocked(props.addMessage)
    .mock.calls.map(([message]) => message)
    .filter((message): message is ChatMessage => message.type === "user");
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mockedFetch.mockReset();
});

describe("useSessionSubmit", () => {
  it("does nothing for empty input without attachments", async () => {
    const props = createProps();
    props.inputValueRef.current = "   ";
    const { result } = renderHook(() => useSessionSubmit(props));

    await act(async () => {
      await result.current.handleSubmit(submitEvent());
    });

    expect(props.sendMessage).not.toHaveBeenCalled();
    expect(props.addMessage).not.toHaveBeenCalled();
  });

  it("submits a normal message: optimistic bubble, sati-command, cleared composer state", async () => {
    const props = createProps();
    props.inputValueRef.current = "hello world";
    const { result } = renderHook(() => useSessionSubmit(props));

    await act(async () => {
      await result.current.handleSubmit(submitEvent());
    });

    expect(userMessages(props)).toHaveLength(1);
    expect(userMessages(props)[0].content).toBe("hello world");
    expect(props.setIsLoading).toHaveBeenCalledWith(true);
    expect(props.applyInputValue).toHaveBeenCalledWith("");
    expect(props.resetAttachmentState).toHaveBeenCalled();
    expect(props.commandMenu.resetCommandMenuState).toHaveBeenCalled();
    expect(props.setIsTextareaExpanded).toHaveBeenCalledWith(false);

    const message = sentMessage(props);
    expect(message?.type).toBe("sati-command");
    if (message?.type === "sati-command") {
      expect(message.command).toBe("hello world");
      expect(message.options?.sessionId).toBe("sess-1");
      expect(message.options?.resume).toBe(true);
      expect(message.options?.model).toBe("test-model");
    }
  });

  it("uploads attachments before submitting and reports the uploaded paths", async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        images: [{ url: "img-1" }],
        files: [{ name: "brief.pdf", path: "uploads/brief.pdf" }],
      }),
    } as Response);

    const file = new File([new Uint8Array(1)], "brief.pdf", { type: "application/pdf" });
    const props = createProps({ attachedImages: [file] });
    props.inputValueRef.current = "summarize";
    const { result } = renderHook(() => useSessionSubmit(props));

    await act(async () => {
      await result.current.handleSubmit(submitEvent());
    });

    expect(mockedFetch).toHaveBeenCalledWith(
      "/api/projects/proj/upload-attachments",
      expect.objectContaining({ method: "POST" }),
    );
    const userMessage = userMessages(props)[0];
    expect(userMessage.images).toEqual([{ url: "img-1" }]);
    expect(userMessage.attachments?.[0]).toMatchObject({ name: "brief.pdf", path: "uploads/brief.pdf" });

    const message = sentMessage(props);
    expect(message?.type).toBe("sati-command");
    if (message?.type === "sati-command") {
      expect(message.command).toContain("uploads/brief.pdf");
      expect(message.options?.images).toEqual([{ url: "img-1" }]);
    }
  });

  it("shows an error and skips dispatch when the attachment upload fails", async () => {
    mockedFetch.mockResolvedValue({ ok: false, status: 500 } as Response);

    const file = new File([new Uint8Array(1)], "broken.png", { type: "image/png" });
    const props = createProps({ attachedImages: [file] });
    props.inputValueRef.current = "go";
    const { result } = renderHook(() => useSessionSubmit(props));

    await act(async () => {
      await result.current.handleSubmit(submitEvent());
    });

    expect(props.sendMessage).not.toHaveBeenCalled();
    expect(props.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        content: "Failed to upload attachments: Failed to upload attachments",
      }),
      "sess-1",
    );
  });

  it("queues the first submit while busy without dispatching", async () => {
    const props = createProps({ isLoading: true });
    props.inputValueRef.current = "queued text";
    const { result } = renderHook(() => useSessionSubmit(props));

    await act(async () => {
      await result.current.handleSubmit(submitEvent());
    });

    expect(props.sendMessage).not.toHaveBeenCalled();
    expect(props.queuedBusySendRef.current).toBe(true);
    expect(props.queuedBusySendSnapshotRef.current).toMatchObject({ input: "queued text" });
    expect(props.setIsBusySendQueued).toHaveBeenCalledWith(true);
    expect(props.setIsBusySendConfirmed).toHaveBeenCalledWith(false);
  });

  it("aborts the running turn when submitting again while a send is queued", async () => {
    const props = createProps({ isLoading: true, isBusySendQueued: true, canAbortSession: true });
    props.inputValueRef.current = "new text";
    const { result } = renderHook(() => useSessionSubmit(props));

    await act(async () => {
      await result.current.handleSubmit(submitEvent());
    });

    expect(props.sendMessage).toHaveBeenCalledWith({
      type: "abort-session",
      sessionId: "sess-1",
      provider: "sati",
    });
    expect(props.queuedBusySendSnapshotRef.current).toMatchObject({
      input: "new text",
      forceStart: true,
    });
    expect(props.queuedBusySendConfirmedRef.current).toBe(true);
    expect(props.setIsAborting).toHaveBeenCalledWith(true);
  });

  it("intercepts a known slash command instead of submitting text", async () => {
    const command = { name: "/help", description: "Help" };
    const props = createProps();
    props.commandMenu = { slashCommands: [command], resetCommandMenuState: vi.fn() };
    props.inputValueRef.current = "/help overview";
    const { result } = renderHook(() => useSessionSubmit(props));

    await act(async () => {
      await result.current.handleSubmit(submitEvent());
    });

    expect(props.executeCommand).toHaveBeenCalledWith(command, "/help overview");
    expect(props.sendMessage).not.toHaveBeenCalled();
    expect(props.applyInputValue).toHaveBeenCalledWith("");
    expect(props.commandMenu.resetCommandMenuState).toHaveBeenCalled();
  });

  it("does not re-intercept the slash text after a passthrough command", async () => {
    const command = { name: "/help" };
    const props = createProps();
    props.commandMenu = { slashCommands: [command], resetCommandMenuState: vi.fn() };
    props.skipSlashDetectionOnceRef.current = true;
    props.inputValueRef.current = "/help literal";
    const { result } = renderHook(() => useSessionSubmit(props));

    await act(async () => {
      await result.current.handleSubmit(submitEvent());
    });

    expect(props.executeCommand).not.toHaveBeenCalled();
    expect(props.skipSlashDetectionOnceRef.current).toBe(false);
    expect(sentMessage(props)?.type).toBe("sati-command");
  });

  it("sends edit-last-turn when the edit mode is armed", async () => {
    const props = createProps();
    props.editLastTurnTargetRef.current = { sessionId: "sess-1" };
    props.inputValueRef.current = "edited text";
    const { result } = renderHook(() => useSessionSubmit(props));

    await act(async () => {
      await result.current.handleSubmit(submitEvent());
    });

    const message = sentMessage(props);
    expect(message?.type).toBe("edit-last-turn");
    if (message?.type === "edit-last-turn") {
      expect(message.sessionId).toBe("sess-1");
      expect(message.text).toBe("edited text");
    }
    expect(props.editLastTurnTargetRef.current).toBeNull();
    expect(userMessages(props)[0].content).toBe("edited text");
  });

  it("regenerateLastTurn dispatches a regenerate frame and an optimistic bubble", async () => {
    const props = createProps();
    const { result } = renderHook(() => useSessionSubmit(props));

    await act(async () => {
      result.current.regenerateLastTurn("sess-1", "original question");
    });

    const message = sentMessage(props);
    expect(message?.type).toBe("regenerate-last-turn");
    if (message?.type === "regenerate-last-turn") {
      expect(message.sessionId).toBe("sess-1");
    }
    expect(userMessages(props)[0].content).toBe("original question");
    expect(props.setIsLoading).toHaveBeenCalledWith(true);
  });

  it("steers the queued text as mid-turn input and clears the queue", () => {
    const props = createProps({ isBusySendQueued: true, isLoading: true, input: "steer text" });
    props.inputValueRef.current = "steer text";
    props.queuedBusySendSnapshotRef.current = { input: "steer text", attachedImages: [], documentReferences: [] };
    const { result } = renderHook(() => useSessionSubmit(props));

    act(() => result.current.steerBusySendQueue());

    expect(props.sendMessage).toHaveBeenCalledWith({
      type: "steer-session",
      sessionId: "sess-1",
      text: "steer text",
    });
    expect(props.cancelBusySendQueue).toHaveBeenCalled();
    expect(props.applyInputValue).toHaveBeenCalledWith("");
    expect(props.resetAttachmentState).toHaveBeenCalled();
  });

  it("disables steering when the queued send carries attachments", () => {
    const props = createProps({ isBusySendQueued: true, isLoading: true, input: "steer text" });
    props.inputValueRef.current = "steer text";
    const { result } = renderHook(() => useSessionSubmit(props));

    expect(result.current.canSteerBusySend).toBe(true);

    const imageFile = new File([new Uint8Array(1)], "shot.png", { type: "image/png" });
    const reference = { id: "ref-1" } as ContentReference;
    const { result: withAttachments } = renderHook(() =>
      useSessionSubmit({ ...props, attachedImages: [imageFile], documentReferences: [reference] }),
    );

    expect(withAttachments.current.canSteerBusySend).toBe(false);
  });

  it("flushes the queued send when the session becomes idle", async () => {
    const props = createProps({ isLoading: true });
    props.inputValueRef.current = "queued text";
    const { result, rerender } = renderHook((p: SessionSubmitProps) => useSessionSubmit(p), {
      initialProps: props,
    });

    await act(async () => {
      await result.current.handleSubmit(submitEvent());
    });
    expect(props.sendMessage).not.toHaveBeenCalled();

    await act(async () => {
      rerender({ ...props, isLoading: false });
    });

    expect(props.sendMessage).toHaveBeenCalledTimes(1);
    expect(sentMessage(props)?.type).toBe("sati-command");
    expect(userMessages(props)[0].content).toBe("queued text");
  });
});
