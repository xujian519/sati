// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFigureAnnotationDocument, type FigureAnnotationDocument } from "../../../types/annotationReference";
import FigureAnnotator from "./FigureAnnotator";

const WIDTH = 100;
const HEIGHT = 50;

const FIGURE = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <g id="n-n1" data-ref="1"><rect x="10" y="10" width="20" height="10" fill="none"/></g>
</svg>`;

/** 已保存的标注（本测试只用它是否被灌入来判断竞态）。 */
function savedDocument(): FigureAnnotationDocument {
  return buildFigureAnnotationDocument({
    figure: {
      path: "/w/project/figures/inv-fig1.svg",
      relativePath: "figures/inv-fig1.svg",
      mediaType: "image/svg+xml",
      width: WIDTH,
      height: HEIGHT,
      sha256: "b".repeat(64),
    },
    marks: [{ id: "s1", kind: "text", color: "#2f9e44", points: [[5, 20]], text: "保存过的说明" }],
  });
}

/** 由测试控制何时返回的 sidecar 读回。 */
let settleRead: ((value: FigureAnnotationDocument | null) => void) | null = null;
const readFigureAnnotation = vi.fn(
  () =>
    new Promise<FigureAnnotationDocument | null>(resolve => {
      settleRead = resolve;
    }),
);

vi.mock("../utils/sidecar", () => ({
  readFigureAnnotation: () => readFigureAnnotation(),
  saveFigureAnnotation: () => Promise.resolve("/w/project/figures/inv-fig1.annot.json"),
}));

vi.mock("../../code-editor/view/binary-file/hooks/use-file-blob", () => ({
  useFileBlob: () => ({ blob: new Blob([FIGURE], { type: "image/svg+xml" }), errorMessage: null, loading: false }),
}));

// 与相邻组件测试同法：把 t 换成"原样回显键 + 计数"，从而能断言取的是哪个键。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`),
  }),
}));

// jsdom 没有 ResizeObserver，而图面就绪后的自适应宽度测量依赖它。
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

afterEach(() => {
  cleanup();
  settleRead = null;
  readFigureAnnotation.mockClear();
});

function renderAnnotator() {
  return render(
    <FigureAnnotator
      projectName="demo"
      file={{ name: "inv-fig1.svg", path: "/w/project/figures/inv-fig1.svg" }}
      title="inv-fig1.svg"
      message="fallback"
      onClose={() => undefined}
    />,
  );
}

/** 等图面渲染出来（覆盖层出现即代表 `source` 已就绪）。 */
async function waitForOverlay(container: HTMLElement): Promise<SVGSVGElement> {
  const overlay = await waitFor(() => {
    const element = container.querySelector<SVGSVGElement>("[data-figure-annotator-overlay]");
    if (element === null) throw new Error("the annotator overlay did not render");
    return element;
  });
  Object.defineProperty(overlay, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, top: 0, width: WIDTH, height: HEIGHT, right: WIDTH, bottom: HEIGHT, x: 0, y: 0 }),
  });
  return overlay;
}

describe("figure annotator seeding", () => {
  it("never lets a late sidecar read overwrite what the user already drew", async () => {
    const { container } = renderAnnotator();
    const overlay = await waitForOverlay(container);

    // 用户抢在 sidecar 读回之前落笔。
    fireEvent.click(screen.getByText("figureAnnotator.annotate"));
    fireEvent.pointerDown(overlay, { clientX: 10, clientY: 5 });
    fireEvent.pointerMove(overlay, { clientX: 80, clientY: 40 });
    fireEvent.pointerUp(overlay, { clientX: 80, clientY: 40 });
    expect(container.querySelector('path[stroke="#e03131"]')).not.toBeNull();

    settleRead?.(savedDocument());

    await waitFor(() => {
      expect(screen.getByText("figureAnnotator.seedSkipped:1")).toBeTruthy();
    });
    // 刚画的那一笔还在，已保存的标注没有被灌进来。
    expect(container.querySelector('path[stroke="#e03131"]')).not.toBeNull();
    expect(container.textContent).not.toContain("保存过的说明");
  });

  it("loads the saved annotation when nothing was drawn yet", async () => {
    const { container } = renderAnnotator();
    await waitForOverlay(container);

    settleRead?.(savedDocument());

    await waitFor(() => {
      expect(container.textContent).toContain("保存过的说明");
    });
    expect(screen.queryByText(/figureAnnotator.seedSkipped/)).toBeNull();
  });
});
