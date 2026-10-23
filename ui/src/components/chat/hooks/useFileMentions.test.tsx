import { act, renderHook, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../types/app";
import { ADD_WORKSPACE_FILE_MENTION_EVENT } from "../../../utils/workspaceFileMention";
import { useFileMentions } from "./useFileMentions";

const { getFilesMock } = vi.hoisted(() => ({
  getFilesMock: vi.fn(),
}));

vi.mock("../../../utils/api", () => ({
  api: {
    getFiles: getFilesMock,
  },
}));

const project = {
  name: "project-a",
  displayName: "Project A",
  fullPath: "/workspace/project-a",
} as Project;

const textareaRef = { current: null } as RefObject<HTMLTextAreaElement | null>;

describe("useFileMentions conversation scope", () => {
  beforeEach(() => {
    getFilesMock.mockReset();
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [],
    });
  });

  it("does not reuse the previous conversation cursor for an external mention", () => {
    const setInput = vi.fn();
    const { result, rerender } = renderHook(
      (props: { mentionScopeKey: string; input: string }) =>
        useFileMentions({
          selectedProject: project,
          mentionScopeKey: props.mentionScopeKey,
          input: props.input,
          setInput,
          textareaRef,
        }),
      {
        initialProps: {
          mentionScopeKey: "draft_input_project-a:session-a",
          input: "abcdef",
        },
      },
    );

    act(() => result.current.setCursorPosition(2));
    rerender({
      mentionScopeKey: "draft_input_project-a:session-b",
      input: "xyz",
    });
    setInput.mockClear();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(ADD_WORKSPACE_FILE_MENTION_EVENT, {
          detail: {
            projectName: project.name,
            relativePath: "docs/report.docx",
          },
        }),
      );
    });

    expect(setInput).toHaveBeenCalledWith("xyz docs/report.docx ");
  });

  it("flattens the project tree and filters mentions case-insensitively", async () => {
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [
        {
          name: "docs",
          type: "directory",
          children: [
            { name: "report.pdf", type: "file", path: "docs/report.pdf" },
            {
              name: "notes",
              type: "directory",
              children: [{ name: "todo.md", type: "file", path: "docs/notes/todo.md" }],
            },
          ],
        },
        { name: "README.md", type: "file", path: "README.md" },
      ],
    });

    const setInput = vi.fn();
    const { result, rerender } = renderHook(
      (props: { input: string }) =>
        useFileMentions({
          selectedProject: project,
          mentionScopeKey: "draft_input_project-a:session-a",
          input: props.input,
          setInput,
          textareaRef,
        }),
      { initialProps: { input: "" } },
    );

    await waitFor(() => expect(getFilesMock).toHaveBeenCalledTimes(1));
    rerender({ input: "@REPORT" });
    act(() => result.current.setCursorPosition(7));

    await waitFor(() => expect(result.current.showFileDropdown).toBe(true));
    expect(result.current.filteredFiles).toEqual([
      { name: "report.pdf", path: "docs/report.pdf", relativePath: "docs/report.pdf" },
    ]);
  });

  it("refreshes the file list only when the dropdown reopens", async () => {
    const setInput = vi.fn();
    const { result, rerender } = renderHook(
      (props: { input: string }) =>
        useFileMentions({
          selectedProject: project,
          mentionScopeKey: "draft_input_project-a:session-a",
          input: props.input,
          setInput,
          textareaRef,
        }),
      { initialProps: { input: "" } },
    );

    await waitFor(() => expect(getFilesMock).toHaveBeenCalledTimes(1));

    rerender({ input: "@" });
    act(() => result.current.setCursorPosition(1));
    await waitFor(() => expect(result.current.showFileDropdown).toBe(true));
    await waitFor(() => expect(getFilesMock).toHaveBeenCalledTimes(2));

    rerender({ input: "@r" });
    act(() => result.current.setCursorPosition(2));
    expect(getFilesMock).toHaveBeenCalledTimes(2);
  });

  it("inserts the selected file and closes the dropdown", async () => {
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [{ name: "report.pdf", type: "file", path: "docs/report.pdf" }],
    });

    const setInput = vi.fn();
    const { result, rerender } = renderHook(
      (props: { input: string }) =>
        useFileMentions({
          selectedProject: project,
          mentionScopeKey: "draft_input_project-a:session-a",
          input: props.input,
          setInput,
          textareaRef,
        }),
      { initialProps: { input: "" } },
    );

    rerender({ input: "@rep" });
    act(() => result.current.setCursorPosition(4));
    await waitFor(() => expect(result.current.filteredFiles).toHaveLength(1));

    act(() => result.current.selectFile(result.current.filteredFiles[0]));

    expect(setInput).toHaveBeenCalledWith("report.pdf ");
    // The parent applies the new input; once the "@" query is gone the dropdown stays closed.
    rerender({ input: "report.pdf " });
    await waitFor(() => expect(result.current.showFileDropdown).toBe(false));
  });

  it("moves the selection with arrow keys and picks it with Tab", async () => {
    getFilesMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { name: "alpha.md", type: "file", path: "alpha.md" },
        { name: "beta.md", type: "file", path: "beta.md" },
      ],
    });

    const setInput = vi.fn();
    const { result, rerender } = renderHook(
      (props: { input: string }) =>
        useFileMentions({
          selectedProject: project,
          mentionScopeKey: "draft_input_project-a:session-a",
          input: props.input,
          setInput,
          textareaRef,
        }),
      { initialProps: { input: "" } },
    );

    rerender({ input: "@" });
    act(() => result.current.setCursorPosition(1));
    await waitFor(() => expect(result.current.filteredFiles).toHaveLength(2));

    const preventDefault = vi.fn();
    act(() => {
      result.current.handleFileMentionsKeyDown({ key: "ArrowDown", preventDefault });
    });
    expect(result.current.selectedFileIndex).toBe(0);
    expect(preventDefault).toHaveBeenCalledOnce();

    act(() => {
      result.current.handleFileMentionsKeyDown({ key: "Tab", preventDefault });
    });
    expect(setInput).toHaveBeenCalledWith("alpha.md ");
  });

  it("ignores external mentions addressed to another project", async () => {
    const setInput = vi.fn();
    renderHook(() =>
      useFileMentions({
        selectedProject: project,
        mentionScopeKey: "draft_input_project-a:session-a",
        input: "",
        setInput,
        textareaRef,
      }),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(ADD_WORKSPACE_FILE_MENTION_EVENT, {
          detail: { projectName: "project-b", relativePath: "docs/report.docx" },
        }),
      );
    });

    expect(setInput).not.toHaveBeenCalled();
  });

  it("deletes a highlighted file mention as one token with Backspace", () => {
    const setInput = vi.fn();
    const textarea = document.createElement("textarea");
    const localTextareaRef = { current: textarea } as RefObject<HTMLTextAreaElement>;
    const { result, rerender } = renderHook(
      (props: { input: string }) =>
        useFileMentions({
          selectedProject: project,
          mentionScopeKey: "draft_input_project-a:session-a",
          input: props.input,
          setInput,
          textareaRef: localTextareaRef,
        }),
      { initialProps: { input: "" } },
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(ADD_WORKSPACE_FILE_MENTION_EVENT, {
          detail: { projectName: project.name, relativePath: "docs/report.docx" },
        }),
      );
    });
    const inserted = "docs/report.docx ";
    rerender({ input: inserted });
    textarea.value = inserted;
    textarea.selectionStart = inserted.length;
    textarea.selectionEnd = inserted.length;
    setInput.mockClear();

    const preventDefault = vi.fn();
    act(() => {
      result.current.handleFileMentionsKeyDown({ key: "Backspace", preventDefault });
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(setInput).toHaveBeenCalledWith("");
  });
});
