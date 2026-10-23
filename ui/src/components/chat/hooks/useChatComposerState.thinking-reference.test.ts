// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThinkingModeAvailability } from "../constants/thinkingModeAvailability";
import { ADD_CONTENT_REFERENCE_EVENT } from "../../../types/contentReference";
import type { DocumentSelectionReference } from "../../../types/documentSelection";
import { useChatComposerState } from "./useChatComposerState";

type ComposerArgs = Parameters<typeof useChatComposerState>[0];

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

function baseProps(overrides: Partial<ComposerArgs> = {}): ComposerArgs {
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
    ...overrides,
  };
}

function documentReference(id: string): DocumentSelectionReference {
  return {
    kind: "document-selection",
    id,
    projectName: "p1",
    fileName: "brief.pdf",
    filePath: "docs/brief.pdf",
    source: "pdf",
    pageNumbers: [1],
    selectedText: "claim 1",
    createdAt: "2026-10-23T00:00:00.000Z",
  };
}

describe("useChatComposerState thinking mode", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("restores the stored mode for a concrete session", async () => {
    localStorage.setItem("thinkingMode-s1", "high");

    const { result } = renderHook(() => useChatComposerState(baseProps()));

    await waitFor(() => expect(result.current.thinkingMode).toBe("high"));
  });

  it("persists a mode change for a concrete session", () => {
    const { result } = renderHook(() => useChatComposerState(baseProps()));

    act(() => result.current.setThinkingMode("low"));

    expect(result.current.thinkingMode).toBe("low");
    expect(localStorage.getItem("thinkingMode-s1")).toBe("low");
  });

  it("normalizes unknown modes to default", () => {
    const { result } = renderHook(() => useChatComposerState(baseProps()));

    act(() => result.current.setThinkingMode("not-a-mode"));

    expect(result.current.thinkingMode).toBe("default");
  });

  it("does not persist modes for temporary sessions", () => {
    const props = baseProps({
      selectedSession: { id: "new-session-1" },
      currentSessionId: "new-session-1",
    });
    const { result } = renderHook(() => useChatComposerState(props));

    act(() => result.current.setThinkingMode("high"));

    expect(result.current.thinkingMode).toBe("high");
    expect(localStorage.getItem("thinkingMode-new-session-1")).toBeNull();
  });
});

describe("useChatComposerState wrapped setters", () => {
  it("accepts values and functional updaters for attached images", () => {
    const { result } = renderHook(() => useChatComposerState(baseProps()));
    const first = new File([new Uint8Array(1)], "one.png", { type: "image/png" });
    const second = new File([new Uint8Array(1)], "two.png", { type: "image/png" });

    act(() => result.current.setAttachedImages([first]));
    expect(result.current.attachedImages).toHaveLength(1);

    act(() => result.current.setAttachedImages(previous => [...previous, second]));
    expect(result.current.attachedImages.map(file => file.name)).toEqual(["one.png", "two.png"]);
  });
});

describe("useChatComposerState document references", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("adds a normalized reference and ignores duplicate ids", () => {
    const { result } = renderHook(() => useChatComposerState(baseProps()));

    act(() => {
      window.dispatchEvent(new CustomEvent(ADD_CONTENT_REFERENCE_EVENT, { detail: documentReference("ref-1") }));
    });
    expect(result.current.documentReferences).toHaveLength(1);
    expect(result.current.documentReferences[0].id).toBe("ref-1");
    expect(result.current.documentReferences[0].source.relativePath).toBe("docs/brief.pdf");

    act(() => {
      window.dispatchEvent(new CustomEvent(ADD_CONTENT_REFERENCE_EVENT, { detail: documentReference("ref-1") }));
    });
    expect(result.current.documentReferences).toHaveLength(1);
  });

  it("ignores malformed payloads", () => {
    const { result } = renderHook(() => useChatComposerState(baseProps()));

    act(() => {
      window.dispatchEvent(new CustomEvent(ADD_CONTENT_REFERENCE_EVENT, { detail: { foo: "bar" } }));
    });
    expect(result.current.documentReferences).toHaveLength(0);
  });

  it("removes a reference by id", () => {
    const { result } = renderHook(() => useChatComposerState(baseProps()));

    act(() => {
      window.dispatchEvent(new CustomEvent(ADD_CONTENT_REFERENCE_EVENT, { detail: documentReference("ref-1") }));
    });
    act(() => result.current.removeDocumentReference("ref-1"));

    expect(result.current.documentReferences).toHaveLength(0);
  });
});
