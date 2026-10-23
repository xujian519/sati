// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PendingApproval, PendingPermissionRequest } from "../chat/types/types";
import type { ThinkingModeId } from "../chat/constants/thinkingModes";
import type { ThinkingModeAvailability } from "../chat/constants/thinkingModeAvailability";
import { MAX_ATTACHMENTS_ERROR_KEY } from "../chat/hooks/useAttachmentUpload";
import ComposerV2, { type ComposerV2Props } from "./ComposerV2";

vi.mock("../chat/view/subcomponents/CommandMenu", () => ({
  default: ({ isOpen, commands }: { isOpen: boolean; commands: { name: string }[] }) =>
    isOpen
      ? React.createElement("div", { "data-testid": "command-menu" }, commands.map(command => command.name).join(","))
      : null,
}));

vi.mock("../chat/view/subcomponents/PermissionRequestsBanner", () => ({
  default: ({ pendingPermissionRequests }: { pendingPermissionRequests: unknown[] }) =>
    React.createElement(
      "div",
      { "data-testid": "permission-banner" },
      `permissions:${pendingPermissionRequests.length}`,
    ),
}));

vi.mock("../chat/view/subcomponents/ApprovalRequestsBanner", () => ({
  default: ({ pendingApprovals }: { pendingApprovals: unknown[] }) =>
    React.createElement("div", { "data-testid": "approval-banner" }, `approvals:${pendingApprovals.length}`),
}));

vi.mock("../chat/view/subcomponents/ImageAttachment", () => ({
  default: ({ file, onRemove }: { file: File; onRemove: () => void }) =>
    React.createElement("button", { type: "button", onClick: onRemove }, `image:${file.name}`),
}));

vi.mock("./DocumentReferenceChip", () => ({
  default: ({ reference, onRemove }: { reference: { id: string }; onRemove?: () => void }) =>
    React.createElement("button", { type: "button", onClick: onRemove }, `ref:${reference.id}`),
}));

const THINKING_MODE_IDS: ThinkingModeId[] = ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

function makeThinkingAvailability(): ThinkingModeAvailability {
  return Object.fromEntries(THINKING_MODE_IDS.map(id => [id, null])) as ThinkingModeAvailability;
}

function makeProps(overrides: Partial<ComposerV2Props> = {}): ComposerV2Props {
  return {
    input: "",
    placeholder: "Type a message",
    textareaRef: React.createRef<HTMLTextAreaElement>(),
    inputHighlightRef: React.createRef<HTMLDivElement>(),
    renderInputWithMentions: text => text,
    onInputChange: () => {},
    onTextareaClick: () => {},
    onTextareaKeyDown: () => {},
    onTextareaPaste: () => {},
    onTextareaScrollSync: () => {},
    onTextareaInput: () => {},
    onSubmit: () => {},
    onAbortSession: () => {},
    openImagePicker: () => {},
    attachedImages: [],
    onRemoveImage: () => {},
    documentReferences: [],
    onRemoveDocumentReference: () => {},
    uploadingImages: new Map(),
    imageErrors: new Map(),
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: 0,
    onSelectFile: () => {},
    filteredCommands: [],
    selectedCommandIndex: 0,
    onCommandSelect: () => {},
    onCloseCommandMenu: () => {},
    isCommandMenuOpen: false,
    frequentCommands: [],
    onToggleCommandMenu: () => {},
    onInsertMention: () => {},
    onInsertSlash: () => {},
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    thinkingMode: "default",
    thinkingModeAvailability: makeThinkingAvailability(),
    onThinkingModeChange: () => {},
    pendingPermissionRequests: [],
    handlePermissionDecision: () => {},
    handleGrantToolPermission: () => ({ success: true }),
    pendingApprovals: [],
    handleApprovalDecision: () => {},
    permissionMode: "default",
    onPermissionModeChange: () => {},
    runMode: "agent",
    onRunModeChange: () => {},
    ...overrides,
  };
}

function renderComposer(overrides: Partial<ComposerV2Props> = {}) {
  const props = makeProps(overrides);
  const view = render(<ComposerV2 {...props} />);
  return { props, view };
}

