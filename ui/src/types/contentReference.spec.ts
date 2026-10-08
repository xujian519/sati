import { describe, expect, it } from "vitest";
import { buildAnnotationDocument, type AnnotationMark } from "./annotationReference";
import { createDocumentSelectionReference } from "./documentSelection";
import {
  contentReferenceImage,
  createCellRangeContentReference,
  createAnnotationContentReference,
  createImageRegionContentReference,
  createTextContentReference,
  formatContentReferencePromptBlock,
  getContentReferenceSummary,
  isContentReference,
  normalizeContentReference,
  parseContentReferencePromptBlock,
  serializableReference,
} from "./contentReference";

const source = {
  projectName: "demo",
  relativePath: "reports/Q1.xlsx",
  fileName: "Q1.xlsx",
};

describe("contentReference", () => {
  it("normalizes old document selections into text references", () => {
    const legacy = createDocumentSelectionReference({
      projectName: "demo",
      fileName: "brief.pdf",
      filePath: "brief.pdf",
      source: "pdf",
      pageNumbers: [2],
      selectedText: "关键结论",
      surroundingText: "这是关键结论的上下文",
    });

    const normalized = normalizeContentReference(legacy);
    expect(normalized?.selectionMode).toBe("text");
    expect(normalized?.source.relativePath).toBe("brief.pdf");
    expect(normalized?.renderer.id).toBe("pdf");
  });

  it("serializes semantic cell ranges with values and formulas", () => {
    const reference = createCellRangeContentReference({
      selectionMode: "cells",
      source,
      renderer: { id: "xlsx", backend: "builtin", locatorQuality: "semantic" },
      locator: {
        surface: "sheet",
        sheetId: "sheet-0",
        sheetName: "KPI趋势",
        ranges: ["B2:C3"],
        activeRange: "B2:C3",
      },
      cells: [
        {
          range: "B2:C3",
          displayValues: [
            ["一月", "10"],
            ["二月", "12"],
          ],
          rawValues: [
            ["一月", 10],
            ["二月", 12],
          ],
          formulas: [
            ["", "=SUM(A1:A2)"],
            ["", ""],
          ],
          rowCount: 2,
          columnCount: 2,
          truncated: false,
        },
      ],
      headers: [["月份", "收入"]],
      surroundingValues: [
        ["月份", "收入"],
        ["一月", "10"],
        ["二月", "12"],
      ],
    });

    const prompt = formatContentReferencePromptBlock([reference]);
    expect(prompt).toContain("KPI趋势");
    expect(prompt).toContain("B2:C3");
    expect(prompt).toContain("rawValues");
    expect(prompt).toContain("=SUM(A1:A2)");
    expect(prompt).toContain("Nearby header rows");
    expect(parseContentReferencePromptBlock(prompt).references).toEqual([reference]);
  });

  it("sends region metadata without duplicating image bytes in the structured attachment", () => {
    const reference = createImageRegionContentReference({
      selectionMode: "region",
      source,
      renderer: { id: "xlsx", backend: "builtin", locatorQuality: "visual" },
      locator: {
        surface: "sheet",
        sheetId: "sheet-0",
        sheetName: "Sheet1",
        rect: { x: -1, y: 0.2, width: 2, height: 0.3 },
      },
      image: {
        name: "selection.png",
        mimeType: "image/png",
        width: 300,
        height: 120,
        dataUrl: "data:image/png;base64,AAAA",
      },
    });

    expect(reference.locator.rect).toEqual({ x: 0, y: 0.2, width: 1, height: 0.3 });
    const prompt = formatContentReferencePromptBlock([reference]);
    expect(prompt).toContain("selection.png");
    expect(prompt).not.toContain("data:image/png");
  });

  it("accepts a region reference anchored on the figure, and still rejects unknown surfaces", () => {
    const reference = createImageRegionContentReference({
      selectionMode: "region",
      source,
      renderer: { id: "image", backend: "builtin", locatorQuality: "visual" },
      locator: { surface: "figure", rect: { x: 0, y: 0, width: 1, height: 1 } },
      image: {
        name: "reference-inv-fig1.svg.png",
        mimeType: "image/png",
        width: 10,
        height: 10,
        dataUrl: "data:image/png;base64,AAAA",
      },
    });
    expect(isContentReference(reference)).toBe(true);

    // 白名单只放开了 `figure`：其它未声明的落点面仍然拒绝。
    expect(isContentReference({ ...reference, locator: { ...reference.locator, surface: "canvas" } })).toBe(false);
  });

  it("keeps text quote context and normalized coordinates", () => {
    const reference = createTextContentReference({
      selectionMode: "text",
      source: { ...source, relativePath: "brief.docx", fileName: "brief.docx" },
      renderer: { id: "docx", backend: "builtin", locatorQuality: "semantic" },
      locator: {
        surface: "document",
        pageNumbers: [1],
        headingPath: ["结论"],
        quote: { exact: "增长 20%", prefix: "收入", suffix: "，超预期" },
        rects: [{ x: 0.8, y: 0.1, width: 0.5, height: 0.1 }],
      },
      selectedText: "增长 20%",
      surroundingText: "收入增长 20%，超预期",
    });

    expect(reference.locator.rects?.[0]?.x).toBeCloseTo(0.8);
    expect(reference.locator.rects?.[0]?.y).toBeCloseTo(0.1);
    expect(reference.locator.rects?.[0]?.width).toBeCloseTo(0.2);
    expect(reference.locator.rects?.[0]?.height).toBeCloseTo(0.1);
  });

  it.each([
    ["unknown selection mode", { selectionMode: "unknown" }],
    ["text reference without a locator", { selectionMode: "text", selectedText: "hello" }],
    [
      "cell reference without snapshots",
      {
        selectionMode: "cells",
        locator: {
          surface: "sheet",
          sheetId: "sheet-0",
          sheetName: "Sheet1",
          ranges: ["A1"],
          activeRange: "A1",
        },
      },
    ],
    [
      "region reference without an image",
      {
        selectionMode: "region",
        locator: {
          surface: "sheet",
          rect: { x: 0, y: 0, width: 1, height: 1 },
        },
      },
    ],
  ])("rejects malformed %s payloads", (_label, fields) => {
    const malformed = {
      schemaVersion: 1,
      kind: "content-reference",
      id: "malformed-reference",
      createdAt: new Date().toISOString(),
      source,
      renderer: { id: "xlsx", backend: "builtin", locatorQuality: "semantic" },
      ...fields,
    };

    expect(isContentReference(malformed)).toBe(false);
    expect(normalizeContentReference(malformed)).toBeNull();
    const prompt = [
      "Question",
      "[Content references selected by user:]",
      `   Reference JSON: ${JSON.stringify(malformed)}`,
    ].join("\n");
    expect(parseContentReferencePromptBlock(prompt)).toEqual({
      content: "Question",
      references: [],
    });
  });
});

