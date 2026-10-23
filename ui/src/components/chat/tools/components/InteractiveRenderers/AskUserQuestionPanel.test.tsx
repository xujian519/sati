// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskUserQuestionPanel } from "./AskUserQuestionPanel";

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    return window.setTimeout(() => callback(performance.now()), 0);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function panelRequest(questions: unknown[]) {
  return { requestId: "request-1", toolName: "AskUserQuestion", input: { questions } };
}

describe("AskUserQuestionPanel selection", () => {
  it("submits a single selected option", () => {
    const onDecision = vi.fn();
    render(
      <AskUserQuestionPanel
        request={panelRequest([
          {
            question: "Choose a path",
            options: [{ label: "Default" }, { label: "Advanced" }],
          },
        ])}
        onDecision={onDecision}
      />,
    );

    fireEvent.click(screen.getByText("Advanced"));
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    expect(onDecision).toHaveBeenCalledWith("request-1", {
      allow: true,
      updatedInput: { questions: expect.any(Array), answers: { "Choose a path": "Advanced" } },
    });
  });

  it("joins every selected option for multi-select questions", () => {
    const onDecision = vi.fn();
    render(
      <AskUserQuestionPanel
        request={panelRequest([
          {
            question: "Pick features",
            multiSelect: true,
            options: [{ label: "Fast" }, { label: "Safe" }],
          },
        ])}
        onDecision={onDecision}
      />,
    );

    fireEvent.click(screen.getByText("Fast"));
    fireEvent.click(screen.getByText("Safe"));
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    expect(onDecision).toHaveBeenCalledWith(
      "request-1",
      expect.objectContaining({
        updatedInput: expect.objectContaining({ answers: { "Pick features": "Fast, Safe" } }),
      }),
    );
  });

  it("advances and goes back across multiple questions", () => {
    const onDecision = vi.fn();
    render(
      <AskUserQuestionPanel
        request={panelRequest([
          { question: "First?", options: [{ label: "One" }] },
          { question: "Second?", options: [{ label: "Two" }] },
        ])}
        onDecision={onDecision}
      />,
    );

    expect(screen.getByText("First?")).toBeTruthy();
    fireEvent.click(screen.getByText("One"));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    expect(screen.getByText("Second?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByText("First?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getByText("Two"));
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    expect(onDecision).toHaveBeenCalledWith(
      "request-1",
      expect.objectContaining({
        updatedInput: expect.objectContaining({ answers: { "First?": "One", "Second?": "Two" } }),
      }),
    );
  });

  it("skips every question with an empty answer set", () => {
    const onDecision = vi.fn();
    render(
      <AskUserQuestionPanel
        request={panelRequest([{ question: "First?", options: [{ label: "One" }] }])}
        onDecision={onDecision}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Skip/ }));

    expect(onDecision).toHaveBeenCalledWith(
      "request-1",
      expect.objectContaining({ updatedInput: expect.objectContaining({ answers: {} }) }),
    );
  });

  it("selects and submits with number and Enter keys", () => {
    const onDecision = vi.fn();
    const { container } = render(
      <AskUserQuestionPanel
        request={panelRequest([{ question: "Choose", options: [{ label: "First" }, { label: "Second" }] }])}
        onDecision={onDecision}
      />,
    );

    const root = container.firstElementChild as HTMLElement;
    fireEvent.keyDown(root, { key: "2" });
    fireEvent.keyDown(root, { key: "Enter" });

    expect(onDecision).toHaveBeenCalledWith(
      "request-1",
      expect.objectContaining({ updatedInput: expect.objectContaining({ answers: { Choose: "Second" } }) }),
    );
  });

  it("renders nothing when every question is malformed", () => {
    const { container } = render(
      <AskUserQuestionPanel request={panelRequest([{ header: "missing text" }, null])} onDecision={vi.fn()} />,
    );

    expect(container.firstChild).toBeNull();
  });
});

describe("AskUserQuestionPanel IME behavior", () => {
  it("does not submit the Other input when Enter confirms IME composition", () => {
    const onDecision = vi.fn();
    const request = {
      requestId: "request-1",
      toolName: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Choose a path",
            options: [{ label: "Default", description: "Use the default path" }],
          },
        ],
      },
    };

    render(<AskUserQuestionPanel request={request} onDecision={onDecision} />);

    fireEvent.click(screen.getByText("Other..."));
    const otherInput = screen.getByPlaceholderText("Type your answer...");
    fireEvent.change(otherInput, { target: { value: "nihao" } });

    fireEvent.keyDown(otherInput, {
      key: "Enter",
      code: "Enter",
      keyCode: 229,
      which: 229,
    });
    expect(onDecision).not.toHaveBeenCalled();

    fireEvent.keyDown(otherInput, {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
    });

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith(
      "request-1",
      expect.objectContaining({
        allow: true,
        updatedInput: expect.objectContaining({
          answers: { "Choose a path": "nihao" },
        }),
      }),
    );
  });
});
