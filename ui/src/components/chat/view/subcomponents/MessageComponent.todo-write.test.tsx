// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types/types";
import MessageComponent from "./MessageComponent";

afterEach(() => {
  cleanup();
});

function renderToolMessage(message: ChatMessage) {
  return render(
    <MessageComponent
      message={message}
      prevMessage={null}
      createDiff={() => []}
      provider="sati"
      onShowSettings={() => {}}
    />,
  );
}

describe("MessageComponent todo_write rendering", () => {
  it("renders markdown checklist details for lowercase todo_write tool calls", () => {
    renderToolMessage({
      id: "todo-tool-1",
      type: "assistant",
      content: "",
      timestamp: "2026-05-18T08:00:00.000Z",
      isToolUse: true,
      toolName: "todo_write",
      toolId: "todo-tool-1",
      toolInput: {
        markdown: ["- [x] Create project directory structure", "- [ ] Implement game constants"].join("\n"),
      },
    });

    const summary = screen.getByText("Updating todo list").closest("summary");
    expect(summary).not.toBeNull();
    fireEvent.click(summary as HTMLElement);

    expect(screen.getByText("Create project directory structure")).toBeTruthy();
    expect(screen.getByText("Implement game constants")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText("in progress")).toBeTruthy();
  });

  it("renders TodoWrite success result message", () => {
    renderToolMessage({
      id: "todo-tool-2",
      type: "assistant",
      content: "",
      timestamp: "2026-05-18T08:00:00.000Z",
      isToolUse: true,
      toolName: "TodoWrite",
      toolId: "todo-tool-2",
      toolInput: {
        markdown: "- [ ] Create project directory structure",
      },
      toolResult: {
        isError: false,
        content: "Todo list updated",
      },
    });

    expect(screen.getAllByText("Todo list updated").length).toBeGreaterThan(0);
  });

  it("renders structured todos for todo_write calls", () => {
    renderToolMessage({
      id: "todo-tool-3",
      type: "assistant",
      content: "",
      timestamp: "2026-05-18T08:00:00.000Z",
      isToolUse: true,
      toolName: "todo_write",
      toolId: "todo-tool-3",
      toolInput: {
        todos: [
          { id: "t1", content: "Create project directory structure", status: "completed" },
          { id: "t2", content: "Implement game constants", status: "in_progress", priority: "high" },
          { id: "t3", content: "Run verification suite", status: "pending" },
        ],
      },
    });

    const summary = screen.getByText("Updating todo list").closest("summary");
    expect(summary).not.toBeNull();
    fireEvent.click(summary as HTMLElement);

    expect(screen.getByText("Create project directory structure")).toBeTruthy();
    expect(screen.getByText("Implement game constants")).toBeTruthy();
    expect(screen.getByText("Run verification suite")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText("in progress")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
  });

  it("falls back to markdown parsing when structured todos is empty", () => {
    renderToolMessage({
      id: "todo-tool-4",
      type: "assistant",
      content: "",
      timestamp: "2026-05-18T08:00:00.000Z",
      isToolUse: true,
      toolName: "todo_write",
      toolId: "todo-tool-4",
      toolInput: {
        todos: [],
        markdown: "- [x] Create project directory structure",
      },
    });

    const summary = screen.getByText("Updating todo list").closest("summary");
    expect(summary).not.toBeNull();
    fireEvent.click(summary as HTMLElement);

    expect(screen.getByText("Create project directory structure")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
  });
});
