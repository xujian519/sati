// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PdfDocumentPreview from "./PdfDocumentPreview";

const pdfMocks = vi.hoisted(() => ({ loadDocument: vi.fn() }));

vi.mock("./pdfjs", () => ({
  GlobalWorkerOptions: {},
  TextLayer: class {
    textDivs: HTMLElement[] = [];
    textContentItemsStr: string[] = [];
    async render() {}
    cancel() {}
  },
  loadDocument: pdfMocks.loadDocument,
}));

vi.mock("pdfjs-dist/legacy/build/pdf.worker.mjs?url", () => ({ default: "pdf-worker.js" }));

type ObserverEntry = { isIntersecting: boolean; target: Element };
type ObserverCallback = (entries: ObserverEntry[], observer: IntersectionObserverMock) => void;

/** 挂载期 effect 的可观测执行顺序（各 mock 在"自己被调用"时打点）。 */
let effectOrder: string[] = [];

class ResizeObserverMock {
  constructor() {
    effectOrder.push("resize-observer");
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

class IntersectionObserverMock {
  static instances: IntersectionObserverMock[] = [];

  callback: ObserverCallback;
  observed: Element[] = [];

  constructor(callback: ObserverCallback) {
    this.callback = callback;
    IntersectionObserverMock.instances.push(this);
  }

  observe(target: Element) {
    this.observed.push(target);
  }

  unobserve() {}
  disconnect() {}
  takeRecords(): ObserverEntry[] {
    return [];
  }

  fire(entry: ObserverEntry) {
    this.callback([entry], this);
  }
}

function observerFor(target: Element): IntersectionObserverMock | undefined {
  return IntersectionObserverMock.instances.find(observer => observer.observed.includes(target));
}

/** Deterministic requestAnimationFrame queue so a test can flush frames explicitly. */
let pendingFrames: Array<{ id: number; callback: FrameRequestCallback }> = [];
let nextFrameId = 0;
let requestFrameMock: ReturnType<typeof vi.fn>;
let cancelFrameMock: ReturnType<typeof vi.fn>;

function flushFrames(rounds = 6) {
  for (let round = 0; round < rounds; round += 1) {
    const due = pendingFrames;
    pendingFrames = [];
    if (due.length === 0) return;
    act(() => {
      for (const frame of due) frame.callback(16);
    });
  }
}

/** Let the (mocked, already-resolved) pdf.js load promise settle inside act. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * 挂载期的调度帧 + "恢复默认视口"帧都消化掉：恢复 effect 在 `scrollTop === 0` 时会把
 * `viewer.scrollTop` 写回 0，测试必须先让它跑完，再摆放自己的滚动位置。
 */
async function settleViewport() {
  await settle();
  flushFrames();
  await settle();
  flushFrames();
}

/**
 * jsdom 没有布局：这里给 `getBoundingClientRect` 装一个最小可用的"单列滚动"模型——
 * 第 N 页占据 [(N-1)*800 - scrollTop, +800)，查看器占据 [0, viewerRectHeight)。
 * 组件里"按可见高度挑当前页"的逻辑因此可被稳定断言。
 */
const PAGE_HEIGHT = 800;
let viewerScrollTop = 0;
let viewerRectHeight = 768;

function fakeRect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom: top + height,
    left: 0,
    right: 600,
    width: 600,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function installLayoutMock() {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element): DOMRect {
    const pageNumber = Number((this as HTMLElement).dataset?.pdfPageNumber ?? "");
    if (Number.isFinite(pageNumber) && pageNumber > 0) {
      return fakeRect((pageNumber - 1) * PAGE_HEIGHT - viewerScrollTop, PAGE_HEIGHT);
    }
    return fakeRect(0, viewerRectHeight);
  };
}

type MockPage = {
  getViewport: (options?: { scale?: number; rotation?: number }) => { width: number; height: number };
  render: () => { promise: Promise<void>; cancel: () => void };
  getTextContent: () => Promise<{ items: Array<{ str: string }> }>;
};

function createMockDocument(numPages: number, outline: unknown[] = []) {
  const createPage = (): MockPage => ({
    getViewport: (options?: { scale?: number }) => ({
      width: 600 * (options?.scale ?? 1),
      height: 800 * (options?.scale ?? 1),
    }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    getTextContent: async () => ({ items: [] as Array<{ str: string }> }),
  });

  return {
    numPages,
    getPage: vi.fn(async () => createPage()),
    getOutline: vi.fn(async () => outline),
    destroy: vi.fn(),
  };
}

function queueDocument(document: ReturnType<typeof createMockDocument>, destroy = vi.fn()) {
  pdfMocks.loadDocument.mockImplementationOnce(() => {
    effectOrder.push("load-document");
    return { promise: Promise.resolve(document), destroy };
  });
  return destroy;
}

function getPageInput(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "pdfToolbar.goToPage" }) as HTMLInputElement;
}

