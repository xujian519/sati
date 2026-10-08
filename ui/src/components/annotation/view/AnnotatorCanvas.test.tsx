// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnnotationMark } from "../../../types/annotationReference";
import { AnnotatorCanvas } from "./AnnotatorCanvas";

const WIDTH = 100;
const HEIGHT = 50;

/** 覆盖层的矩形按图面尺寸打桩（1 client 像素 = 1 图面像素），坐标换算才可断言。 */
function stubOverlayRect(): SVGSVGElement {
  const overlay = document.querySelector<SVGSVGElement>("[data-annotator-overlay]");
  if (!overlay) throw new Error("the overlay did not render");
  Object.defineProperty(overlay, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, top: 0, width: WIDTH, height: HEIGHT, right: WIDTH, bottom: HEIGHT, x: 0, y: 0 }),
  });
  return overlay;
}

function Harness(props: {
  marks?: readonly AnnotationMark[];
  tool?: "select" | "arrow" | "text";
  onAdd?: (mark: AnnotationMark) => void;
  onSelect?: (id: string | null) => void;
  onRemove?: (id: string) => void;
  scrollX?: number;
  scrollY?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={containerRef}>
      <AnnotatorCanvas
        width={WIDTH}
        height={HEIGHT}
        marks={props.marks ?? []}
        tool={props.tool ?? "arrow"}
        color="#e03131"
        containerRef={containerRef}
        selectedId={null}
        onSelect={props.onSelect ?? (() => undefined)}
        onAdd={props.onAdd ?? (() => undefined)}
        onRemove={props.onRemove ?? (() => undefined)}
        nextId={() => "m-new"}
        scrollX={props.scrollX}
        scrollY={props.scrollY}
      />
    </div>
  );
}

afterEach(cleanup);

describe("annotator canvas", () => {
  it("maps pointer input and draws marks in document coordinates when the surface is scrolled", () => {
    const onAdd = vi.fn();
    const { container } = render(<Harness scrollY={100} onAdd={onAdd} />);
    const overlay = stubOverlayRect();

    fireEvent.pointerDown(overlay, { clientX: 10, clientY: 5 });
    fireEvent.pointerMove(overlay, { clientX: 80, clientY: 40 });
    fireEvent.pointerUp(overlay, { clientX: 80, clientY: 40 });

    // 文档坐标 = 视口坐标 + scroll（y 方向 100）。
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        points: [
          [10, 105],
          [80, 140],
        ],
      }),
    );
    // 绘制层把已有标注整体平移 -scroll，使其与文档内容对齐。
    expect(container.querySelector("svg > g")?.getAttribute("transform")).toBe("translate(0 -100)");
  });

  it("commits a dragged mark in figure pixels", () => {
    const onAdd = vi.fn();
    const onSelect = vi.fn();
    render(<Harness onAdd={onAdd} onSelect={onSelect} />);
    const overlay = stubOverlayRect();

    fireEvent.pointerDown(overlay, { clientX: 10, clientY: 5 });
    fireEvent.pointerMove(overlay, { clientX: 80, clientY: 40 });
    fireEvent.pointerUp(overlay, { clientX: 80, clientY: 40 });

    expect(onAdd).toHaveBeenCalledTimes(1);
    const mark = onAdd.mock.calls[0]?.[0] as AnnotationMark;
    expect(mark).toMatchObject({ id: "m-new", kind: "arrow", color: "#e03131" });
    expect(mark.points).toEqual([
      [10, 5],
      [80, 40],
    ]);
    // 画完即选中：说明框直接落到这条标注上。
    expect(onSelect).toHaveBeenCalledWith("m-new");
  });

  it("ignores a drag too short to be a mark", () => {
    const onAdd = vi.fn();
    render(<Harness onAdd={onAdd} />);
    const overlay = stubOverlayRect();

    fireEvent.pointerDown(overlay, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(overlay, { clientX: 12, clientY: 12 });
    fireEvent.pointerUp(overlay, { clientX: 12, clientY: 12 });

    expect(onAdd).not.toHaveBeenCalled();
  });

  it("creates and selects a text mark on a single click", () => {
    const onAdd = vi.fn();
    const onSelect = vi.fn();
    render(<Harness tool="text" onAdd={onAdd} onSelect={onSelect} />);
    const overlay = stubOverlayRect();

    fireEvent.pointerDown(overlay, { clientX: 30, clientY: 20 });

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0]?.[0]).toMatchObject({ kind: "text", points: [[30, 20]], text: "" });
    expect(onSelect).toHaveBeenCalledWith("m-new");
  });

  it("does not draw in select mode", () => {
    const onAdd = vi.fn();
    render(<Harness tool="select" onAdd={onAdd} />);
    const overlay = stubOverlayRect();

    fireEvent.pointerDown(overlay, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(overlay, { clientX: 60, clientY: 40 });
    fireEvent.pointerUp(overlay, { clientX: 60, clientY: 40 });

    expect(onAdd).not.toHaveBeenCalled();
  });

  it("draws a stored mark and deletes it on a double click", () => {
    const onRemove = vi.fn();
    const stored: AnnotationMark = {
      id: "m1",
      kind: "rect",
      color: "#1971c2",
      points: [
        [0, 0],
        [20, 20],
      ],
      text: "少一个件",
    };
    const { container } = render(<Harness marks={[stored]} tool="select" onRemove={onRemove} />);

    expect(container.querySelectorAll("rect").length).toBeGreaterThan(0);
    const hit = container.querySelector('path[stroke="transparent"]');
    expect(hit).not.toBeNull();
    fireEvent.doubleClick(hit!);
    expect(onRemove).toHaveBeenCalledWith("m1");
  });

  it("keeps a mark selected when the click that picked it bubbles out of the hit shape", () => {
    const onSelect = vi.fn();
    const stored: AnnotationMark = {
      id: "m1",
      kind: "rect",
      color: "#1971c2",
      points: [
        [0, 0],
        [20, 20],
      ],
      text: "少一个件",
    };
    const { container } = render(<Harness marks={[stored]} tool="select" onSelect={onSelect} />);
    const hit = container.querySelector('path[stroke="transparent"]');

    // 真实点击是 pointerdown 之后再冒一个 click；覆盖层的 click 处理器不认目标就会把选中清掉。
    fireEvent.pointerDown(hit!, { clientX: 10, clientY: 10 });
    fireEvent.click(hit!, { clientX: 10, clientY: 10 });
    expect(onSelect).toHaveBeenLastCalledWith("m1");

    // 点在空白图面上仍然取消选中。
    const overlay = container.querySelector("[data-annotator-overlay]");
    fireEvent.click(overlay!);
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("shows a placeholder for a text mark that has no label yet", () => {
    const stored: AnnotationMark = { id: "t1", kind: "text", color: "#2f9e44", points: [[5, 20]], text: "" };
    const { container } = render(<Harness marks={[stored]} tool="select" />);
    expect(container.querySelector("text")?.textContent).toBe("T");
  });
});
