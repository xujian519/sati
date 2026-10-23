// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { TFunction } from "i18next";
import type { ChatMessage } from "../../chat/types/types";
import { MessageHeaderRow } from "../../chat/view/subcomponents/MessageHeaderRow";
import { resolveHeaderTypeLabel } from "../../chat/view/subcomponents/messageHeaderLabel";
import { TaskNotificationRow } from "../../chat/view/subcomponents/TaskNotificationRow";
import { AssistantMessageRow } from "./AssistantMessageRow";
import { ErrorMessageRow } from "./ErrorMessageRow";
import { hasAssistantBody } from "./messageRowVisibility";
import { UserMessageRow } from "./UserMessageRow";

afterEach(() => {
  cleanup();
});

/** 最小 i18n 桩：返回 defaultValue，足以断言渲染文本。 */
const t = ((key: string, options?: Record<string, unknown>) =>
  String(options?.defaultValue ?? key)) as TFunction<"chat">;

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "u-1",
    entryId: "e-1",
    type: "user",
    content: "hello",
    timestamp: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("ErrorMessageRow", () => {
  it("renders the error banner content", () => {
    const { container } = render(<ErrorMessageRow formattedContent="model unavailable" selectedProject={null} />);

    expect(container.textContent).toContain("model unavailable");
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".text-red-500")).not.toBeNull();
  });
});

describe("TaskNotificationRow", () => {
  it("renders task content, status, id and timestamp", () => {
    const { container } = render(
      <TaskNotificationRow
        messageContent="background job finished"
        formattedTime="10:30:00"
        taskStatus="completed"
        taskId="task-42"
      />,
    );

    expect(screen.getByText("background job finished")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText("task-42")).toBeTruthy();
    expect(screen.getByText("10:30:00")).toBeTruthy();
    expect(container.querySelector(".bg-green-500")).not.toBeNull();
  });

  it("falls back to the amber dot for unknown statuses", () => {
    const { container } = render(
      <TaskNotificationRow messageContent="pending" formattedTime="10:30:00" taskStatus="paused" />,
    );

    expect(container.querySelector(".bg-amber-500")).not.toBeNull();
  });
});

describe("MessageHeaderRow", () => {
  it("renders the tool and error header glyphs", () => {
    const { rerender } = render(<MessageHeaderRow messageType="tool" provider="sati" t={t} />);
    expect(screen.getByText("messageTypes.tool")).toBeTruthy();
    expect(screen.getByText("🔧")).toBeTruthy();

    rerender(<MessageHeaderRow messageType="error" provider="sati" t={t} />);
    expect(screen.getByText("messageTypes.error")).toBeTruthy();
    expect(screen.getByText("!")).toBeTruthy();
  });

  it("maps message types and providers to header labels", () => {
    expect(resolveHeaderTypeLabel(t, "error", "sati")).toBe("messageTypes.error");
    expect(resolveHeaderTypeLabel(t, "tool", "sati")).toBe("messageTypes.tool");
    expect(resolveHeaderTypeLabel(t, "assistant", "cursor")).toBe("messageTypes.cursor");
    expect(resolveHeaderTypeLabel(t, "assistant", "codex")).toBe("messageTypes.codex");
    expect(resolveHeaderTypeLabel(t, "assistant", "gemini")).toBe("messageTypes.gemini");
    expect(resolveHeaderTypeLabel(t, "assistant", "sati")).toBe("messageTypes.sati");
  });
});

describe("hasAssistantBody", () => {
  it("treats whitespace-only content as empty", () => {
    const message = userMessage({ type: "assistant", content: "" });
    expect(hasAssistantBody(message, "")).toBe(false);
    expect(hasAssistantBody(message, "   \n ")).toBe(false);
  });

  it("keeps streaming cursors and artifacts visible", () => {
    const streaming = userMessage({ type: "assistant", content: "", isStreaming: true });
    expect(hasAssistantBody(streaming, "")).toBe(true);

    const withArtifact = userMessage({ type: "assistant", content: "", artifacts: [] });
    expect(hasAssistantBody(withArtifact, "")).toBe(false);
    const artifact = {
      id: "artifact-1",
      name: "a.md",
      path: "a.md",
      operation: "created" as const,
      source: "tool" as const,
      status: "complete" as const,
      size: 12,
      sha256: "0".repeat(64),
      createdAt: "2026-10-23T00:00:00.000Z",
    };
    expect(hasAssistantBody({ ...withArtifact, artifacts: [artifact] }, "")).toBe(true);

    expect(hasAssistantBody(userMessage({ type: "assistant", content: "hello" }), "hello")).toBe(true);
  });
});

describe("UserMessageRow", () => {
  function renderUser(overrides: Partial<ComponentProps<typeof UserMessageRow>> = {}) {
    return render(
      <UserMessageRow
        message={userMessage({ content: "first prompt" })}
        formattedContent="first prompt"
        messageImages={[]}
        documentReferenceAttachments={[]}
        fileAttachments={[]}
        selectedProject={null}
        forkCarriedMessageCount={2}
        forkDisabled={false}
        hasForkUnsupportedContent={false}
        isLastUserMessage
        t={t}
        {...overrides}
      />,
    );
  }

  it("shows fork and edit actions for the last user message", () => {
    const onFork = vi.fn();
    const onEdit = vi.fn();
    renderUser({ onFork, onEditLastUserMessage: onEdit });

    expect(screen.getByText("first prompt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fork from here · carries 2 messages" }));
    expect(onFork).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("disables fork and hides edit when the message carries unsupported content", () => {
    renderUser({ onFork: vi.fn(), onEditLastUserMessage: vi.fn(), hasForkUnsupportedContent: true });

    const fork = screen.getByRole("button", { name: /Forking messages with attachments/ });
    expect((fork as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
  });
});

describe("AssistantMessageRow", () => {
  const assistant = userMessage({ id: "a-1", type: "assistant", content: "answer" });

  it("renders prose and hides actions when disabled", () => {
    render(
      <AssistantMessageRow
        message={assistant}
        hasBody
        linkedContentDisplayText="answer"
        contentDisplayText="answer"
        formattedContent="answer"
        selectedProject={null}
        forkCarriedMessageCount={0}
        forkDisabled={false}
        isLastAssistantMessage
        showAssistantActions={false}
        t={t}
      />,
    );

    expect(screen.getByText("answer")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("offers regenerate and fork for the last assistant message", () => {
    const onRegenerate = vi.fn();
    const onFork = vi.fn();
    render(
      <AssistantMessageRow
        message={assistant}
        hasBody
        linkedContentDisplayText="answer"
        contentDisplayText="answer"
        formattedContent="answer"
        selectedProject={null}
        onFork={onFork}
        forkCarriedMessageCount={0}
        forkDisabled={false}
        isSessionRunning={false}
        onRegenerateLastTurn={onRegenerate}
        isLastAssistantMessage
        t={t}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Fork from here · carries 0 messages" }));
    expect(onFork).toHaveBeenCalledTimes(1);
  });

  it("returns null when the parent says there is no body", () => {
    const { container } = render(
      <AssistantMessageRow
        message={assistant}
        hasBody={false}
        linkedContentDisplayText=""
        contentDisplayText=""
        formattedContent=""
        selectedProject={null}
        forkCarriedMessageCount={0}
        forkDisabled={false}
        isLastAssistantMessage={false}
        t={t}
      />,
    );

    expect(container.innerHTML).toBe("");
  });
});