describe("ComposerV2 send and abort controls", () => {
  it("disables send for an empty draft and enables it once there is content", () => {
    const { view } = renderComposer();
    const sendButton = screen.getByTitle("Send") as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);

    view.rerender(<ComposerV2 {...makeProps({ input: "hello" })} />);
    expect((screen.getByTitle("Send") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the abort control when idle and abortable, and keeps send for a non-empty draft", () => {
    const { view } = renderComposer({ isLoading: true, canAbortSession: true });
    expect(screen.getByTitle("Stop")).toBeTruthy();

    view.rerender(<ComposerV2 {...makeProps({ input: "draft", isLoading: true, canAbortSession: true })} />);
    expect(screen.queryByTitle("Stop")).toBeNull();
    expect(screen.getByTitle("Queue message")).toBeTruthy();
  });

  it("switches the send title for pending, queued and confirmed queue states", () => {
    const { view } = renderComposer({ input: "draft", isSubmitPending: true });
    expect((screen.getByTitle("Sending...") as HTMLButtonElement).disabled).toBe(true);

    view.rerender(<ComposerV2 {...makeProps({ input: "draft", isBusySendQueued: true })} />);
    expect(screen.getByTitle("Queued — click send again to stop this turn and send now")).toBeTruthy();

    view.rerender(<ComposerV2 {...makeProps({ input: "draft", isBusySendQueued: true, isBusySendConfirmed: true })} />);
    expect(screen.getByTitle("Stopping current turn — sending next message")).toBeTruthy();
  });

  it("submits the form through onSubmit", () => {
    const onSubmit = vi.fn();
    renderComposer({ onSubmit });
    const textarea = screen.getByPlaceholderText("Type a message");
    fireEvent.submit(textarea.closest("form") as HTMLFormElement);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("ComposerV2 menus", () => {
  it("opens the run mode menu and reports the selected mode", () => {
    const onRunModeChange = vi.fn();
    renderComposer({ onRunModeChange });

    fireEvent.click(screen.getByTitle("Select run mode"));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getAllByText("Agent").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(within(screen.getByRole("menu")).getByText("Plan"));
    expect(onRunModeChange).toHaveBeenCalledWith("plan");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("disables plan mode when unavailable and explains why", () => {
    renderComposer({ planModeAvailable: false });
    fireEvent.click(screen.getByTitle("Select run mode"));

    const planOption = screen.getByText("Plan").closest("button") as HTMLButtonElement;
    expect(planOption.disabled).toBe(true);
    expect(screen.getByText("Plan mode is only available for Anthropic models.")).toBeTruthy();
  });

  it("opens the permission menu, reports a selection and disables the selector in plan mode", () => {
    const onPermissionModeChange = vi.fn();
    const { view } = renderComposer({ onPermissionModeChange });

    fireEvent.click(screen.getByTitle("Select permission mode"));
    expect(screen.getByText("Full Access")).toBeTruthy();

    fireEvent.click(screen.getByText("Full Access"));
    expect(onPermissionModeChange).toHaveBeenCalledWith("bypassPermissions");
    expect(screen.queryByRole("menu")).toBeNull();

    view.rerender(<ComposerV2 {...makeProps({ permissionMode: "bypassPermissions", runMode: "plan" })} />);
    expect((screen.getByTitle("Select permission mode") as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes an open permission menu when switching to plan mode", () => {
    const { view } = renderComposer();
    fireEvent.click(screen.getByTitle("Select permission mode"));
    expect(screen.getByRole("menu")).toBeTruthy();

    view.rerender(<ComposerV2 {...makeProps({ runMode: "plan" })} />);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the thinking menu, disables unavailable modes and reports a selection", () => {
    const onThinkingModeChange = vi.fn();
    const availability = makeThinkingAvailability();
    availability.medium = "Unsupported by this model.";
    renderComposer({ onThinkingModeChange, thinkingModeAvailability: availability });

    fireEvent.click(screen.getByTitle("Select thinking strength"));
    expect((screen.getByText("Medium").closest("button") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText("High"));
    expect(onThinkingModeChange).toHaveBeenCalledWith("high");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("ComposerV2 context indicator", () => {
  it("shows an unknown state before any token budget is reported", () => {
    renderComposer();
    const trigger = screen.getByLabelText("Context usage unknown. It will appear after the next model response.");
    expect(trigger.textContent).toContain("--");

    fireEvent.click(trigger);
    expect(screen.getByRole("status").textContent).toContain(
      "No token budget has been reported yet. It will appear after the next model response.",
    );
  });

  it("shows usage, fixed overhead and conversation slices for a known budget", () => {
    renderComposer({ tokenBudget: { used: 50000, total: 100000, fixedOverheadTokens: 10000 } });
    const trigger = screen.getByLabelText("50% used. 50.0k tokens used out of 100k. Auto compact runs near the limit.");
    expect(trigger.textContent).toContain("50%");

    fireEvent.click(trigger);
    const popover = screen.getByRole("status");
    expect(popover.textContent).toContain("50,000 tokens used out of 100,000.");
    expect(popover.textContent).toContain("Prompt & tools (fixed)");
    expect(popover.textContent).toContain("Conversation");
  });

  it("surfaces the blocking copy when the server reports blocking state", () => {
    renderComposer({ tokenBudget: { used: 96000, total: 100000, state: "blocking" } });
    const trigger = screen.getByLabelText(
      "96% used. 96.0k tokens used out of 100k. Auto compact ran, but the context is still over the limit.",
    );

    fireEvent.click(trigger);
    expect(screen.getByRole("status").textContent).toContain(
      "Compaction ran, but the context is still over the limit.",
    );
  });
});

describe("ComposerV2 banners and attachments", () => {
  it("hides the composer form while a blocking permission request is pending", () => {
    const pendingPermissionRequests: PendingPermissionRequest[] = [{ requestId: "req-1", toolName: "AskUserQuestion" }];
    renderComposer({ pendingPermissionRequests });

    expect(screen.getByTestId("permission-banner").textContent).toBe("permissions:1");
    expect(screen.queryByPlaceholderText("Type a message")).toBeNull();
  });

  it("renders the approval banner without hiding the composer", () => {
    const pendingApprovals: PendingApproval[] = [{ pendingIndex: 1, textPreview: "x", triggerKeyword: "y" }];
    renderComposer({ pendingApprovals });

    expect(screen.getByTestId("approval-banner").textContent).toBe("approvals:1");
    expect(screen.getByPlaceholderText("Type a message")).toBeTruthy();
  });

  it("renders attachment chips, the limit error and removes by index", () => {
    const onRemoveImage = vi.fn();
    const image = new File(["x"], "shot.png", { type: "image/png" });
    renderComposer({
      attachedImages: [image],
      onRemoveImage,
      imageErrors: new Map([[MAX_ATTACHMENTS_ERROR_KEY, "Too many attachments"]]),
    });

    expect(screen.getByText("Too many attachments")).toBeTruthy();
    fireEvent.click(screen.getByText("image:shot.png"));
    expect(onRemoveImage).toHaveBeenCalledWith(0);
  });

  it("renders the busy-send banner with steer and cancel actions", () => {
    const onSteerBusySendQueue = vi.fn();
    const onCancelBusySendQueue = vi.fn();
    renderComposer({
      input: "draft",
      isBusySendQueued: true,
      canSteerBusySend: true,
      onSteerBusySendQueue,
      onCancelBusySendQueue,
    });

    expect(screen.getByText("Queued; click again to stop this turn and send now")).toBeTruthy();
    fireEvent.click(screen.getByText("Steer"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(onSteerBusySendQueue).toHaveBeenCalledTimes(1);
    expect(onCancelBusySendQueue).toHaveBeenCalledTimes(1);
  });

  it("renders file suggestions and the command menu when requested", () => {
    const onSelectFile = vi.fn();
    renderComposer({
      showFileDropdown: true,
      filteredFiles: [{ name: "a.ts", path: "src/a.ts" }],
      onSelectFile,
      isCommandMenuOpen: true,
      filteredCommands: [{ name: "/review" }],
    });

    expect(screen.getByTestId("command-menu").textContent).toBe("/review");
    fireEvent.click(screen.getByText("a.ts"));
    expect(onSelectFile).toHaveBeenCalledWith({ name: "a.ts", path: "src/a.ts" });
  });
});
