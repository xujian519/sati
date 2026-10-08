import { describe, expect, it } from "vitest";
import {
  ANNOTATION_DOCUMENT_VERSION,
  annotationImageName,
  annotationSidecarCandidates,
  annotationSidecarPath,
  annotationSummary,
  annotationTargetFingerprint,
  annotationTargetsFile,
  buildAnnotationDocument,
  describeAnchor,
  describeAnnotationMarks,
  isAnnotationDocument,
  isAnnotationMark,
  legacyAnnotationSidecarPath,
  normalizeAnnotationDocument,
  parseAnnotationDocument,
  type AnnotatedTargetInfo,
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
    expect(annotationSidecarPath("/w/outputs/inv-fig1.svg")).toBe("/w/outputs/inv-fig1.svg.annot.json");
    expect(annotationImageName("/w/outputs/inv-fig1.svg")).toBe("inv-fig1.svg.annotated.png");
    // 相对路径与 Windows 分隔符同样成立；后缀大小写原样保留（派生自目标文件名）。
    expect(annotationSidecarPath("outputs/inv-fig1.SVG")).toBe("outputs/inv-fig1.SVG.annot.json");
    expect(annotationSidecarPath("C:\\case\\fig1.svg")).toBe("C:\\case\\fig1.svg.annot.json");
    // 栅格图与 SVG 走同一条派生规则。
    expect(annotationSidecarPath("/w/scans/page-1.png")).toBe("/w/scans/page-1.png.annot.json");
    expect(annotationImageName("/w/scans/page-1.png")).toBe("page-1.png.annotated.png");
  });

  it("keeps the v1 main-name sidecar as a read-only fallback", () => {
    expect(legacyAnnotationSidecarPath("/w/outputs/inv-fig1.svg")).toBe("/w/outputs/inv-fig1.annot.json");
    expect(annotationSidecarCandidates("/w/outputs/inv-fig1.svg")).toEqual([
      "/w/outputs/inv-fig1.svg.annot.json",
      "/w/outputs/inv-fig1.annot.json",
    ]);
    // 没有扩展名的文件，两个名字重合，只读一次。
    expect(annotationSidecarCandidates("/w/Makefile")).toEqual(["/w/Makefile.annot.json"]);
  });

  it("only accepts a sidecar that targets this very file", () => {
    const document = buildAnnotationDocument({ target, marks: [mark()] });

    expect(annotationTargetsFile(document, target.path)).toBe(true);
    // 编辑器给的形态可能是相对项目根，判据只看文件名，所以照样成立。
    expect(annotationTargetsFile(document, "data/cases/c1/outputs/inv-fig1.svg")).toBe(true);
    // macOS / Windows 上扩展名大小写不同仍是同一个文件。
    expect(annotationTargetsFile(document, "/w/data/cases/c1/outputs/INV-FIG1.SVG")).toBe(true);
    // 同目录同主名、只有扩展名不同：这是另一份文件，不能把它的标注读成自己的。
    expect(annotationTargetsFile(document, "/w/data/cases/c1/outputs/inv-fig1.png")).toBe(false);
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

  it("derives the target kind from mediaType when migrating a v1 sidecar", () => {
    const html = normalizeAnnotationDocument(
      legacyDocument({
        figure: {
          path: "/w/reports/monthly.html",
          relativePath: "reports/monthly.html",
          mediaType: "text/html",
          width: 1024,
          height: 768,
          sha256: "b".repeat(64),
        },
      }),
    );
    // 姊妹项目（dsh）写下的 HTML 侧车没有 kind：按 mediaType 推导成 html 面，
    // 而不是硬编码的附图（否则会被误读为 SVG）。
    expect(html?.target.kind).toBe("html");

    const raster = normalizeAnnotationDocument(
      legacyDocument({
        figure: {
          path: "/w/scans/page-1.png",
          relativePath: "scans/page-1.png",
          mediaType: "image/png",
          width: 1200,
          height: 900,
          sha256: "c".repeat(64),
        },
      }),
    );
    expect(raster?.target.kind).toBe("image");
    // SVG 的既有推导保持不变（回归）。
    expect(normalizeAnnotationDocument(legacyDocument())?.target.kind).toBe("figure-svg");
  });

  it("reads a dsh-written v1 html sidecar, keeping its selector and baseline", () => {
    const migrated = normalizeAnnotationDocument(
      legacyDocument({
        figure: {
          // dsh 只写绝对 path（没有 relativePath），也没有 kind。
          path: "/w/reports/monthly.html",
          mediaType: "text/html",
          width: 1024,
          height: 768,
          sha256: "f".repeat(64),
        },
        marks: [
          {
            id: "m1",
            kind: "arrow",
            color: "#e03131",
            points: [
              [10, 20],
              [200, 150],
            ],
            text: "这里要指向图表",
            figureFingerprint: `sha256:${"f".repeat(64)}`,
            anchor: { tag: "canvas", bbox: [10, 10, 200, 120], selector: "body > canvas:nth-of-type(1)" },
          },
        ],
      }),
    );

    expect(migrated?.target.kind).toBe("html");
    expect(migrated?.target.relativePath).toBe("/w/reports/monthly.html");
    expect(migrated?.marks[0]?.anchor?.selector).toBe("body > canvas:nth-of-type(1)");
    expect(migrated?.marks[0]?.targetFingerprint).toBe(`sha256:${"f".repeat(64)}`);
  });

  it("keeps the read → save → read invariant for a dsh html sidecar", () => {
    const migrated = normalizeAnnotationDocument(
      legacyDocument({
        figure: {
          path: "/w/reports/monthly.html",
          mediaType: "text/html",
          width: 1024,
          height: 768,
          sha256: "f".repeat(64),
        },
        marks: [
          {
            id: "m1",
            kind: "arrow",
            color: "#e03131",
            points: [
              [10, 20],
              [200, 150],
            ],
            text: "这里要指向图表",
            figureFingerprint: `sha256:${"f".repeat(64)}`,
            anchor: { tag: "canvas", bbox: [10, 10, 200, 120], selector: "body > canvas:nth-of-type(1)" },
          },
        ],
        summary: "互读夹具",
      }),
    );
    expect(migrated).not.toBeNull();
    if (migrated === null) return;

    // 读 → 存：按 v2 形状重建（Sati 的保存路径）。
    const saved = buildAnnotationDocument({
      target: migrated.target,
      marks: migrated.marks,
      summary: migrated.summary,
      createdAt: migrated.createdAt,
    });
    // 存 → 读：JSON 往返后逐字段一致（target / marks / summary / createdAt）。
    const reread = normalizeAnnotationDocument(JSON.parse(JSON.stringify(saved)));
    expect(reread).not.toBeNull();
    expect(reread?.target).toEqual(saved.target);
    expect(reread?.marks).toEqual(saved.marks);
    expect(reread?.summary).toBe("互读夹具");
    expect(reread?.createdAt).toBe(saved.createdAt);
  });

  it("accepts a v2 html target and keeps its selector anchor", () => {
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
      marks: [mark({ anchor: { tag: "p", bbox: [0, 0, 10, 10], selector: "body > p:nth-of-type(1)" } })],
    });

    expect(isAnnotationDocument(document)).toBe(true);
    const roundTripped = normalizeAnnotationDocument(JSON.parse(JSON.stringify(document)));
    expect(roundTripped?.target.kind).toBe("html");
    expect(roundTripped?.marks[0]?.anchor?.selector).toBe("body > p:nth-of-type(1)");
  });

  it("rejects a target whose kind contradicts its mediaType, and only that pairing", () => {
    const htmlTarget: AnnotatedTargetInfo = {
      kind: "html",
      path: "/w/reports/monthly.html",
      relativePath: "reports/monthly.html",
      mediaType: "text/html",
      // 非 1024：只告警、不拒绝（A8），因此这里必须仍可读。
      width: 800,
      height: 600,
      sha256: "d".repeat(64),
    };
    const withTarget = (target: AnnotatedTargetInfo) => buildAnnotationDocument({ target, marks: [mark()] });

    expect(isAnnotationDocument(withTarget(htmlTarget))).toBe(true);
    expect(isAnnotationDocument(withTarget({ ...htmlTarget, mediaType: "image/png" }))).toBe(false);
    expect(isAnnotationDocument(withTarget({ ...htmlTarget, kind: "image" }))).toBe(false);
    // 附图与控制组不受影响。
    expect(isAnnotationDocument(withTarget({ ...htmlTarget, kind: "figure-svg", mediaType: "image/svg+xml" }))).toBe(
      true,
    );
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

  it("leads with the selector and confines untrusted anchor fields to bounded, escaped text", () => {
    // selector 优先级最高；同一条锚点的 text 不再出现在输出里。
    expect(describeAnchor({ tag: "p", bbox: [0, 0, 1, 1], selector: "body > p", text: "hello" })).toBe(
      "selector=body > p",
    );
    // 限长：selector 截到 400，去换行，转义引号——不能让文档文字改变提示块结构。
    expect(describeAnchor({ tag: "p", bbox: [0, 0, 1, 1], selector: "s".repeat(500) })).toBe(
      `selector=${"s".repeat(400)}`,
    );
    const escaped = describeAnchor({ tag: "p", bbox: [0, 0, 1, 1], title: `a"b\nc` });
    expect(escaped).toBe('title="a\\"b c"');
    expect(escaped).not.toContain("\n");
  });

  it("summarizes a reference by its first note, then by the caller's label", () => {
    const label = (count: number): string => `${count} 处标注`;
    const document = buildAnnotationDocument({ target, marks: [mark()] });
    expect(annotationSummary(document, label)).toBe("这个标号应指向滑套 34");
    const silent = buildAnnotationDocument({ target, marks: [mark({ text: "" })] });
    expect(annotationSummary(silent, label)).toBe("1 处标注");
  });
});
