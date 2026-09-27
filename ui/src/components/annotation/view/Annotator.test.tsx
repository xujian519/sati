// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildAnnotationDocument, type AnnotationDocument } from "../../../types/annotationReference";
import { ADD_CONTENT_REFERENCE_EVENT, isContentReference } from "../../../types/contentReference";
import Annotator from "./Annotator";

const WIDTH = 100;
const HEIGHT = 50;

const FIGURE = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <g id="n-n1" data-ref="1"><rect x="10" y="10" width="20" height="10" fill="none"/></g>
</svg>`;

/** 已保存的标注（本测试只用它是否被灌入来判断竞态）。 */
function savedDocument(): AnnotationDocument {
  return buildAnnotationDocument({
    target: {
      kind: "figure-svg",
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
let settleRead: ((value: AnnotationDocument | null) => void) | null = null;
const readAnnotation = vi.fn(
  () =>
    new Promise<AnnotationDocument | null>(resolve => {
      settleRead = resolve;
    }),
);

vi.mock("../utils/sidecar", () => ({
  readAnnotation: () => readAnnotation(),
  saveAnnotation: () => Promise.resolve("/w/project/figures/inv-fig1.svg.annot.json"),
}));

// 桩必须返回**同一个** Blob 实例：`useObjectUrl` 以 blob 身份为依赖，每次渲染都给新实例
// 会形成无限渲染循环（真实 `useFileBlob` 把它存在 state 里，引用稳定）。
const FIGURE_BLOB = new Blob([FIGURE], { type: "image/svg+xml" });

vi.mock("../../code-editor/view/binary-file/hooks/use-file-blob", () => ({
  useFileBlob: () => ({ blob: FIGURE_BLOB, errorMessage: null, loading: false }),
}));

// 与相邻组件测试同法：把 t 换成"原样回显键 + 计数"，从而能断言取的是哪个键。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`),
  }),
}));

// 共享的选区覆盖层自带 html2canvas + 画布，jsdom 两样都没有：这里只留"选区提交"这一个契约，
// 用桩把一次捕获直接交给面板，验证面板产出并派发的是合法 region 引用。
vi.mock("../../code-editor/view/subcomponents/RegionSelectionOverlay", () => ({
  default: ({ active, onCommit }: { active: boolean; onCommit: (capture: unknown) => void }) =>
    active ? (
      <button
        type="button"
        onClick={() =>
          onCommit({
            rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
            dataUrl: "data:image/png;base64,AAAA",
            width: 40,
            height: 40,
          })
        }
      >
        mock-region-commit
      </button>
    ) : null,
}));

// jsdom 不实现 Blob URL（`useObjectUrl` 依赖它）。
beforeAll(() => {
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:mock" });
  }
  if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
  }
});

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
  readAnnotation.mockClear();
});

function renderAnnotator() {
  return render(
    <Annotator
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
    const element = container.querySelector<SVGSVGElement>("[data-annotator-overlay]");
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
    fireEvent.click(screen.getByText("annotator.annotate"));
    fireEvent.pointerDown(overlay, { clientX: 10, clientY: 5 });
    fireEvent.pointerMove(overlay, { clientX: 80, clientY: 40 });
    fireEvent.pointerUp(overlay, { clientX: 80, clientY: 40 });
    expect(container.querySelector('path[stroke="#e03131"]')).not.toBeNull();

    settleRead?.(savedDocument());

    await waitFor(() => {
      expect(screen.getByText("annotator.seedSkipped:1")).toBeTruthy();
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
    expect(screen.queryByText(/annotator.seedSkipped/)).toBeNull();
  });

  it("offers a region-reference exit that hands the composer a valid region payload", async () => {
    const { container } = renderAnnotator();
    await waitForOverlay(container);

    fireEvent.click(screen.getByText("annotator.regionReference"));
    // 区域模式：普通 `<img>` 顶上来，绘制覆盖层卸载（两套手势不抢同一块画布）。
    await waitFor(() => {
      expect(container.querySelector('img[alt="inv-fig1.svg"]')).not.toBeNull();
    });
    expect(container.querySelector("[data-annotator-overlay]")).toBeNull();

    const references: unknown[] = [];
    const listener = (event: Event): void => {
      references.push((event as CustomEvent).detail);
    };
    window.addEventListener(ADD_CONTENT_REFERENCE_EVENT, listener);
    try {
      fireEvent.click(screen.getByText("mock-region-commit"));
    } finally {
      window.removeEventListener(ADD_CONTENT_REFERENCE_EVENT, listener);
    }

    expect(references).toHaveLength(1);
    const reference = references[0] as {
      selectionMode: string;
      locator: { surface: string; rect: unknown };
      image: { width: number; mimeType: string };
    };
    // 产出的是区域引用（不是标注引用），且落点面是图本身。
    expect(reference.selectionMode).toBe("region");
    expect(reference.locator).toMatchObject({ surface: "figure", rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } });
    expect(reference.image).toMatchObject({ mimeType: "image/png", width: 40 });
    expect(isContentReference(reference)).toBe(true);
    // 提交后退出区域模式，画布回到可绘制状态。
    await waitFor(() => {
      expect(container.querySelector('img[alt="inv-fig1.svg"]')).toBeNull();
    });
    expect(container.querySelector("[data-annotator-overlay]")).not.toBeNull();
  });
});
