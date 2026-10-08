// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HtmlDocumentPreview from "./HtmlDocumentPreview";

// 标注模式会读源与挂消息监听：这里只需要它不触网、可渲染。
vi.mock("../../../../utils/api", () => ({
  api: {
    readFileBlob: vi.fn(() => new Promise(() => {})),
    readFile: vi.fn(() => new Promise(() => {})),
    saveFile: vi.fn(() => new Promise(() => {})),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// jsdom 没有 ResizeObserver（标注面的自适应测量依赖它）。
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

afterEach(cleanup);

describe("HtmlDocumentPreview", () => {
  it("renders remote project HTML in an isolated sandbox", () => {
    render(<HtmlDocumentPreview url="/preview/index.html" title="Preview: index.html" />);

    const frame = screen.getByTitle("Preview: index.html");
    expect(frame.getAttribute("src")).toBe("/preview/index.html");
    expect(frame.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });

  it("disables the annotate tab without project context", () => {
    render(<HtmlDocumentPreview url="/preview/index.html" title="Preview: index.html" />);

    expect(screen.getByRole("button", { name: "annotator.view" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "annotator.annotate" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("switches to the annotate face with a stricter sandbox and waits for the snapshot", () => {
    render(
      <HtmlDocumentPreview
        url="/preview/index.html?token=t"
        title="Preview: index.html"
        projectName="demo"
        filePath="index.html"
        fileName="index.html"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "annotator.annotate" }));

    const frame = screen.getByTitle("Annotate: Preview: index.html");
    const src = frame.getAttribute("src") ?? "";
    expect(src.startsWith("/preview/index.html?token=t&annotate=1&sati_nonce=")).toBe(true);
    // nonce 由父页随机生成（24 位 hex），经 URL 注入桥接。
    expect(src.split("sati_nonce=")[1] ?? "").toMatch(/^[0-9a-f]{24}$/);
    // 标注模式收紧：只留 allow-scripts。
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    // 快照未到时如实提示"测量中"，并且不渲染查看用的那张 iframe。
    expect(screen.getByText("annotator.htmlWaiting")).toBeTruthy();
    expect(screen.queryByTitle("Preview: index.html")).toBeNull();
  });
});
