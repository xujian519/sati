import { describe, expect, it } from "vitest";
import {
  ANNOTATION_DOCUMENT_VERSION,
  annotationImageName,
  annotationSidecarPath,
  annotationSummary,
  annotationTargetFingerprint,
  buildAnnotationDocument,
  describeAnnotationMarks,
  isAnnotationDocument,
  isAnnotationMark,
  normalizeAnnotationDocument,
  parseAnnotationDocument,
  type AnnotationDocument,
  type AnnotationMark,
} from "./annotationReference";

const target = {
  kind: "figure-svg" as const,
  path: "/w/data/cases/c1/outputs/inv-fig1.svg",
  relativePath: "data/cases/c1/outputs/inv-fig1.svg",
  mediaType: "image/svg+xml",
  width: 800,
  height: 600,
  sha256: "a".repeat(64),
};

const rasterTarget = {
  ...target,
  kind: "image" as const,
  path: "/w/data/cases/c1/scans/page-1.png",
  relativePath: "data/cases/c1/scans/page-1.png",
  mediaType: "image/png",
};

function mark(overrides: Partial<AnnotationMark> = {}): AnnotationMark {
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

/** v1 文档（本变更之前写下的形状）。 */
function legacyDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    figure: {
      path: target.path,
      relativePath: target.relativePath,
      mediaType: target.mediaType,
      width: target.width,
      height: target.height,
      sha256: target.sha256,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    marks: [],
    ...overrides,
  };
}

