import { describe, expect, it } from "vitest";
import {
  annotationFigureFingerprint,
  buildFigureAnnotationDocument,
  describeFigureMarks,
  figureAnnotationImageName,
  figureAnnotationSidecarPath,
  figureAnnotationSummary,
  isFigureAnnotationDocument,
  isFigureAnnotationMark,
  parseFigureAnnotationDocument,
  type FigureAnnotationMark,
} from "./annotationReference";

const figure = {
  path: "/w/data/cases/c1/outputs/inv-fig1.svg",
  relativePath: "data/cases/c1/outputs/inv-fig1.svg",
  mediaType: "image/svg+xml",
  width: 800,
  height: 600,
  sha256: "a".repeat(64),
};

function mark(overrides: Partial<FigureAnnotationMark> = {}): FigureAnnotationMark {
  return {
    id: "m1",
    kind: "arrow",
    color: "#e03131",
    points: [
      [10, 20],
      [200, 150],
    ],
    text: "这个标号应指向滑套 34",
    ...overrides,
  };
}

describe("figure annotation contract", () => {
  it("derives the sidecar and the review image beside the figure", () => {
    expect(figureAnnotationSidecarPath("/w/outputs/inv-fig1.svg")).toBe("/w/outputs/inv-fig1.annot.json");
    expect(figureAnnotationImageName("/w/outputs/inv-fig1.svg")).toBe("inv-fig1.annotated.png");
    // 相对路径与大小写后缀同样成立。
    expect(figureAnnotationSidecarPath("outputs/inv-fig1.SVG")).toBe("outputs/inv-fig1.annot.json");
    expect(figureAnnotationSidecarPath("C:\\case\\fig1.svg")).toBe("C:\\case\\fig1.annot.json");
  });

  it("builds a document that validates and keeps the first save time", () => {
    const document = buildFigureAnnotationDocument(
      { figure, marks: [mark()], summary: "把标号都对齐一遍", createdAt: "2026-01-01T00:00:00.000Z" },
      "2026-02-02T00:00:00.000Z",
    );

    expect(document.version).toBe(1);
    expect(document.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(document.updatedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(isFigureAnnotationDocument(document)).toBe(true);
    expect(isFigureAnnotationDocument(JSON.parse(JSON.stringify(document)))).toBe(true);
  });

  it("drops an empty overall note and rejects geometrically empty figures", () => {
    expect(buildFigureAnnotationDocument({ figure, marks: [], summary: "   " }).summary).toBeUndefined();
    expect(
      isFigureAnnotationDocument({
        version: 1,
        figure: { ...figure, width: 0 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        marks: [],
      }),
    ).toBe(false);
  });

  it("requires a shape, a colour and at least one point on every mark", () => {
    expect(isFigureAnnotationMark(mark())).toBe(true);
    expect(isFigureAnnotationMark({ ...mark(), kind: "star" })).toBe(false);
    expect(isFigureAnnotationMark({ ...mark(), points: [] })).toBe(false);
    expect(isFigureAnnotationMark({ ...mark(), points: [[0, Number.NaN]] })).toBe(false);
    expect(isFigureAnnotationMark({ ...mark(), anchor: { tag: "g" } })).toBe(false);
    expect(isFigureAnnotationMark({ ...mark(), anchor: { tag: "g", bbox: [0, 0, 1, 1], ref: "34" } })).toBe(true);
  });

  it("records which algorithm produced the figure digest", () => {
    const document = (hashAlgo?: unknown) =>
      isFigureAnnotationDocument({
        version: 1,
        figure: hashAlgo === undefined ? figure : { ...figure, hashAlgo },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        marks: [],
      });

    expect(document()).toBe(true);
    expect(document("sha256")).toBe(true);
    expect(document("fnv1a64")).toBe(true);
    expect(document("md5")).toBe(false);
    expect(document(1)).toBe(false);
  });

  it("builds a comparable fingerprint that reads a missing algorithm as sha256", () => {
    expect(annotationFigureFingerprint({ sha256: "ab".repeat(32) })).toBe(`sha256:${"ab".repeat(32)}`);
    expect(annotationFigureFingerprint({ sha256: "ab".repeat(8), hashAlgo: "fnv1a64" })).toBe(
      `fnv1a64:${"ab".repeat(8)}`,
    );
    // 同一份摘要配不同算法不得被认成同一版图。
    expect(annotationFigureFingerprint({ sha256: "ab".repeat(32) })).not.toBe(
      annotationFigureFingerprint({ sha256: "ab".repeat(32), hashAlgo: "fnv1a64" }),
    );
  });

  it("treats an unreadable sidecar as never annotated", () => {
    expect(parseFigureAnnotationDocument("not json")).toBeNull();
    expect(parseFigureAnnotationDocument(JSON.stringify({ version: 2, marks: [] }))).toBeNull();
    expect(
      parseFigureAnnotationDocument(JSON.stringify({ version: 1, figure, createdAt: "x", updatedAt: "x", marks: [] })),
    ).not.toBeNull();
  });

  it("renders numbered marks with their anchors, in the agent-facing language", () => {
    const lines = describeFigureMarks([
      mark(),
      mark({
        id: "m2",
        kind: "rect",
        points: [
          [0, 0],
          [5, 5],
        ],
        text: "",
        anchor: { tag: "g", id: "n-3", nodeId: "3", ref: "34", bbox: [0, 0, 5, 5] },
      }),
    ]);

    expect(lines[0]).toBe("1. arrow (10,20) -> (200,150): 这个标号应指向滑套 34");
    expect(lines[1]).toBe("2. rectangle (0,0)-(5,5) (node=3, ref=34) (no note)");
  });

  it("summarizes a reference by its first note, then by the caller's label", () => {
    const label = (count: number): string => `${count} 处标注`;
    const document = buildFigureAnnotationDocument({ figure, marks: [mark()] });
    expect(figureAnnotationSummary(document, label)).toBe("这个标号应指向滑套 34");
    const silent = buildFigureAnnotationDocument({ figure, marks: [mark({ text: "" })] });
    expect(figureAnnotationSummary(silent, label)).toBe("1 处标注");
  });
});