function getZoomInput(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "pdfToolbar.zoomPercent" }) as HTMLInputElement;
}

function getViewer(): HTMLElement {
  const page = document.querySelector<HTMLElement>("[data-pdf-page-number]");
  const viewer = page?.parentElement?.parentElement;
  if (!viewer) throw new Error("viewer not found");
  return viewer;
}

/** 把查看器元素变成"真的能存 scrollTop"，并同步给布局模型。 */
function setViewerScrollTop(viewer: HTMLElement, value: number) {
  viewerScrollTop = value;
  Object.defineProperty(viewer, "scrollTop", {
    configurable: true,
    get: () => viewerScrollTop,
    set: (next: number) => {
      viewerScrollTop = next;
    },
  });
}

function commitPageInput(value: string) {
  const input = getPageInput();
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

function commitZoomInput(value: string) {
  const input = getZoomInput();
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

async function renderPreview(props: Partial<Parameters<typeof PdfDocumentPreview>[0]> = {}) {
  const view = render(
    <PdfDocumentPreview
      url="/report.pdf?rev=1"
      projectName="demo"
      fileName="report.pdf"
      filePath="report.pdf"
      source="pdf"
      {...props}
    />,
  );
  const pageInput = await screen.findByRole("textbox", { name: "pdfToolbar.goToPage" });
  await waitFor(() => expect((pageInput as HTMLInputElement).disabled).toBe(false));
  return view;
}

function sameFileReloadProps(url: string) {
  return { url, projectName: "demo", fileName: "report.pdf", filePath: "report.pdf", source: "pdf" as const };
}

const nativeAddEventListener = EventTarget.prototype.addEventListener;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
const originalScrollTo = HTMLElement.prototype.scrollTo;
const originalElementRect = Element.prototype.getBoundingClientRect;
const originalRangeRect = Range.prototype.getBoundingClientRect;
const scrollIntoViewMock = vi.fn();

beforeEach(() => {
  pdfMocks.loadDocument.mockReset();
  IntersectionObserverMock.instances = [];
  effectOrder = [];
  pendingFrames = [];
  nextFrameId = 0;
  viewerScrollTop = 0;
  viewerRectHeight = 768;

  requestFrameMock = vi.fn((callback: FrameRequestCallback) => {
    if (!effectOrder.includes("raf")) effectOrder.push("raf");
    nextFrameId += 1;
    pendingFrames.push({ id: nextFrameId, callback });
    return nextFrameId;
  });
  cancelFrameMock = vi.fn((id: number) => {
    pendingFrames = pendingFrames.filter(frame => frame.id !== id);
  });

  vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function addEventListener(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    // "selectionchange" 只由"滚动/选区监听"那个 effect 在 document 上注册，作为它的打点。
    if (type === "selectionchange") effectOrder.push("document-listeners");
    return nativeAddEventListener.call(this, type, listener, options);
  });
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
  vi.stubGlobal("requestAnimationFrame", requestFrameMock);
  vi.stubGlobal("cancelAnimationFrame", cancelFrameMock);

  scrollIntoViewMock.mockReset();
  HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
  HTMLElement.prototype.scrollTo = vi.fn();
  installLayoutMock();
  // jsdom 也没有实现 Range 的 rect（浮层定位要用）。
  Range.prototype.getBoundingClientRect = () => fakeRect(0, 12);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  HTMLElement.prototype.scrollTo = originalScrollTo;
  Element.prototype.getBoundingClientRect = originalElementRect;
  Range.prototype.getBoundingClientRect = originalRangeRect;
});

describe("PdfDocumentPreview 视口快照与恢复（N07 拆分）", () => {
  it("同一文件重新加载时按快照恢复页码与 scrollTop（不是回到默认视口）", async () => {
    queueDocument(createMockDocument(5));
    const { rerender } = await renderPreview();
    const viewer = getViewer();
    setViewerScrollTop(viewer, (3 - 1) * PAGE_HEIGHT);
    commitPageInput("3");
    flushFrames();
    expect(getPageInput().value).toBe("3");

    queueDocument(createMockDocument(5));
    rerender(<PdfDocumentPreview {...sameFileReloadProps("/report.pdf?rev=2")} />);
    await settle();

    await waitFor(() => expect(getPageInput().value).toBe("3"));
    flushFrames();
    expect(viewer.scrollTop).toBe((3 - 1) * PAGE_HEIGHT);
    expect(getPageInput().value).toBe("3");
  });

  it("文件 key 变化时回到默认视口（页码 1、缩放 100%）", async () => {
    queueDocument(createMockDocument(5));
    const { rerender } = await renderPreview();
    commitPageInput("3");
    commitZoomInput("250%");
    expect(getPageInput().value).toBe("3");
    expect(getZoomInput().value).toBe("250%");

    queueDocument(createMockDocument(5));
    rerender(
      <PdfDocumentPreview url="/other.pdf" projectName="demo" fileName="other.pdf" filePath="other.pdf" source="pdf" />,
    );
    await settle();
    flushFrames();

    await waitFor(() => expect(getPageInput().value).toBe("1"));
    expect(getZoomInput().value).toBe("100%");
  });

  it("同一文件重载保留自定义缩放（快照里的 customScale）", async () => {
    queueDocument(createMockDocument(5));
    const { rerender } = await renderPreview();
    commitZoomInput("175%");
    expect(getZoomInput().value).toBe("175%");

    queueDocument(createMockDocument(5));
    rerender(<PdfDocumentPreview {...sameFileReloadProps("/report.pdf?rev=3")} />);
    await settle();
    flushFrames();

    await waitFor(() => expect(getZoomInput().value).toBe("175%"));
  });
});

describe("PdfDocumentPreview 滚动跟踪（N07 拆分）", () => {
  it("同一帧内的连续滚动只调度两帧（当前页 + 强制渲染各一次）", async () => {
    queueDocument(createMockDocument(5));
    await renderPreview();
    await settleViewport();
    const viewer = getViewer();
    requestFrameMock.mockClear();

    fireEvent.scroll(viewer);
    fireEvent.scroll(viewer);
    fireEvent.scroll(viewer);

    expect(requestFrameMock).toHaveBeenCalledTimes(2);
  });

  it("滚动到第 2 页并把该页标为可见后，当前页更新为 2", async () => {
    queueDocument(createMockDocument(5));
    await renderPreview();
    await settleViewport();
    const viewer = getViewer();
    setViewerScrollTop(viewer, PAGE_HEIGHT);
    const pageTwo = document.querySelector<HTMLElement>('[data-pdf-page-number="2"]');
    if (!pageTwo) throw new Error("page 2 missing");

    act(() => {
      observerFor(pageTwo)?.fire({ isIntersecting: true, target: pageTwo });
    });
    flushFrames();

    await waitFor(() => expect(getPageInput().value).toBe("2"));
  });

  it("可见页集合里按可见高度挑当前页，而不是取第一页", async () => {
    queueDocument(createMockDocument(5));
    await renderPreview();
    await settleViewport();
    const viewer = getViewer();
    setViewerScrollTop(viewer, PAGE_HEIGHT);
    const pages = [1, 2, 3].map(number => document.querySelector<HTMLElement>(`[data-pdf-page-number="${number}"]`));
    if (pages.some(page => !page)) throw new Error("pages missing");

    act(() => {
      for (const page of pages)
        observerFor(page as HTMLElement)?.fire({ isIntersecting: true, target: page as HTMLElement });
    });
    flushFrames();

    await waitFor(() => expect(getPageInput().value).toBe("2"));
  });

  it("可见高度相同时取更靠上的页（平局比较顶部距离）", async () => {
    queueDocument(createMockDocument(5));
    await renderPreview();
    await settleViewport();
    viewerRectHeight = PAGE_HEIGHT * 3;
    const pages = [1, 2].map(number => document.querySelector<HTMLElement>(`[data-pdf-page-number="${number}"]`));
    if (pages.some(page => !page)) throw new Error("pages missing");

    act(() => {
      for (const page of pages)
        observerFor(page as HTMLElement)?.fire({ isIntersecting: true, target: page as HTMLElement });
    });
    flushFrames();

    await waitFor(() => expect(getPageInput().value).toBe("1"));
  });

  it("卸载后滚动监听被移除（不再调度新帧）", async () => {
    queueDocument(createMockDocument(5));
    const { unmount } = await renderPreview();
    await settleViewport();
    const viewer = getViewer();
    unmount();
    requestFrameMock.mockClear();

    fireEvent.scroll(viewer);

    expect(requestFrameMock).not.toHaveBeenCalled();
  });

  it("卸载时取消在途的 rAF", async () => {
    queueDocument(createMockDocument(5));
    const { unmount } = await renderPreview();
    await settleViewport();
    const viewer = getViewer();
    fireEvent.scroll(viewer);
    const scheduled = pendingFrames.map(frame => frame.id);
    expect(scheduled).toHaveLength(2);

    unmount();

    // 在途帧必须被取消（卸载后子组件清理还会再调度两帧，但那两个不是"在途"的）。
    for (const id of scheduled) {
      expect(cancelFrameMock).toHaveBeenCalledWith(id);
      expect(pendingFrames.some(frame => frame.id === id)).toBe(false);
    }
  });
});

describe("PdfDocumentPreview 选区 → 引用（N07 拆分）", () => {
  function fillTextLayers(texts: string[]) {
    document.querySelectorAll<HTMLElement>("[data-pdf-page-number] .textLayer").forEach((layer, index) => {
      layer.textContent = texts[index] ?? "";
    });
  }

  function selectAcross(startTextLayer: HTMLElement, endTextLayer: HTMLElement) {
    const startNode = startTextLayer.firstChild;
    const endNode = endTextLayer.firstChild;
    if (!startNode || !endNode) throw new Error("text layer has no text");
    const range = document.createRange();
    range.setStart(startNode, 0);
    range.setEnd(endNode, endNode.textContent?.length ?? 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  async function waitOutDebounce() {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
    });
  }

  it("空选区（collapsed）不显示引用浮层", async () => {
    queueDocument(createMockDocument(5));
    await renderPreview();
    fillTextLayers(["第一页文本", "第二页文本"]);
    const layer = document.querySelector<HTMLElement>('[data-pdf-page-number="1"] .textLayer');
    if (!layer) throw new Error("text layer missing");
    const range = document.createRange();
    range.selectNodeContents(layer);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    fireEvent.mouseUp(document);
    await waitOutDebounce();

    expect(screen.queryByText("selection.chatInSati")).toBeNull();
  });

  it("跨页选区生成命中两页的引用，并在点击时派发 sati:add-chat-reference", async () => {
    queueDocument(createMockDocument(5));
    await renderPreview();
    fillTextLayers(["第一页文本", "第二页文本"]);
    const firstLayer = document.querySelector<HTMLElement>('[data-pdf-page-number="1"] .textLayer');
    const secondLayer = document.querySelector<HTMLElement>('[data-pdf-page-number="2"] .textLayer');
    if (!firstLayer || !secondLayer) throw new Error("text layers missing");
    selectAcross(firstLayer, secondLayer);

    fireEvent.mouseUp(document);
    const button = await screen.findByText("selection.chatInSati");
    const listener = vi.fn();
    window.addEventListener("sati:add-chat-reference", listener);

    fireEvent.click(button);

    expect(listener).toHaveBeenCalledTimes(1);
    const detail = (listener.mock.calls[0][0] as CustomEvent).detail as {
      locator: { pageNumbers: number[]; quote: { exact: string } };
      selectedText: string;
    };
    expect(detail.locator.pageNumbers).toEqual([1, 2]);
    expect(detail.locator.quote.exact).toBe("第一页文本第二页文本");
    expect(window.getSelection()?.rangeCount).toBe(0);
    window.removeEventListener("sati:add-chat-reference", listener);
  });

  it("selectionchange 会撤下引用浮层", async () => {
    queueDocument(createMockDocument(5));
    await renderPreview();
    fillTextLayers(["第一页文本", "第二页文本"]);
    const firstLayer = document.querySelector<HTMLElement>('[data-pdf-page-number="1"] .textLayer');
    const secondLayer = document.querySelector<HTMLElement>('[data-pdf-page-number="2"] .textLayer');
    if (!firstLayer || !secondLayer) throw new Error("text layers missing");
    selectAcross(firstLayer, secondLayer);

    fireEvent.mouseUp(document);
    await screen.findByText("selection.chatInSati");

    fireEvent(document, new Event("selectionchange"));

    await waitFor(() => expect(screen.queryByText("selection.chatInSati")).toBeNull());
  });

  it("选区不在 .textLayer 上时不生成引用", async () => {
    queueDocument(createMockDocument(5));
    await renderPreview();
    const page = document.querySelector<HTMLElement>('[data-pdf-page-number="1"]');
    if (!page) throw new Error("page missing");
    const outside = document.createElement("div");
    outside.textContent = "页外文本";
    page.append(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    fireEvent.mouseUp(document);
    await waitOutDebounce();

    expect(screen.queryByText("selection.chatInSati")).toBeNull();
  });
});

describe("PdfDocumentPreview 工具栏控制器（N07 拆分）", () => {
  it("页码输入越界被夹到文档页数", async () => {
    queueDocument(createMockDocument(5));
    await renderPreview();

    commitPageInput("99");

    await waitFor(() => expect(getPageInput().value).toBe("5"));
  });

  it("页码输入非数字时回退到当前页", async () => {
    queueDocument(createMockDocument(5));
    await renderPreview();
    commitPageInput("3");
    expect(getPageInput().value).toBe("3");

    commitPageInput("abc");

    await waitFor(() => expect(getPageInput().value).toBe("3"));
  });

  it("缩放输入超过上限被夹到 MAX_SCALE(400%)", async () => {
    queueDocument(createMockDocument(5));
    await renderPreview();

    commitZoomInput("900%");

    await waitFor(() => expect(getZoomInput().value).toBe("400%"));
  });

  it("缩放输入非数字时回退到当前百分比", async () => {
    queueDocument(createMockDocument(5));
    await renderPreview();
    commitZoomInput("250%");
    expect(getZoomInput().value).toBe("250%");

    commitZoomInput("abc");

    await waitFor(() => expect(getZoomInput().value).toBe("250%"));
  });

  it("旋转按钮只对 pdf 源渲染", async () => {
    queueDocument(createMockDocument(5));
    const { unmount } = await renderPreview();
    expect(screen.getByRole("button", { name: "pdfToolbar.rotateClockwise" })).toBeTruthy();
    unmount();

    queueDocument(createMockDocument(5));
    await renderPreview({ source: "office-pdf" });
    expect(screen.queryByRole("button", { name: "pdfToolbar.rotateClockwise" })).toBeNull();
    expect(screen.queryByRole("button", { name: "pdfToolbar.rotateCounterClockwise" })).toBeNull();
  });

  it("缩放到达上限后放大按钮禁用、缩小仍可用", async () => {
    queueDocument(createMockDocument(5));
    await renderPreview();
    commitZoomInput("400%");

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "pdfToolbar.zoomIn" }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect((screen.getByRole("button", { name: "pdfToolbar.zoomOut" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("PdfDocumentPreview 导航侧栏（N07 拆分）", () => {
  it("pages 模式且有大纲时默认展示大纲，可切回缩略图", async () => {
    queueDocument(createMockDocument(3, [{ title: "第一章", dest: [1], items: [] }]));
    await renderPreview({ navigationMode: "pages" });

    const tree = await screen.findByRole("tree");
    expect(tree.textContent).toContain("第一章");

    fireEvent.click(screen.getByRole("button", { name: "pdfToolbar.pages" }));

    await waitFor(() => expect(document.querySelector("[data-pdf-thumbnail-page]")).not.toBeNull());
  });

  it("navigationMode=none 时不渲染侧栏与面板切换按钮", async () => {
    queueDocument(createMockDocument(3, [{ title: "第一章", dest: [1], items: [] }]));
    await renderPreview();

    expect(screen.queryByRole("tree")).toBeNull();
    expect(screen.queryByRole("button", { name: "pdfToolbar.showNavigation" })).toBeNull();
  });
});

describe("PdfDocumentPreview effect 顺序（N07 头号不变式）", () => {
  /**
   * 视口 hook 里"把视口字段同步进 viewStateRef"的四个 effect 必须声明在加载 effect 之前：
   * 加载 effect 读 `viewStateRef` 做快照，顺序颠倒就晚一帧、恢复出上一个页码。
   *
   * 触发这条路径要求"当前页变化"和"同文件重载"落在**同一次 commit**：这里由父组件的一个
   * click 处理器在同一事件批次里既点缩略图（setCurrentPage）又换 url（fileKey 不变 → 快照分支）。
   * 断言取"加载 effect 读到的快照值本身"（settle 之后、flushFrames 之前）——jsdom 没有布局，
   * 帧里的重算总会在无布局下选回第 1 页，因此不能等帧跑完再断言。
   */
  function CollisionHarness() {
    const [url, setUrl] = useState("/report.pdf?rev=1");
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            document.querySelector<HTMLButtonElement>('[data-pdf-thumbnail-page="3"]')?.click();
            setUrl("/report.pdf?rev=2");
          }}
        >
          collide
        </button>
        <PdfDocumentPreview {...sameFileReloadProps(url)} navigationMode="pages" />
      </div>
    );
  }

  it("挂载期 effect 实际执行顺序：ResizeObserver → 加载 → 文档监听 → rAF 调度", async () => {
    queueDocument(createMockDocument(5));
    await renderPreview();

    const observed = effectOrder.filter((marker, index) => effectOrder.indexOf(marker) === index);
    expect(observed.slice(0, 4)).toEqual(["resize-observer", "load-document", "document-listeners", "raf"]);
  });

  it("同一批次内页码变化 + 同文件重载时，视口快照读到的是新页码", async () => {
    queueDocument(createMockDocument(5));
    queueDocument(createMockDocument(5));
    render(<CollisionHarness />);
    const pageInput = await screen.findByRole("textbox", { name: "pdfToolbar.goToPage" });
    await waitFor(() => expect((pageInput as HTMLInputElement).disabled).toBe(false));
    expect(getPageInput().value).toBe("1");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "collide" }));
    });
    await settle();

    expect(getPageInput().value).toBe("3");
  });
});