describe("annotation contract", () => {
  it("derives the sidecar and the review image beside the annotated file", () => {
    expect(annotationSidecarPath("/w/outputs/inv-fig1.svg")).toBe("/w/outputs/inv-fig1.annot.json");
    expect(annotationImageName("/w/outputs/inv-fig1.svg")).toBe("inv-fig1.annotated.png");
    // 相对路径与大小写后缀同样成立。
    expect(annotationSidecarPath("outputs/inv-fig1.SVG")).toBe("outputs/inv-fig1.annot.json");
    expect(annotationSidecarPath("C:\\case\\fig1.svg")).toBe("C:\\case\\fig1.annot.json");
    // 栅格图与 SVG 走同一条派生规则。
    expect(annotationSidecarPath("/w/scans/page-1.png")).toBe("/w/scans/page-1.annot.json");
    expect(annotationImageName("/w/scans/page-1.png")).toBe("page-1.annotated.png");
  });

  it("builds a document that validates and keeps the first save time", () => {
    const document = buildAnnotationDocument(
      { target, marks: [mark()], summary: "把标号都对齐一遍", createdAt: "2026-01-01T00:00:00.000Z" },
      "2026-02-02T00:00:00.000Z",
    );

    expect(document.version).toBe(ANNOTATION_DOCUMENT_VERSION);
    expect(document.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(document.updatedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(isAnnotationDocument(document)).toBe(true);
    expect(isAnnotationDocument(JSON.parse(JSON.stringify(document)))).toBe(true);
  });

  it("carries the surface kind, so a raster target is a first-class document", () => {
    const document = buildAnnotationDocument({ target: rasterTarget, marks: [mark()] });
    expect(document.target.kind).toBe("image");
    expect(isAnnotationDocument(document)).toBe(true);
    expect(isAnnotationDocument({ ...document, target: { ...rasterTarget, kind: "canvas" } })).toBe(false);
  });

  it("drops an empty overall note and rejects geometrically empty targets", () => {
    expect(buildAnnotationDocument({ target, marks: [], summary: "   " }).summary).toBeUndefined();
    expect(
      isAnnotationDocument({
        version: ANNOTATION_DOCUMENT_VERSION,
        target: { ...target, width: 0 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        marks: [],
      }),
    ).toBe(false);
  });

  it("requires a shape, a colour and at least one point on every mark", () => {
    expect(isAnnotationMark(mark())).toBe(true);
    expect(isAnnotationMark({ ...mark(), kind: "star" })).toBe(false);
    expect(isAnnotationMark({ ...mark(), points: [] })).toBe(false);
    expect(isAnnotationMark({ ...mark(), points: [[0, Number.NaN]] })).toBe(false);
    expect(isAnnotationMark({ ...mark(), anchor: { tag: "g" } })).toBe(false);
    expect(isAnnotationMark({ ...mark(), anchor: { tag: "g", bbox: [0, 0, 1, 1], ref: "34" } })).toBe(true);
    expect(isAnnotationMark({ ...mark(), targetFingerprint: "sha256:ab" })).toBe(true);
    expect(isAnnotationMark({ ...mark(), targetFingerprint: 7 })).toBe(false);
  });

  it("records which algorithm produced the content digest", () => {
    const document = (hashAlgo?: unknown) =>
      isAnnotationDocument({
        version: ANNOTATION_DOCUMENT_VERSION,
        target: hashAlgo === undefined ? target : { ...target, hashAlgo },
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
    expect(annotationTargetFingerprint({ sha256: "ab".repeat(32) })).toBe(`sha256:${"ab".repeat(32)}`);
    expect(annotationTargetFingerprint({ sha256: "ab".repeat(8), hashAlgo: "fnv1a64" })).toBe(
      `fnv1a64:${"ab".repeat(8)}`,
    );
    // 同一份摘要配不同算法不得被认成同一版。
    expect(annotationTargetFingerprint({ sha256: "ab".repeat(32) })).not.toBe(
      annotationTargetFingerprint({ sha256: "ab".repeat(32), hashAlgo: "fnv1a64" }),
    );
  });

  it("flags only the marks drawn on an earlier version, keeping the numbering", () => {
    const marks: AnnotationMark[] = [
      mark({ id: "m1", targetFingerprint: "sha256:old" }),
      mark({ id: "m2" }), // 无基线（本次变更前的数据）→ 不知道就不告警
      mark({ id: "m3", targetFingerprint: "sha256:new" }),
    ];

    const lines = describeAnnotationMarks(marks, "sha256:new");
    expect(lines[0]).toContain("[drawn on an earlier version of the annotated file]");
    expect(lines[1]).not.toContain("[drawn on an earlier version");
    expect(lines[2]).not.toContain("[drawn on an earlier version");
    // 编号恒按绘制顺序，不因基线而错位。
    expect(lines.map(line => line.slice(0, 3))).toEqual(["1. ", "2. ", "3. "]);

    // 不传文档指纹的调用点（旧行为）一律不标记。
    expect(describeAnnotationMarks(marks).some(line => line.includes("earlier"))).toBe(false);
    // 指纹里算法不同也算不同版本（FNV 摘要与 SHA 摘要在字符串上就不可能相等）。
    expect(describeAnnotationMarks([mark({ targetFingerprint: "sha256:new" })], "fnv1a64:new")[0]).toContain("earlier");
  });

  it("treats an unreadable sidecar as never annotated", () => {
    expect(parseAnnotationDocument("not json")).toBeNull();
    expect(parseAnnotationDocument(JSON.stringify({ version: 99, marks: [] }))).toBeNull();
    expect(parseAnnotationDocument(JSON.stringify(legacyDocument()))).not.toBeNull();
  });

  it("migrates a v1 sidecar on read, without touching the disk shape", () => {
    const migrated = normalizeAnnotationDocument(
      legacyDocument({
        figure: { ...(legacyDocument().figure as object), hashAlgo: "fnv1a64" },
        marks: [mark({ targetFingerprint: undefined, figureFingerprint: "fnv1a64:old" } as Partial<AnnotationMark>)],
        summary: "旧版说明",
      }),
    );

    expect(migrated).not.toBeNull();
    expect(migrated?.version).toBe(ANNOTATION_DOCUMENT_VERSION);
    // v1 没有 kind，迁移时按当时唯一的可能面补上——附图。
    expect(migrated?.target.kind).toBe("figure-svg");
    expect(migrated?.target.hashAlgo).toBe("fnv1a64");
    expect(migrated?.summary).toBe("旧版说明");
    // 逐条基线随字段改名一起搬过来，否则"画在旧版上"的告警会整段消失。
    expect(migrated?.marks[0]?.targetFingerprint).toBe("fnv1a64:old");
    expect(isAnnotationDocument(migrated)).toBe(true);
  });

  it("refuses a v1 sidecar whose figure is structurally broken", () => {
    expect(normalizeAnnotationDocument(legacyDocument({ figure: { path: "/w/x.svg" } }))).toBeNull();
    expect(normalizeAnnotationDocument(legacyDocument({ marks: [{ id: "m1" }] }))).toBeNull();
    expect(normalizeAnnotationDocument(legacyDocument({ createdAt: "" }))).toBeNull();
  });

  it("reads a v1 sidecar that records only an absolute path, deriving the relative one", () => {
    // 姊妹项目插件写下的 sidecar 没有 relativePath（还带一个 Sati 不认的 address）。
    // 这类文件在真实工作区里存在，缺字段就判废等于让用户的既有标注静默消失。
    const migrated = normalizeAnnotationDocument(
      legacyDocument({
        figure: {
          address: "dsh-resource://file/session/x/图3.svg",
          path: "/w/figures/图3.svg",
          mediaType: "image/svg+xml",
          width: 210,
          height: 297,
          sha256: "d".repeat(64),
        },
      }),
    );

    expect(migrated).not.toBeNull();
    expect(migrated?.target.relativePath).toBe("/w/figures/图3.svg");
    expect(isAnnotationDocument(migrated)).toBe(true);
  });

  it("reads a v2 document as itself, so a second pass is a no-op", () => {
    const document: AnnotationDocument = buildAnnotationDocument({ target: rasterTarget, marks: [mark()] });
    expect(normalizeAnnotationDocument(document)).toEqual(document);
  });

  it("renders numbered marks with their anchors, in the agent-facing language", () => {
    const lines = describeAnnotationMarks([
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
    const document = buildAnnotationDocument({ target, marks: [mark()] });
    expect(annotationSummary(document, label)).toBe("这个标号应指向滑套 34");
    const silent = buildAnnotationDocument({ target, marks: [mark({ text: "" })] });
    expect(annotationSummary(silent, label)).toBe("1 处标注");
  });
});
