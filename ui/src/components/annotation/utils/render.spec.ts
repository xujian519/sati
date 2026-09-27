import { describe, expect, it } from "vitest";
import type { AnnotationMark } from "../../../types/annotationReference";
import { MARK_FONT_STACK, markPathData, markTextBox } from "./render";

const arrow: AnnotationMark = {
  id: "a",
  kind: "arrow",
  color: "#e03131",
  points: [
    [0, 0],
    [10, 0],
  ],
};
const pen: AnnotationMark = {
  id: "p",
  kind: "pen",
  color: "#000",
  points: [
    [0, 0],
    [5, 5],
    [10, 0],
  ],
};

describe("mark geometry", () => {
  it("draws an arrow as a shaft plus two head strokes", () => {
    expect(markPathData(arrow)?.split("M").length).toBe(3);
  });

  it("normalizes opposite corners into a rectangle", () => {
    expect(
      markPathData({
        id: "r",
        kind: "rect",
        color: "#000",
        points: [
          [10, 20],
          [30, 5],
        ],
      }),
    ).toBe("M 10 5 H 30 V 20 H 10 Z");
  });

  it("closes an ellipse from its bounding box and degrades a flat one to a line", () => {
    expect(
      markPathData({
        id: "e",
        kind: "ellipse",
        color: "#000",
        points: [
          [0, 0],
          [100, 50],
        ],
      }),
    ).toBe("M 0 25 a 50 25 0 1 0 100 0 a 50 25 0 1 0 -100 0");
    expect(
      markPathData({
        id: "e",
        kind: "ellipse",
        color: "#000",
        points: [
          [0, 0],
          [100, 0],
        ],
      }),
    ).toBe("M 0 0 L 100 0");
  });

  it("draws a freehand path through every sample", () => {
    expect(markPathData(pen)).toBe("M 0 0 L 5 5 L 10 0");
  });

  it("has no stroke for a text mark", () => {
    expect(markPathData({ id: "t", kind: "text", color: "#000", points: [[1, 2]], text: "图号" })).toBeUndefined();
    expect(markPathData({ id: "x", kind: "arrow", color: "#000", points: [] })).toBeUndefined();
    expect(markPathData({ id: "y", kind: "rect", color: "#000", points: [[1, 1]] })).toBeUndefined();
  });

  it("boxes a text mark from its note and skips an empty one", () => {
    const box = markTextBox({ id: "t", kind: "text", color: "#000", points: [[1, 2]], text: "图号" });
    expect(box).toMatchObject({ x: 1, y: 2, text: "图号" });
    expect(box!.width).toBeGreaterThan(0);
    expect(markTextBox({ id: "t2", kind: "text", color: "#000", points: [[1, 2]], text: "  " })).toBeUndefined();
    expect(markTextBox({ id: "t3", kind: "text", color: "#000", points: [] })).toBeUndefined();
  });

  it("keeps the font stack free of quotes (it is interpolated into an SVG attribute)", () => {
    expect(MARK_FONT_STACK).not.toContain('"');
    expect(MARK_FONT_STACK).not.toContain("'");
  });
});
