// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DocxBuiltinPreview from "./DocxBuiltinPreview";

const renderAsyncMock = vi.hoisted(() =>
  vi.fn(async (_blob: Blob, bodyContainer: HTMLElement) => {
    const wrapper = document.createElement("div");
    wrapper.className = "sati-docx-wrapper";
    const page = document.createElement("section");
    page.className = "sati-docx";
    page.textContent = "Document body";
    wrapper.append(page);
    bodyContainer.append(wrapper);
  }),
);

vi.mock("docx-preview", () => ({
  renderAsync: renderAsyncMock,
}));

afterEach(() => {
  cleanup();
  renderAsyncMock.mockClear();
});

describe("DocxBuiltinPreview", () => {
  it("does not rebuild the document when callback props change", async () => {
    const blob = new Blob(["docx-data"]);
    const props = {
      blob,
      fileName: "report.docx",
      filePath: "report.docx",
      onError: vi.fn(),
    };
    const { rerender } = render(<DocxBuiltinPreview {...props} />);

    await waitFor(() => {
      expect(renderAsyncMock).toHaveBeenCalledTimes(1);
    });

    rerender(<DocxBuiltinPreview {...props} onError={vi.fn()} />);

    await Promise.resolve();
    expect(renderAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("starts with the outline collapsed so it does not squeeze the page body", async () => {
    renderAsyncMock.mockImplementationOnce(async (_blob: Blob, bodyContainer: HTMLElement) => {
      const wrapper = document.createElement("div");
      wrapper.className = "sati-docx-wrapper";
      const page = document.createElement("section");
      page.className = "sati-docx";
      const heading = document.createElement("h1");
      heading.textContent = "Chapter One";
      page.append(heading);
      wrapper.append(page);
      bodyContainer.append(wrapper);
    });

    render(
      <DocxBuiltinPreview
        blob={new Blob(["docx-data"])}
        fileName="report.docx"
        filePath="report.docx"
        onError={vi.fn()}
      />,
    );

    // 标题已进正文（h1），大纲面板默认折叠——面板条目以 button 渲染，正文标题不是。
    await waitFor(() => expect(document.querySelector("h1")).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Chapter One" })).toBeNull();
  });
});