describe("figure annotation references", () => {
  const figureMark: AnnotationMark = {
    id: "m1",
    kind: "arrow",
    color: "#e03131",
    points: [
      [10, 20],
      [200, 150],
    ],
    text: "这个标号应指向滑套 34",
    anchor: { tag: "g", id: "n-n3", nodeId: "n3", ref: "34", bbox: [10, 10, 40, 20] },
  };

  function annotationReference(overrides: { marks?: readonly AnnotationMark[]; summary?: string } = {}) {
    const document = buildAnnotationDocument({
      target: {
        kind: "figure-svg",
        path: "/w/data/cases/c1/outputs/inv-fig1.svg",
        relativePath: "data/cases/c1/outputs/inv-fig1.svg",
        mediaType: "image/svg+xml",
        width: 800,
        height: 600,
        sha256: "b".repeat(64),
      },
      marks: overrides.marks ?? [figureMark],
      ...(overrides.summary === undefined ? {} : { summary: overrides.summary }),
    });
    return createAnnotationContentReference({
      selectionMode: "annotation",
      source: { ...source, relativePath: "data/cases/c1/outputs/inv-fig1.svg", fileName: "inv-fig1.svg" },
      renderer: { id: "image", backend: "builtin", locatorQuality: "visual" },
      locator: { surface: "figure", width: 800, height: 600 },
      image: {
        name: "inv-fig1.annotated.png",
        mimeType: "image/png",
        width: 1600,
        height: 1200,
        dataUrl: "data:image/png;base64,AAAA",
      },
      annotation: { document, sidecarPath: "/w/data/cases/c1/outputs/inv-fig1.annot.json" },
    });
  }

  it("round-trips through validation and keeps the annotator's marks", () => {
    const reference = annotationReference();
    expect(isContentReference(reference)).toBe(true);

    const normalized = normalizeContentReference(JSON.parse(JSON.stringify(reference)));
    expect(normalized?.selectionMode).toBe("annotation");
    expect(normalized && "annotation" in normalized ? normalized.annotation.document.marks : []).toHaveLength(1);
  });

  it("carries a raster annotation on the image surface and describes it as a review comment", () => {
    const document = buildAnnotationDocument({
      target: {
        kind: "image",
        path: "/w/data/cases/c1/scans/page-1.png",
        relativePath: "data/cases/c1/scans/page-1.png",
        mediaType: "image/png",
        width: 1200,
        height: 900,
        sha256: "c".repeat(64),
      },
      marks: [figureMark],
    });
    const reference = createAnnotationContentReference({
      selectionMode: "annotation",
      source: { ...source, relativePath: "data/cases/c1/scans/page-1.png", fileName: "page-1.png" },
      renderer: { id: "image", backend: "builtin", locatorQuality: "visual" },
      locator: { surface: "image", width: 1200, height: 900 },
      image: {
        name: "page-1.annotated.png",
        mimeType: "image/png",
        width: 1200,
        height: 900,
        dataUrl: "data:image/png;base64,AAAA",
      },
      annotation: { document, sidecarPath: null },
    });

    expect(isContentReference(reference)).toBe(true);
    expect(normalizeContentReference(JSON.parse(JSON.stringify(reference)))?.selectionMode).toBe("annotation");

    const block = formatContentReferencePromptBlock([reference]);
    expect(block).toContain("Annotated image: /w/data/cases/c1/scans/page-1.png");
    expect(block).toContain("coordinates are image pixels");
    // 位图没有生成源：绝不能给出"改生成源 / 别改导出图"那套附图纪律。
    expect(block).not.toContain("Exported figure:");
    expect(block).not.toContain("Change the figure's generating source");
    expect(block).toContain("no generating source in the workspace");
  });

  it("carries an html annotation on the html surface and round-trips through validation", () => {
    const document = buildAnnotationDocument({
      target: {
        kind: "html",
        path: "/w/reports/monthly.html",
        relativePath: "reports/monthly.html",
        mediaType: "text/html",
        width: 1024,
        height: 768,
        sha256: "d".repeat(64),
      },
      marks: [figureMark],
    });
    const reference = createAnnotationContentReference({
      selectionMode: "annotation",
      source: { ...source, relativePath: "reports/monthly.html", fileName: "monthly.html", mimeType: "text/html" },
      renderer: { id: "image", backend: "builtin", locatorQuality: "visual" },
      locator: { surface: "html", width: 1024, height: 768 },
      image: {
        name: "monthly.html.annotated.png",
        mimeType: "image/png",
        width: 1024,
        height: 768,
        dataUrl: "data:image/png;base64,AAAA",
      },
      annotation: { document, sidecarPath: "/w/reports/monthly.html.annot.json" },
    });

    expect(isContentReference(reference)).toBe(true);
    const normalized = normalizeContentReference(JSON.parse(JSON.stringify(reference)));
    expect(normalized?.selectionMode).toBe("annotation");
    expect(normalized && "annotation" in normalized ? normalized.locator.surface : null).toBe("html");
  });

  it("accepts a v1 annotation document inside a historical reference and upgrades it", () => {
    const legacy = {
      ...annotationReference(),
      annotation: {
        sidecarPath: null,
        document: {
          version: 1,
          figure: {
            path: "/w/data/cases/c1/outputs/inv-fig1.svg",
            relativePath: "data/cases/c1/outputs/inv-fig1.svg",
            mediaType: "image/svg+xml",
            width: 800,
            height: 600,
            sha256: "b".repeat(64),
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          marks: [{ ...figureMark, targetFingerprint: undefined, figureFingerprint: "sha256:old" }],
        },
      },
    };

    // 历史消息里的引用必须仍能反解：读得进、算式合法、且内嵌文档已升到 v2。
    expect(isContentReference(legacy)).toBe(true);
    const normalized = normalizeContentReference(legacy);
    expect(normalized && "annotation" in normalized ? normalized.annotation.document.version : null).toBe(2);
    expect(normalized && "annotation" in normalized ? normalized.annotation.document.target.kind : null).toBe(
      "figure-svg",
    );
  });

  it("hands the flattened review image to the composer as a multimodal part", () => {
    const image = contentReferenceImage(annotationReference());
    expect(image).toMatchObject({ name: "inv-fig1.annotated.png", mimeType: "image/png" });
    expect(image?.data.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("does not tell the model to edit the exported figure as if it were the source", () => {
    const block = formatContentReferencePromptBlock([annotationReference()]);
    // 通用行必须点出例外，否则与下方标注纪律（"改生成源、不改导出图"）互相矛盾。
    expect(block).toContain("figure annotations are the exception");
    expect(block).toContain("Exported figure: data/cases/c1/outputs/inv-fig1.svg (do not edit;");
    expect(block).not.toContain("   Source: data/cases/c1/outputs/inv-fig1.svg");
  });

  it("keeps the plain source line for references whose source really is the edit target", () => {
    const region = createImageRegionContentReference({
      selectionMode: "region",
      source,
      renderer: { id: "xlsx", backend: "builtin", locatorQuality: "visual" },
      locator: {
        surface: "sheet",
        sheetId: "sheet-0",
        sheetName: "Sheet1",
        rect: { x: 0, y: 0, width: 0.5, height: 0.5 },
      },
      image: {
        name: "selection.png",
        mimeType: "image/png",
        width: 10,
        height: 10,
        dataUrl: "data:image/png;base64,AAAA",
      },
    });

    const block = formatContentReferencePromptBlock([region]);
    expect(block).toContain("   Source: reports/Q1.xlsx");
    expect(block).not.toContain("figure annotations are the exception");
    // 两类引用混在一起时，例外分句仍必须出现（标注纪律对整块生效）。
    expect(formatContentReferencePromptBlock([region, annotationReference()])).toContain(
      "figure annotations are the exception",
    );
  });

  it("warns when some marks were drawn on an earlier version of the file", () => {
    const staleMark = { ...figureMark, id: "m2", targetFingerprint: "sha256:old" };
    const freshMark = { ...figureMark, id: "m3", targetFingerprint: `sha256:${"b".repeat(64)}` };

    const block = formatContentReferencePromptBlock([annotationReference({ marks: [staleMark, freshMark] })]);
    expect(block).toContain("1 of these marks were drawn on an earlier version of the file");
    // 逐条后缀只加在旧版那条上。
    expect(block.match(/\[drawn on an earlier version of the annotated file\]/g)).toHaveLength(1);

    // 全部对应当前图时不加任何多余行（旧行为不变）。
    const fresh = formatContentReferencePromptBlock([annotationReference({ marks: [freshMark] })]);
    expect(fresh).not.toContain("earlier version of the file");
    expect(fresh).not.toContain("[drawn on an earlier version of the annotated file]");
  });

  it("never lets the inline image bytes reach the prompt text", () => {
    const block = formatContentReferencePromptBlock([annotationReference({ summary: "把标号都对齐一遍" })]);
    const serialized = serializableReference(annotationReference());

    expect(block).toContain("ANNOTATION reference");
    expect(block).toContain("Annotation file: /w/data/cases/c1/outputs/inv-fig1.annot.json");
    expect(block).toContain("1. arrow (10,20) -> (200,150) (node=n3, ref=34): 这个标号应指向滑套 34");
    expect(block).toContain("Overall note: 把标号都对齐一遍");
    expect(block).toContain("Discipline: answer mark by mark");
    expect(block).not.toContain("base64");
    expect(serialized).not.toContain("base64");
    const parsed = JSON.parse(block.split("Reference JSON: ")[1]!.split("\n")[0]!);
    expect(parsed.image.dataUrl).toBeUndefined();
  });

  it("comes back as an annotation reference when a session is re-read", () => {
    const block = formatContentReferencePromptBlock([annotationReference()]);
    const parsed = parseContentReferencePromptBlock(`修一下标号${block}`);
    expect(parsed.content).toBe("修一下标号");
    expect(parsed.references).toHaveLength(1);
    expect(parsed.references[0]?.selectionMode).toBe("annotation");
  });

  it("labels the chip with the user's first note, then with the caller's label", () => {
    const options = { maxLength: 80, annotationCountLabel: (count: number): string => `${count} 处标注` };
    expect(getContentReferenceSummary(annotationReference(), options)).toBe("这个标号应指向滑套 34");
    expect(getContentReferenceSummary(annotationReference({ marks: [], summary: "" }), options)).toBe("0 处标注");
    // 调用方不给条数文案时退化为纯数字，不回落成硬编码语种文案。
    expect(getContentReferenceSummary(annotationReference({ marks: [], summary: "" }))).toBe("0");
  });

  it("rejects a payload whose annotation document is unreadable", () => {
    const reference = annotationReference();
    const broken = { ...reference, annotation: { sidecarPath: null, document: { version: 1, marks: [] } } };
    expect(isContentReference(broken)).toBe(false);
    expect(normalizeContentReference(broken)).toBeNull();

    const noGeometry = { ...reference, locator: { surface: "figure", width: 0, height: 600 } };
    expect(isContentReference(noGeometry)).toBe(false);

    // 未落盘的标注（sidecarPath 为 null）同样是合法载荷：标注仍随消息送达。
    const unsaved = { ...reference, annotation: { sidecarPath: null, document: reference.annotation.document } };
    expect(isContentReference(unsaved)).toBe(true);
  });
});
